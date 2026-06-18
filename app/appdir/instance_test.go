package appdir

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// loadOrCreateInstanceID writes a random id on first call and returns the same
// value (read from disk) afterwards.
func TestInstanceID_PersistsAndStable(t *testing.T) {
	dir := t.TempDir()
	t.Setenv(EnvOverride, dir)

	id1 := loadOrCreateInstanceID()
	if id1 == "" {
		t.Fatal("instance id is empty")
	}
	b, err := os.ReadFile(filepath.Join(dir, "instance-id"))
	if err != nil {
		t.Fatalf("instance-id not persisted: %v", err)
	}
	if got := strings.TrimSpace(string(b)); got != id1 {
		t.Errorf("persisted %q != returned %q", got, id1)
	}
	// A second load reads the existing value rather than minting a new one.
	if id2 := loadOrCreateInstanceID(); id2 != id1 {
		t.Errorf("instance id not stable: %q then %q", id1, id2)
	}
}

func TestRandomID_Distinct(t *testing.T) {
	if randomID() == randomID() {
		t.Error("randomID returned a duplicate")
	}
}
