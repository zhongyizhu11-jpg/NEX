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

指令：{"runs": [{"id": "...", "apply": true|false}]}，面板每轮重发，直到收到对应 id 的结果。
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
	netTuneProcRoot     = "/proc/sys"
	netTuneConfPath     = "/etc/sysctl.d/99-forwardx-network.conf"
	netTuneHashsizePath = "/sys/module/nf_conntrack/parameters/hashsize"
	netTuneModprobeConf = "/etc/modprobe.d/99-forwardx-conntrack.conf"
	// netTuneLoadBBR 尝试加载 tcp_bbr 模块（测试里换掉）。
	netTuneLoadBBR = func() {
		_, _ = commandOutputWithTimeout(5*time.Second, "modprobe", "tcp_bbr")
	}
)

type netTuneRuleKind int

const (
	// 数值至少要到 want；三元组（tcp_rmem 这类）只看、只动最后一个字段。
	netTuneAtLeast netTuneRuleKind = iota
	// 数值至多 want。
	netTuneAtMost
	// 这几位要置上（按位或，保留已有的位）。
	netTuneBitsSet
	// 必须等于 want。
	netTuneEquals
)

type netTuneRule struct {
	key  string
	kind netTuneRuleKind
	want int64
}

// 和安装脚本 apply_network_tuning 的顺序、取值一一对应（改一边记得改另一边，shared/netTune.ts 也是）。
var netTuneRules = []netTuneRule{
	{"net.ipv4.ip_forward", netTuneEquals, 1},
	{"net.core.rmem_max", netTuneAtLeast, 67108864},
	{"net.core.wmem_max", netTuneAtLeast, 67108864},
	{"net.ipv4.tcp_rmem", netTuneAtLeast, 67108864},
	{"net.ipv4.tcp_wmem", netTuneAtLeast, 67108864},
	{"net.netfilter.nf_conntrack_max", netTuneAtLeast, 1048576},
	{"net.netfilter.nf_conntrack_tcp_be_liberal", netTuneAtLeast, 1},
	{"net.ipv4.tcp_no_metrics_save", netTuneAtLeast, 1},
	{"net.core.rmem_default", netTuneAtLeast, 1048576},
	{"net.core.wmem_default", netTuneAtLeast, 1048576},
	{"net.ipv4.udp_rmem_min", netTuneAtLeast, 16384},
	{"net.ipv4.udp_wmem_min", netTuneAtLeast, 16384},
	{"net.core.netdev_max_backlog", netTuneAtLeast, 16384},
	{"net.core.somaxconn", netTuneAtLeast, 4096},
	{"net.ipv4.tcp_max_syn_backlog", netTuneAtLeast, 8192},
	{"net.ipv4.tcp_mtu_probing", netTuneAtLeast, 1},
	{"net.ipv4.tcp_notsent_lowat", netTuneAtMost, 131072},
	{"net.ipv4.tcp_slow_start_after_idle", netTuneAtMost, 0},
	{"net.ipv4.tcp_fastopen", netTuneBitsSet, 3},
	{"net.ipv4.tcp_tw_reuse", netTuneEquals, 1},
}

const (
	netTuneKeyCC         = "net.ipv4.tcp_congestion_control"
	netTuneKeyQdisc      = "net.core.default_qdisc"
	netTuneKeyAvailCC    = "net.ipv4.tcp_available_congestion_control"
	netTuneKeyBuckets    = "net.netfilter.nf_conntrack_buckets"
	netTuneKeyCount      = "net.netfilter.nf_conntrack_count"
	netTuneKeyConntrack  = "net.netfilter.nf_conntrack_max"
	netTuneKeyOSRelease  = "kernel.osrelease"
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
		ID    string `json:"id"`
		Apply bool   `json:"apply"`
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
}

func newNetTuneExtModule() *netTuneExtModule {
	return &netTuneExtModule{results: map[string]*netTuneResult{}}
}

func (m *netTuneExtModule) Name() string { return "nettune" }

func (m *netTuneExtModule) Report(cfg Config) any {
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
		go func(id string) {
			done := netTuneRun(apply)
			m.mu.Lock()
			defer m.mu.Unlock()
			done.ID = id
			done.Apply = apply
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
		if err != nil || last >= rule.want {
			return "", false
		}
		fields[len(fields)-1] = strconv.FormatInt(rule.want, 10)
		return strings.Join(fields, " "), true
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
func netTuneRun(apply bool) netTuneResult {
	result := netTuneResult{}
	if runtime.GOOS != "linux" {
		result.Error = "只有 Linux 主机能读写内核网络参数"
		return result
	}
	if apply {
		netTuneApply(&result)
	}
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

func netTuneApply(result *netTuneResult) {
	// 写进配置文件的：所有规则里的键（调过的写新值，本来就更好的写原值 —— 和安装脚本一样，
	// 用当前生效值重写，不会把别人调过的值丢掉）。
	persisted := make([][2]string, 0, len(netTuneRules)+3)
	for _, rule := range netTuneRules {
		current, ok, err := netTuneRead(rule.key)
		if err != nil {
			result.Failed = netTuneAppendFailure(result.Failed, rule.key, err)
			continue
		}
		if !ok {
			continue
		}
		if want, change := netTuneDesired(rule, current); change {
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

func init() {
	registerExtModule(newNetTuneExtModule())
}
