package macro

import (
	"errors"
	"testing"
)

func makeMacro(id, name, keys string) Macro {
	return Macro{ID: id, Name: name, Keystrokes: keys, CreatedAt: 1700000000000}
}

func TestStore_RoundTrip(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	// Include a control char (Ctrl-C = \x03) to confirm raw bytes survive
	// the JSON round-trip.
	m := makeMacro("m1", "interrupt+ls", "\x03ls -la\r")
	if err := s.Save(m); err != nil {
		t.Fatalf("Save: %v", err)
	}
	s2, err := Open(dir)
	if err != nil {
		t.Fatalf("re-Open: %v", err)
	}
	got, err := s2.Get("m1")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Name != "interrupt+ls" {
		t.Errorf("name got %q", got.Name)
	}
	if got.Keystrokes != "\x03ls -la\r" {
		t.Errorf("keystrokes round-trip mismatch: %q", got.Keystrokes)
	}
}

func TestSave_IDRequired(t *testing.T) {
	s, _ := Open(t.TempDir())
	if err := s.Save(Macro{ID: "", Name: "x"}); err == nil {
		t.Error("expected error for empty id")
	}
}

func TestSave_NameRequired(t *testing.T) {
	s, _ := Open(t.TempDir())
	if err := s.Save(Macro{ID: "m1", Name: ""}); err == nil {
		t.Error("expected error for empty name")
	}
}

func TestSave_UpsertByID(t *testing.T) {
	s, _ := Open(t.TempDir())
	_ = s.Save(makeMacro("m1", "first", "a"))
	_ = s.Save(makeMacro("m1", "renamed", "bc"))
	got, _ := s.Get("m1")
	if got.Name != "renamed" || got.Keystrokes != "bc" {
		t.Errorf("upsert didn't replace content: %+v", got)
	}
	if len(s.List()) != 1 {
		t.Errorf("upsert created duplicate; list=%v", s.List())
	}
}

func TestSave_SortedByNameOnInsert(t *testing.T) {
	s, _ := Open(t.TempDir())
	_ = s.Save(makeMacro("3", "zeta", ""))
	_ = s.Save(makeMacro("1", "alpha", ""))
	_ = s.Save(makeMacro("2", "Mu", ""))
	got := s.List()
	want := []string{"alpha", "Mu", "zeta"}
	for i, w := range want {
		if i >= len(got) || got[i].Name != w {
			t.Errorf("at %d got %v want %s", i, got, w)
		}
	}
}

func TestDelete_KnownAndUnknown(t *testing.T) {
	s, _ := Open(t.TempDir())
	_ = s.Save(makeMacro("m1", "x", ""))
	if err := s.Delete("m1"); err != nil {
		t.Fatalf("Delete known: %v", err)
	}
	if _, err := s.Get("m1"); !errors.Is(err, ErrNotFound) {
		t.Errorf("expected ErrNotFound after delete, got %v", err)
	}
	if err := s.Delete("nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("expected ErrNotFound for unknown id, got %v", err)
	}
}

func TestList_ReturnsCopy(t *testing.T) {
	s, _ := Open(t.TempDir())
	_ = s.Save(makeMacro("m1", "a", "x"))
	got := s.List()
	got[0].Name = "mutated"
	again := s.List()
	if again[0].Name != "a" {
		t.Errorf("List didn't return a defensive copy; in-store name=%q", again[0].Name)
	}
}

func TestInMemoryStore_NotPersisted(t *testing.T) {
	s := NewInMemory()
	if err := s.Save(makeMacro("m1", "foo", "")); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if len(s.List()) != 1 {
		t.Errorf("in-memory should still hold list, got %v", s.List())
	}
}
