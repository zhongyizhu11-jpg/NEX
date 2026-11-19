package main

import (
	"testing"
	"time"
)

// 外部观察的探测：间隔按组的时间收紧；结果如实报（通 = healthy，不通 = unhealthy），不做本机的持续判断。
func TestForwardGroupPeerProbeIntervalAndReport(t *testing.T) {
	if got := capForwardGroupHealthProbeInterval(time.Minute, []forwardGroupProbe{{ProbeType: "peer", FailoverSeconds: 20, RecoverSeconds: 120}}); got != 10*time.Second {
		t.Fatalf("peer probe interval = %v, want 10s (half of the shorter window)", got)
	}
	if got := capForwardGroupHealthProbeInterval(time.Minute, []forwardGroupProbe{{ProbeType: " Peer "}}); got != 30*time.Second {
		t.Fatalf("peer probe with default windows = %v, want 30s", got)
	}

	task := tcpingTask{Kind: "forwardGroup", GroupID: 7, MemberID: 71, ProbeType: "peer", Method: "tcp", TargetIP: "203.0.113.9", TargetPort: 443}
	payload := map[string]any{}
	applyForwardGroupHealthDecision(task, false, payload, time.Now())
	if _, decided := payload["healthStatus"]; decided {
		t.Fatalf("the local health gate must not debounce peer probes: %v", payload)
	}
	applyForwardGroupPeerProbeReport(task, false, payload)
	if payload["healthStatus"] != "unhealthy" {
		t.Fatalf("unreachable peer probe must report unhealthy at once, got %v", payload["healthStatus"])
	}
	applyForwardGroupPeerProbeReport(task, true, payload)
	if payload["healthStatus"] != "healthy" {
		t.Fatalf("reachable peer probe must report healthy at once, got %v", payload["healthStatus"])
	}

	// 别的探测类型不受影响
	chain := map[string]any{}
	applyForwardGroupPeerProbeReport(tcpingTask{Kind: "forwardGroup", ProbeType: "chain"}, false, chain)
	applyForwardGroupPeerProbeReport(tcpingTask{Kind: "rule", ProbeType: "peer"}, false, chain)
	if len(chain) != 0 {
		t.Fatalf("non-peer probes must be left alone: %v", chain)
	}
}

// 带 healthStatus 的外部观察结果在上报闸门里按健康结果处理：不变也每分钟报一次，一变立刻报。
func TestForwardGroupPeerProbeReportsEveryMinute(t *testing.T) {
	gate := newTCPingReportGate()
	report := func(status string, timeout bool) []map[string]any {
		return []map[string]any{{
			"groupId": 7, "memberId": 71, "probeType": "peer", "method": "tcp", "targetIp": "203.0.113.9", "targetPort": 443,
			"topologyKey": "forward-group:7:peer:71", "probeKey": "forward-group:7:host:2:peer:71:203.0.113.9:443:tcp",
			"isTimeout": timeout, "healthStatus": status, "probeCount": 3, "probeSuccesses": map[bool]int{true: 0, false: 3}[timeout],
		}}
	}
	start := time.Unix(1_800_000_000, 0)
	first := gate.plan(nil, nil, report("healthy", false), nil, false, start)
	if len(first.forwardGroups) != 1 {
		t.Fatalf("first peer result must be reported, got %d", len(first.forwardGroups))
	}
	gate.commit(first)
	quiet := gate.plan(nil, nil, report("healthy", false), nil, false, start.Add(30*time.Second))
	if len(quiet.forwardGroups) != 0 {
		t.Fatalf("an unchanged peer result inside one minute must be held back, got %d", len(quiet.forwardGroups))
	}
	steady := gate.plan(nil, nil, report("healthy", false), nil, false, start.Add(61*time.Second))
	if len(steady.forwardGroups) != 1 {
		t.Fatalf("an unchanged peer result must be re-sent after one minute, got %d", len(steady.forwardGroups))
	}
	gate.commit(steady)
	flipped := gate.plan(nil, nil, report("unhealthy", true), nil, false, start.Add(70*time.Second))
	if len(flipped.forwardGroups) != 1 {
		t.Fatalf("a flipped peer result must be reported at once, got %d", len(flipped.forwardGroups))
	}
}
