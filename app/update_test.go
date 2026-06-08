package main

import "testing"

func TestIsNewerVersion(t *testing.T) {
	cases := []struct {
		latest, current string
		want            bool
	}{
		{"1.0.1", "1.0.0", true},
		{"1.1.0", "1.0.9", true},
		{"1.10.0", "1.9.0", true},  // numeric, not lexical
		{"2.0.0", "1.99.99", true}, // major wins
		{"1.0.0", "1.0.0", false},
		{"1.0.0", "1.0.1", false},
		{"1.0.0", "2.0.0", false},
		{"v1.2.0", "1.1.0", true},      // leading v tolerated
		{"1.2.0", "v1.1.0", true},      // on either side
		{"1.2.0-rc1", "1.1.0", true},   // pre-release suffix ignored
		{"1.2.0", "1.2.0-rc1", false},  // 1.2.0 == 1.2.0 once suffix stripped
		{"1.2", "1.1.9", true},         // uneven component counts
		{"1.2.0", "1.2", false},        // 1.2.0 == 1.2
	}
	for _, c := range cases {
		if got := isNewerVersion(c.latest, c.current); got != c.want {
			t.Errorf("isNewerVersion(%q, %q) = %v, want %v", c.latest, c.current, got, c.want)
		}
	}
}

func TestPlatformAssetSuffix(t *testing.T) {
	cases := []struct {
		goos, goarch string
		want         string
	}{
		{"windows", "amd64", "-windows-amd64.exe"},
		{"darwin", "amd64", "-macos-universal.dmg"},
		{"darwin", "arm64", "-macos-universal.dmg"}, // universal — arch-agnostic
		{"linux", "amd64", "-linux-amd64.appimage"},
		{"linux", "arm64", "-linux-aarch64.appimage"}, // arm64 → aarch64 slug
		{"freebsd", "amd64", ""},                      // no packaged installer
		{"openbsd", "arm64", ""},
	}
	for _, c := range cases {
		if got := platformAssetSuffix(c.goos, c.goarch); got != c.want {
			t.Errorf("platformAssetSuffix(%q, %q) = %q, want %q", c.goos, c.goarch, got, c.want)
		}
	}
}

func TestClassifyLinuxInstall(t *testing.T) {
	cases := []struct {
		name              string
		appImage, exePath string
		wantCanSelf       bool
		wantPackaged      bool
	}{
		{"appimage", "/home/u/Apps/HopperXterm.AppImage", "/tmp/.mount_xx/usr/bin/HopperXterm", true, false},
		{"appimage wins over /usr path", "/home/u/HopperXterm.AppImage", "/usr/bin/HopperXterm", true, false},
		{"deb under /usr", "", "/usr/bin/HopperXterm", false, true},
		{"opt install", "", "/opt/hopperxterm/HopperXterm", false, true},
		{"bare binary in home", "", "/home/u/build/HopperXterm", false, false},
		{"bare binary in /tmp", "", "/tmp/HopperXterm", false, false},
		{"blank appimage env treated as unset", "   ", "/home/u/HopperXterm", false, false},
	}
	for _, c := range cases {
		gotSelf, gotPkg := classifyLinuxInstall(c.appImage, c.exePath)
		if gotSelf != c.wantCanSelf || gotPkg != c.wantPackaged {
			t.Errorf("classifyLinuxInstall(%q, %q) = (%v, %v), want (%v, %v)",
				c.appImage, c.exePath, gotSelf, gotPkg, c.wantCanSelf, c.wantPackaged)
		}
	}
}

func TestPickPlatformAsset(t *testing.T) {
	assets := []ghAsset{
		{Name: "HopperXterm-1.2.0-windows-amd64.exe", BrowserDownloadURL: "u-win"},
		{Name: "HopperXterm-1.2.0-macos-universal.dmg", BrowserDownloadURL: "u-mac"},
		{Name: "SHA256SUMS.txt", BrowserDownloadURL: "u-sums"},
	}
	// pickPlatformAsset keys off runtime.GOOS, so we can only assert the
	// running platform's result here — but it must never pick the checksum
	// file and must return one of the installers (or nil on an unsupported OS).
	got := pickPlatformAsset(assets)
	if got != nil && got.Name == "SHA256SUMS.txt" {
		t.Fatalf("picked the checksum file as an installer asset")
	}

	// No matching asset → nil.
	if a := pickPlatformAsset([]ghAsset{{Name: "notes.txt"}}); a != nil {
		t.Errorf("expected nil for assets with no installer, got %v", a)
	}
}
