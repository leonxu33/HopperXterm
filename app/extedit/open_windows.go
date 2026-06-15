//go:build windows

package extedit

import "os/exec"

// openInEditor opens the file in a text editor. With a configured editor we
// run it directly; otherwise notepad (always present) is the safe default.
func openInEditor(path, editor string) *exec.Cmd {
	if editor != "" {
		return exec.Command(editor, path)
	}
	return exec.Command("notepad.exe", path)
}

// openWith shows Windows' native "How do you want to open this file?" chooser
// (the OpenAs_RunDLL shell verb), letting the user pick any installed app.
func openWith(path string) *exec.Cmd {
	return exec.Command("rundll32.exe", "shell32.dll,OpenAs_RunDLL", path)
}
