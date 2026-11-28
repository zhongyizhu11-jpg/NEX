package main

/*
扩展模块 "nettune"（2.2.250 起）：一键网络调优。面板那头见 server/ops/netTuneAgent.ts，
参数表和「达标」的判断见 shared/netTune.ts。

安装脚本（server/agentInstallScripts.ts 的 apply_network_tuning）装机 / 升级时已经调过一遍：
BBR + fq、大缓冲、连接跟踪表、几项 TCP 行为。这里是同一套规则，搬到 Agent 里，让管理员
不用重装就能：
  - 检查：读出这些参数现在的值（加上连接跟踪用量、可用的拥塞控制算法、内核版本）；
  - 调优：按同样的规则调一遍 —— 只往「更适合转发」的方向调，已经更好的值原样保留；
    拥塞控制只在现在是默认的 cubic / reno（或已是 bbr）时改成 bbr，不覆盖用户自选的算法。
    调完把这些键的当前值写进 /etc/sysctl.d/99-forwardx-network.conf（和安装脚本同一个文件），
    重启后还在。

指令：{"runs": [{"id": "...", "apply": true|false, "mode": "...", "values": {...}}]}，面板每轮重发，直到收到对应 id 的结果。

2.2.255 起多两种 mode（老 Agent 不认 mode，只看 apply=false，当一次「检查」，不会误改）：
  - set：把指定的几项改成给定的值（只收 netTuneEditableKey 里的键，值按键校验）；每项写完读回来核对，
    读回来不一样就把这一项改回原值。写进同一个 sysctl.d 文件。
  - restore：改回「面板第一次改这台机器之前」的值（见 netTuneBackupPath），并删掉面板写的 sysctl.d /
    modprobe.d 文件，重启后也是原样。
任何一次改动（apply / set）之前，如果还没有备份，先把这些键当时的值存一份；之后不再覆盖，「原样」一直是第一次那份。
2.2.276 起（和 tcpfit 学的两点，见 ext_nettune_window.go）：
  - 缓冲上限按内存封顶：rmem_max / wmem_max / tcp_rmem / tcp_wmem 的上限建议 64 MiB，但不超过内存的 1/32
    （低于建议抬上来，超过预算压下去）。小内存机器上 64 MiB 会让几条大流吃光全局 TCP 内存。
  - 初始窗口：每条 IPv4 默认路由的 initcwnd / initrwnd 抬到 32，新连接第一个来回能多发一倍多的数据；
    网络重连冲掉后 Agent 每分钟检查一次补回，还原时回到调优前。
上报：{"results": [...]}，每个结果在内存里留 15 分钟，每轮都报，面板自己去重。
同一个 id 只做一次（做过的记在内存里；Agent 重启后面板重发也无妨：调优本身是幂等的）。
*/

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const netTuneResultTTL = 15 * time.Minute

var (
	netTuneProcRoot      = "/proc/sys"
	netTuneConfPath      = "/etc/sysctl.d/99-forwardx-network.conf"
	netTuneHashsizePath  = "/sys/module/nf_conntrack/parameters/hashsize"
	netTuneModprobeConf  = "/etc/modprobe.d/99-forwardx-conntrack.conf"
	netTuneBackupPath    = "/etc/forwardx-nettune/backup.json"
	netTuneBBRModuleConf = "/etc/modules-load.d/forwardx-bbr.conf"
	netTuneMemInfoPath   = "/proc/meminfo"
	// netTuneLoadBBR 尝试加载 tcp_bbr 模块（测试里换掉）。
	netTuneLoadBBR = func() {
		_, _ = commandOutputWithTimeout(5*time.Second, "modprobe", "tcp_bbr")
	}
)

type netTuneRuleKind int

const (
	// 数值至少要到 want；三元组（tcp_wmem 这类）只看、只动最后一个字段。
	netTuneAtLeast netTuneRuleKind = iota
	// 数值至多 want。
	netTuneAtMost
	// 这几位要置上（按位或，保留已有的位）。
	netTuneBitsSet
	// 必须等于 want。
	netTuneEquals
	// TCP 缓冲三元组（tcp_rmem / tcp_wmem：最小 起点 上限）：上限至少 want（有内存预算时不超过预算），
	// 起点（中间值）至少 netTuneTCPRmemDefault。抬完保证 最小 ≤ 起点 ≤ 上限。
	netTuneRmemAtLeast
	// 三段各自至少 triple[i]（tcp_mem：低 压力 上限，单位是页），只抬不降，抬完保证从小到大。
	netTuneTripleAtLeast
)

// netTuneMemRule：哪几项按这台机器的内存 / 带宽算（2.2.276，和 tcpfit 学的）。
type netTuneMemRule int

const (
	netTuneMemNone netTuneMemRule = iota
	// 缓冲上限：want 和 budget 换成 netTuneBufferLimits 的结果。
	netTuneMemBuffer
	// tcp_mem：triple 换成 netTuneTCPMem 的结果；读不到内存就不动。
	netTuneMemTCPMem
	// vm.min_free_kbytes：至少 32 MiB，但不超过内存的 1/32；读不到内存就不动。
	netTuneMemMinFree
)

// netTuneTCPRmemDefault 是 tcp_rmem 中间值（每条 TCP 接收缓冲的起点）至少抬到多少。
// 内核默认 128 KiB：高延迟 + 丢包的线路上新连接的 BBR 启动阶段会被接收窗口卡住、过早结束，
// 之后十几秒只有几到几十 Mbit/s。取 1 MiB 不取 4 MiB：4 MiB 起步更快，但 50 ms 丢包线路上
// 十几条新连接同时下载时最慢的那条反而晚 10–15% 收完，对端读得慢的连接最多攒的数据也是 4 倍。
// 实测见 forwardx-fxp/internal/v3/BENCHMARKS.md「tcp_rmem 起点」一节。它只是起点：内核按收到的
// 数据分配，没数据进来的连接不多占；对端一直不读的连接最多攒到这么多（原来是 128 KiB）。
const netTuneTCPRmemDefault = 1048576

type netTuneRule struct {
	key  string
	kind netTuneRuleKind
	want int64
	// mem：按内存 / 带宽算的几项（见 netTuneHostRule）。缓冲上限超过 budget 的压到 budget；
	// budget 为 0 表示不封顶（读不到内存，照旧只抬不压）。
	mem    netTuneMemRule
	budget int64
	triple [3]int64
}

// 和安装脚本 apply_network_tuning 的顺序、取值一一对应（改一边记得改另一边，shared/netTune.ts 也是）。
var netTuneRules = []netTuneRule{
	{key: "net.ipv4.ip_forward", kind: netTuneEquals, want: 1},
	{key: "net.core.rmem_max", kind: netTuneAtLeast, want: netTuneBufferWant, mem: netTuneMemBuffer},
	{key: "net.core.wmem_max", kind: netTuneAtLeast, want: netTuneBufferWant, mem: netTuneMemBuffer},
	{key: "net.ipv4.tcp_rmem", kind: netTuneRmemAtLeast, want: netTuneBufferWant, mem: netTuneMemBuffer},
	// 发送方向的起点也抬到 1 MiB（2.2.276，tcpfit 两个方向都这么设）：起点只是开始时的额度，
	// 发送队列里没发出去的数据另有 tcp_notsent_lowat 管着。
	{key: "net.ipv4.tcp_wmem", kind: netTuneRmemAtLeast, want: netTuneBufferWant, mem: netTuneMemBuffer},
	{key: "net.ipv4.tcp_mem", kind: netTuneTripleAtLeast, mem: netTuneMemTCPMem},
	{key: "net.netfilter.nf_conntrack_max", kind: netTuneAtLeast, want: 1048576},
	{key: "net.netfilter.nf_conntrack_tcp_be_liberal", kind: netTuneAtLeast, want: 1},
	{key: "net.ipv4.tcp_no_metrics_save", kind: netTuneAtLeast, want: 1},
	{key: "net.core.rmem_default", kind: netTuneAtLeast, want: 1048576},
	{key: "net.core.wmem_default", kind: netTuneAtLeast, want: 1048576},
	{key: "net.ipv4.udp_rmem_min", kind: netTuneAtLeast, want: 16384},
	{key: "net.ipv4.udp_wmem_min", kind: netTuneAtLeast, want: 16384},
	{key: "net.core.netdev_max_backlog", kind: netTuneAtLeast, want: 16384},
	{key: "net.core.netdev_budget", kind: netTuneAtLeast, want: 600},
	{key: "net.core.optmem_max", kind: netTuneAtLeast, want: 65536},
	{key: "net.core.somaxconn", kind: netTuneAtLeast, want: 8192},
	{key: "net.ipv4.tcp_max_syn_backlog", kind: netTuneAtLeast, want: 8192},
	{key: "net.ipv4.tcp_mtu_probing", kind: netTuneAtLeast, want: 1},
	{key: "net.ipv4.tcp_notsent_lowat", kind: netTuneAtMost, want: 131072},
	{key: "net.ipv4.tcp_slow_start_after_idle", kind: netTuneAtMost, want: 0},
	{key: "net.ipv4.tcp_fastopen", kind: netTuneBitsSet, want: 3},
	{key: "net.ipv4.tcp_tw_reuse", kind: netTuneEquals, want: 1},
	// 以下 2.2.276 起，和 tcpfit 的基础调优一致。刻意没搬的两项：
	//   ip_local_port_range = 1024 65535 —— 中转机上本机发起的连接会占到规则要监听的端口，规则起不来；
	//   tcp_no_metrics_save = 0 —— 这里保持 1（一次丢包的坏印象不拖慢后面的新连接），tcpfit 没给理由。
	{key: "net.ipv4.tcp_window_scaling", kind: netTuneEquals, want: 1},
	{key: "net.ipv4.tcp_moderate_rcvbuf", kind: netTuneEquals, want: 1},
	{key: "net.ipv4.tcp_adv_win_scale", kind: netTuneEquals, want: 1},
	{key: "net.ipv4.tcp_sack", kind: netTuneEquals, want: 1},
	{key: "net.ipv4.tcp_dsack", kind: netTuneEquals, want: 1},
	{key: "net.ipv4.tcp_timestamps", kind: netTuneEquals, want: 1},
	{key: "net.ipv4.tcp_syncookies", kind: netTuneEquals, want: 1},
	{key: "net.ipv4.tcp_fin_timeout", kind: netTuneAtMost, want: 15},
	{key: "net.ipv4.tcp_keepalive_time", kind: netTuneAtMost, want: 600},
	{key: "vm.min_free_kbytes", kind: netTuneAtLeast, want: netTuneMinFreeKB, mem: netTuneMemMinFree},
	{key: "fs.file-max", kind: netTuneAtLeast, want: 1000000},
}

/*
缓冲上限按带宽和内存算（2.2.276，和 shared/netTune.ts 的 netTuneBufferLimits、安装脚本的 tuning_buffer_limits 一致）。

知道这台机器的带宽（面板上填的线路带宽，或出口整形的公网带宽）时，照 tcpfit：上限 = 2 × BDP + 2 MiB，
BDP 按 150 ms 往返算（覆盖常见跨境线路，也不会按某次不准的 ping 把缓冲算小），向上取整到 MiB。
不知道带宽时建议 64 MiB（200 ms 跨境线路单连接跑满千兆要这么大）。两种都不超过内存的 1/32：
内核默认的全局 TCP 内存上限（tcp_mem）约是内存的 1/10 左右，1 GiB 的机器上允许单条连接占 64 MiB，
几条大流就把全局预算吃光，内核进入内存压力后把所有连接的窗口一起压小。1/32 是 tcpfit 的取法：
tcp_mem 上限按内存 1/4 算时的 1/8，即至少容得下 8 条大流同时跑满。按 MiB 往下取整，最低 4 MiB
（再低百兆都跑不满）、最高 256 MiB（再大一条连接就独占全局预算，收益也早没了）。

	内存  512 MiB → 16 MiB    1 GiB → 32 MiB    2 GiB 起 → 64 MiB（大机器自己调到 256 MiB 以内都算合适）
*/
const (
	netTuneBufferWant        int64 = 64 << 20
	netTuneBufferBudgetFloor int64 = 4 << 20
	netTuneBufferBudgetCeil  int64 = 256 << 20
	netTuneBufferRTTMillis   int64 = 150
	netTuneMinFreeKB         int64 = 32768
)

// netTuneMemTotal 读 /proc/meminfo 的 MemTotal（字节）。
func netTuneMemTotal() (int64, bool) {
	raw, err := os.ReadFile(netTuneMemInfoPath)
	if err != nil {
		return 0, false
	}
	for _, line := range strings.Split(string(raw), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 && fields[0] == "MemTotal:" {
			kb, err := strconv.ParseInt(fields[1], 10, 64)
			if err != nil || kb <= 0 {
				return 0, false
			}
			return kb * 1024, true
		}
	}
	return 0, false
}

// netTuneBufferLimits 返回缓冲上限的建议值和内存预算；读不到内存时预算为 0（不封顶）。
// bandwidthMbps 为 0 表示不知道带宽。
func netTuneBufferLimits(bandwidthMbps int64) (want, budget int64) {
	want = netTuneBufferWant
	if bandwidthMbps > 0 {
		bdp := bandwidthMbps * 1_000_000 / 8 * netTuneBufferRTTMillis / 1000
		want = (2*bdp + 2<<20 + 1<<20 - 1) / (1 << 20) * (1 << 20)
		want = min(max(want, netTuneBufferBudgetFloor), netTuneBufferBudgetCeil)
	}
	mem, ok := netTuneMemTotal()
	if !ok {
		return want, 0
	}
	budget = mem / 32 / (1 << 20) * (1 << 20)
	budget = min(max(budget, netTuneBufferBudgetFloor), netTuneBufferBudgetCeil)
	return min(want, budget), budget
}

// netTuneTCPMem：全局 TCP 内存（页）的 低 / 压力 / 上限 = 内存的 1/16、1/8、1/4（tcpfit 的取法；
// 内核默认约 3/64、1/16、3/32，大流多时早早进入内存压力、所有连接的窗口一起被压小）。
func netTuneTCPMem(memBytes int64) [3]int64 {
	pages := memBytes / 4096
	return [3]int64{max(pages/16, 4096), max(pages/8, 8192), max(pages/4, 16384)}
}

type netTuneHostFacts struct {
	memBytes      int64
	bandwidthMbps int64
}

func netTuneReadHostFacts(bandwidthMbps int64) netTuneHostFacts {
	mem, _ := netTuneMemTotal()
	return netTuneHostFacts{memBytes: mem, bandwidthMbps: bandwidthMbps}
}

// netTuneHostRule：按这台机器的内存 / 带宽换掉那几项的目标值；skip 为 true 表示这台机器上不动这一项
// （读不到内存时的 tcp_mem、min_free_kbytes）。
func netTuneHostRule(rule netTuneRule, facts netTuneHostFacts) (netTuneRule, bool) {
	switch rule.mem {
	case netTuneMemBuffer:
		rule.want, rule.budget = netTuneBufferLimits(facts.bandwidthMbps)
	case netTuneMemTCPMem:
		if facts.memBytes <= 0 {
			return rule, true
		}
		rule.triple = netTuneTCPMem(facts.memBytes)
	case netTuneMemMinFree:
		if facts.memBytes <= 0 {
			return rule, true
		}
		rule.want = min(netTuneMinFreeKB, facts.memBytes/1024/32)
	}
	return rule, false
}

const (
	netTuneKeyCC        = "net.ipv4.tcp_congestion_control"
	netTuneKeyQdisc     = "net.core.default_qdisc"
	netTuneKeyAvailCC   = "net.ipv4.tcp_available_congestion_control"
	netTuneKeyBuckets   = "net.netfilter.nf_conntrack_buckets"
	netTuneKeyCount     = "net.netfilter.nf_conntrack_count"
	netTuneKeyConntrack = "net.netfilter.nf_conntrack_max"
	netTuneKeyOSRelease = "kernel.osrelease"
	// 不是 /proc/sys 下的键：Agent 算好报给面板（面板按它判断缓冲上限）。
	netTuneKeyMemTotal   = "meminfo.memtotal"
	netTuneMinBuckets    = 262144
	netTuneConfHeader    = "# NEX 转发调优（面板「一键网络调优」写入，和 Agent 安装脚本同一个文件）；安装时设置 FORWARDX_NETWORK_TUNING=0 可跳过安装时的调优\n"
	netTuneMaxValueBytes = 256
)

// 会读出来上报的全部键（规则里的 + 拥塞控制几项 + 只读的用量）。
func netTuneReportKeys() []string {
	keys := make([]string, 0, len(netTuneRules)+6)
	for _, rule := range netTuneRules {
		keys = append(keys, rule.key)
	}
	return append(keys, netTuneKeyCC, netTuneKeyQdisc, netTuneKeyAvailCC, netTuneKeyBuckets, netTuneKeyCount, netTuneKeyOSRelease)
}

type netTuneChange struct {
	Key  string `json:"key"`
	From string `json:"from"`
	To   string `json:"to"`
}

type netTuneFailure struct {
	Key   string `json:"key"`
	Error string `json:"error"`
}

type netTuneResult struct {
	ID         string            `json:"id"`
	Apply      bool              `json:"apply"`
	Mode       string            `json:"mode,omitempty"`
	HasBackup  bool              `json:"hasBackup"`
	Status     string            `json:"status"`
	StartedAt  int64             `json:"startedAt"`
	FinishedAt int64             `json:"finishedAt,omitempty"`
	Values     map[string]string `json:"values,omitempty"`
	// Missing：这台机器上没有的键（例如没加载 nf_conntrack 模块），不算失败。
	Missing   []string         `json:"missing,omitempty"`
	Changed   []netTuneChange  `json:"changed,omitempty"`
	Failed    []netTuneFailure `json:"failed,omitempty"`
	File      string           `json:"file,omitempty"`
	FileError string           `json:"fileError,omitempty"`
	Error     string           `json:"error,omitempty"`
}

type netTuneDirective struct {
	Runs []struct {
		ID     string            `json:"id"`
		Apply  bool              `json:"apply"`
		Mode   string            `json:"mode"`
		Values map[string]string `json:"values"`
		// BandwidthMbps：这台机器的带宽（面板上的线路带宽 / 出口整形带宽，2.2.276），0 = 不知道。
		BandwidthMbps int64 `json:"bandwidthMbps"`
	} `json:"runs"`
}

type netTuneReport struct {
	Results []netTuneResult `json:"results"`
}

type netTuneExtModule struct {
	mu      sync.Mutex
	results map[string]*netTuneResult
	// busy：同一时间只跑一轮（检查和调优都很快，但别让两轮调优交错写同一批键）。
	busy bool
	// lastRouteCheck：上一次检查默认路由的初始窗口（见 maybeMaintainRoutes），一分钟一次。
	lastRouteCheck time.Time
}

func newNetTuneExtModule() *netTuneExtModule {
	return &netTuneExtModule{results: map[string]*netTuneResult{}}
}

func (m *netTuneExtModule) Name() string { return "nettune" }

func (m *netTuneExtModule) Report(cfg Config) any {
	m.maybeMaintainRoutes(time.Now())
	m.mu.Lock()
	defer m.mu.Unlock()
	cutoff := time.Now().Add(-netTuneResultTTL).Unix()
	report := netTuneReport{}
	ids := make([]string, 0, len(m.results))
	for id, r := range m.results {
		if r.FinishedAt > 0 && r.FinishedAt < cutoff {
			delete(m.results, id)
			continue
		}
		ids = append(ids, id)
	}
	if len(ids) == 0 {
		return nil
	}
	sort.Strings(ids)
	for _, id := range ids {
		report.Results = append(report.Results, *m.results[id])
	}
	return report
}

func (m *netTuneExtModule) Apply(cfg Config, directive json.RawMessage) {
	var d netTuneDirective
	if err := json.Unmarshal(directive, &d); err != nil {
		logf("nettune directive invalid: %v", err)
		return
	}
	for _, run := range d.Runs {
		if !opsValidID(run.ID) {
			continue
		}
		m.mu.Lock()
		if _, seen := m.results[run.ID]; seen || m.busy {
			m.mu.Unlock()
			continue
		}
		m.busy = true
		result := &netTuneResult{ID: run.ID, Apply: run.Apply, Status: "running", StartedAt: time.Now().Unix()}
		m.results[run.ID] = result
		m.mu.Unlock()

		apply := run.Apply
		mode := netTuneMode(run.Mode, run.Apply)
		values := run.Values
		bandwidth := min(max(run.BandwidthMbps, 0), 1_000_000)
		result.Mode = mode
		go func(id string) {
			done := netTuneRunWith(mode, values, bandwidth)
			m.mu.Lock()
			defer m.mu.Unlock()
			done.ID = id
			done.Apply = apply
			done.Mode = mode
			done.StartedAt = m.results[id].StartedAt
			done.Status = "done"
			done.FinishedAt = time.Now().Unix()
			m.results[id] = &done
			m.busy = false
			wakeAgentExt()
		}(run.ID)
		// 一轮只接一个：其余的等面板下一轮重发。
		return
	}
}

func netTuneProcPath(key string) string {
	return filepath.Join(netTuneProcRoot, strings.ReplaceAll(key, ".", "/"))
}

// netTuneRead 读一个键，把制表符和连续空格压成一个空格（tcp_rmem 这类三元组）。
// 键不存在返回 ok=false。
func netTuneRead(key string) (string, bool, error) {
	raw, err := os.ReadFile(netTuneProcPath(key))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", false, nil
		}
		return "", false, err
	}
	if len(raw) > netTuneMaxValueBytes {
		raw = raw[:netTuneMaxValueBytes]
	}
	return strings.Join(strings.Fields(string(raw)), " "), true, nil
}

func netTuneWrite(key, value string) error {
	return netTuneWriteExisting(netTuneProcPath(key), value)
}

// netTuneWriteExisting 只写已经存在的文件（/proc/sys、/sys 下的参数），不新建。
func netTuneWriteExisting(path, value string) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_TRUNC, 0)
	if err != nil {
		return err
	}
	if _, err := file.WriteString(value); err != nil {
		file.Close()
		return err
	}
	return file.Close()
}

// netTuneDesired 按规则算出这个键该是什么值；不用改（或认不出来）返回 ok=false。
func netTuneDesired(rule netTuneRule, current string) (string, bool) {
	fields := strings.Fields(current)
	if len(fields) == 0 {
		return "", false
	}
	switch rule.kind {
	case netTuneAtLeast:
		last, err := strconv.ParseInt(fields[len(fields)-1], 10, 64)
		if err != nil {
			return "", false
		}
		target := last
		if last < rule.want {
			target = rule.want
		} else if rule.budget > 0 && last > rule.budget {
			// 超过内存预算：压到预算（只有缓冲上限这几项有预算）
			target = rule.budget
		}
		if target == last {
			return "", false
		}
		fields[len(fields)-1] = strconv.FormatInt(target, 10)
		return strings.Join(fields, " "), true
	case netTuneRmemAtLeast:
		if len(fields) != 3 {
			// 认不出三段（不该发生）：退回只看最后一段。
			fallback := rule
			fallback.kind = netTuneAtLeast
			return netTuneDesired(fallback, current)
		}
		nums := [3]int64{}
		for i, field := range fields {
			n, err := strconv.ParseInt(field, 10, 64)
			if err != nil || n < 0 {
				return "", false
			}
			nums[i] = n
		}
		minimum, start, limit := nums[0], nums[1], nums[2]
		start = max(start, netTuneTCPRmemDefault, minimum)
		limit = max(limit, rule.want)
		if rule.budget > 0 && limit > rule.budget {
			limit = rule.budget
		}
		limit = max(limit, start)
		if start == nums[1] && limit == nums[2] {
			return "", false
		}
		return fmt.Sprintf("%d %d %d", minimum, start, limit), true
	case netTuneTripleAtLeast:
		if len(fields) != 3 {
			return "", false
		}
		nums := [3]int64{}
		for i, field := range fields {
			n, err := strconv.ParseInt(field, 10, 64)
			if err != nil || n < 0 {
				return "", false
			}
			nums[i] = max(n, rule.triple[i])
		}
		nums[1] = max(nums[1], nums[0])
		nums[2] = max(nums[2], nums[1])
		next := fmt.Sprintf("%d %d %d", nums[0], nums[1], nums[2])
		if next == strings.Join(fields, " ") {
			return "", false
		}
		return next, true
	case netTuneAtMost:
		if len(fields) != 1 {
			return "", false
		}
		value, err := strconv.ParseInt(fields[0], 10, 64)
		if err != nil || value <= rule.want {
			return "", false
		}
		return strconv.FormatInt(rule.want, 10), true
	case netTuneBitsSet:
		if len(fields) != 1 {
			return "", false
		}
		value, err := strconv.ParseInt(fields[0], 10, 64)
		if err != nil || value|rule.want == value {
			return "", false
		}
		return strconv.FormatInt(value|rule.want, 10), true
	case netTuneEquals:
		if len(fields) != 1 {
			return "", false
		}
		value, err := strconv.ParseInt(fields[0], 10, 64)
		if err != nil || value == rule.want {
			return "", false
		}
		return strconv.FormatInt(rule.want, 10), true
	}
	return "", false
}

func netTuneHasWord(list, word string) bool {
	for _, item := range strings.Fields(list) {
		if item == word {
			return true
		}
	}
	return false
}

// netTuneRun 读一遍（apply 时先调再读），返回结果（ID / 状态由调用方填）。
// netTuneMode：老面板只发 apply，没有 mode。
func netTuneMode(mode string, apply bool) string {
	switch mode {
	case "check", "apply", "set", "restore":
		return mode
	}
	if apply {
		return "apply"
	}
	return "check"
}

func netTuneRun(apply bool) netTuneResult {
	return netTuneRunMode(netTuneMode("", apply), nil)
}

func netTuneRunMode(mode string, values map[string]string) netTuneResult {
	return netTuneRunWith(mode, values, 0)
}

// netTuneRunWith：bandwidthMbps 是面板给的这台机器的带宽（0 = 不知道），一键调优按它算缓冲上限。
func netTuneRunWith(mode string, values map[string]string, bandwidthMbps int64) netTuneResult {
	result := netTuneResult{Mode: mode}
	if runtime.GOOS != "linux" {
		result.Error = "只有 Linux 主机能读写内核网络参数"
		return result
	}
	switch mode {
	case "apply":
		netTuneEnsureBackup(&result)
		netTuneApply(&result, netTuneReadHostFacts(bandwidthMbps))
		netTuneApplyInitWindow(&result, true)
	case "set":
		netTuneEnsureBackup(&result)
		netTuneSetValues(&result, values)
	case "restore":
		netTuneRestoreInitWindow(&result)
		netTuneRestore(&result)
	}
	_, err := os.Stat(netTuneBackupPath)
	_, routeErr := os.Stat(netTuneRouteStatePath)
	result.HasBackup = err == nil || routeErr == nil
	result.Values = map[string]string{}
	for _, key := range netTuneReportKeys() {
		value, ok, err := netTuneRead(key)
		switch {
		case err != nil:
			result.Failed = netTuneAppendFailure(result.Failed, key, err)
		case !ok:
			result.Missing = append(result.Missing, key)
		default:
			result.Values[key] = value
		}
	}
	if mem, ok := netTuneMemTotal(); ok {
		result.Values[netTuneKeyMemTotal] = strconv.FormatInt(mem, 10)
	}
	netTuneReportInitWindow(&result)
	return result
}

func netTuneAppendFailure(list []netTuneFailure, key string, err error) []netTuneFailure {
	for _, item := range list {
		if item.Key == key {
			return list
		}
	}
	message := err.Error()
	if errors.Is(err, os.ErrPermission) || strings.Contains(message, "read-only file system") {
		message = "没有权限改（容器里运行的 Agent 改不了宿主机的内核参数）"
	}
	return append(list, netTuneFailure{Key: key, Error: message})
}

func netTuneSet(result *netTuneResult, key, from, to string) bool {
	if err := netTuneWrite(key, to); err != nil {
		result.Failed = netTuneAppendFailure(result.Failed, key, err)
		return false
	}
	result.Changed = append(result.Changed, netTuneChange{Key: key, From: from, To: to})
	return true
}

func netTuneApply(result *netTuneResult, facts netTuneHostFacts) {
	// 写进配置文件的：所有规则里的键（调过的写新值，本来就更好的写原值 —— 和安装脚本一样，
	// 用当前生效值重写，不会把别人调过的值丢掉）。
	persisted := make([][2]string, 0, len(netTuneRules)+3)
	for _, base := range netTuneRules {
		rule, skip := netTuneHostRule(base, facts)
		current, ok, err := netTuneRead(rule.key)
		if err != nil {
			result.Failed = netTuneAppendFailure(result.Failed, rule.key, err)
			continue
		}
		if !ok {
			continue
		}
		if want, change := netTuneDesired(rule, current); change && !skip {
			if netTuneSet(result, rule.key, current, want) {
				current = want
			}
		}
		persisted = append(persisted, [2]string{rule.key, current})
	}

	// 连接跟踪哈希桶抬到 表上限/4（至少 262144）：只抬表上限不抬桶，查表链会越来越长。
	if bucketValue, ok := netTuneApplyBuckets(result); ok {
		persisted = append(persisted, [2]string{netTuneKeyBuckets, bucketValue})
	}

	// BBR：只在当前是默认的 cubic / reno（或已是 bbr）时设置，不覆盖用户自选的算法。
	if cc, ok, _ := netTuneRead(netTuneKeyCC); ok && (cc == "cubic" || cc == "reno" || cc == "bbr") {
		available, _, _ := netTuneRead(netTuneKeyAvailCC)
		if !netTuneHasWord(available, "bbr") {
			netTuneLoadBBR()
			available, _, _ = netTuneRead(netTuneKeyAvailCC)
		}
		if netTuneHasWord(available, "bbr") {
			qdiscOK := true
			if qdisc, ok, _ := netTuneRead(netTuneKeyQdisc); ok && qdisc != "fq" {
				qdiscOK = netTuneSet(result, netTuneKeyQdisc, qdisc, "fq")
			}
			if qdiscOK {
				persisted = append(persisted, [2]string{netTuneKeyQdisc, "fq"})
			}
			ccOK := true
			if cc != "bbr" {
				ccOK = netTuneSet(result, netTuneKeyCC, cc, "bbr")
			}
			if ccOK {
				persisted = append(persisted, [2]string{netTuneKeyCC, "bbr"})
				// 开机时先加载 tcp_bbr，sysctl.d 里的 bbr 才设得上（老内核不会自动加载）
				if err := os.MkdirAll(filepath.Dir(netTuneBBRModuleConf), 0755); err == nil {
					_ = writeFileAtomicDurable(netTuneBBRModuleConf, []byte("tcp_bbr\n"), 0644)
				}
			}
		}
	}

	if err := netTuneWriteConf(persisted); err != nil {
		result.FileError = err.Error()
	} else {
		result.File = netTuneConfPath
	}
}

// netTuneApplyBuckets 返回要写进配置文件的桶数（sysctl 写成功时）；老内核这个键只读，
// 改走模块参数 hashsize，并写 modprobe.d 让重启后还在（这种情况不写进 sysctl 文件）。
func netTuneApplyBuckets(result *netTuneResult) (string, bool) {
	maxValue, okMax, _ := netTuneRead(netTuneKeyConntrack)
	current, okCur, _ := netTuneRead(netTuneKeyBuckets)
	if !okMax || !okCur {
		return "", false
	}
	maxN, errMax := strconv.ParseInt(maxValue, 10, 64)
	curN, errCur := strconv.ParseInt(current, 10, 64)
	if errMax != nil || errCur != nil {
		return "", false
	}
	want := maxN / 4
	if want < netTuneMinBuckets {
		want = netTuneMinBuckets
	}
	if want <= curN {
		return current, true
	}
	wantText := strconv.FormatInt(want, 10)
	if err := netTuneWrite(netTuneKeyBuckets, wantText); err == nil {
		if after, ok, _ := netTuneRead(netTuneKeyBuckets); ok && after == wantText {
			result.Changed = append(result.Changed, netTuneChange{Key: netTuneKeyBuckets, From: current, To: wantText})
			return wantText, true
		}
	}
	if err := netTuneWriteExisting(netTuneHashsizePath, wantText); err != nil {
		result.Failed = netTuneAppendFailure(result.Failed, netTuneKeyBuckets, fmt.Errorf("改不了：%v", err))
		return "", false
	}
	result.Changed = append(result.Changed, netTuneChange{Key: netTuneKeyBuckets, From: current, To: wantText})
	if err := os.MkdirAll(filepath.Dir(netTuneModprobeConf), 0755); err == nil {
		_ = writeFileAtomicDurable(netTuneModprobeConf, []byte("options nf_conntrack hashsize="+wantText+"\n"), 0644)
	}
	return "", false
}

func netTuneWriteConf(entries [][2]string) error {
	if len(entries) == 0 {
		return errors.New("没有可以写的参数")
	}
	if err := os.MkdirAll(filepath.Dir(netTuneConfPath), 0755); err != nil {
		return err
	}
	var builder strings.Builder
	builder.WriteString(netTuneConfHeader)
	for _, entry := range entries {
		builder.WriteString(entry[0])
		builder.WriteString(" = ")
		builder.WriteString(entry[1])
		builder.WriteString("\n")
	}
	return writeFileAtomicDurable(netTuneConfPath, []byte(builder.String()), 0644)
}

/* ---------- 2.2.255：逐项设置、还原 ---------- */

// netTuneBackupKeys：备份 / 还原覆盖的键 —— 一键调优和逐项设置会动到的全部。
func netTuneBackupKeys() []string {
	keys := make([]string, 0, len(netTuneRules)+3)
	for _, rule := range netTuneRules {
		keys = append(keys, rule.key)
	}
	return append(keys, netTuneKeyCC, netTuneKeyQdisc, netTuneKeyBuckets)
}

type netTuneBackup struct {
	SavedAt int64             `json:"savedAt"`
	Values  map[string]string `json:"values"`
}

// netTuneEnsureBackup：第一次改之前存一份当时的值。已经有了就不动 —— 「原样」永远是面板第一次动手之前那一份。
// 存不下来（只读文件系统）不拦着改，只在结果里说一声：还原就做不了了。
//
// 已经有备份、但新版本多管了几个键（2.2.276 加了 tcp_mem、fin_timeout 这些）：那几个键之前面板没碰过，
// 现在的值就是原样，补进备份里，还原时一起改回去。已有的键不覆盖。
func netTuneEnsureBackup(result *netTuneResult) {
	backup := netTuneBackup{SavedAt: time.Now().Unix(), Values: map[string]string{}}
	if raw, err := os.ReadFile(netTuneBackupPath); err == nil {
		var existing netTuneBackup
		if json.Unmarshal(raw, &existing) != nil || existing.Values == nil {
			return // 坏了的备份不动（还原时会说清楚）
		}
		backup = existing
	} else if !errors.Is(err, os.ErrNotExist) {
		return
	}
	added := false
	for _, key := range netTuneBackupKeys() {
		if _, have := backup.Values[key]; have {
			continue
		}
		if value, ok, err := netTuneRead(key); err == nil && ok {
			backup.Values[key] = value
			added = true
		}
	}
	if !added {
		return
	}
	raw, _ := json.Marshal(backup)
	if err := os.MkdirAll(filepath.Dir(netTuneBackupPath), 0700); err != nil {
		result.Failed = netTuneAppendFailure(result.Failed, "backup", fmt.Errorf("原值没存下来，以后还原不了：%v", err))
		return
	}
	if err := writeFileAtomicDurable(netTuneBackupPath, raw, 0600); err != nil {
		result.Failed = netTuneAppendFailure(result.Failed, "backup", fmt.Errorf("原值没存下来，以后还原不了：%v", err))
	}
}

// netTuneTCPBufferKey：「最小 起点 上限」三段的 TCP 缓冲参数。
func netTuneTCPBufferKey(key string) bool {
	return key == "net.ipv4.tcp_rmem" || key == "net.ipv4.tcp_wmem"
}

var netTuneQdiscChoices = map[string]bool{"fq": true, "fq_codel": true, "cake": true, "pfifo_fast": true, "sfq": true, "codel": true}

// netTuneEditableKey：能逐项设置的键。和 shared/netTune.ts 的 NETTUNE_EDITABLE_KEYS 一致。
func netTuneEditableKey(key string) bool {
	if key == netTuneKeyCC || key == netTuneKeyQdisc {
		return true
	}
	for _, rule := range netTuneRules {
		if rule.key == key {
			return true
		}
	}
	return false
}

// netTuneValidate：数字参数要和当前值的段数一样（tcp_rmem 是三段），每段是非负整数；
// 拥塞控制必须在可用列表里（不在就先试着 modprobe 一下）；队列只收常见几种。
func netTuneValidate(key, value, current string) (string, error) {
	fields := strings.Fields(value)
	if len(fields) == 0 {
		return "", errors.New("值是空的")
	}
	switch key {
	case netTuneKeyCC:
		if len(fields) != 1 || !opsValidID(fields[0]) {
			return "", errors.New("拥塞控制算法名不对")
		}
		available, _, _ := netTuneRead(netTuneKeyAvailCC)
		if !netTuneHasWord(available, fields[0]) {
			_, _ = commandOutputWithTimeout(5*time.Second, "modprobe", "tcp_"+fields[0])
			available, _, _ = netTuneRead(netTuneKeyAvailCC)
		}
		if !netTuneHasWord(available, fields[0]) {
			return "", fmt.Errorf("这台机器的内核没有 %s（可用：%s）", fields[0], available)
		}
		return fields[0], nil
	case netTuneKeyQdisc:
		if len(fields) != 1 || !netTuneQdiscChoices[fields[0]] {
			return "", errors.New("队列只支持 fq、fq_codel、cake、pfifo_fast、sfq、codel")
		}
		return fields[0], nil
	}
	if want := len(strings.Fields(current)); want > 0 && len(fields) != want {
		return "", fmt.Errorf("这一项要填 %d 个数", want)
	}
	nums := make([]int64, 0, len(fields))
	for _, field := range fields {
		n, err := strconv.ParseInt(field, 10, 64)
		if err != nil || n < 0 {
			return "", fmt.Errorf("「%s」不是非负整数", field)
		}
		nums = append(nums, n)
	}
	// TCP 缓冲三元组：最小 ≤ 起点 ≤ 上限（内核不查，填反了缓冲会长不起来或一开始就超上限）。
	if (netTuneTCPBufferKey(key) || key == "net.ipv4.tcp_mem") && len(nums) == 3 && (nums[0] > nums[1] || nums[1] > nums[2]) {
		return "", errors.New("三个数要从小到大：最小 ≤ 起点 ≤ 上限")
	}
	return strings.Join(fields, " "), nil
}

func netTuneSetValues(result *netTuneResult, values map[string]string) {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	if len(keys) == 0 {
		result.Error = "没有要改的参数"
		return
	}
	if len(keys) > 32 {
		result.Error = "一次最多改 32 项"
		return
	}
	// 拥塞控制先于队列改无所谓顺序；但 bbr 不在时 modprobe 要先跑，netTuneValidate 里已经处理了
	for _, key := range keys {
		if !netTuneEditableKey(key) {
			result.Failed = netTuneAppendFailure(result.Failed, key, errors.New("这一项不能在这里改"))
			continue
		}
		current, ok, err := netTuneRead(key)
		if err != nil {
			result.Failed = netTuneAppendFailure(result.Failed, key, err)
			continue
		}
		if !ok {
			result.Failed = netTuneAppendFailure(result.Failed, key, errors.New("这台机器上没有这个参数"))
			continue
		}
		want, err := netTuneValidate(key, values[key], current)
		if err != nil {
			result.Failed = netTuneAppendFailure(result.Failed, key, err)
			continue
		}
		if want == current {
			continue
		}
		if err := netTuneWrite(key, want); err != nil {
			result.Failed = netTuneAppendFailure(result.Failed, key, err)
			continue
		}
		// 读回来核对：内核会把不接受的值改掉（超上限、按页对齐……），对不上就改回原值
		if after, _, _ := netTuneRead(key); after != want {
			_ = netTuneWrite(key, current)
			result.Failed = netTuneAppendFailure(result.Failed, key, fmt.Errorf("内核没有接受 %s（读回来是 %s），已改回 %s", want, after, current))
			continue
		}
		result.Changed = append(result.Changed, netTuneChange{Key: key, From: current, To: want})
	}
	netTunePersistCurrent(result)
}

// netTunePersistCurrent：把一键调优管的这些键按「现在的值」写进 sysctl.d，重启后还是这样。
func netTunePersistCurrent(result *netTuneResult) {
	persisted := make([][2]string, 0, len(netTuneRules)+3)
	for _, key := range append(netTuneBackupKeys()[:len(netTuneRules)], netTuneKeyQdisc, netTuneKeyCC) {
		if value, ok, err := netTuneRead(key); err == nil && ok {
			persisted = append(persisted, [2]string{key, value})
		}
	}
	if err := netTuneWriteConf(persisted); err != nil {
		result.FileError = err.Error()
	} else {
		result.File = netTuneConfPath
	}
}

func netTuneRestore(result *netTuneResult) {
	raw, err := os.ReadFile(netTuneBackupPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			result.Error = "没有找到调优前的原值：面板还没在这台机器上改过参数（安装 Agent 时的调优不算，那一次的原值没有留）"
		} else {
			result.Error = "读不了原值备份：" + err.Error()
		}
		return
	}
	var backup netTuneBackup
	if err := json.Unmarshal(raw, &backup); err != nil || len(backup.Values) == 0 {
		result.Error = "原值备份坏了，没法还原"
		return
	}
	// 先改回队列再改拥塞控制、其余按键名：和设置时一样每项读回来核对
	keys := make([]string, 0, len(backup.Values))
	for key := range backup.Values {
		if netTuneEditableKey(key) || key == netTuneKeyBuckets {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	for _, key := range keys {
		want := backup.Values[key]
		current, ok, err := netTuneRead(key)
		if err != nil || !ok || current == want {
			continue
		}
		if err := netTuneWrite(key, want); err != nil {
			result.Failed = netTuneAppendFailure(result.Failed, key, err)
			continue
		}
		result.Changed = append(result.Changed, netTuneChange{Key: key, From: current, To: want})
	}
	// 面板写的持久化文件删掉：重启后不再把调过的值加载回来
	for _, path := range []string{netTuneConfPath, netTuneModprobeConf, netTuneBBRModuleConf} {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			result.FileError = "删不掉 " + path + "：" + err.Error()
		}
	}
}

func init() {
	registerExtModule(newNetTuneExtModule())
}
