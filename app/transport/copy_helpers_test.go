package transport

import (
	"bytes"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeCloser records whether Close was called (race-safe).
type fakeCloser struct {
	mu sync.Mutex
	c  bool
}

func (f *fakeCloser) Close() error {
	f.mu.Lock()
	f.c = true
	f.mu.Unlock()
	return nil
}

func (f *fakeCloser) closed() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.c
}

// waitFor polls cond for up to ~1s.
func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	for i := 0; i < 200; i++ {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("condition not met in time")
}

func TestCopyWithProgress_ReportsAndCopies(t *testing.T) {
	src := strings.NewReader(strings.Repeat("a", 1000))
	var dst bytes.Buffer
	var reports int
	n, err := copyWithProgress(&dst, src, func(int64) error { reports++; return nil })
	if err != nil {
		t.Fatalf("copyWithProgress: %v", err)
	}
	if n != 1000 || dst.Len() != 1000 {
		t.Errorf("copied %d (buf %d), want 1000", n, dst.Len())
	}
	if reports == 0 {
		t.Errorf("progress never reported")
	}
}

func TestCopyWithProgress_NilProgress(t *testing.T) {
	var dst bytes.Buffer
	n, err := copyWithProgress(&dst, strings.NewReader("hello"), nil)
	if err != nil || n != 5 {
		t.Fatalf("n=%d err=%v", n, err)
	}
}

func TestCopyWithProgress_AbortsOnProgressError(t *testing.T) {
	src := strings.NewReader(strings.Repeat("x", 2_000_000)) // > one 256KiB chunk
	var dst bytes.Buffer
	boom := errors.New("cancelled")
	_, err := copyWithProgress(&dst, src, func(int64) error { return boom })
	if !errors.Is(err, boom) {
		t.Errorf("expected the progress error to propagate, got %v", err)
	}
}

func TestSftpUploadCopy_WithAndWithoutProgress(t *testing.T) {
	var dst bytes.Buffer
	n, err := sftpUploadCopy(&dst, strings.NewReader("payload"), nil)
	if err != nil || n != 7 {
		t.Fatalf("nil-progress: n=%d err=%v", n, err)
	}

	dst.Reset()
	var seen int64
	n, err = sftpUploadCopy(&dst, strings.NewReader("payload"), func(w int64) error { seen = w; return nil })
	if err != nil || n != 7 || seen != 7 {
		t.Fatalf("with-progress: n=%d err=%v seen=%d", n, err, seen)
	}
}

func TestSftpDownloadCopy_WithAndWithoutProgress(t *testing.T) {
	var dst bytes.Buffer
	n, err := sftpDownloadCopy(&dst, strings.NewReader("data!!"), nil)
	if err != nil || n != 6 {
		t.Fatalf("nil-progress: n=%d err=%v", n, err)
	}

	dst.Reset()
	var seen int64
	n, err = sftpDownloadCopy(&dst, strings.NewReader("data!!"), func(w int64) error { seen = w; return nil })
	if err != nil || n != 6 || seen != 6 {
		t.Fatalf("with-progress: n=%d err=%v seen=%d", n, err, seen)
	}
}

func TestProgressReaderWrap_PropagatesError(t *testing.T) {
	pr := &progressReaderWrap{r: strings.NewReader("abc"), progress: func(int64) error { return errors.New("stop") }}
	buf := make([]byte, 8)
	// Must report 0 bytes alongside the error: pkg/sftp's sequential
	// ReadFrom fills its buffer with io.ReadFull, which discards a non-nil
	// error on a full read — so a (n>0, err) return would be swallowed and
	// the cancel ignored. (0, err) always propagates.
	n, err := pr.Read(buf)
	if err == nil {
		t.Fatal("expected progress error to surface from Read")
	}
	if n != 0 {
		t.Errorf("cancelling Read must report 0 bytes so io.ReadFull can't swallow the error, got n=%d", n)
	}
}

func TestProgressWriterWrap_PropagatesError(t *testing.T) {
	var dst bytes.Buffer
	pw := &progressWriterWrap{w: &dst, progress: func(int64) error { return errors.New("stop") }}
	if _, err := pw.Write([]byte("abc")); err == nil {
		t.Error("expected progress error to surface from Write")
	}
}

func TestS3ProgressReader_CountsBytes(t *testing.T) {
	var seen int64
	pr := &progressReader{r: strings.NewReader("0123456789"), progress: func(w int64) error { seen = w; return nil }}
	buf := make([]byte, 4)
	total := 0
	for {
		n, err := pr.Read(buf)
		total += n
		if err != nil {
			break
		}
	}
	if total != 10 || seen != 10 {
		t.Errorf("read %d (progress saw %d), want 10", total, seen)
	}
}

func TestClientName(t *testing.T) {
	cases := []struct {
		fc   FileClient
		want string
	}{
		{&SFTP{}, "sftp"},
		{&SCP{}, "scp"},
		{&FTP{}, "ftp"},
		{&S3{}, "s3"},
		{nil, ""},
	}
	for _, c := range cases {
		if got := ClientName(c.fc); got != c.want {
			t.Errorf("ClientName(%T) = %q, want %q", c.fc, got, c.want)
		}
	}
}

func TestWatchCancel_NilChannelIsNoOp(t *testing.T) {
	stop := watchCancel(nil)
	stop() // must not panic
}

func TestWatchCancel_ClosesOnCancel(t *testing.T) {
	cancel := make(chan struct{})
	c := &fakeCloser{}
	stop := watchCancel(cancel, c)
	close(cancel)
	// Give the watcher goroutine a moment to fire.
	waitFor(t, func() bool { return c.closed() })
	stop()
}

func TestWatchCancel_StopWithoutCancel(t *testing.T) {
	// Normal-completion path: the transfer finishes and stop() tells the
	// watcher to exit without ever touching the handles.
	cancel := make(chan struct{})
	c := &fakeCloser{}
	stop := watchCancel(cancel, c)
	stop()
	// The watcher should have taken the <-done branch and left c untouched.
	for i := 0; i < 50 && !c.closed(); i++ {
		time.Sleep(time.Millisecond)
	}
	if c.closed() {
		t.Error("closer should not fire when only stop() is called")
	}
}
