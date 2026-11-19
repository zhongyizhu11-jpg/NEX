package main

import (
	"testing"
	"time"
)

// F3：TCP 那一侧和 UDP 那一侧的中断各记各的账。以前记在同一份上：一次真正的断开（两侧一起断）记两次，
// 断两次就凑够了「一小时 4 次」，之后的恢复被抖动抑制压住 30 秒。
func TestTCPAndUDPOutagesAreDampedSeparately(t *testing.T) {
	resetFXPEndpointRegistry()
	state := fxpEndpointStateFor(exitEndpoint{Host: "127.0.0.1", Port: 39003})
	// 对端回过探活包：UDP 那一侧以探活为准。
	state.udpProbeResult(nil)
	udpDown := func() {
		for i := 0; i < fxpSuspectProbes; i++ {
			state.udpProbeResult(errTestEndpointDown)
		}
		if ok, _ := state.reachable(true, time.Now()); ok {
			t.Fatal("UDP 探活连着两轮没回应该判坏")
		}
	}
	udpRecovers := func() bool {
		for i := 0; i < fxpRecoverProbes; i++ {
			state.udpProbeResult(nil)
		}
		ok, _ := state.reachable(true, time.Now())
		return ok
	}
	tcpRecovers := func() bool {
		for i := 0; i < fxpRecoverProbes; i++ {
			state.probeSucceeded()
		}
		return state.isHealthy()
	}
	// 三次真正的断开（两侧一起断、一起好）：一小时里各侧都只断了 3 次，没到 4 次的门槛，每次都马上恢复。
	for outage := 1; outage <= 3; outage++ {
		state.markFailure(errTestEndpointDown)
		udpDown()
		if !tcpRecovers() {
			t.Fatalf("第 %d 次断开：TCP 那一侧一小时里只断了 %d 次，连着探通应该恢复（被抖动抑制压住了）", outage, outage)
		}
		if !udpRecovers() {
			t.Fatalf("第 %d 次断开：UDP 那一侧一小时里只断了 %d 次，连着探通应该恢复（被抖动抑制压住了）", outage, outage)
		}
	}
	// 第四次：各侧都够 4 次了，压住。
	state.markFailure(errTestEndpointDown)
	if tcpRecovers() {
		t.Fatal("TCP 那一侧一小时里断了 4 次，刚断就探通也不该马上放回来")
	}
	udpDown()
	if udpRecovers() {
		t.Fatal("UDP 那一侧一小时里断了 4 次，刚断就探通也不该马上放回来")
	}
}
