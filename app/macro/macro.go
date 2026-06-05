// Package macro persists recorded keystroke macros. A macro is a raw
// capture of the bytes a user typed into a terminal (control characters
// included), replayed verbatim on demand. One JSON file holds the full
// collection. Records are keyed by ID (names may repeat / be renamed)
// and listed in case-insensitive name order for stable display.
package macro

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"hopperxterm/appdir"
)

const macrosFile = "macros.json"

// ErrNotFound is returned by mutators when the target ID is unknown.
var ErrNotFound = errors.New("macro: not found")

// Macro is a named recording of raw terminal input. Keystrokes holds the
// exact bytes captured during recording (control chars JSON-escape to
// \u00xx and round-trip cleanly), replayed as-is.
type Macro struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Keystrokes string `json:"keystrokes"`
	CreatedAt  int64  `json:"createdAt"` // unix millis
}

// Store keeps the macro collection on disk under a directory. Thread-safe.
type Store struct {
	mu     sync.RWMutex
	dir    string
	macros []Macro
}

// OpenDefault opens the store under the shared app config dir (appdir.Base).
func OpenDefault() (*Store, error) {
	dir, err := appdir.Base()
	if err != nil {
		return nil, fmt.Errorf("macro: config dir: %w", err)
	}
	return Open(dir)
}

// Open opens the store at an explicit directory. Used by tests.
func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("macro: mkdir %s: %w", dir, err)
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
	path := filepath.Join(s.dir, macrosFile)
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("macro: read %s: %w", path, err)
	}
	if len(b) == 0 {
		return nil
	}
	return json.Unmarshal(b, &s.macros)
}

// Reload discards in-memory state and re-reads it from disk. Used after
// a config import replaces the underlying JSON file.
func (s *Store) Reload() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.macros = nil
	return s.load()
}

// List returns macros sorted by name (case-insensitive). Defensive copy.
func (s *Store) List() []Macro {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Macro, len(s.macros))
	copy(out, s.macros)
	return out
}

// Save upserts a macro by ID. Existing entries keep their slot but get
// fresh content; new entries are inserted in case-insensitive name order.
func (s *Store) Save(m Macro) error {
	if m.ID == "" {
		return errors.New("macro: id required")
	}
	if m.Name == "" {
		return errors.New("macro: name required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.macros {
		if s.macros[i].ID == m.ID {
			s.macros[i] = m
			return s.persist()
		}
	}
	insertAt := len(s.macros)
	for i, existing := range s.macros {
		if lessFoldName(m.Name, existing.Name) {
			insertAt = i
			break
		}
	}
	s.macros = append(s.macros, Macro{})
	copy(s.macros[insertAt+1:], s.macros[insertAt:])
	s.macros[insertAt] = m
	return s.persist()
}

// Delete removes a macro by ID. ErrNotFound if absent.
func (s *Store) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.macros {
		if s.macros[i].ID == id {
			s.macros = append(s.macros[:i], s.macros[i+1:]...)
			return s.persist()
		}
	}
	return ErrNotFound
}

// Get returns a macro by ID, or ErrNotFound.
func (s *Store) Get(id string) (Macro, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for i := range s.macros {
		if s.macros[i].ID == id {
			return s.macros[i], nil
		}
	}
	return Macro{}, ErrNotFound
}

func (s *Store) persist() error {
	if s.dir == "" {
		return nil
	}
	path := filepath.Join(s.dir, macrosFile)
	b, err := json.MarshalIndent(s.macros, "", "  ")
	if err != nil {
		return fmt.Errorf("macro: marshal: %w", err)
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return fmt.Errorf("macro: write %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("macro: rename %s: %w", path, err)
	}
	return nil
}

// lessFoldName compares two names, lowercasing ASCII letters inline.
func lessFoldName(a, b string) bool {
	n := len(a)
	if len(b) < n {
		n = len(b)
	}
	for i := 0; i < n; i++ {
		ai := lowerASCII(a[i])
		bi := lowerASCII(b[i])
		if ai != bi {
			return ai < bi
		}
	}
	return len(a) < len(b)
}

func lowerASCII(c byte) byte {
	if c >= 'A' && c <= 'Z' {
		return c + 32
	}
	return c
}
