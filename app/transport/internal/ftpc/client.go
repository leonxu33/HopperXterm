// Package ftpc is a small FTP client tailored to HopperXterm's file-only
// FTP sessions. It exists because the previous dependency
// (github.com/jlaffaye/ftp) is passive-only, and some servers (e.g.
// vsFTPd behind an AWS load balancer that only forwards the control port)
// refuse every passive data connection — the data ports simply aren't
// routable. Clients like FileZilla cope by falling back to
// ACTIVE mode (EPRT/PORT), where the server dials back to the client.
//
// This client tries passive first (EPSV, then PASV), and on a passive
// data-dial failure switches to active mode for the rest of the session.
// The LIST-output parser (parse.go) and field scanner (scanner.go) are
// vendored verbatim from jlaffaye/ftp; everything here is original.
//
// A single FTP control connection is not safe for concurrent use, so all
// public methods serialize on a mutex. Retr holds the lock until the
// returned reader is closed (the control channel is idle but must not be
// reused mid-transfer).
package ftpc

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"
)

// EntryType describes the different types of an Entry.
type EntryType int

const (
	EntryTypeFile EntryType = iota
	EntryTypeFolder
	EntryTypeLink
)

// Entry describes a file/directory returned by List.
type Entry struct {
	Name   string
	Target string // target of a symbolic link
	Type   EntryType
	Size   uint64
	Time   time.Time
}

// Error is a non-2xx/3xx FTP reply surfaced to the caller.
type Error struct {
	Code int
	Msg  string
}

func (e *Error) Error() string { return fmt.Sprintf("%d %s", e.Code, e.Msg) }

// Config holds the minimum needed to reach an FTP server.
type Config struct {
	Host    string
	Port    int           // 0 → 21
	Timeout time.Duration // 0 → 10s; applies to dials and Accept
	Debug   io.Writer     // optional protocol trace (nil disables)
	Now     func() time.Time
}

// Conn is an authenticated FTP control connection.
type Conn struct {
	mu       sync.Mutex
	conn     net.Conn
	r        *bufio.Reader
	host     string // control host, reused for the data channel (NAT-safe)
	timeout  time.Duration
	debug    io.Writer
	now      func() time.Time
	loc      *time.Location

	skipEPSV     bool // EPSV unsupported → go straight to PASV
	preferActive bool // a passive data dial failed → use active mode

	// dataMu guards xfer, the in-flight transfer's data connection. Retr
	// and Stor hold mu for the whole transfer, so AbortData uses this
	// separate lock to tear the data conn down from another goroutine
	// (transfer cancellation) and unblock a stalled read/write.
	dataMu sync.Mutex
	xfer   net.Conn
}

func (c *Conn) setXfer(nc net.Conn) { c.dataMu.Lock(); c.xfer = nc; c.dataMu.Unlock() }
func (c *Conn) clearXfer()          { c.dataMu.Lock(); c.xfer = nil; c.dataMu.Unlock() }

// AbortData closes the in-flight transfer's data connection, if any,
// unblocking a Retr/Stor stalled on a slow or dead network. Safe to call
// from a goroutine other than the one running the transfer; a no-op when
// no transfer is active. The transfer's own Close/finishTransfer path then
// runs normally and surfaces the resulting error.
func (c *Conn) AbortData() {
	c.dataMu.Lock()
	nc := c.xfer
	c.dataMu.Unlock()
	if nc != nil {
		_ = nc.Close()
	}
}

// Dial opens a control connection and reads the server greeting.
func Dial(cfg Config) (*Conn, error) {
	if cfg.Host == "" {
		return nil, errors.New("ftpc: host required")
	}
	if cfg.Port == 0 {
		cfg.Port = 21
	}
	if cfg.Timeout == 0 {
		cfg.Timeout = 10 * time.Second
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	addr := net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port))
	nc, err := net.DialTimeout("tcp", addr, cfg.Timeout)
	if err != nil {
		return nil, fmt.Errorf("ftpc: dial %s: %w", addr, err)
	}
	c := &Conn{
		conn:    nc,
		r:       bufio.NewReader(nc),
		host:    cfg.Host,
		timeout: cfg.Timeout,
		debug:   cfg.Debug,
		now:     cfg.Now,
		loc:     time.UTC,
	}
	if _, _, err := c.readResponse(220); err != nil {
		nc.Close()
		return nil, fmt.Errorf("ftpc: greeting: %w", err)
	}
	return c, nil
}

// Login authenticates and switches to binary transfer mode.
func (c *Conn) Login(user, pass string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	code, msg, err := c.cmd("USER %s", user)
	if err != nil {
		return err
	}
	switch code {
	case 230: // already logged in
	case 331, 332: // password (or account) required
		if code, msg, err = c.cmd("PASS %s", pass); err != nil {
			return err
		}
		if code != 230 && code != 202 {
			return &Error{code, msg}
		}
	default:
		return &Error{code, msg}
	}
	// Binary mode so sizes and byte counts are exact.
	if code, msg, err := c.cmd("TYPE I"); err != nil {
		return err
	} else if code != 200 {
		return &Error{code, msg}
	}
	return nil
}

// Quit sends QUIT (best-effort) and closes the control connection.
func (c *Conn) Quit() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	_ = c.send("QUIT")
	return c.conn.Close()
}

// CurrentDir returns the server-side working directory (PWD).
func (c *Conn) CurrentDir() (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	code, msg, err := c.cmd("PWD")
	if err != nil {
		return "", err
	}
	if code != 257 {
		return "", &Error{code, msg}
	}
	// 257 "/path/name" comment — extract the quoted path ("" escapes ").
	start := strings.Index(msg, `"`)
	end := strings.LastIndex(msg, `"`)
	if start == -1 || end <= start {
		return msg, nil
	}
	return strings.ReplaceAll(msg[start+1:end], `""`, `"`), nil
}

// List returns the entries of dir via the LIST command.
func (c *Conn) List(dir string) ([]*Entry, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	var format string
	var args []interface{}
	if dir == "" || dir == "." {
		format = "LIST"
	} else {
		format = "LIST %s"
		args = []interface{}{dir}
	}

	conn, err := c.dataCmd(format, args...)
	if err != nil {
		return nil, err
	}
	data, readErr := io.ReadAll(conn)
	conn.Close()
	// Read the transfer-complete reply regardless of read outcome so the
	// control stream stays in sync for the next command.
	if _, _, ferr := c.finishTransfer(); ferr != nil && readErr == nil {
		readErr = ferr
	}
	if readErr != nil {
		return nil, readErr
	}

	now := c.now()
	var out []*Entry
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimRight(line, "\r")
		if line == "" {
			continue
		}
		e, perr := parseListLine(line, now, c.loc)
		if perr != nil {
			// Skip unparseable lines (banners, "total N", odd formats)
			// rather than failing the whole listing.
			continue
		}
		out = append(out, e)
	}
	return out, nil
}

// Retr opens remotePath for reading. The returned reader holds the
// control-connection lock until Closed; the caller MUST Close it.
func (c *Conn) Retr(remotePath string) (io.ReadCloser, error) {
	c.mu.Lock()
	conn, err := c.dataCmd("RETR %s", remotePath)
	if err != nil {
		c.mu.Unlock()
		return nil, err
	}
	c.setXfer(conn) // expose the data conn so AbortData can cancel a stalled read
	return &retrReader{conn: conn, c: c}, nil
}

// Stor writes r to remotePath (STOR).
func (c *Conn) Stor(remotePath string, r io.Reader) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	conn, err := c.dataCmd("STOR %s", remotePath)
	if err != nil {
		return err
	}
	c.setXfer(conn) // expose the data conn so AbortData can cancel a stalled write
	defer c.clearXfer()
	_, copyErr := io.Copy(conn, r)
	conn.Close()
	_, _, ferr := c.finishTransfer()
	if copyErr != nil {
		return copyErr
	}
	return ferr
}

// MakeDir creates a directory (MKD).
func (c *Conn) MakeDir(p string) error { return c.simpleCmd2xx("MKD %s", p) }

// Delete removes a file (DELE).
func (c *Conn) Delete(p string) error { return c.simpleCmd2xx("DELE %s", p) }

// RemoveDir removes an empty directory (RMD).
func (c *Conn) RemoveDir(p string) error { return c.simpleCmd2xx("RMD %s", p) }

// Rename moves src to dst (RNFR + RNTO).
func (c *Conn) Rename(src, dst string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if code, msg, err := c.cmd("RNFR %s", src); err != nil {
		return err
	} else if code != 350 {
		return &Error{code, msg}
	}
	code, msg, err := c.cmd("RNTO %s", dst)
	if err != nil {
		return err
	}
	if code < 200 || code >= 300 {
		return &Error{code, msg}
	}
	return nil
}

func (c *Conn) simpleCmd2xx(format string, args ...interface{}) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	code, msg, err := c.cmd(format, args...)
	if err != nil {
		return err
	}
	if code < 200 || code >= 300 {
		return &Error{code, msg}
	}
	return nil
}

// ─── data connection (passive → active fallback) ──────────────────────────

// dataCmd sets up a data connection and issues the transfer command,
// returning the data conn after the 1xx preliminary reply. The caller
// transfers, closes the conn, then calls finishTransfer for the 2xx.
func (c *Conn) dataCmd(format string, args ...interface{}) (net.Conn, error) {
	if !c.preferActive {
		conn, err := c.passiveDataConn()
		if err == nil {
			if terr := c.sendTransfer(format, args...); terr != nil {
				conn.Close()
				return nil, terr
			}
			return conn, nil
		}
		// The passive data port is unreachable (the classic
		// firewalled-PASV-range case). Switch to active mode for the rest
		// of this session and retry.
		if c.debug != nil {
			fmt.Fprintf(c.debug, "ftpc: passive data conn failed (%v); switching to active mode\n", err)
		}
		c.preferActive = true
	}
	return c.activeDataConn(format, args...)
}

// passiveDataConn negotiates EPSV (preferred) or PASV and dials the data
// port. The advertised host is ignored in favor of the control host — the
// reliable, NAT-safe choice (the box we already reached on the control
// port).
func (c *Conn) passiveDataConn() (net.Conn, error) {
	var port int
	if !c.skipEPSV {
		p, err := c.epsv()
		if err == nil {
			port = p
		} else {
			c.skipEPSV = true
		}
	}
	if port == 0 {
		_, p, err := c.pasv()
		if err != nil {
			return nil, err
		}
		port = p
	}
	addr := net.JoinHostPort(c.host, strconv.Itoa(port))
	conn, err := net.DialTimeout("tcp", addr, c.timeout)
	if err != nil {
		return nil, fmt.Errorf("passive dial %s: %w", addr, err)
	}
	return conn, nil
}

// activeDataConn opens a local listener, tells the server to connect back
// (EPRT, falling back to PORT), issues the transfer command, then accepts
// the inbound data connection.
func (c *Conn) activeDataConn(format string, args ...interface{}) (net.Conn, error) {
	localIP := c.conn.LocalAddr().(*net.TCPAddr).IP
	ln, err := net.ListenTCP("tcp", &net.TCPAddr{IP: localIP, Port: 0})
	if err != nil {
		return nil, fmt.Errorf("active listen: %w", err)
	}
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port

	if err := c.eprt(localIP, port); err != nil {
		// Older/IPv4-only servers may reject EPRT; fall back to PORT.
		if perr := c.port(localIP, port); perr != nil {
			return nil, fmt.Errorf("active mode setup failed (EPRT: %v; PORT: %w)", err, perr)
		}
	}
	if err := c.sendTransfer(format, args...); err != nil {
		return nil, err
	}
	_ = ln.SetDeadline(c.now().Add(c.timeout))
	conn, err := ln.Accept()
	if err != nil {
		return nil, fmt.Errorf("active data accept: %w", err)
	}
	return conn, nil
}

// sendTransfer issues the transfer command and consumes the 1xx
// preliminary reply (150 file status okay / 125 data connection open).
func (c *Conn) sendTransfer(format string, args ...interface{}) error {
	code, msg, err := c.cmd(format, args...)
	if err != nil {
		return err
	}
	if code != 150 && code != 125 {
		return &Error{code, msg}
	}
	return nil
}

// finishTransfer reads the post-transfer completion reply (226/250).
func (c *Conn) finishTransfer() (int, string, error) {
	code, msg, err := c.readResponse(-1)
	if err != nil {
		return code, msg, err
	}
	if code != 226 && code != 250 {
		return code, msg, &Error{code, msg}
	}
	return code, msg, nil
}

func (c *Conn) epsv() (int, error) {
	code, line, err := c.cmd("EPSV")
	if err != nil {
		return 0, err
	}
	if code != 229 {
		return 0, &Error{code, line}
	}
	// 229 Entering Extended Passive Mode (|||port|)
	start := strings.Index(line, "(")
	end := strings.LastIndex(line, ")")
	if start == -1 || end <= start {
		return 0, errors.New("invalid EPSV response")
	}
	parts := strings.Split(line[start+1:end], "|")
	if len(parts) < 4 {
		return 0, errors.New("invalid EPSV response")
	}
	return strconv.Atoi(parts[3])
}

func (c *Conn) pasv() (string, int, error) {
	code, line, err := c.cmd("PASV")
	if err != nil {
		return "", 0, err
	}
	if code != 227 {
		return "", 0, &Error{code, line}
	}
	// 227 Entering Passive Mode (h1,h2,h3,h4,p1,p2)
	start := strings.Index(line, "(")
	end := strings.LastIndex(line, ")")
	if start == -1 || end <= start {
		return "", 0, errors.New("invalid PASV response")
	}
	f := strings.Split(line[start+1:end], ",")
	if len(f) < 6 {
		return "", 0, errors.New("invalid PASV response")
	}
	p1, err1 := strconv.Atoi(strings.TrimSpace(f[4]))
	p2, err2 := strconv.Atoi(strings.TrimSpace(f[5]))
	if err1 != nil || err2 != nil {
		return "", 0, errors.New("invalid PASV port")
	}
	return strings.Join(f[0:4], "."), p1*256 + p2, nil
}

func (c *Conn) eprt(ip net.IP, port int) error {
	proto, addr := 2, ip.String()
	if v4 := ip.To4(); v4 != nil {
		proto, addr = 1, v4.String()
	}
	code, msg, err := c.cmd("EPRT |%d|%s|%d|", proto, addr, port)
	if err != nil {
		return err
	}
	if code != 200 {
		return &Error{code, msg}
	}
	return nil
}

func (c *Conn) port(ip net.IP, port int) error {
	v4 := ip.To4()
	if v4 == nil {
		return errors.New("PORT requires IPv4")
	}
	code, msg, err := c.cmd("PORT %d,%d,%d,%d,%d,%d", v4[0], v4[1], v4[2], v4[3], port>>8, port&0xff)
	if err != nil {
		return err
	}
	if code != 200 {
		return &Error{code, msg}
	}
	return nil
}

// ─── control protocol primitives ──────────────────────────────────────────

// cmd sends a command and reads its reply (no expected-code enforcement;
// callers inspect the returned code).
func (c *Conn) cmd(format string, args ...interface{}) (int, string, error) {
	if err := c.send(format, args...); err != nil {
		return 0, "", err
	}
	return c.readResponse(-1)
}

func (c *Conn) send(format string, args ...interface{}) error {
	line := fmt.Sprintf(format, args...)
	if c.debug != nil {
		fmt.Fprintf(c.debug, "ftpc> %s\n", line)
	}
	_, err := fmt.Fprintf(c.conn, "%s\r\n", line)
	return err
}

// readResponse reads a (possibly multiline) FTP reply. A multiline reply
// opens with "NNN-..." and ends at a line beginning "NNN " (same code,
// space). If expect >= 0 and the code differs, an *Error is returned.
func (c *Conn) readResponse(expect int) (int, string, error) {
	line, err := c.readLine()
	if err != nil {
		return 0, "", err
	}
	if len(line) < 4 || (line[3] != ' ' && line[3] != '-') {
		return 0, "", fmt.Errorf("ftpc: malformed response: %q", line)
	}
	code, err := strconv.Atoi(line[:3])
	if err != nil {
		return 0, "", fmt.Errorf("ftpc: invalid response code: %q", line)
	}
	msg := line[4:]
	if line[3] == '-' {
		for {
			l, lerr := c.readLine()
			if lerr != nil {
				return 0, "", lerr
			}
			msg += "\n" + l
			if len(l) >= 4 && l[3] == ' ' {
				if lc, e := strconv.Atoi(l[:3]); e == nil && lc == code {
					break
				}
			}
		}
	}
	if expect >= 0 && code != expect {
		return code, msg, &Error{code, msg}
	}
	return code, msg, nil
}

func (c *Conn) readLine() (string, error) {
	s, err := c.r.ReadString('\n')
	s = strings.TrimRight(s, "\r\n")
	if c.debug != nil && s != "" {
		fmt.Fprintf(c.debug, "ftpc< %s\n", s)
	}
	return s, err
}

// retrReader wraps a RETR data connection; Close reads the 226 completion
// reply and releases the control-connection lock taken by Retr.
type retrReader struct {
	conn   net.Conn
	c      *Conn
	closed bool
}

func (r *retrReader) Read(p []byte) (int, error) { return r.conn.Read(p) }

func (r *retrReader) Close() error {
	if r.closed {
		return nil
	}
	r.closed = true
	r.c.clearXfer()
	cerr := r.conn.Close()
	_, _, ferr := r.c.finishTransfer()
	r.c.mu.Unlock()
	if cerr != nil {
		return cerr
	}
	return ferr
}
