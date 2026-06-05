//go:build !windows

package transport

import (
	"errors"
	"net"
)

// dialAgentFallback is tried when SSH_AUTH_SOCK is unset: on unix-likes the
// env var is the only way to find the agent, so there is no fallback.
func dialAgentFallback() (net.Conn, error) {
	return nil, errors.New("no agent: SSH_AUTH_SOCK unset")
}
