package profile

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
	groupsFile   = "groups.json"
	sessionsFile = "sessions.json"
)

// ErrNotFound is returned by mutators when the target id is unknown.
var ErrNotFound = errors.New("profile: not found")

// Store holds the user's groups + sessions, persisted to JSON files under a
// directory (defaults to appdir.Base()). All public methods
// are safe for concurrent use.
type Store struct {
	mu       sync.RWMutex
	dir      string
	groups   []Group
	sessions []Session

	// transient holds in-memory-only sessions (quick-connect / temporary
	// sessions). They are never written to disk and never appear in
	// Snapshot (so they stay out of the sidebar), but Lookup resolves them
	// so OpenPane / ReconnectPane can dial them like any saved session.
	// Discarded on process exit, which is exactly the "gone when the app
	// closes" contract.
	transient map[string]Session
}

// OpenDefault opens the store under the shared app config dir (see
// appdir.Base), creating it if necessary. Missing files are treated as an
// empty store.
func OpenDefault() (*Store, error) {
	dir, err := appdir.Base()
	if err != nil {
		return nil, fmt.Errorf("profile: config dir: %w", err)
	}
	return Open(dir)
}

// Open opens the store at an explicit directory. Used by tests to point at a
// temp dir. The directory is created if it doesn't exist.
func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("profile: mkdir %s: %w", dir, err)
	}
	s := &Store{dir: dir}
	if err := s.load(); err != nil {
		return nil, err
	}
	return s, nil
}

// NewInMemory returns a store with no on-disk persistence. Useful as a fallback
// when OpenDefault fails (e.g., locked-down profile dir on a CI box).
func NewInMemory() *Store {
	return &Store{dir: ""}
}

func (s *Store) load() error {
	if err := readJSON(filepath.Join(s.dir, groupsFile), &s.groups); err != nil {
		return err
	}
	if err := readJSON(filepath.Join(s.dir, sessionsFile), &s.sessions); err != nil {
		return err
	}
	return nil
}

// Reload discards the in-memory state and re-reads it from disk. Used
// after a config import replaces the underlying JSON files so the live
// store reflects the imported data without restarting the app.
func (s *Store) Reload() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.groups = nil
	s.sessions = nil
	return s.load()
}

// Snapshot returns a copy of the current state. Safe to hand to Wails — the
// frontend mutates its own copy.
func (s *Store) Snapshot() Snapshot {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := Snapshot{
		Groups:   make([]Group, len(s.groups)),
		Sessions: make([]Session, len(s.sessions)),
	}
	copy(out.Groups, s.groups)
	copy(out.Sessions, s.sessions)
	return out
}

// SaveSession upserts a session by ID. New sessions are appended (root if
// GroupID is empty, otherwise just after the last session in that group).
func (s *Store) SaveSession(sess Session) error {
	if sess.ID == "" {
		return errors.New("profile: session id required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.sessions {
		if s.sessions[i].ID == sess.ID {
			s.sessions[i] = sess
			return s.persistSessions()
		}
	}
	// New session — insert just after the last session in the same bucket so
	// it appears at the bottom of its group / root list.
	insertAt := len(s.sessions)
	for i := len(s.sessions) - 1; i >= 0; i-- {
		if s.sessions[i].GroupID == sess.GroupID {
			insertAt = i + 1
			break
		}
	}
	s.sessions = append(s.sessions, Session{})
	copy(s.sessions[insertAt+1:], s.sessions[insertAt:])
	s.sessions[insertAt] = sess
	return s.persistSessions()
}

// Lookup resolves a session by ID, checking persisted sessions first and
// then the in-memory transient registry. OpenPane / ReconnectPane use this
// so a transient (quick-connect) session dials exactly like a saved one.
func (s *Store) Lookup(id string) (Session, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for i := range s.sessions {
		if s.sessions[i].ID == id {
			return s.sessions[i], true
		}
	}
	if sess, ok := s.transient[id]; ok {
		return sess, true
	}
	return Session{}, false
}

// SaveTransientSession upserts a session into the in-memory transient
// registry. Never touches disk and never enters Snapshot, so the session
// stays out of the sidebar and vanishes on app exit.
func (s *Store) SaveTransientSession(sess Session) error {
	if sess.ID == "" {
		return errors.New("profile: session id required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.transient == nil {
		s.transient = make(map[string]Session)
	}
	s.transient[sess.ID] = sess
	return nil
}

// RemoveTransient drops a transient session from the registry. Called when a
// temporary tab closes. No-op if the id isn't transient.
func (s *Store) RemoveTransient(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.transient, id)
}

// DeleteSession removes a session by ID. Returns ErrNotFound if no match.
func (s *Store) DeleteSession(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.sessions {
		if s.sessions[i].ID == id {
			s.sessions = append(s.sessions[:i], s.sessions[i+1:]...)
			return s.persistSessions()
		}
	}
	return ErrNotFound
}

// SaveGroup upserts a group by ID. New groups are appended.
func (s *Store) SaveGroup(g Group) error {
	if g.ID == "" {
		return errors.New("profile: group id required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.groups {
		if s.groups[i].ID == g.ID {
			s.groups[i] = g
			return s.persistGroups()
		}
	}
	s.groups = append(s.groups, g)
	return s.persistGroups()
}

// DeleteGroup removes a group. If deleteSessionsInside is true, every session
// with matching GroupID is removed too; otherwise those sessions are
// re-parented to root (GroupID = "").
func (s *Store) DeleteGroup(id string, deleteSessionsInside bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	idx := -1
	for i := range s.groups {
		if s.groups[i].ID == id {
			idx = i
			break
		}
	}
	if idx < 0 {
		return ErrNotFound
	}
	s.groups = append(s.groups[:idx], s.groups[idx+1:]...)

	if deleteSessionsInside {
		filtered := s.sessions[:0]
		for _, sess := range s.sessions {
			if sess.GroupID != id {
				filtered = append(filtered, sess)
			}
		}
		s.sessions = filtered
	} else {
		for i := range s.sessions {
			if s.sessions[i].GroupID == id {
				s.sessions[i].GroupID = ""
			}
		}
	}

	if err := s.persistGroups(); err != nil {
		return err
	}
	return s.persistSessions()
}

// MoveSession re-parents a session to targetGroupID ("" = root) and reorders
// it to appear immediately before beforeSessionID. Pass beforeSessionID = ""
// to move to the end of the target bucket.
func (s *Store) MoveSession(id, targetGroupID, beforeSessionID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Extract the moved session.
	srcIdx := -1
	for i := range s.sessions {
		if s.sessions[i].ID == id {
			srcIdx = i
			break
		}
	}
	if srcIdx < 0 {
		return ErrNotFound
	}
	moved := s.sessions[srcIdx]
	moved.GroupID = targetGroupID
	s.sessions = append(s.sessions[:srcIdx], s.sessions[srcIdx+1:]...)

	// Find insertion point.
	insertAt := len(s.sessions)
	if beforeSessionID != "" {
		for i := range s.sessions {
			if s.sessions[i].ID == beforeSessionID {
				insertAt = i
				break
			}
		}
	} else {
		// End of the target bucket = just after the last session with the
		// same GroupID, or end of slice if none.
		insertAt = len(s.sessions)
		for i := len(s.sessions) - 1; i >= 0; i-- {
			if s.sessions[i].GroupID == targetGroupID {
				insertAt = i + 1
				break
			}
		}
	}

	s.sessions = append(s.sessions, Session{})
	copy(s.sessions[insertAt+1:], s.sessions[insertAt:])
	s.sessions[insertAt] = moved
	return s.persistSessions()
}

// ReorderGroup moves a group so it appears immediately before beforeGroupID.
// Pass beforeGroupID = "" to move to the end.
func (s *Store) ReorderGroup(id, beforeGroupID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	srcIdx := -1
	for i := range s.groups {
		if s.groups[i].ID == id {
			srcIdx = i
			break
		}
	}
	if srcIdx < 0 {
		return ErrNotFound
	}
	moved := s.groups[srcIdx]
	s.groups = append(s.groups[:srcIdx], s.groups[srcIdx+1:]...)

	insertAt := len(s.groups)
	if beforeGroupID != "" {
		for i := range s.groups {
			if s.groups[i].ID == beforeGroupID {
				insertAt = i
				break
			}
		}
	}
	s.groups = append(s.groups, Group{})
	copy(s.groups[insertAt+1:], s.groups[insertAt:])
	s.groups[insertAt] = moved
	return s.persistGroups()
}

func (s *Store) persistGroups() error {
	return writeJSON(filepath.Join(s.dir, groupsFile), s.groups)
}

func (s *Store) persistSessions() error {
	return writeJSON(filepath.Join(s.dir, sessionsFile), s.sessions)
}

func readJSON(path string, dst any) error {
	if path == "" {
		return nil
	}
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("profile: read %s: %w", path, err)
	}
	if len(b) == 0 {
		return nil
	}
	if err := json.Unmarshal(b, dst); err != nil {
		return fmt.Errorf("profile: parse %s: %w", path, err)
	}
	return nil
}

// writeJSON atomically replaces path with the JSON encoding of v. A
// no-op for the in-memory store (dir == "").
func writeJSON(path string, v any) error {
	if filepath.Dir(path) == "." || path == "" {
		// In-memory store has no on-disk path.
		return nil
	}
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return fmt.Errorf("profile: marshal %s: %w", path, err)
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return fmt.Errorf("profile: write %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("profile: rename %s: %w", path, err)
	}
	return nil
}
