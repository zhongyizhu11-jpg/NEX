package main

import (
	"crypto/tls"
	"errors"
	"net"
	"testing"
	"time"
)

// 转送规则（经隧道 / 转发链 / 转发组）在分流器眼里和直连规则一样：名字 → 规则在本机回环上的入口。
// 这几个测试把「读 SNI → 选路 → 交到对的规则入口 → 计数 / 回报版本号」整条路走一遍。

// startSNIBackend 起一个回环监听当「规则在本机的入口」（隧道入口 / 转发链第一跳），收到的 SNI 发到 ch。
func startSNIBackend(t *testing.T, ch chan<- string) (int, func()) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func(conn net.Conn) {
				defer conn.Close()
				_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
				hello, err := readSNIClientHello(nil, conn)
				if err == nil {
					ch <- hello.ServerName
				}
			}(conn)
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port, func() { _ = ln.Close() }
}

func startTestSNIInbound(t *testing.T, spec sniInboundSpec) string {
	t.Helper()
	previousListen := sniListen
	sniListen = func(int) (net.Listener, error) { return net.Listen("tcp", "127.0.0.1:0") }
	t.Cleanup(func() { sniListen = previousListen })
	syncSNIInbounds([]sniInboundSpec{spec})
	t.Cleanup(func() { syncSNIInbounds(nil) })
	sniInboundMu.Lock()
	server := sniInboundServers[spec.ID]
	sniInboundMu.Unlock()
	if server == nil {
		t.Fatalf("inbound did not start")
	}
	return server.listener.Addr().String()
}

func dialSNI(t *testing.T, addr, name string) {
	t.Helper()
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	client := tls.Client(conn, &tls.Config{ServerName: name, InsecureSkipVerify: true})
	_ = client.SetDeadline(time.Now().Add(500 * time.Millisecond))
	_ = client.Handshake()
}

func waitSNIStatus(t *testing.T, id int, ok func(sniInboundStatus) bool) sniInboundStatus {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	var last sniInboundStatus
	for time.Now().Before(deadline) {
		for _, status := range sniInboundStatusSnapshot() {
			if status.ID == id {
				last = status
				if ok(status) {
					return status
				}
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("status never matched: %+v", last)
	return last
}

func TestSNIRoutedRulesReachTheirOwnEntry(t *testing.T) {
	tunnelEntry := make(chan string, 4)
	chainEntry := make(chan string, 4)
	tunnelPort, stopTunnel := startSNIBackend(t, tunnelEntry)
	defer stopTunnel()
	chainPort, stopChain := startSNIBackend(t, chainEntry)
	defer stopChain()
	// 一个关着的端口：规则的入口还没起来（Agent 还在拉起隧道入口）。
	closed, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	closedPort := closed.Addr().(*net.TCPAddr).Port
	_ = closed.Close()

	addr := startTestSNIInbound(t, sniInboundSpec{
		ID: 21, Port: 443, RejectEmptySNI: true, UnknownSNIAction: "reject", Revision: "rev-a",
		Routes: []sniRoute{
			{Name: "tunnel.example.com", RuleID: 101, BackendPort: tunnelPort, Active: true},
			{Name: "chain.example.com", RuleID: 202, BackendPort: chainPort, Active: true},
			{Name: "paused.example.com", RuleID: 303, BackendPort: chainPort, Active: false},
			{Name: "starting.example.com", RuleID: 404, BackendPort: closedPort, Active: true},
		},
	})

	dialSNI(t, addr, "tunnel.example.com")
	dialSNI(t, addr, "chain.example.com")
	for name, ch := range map[string]chan string{"tunnel.example.com": tunnelEntry, "chain.example.com": chainEntry} {
		select {
		case got := <-ch:
			if got != name {
				t.Fatalf("%s 被交给了别的规则入口：%s", name, got)
			}
		case <-time.After(3 * time.Second):
			t.Fatalf("%s 没有交到它的规则入口", name)
		}
	}
	// 暂停规则的名字、不认识的名字：断开，谁的入口都不进。
	dialSNI(t, addr, "paused.example.com")
	dialSNI(t, addr, "unknown.example.com")
	// 规则入口没起来：拨不通记一次后端错误（这也是面板不把 DDNS 切过来的原因之一）。
	dialSNI(t, addr, "starting.example.com")

	status := waitSNIStatus(t, 21, func(s sniInboundStatus) bool {
		return s.Matched == 3 && s.Dropped == 2 && s.BackendErrors == 1
	})
	if !status.Listening || status.Revision != "rev-a" || status.Routes != 3 {
		t.Fatalf("status must echo the table revision and count only active names: %+v", status)
	}
	select {
	case got := <-chainEntry:
		t.Fatalf("paused / unknown names must not reach any rule entry, got %s", got)
	case got := <-tunnelEntry:
		t.Fatalf("paused / unknown names must not reach any rule entry, got %s", got)
	case <-time.After(100 * time.Millisecond):
	}
}

func TestSNIRoutedRevisionFollowsTableSwap(t *testing.T) {
	addr := startTestSNIInbound(t, sniInboundSpec{ID: 22, Port: 443, Revision: "rev-1", UnknownSNIAction: "reject"})
	dialSNI(t, addr, "nobody.example.com")
	waitSNIStatus(t, 22, func(s sniInboundStatus) bool { return s.Revision == "rev-1" && s.Dropped == 1 })

	sniInboundMu.Lock()
	before := sniInboundServers[22]
	sniInboundMu.Unlock()
	// 同一端口只换表：监听不重开，计数不清零，回报的版本号换成新的。
	syncSNIInbounds([]sniInboundSpec{{
		ID: 22, Port: 443, Revision: "rev-2", UnknownSNIAction: "reject",
		Routes: []sniRoute{{Name: "a.example.com", RuleID: 1, BackendPort: 45001, Active: true}},
	}})
	sniInboundMu.Lock()
	after := sniInboundServers[22]
	sniInboundMu.Unlock()
	if before != after {
		t.Fatalf("same port must keep the listener")
	}
	status := waitSNIStatus(t, 22, func(s sniInboundStatus) bool { return s.Revision == "rev-2" })
	if status.Dropped != 1 || status.Routes != 1 {
		t.Fatalf("table swap must keep counters and report new routes: %+v", status)
	}
}

func TestSNIRoutedRevisionReportedOnListenFailure(t *testing.T) {
	previousListen := sniListen
	sniListen = func(int) (net.Listener, error) { return nil, errors.New("address already in use") }
	defer func() { sniListen = previousListen }()
	syncSNIInbounds([]sniInboundSpec{{ID: 23, Port: 443, Revision: "rev-x"}})
	defer syncSNIInbounds(nil)
	status := sniInboundStatusSnapshot()
	if len(status) != 1 || status[0].Listening || status[0].Revision != "rev-x" {
		t.Fatalf("listen failure must still echo the revision (panel tells 'received' from 'listening'): %+v", status)
	}
}

func TestSNICountersRecordDecisions(t *testing.T) {
	var counters sniInboundCounters
	table := testSNITable(nil)
	counters.recordDecision(table.decide("a.example.com", true))
	counters.recordDecision(table.decide("", false))
	counters.recordBackendError()
	if counters.matched.Load() != 1 || counters.dropped.Load() != 1 || counters.backendErrors.Load() != 1 {
		t.Fatalf("counters: matched=%d dropped=%d backend=%d", counters.matched.Load(), counters.dropped.Load(), counters.backendErrors.Load())
	}
	var none *sniInboundCounters
	none.recordDecision(sniDecision{ok: true})
	none.recordBackendError()
}
