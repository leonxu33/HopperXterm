package macro

import "testing"

func TestStore_Reload(t *testing.T) {
	dir := t.TempDir()
	s1, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := s1.Save(makeMacro("m1", "first", "a")); err != nil {
		t.Fatal(err)
	}

	s2, _ := Open(dir)
	_ = s2.Delete("m1")
	if err := s2.Save(makeMacro("m2", "second", "b")); err != nil {
		t.Fatal(err)
	}

	if err := s1.Reload(); err != nil {
		t.Fatalf("Reload: %v", err)
	}
	got := s1.List()
	if len(got) != 1 || got[0].ID != "m2" {
		t.Errorf("after Reload want [m2], got %+v", got)
	}
}
