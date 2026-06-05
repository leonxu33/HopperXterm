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

// shQuote single-quotes a path so spaces and shell metacharacters in file
// names can't break out of the argument. The only character that can't live
// inside single quotes is a single quote itself, handled by the classic
// '\'' escape.
func shQuote(s string) string {
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
	out, err := s.run("ls -la -- " + shQuote(dir))
	if err != nil {
		return nil, err
	}
	return parseLSOutput(out), nil
}

// Stat returns metadata for a single path via `ls -lad`.
func (s *SCP) Stat(p string) (Entry, error) {
	out, err := s.run("ls -lad -- " + shQuote(p))
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
	_, err := s.run(cmd + shQuote(p))
	return err
}

// Remove deletes a single file or empty directory. Mirrors SFTP.Remove:
// stat first so directories go through rmdir.
func (s *SCP) Remove(p string) error {
	e, err := s.Stat(p)
	if err == nil && e.IsDir && !e.IsSymlink {
		_, rerr := s.run("rmdir -- " + shQuote(p))
		return rerr
	}
	_, rerr := s.run("rm -- " + shQuote(p))
	return rerr
}

// RemoveAll deletes p and everything under it.
func (s *SCP) RemoveAll(p string) error {
	_, err := s.run("rm -rf -- " + shQuote(p))
	return err
}

// Rename moves src to dst.
func (s *SCP) Rename(src, dst string) error {
	_, err := s.run("mv -- " + shQuote(src) + " " + shQuote(dst))
	return err
}

// Create makes an empty file at p, truncating any existing one. `: > file`
// is the POSIX shell idiom (the `:` no-op produces no output, `>` truncates
// or creates), matching SFTP.Create's overwrite semantics.
func (s *SCP) Create(p string) error {
	_, err := s.run(": > " + shQuote(p))
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

// Download copies remotePath to localPath using scp source mode (`scp -f`).
// Protocol: we send a 0 byte, the remote sends a `C<mode> <size> <name>`
// control line, we ack, the remote streams <size> bytes then a status byte,
// we ack. progress reports cumulative bytes for the file; cancel closes the
// session to abort an in-flight copy.
func (s *SCP) Download(remotePath, localPath string, progress ProgressFunc, cancel <-chan struct{}) (int64, error) {
	sess, err := s.client.NewSession()
	if err != nil {
		return 0, err
	}
	defer sess.Close()
	stdin, err := sess.StdinPipe()
	if err != nil {
		return 0, err
	}
	stdout, err := sess.StdoutPipe()
	if err != nil {
		return 0, err
	}
	if err := sess.Start("scp -f -- " + shQuote(remotePath)); err != nil {
		return 0, err
	}
	stop := watchCancel(cancel, sess)
	defer stop()

	// Sized to match SFTP's transfer buffer so the data stream is read in
	// large chunks rather than the default ~4 KiB.
	r := bufio.NewReaderSize(stdout, 256*1024)
	if _, err := stdin.Write([]byte{0}); err != nil { // tell source we're ready
		return 0, err
	}
	var written int64
	for {
		// ReadString returns a non-empty line (with the trailing '\n') on
		// success and an error otherwise, so line[0] is always safe below.
		line, err := r.ReadString('\n')
		if err != nil {
			return written, err
		}
		switch line[0] {
		case 'C':
			_, size, _, perr := parseSCPControl(line)
			if perr != nil {
				return written, perr
			}
			if _, err := stdin.Write([]byte{0}); err != nil { // ack the C message
				return written, err
			}
			dst, err := os.Create(localPath)
			if err != nil {
				return written, fmt.Errorf("create local %s: %w", localPath, err)
			}
			var w io.Writer = dst
			if progress != nil {
				w = &progressWriterWrap{w: dst, progress: progress}
			}
			n, cerr := io.CopyN(w, r, size)
			written += n
			dst.Close()
			if cerr != nil {
				return written, cerr
			}
			if _, err := r.ReadByte(); err != nil { // source's end-of-file status byte
				return written, err
			}
			if _, err := stdin.Write([]byte{0}); err != nil { // final ack
				return written, err
			}
			_ = stdin.Close()
			_ = sess.Wait()
			return written, nil
		case 'T': // mtime/atime line — ack and keep going
			if _, err := stdin.Write([]byte{0}); err != nil {
				return written, err
			}
		case 0x01, 0x02: // warning / error from the source
			return written, fmt.Errorf("scp: %s", strings.TrimSpace(line[1:]))
		case 'D', 'E':
			return written, errors.New("scp: source is a directory (use DownloadDir)")
		default:
			return written, fmt.Errorf("scp: unexpected protocol byte %q", line[0])
		}
	}
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
	size := info.Size()

	sess, err := s.client.NewSession()
	if err != nil {
		return 0, err
	}
	defer sess.Close()
	stdin, err := sess.StdinPipe()
	if err != nil {
		return 0, err
	}
	stdout, err := sess.StdoutPipe()
	if err != nil {
		return 0, err
	}
	if err := sess.Start("scp -t -- " + shQuote(remotePath)); err != nil {
		return 0, err
	}
	stop := watchCancel(cancel, sess)
	defer stop()

	r := bufio.NewReader(stdout)
	if err := readAck(r); err != nil {
		return 0, err
	}
	// The C-message name is the basename; scp writes to remotePath itself
	// when it isn't an existing directory.
	if _, err := fmt.Fprintf(stdin, "C0644 %d %s\n", size, path.Base(remotePath)); err != nil {
		return 0, err
	}
	if err := readAck(r); err != nil {
		return 0, err
	}
	var src io.Reader = f
	if progress != nil {
		src = &progressReaderWrap{r: f, progress: progress}
	}
	n, cerr := io.CopyN(stdin, src, size)
	if cerr != nil {
		return n, cerr
	}
	if _, err := stdin.Write([]byte{0}); err != nil { // end-of-file marker
		return n, err
	}
	if err := readAck(r); err != nil {
		return n, err
	}
	_ = stdin.Close()
	_ = sess.Wait()
	return n, nil
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
