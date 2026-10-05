package main

import (
	"strings"
	"sync"
	"testing"
)

const lazyListenSSOutputWithOwners = `
tcp LISTEN 0 4096 *:19850 *:* users:(("gost",pid=100,fd=7))
udp UNCONN 0 0 *:19850 *:* users:(("gost",pid=100,fd=8))
tcp LISTEN 0 4096 *:19851 *:* users:(("xray",pid=200,fd=7))
`

// 不带 -p 时 ss 只少了 users:(...) 那一列。
func lazyListenSSOutputWithoutOwners() string {
	var lines []string
	for _, line := range strings.Split(lazyListenSSOutputWithOwners, "\n") {
		if idx := strings.Index(line, " users:"); idx >= 0 {
			line = line[:idx]
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n")
}

func stubRuntimeListenSS(t *testing.T, ok bool) *[]bool {
	t.Helper()
	var mu sync.Mutex
	calls := []bool{}
	previous := runtimeListenSSOutput
	runtimeListenSSOutput = func(withOwners bool) (string, bool) {
		mu.Lock()
		calls = append(calls, withOwners)
		mu.Unlock()
		if !ok {
			return "", false
		}
		if withOwners {
			return lazyListenSSOutputWithOwners, true
		}
		return lazyListenSSOutputWithoutOwners(), true
	}
	t.Cleanup(func() { runtimeListenSSOutput = previous })
	return &calls
}

func TestRuntimeListenSnapshotRunsSSOnlyWhenQueried(t *testing.T) {
	calls := stubRuntimeListenSS(t, true)
	_ = newRuntimeListenSnapshot()
	if len(*calls) != 0 {
		t.Fatalf("building a snapshot ran ss %d time(s) before any query", len(*calls))
	}
}

func TestRuntimeListenSnapshotSkipsProcessScanForPortOnlyChecks(t *testing.T) {
	calls := stubRuntimeListenSS(t, true)
	snapshot := newRuntimeListenSnapshot()
	if !runtimeListenPortReady(snapshot, 19850, "both", nil) {
		t.Fatal("port-only check should see the tcp+udp listener")
	}
	if runtimeListenPortReady(snapshot, 19852, "tcp", nil) {
		t.Fatal("port-only check accepted a port nobody listens on")
	}
	// 带进程名的检查查的是没在监听的端口：结果一定是没就绪，用不着进程信息。
	if runtimeListenPortReady(snapshot, 19852, "tcp", []string{"gost"}) {
		t.Fatal("owner check accepted a port nobody listens on")
	}
	if got := *calls; len(got) != 1 || got[0] {
		t.Fatalf("ss calls (withOwners) = %v, want one call without -p", got)
	}

	// 带进程名、端口在监听：补跑一次 -p，按进程名判断的结果和以前一致。
	if !runtimeListenPortReady(snapshot, 19850, "both", []string{"gost"}) {
		t.Fatal("gost listener should satisfy the gost owner check")
	}
	if runtimeListenPortReady(snapshot, 19851, "tcp", []string{"gost"}) {
		t.Fatal("xray listener must not satisfy the gost owner check once owners are known")
	}
	if got := *calls; len(got) != 2 || !got[1] {
		t.Fatalf("ss calls (withOwners) = %v, want a single -p upgrade", got)
	}
}

func TestRuntimeListenSnapshotFirstOwnerQueryUsesSingleProcessScan(t *testing.T) {
	calls := stubRuntimeListenSS(t, true)
	snapshot := newRuntimeListenSnapshot()
	if runtimeListenPortReady(snapshot, 19851, "tcp", []string{"gost"}) {
		t.Fatal("xray listener satisfied the gost owner check")
	}
	if !runtimeListenPortReady(snapshot, 19851, "tcp", nil) {
		t.Fatal("port-only check should accept the xray listener")
	}
	if got := *calls; len(got) != 1 || !got[0] {
		t.Fatalf("ss calls (withOwners) = %v, want exactly one -p call", got)
	}
}

func TestRuntimeListenSnapshotMatchesEagerResults(t *testing.T) {
	stubRuntimeListenSS(t, true)
	eager := &runtimeListenSnapshot{tcpPorts: map[int][]string{}, udpPorts: map[int][]string{}}
	eager.parseSSListenOutput(lazyListenSSOutputWithOwners)
	queries := []struct {
		port     int
		protocol string
		needles  []string
	}{
		{19850, "tcp", nil}, {19850, "udp", []string{"gost"}}, {19851, "tcp", []string{"gost"}},
		{19851, "tcp", []string{"xray"}}, {19851, "both", nil}, {19852, "tcp", nil}, {19850, "both", []string{"forwardx-fxp"}},
	}
	lazy := newRuntimeListenSnapshot()
	for _, q := range queries {
		if got, want := runtimeListenPortReady(lazy, q.port, q.protocol, q.needles), runtimeListenPortReady(eager, q.port, q.protocol, q.needles); got != want {
			t.Fatalf("lazy snapshot result %v for %+v, eager ss -ltnup result %v", got, q, want)
		}
	}
}
