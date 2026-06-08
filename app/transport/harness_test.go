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
	"bufio"
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"encoding/pem"
	"fmt"
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
	// scp wire protocol: source mode (-f streams a file out) and sink mode
	// (-t receives a file). Backs the SCP transport's transfer paths against
	// real files on the harness host (which is this machine).
	if strings.HasPrefix(cmd, "scp -f -- ") {
		scpSource(ch, scpPathArg(cmd))
		return
	}
	if strings.HasPrefix(cmd, "scp -t -- ") {
		scpSink(ch, scpPathArg(cmd))
		return
	}
	// File-management commands the SCP transport issues (List `ls -la`,
	// Stat `ls -lad`, Mkdir, Remove) — backed by the real harness host FS,
	// just like scp -f/-t. Without these they'd fall through to the
	// resource-monitor stream below and hang the exec forever.
	if strings.HasPrefix(cmd, "ls -lad -- ") {
		scpLS(ch, scpPathArg(cmd), false)
		return
	}
	if strings.HasPrefix(cmd, "ls -la -- ") {
		scpLS(ch, scpPathArg(cmd), true)
		return
	}
	if strings.HasPrefix(cmd, "rm -- ") || strings.HasPrefix(cmd, "rmdir -- ") {
		scpExit(ch, os.Remove(scpPathArg(cmd)))
		return
	}
	if strings.HasPrefix(cmd, "mkdir -p -- ") {
		scpExit(ch, os.MkdirAll(scpPathArg(cmd), 0o755))
		return
	}
	if strings.HasPrefix(cmd, "mkdir -- ") {
		scpExit(ch, os.Mkdir(scpPathArg(cmd), 0o755))
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

// scpPathArg extracts the file argument from a `scp -f -- '<path>'` /
// `scp -t -- '<path>'` command, undoing transport.ShQuote.
func scpPathArg(cmd string) string {
	i := strings.Index(cmd, " -- ")
	if i < 0 {
		return ""
	}
	arg := cmd[i+len(" -- "):]
	if len(arg) >= 2 && arg[0] == '\'' && arg[len(arg)-1] == '\'' {
		arg = strings.ReplaceAll(arg[1:len(arg)-1], `'\''`, "'")
	}
	return arg
}

// scpExit closes the exec with status 0 on success, 1 (with the error on
// stdout) otherwise — matching how the SCP transport reads run() results.
func scpExit(ch ssh.Channel, err error) {
	if err != nil {
		_, _ = io.WriteString(ch, err.Error()+"\n")
		sendExit(ch, 1)
		return
	}
	sendExit(ch, 0)
}

// scpLS emulates `ls -la`/`ls -lad` against the real host FS. listContents
// distinguishes List (`ls -la <dir>` → the dir's entries) from Stat
// (`ls -lad <path>` → the path itself). A missing path exits non-zero with
// empty stdout, so SCP.Stat surfaces "cannot stat" and SCP.Remove falls
// through to its `rm` branch.
func scpLS(ch ssh.Channel, p string, listContents bool) {
	fi, err := os.Stat(p)
	if err != nil {
		sendExit(ch, 1)
		return
	}
	var b strings.Builder
	if listContents && fi.IsDir() {
		ents, _ := os.ReadDir(p)
		for _, de := range ents {
			if info, ierr := de.Info(); ierr == nil {
				b.WriteString(lsLongLine(de.Name(), info))
			}
		}
	} else {
		b.WriteString(lsLongLine(filepath.Base(p), fi))
	}
	_, _ = io.WriteString(ch, b.String())
	sendExit(ch, 0)
}

// lsLongLine renders one `ls -l`-format row that ftpc.ParseUnixListLine
// (the SCP transport's listing parser) accepts: a 10-char mode string,
// link count, owner, group, size, "Mon _2 15:04" timestamp, and name.
func lsLongLine(name string, fi os.FileInfo) string {
	perm := "-rw-r--r--"
	if fi.IsDir() {
		perm = "drwxr-xr-x"
	}
	return fmt.Sprintf("%s 1 owner group %d %s %s\n",
		perm, fi.Size(), fi.ModTime().Format("Jan 2 15:04"), name)
}

// scpSource emulates `scp -f <path>`: wait for the client's readiness byte,
// send the C-header, stream the file, send the end-of-file status, await the
// final ack. The caller (runExec) closes the channel.
func scpSource(ch ssh.Channel, p string) {
	br := bufio.NewReader(ch)
	if _, err := br.ReadByte(); err != nil { // client "ready" (0)
		return
	}
	info, err := os.Stat(p)
	if err != nil {
		_, _ = fmt.Fprintf(ch, "\x01scp: %s: No such file or directory\n", p)
		return
	}
	data, err := os.ReadFile(p)
	if err != nil {
		_, _ = fmt.Fprintf(ch, "\x01scp: %s: %v\n", p, err)
		return
	}
	_, _ = fmt.Fprintf(ch, "C0644 %d %s\n", info.Size(), filepath.Base(p))
	if b, err := br.ReadByte(); err != nil || b != 0 { // client acks the C-header
		return
	}
	_, _ = ch.Write(data)
	_, _ = ch.Write([]byte{0}) // end-of-file status byte
	_, _ = br.ReadByte()       // client's final ack
	sendExit(ch, 0)
}

// scpSink emulates `scp -t <dest>`: send the readiness ack, read the
// C-header, read exactly <size> bytes plus the end-of-file marker, write the
// file, send the commit ack. If dest is an existing directory the file lands
// under it (named by the header); otherwise dest is the file path itself.
func scpSink(ch ssh.Channel, dest string) {
	br := bufio.NewReader(ch)
	if _, err := ch.Write([]byte{0}); err != nil { // ready
		return
	}
	line, err := br.ReadString('\n')
	if err != nil {
		return
	}
	_, size, name, perr := parseSCPControl(line)
	if perr != nil {
		_, _ = fmt.Fprintf(ch, "\x02%v\n", perr)
		return
	}
	target := dest
	if fi, serr := os.Stat(dest); serr == nil && fi.IsDir() {
		target = filepath.Join(dest, name)
	}
	if _, err := ch.Write([]byte{0}); err != nil { // ack the C-header
		return
	}
	buf := make([]byte, size)
	if _, err := io.ReadFull(br, buf); err != nil {
		return
	}
	if b, err := br.ReadByte(); err != nil || b != 0 { // end-of-file marker
		return
	}
	if err := os.WriteFile(target, buf, 0o644); err != nil {
		_, _ = fmt.Fprintf(ch, "\x02scp: %v\n", err)
		return
	}
	_, _ = ch.Write([]byte{0}) // commit ack
	sendExit(ch, 0)
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
