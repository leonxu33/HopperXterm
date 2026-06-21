// Local filesystem listing — feeds the "Local" pane of the SFTP / FTP
// dual-pane browser. Returns the same Entry shape the remote
// transports use so the frontend can render both sides with one
// table component.
package transport

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
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

// LocalCopy recursively copies src → dst on the local filesystem (the
// backend for same-machine drag-to-copy in the Local pane). Files preserve
// their permission bits; symlinks are recreated rather than followed. It
// refuses to copy a path onto itself or into its own subtree, which would
// overwrite the source mid-read or recurse forever.
func LocalCopy(src, dst string) error {
	src = expandPath(src)
	dst = expandPath(dst)
	if src == "" || dst == "" {
		return errors.New("transport: empty path")
	}
	absSrc, err := filepath.Abs(src)
	if err != nil {
		return err
	}
	absDst, err := filepath.Abs(dst)
	if err != nil {
		return err
	}
	if localSelfOrDescendant(absSrc, absDst) {
		return fmt.Errorf("transport: cannot copy %q into itself", src)
	}
	return localCopyPath(absSrc, absDst)
}

// localSelfOrDescendant reports whether dst equals src or is nested inside
// it. filepath.Rel handles Windows case-insensitivity on the shared prefix.
func localSelfOrDescendant(src, dst string) bool {
	rel, err := filepath.Rel(src, dst)
	if err != nil {
		return false
	}
	if rel == "." {
		return true
	}
	// A relative path that doesn't climb out of src (no leading "..") means
	// dst sits inside the src tree.
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator))
}

// localCopyPath copies a file, directory tree, or symlink from src to dst.
// Assumes the self/descendant check already passed.
func localCopyPath(src, dst string) error {
	st, err := os.Lstat(src)
	if err != nil {
		return err
	}
	if st.Mode()&os.ModeSymlink != 0 {
		target, err := os.Readlink(src)
		if err != nil {
			return err
		}
		return os.Symlink(target, dst)
	}
	if st.IsDir() {
		if err := os.MkdirAll(dst, st.Mode().Perm()); err != nil {
			return err
		}
		entries, err := os.ReadDir(src)
		if err != nil {
			return err
		}
		for _, e := range entries {
			if err := localCopyPath(filepath.Join(src, e.Name()), filepath.Join(dst, e.Name())); err != nil {
				return err
			}
		}
		return nil
	}
	return localCopyFile(src, dst, st.Mode().Perm())
}

// localCopyFile copies one regular file's contents, creating dst with perm.
func localCopyFile(src, dst string, perm os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, perm)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
