package credentials

import (
	"errors"
	"testing"

	"github.com/zalando/go-keyring"
)

// Route all keyring calls to the in-memory mock so tests never touch the
// real OS keychain.
func init() { keyring.MockInit() }

func TestSetGetRoundTrip(t *testing.T) {
	const sid = "session-roundtrip"
	if err := SetPassword(sid, "hunter2"); err != nil {
		t.Fatalf("SetPassword: %v", err)
	}
	got, err := GetPassword(sid)
	if err != nil {
		t.Fatalf("GetPassword: %v", err)
	}
	if got != "hunter2" {
		t.Errorf("got %q, want hunter2", got)
	}
}

func TestSetPassword_Overwrites(t *testing.T) {
	const sid = "session-overwrite"
	_ = SetPassword(sid, "first")
	if err := SetPassword(sid, "second"); err != nil {
		t.Fatalf("SetPassword overwrite: %v", err)
	}
	got, _ := GetPassword(sid)
	if got != "second" {
		t.Errorf("overwrite: got %q, want second", got)
	}
}

func TestGetPassword_NotFound(t *testing.T) {
	_, err := GetPassword("session-never-set")
	if !errors.Is(err, ErrNotFound) {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
}

func TestGetPassword_EmptySessionID(t *testing.T) {
	_, err := GetPassword("")
	if !errors.Is(err, ErrNotFound) {
		t.Errorf("empty sessionID should yield ErrNotFound, got %v", err)
	}
}

func TestSetPassword_EmptySessionIDErrors(t *testing.T) {
	if err := SetPassword("", "x"); err == nil {
		t.Error("SetPassword with empty sessionID should error")
	}
}

func TestDeletePassword(t *testing.T) {
	const sid = "session-delete"
	_ = SetPassword(sid, "temp")
	if err := DeletePassword(sid); err != nil {
		t.Fatalf("DeletePassword: %v", err)
	}
	if _, err := GetPassword(sid); !errors.Is(err, ErrNotFound) {
		t.Errorf("after delete expected ErrNotFound, got %v", err)
	}
}

func TestDeletePassword_Idempotent(t *testing.T) {
	// Deleting a non-existent entry is not an error (delete-is-idempotent).
	if err := DeletePassword("session-not-there"); err != nil {
		t.Errorf("deleting a missing entry should be nil, got %v", err)
	}
	// Empty sessionID also returns nil.
	if err := DeletePassword(""); err != nil {
		t.Errorf("deleting empty sessionID should be nil, got %v", err)
	}
}
