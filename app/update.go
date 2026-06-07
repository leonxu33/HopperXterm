package main

// Self-update: check GitHub Releases for a newer version and install it in
// place — Windows runs the NSIS installer silently, macOS replaces the .app
// bundle, Linux replaces the running .AppImage. All three quit + relaunch.
// Manual-only — triggered from Settings → Check for updates. There is no
// background/auto check.
//
// The version, release tag, and installer asset names all derive from
// info.productVersion in wails.json (see app.go AppVersion + the release
// skill's naming scheme), so this stays in sync with what `release` publishes:
//   HopperXterm-<version>-windows-amd64.exe
//   HopperXterm-<version>-macos-universal.dmg
//   HopperXterm-<version>-linux-<arch>.AppImage   (<arch> = amd64 | aarch64)

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"hopperxterm/events"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// updateRepo is the GitHub owner/repo that publishes releases. Kept in sync
// with the repo link in AboutModal.tsx and the release skill.
const updateRepo = "leonxu33/HopperXterm"

// UpdateInfo is the result of a CheckForUpdates call, shaped for the frontend.
type UpdateInfo struct {
	// Available is true only when LatestVersion is strictly newer than the
	// running version AND an installer asset exists for this platform.
	Available bool `json:"available"`
	// Newer is true when LatestVersion is strictly newer than the running
	// version, regardless of whether an installer asset exists for this
	// platform (lets the frontend offer "View release" for manual download
	// when Newer && !HasAsset).
	Newer bool `json:"newer"`
	// Dev is true for the `wails dev` build (version "dev") — update checks
	// are meaningless there, so the frontend shows a "development build" note.
	Dev            bool   `json:"dev"`
	CurrentVersion string `json:"currentVersion"`
	LatestVersion  string `json:"latestVersion"`
	ReleaseNotes   string `json:"releaseNotes"`
	ReleaseURL     string `json:"releaseUrl"`
	// Asset* describe the installer for THIS platform. HasAsset is false when
	// the latest release ships no installer matching this OS/arch — the
	// frontend then offers "View release" (manual download) instead of install.
	HasAsset  bool   `json:"hasAsset"`
	AssetName string `json:"assetName"`
	AssetURL  string `json:"assetUrl"`
	AssetSize int64  `json:"assetSize"`
}

// ghRelease is the slice of GitHub's release JSON we consume.
type ghRelease struct {
	TagName string    `json:"tag_name"`
	HTMLURL string    `json:"html_url"`
	Body    string    `json:"body"`
	Assets  []ghAsset `json:"assets"`
}

type ghAsset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
	Size               int64  `json:"size"`
}

// CheckForUpdates queries the latest published GitHub release and compares it
// to the running version. It never mutates anything — the user opts into the
// install separately via DownloadAndApplyUpdate. Returns an error only on a
// network/parse failure so the frontend can surface it; a successful check
// with no newer version returns Available=false.
func (a *App) CheckForUpdates() (*UpdateInfo, error) {
	cur := a.AppVersion()
	info := &UpdateInfo{CurrentVersion: cur}

	// The dev build's version label (or an unparseable empty version) can't be
	// compared to a release tag — report it as a dev build rather than offering
	// a bogus update. devVersionLabel is "" in release builds (so this only
	// trips on a genuinely empty version) and "dev" under the dev build tag.
	if cur == "" || cur == devVersionLabel {
		info.Dev = true
		return info, nil
	}

	rel, err := fetchLatestRelease(a.ctx)
	if err != nil {
		return nil, err
	}

	info.LatestVersion = strings.TrimPrefix(strings.TrimSpace(rel.TagName), "v")
	info.ReleaseURL = rel.HTMLURL
	info.ReleaseNotes = rel.Body

	if asset := pickPlatformAsset(rel.Assets); asset != nil {
		info.HasAsset = true
		info.AssetName = asset.Name
		info.AssetURL = asset.BrowserDownloadURL
		info.AssetSize = asset.Size
	}

	// "Available" requires both a newer version and an installable asset; a
	// newer release with no asset for this platform still surfaces (via
	// Newer + ReleaseURL) but the frontend routes to manual download.
	info.Newer = isNewerVersion(info.LatestVersion, cur)
	info.Available = info.Newer && info.HasAsset

	return info, nil
}

// DownloadAndApplyUpdate downloads the given release asset (emitting
// update:progress events) and hands it to the platform installer. On Windows
// the installer runs silently and the app quits so it can replace the locked
// exe and relaunch; on macOS the .dmg is opened for the user to drag over and
// the app stays running. assetURL/assetName come straight from a prior
// CheckForUpdates result (no server-side state).
func (a *App) DownloadAndApplyUpdate(assetURL, assetName string) error {
	if assetURL == "" {
		return fmt.Errorf("no download URL for this platform")
	}

	path, err := a.downloadUpdateAsset(assetURL, assetName)
	if err != nil {
		events.EmitUpdateProgress(a.ctx, events.UpdateProgressPayload{State: "error", Error: err.Error()})
		return err
	}

	events.EmitUpdateProgress(a.ctx, events.UpdateProgressPayload{State: "installing"})

	if err := launchUpdateInstaller(path); err != nil {
		events.EmitUpdateProgress(a.ctx, events.UpdateProgressPayload{State: "error", Error: err.Error()})
		return err
	}

	if quitAfterInstall {
		// Quit so the silent installer can overwrite the locked exe; the
		// detached helper waits for us to exit, installs, and relaunches.
		// A short beat lets the frontend render "Installing…" and this RPC
		// resolve before the window tears down.
		go func() {
			time.Sleep(800 * time.Millisecond)
			wailsruntime.Quit(a.ctx)
		}()
	}
	return nil
}

// fetchLatestRelease GETs the repo's latest published release (the API
// endpoint already excludes drafts and pre-releases).
func fetchLatestRelease(ctx context.Context) (*ghRelease, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	reqCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	url := "https://api.github.com/repos/" + updateRepo + "/releases/latest"
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "HopperXterm-Updater") // GitHub rejects requests with no UA

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("contacting GitHub: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, fmt.Errorf("no published release found yet")
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GitHub returned %s", resp.Status)
	}

	var rel ghRelease
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&rel); err != nil {
		return nil, fmt.Errorf("parsing release: %w", err)
	}
	if strings.TrimSpace(rel.TagName) == "" {
		return nil, fmt.Errorf("latest release has no version tag")
	}
	return &rel, nil
}

// platformAssetSuffix returns the (lowercase) release-asset filename suffix for
// the given OS/arch per the naming scheme the `release` skill publishes, or ""
// for a platform with no packaged installer. Split out from pickPlatformAsset
// so the per-platform mapping (notably the linux arm64→aarch64 slug) is unit-
// testable without depending on the test host's GOOS/GOARCH.
func platformAssetSuffix(goos, goarch string) string {
	switch goos {
	case "windows":
		return "-windows-amd64.exe"
	case "darwin":
		return "-macos-universal.dmg"
	case "linux":
		// Arch-specific AppImage (see scripts/build_linux_installer.sh). Use the
		// "aarch64" slug for arm64 so it can't be misread as "amd64". The
		// in-place apply only works when running FROM an AppImage (the helper
		// replaces $APPIMAGE); a bare-binary build that downloads this will get
		// a clear "not an AppImage" error from launchUpdateInstaller instead.
		arch := goarch // "amd64"
		if arch == "arm64" {
			arch = "aarch64"
		}
		return "-linux-" + arch + ".appimage"
	default:
		return "" // no packaged installer for this platform
	}
}

// pickPlatformAsset returns the installer asset matching the running OS/arch
// per the release naming scheme, or nil if none is present.
func pickPlatformAsset(assets []ghAsset) *ghAsset {
	suffix := platformAssetSuffix(runtime.GOOS, runtime.GOARCH)
	if suffix == "" {
		return nil // no packaged installer for this platform
	}
	for i := range assets {
		if strings.HasSuffix(strings.ToLower(assets[i].Name), suffix) {
			return &assets[i]
		}
	}
	return nil
}

// isNewerVersion reports whether latest is strictly greater than current,
// comparing dotted-numeric components (so 1.10.0 > 1.9.0). Any pre-release or
// build suffix ("-rc1", "+meta") is ignored; missing/non-numeric components
// count as 0.
func isNewerVersion(latest, current string) bool {
	lv, cv := parseVersion(latest), parseVersion(current)
	n := len(lv)
	if len(cv) > n {
		n = len(cv)
	}
	for i := 0; i < n; i++ {
		var l, c int
		if i < len(lv) {
			l = lv[i]
		}
		if i < len(cv) {
			c = cv[i]
		}
		if l != c {
			return l > c
		}
	}
	return false
}

func parseVersion(v string) []int {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	if i := strings.IndexAny(v, "-+"); i >= 0 {
		v = v[:i]
	}
	parts := strings.Split(v, ".")
	out := make([]int, len(parts))
	for i, p := range parts {
		out[i], _ = strconv.Atoi(strings.TrimSpace(p))
	}
	return out
}

// downloadUpdateAsset streams the asset to a temp file, emitting throttled
// update:progress events. Returns the saved path.
func (a *App) downloadUpdateAsset(url, name string) (string, error) {
	ctx := a.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	// Cap the whole download so a stalled server can't hang the updater
	// forever. 10 min is generous for an ~10–20 MB installer even on a slow
	// link (~30 kbps floor) while still bounding a dead connection.
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()

	name = filepath.Base(strings.TrimSpace(name)) // strip any path components from the asset name
	if name == "" || name == "." || name == string(filepath.Separator) {
		name = "HopperXterm-update"
	}

	dir := filepath.Join(os.TempDir(), "hopperxterm-update")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("preparing download folder: %w", err)
	}
	dest := filepath.Join(dir, name)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "HopperXterm-Updater")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("downloading update: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("download failed: %s", resp.Status)
	}

	f, err := os.Create(dest)
	if err != nil {
		return "", fmt.Errorf("creating download file: %w", err)
	}

	total := resp.ContentLength
	pr := &progressReader{
		r:     resp.Body,
		total: total,
		emit: func(read int64) {
			events.EmitUpdateProgress(ctx, events.UpdateProgressPayload{State: "downloading", Bytes: read, Total: total})
		},
	}
	if _, err := io.Copy(f, pr); err != nil {
		f.Close()
		os.Remove(dest)
		return "", fmt.Errorf("saving update: %w", err)
	}
	if err := f.Close(); err != nil {
		os.Remove(dest)
		return "", err
	}
	return dest, nil
}

// progressReader wraps a download stream and reports cumulative bytes read,
// throttled to one emit per ~256 KiB (plus a final emit at EOF) so the event
// stream doesn't flood the frontend.
type progressReader struct {
	r        io.Reader
	total    int64
	read     int64
	lastEmit int64
	emit     func(read int64)
}

func (p *progressReader) Read(b []byte) (int, error) {
	n, err := p.r.Read(b)
	if n > 0 {
		p.read += int64(n)
		if p.read-p.lastEmit >= 256*1024 {
			p.lastEmit = p.read
			p.emit(p.read)
		}
	}
	if err == io.EOF {
		p.emit(p.read) // ensure a final 100% tick
	}
	return n, err
}
