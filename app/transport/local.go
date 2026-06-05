// Local shell transport — spawns a child shell process inside a PTY
// on the host machine. Uses github.com/aymanbagabas/go-pty which
// dispatches to ConPTY on Windows and pty(7) on Unix.
//
// Default command:
//   Windows  → pwsh.exe (PowerShell 7+), fallback powershell.exe, then cmd.exe
//   linux    → $SHELL or /bin/bash
//   darwin   → $SHELL or /bin/zsh
package transport

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	goruntime "runtime"

	pty "github.com/aymanbagabas/go-pty"
)

// LocalShell is a started local PTY. Satisfies PtyChannel.
type LocalShell struct {
	pty  pty.Pty
	cmd  *pty.Cmd
	In   io.WriteCloser
	Out  io.Reader
	name string
}

// Stdin / Stdout / Resize make LocalShell satisfy PtyChannel.
func (s *LocalShell) Stdin() io.Writer  { return s.In }
func (s *LocalShell) Stdout() io.Reader { return s.Out }

// StartLocalShell launches the platform-default shell. The PTY is
// initialised to 80×24; resize via Resize before/after Wait.
func StartLocalShell() (*LocalShell, error) {
	command, args := defaultLocalShell()
	if command == "" {
		return nil, errors.New("transport: no local shell found")
	}

	p, err := pty.New()
	if err != nil {
		return nil, fmt.Errorf("transport: pty new: %w", err)
	}
	cmd := p.Command(command, args...)
	cmd.Env = os.Environ()
	// Start in the user's home directory, like every terminal app. A
	// GUI-launched process's cwd is meaningless (`/` on macOS, the exe dir on
	// Windows). An unresolvable home just keeps the inherited cwd.
	if home, err := os.UserHomeDir(); err == nil {
		cmd.Dir = home
	}
	if goruntime.GOOS != "windows" {
		// A GUI-launched app (Finder / Dock / .desktop) inherits no TERM or
		// locale. Without TERM, zsh's line editor degrades badly (dead arrow
		// keys, backspace echoing whitespace). xterm.js is an
		// xterm-256color-class terminal, so advertise that when nothing is
		// set; an inherited TERM (e.g. `wails dev` from a terminal) wins.
		if os.Getenv("TERM") == "" {
			cmd.Env = append(cmd.Env, "TERM=xterm-256color")
		}
		// No locale at all renders the shell ASCII-only; pick a UTF-8 one.
		if os.Getenv("LANG") == "" && os.Getenv("LC_ALL") == "" && os.Getenv("LC_CTYPE") == "" {
			cmd.Env = append(cmd.Env, "LANG=en_US.UTF-8")
		}
	}

	if err := cmd.Start(); err != nil {
		p.Close()
		return nil, fmt.Errorf("transport: start %s: %w", command, err)
	}

	return &LocalShell{
		pty:  p,
		cmd:  cmd,
		In:   p,
		Out:  p,
		name: command,
	}, nil
}

// Resize updates the PTY size. cols/rows in terminal cells.
func (s *LocalShell) Resize(cols, rows int) error {
	if s.pty == nil {
		return errors.New("local shell: not running")
	}
	return s.pty.Resize(cols, rows)
}

// Close terminates the shell and releases the PTY.
func (s *LocalShell) Close() error {
	if s.cmd != nil && s.cmd.Process != nil {
		_ = s.cmd.Process.Kill()
	}
	if s.pty != nil {
		return s.pty.Close()
	}
	return nil
}

// Name reports the executable we launched (for connection logs).
func (s *LocalShell) Name() string { return s.name }

// Wait blocks until the shell process exits.
func (s *LocalShell) Wait() error {
	if s.cmd == nil {
		return errors.New("local shell: nothing to wait on")
	}
	return s.cmd.Wait()
}

// defaultLocalShell picks a sensible shell per OS. Returns the command
// and any default args.
func defaultLocalShell() (string, []string) {
	switch goruntime.GOOS {
	case "windows":
		// Prefer pwsh (PowerShell 7+) which has nicer ANSI support and
		// is the default in modern Windows installs. Fall back to
		// Windows PowerShell, then cmd.exe.
		for _, candidate := range []string{"pwsh.exe", "powershell.exe", "cmd.exe"} {
			if path, err := exec.LookPath(candidate); err == nil {
				return path, nil
			}
		}
		// As a last resort assume cmd.exe is on PATH even if LookPath
		// failed (shouldn't happen on a healthy Windows install).
		return "cmd.exe", nil
	case "darwin":
		// Login shell (-l), matching what Terminal.app does: a Finder-launched
		// app's PATH is the bare system default, and only the login profile
		// chain (/usr/libexec/path_helper via /etc/zprofile, ~/.zprofile)
		// restores the user's real PATH (Homebrew, toolchains, …).
		if sh := os.Getenv("SHELL"); sh != "" {
			return sh, []string{"-l"}
		}
		return "/bin/zsh", []string{"-l"}
	default: // linux, *bsd
		if sh := os.Getenv("SHELL"); sh != "" {
			return sh, nil
		}
		return "/bin/bash", nil
	}
}
