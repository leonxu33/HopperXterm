// One-shot OS identity probe used to populate the status bar's host
// info section. Returns whatever Linux/macOS exposes about itself —
// distro name + version + kernel + arch. Best-effort: missing fields
// are returned empty, never as an error.
package transport

import (
	"bufio"
	"encoding/base64"
	"strings"
	"time"
	"unicode/utf16"

	"golang.org/x/crypto/ssh"
)

// PowerShellEncodedCmd builds a `powershell -EncodedCommand` invocation
// for the given script. Windows OpenSSH will NOT reliably run a script
// fed to `powershell -Command -` on stdin — it reads nothing and exits 0
// — so we pass the script as a base64'd UTF-16LE -EncodedCommand instead:
// no stdin, no quoting headaches. Our scripts are ASCII and stay well
// under the cmd.exe 8191-char command-line limit even after encoding.
func PowerShellEncodedCmd(script string) string {
	u := utf16.Encode([]rune(script))
	b := make([]byte, len(u)*2)
	for i, c := range u {
		b[2*i] = byte(c)
		b[2*i+1] = byte(c >> 8)
	}
	return "powershell -NoProfile -NonInteractive -EncodedCommand " + base64.StdEncoding.EncodeToString(b)
}

// HostOSInfo mirrors the events.HostInfo payload. Kept in the transport
// package so callers don't need to import events just to call a probe.
type HostOSInfo struct {
	Name     string
	Version  string
	Kernel   string
	Arch     string
	Hostname string // `hostname` command output, or `uname -n` fallback
	// Family is the OS family ("linux" / "darwin" / "windows") as decided
	// by ClassifyRemoteOS during the probe. Exposed so callers can reuse
	// the classification (e.g. the resource poller) instead of paying a
	// second `uname -s` round trip.
	Family string
}

// probeScript prints three labelled sections wrapped in marker lines.
// Markers let us tolerate leading noise from the remote user's shell
// startup (.bashrc / motd / Amazon Linux's "Last login" banner / etc.)
// — without them, EC2 hosts were having their first non-blank line
// misread as the uname output.
//
//   - HOPPERPROBE-KERNEL   → `uname -s -r -m` (Linux 6.17.0-29 x86_64)
//   - HOPPERPROBE-HOSTNAME → `hostname` (e.g. ip-10-0-1-23.ec2.internal)
//   - HOPPERPROBE-OSREL    → /etc/os-release contents (KEY=value)
//   - HOPPERPROBE-MACOS    → `sw_vers` output on Darwin hosts
//   - HOPPERPROBE-END      → terminator
//
// POSIX-safe so it works on BusyBox / Alpine.
const probeScript = `printf '%s\n' '----HOPPERPROBE-KERNEL----'
uname -s -r -m 2>/dev/null
printf '%s\n' '----HOPPERPROBE-HOSTNAME----'
hostname 2>/dev/null || uname -n 2>/dev/null
printf '%s\n' '----HOPPERPROBE-OSREL----'
cat /etc/os-release 2>/dev/null
printf '%s\n' '----HOPPERPROBE-MACOS----'
sw_vers 2>/dev/null
printf '%s\n' '----HOPPERPROBE-END----'`

// windowsProbeScript is the PowerShell counterpart to probeScript for
// Windows OpenSSH remotes, which have no POSIX shell to interpret the
// `printf`/`uname`/`cat` snippet above. Same marker-delimited shape so
// the parser can reuse the section-walking approach.
//
// CRITICAL: this touches ONLY the registry, pure .NET, and environment
// variables — never the cimwin32 classes (Win32_OperatingSystem etc.),
// which HANG INDEFINITELY over the non-PTY exec on some hosts (the same
// trap the resource poller documents and avoids). The original version
// used `Get-CimInstance Win32_OperatingSystem` and was the reason host
// info silently failed to populate on those machines. ProductName/
// DisplayVersion/CurrentBuild come from the CurrentVersion registry key;
// arch from $env:PROCESSOR_ARCHITECTURE; hostname from $env:COMPUTERNAME.
const windowsProbeScript = `$ErrorActionPreference='SilentlyContinue'
$ProgressPreference='SilentlyContinue'
$rk = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
$disp = $rk.DisplayVersion
if (-not $disp) { $disp = $rk.ReleaseId }
Write-Output '----HOPPERPROBE-WINKERNEL----'
Write-Output ('Caption=' + $rk.ProductName)
Write-Output ('Version=' + $disp + ' (build ' + $rk.CurrentBuild + ')')
Write-Output ('Arch=' + $env:PROCESSOR_ARCHITECTURE)
Write-Output '----HOPPERPROBE-WINHOST----'
Write-Output $env:COMPUTERNAME
Write-Output '----HOPPERPROBE-END----'`

// RunWithTimeout opens a fresh session, runs cmd, and returns its
// combined (stdout+stderr) output. ok is false only when the session
// can't be opened or the command doesn't finish within d — a nonzero
// command exit is deliberately NOT a failure: callers parse best-effort
// output (PowerShell can exit nonzero with usable output) and the OS
// classifier relies on a Windows shell's "not recognized" stderr text. On
// !ok the returned string is empty. The done channel is buffered so the
// goroutine never leaks on timeout (sess.Close, deferred, unblocks it).
func RunWithTimeout(client *ssh.Client, cmd string, d time.Duration) (string, bool) {
	sess, err := client.NewSession()
	if err != nil {
		return "", false
	}
	defer sess.Close()
	done := make(chan []byte, 1)
	go func() {
		out, _ := sess.CombinedOutput(cmd)
		done <- out
	}()
	select {
	case out := <-done:
		return string(out), true
	case <-time.After(d):
		return "", false
	}
}

// ClassifyRemoteOS runs `uname -s` over the SSH client to decide which
// family of probe/resource script the remote understands. Returns
// "linux", "darwin", or "windows". On Windows OpenSSH the default shell
// (cmd.exe / powershell.exe) has no `uname`, so the command errors or
// emits no Linux|Darwin token — classified as "windows". A 3-second hard
// deadline guards a hung remote; on timeout (or a failed session) it
// returns "" and callers treat the empty string as the Linux default for
// backwards compatibility.
func ClassifyRemoteOS(client *ssh.Client) string {
	if client == nil {
		return ""
	}
	out, ok := RunWithTimeout(client, "uname -s", 3*time.Second)
	if !ok {
		return ""
	}
	return classifyUname(out)
}

// classifyUname maps `uname -s` stdout to an OS family. Pure, for tests.
// Linux/Darwin are matched case-insensitively; anything else (including
// the empty string or a Windows shell's error text) is treated as
// Windows.
func classifyUname(out string) string {
	low := strings.ToLower(out)
	switch {
	case strings.Contains(low, "linux"):
		return "linux"
	case strings.Contains(low, "darwin"):
		return "darwin"
	default:
		return "windows"
	}
}

// ProbeHostInfoSSH runs the probe against an existing SSH client.
// 5-second hard deadline; any failure returns the zero value. Windows
// remotes are detected up front and probed via PowerShell instead of the
// POSIX script.
func ProbeHostInfoSSH(client *ssh.Client) HostOSInfo {
	if client == nil {
		return HostOSInfo{}
	}
	// Classify once and carry the result back on the returned struct so
	// callers (the resource poller) can skip re-running `uname -s`.
	fam := ClassifyRemoteOS(client)
	var info HostOSInfo
	if fam == "windows" {
		info = probeWindowsHostInfo(client)
	} else if out, ok := RunWithTimeout(client, probeScript, 5*time.Second); ok {
		info = ParseHostInfoOutput(out)
	}
	info.Family = fam
	return info
}

// probeWindowsHostInfo feeds windowsProbeScript to PowerShell on the
// remote and parses the marker-delimited result. 5-second hard deadline.
// A nonzero PowerShell exit still gets parsed — partial output (e.g. the
// hostname but not the CIM query) is better than nothing.
func probeWindowsHostInfo(client *ssh.Client) HostOSInfo {
	// RunWithTimeout returns "" on timeout/failure, and parseWindowsHostInfo
	// is safe on any input (yields the zero value), so the timeout/error
	// cases collapse into the same parse call.
	out, _ := RunWithTimeout(client, PowerShellEncodedCmd(windowsProbeScript), 5*time.Second)
	return parseWindowsHostInfo(out)
}

// parseWindowsHostInfo turns the windowsProbeScript output into a
// HostOSInfo. Walks the marker-delimited sections so leading shell
// chatter is ignored, mirroring ParseHostInfoOutput. Exposed-style pure
// function; safe on any input.
func parseWindowsHostInfo(s string) HostOSInfo {
	info := HostOSInfo{}
	const (
		kKernel = "----HOPPERPROBE-WINKERNEL----"
		kHost   = "----HOPPERPROBE-WINHOST----"
		kEnd    = "----HOPPERPROBE-END----"
	)
	section := ""
	scanner := bufio.NewScanner(strings.NewReader(s))
	for scanner.Scan() {
		trimmed := strings.TrimSpace(scanner.Text())
		switch trimmed {
		case kKernel:
			section = "kernel"
			continue
		case kHost:
			section = "host"
			continue
		case kEnd:
			section = ""
			continue
		}
		switch section {
		case "kernel":
			eq := strings.IndexByte(trimmed, '=')
			if eq < 0 {
				continue
			}
			key := strings.TrimSpace(trimmed[:eq])
			val := strings.TrimSpace(trimmed[eq+1:])
			if val == "" {
				continue
			}
			switch key {
			case "Caption":
				// "Microsoft Windows 11 Pro" → "Windows 11 Pro".
				info.Name = strings.TrimSpace(strings.TrimPrefix(val, "Microsoft "))
			case "Version":
				info.Version = val // NT build, e.g. "10.0.26200"
			case "Arch":
				info.Arch = val // e.g. "64-bit"
			}
		case "host":
			if info.Hostname == "" && trimmed != "" {
				info.Hostname = trimmed
			}
		}
	}
	return info
}

// ParseHostInfoOutput turns the probe script's stdout into a
// HostOSInfo. Walks the marker-delimited sections so we ignore any
// leading noise from the remote shell's startup. Exposed for unit
// tests; safe to call on any input.
func ParseHostInfoOutput(s string) HostOSInfo {
	info := HostOSInfo{}
	const (
		kKernel   = "----HOPPERPROBE-KERNEL----"
		kHostname = "----HOPPERPROBE-HOSTNAME----"
		kOSRel    = "----HOPPERPROBE-OSREL----"
		kMacOS    = "----HOPPERPROBE-MACOS----"
		kEnd      = "----HOPPERPROBE-END----"
	)
	// Bucket lines by section. Anything before the first marker is shell
	// startup chatter and gets discarded.
	var kernelLines, hostnameLines, osrelLines, macosLines []string
	section := ""
	scanner := bufio.NewScanner(strings.NewReader(s))
	for scanner.Scan() {
		raw := scanner.Text()
		trimmed := strings.TrimSpace(raw)
		switch trimmed {
		case kKernel:
			section = "kernel"
			continue
		case kHostname:
			section = "hostname"
			continue
		case kOSRel:
			section = "osrel"
			continue
		case kMacOS:
			section = "macos"
			continue
		case kEnd:
			section = ""
			continue
		}
		switch section {
		case "kernel":
			kernelLines = append(kernelLines, raw)
		case "hostname":
			hostnameLines = append(hostnameLines, raw)
		case "osrel":
			osrelLines = append(osrelLines, raw)
		case "macos":
			macosLines = append(macosLines, raw)
		}
	}
	// Hostname section: first non-blank line, trimmed.
	for _, ln := range hostnameLines {
		t := strings.TrimSpace(ln)
		if t != "" {
			info.Hostname = t
			break
		}
	}
	// Kernel section: take the first non-empty line as `uname -s -r -m`.
	for _, ln := range kernelLines {
		f := strings.Fields(ln)
		if len(f) >= 3 {
			info.Name = f[0] // overwritten by os-release / sw_vers below
			info.Kernel = f[1]
			info.Arch = f[2]
			break
		}
	}
	// /etc/os-release section.
	for _, ln := range osrelLines {
		line := strings.TrimSpace(ln)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		eq := strings.IndexByte(line, '=')
		if eq < 0 {
			continue
		}
		key := strings.TrimSpace(line[:eq])
		val := strings.Trim(strings.TrimSpace(line[eq+1:]), `"`)
		switch key {
		case "PRETTY_NAME":
			if val == "" {
				continue
			}
			info.Name, info.Version = splitPrettyName(val)
		case "NAME":
			if info.Name == "" || info.Name == "Linux" || info.Name == "Darwin" {
				info.Name = val
			}
		case "VERSION":
			if info.Version == "" {
				info.Version = val
			}
		case "VERSION_ID":
			if info.Version == "" {
				info.Version = val
			}
		}
	}
	// macOS sw_vers section (only populated when the remote is Darwin).
	// Output looks like:
	//   ProductName:    macOS
	//   ProductVersion: 15.5
	//   BuildVersion:   24F74
	var swName, swVer string
	for _, ln := range macosLines {
		line := strings.TrimSpace(ln)
		colon := strings.IndexByte(line, ':')
		if colon < 0 {
			continue
		}
		key := strings.TrimSpace(line[:colon])
		val := strings.TrimSpace(line[colon+1:])
		switch key {
		case "ProductName":
			swName = val
		case "ProductVersion":
			swVer = val
		}
	}
	if swName != "" {
		info.Name = swName
	}
	if swVer != "" {
		info.Version = swVer
	}
	return info
}

// splitPrettyName separates "Ubuntu 24.04.3 LTS" into ("Ubuntu",
// "24.04.3 LTS"). For single-word values it returns the whole thing as
// the name.
func splitPrettyName(s string) (string, string) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", ""
	}
	// Distros like "Amazon Linux" have a two-word name; we still split on
	// the first digit-bearing token. Walk forward to find the start of
	// version-like content.
	parts := strings.Fields(s)
	for i := 1; i < len(parts); i++ {
		if hasDigit(parts[i]) {
			return strings.Join(parts[:i], " "), strings.Join(parts[i:], " ")
		}
	}
	return s, ""
}

func hasDigit(s string) bool {
	for _, r := range s {
		if r >= '0' && r <= '9' {
			return true
		}
	}
	return false
}
