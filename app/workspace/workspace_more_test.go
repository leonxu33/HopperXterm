package workspace

import (
	"os"
	"path/filepath"
	"testing"
)

func TestOpenDefault_Succeeds(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("AppData", t.TempDir())
	t.Setenv("HOME", t.TempDir())
	s, err := OpenDefault()
	if err != nil {
		t.Fatalf("OpenDefault: %v", err)
	}
	if s == nil {
		t.Fatal("nil store")
	}
}

func TestSave_UpdateKeepsPosition(t *testing.T) {
	s := NewInMemory()
	_ = s.Save(makeWS("Apple"))
	_ = s.Save(makeWS("banana"))
	updated := makeWS("Apple")
	updated.UpdatedAt = 999
	_ = s.Save(updated)
	list := s.List()
	if list[0].Name != "Apple" || list[0].UpdatedAt != 999 {
		t.Errorf("update didn't keep position/content: %+v", list)
	}
}

func TestOpen_CorruptJSONErrors(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, workspacesFile), []byte("{bad"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(dir); err == nil {
		t.Error("Open with corrupt workspaces.json should error")
	}
}

func TestLoad_EmptyFileIsEmptyStore(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, workspacesFile), nil, 0o644)
	s, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if len(s.List()) != 0 {
		t.Errorf("expected empty store from empty file, got %d", len(s.List()))
	}
}
