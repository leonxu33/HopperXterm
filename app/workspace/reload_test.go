package workspace

import "testing"

func TestStore_Reload(t *testing.T) {
	dir := t.TempDir()
	s1, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := s1.Save(Workspace{Name: "w1"}); err != nil {
		t.Fatal(err)
	}

	s2, _ := Open(dir)
	_ = s2.Delete("w1")
	if err := s2.Save(Workspace{Name: "w2"}); err != nil {
		t.Fatal(err)
	}

	if err := s1.Reload(); err != nil {
		t.Fatalf("Reload: %v", err)
	}
	got := s1.List()
	if len(got) != 1 || got[0].Name != "w2" {
		t.Errorf("after Reload want [w2], got %+v", got)
	}
}
