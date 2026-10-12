//go:build !linux

package sockmap

import (
	"net"
	"time"
)

// Relay 在非 Linux 上从不接管。
func Relay(accepted, dialed net.Conn, linger time.Duration) (Result, bool) { return Result{}, false }

// Status 在非 Linux 上固定是 unsupported。
func Status() string { return "unsupported" }

// Snapshot 在非 Linux 上恒为零。
func Snapshot() Stats { return Stats{} }
