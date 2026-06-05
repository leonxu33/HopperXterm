package transport

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// expandPath turns paths like "~/foo" or "~\foo" into absolute paths,
// resolves "${VAR}" / "%VAR%" environment references, and normalises
// the separators for the current OS. Returns the input unchanged if
// it's already absolute or if expansion fails.
func expandPath(p string) string {
	p = strings.TrimSpace(p)
	if p == "" {
		return p
	}
	// Tilde expansion — POSIX-style "~/x" or Windows-style "~\x".
	if p == "~" {
		if home, err := os.UserHomeDir(); err == nil {
			return home
		}
		return p
	}
	if strings.HasPrefix(p, "~/") || strings.HasPrefix(p, `~\`) {
		if home, err := os.UserHomeDir(); err == nil {
			p = filepath.Join(home, p[2:])
		}
	}
	// %VAR% expansion on Windows. os.ExpandEnv handles ${VAR} / $VAR
	// shapes; pre-translate the percent shape so a single call covers
	// both styles.
	if runtime.GOOS == "windows" && strings.ContainsRune(p, '%') {
		p = expandPercentVars(p)
	}
	p = os.ExpandEnv(p)
	return p
}

func expandPercentVars(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); {
		if s[i] != '%' {
			b.WriteByte(s[i])
			i++
			continue
		}
		end := strings.IndexByte(s[i+1:], '%')
		if end < 0 {
			b.WriteString(s[i:])
			break
		}
		name := s[i+1 : i+1+end]
		if name == "" {
			// `%%` → literal `%`
			b.WriteByte('%')
			i += 2
			continue
		}
		if v, ok := os.LookupEnv(name); ok {
			b.WriteString(v)
		} else {
			b.WriteString(s[i : i+end+2])
		}
		i += end + 2
	}
	return b.String()
}
