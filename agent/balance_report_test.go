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

func TestAgentBalanceSharesFromLiveConnections(t *testing.T) {
	proxy := tunnelBalanceTestProxy("round_robin")
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	c, d := net.Pipe()
	defer c.Close()
	defer d.Close()
	proxy.mu.Lock()
	proxy.targetHealth[2] = false
	proxy.conns[0][a] = struct{}{}
	proxy.conns[1][c] = struct{}{}
	proxy.mu.Unlock()
	_, _, exits, _ := proxy.balanceSnapshot()
	if exits[0].Share != 0.5 || exits[1].Share != 0.5 || exits[0].State != "active" {
		t.Fatalf("connections split across the two good exits: %#v", exits)
	}
	if exits[2].State != "down" || exits[2].Reason != "exit" {
		t.Fatalf("entry cannot reach the third exit: %#v", exits[2])
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
