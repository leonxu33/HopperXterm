package profile

import (
	"path/filepath"
	"testing"
)

func TestStore_RoundTrip(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	if err := s.SaveGroup(Group{ID: "g1", Name: "Production", Color: "#7df0c4"}); err != nil {
		t.Fatalf("SaveGroup: %v", err)
	}
	if err := s.SaveSession(Session{
		ID: "s1", Type: SessionSSH, Label: "shell", GroupID: "g1",
		Host: "10.0.0.1", User: "user", Port: 22,
	}); err != nil {
		t.Fatalf("SaveSession: %v", err)
	}

	// Reopen and confirm the data round-trips.
	s2, err := Open(dir)
	if err != nil {
		t.Fatalf("re-Open: %v", err)
	}
	snap := s2.Snapshot()
	if len(snap.Groups) != 1 || snap.Groups[0].ID != "g1" || snap.Groups[0].Color != "#7df0c4" {
		t.Errorf("groups not round-tripped: %+v", snap.Groups)
	}
	if len(snap.Sessions) != 1 || snap.Sessions[0].ID != "s1" || snap.Sessions[0].Host != "10.0.0.1" {
		t.Errorf("sessions not round-tripped: %+v", snap.Sessions)
	}
}

func TestStore_MoveSession_AcrossGroups(t *testing.T) {
	s, _ := Open(t.TempDir())
	_ = s.SaveGroup(Group{ID: "g1", Name: "A"})
	_ = s.SaveGroup(Group{ID: "g2", Name: "B"})
	_ = s.SaveSession(Session{ID: "s1", Type: SessionSSH, GroupID: "g1"})
	_ = s.SaveSession(Session{ID: "s2", Type: SessionSSH, GroupID: "g1"})
	_ = s.SaveSession(Session{ID: "s3", Type: SessionSSH, GroupID: "g2"})

	if err := s.MoveSession("s1", "g2", "s3"); err != nil {
		t.Fatalf("MoveSession: %v", err)
	}

	snap := s.Snapshot()
	// s1 should now be in g2, positioned before s3.
	for _, sess := range snap.Sessions {
		if sess.ID == "s1" && sess.GroupID != "g2" {
			t.Errorf("s1 GroupID = %q, want g2", sess.GroupID)
		}
	}
	// Order in g2 should be: s1, s3.
	var g2Order []string
	for _, sess := range snap.Sessions {
		if sess.GroupID == "g2" {
			g2Order = append(g2Order, sess.ID)
		}
	}
	if len(g2Order) != 2 || g2Order[0] != "s1" || g2Order[1] != "s3" {
		t.Errorf("g2 order = %v, want [s1 s3]", g2Order)
	}
}

func TestStore_DeleteGroup_ReparentsToRoot(t *testing.T) {
	s, _ := Open(t.TempDir())
	_ = s.SaveGroup(Group{ID: "g1", Name: "A"})
	_ = s.SaveSession(Session{ID: "s1", Type: SessionSSH, GroupID: "g1"})
	_ = s.SaveSession(Session{ID: "s2", Type: SessionSSH, GroupID: "g1"})

	if err := s.DeleteGroup("g1", false); err != nil {
		t.Fatalf("DeleteGroup: %v", err)
	}
	snap := s.Snapshot()
	if len(snap.Groups) != 0 {
		t.Errorf("groups = %v, want []", snap.Groups)
	}
	for _, sess := range snap.Sessions {
		if sess.GroupID != "" {
			t.Errorf("session %s still has GroupID %q, want root", sess.ID, sess.GroupID)
		}
	}
}

func TestStore_DeleteGroup_CascadeDeletesSessions(t *testing.T) {
	s, _ := Open(t.TempDir())
	_ = s.SaveGroup(Group{ID: "g1"})
	_ = s.SaveSession(Session{ID: "s1", GroupID: "g1"})
	_ = s.SaveSession(Session{ID: "s2", GroupID: ""}) // root

	if err := s.DeleteGroup("g1", true); err != nil {
		t.Fatalf("DeleteGroup: %v", err)
	}
	snap := s.Snapshot()
	if len(snap.Sessions) != 1 || snap.Sessions[0].ID != "s2" {
		t.Errorf("sessions = %+v, want only s2", snap.Sessions)
	}
}

func TestStore_FirstRun_MissingFiles(t *testing.T) {
	// Point at a directory that doesn't yet exist — Open should mkdir and
	// treat missing JSON files as an empty store.
	dir := filepath.Join(t.TempDir(), "fresh", "subdir")
	s, err := Open(dir)
	if err != nil {
		t.Fatalf("Open on missing dir: %v", err)
	}
	snap := s.Snapshot()
	if len(snap.Groups) != 0 || len(snap.Sessions) != 0 {
		t.Errorf("expected empty store, got %+v", snap)
	}
}

func TestStore_InMemory_NoPersistence(t *testing.T) {
	s := NewInMemory()
	if err := s.SaveGroup(Group{ID: "g1", Name: "A"}); err != nil {
		t.Fatalf("SaveGroup on in-memory: %v", err)
	}
	if len(s.Snapshot().Groups) != 1 {
		t.Errorf("in-memory store didn't keep the group")
	}
}

func TestStore_ReorderGroup(t *testing.T) {
	s, _ := Open(t.TempDir())
	_ = s.SaveGroup(Group{ID: "g1"})
	_ = s.SaveGroup(Group{ID: "g2"})
	_ = s.SaveGroup(Group{ID: "g3"})

	// Move g3 before g1 → expect order [g3, g1, g2]
	if err := s.ReorderGroup("g3", "g1"); err != nil {
		t.Fatalf("ReorderGroup: %v", err)
	}
	var ids []string
	for _, g := range s.Snapshot().Groups {
		ids = append(ids, g.ID)
	}
	if !equalSlice(ids, []string{"g3", "g1", "g2"}) {
		t.Errorf("group order = %v, want [g3 g1 g2]", ids)
	}
}

func equalSlice(a, b []string) bool {
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
