package main

import (
	"net/netip"
	"testing"

	"golang.zx2c4.com/wireguard/tun/netstack"
	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/transport/tcp"
)

func TestTuneWireGuardNetstackRaisesBuffersAndUsesCubic(t *testing.T) {
	dev, tnet, err := netstack.CreateNetTUN([]netip.Addr{netip.MustParseAddr("10.77.0.1")}, nil, 1380)
	if err != nil {
		t.Fatalf("create netstack: %v", err)
	}
	defer dev.Close()

	// 依赖升级把字段改名时这里会先失败，而不是在真机上悄悄退回 reno + 4MB。
	s := wireGuardNetstackStack(tnet)
	if s == nil {
		t.Fatal("netstack stack field not reachable; wireguard-go layout changed")
	}
	if err := tuneWireGuardNetstack(tnet); err != nil {
		t.Fatalf("tune: %v", err)
	}
	var recv tcpip.TCPReceiveBufferSizeRangeOption
	if err := s.TransportProtocolOption(tcp.ProtocolNumber, &recv); err != nil {
		t.Fatal(err)
	}
	if recv.Max != wireGuardNetstackBufferMax || recv.Default != tcp.DefaultReceiveBufferSize {
		t.Fatalf("receive range = %+v", recv)
	}
	var send tcpip.TCPSendBufferSizeRangeOption
	if err := s.TransportProtocolOption(tcp.ProtocolNumber, &send); err != nil {
		t.Fatal(err)
	}
	if send.Max != wireGuardNetstackBufferMax || send.Default != tcp.DefaultSendBufferSize {
		t.Fatalf("send range = %+v", send)
	}
	var cc tcpip.CongestionControlOption
	if err := s.TransportProtocolOption(tcp.ProtocolNumber, &cc); err != nil {
		t.Fatal(err)
	}
	if string(cc) != "cubic" {
		t.Fatalf("congestion control = %q", cc)
	}
	var sack tcpip.TCPSACKEnabled
	if err := s.TransportProtocolOption(tcp.ProtocolNumber, &sack); err != nil || !bool(sack) {
		t.Fatalf("SACK should stay enabled: %v %v", sack, err)
	}
}

func TestTuneWireGuardNetstackNilIsError(t *testing.T) {
	if err := tuneWireGuardNetstack(nil); err == nil {
		t.Fatal("expected error for nil netstack")
	}
}
