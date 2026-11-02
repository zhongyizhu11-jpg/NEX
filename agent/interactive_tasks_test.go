package main

import (
	"context"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type interactiveTaskProbe struct {
	release  chan struct{}
	started  atomic.Int32
	finished atomic.Int32
	mu       sync.Mutex
	rejects  []string
	rejected chan string
}

func newInteractiveTaskProbe() *interactiveTaskProbe {
	return &interactiveTaskProbe{release: make(chan struct{}), rejected: make(chan string, 64)}
}

func (p *interactiveTaskProbe) job(kind, id string, timeout time.Duration) interactiveTaskDispatch {
	return interactiveTaskDispatch{
		kind:    kind,
		taskID:  id,
		timeout: timeout,
		run: func(ctx context.Context) {
			p.started.Add(1)
			select {
			case <-p.release:
			case <-ctx.Done():
			}
			p.finished.Add(1)
		},
		reject: func(reason string) {
			p.mu.Lock()
			p.rejects = append(p.rejects, id)
			p.mu.Unlock()
			p.rejected <- reason
		},
	}
}

func waitInteractive(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func TestInteractiveTaskLimiterDedupesByKindAndTaskID(t *testing.T) {
	limiter := newInteractiveTaskLimiter(4, 4, time.Minute)
	probe := newInteractiveTaskProbe()
	defer close(probe.release)

	if !limiter.dispatch(probe.job("looking-glass", "t1", time.Minute)) {
		t.Fatal("first dispatch should be accepted")
	}
	if limiter.dispatch(probe.job("looking-glass", "t1", time.Minute)) {
		t.Fatal("duplicate task id should be ignored while running")
	}
	// 同一个 ID 在不同种类之间不算重复
	if !limiter.dispatch(probe.job("iperf3", "t1", time.Minute)) {
		t.Fatal("same id with a different kind should be accepted")
	}
	waitInteractive(t, "both tasks to start", func() bool { return probe.started.Load() == 2 })
	if len(probe.rejected) != 0 {
		t.Fatalf("duplicates must not be reported as rejected, got %d", len(probe.rejected))
	}
}

func TestInteractiveTaskLimiterAllowsSameIDAfterFinish(t *testing.T) {
	limiter := newInteractiveTaskLimiter(2, 2, time.Minute)
	var runs atomic.Int32
	job := interactiveTaskDispatch{kind: "diagnostics", taskID: "again", timeout: time.Minute, run: func(context.Context) { runs.Add(1) }}
	if !limiter.dispatch(job) {
		t.Fatal("first dispatch should be accepted")
	}
	waitInteractive(t, "first run to finish", func() bool {
		running, queued := limiter.stats()
		return runs.Load() == 1 && running == 0 && queued == 0
	})
	waitInteractive(t, "pending key to clear", func() bool {
		limiter.mu.Lock()
		defer limiter.mu.Unlock()
		return len(limiter.pending) == 0
	})
	if !limiter.dispatch(job) {
		t.Fatal("same task id should run again once the previous run finished")
	}
	waitInteractive(t, "second run", func() bool { return runs.Load() == 2 })
}

func TestInteractiveTaskLimiterCapsConcurrencyAndRejectsOverflow(t *testing.T) {
	limiter := newInteractiveTaskLimiter(4, 2, time.Minute)
	probe := newInteractiveTaskProbe()

	accepted := 0
	for i := 0; i < 9; i++ {
		if limiter.dispatch(probe.job("iperf3", fmt.Sprintf("task-%d", i), time.Minute)) {
			accepted++
		}
	}
	if accepted != 6 {
		t.Fatalf("expected 4 running + 2 queued accepted, got %d", accepted)
	}
	waitInteractive(t, "4 running", func() bool { return probe.started.Load() == 4 })
	// 多出来的 3 个应当各回一条「太多」的失败结果，而不是悄悄丢掉
	for i := 0; i < 3; i++ {
		select {
		case reason := <-probe.rejected:
			if reason != interactiveTaskBusyMessage {
				t.Fatalf("unexpected reject reason %q", reason)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("expected 3 busy rejections, got %d", i)
		}
	}
	time.Sleep(20 * time.Millisecond)
	if got := probe.started.Load(); got != 4 {
		t.Fatalf("no more than 4 tasks may run at once, got %d", got)
	}
	running, queued := limiter.stats()
	if running != 4 || queued != 2 {
		t.Fatalf("stats running=%d queued=%d, want 4/2", running, queued)
	}
	close(probe.release)
	waitInteractive(t, "queued tasks to run", func() bool { return probe.finished.Load() == 6 })
	waitInteractive(t, "limiter to drain", func() bool {
		running, queued := limiter.stats()
		return running == 0 && queued == 0
	})
}

func TestInteractiveTaskLimiterRejectsAfterQueueWait(t *testing.T) {
	limiter := newInteractiveTaskLimiter(1, 1, 30*time.Millisecond)
	probe := newInteractiveTaskProbe()
	defer close(probe.release)

	limiter.dispatch(probe.job("looking-glass", "busy", time.Minute))
	waitInteractive(t, "first task to start", func() bool { return probe.started.Load() == 1 })
	if !limiter.dispatch(probe.job("looking-glass", "waiting", time.Minute)) {
		t.Fatal("second task should be queued")
	}
	select {
	case reason := <-probe.rejected:
		if reason != interactiveTaskQueueTimeoutMessage {
			t.Fatalf("unexpected reject reason %q", reason)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("queued task should be rejected after the queue wait")
	}
	if probe.started.Load() != 1 {
		t.Fatal("timed-out queued task must not run")
	}
}

func TestInteractiveTaskLimiterRunHasDeadline(t *testing.T) {
	limiter := newInteractiveTaskLimiter(1, 0, time.Minute)
	probe := newInteractiveTaskProbe()
	defer close(probe.release)
	limiter.dispatch(probe.job("rule-connections", "slow", 20*time.Millisecond))
	// run 只在 ctx 到期时返回，名额随之释放
	waitInteractive(t, "run to hit its deadline", func() bool { return probe.finished.Load() == 1 })
	waitInteractive(t, "slot to be released", func() bool {
		running, _ := limiter.stats()
		return running == 0
	})
}

func TestInteractiveTaskRejectedResultsCarryError(t *testing.T) {
	lg := lookingGlassRejectedResult(lookingGlassTask{TaskID: "a", Method: "mtr", ResolvedAddress: "1.1.1.1"}, interactiveTaskBusyMessage)
	if lg.Error != interactiveTaskBusyMessage || lg.Output != interactiveTaskBusyMessage || lg.ExitCode == nil || *lg.ExitCode != 1 || lg.FinishedAt == "" {
		t.Fatalf("looking glass rejection = %+v", lg)
	}
	ip := iperf3RejectedResult(iperf3Task{TaskID: "b", Op: "start", Port: 5201}, interactiveTaskBusyMessage)
	if ip.Status != "error" || ip.Error != interactiveTaskBusyMessage || ip.TaskID != "b" {
		t.Fatalf("iperf3 rejection = %+v", ip)
	}
}

func TestRunDiagnosticsTaskContextStopsWithParent(t *testing.T) {
	env := fakeDiagnosticsEnv()
	env.now = time.Now
	env.lookupIP = func(ctx context.Context, _ string, _ string) ([]net.IP, error) {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	parent, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	started := time.Now()
	result := runDiagnosticsTaskContext(parent, env, diagnosticsTask{TaskID: "p", TimeoutMs: 20000, Checks: []diagnosticsCheck{{ID: "a", Kind: "dns", Host: "slow.example"}}})
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Fatalf("parent deadline ignored, took %v", elapsed)
	}
	if len(result.Results) != 1 {
		t.Fatalf("expected one check result, got %+v", result.Results)
	}
}
