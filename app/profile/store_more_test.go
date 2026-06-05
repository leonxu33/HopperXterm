package profile

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestOpenDefault_Succeeds(t *testing.T) {
	// Redirect the config dir at a temp tree so we don't touch the real one.
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())   // linux
	t.Setenv("AppData", t.TempDir())           // windows
	t.Setenv("HOME", t.TempDir())              // darwin fallback
	s, err := OpenDefault()
	if err != nil {
		t.Fatalf("OpenDefault: %v", err)
	}
	if s == nil {
		t.Fatal("OpenDefault returned nil store")
	}
}

func TestSaveSession_EmptyIDErrors(t *testing.T) {
	s := NewInMemory()
	if err := s.SaveSession(Session{}); err == nil {
		t.Error("SaveSession with empty ID should error")
	}
}

func TestSaveGroup_EmptyIDErrors(t *testing.T) {
	s := NewInMemory()
	if err := s.SaveGroup(Group{}); err == nil {
		t.Error("SaveGroup with empty ID should error")
	}
}

func TestSaveGroup_UpdatesExisting(t *testing.T) {
	s := NewInMemory()
	_ = s.SaveGroup(Group{ID: "g1", Name: "Old"})
	_ = s.SaveGroup(Group{ID: "g1", Name: "New", Color: "#fff"})
	snap := s.Snapshot()
	if len(snap.Groups) != 1 || snap.Groups[0].Name != "New" || snap.Groups[0].Color != "#fff" {
		t.Errorf("group not updated in place: %+v", snap.Groups)
	}
}

func TestSaveSession_NewIntoGroupAppendsAfterBucket(t *testing.T) {
	s := NewInMemory()
	_ = s.SaveSession(Session{ID: "a", GroupID: "g1"})
	_ = s.SaveSession(Session{ID: "b", GroupID: ""}) // root
	_ = s.SaveSession(Session{ID: "c", GroupID: "g1"})
	// c should land right after a (the bottom of g1), before b stays.
	var order []string
	for _, sess := range s.Snapshot().Sessions {
		order = append(order, sess.ID)
	}
	// Expected: a, c, b
	want := []string{"a", "c", "b"}
	for i := range want {
		if order[i] != want[i] {
			t.Errorf("order = %v, want %v", order, want)
			break
		}
	}
}

func TestDeleteSession_NotFound(t *testing.T) {
	s := NewInMemory()
	if err := s.DeleteSession("ghost"); !errors.Is(err, ErrNotFound) {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
}

func TestMoveSession_NotFound(t *testing.T) {
	s := NewInMemory()
	if err := s.MoveSession("ghost", "", ""); !errors.Is(err, ErrNotFound) {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
}

func TestMoveSession_ToEndOfBucket(t *testing.T) {
	s := NewInMemory()
	_ = s.SaveSession(Session{ID: "s1", GroupID: "g1"})
	_ = s.SaveSession(Session{ID: "s2", GroupID: "g1"})
	_ = s.SaveSession(Session{ID: "s3", GroupID: "g1"})
	// Move s1 to the end of g1 (beforeSessionID="").
	if err := s.MoveSession("s1", "g1", ""); err != nil {
		t.Fatalf("MoveSession: %v", err)
	}
	var order []string
	for _, sess := range s.Snapshot().Sessions {
		order = append(order, sess.ID)
	}
	if order[len(order)-1] != "s1" {
		t.Errorf("s1 should be last, got %v", order)
	}
}

func TestReorderGroup_NotFound(t *testing.T) {
	s := NewInMemory()
	if err := s.ReorderGroup("ghost", ""); !errors.Is(err, ErrNotFound) {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
}

func TestReorderGroup_ToEnd(t *testing.T) {
	s := NewInMemory()
	_ = s.SaveGroup(Group{ID: "g1"})
	_ = s.SaveGroup(Group{ID: "g2"})
	_ = s.SaveGroup(Group{ID: "g3"})
	if err := s.ReorderGroup("g1", ""); err != nil {
		t.Fatalf("ReorderGroup: %v", err)
	}
	var ids []string
	for _, g := range s.Snapshot().Groups {
		ids = append(ids, g.ID)
	}
	if ids[len(ids)-1] != "g1" {
		t.Errorf("g1 should be last, got %v", ids)
	}
}

func TestOpen_CorruptJSONErrors(t *testing.T) {
	dir := t.TempDir()
	// Write malformed groups.json so load()'s parse step fails.
	if err := os.WriteFile(filepath.Join(dir, "groups.json"), []byte("{ not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(dir); err == nil {
		t.Error("Open with corrupt groups.json should error")
	}
}

func TestReadJSON_EdgeCases(t *testing.T) {
	dir := t.TempDir()

	// Empty path → nil (in-memory).
	var dst []Group
	if err := readJSON("", &dst); err != nil {
		t.Errorf("empty path: %v", err)
	}
	// Missing file → nil, empty dst.
	if err := readJSON(filepath.Join(dir, "missing.json"), &dst); err != nil {
		t.Errorf("missing file: %v", err)
	}
	// Empty file → nil.
	empty := filepath.Join(dir, "empty.json")
	_ = os.WriteFile(empty, nil, 0o644)
	if err := readJSON(empty, &dst); err != nil {
		t.Errorf("empty file: %v", err)
	}
	// Valid file → parsed.
	valid := filepath.Join(dir, "valid.json")
	_ = os.WriteFile(valid, []byte(`[{"id":"g1","name":"X"}]`), 0o644)
	if err := readJSON(valid, &dst); err != nil || len(dst) != 1 || dst[0].ID != "g1" {
		t.Errorf("valid file parse: dst=%+v err=%v", dst, err)
	}
}

func TestWriteJSON_InMemoryNoOp(t *testing.T) {
	// A bare filename (Dir == ".") is treated as the in-memory no-op path.
	if err := writeJSON("groups.json", []Group{{ID: "g"}}); err != nil {
		t.Errorf("in-memory writeJSON should be a no-op, got %v", err)
	}
	if _, err := os.Stat("groups.json"); err == nil {
		t.Error("in-memory writeJSON must not create a file")
		_ = os.Remove("groups.json")
	}
}
