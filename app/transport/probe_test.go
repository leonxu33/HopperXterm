package transport

import (
	"encoding/base64"
	"strings"
	"testing"
	"unicode/utf16"
)

func TestPowerShellEncodedCmd(t *testing.T) {
	const script = "Write-Output 'hi'"
	cmd := PowerShellEncodedCmd(script)
	const prefix = "powershell -NoProfile -NonInteractive -EncodedCommand "
	if !strings.HasPrefix(cmd, prefix) {
		t.Fatalf("missing prefix, got %q", cmd)
	}
	b64 := strings.TrimPrefix(cmd, prefix)
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		t.Fatalf("payload is not valid base64: %v", err)
	}
	// Decode the UTF-16LE bytes back to the original script.
	if len(raw)%2 != 0 {
		t.Fatalf("UTF-16LE payload has odd byte length %d", len(raw))
	}
	u := make([]uint16, len(raw)/2)
	for i := range u {
		u[i] = uint16(raw[2*i]) | uint16(raw[2*i+1])<<8
	}
	if got := string(utf16.Decode(u)); got != script {
		t.Errorf("round-trip = %q, want %q", got, script)
	}
}

const (
	mK   = "----HOPPERPROBE-KERNEL----"
	mH   = "----HOPPERPROBE-HOSTNAME----"
	mO   = "----HOPPERPROBE-OSREL----"
	mM   = "----HOPPERPROBE-MACOS----"
	mEnd = "----HOPPERPROBE-END----"
)

func TestParseHostInfoOutput_Ubuntu(t *testing.T) {
	in := mK + "\n" +
		"Linux 6.17.0-29-generic x86_64\n" +
		mH + "\n" +
		"prod-edge-01\n" +
		mO + "\n" +
		"PRETTY_NAME=\"Ubuntu 24.04.3 LTS\"\n" +
		"NAME=\"Ubuntu\"\n" +
		"VERSION_ID=\"24.04\"\n" +
		"VERSION=\"24.04.3 LTS (Noble Numbat)\"\n" +
		"ID=ubuntu\n" +
		mM + "\n" +
		mEnd + "\n"
	got := ParseHostInfoOutput(in)
	if got.Name != "Ubuntu" {
		t.Errorf("Name = %q, want Ubuntu", got.Name)
	}
	if got.Version != "24.04.3 LTS" {
		t.Errorf("Version = %q, want 24.04.3 LTS", got.Version)
	}
	if got.Kernel != "6.17.0-29-generic" {
		t.Errorf("Kernel = %q", got.Kernel)
	}
	if got.Arch != "x86_64" {
		t.Errorf("Arch = %q", got.Arch)
	}
	if got.Hostname != "prod-edge-01" {
		t.Errorf("Hostname = %q, want prod-edge-01", got.Hostname)
	}
}

func TestParseHostInfoOutput_AmazonLinuxWithBashrcNoise(t *testing.T) {
	// EC2 ec2-user often gets a chatty .bashrc / motd. The probe must
	// look past that prefix and use the marker-delimited sections.
	in := "Last login: Sat Apr 5 12:34:56 2025\n" +
		"   __|  __|_  )\n" +
		"   _|  (     /   Amazon Linux 2023\n" +
		"  ___|\\___|___|\n" +
		"https://aws.amazon.com/linux/amazon-linux-2023/\n" +
		mK + "\n" +
		"Linux 6.1.79-99.164.amzn2023.x86_64 x86_64\n" +
		mH + "\n" +
		"ip-10-0-1-23.ec2.internal\n" +
		mO + "\n" +
		"PRETTY_NAME=\"Amazon Linux 2023.4.20240416\"\n" +
		"NAME=\"Amazon Linux\"\n" +
		"VERSION=\"2023\"\n" +
		mM + "\n" +
		mEnd + "\n"
	got := ParseHostInfoOutput(in)
	if got.Name != "Amazon Linux" {
		t.Errorf("Name = %q, want Amazon Linux (motd should be ignored)", got.Name)
	}
	if got.Version != "2023.4.20240416" {
		t.Errorf("Version = %q", got.Version)
	}
	if got.Kernel != "6.1.79-99.164.amzn2023.x86_64" {
		t.Errorf("Kernel = %q", got.Kernel)
	}
	if got.Arch != "x86_64" {
		t.Errorf("Arch = %q", got.Arch)
	}
	if got.Hostname != "ip-10-0-1-23.ec2.internal" {
		t.Errorf("Hostname = %q", got.Hostname)
	}
}

func TestParseHostInfoOutput_Alpine(t *testing.T) {
	in := mK + "\n" +
		"Linux 6.6.32-0-lts aarch64\n" +
		mO + "\n" +
		"NAME=\"Alpine Linux\"\nID=alpine\nVERSION_ID=3.20.0\n" +
		mM + "\n" + mEnd + "\n"
	got := ParseHostInfoOutput(in)
	if got.Name != "Alpine Linux" {
		t.Errorf("Name = %q", got.Name)
	}
	if got.Version != "3.20.0" {
		t.Errorf("Version = %q", got.Version)
	}
	if got.Arch != "aarch64" {
		t.Errorf("Arch = %q", got.Arch)
	}
}

func TestParseHostInfoOutput_MacOSWithSwVers(t *testing.T) {
	in := mK + "\n" +
		"Darwin 23.6.0 arm64\n" +
		mO + "\n" + // no /etc/os-release on macOS
		mM + "\n" +
		"ProductName:		macOS\n" +
		"ProductVersion:	15.5\n" +
		"BuildVersion:		24F74\n" +
		mEnd + "\n"
	got := ParseHostInfoOutput(in)
	if got.Name != "macOS" {
		t.Errorf("Name = %q, want macOS", got.Name)
	}
	if got.Version != "15.5" {
		t.Errorf("Version = %q", got.Version)
	}
	if got.Kernel != "23.6.0" {
		t.Errorf("Kernel = %q", got.Kernel)
	}
	if got.Arch != "arm64" {
		t.Errorf("Arch = %q", got.Arch)
	}
}

func TestParseHostInfoOutput_NoMarkers(t *testing.T) {
	// If a remote runs an old/broken probe and we get raw kernel +
	// os-release without markers, the parser should return the zero
	// value rather than misread random shell output.
	if got := ParseHostInfoOutput("Linux 6.0.0 x86_64\nPRETTY_NAME=\"Hax\"\n"); got != (HostOSInfo{}) {
		t.Errorf("output without markers should yield zero value, got %+v", got)
	}
}

func TestParseHostInfoOutput_Empty(t *testing.T) {
	if got := ParseHostInfoOutput(""); got != (HostOSInfo{}) {
		t.Errorf("empty input should yield zero value, got %+v", got)
	}
}

func TestClassifyUname(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"Linux\n", "linux"},
		{"  LINUX  ", "linux"},
		{"Darwin\n", "darwin"},
		{"darwin", "darwin"},
		// Windows shells have no `uname`; the error text lands in stdout
		// via CombinedOutput and lacks the Linux/Darwin token.
		{"'uname' is not recognized as an internal or external command,", "windows"},
		{"uname : The term 'uname' is not recognized...", "windows"},
		{"", "windows"},
		// MINGW/Cygwin report neither Linux nor Darwin → windows (and
		// powershell.exe still exists there).
		{"MINGW64_NT-10.0-26200", "windows"},
	}
	for _, c := range cases {
		if got := classifyUname(c.in); got != c.want {
			t.Errorf("classifyUname(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

const (
	mWK = "----HOPPERPROBE-WINKERNEL----"
	mWH = "----HOPPERPROBE-WINHOST----"
	mWE = "----HOPPERPROBE-END----"
)

func TestParseWindowsHostInfo(t *testing.T) {
	in := mWK + "\r\n" +
		"Caption=Microsoft Windows 11 Pro\r\n" +
		"Version=10.0.26200\r\n" +
		"Arch=64-bit\r\n" +
		mWH + "\r\n" +
		"DESKTOP-ABC123\r\n" +
		mWE + "\r\n"
	got := parseWindowsHostInfo(in)
	if got.Name != "Windows 11 Pro" {
		t.Errorf("Name = %q, want Windows 11 Pro (Microsoft prefix stripped)", got.Name)
	}
	if got.Version != "10.0.26200" {
		t.Errorf("Version = %q", got.Version)
	}
	if got.Arch != "64-bit" {
		t.Errorf("Arch = %q", got.Arch)
	}
	if got.Hostname != "DESKTOP-ABC123" {
		t.Errorf("Hostname = %q", got.Hostname)
	}
}

func TestParseWindowsHostInfo_LeadingNoiseAndEmpty(t *testing.T) {
	// Banner / blank lines before the first marker are ignored.
	in := "some MOTD banner\r\n\r\n" + mWK + "\n" +
		"Caption=Microsoft Windows Server 2022 Standard\n" +
		mWH + "\n" + "WINSRV\n" + mWE + "\n"
	got := parseWindowsHostInfo(in)
	if got.Name != "Windows Server 2022 Standard" {
		t.Errorf("Name = %q", got.Name)
	}
	if got.Hostname != "WINSRV" {
		t.Errorf("Hostname = %q", got.Hostname)
	}
	if got := parseWindowsHostInfo(""); got != (HostOSInfo{}) {
		t.Errorf("empty input should yield zero value, got %+v", got)
	}
}
