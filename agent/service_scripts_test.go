package main

import (
	"strings"
	"testing"
)

func TestHardenManagedSystemdUnitAddsRuntimeLimitsOnce(t *testing.T) {
	unit := strings.Join([]string{
		"[Unit]",
		"Description=ForwardX runtime",
		"",
		"[Service]",
		"Type=simple",
		"ExecStart=/usr/local/bin/forwardx-runtime -C /etc/forwardx/runtime/gost.json",
		"Restart=always",
		"",
		"[Install]",
		"WantedBy=multi-user.target",
		"",
	}, "\n")

	hardened := hardenManagedSystemdUnit(unit)
	for _, directive := range []string{"LimitCORE=0", "LogRateLimitIntervalSec=30s", "LogRateLimitBurst=200"} {
		if strings.Count(hardened, directive) != 1 {
			t.Fatalf("directive %q count=%d in %q", directive, strings.Count(hardened, directive), hardened)
		}
	}
	if again := hardenManagedSystemdUnit(hardened); again != hardened {
		t.Fatalf("systemd hardening was not idempotent\nfirst: %q\nsecond: %q", hardened, again)
	}
	if got := systemdUnitExecStart(hardened); !strings.Contains(got, "forwardx-runtime") {
		t.Fatalf("ExecStart was changed or lost: %q", got)
	}
}

func TestOpenRCAndSysVScriptsDisableCoreDumps(t *testing.T) {
	execStart := "/usr/local/bin/realm -c /etc/forwardx/realm.toml"
	for name, script := range map[string]string{
		"openrc": openRCServiceScript("forwardx-realm-1000", execStart, ""),
		"sysv":   sysVServiceScript("forwardx-realm-1000", execStart, ""),
	} {
		if !strings.Contains(script, "ulimit -c 0") {
			t.Fatalf("%s script does not disable core dumps: %q", name, script)
		}
		if !strings.Contains(script, execStart) {
			t.Fatalf("%s script lost ExecStart: %q", name, script)
		}
	}
}

// 转成 OpenRC / SysV 以后 systemd 的 LimitNOFILE 不再生效，脚本里要用 ulimit -n 补上。
func TestOpenRCAndSysVScriptsKeepFileDescriptorLimit(t *testing.T) {
	execStart := "/usr/local/bin/forwardx-runtime -C /etc/forwardx/runtime/gost.json"
	unit := strings.Join([]string{
		"[Unit]",
		"Description=ForwardX runtime",
		"LimitNOFILE=1",
		"[Service]",
		"ExecStart=" + execStart,
		"LimitNOFILE=4096",
		"LimitNOFILE=65535",
		"[Install]",
		"WantedBy=multi-user.target",
	}, "\n")
	if got := systemdUnitLimitNOFILE(unit); got != "65535" {
		t.Fatalf("LimitNOFILE = %q, want the last [Service] value", got)
	}
	cases := []struct {
		limit string
		want  string
	}{
		{"65535", "ulimit -n 65535 2>/dev/null || true; ulimit -c 0"},
		{"", "ulimit -n 1048576 2>/dev/null || true; ulimit -c 0"},
		{"infinity", "ulimit -n 1048576 2>/dev/null || true; ulimit -c 0"},
		{"65535; reboot", "ulimit -n 1048576 2>/dev/null || true; ulimit -c 0"},
		{"1024:524288", "ulimit -Hn 524288 2>/dev/null || true; ulimit -Sn 1024 2>/dev/null || true; ulimit -c 0"},
	}
	for _, tc := range cases {
		for name, script := range map[string]string{
			"openrc": openRCServiceScript("forwardx-gost-1000", execStart, tc.limit),
			"sysv":   sysVServiceScript("forwardx-gost-1000", execStart, tc.limit),
		} {
			if !strings.Contains(script, tc.want) {
				t.Fatalf("%s script for LimitNOFILE=%q does not contain %q:\n%s", name, tc.limit, tc.want, script)
			}
			if strings.Contains(script, "reboot") {
				t.Fatalf("%s script injected an unvalidated limit: %q", name, script)
			}
			if !strings.Contains(script, "exec "+execStart) {
				t.Fatalf("%s script lost ExecStart: %q", name, script)
			}
		}
	}
	if got := systemdUnitLimitNOFILE("[Service]\nExecStart=/bin/true\n"); got != "" {
		t.Fatalf("absent LimitNOFILE = %q", got)
	}
}
