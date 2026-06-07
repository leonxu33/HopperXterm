// Package recent persists the "recently opened" MRU surfaced by the
// new-tab "+" menu. An entry is a lightweight reference to either a
// session (by ID) or a workspace (by name) — never the target itself,
// so the menu resolves refs against the live profile/workspace lists at
// render time and silently drops anything that no longer exists. One
// JSON file holds the full list in most-recently-used order (newest
// first), capped so deletions/renames can fall through to still-valid
// older entries.
package recent

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"hopperxterm/appdir"
)

const (
	recentsFile = "recents.json"
	// maxItems holds well above the four the menu shows so a few stale
	// refs don't starve the list of valid fallbacks.
	maxItems = 12
)

// Ref points at a recently opened target. Kind is "session", "workspace",
// or "quick"; exactly one of ID / Name / Cmd is set accordingly. Mirrors
// the frontend RecentRef union.
//
// A "quick" ref is a quick-connect command line (e.g. "!ssh u@host -p 2222")
// for a temporary session. Unlike sessions/workspaces it stores the target
// inline (the command itself) rather than referencing a persisted record,
// because temporary sessions are never saved — re-running just re-parses the
// command and opens a fresh temporary session.
type Ref struct {
	Kind string `json:"kind"`
	ID   string `json:"id,omitempty"`
	Name string `json:"name,omitempty"`
	Cmd  string `json:"cmd,omitempty"`
}

// key uniquely identifies a ref for dedup, matching the frontend's
// recentKey() so the two sides agree on identity.
func (r Ref) key() string {
	switch r.Kind {
	case "workspace":
		return "workspace:" + r.Name
	case "quick":
		return "quick:" + r.Cmd
	default:
		return "session:" + r.ID
	}
}

func (r Ref) valid() bool {
	switch r.Kind {
	case "session":
		return r.ID != ""
	case "workspace":
		return r.Name != ""
	case "quick":
		return r.Cmd != ""
	default:
		return false
	}
}

// Store keeps the MRU on disk under a directory. Thread-safe.
type Store struct {
	mu    sync.RWMutex
	dir   string
	items []Ref
}

// OpenDefault opens the store under the shared app config dir (appdir.Base).
func OpenDefault() (*Store, error) {
	dir, err := appdir.Base()
	if err != nil {
		return nil, fmt.Errorf("recent: config dir: %w", err)
	}
	return Open(dir)
}

// Open opens the store at an explicit directory. Used by tests.
func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("recent: mkdir %s: %w", dir, err)
	}
	s := &Store{dir: dir}
	if err := s.load(); err != nil {
		return nil, err
	}
	return s, nil
}

// NewInMemory returns a non-persistent store.
func NewInMemory() *Store {
	return &Store{dir: ""}
}

func (s *Store) load() error {
	if s.dir == "" {
		return nil
	}
	path := filepath.Join(s.dir, recentsFile)
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("recent: read %s: %w", path, err)
	}
	if len(b) == 0 {
		return nil
	}
	var items []Ref
	if err := json.Unmarshal(b, &items); err != nil {
		return fmt.Errorf("recent: unmarshal %s: %w", path, err)
	}
	// Drop anything malformed that may have been hand-edited / partially
	// written; keep order and the cap.
	for _, r := range items {
		if r.valid() {
			s.items = append(s.items, r)
		}
	}
	if len(s.items) > maxItems {
		s.items = s.items[:maxItems]
	}
	return nil
}

// Reload discards in-memory state and re-reads it from disk. Used after
// a config import replaces the underlying JSON file.
func (s *Store) Reload() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.items = nil
	return s.load()
}

// List returns the MRU newest-first. Defensive copy.
func (s *Store) List() []Ref {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Ref, len(s.items))
	copy(out, s.items)
	return out
}

// Push moves ref to the front (newest), removing any earlier occurrence
// of the same target, and trims to the cap. Returns the updated list.
// Invalid refs are ignored and the current list returned unchanged.
func (s *Store) Push(ref Ref) ([]Ref, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !ref.valid() {
		out := make([]Ref, len(s.items))
		copy(out, s.items)
		return out, nil
	}
	k := ref.key()
	next := make([]Ref, 0, len(s.items)+1)
	next = append(next, ref)
	for _, r := range s.items {
		if r.key() == k {
			continue
		}
		next = append(next, r)
	}
	if len(next) > maxItems {
		next = next[:maxItems]
	}
	s.items = next
	if err := s.persist(); err != nil {
		return nil, err
	}
	out := make([]Ref, len(s.items))
	copy(out, s.items)
	return out, nil
}

func (s *Store) persist() error {
	if s.dir == "" {
		return nil
	}
	path := filepath.Join(s.dir, recentsFile)
	b, err := json.MarshalIndent(s.items, "", "  ")
	if err != nil {
		return fmt.Errorf("recent: marshal: %w", err)
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return fmt.Errorf("recent: write %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("recent: rename %s: %w", path, err)
	}
	return nil
}
