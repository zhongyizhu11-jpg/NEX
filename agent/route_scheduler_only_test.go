package main

import (
	"encoding/json"
	"testing"
)

/*
NEX 隧道的线路组：出口机上没有这条规则自己的进程，面板发一条「只跑调度器」的运行规则
（schedulerOnly）。它只开调度器 —— 不占规则端口、不写端口状态、不装计数链，也不能顶替同号
端口上真正的规则。
*/

func schedulerOnlyTestRule() runningRule {
	return runningRule{
		RuleID:        42,
		TunnelID:      7,
		SourcePort:    41042,
		TargetIP:      "198.51.100.7",
		TargetPort:    443,
		Protocol:      "both",
		ForwardType:   "route-scheduler",
		SchedulerOnly: true,
		Failover:      &failoverSpec{Enabled: true, ListenPort: 41042, BindAddress: "127.0.0.1", Protocol: "both", Strategy: "fallback"},
	}
}

func TestRunningRuleDecodesSchedulerOnly(t *testing.T) {
	var rule runningRule
	raw := `{"ruleId":42,"tunnelId":7,"sourcePort":41042,"targetIp":"198.51.100.7","targetPort":443,"protocol":"both","forwardType":"route-scheduler","schedulerOnly":true,"failover":{"enabled":true,"listenPort":41042}}`
	if err := json.Unmarshal([]byte(raw), &rule); err != nil {
		t.Fatalf("decode running rule: %v", err)
	}
	if !rule.SchedulerOnly || rule.Failover == nil || !rule.Failover.Enabled || rule.Failover.ListenPort != 41042 {
		t.Fatalf("scheduler-only running rule decoded wrong: %+v", rule)
	}
	var plain runningRule
	if err := json.Unmarshal([]byte(`{"ruleId":1,"sourcePort":8080}`), &plain); err != nil {
		t.Fatalf("decode plain running rule: %v", err)
	}
	if plain.SchedulerOnly {
		t.Fatal("a running rule without the field must own its port as before")
	}
}

func TestSchedulerOnlyRuleStartsSchedulerWithoutOwningPort(t *testing.T) {
	scheduler := schedulerOnlyTestRule()
	// 同一台机器上另一条规则正好用着同号端口：端口归它，调度器照开。
	owner := runningRule{RuleID: 9, SourcePort: 41042, Protocol: "tcp", ForwardType: "gost"}
	ports, failovers := runningRuleWants([]runningRule{scheduler})
	if ports["41042"] {
		t.Fatal("a scheduler-only rule must not keep port state alive")
	}
	if len(failovers) != 1 || failovers[0].RuleID != 42 || !failovers[0].SchedulerOnly {
		t.Fatalf("scheduler-only rule must still start its scheduler: %+v", failovers)
	}
	ports, failovers = runningRuleWants([]runningRule{scheduler, owner})
	if !ports["41042"] {
		t.Fatal("the real rule on the same port number must keep its port")
	}
	if len(failovers) != 1 {
		t.Fatalf("only the scheduler-only rule carries a scheduler here: %+v", failovers)
	}
}

func TestSchedulerOnlyRuleIsNotRememberedAsPortState(t *testing.T) {
	t.Cleanup(func() { rememberDesiredRunningRules(nil) })
	scheduler := schedulerOnlyTestRule()
	owner := runningRule{RuleID: 9, SourcePort: 8443, Protocol: "tcp", ForwardType: "gost"}
	rememberDesiredRunningRules([]runningRule{scheduler, owner})
	if _, ok := desiredRunningRuleForStatePort(scheduler.RuleID, scheduler.SourcePort); ok {
		t.Fatal("a scheduler-only rule must not rewrite port state files")
	}
	if _, ok := desiredRunningRuleForAction(action{RuleID: scheduler.RuleID, SourcePort: scheduler.SourcePort, Protocol: "both"}); ok {
		t.Fatal("a scheduler-only rule must not protect or replace an action on that port")
	}
	for _, state := range desiredRunningRuleStatesSnapshot() {
		if state.RuleID == scheduler.RuleID {
			t.Fatalf("a scheduler-only rule must not be reported as local port state: %+v", state)
		}
	}
	if _, ok := desiredRunningRuleForStatePort(owner.RuleID, owner.SourcePort); !ok {
		t.Fatal("ordinary running rules are still remembered")
	}
}
