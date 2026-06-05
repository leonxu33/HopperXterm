// Package transport implements per-protocol connection setup: ssh, sftp,
// ftp, local shell (conpty on Windows / pty on Unix), wsl, s3, ec2.
// All transports expose a uniform interface so pane.Pane can hold any of them.
package transport

import "sort"

// sortEntries orders a directory listing the way every transport's List
// presents it: a synthetic ".." first (local listings only), then
// directories before files, then alphabetically by name. Stable so equal
// keys keep their server-reported order.
func sortEntries(entries []Entry) {
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].Name == ".." {
			return true
		}
		if entries[j].Name == ".." {
			return false
		}
		if entries[i].IsDir != entries[j].IsDir {
			return entries[i].IsDir
		}
		return entries[i].Name < entries[j].Name
	})
}
