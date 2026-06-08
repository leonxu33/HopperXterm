package transport

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

// newTestSCP dials the harness and returns an SCP client built directly on
// the SSH client. It bypasses OpenSCP because the harness emulates only the
// scp wire protocol (scp -f / scp -t), not the shell commands OpenSCP's
// `pwd` reachability check would run.
func newTestSCP(t *testing.T) *SCP {
	t.Helper()
	isolateSSHHome(t)
	srv := newTestSSHServer(t)
	client, err := DialSSH(srv.dialConfig())
	if err != nil {
		srv.Close()
		t.Fatalf("DialSSH: %v", err)
	}
	t.Cleanup(func() {
		_ = client.Close()
		srv.Close()
	})
	return &SCP{client: client}
}

// TestSCP_UploadDownloadRoundTrip exercises the refactored Download/Upload
// against the harness's scp emulation — the first end-to-end coverage of the
// SCP transfer protocol (previously only its parsers were unit-tested).
func TestSCP_UploadDownloadRoundTrip(t *testing.T) {
	s := newTestSCP(t)
	base := t.TempDir()

	localSrc := filepath.Join(base, "src.bin")
	payload := make([]byte, 7000)
	for i := range payload {
		payload[i] = byte(i % 251)
	}
	if err := os.WriteFile(localSrc, payload, 0o644); err != nil {
		t.Fatalf("write src: %v", err)
	}

	remote := remotePath(base) + "/up.bin"
	var lastUp int64
	n, err := s.Upload(localSrc, remote, func(w int64) error { lastUp = w; return nil }, nil)
	if err != nil {
		t.Fatalf("Upload: %v", err)
	}
	if n != int64(len(payload)) {
		t.Errorf("uploaded %d bytes, want %d", n, len(payload))
	}
	if lastUp != int64(len(payload)) {
		t.Errorf("upload progress ended at %d, want %d", lastUp, len(payload))
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
	if !bytes.Equal(got, payload) {
		t.Errorf("round-trip mismatch: %d bytes differ", len(got))
	}
}

// runCrossStream copies one file directly from src to dst via CopyRemoteFile
// and asserts the bytes, count, and final progress. Both clients run against
// the local harness, so the "remote" paths are real temp dirs.
func runCrossStream(t *testing.T, src, dst FileClient) {
	t.Helper()

	// Both ends must advertise their streaming capability or CopyRemoteFile
	// would silently take the (slower) temp-file relay.
	if _, ok := src.(RemoteReadable); !ok {
		t.Fatalf("%T should implement RemoteReadable", src)
	}
	if _, ok := dst.(RemoteWritable); !ok {
		t.Fatalf("%T should implement RemoteWritable", dst)
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
		int64(len(payload)),
		func(w int64) error { lastProgress = w; return nil }, nil,
	)
	if err != nil {
		t.Fatalf("CopyRemoteFile: %v", err)
	}
	if n != int64(len(payload)) {
		t.Errorf("copied %d bytes, want %d", n, len(payload))
	}
	if lastProgress != int64(len(payload)) {
		t.Errorf("final progress = %d, want %d", lastProgress, len(payload))
	}
	got, err := os.ReadFile(filepath.Join(dstDir, "copy.bin"))
	if err != nil {
		t.Fatalf("read dst: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Errorf("destination content mismatch (%d bytes)", len(got))
	}
}

// The three SSH pairings that gained direct streaming: a host without an SFTP
// subsystem (SCP) on either or both ends now avoids the local temp-file relay.
func TestCopyRemoteFile_StreamsSCPToSCP(t *testing.T) {
	runCrossStream(t, newTestSCP(t), newTestSCP(t))
}

func TestCopyRemoteFile_StreamsSCPToSFTP(t *testing.T) {
	runCrossStream(t, newTestSCP(t), newTestSFTP(t))
}

func TestCopyRemoteFile_StreamsSFTPToSCP(t *testing.T) {
	runCrossStream(t, newTestSFTP(t), newTestSCP(t))
}

// An SCP destination frames the file by the size in its C-header, so a source
// whose real length differs from the announced size must error rather than
// mis-frame and silently corrupt the file. Both directions of drift are
// guarded: too-small announce → the writer refuses the overflow; too-large →
// Close sees the source ended early.
func TestCopyRemoteFile_SCPSinkSizeMismatch(t *testing.T) {
	srcDir := t.TempDir()
	payload := make([]byte, 9000)
	if err := os.WriteFile(filepath.Join(srcDir, "f.bin"), payload, 0o644); err != nil {
		t.Fatalf("seed src: %v", err)
	}

	for _, tc := range []struct {
		name    string
		size    int64 // size announced to the SCP sink (≠ the real 9000)
		dstName string
	}{
		{"announced-too-small", 5000, "small.bin"},
		{"announced-too-large", 12000, "large.bin"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			src := newTestSFTP(t)
			dst := newTestSCP(t)
			dstDir := t.TempDir()
			_, err := CopyRemoteFile(
				src, remotePath(srcDir)+"/f.bin",
				dst, remotePath(dstDir)+"/"+tc.dstName,
				tc.size, nil, nil,
			)
			if err == nil {
				t.Errorf("expected an error when announced size %d != real 9000, got nil", tc.size)
			}
		})
	}
}
