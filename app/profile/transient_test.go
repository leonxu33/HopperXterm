package profile

import (
	"os"
	"path/filepath"
	"testing"
)

// Transient sessions resolve via Lookup but never appear in Snapshot and are
// never written to disk.
func TestStore_TransientSession_InvisibleButResolvable(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	tmp := Session{ID: "tmp-1", Type: SessionSSH, Label: "user@host", Host: "host", User: "user", Port: 52222}
	if err := s.SaveTransientSession(tmp); err != nil {
		t.Fatalf("SaveTransientSession: %v", err)
	}

	// Resolvable by Lookup (this is what OpenPane uses).
	got, ok := s.Lookup("tmp-1")
	if !ok {
		t.Fatal("Lookup(tmp-1): not found")
	}
	if got.Host != "host" || got.Port != 52222 {
		t.Errorf("Lookup returned wrong session: %+v", got)
	}

	// Absent from Snapshot → never shows in the sidebar.
	if len(s.Snapshot().Sessions) != 0 {
		t.Errorf("transient session leaked into Snapshot: %+v", s.Snapshot().Sessions)
	}

	// Never written to disk → gone on reopen.
	if _, err := os.Stat(filepath.Join(dir, sessionsFile)); err == nil {
		// File may exist from other writes, but it must not contain the transient.
		s2, _ := Open(dir)
		if _, ok := s2.Lookup("tmp-1"); ok {
			t.Error("transient session persisted to disk")
		}
	}
}

func TestStore_TransientSession_IDRequired(t *testing.T) {
	s := NewInMemory()
	if err := s.SaveTransientSession(Session{}); err == nil {
		t.Error("SaveTransientSession with empty id should error")
	}
}

// Lookup prefers a persisted session over a transient one with the same id —
// the contract that lets "Save session…" promote in place by re-saving the id.
func TestStore_Lookup_PersistedShadowsTransient(t *testing.T) {
	s := NewInMemory()
	_ = s.SaveTransientSession(Session{ID: "x", Host: "transient-host"})
	_ = s.SaveSession(Session{ID: "x", Host: "saved-host"})

	got, ok := s.Lookup("x")
	if !ok {
		t.Fatal("Lookup(x): not found")
	}
	if got.Host != "saved-host" {
		t.Errorf("expected persisted session to win, got host %q", got.Host)
	}
}

func TestStore_RemoveTransient(t *testing.T) {
	s := NewInMemory()
	_ = s.SaveTransientSession(Session{ID: "tmp-9", Host: "h"})
	s.RemoveTransient("tmp-9")
	if _, ok := s.Lookup("tmp-9"); ok {
		t.Error("RemoveTransient did not drop the session")
	}
	// No-op on unknown id (must not panic).
	s.RemoveTransient("nope")
}
