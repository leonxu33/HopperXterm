// SCP transport — a FileClient that powers the Remote Files panel on SSH
// hosts whose SFTP subsystem is unavailable (disabled in sshd_config, or a
// legacy/embedded host that only ships scp). It is the automatic fallback
// when transport.OpenSFTP fails (see pane.fileClient).
//
// SCP is purely a file-copy protocol — it has no list/stat/mkdir/rename/
// delete — so this client is really "shell + scp":
//   - metadata + management run as one-shot shell commands over SSH exec
//     channels (ls/pwd/mkdir/rm/mv), the same mechanism transport/probe.go
//     uses;
//   - transfers use the real SCP wire protocol (scp -t sink / scp -f source).
//
// POSIX remotes only: the shell commands assume a Unix shell + coreutils.
// Windows remotes that lack SFTP keep their original error (pane gates this).
package transport

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"hopperxterm/transport/internal/ftpc"

	"golang.org/x/crypto/ssh"
)

// SCP wraps an SSH client to present the FileClient surface without an SFTP
// subsystem. Like SFTP it borrows the pane's existing *ssh.Client and never
// closes it — the pane owns the client lifetime.
type SCP struct {
	client *ssh.Client
}

// OpenSCP validates that a POSIX shell is reachable on the client (a quick
// `pwd`) and returns a FileClient backed by shell commands + the scp wire
// protocol. The client is not closed by SCP.Close.
func OpenSCP(client *ssh.Client) (*SCP, error) {
	if client == nil {
		return nil, errors.New("scp: nil ssh client")
	}
	s := &SCP{client: client}
	if _, err := s.run("pwd"); err != nil {
		return nil, fmt.Errorf("transport: open scp: %w", err)
	}
	return s, nil
}

// Close is a no-op: SCP borrows the shared SSH client (mirrors OpenSFTP).
func (s *SCP) Close() error { return nil }

// run executes cmd in a fresh session and returns its stdout. A nonzero exit
// is folded into an error carrying the remote stderr so callers surface a
// useful message (e.g. "mkdir: cannot create directory ...: File exists").
func (s *SCP) run(cmd string) (string, error) {
	sess, err := s.client.NewSession()
	if err != nil {
		return "", err
	}
	defer sess.Close()
	var out, errb bytes.Buffer
	sess.Stdout = &out
	sess.Stderr = &errb
	if err := sess.Run(cmd); err != nil {
		msg := strings.TrimSpace(errb.String())
		if msg == "" {
			msg = err.Error()
		}
		return out.String(), errors.New(msg)
	}
	return out.String(), nil
}

// ShQuote single-quotes a path so spaces and shell metacharacters in file
// names can't break out of the argument. The only character that can't live
// inside single quotes is a single quote itself, handled by the classic
// '\'' escape.
func ShQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// --- metadata + management (shell commands) ---------------------------------

// Cwd returns the remote working directory (the user's home for a fresh exec).
func (s *SCP) Cwd() (string, error) {
	out, err := s.run("pwd")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out), nil
}

// List runs `ls -la` and feeds each line to the vendored LIST parser (FTP
// LIST output is the same `ls -l` format), skipping the `total N` header,
// unparseable lines, and "."/"..".
func (s *SCP) List(dir string) ([]Entry, error) {
	if dir == "" {
		dir = "."
	}
	out, err := s.run("ls -la -- " + ShQuote(dir))
	if err != nil {
		return nil, err
	}
	return parseLSOutput(out), nil
}

// Stat returns metadata for a single path via `ls -lad`.
func (s *SCP) Stat(p string) (Entry, error) {
	out, err := s.run("ls -lad -- " + ShQuote(p))
	if err != nil {
		return Entry{}, err
	}
	entries := parseLSEntries(out)
	if len(entries) == 0 {
		return Entry{}, fmt.Errorf("scp: cannot stat %s", p)
	}
	ent := entries[0]
	// `ls -lad <path>` echoes the path we passed as the name; normalize to
	// the base name like SFTP's Stat reports.
	ent.Name = path.Base(strings.TrimRight(p, "/"))
	return ent, nil
}

// Mkdir creates a directory. parents=true acts like mkdir -p.
func (s *SCP) Mkdir(p string, parents bool) error {
	cmd := "mkdir -- "
	if parents {
		cmd = "mkdir -p -- "
	}
	_, err := s.run(cmd + ShQuote(p))
	return err
}

// Remove deletes a single file or empty directory. Mirrors SFTP.Remove:
// stat first so directories go through rmdir.
func (s *SCP) Remove(p string) error {
	e, err := s.Stat(p)
	if err == nil && e.IsDir && !e.IsSymlink {
		_, rerr := s.run("rmdir -- " + ShQuote(p))
		return rerr
	}
	_, rerr := s.run("rm -- " + ShQuote(p))
	return rerr
}

// RemoveAll deletes p and everything under it.
func (s *SCP) RemoveAll(p string) error {
	_, err := s.run("rm -rf -- " + ShQuote(p))
	return err
}

// Rename moves src to dst.
func (s *SCP) Rename(src, dst string) error {
	_, err := s.run("mv -- " + ShQuote(src) + " " + ShQuote(dst))
	return err
}

// Create makes an empty file at p, truncating any existing one. `: > file`
// is the POSIX shell idiom (the `:` no-op produces no output, `>` truncates
// or creates), matching SFTP.Create's overwrite semantics.
func (s *SCP) Create(p string) error {
	_, err := s.run(": > " + ShQuote(p))
	return err
}

// parseLSEntries parses every `ls -l`/`ls -la` line in out into an Entry,
// skipping the `total N` header and any unparseable rows. Input order is
// preserved; callers sort if they need directories-first.
func parseLSEntries(out string) []Entry {
	now := time.Now()
	entries := make([]Entry, 0, 16)
	sc := bufio.NewScanner(strings.NewReader(out))
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		e, err := ftpc.ParseUnixListLine(sc.Text(), now, time.Local)
		if err != nil || e == nil {
			continue // "total N" header, blank lines, unparseable rows
		}
		entries = append(entries, entryFromFtpc(e))
	}
	return entries
}

// parseLSOutput converts `ls -la` stdout into sorted Entry rows, dropping the
// "." / ".." entries `ls -la` includes.
func parseLSOutput(out string) []Entry {
	entries := parseLSEntries(out)
	out2 := entries[:0]
	for _, e := range entries {
		if e.Name == "." || e.Name == ".." {
			continue
		}
		out2 = append(out2, e)
	}
	sortEntries(out2)
	return out2
}

// entryFromFtpc maps a parsed ftpc.Entry onto the transport.Entry the
// frontend consumes. Mirrors the conversion in ftp.go's List. Mode/Owner/
// Group are left zero/empty (best-effort, same as the FTP path).
func entryFromFtpc(e *ftpc.Entry) Entry {
	return Entry{
		Name:      e.Name,
		IsDir:     e.Type == ftpc.EntryTypeFolder,
		IsSymlink: e.Type == ftpc.EntryTypeLink,
		Size:      int64(e.Size),
		Mode:      0,
		ModTimeMs: e.Time.UnixMilli(),
		Target:    e.Target,
	}
}

// --- transfers (SCP wire protocol) ------------------------------------------
//
// The single-file transfer paths are expressed as two streaming primitives
// — openSource (scp -f, a ReadCloser) and openSink (scp -t, a WriteCloser)
// — so the same protocol code serves both local↔remote transfers (Download/
// Upload below) and direct remote↔remote streaming (transport.CopyRemoteFile,
// via the RemoteReadable / RemoteWritable capabilities). The earlier
// monolithic Download/Upload couldn't stream server-to-server because the
// data never surfaced as an io.Reader/Writer.

// scpReader is the read side of `scp -f`: it yields exactly the file's bytes
// (Read returns io.EOF once `remaining` hits 0) and finishes the protocol on
// Close — consume the source's end-of-file status byte, send the final ack,
// reap the session. Close is idempotent; abort tears the session down for
// cancellation without attempting the (now-impossible) closing handshake.
type scpReader struct {
	sess      *ssh.Session
	stdin     io.WriteCloser
	r         *bufio.Reader
	remaining int64
	closeOnce sync.Once
	closeErr  error
}

func (sr *scpReader) Read(b []byte) (int, error) {
	if sr.remaining <= 0 {
		return 0, io.EOF
	}
	if int64(len(b)) > sr.remaining {
		b = b[:sr.remaining]
	}
	n, err := sr.r.Read(b)
	sr.remaining -= int64(n)
	return n, err
}

func (sr *scpReader) Close() error {
	sr.closeOnce.Do(func() {
		// Only run the closing handshake when the whole file was read; a
		// short read means the copy was aborted, so just reap the session.
		if sr.remaining == 0 {
			if _, err := sr.r.ReadByte(); err != nil { // end-of-file status byte
				sr.closeErr = err
			} else if _, err := sr.stdin.Write([]byte{0}); err != nil { // final ack
				sr.closeErr = err
			}
		}
		_ = sr.stdin.Close()
		if werr := sr.sess.Wait(); werr != nil && sr.closeErr == nil && sr.remaining == 0 {
			sr.closeErr = werr
		}
		_ = sr.sess.Close()
	})
	return sr.closeErr
}

func (sr *scpReader) abort() error { return sr.sess.Close() }

// openSource starts `scp -f`, walks the control stream to the file's
// `C<mode> <size> <name>` header, acks it, and returns a reader positioned
// at the first data byte. Directory ('D'/'E') and error (0x01/0x02) headers
// are surfaced as errors — Download is only ever pointed at a regular file.
// startTransfer opens a session, wires stdin/stdout, and starts cmd, tearing
// the session down on any error so the caller only ever cleans up a session
// it has taken ownership of. Shared by the source (scp -f) and sink (scp -t)
// openers, which otherwise duplicate this exact setup.
func (s *SCP) startTransfer(cmd string) (*ssh.Session, io.WriteCloser, io.Reader, error) {
	sess, err := s.client.NewSession()
	if err != nil {
		return nil, nil, nil, err
	}
	stdin, err := sess.StdinPipe()
	if err != nil {
		sess.Close()
		return nil, nil, nil, err
	}
	stdout, err := sess.StdoutPipe()
	if err != nil {
		sess.Close()
		return nil, nil, nil, err
	}
	if err := sess.Start(cmd); err != nil {
		sess.Close()
		return nil, nil, nil, err
	}
	return sess, stdin, stdout, nil
}

func (s *SCP) openSource(remotePath string) (*scpReader, error) {
	sess, stdin, stdout, err := s.startTransfer("scp -f -- " + ShQuote(remotePath))
	if err != nil {
		return nil, err
	}
	// Sized to match SFTP's transfer buffer so the data stream is read in
	// large chunks rather than the default ~4 KiB.
	r := bufio.NewReaderSize(stdout, 256*1024)
	if _, err := stdin.Write([]byte{0}); err != nil { // tell source we're ready
		sess.Close()
		return nil, err
	}
	for {
		// ReadString returns a non-empty line (with the trailing '\n') on
		// success and an error otherwise, so line[0] is always safe below.
		line, err := r.ReadString('\n')
		if err != nil {
			sess.Close()
			return nil, err
		}
		switch line[0] {
		case 'C':
			_, size, _, perr := parseSCPControl(line)
			if perr != nil {
				sess.Close()
				return nil, perr
			}
			if _, err := stdin.Write([]byte{0}); err != nil { // ack the C message
				sess.Close()
				return nil, err
			}
			return &scpReader{sess: sess, stdin: stdin, r: r, remaining: size}, nil
		case 'T': // mtime/atime line — ack and keep going
			if _, err := stdin.Write([]byte{0}); err != nil {
				sess.Close()
				return nil, err
			}
		case 0x01, 0x02: // warning / error from the source
			sess.Close()
			return nil, fmt.Errorf("scp: %s", strings.TrimSpace(line[1:]))
		case 'D', 'E':
			sess.Close()
			return nil, errors.New("scp: source is a directory (use DownloadDir)")
		default:
			sess.Close()
			return nil, fmt.Errorf("scp: unexpected protocol byte %q", line[0])
		}
	}
}

// OpenRemote opens remotePath for streaming reads (RemoteReadable).
func (s *SCP) OpenRemote(remotePath string) (io.ReadCloser, error) {
	return s.openSource(remotePath)
}

// scpWriter is the write side of `scp -t`: bytes written go straight to the
// sink, and Close finishes the protocol — send the end-of-file marker, read
// the sink's commit ack, reap the session. Close is idempotent; abort tears
// the session down for cancellation.
//
// scp frames the file by the size announced in the C-header, so the writer
// must deliver *exactly* that many bytes. `remaining` enforces it against a
// source whose length drifts from the stat'd size (a file changing mid-copy):
// Write refuses anything past the announced size (surfaced to io.Copy as a
// short write) and Close fails if the source ended early, rather than letting
// scp mis-frame and silently corrupt the destination.
type scpWriter struct {
	sess      *ssh.Session
	stdin     io.WriteCloser
	r         *bufio.Reader
	remaining int64
	closeOnce sync.Once
	closeErr  error
}

func (sw *scpWriter) Write(b []byte) (int, error) {
	short := int64(len(b)) > sw.remaining
	if short {
		b = b[:sw.remaining]
	}
	n, err := sw.stdin.Write(b)
	sw.remaining -= int64(n)
	if err == nil && short {
		err = io.ErrShortWrite // source exceeded the announced size
	}
	return n, err
}

func (sw *scpWriter) Close() error {
	sw.closeOnce.Do(func() {
		if sw.remaining > 0 {
			// Source ended early; the sink is still waiting for bytes. Sending
			// the EOF marker now would have scp read it as file data, so abort
			// instead of completing a frame we know is short.
			sw.closeErr = io.ErrUnexpectedEOF
			_ = sw.sess.Close()
			return
		}
		if _, err := sw.stdin.Write([]byte{0}); err != nil { // end-of-file marker
			sw.closeErr = err
		} else if err := readAck(sw.r); err != nil { // sink's commit ack
			sw.closeErr = err
		}
		_ = sw.stdin.Close()
		if werr := sw.sess.Wait(); werr != nil && sw.closeErr == nil {
			sw.closeErr = werr
		}
		_ = sw.sess.Close()
	})
	return sw.closeErr
}

func (sw *scpWriter) abort() error { return sw.sess.Close() }

// openSink starts `scp -t`, performs the opening handshake (read ready ack,
// send the `C0644 <size> <name>` header, read its ack), and returns a writer
// ready for the file's bytes. The C-message name is the basename; scp writes
// to remotePath itself when it isn't an existing directory.
func (s *SCP) openSink(remotePath string, size int64) (*scpWriter, error) {
	sess, stdin, stdout, err := s.startTransfer("scp -t -- " + ShQuote(remotePath))
	if err != nil {
		return nil, err
	}
	r := bufio.NewReader(stdout)
	if err := readAck(r); err != nil {
		sess.Close()
		return nil, err
	}
	if _, err := fmt.Fprintf(stdin, "C0644 %d %s\n", size, path.Base(remotePath)); err != nil {
		sess.Close()
		return nil, err
	}
	if err := readAck(r); err != nil {
		sess.Close()
		return nil, err
	}
	return &scpWriter{sess: sess, stdin: stdin, r: r, remaining: size}, nil
}

// CreateRemote opens remotePath for streaming writes (RemoteWritable). size
// is mandatory — scp sink mode frames the file by the count in its header.
func (s *SCP) CreateRemote(remotePath string, size int64) (io.WriteCloser, error) {
	return s.openSink(remotePath, size)
}

// Download copies remotePath to localPath using scp source mode (`scp -f`).
// progress reports cumulative bytes for the file; cancel aborts an in-flight
// copy by killing the session.
func (s *SCP) Download(remotePath, localPath string, progress ProgressFunc, cancel <-chan struct{}) (int64, error) {
	src, err := s.openSource(remotePath)
	if err != nil {
		return 0, err
	}
	dst, err := os.Create(localPath)
	if err != nil {
		_ = src.abort()
		return 0, fmt.Errorf("create local %s: %w", localPath, err)
	}
	stop := watchCancel(cancel, closerFunc(src.abort), dst)
	defer stop()
	n, cerr := sftpDownloadCopy(dst, src, progress)
	_ = dst.Close()
	if cerr != nil {
		_ = src.abort() // copy failed (watchCancel only fires on external cancel)
		return n, cerr
	}
	return n, src.Close() // finalize the protocol (deferred stop is then a no-op)
}

// Upload copies localPath onto remotePath using scp sink mode (`scp -t`).
func (s *SCP) Upload(localPath, remotePath string, progress ProgressFunc, cancel <-chan struct{}) (int64, error) {
	f, err := os.Open(localPath)
	if err != nil {
		return 0, fmt.Errorf("open local %s: %w", localPath, err)
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return 0, err
	}
	sink, err := s.openSink(remotePath, info.Size())
	if err != nil {
		return 0, err
	}
	stop := watchCancel(cancel, f, closerFunc(sink.abort))
	defer stop()
	n, cerr := sftpUploadCopy(sink, f, progress)
	if cerr != nil {
		_ = sink.abort() // copy failed (watchCancel only fires on external cancel)
		return n, cerr
	}
	return n, sink.Close()
}

// UploadDir recursively copies a local tree to remoteDir, mirroring
// SFTP.UploadDir: directories are created via mkdir -p, files stream through
// the single-file scp path, progress is cumulative across the tree.
func (s *SCP) UploadDir(localDir, remoteDir string, progress ProgressFunc, cancel <-chan struct{}) (int64, error) {
	info, err := os.Stat(localDir)
	if err != nil {
		return 0, err
	}
	if !info.IsDir() {
		return 0, fmt.Errorf("upload-dir: %s is not a directory", localDir)
	}
	_ = s.Mkdir(remoteDir, true)
	var written int64
	walkErr := filepath.Walk(localDir, func(p string, fi os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, rerr := filepath.Rel(localDir, p)
		if rerr != nil {
			return rerr
		}
		if rel == "." {
			return nil
		}
		remote := path.Join(remoteDir, filepath.ToSlash(rel))
		if fi.IsDir() {
			return s.Mkdir(remote, true)
		}
		base := written
		n, cerr := s.Upload(p, remote, func(b int64) error {
			if progress != nil {
				return progress(base + b)
			}
			return nil
		}, cancel)
		written += n
		return cerr
	})
	return written, walkErr
}

// DownloadDir recursively copies remoteDir into localDir by walking the
// remote tree with List and streaming each file through the single-file scp
// path. Symlinks are skipped (not dereferenced) to avoid copy loops.
func (s *SCP) DownloadDir(remoteDir, localDir string, progress ProgressFunc, cancel <-chan struct{}) (int64, error) {
	var written int64
	// walk creates each local dir via MkdirAll before reading its entries,
	// so the destination tree (including localDir itself) is built lazily.
	var walk func(rdir, ldir string) error
	walk = func(rdir, ldir string) error {
		entries, err := s.List(rdir)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(ldir, 0o755); err != nil {
			return err
		}
		for _, e := range entries {
			if e.Name == "." || e.Name == ".." || e.IsSymlink {
				continue
			}
			rpath := path.Join(rdir, e.Name)
			lpath := filepath.Join(ldir, e.Name)
			if e.IsDir {
				if err := walk(rpath, lpath); err != nil {
					return err
				}
				continue
			}
			base := written
			n, cerr := s.Download(rpath, lpath, func(b int64) error {
				if progress != nil {
					return progress(base + b)
				}
				return nil
			}, cancel)
			written += n
			if cerr != nil {
				return cerr
			}
		}
		return nil
	}
	if err := walk(remoteDir, localDir); err != nil {
		return written, err
	}
	return written, nil
}

// parseSCPControl parses a `C<mode> <size> <name>` scp control line.
func parseSCPControl(line string) (mode string, size int64, name string, err error) {
	line = strings.TrimRight(line, "\r\n")
	if len(line) == 0 || line[0] != 'C' {
		return "", 0, "", fmt.Errorf("scp: bad control line %q", line)
	}
	parts := strings.SplitN(line[1:], " ", 3)
	if len(parts) < 3 {
		return "", 0, "", fmt.Errorf("scp: bad control line %q", line)
	}
	size, err = strconv.ParseInt(parts[1], 10, 64)
	if err != nil {
		return "", 0, "", fmt.Errorf("scp: bad size in control line %q", line)
	}
	return parts[0], size, parts[2], nil
}

// readAck reads one scp acknowledgement byte: 0 = ok, 1 = warning, 2 = fatal.
// For 1/2 the remainder of the line is the human-readable message.
func readAck(r *bufio.Reader) error {
	b, err := r.ReadByte()
	if err != nil {
		return err
	}
	if b == 0 {
		return nil
	}
	msg, _ := r.ReadString('\n')
	return fmt.Errorf("scp: %s", strings.TrimSpace(msg))
}
