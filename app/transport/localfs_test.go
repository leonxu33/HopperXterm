package transport

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLocalList_SortsAndIncludesParent(t *testing.T) {
	dir := t.TempDir()
	_ = os.MkdirAll(filepath.Join(dir, "zsub"), 0o755)
	_ = os.MkdirAll(filepath.Join(dir, "asub"), 0o755)
	_ = os.WriteFile(filepath.Join(dir, "m.txt"), []byte("hi"), 0o644)
	_ = os.WriteFile(filepath.Join(dir, "b.txt"), []byte("hello"), 0o644)

	entries, err := LocalList(dir)
	if err != nil {
		t.Fatalf("LocalList: %v", err)
	}
	if len(entries) == 0 || entries[0].Name != ".." {
		t.Fatalf("expected synthetic '..' first, got %+v", entries)
	}
	// After "..", directories precede files, each alphabetical.
	rest := entries[1:]
	want := []string{"asub", "zsub", "b.txt", "m.txt"}
	if len(rest) != len(want) {
		t.Fatalf("entry count = %d, want %d: %+v", len(rest), len(want), rest)
	}
	for i, w := range want {
		if rest[i].Name != w {
			t.Errorf("entry %d = %q, want %q", i, rest[i].Name, w)
		}
	}
	// File sizes round-trip.
	for _, e := range rest {
		if e.Name == "b.txt" && e.Size != 5 {
			t.Errorf("b.txt size = %d, want 5", e.Size)
		}
	}
}

func TestLocalList_EmptyMeansHome(t *testing.T) {
	if _, err := LocalList(""); err != nil {
		t.Fatalf("LocalList(\"\") should default to home: %v", err)
	}
}

func TestLocalList_MissingDirErrors(t *testing.T) {
	if _, err := LocalList(filepath.Join(t.TempDir(), "does-not-exist")); err == nil {
		t.Error("LocalList on a missing dir should error")
	}
}

func TestLocalCwd_ReturnsHome(t *testing.T) {
	cwd, err := LocalCwd()
	if err != nil {
		t.Fatalf("LocalCwd: %v", err)
	}
	if cwd == "" {
		t.Error("LocalCwd returned empty")
	}
}

func TestLocalMkdirRemoveCreateRename(t *testing.T) {
	base := t.TempDir()

	// Mkdir (non-parents) then nested mkdir -p.
	d := filepath.Join(base, "d1")
	if err := LocalMkdir(d, false); err != nil {
		t.Fatalf("LocalMkdir: %v", err)
	}
	nested := filepath.Join(base, "p", "q", "r")
	if err := LocalMkdir(nested, true); err != nil {
		t.Fatalf("LocalMkdir parents: %v", err)
	}
	if fi, err := os.Stat(nested); err != nil || !fi.IsDir() {
		t.Fatalf("nested dir not created: %v", err)
	}

	// Create a file, rename it, then remove it.
	f := filepath.Join(base, "a.txt")
	if err := LocalCreate(f); err != nil {
		t.Fatalf("LocalCreate: %v", err)
	}
	f2 := filepath.Join(base, "b.txt")
	if err := LocalRename(f, f2); err != nil {
		t.Fatalf("LocalRename: %v", err)
	}
	if _, err := os.Stat(f2); err != nil {
		t.Fatalf("renamed file missing: %v", err)
	}
	if err := LocalRemove(f2, false); err != nil {
		t.Fatalf("LocalRemove: %v", err)
	}
	if _, err := os.Stat(f2); err == nil {
		t.Error("file still present after LocalRemove")
	}

	// Recursive remove of a populated tree.
	if err := LocalRemove(filepath.Join(base, "p"), true); err != nil {
		t.Fatalf("LocalRemove recursive: %v", err)
	}
	if _, err := os.Stat(filepath.Join(base, "p")); err == nil {
		t.Error("tree still present after recursive LocalRemove")
	}
}

func TestLocalOps_EmptyPathErrors(t *testing.T) {
	if err := LocalMkdir("", false); err == nil {
		t.Error("LocalMkdir(\"\") should error")
	}
	if err := LocalRemove("", false); err == nil {
		t.Error("LocalRemove(\"\") should error")
	}
	if err := LocalCreate("", ); err == nil {
		t.Error("LocalCreate(\"\") should error")
	}
	if err := LocalRename("", "x"); err == nil {
		t.Error("LocalRename with empty src should error")
	}
	if err := LocalCopy("", "x"); err == nil {
		t.Error("LocalCopy with empty src should error")
	}
}

func TestLocalCopy_FileAndTree(t *testing.T) {
	root := t.TempDir()
	srcDir := filepath.Join(root, "src")
	if err := os.MkdirAll(filepath.Join(srcDir, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(srcDir, "top.txt"), []byte("TOP"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(srcDir, "sub", "deep.txt"), []byte("DEEP"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Single file into a sibling target.
	dstFile := filepath.Join(root, "copy.txt")
	if err := LocalCopy(filepath.Join(srcDir, "top.txt"), dstFile); err != nil {
		t.Fatalf("LocalCopy(file): %v", err)
	}
	if b, _ := os.ReadFile(dstFile); string(b) != "TOP" {
		t.Errorf("copied file = %q, want TOP", b)
	}

	// Whole tree, including the nested file.
	dstTree := filepath.Join(root, "dst")
	if err := LocalCopy(srcDir, dstTree); err != nil {
		t.Fatalf("LocalCopy(tree): %v", err)
	}
	if b, _ := os.ReadFile(filepath.Join(dstTree, "sub", "deep.txt")); string(b) != "DEEP" {
		t.Errorf("nested file = %q, want DEEP", b)
	}
}

func TestLocalCopy_RejectsSelfAndDescendant(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "d")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := LocalCopy(dir, dir); err == nil {
		t.Error("LocalCopy(x, x) should reject copying onto itself")
	}
	if err := LocalCopy(dir, filepath.Join(dir, "d")); err == nil {
		t.Error("LocalCopy(x, x/sub) should reject copying into own subtree")
	}
	// A sibling target with a shared name prefix is fine.
	if err := LocalCopy(dir, filepath.Join(root, "d2")); err != nil {
		t.Errorf("LocalCopy to sibling: unexpected error %v", err)
	}
}

func TestLocalSelfOrDescendant(t *testing.T) {
	root := t.TempDir()
	a := filepath.Join(root, "a")
	cases := []struct {
		src, dst string
		want     bool
	}{
		{a, a, true},
		{a, filepath.Join(a, "x"), true},
		{a, filepath.Join(root, "b"), false},
		{a, root, false},
	}
	for _, c := range cases {
		if got := localSelfOrDescendant(c.src, c.dst); got != c.want {
			t.Errorf("localSelfOrDescendant(%q,%q)=%v want %v", c.src, c.dst, got, c.want)
		}
	}
}
