//go:build !linux

package main

import (
	"net"
	"strconv"
	"syscall"
)

func listenTCP(host string, port int, _ bool) (net.Listener, error) {
	return net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(port)))
}

// tcpFastOpenDialControl 在 Linux 以外不做任何事：拨号端的 TFO 只在 Linux 上开。
func tcpFastOpenDialControl(bool) func(network, address string, c syscall.RawConn) error {
	return nil
}
