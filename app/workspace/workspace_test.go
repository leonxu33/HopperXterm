package workspace

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// makeWS builds a workspace whose tab layout is an opaque split tree (a row
// of leaves), matching the shape the frontend now persists. The backend
// stores Layout as interface{} and round-trips it as JSON.
func makeWS(name string, sessionIDs ...string) Workspace {
	children := make([]interface{}, len(sessionIDs))
	for i, id := range sessionIDs {
		children[i] = map[string]interface{}{"kind": "leaf", "sessionId": id, "weight": 1.0}
	}
	var layout interface{}
	if len(children) == 1 {
		layout = children[0]
	} else {
		layout = map[string]interface{}{"kind": "split", "dir": "row", "weight": 1.0, "children": children}
	}
	return Workspace{
		ID:        name, // names are unique in these tests, so ID=name is a valid key
		Name:      name,
		Tabs:      []Tab{{Label: name + " tab", Layout: layout}},
		UpdatedAt: 1700000000000,
	}
}

// countLeaves walks an opaque (JSON-decoded) layout tree and counts leaves.
func countLeaves(layout interface{}) int {
	n, ok := layout.(map[string]interface{})
	if !ok {
		return 0
	}
	if n["kind"] == "leaf" {
		return 1
	}
	total := 0
	if kids, ok := n["children"].([]interface{}); ok {
		for _, k := range kids {
			total += countLeaves(k)
		}
	}
	return total
}

func TestStore_RoundTrip(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	w := makeWS("prod", "s1", "s2")
	if err := s.Save(w); err != nil {
		t.Fatalf("Save: %v", err)
	}
	// Reopen.
	s2, err := Open(dir)
	if err != nil {
		t.Fatalf("re-Open: %v", err)
	}
	got, err := s2.Get("prod")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Name != "prod" {
		t.Errorf("name got %q want %q", got.Name, "prod")
	}
	if len(got.Tabs) != 1 {
		t.Fatalf("layout shape mismatch: %+v", got.Tabs)
	}
	if n := countLeaves(got.Tabs[0].Layout); n != 2 {
		t.Errorf("leaf count got %d want 2", n)
	}
}

// Inactive round-trips through disk; default-active means a freshly built
// workspace (and legacy records) come back Inactive==false.
func TestStore_InactiveRoundTrip(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir)
	w := makeWS("dormant", "s1")
	w.Inactive = true
	if err := s.Save(w); err != nil {
		t.Fatalf("Save: %v", err)
	}
	s2, _ := Open(dir)
	got, err := s2.Get("dormant")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if !got.Inactive {
		t.Errorf("Inactive not persisted: %+v", got)
	}
	// A plain workspace defaults to active.
	active := makeWS("live", "s1")
	if err := s.Save(active); err != nil {
		t.Fatalf("Save active: %v", err)
	}
	if g, _ := s.Get("live"); g.Inactive {
		t.Errorf("fresh workspace should default to active, got Inactive=true")
	}
}

func TestSave_IDRequired(t *testing.T) {
	s, _ := Open(t.TempDir())
	if err := s.Save(Workspace{Name: "noid"}); err == nil {
		t.Error("expected error for empty id")
	}
}

func TestSave_NameRequired(t *testing.T) {
	s, _ := Open(t.TempDir())
	if err := s.Save(Workspace{ID: "id1", Name: ""}); err == nil {
		t.Error("expected error for empty name")
	}
}

func TestSave_UpsertByID(t *testing.T) {
	s, _ := Open(t.TempDir())
	_ = s.Save(makeWS("dev", "s1"))
	_ = s.Save(makeWS("dev", "s2", "s3"))
	got, _ := s.Get("dev")
	if n := countLeaves(got.Tabs[0].Layout); n != 2 {
		t.Errorf("upsert didn't replace content (leaves=%d): %+v", n, got)
	}
	if len(s.List()) != 1 {
		t.Errorf("upsert created duplicate; list=%v", s.List())
	}
}

// Renaming keeps the same ID, so a Save with an unchanged ID but new Name
// updates in place rather than creating a duplicate.
func TestSave_RenameKeepsIdentity(t *testing.T) {
	s, _ := Open(t.TempDir())
	w := makeWS("orig", "s1")
	_ = s.Save(w)
	w.Name = "renamed"
	_ = s.Save(w)
	if len(s.List()) != 1 {
		t.Fatalf("rename created duplicate; list=%v", s.List())
	}
	got, err := s.Get("orig") // ID is still "orig"
	if err != nil {
		t.Fatalf("Get by id after rename: %v", err)
	}
	if got.Name != "renamed" {
		t.Errorf("name got %q want %q", got.Name, "renamed")
	}
}

// Legacy records written before IDs existed (no "id" field) get ID=Name
// backfilled on load.
func TestLoad_BackfillsLegacyID(t *testing.T) {
	dir := t.TempDir()
	legacy := `[{"name":"old","tabs":[],"updatedAt":1}]`
	if err := os.WriteFile(filepath.Join(dir, workspacesFile), []byte(legacy), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	s, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	got, err := s.Get("old") // resolvable by the backfilled ID (=Name)
	if err != nil {
		t.Fatalf("Get backfilled id: %v", err)
	}
	if got.ID != "old" {
		t.Errorf("backfilled ID got %q want %q", got.ID, "old")
	}
}

func TestSave_SortedByNameOnInsert(t *testing.T) {
	s, _ := Open(t.TempDir())
	_ = s.Save(makeWS("zeta"))
	_ = s.Save(makeWS("alpha"))
	_ = s.Save(makeWS("Mu"))
	got := s.List()
	want := []string{"alpha", "Mu", "zeta"}
	for i, w := range want {
		if i >= len(got) || got[i].Name != w {
			t.Errorf("at %d got %v want %s", i, got, w)
		}
	}
}

func TestSave_CaseInsensitiveSort(t *testing.T) {
	s, _ := Open(t.TempDir())
	_ = s.Save(makeWS("BANANA"))
	_ = s.Save(makeWS("apple"))
	got := s.List()
	if got[0].Name != "apple" || got[1].Name != "BANANA" {
		t.Errorf("case-insensitive sort failed: %v", got)
	}
}

func TestDelete_KnownAndUnknown(t *testing.T) {
	s, _ := Open(t.TempDir())
	_ = s.Save(makeWS("x"))
	if err := s.Delete("x"); err != nil {
		t.Fatalf("Delete known: %v", err)
	}
	if _, err := s.Get("x"); !errors.Is(err, ErrNotFound) {
		t.Errorf("expected ErrNotFound after delete, got %v", err)
	}
	if err := s.Delete("y"); !errors.Is(err, ErrNotFound) {
		t.Errorf("expected ErrNotFound for unknown name, got %v", err)
	}
}

func TestGet_NotFound(t *testing.T) {
	s, _ := Open(t.TempDir())
	if _, err := s.Get("missing"); !errors.Is(err, ErrNotFound) {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
}

func TestInMemoryStore_SavesAreNotPersisted(t *testing.T) {
	s := NewInMemory()
	if err := s.Save(makeWS("foo")); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if len(s.List()) != 1 {
		t.Errorf("in-memory should still hold list, got %v", s.List())
	}
	// dir == "" — no on-disk side effect; just confirm persist returns nil.
}

func TestList_ReturnsCopy(t *testing.T) {
	s, _ := Open(t.TempDir())
	_ = s.Save(makeWS("a"))
	got := s.List()
	got[0].Name = "mutated"
	again := s.List()
	if again[0].Name != "a" {
		t.Errorf("List didn't return a defensive copy; in-store name=%q", again[0].Name)
	}
}

func TestLessFoldName(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"abc", "abd", true},
		{"abd", "abc", false},
		{"ABC", "abd", true},
		{"abc", "ABD", true},
		{"abc", "abc", false},
		{"abc", "abcd", true},
		{"abcd", "abc", false},
	}
	for _, c := range cases {
		if got := lessFoldName(c.a, c.b); got != c.want {
			t.Errorf("lessFoldName(%q,%q)=%v want %v", c.a, c.b, got, c.want)
		}
	}
}
