package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// 在临时目录里搭一个假的 /proc/sys，按 key → 值写好。
func netTuneFakeProc(t *testing.T, values map[string]string) string {
	t.Helper()
	root := t.TempDir()
	oldRoot, oldConf, oldHash, oldModprobe, oldLoad := netTuneProcRoot, netTuneConfPath, netTuneHashsizePath, netTuneModprobeConf, netTuneLoadBBR
	netTuneProcRoot = filepath.Join(root, "proc")
	netTuneConfPath = filepath.Join(root, "etc", "sysctl.d", "99-forwardx-network.conf")
	netTuneHashsizePath = filepath.Join(root, "sys", "hashsize")
	netTuneModprobeConf = filepath.Join(root, "etc", "modprobe.d", "99-forwardx-conntrack.conf")
	netTuneLoadBBR = func() {}
	t.Cleanup(func() {
		netTuneProcRoot, netTuneConfPath, netTuneHashsizePath, netTuneModprobeConf, netTuneLoadBBR = oldRoot, oldConf, oldHash, oldModprobe, oldLoad
	})
	for key, value := range values {
		path := netTuneProcPath(key)
		if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(value+"\n"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func netTuneDistroDefaults() map[string]string {
	return map[string]string{
		"net.ipv4.ip_forward":                       "1",
		"net.core.rmem_max":                         "212992",
		"net.core.wmem_max":                         "134217728", // 用户调得比建议还大：保留
		"net.ipv4.tcp_rmem":                         "4096\t131072\t6291456",
		"net.ipv4.tcp_wmem":                         "4096\t16384\t4194304",
		"net.netfilter.nf_conntrack_max":            "262144",
		"net.netfilter.nf_conntrack_buckets":        "65536",
		"net.netfilter.nf_conntrack_count":          "1234",
		"net.netfilter.nf_conntrack_tcp_be_liberal": "0",
		"net.ipv4.tcp_no_metrics_save":              "0",
		"net.core.rmem_default":                     "212992",
		"net.core.wmem_default":                     "212992",
		"net.ipv4.udp_rmem_min":                     "4096",
		"net.ipv4.udp_wmem_min":                     "4096",
		"net.core.netdev_max_backlog":               "1000",
		"net.core.somaxconn":                        "4096",
		"net.ipv4.tcp_max_syn_backlog":              "512",
		"net.ipv4.tcp_mtu_probing":                  "0",
		"net.ipv4.tcp_notsent_lowat":                "4294967295",
		"net.ipv4.tcp_slow_start_after_idle":        "1",
		"net.ipv4.tcp_fastopen":                     "1",
		"net.ipv4.tcp_tw_reuse":                     "2",
		"net.ipv4.tcp_congestion_control":           "cubic",
		"net.ipv4.tcp_available_congestion_control": "reno cubic bbr",
		"net.core.default_qdisc":                    "fq_codel",
		"kernel.osrelease":                          "6.1.0-test",
	}
}

func TestNetTuneDesiredRules(t *testing.T) {
	cases := []struct {
		rule    netTuneRule
		current string
		want    string
		change  bool
	}{
		{netTuneRule{"a", netTuneAtLeast, 100}, "50", "100", true},
		{netTuneRule{"a", netTuneAtLeast, 100}, "200", "", false},
		{netTuneRule{"a", netTuneAtLeast, 100}, "4096 131072 50", "4096 131072 100", true},
		{netTuneRule{"a", netTuneAtLeast, 100}, "4096 131072 500", "", false},
		{netTuneRule{"a", netTuneAtMost, 0}, "1", "0", true},
		{netTuneRule{"a", netTuneAtMost, 131072}, "4294967295", "131072", true},
		{netTuneRule{"a", netTuneAtMost, 131072}, "16384", "", false},
		{netTuneRule{"a", netTuneBitsSet, 3}, "1", "3", true},
		{netTuneRule{"a", netTuneBitsSet, 3}, "1027", "", false},
		{netTuneRule{"a", netTuneBitsSet, 3}, "1024", "1027", true},
		{netTuneRule{"a", netTuneEquals, 1}, "2", "1", true},
		{netTuneRule{"a", netTuneEquals, 1}, "1", "", false},
		{netTuneRule{"a", netTuneAtLeast, 100}, "abc", "", false},
		{netTuneRule{"a", netTuneAtLeast, 100}, "", "", false},
	}
	for _, c := range cases {
		got, change := netTuneDesired(c.rule, c.current)
		if got != c.want || change != c.change {
			t.Errorf("%v on %q: got (%q, %v), want (%q, %v)", c.rule, c.current, got, change, c.want, c.change)
		}
	}
}

func TestNetTuneApplyRaisesOnlyAndPersists(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("只在 Linux 上跑")
	}
	netTuneFakeProc(t, netTuneDistroDefaults())

	result := netTuneRun(true)
	if result.Error != "" || len(result.Failed) != 0 {
		t.Fatalf("unexpected failure: %+v", result)
	}
	values := result.Values
	expect := map[string]string{
		"net.core.rmem_max":                  "67108864",
		"net.core.wmem_max":                  "134217728", // 原本更大，不动
		"net.ipv4.tcp_rmem":                  "4096 131072 67108864",
		"net.ipv4.tcp_wmem":                  "4096 16384 67108864",
		"net.netfilter.nf_conntrack_max":     "1048576",
		"net.netfilter.nf_conntrack_buckets": "262144",
		"net.core.somaxconn":                 "4096",
		"net.ipv4.tcp_max_syn_backlog":       "8192",
		"net.ipv4.tcp_notsent_lowat":         "131072",
		"net.ipv4.tcp_slow_start_after_idle": "0",
		"net.ipv4.tcp_fastopen":              "3",
		"net.ipv4.tcp_tw_reuse":              "1",
		"net.ipv4.tcp_congestion_control":    "bbr",
		"net.core.default_qdisc":             "fq",
		"net.netfilter.nf_conntrack_count":   "1234",
		"kernel.osrelease":                   "6.1.0-test",
	}
	for key, want := range expect {
		if values[key] != want {
			t.Errorf("%s = %q, want %q", key, values[key], want)
		}
	}
	changedKeys := map[string]bool{}
	for _, change := range result.Changed {
		changedKeys[change.Key] = true
	}
	if changedKeys["net.core.wmem_max"] || changedKeys["net.core.somaxconn"] || changedKeys["net.ipv4.ip_forward"] {
		t.Errorf("已经达标的键不该算改动：%+v", result.Changed)
	}
	if !changedKeys["net.ipv4.tcp_congestion_control"] || !changedKeys["net.netfilter.nf_conntrack_buckets"] {
		t.Errorf("拥塞控制和哈希桶应该改了：%+v", result.Changed)
	}

	conf, err := os.ReadFile(netTuneConfPath)
	if err != nil {
		t.Fatalf("配置文件没写：%v", err)
	}
	text := string(conf)
	for _, line := range []string{
		"net.core.wmem_max = 134217728",
		"net.ipv4.tcp_rmem = 4096 131072 67108864",
		"net.netfilter.nf_conntrack_buckets = 262144",
		"net.core.default_qdisc = fq",
		"net.ipv4.tcp_congestion_control = bbr",
	} {
		if !strings.Contains(text, line+"\n") {
			t.Errorf("配置文件里缺 %q:\n%s", line, text)
		}
	}
	if result.File != netTuneConfPath {
		t.Errorf("result.File = %q", result.File)
	}

	// 再调一遍：什么都不改（幂等）
	again := netTuneRun(true)
	if len(again.Changed) != 0 || len(again.Failed) != 0 {
		t.Errorf("第二遍不该再改：changed=%+v failed=%+v", again.Changed, again.Failed)
	}
}

func TestNetTuneKeepsCustomCongestionControl(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("只在 Linux 上跑")
	}
	values := netTuneDistroDefaults()
	values["net.ipv4.tcp_congestion_control"] = "hybla"
	values["net.ipv4.tcp_available_congestion_control"] = "reno cubic bbr hybla"
	netTuneFakeProc(t, values)
	result := netTuneRun(true)
	if result.Values["net.ipv4.tcp_congestion_control"] != "hybla" || result.Values["net.core.default_qdisc"] != "fq_codel" {
		t.Errorf("用户自选的算法不该动：cc=%q qdisc=%q", result.Values["net.ipv4.tcp_congestion_control"], result.Values["net.core.default_qdisc"])
	}
}

func TestNetTuneNoBBRAvailable(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("只在 Linux 上跑")
	}
	values := netTuneDistroDefaults()
	values["net.ipv4.tcp_available_congestion_control"] = "reno cubic"
	netTuneFakeProc(t, values)
	loaded := false
	netTuneLoadBBR = func() { loaded = true }
	result := netTuneRun(true)
	if !loaded {
		t.Error("没有 bbr 时应该先试着加载模块")
	}
	if result.Values["net.ipv4.tcp_congestion_control"] != "cubic" {
		t.Errorf("加载不了 bbr 时保持原样，got %q", result.Values["net.ipv4.tcp_congestion_control"])
	}
}

func TestNetTuneMissingConntrackAndCheckOnly(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("只在 Linux 上跑")
	}
	values := netTuneDistroDefaults()
	for key := range values {
		if strings.HasPrefix(key, "net.netfilter.") {
			delete(values, key)
		}
	}
	netTuneFakeProc(t, values)

	check := netTuneRun(false)
	if len(check.Changed) != 0 || check.File != "" {
		t.Errorf("只检查不该改东西：%+v", check)
	}
	if check.Values["net.core.rmem_max"] != "212992" {
		t.Errorf("检查读出的值不对：%q", check.Values["net.core.rmem_max"])
	}
	missing := strings.Join(check.Missing, ",")
	if !strings.Contains(missing, "net.netfilter.nf_conntrack_max") {
		t.Errorf("没加载 nf_conntrack 时应记为缺失：%v", check.Missing)
	}
	if _, err := os.Stat(netTuneConfPath); !os.IsNotExist(err) {
		t.Errorf("只检查不该写配置文件")
	}

	applied := netTuneRun(true)
	if len(applied.Failed) != 0 {
		t.Errorf("缺的键不算失败：%+v", applied.Failed)
	}
}

func TestNetTuneModuleRunsOncePerID(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("只在 Linux 上跑")
	}
	netTuneFakeProc(t, netTuneDistroDefaults())
	module := newNetTuneExtModule()
	directive, _ := json.Marshal(map[string]any{"runs": []map[string]any{{"id": "run-1", "apply": false}}})
	module.Apply(Config{}, directive)

	deadline := time.Now().Add(3 * time.Second)
	var report netTuneReport
	for time.Now().Before(deadline) {
		raw := module.Report(Config{})
		if raw != nil {
			report = raw.(netTuneReport)
			if len(report.Results) == 1 && report.Results[0].Status == "done" {
				break
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	if len(report.Results) != 1 || report.Results[0].Status != "done" || report.Results[0].ID != "run-1" {
		t.Fatalf("结果不对：%+v", report)
	}
	finishedAt := report.Results[0].FinishedAt

	// 面板重发同一个 id：不再跑一遍
	module.Apply(Config{}, directive)
	time.Sleep(50 * time.Millisecond)
	again := module.Report(Config{}).(netTuneReport)
	if len(again.Results) != 1 || again.Results[0].FinishedAt != finishedAt {
		t.Errorf("同一个 id 不该再跑：%+v", again)
	}

	// 非法 id 不接
	bad, _ := json.Marshal(map[string]any{"runs": []map[string]any{{"id": "../x", "apply": true}}})
	module.Apply(Config{}, bad)
	if len(module.Report(Config{}).(netTuneReport).Results) != 1 {
		t.Error("非法 id 不该接")
	}
}
