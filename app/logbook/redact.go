package logbook

import "regexp"

// redaction is the central safety net that scrubs secrets out of every log
// line before it is written. The primary defence is discipline — callers must
// never hand credential-bearing structs to the logger — but messages flow
// through user-supplied hosts, URLs, and wrapped transport errors, so we strip
// the obvious secret shapes here as a backstop. Every backend and frontend log
// line passes through emit(), so this covers both sides.
//
// The replacement keeps enough of the surrounding text to stay useful for
// debugging (e.g. the username and host of a URL survive; only the password is
// masked).
var redactors = []struct {
	re   *regexp.Regexp
	repl string
}{
	// URLs with inline credentials: the password between the userinfo ':' and
	// the '@' is masked to '***'; the scheme, user, and host are all kept.
	{regexp.MustCompile(`([a-zA-Z][a-zA-Z0-9+.-]*://[^\s:/@]+):[^\s@/]+@`), `$1:***@`},
	// PEM private-key blocks (any key type), possibly spanning lines.
	{regexp.MustCompile(`(?s)-----BEGIN [^-]*PRIVATE KEY-----.*?-----END [^-]*PRIVATE KEY-----`), `[REDACTED PRIVATE KEY]`},
	// AWS access key IDs.
	{regexp.MustCompile(`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`), `[REDACTED AWS KEY]`},
	// Bearer tokens.
	{regexp.MustCompile(`(?i)\bBearer\s+[A-Za-z0-9._~+/-]+=*`), `Bearer [REDACTED]`},
	// Quoted secret values — key="value" / key:'value' / JSON "key":"value".
	// Masks the whole quoted body so values containing spaces don't leak (an
	// unquoted-only pattern would stop at the first space). Must run before the
	// unquoted pattern below.
	{regexp.MustCompile(`(?i)(\b(?:password|passphrase|secret|token|secretaccesskey)\b["']?\s*[:=]\s*["'])[^"']*(["'])`), `${1}[REDACTED]${2}`},
	// Unquoted secret values — key=value / key: value. Stops at the next
	// separator/space so it can't swallow trailing context.
	{regexp.MustCompile(`(?i)(\b(?:password|passphrase|secret|token|secretaccesskey)\b\s*[:=]\s*)[^\s"',;&]+`), `${1}[REDACTED]`},
}

// redact returns s with secret-shaped substrings masked.
func redact(s string) string {
	for _, r := range redactors {
		s = r.re.ReplaceAllString(s, r.repl)
	}
	return s
}
