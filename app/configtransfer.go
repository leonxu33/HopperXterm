package main

// Configuration export / import. Bundles the user's portable JSON
// records (sessions, groups, workspaces, macros, recents) into a single
// .zip for migrating to another machine. Connection passwords and key
// passphrases live in the OS keychain and are deliberately NOT included —
// the user re-enters them (once, when first prompted) on the new machine.

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"hopperxterm/appdir"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// configFiles is the set of JSON records that make up a portable config.
// Each is optional — a fresh install may not have written all of them.
var configFiles = []string{
	"groups.json",
	"sessions.json",
	"workspaces.json",
	"macros.json",
	"recents.json",
	"prefs.json",
}

const exportManifestName = "hopperxterm-export.json"

type exportManifest struct {
	App        string   `json:"app"`
	Version    int      `json:"version"`
	ExportedAt string   `json:"exportedAt"`
	Files      []string `json:"files"`
	Note       string   `json:"note"`
}

func configBaseDir() (string, error) {
	return appdir.Base()
}

// ExportConfig prompts for a destination .zip and writes the user's
// configuration into it (plus a manifest). Returns the chosen path, or
// "" if the user cancelled. Passwords are never included.
func (a *App) ExportConfig() (string, error) {
	base, err := configBaseDir()
	if err != nil {
		return "", err
	}
	target, err := wailsruntime.SaveFileDialog(a.ctx, wailsruntime.SaveDialogOptions{
		Title:           "Export HopperXterm configuration",
		DefaultFilename: fmt.Sprintf("hopperxterm-config-%s.zip", time.Now().Format("2006-01-02")),
		Filters:         []wailsruntime.FileFilter{{DisplayName: "Zip archive (*.zip)", Pattern: "*.zip"}},
	})
	if err != nil {
		return "", err
	}
	if target == "" {
		return "", nil // cancelled
	}

	data, err := buildConfigZip(base)
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(target, data, 0o644); err != nil {
		return "", fmt.Errorf("write %s: %w", target, err)
	}
	return target, nil
}

// buildConfigZip packs the allowlisted config files under base into a zip
// (plus a manifest), returning the archive bytes. Files that don't exist
// are skipped. Built in memory since these records are tiny.
func buildConfigZip(base string) ([]byte, error) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	included := make([]string, 0, len(configFiles))
	for _, name := range configFiles {
		b, rerr := os.ReadFile(filepath.Join(base, name))
		if errors.Is(rerr, os.ErrNotExist) {
			continue
		}
		if rerr != nil {
			return nil, fmt.Errorf("read %s: %w", name, rerr)
		}
		w, werr := zw.Create(name)
		if werr != nil {
			return nil, werr
		}
		if _, werr := w.Write(b); werr != nil {
			return nil, werr
		}
		included = append(included, name)
	}

	mb, _ := json.MarshalIndent(exportManifest{
		App:        "HopperXterm",
		Version:    1,
		ExportedAt: time.Now().UTC().Format(time.RFC3339),
		Files:      included,
		Note:       "Connection passwords and key passphrases are stored in the OS keychain and are NOT included in this export.",
	}, "", "  ")
	if w, werr := zw.Create(exportManifestName); werr == nil {
		_, _ = w.Write(mb)
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// ImportConfig prompts for a .zip produced by ExportConfig and replaces
// the matching local config files, then reloads the live stores so the
// UI updates without a restart. Returns the source path, or "" if
// cancelled. Only files on the configFiles allowlist are extracted (by
// basename, so a malicious archive can't escape the config dir), and
// each must be valid JSON before anything on disk is touched.
func (a *App) ImportConfig() (string, error) {
	base, err := configBaseDir()
	if err != nil {
		return "", err
	}
	src, err := wailsruntime.OpenFileDialog(a.ctx, wailsruntime.OpenDialogOptions{
		Title:   "Import HopperXterm configuration",
		Filters: []wailsruntime.FileFilter{{DisplayName: "Zip archive (*.zip)", Pattern: "*.zip"}},
	})
	if err != nil {
		return "", err
	}
	if src == "" {
		return "", nil // cancelled
	}

	data, err := os.ReadFile(src)
	if err != nil {
		return "", fmt.Errorf("read archive: %w", err)
	}
	if _, err := applyConfigZip(base, data); err != nil {
		return "", err
	}
	a.reloadStores()
	return src, nil
}

// applyConfigZip extracts the allowlisted, valid-JSON config files from a
// zip archive into base, replacing each atomically. Returns how many
// files were written. Only basenames on the allowlist are honored (so a
// crafted archive can't write outside base — zip-slip safe), and every
// entry is validated before anything on disk is touched, so a corrupt
// archive can't leave the config half-replaced.
func applyConfigZip(base string, data []byte) (int, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return 0, fmt.Errorf("open archive: %w", err)
	}

	allowed := make(map[string]bool, len(configFiles))
	for _, n := range configFiles {
		allowed[n] = true
	}

	pending := map[string][]byte{}
	for _, zf := range zr.File {
		name := filepath.Base(zf.Name)
		if !allowed[name] {
			continue
		}
		rc, oerr := zf.Open()
		if oerr != nil {
			return 0, fmt.Errorf("read %s: %w", name, oerr)
		}
		b, rerr := io.ReadAll(io.LimitReader(rc, 8<<20)) // 8 MiB ceiling per file
		rc.Close()
		if rerr != nil {
			return 0, fmt.Errorf("read %s: %w", name, rerr)
		}
		if len(b) > 0 && !json.Valid(b) {
			return 0, fmt.Errorf("%s in the archive is not valid JSON", name)
		}
		pending[name] = b
	}
	if len(pending) == 0 {
		return 0, errors.New("no HopperXterm configuration files found in the archive")
	}

	if err := os.MkdirAll(base, 0o755); err != nil {
		return 0, err
	}
	for name, b := range pending {
		dst := filepath.Join(base, name)
		tmp := dst + ".tmp"
		if err := os.WriteFile(tmp, b, 0o644); err != nil {
			return 0, fmt.Errorf("write %s: %w", name, err)
		}
		if err := os.Rename(tmp, dst); err != nil {
			return 0, fmt.Errorf("replace %s: %w", name, err)
		}
	}
	return len(pending), nil
}

// reloadStores re-reads every file-backed store from disk. Best-effort:
// a reload error on one store shouldn't block the others.
func (a *App) reloadStores() {
	if a.profile != nil {
		_ = a.profile.Reload()
	}
	if a.workspaces != nil {
		_ = a.workspaces.Reload()
	}
	if a.macros != nil {
		_ = a.macros.Reload()
	}
	if a.recents != nil {
		_ = a.recents.Reload()
	}
	if a.prefs != nil {
		_ = a.prefs.Reload()
	}
}
