//go:build !windows && !darwin

package main

import "fmt"

// quitAfterInstall: no packaged installer on plain unix-likes, so nothing to
// apply — the app keeps running.
const quitAfterInstall = false

// launchUpdateInstaller: Linux/other unix-likes have no packaged installer in
// the release, so there's nothing to auto-apply. The version check still works;
// the frontend routes these users to the manual "View release" download.
func launchUpdateInstaller(installerPath string) error {
	return fmt.Errorf("automatic update isn't supported on this platform — download the new version manually")
}
