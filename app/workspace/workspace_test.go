package workspace

import (
	"errors"
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

func TestSave_NameRequired(t *testing.T) {
	s, _ := Open(t.TempDir())
	err := s.Save(Workspace{Name: ""})
	if err == nil {
		t.Error("expected error for empty name")
	}
}

func TestSave_UpsertByName(t *testing.T) {
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
