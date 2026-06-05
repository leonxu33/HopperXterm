// Package credentials wraps github.com/zalando/go-keyring for OS keychain
// access. Passwords and key passphrases never live in profile JSON.
//
// Keyed by sessionID: each saved session has at most one password entry.
// Two sessions to the same host (different users, different ports) get
// independent entries.
package credentials

import (
	"errors"

	"github.com/zalando/go-keyring"
)

const service = "hopperxterm"

// ErrNotFound is returned by GetPassword when no entry exists for the
// given sessionID. Callers should treat it as "no saved password — go
// prompt the user", not as a real failure.
var ErrNotFound = errors.New("credentials: no saved password")

// GetPassword reads the saved password for a session, or returns
// ErrNotFound if none is stored. Underlying keyring errors (locked
// keychain, etc.) are returned as-is.
func GetPassword(sessionID string) (string, error) {
	if sessionID == "" {
		return "", ErrNotFound
	}
	v, err := keyring.Get(service, sessionID)
	if err != nil {
		if errors.Is(err, keyring.ErrNotFound) {
			return "", ErrNotFound
		}
		return "", err
	}
	return v, nil
}

// SetPassword writes (or replaces) the saved password for a session.
func SetPassword(sessionID, password string) error {
	if sessionID == "" {
		return errors.New("credentials: sessionID required")
	}
	return keyring.Set(service, sessionID, password)
}

// DeletePassword removes the saved password for a session. Missing
// entries return nil — delete is idempotent from the caller's view.
func DeletePassword(sessionID string) error {
	if sessionID == "" {
		return nil
	}
	err := keyring.Delete(service, sessionID)
	if err != nil && errors.Is(err, keyring.ErrNotFound) {
		return nil
	}
	return err
}
