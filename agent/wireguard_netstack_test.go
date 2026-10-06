package main

import (
	"net"
	"net/netip"
	"testing"
	"time"

	"golang.zx2c4.com/wireguard/conn"
)

func TestWireGuardNetTUNReadsQueuedPacketsAsOneBatch(t *testing.T) {
	dev, err := newWireGuardNetTUN(netip.MustParseAddr("10.77.0.1"), 1380)
	if err != nil {
		t.Fatalf("create netstack: %v", err)
	}
	defer dev.Close()
	if dev.BatchSize() != conn.IdealBatchSize {
		t.Fatalf("batch size %d, want %d", dev.BatchSize(), conn.IdealBatchSize)
	}

	// 从协议栈往一个对端地址发 UDP：包会排在出站队列里等 WireGuard 来取。
	udp, err := dev.DialUDP(nil, &net.UDPAddr{IP: net.ParseIP("10.77.0.2"), Port: 4000})
	if err != nil {
		t.Fatalf("dial udp: %v", err)
	}
	defer udp.Close()
	const packets = 32
	for i := 0; i < packets; i++ {
		if _, err := udp.Write([]byte{byte(i), 1, 2, 3}); err != nil {
			t.Fatalf("write %d: %v", i, err)
		}
	}

	bufs := make([][]byte, dev.BatchSize())
	sizes := make([]int, dev.BatchSize())
	for i := range bufs {
		bufs[i] = make([]byte, 2048)
	}
	const offset = 16
	got, reads := 0, 0
	deadline := time.Now().Add(5 * time.Second)
	for got < packets && time.Now().Before(deadline) {
		n, err := dev.Read(bufs, sizes, offset)
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		reads++
		for i := 0; i < n; i++ {
			packet := bufs[i][offset : offset+sizes[i]]
			if len(packet) < 28 || packet[0]>>4 != 4 {
				t.Fatalf("packet %d is not IPv4: %d bytes", i, len(packet))
			}
			got++
		}
	}
	if got != packets {
		t.Fatalf("read %d packets, want %d", got, packets)
	}
	// 32 个包已经排好了队，一次 Read 就该带走一大批，而不是一次一个。
	if reads >= packets/2 {
		t.Fatalf("%d packets took %d reads; batching is not happening", packets, reads)
	}
	if dev.droppedPackets() != 0 {
		t.Fatalf("dropped %d packets", dev.droppedPackets())
	}
}

func TestWireGuardNetTUNCloseUnblocksRead(t *testing.T) {
	dev, err := newWireGuardNetTUN(netip.MustParseAddr("10.77.0.1"), 1380)
	if err != nil {
		t.Fatalf("create netstack: %v", err)
	}
	done := make(chan error, 1)
	go func() {
		bufs := [][]byte{make([]byte, 2048)}
		_, err := dev.Read(bufs, make([]int, 1), 0)
		done <- err
	}()
	time.Sleep(20 * time.Millisecond)
	_ = dev.Close()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("read after close must fail")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("close did not unblock the reader")
	}
	// 关两次也不该炸。
	_ = dev.Close()
}

func TestWireGuardNetTUNDropsPacketsThatDoNotFit(t *testing.T) {
	dev, err := newWireGuardNetTUN(netip.MustParseAddr("10.77.0.1"), 1380)
	if err != nil {
		t.Fatalf("create netstack: %v", err)
	}
	defer dev.Close()
	udp, err := dev.DialUDP(nil, &net.UDPAddr{IP: net.ParseIP("10.77.0.2"), Port: 4000})
	if err != nil {
		t.Fatalf("dial udp: %v", err)
	}
	defer udp.Close()
	if _, err := udp.Write(make([]byte, 600)); err != nil {
		t.Fatal(err)
	}
	// 缓冲只有 64 字节：这个包装不下，Read 不能报错，只是什么都不交。
	n, err := dev.Read([][]byte{make([]byte, 64)}, make([]int, 1), 0)
	if err != nil || n != 0 {
		t.Fatalf("read = %d, %v; want 0, nil", n, err)
	}
	if dev.droppedPackets() != 1 {
		t.Fatalf("dropped = %d, want 1", dev.droppedPackets())
	}
}
