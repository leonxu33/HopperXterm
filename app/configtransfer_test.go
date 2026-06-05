package main

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestBuildAndApplyConfigZip_RoundTrip(t *testing.T) {
	srcDir := t.TempDir()
	// Two of the known files present, the rest absent (must be skipped).
	writeFile(t, srcDir, "sessions.json", `[{"id":"s1","type":"ssh","label":"box"}]`)
	writeFile(t, srcDir, "groups.json", `[{"id":"g1","name":"Prod"}]`)

	data, err := buildConfigZip(srcDir)
	if err != nil {
		t.Fatalf("buildConfigZip: %v", err)
	}

	// Apply into a fresh dir and confirm the files reappear verbatim.
	dstDir := t.TempDir()
	n, err := applyConfigZip(dstDir, data)
	if err != nil {
		t.Fatalf("applyConfigZip: %v", err)
	}
	if n != 2 {
		t.Errorf("wrote %d files, want 2", n)
	}
	if got := readFile(t, dstDir, "sessions.json"); got != `[{"id":"s1","type":"ssh","label":"box"}]` {
		t.Errorf("sessions.json round-trip mismatch: %q", got)
	}
	if got := readFile(t, dstDir, "groups.json"); got != `[{"id":"g1","name":"Prod"}]` {
		t.Errorf("groups.json round-trip mismatch: %q", got)
	}
	// A file not in the archive must not be created.
	if _, err := os.Stat(filepath.Join(dstDir, "macros.json")); !os.IsNotExist(err) {
		t.Errorf("macros.json should not exist, stat err = %v", err)
	}
}

func TestApplyConfigZip_RejectsInvalidJSON(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, _ := zw.Create("sessions.json")
	w.Write([]byte("{not json"))
	zw.Close()

	dstDir := t.TempDir()
	if _, err := applyConfigZip(dstDir, buf.Bytes()); err == nil {
		t.Error("expected error for invalid JSON entry")
	}
	// Nothing should have been written.
	if _, err := os.Stat(filepath.Join(dstDir, "sessions.json")); !os.IsNotExist(err) {
		t.Error("sessions.json should not have been written on validation failure")
	}
}

func TestApplyConfigZip_IgnoresUnknownAndTraversalEntries(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	// A path-traversal attempt and an unrelated file — both must be ignored;
	// only the basename-allowlisted entry is honored.
	for name, body := range map[string]string{
		"../../evil.json":      `{"x":1}`,
		"random.txt":           "hello",
		"sub/dir/sessions.json": `[{"id":"ok"}]`, // basename matches → honored
	} {
		w, _ := zw.Create(name)
		w.Write([]byte(body))
	}
	zw.Close()

	dstDir := t.TempDir()
	n, err := applyConfigZip(dstDir, buf.Bytes())
	if err != nil {
		t.Fatalf("applyConfigZip: %v", err)
	}
	if n != 1 {
		t.Errorf("wrote %d files, want 1 (only the basename-matched sessions.json)", n)
	}
	if got := readFile(t, dstDir, "sessions.json"); got != `[{"id":"ok"}]` {
		t.Errorf("sessions.json = %q", got)
	}
	// The traversal entry must not have escaped the dir.
	if _, err := os.Stat(filepath.Join(filepath.Dir(dstDir), "evil.json")); !os.IsNotExist(err) {
		t.Error("path-traversal entry escaped the target directory")
	}
}

func TestApplyConfigZip_EmptyArchive(t *testing.T) {
	var buf bytes.Buffer
	zip.NewWriter(&buf).Close()
	if _, err := applyConfigZip(t.TempDir(), buf.Bytes()); err == nil {
		t.Error("expected error when no config files are present in the archive")
	}
}

func writeFile(t *testing.T, dir, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func readFile(t *testing.T, dir, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
