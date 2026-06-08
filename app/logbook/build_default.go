//go:build !dev

package logbook

// devBuild is false in release builds: the log is file-only and the default
// level is Info.
const devBuild = false
