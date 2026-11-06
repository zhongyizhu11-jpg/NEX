//go:build !linux

package main

import (
	"net"
	"net/netip"
)

// 非 Linux：没有 recvmmsg / sendmmsg / GSO / GRO，读循环直接读 *net.UDPConn，发送逐包。

const fxpUDPBatchSize = 64

// 和 Linux 上同名的开关一样（测试里会改它们），这里没有作用。
var (
	fxpUDPBatchEnabled = true
	fxpUDPGROEnabled   = true
)

type fxpUDPPacketReader interface {
	ReadFromUDPAddrPort(b []byte) (int, netip.AddrPort, error)
}

func newFXPUDPBatchReader(conn *net.UDPConn, _ bool, _ bool) fxpUDPPacketReader { return conn }

func closeFXPUDPPacketReader(fxpUDPPacketReader) {}

func fxpUDPReaderBuffered(fxpUDPPacketReader) bool { return false }

type fxpUDPBatchSender struct{}

func newFXPUDPBatchSender(*net.UDPConn) *fxpUDPBatchSender { return nil }

func (s *fxpUDPBatchSender) full() bool                   { return true }
func (s *fxpUDPBatchSender) pending() int                 { return 0 }
func (s *fxpUDPBatchSender) add([]byte)                   {}
func (s *fxpUDPBatchSender) flushTo(netip.AddrPort) error { return nil }
func (s *fxpUDPBatchSender) flushConnected() error        { return nil }
