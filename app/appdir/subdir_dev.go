//go:build dev

package appdir

// subdir under os.UserConfigDir() for development builds. `wails dev`
// compiles with the `dev` build tag, so the hot-reload app keeps its data
// separate from a release install.
const subdir = "hopperxterm-dev"
