package pane

// Minimal in-process SSH/SFTP server for the pane connect tests — a
// trimmed sibling of transport's harness. Accepts a generated key
// (written to ClientKeyPath, fed to the session's PemFile), echoes the
// shell, serves SFTP, answers keepalives, and replies to the probe /
// resource exec channels.

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

const cannedProbe = "----HOPPERPROBE-KERNEL----\nLinux 6.8.0-test x86_64\n" +
	"----HOPPERPROBE-HOSTNAME----\nharness\n" +
	"----HOPPERPROBE-OSREL----\nPRETTY_NAME=\"Ubuntu 24.04 LTS\"\n" +
	"----HOPPERPROBE-MACOS----\n----HOPPERPROBE-END----\n"

type paneSSHServer struct {
	Host, KeyPath string
	Port          int
	ln            net.Listener
	wg            sync.WaitGroup
}

func startPaneSSHServer(t *testing.T) *paneSSHServer {
	t.Helper()
	_, hostPriv, _ := ed25519.GenerateKey(rand.Reader)
	hostSigner, _ := ssh.NewSignerFromKey(hostPriv)

	clientPub, clientPriv, _ := ed25519.GenerateKey(rand.Reader)
	authorized, _ := ssh.NewPublicKey(clientPub)
	block, _ := ssh.MarshalPrivateKey(clientPriv, "")
	keyPath := filepath.Join(t.TempDir(), "client.pem")
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(block), 0o600); err != nil {
		t.Fatalf("write key: %v", err)
	}

	cfg := &ssh.ServerConfig{
		MaxAuthTries: 1000,
		PublicKeyCallback: func(_ ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			if bytes.Equal(key.Marshal(), authorized.Marshal()) {
				return nil, nil
			}
			return nil, errAuth
		},
		PasswordCallback: func(_ ssh.ConnMetadata, p []byte) (*ssh.Permissions, error) {
			if string(p) == "testpass" {
				return nil, nil
			}
			return nil, errAuth
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
	s := &paneSSHServer{Host: host, Port: port, KeyPath: keyPath, ln: ln}
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			s.wg.Add(1)
			go func() { defer s.wg.Done(); paneHandleConn(conn, cfg) }()
		}
	}()
	t.Cleanup(s.Close)
	return s
}

func (s *paneSSHServer) Close() {
	_ = s.ln.Close()
	s.wg.Wait()
}

func paneHandleConn(conn net.Conn, cfg *ssh.ServerConfig) {
	sconn, chans, reqs, err := ssh.NewServerConn(conn, cfg)
	if err != nil {
		_ = conn.Close()
		return
	}
	defer sconn.Close()
	go func() {
		for r := range reqs {
			if r.WantReply {
				_ = r.Reply(true, nil)
			}
		}
	}()
	for nc := range chans {
		if nc.ChannelType() != "session" {
			_ = nc.Reject(ssh.UnknownChannelType, "no")
			continue
		}
		ch, creqs, err := nc.Accept()
		if err != nil {
			return
		}
		go paneHandleSession(ch, creqs)
	}
}

func paneHandleSession(ch ssh.Channel, reqs <-chan *ssh.Request) {
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
			go func() { _, _ = io.Copy(ch, ch); _ = ch.Close() }()
		case "exec":
			if req.WantReply {
				_ = req.Reply(true, nil)
			}
			go paneRunExec(ch, decodeReqString(req.Payload))
		case "subsystem":
			if decodeReqString(req.Payload) == "sftp" {
				if req.WantReply {
					_ = req.Reply(true, nil)
				}
				go func() {
					srv, err := sftp.NewServer(ch)
					if err == nil {
						_ = srv.Serve()
						_ = srv.Close()
					}
					_ = ch.Close()
				}()
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

func paneRunExec(ch ssh.Channel, cmd string) {
	defer ch.Close()
	if strings.Contains(cmd, "HOPPERPROBE") {
		_, _ = io.WriteString(ch, cannedProbe)
		var b [4]byte
		_, _ = ch.SendRequest("exit-status", false, b[:])
		return
	}
	line := "v3 1700000000000 12 4000000 8000000 1.5 2.5 10.0 5.0 3600 0.42 " +
		"5000000 20000000 100000 50000 - - -\n"
	for {
		if _, err := io.WriteString(ch, line); err != nil {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func decodeReqString(payload []byte) string {
	if len(payload) < 4 {
		return ""
	}
	n := binary.BigEndian.Uint32(payload)
	if int(n) > len(payload)-4 {
		n = uint32(len(payload) - 4)
	}
	return string(payload[4 : 4+n])
}

var errAuth = &paneAuthErr{}

type paneAuthErr struct{}

func (*paneAuthErr) Error() string { return "denied" }

// isolateHome points os.UserHomeDir() at a temp dir so the TOFU host-key
// callback doesn't touch the developer's real ~/.ssh.
func isolateHome(t *testing.T) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("SSH_AUTH_SOCK", "")
}
