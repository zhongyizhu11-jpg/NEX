package main

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

/*
数据面运行时指标（FXP 2.2.150 起，面板 /metrics 导出为 nex_fxp_*）。

这次性能专项修的几类问题 —— 连接风暴下句柄堆积、UDP 队列挤掉 / 过期丢包、会话被拒、连接池没命中现拨 ——
以前在线上都看不见，只能等用户反馈。现在每个 FXP 进程按（面板, 令牌, 隧道, 规则, 角色, 名字）攒计数，
一分钟报一次 /api/agent/fxp-runtime-metrics；面板留 7 天，/metrics 导出最近 5 分钟的事件数和此刻的量。

两类：
  counter  一分钟里发生了几次（报成功了清零，报失败放回去下次一起报）：
             udp_queue_drop        发送 / 回程队列满了挤掉最老的包
             udp_expired_drop      包在队列里等了超过 75 ms 还有更新的包，丢掉
             udp_session_rejected  新会话被拒（规则连接闸、会话数 / 每 IP 上限、会话号冲突、目标冲突）
             udp_session_reclaimed 会话太多时按压力回收了最闲的
             pool_hit / pool_miss  入口 / 中转取下一跳连接：池里有现成的 / 没有、现拨
             peer_gone             一侧没说再见就断了，立刻收掉的会话数（进程级，没有隧道标签）
             half_close_reaped     干净半关闭后等满 fxpHalfCloseMaxWait 收掉的会话数（进程级）
             linger_expired        写侧 closed 后等满 30 秒 linger 才收掉的会话数（进程级）
  gauge    此刻的量，报的是取数那一刻的值：
             udp_sessions          这个 UDP 监听上活着的会话数
             tcp_sessions          这个角色上正在转发的 TCP 会话数

热路径代价：这些事件本身都是异常 / 边界事件（丢包、拒绝、拨号），不是每个包都走，所以用一把锁 + map 就够了；
gauge 的 tcp_sessions 每条连接加减一次。
*/

const (
	fxpRuntimeMetricsReportPath     = "/api/agent/fxp-runtime-metrics"
	fxpRuntimeMetricsReportInterval = time.Minute
	fxpRuntimeMetricsMaxKeys        = 4000
)

type fxpRuntimeMetricKey struct {
	panelURL string
	token    string
	tunnelID int
	ruleID   int
	role     string
	name     string
}

type fxpRuntimeMetricRow struct {
	TunnelID int    `json:"tunnelId"`
	RuleID   int    `json:"ruleId,omitempty"`
	Role     string `json:"role"`
	Name     string `json:"name"`
	Kind     string `json:"kind"`
	Value    int64  `json:"value"`
}

type fxpRuntimeMetricsGroup struct {
	panelURL string
	token    string
}

var fxpRuntimeMetrics = struct {
	sync.Mutex
	counters map[fxpRuntimeMetricKey]int64
	gauges   map[fxpRuntimeMetricKey]int64
	// readers：取数那一刻去问的 gauge（会话表长度），注销后不再报。
	readers map[fxpRuntimeMetricKey][]*fxpRuntimeGaugeReader
	// process：没有配置可挂的进程级计数（waitBidirectional 里拿不到 cfg），报给每个见过的面板。
	process map[string]int64
	groups  map[fxpRuntimeMetricsGroup]struct{}
	once    sync.Once
}{
	counters: map[fxpRuntimeMetricKey]int64{},
	gauges:   map[fxpRuntimeMetricKey]int64{},
	readers:  map[fxpRuntimeMetricKey][]*fxpRuntimeGaugeReader{},
	process:  map[string]int64{},
	groups:   map[fxpRuntimeMetricsGroup]struct{}{},
}

type fxpRuntimeGaugeReader struct {
	read func() int64
}

func fxpRuntimeMetricKeyFor(cfg config, name string) (fxpRuntimeMetricKey, bool) {
	panelURL := strings.TrimRight(strings.TrimSpace(cfg.PanelURL), "/")
	token := strings.TrimSpace(cfg.Token)
	if panelURL == "" || token == "" || cfg.TunnelID <= 0 || name == "" {
		return fxpRuntimeMetricKey{}, false
	}
	role := strings.ToLower(strings.TrimSpace(cfg.Role))
	if role == "" {
		role = "entry"
	}
	return fxpRuntimeMetricKey{panelURL: panelURL, token: token, tunnelID: cfg.TunnelID, ruleID: cfg.RuleID, role: role, name: name}, true
}

func fxpRuntimeMetricsStart() {
	fxpRuntimeMetrics.once.Do(func() { go fxpRuntimeMetricsReportLoop() })
}

// fxpMetricAdd 给这条规则记 n 次 name 事件。没有面板配置（测试、离线跑）时什么都不做。
func fxpMetricAdd(cfg config, name string, n int64) {
	key, ok := fxpRuntimeMetricKeyFor(cfg, name)
	if !ok || n <= 0 {
		return
	}
	fxpRuntimeMetrics.Lock()
	if _, known := fxpRuntimeMetrics.counters[key]; !known && len(fxpRuntimeMetrics.counters) >= fxpRuntimeMetricsMaxKeys {
		fxpRuntimeMetrics.Unlock()
		return
	}
	fxpRuntimeMetrics.counters[key] += n
	fxpRuntimeMetrics.groups[fxpRuntimeMetricsGroup{panelURL: key.panelURL, token: key.token}] = struct{}{}
	fxpRuntimeMetrics.Unlock()
	fxpRuntimeMetricsStart()
}

// fxpMetricAddProcess 记一次进程级事件（拿不到 cfg 的地方），报给每个见过的面板。
func fxpMetricAddProcess(name string) {
	if name == "" {
		return
	}
	fxpRuntimeMetrics.Lock()
	fxpRuntimeMetrics.process[name]++
	fxpRuntimeMetrics.Unlock()
}

// fxpMetricGaugeDelta 给一个由加减维护的 gauge（tcp_sessions）加 delta。
func fxpMetricGaugeDelta(cfg config, name string, delta int64) {
	key, ok := fxpRuntimeMetricKeyFor(cfg, name)
	if !ok || delta == 0 {
		return
	}
	fxpRuntimeMetrics.Lock()
	next := fxpRuntimeMetrics.gauges[key] + delta
	if next < 0 {
		next = 0
	}
	fxpRuntimeMetrics.gauges[key] = next
	fxpRuntimeMetrics.groups[fxpRuntimeMetricsGroup{panelURL: key.panelURL, token: key.token}] = struct{}{}
	fxpRuntimeMetrics.Unlock()
	fxpRuntimeMetricsStart()
}

// fxpMetricGauge 登记一个取数时去问的 gauge（会话表长度）。返回注销函数，监听结束时调。
func fxpMetricGauge(cfg config, name string, read func() int64) func() {
	key, ok := fxpRuntimeMetricKeyFor(cfg, name)
	if !ok || read == nil {
		return func() {}
	}
	reader := &fxpRuntimeGaugeReader{read: read}
	fxpRuntimeMetrics.Lock()
	fxpRuntimeMetrics.readers[key] = append(fxpRuntimeMetrics.readers[key], reader)
	fxpRuntimeMetrics.groups[fxpRuntimeMetricsGroup{panelURL: key.panelURL, token: key.token}] = struct{}{}
	fxpRuntimeMetrics.Unlock()
	fxpRuntimeMetricsStart()
	var once sync.Once
	return func() {
		once.Do(func() {
			fxpRuntimeMetrics.Lock()
			defer fxpRuntimeMetrics.Unlock()
			list := fxpRuntimeMetrics.readers[key]
			for i, item := range list {
				if item == reader {
					list = append(list[:i], list[i+1:]...)
					break
				}
			}
			if len(list) == 0 {
				delete(fxpRuntimeMetrics.readers, key)
			} else {
				fxpRuntimeMetrics.readers[key] = list
			}
		})
	}
}

// fxpRuntimeMetricsSnapshot 取出这一分钟的计数（清零）和此刻的 gauge，按面板分组。counters 返回给调用方，报失败时放回。
func fxpRuntimeMetricsSnapshot() (map[fxpRuntimeMetricsGroup][]fxpRuntimeMetricRow, map[fxpRuntimeMetricKey]int64, map[string]int64) {
	fxpRuntimeMetrics.Lock()
	counters := fxpRuntimeMetrics.counters
	fxpRuntimeMetrics.counters = map[fxpRuntimeMetricKey]int64{}
	process := fxpRuntimeMetrics.process
	fxpRuntimeMetrics.process = map[string]int64{}
	gauges := make(map[fxpRuntimeMetricKey]int64, len(fxpRuntimeMetrics.gauges)+len(fxpRuntimeMetrics.readers))
	for key, value := range fxpRuntimeMetrics.gauges {
		gauges[key] = value
	}
	readers := make(map[fxpRuntimeMetricKey][]*fxpRuntimeGaugeReader, len(fxpRuntimeMetrics.readers))
	for key, list := range fxpRuntimeMetrics.readers {
		readers[key] = append([]*fxpRuntimeGaugeReader(nil), list...)
	}
	groups := make([]fxpRuntimeMetricsGroup, 0, len(fxpRuntimeMetrics.groups))
	for group := range fxpRuntimeMetrics.groups {
		groups = append(groups, group)
	}
	fxpRuntimeMetrics.Unlock()

	// gauge 的读函数在锁外调（它们要拿会话表自己的锁）。
	for key, list := range readers {
		var total int64
		for _, reader := range list {
			total += reader.read()
		}
		gauges[key] += total
	}
	rows := map[fxpRuntimeMetricsGroup][]fxpRuntimeMetricRow{}
	for key, value := range counters {
		group := fxpRuntimeMetricsGroup{panelURL: key.panelURL, token: key.token}
		rows[group] = append(rows[group], fxpRuntimeMetricRow{TunnelID: key.tunnelID, RuleID: key.ruleID, Role: key.role, Name: key.name, Kind: "counter", Value: value})
	}
	for key, value := range gauges {
		group := fxpRuntimeMetricsGroup{panelURL: key.panelURL, token: key.token}
		rows[group] = append(rows[group], fxpRuntimeMetricRow{TunnelID: key.tunnelID, RuleID: key.ruleID, Role: key.role, Name: key.name, Kind: "gauge", Value: value})
	}
	if len(process) > 0 {
		for _, group := range groups {
			for name, value := range process {
				rows[group] = append(rows[group], fxpRuntimeMetricRow{TunnelID: 0, Role: "process", Name: name, Kind: "counter", Value: value})
			}
		}
	}
	for group := range rows {
		list := rows[group]
		sort.Slice(list, func(i, j int) bool {
			a, b := list[i], list[j]
			if a.TunnelID != b.TunnelID {
				return a.TunnelID < b.TunnelID
			}
			if a.RuleID != b.RuleID {
				return a.RuleID < b.RuleID
			}
			if a.Role != b.Role {
				return a.Role < b.Role
			}
			return a.Name < b.Name
		})
		rows[group] = list
	}
	return rows, counters, process
}

// fxpRuntimeMetricsRestore 把报失败那一分钟的计数加回去。
func fxpRuntimeMetricsRestore(counters map[fxpRuntimeMetricKey]int64, process map[string]int64) {
	fxpRuntimeMetrics.Lock()
	for key, value := range counters {
		fxpRuntimeMetrics.counters[key] += value
	}
	for name, value := range process {
		fxpRuntimeMetrics.process[name] += value
	}
	fxpRuntimeMetrics.Unlock()
}

func fxpRuntimeMetricsReportLoop() {
	ticker := time.NewTicker(fxpRuntimeMetricsReportInterval)
	defer ticker.Stop()
	for range ticker.C {
		reportFXPRuntimeMetrics()
	}
}

func reportFXPRuntimeMetrics() {
	rows, counters, process := fxpRuntimeMetricsSnapshot()
	if len(rows) == 0 {
		return
	}
	failedAny := false
	for group, list := range rows {
		if len(list) == 0 {
			continue
		}
		if err := postFXPRuntimeMetrics(group, list); err != nil {
			failedAny = true
			logTrafficDiagnostic("runtime-metrics", "runtime metrics report failed: %s", safeTrafficReportError(err, group.token))
		}
	}
	if failedAny {
		// 只有一个面板时直接放回；几个面板里有的成了有的没成，重复报的只是一分钟的计数，面板侧按分钟去重不了也只多一行。
		fxpRuntimeMetricsRestore(counters, process)
	}
}

func postFXPRuntimeMetrics(group fxpRuntimeMetricsGroup, rows []fxpRuntimeMetricRow) error {
	payload := map[string]any{
		"rows":       rows,
		"reportedAt": time.Now().UnixMilli(),
	}
	env, err := encryptEnvelope(payload, group.token)
	if err != nil {
		return err
	}
	body, _ := json.Marshal(env)
	resp, err := postFXPEncryptedPanelRequest(trafficHTTPClient, group.panelURL, group.token, fxpRuntimeMetricsReportPath, body)
	if err != nil {
		return err
	}
	if resp.StatusCode == 404 {
		// 老面板没有这个接口：当成报成功，别把计数攒成山。
		return nil
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("panel returned %s", resp.Status)
	}
	return nil
}
