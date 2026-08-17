package pane

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"hopperxterm/events"
	"hopperxterm/logbook"
	"hopperxterm/transport"
)

// Per-process monitoring. Streams one selected PID's CPU + memory at 1 Hz
// over a dedicated SSH exec channel, emitting events.ProcessSample. This is
// deliberately separate from the host-wide resource poller (resource.go):
// process selection is per-panel and user-chosen, so folding it into the
// shared, host-deduplicated host poller would force a restart on every
// selection change and conflict between panels. A standalone stream keeps
// the two concerns isolated — a monitored process exiting never disturbs
// the system charts.
//
// CPU is reported top-style: the share of one logical core (utime+stime
// delta / clock ticks per second), so a process spanning N cores can read
// up to N×100%. The frontend's chart Y-axis auto-scales to match.
//
// Line format (one per second), shared by all three OS scripts so the Go
// parser is platform-agnostic:
//
//	p1 ts_ms pid cpuPct memKB alive uptimeSec
//
// alive is 1 normally and 0 on the single final tick emitted when the PID
// has gone, after which the script exits and the stream ends. uptimeSec is
// how long the process has been running (0 when unknown / not running).

// linuxProcScript reads /proc/<pid>/{stat,status}. $pid is supplied by
// prepending a `pid=N` assignment on stdin (see processStreamCmd).
const linuxProcScript = `
clk=$(getconf CLK_TCK 2>/dev/null); case "$clk" in ''|*[!0-9]*) clk=100;; esac
prev=-1
while :; do
  if [ ! -d /proc/$pid ]; then
    ts=$(date +%s%3N 2>/dev/null); case "$ts" in ''|*[!0-9]*) ts=$(($(date +%s)*1000));; esac
    echo "p1 $ts $pid 0 0 0 0"
    break
  fi
  # /proc/<pid>/stat: comm (field 2) is wrapped in parens and may itself
  # contain spaces or ')', so strip up to the LAST ') ' to land on field 3
  # (state). After dropping fields 1-2 the positions shift by 2, so utime
  # (field 14) is ${12}, stime (field 15) is ${13} and starttime (field 22,
  # jiffies since boot) is ${20}.
  stat=$(cat /proc/$pid/stat 2>/dev/null)
  rest=${stat##*) }
  set -- $rest
  utime=${12}; stime=${13}; start=${20}
  case "$utime" in ''|*[!0-9]*) utime=0;; esac
  case "$stime" in ''|*[!0-9]*) stime=0;; esac
  case "$start" in ''|*[!0-9]*) start=0;; esac
  proc=$((utime+stime))
  rss=$(awk '/^VmRSS:/{print $2}' /proc/$pid/status 2>/dev/null)
  case "$rss" in ''|*[!0-9]*) rss=0;; esac
  read up _ < /proc/uptime; up=${up%%.*}
  case "$up" in ''|*[!0-9]*) up=0;; esac
  ets=$((up - start/clk)); [ "$ets" -lt 0 ] && ets=0
  if [ "$prev" -lt 0 ]; then
    cpu=0
  else
    d=$((proc-prev))
    [ "$d" -lt 0 ] && d=0
    # d jiffies accrued over the ~1s interval; clk jiffies/s == one full core.
    cpu=$((100*d/clk))
  fi
  prev=$proc
  ts=$(date +%s%3N 2>/dev/null); case "$ts" in ''|*[!0-9]*) ts=$(($(date +%s)*1000));; esac
  echo "p1 $ts $pid $cpu $rss 1 $ets"
  sleep 1
done
`

// darwinProcScript uses BSD ps. pcpu is already top-style (can exceed 100
// on multi-core) and rss is in KiB. ps over a non-PTY exec is safe — unlike
// top, which hangs without a controlling terminal (see the macOS poller
// notes in resource.go). etime ("[[dd-]hh:]mm:ss") is folded to seconds by
// the awk right-to-left walk (units climb s→m→h→d).
const darwinProcScript = `
while :; do
  line=$(ps -p $pid -o pcpu=,rss=,etime= 2>/dev/null)
  ts=$(( $(date +%s) * 1000 ))
  if [ -z "$line" ]; then
    echo "p1 $ts $pid 0 0 0 0"
    break
  fi
  set -- $line
  cpu=$1; rss=$2; et=$3
  case "$rss" in ''|*[!0-9]*) rss=0;; esac
  ets=$(printf %s "$et" | awk '{n=split($0,a,/[-:]/); s=a[n]+a[n-1]*60; if(n>=3)s+=a[n-2]*3600; if(n>=4)s+=a[n-3]*86400; print int(s)}')
  case "$ets" in ''|*[!0-9]*) ets=0;; esac
  echo "p1 $ts $pid $cpu $rss 1 $ets"
  sleep 1
done
`

// windowsProcScript is the PowerShell counterpart. $tpid (NOT $pid, which
// is the PowerShell automatic variable for the current process) is supplied
// by prepending a `$tpid=N` assignment on stdin. $p.CPU is cumulative
// processor-seconds across all cores; the per-wall-second delta ×100 gives
// the top-style percentage. Fed via the windowsStdinRunner stub like the
// host poller.
const windowsProcScript = `$ErrorActionPreference='SilentlyContinue'
$ProgressPreference='SilentlyContinue'
$prev=-1.0; $prevT=0.0
while($true){
  $ts=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $p=Get-Process -Id $tpid -ErrorAction SilentlyContinue
  if($p -eq $null){
    [Console]::Out.WriteLine("p1 $ts $tpid 0 0 0 0")
    [Console]::Out.Flush()
    break
  }
  $cpuSec=[double]$p.CPU
  $rss=[int64]($p.WorkingSet64/1024)
  $et=0; try{ $et=[int64](([DateTime]::Now-$p.StartTime).TotalSeconds) }catch{}
  if($et -lt 0){ $et=0 }
  $now=[double][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if($prev -lt 0){
    $cpu=0
  } else {
    $dt=($now-$prevT)/1000.0
    if($dt -le 0){ $dt=1.0 }
    $dc=$cpuSec-$prev
    if($dc -lt 0){ $dc=0 }
    $cpu=[int][math]::Round(100*$dc/$dt)
  }
  $prev=$cpuSec; $prevT=$now
  [Console]::Out.WriteLine("p1 $ts $tpid $cpu $rss 1 $et")
  [Console]::Out.Flush()
  Start-Sleep -Seconds 1
}
`

// processStreamCmd returns the remote command to start and the stdin text
// for the per-process poller, mirroring resourceStreamCmd. The PID is
// injected as a leading variable assignment so the scripts themselves stay
// placeholder-free. Unknown/empty families fall back to the Linux path.
func processStreamCmd(osFamily string, pid int) (cmd, stdin string) {
	switch osFamily {
	case "darwin":
		return "sh -s", fmt.Sprintf("pid=%d\n", pid) + darwinProcScript
	case "windows":
		return transport.PowerShellEncodedCmd(windowsStdinRunner),
			fmt.Sprintf("$tpid=%d\r\n", pid) + windowsProcScript
	default: // "" or "linux"
		return "sh -s", fmt.Sprintf("pid=%d\n", pid) + linuxProcScript
	}
}

// ── Command-mode scripts ───────────────────────────────────────────────────
// These follow a process by name instead of PID: each tick they resolve the
// matching PID (pgrep -x / Get-Process -Name, first match) and read its
// stats, so monitoring survives a restart under a new PID. When nothing
// matches they emit a "not running" tick (pid 0, alive 0) and keep polling
// rather than ending the stream. $cmdname is injected on stdin.

const linuxProcCmdScript = `
clk=$(getconf CLK_TCK 2>/dev/null); case "$clk" in ''|*[!0-9]*) clk=100;; esac
prev=-1; prevpid=0
while :; do
  pid=$(pgrep -x "$cmdname" 2>/dev/null | head -n1)
  ts=$(date +%s%3N 2>/dev/null); case "$ts" in ''|*[!0-9]*) ts=$(($(date +%s)*1000));; esac
  if [ -z "$pid" ] || [ ! -d /proc/$pid ]; then
    echo "p1 $ts 0 0 0 0 0"
    prev=-1; prevpid=0
    sleep 1; continue
  fi
  [ "$pid" != "$prevpid" ] && prev=-1
  prevpid=$pid
  stat=$(cat /proc/$pid/stat 2>/dev/null)
  rest=${stat##*) }
  set -- $rest
  utime=${12}; stime=${13}; start=${20}
  case "$utime" in ''|*[!0-9]*) utime=0;; esac
  case "$stime" in ''|*[!0-9]*) stime=0;; esac
  case "$start" in ''|*[!0-9]*) start=0;; esac
  proc=$((utime+stime))
  rss=$(awk '/^VmRSS:/{print $2}' /proc/$pid/status 2>/dev/null)
  case "$rss" in ''|*[!0-9]*) rss=0;; esac
  read up _ < /proc/uptime; up=${up%%.*}
  case "$up" in ''|*[!0-9]*) up=0;; esac
  ets=$((up - start/clk)); [ "$ets" -lt 0 ] && ets=0
  if [ "$prev" -lt 0 ]; then cpu=0; else d=$((proc-prev)); [ "$d" -lt 0 ] && d=0; cpu=$((100*d/clk)); fi
  prev=$proc
  echo "p1 $ts $pid $cpu $rss 1 $ets"
  sleep 1
done
`

const darwinProcCmdScript = `
while :; do
  pid=$(pgrep -x "$cmdname" 2>/dev/null | head -n1)
  ts=$(( $(date +%s) * 1000 ))
  if [ -z "$pid" ]; then echo "p1 $ts 0 0 0 0 0"; sleep 1; continue; fi
  line=$(ps -p $pid -o pcpu=,rss=,etime= 2>/dev/null)
  if [ -z "$line" ]; then echo "p1 $ts 0 0 0 0 0"; sleep 1; continue; fi
  set -- $line
  cpu=$1; rss=$2; et=$3
  case "$rss" in ''|*[!0-9]*) rss=0;; esac
  ets=$(printf %s "$et" | awk '{n=split($0,a,/[-:]/); s=a[n]+a[n-1]*60; if(n>=3)s+=a[n-2]*3600; if(n>=4)s+=a[n-3]*86400; print int(s)}')
  case "$ets" in ''|*[!0-9]*) ets=0;; esac
  echo "p1 $ts $pid $cpu $rss 1 $ets"
  sleep 1
done
`

const windowsProcCmdScript = `$ErrorActionPreference='SilentlyContinue'
$ProgressPreference='SilentlyContinue'
$prev=-1.0; $prevT=0.0; $prevpid=0
while($true){
  $ts=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $p=Get-Process -Name $cmdname -ErrorAction SilentlyContinue | Sort-Object Id | Select-Object -First 1
  if($p -eq $null){
    [Console]::Out.WriteLine("p1 $ts 0 0 0 0 0")
    [Console]::Out.Flush()
    $prev=-1.0; $prevpid=0
    Start-Sleep -Seconds 1; continue
  }
  $cur=$p.Id
  if($cur -ne $prevpid){ $prev=-1.0 }
  $prevpid=$cur
  $cpuSec=[double]$p.CPU
  $rss=[int64]($p.WorkingSet64/1024)
  $et=0; try{ $et=[int64](([DateTime]::Now-$p.StartTime).TotalSeconds) }catch{}
  if($et -lt 0){ $et=0 }
  $now=[double][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if($prev -lt 0){ $cpu=0 } else {
    $dt=($now-$prevT)/1000.0; if($dt -le 0){ $dt=1.0 }
    $dc=$cpuSec-$prev; if($dc -lt 0){ $dc=0 }
    $cpu=[int][math]::Round(100*$dc/$dt)
  }
  $prev=$cpuSec; $prevT=$now
  [Console]::Out.WriteLine("p1 $ts $cur $cpu $rss 1 $et")
  [Console]::Out.Flush()
  Start-Sleep -Seconds 1
}
`

// shSingleQuote wraps s in single quotes for safe POSIX-sh injection,
// escaping any embedded single quotes. psSingleQuote does the same for
// PowerShell (where a literal single quote is doubled inside '…').
func shSingleQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func psSingleQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}

// processCommandStreamCmd is the command-mode counterpart of
// processStreamCmd: it follows a process by name, injecting the name as a
// quoted variable assignment on stdin.
func processCommandStreamCmd(osFamily, command string) (cmd, stdin string) {
	switch osFamily {
	case "darwin":
		return "sh -s", "cmdname=" + shSingleQuote(command) + "\n" + darwinProcCmdScript
	case "windows":
		return transport.PowerShellEncodedCmd(windowsStdinRunner),
			"$cmdname=" + psSingleQuote(command) + "\r\n" + windowsProcCmdScript
	default: // "" or "linux"
		return "sh -s", "cmdname=" + shSingleQuote(command) + "\n" + linuxProcCmdScript
	}
}

// processListCmd returns the one-shot command that lists processes for the
// picker. Unix uses `ps` with header-suppressing `=` formats; Windows emits
// a pipe-delimited line per process so parsing is locale-independent.
func processListCmd(osFamily string) string {
	switch osFamily {
	case "darwin":
		// BSD ps: -r sorts by CPU usage (descending).
		return "ps -axo pid=,user=,pcpu=,rss=,comm= -r"
	case "windows":
		return transport.PowerShellEncodedCmd(windowsListScript)
	default: // "" or "linux"
		return "ps -eo pid=,user=,pcpu=,rss=,comm= --sort=-pcpu"
	}
}

// windowsListScript emits up to 200 processes ordered by CPU%,
// "pid|name|memKB|cpuPct" per line. CPU% is a top-style instantaneous value
// (share of one core, may exceed 100) computed from two .CPU (cumulative
// processor-seconds) snapshots ~0.5s apart — Get-Process has no live
// percentage. User is omitted (resolving the owner per process needs an
// expensive CIM Win32_Process Owner call).
const windowsListScript = `$ErrorActionPreference='SilentlyContinue'
$s1=@{}
foreach($p in Get-Process){ $s1[$p.Id]=[double]$p.CPU }
Start-Sleep -Milliseconds 500
$rows = foreach($p in Get-Process){
  $c0=$s1[$p.Id]; if($c0 -eq $null){ $c0=[double]$p.CPU }
  $dc=[double]$p.CPU-$c0; if($dc -lt 0){ $dc=0 }
  [PSCustomObject]@{ Id=$p.Id; Name=$p.ProcessName; Mem=[int64]($p.WorkingSet64/1024); Cpu=[math]::Round(200*$dc,1) }
}
$rows | Sort-Object Cpu -Descending | Select-Object -First 200 | ForEach-Object {
  [Console]::Out.WriteLine(("{0}|{1}|{2}|{3}" -f $_.Id, $_.Name, $_.Mem, $_.Cpu))
}`

const maxProcessList = 200

// parseProcessLine turns one streamed "p1 …" record into a ProcessSample.
// Non-numeric fields zero out rather than rejecting the whole line. The
// trailing uptime field is optional (6-field lines parse with Uptime 0) so
// a remote shell that mangles the last token degrades gracefully.
func parseProcessLine(line string) (events.ProcessSample, bool) {
	parts := strings.Fields(line)
	if (len(parts) != 6 && len(parts) != 7) || parts[0] != "p1" {
		return events.ProcessSample{}, false
	}
	atoi := func(s string) int64 {
		v, _ := strconv.ParseInt(s, 10, 64)
		return v
	}
	atof := func(s string) float64 {
		v, _ := strconv.ParseFloat(s, 64)
		return v
	}
	s := events.ProcessSample{
		TS:     atoi(parts[1]),
		PID:    int(atoi(parts[2])),
		CPUPct: atof(parts[3]),
		MemKB:  atoi(parts[4]),
		Alive:  parts[5] == "1",
	}
	if len(parts) == 7 {
		s.Uptime = atoi(parts[6])
	}
	return s, true
}

// parseProcessList parses the one-shot list output for the picker. Unix and
// Windows have different column layouts, so the family selects the parser.
// Malformed rows are skipped; the result is capped at maxProcessList.
func parseProcessList(osFamily, out string) []events.ProcessInfo {
	if osFamily == "windows" {
		return parseWindowsProcessList(out)
	}
	return parseUnixProcessList(out)
}

func parseUnixProcessList(out string) []events.ProcessInfo {
	var list []events.ProcessInfo
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(strings.TrimSpace(line))
		// pid user pcpu rss comm[...]
		if len(fields) < 5 {
			continue
		}
		pid, err := strconv.Atoi(fields[0])
		if err != nil {
			continue
		}
		cpu, _ := strconv.ParseFloat(fields[2], 64)
		rss, _ := strconv.ParseInt(fields[3], 10, 64)
		name := strings.Join(fields[4:], " ")
		// macOS `comm` is a full executable path; Linux `comm` is already a
		// bare name (never contains '/'). Reduce to the basename so the
		// display — and command-mode pgrep matching — use the same token on
		// both. (Harmless no-op on Linux.)
		if i := strings.LastIndex(name, "/"); i >= 0 {
			name = name[i+1:]
		}
		list = append(list, events.ProcessInfo{
			PID:    pid,
			Name:   name,
			User:   fields[1],
			CPUPct: cpu,
			MemKB:  rss,
		})
		if len(list) >= maxProcessList {
			break
		}
	}
	return list
}

func parseWindowsProcessList(out string) []events.ProcessInfo {
	var list []events.ProcessInfo
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		f := strings.Split(line, "|")
		// pid|name|memKB|cpuSeconds
		if len(f) < 3 {
			continue
		}
		pid, err := strconv.Atoi(strings.TrimSpace(f[0]))
		if err != nil {
			continue
		}
		rss, _ := strconv.ParseInt(strings.TrimSpace(f[2]), 10, 64)
		var cpu float64
		if len(f) >= 4 {
			cpu, _ = strconv.ParseFloat(strings.TrimSpace(f[3]), 64)
		}
		list = append(list, events.ProcessInfo{
			PID:    pid,
			Name:   strings.TrimSpace(f[1]),
			MemKB:  rss,
			CPUPct: cpu,
		})
		if len(list) >= maxProcessList {
			break
		}
	}
	return list
}

// procMonitor is one live per-process stream. Refcounted so two panels
// watching the same PID share a single exec channel; dead is set by the
// reader goroutine when it exits so a later Start replaces it instead of
// attaching to a stream that will emit nothing more.
type procMonitor struct {
	cancel context.CancelFunc
	refs   int
	dead   bool
}

// ListProcesses runs the one-shot picker query and returns the parsed rows.
func (p *Pane) ListProcesses() ([]events.ProcessInfo, error) {
	sh := p.currentSSH()
	if sh == nil || sh.Client == nil {
		return nil, errors.New("pane: process list requires an SSH-backed session")
	}
	osFamily := p.cachedOSFamily()
	if osFamily == "" {
		osFamily = transport.ClassifyRemoteOS(sh.Client)
	}
	sess, err := sh.Client.NewSession()
	if err != nil {
		return nil, fmt.Errorf("process: open session: %w", err)
	}
	defer sess.Close()

	type result struct {
		out []byte
		err error
	}
	ch := make(chan result, 1)
	go func() {
		out, err := sess.CombinedOutput(processListCmd(osFamily))
		ch <- result{out, err}
	}()
	select {
	case r := <-ch:
		if r.err != nil && len(r.out) == 0 {
			return nil, fmt.Errorf("process: list: %w", r.err)
		}
		return parseProcessList(osFamily, string(r.out)), nil
	case <-time.After(8 * time.Second):
		return nil, errors.New("process: list timed out")
	}
}

// StartProcessMonitor opens a dedicated exec channel streaming the given
// PID's CPU/memory once per second. See startProcessMonitor for the shared
// machinery.
func (p *Pane) StartProcessMonitor(pid int) error {
	osFamily := p.cachedOSFamily()
	if sh := p.currentSSH(); osFamily == "" && sh != nil && sh.Client != nil {
		osFamily = transport.ClassifyRemoteOS(sh.Client)
	}
	startCmd, stdinScript := processStreamCmd(osFamily, pid)
	// terminal: a PID monitor ends on the exit tick.
	return p.startProcessMonitor(pidSpec(pid), true, startCmd, stdinScript)
}

// StartProcessMonitorByCommand follows a process by name: the stream
// resolves the matching PID each tick (first match), so monitoring survives
// the process restarting under a new PID.
func (p *Pane) StartProcessMonitorByCommand(command string) error {
	osFamily := p.cachedOSFamily()
	if sh := p.currentSSH(); osFamily == "" && sh != nil && sh.Client != nil {
		osFamily = transport.ClassifyRemoteOS(sh.Client)
	}
	startCmd, stdinScript := processCommandStreamCmd(osFamily, command)
	// not terminal: keep polling across restarts (alive=false is just "down").
	return p.startProcessMonitor(cmdSpec(command), false, startCmd, stdinScript)
}

// pidSpec / cmdSpec build the monitor spec — the refcount key, stamped onto
// every sample for frontend demux. Single source of truth for the format,
// which is a contract with the frontend (specOf in ResourcePanel.tsx).
func pidSpec(pid int) string        { return fmt.Sprintf("pid:%d", pid) }
func cmdSpec(command string) string { return "cmd:" + command }

// startProcessMonitor is the shared poller machinery for both monitor kinds.
// spec is the refcount key and is stamped onto every emitted sample so the
// frontend can demux (and so command-mode samples keep a stable identity as
// the resolved PID changes). terminal selects exit behavior: when true the
// stream ends on the first alive=false tick (PID gone); when false it keeps
// polling so a command monitor resumes after a restart. A repeat Start on a
// live monitor just bumps the count.
func (p *Pane) startProcessMonitor(spec string, terminal bool, startCmd, stdinScript string) error {
	sh := p.currentSSH()
	if sh == nil || sh.Client == nil {
		return errors.New("pane: process monitor requires an SSH-backed session")
	}
	p.procMu.Lock()
	defer p.procMu.Unlock()
	if p.procMon == nil {
		p.procMon = make(map[string]*procMonitor)
	}
	if m, ok := p.procMon[spec]; ok && !m.dead {
		m.refs++
		return nil
	} else if ok {
		// Stale (the previous stream's process exited). Cancel and replace.
		if m.cancel != nil {
			m.cancel()
		}
		delete(p.procMon, spec)
	}

	sess, err := sh.Client.NewSession()
	if err != nil {
		return fmt.Errorf("process: open session: %w", err)
	}
	stdout, err := sess.StdoutPipe()
	if err != nil {
		sess.Close()
		return fmt.Errorf("process: stdout pipe: %w", err)
	}
	stderr, err := sess.StderrPipe()
	if err != nil {
		sess.Close()
		return fmt.Errorf("process: stderr pipe: %w", err)
	}
	sess.Stdin = strings.NewReader(stdinScript)
	if err := sess.Start(startCmd); err != nil {
		sess.Close()
		return fmt.Errorf("process: start poller: %w", err)
	}

	// Drain stderr to the connection log so script failures don't vanish.
	go func() {
		scanner := bufio.NewScanner(stderr)
		scanner.Buffer(make([]byte, 0, 4096), 16384)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" {
				continue
			}
			events.EmitConnectionLog(p.appCtx, p.ID, events.LogErr, nowMillis(),
				fmt.Sprintf("process[%s]: %s", spec, line))
		}
		p.logScanErr(fmt.Sprintf("process[%s] stderr", spec), scanner.Err())
	}()

	ctx, cancel := context.WithCancel(p.ctx)
	mon := &procMonitor{cancel: cancel, refs: 1}
	p.procMon[spec] = mon

	go func() {
		defer logbook.Recover("pane.processMonitor")
		defer func() {
			_ = sess.Close()
			p.procMu.Lock()
			// Compare by identity, not key: if this spec was stopped and
			// re-started within our shutdown window, the map now holds a
			// different (live) monitor we must not clobber.
			if p.procMon[spec] == mon {
				mon.dead = true
			}
			p.procMu.Unlock()
		}()
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 0, 4096), 16384)
		for scanner.Scan() {
			if ctx.Err() != nil {
				return
			}
			line := strings.TrimSpace(scanner.Text())
			if !strings.HasPrefix(line, "p1 ") {
				continue
			}
			s, ok := parseProcessLine(line)
			if !ok {
				continue
			}
			s.Spec = spec
			events.EmitProcessSample(p.appCtx, p.ID, s)
			if terminal && !s.Alive {
				return // final tick — the PID has exited
			}
		}
		p.logScanErr(fmt.Sprintf("process[%s]", spec), scanner.Err())
	}()
	return nil
}

// StopProcessMonitor / StopProcessMonitorByCommand decrement the target's
// consumer refcount and tear the stream down once it hits zero.
func (p *Pane) StopProcessMonitor(pid int) { p.stopProcessMonitor(pidSpec(pid)) }

func (p *Pane) StopProcessMonitorByCommand(command string) { p.stopProcessMonitor(cmdSpec(command)) }

func (p *Pane) stopProcessMonitor(spec string) {
	p.procMu.Lock()
	defer p.procMu.Unlock()
	m, ok := p.procMon[spec]
	if !ok {
		return
	}
	if m.refs > 0 {
		m.refs--
	}
	if m.refs > 0 {
		return
	}
	if m.cancel != nil {
		m.cancel()
	}
	delete(p.procMon, spec)
}

// stopAllProcessMonitors cancels every live per-process stream. Called from
// pane.Close so no goroutine outlives the pane.
func (p *Pane) stopAllProcessMonitors() {
	p.procMu.Lock()
	defer p.procMu.Unlock()
	for spec, m := range p.procMon {
		if m.cancel != nil {
			m.cancel()
		}
		delete(p.procMon, spec)
	}
}

// activeProcessSpecs snapshots the specs + refcounts of every tracked
// process monitor, for re-arming after a reconnect. It deliberately
// includes entries marked dead: a connection drop kills the monitor's
// goroutine (setting dead) but leaves the entry in the map as the
// still-wanted intent — those are exactly the ones to re-arm.
func (p *Pane) activeProcessSpecs() map[string]int {
	p.procMu.Lock()
	defer p.procMu.Unlock()
	if len(p.procMon) == 0 {
		return nil
	}
	out := make(map[string]int, len(p.procMon))
	for spec, m := range p.procMon {
		out[spec] = m.refs
	}
	return out
}

// restartProcessMonitor relaunches a monitor against the new connection
// after a reconnect, rebuilding its poller from the spec and restoring the
// refcount that was live before the drop. Any stale entry for the spec is
// dropped first so the launch isn't mistaken for a refcount bump on a dead
// monitor.
func (p *Pane) restartProcessMonitor(spec string, refs int) error {
	osFamily := p.cachedOSFamily()
	var startCmd, stdinScript string
	var terminal bool
	if rest, ok := strings.CutPrefix(spec, "pid:"); ok {
		pid, err := strconv.Atoi(rest)
		if err != nil {
			return fmt.Errorf("process: bad pid spec %q", spec)
		}
		startCmd, stdinScript = processStreamCmd(osFamily, pid)
		terminal = true
	} else if rest, ok := strings.CutPrefix(spec, "cmd:"); ok {
		startCmd, stdinScript = processCommandStreamCmd(osFamily, rest)
		terminal = false
	} else {
		return fmt.Errorf("process: unrecognized spec %q", spec)
	}

	// Drop any stale entry so startProcessMonitor relaunches rather than
	// bumping a dead monitor's refcount.
	p.procMu.Lock()
	if m, ok := p.procMon[spec]; ok {
		if m.cancel != nil {
			m.cancel()
		}
		delete(p.procMon, spec)
	}
	p.procMu.Unlock()

	if err := p.startProcessMonitor(spec, terminal, startCmd, stdinScript); err != nil {
		return err
	}
	// startProcessMonitor sets refs=1; restore the count from before the drop.
	p.procMu.Lock()
	if m, ok := p.procMon[spec]; ok {
		m.refs = refs
	}
	p.procMu.Unlock()
	return nil
}
