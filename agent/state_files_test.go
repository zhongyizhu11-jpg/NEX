package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWriteStateFileCreatesDirectoryAndReplacesAtomically(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "nested", "state")
	path := filepath.Join(dir, "port_8080.rule")
	if err := writeStateFile(path, []byte("12")); err != nil {
		t.Fatalf("write: %v", err)
	}
	if raw, err := os.ReadFile(path); err != nil || string(raw) != "12" {
		t.Fatalf("content = %q, %v", raw, err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0644 {
		t.Fatalf("mode = %v, %v", info, err)
	}
	if err := writeStateFile(path, []byte("13")); err != nil {
		t.Fatalf("rewrite: %v", err)
	}
	if raw, _ := os.ReadFile(path); string(raw) != "13" {
		t.Fatalf("content after rewrite = %q", raw)
	}
	entries, _ := os.ReadDir(dir)
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".") {
			t.Fatalf("temporary file left behind: %s", entry.Name())
		}
	}
}

func TestWriteStateFileSkipsUnchangedContent(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "port_1.fwtype")
	if err := writeStateFile(path, []byte("iptables")); err != nil {
		t.Fatal(err)
	}
	before, _ := os.Stat(path)
	// 目录改成只读：内容没变时不应该再去写（否则这里会失败）
	if os.Geteuid() != 0 {
		if err := os.Chmod(dir, 0555); err != nil {
			t.Fatal(err)
		}
		defer os.Chmod(dir, 0755)
	}
	if err := writeStateFile(path, []byte("iptables")); err != nil {
		t.Fatalf("unchanged content must not be rewritten: %v", err)
	}
	after, _ := os.Stat(path)
	if !os.SameFile(before, after) {
		t.Fatal("unchanged content replaced the file")
	}
}

func TestWriteStateFileReportsFailure(t *testing.T) {
	blocker := filepath.Join(t.TempDir(), "not-a-dir")
	if err := os.WriteFile(blocker, []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := writeStateFile(filepath.Join(blocker, "port_1.rule"), []byte("1")); err == nil {
		t.Fatal("expected an error when the state directory cannot be created")
	}
}

func TestAgentStatePathUsesStateDir(t *testing.T) {
	if got := agentStatePath("port_80.rule"); got != "/var/lib/forwardx-agent/port_80.rule" {
		t.Fatalf("agentStatePath = %q", got)
	}
	if managedServiceSignaturePath("forwardx-fxp") != "/var/lib/forwardx-agent/service_forwardx-fxp.signature" {
		t.Fatalf("signature path changed: %q", managedServiceSignaturePath("forwardx-fxp"))
	}
	if desiredStateVersionPath != "/var/lib/forwardx-agent/desired_state_agent_version" {
		t.Fatalf("desired state version path changed: %q", desiredStateVersionPath)
	}
}
