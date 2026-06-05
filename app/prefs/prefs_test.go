package prefs

import "testing"

func TestSetPersistsAcrossOpen(t *testing.T) {
	dir := t.TempDir()

	s1, err := Open(dir)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if got := s1.All(); len(got) != 0 {
		t.Fatalf("fresh store not empty: %v", got)
	}
	if err := s1.Set("lineEditShortcuts", false); err != nil {
		t.Fatalf("set: %v", err)
	}

	s2, err := Open(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	v, ok := s2.All()["lineEditShortcuts"].(bool)
	if !ok || v {
		t.Fatalf("want lineEditShortcuts=false after reopen, got %v (ok=%v)", v, ok)
	}
}

func TestReloadPicksUpSwappedFile(t *testing.T) {
	dir := t.TempDir()

	s1, err := Open(dir)
	if err != nil {
		t.Fatalf("open: %v", err)
	}

	// Simulate a config import: another handle rewrites the file on disk.
	s2, err := Open(dir)
	if err != nil {
		t.Fatalf("open2: %v", err)
	}
	if err := s2.Set("theme", "dark"); err != nil {
		t.Fatalf("set: %v", err)
	}

	if _, ok := s1.All()["theme"]; ok {
		t.Fatal("s1 saw the write before Reload — stores must not share memory")
	}
	if err := s1.Reload(); err != nil {
		t.Fatalf("reload: %v", err)
	}
	if got, _ := s1.All()["theme"].(string); got != "dark" {
		t.Fatalf("after reload want theme=dark, got %q", got)
	}
}

func TestEmptyKeyRejected(t *testing.T) {
	s := NewInMemory()
	if err := s.Set("", true); err == nil {
		t.Fatal("empty key accepted")
	}
}

func TestInMemoryFallback(t *testing.T) {
	s := NewInMemory()
	if err := s.Set("k", 42.0); err != nil {
		t.Fatalf("set: %v", err)
	}
	if got, _ := s.All()["k"].(float64); got != 42.0 {
		t.Fatalf("want 42, got %v", got)
	}
	if err := s.Reload(); err != nil {
		t.Fatalf("reload: %v", err)
	}
}
