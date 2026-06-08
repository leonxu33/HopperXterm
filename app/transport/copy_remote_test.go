package transport

import (
	"os"
	"path/filepath"
	"testing"
)

// noStreamClient wraps a FileClient but does NOT expose OpenRemote /
// CreateRemote — embedding the interface only promotes the interface's
// own methods, so a type assertion to RemoteReadable/RemoteWritable fails.
// This forces CopyRemoteFile down its temp-file fallback path.
type noStreamClient struct{ FileClient }

func TestCopyRemoteFile_StreamsBetweenTwoSFTP(t *testing.T) {
	// Two independent in-process SFTP servers stand in for two different
	// remote hosts — the cross-pane case.
	src := newTestSFTP(t)
	dst := newTestSFTP(t)

	// *SFTP must advertise both streaming capabilities, or CopyRemoteFile
	// would silently take the (slower) temp-file fallback for SSH↔SSH.
	if _, ok := any(src).(RemoteReadable); !ok {
		t.Fatal("*SFTP should implement RemoteReadable")
	}
	if _, ok := any(dst).(RemoteWritable); !ok {
		t.Fatal("*SFTP should implement RemoteWritable")
	}

	srcDir := t.TempDir()
	dstDir := t.TempDir()
	payload := make([]byte, 9000)
	for i := range payload {
		payload[i] = byte(i % 251)
	}
	if err := os.WriteFile(filepath.Join(srcDir, "f.bin"), payload, 0o644); err != nil {
		t.Fatalf("seed src: %v", err)
	}

	var lastProgress int64
	n, err := CopyRemoteFile(
		src, remotePath(srcDir)+"/f.bin",
		dst, remotePath(dstDir)+"/copy.bin",
		func(w int64) error { lastProgress = w; return nil }, nil,
	)
	if err != nil {
		t.Fatalf("CopyRemoteFile: %v", err)
	}
	if n != int64(len(payload)) {
		t.Errorf("copied %d bytes, want %d", n, len(payload))
	}
	if lastProgress == 0 {
		t.Errorf("progress callback never reported bytes")
	}
	got, err := os.ReadFile(filepath.Join(dstDir, "copy.bin"))
	if err != nil {
		t.Fatalf("read dst: %v", err)
	}
	if string(got) != string(payload) {
		t.Errorf("destination content mismatch (%d bytes)", len(got))
	}
}

func TestCopyRemoteFile_TempFileFallback(t *testing.T) {
	src := newTestSFTP(t)
	dst := newTestSFTP(t)

	srcDir := t.TempDir()
	dstDir := t.TempDir()
	// Large enough that the download streams in several chunks, so the
	// progress callback fires repeatedly during the download phase (the
	// regression guarded below: that phase used to report nothing, leaving
	// the bar frozen at 0% for the whole download of a big file).
	size := 800 * 1024
	payload := make([]byte, size)
	for i := range payload {
		payload[i] = byte(i % 251)
	}
	if err := os.WriteFile(filepath.Join(srcDir, "a.bin"), payload, 0o644); err != nil {
		t.Fatalf("seed src: %v", err)
	}

	// Hide the streaming methods on both ends → temp-file relay path.
	var reports []int64
	n, err := CopyRemoteFile(
		noStreamClient{src}, remotePath(srcDir)+"/a.bin",
		noStreamClient{dst}, remotePath(dstDir)+"/a.bin",
		func(w int64) error { reports = append(reports, w); return nil }, nil,
	)
	if err != nil {
		t.Fatalf("CopyRemoteFile (fallback): %v", err)
	}
	if n != int64(size) {
		t.Errorf("copied %d bytes, want %d", n, size)
	}
	if len(reports) == 0 {
		t.Fatal("fallback never reported progress")
	}
	// Progress must be monotonic and finish at the file size.
	for i := 1; i < len(reports); i++ {
		if reports[i] < reports[i-1] {
			t.Errorf("progress went backwards: %d after %d", reports[i], reports[i-1])
		}
	}
	if reports[len(reports)-1] != int64(size) {
		t.Errorf("final progress = %d, want %d", reports[len(reports)-1], size)
	}
	// At least one report must land in the download half (≤ size/2),
	// proving the download phase is no longer silent.
	sawDownload := false
	for _, w := range reports {
		if w > 0 && w <= int64(size/2) {
			sawDownload = true
			break
		}
	}
	if !sawDownload {
		t.Errorf("no progress reported during the download phase (bar would appear frozen)")
	}
	got, _ := os.ReadFile(filepath.Join(dstDir, "a.bin"))
	if string(got) != string(payload) {
		t.Errorf("fallback content mismatch (%d bytes)", len(got))
	}
}
