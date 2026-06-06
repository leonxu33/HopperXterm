package pane

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/zalando/go-keyring"

	"hopperxterm/profile"
	"hopperxterm/transport"
)

// Route keychain access to the in-memory mock for the whole package.
func init() { keyring.MockInit() }

// paneWithPTY builds a Connected pane wired to a fake PTY.
func paneWithPTY(out string) (*Pane, *fakePTY) {
	p := newPane(context.Background(), "p1", profile.Session{ID: "s1", Type: profile.SessionSSH})
	f := &fakePTY{out: strings.NewReader(out)}
	p.pty = f
	return p, f
}

func TestReadLoop_CapturesOsc7AndDisconnectsOnEOF(t *testing.T) {
	// Stdout carries an OSC 7 cwd sequence then ends (EOF).
	out := "\x1b]7;file://host/var/www\x07welcome\n"
	p, _ := paneWithPTY(out)
	p.transition(StateConnected, "")
	p.readLoop() // returns on EOF
	if got := p.LastCwd(); got != "/var/www" {
		t.Errorf("LastCwd = %q, want /var/www", got)
	}
	if p.State() != StateDisconnected {
		t.Errorf("state after EOF = %s, want Disconnected", p.State())
	}
}

func TestResize_ForwardsToPTY(t *testing.T) {
	p, f := paneWithPTY("")
	if err := p.Resize(90, 30); err != nil {
		t.Fatalf("Resize: %v", err)
	}
	if f.resizes != 1 {
		t.Errorf("resize not forwarded, count=%d", f.resizes)
	}
}

func TestSendInput_ForwardsWhenNotAuthing(t *testing.T) {
	p, f := paneWithPTY("")
	if err := p.SendInput([]byte("ls -la\n")); err != nil {
		t.Fatalf("SendInput: %v", err)
	}
	if f.written() != "ls -la\n" {
		t.Errorf("stdin = %q, want %q", f.written(), "ls -la\n")
	}
}

func TestWriteStartupCmds(t *testing.T) {
	// Lines are terminated with CR (\r) — the byte a real Enter sends.
	p, f := paneWithPTY("")
	p.writeStartupCmds("uptime")
	if got := f.written(); got != "uptime\r" {
		t.Errorf("startup cmds = %q, want %q", got, "uptime\r")
	}

	// Multi-line snippet: each line gets a CR; CRLF/LF normalized to CR.
	p3, f3 := paneWithPTY("")
	p3.writeStartupCmds("cd /tmp\r\nls\nuptime")
	if got := f3.written(); got != "cd /tmp\rls\ruptime\r" {
		t.Errorf("multi-line = %q, want %q", got, "cd /tmp\rls\ruptime\r")
	}

	// Empty / whitespace commands are a no-op.
	p2, f2 := paneWithPTY("")
	p2.writeStartupCmds("   ")
	if f2.written() != "" {
		t.Errorf("blank startup cmds should write nothing, got %q", f2.written())
	}
}

func TestWriteStartupCmds_InitialDir(t *testing.T) {
	// Workspace restore: initialDir appends a single-quoted `cd` AFTER the
	// session's own snippet (so the restored dir wins), each line CR-ended.
	p, f := paneWithPTY("")
	p.initialDir = "/var/www/my app"
	p.writeStartupCmds("ls")
	if got := f.written(); got != "ls\rcd '/var/www/my app'\r" {
		t.Errorf("with initialDir = %q", got)
	}

	// No startup snippet: just the cd.
	p2, f2 := paneWithPTY("")
	p2.initialDir = "/srv"
	p2.writeStartupCmds("")
	if got := f2.written(); got != "cd '/srv'\r" {
		t.Errorf("cd-only = %q", got)
	}

	// A single quote in the path is escaped so it can't break the argument.
	p3, f3 := paneWithPTY("")
	p3.initialDir = "/a'b"
	p3.writeStartupCmds("")
	if got, want := f3.written(), `cd '/a'\''b'`+"\r"; got != want {
		t.Errorf("quote-escape = %q, want %q", got, want)
	}
}

func TestCwdHookApplies(t *testing.T) {
	// SSH/EC2 to a Linux or macOS remote: enabled.
	pLin, _ := paneWithPTY("")
	pLin.cacheOSFamily("linux")
	if !pLin.cwdHookApplies(profile.Session{Type: profile.SessionSSH}) {
		t.Error("SSH to a Linux remote should get the hook")
	}
	pMac, _ := paneWithPTY("")
	pMac.cacheOSFamily("darwin")
	if !pMac.cwdHookApplies(profile.Session{Type: profile.SessionAWSEC2}) {
		t.Error("EC2 to a macOS remote should get the hook")
	}
	// SSH to a Windows remote: excluded (hook is bash/zsh).
	pWin, _ := paneWithPTY("")
	pWin.cacheOSFamily("windows")
	if pWin.cwdHookApplies(profile.Session{Type: profile.SessionSSH}) {
		t.Error("SSH to a Windows remote should not get the hook")
	}
	// WSL and local shells are excluded regardless (no Remote Files panel;
	// don't touch the user's own prompt). cacheOSFamily is irrelevant here.
	pWSL, _ := paneWithPTY("")
	pWSL.cacheOSFamily("linux")
	if pWSL.cwdHookApplies(profile.Session{Type: profile.SessionWSL}) {
		t.Error("WSL should not get the hook")
	}
	pLocal, _ := paneWithPTY("")
	if pLocal.cwdHookApplies(profile.Session{Type: profile.SessionShell}) {
		t.Error("local shell should not get the hook")
	}
	// An unresolved family on SSH is treated as not-applicable (no bash
	// garbage on a misclassified host). Cancel the ctx so the probe-wait
	// exits immediately instead of polling for ~1.5s.
	pUnknown, _ := paneWithPTY("")
	pUnknown.cancel()
	if pUnknown.cwdHookApplies(profile.Session{Type: profile.SessionAWSEC2}) {
		t.Error("unresolved family should not get the hook")
	}
}

func TestInstallOsc7Hook(t *testing.T) {
	p, f := paneWithPTY("")
	if err := p.InstallOsc7Hook(); err != nil {
		t.Fatalf("InstallOsc7Hook: %v", err)
	}
	if !strings.Contains(f.written(), "_hop_osc7") {
		t.Errorf("hook not written to stdin: %q", f.written())
	}
	p.swallowMu.Lock()
	active := p.swallowActive
	p.swallowMu.Unlock()
	if !active {
		t.Error("swallow filter not armed after InstallOsc7Hook")
	}

	// Not connected → error.
	p2 := newPane(context.Background(), "x", profile.Session{})
	if err := p2.InstallOsc7Hook(); err == nil {
		t.Error("InstallOsc7Hook without a pty should error")
	}

	// Windows remote → refused (the hook is bash/zsh; injecting it into
	// cmd/PowerShell would print garbage), and nothing is written.
	pWin, fWin := paneWithPTY("")
	pWin.cacheOSFamily("windows")
	if err := pWin.InstallOsc7Hook(); err == nil {
		t.Error("InstallOsc7Hook should refuse a Windows shell")
	}
	if fWin.written() != "" {
		t.Errorf("nothing should be written to a Windows shell, got %q", fWin.written())
	}
}

func TestApplyOutputFilter(t *testing.T) {
	// Inactive filter returns data unchanged.
	p := newPane(context.Background(), "p", profile.Session{})
	if got := p.applyOutputFilter([]byte("abc")); string(got) != "abc" {
		t.Errorf("inactive filter changed data: %q", got)
	}

	// Active, marker arrives → everything up to+including marker dropped,
	// tail forwarded.
	p.swallowMu.Lock()
	p.swallowActive = true
	p.swallowMarker = []byte(osc7EndMarker)
	p.swallowDeadline = time.Now().Add(time.Second)
	p.swallowMu.Unlock()
	chunk := []byte("echo-noise" + osc7EndMarker + "real")
	if got := p.applyOutputFilter(chunk); string(got) != "real" {
		t.Errorf("post-marker tail = %q, want real", got)
	}

	// Active, no marker yet → buffered, returns nil.
	p.swallowMu.Lock()
	p.swallowActive = true
	p.swallowPending = nil
	p.swallowMarker = []byte(osc7EndMarker)
	p.swallowDeadline = time.Now().Add(time.Second)
	p.swallowMu.Unlock()
	if got := p.applyOutputFilter([]byte("partial")); got != nil {
		t.Errorf("expected nil while buffering, got %q", got)
	}

	// Deadline passed → flush whatever's buffered + new data.
	p.swallowMu.Lock()
	p.swallowActive = true
	p.swallowPending = []byte("buffered")
	p.swallowDeadline = time.Now().Add(-time.Second)
	p.swallowMu.Unlock()
	if got := p.applyOutputFilter([]byte("more")); string(got) != "bufferedmore" {
		t.Errorf("deadline flush = %q, want bufferedmore", got)
	}
}

func TestApplyOutputFilter_BufferCapFlush(t *testing.T) {
	p := newPane(context.Background(), "p", profile.Session{})
	p.swallowMu.Lock()
	p.swallowActive = true
	p.swallowMarker = []byte("NEVER-APPEARS")
	p.swallowDeadline = time.Now().Add(time.Hour)
	p.swallowMu.Unlock()
	big := make([]byte, 70*1024) // exceeds the 64 KiB cap
	got := p.applyOutputFilter(big)
	if len(got) != len(big) {
		t.Errorf("over-cap buffer should flush; got %d bytes, want %d", len(got), len(big))
	}
}

func TestConnectAnimationLifecycle(t *testing.T) {
	p := newPane(context.Background(), "p", profile.Session{})
	p.startConnectAnimation("u@h")
	// Stop (idempotent) must not hang or panic.
	p.stopConnectAnimation()
	p.stopConnectAnimation()
}

func TestEmitHelpers_NilSafe(t *testing.T) {
	var p *Pane
	p.emitTerminalError("x")  // nil receiver guard
	p.emitTerminalClosed()    // nil receiver guard
	good := newPane(context.Background(), "p", profile.Session{})
	good.emitTerminalError("boom")
	good.emitTerminalClosed()
}

func TestClearTerminalIfAuthed(t *testing.T) {
	var p *Pane
	p.clearTerminalIfAuthed() // nil guard

	p2 := newPane(context.Background(), "p", profile.Session{})
	p2.clearTerminalIfAuthed() // promptCount == 0 → no-op branch
	p2.authMu.Lock()
	p2.promptCount = 2
	p2.authMu.Unlock()
	p2.clearTerminalIfAuthed() // emits RIS branch
}

// ---- password handling ------------------------------------------------------

func TestSaveAndDiscardCurrentPassword(t *testing.T) {
	p := newPane(context.Background(), "p", profile.Session{ID: "save-sess"})
	// Nothing typed yet → error.
	if err := p.SaveCurrentPassword(); err == nil {
		t.Error("SaveCurrentPassword with no typed pw should error")
	}
	p.pwdMu.Lock()
	p.typedPwd = "topsecret"
	p.hasTypedPw = true
	p.pwdMu.Unlock()
	if err := p.SaveCurrentPassword(); err != nil {
		t.Fatalf("SaveCurrentPassword: %v", err)
	}
	if got, _ := keyring.Get("hopperxterm", "save-sess"); got != "topsecret" {
		t.Errorf("keychain entry = %q, want topsecret", got)
	}
	// In-memory copy is wiped after save.
	p.pwdMu.Lock()
	if p.hasTypedPw {
		t.Error("typed password not cleared after save")
	}
	p.pwdMu.Unlock()

	// Discard path.
	p.pwdMu.Lock()
	p.typedPwd = "x"
	p.hasTypedPw = true
	p.pwdMu.Unlock()
	p.DiscardCurrentPassword()
	p.pwdMu.Lock()
	if p.hasTypedPw {
		t.Error("DiscardCurrentPassword left the password set")
	}
	p.pwdMu.Unlock()
}

func TestSubmitPanePassword(t *testing.T) {
	p := newPane(context.Background(), "p", profile.Session{})
	// No active prompt → error.
	if err := p.SubmitPanePassword("pw", true); err == nil {
		t.Error("SubmitPanePassword with no active prompt should error")
	}
	// Active prompt → delivered.
	p.authMu.Lock()
	p.authActive = true
	p.authResp = make(chan authResult, 1)
	resp := p.authResp
	p.authMu.Unlock()
	if err := p.SubmitPanePassword("hunter2", true); err != nil {
		t.Fatalf("SubmitPanePassword: %v", err)
	}
	select {
	case r := <-resp:
		if r.text != "hunter2" {
			t.Errorf("delivered %q, want hunter2", r.text)
		}
	case <-time.After(time.Second):
		t.Fatal("password not delivered to waiting prompt")
	}
	p.pwdMu.Lock()
	if !p.savePwdChosen || !p.savePwdChoice {
		t.Error("save preference not recorded")
	}
	p.pwdMu.Unlock()
}

func TestCancelPanePassword(t *testing.T) {
	p := newPane(context.Background(), "p", profile.Session{})
	// No active prompt → nil (idempotent).
	if err := p.CancelPanePassword(); err != nil {
		t.Errorf("CancelPanePassword with no prompt: %v", err)
	}
	// Active prompt → delivers an error to the waiter.
	p.authMu.Lock()
	p.authActive = true
	p.authResp = make(chan authResult, 1)
	resp := p.authResp
	p.authMu.Unlock()
	_ = p.CancelPanePassword()
	select {
	case r := <-resp:
		if r.err == nil {
			t.Error("cancel should deliver an error")
		}
	case <-time.After(time.Second):
		t.Fatal("cancel not delivered")
	}
}

func TestPersistChosenPassword(t *testing.T) {
	p := newPane(context.Background(), "p", profile.Session{ID: "persist-sess"})
	// Not chosen → no-op, nothing persisted.
	p.persistChosenPassword()
	if _, err := keyring.Get("hopperxterm", "persist-sess"); err == nil {
		t.Error("persistChosenPassword wrote a key without a choice")
	}
	// Chosen + save → persists and clears.
	p.pwdMu.Lock()
	p.savePwdChosen = true
	p.savePwdChoice = true
	p.typedPwd = "saved-pw"
	p.hasTypedPw = true
	p.pwdMu.Unlock()
	p.persistChosenPassword()
	if got, _ := keyring.Get("hopperxterm", "persist-sess"); got != "saved-pw" {
		t.Errorf("keychain = %q, want saved-pw", got)
	}
}

func TestMaybeAskSavePassword_Branches(t *testing.T) {
	// chosen → returns early (no panic, no emit).
	p := newPane(context.Background(), "p", profile.Session{ID: "m1"})
	p.pwdMu.Lock()
	p.savePwdChosen = true
	p.pwdMu.Unlock()
	p.maybeAskSavePassword(profile.Session{ID: "m1"})

	// no typed pw → returns.
	p2 := newPane(context.Background(), "p", profile.Session{ID: "m2"})
	p2.maybeAskSavePassword(profile.Session{ID: "m2"})

	// typed pw not in keychain → emits (no-op under test ctx) without error.
	p3 := newPane(context.Background(), "p", profile.Session{ID: "m3"})
	p3.pwdMu.Lock()
	p3.typedPwd = "fresh"
	p3.hasTypedPw = true
	p3.pwdMu.Unlock()
	p3.maybeAskSavePassword(profile.Session{ID: "m3", Host: "h", User: "u"})
}

// ---- SFTP wrappers via fake file client ------------------------------------

func paneWithFC() (*Pane, *fakeFileClient) {
	p := newPane(context.Background(), "p", profile.Session{ID: "s"})
	fc := newFakeFC()
	p.fileMu.Lock()
	p.file = fc
	p.fileMu.Unlock()
	return p, fc
}

func TestSftpWrappers(t *testing.T) {
	p, fc := paneWithFC()
	fc.listing["/d"] = []transport.Entry{{Name: "a"}, {Name: "b"}}

	if entries, err := p.SftpList("/d"); err != nil || len(entries) != 2 {
		t.Errorf("SftpList: entries=%v err=%v", entries, err)
	}
	if cwd, err := p.SftpCwd(); err != nil || cwd != "/home/u" {
		t.Errorf("SftpCwd: %q %v", cwd, err)
	}
	if err := p.SftpMkdir("/x", true); err != nil {
		t.Errorf("SftpMkdir: %v", err)
	}
	if err := p.SftpCreate("/x/f"); err != nil {
		t.Errorf("SftpCreate: %v", err)
	}
	if err := p.SftpRemove("/x/f"); err != nil {
		t.Errorf("SftpRemove: %v", err)
	}
	if err := p.SftpRemoveAll("/x"); err != nil {
		t.Errorf("SftpRemoveAll: %v", err)
	}
	if err := p.SftpRename("/a", "/b"); err != nil {
		t.Errorf("SftpRename: %v", err)
	}
}

func TestSftpWrappers_NoFileClientErrors(t *testing.T) {
	p := newPane(context.Background(), "p", profile.Session{})
	if _, err := p.SftpList("/"); err == nil {
		t.Error("SftpList without a file client should error")
	}
	if _, err := p.fileClient(); err == nil {
		t.Error("fileClient without a backend should error")
	}
}

func TestSftpUpload_EmitsTransfer(t *testing.T) {
	p, fc := paneWithFC()
	fc.uploadN = 42

	// Upload a real local file (SftpUpload stats it for TotalBytes).
	dir := t.TempDir()
	local := dir + "/up.txt"
	if err := writeLocal(local, "hello"); err != nil {
		t.Fatal(err)
	}
	id, err := p.SftpUpload(local, "/remote/up.txt")
	if err != nil {
		t.Fatalf("SftpUpload: %v", err)
	}
	if id == 0 {
		t.Error("expected a non-zero transfer id")
	}
	if len(fc.uploaded) != 1 || fc.uploaded[0] != "/remote/up.txt" {
		t.Errorf("upload target not recorded: %v", fc.uploaded)
	}
}

func TestSftpDownload_EmitsTransfer(t *testing.T) {
	p, fc := paneWithFC()
	fc.downloadN = 7
	fc.listing["/remote"] = []transport.Entry{{Name: "f.txt", Size: 7}}
	id, err := p.SftpDownload("/remote/f.txt", t.TempDir()+"/f.txt")
	if err != nil {
		t.Fatalf("SftpDownload: %v", err)
	}
	if id == 0 {
		t.Error("expected a non-zero transfer id")
	}
}

func TestSftpUploadDir_And_DownloadDir(t *testing.T) {
	p, fc := paneWithFC()
	fc.uploadN = 3
	fc.downloadN = 3
	// UploadDir walks a real local tree for TotalBytes.
	dir := t.TempDir()
	_ = writeLocal(dir+"/a.txt", "abc")
	if _, err := p.SftpUploadDir(dir, "/remote"); err != nil {
		t.Errorf("SftpUploadDir: %v", err)
	}
	// DownloadDir pre-walks the remote via the fake List.
	fc.listing["/remote"] = []transport.Entry{{Name: "a.txt", Size: 3}}
	if _, err := p.SftpDownloadDir("/remote", dir+"/back"); err != nil {
		t.Errorf("SftpDownloadDir: %v", err)
	}
}

func TestStatRemote(t *testing.T) {
	p, fc := paneWithFC()
	fc.listing["/var"] = []transport.Entry{{Name: "log", Size: 999}}
	got, err := p.statRemote("/var/log")
	if err != nil {
		t.Fatalf("statRemote: %v", err)
	}
	if got != 999 {
		t.Errorf("statRemote = %d, want 999", got)
	}
}

func TestProgressThrottle_CancelAborts(t *testing.T) {
	p := newPane(context.Background(), "p", profile.Session{})
	id := nextTransferID()
	cancel := registerTransfer(id)
	defer unregisterTransfer(id)
	th := newProgressThrottle(p, id, "upload", "/r", 100, cancel)
	// Before cancel: report returns nil (throttled or emitted).
	if err := th.report(10); err != nil {
		t.Errorf("report before cancel: %v", err)
	}
	CancelTransfer(id)
	if err := th.report(20); err == nil {
		t.Error("report after cancel should return an error")
	}
}
