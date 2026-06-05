package transport

import (
	goruntime "runtime"
	"testing"
)

func TestStartLocalShell_Lifecycle(t *testing.T) {
	sh, err := StartLocalShell()
	if err != nil {
		t.Skipf("no local shell available on this host: %v", err)
	}
	defer sh.Close()

	if sh.Name() == "" {
		t.Error("local shell Name() is empty")
	}
	if sh.Stdin() == nil || sh.Stdout() == nil {
		t.Error("local shell Stdin/Stdout should be wired")
	}
	// Resize the freshly-allocated PTY.
	if err := sh.Resize(100, 30); err != nil {
		t.Errorf("Resize: %v", err)
	}
}

func TestLocalShell_ResizeAndWaitGuards(t *testing.T) {
	var s LocalShell // zero value: nothing running
	if err := s.Resize(80, 24); err == nil {
		t.Error("Resize on an unstarted shell should error")
	}
	if err := s.Wait(); err == nil {
		t.Error("Wait on an unstarted shell should error")
	}
	if err := s.Close(); err != nil {
		t.Errorf("Close on an unstarted shell should be a no-op: %v", err)
	}
}

func TestStartWSL_PlatformBehaviour(t *testing.T) {
	sh, err := StartWSL("")
	if goruntime.GOOS != "windows" {
		if err == nil {
			t.Error("StartWSL off Windows should error")
		}
		return
	}
	// On Windows, wsl.exe may or may not be installed. Either outcome
	// exercises the code path; just don't leak a process if it started.
	if err != nil {
		t.Logf("StartWSL returned (acceptable if WSL not installed): %v", err)
		return
	}
	if sh.Name() == "" {
		t.Error("WSL shell Name() empty")
	}
	_ = sh.Close()
}

func TestDecodeUTF16LE(t *testing.T) {
	// wsl.exe --list --quiet output: UTF-16LE, BOM-prefixed, CRLF lines.
	// Build the bytes for "Ubuntu\r\nDebian\r\n" with a leading BOM.
	enc := func(s string) []byte {
		b := []byte{0xFF, 0xFE} // BOM
		for _, r := range s {
			b = append(b, byte(r), byte(r>>8))
		}
		return b
	}
	got := decodeUTF16LE(enc("Ubuntu\r\nDebian\r\n"))
	if got != "Ubuntu\r\nDebian\r\n" {
		t.Fatalf("decodeUTF16LE = %q, want %q", got, "Ubuntu\r\nDebian\r\n")
	}
	// Trailing odd byte must be tolerated (dropped), not panic.
	if out := decodeUTF16LE([]byte{0x41, 0x00, 0x42}); out != "A" {
		t.Errorf("odd-length decode = %q, want %q", out, "A")
	}
	if decodeUTF16LE(nil) != "" {
		t.Error("nil decode should be empty")
	}
}
