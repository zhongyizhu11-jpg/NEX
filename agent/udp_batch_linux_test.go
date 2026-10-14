//go:build linux

package main

import (
	"errors"
	"net"
	"net/netip"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"
)

// 交给内核的 struct mmsghdr 布局必须和 C 的一样：msghdr 后面一个 uint32，再补齐到指针对齐
// （64 位 64 字节、32 位 32 字节）。
func TestUDPMmsghdrLayoutMatchesKernel(t *testing.T) {
	var h udpMmsghdr
	if got, want := unsafe.Sizeof(h), unsafe.Sizeof(unix.Msghdr{})+unsafe.Sizeof(uintptr(0)); got != want {
		t.Fatalf("sizeof(mmsghdr) = %d, want %d", got, want)
	}
	if got, want := unsafe.Offsetof(h.len), unsafe.Sizeof(unix.Msghdr{}); got != want {
		t.Fatalf("offsetof(msg_len) = %d, want %d", got, want)
	}
}

func TestUDPSockaddrConversions(t *testing.T) {
	var name unix.RawSockaddrInet6
	// IPv4 套接字、IPv4 地址。
	v4 := netip.MustParseAddrPort("198.51.100.7:53")
	length, ok := udpAddrPortToSockaddr(&name, false, v4)
	if !ok || length != unix.SizeofSockaddrInet4 {
		t.Fatalf("v4 marshal: ok=%v len=%d", ok, length)
	}
	if got, ok := udpSockaddrToAddrPort(&name, length); !ok || got != v4 {
		t.Fatalf("v4 round trip = %v (%v)", got, ok)
	}
	// IPv4 套接字收到 ::ffff: 形式的地址要还原成 IPv4；纯 IPv6 地址发不出去。
	if _, ok := udpAddrPortToSockaddr(&name, false, netip.MustParseAddrPort("[::ffff:198.51.100.7]:53")); !ok {
		t.Fatal("mapped v4 must be sendable on a v4 socket")
	}
	if got, _ := udpSockaddrToAddrPort(&name, unix.SizeofSockaddrInet4); got != v4 {
		t.Fatalf("mapped v4 on v4 socket = %v", got)
	}
	if _, ok := udpAddrPortToSockaddr(&name, false, netip.MustParseAddrPort("[2001:db8::1]:443")); ok {
		t.Fatal("pure v6 must not be sendable on a v4 socket")
	}
	// IPv6（双栈）套接字发给 IPv4 地址写成 ::ffff:a.b.c.d，和 net 包一样。
	length, ok = udpAddrPortToSockaddr(&name, true, v4)
	if !ok || length != unix.SizeofSockaddrInet6 {
		t.Fatalf("v4 on v6 socket: ok=%v len=%d", ok, length)
	}
	if got, _ := udpSockaddrToAddrPort(&name, length); got != netip.MustParseAddrPort("[::ffff:198.51.100.7]:53") {
		t.Fatalf("v4 on v6 socket round trip = %v", got)
	}
	// 带 zone 的链路本地地址：zone 换成接口编号再换回来。
	lo, err := net.InterfaceByName("lo")
	if err != nil {
		t.Skip("no lo interface")
	}
	zoned := netip.MustParseAddrPort("[fe80::1%lo]:5353")
	length, ok = udpAddrPortToSockaddr(&name, true, zoned)
	if !ok || name.Scope_id != uint32(lo.Index) {
		t.Fatalf("zone lo -> scope %d, want %d (ok=%v)", name.Scope_id, lo.Index, ok)
	}
	if got, _ := udpSockaddrToAddrPort(&name, length); got != zoned {
		t.Fatalf("zoned round trip = %v, want %v", got, zoned)
	}
	// 数字 zone 直接当编号。
	if _, ok := udpAddrPortToSockaddr(&name, true, netip.MustParseAddrPort("[fe80::1%7]:1")); !ok || name.Scope_id != 7 {
		t.Fatalf("numeric zone -> scope %d", name.Scope_id)
	}
}

// 往批次里填一个待发的包（测试用）。
func (b *udpBatch) stage(i int, payload []byte) {
	copy(b.slab[i*udpBatchStride:], payload)
	b.hdrs[i].len = uint32(len(payload))
}

func TestUDPBatchSendRecvLoopback(t *testing.T) {
	left, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer left.Close()
	right, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer right.Close()
	leftBatch, rightBatch := newUDPBatchConn(left), newUDPBatchConn(right)
	if leftBatch == nil || rightBatch == nil {
		t.Fatal("batch handles not created for UDPConn")
	}
	leftAddr := left.LocalAddr().(*net.UDPAddr).AddrPort()
	rightAddr := right.LocalAddr().(*net.UDPAddr).AddrPort()

	// sendTo：一批 5 个大小不一的包（含最大载荷）发到同一个地址。
	payloads := [][]byte{{1}, make([]byte, 1400), make([]byte, 65507), {4, 5, 6}, make([]byte, 9000)}
	for i := range payloads {
		for j := range payloads[i] {
			payloads[i][j] = byte(i*31 + j)
		}
	}
	out := getUDPBatch()
	for i, payload := range payloads {
		out.stage(i, payload)
	}
	if err := leftBatch.sendTo(out, len(payloads), rightAddr); err != nil {
		t.Fatalf("sendTo: %v", err)
	}
	putUDPBatch(out)
	received := map[int][]byte{}
	_ = right.SetReadDeadline(time.Now().Add(2 * time.Second))
	for len(received) < len(payloads) {
		in, n, err := rightBatch.recv()
		if err != nil {
			t.Fatalf("recv: %v (got %d so far)", err, len(received))
		}
		for i := 0; i < n; i++ {
			if in.addr(i) != leftAddr {
				t.Fatalf("packet from %v, want %v", in.addr(i), leftAddr)
			}
			received[len(in.packet(i))] = append([]byte(nil), in.packet(i)...)
		}
		putUDPBatch(in)
	}
	for i, payload := range payloads {
		if got := received[len(payload)]; string(got) != string(payload) {
			t.Fatalf("payload %d (%d bytes) mismatched", i, len(payload))
		}
	}

	// send：已连接套接字上一批写出去。
	conn, err := net.DialUDP("udp", nil, net.UDPAddrFromAddrPort(rightAddr))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	connBatch := newUDPBatchConn(conn)
	out = getUDPBatch()
	out.stage(0, []byte("ignored"))
	out.stage(1, []byte("one"))
	out.stage(2, []byte("two"))
	if err := connBatch.send(out, 1, 3); err != nil {
		t.Fatalf("send: %v", err)
	}
	putUDPBatch(out)
	got := map[string]bool{}
	for len(got) < 2 {
		in, n, err := rightBatch.recv()
		if err != nil {
			t.Fatalf("recv connected: %v", err)
		}
		for i := 0; i < n; i++ {
			if in.addr(i) != conn.LocalAddr().(*net.UDPAddr).AddrPort() {
				t.Fatalf("connected packet from %v", in.addr(i))
			}
			got[string(in.packet(i))] = true
		}
		putUDPBatch(in)
	}
	if !got["one"] || !got["two"] || got["ignored"] {
		t.Fatalf("connected send delivered %v", got)
	}

	// 读超时和关闭的错误和普通 Read 一样。
	_ = right.SetReadDeadline(time.Now().Add(20 * time.Millisecond))
	if _, _, err := rightBatch.recv(); err == nil {
		t.Fatal("recv after deadline returned no error")
	} else {
		var netErr net.Error
		if !errors.As(err, &netErr) || !netErr.Timeout() {
			t.Fatalf("deadline error %v is not a timeout", err)
		}
	}
	_ = right.Close()
	if _, _, err := rightBatch.recv(); !errors.Is(err, net.ErrClosed) {
		t.Fatalf("recv after close = %v, want net.ErrClosed", err)
	}
	if err := leftBatch.sendTo(getUDPBatch(), 0, rightAddr); err != nil {
		t.Fatalf("empty sendTo: %v", err)
	}
}

// 大批次借光了就退到单包批次，收发照常。
func TestUDPBatchFallsBackToSinglePacketWhenPoolExhausted(t *testing.T) {
	udpBatchMu.Lock()
	savedFree, savedCount := udpBatchFree, udpBatchCount
	udpBatchFree, udpBatchCount = nil, udpBatchPoolLimit
	udpBatchMu.Unlock()
	defer func() {
		udpBatchMu.Lock()
		udpBatchFree, udpBatchCount = savedFree, savedCount
		udpBatchMu.Unlock()
	}()
	b := getUDPBatch()
	if b.mapped || len(b.hdrs) != 1 {
		t.Fatalf("exhausted pool handed out mapped=%v hdrs=%d", b.mapped, len(b.hdrs))
	}
	putUDPBatch(b)

	left, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer left.Close()
	right, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer right.Close()
	rightAddr := right.LocalAddr().(*net.UDPAddr).AddrPort()
	for i := 0; i < 3; i++ {
		if _, err := left.WriteToUDPAddrPort([]byte{byte(i)}, rightAddr); err != nil {
			t.Fatal(err)
		}
	}
	rightBatch := newUDPBatchConn(right)
	_ = right.SetReadDeadline(time.Now().Add(2 * time.Second))
	seen := 0
	for seen < 3 {
		in, n, err := rightBatch.recv()
		if err != nil {
			t.Fatal(err)
		}
		if n != 1 || in.mapped {
			t.Fatalf("single-packet fallback returned n=%d mapped=%v", n, in.mapped)
		}
		seen += n
		putUDPBatch(in)
	}
}

// 关掉批量开关以后两个中继都走逐包路径（非 Linux 的路径），行为一样。
func TestUDPRelaysWorkWithBatchDisabled(t *testing.T) {
	old := udpBatchEnabled
	udpBatchEnabled = false
	defer func() { udpBatchEnabled = old }()
	echo := udpPlainEcho(t)
	failoverUDPTestSetup(t)
	spec := failoverTestSpec(failoverTestDualPort(t))
	spec.Protocol = "udp"
	spec.Targets = []failoverTarget{{TargetIP: "127.0.0.1", TargetPort: echo.Port}, {TargetIP: "127.0.0.1", TargetPort: echo.Port}}
	_, addr := startUDPFailoverForTest(t, 950104, 65104, spec)
	udpRelayExactness(t, addr, 8, 50, 8)
	udpRelayExactness(t, startGuardUDPRelayForTest(t, 61, echo, nil), 8, 50, 8)
}
