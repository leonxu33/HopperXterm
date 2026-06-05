package pane

import (
	"context"
	"errors"
	"testing"
	"time"

	"hopperxterm/profile"
)

// stateSync polls until cond returns true or budget elapses.
func stateSync(t *testing.T, budget time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(budget)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatal("condition not met within budget")
}

func newTestPane(t *testing.T) *Pane {
	t.Helper()
	// appCtx is the parent for emitted events; in tests no runtime context
	// is wired, so emit calls silently no-op.
	return newPane(context.Background(), "p-test", profile.Session{ID: "s", Type: profile.SessionSSH, Host: "x", User: "u"})
}

func TestNewPane_InitialState(t *testing.T) {
	p := newTestPane(t)
	if got := p.State(); got != StateConnecting {
		t.Errorf("initial state got %s want %s", got, StateConnecting)
	}
}

func TestTransition_IgnoresIdempotent(t *testing.T) {
	p := newTestPane(t)
	// Same state shouldn't toggle anything weird.
	p.transition(StateConnecting, "still connecting")
	if got := p.State(); got != StateConnecting {
		t.Errorf("state changed unexpectedly")
	}
	// Real progression.
	p.transition(StateConnected, "")
	if got := p.State(); got != StateConnected {
		t.Errorf("transition to Connected failed: got %s", got)
	}
}

func TestPromptAndSendInput_PasswordRoundTrip(t *testing.T) {
	p := newTestPane(t)
	// Run prompt in goroutine — it'll block until SendInput delivers Enter.
	type result struct {
		text string
		err  error
	}
	done := make(chan result, 1)
	go func() {
		got, err := p.prompt("Password: ", false)
		done <- result{text: got, err: err}
	}()

	// authActive must flip to true before SendInput is called; the goroutine
	// is now sitting on the channel receive in prompt().
	stateSync(t, 200*time.Millisecond, func() bool {
		p.authMu.Lock()
		on := p.authActive
		p.authMu.Unlock()
		return on
	})

	// Send "hi" then Enter.
	if err := p.SendInput([]byte("hi\r")); err != nil {
		t.Fatalf("SendInput: %v", err)
	}

	select {
	case r := <-done:
		if r.err != nil {
			t.Errorf("prompt returned err: %v", r.err)
		}
		if r.text != "hi" {
			t.Errorf("password got %q want %q", r.text, "hi")
		}
	case <-time.After(time.Second):
		t.Fatal("prompt did not return within 1s")
	}

	// authActive must be cleared after submission.
	p.authMu.Lock()
	if p.authActive {
		t.Errorf("authActive still true after submit")
	}
	p.authMu.Unlock()
}

func TestPromptAndSendInput_Backspace(t *testing.T) {
	p := newTestPane(t)
	done := make(chan string, 1)
	go func() {
		got, _ := p.prompt("PW: ", false)
		done <- got
	}()
	stateSync(t, 200*time.Millisecond, func() bool {
		p.authMu.Lock()
		on := p.authActive
		p.authMu.Unlock()
		return on
	})

	// "abc" + 0x7f (DEL) + "Z" + Enter → "abZ"
	if err := p.SendInput([]byte{'a', 'b', 'c', 0x7f, 'Z', '\r'}); err != nil {
		t.Fatalf("SendInput: %v", err)
	}
	select {
	case got := <-done:
		if got != "abZ" {
			t.Errorf("got %q want %q", got, "abZ")
		}
	case <-time.After(time.Second):
		t.Fatal("prompt timeout")
	}
}

func TestPromptAndSendInput_CtrlCCancels(t *testing.T) {
	p := newTestPane(t)
	type result struct {
		text string
		err  error
	}
	done := make(chan result, 1)
	go func() {
		got, err := p.prompt("PW: ", false)
		done <- result{text: got, err: err}
	}()
	stateSync(t, 200*time.Millisecond, func() bool {
		p.authMu.Lock()
		on := p.authActive
		p.authMu.Unlock()
		return on
	})
	if err := p.SendInput([]byte{'h', 'i', 0x03}); err != nil {
		t.Fatalf("SendInput: %v", err)
	}
	select {
	case r := <-done:
		if r.err == nil {
			t.Errorf("expected cancellation error, got nil; text=%q", r.text)
		}
	case <-time.After(time.Second):
		t.Fatal("prompt timeout")
	}
}

func TestPromptCancelledByContext(t *testing.T) {
	p := newTestPane(t)
	type result struct {
		text string
		err  error
	}
	done := make(chan result, 1)
	go func() {
		got, err := p.prompt("PW: ", false)
		done <- result{text: got, err: err}
	}()
	stateSync(t, 200*time.Millisecond, func() bool {
		p.authMu.Lock()
		on := p.authActive
		p.authMu.Unlock()
		return on
	})
	p.cancel()
	select {
	case r := <-done:
		if !errors.Is(r.err, context.Canceled) {
			t.Errorf("expected ctx canceled, got %v", r.err)
		}
	case <-time.After(time.Second):
		t.Fatal("prompt timeout after cancel")
	}
}

func TestSendInput_NotConnectedNoAuthActive(t *testing.T) {
	p := newTestPane(t)
	// Not connected (shell == nil) and authActive == false: should return
	// the "not connected" error.
	err := p.SendInput([]byte("hello"))
	if err == nil {
		t.Errorf("expected 'not connected', got nil")
	}
}

func TestResize_NotConnected(t *testing.T) {
	p := newTestPane(t)
	if err := p.Resize(80, 24); err == nil {
		t.Errorf("expected error when not connected, got nil")
	}
}

func TestFileClient_NotConnected(t *testing.T) {
	p := newTestPane(t)
	if _, err := p.fileClient(); err == nil {
		t.Errorf("expected 'no file client', got nil")
	}
}

func TestStartResourceMonitor_NotConnected(t *testing.T) {
	p := newTestPane(t)
	if err := p.StartResourceMonitor(); err == nil {
		t.Errorf("expected 'not connected', got nil")
	}
}

func TestStopResourceMonitor_IdempotentWhenOff(t *testing.T) {
	p := newTestPane(t)
	// Should not panic.
	p.StopResourceMonitor()
}
