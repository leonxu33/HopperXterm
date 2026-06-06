//go:build dev

package main

// devVersionLabel overrides AppVersion under the `dev` build tag that
// `wails dev` compiles with, so the About dialog reads "dev" instead of a
// release productVersion — a clear signal you're running the hot-reload build.
const devVersionLabel = "dev"
