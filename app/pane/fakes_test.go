package pane

import (
	"errors"
	"io"
	"os"
	"strings"
	"sync"
	"time"

	"hopperxterm/transport"
)

// writeLocal writes content to a file (test helper for upload/stat paths).
func writeLocal(path, content string) error {
	return os.WriteFile(path, []byte(content), 0o644)
}

// fakePTY is an in-memory transport.PtyChannel. Stdin writes are captured;
// Stdout streams from a configurable reader.
type fakePTY struct {
	mu      sync.Mutex
	writes  []byte
	out     io.Reader
	resizes int
	closed  bool
}

func (f *fakePTY) Write(p []byte) (int, error) {
	f.mu.Lock()
	f.writes = append(f.writes, p...)
	f.mu.Unlock()
	return len(p), nil
}
func (f *fakePTY) Stdin() io.Writer { return f }
func (f *fakePTY) Stdout() io.Reader {
	if f.out == nil {
		return strings.NewReader("")
	}
	return f.out
}
func (f *fakePTY) Resize(cols, rows int) error {
	f.mu.Lock()
	f.resizes++
	f.mu.Unlock()
	return nil
}
func (f *fakePTY) Close() error {
	f.mu.Lock()
	f.closed = true
	f.mu.Unlock()
	return nil
}
func (f *fakePTY) written() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return string(f.writes)
}

// fakeFileClient is an in-memory transport.FileClient covering the calls
// the pane SFTP wrappers make. Behaviour is configurable per-test.
type fakeFileClient struct {
	mu sync.Mutex

	listing  map[string][]transport.Entry
	cwd      string
	uploaded []string
	created  []string
	removed  []string
	renamed  [][2]string
	closeErr error

	uploadN, downloadN int64
}

func newFakeFC() *fakeFileClient {
	return &fakeFileClient{listing: map[string][]transport.Entry{}, cwd: "/home/u"}
}

func (f *fakeFileClient) List(dir string) ([]transport.Entry, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.listing[dir], nil
}
func (f *fakeFileClient) Stat(p string) (transport.Entry, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	dir, name := p, ""
	if i := strings.LastIndex(p, "/"); i >= 0 {
		dir, name = p[:i], p[i+1:]
	}
	for _, e := range f.listing[dir] {
		if e.Name == name {
			return e, nil
		}
	}
	return transport.Entry{}, errors.New("not found")
}
func (f *fakeFileClient) Cwd() (string, error) { return f.cwd, nil }
func (f *fakeFileClient) Mkdir(p string, parents bool) error {
	f.mu.Lock()
	f.created = append(f.created, "dir:"+p)
	f.mu.Unlock()
	return nil
}
func (f *fakeFileClient) Remove(p string) error {
	f.mu.Lock()
	f.removed = append(f.removed, p)
	f.mu.Unlock()
	return nil
}
func (f *fakeFileClient) RemoveAll(p string) error {
	f.mu.Lock()
	f.removed = append(f.removed, "all:"+p)
	f.mu.Unlock()
	return nil
}
func (f *fakeFileClient) Rename(src, dst string) error {
	f.mu.Lock()
	f.renamed = append(f.renamed, [2]string{src, dst})
	f.mu.Unlock()
	return nil
}
func (f *fakeFileClient) Create(p string) error {
	f.mu.Lock()
	f.created = append(f.created, p)
	f.mu.Unlock()
	return nil
}
func (f *fakeFileClient) Download(remote, local string, progress transport.ProgressFunc, cancel <-chan struct{}) (int64, error) {
	if progress != nil {
		_ = progress(f.downloadN)
	}
	return f.downloadN, nil
}
func (f *fakeFileClient) Upload(local, remote string, progress transport.ProgressFunc, cancel <-chan struct{}) (int64, error) {
	f.mu.Lock()
	f.uploaded = append(f.uploaded, remote)
	f.mu.Unlock()
	if progress != nil {
		_ = progress(f.uploadN)
	}
	return f.uploadN, nil
}
func (f *fakeFileClient) UploadDir(local, remote string, progress transport.ProgressFunc, cancel <-chan struct{}) (int64, error) {
	if progress != nil {
		_ = progress(f.uploadN)
	}
	return f.uploadN, nil
}
func (f *fakeFileClient) DownloadDir(remote, local string, progress transport.ProgressFunc, cancel <-chan struct{}) (int64, error) {
	if progress != nil {
		_ = progress(f.downloadN)
	}
	return f.downloadN, nil
}
func (f *fakeFileClient) Close() error { return f.closeErr }

// waitFor polls cond for up to ~1s.
func waitFor(t interface{ Fatal(...any) }, cond func() bool) {
	for i := 0; i < 200; i++ {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("condition not met in time")
}
