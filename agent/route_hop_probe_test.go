package main

import (
	"errors"
	"net"
	"testing"
	"time"
)

func routeHopTestRunner(clock *time.Time, reachable *bool) *routeHopProbeRunner {
	runner := newRouteHopProbeRunner()
	runner.now = func() time.Time { return *clock }
	runner.dial = func(network, address string, timeout time.Duration) (net.Conn, error) {
		if *reachable {
			client, server := net.Pipe()
			_ = server.Close()
			return client, nil
		}
		return nil, errors.New("refused")
	}
	return runner
}

func routeHopRound(runner *routeHopProbeRunner, clock *time.Time, step time.Duration) []map[string]any {
	for _, state := range runner.due() {
		runner.probe(state)
	}
	results := runner.report()
	*clock = clock.Add(step)
	return results
}

func TestRouteHopProbeFlipsFastAndRecoversAfterStableOks(t *testing.T) {
	clock := time.Unix(1_800_000_000, 0)
	reachable := true
	runner := routeHopTestRunner(&clock, &reachable)
	spec := &routeHopProbeSpec{IntervalMs: 1500, TimeoutMs: 1000, FailThreshold: 2, RecoverOks: 3}
	runner.sync([]ruleLatencyProbe{{RuleID: 41, TargetIP: "203.0.113.9", TargetPort: 443, RouteHop: spec}})

	first := routeHopRound(runner, &clock, 1500*time.Millisecond)
	if len(first) != 1 || first[0]["down"] != false {
		t.Fatalf("first ok probe reports the hop as up so the panel knows the fast path is live: %#v", first)
	}

	reachable = false
	if got := routeHopRound(runner, &clock, 1500*time.Millisecond); got != nil {
		t.Fatalf("one failure is not enough to flip (threshold 2): %#v", got)
	}
	down := routeHopRound(runner, &clock, 1500*time.Millisecond)
	if len(down) != 1 || down[0]["ruleId"] != 41 || down[0]["down"] != true {
		t.Fatalf("second consecutive failure flips to down and reports immediately: %#v", down)
	}

	reachable = true
	for i := 0; i < 2; i++ {
		if got := routeHopRound(runner, &clock, 1500*time.Millisecond); got != nil {
			t.Fatalf("recovery needs 3 stable oks, reported after %d: %#v", i+1, got)
		}
	}
	up := routeHopRound(runner, &clock, 1500*time.Millisecond)
	if len(up) != 1 || up[0]["down"] != false {
		t.Fatalf("third ok in a row reports recovery: %#v", up)
	}
}

func TestRouteHopProbeSnapshotAndDroppedProbes(t *testing.T) {
	clock := time.Unix(1_800_000_000, 0)
	reachable := true
	runner := routeHopTestRunner(&clock, &reachable)
	spec := &routeHopProbeSpec{IntervalMs: 1500}
	runner.sync([]ruleLatencyProbe{
		{RuleID: 1, TargetIP: "198.51.100.1", TargetPort: 80, RouteHop: spec},
		{RuleID: 2, TargetIP: "198.51.100.2", TargetPort: 80},
	})
	if len(runner.states) != 1 {
		t.Fatalf("only probes carrying routeHop are run fast: %d", len(runner.states))
	}
	routeHopRound(runner, &clock, time.Second)
	if got := routeHopRound(runner, &clock, routeHopProbeSnapshotEvery); got != nil {
		t.Fatalf("no flip, no snapshot due yet: %#v", got)
	}
	if got := routeHopRound(runner, &clock, time.Second); len(got) != 1 {
		t.Fatalf("every 30s a full snapshot keeps the panel's fast path fresh: %#v", got)
	}
	runner.sync(nil)
	if !runner.idle() {
		t.Fatalf("probes the panel no longer sends are dropped")
	}
}
