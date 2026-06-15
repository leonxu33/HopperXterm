//go:build linux

package extedit

import "os/exec"

// linuxEditors is the ordered fallback list of GUI text editors tried when no
// editor is configured. The first one found on PATH wins; if none exist we
// fall back to xdg-open (the file's default association).
var linuxEditors = []string{"gnome-text-editor", "gedit", "kate", "mousepad", "code"}

// openInEditor opens the file in a text editor: the configured command if set,
// else the first available GUI editor, else the default association.
func openInEditor(path, editor string) *exec.Cmd {
	if editor != "" {
		return exec.Command(editor, path)
	}
	for _, e := range linuxEditors {
		if _, err := exec.LookPath(e); err == nil {
			return exec.Command(e, path)
		}
	}
	return exec.Command("xdg-open", path)
}

// openWith opens the file with its default association. Linux has no standard
// "choose an app" chooser, so this uses xdg-open (the design's mac/Linux
// behavior for "Open with").
func openWith(path string) *exec.Cmd {
	return exec.Command("xdg-open", path)
}
