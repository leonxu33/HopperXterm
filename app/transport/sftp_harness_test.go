package transport

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

// newTestSFTP dials the harness and opens an SFTP subsystem on top.
func newTestSFTP(t *testing.T) *SFTP {
	t.Helper()
	isolateSSHHome(t)
	srv := newTestSSHServer(t)
	client, err := DialSSH(srv.dialConfig())
	if err != nil {
		srv.Close()
		t.Fatalf("DialSSH: %v", err)
	}
	s, err := OpenSFTP(client)
	if err != nil {
		client.Close()
		srv.Close()
		t.Fatalf("OpenSFTP: %v", err)
	}
	t.Cleanup(func() {
		_ = s.Close()
		_ = client.Close()
		srv.Close()
	})
	return s
}

// remotePath maps a host path into the forward-slash form the SFTP server
// (and os.* on Windows) accept.
func remotePath(p string) string { return filepath.ToSlash(p) }

func TestSFTP_MkdirListStat(t *testing.T) {
	s := newTestSFTP(t)
	base := remotePath(t.TempDir())

	sub := base + "/alpha"
	if err := s.Mkdir(sub, false); err != nil {
		t.Fatalf("Mkdir: %v", err)
	}
	// Nested with parents.
	if err := s.Mkdir(base+"/x/y/z", true); err != nil {
		t.Fatalf("Mkdir parents: %v", err)
	}

	// A file to find in the listing.
	if err := s.Create(base + "/file.txt"); err != nil {
		t.Fatalf("Create: %v", err)
	}

	entries, err := s.List(base)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	names := map[string]Entry{}
	for _, e := range entries {
		names[e.Name] = e
	}
	if _, ok := names["alpha"]; !ok {
		t.Errorf("alpha dir missing from listing: %v", entries)
	}
	if e, ok := names["file.txt"]; !ok || e.IsDir {
		t.Errorf("file.txt missing or marked dir: %+v", e)
	}
	// Directories sort before files.
	if len(entries) >= 2 && !entries[0].IsDir {
		t.Errorf("expected directories first, got %+v", entries)
	}

	st, err := s.Stat(base + "/file.txt")
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if st.IsDir {
		t.Errorf("Stat on a file says IsDir")
	}
	// SFTP entries carry numeric owner/group strings from the FileStat.
	if st.Owner == "" {
		t.Errorf("expected an SFTP owner string, got empty")
	}
}

// List resolves every symlink's target + is-it-a-dir flag, and does so
// concurrently (a worker pool) so a symlink-heavy directory like /usr/bin
// doesn't pay 2 serial round trips per link. This exercises the pool well
// past its width with a mix of dir- and file-targeted links.
func TestSFTP_ListResolvesSymlinksConcurrently(t *testing.T) {
	s := newTestSFTP(t)
	host := t.TempDir()
	base := remotePath(host)

	if err := os.MkdirAll(filepath.Join(host, "realdir"), 0o755); err != nil {
		t.Fatalf("mkdir target: %v", err)
	}
	if err := os.WriteFile(filepath.Join(host, "realfile.txt"), []byte("hi"), 0o644); err != nil {
		t.Fatalf("write target: %v", err)
	}

	const n = 20 // > the 12-worker pool, so jobs queue
	for i := 0; i < n; i++ {
		// Skip on platforms where symlink creation isn't permitted
		// (Windows without Developer Mode / admin).
		if err := os.Symlink(filepath.Join(host, "realdir"), filepath.Join(host, fmt.Sprintf("dlink%02d", i))); err != nil {
			t.Skipf("symlinks not supported here: %v", err)
		}
		if err := os.Symlink(filepath.Join(host, "realfile.txt"), filepath.Join(host, fmt.Sprintf("flink%02d", i))); err != nil {
			t.Skipf("symlinks not supported here: %v", err)
		}
	}

	entries, err := s.List(base)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	byName := map[string]Entry{}
	for _, e := range entries {
		byName[e.Name] = e
	}
	for i := 0; i < n; i++ {
		d := byName[fmt.Sprintf("dlink%02d", i)]
		if !d.IsSymlink || !d.IsDir || d.Target == "" {
			t.Errorf("dir symlink %d resolved wrong: %+v", i, d)
		}
		f := byName[fmt.Sprintf("flink%02d", i)]
		if !f.IsSymlink || f.IsDir || f.Target == "" {
			t.Errorf("file symlink %d resolved wrong: %+v", i, f)
		}
	}
}

func TestSFTP_ListEmptyDirDefaultsToDot(t *testing.T) {
	s := newTestSFTP(t)
	// List("") defaults to ".", the server's cwd — should not error.
	if _, err := s.List(""); err != nil {
		t.Fatalf("List(\"\"): %v", err)
	}
	cwd, err := s.Cwd()
	if err != nil {
		t.Fatalf("Cwd: %v", err)
	}
	if cwd == "" {
		t.Errorf("Cwd returned empty")
	}
}

func TestSFTP_UploadDownloadRoundTrip(t *testing.T) {
	s := newTestSFTP(t)
	base := t.TempDir()

	localSrc := filepath.Join(base, "src.bin")
	payload := make([]byte, 5000)
	for i := range payload {
		payload[i] = byte(i % 251)
	}
	if err := os.WriteFile(localSrc, payload, 0o644); err != nil {
		t.Fatalf("write src: %v", err)
	}

	remote := remotePath(base) + "/uploaded.bin"
	var lastUp int64
	n, err := s.Upload(localSrc, remote, func(w int64) error { lastUp = w; return nil }, nil)
	if err != nil {
		t.Fatalf("Upload: %v", err)
	}
	if n != int64(len(payload)) {
		t.Errorf("uploaded %d bytes, want %d", n, len(payload))
	}
	if lastUp == 0 {
		t.Errorf("progress callback never reported bytes")
	}

	localDst := filepath.Join(base, "dst.bin")
	n, err = s.Download(remote, localDst, nil, nil)
	if err != nil {
		t.Fatalf("Download: %v", err)
	}
	if n != int64(len(payload)) {
		t.Errorf("downloaded %d bytes, want %d", n, len(payload))
	}
	got, _ := os.ReadFile(localDst)
	if string(got) != string(payload) {
		t.Errorf("round-trip mismatch: %d bytes differ", len(got))
	}
}

func TestSFTP_RenameAndRemove(t *testing.T) {
	s := newTestSFTP(t)
	base := remotePath(t.TempDir())

	if err := s.Create(base + "/one.txt"); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := s.Rename(base+"/one.txt", base+"/two.txt"); err != nil {
		t.Fatalf("Rename: %v", err)
	}
	if _, err := s.Stat(base + "/two.txt"); err != nil {
		t.Errorf("renamed file missing: %v", err)
	}
	if err := s.Remove(base + "/two.txt"); err != nil {
		t.Fatalf("Remove file: %v", err)
	}
	if _, err := s.Stat(base + "/two.txt"); err == nil {
		t.Errorf("file still present after Remove")
	}

	// Remove on an empty directory.
	if err := s.Mkdir(base+"/emptydir", false); err != nil {
		t.Fatalf("Mkdir: %v", err)
	}
	if err := s.Remove(base + "/emptydir"); err != nil {
		t.Errorf("Remove empty dir: %v", err)
	}
}

func TestSFTP_RemoveAllTree(t *testing.T) {
	s := newTestSFTP(t)
	base := remotePath(t.TempDir())
	if err := s.Mkdir(base+"/tree/sub", true); err != nil {
		t.Fatalf("Mkdir: %v", err)
	}
	if err := s.Create(base + "/tree/a.txt"); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := s.Create(base + "/tree/sub/b.txt"); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := s.RemoveAll(base + "/tree"); err != nil {
		t.Fatalf("RemoveAll: %v", err)
	}
	if _, err := s.Stat(base + "/tree"); err == nil {
		t.Errorf("tree still present after RemoveAll")
	}
	// RemoveAll on a single file works too.
	if err := s.Create(base + "/loose.txt"); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := s.RemoveAll(base + "/loose.txt"); err != nil {
		t.Errorf("RemoveAll on a file: %v", err)
	}
}

func TestSFTP_UploadDirDownloadDir(t *testing.T) {
	s := newTestSFTP(t)
	base := t.TempDir()

	// Build a small local tree.
	localTree := filepath.Join(base, "send")
	_ = os.MkdirAll(filepath.Join(localTree, "nested"), 0o755)
	_ = os.WriteFile(filepath.Join(localTree, "top.txt"), []byte("top"), 0o644)
	_ = os.WriteFile(filepath.Join(localTree, "nested", "deep.txt"), []byte("deep-content"), 0o644)

	remoteDir := remotePath(base) + "/recv"
	up, err := s.UploadDir(localTree, remoteDir, nil, nil)
	if err != nil {
		t.Fatalf("UploadDir: %v", err)
	}
	if up != int64(len("top")+len("deep-content")) {
		t.Errorf("UploadDir wrote %d bytes, want %d", up, len("top")+len("deep-content"))
	}

	// Pull it back to a new local dir.
	back := filepath.Join(base, "back")
	down, err := s.DownloadDir(remoteDir, back, nil, nil)
	if err != nil {
		t.Fatalf("DownloadDir: %v", err)
	}
	if down != up {
		t.Errorf("DownloadDir read %d bytes, UploadDir wrote %d", down, up)
	}
	got, err := os.ReadFile(filepath.Join(back, "nested", "deep.txt"))
	if err != nil {
		t.Fatalf("read downloaded nested file: %v", err)
	}
	if string(got) != "deep-content" {
		t.Errorf("nested file content = %q, want deep-content", got)
	}
}

func TestSFTP_UploadDirRejectsFile(t *testing.T) {
	s := newTestSFTP(t)
	base := t.TempDir()
	f := filepath.Join(base, "afile")
	_ = os.WriteFile(f, []byte("x"), 0o644)
	if _, err := s.UploadDir(f, remotePath(base)+"/dst", nil, nil); err == nil {
		t.Error("UploadDir on a plain file should error")
	}
}

func TestSFTP_CreateErrorOnNilClient(t *testing.T) {
	s := &SFTP{} // c == nil
	if err := s.Create("/x"); err == nil {
		t.Error("Create on a nil client should error")
	}
	if _, err := s.UploadDir("/a", "/b", nil, nil); err == nil {
		t.Error("UploadDir on a nil client should error")
	}
	if _, err := s.DownloadDir("/a", "/b", nil, nil); err == nil {
		t.Error("DownloadDir on a nil client should error")
	}
	// Close on a nil client is a no-op.
	if err := s.Close(); err != nil {
		t.Errorf("Close on empty SFTP: %v", err)
	}
}

func TestDialAndOpenSFTP_OwnsClient(t *testing.T) {
	isolateSSHHome(t)
	srv := newTestSSHServer(t)
	defer srv.Close()
	s, err := DialAndOpenSFTP(srv.dialConfig())
	if err != nil {
		t.Fatalf("DialAndOpenSFTP: %v", err)
	}
	base := remotePath(t.TempDir())
	if err := s.Mkdir(base+"/d", false); err != nil {
		t.Errorf("Mkdir over dial-opened SFTP: %v", err)
	}
	// Close should tear down the owned client without error.
	if err := s.Close(); err != nil {
		t.Errorf("Close: %v", err)
	}
}

func TestEntryFromInfo_LocalFile(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "data.txt")
	_ = os.WriteFile(f, []byte("hello"), 0o644)
	fi, err := os.Stat(f)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	e := entryFromInfo(fi)
	if e.Name != "data.txt" {
		t.Errorf("Name = %q", e.Name)
	}
	if e.IsDir {
		t.Errorf("file marked as dir")
	}
	if e.Size != 5 {
		t.Errorf("Size = %d, want 5", e.Size)
	}
	if e.ModTimeMs == 0 {
		t.Errorf("ModTimeMs not set")
	}
	// A plain os.FileInfo has no *sftp.FileStat, so owner/group stay empty.
	if e.Owner != "" || e.Group != "" {
		t.Errorf("local FileInfo should not populate owner/group: %q/%q", e.Owner, e.Group)
	}
}

// Sanity: List output is deterministically ordered (dirs first, then name).
func TestSFTP_ListOrdering(t *testing.T) {
	s := newTestSFTP(t)
	base := remotePath(t.TempDir())
	_ = s.Mkdir(base+"/zdir", false)
	_ = s.Mkdir(base+"/adir", false)
	_ = s.Create(base + "/m.txt")
	_ = s.Create(base + "/b.txt")
	entries, err := s.List(base)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	// Verify the slice is sorted the way List promises.
	sorted := make([]Entry, len(entries))
	copy(sorted, entries)
	sort.SliceStable(sorted, func(i, j int) bool {
		if sorted[i].IsDir != sorted[j].IsDir {
			return sorted[i].IsDir
		}
		return sorted[i].Name < sorted[j].Name
	})
	for i := range entries {
		if entries[i].Name != sorted[i].Name {
			t.Errorf("List not ordered dirs-first/name: %+v", entries)
			break
		}
	}
}
