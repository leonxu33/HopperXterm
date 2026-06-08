//go:build dev

package logbook

// devBuild is true under the `dev` build tag (`wails dev`): the log also tees
// to stdout for convenience and the default level is Debug.
const devBuild = true
