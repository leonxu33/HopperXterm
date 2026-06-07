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
