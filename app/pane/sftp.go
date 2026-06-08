package pane

import (
	"errors"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"hopperxterm/events"
	"hopperxterm/transport"
)

// fileClient returns whichever file backend powers this pane.
// For FTP / S3 / standalone SFTP panes, it was opened eagerly at
// connect time. For SSH-backed panes, it's lazily opened against the
// pane's existing SSH client.
func (p *Pane) fileClient() (transport.FileClient, error) {
	p.fileMu.Lock()
	defer p.fileMu.Unlock()
	if p.file != nil {
		return p.file, nil
	}
	if p.ssh != nil && p.ssh.Client != nil {
		s, err := transport.OpenSFTP(p.ssh.Client)
		if err != nil {
			// Some hosts disable the SFTP subsystem but still support scp.
			// Fall back to a shell+scp FileClient so the Remote Files panel
			// keeps working. POSIX only — the shell commands assume a Unix
			// shell, so a Windows remote keeps the original SFTP error.
			if p.cachedOSFamily() == "windows" {
				return nil, err
			}
			scp, scpErr := transport.OpenSCP(p.ssh.Client)
			if scpErr != nil {
				return nil, err // surface the original SFTP failure
			}
			events.EmitConnectionLog(p.appCtx, p.ID, events.LogDim, nowMillis(),
				"SFTP unavailable — using SCP fallback")
			p.file = scp
			return scp, nil
		}
		p.file = s
		return s, nil
	}
	return nil, errors.New("pane: no file client available (not connected, or non-file session type)")
}

// SftpList returns the directory entries at dir. Pass "" for the user's
// SFTP working directory (the server reports that via Cwd).
func (p *Pane) SftpList(dir string) ([]transport.Entry, error) {
	s, err := p.fileClient()
	if err != nil {
		return nil, err
	}
	entries, err := s.List(dir)
	if err != nil {
		return nil, err
	}
	// Windows SFTP servers report uid/gid 0 for every file (NTFS ACLs don't
	// map to POSIX ownership), so the numbers are meaningless. Blank them so
	// the UI renders "-" instead of a misleading "0". List-only by design:
	// statRemote never surfaces owner/group, so Stat needs no equivalent.
	if p.cachedOSFamily() == "windows" {
		for i := range entries {
			entries[i].Owner = ""
			entries[i].Group = ""
		}
	}
	return entries, nil
}

// SftpCwd returns the SFTP working directory (typically $HOME).
func (p *Pane) SftpCwd() (string, error) {
	s, err := p.fileClient()
	if err != nil {
		return "", err
	}
	return s.Cwd()
}

// SftpMkdir creates a directory.
func (p *Pane) SftpMkdir(path string, parents bool) error {
	s, err := p.fileClient()
	if err != nil {
		return err
	}
	return s.Mkdir(path, parents)
}

// SftpCreate writes an empty file at the given path.
func (p *Pane) SftpCreate(path string) error {
	s, err := p.fileClient()
	if err != nil {
		return err
	}
	return s.Create(path)
}

// SftpRemove deletes a single file or empty directory.
func (p *Pane) SftpRemove(path string) error {
	s, err := p.fileClient()
	if err != nil {
		return err
	}
	return s.Remove(path)
}

// SftpRemoveAll recursively deletes a file or directory tree.
func (p *Pane) SftpRemoveAll(path string) error {
	s, err := p.fileClient()
	if err != nil {
		return err
	}
	return s.RemoveAll(path)
}

// SftpRename moves src to dst on the remote.
func (p *Pane) SftpRename(src, dst string) error {
	s, err := p.fileClient()
	if err != nil {
		return err
	}
	return s.Rename(src, dst)
}

// transferSeq generates a monotonic transfer ID per pane process.
var transferSeq atomic.Uint64

// transferMu guards in-flight transfer cancellations.
var transferMu sync.Mutex
var transferCancels = map[uint64]chan struct{}{}

func nextTransferID() uint64 { return transferSeq.Add(1) }

// runTransfer wraps the lifecycle shared by every upload/download: a
// fresh transfer ID, cancel registration, the running→done|error|cancelled
// event sequence, and a throttle threading progress + cancellation into
// the copy. The per-transfer specifics (which file-client call to make,
// and how to compute the total byte count) come in via `op`/`total`.
// kind is "upload" or "download"; remotePath is the event's Path label.
func (p *Pane) runTransfer(
	kind, remotePath string,
	total int64,
	op func(progress transport.ProgressFunc, cancel <-chan struct{}) (int64, error),
) (uint64, error) {
	id := nextTransferID()
	cancel := registerTransfer(id)
	defer unregisterTransfer(id)

	emit := func(state string, written int64, errMsg string) {
		payload := events.SftpTransferPayload{
			ID: id, Kind: kind, Path: remotePath, State: state,
			Bytes: written, Error: errMsg,
		}
		// TotalBytes rides only on the running events (matching the
		// throttle), so terminal events keep their lean payload.
		if state == "running" {
			payload.TotalBytes = total
		}
		events.EmitSftpTransfer(p.appCtx, p.ID, payload)
	}

	emit("running", 0, "")
	throttle := newProgressThrottle(p, id, kind, remotePath, total, cancel)
	written, err := op(throttle.report, cancel)
	if err != nil {
		if isCancelled(cancel) {
			emit("cancelled", written, "")
		} else {
			emit("error", written, err.Error())
		}
		return id, err
	}
	emit("done", written, "")
	return id, nil
}

// SftpDownload streams a remote file to a local path. Emits
// sftp:transfer:{paneID} events with the transfer ID, byte progress, and
// terminal state. Synchronous: blocks until done or error.
func (p *Pane) SftpDownload(remotePath, localPath string) (uint64, error) {
	s, err := p.fileClient()
	if err != nil {
		return 0, err
	}
	// Best-effort source size for the percentage display. SFTP/FTP/S3
	// expose stat via the file client's listing, but no direct stat
	// helper exists here yet — fall back to 0 (frontend just hides the
	// percentage column when zero).
	var total int64
	if st, err := p.statRemote(remotePath); err == nil {
		total = st
	}
	return p.runTransfer("download", remotePath, total,
		func(progress transport.ProgressFunc, cancel <-chan struct{}) (int64, error) {
			return s.Download(remotePath, localPath, progress, cancel)
		})
}

// SftpUploadDir recursively copies a local directory tree to remoteDir.
// One transfer ID for the whole tree; progress events report the
// cumulative byte count. Pre-walks the local tree to compute total
// bytes so the UI can show a real percentage.
func (p *Pane) SftpUploadDir(localPath, remotePath string) (uint64, error) {
	s, err := p.fileClient()
	if err != nil {
		return 0, err
	}
	var total int64
	_ = filepath.Walk(localPath, func(_ string, info os.FileInfo, werr error) error {
		if werr == nil && !info.IsDir() {
			total += info.Size()
		}
		return nil
	})
	return p.runTransfer("upload", remotePath, total,
		func(progress transport.ProgressFunc, cancel <-chan struct{}) (int64, error) {
			return s.UploadDir(localPath, remotePath, progress, cancel)
		})
}

// SftpDownloadDir recursively copies a remote directory tree to localDir.
func (p *Pane) SftpDownloadDir(remotePath, localPath string) (uint64, error) {
	s, err := p.fileClient()
	if err != nil {
		return 0, err
	}
	// Pre-walk the remote tree to compute total bytes (best-effort —
	// a List-based walk; if a subdir fails we just under-count).
	var total int64
	var walk func(dir string)
	walk = func(dir string) {
		entries, err := s.List(dir)
		if err != nil {
			return
		}
		for _, e := range entries {
			if e.Name == ".." {
				continue
			}
			full := dir + "/" + e.Name
			if e.IsDir {
				walk(full)
			} else {
				total += e.Size
			}
		}
	}
	walk(remotePath)

	return p.runTransfer("download", remotePath, total,
		func(progress transport.ProgressFunc, cancel <-chan struct{}) (int64, error) {
			return s.DownloadDir(remotePath, localPath, progress, cancel)
		})
}

// SftpUpload streams a local file to a remote path.
func (p *Pane) SftpUpload(localPath, remotePath string) (uint64, error) {
	s, err := p.fileClient()
	if err != nil {
		return 0, err
	}
	var total int64
	if st, err := os.Stat(localPath); err == nil {
		total = st.Size()
	}
	return p.runTransfer("upload", remotePath, total,
		func(progress transport.ProgressFunc, cancel <-chan struct{}) (int64, error) {
			return s.Upload(localPath, remotePath, progress, cancel)
		})
}

// SftpRelayFrom copies the named entries from another pane's file client
// (srcDir on `src`) into this pane's dstDir — a server-to-server transfer
// driven by a cross-pane drag-and-drop. Files stream directly when both
// ends support it (transport.CopyRemoteFile), with a temp-file fallback;
// directories recurse. Each call is ONE transfer on this (the destination)
// pane, so progress + cancel land in the pane the user dropped onto, with
// bytes reported cumulatively across every entry in `names`. The frontend
// drives one call per dropped entry (so each gets its own transfer row),
// but the cumulative `base` accounting also makes a multi-name batch
// report correctly if called that way.
func (p *Pane) SftpRelayFrom(src transport.FileClient, srcDir string, names []string, dstDir string) (uint64, error) {
	dst, err := p.fileClient()
	if err != nil {
		return 0, err
	}

	// Pre-walk the source to seed TotalBytes (best-effort; a failed
	// sub-listing just under-counts, like SftpDownloadDir).
	var total int64
	for _, n := range names {
		total += relaySize(src, joinRemote(srcDir, n))
	}

	// Label the transfer with the first destination path so the panel's
	// "done → refresh if parentDir == cwd" heuristic still fires; the
	// frontend also refreshes explicitly after the await.
	label := dstDir
	if len(names) > 0 {
		label = joinRemote(dstDir, names[0])
	}

	return p.runTransfer("download", label, total,
		func(progress transport.ProgressFunc, cancel <-chan struct{}) (int64, error) {
			var base int64
			for _, n := range names {
				if isSkippableEntry(n) {
					continue
				}
				written, err := copyEntry(
					src, joinRemote(srcDir, n),
					dst, joinRemote(dstDir, n),
					base, progress, cancel,
				)
				base += written
				if err != nil {
					return base, err
				}
			}
			return base, nil
		})
}

// copyEntry copies one entry (file or directory tree) from src to dst.
// `base` is the byte count already reported by earlier entries in the
// batch, so progress stays cumulative across the whole drop. Returns the
// bytes copied for this entry.
func copyEntry(
	src transport.FileClient, srcPath string,
	dst transport.FileClient, dstPath string,
	base int64, progress transport.ProgressFunc, cancel <-chan struct{},
) (int64, error) {
	st, err := src.Stat(srcPath)
	if err != nil {
		return 0, err
	}
	if !st.IsDir {
		// Offset this file's 0..size progress by the running base.
		fileProgress := func(written int64) error {
			if progress == nil {
				return nil
			}
			return progress(base + written)
		}
		return transport.CopyRemoteFile(src, srcPath, dst, dstPath, st.Size, fileProgress, cancel)
	}

	// Directory: create it on the destination, then recurse. The remote
	// path is always POSIX (joinRemote), matching the rest of the SFTP layer.
	if err := dst.Mkdir(dstPath, true); err != nil {
		return 0, err
	}
	entries, err := src.List(srcPath)
	if err != nil {
		return 0, err
	}
	var sub int64
	for _, e := range entries {
		if isSkippableEntry(e.Name) {
			continue
		}
		written, err := copyEntry(
			src, joinRemote(srcPath, e.Name),
			dst, joinRemote(dstPath, e.Name),
			base+sub, progress, cancel,
		)
		sub += written
		if err != nil {
			return sub, err
		}
	}
	return sub, nil
}

// relaySize returns the total byte size of a remote path (recursing into
// directories). Best-effort: a stat/list failure contributes 0 so the
// progress denominator just under-counts rather than erroring the copy.
func relaySize(c transport.FileClient, path string) int64 {
	st, err := c.Stat(path)
	if err != nil {
		return 0
	}
	if !st.IsDir {
		return st.Size
	}
	entries, err := c.List(path)
	if err != nil {
		return 0
	}
	var total int64
	for _, e := range entries {
		if isSkippableEntry(e.Name) {
			continue
		}
		total += relaySize(c, joinRemote(path, e.Name))
	}
	return total
}

// isSkippableEntry is true for the listing pseudo-entries ("." / "..") and
// the empty name — none of which should be copied or counted.
func isSkippableEntry(name string) bool {
	return name == "" || name == "." || name == ".."
}

// joinRemote joins a POSIX remote directory and a name. Remote file paths
// are always '/'-separated regardless of the local OS.
func joinRemote(dir, name string) string {
	if dir == "" {
		return name
	}
	if dir[len(dir)-1] == '/' {
		return dir + name
	}
	return dir + "/" + name
}

// progressThrottle emits sftp:transfer events at most ~10 Hz to avoid
// drowning the IPC channel on fast copies.
type progressThrottle struct {
	pane   *Pane
	id     uint64
	kind   string
	path   string
	total  int64
	last   time.Time
	cancel chan struct{}
}

func newProgressThrottle(p *Pane, id uint64, kind, path string, total int64, cancel chan struct{}) *progressThrottle {
	return &progressThrottle{pane: p, id: id, kind: kind, path: path, total: total, cancel: cancel}
}

// report is called on every copy iteration. Returns a non-nil error to
// abort the copy when the transfer's cancel channel has been closed —
// that's how the red ✕ button actually interrupts an in-flight stream.
func (t *progressThrottle) report(written int64) error {
	// Cancel check fires on every iteration so cancellation is
	// responsive (worst-case latency = one 256 KiB chunk read).
	if isCancelled(t.cancel) {
		return errors.New("cancelled")
	}
	now := time.Now()
	if now.Sub(t.last) < 100*time.Millisecond {
		return nil
	}
	t.last = now
	events.EmitSftpTransfer(t.pane.appCtx, t.pane.ID, events.SftpTransferPayload{
		ID: t.id, Kind: t.kind, Path: t.path, State: "running", Bytes: written, TotalBytes: t.total,
	})
	return nil
}

// statRemote returns the size of the file at remotePath via the pane's
// file client. Used to seed TotalBytes on download events.
func (p *Pane) statRemote(remotePath string) (int64, error) {
	s, err := p.fileClient()
	if err != nil {
		return 0, err
	}
	e, err := s.Stat(remotePath)
	if err != nil {
		return 0, err
	}
	return e.Size, nil
}

func registerTransfer(id uint64) chan struct{} {
	ch := make(chan struct{})
	transferMu.Lock()
	transferCancels[id] = ch
	transferMu.Unlock()
	return ch
}

func unregisterTransfer(id uint64) {
	transferMu.Lock()
	delete(transferCancels, id)
	transferMu.Unlock()
}

func isCancelled(ch chan struct{}) bool {
	select {
	case <-ch:
		return true
	default:
		return false
	}
}

// CancelTransfer signals a running transfer to stop. The cancellation is
// cooperative — Upload/Download check between reads; an in-flight
// network read may take a moment to surface the error.
//
// TODO: thread cancellation into copyWithProgress so a stuck network
// read aborts immediately. For now this just flips the flag.
func CancelTransfer(id uint64) {
	transferMu.Lock()
	ch, ok := transferCancels[id]
	transferMu.Unlock()
	if ok {
		select {
		case <-ch:
		default:
			close(ch)
		}
	}
}
