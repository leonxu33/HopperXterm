package transport

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

// FileClient is the surface every file-only transport (SFTP, FTP, S3)
// presents to the pane layer. Lets pane.Pane store one client without
// caring which backend it is — the Wails methods dispatch through this
// interface.
type FileClient interface {
	List(dir string) ([]Entry, error)
	// Stat returns metadata for a single path (used to seed transfer
	// progress totals without listing the whole parent directory).
	Stat(path string) (Entry, error)
	Cwd() (string, error)
	Mkdir(p string, parents bool) error
	Remove(p string) error
	RemoveAll(p string) error
	Rename(src, dst string) error
	Download(remotePath, localPath string, progress ProgressFunc, cancel <-chan struct{}) (int64, error)
	Upload(localPath, remotePath string, progress ProgressFunc, cancel <-chan struct{}) (int64, error)
	// UploadDir / DownloadDir recursively copy a tree (`cp -r` style).
	// Source must exist; destination is created if missing. Progress
	// reports cumulative bytes across the whole tree so the UI shows
	// one progress row per directory transfer. cancel is closed to
	// abort an in-flight transfer; SFTP closes the active file
	// handle so pipelined requests fail immediately instead of
	// draining (avoids the multi-second cancel lag from pkg/sftp's
	// concurrent read/write queue).
	UploadDir(localDir, remoteDir string, progress ProgressFunc, cancel <-chan struct{}) (int64, error)
	DownloadDir(remoteDir, localDir string, progress ProgressFunc, cancel <-chan struct{}) (int64, error)
	// Create makes an empty file at p (overwriting if it exists).
	// Used by the "New file" toolbar action.
	Create(p string) error
	Close() error
}

// SFTP wraps an SFTP subsystem on top of an SSH client. The client is
// shared with the terminal Shell — opening an SFTP session is a separate
// SSH channel, not a separate TCP connection.
type SFTP struct {
	Client     *ssh.Client
	c          *sftp.Client
	ownsClient bool
}

// OpenSFTP starts the SFTP subsystem on the given SSH client. The client
// is not closed when SFTP.Close is called; the caller owns the client
// lifetime (typically the pane that allocated it).
func OpenSFTP(client *ssh.Client) (*SFTP, error) {
	// Tune for throughput: enable the library's concurrent read/write
	// paths so io.Copy resolves to *sftp.File's WriteTo / ReadFrom
	// (which pipeline many in-flight packets in parallel). MaxPacket
	// is left at the library default (32 KiB) because raising it has
	// tripped server-side limits on some hosts — the concurrent paths
	// already saturate the wire with default-size packets.
	c, err := sftp.NewClient(
		client,
		sftp.UseConcurrentReads(true),
		sftp.UseConcurrentWrites(true),
	)
	if err != nil {
		return nil, fmt.Errorf("transport: open sftp: %w", err)
	}
	return &SFTP{Client: client, c: c}, nil
}

// DialAndOpenSFTP dials a fresh SSH client and starts SFTP on top of it.
// Used when the user opens a session whose primary protocol is SFTP
// rather than SSH-shell. SFTP.Close tears the client down.
func DialAndOpenSFTP(cfg SSHDialConfig) (*SFTP, error) {
	client, err := DialSSH(cfg)
	if err != nil {
		return nil, err
	}
	s, err := OpenSFTP(client)
	if err != nil {
		client.Close()
		return nil, err
	}
	s.ownsClient = true
	return s, nil
}

// Close ends the SFTP subsystem. If this SFTP owns its underlying SSH
// client (the DialAndOpenSFTP path), the client is closed too.
func (s *SFTP) Close() error {
	var firstErr error
	if s.c != nil {
		if err := s.c.Close(); err != nil {
			firstErr = err
		}
		s.c = nil
	}
	if s.ownsClient && s.Client != nil {
		if err := s.Client.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// Entry is one row of a directory listing. Times are unix millis to keep
// the wire format JSON-friendly.
type Entry struct {
	Name      string `json:"name"`
	IsDir     bool   `json:"isDir"`
	IsSymlink bool   `json:"isSymlink"`
	Size      int64  `json:"size"`
	Mode      uint32 `json:"mode"`
	ModTimeMs int64  `json:"modTimeMs"`
	Target    string `json:"target,omitempty"` // if symlink, the link target
	// Owner / Group are best-effort. For SFTP we surface the UID/GID
	// the server reported as strings ("1000" / "1000"); the design
	// renders them inline so the column has something useful. For
	// local listings on Unix we resolve names via os/user (with the
	// numeric id as fallback). Windows leaves them empty.
	Owner string `json:"owner,omitempty"`
	Group string `json:"group,omitempty"`
}

// List returns the entries of dir, sorted directories-first then by name.
// Symlinks are reported with IsSymlink=true and Target set; if the target
// is a directory the entry's IsDir is true so navigation works.
func (s *SFTP) List(dir string) ([]Entry, error) {
	if dir == "" {
		dir = "."
	}
	infos, err := s.c.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	out := make([]Entry, len(infos))
	var links []int // indices of symlink entries to resolve
	for i, fi := range infos {
		out[i] = entryFromInfo(fi)
		if fi.Mode()&os.ModeSymlink != 0 {
			out[i].IsSymlink = true
			links = append(links, i)
		}
	}
	// Resolve symlink targets concurrently. Each link costs a ReadLink plus
	// a Stat (to learn whether the target is a directory) — done serially
	// that's 2 round trips per link, so a symlink-heavy directory like
	// /usr/bin took seconds. pkg/sftp multiplexes requests over the single
	// connection, so a bounded worker pool collapses N serial round trips
	// into ~N/workers. Each worker writes a distinct index → no locking.
	if len(links) > 0 {
		const maxWorkers = 12
		workers := maxWorkers
		if len(links) < workers {
			workers = len(links)
		}
		jobs := make(chan int)
		var wg sync.WaitGroup
		wg.Add(workers)
		for w := 0; w < workers; w++ {
			go func() {
				defer wg.Done()
				for i := range jobs {
					full := path.Join(dir, infos[i].Name())
					if target, lerr := s.c.ReadLink(full); lerr == nil {
						out[i].Target = target
						// Stat (follows the link) to know if it's a directory.
						if tinfo, terr := s.c.Stat(full); terr == nil {
							out[i].IsDir = tinfo.IsDir()
						}
					}
				}
			}()
		}
		for _, i := range links {
			jobs <- i
		}
		close(jobs)
		wg.Wait()
	}
	sortEntries(out)
	return out, nil
}

// Cwd asks the server for the absolute path of the SFTP root (the user's
// home, in practice). Used to seed the breadcrumb on first listing.
func (s *SFTP) Cwd() (string, error) {
	return s.c.Getwd()
}

// Stat returns metadata for a single path.
func (s *SFTP) Stat(p string) (Entry, error) {
	fi, err := s.c.Stat(p)
	if err != nil {
		return Entry{}, err
	}
	return entryFromInfo(fi), nil
}

// Mkdir creates a directory. parents=true acts like mkdir -p.
func (s *SFTP) Mkdir(p string, parents bool) error {
	if parents {
		return s.c.MkdirAll(p)
	}
	return s.c.Mkdir(p)
}

// Remove deletes a file or empty directory. For non-empty directories,
// the caller must walk and remove children first.
func (s *SFTP) Remove(p string) error {
	fi, err := s.c.Stat(p)
	if err != nil {
		return err
	}
	if fi.IsDir() {
		return s.c.RemoveDirectory(p)
	}
	return s.c.Remove(p)
}

// RemoveAll deletes p and everything under it, file or directory.
func (s *SFTP) RemoveAll(p string) error {
	fi, err := s.c.Stat(p)
	if err != nil {
		return err
	}
	if !fi.IsDir() {
		return s.c.Remove(p)
	}
	infos, err := s.c.ReadDir(p)
	if err != nil {
		return err
	}
	for _, fi := range infos {
		if err := s.RemoveAll(path.Join(p, fi.Name())); err != nil {
			return err
		}
	}
	return s.c.RemoveDirectory(p)
}

// Rename moves src to dst. The SFTP server is responsible for atomicity
// guarantees (which on most Linux servers means same-filesystem rename
// is atomic and cross-filesystem fails).
// Create makes an empty file at p, replacing any existing one.
func (s *SFTP) Create(p string) error {
	if s.c == nil {
		return errors.New("sftp: not connected")
	}
	f, err := s.c.Create(p)
	if err != nil {
		return err
	}
	return f.Close()
}

func (s *SFTP) Rename(src, dst string) error {
	return s.c.Rename(src, dst)
}

// ProgressFunc reports cumulative bytes transferred. Called from the
// copy goroutine on every iteration; if it returns a non-nil error,
// the copy aborts immediately and propagates that error. Callers use
// this to thread cancellation in: throttle.report returns
// errors.New("cancelled") when the transfer's cancel channel fires.
type ProgressFunc func(written int64) error

// Download copies remotePath into localPath. Existing localPath is
// overwritten. progress is invoked as bytes accumulate.
func (s *SFTP) Download(remotePath, localPath string, progress ProgressFunc, cancel <-chan struct{}) (int64, error) {
	src, err := s.c.Open(remotePath)
	if err != nil {
		return 0, fmt.Errorf("open remote %s: %w", remotePath, err)
	}
	defer src.Close()
	dst, err := os.Create(localPath)
	if err != nil {
		return 0, fmt.Errorf("create local %s: %w", localPath, err)
	}
	defer dst.Close()
	stopWatch := watchCancel(cancel, src, dst)
	defer stopWatch()
	return sftpDownloadCopy(dst, src, progress)
}

// Upload copies localPath onto remotePath, creating or truncating the
// remote file.
func (s *SFTP) Upload(localPath, remotePath string, progress ProgressFunc, cancel <-chan struct{}) (int64, error) {
	src, err := os.Open(localPath)
	if err != nil {
		return 0, fmt.Errorf("open local %s: %w", localPath, err)
	}
	defer src.Close()
	dst, err := s.c.Create(remotePath)
	if err != nil {
		return 0, fmt.Errorf("create remote %s: %w", remotePath, err)
	}
	defer dst.Close()
	stopWatch := watchCancel(cancel, src, dst)
	defer stopWatch()
	return sftpUploadCopy(dst, src, progress)
}

// watchCancel spawns a goroutine that closes the given handles the
// moment `cancel` fires. Returns a stop func the caller defers to
// shut the goroutine down on the normal-completion path. When the
// handles get closed mid-flight the in-flight pkg/sftp pipeline
// fails immediately instead of waiting for queued requests to drain.
func watchCancel(cancel <-chan struct{}, closers ...io.Closer) func() {
	if cancel == nil {
		return func() {}
	}
	done := make(chan struct{})
	go func() {
		select {
		case <-cancel:
			for _, c := range closers {
				if c != nil {
					_ = c.Close()
				}
			}
		case <-done:
		}
	}()
	return func() { close(done) }
}

// sftpUploadCopy routes through io.Copy so *sftp.File.ReadFrom is
// selected (pkg/sftp's concurrent-write path). The source reader is
// wrapped with a counter so progress + cancellation work end-to-end.
func sftpUploadCopy(dst io.Writer, src io.Reader, progress ProgressFunc) (int64, error) {
	if progress == nil {
		return io.Copy(dst, src)
	}
	pr := &progressReaderWrap{r: src, progress: progress}
	return io.Copy(dst, pr)
}

// sftpDownloadCopy routes through io.Copy so *sftp.File.WriteTo is
// selected (pkg/sftp's concurrent-read path). The dest writer is
// wrapped with a counter.
func sftpDownloadCopy(dst io.Writer, src io.Reader, progress ProgressFunc) (int64, error) {
	if progress == nil {
		return io.Copy(dst, src)
	}
	pw := &progressWriterWrap{w: dst, progress: progress}
	return io.Copy(pw, src)
}

type progressReaderWrap struct {
	r        io.Reader
	written  int64
	progress ProgressFunc
}

func (p *progressReaderWrap) Read(b []byte) (int, error) {
	n, err := p.r.Read(b)
	if n > 0 {
		p.written += int64(n)
		if p.progress != nil {
			if perr := p.progress(p.written); perr != nil {
				return n, perr
			}
		}
	}
	return n, err
}

type progressWriterWrap struct {
	w        io.Writer
	written  int64
	progress ProgressFunc
}

func (p *progressWriterWrap) Write(b []byte) (int, error) {
	n, err := p.w.Write(b)
	if n > 0 {
		p.written += int64(n)
		if p.progress != nil {
			if perr := p.progress(p.written); perr != nil {
				return n, perr
			}
		}
	}
	return n, err
}

// UploadDir recursively copies a local directory tree to remoteDir.
// Mirrors `cp -r`: existing destination files are overwritten,
// directories at the remote get created lazily, and progress is the
// cumulative bytes across all files. Stops on the first error.
func (s *SFTP) UploadDir(localDir, remoteDir string, progress ProgressFunc, cancel <-chan struct{}) (int64, error) {
	if s.c == nil {
		return 0, errors.New("sftp: not connected")
	}
	info, err := os.Stat(localDir)
	if err != nil {
		return 0, err
	}
	if !info.IsDir() {
		return 0, fmt.Errorf("upload-dir: %s is not a directory", localDir)
	}
	// Ensure the top-level remote dir exists.
	_ = s.c.MkdirAll(remoteDir)

	var written int64
	walkErr := filepath.Walk(localDir, func(p string, info os.FileInfo, err error) error {
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
		// Remote paths are always POSIX.
		remote := remoteDir + "/" + filepath.ToSlash(rel)
		if info.IsDir() {
			return s.c.MkdirAll(remote)
		}
		src, err := os.Open(p)
		if err != nil {
			return err
		}
		defer src.Close()
		dst, err := s.c.Create(remote)
		if err != nil {
			return err
		}
		defer dst.Close()
		stopWatch := watchCancel(cancel, src, dst)
		defer stopWatch()
		base := written
		n, cerr := sftpUploadCopy(dst, src, func(localBytes int64) error {
			if progress != nil {
				return progress(base + localBytes)
			}
			return nil
		})
		written += n
		return cerr
	})
	return written, walkErr
}

// DownloadDir recursively copies remoteDir into localDir using
// pkg/sftp's Walker for the remote tree enumeration.
func (s *SFTP) DownloadDir(remoteDir, localDir string, progress ProgressFunc, cancel <-chan struct{}) (int64, error) {
	if s.c == nil {
		return 0, errors.New("sftp: not connected")
	}
	if err := os.MkdirAll(localDir, 0o755); err != nil {
		return 0, err
	}
	var written int64
	walker := s.c.Walk(remoteDir)
	for walker.Step() {
		if err := walker.Err(); err != nil {
			return written, err
		}
		p := walker.Path()
		info := walker.Stat()
		if p == remoteDir {
			continue
		}
		rel := strings.TrimPrefix(p, remoteDir)
		rel = strings.TrimLeft(rel, "/\\")
		local := filepath.Join(localDir, filepath.FromSlash(rel))
		if info.IsDir() {
			if err := os.MkdirAll(local, 0o755); err != nil {
				return written, err
			}
			continue
		}
		// Ensure the file's parent exists locally.
		if err := os.MkdirAll(filepath.Dir(local), 0o755); err != nil {
			return written, err
		}
		src, err := s.c.Open(p)
		if err != nil {
			return written, err
		}
		dst, err := os.Create(local)
		if err != nil {
			src.Close()
			return written, err
		}
		stopWatch := watchCancel(cancel, src, dst)
		base := written
		n, cerr := sftpDownloadCopy(dst, src, func(localBytes int64) error {
			if progress != nil {
				return progress(base + localBytes)
			}
			return nil
		})
		stopWatch()
		src.Close()
		dst.Close()
		written += n
		if cerr != nil {
			return written, cerr
		}
	}
	return written, nil
}

func copyWithProgress(dst io.Writer, src io.Reader, progress ProgressFunc) (int64, error) {
	buf := make([]byte, 256*1024)
	var written int64
	for {
		n, rerr := src.Read(buf)
		if n > 0 {
			if _, werr := dst.Write(buf[:n]); werr != nil {
				return written, werr
			}
			written += int64(n)
			if progress != nil {
				if perr := progress(written); perr != nil {
					return written, perr
				}
			}
		}
		if rerr != nil {
			if errors.Is(rerr, io.EOF) {
				return written, nil
			}
			return written, rerr
		}
	}
}

func entryFromInfo(fi os.FileInfo) Entry {
	e := Entry{
		Name:      fi.Name(),
		IsDir:     fi.IsDir(),
		Size:      fi.Size(),
		Mode:      uint32(fi.Mode().Perm()),
		ModTimeMs: fi.ModTime().UnixMilli(),
	}
	// pkg/sftp exposes the protocol-level FileStat via Sys(); it
	// carries UID/GID as uint32. We surface them as decimal strings —
	// resolving to names would require a remote `getent passwd` lookup
	// and isn't worth the round-trip.
	if st, ok := fi.Sys().(*sftp.FileStat); ok {
		e.Owner = strconv.FormatUint(uint64(st.UID), 10)
		e.Group = strconv.FormatUint(uint64(st.GID), 10)
	}
	return e
}

// SuggestRemotePath builds a destination path inside dir for the given
// localPath. It uses path.Base on the local path so platform separators
// in localPath don't bleed into the POSIX-style remote tree.
func SuggestRemotePath(dir, localPath string) string {
	base := path.Base(localPath)
	// Path may be Windows-style; collapse to last segment.
	for i := len(localPath) - 1; i >= 0; i-- {
		if localPath[i] == '\\' || localPath[i] == '/' {
			base = localPath[i+1:]
			break
		}
	}
	return path.Join(dir, base)
}

