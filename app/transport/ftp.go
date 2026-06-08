// FTP transport — file-only sessions on top of the internal ftpc client
// (passive with active-mode fallback). No shell channel; mirrors the SFTP
// wrapper's surface so the same Entry/ProgressFunc types work in the frontend.
package transport

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"strings"
	"time"

	"hopperxterm/transport/internal/ftpc"
)

// FTPDialConfig is the minimum we need to reach an FTP server.
type FTPDialConfig struct {
	Host     string
	User     string
	Password string        // FTP is plaintext; the credential is plain.
	Port     int           // 0 → 21
	Timeout  time.Duration // 0 → 10s
}

// FTP wraps an active FTP connection.
type FTP struct {
	c *ftpc.Conn
}

// DialFTP opens an FTP connection and authenticates. Anonymous login is
// accepted if User=="" (sends "anonymous" / "anonymous").
func DialFTP(cfg FTPDialConfig) (*FTP, error) {
	if cfg.Host == "" {
		return nil, errors.New("transport: host required")
	}
	if cfg.Port == 0 {
		cfg.Port = 21
	}
	if cfg.Timeout == 0 {
		cfg.Timeout = 10 * time.Second
	}
	// The ftpc client tries passive first (EPSV/PASV) and falls back to
	// active mode (EPRT/PORT) if a passive data connection is refused —
	// the case for servers whose passive port range isn't routable from
	// the client (e.g. vsFTPd behind an AWS LB that only forwards port 21).
	// It also reuses the control host for passive data connections, so a
	// NAT-mangled PASV-advertised IP is ignored.
	conn, err := ftpc.Dial(ftpc.Config{
		Host:    cfg.Host,
		Port:    cfg.Port,
		Timeout: cfg.Timeout,
	})
	if err != nil {
		return nil, fmt.Errorf("transport: ftp dial %s:%d: %w", cfg.Host, cfg.Port, err)
	}
	user, pwd := cfg.User, cfg.Password
	if user == "" {
		user, pwd = "anonymous", "anonymous"
	}
	if err := conn.Login(user, pwd); err != nil {
		conn.Quit()
		return nil, fmt.Errorf("transport: ftp login: %w", err)
	}
	return &FTP{c: conn}, nil
}

// Close terminates the FTP session.
func (f *FTP) Close() error {
	if f.c == nil {
		return nil
	}
	err := f.c.Quit()
	f.c = nil
	return err
}

// Cwd returns the FTP server-side working directory.
func (f *FTP) Cwd() (string, error) {
	if f.c == nil {
		return "", errors.New("ftp: not connected")
	}
	return f.c.CurrentDir()
}

// List returns the contents of dir as []Entry (same shape as SFTP).
func (f *FTP) List(dir string) ([]Entry, error) {
	if f.c == nil {
		return nil, errors.New("ftp: not connected")
	}
	if dir == "" {
		dir = "."
	}
	entries, err := f.c.List(dir)
	if err != nil {
		return nil, err
	}
	out := make([]Entry, 0, len(entries))
	for _, e := range entries {
		// Skip "." and ".." which FTP servers commonly include.
		if e.Name == "." || e.Name == ".." {
			continue
		}
		out = append(out, Entry{
			Name:      e.Name,
			IsDir:     e.Type == ftpc.EntryTypeFolder,
			IsSymlink: e.Type == ftpc.EntryTypeLink,
			Size:      int64(e.Size),
			Mode:      0,
			ModTimeMs: e.Time.UnixMilli(),
			Target:    e.Target,
		})
	}
	sortEntries(out)
	return out, nil
}

// Stat returns metadata for a single path. FTP has no portable stat, so
// we list the parent directory and pick the matching entry.
func (f *FTP) Stat(p string) (Entry, error) {
	if f.c == nil {
		return Entry{}, errors.New("ftp: not connected")
	}
	dir, name := path.Dir(p), path.Base(p)
	entries, err := f.List(dir)
	if err != nil {
		return Entry{}, err
	}
	for _, e := range entries {
		if e.Name == name {
			return e, nil
		}
	}
	return Entry{}, fmt.Errorf("ftp: %s not found", p)
}

// Mkdir creates a directory. parents=true emulates mkdir -p with
// repeated MKD calls.
func (f *FTP) Mkdir(p string, parents bool) error {
	if f.c == nil {
		return errors.New("ftp: not connected")
	}
	if !parents {
		return f.c.MakeDir(p)
	}
	// Walk components, creating missing ones.
	parts := strings.Split(strings.Trim(p, "/"), "/")
	cur := ""
	if strings.HasPrefix(p, "/") {
		cur = "/"
	}
	for _, part := range parts {
		if part == "" {
			continue
		}
		if cur == "" {
			cur = part
		} else if cur == "/" {
			cur = "/" + part
		} else {
			cur = cur + "/" + part
		}
		if err := f.c.MakeDir(cur); err != nil {
			// Many servers return "550 directory exists" — ignore.
			if !strings.Contains(err.Error(), "550") {
				return err
			}
		}
	}
	return nil
}

// Remove deletes a file. FTP RFC 959 separates DELE (files) and RMD
// (dirs); we try RMD on EISDIR-ish errors.
func (f *FTP) Remove(p string) error {
	if f.c == nil {
		return errors.New("ftp: not connected")
	}
	if err := f.c.Delete(p); err == nil {
		return nil
	}
	return f.c.RemoveDir(p)
}

// RemoveAll recursively removes a tree. Lists, recurses into subdirs,
// deletes files, then RMD on the way back up.
func (f *FTP) RemoveAll(p string) error {
	if f.c == nil {
		return errors.New("ftp: not connected")
	}
	entries, err := f.List(p)
	if err != nil {
		// Treat as a single file.
		return f.c.Delete(p)
	}
	for _, e := range entries {
		child := path.Join(p, e.Name)
		if e.IsDir {
			if err := f.RemoveAll(child); err != nil {
				return err
			}
		} else {
			if err := f.c.Delete(child); err != nil {
				return err
			}
		}
	}
	return f.c.RemoveDir(p)
}

// Rename moves src to dst (FTP "RNFR" + "RNTO").
func (f *FTP) Rename(src, dst string) error {
	if f.c == nil {
		return errors.New("ftp: not connected")
	}
	return f.c.Rename(src, dst)
}

// Download streams remotePath into localPath.
func (f *FTP) Download(remotePath, localPath string, progress ProgressFunc, _ <-chan struct{}) (int64, error) {
	if f.c == nil {
		return 0, errors.New("ftp: not connected")
	}
	r, err := f.c.Retr(remotePath)
	if err != nil {
		return 0, fmt.Errorf("open remote %s: %w", remotePath, err)
	}
	defer r.Close()
	dst, err := os.Create(localPath)
	if err != nil {
		return 0, fmt.Errorf("create local %s: %w", localPath, err)
	}
	n, cerr := copyWithProgress(dst, r, progress)
	_ = dst.Close() // close before any unlink — Windows won't remove an open file
	if cerr != nil {
		discardPartial(func() error { return os.Remove(localPath) })
		return n, cerr
	}
	return n, nil
}

// Upload streams localPath onto remotePath.
// Create writes an empty file at remotePath via the FTP STOR command.
func (f *FTP) Create(p string) error {
	if f.c == nil {
		return errors.New("ftp: not connected")
	}
	return f.c.Stor(p, strings.NewReader(""))
}

// UploadDir / DownloadDir for FTP are not implemented yet — a manual
// recursive walk per directory would be needed. Returning an error keeps
// the frontend honest until that lands.
func (f *FTP) UploadDir(localDir, remoteDir string, progress ProgressFunc, _ <-chan struct{}) (int64, error) {
	return 0, errors.New("ftp: recursive directory upload not yet supported")
}

func (f *FTP) DownloadDir(remoteDir, localDir string, progress ProgressFunc, _ <-chan struct{}) (int64, error) {
	return 0, errors.New("ftp: recursive directory download not yet supported")
}

func (f *FTP) Upload(localPath, remotePath string, progress ProgressFunc, _ <-chan struct{}) (int64, error) {
	if f.c == nil {
		return 0, errors.New("ftp: not connected")
	}
	src, err := os.Open(localPath)
	if err != nil {
		return 0, fmt.Errorf("open local %s: %w", localPath, err)
	}
	defer src.Close()
	// Stor consumes a reader directly; wrap it in a pipe so we can report
	// progress between read chunks.
	pr, pw := io.Pipe()
	type result struct {
		written int64
		err     error
	}
	done := make(chan result, 1)
	go func() {
		n, err := copyWithProgress(pw, src, progress)
		_ = pw.CloseWithError(err)
		done <- result{written: n, err: err}
	}()
	if err := f.c.Stor(remotePath, pr); err != nil {
		_ = pr.CloseWithError(err)
		discardPartial(func() error { return f.Remove(remotePath) })
		return 0, fmt.Errorf("stor %s: %w", remotePath, err)
	}
	res := <-done
	if res.err != nil {
		discardPartial(func() error { return f.Remove(remotePath) })
	}
	return res.written, res.err
}
