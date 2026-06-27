//go:build darwin

package extedit

import "os/exec"

// openInEditor opens the file in a text editor. A configured editor is passed
// to `open -a` (an app name or .app path); otherwise `open -t` uses the
// system's default text editor.
func openInEditor(path, editor string) *exec.Cmd {
	if editor != "" {
		return exec.Command("open", "-a", editor, path)
	}
	return exec.Command("open", "-t", path)
}

// openWith opens the file with its default association. macOS has no clean CLI
// "choose an app" dialog, so this falls back to the default app (the design's
// mac/Linux behavior for "Open with").
func openWith(path string) *exec.Cmd {
	return exec.Command("open", path)
}

// openDefault opens the file with its default associated program.
func openDefault(path string) *exec.Cmd {
	return exec.Command("open", path)
}
