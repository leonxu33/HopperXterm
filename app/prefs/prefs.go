// Package prefs persists small UI preferences (toggles, choices) as one flat
// JSON object in prefs.json. The store is deliberately generic — string key →
// arbitrary JSON value — so adding a new preference is a frontend-only change;
// the backend just round-trips the JSON. Defaults live in the frontend: a key
// that has never been set is simply absent here.
package prefs

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"hopperxterm/appdir"
)

const prefsFile = "prefs.json"

// Store keeps the preference map on disk under a directory. Thread-safe.
type Store struct {
	mu   sync.RWMutex
	dir  string // empty = in-memory only (fallback when the config dir is unusable)
	data map[string]any
}

// OpenDefault opens the store under the shared app config dir (appdir.Base).
func OpenDefault() (*Store, error) {
	dir, err := appdir.Base()
	if err != nil {
		return nil, fmt.Errorf("prefs: config dir: %w", err)
	}
	return Open(dir)
}

// Open opens the store at an explicit directory. Used by tests.
func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("prefs: mkdir %s: %w", dir, err)
	}
	s := &Store{dir: dir}
	if err := s.load(); err != nil {
		return nil, err
	}
	return s, nil
}

// NewInMemory returns a store that never touches disk. Fallback for a
// broken config dir — preferences just won't survive a restart.
func NewInMemory() *Store {
	return &Store{data: map[string]any{}}
}

// All returns a copy of every stored preference.
func (s *Store) All() map[string]any {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make(map[string]any, len(s.data))
	for k, v := range s.data {
		out[k] = v
	}
	return out
}

// Set stores one preference and persists the file.
func (s *Store) Set(key string, value any) error {
	if key == "" {
		return fmt.Errorf("prefs: empty key")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.data == nil {
		s.data = map[string]any{}
	}
	s.data[key] = value
	return s.save()
}

// Reload re-reads prefs.json, replacing the in-memory map. Used after a
// config import swaps the underlying file.
func (s *Store) Reload() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loadLocked()
}

func (s *Store) load() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loadLocked()
}

func (s *Store) loadLocked() error {
	s.data = map[string]any{}
	if s.dir == "" {
		return nil
	}
	b, err := os.ReadFile(filepath.Join(s.dir, prefsFile))
	if err != nil {
		if os.IsNotExist(err) {
			return nil // first run — empty map, frontend defaults apply
		}
		return fmt.Errorf("prefs: read: %w", err)
	}
	if err := json.Unmarshal(b, &s.data); err != nil {
		return fmt.Errorf("prefs: parse %s: %w", prefsFile, err)
	}
	return nil
}

// save writes the map. Callers hold s.mu.
func (s *Store) save() error {
	if s.dir == "" {
		return nil // in-memory fallback
	}
	b, err := json.MarshalIndent(s.data, "", "  ")
	if err != nil {
		return fmt.Errorf("prefs: marshal: %w", err)
	}
	tmp := filepath.Join(s.dir, prefsFile+".tmp")
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return fmt.Errorf("prefs: write: %w", err)
	}
	if err := os.Rename(tmp, filepath.Join(s.dir, prefsFile)); err != nil {
		return fmt.Errorf("prefs: rename: %w", err)
	}
	return nil
}
