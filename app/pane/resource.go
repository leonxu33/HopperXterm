package pane

import (
	"bufio"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"hopperxterm/events"
	"hopperxterm/logbook"
	"hopperxterm/transport"
)

// resourceScript is the one-shot bash poller. It runs forever inside a
// single SSH `exec` channel and prints one space-separated record per
// second to stdout. The frontend turns the bytes into ResourceSample
// events.
//
// Format per line (all fields, in order):
//
//	v3 ts_ms cpuPct memUsedKB memTotalKB diskRdKBs diskWrKBs netRxKBs netTxKBs
//	   uptime loadAvg1 diskUsedKB diskTotalKB memCachedKB memBuffersKB
//	   dfTextB64 whoTextB64 userB64
//
// (v2 is the predecessor format without the last 5 fields, still
// parsed for older servers.)
//
// Rates are computed in-script from /proc deltas so the frontend gets
// stable numbers without doing its own diff. Disk usage and the
// multi-line `df -h` / `who` snapshots are refreshed every 10 ticks
// since they change slowly and forking once per second is wasteful.
// The free-form blobs are base64-encoded to fit one whitespace-safe
// token per field.
const resourceScript = `
prev_diskr=0; prev_diskw=0
prev_netr=0; prev_nett=0
prev_total=0; prev_idle=0
du_total=0; du_used=0
df_b64="-"
who_b64="-"
user_b64="-"
tick=0
first=1
while :; do
  # /proc/stat first line: cpu user nice system idle iowait irq softirq steal ...
  read _ u n s i io ir sr st _ < /proc/stat
  total=$((u+n+s+i+io+ir+sr+st))
  idle=$((i+io))
  if [ "$first" = "1" ]; then
    cpu_pct=0
  else
    dt=$((total-prev_total))
    di=$((idle-prev_idle))
    if [ "$dt" -gt 0 ]; then
      cpu_pct=$(( (100*(dt-di)) / dt ))
    else
      cpu_pct=0
    fi
  fi
  prev_total=$total
  prev_idle=$idle

  # /proc/meminfo: MemTotal, MemFree, MemAvailable, Buffers, Cached.
  # SwapCached: would never match here because the case glob is anchored.
  # MemAvailable only exists on kernels >= 3.14; on older remotes (e.g.
  # RHEL/CentOS 6, kernel 2.6.32) the field is absent so ma stays 0 and
  # mt-ma would report memory as 100% used. Fall back to the classic
  # free+buffers+cached estimate (what the free tool used pre-3.14).
  mt=0; mf=0; ma=0; mb=0; mc=0
  while read k v _; do
    case "$k" in
      MemTotal:) mt=$v;;
      MemFree:) mf=$v;;
      MemAvailable:) ma=$v;;
      Buffers:) mb=$v;;
      Cached:) mc=$v;;
    esac
  done < /proc/meminfo
  [ "$ma" = "0" ] && ma=$((mf+mb+mc))
  mu=$((mt-ma))

  # /proc/diskstats: skip loop/ram, sum reads (col 6) and writes (col 10) of physical disks
  dr=0; dw=0
  while read line; do
    set -- $line
    name=$3
    case "$name" in loop*|ram*|fd*|sr*) continue;; esac
    dr=$((dr+${6}))
    dw=$((dw+${10}))
  done < /proc/diskstats
  # diskstats reads/writes are in 512-byte sectors. Convert to KiB.
  dr=$((dr/2)); dw=$((dw/2))

  # /proc/net/dev: sum non-loopback rx/tx bytes
  nr=0; nt=0
  while read line; do
    case "$line" in *Inter*|*face*) continue;; esac
    iface=$(echo "$line" | cut -d: -f1 | tr -d ' ')
    if [ "$iface" = "lo" ] || [ -z "$iface" ]; then continue; fi
    set -- $(echo "$line" | cut -d: -f2)
    nr=$((nr+$1)); nt=$((nt+$9))
  done < /proc/net/dev
  nr=$((nr/1024)); nt=$((nt/1024))

  if [ "$first" = "1" ]; then
    drk=0; dwk=0; nrk=0; ntk=0
  else
    drk=$((dr-prev_diskr)); dwk=$((dw-prev_diskw))
    nrk=$((nr-prev_netr)); ntk=$((nt-prev_nett))
    [ "$drk" -lt 0 ] && drk=0
    [ "$dwk" -lt 0 ] && dwk=0
    [ "$nrk" -lt 0 ] && nrk=0
    [ "$ntk" -lt 0 ] && ntk=0
  fi
  prev_diskr=$dr; prev_diskw=$dw
  prev_netr=$nr; prev_nett=$nt

  # uptime
  up=$(awk '{print int($1)}' /proc/uptime 2>/dev/null)
  # loadavg
  la=$(awk '{print $1}' /proc/loadavg 2>/dev/null)

  ts=$(date +%s%3N 2>/dev/null)
  [ -z "$ts" ] && ts=$(($(date +%s)*1000))

  # Heavy stuff (forks) every 10 ticks: df -kP for the numeric usage,
  # df -h / who / user for the tooltip blobs. base64 piped through tr
  # so the output is one whitespace-safe token even on BusyBox where
  # 'base64 -w0' isn't supported.
  if [ "$first" = "1" ] || [ "$((tick % 10))" = "0" ]; then
    df_line=$(df -kP / 2>/dev/null | awk 'NR==2 {print $2" "$3}')
    if [ -n "$df_line" ]; then
      du_total=${df_line% *}
      du_used=${df_line#* }
    fi
    dft=$(df -h 2>/dev/null | base64 2>/dev/null | tr -d '\n' 2>/dev/null)
    [ -n "$dft" ] && df_b64=$dft
    who_raw=$(who 2>/dev/null | base64 2>/dev/null | tr -d '\n' 2>/dev/null)
    [ -n "$who_raw" ] && who_b64=$who_raw
    u_name=${USER:-$(id -un 2>/dev/null)}
    ub=$(printf '%s' "$u_name" | base64 2>/dev/null | tr -d '\n' 2>/dev/null)
    [ -n "$ub" ] && user_b64=$ub
  fi
  tick=$((tick+1))

  echo "v3 $ts $cpu_pct $mu $mt $drk $dwk $nrk $ntk $up $la $du_used $du_total $mc $mb $df_b64 $who_b64 $user_b64"
  first=0
  sleep 1
done
`

// darwinResourceScript is the macOS counterpart to resourceScript. macOS
// has no /proc, so it pulls the same metrics from BSD userland — top,
// sysctl, vm_stat, ioreg, netstat, df — and emits the identical v3 line
// so the parser and frontend need no changes.
//
// Cadence: `iostat -c 2` takes ~1s (its own inter-sample delay) and
// yields the real CPU-usage delta in its second/last row, so it both
// measures CPU and paces the loop — there is no separate `sleep 1`.
// Disk and network rates are computed from cumulative counters (ioreg
// byte totals, netstat -ibn) the same delta-per-tick way as Linux.
//
// Validated on a real Apple-silicon Mac mini (macOS, 16 GB) over a
// non-PTY SSH exec. Two tools that the first draft used had to change
// because they HANG without a controlling terminal (which this exec has
// none of): `top -l 2` (replaced by `iostat`) and `netstat -ib` (now
// `-ibn` — without `-n` it blocks on DNS/name resolution). Both hangs
// presented as "one sample then frozen / mostly no data" in the UI.
const darwinResourceScript = `
prev_diskr=0; prev_diskw=0
prev_netr=0; prev_nett=0
du_total=0; du_used=0
df_b64="-"; who_b64="-"; user_b64="-"
tick=0; first=1
pagesize=$(sysctl -n hw.pagesize 2>/dev/null); [ -z "$pagesize" ] && pagesize=4096
memtotal_kb=$(( $(sysctl -n hw.memsize 2>/dev/null) / 1024 ))
# kern.boottime prints "{ sec = 1780098269, usec = 346309 } ...". Anchor the
# capture on the literal "{" so the greedy ".*" can't slide the match into the
# "usec = " token (whose "sec = " substring would otherwise capture usec, not
# sec — making boot ~0 and uptime read as ~now, i.e. tens of thousands of days).
boot=$(sysctl -n kern.boottime 2>/dev/null | sed -n 's/.*{ *sec *= *\([0-9]*\).*/\1/p')
case "$boot" in ''|*[!0-9]*) boot=0;; esac
while :; do
  # CPU: iostat -c 2 prints two samples ~1s apart (this also paces the
  # loop — there is no separate sleep). The last row is the inter-sample
  # delta; its idle ("id") column is the 4th-from-last field, since "id"
  # is always followed by the 1m/5m/15m load averages — so $(NF-3) is
  # correct no matter how many disks iostat lists. (top -l 2 was used
  # here originally but hangs with no controlling TTY.)
  idle=$(iostat -c 2 2>/dev/null | awk 'END{print $(NF-3)}')
  if [ -n "$idle" ]; then
    cpu_pct=$(awk -v i="$idle" 'BEGIN{v=100-i; if(v<0)v=0; printf "%d", v}')
  else
    cpu_pct=0
  fi

  # Memory from vm_stat: used = (active + wired + compressed) pages.
  vm=$(vm_stat 2>/dev/null)
  active=$(echo "$vm" | awk '/Pages active/{gsub(/\./,"",$NF);print $NF}')
  wired=$(echo "$vm" | awk '/Pages wired down/{gsub(/\./,"",$NF);print $NF}')
  compressed=$(echo "$vm" | awk '/Pages occupied by compressor/{gsub(/\./,"",$NF);print $NF}')
  filebacked=$(echo "$vm" | awk '/File-backed pages/{gsub(/\./,"",$NF);print $NF}')
  [ -z "$active" ] && active=0
  [ -z "$wired" ] && wired=0
  [ -z "$compressed" ] && compressed=0
  [ -z "$filebacked" ] && filebacked=0
  mt=$memtotal_kb
  mu=$(( (active + wired + compressed) * pagesize / 1024 ))
  mc=$(( filebacked * pagesize / 1024 ))
  mb=0

  # Disk cumulative bytes from ioreg block-storage statistics → KiB.
  io=$(ioreg -c IOBlockStorageDriver -r -w0 2>/dev/null)
  rb=$(echo "$io" | sed -n 's/.*"Bytes (Read)"=\([0-9]*\).*/\1/p' | awk '{s+=$1} END{print s+0}')
  wb=$(echo "$io" | sed -n 's/.*"Bytes (Write)"=\([0-9]*\).*/\1/p' | awk '{s+=$1} END{print s+0}')
  dr=$(( rb / 1024 )); dw=$(( wb / 1024 ))

  # Net cumulative bytes from netstat -ibn; one row per iface (skip lo and
  # the per-address duplicate rows by taking the first row per name). The
  # -n is REQUIRED: without it netstat does DNS/name resolution and blocks
  # for a long time over a non-interactive session, stalling the whole loop.
  net=$(netstat -ibn 2>/dev/null)
  nr=$(echo "$net" | awk 'NR>1 && $1!~/^lo/ {if($1!=last){last=$1; s+=$7}} END{print s+0}')
  nt=$(echo "$net" | awk 'NR>1 && $1!~/^lo/ {if($1!=last){last=$1; s+=$10}} END{print s+0}')
  nr=$(( nr / 1024 )); nt=$(( nt / 1024 ))

  if [ "$first" = "1" ]; then
    drk=0; dwk=0; nrk=0; ntk=0
  else
    drk=$((dr-prev_diskr)); dwk=$((dw-prev_diskw))
    nrk=$((nr-prev_netr)); ntk=$((nt-prev_nett))
    [ "$drk" -lt 0 ] && drk=0
    [ "$dwk" -lt 0 ] && dwk=0
    [ "$nrk" -lt 0 ] && nrk=0
    [ "$ntk" -lt 0 ] && ntk=0
  fi
  prev_diskr=$dr; prev_diskw=$dw
  prev_netr=$nr; prev_nett=$nt

  now=$(date +%s)
  if [ "$boot" -gt 0 ]; then up=$((now-boot)); else up=0; fi
  la=$(sysctl -n vm.loadavg 2>/dev/null | awk '{print $2}')
  [ -z "$la" ] && la=0
  ts=$(( now * 1000 ))

  if [ "$first" = "1" ] || [ "$((tick % 10))" = "0" ]; then
    df_line=$(df -kP / 2>/dev/null | awk 'NR==2 {print $2" "$3}')
    if [ -n "$df_line" ]; then
      du_total=${df_line% *}
      du_used=${df_line#* }
    fi
    dft=$(df -h 2>/dev/null | base64 2>/dev/null | tr -d '\n' 2>/dev/null)
    [ -n "$dft" ] && df_b64=$dft
    who_raw=$(who 2>/dev/null | base64 2>/dev/null | tr -d '\n' 2>/dev/null)
    [ -n "$who_raw" ] && who_b64=$who_raw
    u_name=${USER:-$(id -un 2>/dev/null)}
    ub=$(printf '%s' "$u_name" | base64 2>/dev/null | tr -d '\n' 2>/dev/null)
    [ -n "$ub" ] && user_b64=$ub
  fi
  tick=$((tick+1))

  echo "v3 $ts $cpu_pct $mu $mt $drk $dwk $nrk $ntk $up $la $du_used $du_total $mc $mb $df_b64 $who_b64 $user_b64"
  first=0
done
`

// windowsResourceScript is the PowerShell poller for Windows OpenSSH
// remotes. Emits the identical v3 line once per second. It deliberately
// uses locale-independent CIM perf classes (NOT Get-Counter, whose
// counter-set names are localized) and emits integer-only numeric fields
// so a non-US decimal separator can never reach Go's ParseFloat/ParseInt.
// Windows has no load average, so that field is a literal 0.
//
// Fed via the windowsStdinRunner stub (script read from stdin), so it isn't
// subject to cmd.exe's command-line length limit. CRITICAL: it queries ONLY
// the Perf* CIM provider plus pure .NET — never the cimwin32 classes
// (Win32_OperatingSystem / Win32_ComputerSystem / Win32_LogicalDisk), which
// hang for many seconds — often indefinitely — over a non-PTY SSH exec on
// some Windows hosts (observed live: Win32_OperatingSystem never returned
// while the Perf* classes answered in <400ms), and that would freeze the
// whole poller before it ever printed a line. Memory total comes from .NET
// ComputerInfo (GlobalMemoryStatusEx under the hood) and disk usage from
// [System.IO.DriveInfo]; both are WMI-free. Trailing CR on each line is
// trimmed by the reader; non-"v3 " lines are ignored by the stdout scanner.
const windowsResourceScript = `$ErrorActionPreference='SilentlyContinue'
$ProgressPreference='SilentlyContinue'
Add-Type -AssemblyName Microsoft.VisualBasic
$ci = New-Object Microsoft.VisualBasic.Devices.ComputerInfo
$sd = $env:SystemDrive
$mt = [int64]($ci.TotalPhysicalMemory / 1024)
$df_b64='-'; $who_b64='-'; $user_b64='-'
$tick = 0
while($true){
  $ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  # ProcessorInformation (not PerfOS_Processor) so _Total spans all
  # processor groups on >64-logical-CPU servers. PercentProcessorTime
  # (busy-time fraction, 0-100 across all cores), NOT PercentProcessorUtility
  # — the latter is frequency-weighted and would read higher than the
  # Linux/macOS pollers for the same real load.
  $cpu = [int]((Get-CimInstance Win32_PerfFormattedData_Counters_ProcessorInformation -Filter "Name='_Total'").PercentProcessorTime)
  $mem = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory
  $mf = [int64]$mem.AvailableKBytes
  $mu = $mt - $mf
  $mc = [int64]($mem.CacheBytes / 1024)
  $disk = Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter "Name='_Total'"
  $drk = [int64]([double]$disk.DiskReadBytesPersec / 1024)
  $dwk = [int64]([double]$disk.DiskWriteBytesPersec / 1024)
  $nrk = [double]0; $ntk = [double]0
  foreach($n in (Get-CimInstance Win32_PerfFormattedData_Tcpip_NetworkInterface)){
    $nrk += [double]$n.BytesReceivedPersec
    $ntk += [double]$n.BytesSentPersec
  }
  $nrk = [int64]($nrk / 1024); $ntk = [int64]($ntk / 1024)
  $up = [int64]((Get-CimInstance Win32_PerfFormattedData_PerfOS_System).SystemUpTime)
  $duUsed = 0; $duTotal = 0
  foreach($d in [System.IO.DriveInfo]::GetDrives()){
    if($d.IsReady -and $d.TotalSize -gt 0 -and $d.Name.TrimEnd('\') -eq $sd){
      $duTotal = [int64]($d.TotalSize / 1024)
      $duUsed = [int64](($d.TotalSize - $d.TotalFreeSpace) / 1024)
    }
  }
  if($tick % 10 -eq 0){
    $dfLines = @('Filesystem Size Used Avail Use% Mounted')
    foreach($d in [System.IO.DriveInfo]::GetDrives()){
      if($d.DriveType -eq 'Fixed' -and $d.IsReady -and $d.TotalSize -gt 0){
        $used = $d.TotalSize - $d.TotalFreeSpace
        $pct = [int](100 * $used / $d.TotalSize)
        $nm = $d.Name.TrimEnd('\')
        $dfLines += ('{0} {1}G {2}G {3}G {4}% {0}' -f $nm,[int]($d.TotalSize/1GB),[int]($used/1GB),[int]($d.TotalFreeSpace/1GB),$pct)
      }
    }
    $df_b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($dfLines -join "` + "`" + `n")))
    $whoTxt = (query user 2>$null | Out-String)
    if([string]::IsNullOrWhiteSpace($whoTxt)){ $whoTxt = $env:USERNAME }
    $who_b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($whoTxt))
    $user_b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$env:USERNAME))
    # Never emit an empty token: base64 of an empty string is "", which
    # would drop a field and push the line below 18 tokens, so the Go
    # parser would reject every sample. Fall back to '-' (parsed as "").
    if([string]::IsNullOrEmpty($df_b64)){ $df_b64 = '-' }
    if([string]::IsNullOrEmpty($who_b64)){ $who_b64 = '-' }
    if([string]::IsNullOrEmpty($user_b64)){ $user_b64 = '-' }
  }
  $tick++
  $line = "v3 $ts $cpu $mu $mt $drk $dwk $nrk $ntk $up 0 $duUsed $duTotal $mc 0 $df_b64 $who_b64 $user_b64"
  [Console]::Out.WriteLine($line)
  [Console]::Out.Flush()
  Start-Sleep -Seconds 1
}
`

// windowsStdinRunner is a tiny fixed PowerShell stub that reads the entire
// poller script off stdin and runs it. We base64-`-EncodedCommand` THIS
// (≈190 chars encoded — trivially under any limit), and feed the real
// (multi-KB) poller script on stdin where there is no length limit.
//
// Why this dance:
//   - `-EncodedCommand <whole script>` blows cmd.exe's 8191-char command-
//     line ceiling (Windows OpenSSH runs the exec through cmd.exe), failing
//     with "The command line is too long." before powershell starts.
//   - `-Command -` reads stdin but silently runs NOTHING for a *multi-line*
//     script (it executes the first statement at best), so the poller would
//     emit zero samples.
// ScriptBlock::Create parses the full ReadToEnd() text as one script, so
// multi-line constructs work, and `&` invokes it. Verified to stream 1 Hz.
const windowsStdinRunner = `& ([scriptblock]::Create([Console]::In.ReadToEnd()))`

// resourceStreamCmd returns the remote command to start and the text to
// feed on its stdin for the given OS family (as classified by
// transport.ClassifyRemoteOS). Every family pipes its actual script via
// stdin (no command-line length limit): Unix through `sh -s`, Windows
// through a short -EncodedCommand stub (windowsStdinRunner) that reads the
// script from stdin. An unknown / empty family defaults to the Linux path
// so existing behavior is preserved when classification fails.
func resourceStreamCmd(osFamily string) (cmd, stdin string) {
	switch osFamily {
	case "darwin":
		return "sh -s", darwinResourceScript
	case "windows":
		return transport.PowerShellEncodedCmd(windowsStdinRunner), windowsResourceScript
	default: // "" (classification failed/timed out) or "linux"
		return "sh -s", resourceScript
	}
}

// StartResourceMonitor opens a persistent SSH exec channel that streams
// /proc samples once per second. Lines arrive on stdout and are parsed
// into ResourceSample events.
//
// Reference-counted: every Start matches one Stop, and the monitor
// shuts down only when the count hits zero. Two consumers (status bar
// + resource panel) can independently subscribe/unsubscribe without
// stomping on each other.
func (p *Pane) StartResourceMonitor() error { return p.adjustResourceMonitor(1) }

// restartResourceMonitor relaunches the poller after a reconnect IF a
// consumer still wants it. The consumer count (resRefs) survives the drop
// — the dying poller's deferred cleanup clears only resOn, not resRefs —
// so passing delta 0 relaunches with the pre-drop count intact, and is a
// no-op when nobody was subscribed.
func (p *Pane) restartResourceMonitor() error { return p.adjustResourceMonitor(0) }

// adjustResourceMonitor adds delta to the consumer count and launches the
// host poller when there's at least one consumer and it isn't already
// running. resRefs is pure intent (frontend subscribers); it is decoupled
// from poller liveness so a connection drop that kills the poller doesn't
// erase the subscription — that's what lets a reconnect re-arm it.
func (p *Pane) adjustResourceMonitor(delta int) error {
	sh := p.currentSSH()
	if sh == nil || sh.Client == nil {
		return errors.New("pane: resource monitor requires an SSH-backed session")
	}
	p.resMu.Lock()
	defer p.resMu.Unlock()
	p.resRefs += delta
	if p.resRefs < 0 {
		p.resRefs = 0
	}
	// Already running, or nobody wants it — nothing to launch.
	if p.resOn || p.resRefs == 0 {
		return nil
	}

	// Feed the remote a poller it can actually run: /proc script on Linux,
	// BSD-tool script on macOS, PowerShell on Windows. Reuse the OS family
	// the connect-time probe already classified (avoids a redundant
	// `uname -s` round trip on the first-sample hot path); only classify
	// inline if the poller somehow starts before the probe finished.
	osFamily := p.cachedOSFamily()
	if osFamily == "" {
		osFamily = transport.ClassifyRemoteOS(sh.Client)
	}
	startCmd, stdinScript := resourceStreamCmd(osFamily)

	sess, err := sh.Client.NewSession()
	if err != nil {
		return fmt.Errorf("resource: open session: %w", err)
	}

	stdout, err := sess.StdoutPipe()
	if err != nil {
		sess.Close()
		return fmt.Errorf("resource: stdout pipe: %w", err)
	}
	stderr, err := sess.StderrPipe()
	if err != nil {
		sess.Close()
		return fmt.Errorf("resource: stderr pipe: %w", err)
	}
	// Feed the script into sh via stdin. Must be set BEFORE Start —
	// the Go SSH library refuses StdinPipe / Stdin assignment after
	// process start. Passing a strings.Reader is the canonical pattern;
	// the EOF after the script keeps the shell inside its infinite
	// while loop, not waiting for more input.
	//
	// Linux/macOS invoke /bin/sh -s (POSIX, so the poller works on
	// minimal/embedded remotes — Synology, BusyBox, Alpine — that lack
	// bash); Windows invokes the short -EncodedCommand stub that reads the
	// script from stdin (windowsStdinRunner). startCmd/stdinScript were
	// chosen by resourceStreamCmd above — all families carry the actual
	// script on stdin, verified to be delivered over Windows OpenSSH.
	sess.Stdin = strings.NewReader(stdinScript)

	if err := sess.Start(startCmd); err != nil {
		sess.Close()
		return fmt.Errorf("resource: start poller: %w", err)
	}

	// Drain stderr to a connection log so failures don't disappear.
	go func() {
		scanner := bufio.NewScanner(stderr)
		scanner.Buffer(make([]byte, 0, 4096), 16384)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" {
				continue
			}
			events.EmitConnectionLog(p.appCtx, p.ID, events.LogErr, nowMillis(), "resource: "+line)
		}
	}()

	ctx, cancel := context.WithCancel(p.ctx)
	p.resGen++
	gen := p.resGen
	p.resCancel = cancel
	p.resOn = true

	go func() {
		defer logbook.Recover("pane.resourceMonitor")
		defer func() {
			_ = sess.Close()
			p.resMu.Lock()
			// Mark the poller stopped, but DON'T touch resRefs — the
			// consumers are still subscribed; a reconnect re-arms from that
			// count. Guard on resGen so a superseded poller's exit (after a
			// re-arm bumped the generation) can't clobber the new poller.
			if p.resGen == gen {
				p.resOn = false
				p.resCancel = nil
			}
			p.resMu.Unlock()
		}()
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 0, 4096), 16384)
		for scanner.Scan() {
			if ctx.Err() != nil {
				return
			}
			line := strings.TrimSpace(scanner.Text())
			if line == "" {
				continue
			}
			if !strings.HasPrefix(line, "v3 ") &&
				!strings.HasPrefix(line, "v2 ") &&
				!strings.HasPrefix(line, "v1 ") {
				continue
			}
			s, ok := parseResourceLine(line)
			if !ok {
				continue
			}
			events.EmitResourceSample(p.appCtx, p.ID, s)
		}
	}()
	return nil
}

// StopResourceMonitor decrements the consumer reference count. The
// poller only shuts down when the count hits zero — so a panel close
// doesn't pull samples out from under a still-mounted status bar.
func (p *Pane) StopResourceMonitor() {
	p.resMu.Lock()
	if p.resRefs > 0 {
		p.resRefs--
	}
	if p.resRefs > 0 {
		p.resMu.Unlock()
		return
	}
	p.resMu.Unlock()
	p.stopResourceMonitor()
}

// stopResourceMonitor unconditionally tears down the poller. Used by
// pane.Close to ensure the goroutine exits regardless of refcount.
func (p *Pane) stopResourceMonitor() {
	p.resMu.Lock()
	defer p.resMu.Unlock()
	p.resRefs = 0
	if !p.resOn {
		return
	}
	if p.resCancel != nil {
		p.resCancel()
		p.resCancel = nil
	}
}

func parseResourceLine(line string) (events.ResourceSample, bool) {
	parts := strings.Fields(line)
	// Exact field count per version:
	//   v1: 11   v2: 13 (+diskUsedKB, diskTotalKB)
	//   v3: 18 (+memCachedKB, memBuffersKB, dfTextB64, whoTextB64, userB64)
	wantFields := map[string]int{"v1": 11, "v2": 13, "v3": 18}
	if len(parts) == 0 {
		return events.ResourceSample{}, false
	}
	if want, ok := wantFields[parts[0]]; !ok || len(parts) != want {
		return events.ResourceSample{}, false
	}
	atoi := func(s string) int64 {
		v, _ := strconv.ParseInt(s, 10, 64)
		return v
	}
	atof := func(s string) float64 {
		v, _ := strconv.ParseFloat(s, 64)
		return v
	}
	decode := func(s string) string {
		if s == "-" || s == "" {
			return ""
		}
		b, err := base64.StdEncoding.DecodeString(s)
		if err != nil {
			return ""
		}
		return string(b)
	}
	s := events.ResourceSample{
		TS:         atoi(parts[1]),
		CPUPct:     atof(parts[2]),
		MemUsedKB:  atoi(parts[3]),
		MemTotalKB: atoi(parts[4]),
		DiskRdKBs:  atof(parts[5]),
		DiskWrKBs:  atof(parts[6]),
		NetRxKBs:   atof(parts[7]),
		NetTxKBs:   atof(parts[8]),
		Uptime:     atoi(parts[9]),
		LoadAvg1:   atof(parts[10]),
	}
	if parts[0] == "v2" || parts[0] == "v3" {
		s.DiskUsedKB = atoi(parts[11])
		s.DiskTotalKB = atoi(parts[12])
	}
	if parts[0] == "v3" {
		s.MemCachedKB = atoi(parts[13])
		s.MemBuffersKB = atoi(parts[14])
		s.DfText = decode(parts[15])
		s.WhoText = decode(parts[16])
		s.User = decode(parts[17])
	}
	return s, true
}
