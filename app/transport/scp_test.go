package transport

import (
	"bufio"
	"strings"
	"testing"
)

func TestShQuote(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"plain", "'plain'"},
		{"with space", "'with space'"},
		{"/abs/path", "'/abs/path'"},
		{"it's", `'it'\''s'`},
		{"", "''"},
		{"a'b'c", `'a'\''b'\''c'`},
	}
	for _, c := range cases {
		if got := ShQuote(c.in); got != c.want {
			t.Errorf("ShQuote(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestParseLSOutput(t *testing.T) {
	// Representative `ls -la` output: total header, ./.., a file, a dir, and
	// a symlink with a target.
	out := strings.Join([]string{
		"total 24",
		"drwxr-xr-x  4 user staff   128 Jan 10 09:30 .",
		"drwxr-xr-x 20 user staff   640 Jan  9 18:00 ..",
		"-rw-r--r--  1 user staff  1024 Jan 10 09:31 notes.txt",
		"drwxr-xr-x  2 user staff    64 Jan 10 09:32 projects",
		"lrwxr-xr-x  1 user staff    11 Jan 10 09:33 link -> notes.txt",
	}, "\n")

	entries := parseLSOutput(out)
	byName := map[string]Entry{}
	for _, e := range entries {
		byName[e.Name] = e
	}

	if _, ok := byName["."]; ok {
		t.Error("`.` should be skipped")
	}
	if _, ok := byName[".."]; ok {
		t.Error("`..` should be skipped")
	}
	if len(entries) != 3 {
		t.Fatalf("expected 3 entries (file, dir, symlink), got %d: %+v", len(entries), entries)
	}

	f, ok := byName["notes.txt"]
	if !ok || f.IsDir || f.IsSymlink || f.Size != 1024 {
		t.Errorf("notes.txt parsed wrong: %+v", f)
	}
	d, ok := byName["projects"]
	if !ok || !d.IsDir {
		t.Errorf("projects should be a dir: %+v", d)
	}
	l, ok := byName["link"]
	if !ok || !l.IsSymlink || l.Target != "notes.txt" {
		t.Errorf("link should be a symlink to notes.txt: %+v", l)
	}

	// Directories sort before files (sortEntries).
	if entries[0].Name != "projects" {
		t.Errorf("expected dir first after sort, got %q", entries[0].Name)
	}
}

func TestParseSCPControl(t *testing.T) {
	mode, size, name, err := parseSCPControl("C0644 1024 file.txt\n")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if mode != "0644" || size != 1024 || name != "file.txt" {
		t.Errorf("got mode=%q size=%d name=%q", mode, size, name)
	}

	// Name with spaces (SplitN keeps the remainder intact).
	_, _, name, err = parseSCPControl("C0600 5 my file.bin\n")
	if err != nil || name != "my file.bin" {
		t.Errorf("space-name parse: name=%q err=%v", name, err)
	}

	if _, _, _, err := parseSCPControl("D0755 0 dir\n"); err == nil {
		t.Error("non-C line should error")
	}
	if _, _, _, err := parseSCPControl("C0644 notanumber f\n"); err == nil {
		t.Error("bad size should error")
	}
}

func TestReadAck(t *testing.T) {
	// 0 byte = ok.
	if err := readAck(bufio.NewReader(strings.NewReader("\x00"))); err != nil {
		t.Errorf("0 byte should be ok, got %v", err)
	}
	// 1 byte = warning, message follows to newline.
	err := readAck(bufio.NewReader(strings.NewReader("\x01no such file\n")))
	if err == nil || !strings.Contains(err.Error(), "no such file") {
		t.Errorf("warning ack: got %v", err)
	}
	// 2 byte = fatal.
	err = readAck(bufio.NewReader(strings.NewReader("\x02permission denied\n")))
	if err == nil || !strings.Contains(err.Error(), "permission denied") {
		t.Errorf("fatal ack: got %v", err)
	}
}
