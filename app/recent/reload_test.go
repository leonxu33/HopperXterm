package recent

import "testing"

func TestStore_Reload(t *testing.T) {
	dir := t.TempDir()
	s1, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s1.Push(sess("a")); err != nil {
		t.Fatal(err)
	}

	// A second store pushes another ref; the file is now [b, a].
	s2, _ := Open(dir)
	if _, err := s2.Push(sess("b")); err != nil {
		t.Fatal(err)
	}

	// Reload must reset before loading — recent's load appends, so a
	// missing reset would yield [a, b, a] instead of [b, a].
	if err := s1.Reload(); err != nil {
		t.Fatalf("Reload: %v", err)
	}
	if got := keys(s1.List()); !eq(got, []string{"session:b", "session:a"}) {
		t.Errorf("after Reload want [b a], got %v", got)
	}
}
