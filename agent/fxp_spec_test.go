package main

import "testing"

func TestNormalizeFXPSpecExitStrategies(t *testing.T) {
	for _, strategy := range []string{"fallback", "random", "ip_hash", "round_robin"} {
		spec := normalizeFXPSpec(fxpSpec{ExitStrategy: strategy})
		if spec.ExitStrategy != strategy {
			t.Fatalf("strategy %q normalized to %q", strategy, spec.ExitStrategy)
		}
	}
	if spec := normalizeFXPSpec(fxpSpec{ExitStrategy: "none"}); spec.ExitStrategy != "round_robin" {
		t.Fatalf("unsupported strategy normalized to %q", spec.ExitStrategy)
	}
}

func TestNormalizeFXPSpecKeepsUsableMultipathLegs(t *testing.T) {
	spec := normalizeFXPSpec(fxpSpec{
		Role:             "entry",
		Key:              "session-key",
		MultipathEnabled: true,
		MultipathLegs: []fxpMultipathLeg{
			{Host: " 10.0.0.1 ", Port: 5000, Via: "relay#1"},
			{Host: "10.0.0.2", Port: 5000, Key: "own-key"},
		},
	})
	if !spec.MultipathEnabled {
		t.Fatal("expected multipath to stay enabled with two usable legs")
	}
	if len(spec.MultipathLegs) != 2 {
		t.Fatalf("expected 2 legs, got %d", len(spec.MultipathLegs))
	}
	if spec.MultipathLegs[0].Host != "10.0.0.1" {
		t.Fatalf("expected the host to be trimmed, got %q", spec.MultipathLegs[0].Host)
	}
	// A leg without its own key rides the session key.
	if spec.MultipathLegs[0].Key != "session-key" {
		t.Fatalf("expected the session key to be inherited, got %q", spec.MultipathLegs[0].Key)
	}
	if spec.MultipathLegs[1].Key != "own-key" {
		t.Fatalf("expected an explicit leg key to survive, got %q", spec.MultipathLegs[1].Key)
	}
}

func TestNormalizeFXPSpecDisablesMultipathBelowTwoLegs(t *testing.T) {
	// One leg is an ordinary session, so striping is switched off.
	spec := normalizeFXPSpec(fxpSpec{
		Role:             "entry",
		Key:              "k",
		MultipathEnabled: true,
		MultipathLegs:    []fxpMultipathLeg{{Host: "10.0.0.1", Port: 5000}},
	})
	if spec.MultipathEnabled || spec.MultipathLegs != nil {
		t.Fatalf("expected multipath off with one leg, got enabled=%v legs=%d", spec.MultipathEnabled, len(spec.MultipathLegs))
	}
}

func TestNormalizeFXPSpecDropsInvalidAndDuplicateLegs(t *testing.T) {
	spec := normalizeFXPSpec(fxpSpec{
		Role:             "entry",
		Key:              "k",
		MultipathEnabled: true,
		MultipathLegs: []fxpMultipathLeg{
			{Host: "10.0.0.1", Port: 5000},
			{Host: "", Port: 5000},
			{Host: "10.0.0.3", Port: 0},
			{Host: "10.0.0.4", Port: 70000},
			{Host: "10.0.0.1", Port: 5000},
			{Host: "10.0.0.5", Port: 5000},
		},
	})
	if len(spec.MultipathLegs) != 2 {
		t.Fatalf("expected the invalid and duplicate legs to be dropped, got %d", len(spec.MultipathLegs))
	}
	if spec.MultipathLegs[0].Host != "10.0.0.1" || spec.MultipathLegs[1].Host != "10.0.0.5" {
		t.Fatalf("unexpected surviving legs %+v", spec.MultipathLegs)
	}
}

func TestFXPServerSignatureTracksMultipathChanges(t *testing.T) {
	base := fxpSpec{
		Role:       "entry",
		TunnelID:   5,
		RuleID:     6,
		ListenPort: 1000,
		Key:        "k",
		ExitHost:   "10.0.0.9",
		ExitPort:   5000,
	}
	aggregate := base
	aggregate.MultipathEnabled = true
	aggregate.MultipathLegs = []fxpMultipathLeg{
		{Host: "10.0.0.1", Port: 5000},
		{Host: "10.0.0.2", Port: 5000},
	}
	if fxpServerSignature(base) == fxpServerSignature(aggregate) {
		t.Fatal("switching a tunnel into aggregate mode must change its signature")
	}

	swapped := aggregate
	swapped.MultipathLegs = []fxpMultipathLeg{
		{Host: "10.0.0.1", Port: 5000},
		{Host: "10.0.0.3", Port: 5000},
	}
	if fxpServerSignature(aggregate) == fxpServerSignature(swapped) {
		t.Fatal("replacing a relay front must change the signature")
	}
}

// 单连接多路并发：面板把同一个出口重复 N 条腿（via = stream#1..N），入口各开一条连接。
// 同一地址 + 同一 via 仍然算重复（面板把同一台中转列了两次）。
func TestNormalizeFXPSpecKeepsParallelStreamLegsToTheSameExit(t *testing.T) {
	spec := normalizeFXPSpec(fxpSpec{
		Role:             "entry",
		Key:              "k",
		MultipathEnabled: true,
		MultipathLegs: []fxpMultipathLeg{
			{Host: "10.0.0.9", Port: 5000, Via: "stream#1"},
			{Host: "10.0.0.9", Port: 5000, Via: "stream#2"},
			{Host: "10.0.0.9", Port: 5000, Via: "stream#3"},
			{Host: "10.0.0.9", Port: 5000, Via: "stream#3"},
		},
	})
	if !spec.MultipathEnabled || len(spec.MultipathLegs) != 3 {
		t.Fatalf("expected 3 parallel legs to the same exit, got enabled=%v legs=%d", spec.MultipathEnabled, len(spec.MultipathLegs))
	}
}

// 出口组「按权重」：Agent 不能把 weighted 规整成轮流，权重变了 FXP 要重启拿新配置；
// 没写权重的规则签名不变，升级 Agent 不会因此重启。
func TestFXPSpecWeightedExitStrategy(t *testing.T) {
	base := fxpSpec{
		Role: "entry", RuleID: 7, ListenPort: 30001, Protocol: "tcp", ExitHost: "203.0.113.1", ExitPort: 40001, Key: "k",
		ExitStrategy: "weighted",
		Exits:        []fxpExitEndpoint{{Host: "203.0.113.1", Port: 40001}, {Host: "203.0.113.2", Port: 40001}},
	}
	if got := normalizeFXPSpec(base).ExitStrategy; got != "weighted" {
		t.Fatalf("weighted 被规整成了 %q", got)
	}
	plain := fxpServerSignature(normalizeFXPSpec(base))
	weighted := base
	weighted.Exits = []fxpExitEndpoint{{Host: "203.0.113.1", Port: 40001, Weight: 5}, {Host: "203.0.113.2", Port: 40001, Weight: 3}}
	five := fxpServerSignature(normalizeFXPSpec(weighted))
	if plain == five {
		t.Fatal("写了权重签名却没变，FXP 拿不到新权重")
	}
	weighted.Exits = []fxpExitEndpoint{{Host: "203.0.113.1", Port: 40001, Weight: 5}, {Host: "203.0.113.2", Port: 40001, Weight: 2}}
	if fxpServerSignature(normalizeFXPSpec(weighted)) == five {
		t.Fatal("权重变了签名却没变")
	}
}

// 出口组「按负载」：Agent 原样交给 FXP，线路带宽变了 FXP 要拿到新值。
func TestFXPSpecLeastLoadExitStrategy(t *testing.T) {
	base := fxpSpec{
		Role: "entry", RuleID: 7, ListenPort: 30001, Protocol: "tcp", ExitHost: "203.0.113.1", ExitPort: 40001, Key: "k",
		ExitStrategy: "least_load",
		Exits:        []fxpExitEndpoint{{Host: "203.0.113.1", Port: 40001, CapacityMbps: 500}, {Host: "203.0.113.2", Port: 40001, CapacityMbps: 300}},
	}
	if got := normalizeFXPSpec(base).ExitStrategy; got != "least_load" {
		t.Fatalf("least_load 被规整成了 %q", got)
	}
	before := fxpServerSignature(normalizeFXPSpec(base))
	changed := base
	changed.Exits = []fxpExitEndpoint{{Host: "203.0.113.1", Port: 40001, CapacityMbps: 1000}, {Host: "203.0.113.2", Port: 40001, CapacityMbps: 300}}
	if fxpServerSignature(normalizeFXPSpec(changed)) == before {
		t.Fatal("线路带宽变了签名却没变")
	}
}
