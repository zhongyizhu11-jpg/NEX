//go:build !linux

package main

import (
	"errors"
	"net"
)

func readSystemTCPCongestion() string { return "" }

func setTCPCongestion(conn *net.TCPConn, name string) error {
	return errors.New("per-connection congestion control is only supported on linux")
}
