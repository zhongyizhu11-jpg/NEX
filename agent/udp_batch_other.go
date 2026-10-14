//go:build !linux

package main

import (
	"errors"
	"net/netip"
	"sync/atomic"
)

// 其他系统没有 recvmmsg / sendmmsg：newUDPBatchConn 永远返回 nil，UDP 中继走逐包路径。
// 下面的类型和方法只是让共用的中继代码能编译，不会被调到。
var udpBatchEnabled = false

var (
	udpBatchRecvCalls   atomic.Int64
	udpBatchRecvPackets atomic.Int64
)

type udpBatchConn struct{}

type udpBatch struct{}

func newUDPBatchConn(conn any) *udpBatchConn { return nil }

func putUDPBatch(b *udpBatch) {}

var errUDPBatchUnsupported = errors.New("udp batch: unsupported on this platform")

func (c *udpBatchConn) recv() (*udpBatch, int, error) { return nil, 0, errUDPBatchUnsupported }

func (c *udpBatchConn) sendTo(b *udpBatch, count int, dst netip.AddrPort) error {
	return errUDPBatchUnsupported
}

func (c *udpBatchConn) send(b *udpBatch, from int, to int) error { return errUDPBatchUnsupported }

func (b *udpBatch) packet(i int) []byte { return nil }

func (b *udpBatch) addr(i int) netip.AddrPort { return netip.AddrPort{} }
