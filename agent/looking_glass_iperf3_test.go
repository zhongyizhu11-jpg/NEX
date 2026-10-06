package main

import (
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestIperf3ClientCommandDefaultsAndClamps(t *testing.T) {
	command, args, err := iperf3ClientCommand(lookingGlassTask{ResolvedAddress: "203.0.113.9", Family: 4})
	if err != nil || command != "iperf3" {
		t.Fatalf("command = %q, err = %v", command, err)
	}
	joined := strings.Join(args, " ")
	for _, want := range []string{"-c 203.0.113.9", "-p 5201", "-P 4", "-t 10", "-i 1", "-f m", "--forceflush", "-4"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("missing %q in %q", want, joined)
		}
	}
	if strings.Contains(joined, "-R") {
		t.Fatalf("forward test must not pass -R: %q", joined)
	}

	_, args, _ = iperf3ClientCommand(lookingGlassTask{ResolvedAddress: "2001:db8::9", Family: 6, Port: 5301, Streams: 99, Seconds: 999, Reverse: true})
	joined = strings.Join(args, " ")
	for _, want := range []string{"-p 5301", "-P 16", "-t 30", "-6", "-R"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("missing %q in %q", want, joined)
		}
	}

	_, args, _ = iperf3ClientCommand(lookingGlassTask{ResolvedAddress: "203.0.113.9", Seconds: 1, Port: 70000})
	joined = strings.Join(args, " ")
	if !strings.Contains(joined, "-t 5") || !strings.Contains(joined, "-p 5201") {
		t.Fatalf("too-small seconds and invalid port must fall back: %q", joined)
	}

	if _, _, err := iperf3ClientCommand(lookingGlassTask{}); err == nil {
		t.Fatal("empty target must be rejected")
	}
}

func TestRunLookingGlassCommandThrottlesProgressReports(t *testing.T) {
	// 一口气吐 300 行：逐行回报会是 300 次 HTTP，节流后一秒之内只该报一两次。
	var calls atomic.Int32
	var lastOutput atomic.Value
	output, code, timedOut := runLookingGlassCommand("sh", []string{"-c", "i=0; while [ $i -lt 300 ]; do i=$((i+1)); echo line$i; done"}, 10*time.Second, func(text string, _ int) {
		calls.Add(1)
		lastOutput.Store(text)
	})
	if timedOut || code == nil || *code != 0 {
		t.Fatalf("command failed: timedOut=%v code=%v output=%q", timedOut, code, output)
	}
	if !strings.Contains(output, "line300") {
		t.Fatalf("final output lost lines: %q", output[len(output)-40:])
	}
	if n := calls.Load(); n > 5 {
		t.Fatalf("progress was reported %d times for a burst of 300 lines; expected throttling to about one per second", n)
	}
	if n := calls.Load(); n < 1 {
		t.Fatal("the first output line must still be reported promptly")
	}
}
