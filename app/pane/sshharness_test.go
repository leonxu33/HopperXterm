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

	connMu sync.Mutex
	conns  []*ssh.ServerConn // live connections, for DropConnections

	// Durable-session (tmux) simulation. When tmuxInstalled is true the
	// detection probe answers with the marker (plus HOP_TMUX_HAS when the
	// queried session already exists in tmuxSessions). A `new-session -A`
	// exec creates the session (persists across detach, like real tmux);
	// `kill-session` or an `exit` in the shell destroys it. execLog records
	// every exec the client ran and shellReqs counts plain shell requests, so
	// tests can assert which launch path was taken.
	stateMu       sync.Mutex
	tmuxInstalled bool
	tmuxSessions  map[string]bool
	tmuxAttached  map[string]ssh.Channel // session name → its live attach channel
	execLog       []string
	shellReqs     int
	// tmuxCwd is the value a `tmux display-message … #{pane_current_path}`
	// poll streams back, mimicking the pane's working directory. Settable so a
	// cwd-follow test can change it and watch the poller propagate the update.
	tmuxCwd string
	// resourceDieAfter, when > 0, makes the resource poller exec emit that many
	// v3 lines and then close the channel — standing in for the remote script
	// dying on its own (a torn /proc read killing the shell) while the SSH
	// connection stays up. 0 streams forever, the normal case.
	resourceDieAfter int
	// resourceExecs counts entries into the sample-streaming branch of runExec.
	resourceExecs int
}

func (s *paneSSHServer) setResourceDieAfter(n int) {
	s.stateMu.Lock()
	s.resourceDieAfter = n
	s.stateMu.Unlock()
}

// resourceExecCount reports how many times the sample-streaming branch of
// runExec was entered, i.e. how many times a poller was launched — counted at
// the branch itself rather than by matching the exec string, because the
// resource and process pollers both run as "sh -s" and are indistinguishable
// from the command line alone.
func (s *paneSSHServer) resourceExecCount() int {
	s.stateMu.Lock()
	defer s.stateMu.Unlock()
	return s.resourceExecs
}

func (s *paneSSHServer) setTmuxCwd(path string) {
	s.stateMu.Lock()
	s.tmuxCwd = path
	s.stateMu.Unlock()
}

func (s *paneSSHServer) setTmux(installed bool) {
	s.stateMu.Lock()
	s.tmuxInstalled = installed
	s.tmuxSessions = map[string]bool{}
	s.tmuxAttached = map[string]ssh.Channel{}
	s.stateMu.Unlock()
}

// killSessionExternally simulates `tmux kill-session` run from outside
// HopperXterm (another terminal, or the session dying) while a pane is
// attached: the session is destroyed AND its attach channel is closed (the
// tmux client exits), but the SSH connection stays up. Mimics the client
// exiting cleanly with an exit-status, so the pane sees a clean close rather
// than a transport error.
func (s *paneSSHServer) killSessionExternally(name string) {
	s.stateMu.Lock()
	delete(s.tmuxSessions, name)
	ch := s.tmuxAttached[name]
	delete(s.tmuxAttached, name)
	s.stateMu.Unlock()
	if ch != nil {
		var b [4]byte
		_, _ = ch.SendRequest("exit-status", false, b[:])
		_ = ch.Close()
	}
}

func (s *paneSSHServer) tmuxHas(name string) bool {
	s.stateMu.Lock()
	defer s.stateMu.Unlock()
	return s.tmuxSessions[name]
}

func (s *paneSSHServer) tmuxAdd(name string) {
	s.stateMu.Lock()
	if s.tmuxSessions == nil {
		s.tmuxSessions = map[string]bool{}
	}
	s.tmuxSessions[name] = true
	s.stateMu.Unlock()
}

func (s *paneSSHServer) tmuxDel(name string) {
	s.stateMu.Lock()
	delete(s.tmuxSessions, name)
	s.stateMu.Unlock()
}

func (s *paneSSHServer) setAttached(name string, ch ssh.Channel) {
	s.stateMu.Lock()
	if s.tmuxAttached == nil {
		s.tmuxAttached = map[string]ssh.Channel{}
	}
	s.tmuxAttached[name] = ch
	s.stateMu.Unlock()
}

func (s *paneSSHServer) clearAttached(name string, ch ssh.Channel) {
	s.stateMu.Lock()
	if s.tmuxAttached[name] == ch {
		delete(s.tmuxAttached, name)
	}
	s.stateMu.Unlock()
}

// tmuxCount returns how many live sessions match the hopperxterm prefix.
func (s *paneSSHServer) tmuxCount() int {
	s.stateMu.Lock()
	defer s.stateMu.Unlock()
	n := 0
	for name := range s.tmuxSessions {
		if strings.HasPrefix(name, "hopperxterm-") {
			n++
		}
	}
	return n
}

func (s *paneSSHServer) execs() []string {
	s.stateMu.Lock()
	defer s.stateMu.Unlock()
	return append([]string(nil), s.execLog...)
}

func (s *paneSSHServer) shellCount() int {
	s.stateMu.Lock()
	defer s.stateMu.Unlock()
	return s.shellReqs
}

// tmuxArgAfter extracts the whitespace-delimited token following marker in a
// tmux command line (stripping single quotes), e.g. the session name after
// "new-session -A -s ". Returns "" when the marker isn't present.
func tmuxArgAfter(cmd, marker string) string {
	i := strings.Index(cmd, marker)
	if i < 0 {
		return ""
	}
	rest := strings.TrimSpace(cmd[i+len(marker):])
	if j := strings.IndexByte(rest, ' '); j >= 0 {
		rest = rest[:j]
	}
	return strings.Trim(rest, "'")
}

// DropConnections closes every live SSH connection while leaving the
// listener up, simulating a network drop the client must auto-reconnect
// from (a fresh dial reaches the same listener).
func (s *paneSSHServer) DropConnections() {
	s.connMu.Lock()
	conns := s.conns
	s.conns = nil
	s.connMu.Unlock()
	for _, c := range conns {
		_ = c.Close()
	}
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
			go func() { defer s.wg.Done(); s.handleConn(conn, cfg) }()
		}
	}()
	t.Cleanup(s.Close)
	return s
}

func (s *paneSSHServer) Close() {
	_ = s.ln.Close()
	s.wg.Wait()
}

func (s *paneSSHServer) handleConn(conn net.Conn, cfg *ssh.ServerConfig) {
	sconn, chans, reqs, err := ssh.NewServerConn(conn, cfg)
	if err != nil {
		_ = conn.Close()
		return
	}
	s.connMu.Lock()
	s.conns = append(s.conns, sconn)
	s.connMu.Unlock()
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
		go s.handleSession(ch, creqs)
	}
}

func (s *paneSSHServer) handleSession(ch ssh.Channel, reqs <-chan *ssh.Request) {
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
			s.stateMu.Lock()
			s.shellReqs++
			s.stateMu.Unlock()
			go paneShellLoop(ch)
		case "exec":
			if req.WantReply {
				_ = req.Reply(true, nil)
			}
			go s.runExec(ch, decodeReqString(req.Payload))
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

// paneShellLoop echoes shell input back like a real PTY. When it sees
// "exit" it simulates the remote shell exiting cleanly — sends an
// exit-status and closes the channel, but leaves the SSH connection up
// (so a client keepalive ping still succeeds). This is the signal the
// pane uses to distinguish a clean `exit` from a network drop.
func paneShellLoop(ch ssh.Channel) {
	defer ch.Close()
	buf := make([]byte, 1024)
	var line []byte
	for {
		n, err := ch.Read(buf)
		if n > 0 {
			_, _ = ch.Write(buf[:n]) // echo
			line = append(line, buf[:n]...)
			if bytes.Contains(line, []byte("exit")) {
				var b [4]byte
				_, _ = ch.SendRequest("exit-status", false, b[:])
				return
			}
		}
		if err != nil {
			return
		}
	}
}

func (s *paneSSHServer) runExec(ch ssh.Channel, cmd string) {
	defer ch.Close()
	s.stateMu.Lock()
	s.execLog = append(s.execLog, cmd)
	s.stateMu.Unlock()

	// `uname -s` is transport.ClassifyRemoteOS's inline fallback, used when the
	// poller starts before the connect-time probe has cached an OS family.
	// Answer it properly: without this it fell through to the sample-streaming
	// branch below, so classification gave up and this Linux fake remote was
	// driven with the PowerShell poller.
	if strings.TrimSpace(cmd) == "uname -s" {
		_, _ = io.WriteString(ch, "Linux\n")
		var b [4]byte
		_, _ = ch.SendRequest("exit-status", false, b[:])
		return
	}
	if strings.Contains(cmd, "HOPPERPROBE") {
		_, _ = io.WriteString(ch, cannedProbe)
		var b [4]byte
		_, _ = ch.SendRequest("exit-status", false, b[:])
		return
	}
	// NOTE: the launch command embeds a `command -v tmux && exec tmux …
	// new-session …` guard, so it contains BOTH "command -v tmux" and
	// "new-session -A -s". Match the launch (new-session) FIRST so the guard
	// substring doesn't misroute it to the detection branch below. The
	// detection probe has "has-session", never "new-session", so the two stay
	// disjoint.
	//
	// A durable pane's shell runs via exec (`tmux new-session -A …`) rather
	// than a plain shell request. Create the session (it now persists across a
	// detach, like real tmux), then behave like an interactive shell so the
	// pane's read/keepalive loops and clean-exit detection work as usual. An
	// `exit` destroys the session (last shell gone); a dropped channel leaves
	// it running so a reconnect can re-attach.
	if name := tmuxArgAfter(cmd, "new-session -A -s "); name != "" {
		s.tmuxAdd(name)
		s.setAttached(name, ch)
		defer s.clearAttached(name, ch)
		buf := make([]byte, 1024)
		var line []byte
		for {
			n, err := ch.Read(buf)
			if n > 0 {
				_, _ = ch.Write(buf[:n])
				line = append(line, buf[:n]...)
				if bytes.Contains(line, []byte("exit")) {
					s.tmuxDel(name)
					var b [4]byte
					_, _ = ch.SendRequest("exit-status", false, b[:])
					return
				}
			}
			if err != nil {
				return
			}
		}
	}
	// tmux availability + existence probe (durable sessions): echo the marker
	// iff tmux is "installed", plus HOP_TMUX_HAS when the queried session
	// already exists on this fake remote.
	if strings.Contains(cmd, "command -v tmux") {
		s.stateMu.Lock()
		installed := s.tmuxInstalled
		s.stateMu.Unlock()
		if installed {
			_, _ = io.WriteString(ch, tmuxDetectMarker+"\n")
			if s.tmuxHas(tmuxArgAfter(cmd, "has-session -t ")) {
				_, _ = io.WriteString(ch, tmuxHasMarker+"\n")
			}
		}
		var b [4]byte
		_, _ = ch.SendRequest("exit-status", false, b[:])
		return
	}
	// `tmux list-sessions` (the orphan reaper): report every live session and
	// whether it has an attached client.
	if strings.Contains(cmd, "list-sessions") {
		s.stateMu.Lock()
		for name := range s.tmuxSessions {
			att := "0"
			if s.tmuxAttached[name] != nil {
				att = "1"
			}
			_, _ = io.WriteString(ch, name+" "+att+"\n")
		}
		s.stateMu.Unlock()
		var b [4]byte
		_, _ = ch.SendRequest("exit-status", false, b[:])
		return
	}
	// `tmux kill-session -t <name>` (explicit user close OR the reaper, which
	// batches several `kill-session` in one command): destroy each named session.
	if strings.Contains(cmd, "kill-session -t") {
		rest := cmd
		for {
			i := strings.Index(rest, "kill-session -t ")
			if i < 0 {
				break
			}
			rest = rest[i+len("kill-session -t "):]
			name := rest
			if j := strings.IndexAny(name, " ;"); j >= 0 {
				name = name[:j]
			}
			s.tmuxDel(strings.Trim(name, "'"))
		}
		var b [4]byte
		_, _ = ch.SendRequest("exit-status", false, b[:])
		return
	}
	// `tmux display-message … #{pane_current_path}` (the cwd-follow poller):
	// stream the current tmuxCwd once per "tick" so the pane's reader can emit
	// pane:cwd and update lastCwd. Re-reads the value each loop so a test that
	// changes it mid-stream sees the new path propagate.
	if strings.Contains(cmd, "pane_current_path") {
		for {
			s.stateMu.Lock()
			cwd := s.tmuxCwd
			s.stateMu.Unlock()
			if _, err := io.WriteString(ch, cwd+"\n"); err != nil {
				return
			}
			time.Sleep(50 * time.Millisecond)
		}
	}
	line := "v3 1700000000000 12 4000000 8000000 1.5 2.5 10.0 5.0 3600 0.42 " +
		"5000000 20000000 100000 50000 - - -\n"
	s.stateMu.Lock()
	dieAfter := s.resourceDieAfter
	s.resourceExecs++
	s.stateMu.Unlock()
	for sent := 0; ; sent++ {
		if dieAfter > 0 && sent >= dieAfter {
			return // channel closes → the client sees the poller die
		}
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
