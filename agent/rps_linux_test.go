//go:build linux

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRPSCPUMask(t *testing.T) {
	cases := map[int]string{
		1:  "1",
		2:  "3",
		4:  "f",
		8:  "ff",
		12: "fff",
		32: "ffffffff",
		33: "1,ffffffff",
		64: "ffffffff,ffffffff",
		70: "3f,ffffffff,ffffffff",
	}
	for cpus, want := range cases {
		if got := rpsCPUMask(cpus); got != want {
			t.Fatalf("rpsCPUMask(%d) = %q, want %q", cpus, got, want)
		}
	}
}

func writeFakeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func readFakeFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(data))
}

func TestApplyRPSOnlyTouchesUnsetPhysicalQueues(t *testing.T) {
	root := t.TempDir()
	netClass := filepath.Join(root, "net")
	paths := rpsPaths{netClass: netClass, sockFlowPath: filepath.Join(root, "rps_sock_flow_entries")}
	writeFakeFile(t, paths.sockFlowPath, "0\n")
	// eth0：单队列 virtio，没设过 → 要开。
	writeFakeFile(t, filepath.Join(netClass, "eth0", "device", "vendor"), "0x1af4\n")
	writeFakeFile(t, filepath.Join(netClass, "eth0", "queues", "rx-0", "rps_cpus"), "0\n")
	writeFakeFile(t, filepath.Join(netClass, "eth0", "queues", "rx-0", "rps_flow_cnt"), "0\n")
	// eth1：用户自己设过 → 不动。
	writeFakeFile(t, filepath.Join(netClass, "eth1", "device", "vendor"), "0x1af4\n")
	writeFakeFile(t, filepath.Join(netClass, "eth1", "queues", "rx-0", "rps_cpus"), "2\n")
	// eth2：队列数不少于核数 → 网卡自己分，不动。
	for _, q := range []string{"rx-0", "rx-1", "rx-2", "rx-3"} {
		writeFakeFile(t, filepath.Join(netClass, "eth2", "device", "vendor"), "0x8086\n")
		writeFakeFile(t, filepath.Join(netClass, "eth2", "queues", q, "rps_cpus"), "0\n")
	}
	// lo、docker0（没有 device）→ 不动。
	writeFakeFile(t, filepath.Join(netClass, "lo", "queues", "rx-0", "rps_cpus"), "0\n")
	writeFakeFile(t, filepath.Join(netClass, "docker0", "queues", "rx-0", "rps_cpus"), "0\n")

	changed, err := applyRPSWith(paths, 4)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(changed, ",") != "eth0" {
		t.Fatalf("changed = %v", changed)
	}
	if got := readFakeFile(t, filepath.Join(netClass, "eth0", "queues", "rx-0", "rps_cpus")); got != "f" {
		t.Fatalf("eth0 rps_cpus = %q", got)
	}
	if got := readFakeFile(t, filepath.Join(netClass, "eth0", "queues", "rx-0", "rps_flow_cnt")); got != "32768" {
		t.Fatalf("eth0 rps_flow_cnt = %q", got)
	}
	if got := readFakeFile(t, paths.sockFlowPath); got != "32768" {
		t.Fatalf("rps_sock_flow_entries = %q", got)
	}
	if got := readFakeFile(t, filepath.Join(netClass, "eth1", "queues", "rx-0", "rps_cpus")); got != "2" {
		t.Fatalf("eth1 was overwritten: %q", got)
	}
	for _, name := range []string{"eth2", "lo", "docker0"} {
		if got := readFakeFile(t, filepath.Join(netClass, name, "queues", "rx-0", "rps_cpus")); got != "0" {
			t.Fatalf("%s was touched: %q", name, got)
		}
	}
}

func TestApplyRPSSingleCPUDoesNothing(t *testing.T) {
	root := t.TempDir()
	netClass := filepath.Join(root, "net")
	writeFakeFile(t, filepath.Join(netClass, "eth0", "device", "vendor"), "0x1af4\n")
	writeFakeFile(t, filepath.Join(netClass, "eth0", "queues", "rx-0", "rps_cpus"), "0\n")
	changed, err := applyRPSWith(rpsPaths{netClass: netClass, sockFlowPath: filepath.Join(root, "x")}, 1)
	if err != nil || len(changed) != 0 {
		t.Fatalf("changed=%v err=%v", changed, err)
	}
}
