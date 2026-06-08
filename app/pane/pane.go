// Package pane owns the per-pane connection lifecycle: SSH client, channel,
// goroutine tree (read/write), and the Connecting→Connected→Suspect→Disconnected
// state machine. One Pane per terminal connection; the same session opened
// in multiple tabs creates separate Pane instances.
package pane

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"

	"hopperxterm/credentials"
	"hopperxterm/events"
	"hopperxterm/profile"
	"hopperxterm/transport"
)

// Pane is one live terminal connection — SSH, local shell, or WSL —
// feeding a Terminal in the UI. The transport behind `pty` decides
// what's running; SSH-specific fields (`ssh`, lazy SFTP, resource
// monitor) are only populated for SSH-backed panes.
type Pane struct {
	ID        string
	SessionID string

	// initialDir, when non-empty, is a working directory the shell cd's
	// into once ready (workspace restore — see Manager.OpenInDir). Set
	// before connect and read once by runStartupCmds; not mutated after.
	initialDir string

	appCtx context.Context // for emitting Wails events
	ctx    context.Context // pane lifetime
	cancel context.CancelFunc

	pty transport.PtyChannel // I/O for all transports
	ssh *transport.Shell     // non-nil iff this pane is an SSH session

	mu    sync.RWMutex
	state State

	// Interactive auth state. While authActive is true, SendInput is
	// captured here (and optionally echoed) until Enter or Ctrl+C, then
	// delivered via authResp to the SSH auth callback waiting in prompt.
	authMu     sync.Mutex
	authActive bool
	authEcho   bool
	authBuf    []byte
	authResp   chan authResult

	// Host-key-changed prompt state. While a changed key awaits the user's
	// decision (mid-handshake, on the dial goroutine), hkResp carries the
	// accept/reject answer delivered by ResolveHostKeyChange.
	hkMu     sync.Mutex
	hkActive bool
	hkResp   chan bool

	// File client backs the SFTP / FTP / S3 panel. For SSH-backed
	// panes this is lazily opened on the first SFTP call so panes that
	// never need it don't pay the channel cost. For FTP / S3 panes
	// it's set eagerly at connect time.
	fileMu sync.Mutex
	file   transport.FileClient

	// Resource monitor exec channel, lazy. One per pane. SSH-only.
	// resRefs tracks frontend consumers — Start increments, Stop
	// decrements. The poller goroutine runs as long as resRefs > 0
	// so a panel close doesn't kill samples for a still-mounted
	// status bar.
	resMu     sync.Mutex
	resCancel context.CancelFunc
	resOn     bool
	resRefs   int

	// Per-process monitors, keyed by spec ("pid:<n>" | "cmd:<name>"). Each
	// entry owns one SSH exec channel streaming that target's CPU/memory at
	// 1 Hz. Refcounted like the host poller so two panels watching the same
	// target share a stream and the last Stop tears it down. SSH-only.
	procMu  sync.Mutex
	procMon map[string]*procMonitor

	// osFamily caches the remote OS family ("linux"/"darwin"/"windows")
	// from the connect-time probe so StartResourceMonitor doesn't pay a
	// second `uname -s` round trip before launching the poller. Empty
	// until the probe goroutine completes; the poller falls back to
	// classifying inline if it starts first.
	osFamilyMu sync.Mutex
	osFamily   string

	// Number of times prompt() has been invoked during this pane's
	// auth phase. Used to detect retries (count > 1) so the second and
	// subsequent prompts can show a "permission denied" message instead
	// of looking identical to the first ask.
	promptCount int

	// connectAnim is the "Connecting to host…" dot-rotation animation
	// running on its own goroutine during the dial/auth phase. prompt()
	// and the connect success/failure paths stop it before emitting
	// further output so the animation doesn't overwrite their text.
	connectAnimMu sync.Mutex
	connectAnim   *connectAnim

	// Last password the user typed during interactive auth (echo=false
	// responses). Held in memory until either SaveCurrentPassword
	// persists it to the keychain or DiscardCurrentPassword clears it.
	// Cleared on pane close.
	pwdMu      sync.Mutex
	typedPwd   string
	hasTypedPw bool
	// Session metadata cached at connect time so SaveCurrentPassword
	// has somewhere to look up host / user for the keychain label.
	pwdHost string
	pwdUser string
	// When true, p.prompt emits pane:askpassword for a modal-mode
	// frontend dialog instead of writing the question to pane:output.
	// SFTP / FTP set this because they don't have a terminal.
	promptViaModal bool
	// Tracks whether the modal-mode dialog's "save password" checkbox
	// was checked. If chosen here, the post-connect AskSavePassword
	// dialog is suppressed.
	savePwdChosen bool
	savePwdChoice bool

	// Last cwd reported by an OSC 7 sequence on the PTY stream. Held
	// so the SFTP panel's "Follow terminal folder" toggle can resync
	// to the current shell pwd immediately on toggle-on, instead of
	// waiting for the next prompt redraw.
	cwdMu   sync.RWMutex
	lastCwd string

	// Output filter used by InstallOsc7Hook to swallow the echo of
	// the OSC 7 inject command so it never reaches the user's
	// terminal. swallowPending accumulates incoming PTY bytes; when
	// swallowMarker is found, everything up to and including it is
	// dropped and forwarding resumes. Deadline guards against the
	// marker never arriving (e.g., the shell errored out).
	swallowMu       sync.Mutex
	swallowActive   bool
	swallowPending  []byte
	swallowMarker   []byte
	swallowDeadline time.Time
}

type authResult struct {
	text string
	err  error
}

// newPane creates the Pane struct in Connecting state without doing any
// I/O. Manager.Open registers the result in its map BEFORE calling
// connect, so that interactive-auth callbacks can route SendInput
// through the manager while the handshake is in progress.
func newPane(appCtx context.Context, paneID string, sess profile.Session) *Pane {
	paneCtx, cancel := context.WithCancel(appCtx)
	p := &Pane{
		ID:        paneID,
		SessionID: sess.ID,
		appCtx:    appCtx,
		ctx:       paneCtx,
		cancel:    cancel,
		state:     StateConnecting,
	}
	events.EmitPaneState(appCtx, paneID, events.PaneState(StateConnecting), "")
	return p
}

// connect performs the transport-specific dial + PTY allocation and
// starts the read (and, for SSH, keepalive) goroutines. Blocks on the
// dial — must be called only after the pane is in the Manager's map
// so the auth callback can route SendInput through SSH interactive
// prompts.
func (p *Pane) connect(sess profile.Session) error {
	switch sess.Type {
	case profile.SessionSSH, profile.SessionAWSEC2:
		return p.connectSSHLike(sess)
	case profile.SessionShell:
		return p.connectLocalShell(sess)
	case profile.SessionWSL:
		return p.connectWSL(sess)
	case profile.SessionFTP:
		return p.connectFTP(sess)
	case profile.SessionSFTP:
		// Stand-alone SFTP (no terminal). Dial fresh, no shell channel.
		return p.connectSFTPOnly(sess)
	case profile.SessionAWS:
		return p.connectS3(sess)
	default:
		p.cancel()
		return fmt.Errorf("pane: session type %q is not supported", sess.Type)
	}
}

func (p *Pane) connectSSHLike(sess profile.Session) error {
	events.EmitConnectionLog(p.appCtx, p.ID, events.LogDim, nowMillis(), "Dialing "+sess.Host+"…")
	// Animated "Connecting…" with rotating dots so the pane visibly
	// shows activity during the TCP dial / SSH handshake. The defer
	// guarantees the animation stops on every return path; prompt()
	// also stops it eagerly when interactive auth begins so the dots
	// don't overwrite the Password: prompt.
	p.startConnectAnimation(sess.User + "@" + sess.Host)
	defer p.stopConnectAnimation()

	// Look up a saved password for this session — passed silently into
	// the dial so the user isn't prompted when one's on file.
	savedPwd, _ := credentials.GetPassword(sess.ID)

	var client *ssh.Client
	var err error
	if sess.Type == profile.SessionAWSEC2 {
		client, err = transport.DialEC2(transport.EC2DialConfig{
			InstanceID:     sess.InstanceID,
			Region:         sess.Region,
			User:           sess.User,
			PemFile:        sess.PemFile,
			Port:           sess.Port,
			Prompter:       p.prompt,
			Profile:        sess.Profile,
			SavedPassword:  savedPwd,
			HostKeyChanged: p.promptHostKeyChange,
		})
	} else {
		client, err = transport.DialSSH(transport.SSHDialConfig{
			Host:           sess.Host,
			User:           sess.User,
			Port:           sess.Port,
			Prompter:       p.prompt,
			SavedPassword:  savedPwd,
			PemFile:        sess.PemFile,
			HostKeyChanged: p.promptHostKeyChange,
		})
	}
	if err != nil {
		events.EmitConnectionLog(p.appCtx, p.ID, events.LogErr, nowMillis(), "Dial failed: "+err.Error())
		p.emitTerminalError("Dial failed: " + err.Error())
		p.transition(StateDisconnected, err.Error())
		p.cancel()
		return err
	}
	events.EmitConnectionLog(p.appCtx, p.ID, events.LogOK, nowMillis(), "SSH handshake complete")

	shell, err := transport.StartShell(client)
	if err != nil {
		client.Close()
		events.EmitConnectionLog(p.appCtx, p.ID, events.LogErr, nowMillis(), "PTY allocation failed: "+err.Error())
		p.emitTerminalError("PTY allocation failed: " + err.Error())
		p.transition(StateDisconnected, err.Error())
		p.cancel()
		return err
	}

	p.ssh = shell
	p.pty = shell
	// Emit a clear BEFORE the readLoop starts forwarding PTY output, so
	// any "Password:" / "Permission denied" lines from the auth phase
	// are wiped before the remote shell's MOTD/prompt appears.
	p.clearTerminalIfAuthed()
	p.transition(StateConnected, "")

	go p.readLoop()
	go p.keepaliveLoop()
	go p.probeHostInfo(client)
	p.maybeAskSavePassword(sess)
	p.runConnectInit(sess)
	return nil
}

// probeHostInfo runs a one-shot probe over the SSH client to report
// the remote's OS identity (distro, kernel, arch) to the frontend.
// Runs on its own goroutine so a slow / hanging probe doesn't delay
// terminal readiness.
func (p *Pane) probeHostInfo(client *ssh.Client) {
	info := transport.ProbeHostInfoSSH(client)
	// Cache the OS family for the resource poller even when the rest of
	// the probe came back empty (e.g. banners ate the markers).
	if info.Family != "" {
		p.cacheOSFamily(info.Family)
	}
	if info == (transport.HostOSInfo{}) {
		return
	}
	events.EmitHostInfo(p.appCtx, p.ID, events.HostInfo{
		Name:     info.Name,
		Version:  info.Version,
		Kernel:   info.Kernel,
		Arch:     info.Arch,
		Hostname: info.Hostname,
		Family:   info.Family,
	})
}

func (p *Pane) connectLocalShell(sess profile.Session) error {
	events.EmitConnectionLog(p.appCtx, p.ID, events.LogDim, nowMillis(), "Starting local shell…")
	local, err := transport.StartLocalShell()
	if err != nil {
		events.EmitConnectionLog(p.appCtx, p.ID, events.LogErr, nowMillis(), err.Error())
		p.emitTerminalError(err.Error())
		p.transition(StateDisconnected, err.Error())
		p.cancel()
		return err
	}
	events.EmitConnectionLog(p.appCtx, p.ID, events.LogOK, nowMillis(), "Local shell: "+local.Name())
	p.pty = local
	p.transition(StateConnected, "")
	go p.readLoop()
	p.runConnectInit(sess)
	return nil
}

func (p *Pane) connectFTP(sess profile.Session) error {
	events.EmitConnectionLog(p.appCtx, p.ID, events.LogDim, nowMillis(),
		"Dialing FTP "+sess.Host+"…")
	// FTP panes have no terminal — route the password prompt to the
	// frontend's modal dialog instead of the (non-existent) terminal.
	p.promptViaModal = true
	p.pwdHost = sess.Host
	p.pwdUser = sess.User
	pwd, _ := credentials.GetPassword(sess.ID)
	if pwd == "" {
		var err error
		pwd, err = p.prompt("Password for "+sess.User+"@"+sess.Host, false)
		if err != nil {
			p.transition(StateDisconnected, err.Error())
			p.cancel()
			return err
		}
	}
	c, err := transport.DialFTP(transport.FTPDialConfig{
		Host:     sess.Host,
		User:     sess.User,
		Password: pwd,
		Port:     sess.Port,
	})
	if err != nil {
		events.EmitConnectionLog(p.appCtx, p.ID, events.LogErr, nowMillis(), err.Error())
		p.transition(StateDisconnected, err.Error())
		p.cancel()
		return err
	}
	events.EmitConnectionLog(p.appCtx, p.ID, events.LogOK, nowMillis(), "FTP login complete")
	p.fileMu.Lock()
	p.file = c
	p.fileMu.Unlock()
	p.transition(StateConnected, "")
	// FTP collects the typed password directly (we used the string in
	// the FTPDialConfig). Make sure it's available to persistChosenPassword.
	p.pwdMu.Lock()
	if !p.hasTypedPw && pwd != "" {
		p.typedPwd = pwd
		p.hasTypedPw = true
	}
	p.pwdMu.Unlock()
	p.persistChosenPassword()
	return nil
}

func (p *Pane) connectSFTPOnly(sess profile.Session) error {
	events.EmitConnectionLog(p.appCtx, p.ID, events.LogDim, nowMillis(),
		"Dialing SFTP "+sess.Host+"…")
	// SFTP panes have no terminal — the password prompt is routed to
	// the frontend modal via pane:askpassword instead of pane:output.
	p.promptViaModal = true
	p.pwdHost = sess.Host
	p.pwdUser = sess.User
	savedPwd, _ := credentials.GetPassword(sess.ID)
	c, err := transport.DialAndOpenSFTP(transport.SSHDialConfig{
		Host:           sess.Host,
		User:           sess.User,
		Port:           sess.Port,
		Prompter:       p.prompt,
		SavedPassword:  savedPwd,
		PemFile:        sess.PemFile,
		HostKeyChanged: p.promptHostKeyChange,
	})
	if err != nil {
		events.EmitConnectionLog(p.appCtx, p.ID, events.LogErr, nowMillis(), err.Error())
		p.transition(StateDisconnected, err.Error())
		p.cancel()
		return err
	}
	events.EmitConnectionLog(p.appCtx, p.ID, events.LogOK, nowMillis(), "SFTP open")
	p.fileMu.Lock()
	p.file = c
	p.fileMu.Unlock()
	p.transition(StateConnected, "")
	p.persistChosenPassword()
	return nil
}

func (p *Pane) connectS3(sess profile.Session) error {
	events.EmitConnectionLog(p.appCtx, p.ID, events.LogDim, nowMillis(),
		"Connecting to S3 bucket "+sess.Bucket+"…")
	c, err := transport.DialS3(transport.S3DialConfig{
		Bucket:  sess.Bucket,
		Region:  sess.Region,
		Profile: sess.Profile,
	})
	if err != nil {
		events.EmitConnectionLog(p.appCtx, p.ID, events.LogErr, nowMillis(), err.Error())
		p.transition(StateDisconnected, err.Error())
		p.cancel()
		return err
	}
	events.EmitConnectionLog(p.appCtx, p.ID, events.LogOK, nowMillis(), "S3 connected ("+c.Region+")")
	p.fileMu.Lock()
	p.file = c
	p.fileMu.Unlock()
	p.transition(StateConnected, "")
	return nil
}

func (p *Pane) connectWSL(sess profile.Session) error {
	events.EmitConnectionLog(p.appCtx, p.ID, events.LogDim, nowMillis(), "Starting WSL ("+sess.Distro+")…")
	local, err := transport.StartWSL(sess.Distro)
	if err != nil {
		events.EmitConnectionLog(p.appCtx, p.ID, events.LogErr, nowMillis(), err.Error())
		p.emitTerminalError(err.Error())
		p.transition(StateDisconnected, err.Error())
		p.cancel()
		return err
	}
	events.EmitConnectionLog(p.appCtx, p.ID, events.LogOK, nowMillis(), "WSL started: "+local.Name())
	p.pty = local
	p.transition(StateConnected, "")
	go p.readLoop()
	p.runConnectInit(sess)
	return nil
}

func (p *Pane) State() State {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.state
}

// emitTerminalError writes a connection error directly into the pane's
// terminal output stream as bold red ANSI text, with a hint that the
// user can press 'r' to reconnect. Only terminal-capable panes (SSH,
// EC2, WSL, local shell) should call this — file-only panes have no
// xterm canvas to render onto.
func (p *Pane) emitTerminalError(msg string) {
	if p == nil {
		return
	}
	body := "\r\n\x1b[1;31m✗ " + msg + "\x1b[0m\r\n\x1b[2mPress r to reconnect.\x1b[0m\r\n"
	events.EmitPaneOutput(p.appCtx, p.ID, []byte(body))
}

// emitTerminalClosed writes a graceful disconnect message into the
// pane's terminal output (e.g., the remote shell exited via `exit` or
// the connection dropped cleanly).
func (p *Pane) emitTerminalClosed() {
	if p == nil {
		return
	}
	body := "\r\n\x1b[2mConnection closed. Press r to reconnect.\x1b[0m\r\n"
	events.EmitPaneOutput(p.appCtx, p.ID, []byte(body))
}

// connectAnim drives a rotating-dots animation on its own goroutine
// during the dial/auth phase ("Connecting to user@host." → ".." → ".."
// → ".") so the user sees visible activity instead of a blank pane.
// Stop is idempotent and blocks until the goroutine exits so callers
// can safely write to pane:output afterwards without a race.
type connectAnim struct {
	cancel context.CancelFunc
	done   chan struct{}
	once   sync.Once
}

func (a *connectAnim) Stop() {
	if a == nil {
		return
	}
	a.once.Do(func() {
		a.cancel()
		<-a.done
	})
}

// startConnectAnimation begins rendering "Connecting to {target}…"
// with rotating dots. Returns immediately; the animation runs until
// the returned *connectAnim's Stop() is called. The goroutine wipes
// its own line on exit so the cursor is at column 0 of an empty line
// when subsequent output is emitted.
func (p *Pane) startConnectAnimation(target string) *connectAnim {
	ctx, cancel := context.WithCancel(p.ctx)
	done := make(chan struct{})
	prefix := "\x1b[2mConnecting to " + target
	suffix := "\x1b[0m"
	events.EmitPaneOutput(p.appCtx, p.ID, []byte(prefix+suffix))
	go func() {
		defer close(done)
		ticker := time.NewTicker(400 * time.Millisecond)
		defer ticker.Stop()
		dots := 0
		for {
			select {
			case <-ctx.Done():
				// Wipe our line so the next caller starts clean.
				events.EmitPaneOutput(p.appCtx, p.ID, []byte("\r\x1b[K"))
				return
			case <-ticker.C:
				dots = (dots + 1) % 4 // cycle 1,2,3,0,1,2,3,0…
				line := "\r\x1b[K" + prefix + strings.Repeat(".", dots) + suffix
				events.EmitPaneOutput(p.appCtx, p.ID, []byte(line))
			}
		}
	}()
	a := &connectAnim{cancel: cancel, done: done}
	p.connectAnimMu.Lock()
	p.connectAnim = a
	p.connectAnimMu.Unlock()
	return a
}

// stopConnectAnimation halts any active animation and clears the
// Pane's reference to it. Safe to call multiple times.
func (p *Pane) stopConnectAnimation() {
	p.connectAnimMu.Lock()
	a := p.connectAnim
	p.connectAnim = nil
	p.connectAnimMu.Unlock()
	a.Stop()
}

// clearTerminalIfAuthed wipes the canvas with RIS (ESC c) once auth
// finished interactively, so the user sees a fresh window for the
// remote shell instead of stale "Password:" prompts and any
// "Permission denied" banners. No-op when no prompts happened (e.g.,
// SSH key auth, local shell, WSL).
func (p *Pane) clearTerminalIfAuthed() {
	if p == nil {
		return
	}
	p.authMu.Lock()
	hadPrompts := p.promptCount > 0
	p.authMu.Unlock()
	if !hadPrompts {
		return
	}
	events.EmitPaneOutput(p.appCtx, p.ID, []byte("\x1bc"))
}

func (p *Pane) transition(s State, reason string) {
	p.mu.Lock()
	if p.state == s {
		p.mu.Unlock()
		return
	}
	p.state = s
	p.mu.Unlock()
	events.EmitPaneState(p.appCtx, p.ID, events.PaneState(s), reason)
}

// prompt is wired into transport.DialSSH as the AuthPrompter. The SSH
// library calls it on the dialer goroutine whenever a password or
// keyboard-interactive question needs answering. For terminal panes
// the question is emitted as pane:output and the user types into the
// terminal (SendInput delivers the reply). For non-terminal panes
// (SFTP / FTP) the question is emitted as pane:askpassword and the
// frontend's modal dialog calls App.SubmitPanePassword to deliver.
func (p *Pane) prompt(question string, echo bool) (string, error) {
	// Stop the "Connecting…" dot animation before writing the auth
	// question, so the rotating-dots tick doesn't overwrite the prompt
	// line. Stop blocks until the animation goroutine exits.
	p.stopConnectAnimation()

	p.authMu.Lock()
	p.authBuf = nil
	p.authResp = make(chan authResult, 1)
	p.authActive = true
	p.authEcho = echo
	p.promptCount++
	isRetry := p.promptCount > 1
	ch := p.authResp
	p.authMu.Unlock()

	if p.promptViaModal {
		modalQuestion := question
		if isRetry {
			modalQuestion = "Permission denied. " + question
		}
		events.EmitAskPassword(p.appCtx, p.ID, p.SessionID, p.pwdHost, p.pwdUser, modalQuestion)
	} else {
		if isRetry {
			// Red banner above the next "Password:" so the user knows the
			// previous attempt was rejected by the server instead of seeing
			// an identical second prompt.
			events.EmitPaneOutput(p.appCtx, p.ID,
				[]byte("\r\n\x1b[1;31m✗ Permission denied (publickey,password). Please try again.\x1b[0m\r\n"))
		}
		events.EmitPaneOutput(p.appCtx, p.ID, []byte(question))
	}

	select {
	case res := <-ch:
		// Echo a newline because we consumed the user's Enter — terminal
		// panes only; modal panes don't have a transcript to advance.
		if !p.promptViaModal {
			events.EmitPaneOutput(p.appCtx, p.ID, []byte("\r\n"))
		}
		// Remember the last echo=false response as a candidate password.
		// Keyboard-interactive may ask multiple questions; the password
		// is virtually always echo=false, so the most recent hidden
		// answer is the right one to offer for saving.
		if !echo && res.err == nil && res.text != "" {
			p.pwdMu.Lock()
			p.typedPwd = res.text
			p.hasTypedPw = true
			p.pwdMu.Unlock()
		}
		return res.text, res.err
	case <-p.ctx.Done():
		p.authMu.Lock()
		p.authActive = false
		p.authBuf = nil
		p.authMu.Unlock()
		return "", p.ctx.Err()
	}
}

// promptHostKeyChange is wired into transport.SSHDialConfig.HostKeyChanged.
// The SSH library calls it on the dial goroutine when the server's key no
// longer matches known_hosts. It emits pane:hostkeychanged and blocks until
// the frontend dialog calls ResolveHostKeyChange. Returns true to accept the
// new key (recorded by the transport), false to refuse the connection.
func (p *Pane) promptHostKeyChange(host, oldFP, newFP string) bool {
	p.stopConnectAnimation()

	p.hkMu.Lock()
	p.hkResp = make(chan bool, 1)
	ch := p.hkResp
	p.hkActive = true
	p.hkMu.Unlock()

	events.EmitHostKeyChanged(p.appCtx, p.ID, p.SessionID, host, oldFP, newFP)

	select {
	case ok := <-ch:
		return ok
	case <-p.ctx.Done():
		return false
	}
}

// ResolveHostKeyChange delivers the user's decision from the frontend
// dialog to a waiting promptHostKeyChange. No-op if none is waiting.
func (p *Pane) ResolveHostKeyChange(accept bool) error {
	p.hkMu.Lock()
	if !p.hkActive {
		p.hkMu.Unlock()
		return errors.New("pane: no host-key prompt is active")
	}
	p.hkActive = false
	ch := p.hkResp
	p.hkMu.Unlock()
	select {
	case ch <- accept:
	default:
	}
	return nil
}

// runConnectInit performs post-connect shell setup on a single goroutine
// so every PTY-stdin write stays serialized (no byte interleaving). Only
// terminal sessions call it (ssh / shell / wsl / awsec2). In order, once
// the shell is ready:
//
//  1. SSH/EC2 to a Linux/macOS remote: install the invisible OSC 7
//     cwd-tracking hook (its echo is swallowed) so the shell emits its
//     working directory on every prompt. This makes "Follow terminal
//     folder" and workspace cwd capture/restore work without the user
//     enabling anything, and is the reason GetPaneCwd is reliable at save
//     time. Skipped for WSL / local shells (no Remote Files panel; don't
//     touch the user's own prompt) and Windows remotes (the hook is
//     bash/zsh) — see cwdHookApplies.
//  2. cd into a restored workspace cwd (initialDir), if any.
//  3. run the session's "run commands on connect" snippet.
//
// Waits 250ms first so the remote shell can print its rc-file output / motd
// and settle at a clean prompt before we inject — injecting mid-line would
// corrupt a half-typed command, which is why this can't be done lazily at
// save time.
func (p *Pane) runConnectInit(sess profile.Session) {
	go func() {
		select {
		case <-time.After(250 * time.Millisecond):
		case <-p.ctx.Done():
			return
		}
		if p.pty == nil || p.pty.Stdin() == nil {
			return
		}
		if p.cwdHookApplies(sess) {
			_ = p.installOsc7Hook("cwd tracking")
		}
		p.writeStartupCmds(sess.StartupCmds)
	}()
}

// cwdHookApplies reports whether the OSC 7 cwd-tracking hook should be
// installed for this pane. It's enabled ONLY for SSH/EC2 sessions to a
// Linux or macOS remote — the case the Remote Files panel's "Follow
// terminal folder" and workspace cwd capture/restore actually serve.
// Deliberately excluded:
//   - WSL and local shells: they have no Remote Files panel, and we avoid
//     touching the user's own machine's shell prompt.
//   - Windows remotes: the hook is bash/zsh.
// For SSH/EC2 it consults the connect-time OS-family probe, waiting briefly
// for it to land; an unresolved family (slow / failed probe) is treated as
// NOT applicable so a misclassified host never receives bash garbage.
func (p *Pane) cwdHookApplies(sess profile.Session) bool {
	if sess.Type != profile.SessionSSH && sess.Type != profile.SessionAWSEC2 {
		return false
	}
	for i := 0; i < 30; i++ { // ~1.5s for the probe to classify
		switch p.cachedOSFamily() {
		case "linux", "darwin":
			return true
		case "windows":
			return false
		}
		select {
		case <-time.After(50 * time.Millisecond):
		case <-p.ctx.Done():
			return false
		}
	}
	return false
}

// writeStartupCmds writes the session's "run commands on connect" snippet
// into the pty's stdin, followed by a `cd` into any restored workspace cwd.
// Synchronous; callers (runConnectInit) own the goroutine + readiness wait.
func (p *Pane) writeStartupCmds(cmds string) {
	// Workspace restore: cd into the saved cwd AFTER the session's own
	// startup snippet, so the restored directory is where the pane finally
	// lands even if a startup command cd'd elsewhere ("reopen where I left
	// off" wins over the session default).
	if p.initialDir != "" {
		cd := "cd " + transport.ShQuote(p.initialDir)
		if strings.TrimSpace(cmds) == "" {
			cmds = cd
		} else {
			cmds = strings.TrimRight(cmds, "\r\n") + "\n" + cd
		}
	}
	cmds = strings.TrimSpace(cmds)
	if cmds == "" {
		return
	}
	if p.pty == nil || p.pty.Stdin() == nil {
		return
	}
	// Terminate every line with a carriage return (\r) — that's the byte a
	// real Enter keypress sends (xterm.js emits \r, not \n). A bare \n is
	// displayed in the line buffer but not accepted as "submit" by
	// readline/zsh ZLE in raw mode, so a single-line snippet would print
	// without running. Normalize CRLF/LF → CR and ensure a trailing CR so
	// the final command fires.
	payload := strings.ReplaceAll(cmds, "\r\n", "\n")
	payload = strings.ReplaceAll(payload, "\n", "\r")
	if !strings.HasSuffix(payload, "\r") {
		payload += "\r"
	}
	_, _ = p.pty.Stdin().Write([]byte(payload))
}

// maybeAskSavePassword emits pane:asksavepassword if the user typed a
// password during this connection that's NOT already saved in the
// keychain. Skipped for modal-mode panes where the user already
// answered the save question via the password dialog's checkbox.
func (p *Pane) maybeAskSavePassword(sess profile.Session) {
	p.pwdMu.Lock()
	pwd := p.typedPwd
	has := p.hasTypedPw
	chosen := p.savePwdChosen
	p.pwdHost = sess.Host
	p.pwdUser = sess.User
	p.pwdMu.Unlock()
	if chosen {
		return
	}
	if !has || pwd == "" {
		return
	}
	if existing, err := credentials.GetPassword(sess.ID); err == nil && existing == pwd {
		return
	}
	events.EmitAskSavePassword(p.appCtx, p.ID, sess.ID, sess.Host, sess.User)
}

// SubmitPanePassword delivers a password the user just typed into the
// modal dialog back to a waiting p.prompt invocation. `save` records
// whether the user checked the "save password" box; if so, the
// keychain entry is written after the connection succeeds (handled
// in the connect path). No-op if no prompter is currently waiting.
func (p *Pane) SubmitPanePassword(password string, save bool) error {
	p.authMu.Lock()
	if !p.authActive {
		p.authMu.Unlock()
		return errors.New("pane: no password prompt is active")
	}
	resp := p.authResp
	p.authActive = false
	p.authBuf = nil
	p.authMu.Unlock()

	// Record the save preference up front so the post-connect logic
	// knows the user already answered.
	p.pwdMu.Lock()
	p.savePwdChosen = true
	p.savePwdChoice = save
	p.pwdMu.Unlock()

	select {
	case resp <- authResult{text: password}:
	default:
	}
	return nil
}

// CancelPanePassword aborts a waiting modal prompt. The prompter
// returns an error and the dial fails — the pane transitions to
// Disconnected and the user can try again or close the pane.
func (p *Pane) CancelPanePassword() error {
	p.authMu.Lock()
	if !p.authActive {
		p.authMu.Unlock()
		return nil
	}
	resp := p.authResp
	p.authActive = false
	p.authBuf = nil
	p.authMu.Unlock()
	select {
	case resp <- authResult{err: errors.New("pane: password entry cancelled")}:
	default:
	}
	return nil
}

// persistChosenPassword runs after a successful connect for modal-mode
// panes. If the user ticked "save", the in-memory password is
// persisted to the keychain. Either way the in-memory copy is cleared.
func (p *Pane) persistChosenPassword() {
	p.pwdMu.Lock()
	chosen := p.savePwdChosen
	save := p.savePwdChoice
	pwd := p.typedPwd
	sid := p.SessionID
	if chosen {
		p.typedPwd = ""
		p.hasTypedPw = false
	}
	p.pwdMu.Unlock()
	if !chosen {
		return
	}
	if save && pwd != "" {
		_ = credentials.SetPassword(sid, pwd)
	}
}

// SaveCurrentPassword persists the in-memory typed password to the OS
// keychain under this pane's sessionID. No-op if no password was
// captured during this pane's auth (e.g. key-based login).
func (p *Pane) SaveCurrentPassword() error {
	p.pwdMu.Lock()
	pwd := p.typedPwd
	has := p.hasTypedPw
	sid := p.SessionID
	p.pwdMu.Unlock()
	if !has || pwd == "" {
		return errors.New("pane: no password to save")
	}
	if err := credentials.SetPassword(sid, pwd); err != nil {
		return err
	}
	// Wipe the in-memory copy now that it's persisted.
	p.pwdMu.Lock()
	p.typedPwd = ""
	p.hasTypedPw = false
	p.pwdMu.Unlock()
	return nil
}

// DiscardCurrentPassword drops the in-memory typed password without
// persisting it. Idempotent.
func (p *Pane) DiscardCurrentPassword() {
	p.pwdMu.Lock()
	p.typedPwd = ""
	p.hasTypedPw = false
	p.pwdMu.Unlock()
}

// SendInput writes keystrokes from the frontend into the remote PTY,
// OR (during interactive auth) accumulates them as the auth response.
// Backspace edits the buffer, Ctrl+C cancels auth, Enter submits.
func (p *Pane) SendInput(data []byte) error {
	p.authMu.Lock()

	if !p.authActive {
		p.authMu.Unlock()
		if p.pty == nil || p.pty.Stdin() == nil {
			return errors.New("pane: not connected")
		}
		_, err := p.pty.Stdin().Write(data)
		return err
	}

	var done *authResult
	var echoes []byte

loop:
	for _, b := range data {
		switch b {
		case '\r', '\n':
			text := string(p.authBuf)
			p.authBuf = nil
			done = &authResult{text: text}
			break loop
		case 0x03: // Ctrl+C
			p.authBuf = nil
			done = &authResult{err: errors.New("auth cancelled")}
			break loop
		case 0x7f, 0x08: // backspace / DEL
			if len(p.authBuf) > 0 {
				p.authBuf = p.authBuf[:len(p.authBuf)-1]
				if p.authEcho {
					echoes = append(echoes, '\b', ' ', '\b')
				}
			}
		default:
			p.authBuf = append(p.authBuf, b)
			if p.authEcho {
				echoes = append(echoes, b)
			}
		}
	}

	ch := p.authResp
	if done != nil {
		p.authActive = false
	}
	p.authMu.Unlock()

	if len(echoes) > 0 {
		events.EmitPaneOutput(p.appCtx, p.ID, echoes)
	}

	if done != nil && ch != nil {
		select {
		case ch <- *done:
		default:
		}
	}
	return nil
}

// LastCwd returns the most recent cwd captured from an OSC 7 sequence
// on the pane's PTY stream, or "" if none has been seen yet.
func (p *Pane) LastCwd() string {
	p.cwdMu.RLock()
	defer p.cwdMu.RUnlock()
	return p.lastCwd
}

// cachedOSFamily returns the remote OS family captured by the connect-time
// probe ("linux"/"darwin"/"windows"), or "" if the probe hasn't finished.
func (p *Pane) cachedOSFamily() string {
	p.osFamilyMu.Lock()
	defer p.osFamilyMu.Unlock()
	return p.osFamily
}

// cacheOSFamily records the probed OS family so the resource poller can
// reuse it instead of re-running `uname -s`.
func (p *Pane) cacheOSFamily(fam string) {
	p.osFamilyMu.Lock()
	defer p.osFamilyMu.Unlock()
	p.osFamily = fam
}

// InstallOsc7Hook writes a shell snippet into the PTY that:
//
//  1. Defines _hop_osc7, a function that prints an OSC 7 escape for
//     the current $PWD.
//  2. Wires it into bash's PROMPT_COMMAND (prepended; idempotent on
//     repeat calls) or zsh's precmd_functions, so the shell emits an
//     OSC 7 on every prompt redraw thereafter.
//  3. Calls the function once immediately so the panel can sync
//     without waiting for the user to press Enter.
//  4. Prints a private OSC sequence ("\e]7339;hop:done\a") as an
//     end-of-inject marker. The readLoop uses it to know when to
//     stop swallowing PTY output, so the inject command's echo
//     never reaches the user's terminal.
//
// Used by the "Follow terminal folder" toggle. Non-bash/non-zsh
// shells (cmd.exe, PowerShell, fish, busybox sh on minimal images)
// will silently fail the conditional branches — the one-shot printf
// still works on most POSIX shells; if no marker arrives within 3 s
// the suppression filter releases its buffer anyway.
func (p *Pane) InstallOsc7Hook() error {
	return p.installOsc7Hook("Follow terminal folder")
}

// installOsc7Hook is the implementation; reason is recorded in the
// connection-log audit line so each caller's context is clear (the
// "Follow terminal folder" toggle vs. automatic connect-time cwd tracking).
func (p *Pane) installOsc7Hook(reason string) error {
	if p.pty == nil || p.pty.Stdin() == nil {
		return errors.New("pane: not connected")
	}
	// The hook is bash/zsh — never inject it into a Windows shell, where
	// cmd.exe / PowerShell would echo errors for the bash syntax and the
	// swallow marker would never arrive (releasing a buffer of garbage).
	// runConnectInit already gates on shellIsPOSIX; this guards the direct
	// caller too (the "Follow terminal folder" toggle). cwd tracking is
	// POSIX-only. An unprobed family ("") optimistically proceeds.
	if p.cachedOSFamily() == "windows" {
		return errors.New("pane: OSC 7 cwd tracking is not supported on Windows shells")
	}
	// Arm the readLoop's swallow filter BEFORE writing so the
	// inject's echo never makes it past EmitPaneOutput.
	p.swallowMu.Lock()
	p.swallowActive = true
	p.swallowPending = nil
	p.swallowMarker = []byte(osc7EndMarker)
	p.swallowDeadline = time.Now().Add(3 * time.Second)
	p.swallowMu.Unlock()
	_, err := p.pty.Stdin().Write([]byte(osc7Hook))
	if err == nil {
		// Audit trail: the inject is silently filtered out of the
		// user's terminal, so leave a one-line trace in the
		// connection log identifying what we did and why.
		events.EmitConnectionLog(p.appCtx, p.ID, events.LogDim, time.Now().UnixMilli(),
			"Installed OSC 7 hook in shell session ("+reason+")")
	}
	return err
}

// osc7Hook — sent verbatim to the PTY. Leading space + trailing
// newline are intentional. Single-quoted printf format keeps `\033`
// and `\\` literal until printf interprets them as ESC and `\`. The
// trailing printf emits the `\033]7339;hop:done\007` marker the
// readLoop watches for to stop swallowing output, then `\r\033[2K`
// (carriage-return + erase-line). That erase is the tail forwarded
// AFTER the marker: the shell drew a prompt before we injected, and
// the inject's echo+newline are swallowed, so without it the shell's
// post-command prompt would render on the same line as the stale one
// (a visible "prompt$ prompt$" doubling). Erasing the line lets the
// redrawn prompt land cleanly, so the inject leaves no visible trace.
const osc7Hook = ` _hop_osc7(){ printf '\033]7;file://%s%s\033\\' "${HOSTNAME:-${HOST:-$(hostname 2>/dev/null)}}" "$PWD"; }; if [ -n "$BASH_VERSION" ]; then case ";${PROMPT_COMMAND};" in *";_hop_osc7;"*|*";_hop_osc7"*) :;; *) PROMPT_COMMAND="_hop_osc7${PROMPT_COMMAND:+;$PROMPT_COMMAND}";; esac; elif [ -n "$ZSH_VERSION" ]; then case " ${precmd_functions[*]} " in *" _hop_osc7 "*) :;; *) precmd_functions+=(_hop_osc7);; esac; fi; _hop_osc7; printf '\033]7339;hop:done\007\r\033[2K'
`

// osc7EndMarker — private OSC sequence terminals don't recognise.
// Terminals ignore OSC codes they don't know, so it's invisible to
// the user; the readLoop's byte-level filter watches for it as the
// signal that the inject is done and forwarding can resume.
const osc7EndMarker = "\x1b]7339;hop:done\x07"

// applyOutputFilter is the readLoop's hook for swallowing the
// InstallOsc7Hook inject's echo. When the filter is active, bytes
// accumulate in swallowPending; once swallowMarker is found, the
// buffer up to and including the marker is dropped and any bytes
// after it are returned for normal forwarding. A 3 s deadline +
// 64 KiB cap release the buffer if the marker never arrives (e.g.,
// the shell isn't bash/zsh and the conditional branches no-op).
func (p *Pane) applyOutputFilter(data []byte) []byte {
	p.swallowMu.Lock()
	defer p.swallowMu.Unlock()
	if !p.swallowActive {
		return data
	}
	if time.Now().After(p.swallowDeadline) {
		out := append(p.swallowPending, data...)
		p.swallowPending = nil
		p.swallowActive = false
		return out
	}
	p.swallowPending = append(p.swallowPending, data...)
	if idx := bytes.Index(p.swallowPending, p.swallowMarker); idx >= 0 {
		tail := append([]byte(nil), p.swallowPending[idx+len(p.swallowMarker):]...)
		p.swallowPending = nil
		p.swallowActive = false
		return tail
	}
	if len(p.swallowPending) > 64*1024 {
		out := p.swallowPending
		p.swallowPending = nil
		p.swallowActive = false
		return out
	}
	return nil
}

// Resize forwards a PTY size change to the underlying transport.
func (p *Pane) Resize(cols, rows int) error {
	if p.pty == nil {
		return errors.New("pane: not connected")
	}
	return p.pty.Resize(cols, rows)
}

// Close terminates the connection and tears the goroutine tree down.
func (p *Pane) Close() {
	p.cancel()
	p.stopResourceMonitor()
	p.stopAllProcessMonitors()
	p.fileMu.Lock()
	if p.file != nil {
		_ = p.file.Close()
		p.file = nil
	}
	p.fileMu.Unlock()
	if p.pty != nil {
		_ = p.pty.Close()
	}
	p.transition(StateDisconnected, "closed by user")
}

// readLoop streams PTY output to the frontend. Returns when the
// underlying stream closes or the pane context is cancelled. The same
// stream is also scanned for OSC 7 cwd-change sequences so the SFTP
// panel's "Follow terminal folder" toggle can track the shell's pwd.
func (p *Pane) readLoop() {
	buf := make([]byte, 8192)
	out := p.pty.Stdout()
	var osc osc7Scanner
	emit := func(host, path string) {
		p.cwdMu.Lock()
		p.lastCwd = path
		p.cwdMu.Unlock()
		events.EmitPaneCwd(p.appCtx, p.ID, path, host)
	}
	for {
		n, err := out.Read(buf)
		if n > 0 {
			// Always feed the OSC 7 scanner so cwd tracking keeps
			// working even while the swallow filter is hiding the
			// inject's echo from the user's terminal.
			osc.Feed(buf[:n], emit)
			if forward := p.applyOutputFilter(buf[:n]); len(forward) > 0 {
				events.EmitPaneOutput(p.appCtx, p.ID, forward)
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) || errors.Is(p.ctx.Err(), context.Canceled) {
				p.emitTerminalClosed()
				p.transition(StateDisconnected, "")
			} else {
				p.emitTerminalError(err.Error())
				p.transition(StateDisconnected, err.Error())
			}
			return
		}
	}
}
