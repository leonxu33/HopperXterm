//go:build !dev

package main

// devVersionLabel is empty in release builds, so AppVersion reports the real
// info.productVersion from the embedded wails.json.
const devVersionLabel = ""
