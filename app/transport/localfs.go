// Local filesystem listing — feeds the "Local" pane of the SFTP / FTP
// dual-pane browser. Returns the same Entry shape the remote
// transports use so the frontend can render both sides with one
// table component.
package transport

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// LocalList returns the directory entries at dir, sorted folders-first
// then by name (matching SFTP/FTP/S3 ordering). Empty dir means the
// user's home directory. A leading ".." synthetic entry is included
// for navigation, except at the OS root.
func LocalList(dir string) ([]Entry, error) {
	dir = expandPath(dir)
	if dir == "" {
		h, err := os.UserHomeDir()
		if err != nil {
			return nil, fmt.Errorf("transport: home dir: %w", err)
		}
		dir = h
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return nil, fmt.Errorf("transport: abs %q: %w", dir, err)
	}
	entries, err := os.ReadDir(abs)
	if err != nil {
		return nil, err
	}
	out := make([]Entry, 0, len(entries)+1)
	// Synthetic parent unless we're already at the OS root.
	if parent := filepath.Dir(abs); parent != abs {
		out = append(out, Entry{Name: "..", IsDir: true})
	}
	for _, e := range entries {
		name := e.Name()
		info, err := e.Info()
		if err != nil {
			continue
		}
		isLink := info.Mode()&os.ModeSymlink != 0
		isDir := e.IsDir()
		// Resolve symlinks to detect dir-ness for navigation.
		target := ""
		if isLink {
			full := filepath.Join(abs, name)
			if t, err := os.Readlink(full); err == nil {
				target = t
			}
			if st, err := os.Stat(full); err == nil {
				isDir = st.IsDir()
			}
		}
		out = append(out, Entry{
			Name:      name,
			IsDir:     isDir,
			IsSymlink: isLink,
			Size:      info.Size(),
			Mode:      uint32(info.Mode().Perm()),
			ModTimeMs: info.ModTime().UnixMilli(),
			Target:    target,
		})
	}
	// Folders first, then files, alphabetical within each (`..` always first).
	sortEntries(out)
	return out, nil
}

// LocalCwd returns the user's home directory — the natural starting
// point for the Local pane on first open.
func LocalCwd() (string, error) {
	return os.UserHomeDir()
}

// LocalIsDir reports whether p is a directory. The uploader uses it to
// route a dropped/selected folder to a recursive UploadDir instead of
// writing the directory out as a single (garbage) file. Symlinks are
// followed (os.Stat) so a link to a directory counts as a directory.
func LocalIsDir(p string) (bool, error) {
	p = expandPath(p)
	if p == "" {
		return false, errors.New("transport: empty path")
	}
	st, err := os.Stat(p)
	if err != nil {
		return false, err
	}
	return st.IsDir(), nil
}

// LocalMkdir creates a directory at p; parents=true acts like `mkdir -p`.
func LocalMkdir(p string, parents bool) error {
	p = expandPath(p)
	if p == "" {
		return errors.New("transport: empty path")
	}
	if parents {
		return os.MkdirAll(p, 0o755)
	}
	return os.Mkdir(p, 0o755)
}

// LocalRemove deletes a file or (if recursive) a directory tree.
func LocalRemove(p string, recursive bool) error {
	p = expandPath(p)
	if p == "" {
		return errors.New("transport: empty path")
	}
	if recursive {
		return os.RemoveAll(p)
	}
	return os.Remove(p)
}

// LocalCreate writes an empty file at p (replacing any existing one).
func LocalCreate(p string) error {
	p = expandPath(p)
	if p == "" {
		return errors.New("transport: empty path")
	}
	f, err := os.Create(p)
	if err != nil {
		return err
	}
	return f.Close()
}

// LocalRename moves src → dst on the local filesystem.
func LocalRename(src, dst string) error {
	src = expandPath(src)
	dst = expandPath(dst)
	if src == "" || dst == "" {
		return errors.New("transport: empty path")
	}
	return os.Rename(src, dst)
}
