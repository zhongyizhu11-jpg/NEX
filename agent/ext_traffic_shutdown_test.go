package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

type fakeShutdownRunner struct {
	mu    sync.Mutex
	calls [][]string
	done  chan struct{}
	err   error
}

func (r *fakeShutdownRunner) run(args []string) error {
	r.mu.Lock()
	r.calls = append(r.calls, append([]string(nil), args...))
	r.mu.Unlock()
	select {
	case r.done <- struct{}{}:
	default:
	}
	return r.err
}

func (r *fakeShutdownRunner) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.calls)
}

func newTestTrafficShutdownModule(latch string, runner *fakeShutdownRunner, supported bool) *trafficShutdownExtModule {
	m := newTrafficShutdownExtModule()
	m.latchPath = func() string { return latch }
	m.supported = func() bool { return supported }
	m.command = func() ([]string, error) { return []string{"/sbin/poweroff"}, nil }
	m.run = runner.run
	m.delay = 0
	return m
}

func waitShutdownRun(t *testing.T, runner *fakeShutdownRunner) {
	t.Helper()
	select {
	case <-runner.done:
	case <-time.After(5 * time.Second):
		t.Fatal("shutdown command was not run")
	}
}

func shutdownDirective(mark string) json.RawMessage {
	raw, _ := json.Marshal(map[string]any{"shutdown": true, "mark": mark, "thresholdPercent": 90})
	return raw
}

func TestTrafficShutdownRunsOncePerCycleAndSurvivesReboot(t *testing.T) {
	latch := filepath.Join(t.TempDir(), "state", "traffic-shutdown.json")
	runner := &fakeShutdownRunner{done: make(chan struct{}, 4)}
	m := newTestTrafficShutdownModule(latch, runner, true)

	m.Apply(Config{}, shutdownDirective("7:1700000000"))
	waitShutdownRun(t, runner)
	if runner.count() != 1 || runner.calls[0][0] != "/sbin/poweroff" {
		t.Fatalf("unexpected shutdown calls %v", runner.calls)
	}
	raw, err := os.ReadFile(latch)
	if err != nil {
		t.Fatalf("latch not persisted: %v", err)
	}
	var saved trafficShutdownLatch
	if json.Unmarshal(raw, &saved) != nil || saved.Mark != "7:1700000000" || saved.At <= 0 {
		t.Fatalf("unexpected latch %s", raw)
	}

	// 同一周期重发：不再关。
	if m.execute("7:1700000000", 90) {
		t.Fatal("repeated directive for the same cycle must be ignored")
	}

	// 「开机」：新进程（新模块）读同一个标记文件，同一周期的指令仍然不关。
	rebooted := newTestTrafficShutdownModule(latch, runner, true)
	rebooted.Apply(Config{}, shutdownDirective("7:1700000000"))
	time.Sleep(50 * time.Millisecond)
	if runner.count() != 1 {
		t.Fatalf("shutdown re-ran after reboot in the same cycle: %d calls", runner.count())
	}
	report, _ := json.Marshal(rebooted.Report(Config{}))
	if string(report) == "" || !json.Valid(report) {
		t.Fatal("report should be valid JSON")
	}
	var parsed map[string]any
	_ = json.Unmarshal(report, &parsed)
	if parsed["lastMark"] != "7:1700000000" || parsed["supported"] != true {
		t.Fatalf("unexpected report %s", report)
	}

	// 流量重置换了周期：下一次到阈值可以再关一次。
	rebooted.Apply(Config{}, shutdownDirective("7:1702600000"))
	waitShutdownRun(t, runner)
	if runner.count() != 2 {
		t.Fatalf("new cycle should shut down once more, calls=%d", runner.count())
	}
}

func TestTrafficShutdownRefusesWhenUnsupportedOrLatchFails(t *testing.T) {
	runner := &fakeShutdownRunner{done: make(chan struct{}, 4)}

	unsupportedLatch := filepath.Join(t.TempDir(), "latch.json")
	unsupported := newTestTrafficShutdownModule(unsupportedLatch, runner, false)
	if unsupported.execute("1:0", 100) {
		t.Fatal("non-root / non-Linux Agent must not shut down")
	}
	if _, err := os.Stat(unsupportedLatch); err == nil {
		t.Fatal("unsupported Agent should not write a latch")
	}

	// 标记文件写不进去（父路径是个普通文件）：保证不了每周期一次，就不关。
	blocker := filepath.Join(t.TempDir(), "not-a-dir")
	if err := os.WriteFile(blocker, []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	unwritable := newTestTrafficShutdownModule(filepath.Join(blocker, "latch.json"), runner, true)
	if unwritable.execute("1:0", 100) {
		t.Fatal("must not shut down when the latch cannot be persisted")
	}

	noCommand := newTestTrafficShutdownModule(filepath.Join(t.TempDir(), "latch.json"), runner, true)
	noCommand.command = func() ([]string, error) { return nil, errors.New("no supported shutdown command found") }
	if noCommand.execute("1:0", 100) {
		t.Fatal("must not shut down without a local shutdown command")
	}

	// 只认 shutdown=true 的指令，其它形状一律忽略。
	ignored := newTestTrafficShutdownModule(filepath.Join(t.TempDir(), "latch.json"), runner, true)
	ignored.Apply(Config{}, json.RawMessage(`{"shutdown":false,"mark":"1:0"}`))
	ignored.Apply(Config{}, json.RawMessage(`{"command":"rm -rf /"}`))
	ignored.Apply(Config{}, json.RawMessage(`not json`))
	time.Sleep(50 * time.Millisecond)
	if runner.count() != 0 {
		t.Fatalf("unexpected shutdown calls %v", runner.calls)
	}
}

func TestTrafficShutdownCommandIsLocalAndFixed(t *testing.T) {
	args, err := trafficShutdownCommand()
	if err != nil {
		if trafficShutdownSupported() {
			t.Fatalf("supported Agent without command: %v", err)
		}
		return
	}
	base := filepath.Base(args[0])
	if base != "systemctl" && base != "shutdown" && base != "poweroff" {
		t.Fatalf("unexpected shutdown command %v", args)
	}
}
