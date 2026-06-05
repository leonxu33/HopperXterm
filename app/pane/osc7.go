package pane

import (
	"net/url"
	"strings"
)

// osc7Scanner watches a stream of PTY bytes for OSC 7 sequences and
// extracts the encoded path. OSC 7 looks like:
//
//	ESC ] 7 ; file://host/path ESC \
//
// (the ST terminator may also be 0x07 / BEL). Modern shells (bash, zsh,
// fish via vendor PROMPT_COMMAND) emit this on every prompt redraw, so we
// can track the shell's CWD as a side channel without parsing the prompt.
//
// The scanner is stream-safe — chunks can split a sequence anywhere. It
// buffers up to 2 KiB of in-flight escape data; anything longer is
// discarded as garbage.
type osc7Scanner struct {
	// State machine:
	//   0 → looking for ESC
	//   1 → saw ESC, looking for ']'
	//   2 → saw "ESC ]", looking for '7'
	//   3 → saw "ESC ]7", looking for ';'
	//   4 → consuming payload until ESC\ or BEL
	//   5 → saw ESC inside payload, looking for '\\'
	state int
	buf   []byte
}

const osc7MaxPayload = 2048

// Feed pushes bytes through the scanner. For each complete OSC 7 sequence
// it produces the decoded (host, path) pair via the callback. Returns
// nothing — the caller emits the event.
func (s *osc7Scanner) Feed(data []byte, emit func(host, path string)) {
	for _, b := range data {
		switch s.state {
		case 0:
			if b == 0x1B {
				s.state = 1
			}
		case 1:
			if b == ']' {
				s.state = 2
			} else {
				s.state = 0
			}
		case 2:
			if b == '7' {
				s.state = 3
			} else {
				s.state = 0
			}
		case 3:
			if b == ';' {
				s.state = 4
				s.buf = s.buf[:0]
			} else {
				s.state = 0
			}
		case 4:
			if b == 0x07 {
				// BEL terminator.
				s.flush(emit)
				s.state = 0
			} else if b == 0x1B {
				s.state = 5
			} else {
				if len(s.buf) < osc7MaxPayload {
					s.buf = append(s.buf, b)
				} else {
					// Runaway escape — give up.
					s.state = 0
					s.buf = s.buf[:0]
				}
			}
		case 5:
			if b == '\\' {
				s.flush(emit)
				s.state = 0
			} else {
				// Not a real terminator — treat the ESC as part of payload
				// (rare). Reset to be safe.
				s.state = 0
				s.buf = s.buf[:0]
			}
		}
	}
}

func (s *osc7Scanner) flush(emit func(host, path string)) {
	if len(s.buf) == 0 {
		return
	}
	raw := string(s.buf)
	s.buf = s.buf[:0]
	host, path := parseOsc7(raw)
	if path == "" {
		return
	}
	emit(host, path)
}

// parseOsc7 splits the payload of an OSC 7 sequence into (host, path).
// Accepts `file://host/path` (the spec), `file:///path` (no host), or
// bare `/path` (some shells emit this).
func parseOsc7(payload string) (host string, path string) {
	if strings.HasPrefix(payload, "file://") {
		u, err := url.Parse(payload)
		if err != nil {
			return "", ""
		}
		host = u.Host
		path = u.Path
		// PercentDecode (url.Parse already did this for Path on POSIX).
		if path == "" {
			return "", ""
		}
		// Windows paths may come through as /C:/Users/... — strip the
		// leading slash so they match the host's native form. This pane
		// is talking to a remote shell, so we won't actually see Windows
		// paths in practice, but normalising doesn't hurt.
		if len(path) >= 3 && path[0] == '/' && path[2] == ':' {
			path = path[1:]
		}
		return host, path
	}
	if strings.HasPrefix(payload, "/") {
		return "", payload
	}
	return "", ""
}
