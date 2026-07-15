package main

// On-demand diagnostics: a loopback pprof server exposing goroutine, CPU, heap,
// and other profiles at http://127.0.0.1:6060/debug/pprof/ while the app runs.
// On by default, bound to loopback only (never reachable off the machine);
// disable with HOPPERTERM_PPROF=0, or choose a port with HOPPERTERM_PPROF=<port>.
//
// It exists so a profile can be pulled WITHOUT restarting the app — a restart
// clears accumulated runtime state and would destroy the evidence for any
// slow-building issue (the trap that made the original keepalive CPU-spin
// investigation drag out). Example once it's running:
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
	if v == "0" {
		logbook.Info("diag: pprof disabled (HOPPERTERM_PPROF=0)")
		return
	}
	port := "6060"
	if v != "" && v != "1" {
		port = v
	}
	addr := "127.0.0.1:" + port
	go func() {
		defer logbook.Recover("main.pprof")
		logbook.Info("diag: pprof listening on http://" + addr + "/debug/pprof/ (loopback only; HOPPERTERM_PPROF=0 to disable)")
		// nil handler → http.DefaultServeMux, where the blank net/http/pprof
		// import registered the /debug/pprof/* routes at init.
		if err := http.ListenAndServe(addr, nil); err != nil {
			logbook.Error("diag: pprof server exited: " + err.Error())
		}
	}()
}
