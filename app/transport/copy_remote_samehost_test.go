package transport

import (
	"os"
	"path/filepath"
	"testing"
)

// TestCopyRemoteFile_SameClient reproduces the same-host (same pane) copy:
// one SFTP client is both source and destination, streaming a file from one
// directory into another on the same connection.
func TestCopyRemoteFile_SameClient(t *testing.T) {
	c := newTestSFTP(t)

	root := t.TempDir()
	srcDir := filepath.Join(root, "src")
	dstDir := filepath.Join(root, "dst")
	if err := os.MkdirAll(srcDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(dstDir, 0o755); err != nil {
		t.Fatal(err)
	}
	payload := make([]byte, 9000)
	for i := range payload {
		payload[i] = byte(i % 251)
	}
	if err := os.WriteFile(filepath.Join(srcDir, "f.bin"), payload, 0o644); err != nil {
		t.Fatalf("seed src: %v", err)
	}

	n, err := CopyRemoteFile(
		c, remotePath(srcDir)+"/f.bin",
		c, remotePath(dstDir)+"/f.bin",
		int64(len(payload)),
		nil, nil,
	)
	if err != nil {
		t.Fatalf("CopyRemoteFile (same client): %v", err)
	}
	if n != int64(len(payload)) {
		t.Errorf("copied %d bytes, want %d", n, len(payload))
	}
	got, err := os.ReadFile(filepath.Join(dstDir, "f.bin"))
	if err != nil {
		t.Fatalf("read dst: %v", err)
	}
	if string(got) != string(payload) {
		t.Errorf("destination content mismatch (%d bytes)", len(got))
	}
}
