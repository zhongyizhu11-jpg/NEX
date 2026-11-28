package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// netTuneFakeMem 写一份假的 /proc/meminfo（MemTotal 按 kB）。
func netTuneFakeMem(t *testing.T, bytes int64) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(netTuneMemInfoPath), 0755); err != nil {
		t.Fatal(err)
	}
	text := "MemTotal:       " + strconv.FormatInt(bytes/1024, 10) + " kB\nMemFree:          123456 kB\n"
	if err := os.WriteFile(netTuneMemInfoPath, []byte(text), 0644); err != nil {
		t.Fatal(err)
	}
}

// 假的 `ip -4 route`：show default 按行输出；replace 按 metric（路由的键，和内核一样）换掉那一条，
// 认不出的词（linkdown 这类只出现在输出里的标志）像内核一样报错。
type netTuneFakeRoutes struct {
	mu    sync.Mutex
	lines []string
	calls [][]string
}

var netTuneFakeRouteInputWords = map[string]bool{"default": true, "via": true, "dev": true, "proto": true, "src": true, "metric": true, "scope": true, "onlink": true, "table": true, "initcwnd": true, "initrwnd": true, "mtu": true}

func netTuneFakeIP(t *testing.T, lines ...string) *netTuneFakeRoutes {
	t.Helper()
	fake := &netTuneFakeRoutes{lines: append([]string(nil), lines...)}
	old := netTuneIPRoute
	netTuneIPRoute = fake.run
	t.Cleanup(func() { netTuneIPRoute = old })
	return fake
}

func netTuneFakeRouteMetric(tokens []string) string {
	for i := 0; i+1 < len(tokens); i++ {
		if tokens[i] == "metric" {
			return tokens[i+1]
		}
	}
	return "0"
}

func (f *netTuneFakeRoutes) run(args ...string) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, append([]string(nil), args...))
	if len(args) >= 4 && args[0] == "-4" && args[1] == "route" && args[2] == "show" && args[3] == "default" {
		if len(f.lines) == 0 {
			return nil, nil
		}
		return []byte(strings.Join(f.lines, "\n") + "\n"), nil
	}
	if len(args) >= 4 && args[0] == "-4" && args[1] == "route" && args[2] == "replace" {
		tokens := args[3:]
		for i := 0; i < len(tokens); i++ {
			word := tokens[i]
			if !netTuneFakeRouteInputWords[word] {
				return nil, errors.New("Error: either \"to\" is duplicate, or \"" + word + "\" is a garbage.")
			}
			if word != "default" && word != "onlink" {
				i++ // 带值的词
			}
		}
		metric := netTuneFakeRouteMetric(tokens)
		line := strings.Join(tokens, " ")
		for i, existing := range f.lines {
			fields := strings.Fields(existing)
			if len(fields) > 0 && fields[0] == "default" && netTuneFakeRouteMetric(fields) == metric {
				f.lines[i] = line
				return nil, nil
			}
		}
		f.lines = append(f.lines, line)
		return nil, nil
	}
	return nil, errors.New("fake ip: unexpected " + strings.Join(args, " "))
}

func (f *netTuneFakeRoutes) set(index int, line string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lines[index] = line
}

func (f *netTuneFakeRoutes) line(index int) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.lines[index]
}

// 缓冲上限按内存封顶：单条连接最多占内存的 1/32（tcp_mem 上限约内存 1/4 的 1/8，至少容得下 8 条大流同时跑满），
// 按 MiB 取整，最低 4 MiB、最高 256 MiB；建议值仍是 64 MiB，但不超过这个预算。
func TestNetTuneBufferLimitsFollowMemory(t *testing.T) {
	root := t.TempDir()
	old := netTuneMemInfoPath
	netTuneMemInfoPath = filepath.Join(root, "meminfo")
	t.Cleanup(func() { netTuneMemInfoPath = old })
	const mib = int64(1 << 20)
	cases := []struct {
		mem, want, budget int64
	}{
		{64 * mib, 4 * mib, 4 * mib},       // 太小：底线 4 MiB
		{512 * mib, 16 * mib, 16 * mib},    // 小鸡
		{981 * mib, 30 * mib, 30 * mib},    // 「1G」VPS 实际的 MemTotal：按 MiB 往下取整
		{1024 * mib, 32 * mib, 32 * mib},   //
		{2048 * mib, 64 * mib, 64 * mib},   // 从这里起建议值就是 64 MiB
		{8192 * mib, 64 * mib, 256 * mib},  // 大机器：自己调到 64–256 MiB 都算合适
		{65536 * mib, 64 * mib, 256 * mib}, // 封顶 256 MiB
	}
	for _, c := range cases {
		netTuneFakeMem(t, c.mem)
		want, budget := netTuneBufferLimits(0)
		if want != c.want || budget != c.budget {
			t.Errorf("内存 %d MiB：建议 %d、预算 %d，算出 %d、%d", c.mem/mib, c.want/mib, c.budget/mib, want/mib, budget/mib)
		}
	}
	// 知道带宽时照 tcpfit：2 × BDP（150 ms）+ 2 MiB，向上取整到 MiB，仍不超过内存预算
	netTuneFakeMem(t, 8192*mib)
	for _, c := range []struct{ bw, want int64 }{
		{30, 4 * mib},      // 2×0.56+2 = 3.1 MiB → 底线 4 MiB
		{500, 20 * mib},    // 2×17.9+2 = 19.9 MiB
		{1000, 38 * mib},   // 37.8 MiB
		{2000, 74 * mib},   // 73.5 MiB：比固定 64 MiB 大，2G 口单流才跑得满
		{20000, 256 * mib}, // 封顶 256 MiB
	} {
		if want, _ := netTuneBufferLimits(c.bw); want != c.want {
			t.Errorf("带宽 %d Mbps：上限应该是 %d MiB，算出 %d", c.bw, c.want/mib, want/mib)
		}
	}
	netTuneFakeMem(t, 1024*mib)
	if want, budget := netTuneBufferLimits(2000); want != 32*mib || budget != 32*mib {
		t.Errorf("2G 口但只有 1 GiB 内存：按内存封顶 32 MiB，算出 %d、%d", want/mib, budget/mib)
	}
	// 读不到内存：照旧（只抬到 64 MiB，不压）
	_ = os.Remove(netTuneMemInfoPath)
	if want, budget := netTuneBufferLimits(0); want != 64*mib || budget != 0 {
		t.Errorf("读不到内存时应该是 64 MiB、不封顶，算出 %d、%d", want, budget)
	}
}

// 一键调优带上面板给的带宽：500 Mbps、8 GiB 的机器缓冲上限 20 MiB（老版本抬到的 64 MiB 在预算内，不压）。
func TestNetTuneApplyUsesPanelBandwidth(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("只在 Linux 上跑")
	}
	values := netTuneDistroDefaults()
	values["net.core.wmem_max"] = "67108864"
	netTuneFakeProc(t, values)
	applied := netTuneRunWith("apply", nil, 500)
	if len(applied.Failed) != 0 {
		t.Fatalf("调优失败：%+v", applied.Failed)
	}
	for key, want := range map[string]string{
		"net.core.rmem_max": "20971520",
		"net.core.wmem_max": "67108864", // 比建议大、在内存预算内：不动
		"net.ipv4.tcp_rmem": "4096 1048576 20971520",
		"net.ipv4.tcp_wmem": "4096 1048576 20971520",
	} {
		if value, _, _ := netTuneRead(key); value != want {
			t.Errorf("%s = %s，应该是 %s", key, value, want)
		}
	}
}

// tcpfit 基础调优里的其余几项：tcp_mem 按内存（1/16、1/8、1/4，单位页）、min_free_kbytes 至少 32 MiB 但不超过内存 1/32，
// 其余固定值；老版本留下的备份里没有这些键时补进去，还原时一起改回。
func TestNetTuneTcpfitBaseKeysAndBackupTopUp(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("只在 Linux 上跑")
	}
	netTuneFakeProc(t, netTuneDistroDefaults())
	netTuneFakeMem(t, 1<<30)
	// 2.2.255–2.2.275 留下的备份：只有当时管的那些键
	old := map[string]string{"net.core.somaxconn": "4096", "net.ipv4.tcp_congestion_control": "cubic"}
	raw, _ := json.Marshal(netTuneBackup{SavedAt: 1, Values: old})
	_ = os.MkdirAll(filepath.Dir(netTuneBackupPath), 0700)
	if err := os.WriteFile(netTuneBackupPath, raw, 0600); err != nil {
		t.Fatal(err)
	}

	applied := netTuneRunMode("apply", nil)
	if len(applied.Failed) != 0 {
		t.Fatalf("调优失败：%+v", applied.Failed)
	}
	for key, want := range map[string]string{
		"net.ipv4.tcp_mem":             "16384 32768 65536", // 1 GiB = 262144 页
		"vm.min_free_kbytes":           "32768",
		"net.core.somaxconn":           "8192",
		"net.core.netdev_budget":       "600",
		"net.core.optmem_max":          "65536",
		"net.ipv4.tcp_fin_timeout":     "15",
		"net.ipv4.tcp_keepalive_time":  "600",
		"net.ipv4.tcp_window_scaling":  "1",
		"net.ipv4.tcp_moderate_rcvbuf": "1",
		"net.ipv4.tcp_timestamps":      "1",
		"fs.file-max":                  "1000000",
		"net.ipv4.tcp_no_metrics_save": "1", // 和 tcpfit 不同：这里保持 1
	} {
		if value, _, _ := netTuneRead(key); value != want {
			t.Errorf("%s = %s，应该是 %s", key, value, want)
		}
	}
	if value, _, _ := netTuneRead("net.ipv4.ip_local_port_range"); value != "32768 60999" {
		t.Errorf("本机端口范围不该改（会占到规则要监听的端口）：%s", value)
	}
	if _, err := os.Stat(netTuneBBRModuleConf); err != nil {
		t.Errorf("改成 bbr 后要写 modules-load.d，开机先加载 tcp_bbr：%v", err)
	}

	restored := netTuneRunMode("restore", nil)
	if restored.Error != "" {
		t.Fatalf("还原失败：%+v", restored)
	}
	for key, want := range map[string]string{
		"net.ipv4.tcp_mem":         "12288 16384 24576",
		"net.ipv4.tcp_fin_timeout": "60",
		"vm.min_free_kbytes":       "8192",
		"net.core.somaxconn":       "4096",
		"fs.file-max":              "99999",
	} {
		if value, _, _ := netTuneRead(key); value != want {
			t.Errorf("还原后 %s = %s，应该回到 %s（老备份里没有，调优前补进去的）", key, value, want)
		}
	}
	if _, err := os.Stat(netTuneBBRModuleConf); !os.IsNotExist(err) {
		t.Errorf("还原后 modules-load.d 文件要删掉：%v", err)
	}
	// 小内存机器：min_free_kbytes 不超过内存 1/32
	netTuneFakeMem(t, 256<<20)
	rule, _ := netTuneHostRule(netTuneRule{key: "vm.min_free_kbytes", kind: netTuneAtLeast, want: netTuneMinFreeKB, mem: netTuneMemMinFree}, netTuneReadHostFacts(0))
	if rule.want != 8192 {
		t.Errorf("256 MiB 内存的 min_free_kbytes 目标应该是 8192，算出 %d", rule.want)
	}
}

// 1 GiB 的小鸡：老版本抬到 64 MiB 的缓冲上限压回 32 MiB，没调过的抬到 32 MiB；起点照旧 1 MiB；还原回到原样。
func TestNetTuneApplyCapsBuffersOnSmallMemory(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("只在 Linux 上跑")
	}
	values := netTuneDistroDefaults()
	values["net.core.rmem_max"] = "67108864"               // 老版本 NEX 抬过
	values["net.core.wmem_max"] = "212992"                 // 发行版默认
	values["net.ipv4.tcp_rmem"] = "4096\t131072\t67108864" // 老版本 NEX 抬过上限
	values["net.ipv4.tcp_wmem"] = "4096\t16384\t4194304"
	netTuneFakeProc(t, values)
	netTuneFakeMem(t, 1<<30)

	check := netTuneRunMode("check", nil)
	if check.Values[netTuneKeyMemTotal] != "1073741824" {
		t.Fatalf("要把内存报给面板（面板按它判断）：%q", check.Values[netTuneKeyMemTotal])
	}
	applied := netTuneRunMode("apply", nil)
	if applied.Error != "" || len(applied.Failed) != 0 {
		t.Fatalf("调优失败：%+v", applied)
	}
	for key, want := range map[string]string{
		"net.core.rmem_max": "33554432",
		"net.core.wmem_max": "33554432",
		"net.ipv4.tcp_rmem": "4096 1048576 33554432",
		"net.ipv4.tcp_wmem": "4096 1048576 33554432",
	} {
		if value, _, _ := netTuneRead(key); value != want {
			t.Errorf("1 GiB 内存：%s 应该是 %s，实际 %s", key, want, value)
		}
	}
	conf, _ := os.ReadFile(netTuneConfPath)
	if !strings.Contains(string(conf), "net.core.rmem_max = 33554432\n") {
		t.Errorf("压下来的值要写进 sysctl.d，重启后不回到 64 MiB：\n%s", conf)
	}
	if again := netTuneRunMode("apply", nil); len(again.Changed) != 0 {
		t.Errorf("第二遍不该再改：%+v", again.Changed)
	}
	restored := netTuneRunMode("restore", nil)
	if restored.Error != "" {
		t.Fatalf("还原失败：%+v", restored)
	}
	if value, _, _ := netTuneRead("net.core.rmem_max"); value != "67108864" {
		t.Errorf("还原后 rmem_max = %s，应该回到调优前的 67108864", value)
	}
}

// 初始窗口：一键调优把每条默认路由的 initcwnd / initrwnd 抬到 32（保留网关、proto、src、metric），
// 多路径路由不碰；网络重连 / DHCP 续租把它冲掉后 Agent 自己补回；还原回到调优前（用户原来设的 20 也回到 20）。
func TestNetTuneInitWindowApplyMaintainRestore(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("只在 Linux 上跑")
	}
	netTuneFakeProc(t, netTuneDistroDefaults())
	routes := netTuneFakeIP(t,
		"default via 10.0.0.1 dev eth0 proto dhcp src 10.0.0.5 metric 100",
		"default via 10.1.0.1 dev eth1 metric 200 initcwnd 20",
		"default proto static metric 300",
		"\tnexthop via 10.2.0.1 dev eth2 weight 1",
		"\tnexthop via 10.3.0.1 dev eth3 weight 1",
	)

	check := netTuneRunMode("check", nil)
	if check.Values[netTuneKeyInitcwnd] != "10" || check.Values[netTuneKeyInitrwnd] != "10" {
		t.Fatalf("没设的按内核默认 10 报（取几条默认路由里最小的）：cwnd=%q rwnd=%q", check.Values[netTuneKeyInitcwnd], check.Values[netTuneKeyInitrwnd])
	}
	if check.HasBackup || len(check.Changed) != 0 {
		t.Fatalf("只检查不该改、不该留备份：%+v", check)
	}

	applied := netTuneRunMode("apply", nil)
	if len(applied.Failed) != 0 {
		t.Fatalf("调优失败：%+v", applied.Failed)
	}
	if got := routes.line(0); got != "default via 10.0.0.1 dev eth0 proto dhcp src 10.0.0.5 metric 100 initcwnd 32 initrwnd 32" {
		t.Errorf("eth0 默认路由：%s", got)
	}
	if got := routes.line(1); got != "default via 10.1.0.1 dev eth1 metric 200 initcwnd 32 initrwnd 32" {
		t.Errorf("eth1 默认路由（原来 initcwnd 20）：%s", got)
	}
	if got := routes.line(2); got != "default proto static metric 300" {
		t.Errorf("多路径路由不该碰：%s", got)
	}
	if applied.Values[netTuneKeyInitcwnd] != "32" || applied.Values[netTuneKeyInitrwnd] != "32" {
		t.Errorf("调完应该报 32：%+v", applied.Values)
	}
	var changed bool
	for _, change := range applied.Changed {
		if change.Key == netTuneKeyInitcwnd && change.From == "10" && change.To == "32" {
			changed = true
		}
	}
	if !changed || !applied.HasBackup {
		t.Errorf("要记一笔改动、能还原：%+v hasBackup=%v", applied.Changed, applied.HasBackup)
	}
	if again := netTuneRunMode("apply", nil); len(again.Changed) != 0 {
		t.Errorf("第二遍不该再改：%+v", again.Changed)
	}

	// DHCP 续租 / 网络重启把 eth0 的路由重建了：Agent 下一轮（最多一分钟）补回，不用再点
	routes.set(0, "default via 10.0.0.1 dev eth0 proto dhcp src 10.0.0.5 metric 100")
	module := newNetTuneExtModule()
	now := time.Unix(1_700_000_000, 0)
	if !module.maybeMaintainRoutes(now) {
		t.Fatal("有调优标记时应该去检查路由")
	}
	netTuneWaitFor(t, func() bool { return strings.HasSuffix(routes.line(0), "initcwnd 32 initrwnd 32") }, "被冲掉的初始窗口没补回来")
	netTuneWaitFor(t, func() bool { module.mu.Lock(); defer module.mu.Unlock(); return !module.busy }, "补完要放开")
	if module.maybeMaintainRoutes(now.Add(30 * time.Second)) {
		t.Error("一分钟内只查一次")
	}
	if !module.maybeMaintainRoutes(now.Add(61 * time.Second)) {
		t.Error("过了一分钟要再查")
	}
	netTuneWaitFor(t, func() bool { module.mu.Lock(); defer module.mu.Unlock(); return !module.busy }, "补完要放开")

	restored := netTuneRunMode("restore", nil)
	if restored.Error != "" || len(restored.Failed) != 0 {
		t.Fatalf("还原失败：%+v", restored)
	}
	if got := routes.line(0); got != "default via 10.0.0.1 dev eth0 proto dhcp src 10.0.0.5 metric 100" {
		t.Errorf("eth0 应该回到没设窗口：%s", got)
	}
	if got := routes.line(1); got != "default via 10.1.0.1 dev eth1 metric 200 initcwnd 20" {
		t.Errorf("eth1 应该回到用户原来的 initcwnd 20：%s", got)
	}
	if _, err := os.Stat(netTuneRouteStatePath); !os.IsNotExist(err) {
		t.Errorf("还原后调优标记要删掉（不再补）：%v", err)
	}
	// 还原后不再补
	routes.set(0, "default via 10.0.0.1 dev eth0 proto dhcp src 10.0.0.5 metric 100")
	if module.maybeMaintainRoutes(now.Add(10 * time.Minute)) {
		netTuneWaitFor(t, func() bool { module.mu.Lock(); defer module.mu.Unlock(); return !module.busy }, "补完要放开")
	}
	if strings.Contains(routes.line(0), "initcwnd") {
		t.Errorf("还原后不该再补：%s", routes.line(0))
	}
}

// 输出里才有的标志（linkdown）不能原样塞回 replace，不然内核报错、窗口设不上；onlink 要留着。
func TestNetTuneInitWindowDropsOutputOnlyFlags(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("只在 Linux 上跑")
	}
	netTuneFakeProc(t, netTuneDistroDefaults())
	routes := netTuneFakeIP(t, "default via 10.0.0.1 dev eth0 onlink linkdown")
	applied := netTuneRunMode("apply", nil)
	if len(applied.Failed) != 0 {
		t.Fatalf("不该失败：%+v", applied.Failed)
	}
	if got := routes.line(0); got != "default via 10.0.0.1 dev eth0 onlink initcwnd 32 initrwnd 32" {
		t.Errorf("路由：%s", got)
	}
}

// 没有 IPv4 默认路由（纯 IPv6、策略路由）：初始窗口这一项算「没有」，不算失败，别的照调。
func TestNetTuneInitWindowWithoutDefaultRoute(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("只在 Linux 上跑")
	}
	netTuneFakeProc(t, netTuneDistroDefaults())
	netTuneFakeIP(t)
	applied := netTuneRunMode("apply", nil)
	if len(applied.Failed) != 0 || applied.Error != "" {
		t.Fatalf("不该失败：%+v", applied)
	}
	var missing bool
	for _, key := range applied.Missing {
		missing = missing || key == netTuneKeyInitcwnd
	}
	if !missing {
		t.Errorf("没有默认路由时初始窗口应该算「没有」：%+v", applied.Missing)
	}
	if _, ok := applied.Values[netTuneKeyInitcwnd]; ok {
		t.Errorf("没有默认路由不该报值：%+v", applied.Values)
	}
}

func netTuneWaitFor(t *testing.T, ok func() bool, message string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatal(message)
		}
		time.Sleep(5 * time.Millisecond)
	}
}
