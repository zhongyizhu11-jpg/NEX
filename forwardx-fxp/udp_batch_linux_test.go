//go:build linux

package main

import (
	"bytes"
	"net"
	"net/netip"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"
)

// fxpMmsghdr 必须和内核的 struct mmsghdr 一样大：msghdr 后面跟一个 unsigned int，补齐到 msghdr 的对齐。
func TestFXPMmsghdrMatchesKernelLayout(t *testing.T) {
	align := unsafe.Alignof(unix.Msghdr{})
	want := (unsafe.Sizeof(unix.Msghdr{}) + 4 + align - 1) &^ (align - 1)
	if got := unsafe.Sizeof(fxpMmsghdr{}); got != want {
		t.Fatalf("sizeof(fxpMmsghdr) = %d, want %d", got, want)
	}
}

func udpLoopbackPair(t *testing.T) (*net.UDPConn, *net.UDPConn) {
	t.Helper()
	recv, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	send, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	_ = recv.SetReadBuffer(4 << 20)
	t.Cleanup(func() { _ = recv.Close(); _ = send.Close() })
	return send, recv
}

// testWires 造一批线上包：大多数等长（能合成 GSO），中间夹几个短的。
func testWires(count int) [][]byte {
	var out [][]byte
	for i := 0; i < count; i++ {
		size := 1200
		if i%17 == 16 {
			size = 300 + i
		}
		wire := bytes.Repeat([]byte{byte(i)}, size)
		wire[0], wire[1] = byte(i>>8), byte(i)
		out = append(out, wire)
	}
	return out
}

func sendWires(t *testing.T, send *net.UDPConn, dst netip.AddrPort, wires [][]byte) {
	t.Helper()
	batch := newFXPUDPWireBatch(send)
	if batch == nil {
		t.Skip("batch send not supported here")
	}
	ws := newFXPUDPWorkspace()
	defer batch.release(ws)
	for _, wire := range wires {
		if !batch.prepare(ws) {
			if err := batch.flushTo(dst, nil); err != nil {
				t.Fatal(err)
			}
			batch.prepare(ws)
		}
		// 和 sealPacketInto 一样就地写进 ws.wire 指着的那一格。
		sealed := append(ws.wire[:0], wire...)
		batch.add(sealed)
	}
	if err := batch.flushTo(dst, nil); err != nil {
		t.Fatal(err)
	}
}

func readWires(t *testing.T, reader fxpUDPPacketReader, conn *net.UDPConn, count int) [][]byte {
	t.Helper()
	buf := make([]byte, 65535)
	var got [][]byte
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	for len(got) < count {
		n, _, err := reader.ReadFromUDPAddrPort(buf)
		if err != nil {
			t.Fatalf("read %d of %d: %v", len(got), count, err)
		}
		got = append(got, append([]byte(nil), buf[:n]...))
	}
	return got
}

// 攒批发（等长的合成 GSO）、开 GRO 收：收到的必须是一个个原样的数据报，一个不多一个不少。
func TestFXPUDPBatchRoundTripWithGSOAndGRO(t *testing.T) {
	for _, gro := range []bool{true, false} {
		send, recv := udpLoopbackPair(t)
		reader := newFXPUDPBatchReader(recv, gro, true)
		wires := testWires(150)
		gsoBefore := fxpUDPGSOMessages.Load()
		sendWires(t, send, recv.LocalAddr().(*net.UDPAddr).AddrPort(), wires)
		got := readWires(t, reader, recv, len(wires))
		closeFXPUDPPacketReader(reader)
		for i := range wires {
			if !bytes.Equal(got[i], wires[i]) {
				t.Fatalf("gro=%v datagram %d: got %d bytes starting %x, want %d bytes starting %x", gro, i, len(got[i]), got[i][:2], len(wires[i]), wires[i][:2])
			}
		}
		if fxpUDPGSOAvailable.Load() && fxpUDPGSOMessages.Load() == gsoBefore {
			t.Logf("gro=%v: kernel accepted no GSO messages (UDP_SEGMENT unsupported?)", gro)
		}
	}
}

// 内核拒收 GSO（EIO，网卡不做校验和卸载时就是这样）：整个进程关掉 GSO，剩下的逐个重发，不丢包。
func TestFXPUDPGSORejectionFallsBackWithoutLoss(t *testing.T) {
	oldSend, oldAvailable := fxpUDPSendmmsg, fxpUDPGSOAvailable.Load()
	t.Cleanup(func() {
		fxpUDPSendmmsg = oldSend
		fxpUDPGSOAvailable.Store(oldAvailable)
	})
	fxpUDPGSOAvailable.Store(true)
	rejected := 0
	fxpUDPSendmmsg = func(fd uintptr, hdrs []fxpMmsghdr) (int, unix.Errno) {
		for i := range hdrs {
			if hdrs[i].hdr.Controllen > 0 {
				if i == 0 {
					rejected++
					return 0, unix.EIO
				}
				// 前面不带 GSO 的照发，到第一条 GSO 消息为止。
				n, errno := oldSend(fd, hdrs[:i])
				return n, errno
			}
		}
		return oldSend(fd, hdrs)
	}
	send, recv := udpLoopbackPair(t)
	reader := newFXPUDPBatchReader(recv, false, true)
	defer closeFXPUDPPacketReader(reader)
	batch := newFXPUDPWireBatch(send)
	if batch == nil || !batch.sender.gso {
		t.Skip("UDP_SEGMENT not supported by this kernel")
	}
	wires := testWires(80)
	sendWires(t, send, recv.LocalAddr().(*net.UDPAddr).AddrPort(), wires)
	got := readWires(t, reader, recv, len(wires))
	for i := range wires {
		if !bytes.Equal(got[i], wires[i]) {
			t.Fatalf("datagram %d differs after GSO fallback", i)
		}
	}
	if rejected == 0 {
		t.Fatal("the fake kernel never saw a GSO message")
	}
	if fxpUDPGSOAvailable.Load() {
		t.Fatal("GSO should be disabled process-wide after the kernel rejected it")
	}
}

func TestFXPUDPGROSegmentSizeParsesControlMessage(t *testing.T) {
	ctrl := make([]byte, fxpUDPGROCtrlSpace)
	cmsg := (*unix.Cmsghdr)(unsafe.Pointer(&ctrl[0]))
	cmsg.Level = unix.SOL_UDP
	cmsg.Type = unix.UDP_GRO
	cmsg.SetLen(unix.CmsgLen(4))
	*(*int32)(unsafe.Pointer(&ctrl[unix.CmsgLen(0)])) = 1200
	if got := fxpUDPGROSegmentSize(ctrl, unix.CmsgLen(4)); got != 1200 {
		t.Fatalf("segment size = %d, want 1200", got)
	}
	if got := fxpUDPGROSegmentSize(ctrl, 0); got != 0 {
		t.Fatalf("empty control: segment size = %d, want 0", got)
	}
	cmsg.Type = unix.UDP_SEGMENT
	if got := fxpUDPGROSegmentSize(ctrl, unix.CmsgLen(4)); got != 0 {
		t.Fatalf("other cmsg type: segment size = %d, want 0", got)
	}
}

// 会话读协程借的批次读空就还，监听读协程自己的那批一直留着。
func TestFXPUDPBatchReaderReturnsBorrowedBatch(t *testing.T) {
	send, recv := udpLoopbackPair(t)
	reader := newFXPUDPBatchReader(recv, false, false).(*fxpUDPBatchReader)
	defer closeFXPUDPPacketReader(reader)
	if _, err := send.WriteToUDP([]byte("one"), recv.LocalAddr().(*net.UDPAddr)); err != nil {
		t.Fatal(err)
	}
	got := readWires(t, reader, recv, 1)
	if string(got[0]) != "one" {
		t.Fatalf("got %q", got[0])
	}
	if reader.batch != nil {
		t.Fatal("borrowed batch kept after every datagram was handed out")
	}
}
