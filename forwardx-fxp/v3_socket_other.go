//go:build !linux

package main

import "net"

func setTCPNotSentLowat(conn net.Conn, bytes int) error { return nil }
