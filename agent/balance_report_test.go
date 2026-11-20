package main

import (
	"net"
	"testing"
	"time"
)

func resetAgentBalanceReporterForTest() {
	agentBalanceReporter.mu.Lock()
	agentBalanceReporter.rules = map[string]*agentBalanceRuleState{}
	agentBalanceReporter.dirty = false
	agentBalanceReporter.dirtyAt = time.Time{}
	agentBalanceReporter.last = time.Time{}
	agentBalanceReporter.mu.Unlock()
}

func tunnelBalanceTestProxy(strategy string) *failoverProxy {
	proxy := &failoverProxy{
		ruleID: 501,
		spec: normalizeFailoverSpec(failoverSpec{
			Enabled: true, ListenPort: 65010, BindAddress: "127.0.0.1", Strategy: strategy,
			FailoverSeconds: 4, RecoverSeconds: 6,
			Targets: []failoverTarget{
				{TargetIP: "127.0.0.1", TargetPort: 47001, ProbeIP: "198.51.100.12", ProbePort: 40001},
				{TargetIP: "127.0.0.1", TargetPort: 47002, ProbeIP: "198.51.100.13", ProbePort: 40002, failoverTargetHints: failoverTargetHints{ExtraLatencyMs: 5}},
				{TargetIP: "127.0.0.1", TargetPort: 47003, ProbeIP: "198.51.100.14", ProbePort: 40003},
			},
			BalanceReport: &failoverBalanceReport{TunnelID: 7, HostIDs: []int{2, 3, 4}},
		}),
	}
	proxy.ensureHealthStateLocked()
	return proxy
}

// GOST 链路：主出口 jinx 到目标不通（出口机的探测经面板标了 Down），入口代理在 hep ix 上走。报给面板的是真实状态。
func TestAgentBalanceSnapshotReportsRealState(t *testing.T) {
	proxy := tunnelBalanceTestProxy("fallback")
	proxy.mu.Lock()
	proxy.relayDown[0] = true
	proxy.activeIndex = 1
	proxy.lastLatencyMs[1] = 2
	proxy.mu.Unlock()
	tunnelID, strategy, exits, ok := proxy.balanceSnapshot()
	if !ok || tunnelID != 7 || strategy != "fallback" {
		t.Fatalf("balance proxy reported: %v %v %v", ok, tunnelID, strategy)
	}
	if exits[0].State != "down" || exits[0].Reason != "target" || exits[0].HostID != 2 {
		t.Fatalf("primary cannot reach the target: %#v", exits[0])
	}
	if exits[1].State != "active" || exits[1].MedianMs != 7 || exits[1].Host != "198.51.100.13" {
		t.Fatalf("hep ix in use, latency = entry→exit probe + exit→target hint: %#v", exits[1])
	}
	if exits[2].State != "standby" {
		t.Fatalf("third exit on standby: %#v", exits[2])
	}
	plain := &failoverProxy{spec: normalizeFailoverSpec(failoverSpec{Enabled: true, Strategy: "fallback", Targets: []failoverTarget{{TargetIP: "a", TargetPort: 1}, {TargetIP: "b", TargetPort: 2}}})}
	if _, _, _, ok := plain.balanceSnapshot(); ok {
		t.Fatalf("route-group proxies are not tunnel balance proxies")
	}
}

// picks 是累计分到的条数，不是此刻挂着的连接数（2.2.263 及以前报的是后者）；share 由上报那边按最近一分钟算。
func TestAgentBalancePicksAreAssignmentsNotOpenConnections(t *testing.T) {
	resetAgentBalanceReporterForTest()
	proxy := tunnelBalanceTestProxy("round_robin")
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	proxy.mu.Lock()
	proxy.targetHealth[2] = false
	// 第一台上挂着一条老连接，可这段时间一条新连接都没分给它
	proxy.conns[0][a] = struct{}{}
	proxy.mu.Unlock()
	for i := 0; i < 3; i++ {
		proxy.notePick(1)
	}
	proxy.notePick(0)
	_, _, exits, _ := proxy.balanceSnapshot()
	if exits[0].Picks != 1 || exits[1].Picks != 3 || exits[2].Picks != 0 {
		t.Fatalf("picks are cumulative assignments: %#v", exits)
	}
	if exits[0].State != "active" || exits[1].State != "active" {
		t.Fatalf("both good exits are in rotation: %#v", exits)
	}
	if exits[2].State != "down" || exits[2].Reason != "exit" {
		t.Fatalf("entry cannot reach the third exit: %#v", exits[2])
	}
	failoverMu.Lock()
	failoverProxies["balance-picks-test"] = proxy
	failoverMu.Unlock()
	defer func() {
		failoverMu.Lock()
		delete(failoverProxies, "balance-picks-test")
		failoverMu.Unlock()
	}()
	rules, due := collectAgentBalanceReports(time.Unix(1_800_000_000, 0), true)
	if !due || len(rules) != 1 {
		t.Fatalf("report: %v %#v", due, rules)
	}
	if got := rules[0].Exits; got[0].Share != 0.25 || got[1].Share != 0.75 || got[2].Share != 0 {
		t.Fatalf("share = share of recent assignments: %#v", got)
	}
}

func TestAgentBalanceReportDueOnChange(t *testing.T) {
	resetAgentBalanceReporterForTest()
	proxy := tunnelBalanceTestProxy("fallback")
	failoverMu.Lock()
	failoverProxies["balance-test"] = proxy
	failoverMu.Unlock()
	defer func() {
		failoverMu.Lock()
		delete(failoverProxies, "balance-test")
		failoverMu.Unlock()
	}()
	now := time.Unix(1_800_000_000, 0)
	if _, due := collectAgentBalanceReports(now, false); !due {
		t.Fatalf("first report goes out")
	}
	if _, due := collectAgentBalanceReports(now.Add(time.Second), false); due {
		t.Fatalf("no change, wait")
	}
	proxy.mu.Lock()
	proxy.relayDown[0] = true
	proxy.activeIndex = 1
	proxy.mu.Unlock()
	collectAgentBalanceReports(now.Add(2*time.Second), false)
	rules, due := collectAgentBalanceReports(now.Add(3*time.Second), false)
	if !due || len(rules) != 1 || len(rules[0].Events) != 2 || rules[0].Events[0].To != "down" {
		t.Fatalf("switch reported with events: %v %#v", due, rules)
	}
}

// 报的延迟和调度器比的是同一个数（指数平均），两段分开报：入口到出口 exitMs、出口到目标 targetMs；
// 到目标不知道的那台带 targetLatencyUnknown，medianMs 只算入口到出口那一段。
func TestAgentBalanceSnapshotReportsPickerLatencyAndBothHalves(t *testing.T) {
	proxy := tunnelBalanceTestProxy("latency")
	proxy.mu.Lock()
	proxy.spec.Targets[0].ExtraLatencyUnknown = true
	proxy.spec.Targets[2].ExtraLatencyMs = 9
	at := time.Now()
	for _, ms := range []int{4, 4, 4, 40} {
		proxy.stats[1].recordProbe(true, ms, at)
		at = at.Add(time.Second)
	}
	proxy.stats[0].recordProbe(true, 3, at)
	proxy.stats[2].recordProbe(true, 6, at)
	proxy.lastLatencyMs[1] = 40
	ewma := proxy.plainLatencyLocked(1)
	proxy.mu.Unlock()
	_, _, exits, ok := proxy.balanceSnapshot()
	if !ok {
		t.Fatal("not a balance proxy")
	}
	if ewma >= 40 || exits[1].ExitMs != roundTenth(ewma) || exits[1].TargetMs != 5 || exits[1].MedianMs != roundTenth(ewma+5) {
		t.Fatalf("入口到出口报指数平均（%v），不是最近一次的 40：%#v", ewma, exits[1])
	}
	if !exits[0].TargetLatencyUnknown || exits[0].TargetMs != 0 || exits[0].ExitMs != 3 || exits[0].MedianMs != 3 {
		t.Fatalf("到目标不知道：%#v", exits[0])
	}
	if exits[2].TargetLatencyUnknown || exits[2].TargetMs != 9 || exits[2].MedianMs != 15 {
		t.Fatalf("两段都知道：%#v", exits[2])
	}
}
