package main

import (
	"encoding/binary"
	"errors"
	"net"
	"sync"
	"testing"
	"time"
)

// fakeICMPDatagramConn 模拟内核的 ping 套接字：改写标识符、应答不带 IP 头。
type fakeICMPDatagramConn struct {
	mu      sync.Mutex
	replies [][]byte
	peer    net.IP
	ready   chan struct{}
	closed  bool
	writeTo []net.Addr
}

func newFakeICMPDatagramConn(peer net.IP) *fakeICMPDatagramConn {
	return &fakeICMPDatagramConn{peer: peer, ready: make(chan struct{}, 16)}
}

func (c *fakeICMPDatagramConn) WriteTo(p []byte, addr net.Addr) (int, error) {
	reply := append([]byte(nil), p...)
	reply[0] = 0 // echo reply
	binary.BigEndian.PutUint16(reply[4:6], 0xbeef)
	c.mu.Lock()
	c.writeTo = append(c.writeTo, addr)
	// 先塞一个别的来源的应答，确认按来源过滤。
	c.replies = append(c.replies, append([]byte(nil), reply...), reply)
	c.mu.Unlock()
	c.ready <- struct{}{}
	c.ready <- struct{}{}
	return len(p), nil
}

func (c *fakeICMPDatagramConn) ReadFrom(p []byte) (int, net.Addr, error) {
	select {
	case <-c.ready:
	case <-time.After(time.Second):
		return 0, nil, errors.New("timeout")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	reply := c.replies[0]
	c.replies = c.replies[1:]
	from := c.peer
	if len(c.replies)%2 == 1 {
		from = net.IPv4(192, 0, 2, 99)
	}
	return copy(p, reply), &net.UDPAddr{IP: from}, nil
}

func (c *fakeICMPDatagramConn) Close() error                       { c.closed = true; return nil }
func (c *fakeICMPDatagramConn) LocalAddr() net.Addr                { return &net.UDPAddr{} }
func (c *fakeICMPDatagramConn) SetDeadline(t time.Time) error      { return nil }
func (c *fakeICMPDatagramConn) SetReadDeadline(t time.Time) error  { return nil }
func (c *fakeICMPDatagramConn) SetWriteDeadline(t time.Time) error { return nil }

// 没有原始套接字权限时改用数据报 ICMP，而不是直接退到 fork 外部 ping。
func TestNativePingFallsBackToDatagramSocket(t *testing.T) {
	peer := net.IPv4(198, 51, 100, 9).To4()
	fake := newFakeICMPDatagramConn(peer)
	oldRaw, oldDgram := nativePingListenRaw, nativePingListenDatagram
	nativePingListenRaw = func() (net.PacketConn, error) { return nil, errors.New("operation not permitted") }
	nativePingListenDatagram = func(ipv6 bool) (net.PacketConn, error) {
		if ipv6 {
			return nil, errors.New("unexpected ipv6")
		}
		return fake, nil
	}
	defer func() { nativePingListenRaw, nativePingListenDatagram = oldRaw, oldDgram }()

	latency, ok, err, sent, successes := nativePingIPDetailed(peer, time.Second, 2)
	if err != nil || !ok {
		t.Fatalf("datagram ping failed: ok=%v err=%v", ok, err)
	}
	if latency < 1 || sent != 2 || successes != 2 {
		t.Fatalf("latency=%d sent=%d successes=%d", latency, sent, successes)
	}
	if !fake.closed {
		t.Fatal("datagram socket not closed")
	}
	if dst, ok := fake.writeTo[0].(*net.UDPAddr); !ok || !dst.IP.Equal(peer) {
		t.Fatalf("datagram ping wrote to %v", fake.writeTo[0])
	}
}

func TestNativePingReportsErrorWhenNoICMPSocketAllowed(t *testing.T) {
	oldRaw, oldDgram := nativePingListenRaw, nativePingListenDatagram
	nativePingListenRaw = func() (net.PacketConn, error) { return nil, errors.New("raw denied") }
	nativePingListenDatagram = func(bool) (net.PacketConn, error) { return nil, errors.New("dgram denied") }
	defer func() { nativePingListenRaw, nativePingListenDatagram = oldRaw, oldDgram }()
	// 出错时调用方（pingLatencyDetailed）回退到外部 ping 命令。
	if _, _, err, _, _ := nativePingIPDetailed(net.IPv4(127, 0, 0, 1), 100*time.Millisecond, 1); err == nil {
		t.Fatal("expected an error so the caller falls back to the ping command")
	}
	if _, _, err, _, _ := nativePingIPDetailed(net.ParseIP("::1"), 100*time.Millisecond, 1); err == nil {
		t.Fatal("expected an ipv6 error so the caller falls back to the ping command")
	}
}

// 真实的 ping 套接字：环境不允许（ping_group_range 不含本进程的组）时跳过。
func TestListenICMPDatagramLoopback(t *testing.T) {
	conn, err := listenICMPDatagram(false)
	if err != nil {
		t.Skipf("datagram icmp not permitted here: %v", err)
	}
	defer conn.Close()
	latency, ok, err, _, _ := nativePingExchange(conn, &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)}, net.IPv4(127, 0, 0, 1).To4(), 8, 0, false, 2*time.Second, 1)
	if err != nil || !ok || latency < 1 {
		t.Fatalf("loopback datagram ping: latency=%d ok=%v err=%v", latency, ok, err)
	}
}
