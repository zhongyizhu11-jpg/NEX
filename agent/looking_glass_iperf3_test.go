package main

import (
	"strings"
	"testing"
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
