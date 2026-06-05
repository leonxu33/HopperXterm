package transport

import "testing"

func TestSuggestRemotePath_PosixLocal(t *testing.T) {
	got := SuggestRemotePath("/home/u/work", "/var/log/syslog")
	want := "/home/u/work/syslog"
	if got != want {
		t.Fatalf("posix local: got %q want %q", got, want)
	}
}

func TestSuggestRemotePath_WindowsLocal(t *testing.T) {
	got := SuggestRemotePath("/home/u/uploads", `C:\Users\user\file.txt`)
	want := "/home/u/uploads/file.txt"
	if got != want {
		t.Fatalf("windows local: got %q want %q", got, want)
	}
}

func TestSuggestRemotePath_BareName(t *testing.T) {
	got := SuggestRemotePath("/tmp", "report.csv")
	want := "/tmp/report.csv"
	if got != want {
		t.Fatalf("bare name: got %q want %q", got, want)
	}
}

func TestSuggestRemotePath_MixedSeparators(t *testing.T) {
	got := SuggestRemotePath("/x", `D:\some/mixed\name.dat`)
	want := "/x/name.dat"
	if got != want {
		t.Fatalf("mixed seps: got %q want %q", got, want)
	}
}

func TestSuggestRemotePath_RemoteHasTrailingSlash(t *testing.T) {
	// path.Join collapses, so the trailing-slash case is harmless.
	got := SuggestRemotePath("/a/", "b.txt")
	want := "/a/b.txt"
	if got != want {
		t.Fatalf("trailing slash: got %q want %q", got, want)
	}
}

func TestSuggestRemotePath_EmptyLocal(t *testing.T) {
	// Edge case: empty local path. We expect "dir/" — not great, but
	// deterministic. The frontend gates uploads on a real file.
	got := SuggestRemotePath("/x", "")
	want := "/x"
	if got != want {
		t.Fatalf("empty local: got %q want %q", got, want)
	}
}
