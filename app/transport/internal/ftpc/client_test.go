package ftpc

import (
	"bufio"
	"net"
	"strings"
	"testing"
	"time"
)

// fakeServer is a minimal scripted FTP server for exercising the client's
// control protocol and both data-connection modes over real loopback
// sockets. passiveWorks=false makes the EPSV/PASV reply advertise a closed
// port so the client is forced to fall back to active mode (EPRT).
type fakeServer struct {
	t            *testing.T
	ln           net.Listener
	passiveWorks bool
	listing      string
}

func newFakeServer(t *testing.T, passiveWorks bool, listing string) *fakeServer {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	s := &fakeServer{t: t, ln: ln, passiveWorks: passiveWorks, listing: listing}
	go s.serve()
	return s
}

func (s *fakeServer) addr() string { return s.ln.Addr().String() }
func (s *fakeServer) close()       { s.ln.Close() }

func (s *fakeServer) serve() {
	conn, err := s.ln.Accept()
	if err != nil {
		return
	}
	defer conn.Close()
	r := bufio.NewReader(conn)
	w := func(line string) { conn.Write([]byte(line + "\r\n")) }

	w("220 fake vsFTPd")

	var dataLn net.Listener  // live passive listener (passiveWorks)
	var activeAddr string    // client's EPRT address (active mode)

	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return
		}
		line = strings.TrimRight(line, "\r\n")
		cmd := line
		arg := ""
		if i := strings.IndexByte(line, ' '); i >= 0 {
			cmd, arg = line[:i], line[i+1:]
		}
		switch strings.ToUpper(cmd) {
		case "USER":
			w("331 need password")
		case "PASS":
			w("230 login ok")
		case "TYPE":
			w("200 binary")
		case "PWD":
			w(`257 "/home/generic" is the current directory`)
		case "EPSV":
			port := s.dataPort(&dataLn)
			w("229 Entering Extended Passive Mode (|||" + itoa(port) + "|)")
		case "PASV":
			port := s.dataPort(&dataLn)
			p1, p2 := port/256, port%256
			w("227 Entering Passive Mode (127,0,0,1," + itoa(p1) + "," + itoa(p2) + ")")
		case "EPRT":
			// |1|ip|port|
			parts := strings.Split(arg, "|")
			if len(parts) >= 4 {
				activeAddr = net.JoinHostPort(parts[2], parts[3])
			}
			w("200 EPRT ok")
		case "LIST":
			dc := s.openData(dataLn, activeAddr)
			if dc == nil {
				w("425 can't open data connection")
				continue
			}
			w("150 here comes the listing")
			dc.Write([]byte(s.listing))
			dc.Close()
			w("226 transfer complete")
			activeAddr = ""
		case "QUIT":
			w("221 bye")
			return
		default:
			w("500 unknown")
		}
	}
}

// dataPort returns the port to advertise. When passive works it opens a
// real listener (stored in *lnp); otherwise it returns a just-closed port
// so the client's dial is refused and it falls back to active mode.
func (s *fakeServer) dataPort(lnp *net.Listener) int {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		s.t.Fatalf("data listen: %v", err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	if s.passiveWorks {
		*lnp = l
	} else {
		l.Close() // port now (almost certainly) refused → forces active mode
	}
	return port
}

// openData yields the data connection: accept on the passive listener, or
// dial back to the client's EPRT address for active mode.
func (s *fakeServer) openData(dataLn net.Listener, activeAddr string) net.Conn {
	if activeAddr != "" {
		c, err := net.DialTimeout("tcp", activeAddr, 2*time.Second)
		if err != nil {
			return nil
		}
		return c
	}
	if dataLn != nil {
		defer dataLn.Close()
		dataLn.(*net.TCPListener).SetDeadline(time.Now().Add(2 * time.Second))
		c, err := dataLn.Accept()
		if err != nil {
			return nil
		}
		return c
	}
	return nil
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}

func dialFake(t *testing.T, s *fakeServer) *Conn {
	t.Helper()
	host, portStr, _ := net.SplitHostPort(s.addr())
	port := 0
	for _, ch := range portStr {
		port = port*10 + int(ch-'0')
	}
	c, err := Dial(Config{Host: host, Port: port, Timeout: 3 * time.Second})
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	if err := c.Login("generic", "pw"); err != nil {
		t.Fatalf("Login: %v", err)
	}
	return c
}

const sampleListing = "drwxr-xr-x    2 1000     1000         4096 May 28 12:34 docs\r\n" +
	"-rw-r--r--    1 1000     1000          120 May 28 12:30 readme.txt\r\n"

func TestClient_PassiveList(t *testing.T) {
	s := newFakeServer(t, true, sampleListing)
	defer s.close()
	c := dialFake(t, s)
	defer c.Quit()

	entries, err := c.List(".")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	assertSampleEntries(t, entries)
}

func TestClient_ActiveFallbackList(t *testing.T) {
	// Passive data port is refused → the client must fall back to active
	// mode (EPRT) and still complete the listing.
	s := newFakeServer(t, false, sampleListing)
	defer s.close()
	c := dialFake(t, s)
	defer c.Quit()

	if c.preferActive {
		t.Fatal("should not start in active mode")
	}
	entries, err := c.List(".")
	if err != nil {
		t.Fatalf("List (active fallback): %v", err)
	}
	if !c.preferActive {
		t.Error("client should have switched to active mode after passive failure")
	}
	assertSampleEntries(t, entries)
}

func TestClient_CurrentDir(t *testing.T) {
	s := newFakeServer(t, true, "")
	defer s.close()
	c := dialFake(t, s)
	defer c.Quit()
	dir, err := c.CurrentDir()
	if err != nil {
		t.Fatalf("CurrentDir: %v", err)
	}
	if dir != "/home/generic" {
		t.Errorf("CurrentDir = %q, want /home/generic", dir)
	}
}

func assertSampleEntries(t *testing.T, entries []*Entry) {
	t.Helper()
	if len(entries) != 2 {
		t.Fatalf("got %d entries, want 2", len(entries))
	}
	if entries[0].Name != "docs" || entries[0].Type != EntryTypeFolder {
		t.Errorf("entry0 = %+v, want dir 'docs'", entries[0])
	}
	if entries[1].Name != "readme.txt" || entries[1].Type != EntryTypeFile || entries[1].Size != 120 {
		t.Errorf("entry1 = %+v, want file 'readme.txt' size 120", entries[1])
	}
}

// TestReadResponse_Multiline guards the multiline-reply handling — the bug
// that surfaced as "short response: REST STREAM" came from a FEAT-style
// multiline 211 reply being mis-parsed. The terminating line shares the
// code and a space; intermediate feature lines (leading space) must not end
// the reply.
func TestReadResponse_Multiline(t *testing.T) {
	srv, cli := net.Pipe()
	defer cli.Close()
	go func() {
		defer srv.Close()
		srv.Write([]byte("211-Features:\r\n EPSV\r\n REST STREAM\r\n211 End\r\n"))
	}()
	c := &Conn{conn: cli, r: bufio.NewReader(cli), loc: time.UTC}
	code, msg, err := c.readResponse(-1)
	if err != nil {
		t.Fatalf("readResponse: %v", err)
	}
	if code != 211 {
		t.Errorf("code = %d, want 211", code)
	}
	if !strings.Contains(msg, "REST STREAM") || !strings.Contains(msg, "End") {
		t.Errorf("multiline body not fully captured: %q", msg)
	}
}

func TestParseEPSVAndPASV(t *testing.T) {
	// EPSV parse: only a port between the bars. epsv()/pasv() each send a
	// command before reading, so the fake must consume the command first
	// (net.Pipe is unbuffered — an unread write would deadlock).
	srv, cli := net.Pipe()
	go func() {
		defer srv.Close()
		br := bufio.NewReader(srv)
		br.ReadString('\n') // EPSV
		srv.Write([]byte("229 Entering Extended Passive Mode (|||30200|)\r\n"))
		br.ReadString('\n') // PASV
		srv.Write([]byte("227 Entering Passive Mode (52,78,8,39,117,234)\r\n"))
	}()
	c := &Conn{conn: cli, r: bufio.NewReader(cli), loc: time.UTC}
	port, err := c.epsv()
	if err != nil || port != 30200 {
		t.Fatalf("epsv = %d, %v; want 30200, nil", port, err)
	}
	host, pport, err := c.pasv()
	if err != nil || pport != 117*256+234 {
		t.Fatalf("pasv port = %d, %v; want %d", pport, err, 117*256+234)
	}
	if host != "52.78.8.39" {
		t.Errorf("pasv host = %q, want 52.78.8.39", host)
	}
	cli.Close()
}
