package transport

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

func TestDialSSH_PublicKey(t *testing.T) {
	isolateSSHHome(t)
	srv := newTestSSHServer(t)
	defer srv.Close()

	client, err := DialSSH(srv.dialConfig())
	if err != nil {
		t.Fatalf("DialSSH: %v", err)
	}
	defer client.Close()
}

func TestDialSSH_SavedPassword(t *testing.T) {
	isolateSSHHome(t)
	srv := newTestSSHServer(t)
	defer srv.Close()

	cfg := srv.dialConfig()
	cfg.PemFile = "" // force the password path
	cfg.SavedPassword = "testpass"
	client, err := DialSSH(cfg)
	if err != nil {
		t.Fatalf("DialSSH with saved password: %v", err)
	}
	defer client.Close()
}

func TestDialSSH_InteractivePrompter(t *testing.T) {
	isolateSSHHome(t)
	srv := newTestSSHServer(t)
	defer srv.Close()

	cfg := srv.dialConfig()
	cfg.PemFile = ""
	asked := false
	cfg.Prompter = func(question string, echo bool) (string, error) {
		asked = true
		return "testpass", nil
	}
	client, err := DialSSH(cfg)
	if err != nil {
		t.Fatalf("DialSSH with prompter: %v", err)
	}
	defer client.Close()
	if !asked {
		t.Errorf("prompter was never consulted")
	}
}

func TestDialSSH_WrongPasswordFails(t *testing.T) {
	isolateSSHHome(t)
	srv := newTestSSHServer(t)
	defer srv.Close()

	cfg := srv.dialConfig()
	cfg.PemFile = ""
	cfg.SavedPassword = "wrong"
	// No prompter → the only method is the (wrong) saved password.
	if _, err := DialSSH(cfg); err == nil {
		t.Fatal("expected handshake failure with wrong password")
	}
}

// A stale saved password (e.g. the remote password was changed) must fall
// through to the interactive prompter, even on a server that offers only the
// "password" method and not keyboard-interactive. Regression guard: a separate
// ssh.Password(saved) method used to consume the "password" slot so the
// prompter was never reached.
func TestDialSSH_WrongSavedPasswordFallsThroughToPrompt(t *testing.T) {
	isolateSSHHome(t)
	srv := newTestSSHServer(t)
	defer srv.Close()

	cfg := srv.dialConfig()
	cfg.PemFile = "" // force the password path
	cfg.SavedPassword = "stale-wrong-password"
	asked := false
	cfg.Prompter = func(question string, echo bool) (string, error) {
		asked = true
		return "testpass", nil // the new, correct password
	}
	client, err := DialSSH(cfg)
	if err != nil {
		t.Fatalf("expected fall-through to prompter after a wrong saved password: %v", err)
	}
	defer client.Close()
	if !asked {
		t.Error("prompter was never consulted after the saved password was rejected")
	}
}

func TestDialSSH_Validation(t *testing.T) {
	if _, err := DialSSH(SSHDialConfig{User: "u"}); err == nil {
		t.Error("expected error when host is empty")
	}
	if _, err := DialSSH(SSHDialConfig{Host: "h"}); err == nil {
		t.Error("expected error when user is empty")
	}
}

func TestStartShell_EchoRoundTrip(t *testing.T) {
	isolateSSHHome(t)
	srv := newTestSSHServer(t)
	defer srv.Close()

	client, err := DialSSH(srv.dialConfig())
	if err != nil {
		t.Fatalf("DialSSH: %v", err)
	}
	defer client.Close()

	shell, err := StartShell(client)
	if err != nil {
		t.Fatalf("StartShell: %v", err)
	}
	defer shell.Close()

	if _, err := shell.Stdin().Write([]byte("ping\n")); err != nil {
		t.Fatalf("write: %v", err)
	}
	got := readUntil(t, shell.Stdout(), "ping", 2*time.Second)
	if !strings.Contains(got, "ping") {
		t.Errorf("echo round-trip: got %q, want it to contain %q", got, "ping")
	}

	// Resize sends a window-change the harness accepts.
	if err := shell.Resize(120, 40); err != nil {
		t.Errorf("Resize: %v", err)
	}

	// Ping does a keepalive round-trip the harness replies to.
	if !shell.Ping(context.Background(), 2*time.Second) {
		t.Errorf("Ping returned false against a live server")
	}
}

// TestStartShell_RemoteExitClosesOutput guards the fix for the bug where
// typing `exit` on the remote shell left the pane hung: x/crypto/ssh copies
// channel data into sess.Stdout but never closes that writer when the shell
// exits, so StartShell now Waits on the session and closes the read pipe.
// Without that, this read would block forever and the pane would never go
// Disconnected (so the "Press r to reconnect." hint would never print).
func TestStartShell_RemoteExitClosesOutput(t *testing.T) {
	isolateSSHHome(t)
	srv := newTestSSHServer(t)
	defer srv.Close()

	client, err := DialSSH(srv.dialConfig())
	if err != nil {
		t.Fatalf("DialSSH: %v", err)
	}
	defer client.Close()

	shell, err := StartShell(client)
	if err != nil {
		t.Fatalf("StartShell: %v", err)
	}
	defer shell.Close()

	if _, err := shell.Stdin().Write([]byte("exit\n")); err != nil {
		t.Fatalf("write exit: %v", err)
	}

	done := make(chan error, 1)
	go func() {
		buf := make([]byte, 256)
		for {
			if _, err := shell.Stdout().Read(buf); err != nil {
				done <- err
				return
			}
		}
	}()

	select {
	case err := <-done:
		if err != io.EOF {
			t.Fatalf("after remote exit: got %v, want io.EOF", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Stdout never reached EOF after remote shell exit — pipe writer left open")
	}
}

func TestShell_PingFalseCases(t *testing.T) {
	// Nil client → false, never blocks.
	s := &Shell{}
	if s.Ping(context.Background(), time.Second) {
		t.Error("Ping on a nil-client shell should be false")
	}
	// Cancelled context → false.
	isolateSSHHome(t)
	srv := newTestSSHServer(t)
	defer srv.Close()
	client, err := DialSSH(srv.dialConfig())
	if err != nil {
		t.Fatalf("DialSSH: %v", err)
	}
	defer client.Close()
	shell := &Shell{Client: client}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if shell.Ping(ctx, time.Second) {
		t.Error("Ping with a cancelled context should be false")
	}
}

func TestShell_ResizeAndCloseEdgeCases(t *testing.T) {
	s := &Shell{} // no session
	if err := s.Resize(80, 24); err == nil {
		t.Error("Resize without a session should error")
	}
	// Close on an empty shell is a safe no-op.
	if err := s.Close(); err != nil {
		t.Errorf("Close on empty shell: %v", err)
	}
}

// ---- auth method assembly ---------------------------------------------------

func TestCollectAuthMethods_PrompterAddsPasswordAndKeyboard(t *testing.T) {
	isolateSSHHome(t)
	prompter := func(string, bool) (string, error) { return "x", nil }
	methods, err := collectAuthMethods(prompter, "", "")
	if err != nil {
		t.Fatalf("collectAuthMethods: %v", err)
	}
	// At minimum: password + keyboard-interactive.
	if len(methods) < 2 {
		t.Errorf("expected >=2 methods with a prompter, got %d", len(methods))
	}
}

func TestCollectAuthMethods_PemFileAndSavedPassword(t *testing.T) {
	isolateSSHHome(t)
	keyPath := writeTestKey(t)
	methods, err := collectAuthMethods(nil, "secret", keyPath)
	if err != nil {
		t.Fatalf("collectAuthMethods: %v", err)
	}
	// PEM key + saved password → at least two methods.
	if len(methods) < 2 {
		t.Errorf("expected >=2 methods (pem + password), got %d", len(methods))
	}
}

func TestKeyFileAuth(t *testing.T) {
	keyPath := writeTestKey(t)
	m, err := keyFileAuth(keyPath)
	if err != nil || m == nil {
		t.Fatalf("keyFileAuth on a valid key: m=%v err=%v", m, err)
	}
	if _, err := keyFileAuth(filepath.Join(t.TempDir(), "nope.pem")); err == nil {
		t.Error("keyFileAuth on a missing file should error")
	}
	bad := filepath.Join(t.TempDir(), "bad.pem")
	_ = os.WriteFile(bad, []byte("not a key"), 0o600)
	if _, err := keyFileAuth(bad); err == nil {
		t.Error("keyFileAuth on garbage should error")
	}
}

// ---- TOFU host-key callback -------------------------------------------------

func TestTofuHostKeyCallback_TOFUThenMismatch(t *testing.T) {
	home := isolateSSHHome(t)

	cb, err := tofuHostKeyCallback(nil)
	if err != nil {
		t.Fatalf("tofuHostKeyCallback: %v", err)
	}

	addr := &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 2222}
	key1 := genHostKey(t)
	key2 := genHostKey(t)

	// First sight of the host → accepted and recorded (TOFU).
	if err := cb("127.0.0.1:2222", addr, key1); err != nil {
		t.Fatalf("first TOFU accept failed: %v", err)
	}
	// known_hosts now exists with an entry.
	kh := filepath.Join(home, ".ssh", "known_hosts")
	if b, _ := os.ReadFile(kh); len(b) == 0 {
		t.Fatal("known_hosts not written on TOFU")
	}
	// Same key again → still fine.
	if err := cb("127.0.0.1:2222", addr, key1); err != nil {
		t.Errorf("re-seeing the same key should pass: %v", err)
	}
	// Different key for the same host → fail closed.
	err = cb("127.0.0.1:2222", addr, key2)
	if err == nil {
		t.Fatal("changed host key should be rejected")
	}
	if !strings.Contains(err.Error(), "changed") {
		t.Errorf("mismatch error = %q, want it to mention the key changed", err.Error())
	}
}

func TestTofuHostKeyCallback_PrompterAcceptsChangedKey(t *testing.T) {
	home := isolateSSHHome(t)
	addr := &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 2222}
	key1 := genHostKey(t)
	key2 := genHostKey(t)

	// Seed known_hosts with key1 via TOFU (no prompter needed).
	seed, _ := tofuHostKeyCallback(nil)
	if err := seed("127.0.0.1:2222", addr, key1); err != nil {
		t.Fatalf("seed TOFU: %v", err)
	}

	// A prompter that accepts the changed key.
	asked := false
	accept, _ := tofuHostKeyCallback(func(host, oldFP, newFP string) bool {
		asked = true
		if oldFP == "" || newFP == "" || oldFP == newFP {
			t.Errorf("expected distinct non-empty fingerprints, got old=%q new=%q", oldFP, newFP)
		}
		return true
	})
	if err := accept("127.0.0.1:2222", addr, key2); err != nil {
		t.Fatalf("accepting the changed key should succeed: %v", err)
	}
	if !asked {
		t.Error("prompter was not consulted on a changed key")
	}

	// known_hosts must now trust key2 and no longer key1.
	verify, _ := tofuHostKeyCallback(nil)
	if err := verify("127.0.0.1:2222", addr, key2); err != nil {
		t.Errorf("new key should now be trusted: %v", err)
	}
	if err := verify("127.0.0.1:2222", addr, key1); err == nil {
		t.Error("old key should no longer be trusted after replacement")
	}
	_ = home
}

func TestTofuHostKeyCallback_NilPrompterStillRefuses(t *testing.T) {
	isolateSSHHome(t)
	addr := &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 2222}
	key1 := genHostKey(t)
	key2 := genHostKey(t)
	cb, _ := tofuHostKeyCallback(nil)
	_ = cb("127.0.0.1:2222", addr, key1) // TOFU
	if err := cb("127.0.0.1:2222", addr, key2); err == nil {
		t.Error("nil prompter must keep failing closed on a changed key")
	}
}

func TestTofuHostKeyCallback_CreatesSSHDir(t *testing.T) {
	home := isolateSSHHome(t)
	if _, err := tofuHostKeyCallback(nil); err != nil {
		t.Fatalf("tofuHostKeyCallback: %v", err)
	}
	if fi, err := os.Stat(filepath.Join(home, ".ssh")); err != nil || !fi.IsDir() {
		t.Errorf("~/.ssh not created: err=%v", err)
	}
}

// ---- helpers ----------------------------------------------------------------

func writeTestKey(t *testing.T) string {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	block, err := ssh.MarshalPrivateKey(priv, "")
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	p := filepath.Join(t.TempDir(), "id_test")
	if err := os.WriteFile(p, pem.EncodeToMemory(block), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	return p
}

func genHostKey(t *testing.T) ssh.PublicKey {
	t.Helper()
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	pk, err := ssh.NewPublicKey(pub)
	if err != nil {
		t.Fatalf("NewPublicKey: %v", err)
	}
	return pk
}

// Confirm the harness's known_hosts seeding interacts with knownhosts.New
// the way DialSSH expects (sanity check on the helper, not production code).
func TestKnownHostsRoundTrip(t *testing.T) {
	home := isolateSSHHome(t)
	dir := filepath.Join(home, ".ssh")
	_ = os.MkdirAll(dir, 0o700)
	file := filepath.Join(dir, "known_hosts")
	key := genHostKey(t)
	line := knownhosts.Line([]string{knownhosts.Normalize("127.0.0.1:2222")}, key)
	if err := os.WriteFile(file, []byte(line+"\n"), 0o600); err != nil {
		t.Fatalf("seed known_hosts: %v", err)
	}
	cb, err := knownhosts.New(file)
	if err != nil {
		t.Fatalf("knownhosts.New: %v", err)
	}
	addr := &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 2222}
	if err := cb("127.0.0.1:2222", addr, key); err != nil {
		t.Errorf("seeded key should validate: %v", err)
	}
}

// readUntil reads from r until `want` appears or the deadline passes.
func readUntil(t *testing.T, r interface{ Read([]byte) (int, error) }, want string, d time.Duration) string {
	t.Helper()
	deadline := time.Now().Add(d)
	var sb strings.Builder
	type res struct {
		buf []byte
		err error
	}
	for time.Now().Before(deadline) {
		ch := make(chan res, 1)
		go func() {
			buf := make([]byte, 256)
			n, err := r.Read(buf)
			ch <- res{buf[:n], err}
		}()
		select {
		case rr := <-ch:
			if len(rr.buf) > 0 {
				sb.Write(rr.buf)
				if strings.Contains(sb.String(), want) {
					return sb.String()
				}
			}
			if rr.err != nil {
				return sb.String()
			}
		case <-time.After(time.Until(deadline)):
			return sb.String()
		}
	}
	return sb.String()
}
