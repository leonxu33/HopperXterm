package transport

import "testing"

func TestNormalizeS3Prefix(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"", ""},
		{"/", ""},
		{"foo", "foo/"},
		{"foo/", "foo/"},
		{"/foo", "foo/"},
		{"/foo/", "foo/"},
		{"foo/bar", "foo/bar/"},
		{"/foo/bar/", "foo/bar/"},
	}
	for _, c := range cases {
		if got := normalizeS3Prefix(c.in); got != c.want {
			t.Errorf("normalizeS3Prefix(%q)=%q want %q", c.in, got, c.want)
		}
	}
}
