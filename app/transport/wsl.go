// WSL transport — runs `wsl.exe -d <distro>` through the same PTY
// machinery as the local shell. Windows-only; on other platforms
// StartWSL returns an error.
package transport

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	goruntime "runtime"
	"strings"
	"unicode/utf16"

	pty "github.com/aymanbagabas/go-pty"
)

// ListWSLDistros returns the installed WSL distribution names (the default
// is listed first, matching wsl.exe's own ordering). Off Windows it returns
// an empty slice with no error so the frontend can simply show no picker.
func ListWSLDistros() ([]string, error) {
	if goruntime.GOOS != "windows" {
		return []string{}, nil
	}
	wslPath, err := exec.LookPath("wsl.exe")
	if err != nil {
		return nil, fmt.Errorf("transport: wsl.exe not found: %w", err)
	}
	// `--list --quiet` prints just the distro names, default first. wsl.exe
	// emits UTF-16LE (often with a BOM), so decode rather than treat as ASCII.
	out, err := exec.Command(wslPath, "--list", "--quiet").Output()
	if err != nil {
		return nil, fmt.Errorf("transport: wsl --list: %w", err)
	}
	var distros []string
	for _, line := range strings.Split(decodeUTF16LE(out), "\n") {
		line = strings.TrimSpace(strings.Trim(line, "\r\x00"))
		if line != "" {
			distros = append(distros, line)
		}
	}
	return distros, nil
}

// decodeUTF16LE converts little-endian UTF-16 bytes (wsl.exe's output
// encoding on Windows) to a UTF-8 string, dropping a leading BOM and any
// trailing odd byte.
func decodeUTF16LE(b []byte) string {
	n := len(b) / 2
	u := make([]uint16, n)
	for i := 0; i < n; i++ {
		u[i] = uint16(b[2*i]) | uint16(b[2*i+1])<<8
	}
	if len(u) > 0 && u[0] == 0xFEFF { // strip BOM
		u = u[1:]
	}
	return string(utf16.Decode(u))
}

// StartWSL launches a WSL session for the named distro. Pass an empty
// string to use the user's default distro.
func StartWSL(distro string) (*LocalShell, error) {
	if goruntime.GOOS != "windows" {
		return nil, errors.New("transport: WSL is only available on Windows")
	}
	wslPath, err := exec.LookPath("wsl.exe")
	if err != nil {
		return nil, fmt.Errorf("transport: wsl.exe not found: %w", err)
	}

	args := []string{}
	if distro != "" {
		args = append(args, "-d", distro)
	}

	p, err := pty.New()
	if err != nil {
		return nil, fmt.Errorf("transport: pty new: %w", err)
	}
	cmd := p.Command(wslPath, args...)
	cmd.Env = os.Environ()
	if err := cmd.Start(); err != nil {
		p.Close()
		return nil, fmt.Errorf("transport: start wsl: %w", err)
	}
	name := "wsl"
	if distro != "" {
		name = "wsl:" + distro
	}
	return &LocalShell{
		pty:  p,
		cmd:  cmd,
		In:   p,
		Out:  p,
		name: name,
	}, nil
}
