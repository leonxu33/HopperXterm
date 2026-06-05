//go:build windows

package transport

import (
	"net"

	"github.com/Microsoft/go-winio"
)

// dialAgentFallback is tried when SSH_AUTH_SOCK is unset: Windows OpenSSH's
// ssh-agent listens on a well-known named pipe rather than a unix socket.
func dialAgentFallback() (net.Conn, error) {
	return winio.DialPipe(`\\.\pipe\openssh-ssh-agent`, nil)
}
