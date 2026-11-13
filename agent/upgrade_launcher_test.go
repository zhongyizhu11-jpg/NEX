package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// 装了 systemd-run、但 systemd 没在跑（容器里常见）：要退回 nohup 把升级跑起来，不能每次都「launcher failed」。
func TestSelfUpgradeLauncherFallsBackWhenSystemdIsNotRunning(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	// 假的 systemd-run：和没用 systemd 启动的机器上一样，直接失败。
	if err := os.WriteFile(filepath.Join(bin, "systemd-run"), []byte("#!/bin/sh\necho 'System has not been booted with systemd' >&2\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(dir, "ran")
	logPath := filepath.Join(dir, "upgrade.log")
	cmd := selfUpgradeLauncherCommand("echo ok > "+shellQuote(marker), logPath)
	run := exec.Command("sh", "-c", cmd)
	run.Env = append(os.Environ(), "PATH="+bin+":"+os.Getenv("PATH"))
	if out, err := run.CombinedOutput(); err != nil {
		t.Fatalf("launcher 本身不该失败：%v %s", err, out)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if data, err := os.ReadFile(marker); err == nil && strings.TrimSpace(string(data)) == "ok" {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("systemd-run 失败后应该用 nohup 把升级命令跑起来")
}

func TestSelfUpgradeLauncherOnlyUsesSystemdRunWhenSystemdIsPID1(t *testing.T) {
	cmd := selfUpgradeLauncherCommand("true", "/var/log/forwardx-agent/agent-upgrade.log")
	if !strings.HasPrefix(cmd, "if [ -d /run/systemd/system ] && command -v systemd-run") {
		t.Fatalf("要先确认 systemd 在跑：%s", cmd)
	}
	if !strings.Contains(cmd, "else nohup sh -lc") {
		t.Fatalf("要有 nohup 兜底：%s", cmd)
	}
}
