package main

import (
	"net/netip"
	"testing"

	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/transport/tcp"
)

func TestTuneWireGuardNetstackRaisesBuffersAndUsesCubic(t *testing.T) {
	dev, err := newWireGuardNetTUN(netip.MustParseAddr("10.77.0.1"), 1380)
	if err != nil {
		t.Fatalf("create netstack: %v", err)
	}
	defer dev.Close()

	s := dev.stack
	if err := tuneWireGuardNetstack(s); err != nil {
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
