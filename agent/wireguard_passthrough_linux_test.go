//go:build linux

package main

import (
	"strings"
	"sync"
	"testing"
	"time"
)

// passthroughKernelRunner 是带 `iptables -S` 输出的假命令执行器。
type passthroughKernelRunner struct {
	mu       sync.Mutex
	commands []string
	listings map[string]string // "nat PREROUTING" -> -S 输出
}

func (runner *passthroughKernelRunner) run(args ...string) (string, error) {
	line := strings.Join(args, " ")
	runner.mu.Lock()
	runner.commands = append(runner.commands, line)
	runner.mu.Unlock()
	if len(args) >= 6 && args[0] == "iptables" {
		for i := 0; i+3 < len(args); i++ {
			if args[i] == "-t" && args[i+2] == "-S" {
				return runner.listings[args[i+1]+" "+args[i+3]], nil
			}
		}
	}
	return "", nil
}

func (runner *passthroughKernelRunner) lines() []string {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	return append([]string(nil), runner.commands...)
}

func (runner *passthroughKernelRunner) reset() {
	runner.mu.Lock()
	runner.commands = nil
	runner.mu.Unlock()
}

func withFakeIptablesPresent(t *testing.T) {
	t.Helper()
	orig := wireGuardKernelIptablesPresent
	wireGuardKernelIptablesPresent = func() bool { return true }
	t.Cleanup(func() { wireGuardKernelIptablesPresent = orig })
}

func TestWireGuardKernelPlaneSyncsPassthroughRules(t *testing.T) {
	withFakeIptablesPresent(t)
	spec := testKernelWireGuardSpec(t)
	runner := &passthroughKernelRunner{listings: map[string]string{}}
	plane, err := newWireGuardKernelPlaneWith(spec, runner.run, &fakeWireGuardKernelConfigurer{})
	if err != nil {
		t.Fatalf("create plane: %v", err)
	}
	t.Cleanup(plane.close)

	// 没有直通表、也没装过：什么都不碰。
	runner.reset()
	if err := plane.syncPassthrough(spec); err != nil {
		t.Fatal(err)
	}
	if lines := runner.lines(); len(lines) != 0 {
		t.Fatalf("empty passthrough ran commands: %v", lines)
	}

	withRules := spec
	withRules.Passthrough = []wireGuardPassthroughRule{{RuleID: 12, Role: "exit", PeerID: "exit", Port: 443, Protocol: "tcp", TargetIP: "1.2.3.4", TargetPort: 8443}}
	withRules, err = normalizeWireGuardSpec(withRules)
	if err != nil {
		t.Fatal(err)
	}
	// 链里已经有一条过时的直通规则（目标变过）和一条别的接口的。
	stale := "nex-pt-nexwg42-12-tcp-deadbeef"
	runner.listings["nat PREROUTING"] = strings.Join([]string{
		"-P PREROUTING ACCEPT",
		"-A PREROUTING -s 10.77.0.2/32 -d 10.77.0.1/32 -i nexwg42 -p tcp -m tcp --dport 443 -m comment --comment " + stale + " -j DNAT --to-destination 1.2.3.9:8443",
		"-A PREROUTING -s 10.77.0.2/32 -i nexwg43 -p tcp -m tcp --dport 443 -m comment --comment nex-pt-nexwg43-12-tcp-deadbeef -j DNAT --to-destination 1.2.3.9:8443",
	}, "\n")
	runner.reset()
	if err := plane.syncPassthrough(withRules); err != nil {
		t.Fatal(err)
	}
	text := strings.Join(runner.lines(), "\n")
	for _, want := range []string{
		"sysctl -w net.ipv4.ip_forward=1",
		"iptables " + iptablesWaitFlag() + " -t nat -D PREROUTING -s 10.77.0.2/32 -d 10.77.0.1/32 -i nexwg42 -p tcp -m tcp --dport 443 -m comment --comment " + stale + " -j DNAT --to-destination 1.2.3.9:8443",
		"iptables " + iptablesWaitFlag() + " -t nat -I PREROUTING -i nexwg42 -s 10.77.0.2/32 -d 10.77.0.1/32 -p tcp --dport 443 -m comment --comment nex-pt-nexwg42-12-tcp-",
		"-j DNAT --to-destination 1.2.3.4:8443",
		"iptables " + iptablesWaitFlag() + " -t nat -I POSTROUTING -s 10.77.0.2/32 -d 1.2.3.4/32 -p tcp --dport 8443 -m comment --comment nex-pt-nexwg42-12-tcp-",
		"iptables " + iptablesWaitFlag() + " -t filter -I FORWARD -i nexwg42 -s 10.77.0.2/32 -d 1.2.3.4/32 -p tcp --dport 8443",
		"iptables " + iptablesWaitFlag() + " -t filter -I FORWARD -o nexwg42 -d 10.77.0.2/32 -s 1.2.3.4/32 -p tcp --sport 8443 -m conntrack --ctstate ESTABLISHED,RELATED",
		"iptables " + iptablesWaitFlag() + " -t mangle -I FORWARD -o nexwg42 -p tcp --tcp-flags SYN,RST SYN -m comment --comment nex-pt-nexwg42-mss -j TCPMSS --clamp-mss-to-pmtu",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("sync commands missing %q:\n%s", want, text)
		}
	}
	if strings.Contains(text, "nexwg43") {
		t.Fatalf("another interface's rule was touched:\n%s", text)
	}

	// 规则已经在链里：第二次同步只有列表和 sysctl，不再增删。
	installed := wireGuardPassthroughFirewallRules("nexwg42", "10.77.0.1", map[string]string{"exit": "10.77.0.2"}, withRules.Passthrough)
	runner.listings["nat PREROUTING"] = "-A PREROUTING -i nexwg42 -p tcp -m comment --comment " + installed[0].comment + " -j DNAT --to-destination 1.2.3.4:8443"
	runner.listings["nat POSTROUTING"] = "-A POSTROUTING -m comment --comment " + installed[1].comment + " -j MASQUERADE"
	runner.listings["filter FORWARD"] = "-A FORWARD -m comment --comment " + installed[2].comment + " -j ACCEPT\n-A FORWARD -m comment --comment " + installed[3].comment + " -j ACCEPT"
	runner.listings["mangle FORWARD"] = "-A FORWARD -o nexwg42 -m comment --comment nex-pt-nexwg42-mss -j TCPMSS --clamp-mss-to-pmtu"
	runner.reset()
	if err := plane.syncPassthrough(withRules); err != nil {
		t.Fatal(err)
	}
	for _, line := range runner.lines() {
		if strings.Contains(line, " -I ") || strings.Contains(line, " -D ") {
			t.Fatalf("steady-state sync changed rules: %s", line)
		}
	}

	// 表清空：全部删掉（包括 MSS）。
	runner.reset()
	if err := plane.syncPassthrough(spec); err != nil {
		t.Fatal(err)
	}
	text = strings.Join(runner.lines(), "\n")
	if strings.Count(text, " -D ") != 5 || !strings.Contains(text, "-D FORWARD -o nexwg42 -m comment --comment nex-pt-nexwg42-mss") {
		t.Fatalf("clearing did not delete every rule:\n%s", text)
	}

	// 装回去再拆接口：先清规则再删接口。
	if err := plane.syncPassthrough(withRules); err != nil {
		t.Fatal(err)
	}
	runner.reset()
	plane.close()
	lines := runner.lines()
	if len(lines) == 0 || lines[len(lines)-1] != "ip link del dev nexwg42" {
		t.Fatalf("close must end with deleting the interface: %v", lines)
	}
	if !strings.Contains(strings.Join(lines, "\n"), " -D ") {
		t.Fatalf("close did not clear passthrough rules: %v", lines)
	}
}

func TestWireGuardKernelPlaneSyncPassthroughNeedsIptables(t *testing.T) {
	orig := wireGuardKernelIptablesPresent
	wireGuardKernelIptablesPresent = func() bool { return false }
	t.Cleanup(func() { wireGuardKernelIptablesPresent = orig })
	spec := testKernelWireGuardSpec(t)
	runner := &passthroughKernelRunner{listings: map[string]string{}}
	plane, err := newWireGuardKernelPlaneWith(spec, runner.run, &fakeWireGuardKernelConfigurer{})
	if err != nil {
		t.Fatalf("create plane: %v", err)
	}
	t.Cleanup(plane.close)
	spec.Passthrough = []wireGuardPassthroughRule{{RuleID: 1, Role: "entry", PeerID: "exit", Port: 443, Protocol: "tcp"}}
	if err := plane.syncPassthrough(spec); err == nil {
		t.Fatal("passthrough installed without iptables")
	}
}

// passthroughSyncPlane 记录运行时交给数据面同步的直通表。
type passthroughSyncPlane struct {
	fakeDirectWireGuardPlane
	mu     sync.Mutex
	synced [][]wireGuardPassthroughRule
}

func (plane *passthroughSyncPlane) syncPassthrough(spec wireGuardSpec) error {
	plane.mu.Lock()
	defer plane.mu.Unlock()
	plane.synced = append(plane.synced, append([]wireGuardPassthroughRule(nil), spec.Passthrough...))
	return nil
}

func (plane *passthroughSyncPlane) syncCount() int {
	plane.mu.Lock()
	defer plane.mu.Unlock()
	return len(plane.synced)
}

func TestWireGuardRuntimePassthroughHoldsReferenceAndSyncsOnChange(t *testing.T) {
	const tunnelID = 98610
	plane := &passthroughSyncPlane{}
	runtime := newTestDirectWireGuardRuntime(tunnelID, plane)
	base := testKernelWireGuardSpec(t)
	base.TunnelID = tunnelID
	runtime.spec = base
	runtime.signature = wireGuardSpecSignature(base)
	runtime.peers = map[string]wireGuardPeerSpec{}
	for _, peer := range base.Peers {
		runtime.peers[peer.ID] = peer
	}
	setTestWireGuardRuntime(t, tunnelID, runtime)
	t.Cleanup(runtime.close)

	withRules := base
	withRules.Passthrough = []wireGuardPassthroughRule{{RuleID: 12, Role: "exit", PeerID: "exit", Port: 443, Protocol: "tcp", TargetIP: "1.2.3.4", TargetPort: 8443}}
	if err := runtime.update(withRules); err != nil {
		t.Fatal(err)
	}
	runtime.mu.RLock()
	refs, timer := runtime.refs[wireGuardPassthroughRefID], runtime.releaseTimer
	runtime.mu.RUnlock()
	if refs != 1 || timer != nil {
		t.Fatalf("passthrough ref=%d timer=%v after update", refs, timer != nil)
	}
	if plane.syncCount() != 1 || len(plane.synced[0]) != 1 {
		t.Fatalf("sync calls = %+v", plane.synced)
	}
	// 只改对端 keepalive，不改直通表：不重新同步。
	bumped := withRules
	bumped.Peers = append([]wireGuardPeerSpec(nil), withRules.Peers...)
	bumped.Peers[1].PersistentKeepalive = 15
	if err := runtime.update(bumped); err != nil {
		t.Fatal(err)
	}
	if plane.syncCount() != 1 {
		t.Fatalf("unrelated update re-synced passthrough: %d calls", plane.syncCount())
	}
	// 表清空：同步一次空表，引用放掉，拆除定时器起来。
	if err := runtime.update(base); err != nil {
		t.Fatal(err)
	}
	runtime.mu.RLock()
	_, held := runtime.refs[wireGuardPassthroughRefID]
	timer = runtime.releaseTimer
	runtime.mu.RUnlock()
	if held || timer == nil {
		t.Fatalf("empty passthrough kept ref=%v timer=%v", held, timer != nil)
	}
	if plane.syncCount() != 2 || len(plane.synced[1]) != 0 {
		t.Fatalf("empty table not synced: %+v", plane.synced)
	}
	runtime.mu.Lock()
	if runtime.releaseTimer != nil {
		runtime.releaseTimer.Stop()
		runtime.releaseTimer = nil
	}
	runtime.mu.Unlock()
	_ = time.Second
}

func TestWireGuardRuntimePlaneKindsListsRunningTunnels(t *testing.T) {
	const tunnelID = 98611
	runtime := newTestDirectWireGuardRuntime(tunnelID, &fakeDirectWireGuardPlane{})
	setTestWireGuardRuntime(t, tunnelID, runtime)
	t.Cleanup(runtime.close)
	found := false
	for _, state := range wireGuardRuntimePlaneKinds() {
		if state.TunnelID == tunnelID {
			found = state.Plane == wireGuardPlaneKernel
		}
	}
	if !found {
		t.Fatal("running tunnel missing from plane list")
	}
}
