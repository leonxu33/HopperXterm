package pane

import "testing"

func TestOSC7Scanner(t *testing.T) {
	cases := []struct {
		name string
		in   []string // chunks fed sequentially
		want [][2]string
	}{
		{
			name: "single ST-terminated",
			in:   []string{"\x1b]7;file://host/home/user\x1b\\$ "},
			want: [][2]string{{"host", "/home/user"}},
		},
		{
			name: "single BEL-terminated",
			in:   []string{"\x1b]7;file://host/home/user\x07$ "},
			want: [][2]string{{"host", "/home/user"}},
		},
		{
			name: "split across chunks",
			in:   []string{"\x1b]7;file://h", "ost/var/log", "\x07"},
			want: [][2]string{{"host", "/var/log"}},
		},
		{
			name: "no host",
			in:   []string{"\x1b]7;file:///etc\x07"},
			want: [][2]string{{"", "/etc"}},
		},
		{
			name: "bare path",
			in:   []string{"\x1b]7;/usr/local\x07"},
			want: [][2]string{{"", "/usr/local"}},
		},
		{
			name: "two sequences",
			in:   []string{"\x1b]7;file://h/a\x07prompt$ ls\n\x1b]7;file://h/b\x1b\\"},
			want: [][2]string{{"h", "/a"}, {"h", "/b"}},
		},
		{
			name: "no OSC 7",
			in:   []string{"normal output\nno escape\n"},
			want: nil,
		},
		{
			name: "garbage escape ignored",
			in:   []string{"\x1b]2;title\x07"},
			want: nil,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var got [][2]string
			emit := func(host, path string) {
				got = append(got, [2]string{host, path})
			}
			var s osc7Scanner
			for _, chunk := range tc.in {
				s.Feed([]byte(chunk), emit)
			}
			if len(got) != len(tc.want) {
				t.Fatalf("got %d emits, want %d: got=%v", len(got), len(tc.want), got)
			}
			for i := range tc.want {
				if got[i] != tc.want[i] {
					t.Errorf("emit %d: got %v, want %v", i, got[i], tc.want[i])
				}
			}
		})
	}
}
