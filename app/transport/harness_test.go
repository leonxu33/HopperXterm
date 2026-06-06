package transport

// In-process SSH/SFTP server harness shared by the transport tests. It
// stands up a real SSH server on a loopback listener so DialSSH,
// StartShell, Shell.Ping/Resize, the SFTP client, and ProbeHostInfoSSH
// can be exercised end-to-end without a remote box.
//
// Auth: accepts password "testpass" for any user, and the single public
// key whose private half is written to ClientKeyPath (PEM). The pem path
// is fed to SSHDialConfig.PemFile so the public-key method is tried first
// and the test never depends on the developer's ssh-agent / ~/.ssh keys.
//
// Channels handled:
//   - "session" + "shell"     → byte-for-byte echo (Stdin round-trips to Stdout)
//   - "session" + "exec"      → probe script returns a canned Ubuntu banner;
//                               "sh -s" (resource monitor) streams v3 lines
//   - "session" + "subsystem" → "sftp" served by pkg/sftp against the real FS
//   - global "keepalive@..."  → replied to, so Shell.Ping succeeds

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"encoding/pem"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

// cannedProbeOutput is what the harness returns for the OS-identity probe
// (a marker-delimited Ubuntu banner ParseHostInfoOutput can read).
const cannedProbeOutput = "----HOPPERPROBE-KERNEL----\n" +
	"Linux 6.8.0-test x86_64\n" +
	"----HOPPERPROBE-HOSTNAME----\n" +
	"harness-host\n" +
	"----HOPPERPROBE-OSREL----\n" +
	"PRETTY_NAME=\"Ubuntu 24.04 LTS\"\nNAME=\"Ubuntu\"\n" +
	"----HOPPERPROBE-MACOS----\n" +
	"----HOPPERPROBE-END----\n"

type testSSHServer struct {
	Addr          string // host:port of the loopback listener
	Host          string
	Port          int
	ClientKeyPath string // PEM private key accepted by the server (for PemFile)

	listener net.Listener
	wg       sync.WaitGroup
}

// newTestSSHServer starts a loopback SSH server and returns it. The
// caller must defer srv.Close(). A fresh host key is generated each call,
// so each test gets its own TOFU known_hosts entry.
func newTestSSHServer(t *testing.T) *testSSHServer {
	t.Helper()

	// Host key.
	_, hostPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("host key: %v", err)
	}
	hostSigner, err := ssh.NewSignerFromKey(hostPriv)
	if err != nil {
		t.Fatalf("host signer: %v", err)
	}

	// Client key — written to disk so DialSSH can read it via PemFile.
	clientPub, clientPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("client key: %v", err)
	}
	clientAuthorized, err := ssh.NewPublicKey(clientPub)
	if err != nil {
		t.Fatalf("client public key: %v", err)
	}
	pemBlock, err := ssh.MarshalPrivateKey(clientPriv, "")
	if err != nil {
		t.Fatalf("marshal client key: %v", err)
	}
	keyPath := filepath.Join(t.TempDir(), "client.pem")
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(pemBlock), 0o600); err != nil {
		t.Fatalf("write client key: %v", err)
	}

	cfg := &ssh.ServerConfig{
		MaxAuthTries: 1000, // tolerate stray agent keys the developer may have
		PasswordCallback: func(_ ssh.ConnMetadata, pass []byte) (*ssh.Permissions, error) {
			if string(pass) == "testpass" {
				return nil, nil
			}
			return nil, errDenied
		},
		PublicKeyCallback: func(_ ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			if bytes.Equal(key.Marshal(), clientAuthorized.Marshal()) {
				return nil, nil
			}
			return nil, errDenied
		},
	}
	cfg.AddHostKey(hostSigner)

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	host, portStr, _ := net.SplitHostPort(ln.Addr().String())
	port := 0
	for _, c := range portStr {
		port = port*10 + int(c-'0')
	}

	srv := &testSSHServer{
		Addr:          ln.Addr().String(),
		Host:          host,
		Port:          port,
		ClientKeyPath: keyPath,
		listener:      ln,
	}

	srv.wg.Add(1)
	go func() {
		defer srv.wg.Done()
		for {
			conn, err := ln.Accept()
			if err != nil {
				return // listener closed
			}
			srv.wg.Add(1)
			go func() {
				defer srv.wg.Done()
				srv.handleConn(conn, cfg)
			}()
		}
	}()
	return srv
}

func (s *testSSHServer) Close() {
	_ = s.listener.Close()
	s.wg.Wait()
}

// dialConfig returns an SSHDialConfig pre-pointed at this server using the
// client PEM key (public-key auth, tried first).
func (s *testSSHServer) dialConfig() SSHDialConfig {
	return SSHDialConfig{
		Host:    s.Host,
		User:    "tester",
		Port:    s.Port,
		Timeout: 5 * time.Second,
		PemFile: s.ClientKeyPath,
	}
}

func (s *testSSHServer) handleConn(conn net.Conn, cfg *ssh.ServerConfig) {
	sconn, chans, reqs, err := ssh.NewServerConn(conn, cfg)
	if err != nil {
		_ = conn.Close()
		return
	}
	defer sconn.Close()

	// Reply to global requests (keepalive@openssh.com) so Shell.Ping
	// gets a round-trip.
	go func() {
		for req := range reqs {
			if req.WantReply {
				_ = req.Reply(true, nil)
			}
		}
	}()

	for nc := range chans {
		if nc.ChannelType() != "session" {
			_ = nc.Reject(ssh.UnknownChannelType, "only session channels")
			continue
		}
		ch, chReqs, err := nc.Accept()
		if err != nil {
			return
		}
		go handleSession(ch, chReqs)
	}
}

func handleSession(ch ssh.Channel, reqs <-chan *ssh.Request) {
	for req := range reqs {
		switch req.Type {
		case "pty-req", "window-change", "env":
			if req.WantReply {
				_ = req.Reply(true, nil)
			}
		case "shell":
			if req.WantReply {
				_ = req.Reply(true, nil)
			}
			// Echo loop: client stdin → client stdout. On an "exit" line
			// the server closes the channel (EOF + exit-status), modeling a
			// remote login shell logging out so StartShell's Wait goroutine
			// closes the read pipe and the pane observes io.EOF.
			go func() {
				buf := make([]byte, 256)
				for {
					n, err := ch.Read(buf)
					if n > 0 {
						_, _ = ch.Write(buf[:n])
						if bytes.Contains(buf[:n], []byte("exit")) {
							sendExit(ch, 0)
							break
						}
					}
					if err != nil {
						break
					}
				}
				_ = ch.Close()
			}()
		case "exec":
			if req.WantReply {
				_ = req.Reply(true, nil)
			}
			cmd := decodeExecCommand(req.Payload)
			go runExec(ch, cmd)
		case "subsystem":
			name := decodeExecCommand(req.Payload) // same 4-byte-len framing
			if name == "sftp" {
				if req.WantReply {
					_ = req.Reply(true, nil)
				}
				go serveSFTP(ch)
			} else if req.WantReply {
				_ = req.Reply(false, nil)
			}
		default:
			if req.WantReply {
				_ = req.Reply(false, nil)
			}
		}
	}
}

// runExec serves the two exec shapes the app uses: the probe script and
// the resource-monitor's "sh -s" stream.
func runExec(ch ssh.Channel, cmd string) {
	defer ch.Close()
	if strings.Contains(cmd, "HOPPERPROBE") {
		_, _ = io.WriteString(ch, cannedProbeOutput)
		sendExit(ch, 0)
		return
	}
	// Owner/Group name resolution (SFTP.ensureIDMaps) — canned getent output.
	if strings.Contains(cmd, "getent passwd") {
		_, _ = io.WriteString(ch, "root:x:0:0:root:/root:/bin/bash\ntestuser:x:1000:1000:Test User:/home/testuser:/bin/bash\n")
		sendExit(ch, 0)
		return
	}
	if strings.Contains(cmd, "getent group") {
		_, _ = io.WriteString(ch, "root:x:0:\ntestgroup:x:1000:\n")
		sendExit(ch, 0)
		return
	}
	// Resource monitor: stream v3 lines until the client closes the channel.
	line := "v3 1700000000000 12 4000000 8000000 1.5 2.5 10.0 5.0 3600 0.42 " +
		"5000000 20000000 100000 50000 - - -\n"
	for {
		if _, err := io.WriteString(ch, line); err != nil {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func serveSFTP(ch ssh.Channel) {
	server, err := sftp.NewServer(ch)
	if err != nil {
		_ = ch.Close()
		return
	}
	_ = server.Serve()
	_ = server.Close()
	_ = ch.Close()
}

// decodeExecCommand pulls the command/subsystem string out of an SSH
// request payload (4-byte big-endian length prefix + bytes).
func decodeExecCommand(payload []byte) string {
	if len(payload) < 4 {
		return ""
	}
	n := binary.BigEndian.Uint32(payload)
	if int(n) > len(payload)-4 {
		n = uint32(len(payload) - 4)
	}
	return string(payload[4 : 4+n])
}

func sendExit(ch ssh.Channel, code uint32) {
	var b [4]byte
	binary.BigEndian.PutUint32(b[:], code)
	_, _ = ch.SendRequest("exit-status", false, b[:])
}

// errDenied is the auth-rejection error the harness callbacks return.
var errDenied = &authError{"permission denied"}

type authError struct{ msg string }

func (e *authError) Error() string { return e.msg }

// isolateSSHHome points os.UserHomeDir() at a throwaway dir so the TOFU
// host-key callback writes its known_hosts into the temp tree instead of
// polluting the developer's real ~/.ssh. Also clears SSH_AUTH_SOCK so the
// auth chain doesn't reach for a live agent.
func isolateSSHHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)        // unix
	t.Setenv("USERPROFILE", home) // windows
	t.Setenv("SSH_AUTH_SOCK", "")
	return home
}
