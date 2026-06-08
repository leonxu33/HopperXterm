package pane

import (
	"bytes"
	"errors"
	"io"
	"sort"
	"strings"
	"testing"

	"hopperxterm/transport"
)

// memFS is an in-memory transport.FileClient used to exercise the
// cross-pane relay logic (copyEntry / relaySize) without standing up an
// SSH server. It implements the streaming capabilities, so CopyRemoteFile
// takes its direct-stream path (the SFTP↔SFTP case). Paths are absolute
// POSIX with no trailing slash (except "/").
type memFS struct {
	files map[string][]byte
	dirs  map[string]bool
}

func newMemFS() *memFS {
	return &memFS{files: map[string][]byte{}, dirs: map[string]bool{"/": true}}
}

func memParent(p string) string {
	i := strings.LastIndex(p, "/")
	if i <= 0 {
		return "/"
	}
	return p[:i]
}
func memBase(p string) string { return p[strings.LastIndex(p, "/")+1:] }

func (m *memFS) Stat(p string) (transport.Entry, error) {
	p = strings.TrimRight(p, "/")
	if p == "" {
		p = "/"
	}
	if m.dirs[p] {
		return transport.Entry{Name: memBase(p), IsDir: true}, nil
	}
	if b, ok := m.files[p]; ok {
		return transport.Entry{Name: memBase(p), Size: int64(len(b))}, nil
	}
	return transport.Entry{}, errors.New("memfs: not found " + p)
}

func (m *memFS) List(dir string) ([]transport.Entry, error) {
	dir = strings.TrimRight(dir, "/")
	if dir == "" {
		dir = "/"
	}
	if !m.dirs[dir] {
		return nil, errors.New("memfs: not a dir " + dir)
	}
	var out []transport.Entry
	for d := range m.dirs {
		if d != "/" && memParent(d) == dir {
			out = append(out, transport.Entry{Name: memBase(d), IsDir: true})
		}
	}
	for f, b := range m.files {
		if memParent(f) == dir {
			out = append(out, transport.Entry{Name: memBase(f), Size: int64(len(b))})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func (m *memFS) Mkdir(p string, parents bool) error {
	p = strings.TrimRight(p, "/")
	if p == "" {
		return nil
	}
	if parents {
		cur := ""
		for _, seg := range strings.Split(strings.Trim(p, "/"), "/") {
			cur += "/" + seg
			m.dirs[cur] = true
		}
		return nil
	}
	m.dirs[p] = true
	return nil
}

func (m *memFS) OpenRemote(p string) (io.ReadCloser, error) {
	b, ok := m.files[p]
	if !ok {
		return nil, errors.New("memfs: open missing " + p)
	}
	return io.NopCloser(bytes.NewReader(b)), nil
}

type memWriter struct {
	m    *memFS
	path string
	buf  bytes.Buffer
}

func (w *memWriter) Write(b []byte) (int, error) { return w.buf.Write(b) }
func (w *memWriter) Close() error {
	w.m.files[w.path] = append([]byte(nil), w.buf.Bytes()...)
	return nil
}
func (m *memFS) CreateRemote(p string) (io.WriteCloser, error) {
	return &memWriter{m: m, path: p}, nil
}

// Remaining FileClient methods are unused by the relay path.
func (m *memFS) Cwd() (string, error)   { return "/", nil }
func (m *memFS) Remove(p string) error  { return nil }
func (m *memFS) RemoveAll(string) error { return nil }
func (m *memFS) Rename(string, string) error {
	return nil
}
func (m *memFS) Download(string, string, transport.ProgressFunc, <-chan struct{}) (int64, error) {
	return 0, errors.New("unused")
}
func (m *memFS) Upload(string, string, transport.ProgressFunc, <-chan struct{}) (int64, error) {
	return 0, errors.New("unused")
}
func (m *memFS) UploadDir(string, string, transport.ProgressFunc, <-chan struct{}) (int64, error) {
	return 0, errors.New("unused")
}
func (m *memFS) DownloadDir(string, string, transport.ProgressFunc, <-chan struct{}) (int64, error) {
	return 0, errors.New("unused")
}
func (m *memFS) Create(p string) error { m.files[p] = []byte{}; return nil }
func (m *memFS) Close() error          { return nil }

func TestJoinRemote(t *testing.T) {
	cases := []struct{ dir, name, want string }{
		{"/a", "b", "/a/b"},
		{"/a/", "b", "/a/b"},
		{"", "b", "b"},
		{"/", "b", "/b"},
	}
	for _, c := range cases {
		if got := joinRemote(c.dir, c.name); got != c.want {
			t.Errorf("joinRemote(%q,%q)=%q want %q", c.dir, c.name, got, c.want)
		}
	}
}

func TestRelaySize_Tree(t *testing.T) {
	src := newMemFS()
	_ = src.Mkdir("/d/x", true)
	src.files["/d/a.txt"] = []byte("12345")
	src.files["/d/x/b.txt"] = []byte("67")

	if got := relaySize(src, "/d"); got != 7 {
		t.Errorf("relaySize(dir)=%d want 7", got)
	}
	if got := relaySize(src, "/d/a.txt"); got != 5 {
		t.Errorf("relaySize(file)=%d want 5", got)
	}
	if got := relaySize(src, "/nope"); got != 0 {
		t.Errorf("relaySize(missing)=%d want 0", got)
	}
}

func TestCopyEntry_FileAndTree(t *testing.T) {
	src := newMemFS()
	_ = src.Mkdir("/data/sub", true)
	src.files["/data/top.txt"] = []byte("TOP")
	src.files["/data/sub/deep.txt"] = []byte("DEEPDEEP")

	dst := newMemFS()
	_ = dst.Mkdir("/dest", true)

	// Directory tree, with a non-zero base offset to confirm cumulative
	// progress threads through the recursion.
	var lastProgress int64
	const base = int64(100)
	n, err := copyEntry(src, "/data", dst, "/dest/data", base,
		func(w int64) error { lastProgress = w; return nil }, nil)
	if err != nil {
		t.Fatalf("copyEntry(tree): %v", err)
	}
	want := int64(len("TOP") + len("DEEPDEEP"))
	if n != want {
		t.Errorf("copied %d bytes, want %d", n, want)
	}
	if lastProgress != base+want {
		t.Errorf("final cumulative progress = %d, want %d", lastProgress, base+want)
	}
	if got := string(dst.files["/dest/data/top.txt"]); got != "TOP" {
		t.Errorf("top.txt = %q, want TOP", got)
	}
	if got := string(dst.files["/dest/data/sub/deep.txt"]); got != "DEEPDEEP" {
		t.Errorf("nested deep.txt = %q, want DEEPDEEP", got)
	}
	if !dst.dirs["/dest/data/sub"] {
		t.Errorf("nested dir /dest/data/sub not created")
	}

	// Single file.
	if _, err := copyEntry(src, "/data/top.txt", dst, "/dest/just.txt", 0, nil, nil); err != nil {
		t.Fatalf("copyEntry(file): %v", err)
	}
	if got := string(dst.files["/dest/just.txt"]); got != "TOP" {
		t.Errorf("single-file copy = %q, want TOP", got)
	}
}
