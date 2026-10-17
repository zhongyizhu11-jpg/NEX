package main

import (
	"fmt"
	"strings"
	"testing"
)

func TestParseOOMKillCount(t *testing.T) {
	count, ok := parseOOMKillCount(strings.NewReader("nr_free_pages 123\noom_kill 7\npgfault 9\n"))
	if !ok || count != 7 {
		t.Fatalf("got %d %v, want 7 true", count, ok)
	}
	if _, ok := parseOOMKillCount(strings.NewReader("nr_free_pages 123\n")); ok {
		t.Fatal("old kernels without oom_kill must report unknown")
	}
	if _, ok := parseOOMKillCount(strings.NewReader("oom_kill -1\n")); ok {
		t.Fatal("negative counters are not trusted")
	}
}

func TestParseSystemctlRestarts(t *testing.T) {
	output := "Id=forwardx-runtime.service\nNRestarts=3\n\nId=forwardx-agent.service\nNRestarts=0\n\nId=sshd.service\nNRestarts=5\n\nNRestarts=2\nId=forwardx-realm-12.service\n"
	got := parseSystemctlRestarts(output)
	if len(got) != 2 || got["forwardx-runtime.service"] != 3 || got["forwardx-realm-12.service"] != 2 {
		t.Fatalf("unexpected parse: %#v", got)
	}
}

func TestParseSystemctlRestartsCapsUnits(t *testing.T) {
	var b strings.Builder
	for i := 0; i < serviceRestartsMaxUnits+50; i++ {
		fmt.Fprintf(&b, "Id=forwardx-realm-%d.service\nNRestarts=%d\n\n", i, i+1)
	}
	got := parseSystemctlRestarts(b.String())
	if len(got) != serviceRestartsMaxUnits {
		t.Fatalf("got %d units, want %d", len(got), serviceRestartsMaxUnits)
	}
	if _, kept := got[fmt.Sprintf("forwardx-realm-%d.service", serviceRestartsMaxUnits+49)]; !kept {
		t.Fatal("the unit with the most restarts must be kept")
	}
}
