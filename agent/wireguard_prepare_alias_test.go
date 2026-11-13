package main

import (
	"encoding/json"
	"testing"
)

/*
真机联调（隧道 6，V2 入口组里一条 TCP、一条 UDP 规则）里每次运行状态被清、面板重下发时，入口组
连着重建七八次，UDP 规则时通时断。根因是 prepareFXPWireGuard 在调用方共享的 Entries / Exits 底层
数组上把出口改写成本机代理端口：startFXP 记下的原始配置、落盘快照、同批动作的期望入口组都被改了，
下一轮把上一轮的本地端口当成出口机端口去建代理。

这里照 startFXPProcessLockedWithPersistence 的写法走一遍：先规范化、记下 originalSpec、再准备；
要求准备前后原始配置和期望入口组一字不差，用同一份原始配置再准备一次时代理还是只指向出口机的
真实端口。把 cloneFXPSpecEndpoints 那一行去掉，这个测试会失败。
*/
func TestPrepareFXPWireGuardDoesNotMutateCallerEndpoints(t *testing.T) {
	const tunnelID = 98531
	runtime := &wireGuardRuntime{
		spec: wireGuardSpec{TunnelID: tunnelID},
		peers: map[string]wireGuardPeerSpec{
			"exit-a": {ID: "exit-a", Address: "100.131.0.2"},
		},
		outbound: map[string]*wireGuardOutboundProxy{},
		inbound:  map[string]*wireGuardInboundProxy{},
		refs:     map[string]int{},
	}
	setTestWireGuardRuntime(t, tunnelID, runtime)
	t.Cleanup(runtime.close)

	tcpRule := testV2EntrySpec(tunnelID, 14, 30051, "exit-a")
	tcpRule.Protocol = "tcp"
	tcpRule.ExitPort = 40051
	tcpRule.Exits = []fxpExitEndpoint{{Host: "198.51.100.10", Port: 40051, PeerID: "exit-a"}}
	udpRule := testV2EntrySpec(tunnelID, 15, 30053, "exit-a")
	udpRule.Protocol = "udp"
	udpRule.ExitPort = 40051
	udpRule.Exits = []fxpExitEndpoint{{Host: "198.51.100.10", Port: 40051, PeerID: "exit-a"}}
	desiredGroup, ok := buildSharedFXPEntryGroup([]fxpSpec{tcpRule, udpRule}, tunnelID, forwardXWireGuardVersion)
	if !ok {
		t.Fatal("V2 entry group is invalid")
	}

	// startFXPProcessLockedWithPersistence：spec = normalize(spec); originalSpec := spec; prepare(spec)。
	spec := normalizeFXPSpec(desiredGroup)
	originalSpec := spec
	before, _ := json.Marshal(originalSpec)
	desiredBefore, _ := json.Marshal(desiredGroup)

	prepared, err := prepareFXPWireGuard(spec, "alias-test:first")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range prepared.Entries {
		if entry.ExitHost != "127.0.0.1" || len(entry.Exits) != 1 || entry.Exits[0].Host != "127.0.0.1" {
			t.Fatalf("rule %d was not rewritten to local WireGuard proxies: %#v", entry.RuleID, entry)
		}
	}
	after, _ := json.Marshal(originalSpec)
	if string(before) != string(after) {
		t.Fatalf("WireGuard preparation rewrote the caller's original spec:\nbefore=%s\nafter=%s", before, after)
	}
	desiredAfter, _ := json.Marshal(desiredGroup)
	if string(desiredBefore) != string(desiredAfter) {
		t.Fatalf("WireGuard preparation rewrote the desired entry group shared with sibling actions:\nbefore=%s\nafter=%s", desiredBefore, desiredAfter)
	}

	// 就绪检查（fxpRuntimeReadyForRulePort / fxpMatchesRunning）拿的是记下的原始配置：
	// 它被改过的话，对着正在跑的代理永远对不上，规则一直报没就绪、每次重下发都判漂移重建。
	for _, entry := range originalSpec.Entries {
		if !wireGuardFXPProxiesMatchConfig(entry, prepared, "alias-test:first") {
			t.Fatalf("rule %d is not ready against its own running WireGuard proxies", entry.RuleID)
		}
	}

	// 下一轮（重下发 / 回滚 / 落盘快照恢复）用同一份原始配置再准备：代理仍然只指向出口机的 40051。
	if _, err := prepareFXPWireGuard(originalSpec, "alias-test:second"); err != nil {
		t.Fatal(err)
	}
	runtime.mu.RLock()
	defer runtime.mu.RUnlock()
	want := wireGuardOutboundProxyKey("exit-a", 40051, 40051)
	for key := range runtime.outbound {
		if key != want {
			t.Fatalf("WireGuard outbound proxy targets a stale local port on the exit host: key=%s want=%s", key, want)
		}
	}
	if len(runtime.outbound) != 1 {
		t.Fatalf("WireGuard outbound proxies=%d, want the single real exit endpoint", len(runtime.outbound))
	}
}
