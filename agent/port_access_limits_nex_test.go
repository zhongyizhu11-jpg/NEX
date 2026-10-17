package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestPortAccessLimitSharesUserCounterAndChangesChainOnlyOnThreshold(t *testing.T) {
	spec := portAccessLimitSpec{UserID: 9, MaxIPs: 3, Ports: []int{30001, 30002}}
	dispatch, rules := portLimitRules([]portAccessLimitSpec{spec}, true)
	counter := portLimitCounterChain(spec)
	if counter != portLimitChain("FWX_PC_", []int{9, 3}) {
		t.Fatal("counter chain identity must match upstream")
	}
	if len(rules[counter]) != 2 || !strings.Contains(strings.Join(rules[counter][0], " "), "--connlimit-above 3 --connlimit-mask 128") {
		t.Fatalf("per-source rule missing for IPv6: %v", rules[counter])
	}
	if !strings.Contains(strings.Join(rules[dispatch][0], " "), "--dports 30001,30002 -j "+counter) {
		t.Fatalf("both ports must share one counter: %v", rules[dispatch])
	}
	raised := spec
	raised.MaxIPs = 5
	if portLimitCounterChain(raised) == counter {
		t.Fatal("threshold change must use a fresh counter chain")
	}
	fw := newFakePortLimitFirewall()
	if err := syncPortAccessLimits(fw, []portAccessLimitSpec{spec}, false); err != nil {
		t.Fatal(err)
	}
	if err := syncPortAccessLimits(fw, []portAccessLimitSpec{spec}, true); err != nil {
		t.Fatal(err)
	}
	if err := syncPortAccessLimits(fw, []portAccessLimitSpec{{UserID: 9, MaxIPs: -1}}, false); err == nil {
		t.Fatal("negative limit accepted")
	}
}

func TestPortAccessLimitReadinessReportsLeftoverChains(t *testing.T) {
	fw := newFakePortLimitFirewall()
	specs := []portAccessLimitSpec{{UserID: 1, MaxIPs: 2, Ports: []int{22}}}
	if err := syncPortAccessLimits(fw, specs, false); err != nil {
		t.Fatal(err)
	}
	// An empty desired snapshot must not look healthy while old chains remain.
	if err := syncPortAccessLimits(fw, nil, true); err == nil {
		t.Fatal("stale chains reported healthy")
	}
	if err := syncPortAccessLimits(fw, nil, false); err != nil {
		t.Fatal(err)
	}
	if err := syncPortAccessLimits(fw, nil, true); err != nil {
		t.Fatal(err)
	}
}

func TestPortAccessLimitActionDecodesPanelPayload(t *testing.T) {
	var a action
	payload := `{"statusType":"runtime","op":"apply","forwardType":"port-access-limit-sync","sourcePort":0,"protocol":"tcp","knownRunning":true,"commands":[],"portAccessLimits":[{"userId":3,"maxIPs":2,"ports":[22000,22001]}]}`
	if err := json.Unmarshal([]byte(payload), &a); err != nil {
		t.Fatal(err)
	}
	if !isPortAccessLimitAction(a) || len(a.PortAccessLimits) != 1 || a.PortAccessLimits[0].MaxIPs != 2 || len(a.PortAccessLimits[0].Ports) != 2 {
		t.Fatalf("decoded=%+v", a.PortAccessLimits)
	}
	if desiredActionKey(a) != "runtime:port-access-limit-sync" {
		t.Fatalf("desired key=%s", desiredActionKey(a))
	}
	if canAdoptDesiredAction(a) {
		t.Fatal("a runtime limit sync must never be adopted without applying it")
	}
}

// 面板把这条动作当成 knownRunning，期望状态没变就不重发：失败的快照必须由 Agent 自己重试，
// 成功后被人清掉的限制也要在定期核对时补回来。
func TestPortAccessLimitMaintenanceRetriesFailedSnapshotAndRepairsDrift(t *testing.T) {
	fw := newFakePortLimitFirewall()
	previous := portLimitFirewallForMaintenance
	portLimitFirewallForMaintenance = fw
	t.Cleanup(func() {
		portLimitFirewallForMaintenance = previous
		portLimitHealth.Lock()
		portLimitHealth.signature, portLimitHealth.checkedAt, portLimitHealth.desired, portLimitHealth.attemptAt = "", time.Time{}, nil, time.Time{}
		portLimitHealth.Unlock()
	})
	a := action{StatusType: "runtime", Op: "apply", ForwardType: portAccessLimitForwardType, Protocol: "tcp",
		PortAccessLimits: []portAccessLimitSpec{{UserID: 4, MaxIPs: 3, Ports: []int{31001}}}}

	// 第一次对齐失败（模拟 xtables 锁）。
	fw.failContains = "connlimit"
	if err := syncPortAccessLimits(fw, a.PortAccessLimits, false); err == nil {
		t.Fatal("simulated failure did not fail")
	}
	rememberPortLimitHealth(a, false)
	if attempted, _ := maintainPortAccessLimits(time.Now()); attempted {
		t.Fatal("retried before the retry interval")
	}

	// 锁释放后，到了重试间隔就自己补上。
	fw.failContains = ""
	if attempted, ok := maintainPortAccessLimits(time.Now().Add(portLimitRetryInterval + time.Second)); !attempted || !ok {
		t.Fatalf("failed snapshot not retried: attempted=%v ok=%v", attempted, ok)
	}
	if err := syncPortAccessLimits(fw, a.PortAccessLimits, true); err != nil {
		t.Fatalf("limits not in place after retry: %v", err)
	}

	// 成功后不频繁动防火墙；有人把表清了，到定期核对时补回来。
	if attempted, _ := maintainPortAccessLimits(time.Now().Add(portLimitRetryInterval + time.Second)); attempted {
		t.Fatal("healthy snapshot re-applied before the maintenance interval")
	}
	fw.tables = map[string]map[string][][]string{}
	if attempted, ok := maintainPortAccessLimits(time.Now().Add(accessLimitMaintenanceInterval + time.Second)); !attempted || !ok {
		t.Fatalf("drift not repaired: attempted=%v ok=%v", attempted, ok)
	}
	if err := syncPortAccessLimits(fw, a.PortAccessLimits, true); err != nil {
		t.Fatalf("limits not restored: %v", err)
	}
}
