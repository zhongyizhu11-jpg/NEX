package main

import (
	"encoding/json"
	"strconv"
	"testing"
	"time"
)

func TestQuotaExtFlushesOnceThenRetriesOnce(t *testing.T) {
	m := newQuotaExtModule()
	var calls []string
	m.runDelete = func(protocol string, port int) { calls = append(calls, protocol+":"+strconv.Itoa(port)) }
	m.lookPath = func() bool { return true }
	now := time.Unix(1_800_000_000, 0)
	m.now = func() time.Time { return now }

	directive, _ := json.Marshal(quotaDirective{Mode: "cut", Flush: []quotaFlushItem{{Key: "r1-p3000-t1", Port: 3000, Protocol: "tcp"}, {Key: "r2-p3001-t1", Port: 3001, Protocol: "both"}}})
	m.Apply(Config{}, directive)
	if len(calls) != 3 {
		t.Fatalf("first round should flush tcp:3000 + tcp/udp:3001, got %v", calls)
	}
	// 同一轮指令重发：还没到 30 秒，不再清
	m.Apply(Config{}, directive)
	if len(calls) != 3 {
		t.Fatalf("repeat within delay should not flush, got %v", calls)
	}
	// 30 秒后兜底再清一次
	now = now.Add(31 * time.Second)
	m.Apply(Config{}, directive)
	if len(calls) != 6 {
		t.Fatalf("second flush expected after delay, got %v", calls)
	}
	// 之后不再动
	now = now.Add(5 * time.Minute)
	m.Apply(Config{}, directive)
	if len(calls) != 6 {
		t.Fatalf("no more flushes expected, got %v", calls)
	}
	if m.flushed != 2 {
		t.Fatalf("flushed count = %d, want 2", m.flushed)
	}
}

func TestQuotaExtDrainModeAndMissingToolDoNothing(t *testing.T) {
	m := newQuotaExtModule()
	calls := 0
	m.runDelete = func(string, int) { calls++ }
	m.lookPath = func() bool { return true }
	drain, _ := json.Marshal(quotaDirective{Mode: "drain", Flush: []quotaFlushItem{{Key: "a", Port: 1, Protocol: "tcp"}}})
	m.Apply(Config{}, drain)
	m.lookPath = func() bool { return false }
	cut, _ := json.Marshal(quotaDirective{Mode: "cut", Flush: []quotaFlushItem{{Key: "a", Port: 1, Protocol: "tcp"}}})
	m.Apply(Config{}, cut)
	if calls != 0 {
		t.Fatalf("expected no conntrack calls, got %d", calls)
	}
	report := m.Report(Config{}).(map[string]any)
	if report["conntrack"] != false {
		t.Fatalf("report should say conntrack missing: %v", report)
	}
}

func TestQuotaExtForgetsKeysNoLongerSent(t *testing.T) {
	m := newQuotaExtModule()
	m.runDelete = func(string, int) {}
	m.lookPath = func() bool { return true }
	first, _ := json.Marshal(quotaDirective{Mode: "cut", Flush: []quotaFlushItem{{Key: "a", Port: 1, Protocol: "tcp"}}})
	m.Apply(Config{}, first)
	empty, _ := json.Marshal(quotaDirective{Mode: "cut"})
	m.Apply(Config{}, empty)
	if len(m.state) != 0 {
		t.Fatalf("state should be cleared, got %v", m.state)
	}
}
