package transport

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
	"golang.org/x/crypto/ssh/knownhosts"
)

// AuthPrompter asks the user a single question (typically a password
// prompt) and returns the answer. echo=false means the response should
// be hidden (like a password); echo=true is for visible challenge
// responses. Returning an error aborts the auth attempt.
//
// The pane wires this to the terminal: question goes out as pane:output,
// the user's typed line comes back from SendInput.
type AuthPrompter func(question string, echo bool) (string, error)

// HostKeyPrompter is asked to confirm a *changed* host key mid-handshake.
// It receives the host and the old / new SHA256 fingerprints and returns
// true to accept the new key (which is then recorded in known_hosts,
// replacing the old one) or false to refuse the connection. nil prompter
// means "always refuse" — the fail-closed default.
type HostKeyPrompter func(host, oldFingerprint, newFingerprint string) bool

// SSHDialConfig is the minimum we need to reach a host. Public-key auth
// (agent + on-disk keys) is always tried first; if Prompter is non-nil,
// password and keyboard-interactive auth are added as fallbacks.
type SSHDialConfig struct {
	Host     string
	User     string
	Port     int           // 0 → 22
	Timeout  time.Duration // 0 → 10s
	Prompter AuthPrompter  // optional — enables password / keyboard-interactive
	// HostKeyChanged is consulted when the server's key differs from the
	// stored known_hosts entry. nil → fail closed (refuse). Non-nil → the
	// user is asked; accepting records the new key.
	HostKeyChanged HostKeyPrompter
	// SavedPassword is tried silently after public-key methods and
	// before the interactive prompter. Empty = none. Lets the pane
	// auto-login from a keychain entry without bothering the user.
	SavedPassword string
	// PemFile is an optional path to a private key (.pem / .key) that
	// gets injected at the front of the public-key auth chain, before
	// agent + ~/.ssh keys. Lets the user point at a one-off key for a
	// specific session without dropping it in ~/.ssh.
	PemFile string
}

// DialSSH connects to a host using the auth chain: ssh-agent first, then
// ~/.ssh/id_ed25519 and ~/.ssh/id_rsa. Host keys are verified against
// ~/.ssh/known_hosts with TOFU on unknown hosts and fail-closed on
// mismatch.
func DialSSH(cfg SSHDialConfig) (*ssh.Client, error) {
	if cfg.Host == "" {
		return nil, errors.New("transport: host required")
	}
	if cfg.User == "" {
		return nil, errors.New("transport: user required")
	}
	if cfg.Port == 0 {
		cfg.Port = 22
	}
	if cfg.Timeout == 0 {
		cfg.Timeout = 10 * time.Second
	}

	auths, err := collectAuthMethods(cfg.Prompter, cfg.SavedPassword, cfg.PemFile)
	if err != nil {
		return nil, fmt.Errorf("transport: auth: %w", err)
	}
	if len(auths) == 0 {
		return nil, errors.New("transport: no usable auth methods (no ssh-agent, no ~/.ssh/id_{rsa,ed25519}, no prompter)")
	}

	cb, err := tofuHostKeyCallback(cfg.HostKeyChanged)
	if err != nil {
		return nil, fmt.Errorf("transport: host key callback: %w", err)
	}

	clientCfg := &ssh.ClientConfig{
		User:            cfg.User,
		Auth:            auths,
		HostKeyCallback: cb,
		Timeout:         cfg.Timeout,
	}

	addr := net.JoinHostPort(cfg.Host, fmt.Sprintf("%d", cfg.Port))
	conn, err := net.DialTimeout("tcp", addr, cfg.Timeout)
	if err != nil {
		return nil, fmt.Errorf("transport: dial %s: %w", addr, err)
	}
	// TCP-layer keepalive prevents the kernel from holding a half-open
	// socket forever when the remote falls off the network.
	if tcp, ok := conn.(*net.TCPConn); ok {
		_ = tcp.SetKeepAlive(true)
		_ = tcp.SetKeepAlivePeriod(5 * time.Second)
	}

	c, chans, reqs, err := ssh.NewClientConn(conn, addr, clientCfg)
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("transport: ssh handshake to %s: %w", addr, err)
	}
	return ssh.NewClient(c, chans, reqs), nil
}

// PtyChannel abstracts the things a pane needs from its underlying
// PTY: bytestream in/out, size changes, lifetime. Both SSH Shell and
// the local-process LocalShell satisfy this so pane.Pane is agnostic
// to the transport.
type PtyChannel interface {
	Stdin() io.Writer
	Stdout() io.Reader
	Resize(cols, rows int) error
	Close() error
}

// Shell is a started interactive PTY session over SSH. Output streams
// from Out; keystrokes go into In. Close terminates the remote shell
// and tears the underlying SSH client connection down.
type Shell struct {
	Client  *ssh.Client
	Session *ssh.Session
	In      io.WriteCloser
	Out     io.Reader
}

// Stdin / Stdout / Resize make Shell satisfy PtyChannel.
func (s *Shell) Stdin() io.Writer  { return s.In }
func (s *Shell) Stdout() io.Reader { return s.Out }

// Resize sends an SSH window-change request to the remote PTY.
func (s *Shell) Resize(cols, rows int) error {
	if s.Session == nil {
		return errors.New("ssh shell: not connected")
	}
	return s.Session.WindowChange(rows, cols)
}

// Ping sends a keepalive@openssh.com global request and waits for the
// server's reply, capped at timeout. Returns true on a successful round
// trip; false on timeout, transport error, or context cancellation.
//
// SendRequest itself doesn't take a context, so the call runs on a
// detached goroutine. If the connection later drops, that goroutine
// returns when SendRequest errors out — bounded leak, not unbounded.
func (s *Shell) Ping(ctx context.Context, timeout time.Duration) bool {
	if s.Client == nil {
		return false
	}
	done := make(chan error, 1)
	go func() {
		_, _, err := s.Client.SendRequest("keepalive@openssh.com", true, nil)
		done <- err
	}()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case err := <-done:
		return err == nil
	case <-timer.C:
		return false
	case <-ctx.Done():
		return false
	}
}

// Close terminates the shell and the underlying SSH client. Safe to call
// multiple times — the SSH library's Close is idempotent.
func (s *Shell) Close() error {
	if s.In != nil {
		_ = s.In.Close()
	}
	if s.Session != nil {
		_ = s.Session.Close()
	}
	if s.Client != nil {
		return s.Client.Close()
	}
	return nil
}

// StartShell allocates a PTY (xterm-256color, 80x24 by default), pipes
// stderr into the same stream as stdout, and launches the user's login
// shell.
func StartShell(client *ssh.Client) (*Shell, error) {
	sess, err := client.NewSession()
	if err != nil {
		return nil, fmt.Errorf("transport: new session: %w", err)
	}

	modes := ssh.TerminalModes{
		ssh.ECHO:          1,
		ssh.TTY_OP_ISPEED: 14400,
		ssh.TTY_OP_OSPEED: 14400,
	}
	if err := sess.RequestPty("xterm-256color", 24, 80, modes); err != nil {
		sess.Close()
		return nil, fmt.Errorf("transport: request pty: %w", err)
	}

	pr, pw := io.Pipe()
	sess.Stdout = pw
	sess.Stderr = pw

	stdin, err := sess.StdinPipe()
	if err != nil {
		sess.Close()
		return nil, fmt.Errorf("transport: stdin pipe: %w", err)
	}

	if err := sess.Shell(); err != nil {
		sess.Close()
		return nil, fmt.Errorf("transport: start shell: %w", err)
	}

	// The x/crypto/ssh session copies channel data into pw but never
	// closes it when the remote shell exits (e.g. the user types `exit`)
	// or the connection drops. Without this, pr.Read() in the pane's
	// readLoop would block forever, so the pane would never transition to
	// Disconnected and the "Press r to reconnect." hint would never print.
	// Wait for the session to end on a goroutine, then close the write end
	// so the reader observes io.EOF. We close cleanly regardless of the
	// shell's exit status — for an interactive login shell the exit code
	// reflects the last command, not a transport error, so surfacing it as
	// a red error line would be misleading; a graceful "Connection closed"
	// message is the right signal here.
	go func() {
		_ = sess.Wait()
		_ = pw.Close()
	}()

	return &Shell{Client: client, Session: sess, In: stdin, Out: pr}, nil
}

// collectAuthMethods returns auth methods in the order the SSH library
// will try them: ssh-agent first, then on-disk keys, then (if prompter
// is non-nil) password and keyboard-interactive. The SSH library only
// invokes the password/keyboard-interactive callbacks if all earlier
// methods are rejected by the server.
func collectAuthMethods(prompter AuthPrompter, savedPassword, pemFile string) ([]ssh.AuthMethod, error) {
	var methods []ssh.AuthMethod

	// User-supplied per-session key takes priority — it's the most
	// explicit signal of intent.
	if pemFile != "" {
		if m, err := keyFileAuth(expandPath(pemFile)); err == nil && m != nil {
			methods = append(methods, m)
		}
	}

	if m, err := agentAuth(); err == nil && m != nil {
		methods = append(methods, m)
	}

	home, err := os.UserHomeDir()
	if err == nil {
		for _, name := range []string{"id_ed25519", "id_rsa"} {
			if m, err := keyFileAuth(filepath.Join(home, ".ssh", name)); err == nil && m != nil {
				methods = append(methods, m)
			}
		}
	}

	// Password / keyboard-interactive. The saved password (if any) is tried
	// silently on the FIRST hidden answer, then we fall through to the
	// interactive prompter on retry.
	//
	// Crucially the saved password is folded INTO the retryable callback
	// rather than added as a separate ssh.Password(saved) method: Go's SSH
	// client records the "password" method name as "tried" after one failure
	// and never re-selects another method of the same name. A separate
	// ssh.Password(saved) would therefore consume the only "password" slot,
	// so a stale saved password (e.g. the remote password was changed) would
	// fail the handshake without ever invoking the prompter — on any server
	// that doesn't also offer keyboard-interactive. Using a single retryable
	// password method (saved-first, then prompt) keeps the slot open for the
	// user to re-enter the new password.
	if prompter != nil || savedPassword != "" {
		// Allow the saved silent attempt plus a few interactive retries.
		maxPasswordTries := 3
		if savedPassword != "" {
			maxPasswordTries++
		}
		savedTried := false
		// answer offers the saved password once for a hidden question, then
		// defers to the interactive prompter (shared across the password and
		// keyboard-interactive methods so the saved value isn't tried twice).
		answer := func(question string, echo bool) (string, error) {
			if !echo && !savedTried && savedPassword != "" {
				savedTried = true
				return savedPassword, nil
			}
			if prompter == nil {
				return "", errors.New("transport: password rejected and no prompter available")
			}
			return prompter(question, echo)
		}
		methods = append(methods,
			ssh.RetryableAuthMethod(ssh.PasswordCallback(func() (string, error) {
				return answer("Password: ", false)
			}), maxPasswordTries),
			ssh.RetryableAuthMethod(ssh.KeyboardInteractive(func(_, _ string, questions []string, echos []bool) ([]string, error) {
				answers := make([]string, len(questions))
				for i, q := range questions {
					echo := i < len(echos) && echos[i]
					ans, err := answer(q, echo)
					if err != nil {
						return nil, err
					}
					answers[i] = ans
				}
				return answers, nil
			}), maxPasswordTries),
		)
	}

	return methods, nil
}

func agentAuth() (ssh.AuthMethod, error) {
	var conn net.Conn
	var err error

	if sock := os.Getenv("SSH_AUTH_SOCK"); sock != "" {
		conn, err = net.Dial("unix", sock)
	} else {
		// Per-OS (build-tagged): Windows dials the OpenSSH agent's named
		// pipe; unix-likes have no fallback beyond SSH_AUTH_SOCK.
		conn, err = dialAgentFallback()
	}
	if err != nil {
		return nil, err
	}
	ag := agent.NewClient(conn)
	return ssh.PublicKeysCallback(ag.Signers), nil
}

func keyFileAuth(path string) (ssh.AuthMethod, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	signer, err := ssh.ParsePrivateKey(b)
	if err != nil {
		// Passphrase-protected keys end up here. We don't prompt yet.
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	return ssh.PublicKeys(signer), nil
}

// tofuHostKeyCallback returns a HostKeyCallback that:
//   - Accepts and writes new host keys into ~/.ssh/known_hosts (TOFU).
//   - On a *changed* key, asks `prompter` (if any); accepting records the
//     new key in place of the old, rejecting (or a nil prompter) refuses.
//
// known_hosts and its parent directory are created on first run.
func tofuHostKeyCallback(prompter HostKeyPrompter) (ssh.HostKeyCallback, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	dir := filepath.Join(home, ".ssh")
	file := filepath.Join(dir, "known_hosts")

	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("mkdir %s: %w", dir, err)
	}
	if _, err := os.Stat(file); errors.Is(err, os.ErrNotExist) {
		// Touch the file so knownhosts.New has something to read.
		if err := os.WriteFile(file, nil, 0o600); err != nil {
			return nil, fmt.Errorf("create %s: %w", file, err)
		}
	}

	return func(hostname string, remote net.Addr, key ssh.PublicKey) error {
		// Re-parse on each call so file edits while the app runs are
		// picked up immediately.
		cb, err := newKnownHostsCallback(file)
		if err != nil {
			return fmt.Errorf("read %s: %w", file, err)
		}
		err = cb(hostname, remote, key)
		if err == nil {
			return nil
		}

		var ke *knownhosts.KeyError
		if errors.As(err, &ke) {
			if len(ke.Want) > 0 {
				// Host key changed. Fail closed unless the user explicitly
				// accepts the new key via the prompter.
				if prompter != nil {
					oldFPs := make([]string, 0, len(ke.Want))
					oldKeys := make([]ssh.PublicKey, 0, len(ke.Want))
					for _, w := range ke.Want {
						oldFPs = append(oldFPs, ssh.FingerprintSHA256(w.Key))
						oldKeys = append(oldKeys, w.Key)
					}
					if prompter(hostname, strings.Join(oldFPs, ", "), ssh.FingerprintSHA256(key)) {
						if werr := acceptChangedHostKey(file, hostname, key, oldKeys); werr != nil {
							return fmt.Errorf("record new host key for %s: %w", hostname, werr)
						}
						return nil
					}
				}
				return fmt.Errorf("host key for %s has changed — refusing connection. If this is expected, edit %s by hand", hostname, file)
			}
			// Unknown host — TOFU.
			line := knownhosts.Line([]string{knownhosts.Normalize(hostname)}, key)
			f, ferr := os.OpenFile(file, os.O_APPEND|os.O_WRONLY, 0o600)
			if ferr != nil {
				return fmt.Errorf("append %s: %w", file, ferr)
			}
			defer f.Close()
			if _, ferr := f.WriteString(line + "\n"); ferr != nil {
				return fmt.Errorf("write %s: %w", file, ferr)
			}
			return nil
		}
		return err
	}, nil
}

// newKnownHostsCallback builds a knownhosts callback from file, tolerating
// malformed entries. golang.org/x/crypto/ssh/knownhosts.New fails the whole
// file if any single line is corrupt (e.g. "illegal base64 data") — which
// would block every SSH connection because of one bad entry. We validate
// each line independently with ssh.ParseKnownHosts and feed only the good
// ones to knownhosts.New (via a temp file), leaving the user's real
// known_hosts untouched. Blank lines and comments are preserved.
func newKnownHostsCallback(file string) (ssh.HostKeyCallback, error) {
	raw, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}

	var good [][]byte
	skipped := 0
	for _, line := range bytes.Split(raw, []byte("\n")) {
		trimmed := bytes.TrimSpace(line)
		if len(trimmed) == 0 || trimmed[0] == '#' {
			good = append(good, line) // keep blanks / comments as-is
			continue
		}
		// ParseKnownHosts parses a single entry; a corrupt line errors here.
		probe := append(append([]byte{}, trimmed...), '\n')
		if _, _, _, _, _, perr := ssh.ParseKnownHosts(probe); perr != nil {
			skipped++
			continue
		}
		good = append(good, line)
	}

	// Clean file → use it directly (no temp churn, and TOFU appends land
	// in the same place knownhosts read from).
	if skipped == 0 {
		return knownhosts.New(file)
	}

	// Some lines were corrupt: build the callback from a sanitized copy so
	// the valid entries still protect against key changes. The original
	// file is left as-is (TOFU still appends to it).
	tmp, err := os.CreateTemp("", "hopperxterm-known_hosts-*")
	if err != nil {
		return nil, err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(bytes.Join(good, []byte("\n"))); err != nil {
		tmp.Close()
		return nil, err
	}
	if err := tmp.Close(); err != nil {
		return nil, err
	}
	return knownhosts.New(tmp.Name())
}

// acceptChangedHostKey records a user-approved new host key: it drops every
// known_hosts line whose key matches one of the now-stale keys, then appends
// the new key for hostname. Matching by key bytes (not line number) is robust
// to the sanitized-temp-file path and to hashed host entries. Atomic replace.
func acceptChangedHostKey(file, hostname string, newKey ssh.PublicKey, oldKeys []ssh.PublicKey) error {
	raw, err := os.ReadFile(file)
	if err != nil {
		return err
	}
	stale := make(map[string]bool, len(oldKeys))
	for _, k := range oldKeys {
		stale[string(k.Marshal())] = true
	}

	var kept [][]byte
	for _, line := range bytes.Split(raw, []byte("\n")) {
		trimmed := bytes.TrimSpace(line)
		if len(trimmed) == 0 || trimmed[0] == '#' {
			kept = append(kept, line)
			continue
		}
		_, _, pk, _, _, perr := ssh.ParseKnownHosts(append(append([]byte{}, trimmed...), '\n'))
		if perr == nil && pk != nil && stale[string(pk.Marshal())] {
			continue // a stale key for this host — drop it
		}
		kept = append(kept, line)
	}

	out := bytes.TrimRight(bytes.Join(kept, []byte("\n")), "\n")
	if len(out) > 0 {
		out = append(out, '\n')
	}
	out = append(out, []byte(knownhosts.Line([]string{knownhosts.Normalize(hostname)}, newKey)+"\n")...)

	tmp := file + ".tmp"
	if err := os.WriteFile(tmp, out, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, file)
}
