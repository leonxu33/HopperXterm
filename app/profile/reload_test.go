package profile

import "testing"

// Reload discards in-memory state and re-reads disk. A second store on
// the same dir stands in for "another process / an import replaced the
// files underneath us".
func TestStore_Reload(t *testing.T) {
	dir := t.TempDir()
	s1, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := s1.SaveSession(Session{ID: "s1", Type: SessionSSH, Label: "a"}); err != nil {
		t.Fatal(err)
	}

	s2, _ := Open(dir)
	_ = s2.DeleteSession("s1")
	if err := s2.SaveSession(Session{ID: "s2", Type: SessionSSH, Label: "b"}); err != nil {
		t.Fatal(err)
	}

	// s1 still holds the stale session until it reloads.
	if err := s1.Reload(); err != nil {
		t.Fatalf("Reload: %v", err)
	}
	got := s1.Snapshot().Sessions
	if len(got) != 1 || got[0].ID != "s2" {
		t.Errorf("after Reload want [s2], got %+v", got)
	}
}
