package main

// On-demand diagnostics: a loopback pprof server exposing goroutine, CPU, heap,
// and other profiles at http://127.0.0.1:<port>/debug/pprof/ while the app runs.
// OFF by default — it's an opt-in debug endpoint, not something a shipped SSH
// client should leave listening. Enable with HOPPERTERM_PPROF=1 (port 6060) or
// HOPPERTERM_PPROF=<port>; it always binds loopback only (never reachable off
// the machine).
//
// It exists so a profile can be pulled WITHOUT restarting the app — a restart
// clears accumulated runtime state and would destroy the evidence for any
// slow-building issue (the trap that made the original keepalive CPU-spin
// investigation drag out). Once enabled and running:
//
//	go tool pprof -top http://127.0.0.1:6060/debug/pprof/profile?seconds=20   # CPU
//	curl http://127.0.0.1:6060/debug/pprof/goroutine?debug=1                  # goroutines

import (
	"net/http"
	_ "net/http/pprof" // registers /debug/pprof/* on http.DefaultServeMux
	"os"
	"strings"

	"hopperxterm/logbook"
)

// startDiagnostics starts the loopback pprof server unless disabled. Non-blocking;
// the listener goroutine lives for the app's lifetime.
func startDiagnostics() {
	v := strings.TrimSpace(os.Getenv("HOPPERTERM_PPROF"))
	if v == "" || v == "0" {
		return // opt-in: off unless HOPPERTERM_PPROF is explicitly set
	}
	port := "6060"
	if v != "1" {
		port = v
	}
	addr := "127.0.0.1:" + port
	go func() {
		defer logbook.Recover("main.pprof")
		logbook.Info("diag: pprof listening on http://" + addr + "/debug/pprof/ (loopback only)")
		// nil handler → http.DefaultServeMux, where the blank net/http/pprof
		// import registered the /debug/pprof/* routes at init.
		if err := http.ListenAndServe(addr, nil); err != nil {
			logbook.Error("diag: pprof server exited: " + err.Error())
		}
	}()
}
