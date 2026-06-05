package transport

import (
	"crypto/ed25519"
	"crypto/rand"
	"net"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

// A single corrupt line in known_hosts must not block verification of the
// valid entries — regression for "illegal base64 data" failing the whole
// file and breaking every SSH connection.
func TestNewKnownHostsCallback_SkipsCorruptLines(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "known_hosts")

	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	pub := signer.PublicKey()

	host := knownhosts.Normalize("example.com:22")
	validLine := knownhosts.Line([]string{host}, pub)

	// Corrupt entry (illegal base64) followed by a comment, blank, and the
	// valid line — mirrors a hand-mangled / partially-written known_hosts.
	content := "bad.example.org ssh-ed25519 @@@not-valid-base64@@@\n" +
		"# a comment\n\n" + validLine + "\n"
	if err := os.WriteFile(file, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	cb, err := newKnownHostsCallback(file)
	if err != nil {
		t.Fatalf("loader should tolerate the corrupt line, got: %v", err)
	}

	addr := &net.TCPAddr{IP: net.ParseIP("127.0.0.1"), Port: 22}
	if err := cb("example.com:22", addr, pub); err != nil {
		t.Errorf("known host should verify against its key, got: %v", err)
	}

	// An unknown host must surface as a KeyError (TOFU path), not a parse
	// error — i.e. the callback is functional, just doesn't know this host.
	_, otherPriv, _ := ed25519.GenerateKey(rand.Reader)
	otherSigner, _ := ssh.NewSignerFromKey(otherPriv)
	if err := cb("unknown.example.net:22", addr, otherSigner.PublicKey()); err == nil {
		t.Error("expected an error for an unknown host")
	} else if _, ok := err.(*knownhosts.KeyError); !ok {
		t.Errorf("unknown host should yield *knownhosts.KeyError, got %T: %v", err, err)
	}
}

// A clean file with no corrupt lines still works (the fast path).
func TestNewKnownHostsCallback_CleanFile(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "known_hosts")

	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	signer, _ := ssh.NewSignerFromKey(priv)
	pub := signer.PublicKey()
	line := knownhosts.Line([]string{knownhosts.Normalize("host.example:22")}, pub)
	if err := os.WriteFile(file, []byte(line+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	cb, err := newKnownHostsCallback(file)
	if err != nil {
		t.Fatalf("clean file should load, got: %v", err)
	}
	addr := &net.TCPAddr{IP: net.ParseIP("127.0.0.1"), Port: 22}
	if err := cb("host.example:22", addr, pub); err != nil {
		t.Errorf("known host should verify, got: %v", err)
	}
}
