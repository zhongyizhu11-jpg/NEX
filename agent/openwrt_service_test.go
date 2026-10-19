package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// OpenWrt 的托管服务脚本：rc.common + procd，崩了拉起；命令里带引号的参数原样传下去，sh 能解析。
func TestProcdServiceScript(t *testing.T) {
	script := procdServiceScript("forwardx-fxp-9-24001", "/usr/local/bin/forwardx-fxp -config '/run/forwardx-agent/fxp-9-24001.json'", "1048576")
	for _, want := range []string{
		"#!/bin/sh /etc/rc.common",
		"USE_PROCD=1",
		"procd_open_instance",
		"procd_set_param respawn",
		"procd_close_instance",
		"/var/log/forwardx-agent/forwardx-fxp-9-24001.log",
	} {
		if !strings.Contains(script, want) {
			t.Fatalf("procd 脚本里缺 %q：\n%s", want, script)
		}
	}
	path := filepath.Join(t.TempDir(), "svc")
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("sh", "-n", path).CombinedOutput(); err != nil {
		t.Fatalf("sh 解析不了：%v\n%s\n%s", err, out, script)
	}
	// 去掉 procd 那几个函数，看 command 那一行展开后真正交给 /bin/sh -c 的是不是原样的命令。
	probe := strings.Join([]string{
		"procd_open_instance() { :; }",
		"procd_close_instance() { :; }",
		"procd_set_param() { if [ \"$1\" = command ]; then shift; printf '%s\\n' \"$@\"; fi; }",
		"mkdir() { :; }",
		strings.SplitN(strings.SplitN(script, "start_service() {", 2)[1], "\n}", 2)[0],
	}, "\n")
	out, err := exec.Command("sh", "-c", probe).CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	if len(lines) != 3 || lines[0] != "/bin/sh" || lines[1] != "-c" || !strings.Contains(lines[2], "exec /usr/local/bin/forwardx-fxp -config '/run/forwardx-agent/fxp-9-24001.json'") {
		t.Fatalf("command 参数不对：%q", lines)
	}
}

func TestManagedServiceCleanupDisablesOnOpenWrt(t *testing.T) {
	shell := managedServiceCleanupShell("forwardx-gost-24001")
	if !strings.Contains(shell, "/etc/openwrt_release") || !strings.Contains(shell, "/etc/init.d/forwardx-gost-24001 disable") {
		t.Fatalf("OpenWrt 上删服务要先 disable：%s", shell)
	}
	if out, err := exec.Command("sh", "-n", "-c", shell).CombinedOutput(); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
}
