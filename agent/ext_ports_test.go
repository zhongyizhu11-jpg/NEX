package main

import (
	"errors"
	"strings"
	"testing"
	"time"
)

// 端口占用核对：用 `ss -H -ltnup` 的输出做夹具，/proc 换成假的，不碰真主机。

const portsSSFixture = `tcp   LISTEN 0      511          0.0.0.0:443        0.0.0.0:*    users:(("nginx",pid=812,fd=6),("nginx",pid=811,fd=6))
tcp   LISTEN 0      4096       127.0.0.1:8080       0.0.0.0:*    users:(("python3",pid=900,fd=3))
tcp   LISTEN 0      4096            [::]:22022         [::]:*    users:(("forwardx-agent",pid=100,fd=9))
udp   UNCONN 0      0            0.0.0.0:22022      0.0.0.0:*    users:(("forwardx-fxp",pid=300,fd=7))
tcp   LISTEN 0      4096         0.0.0.0:30000      0.0.0.0:*    users:(("gost",pid=400,fd=5))
udp   UNCONN 0      0      127.0.0.53%lo:53         0.0.0.0:*    users:(("systemd-resolve",pid=500,fd=13))
tcp   LISTEN 0      128             [::]:40000         [::]:*    users:(("sshd",pid=600,fd=4))
`

func portsClassifier() *portOccupancyClassifier {
	files := map[string]string{
		"/proc/812/stat":    "812 (nginx) S 1 812 812 0",
		"/proc/811/stat":    "811 (nginx) S 1 811 811 0",
		"/proc/812/cgroup":  "0::/system.slice/nginx.service\n",
		"/proc/811/cgroup":  "0::/system.slice/nginx.service\n",
		"/proc/400/stat":    "400 (gost) S 1 400 400 0",
		"/proc/400/cgroup":  "0::/system.slice/forwardx-runtime.service\n",
		"/proc/900/stat":    "900 (python3) S 50 900 900 0",
		"/proc/600/stat":    "600 (sshd) S 1 600 600 0",
		"/proc/600/cmdline": "/usr/sbin/sshd\x00-D\x00",
	}
	return &portOccupancyClassifier{
		selfPID: 100,
		cache:   map[int]bool{},
		readFile: func(path string) ([]byte, error) {
			if value, ok := files[path]; ok {
				return []byte(value), nil
			}
			return nil, errors.New("not found")
		},
	}
}

func TestPortOccupancyReportsOnlyForeignListenersOnRulePorts(t *testing.T) {
	targets := []portOccupancyTarget{
		{ruleID: 1, port: 443, protocol: "tcp", forwardType: "nftables"},  // 外来 nginx 占着内核转发的端口
		{ruleID: 2, port: 22022, protocol: "tcp", forwardType: "guard"},   // Agent 自己在听
		{ruleID: 2, port: 22022, protocol: "udp", forwardType: "guard"},   // FXP（forwardx-*）
		{ruleID: 3, port: 30000, protocol: "tcp", forwardType: "gost"},    // forwardx-runtime.service 里的 gost
		{ruleID: 4, port: 8080, protocol: "tcp", forwardType: "iptables"}, // 只在回环上听：内核转发不受影响
		{ruleID: 5, port: 8080, protocol: "udp", forwardType: "realm"},    // 没人听
	}
	report := buildPortOccupancyReport(targets, portsSSFixture, true, portsClassifier(), time.UnixMilli(1_700_000_000_000))
	if !report.Usable || report.CheckedPorts != len(targets) || report.Schema != 1 || report.CollectedAt != 1_700_000_000_000 {
		t.Fatalf("unexpected report header: %+v", report)
	}
	if len(report.Conflicts) != 1 {
		t.Fatalf("only rule 1 conflicts, got %+v", report.Conflicts)
	}
	conflict := report.Conflicts[0]
	if conflict.RuleID != 1 || conflict.Port != 443 || conflict.Protocol != "tcp" || conflict.ForwardType != "nftables" {
		t.Fatalf("conflict = %+v", conflict)
	}
	if len(conflict.Listeners) != 1 || conflict.Listeners[0].Process != "nginx" || conflict.Listeners[0].PID != 812 || conflict.Listeners[0].Address != "0.0.0.0" {
		t.Fatalf("listeners = %+v", conflict.Listeners)
	}

	// 用户态转发：回环上的外来监听也会让它绑不上，要报。
	report = buildPortOccupancyReport([]portOccupancyTarget{{ruleID: 6, port: 8080, protocol: "tcp", forwardType: "gost"}}, portsSSFixture, true, portsClassifier(), time.Now())
	if len(report.Conflicts) != 1 || report.Conflicts[0].Listeners[0].Process != "python3" || report.Conflicts[0].Listeners[0].Address != "127.0.0.1" {
		t.Fatalf("loopback listener blocks a userspace runtime: %+v", report.Conflicts)
	}
}

func TestPortOccupancyUnusableWithoutOwners(t *testing.T) {
	targets := []portOccupancyTarget{{ruleID: 1, port: 443, protocol: "tcp", forwardType: "nftables"}}
	if report := buildPortOccupancyReport(targets, "", false, portsClassifier(), time.Now()); report.Usable {
		t.Fatalf("no ss output: nothing can be confirmed")
	}
	noOwners := "tcp LISTEN 0 511 0.0.0.0:443 0.0.0.0:*\n"
	if report := buildPortOccupancyReport(targets, noOwners, true, portsClassifier(), time.Now()); report.Usable {
		t.Fatalf("listeners without process info cannot be classified")
	}
	if report := buildPortOccupancyReport(nil, "", false, portsClassifier(), time.Now()); !report.Usable || len(report.Conflicts) != 0 {
		t.Fatalf("no rule ports: an empty, usable report clears the panel's warnings")
	}
}

func TestPortOccupancyClassifierChildAndCmdline(t *testing.T) {
	c := portsClassifier()
	c.selfPID = 50 // python3 的父进程
	if !c.managed(900, "python3") {
		t.Fatalf("a child of the Agent is managed")
	}
	if c.managed(600, "sshd") {
		t.Fatalf("sshd is foreign")
	}
	if !c.managed(0, "forwardx-fxp") || c.managed(0, "nginx") {
		t.Fatalf("without a pid only the forwardx-* name counts")
	}
	if procStatParentPID("123 (a b) c) S 77 1 1") != 77 {
		t.Fatalf("parent pid must be read after the last ')'")
	}
}

func TestPortOccupancyTargetsMergeRunningRulesAndPendingApplies(t *testing.T) {
	desiredRunningRuleMu.Lock()
	savedByRulePort := desiredRunningRulesByRulePort
	desiredRunningRulesByRulePort = map[string]runningRule{
		"1:443":   {RuleID: 1, SourcePort: 443, Protocol: "both", ForwardType: "nftables"},
		"9:39001": {RuleID: 9, SourcePort: 39001, Protocol: "tcp", ForwardType: "gost", SchedulerOnly: true},
	}
	desiredRunningRuleMu.Unlock()
	defer func() {
		desiredRunningRuleMu.Lock()
		desiredRunningRulesByRulePort = savedByRulePort
		desiredRunningRuleMu.Unlock()
	}()
	module := &portOccupancyModule{actionPorts: map[string]portOccupancyActionPort{}}
	now := time.Now()
	module.rememberActions([]action{
		{Op: "apply", RuleID: 2, SourcePort: 8443, Protocol: "tcp", ForwardType: "realm"},
		{Op: "remove", RuleID: 3, SourcePort: 9443, Protocol: "tcp"},
		{Op: "apply", StatusType: "tunnel", TunnelID: 4, SourcePort: 9444, Protocol: "tcp"},
		{Op: "apply", RuleID: 5, SourcePort: 443, Protocol: "tcp", ForwardType: "gost"},
	}, now.Add(-time.Minute))
	keys := []string{}
	for _, target := range module.targets(now) {
		keys = append(keys, portOccupancyTargetKey(target)+"#"+target.forwardType)
	}
	got := strings.Join(keys, ",")
	if got != "443/tcp#nftables,443/udp#nftables,8443/tcp#realm" {
		t.Fatalf("targets = %s", got)
	}
	// 太久没再下发的 apply 不再核对。
	if targets := module.targets(now.Add(portOccupancyActionPortTTL + time.Minute)); len(targets) != 2 {
		t.Fatalf("stale pending applies should drop out, got %+v", targets)
	}
}

func TestPortOccupancyDisabledUntilPanelAsks(t *testing.T) {
	module := &portOccupancyModule{actionPorts: map[string]portOccupancyActionPort{}}
	if module.Report(Config{}) != nil {
		t.Fatalf("an old panel never enables the module, so nothing is reported")
	}
	module.Apply(Config{}, []byte(`{"enabled":false}`))
	if module.Report(Config{}) != nil {
		t.Fatalf("still disabled")
	}
}

// 没有 systemd 的机器：Agent 托管的 socat 由 /etc/init.d 脚本拉起、父进程是 1、命令行里没有 forwardx，
// 只有 /run/forwardx-socat-tcp-30022.pid 对得上。以前被报成外来程序占用自己规则的端口。
func TestPortOccupancyTreatsSysVManagedServiceAsOwn(t *testing.T) {
	files := map[string]string{
		"/run/forwardx-socat-tcp-30022.pid": "15663\n",
		"/proc/15663/stat":                  "15663 (socat) S 1 15663 15663 0",
		"/proc/15663/cgroup":                "0::/\n",
		"/proc/15663/cmdline":               "/usr/bin/socat\x00-b65536\x00TCP4-LISTEN:30022,fork,reuseaddr,nodelay\x00TCP:10.20.0.2:8080,nodelay\x00",
		"/proc/777/stat":                    "777 (socat) S 1 777 777 0",
		"/proc/777/cmdline":                 "/usr/bin/socat\x00TCP4-LISTEN:30023,fork\x00",
	}
	classifier := &portOccupancyClassifier{
		selfPID: 100,
		cache:   map[int]bool{},
		readFile: func(path string) ([]byte, error) {
			if value, ok := files[path]; ok {
				return []byte(value), nil
			}
			return nil, errors.New("not found")
		},
		pidFiles: func() []string { return []string{"/run/forwardx-socat-tcp-30022.pid", "/run/forwardx-broken.pid"} },
	}
	if !classifier.managed(15663, "socat") {
		t.Fatal("pid 文件对得上的 socat 是 Agent 自己托管的")
	}
	if classifier.managed(777, "socat") {
		t.Fatal("别人起的 socat 照样算外来程序")
	}
}
