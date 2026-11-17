package main

import (
	"testing"
	"time"
)

func resetBalanceReporterForTest() {
	balanceReporter.mu.Lock()
	balanceReporter.entries = map[*exitEndpointSelector]config{}
	balanceReporter.rules = map[string]*balanceRuleState{}
	balanceReporter.dirty = false
	balanceReporter.dirtyAt = time.Time{}
	balanceReporter.last = time.Time{}
	balanceReporter.mu.Unlock()
}

func balanceTestSelector(strategy string) *exitEndpointSelector {
	exits := []exitEndpoint{
		{Host: "198.51.100.12", Port: 41001, Key: "k", TargetStatus: true, HostID: 2},
		{Host: "198.51.100.13", Port: 41002, Key: "k", TargetStatus: true, HostID: 3},
		{Host: "198.51.100.14", Port: 41003, Key: "k", TargetStatus: true, HostID: 4},
	}
	fail := 2
	return newExitEndpointSelector(exits, exitEndpoint{Host: "198.51.100.12", Port: 41001, Key: "k"}, strategy, &balanceDetectConfig{FailThreshold: fail, RecoverThreshold: 3})
}

func balanceReportFor(t *testing.T, now time.Time) balanceRuleReport {
	t.Helper()
	groups, due := collectBalanceReports(now, true)
	if !due {
		t.Fatalf("forced collection is always due")
	}
	for _, rules := range groups {
		if len(rules) == 1 {
			return rules[0]
		}
	}
	t.Fatalf("one rule reported: %#v", groups)
	return balanceRuleReport{}
}

// 用户遇到的情况：主出口 jinx 连不上目标（高防挡了），流量已经在 hep ix 上。面板要看到的是入口真实的选择。
func TestBalanceReportShowsTheExitTheEntryActuallyUses(t *testing.T) {
	resetFXPEndpointRegistry()
	resetBalanceReporterForTest()
	s := balanceTestSelector("fallback")
	release := registerBalanceReport(s, config{Role: "entry", TunnelID: 7, RuleID: 501, PanelURL: "https://panel.example", Token: "t"})
	defer release()

	now := time.Unix(1_800_000_000, 0)
	first := balanceReportFor(t, now)
	if first.Exits[0].State != "active" || first.Exits[1].State != "standby" || first.Exits[0].HostID != 2 {
		t.Fatalf("before anything goes wrong the primary is in use: %#v", first.Exits)
	}

	s.observeTarget(0, false, 4*time.Second)
	s.observeTarget(0, false, 4*time.Second)
	s.observeTarget(1, true, 7*time.Millisecond)
	report := balanceReportFor(t, now.Add(time.Second))
	if report.Exits[0].State != "down" || report.Exits[0].Reason != "target" {
		t.Fatalf("primary cannot reach the target: %#v", report.Exits[0])
	}
	if report.Exits[1].State != "active" || report.Exits[1].HostID != 3 || report.Exits[1].MedianMs != 7 {
		t.Fatalf("hep ix carries the traffic now: %#v", report.Exits[1])
	}
	if len(report.Events) != 2 || report.Events[0].From != "active" || report.Events[0].To != "down" || report.Events[0].HostID != 2 {
		t.Fatalf("the switch is recorded: %#v", report.Events)
	}
	if !report.TargetAware || report.Strategy != "fallback" {
		t.Fatalf("strategy and target awareness reported: %#v", report)
	}
}

func TestBalanceReportSharesComeFromRealPicks(t *testing.T) {
	resetFXPEndpointRegistry()
	resetBalanceReporterForTest()
	s := balanceTestSelector("round_robin")
	release := registerBalanceReport(s, config{Role: "entry", TunnelID: 7, RuleID: 502, PanelURL: "https://panel.example", Token: "t"})
	defer release()
	now := time.Unix(1_800_000_000, 0)
	_ = balanceReportFor(t, now)

	s.observeTarget(2, false, time.Second)
	s.observeTarget(2, false, time.Second)
	for i := 0; i < 10; i++ {
		if _, _, ok := s.pick(nil); !ok {
			t.Fatalf("pick")
		}
	}
	report := balanceReportFor(t, now.Add(time.Second))
	if report.Exits[0].Picks+report.Exits[1].Picks != 10 || report.Exits[2].Picks != 0 {
		t.Fatalf("new connections only went to the two good exits: %#v", report.Exits)
	}
	if report.Exits[0].Share != 0.5 || report.Exits[2].State != "down" {
		t.Fatalf("shares are the real split: %#v", report.Exits)
	}
	// 下一段时间没有新连接：比例是 -1，在用 / 备用按「现在会挑谁」
	quiet := balanceReportFor(t, now.Add(2*time.Second))
	if quiet.Exits[0].Share != -1 || quiet.Exits[0].State != "active" {
		t.Fatalf("quiet period falls back to the current choice: %#v", quiet.Exits)
	}
}

func TestBalanceReportOnlyForEntriesWithPanel(t *testing.T) {
	resetBalanceReporterForTest()
	s := balanceTestSelector("auto")
	registerBalanceReport(s, config{Role: "entry", RuleID: 1})()
	registerBalanceReport(nil, config{Role: "entry", RuleID: 1, PanelURL: "x", Token: "y"})()
	balanceReporter.mu.Lock()
	n := len(balanceReporter.entries)
	balanceReporter.mu.Unlock()
	if n != 0 {
		t.Fatalf("no panel address / token: nothing to report to")
	}
}

func TestBalanceReportIsDueOnChangeOrEveryTenSeconds(t *testing.T) {
	resetFXPEndpointRegistry()
	resetBalanceReporterForTest()
	s := balanceTestSelector("fallback")
	release := registerBalanceReport(s, config{Role: "entry", TunnelID: 7, RuleID: 503, PanelURL: "https://panel.example", Token: "t"})
	defer release()
	now := time.Unix(1_800_000_000, 0)
	if _, due := collectBalanceReports(now, false); !due {
		t.Fatalf("first report goes out right away")
	}
	if _, due := collectBalanceReports(now.Add(time.Second), false); due {
		t.Fatalf("nothing changed: wait")
	}
	s.observeTarget(0, false, time.Second)
	s.observeTarget(0, false, time.Second)
	collectBalanceReports(now.Add(2*time.Second), false)
	if _, due := collectBalanceReports(now.Add(3*time.Second), false); !due {
		t.Fatalf("a change goes out within about a second")
	}
	if _, due := collectBalanceReports(now.Add(12*time.Second), false); due {
		t.Fatalf("quiet again")
	}
	if _, due := collectBalanceReports(now.Add(14*time.Second), false); !due {
		t.Fatalf("every ten seconds anyway")
	}
}
