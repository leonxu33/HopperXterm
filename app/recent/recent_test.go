package recent

import "testing"

func sess(id string) Ref      { return Ref{Kind: "session", ID: id} }
func ws(name string) Ref      { return Ref{Kind: "workspace", Name: name} }

func keys(items []Ref) []string {
	out := make([]string, len(items))
	for i, r := range items {
		out[i] = r.key()
	}
	return out
}

func eq(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestPush_NewestFirst(t *testing.T) {
	s, _ := Open(t.TempDir())
	_, _ = s.Push(sess("a"))
	_, _ = s.Push(ws("proj"))
	got, _ := s.Push(sess("b"))
	want := []string{"session:b", "workspace:proj", "session:a"}
	if !eq(keys(got), want) {
		t.Errorf("order got %v want %v", keys(got), want)
	}
}

func TestPush_DedupMovesToFront(t *testing.T) {
	s, _ := Open(t.TempDir())
	_, _ = s.Push(sess("a"))
	_, _ = s.Push(sess("b"))
	got, _ := s.Push(sess("a")) // re-open a → front, no dup
	want := []string{"session:a", "session:b"}
	if !eq(keys(got), want) {
		t.Errorf("dedup got %v want %v", keys(got), want)
	}
}

func TestPush_CapsAtMax(t *testing.T) {
	s, _ := Open(t.TempDir())
	for i := 0; i < maxItems+5; i++ {
		_, _ = s.Push(sess(string(rune('a' + i))))
	}
	if len(s.List()) != maxItems {
		t.Errorf("len got %d want %d", len(s.List()), maxItems)
	}
}

func TestPush_IgnoresInvalid(t *testing.T) {
	s, _ := Open(t.TempDir())
	_, _ = s.Push(sess("a"))
	got, _ := s.Push(Ref{Kind: "session"}) // no ID
	if len(got) != 1 {
		t.Errorf("invalid ref should be ignored, got %v", keys(got))
	}
	got, _ = s.Push(Ref{Kind: "bogus", ID: "x"})
	if len(got) != 1 {
		t.Errorf("unknown kind should be ignored, got %v", keys(got))
	}
}

func TestRoundTrip_Persists(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir)
	_, _ = s.Push(sess("a"))
	_, _ = s.Push(ws("proj"))
	s2, err := Open(dir)
	if err != nil {
		t.Fatalf("re-Open: %v", err)
	}
	want := []string{"workspace:proj", "session:a"}
	if !eq(keys(s2.List()), want) {
		t.Errorf("reload got %v want %v", keys(s2.List()), want)
	}
}

func TestList_ReturnsCopy(t *testing.T) {
	s, _ := Open(t.TempDir())
	_, _ = s.Push(sess("a"))
	got := s.List()
	got[0].ID = "mutated"
	if s.List()[0].ID != "a" {
		t.Errorf("List didn't return a defensive copy; in-store id=%q", s.List()[0].ID)
	}
}

func TestInMemory_NotPersisted(t *testing.T) {
	s := NewInMemory()
	if _, err := s.Push(sess("a")); err != nil {
		t.Fatalf("Push: %v", err)
	}
	if len(s.List()) != 1 {
		t.Errorf("in-memory should still hold list, got %v", keys(s.List()))
	}
}
