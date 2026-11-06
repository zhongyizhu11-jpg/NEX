package main

import (
	"net"
	"testing"
	"time"
)

// withUDPRelayGlobalCap 把全进程的 UDP 中继会话上限临时改成 limit。
func withUDPRelayGlobalCap(t *testing.T, limit int64) {
	t.Helper()
	udpRelayGlobalSessionCap() // 先让 Once 跑过，之后直接改值
	old := udpRelayGlobalCap.Load()
	udpRelayGlobalCap.Store(limit)
	t.Cleanup(func() { udpRelayGlobalCap.Store(old) })
}

func waitUDPRelayActive(t *testing.T, want int64) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if udpRelaySessionsActive.Load() == want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("active udp relay sessions = %d, want %d", udpRelaySessionsActive.Load(), want)
}

func udpExchangeOnce(t *testing.T, addr string, payload string) bool {
	t.Helper()
	conn, err := net.Dial("udp", addr)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	if _, err := conn.Write([]byte(payload)); err != nil {
		t.Fatal(err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
	buf := make([]byte, 64)
	n, err := conn.Read(buf)
	return err == nil && string(buf[:n]) == payload
}

func TestUDPRelayGlobalCapDefaultsToHalfTheFileLimit(t *testing.T) {
	limit := udpRelayGlobalSessionCap()
	if limit < udpRelayGlobalSessionFloor || limit > udpRelayGlobalSessionCeiling {
		t.Fatalf("global cap %d outside [%d, %d]", limit, udpRelayGlobalSessionFloor, udpRelayGlobalSessionCeiling)
	}
	if nofile := processOpenFileLimit(); nofile > 0 && nofile/2 >= udpRelayGlobalSessionFloor && uint64(limit) > nofile/2 {
		t.Fatalf("global cap %d exceeds half of RLIMIT_NOFILE %d", limit, nofile)
	}
}

// 线路组：全进程会话数到顶时回收这条规则自己最老的会话，新来源照样通，计数记一次回收。
func TestRouteGroupUDPRecyclesItsOwnOldestSessionAtGlobalCap(t *testing.T) {
	failoverUDPTestSetup(t)
	base := udpRelaySessionsActive.Load()
	withUDPRelayGlobalCap(t, base+2)
	echo := udpPlainEcho(t)
	spec := failoverTestSpec(failoverTestDualPort(t))
	spec.Protocol = "udp"
	spec.Targets = []failoverTarget{{TargetIP: "127.0.0.1", TargetPort: echo.Port}, {TargetIP: "127.0.0.1", TargetPort: echo.Port}}
	_, addr := startUDPFailoverForTest(t, 950201, 65201, spec)
	evicted := udpRelaySessionsEvicted.Load()
	for i, payload := range []string{"a", "b", "c"} {
		if !udpExchangeOnce(t, addr, payload) {
			t.Fatalf("client %d got no reply", i)
		}
	}
	if got := udpRelaySessionsEvicted.Load() - evicted; got < 1 {
		t.Fatalf("evicted %d sessions at the global cap, want at least 1", got)
	}
	waitUDPRelayActive(t, base+2)
}

// 协议守护：全进程会话数到顶、这条规则又没有空闲够久的会话可挤时，新会话被拒、计数记一次拒绝，
// 已有的会话不受影响。
func TestProtocolGuardUDPRejectsNewSessionAtGlobalCapWithoutIdleVictim(t *testing.T) {
	base := udpRelaySessionsActive.Load()
	withUDPRelayGlobalCap(t, base+1)
	echo := udpPlainEcho(t)
	addr := startGuardUDPRelayForTest(t, 950202, echo, nil)
	first, err := net.Dial("udp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	exchange := func(conn net.Conn, payload string) bool {
		if _, err := conn.Write([]byte(payload)); err != nil {
			t.Fatal(err)
		}
		_ = conn.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
		buf := make([]byte, 64)
		n, err := conn.Read(buf)
		return err == nil && string(buf[:n]) == payload
	}
	if !exchange(first, "first") {
		t.Fatal("first session got no reply")
	}
	rejected := udpRelaySessionsRejected.Load()
	if udpExchangeOnce(t, addr, "second") {
		t.Fatal("a new session was admitted past the global cap")
	}
	if udpRelaySessionsRejected.Load() == rejected {
		t.Fatal("rejection was not counted")
	}
	if !exchange(first, "again") {
		t.Fatal("the existing session stopped working")
	}
}
