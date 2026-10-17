package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestPortAccessLimitConnectionCapSharesUserCounterAndChangesChainOnlyOnThreshold(t *testing.T) {
	spec := portAccessLimitSpec{UserID: 9, MaxConnections: 50, Ports: []int{30001, 30002}}
	dispatch, rules := portLimitRules([]portAccessLimitSpec{spec}, false)
	counter := portLimitCounterChain(spec)
	if len(rules[counter]) != 2 {
		t.Fatalf("connection-only counter rules=%v", rules[counter])
	}
	text := strings.Join(rules[counter][0], " ")
	if !strings.Contains(text, "--connlimit-above 50") || !strings.Contains(text, "--connlimit-mask 0") {
		t.Fatalf("total connection cap must group all sources: %s", text)
	}
	if !strings.Contains(strings.Join(rules[dispatch][0], " "), "--dports 30001,30002 -j "+counter) {
		t.Fatalf("both ports must share one counter: %v", rules[dispatch])
	}
	both := spec
	both.MaxIPs = 3
	_, bothRules := portLimitRules([]portAccessLimitSpec{both}, true)
	bothCounter := portLimitCounterChain(both)
	if bothCounter == counter {
		t.Fatal("threshold change must use a fresh counter chain")
	}
	if len(bothRules[bothCounter]) != 3 || !strings.Contains(strings.Join(bothRules[bothCounter][1], " "), "--connlimit-mask 128") {
		t.Fatalf("per-IP rule missing for IPv6: %v", bothRules[bothCounter])
	}
	// An IP-only limit keeps the upstream chain identity.
	ipOnly := portAccessLimitSpec{UserID: 9, MaxIPs: 3, Ports: []int{30001}}
	if portLimitCounterChain(ipOnly) != portLimitChain("FWX_PC_", []int{9, 3}) {
		t.Fatal("IP-only counter chain identity changed")
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
	if err := syncPortAccessLimits(fw, []portAccessLimitSpec{{UserID: 9, MaxConnections: -1}}, false); err == nil {
		t.Fatal("negative connection cap accepted")
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
	payload := `{"statusType":"runtime","op":"apply","forwardType":"port-access-limit-sync","sourcePort":0,"protocol":"tcp","knownRunning":true,"commands":[],"portAccessLimits":[{"userId":3,"maxIPs":2,"maxConnections":40,"ports":[22000,22001]}]}`
	if err := json.Unmarshal([]byte(payload), &a); err != nil {
		t.Fatal(err)
	}
	if !isPortAccessLimitAction(a) || len(a.PortAccessLimits) != 1 || a.PortAccessLimits[0].MaxConnections != 40 || len(a.PortAccessLimits[0].Ports) != 2 {
		t.Fatalf("decoded=%+v", a.PortAccessLimits)
	}
	if desiredActionKey(a) != "runtime:port-access-limit-sync" {
		t.Fatalf("desired key=%s", desiredActionKey(a))
	}
	if canAdoptDesiredAction(a) {
		t.Fatal("a runtime limit sync must never be adopted without applying it")
	}
}
