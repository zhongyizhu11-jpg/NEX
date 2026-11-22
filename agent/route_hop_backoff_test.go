package main

import (
	"context"
	"errors"
	"net"
	"os"
	"syscall"
	"testing"
	"time"
)

func TestRouteHopDialRejectedClassifiesActiveRejectionOnly(t *testing.T) {
	refused := &net.OpError{Op: "dial", Net: "tcp", Err: os.NewSyscallError("connect", syscall.ECONNREFUSED)}
	reset := &net.OpError{Op: "read", Net: "tcp", Err: os.NewSyscallError("read", syscall.ECONNRESET)}
	unreachable := &net.OpError{Op: "dial", Net: "tcp", Err: os.NewSyscallError("connect", syscall.EHOSTUNREACH)}
	netUnreachable := &net.OpError{Op: "dial", Net: "tcp", Err: os.NewSyscallError("connect", syscall.ENETUNREACH)}
	timeout := &net.OpError{Op: "dial", Net: "tcp", Err: context.DeadlineExceeded}
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"refused", refused, true},
		{"reset", reset, true},
		{"refused text", errors.New("dial tcp 203.0.113.8:443: connect: connection refused"), true},
		{"timeout", timeout, false},
		{"i/o timeout text", errors.New("dial tcp 203.0.113.8:443: i/o timeout"), false},
		{"host unreachable", unreachable, false},
		{"net unreachable", netUnreachable, false},
		{"nil", nil, false},
	}
	for _, c := range cases {
		if got := routeHopDialRejected(c.err); got != c.want {
			t.Fatalf("%s: routeHopDialRejected=%v want %v", c.name, got, c.want)
		}
	}
}

func routeHopBackoffRunner(clock *time.Time, reachable *bool, failure error) (*routeHopProbeRunner, *routeHopProbeState) {
	runner := routeHopTestRunner(clock, reachable)
	runner.dial = func(network, address string, timeout time.Duration) (net.Conn, error) {
		if *reachable {
			client, server := net.Pipe()
			_ = server.Close()
			return client, nil
		}
		return nil, failure
	}
	runner.scanner = nil
	spec := &routeHopProbeSpec{IntervalMs: 2000, FailThreshold: 2, RecoverOks: 3, Passive: true}
	runner.sync([]ruleLatencyProbe{{RuleID: 8, TargetIP: "203.0.113.8", TargetPort: 443, RouteHop: spec}})
	var state *routeHopProbeState
	for _, s := range runner.states {
		state = s
	}
	return runner, state
}

// routeHopBackoffStep 跑到下一次到点：返回这一次排的间隔。
func routeHopBackoffStep(runner *routeHopProbeRunner, state *routeHopProbeState, clock *time.Time) time.Duration {
	for _, due := range runner.due() {
		runner.probe(due)
	}
	gap := state.nextDue.Sub(*clock)
	*clock = state.nextDue
	return gap
}

// 出口自己的网络断了 / 被黑洞（连接超时）：不放慢到 60 秒，最多两倍节拍 —— 恢复要几秒内看到（全局故障后
// 各台出口都在退避里，面板拿到的「连不上」全是旧的，GOST 摘错出口、恢复的出口半分钟才放回）。
func TestRouteHopTimeoutBackoffCappedAtTwiceCadence(t *testing.T) {
	clock := time.Unix(1_800_000_000, 0)
	reachable := false
	runner, state := routeHopBackoffRunner(&clock, &reachable, &net.OpError{Op: "dial", Net: "tcp", Err: context.DeadlineExceeded})
	gaps := []time.Duration{}
	for round := 0; round < 10; round++ {
		gaps = append(gaps, routeHopBackoffStep(runner, state, &clock))
	}
	if !state.down {
		t.Fatalf("exit should be down")
	}
	for i, gap := range gaps {
		if gap > 4*time.Second {
			t.Fatalf("timeouts never back off past 2x cadence: round %d gap %v (%v)", i, gap, gaps)
		}
	}
	if gaps[len(gaps)-1] != 4*time.Second {
		t.Fatalf("down by timeout: 2x cadence, got %v", gaps)
	}
	// 恢复：通了一次以后按原节拍确认（3 次通），不再按两倍
	reachable = true
	recoveredAfter := time.Duration(0)
	for round := 0; round < 6 && state.down; round++ {
		recoveredAfter += routeHopBackoffStep(runner, state, &clock)
	}
	if state.down {
		t.Fatalf("exit should have recovered")
	}
	// 已经排好的那一次（≤ 4 秒）+ 两次原节拍
	if got, want := recoveredAfter, 4*time.Second+2*2*time.Second; got > want {
		t.Fatalf("recovery after a timeout outage seen within %v, took %v", want, got)
	}
}

// 目标主动拒绝的出口通了一次以后也按原节拍确认恢复（每次只连 1 次，只多 2 次连接）。
func TestRouteHopRejectedBackoffConfirmsRecoveryAtNormalCadence(t *testing.T) {
	clock := time.Unix(1_800_000_000, 0)
	reachable := false
	refused := &net.OpError{Op: "dial", Net: "tcp", Err: os.NewSyscallError("connect", syscall.ECONNREFUSED)}
	runner, state := routeHopBackoffRunner(&clock, &reachable, refused)
	for round := 0; round < 8; round++ {
		routeHopBackoffStep(runner, state, &clock)
	}
	if !state.down || routeHopProbeInterval(state) != routeHopProbeBackoffMax {
		t.Fatalf("an actively rejected exit backs off to the max: down=%v interval=%v", state.down, routeHopProbeInterval(state))
	}
	reachable = true
	// 已经排好的那次（60 秒）照旧；通了以后 2 秒一次
	routeHopBackoffStep(runner, state, &clock)
	if got := routeHopProbeInterval(state); got != 2*time.Second {
		t.Fatalf("after one ok while down the next check is at normal cadence: %v", got)
	}
	// 中途又被拒：回到长退避
	reachable = false
	routeHopBackoffStep(runner, state, &clock)
	if got := routeHopProbeInterval(state); got < 4*time.Second {
		t.Fatalf("rejected again after one ok: back off again, got %v", got)
	}
}

// 面板拿 ageMs / intervalMs 判断「连不上」这条结论是不是旧的（server/exitTargetHealth.ts）。
func TestRouteHopReportCarriesProbeAgeAndInterval(t *testing.T) {
	clock := time.Unix(1_800_000_000, 0)
	reachable := true
	runner, _ := routeHopBackoffRunner(&clock, &reachable, nil)
	for _, due := range runner.due() {
		runner.probe(due)
	}
	clock = clock.Add(1500 * time.Millisecond)
	// 有真实流量时才是面板下发的节拍（闲着的出口放慢到 30 秒，见 routeHopIdleStretch）
	for _, state := range runner.states {
		state.passiveSeenAt = clock
	}
	got := runner.report()
	if len(got) != 1 {
		t.Fatalf("first result reported: %#v", got)
	}
	if got[0]["ageMs"] != int64(1500) || got[0]["intervalMs"] != int64(2000) {
		t.Fatalf("report carries how old the result is and the current probe interval: %#v", got[0])
	}
}
