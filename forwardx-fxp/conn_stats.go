package main

/*
逐跳连接监控（FXP 2.2.133 起，面板 2.3.451）：每条隧道连接在每一跳、每个阶段花了多久、成没成，
按分钟攒起来报给面板（/api/agent/fxp-conn-stats），面板留 7 天、能导出 CSV / JSON。

阶段：
  - pool      入口 / 中转从连接池拿到现成的下一跳连接（不用拨号，耗时记 0）
  - tcp       入口 / 中转拨下一跳的 TCP
  - handshake 入口 / 中转和下一跳的加密握手确认（从开始拨号算起，流水线握手不阻塞数据，但慢了说明下一跳慢）
  - target    出口拨目标
  - leg       单连接叠加：入口拨每一路（开局、晚到、中途补拨都算），耗时是拨号加报到；
              这一行还带着这一路实际送出（bytesUp）和收到（bytesDown）的字节数，via 是哪台中转
              （relay#主机 ID）或第几路并发（stream#N）。FXP 2.2.135 起。

每个（隧道, 规则, 角色, 阶段, 端点）一行：次数、失败次数、耗时总和 / 最大值、按 50 / 100 / 200 / 500 / 1000 ms
分档的个数、最近一次失败原因。一分钟报一次，报成功了才清零；面板挂了最多攒 10000 行，多了丢最旧的。
*/

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	connStatsReportPath     = "/api/agent/fxp-conn-stats"
	connStatsReportInterval = time.Minute
	connStatsMaxEntries     = 10000
	connStatsMaxBatch       = 500
)

// 分档上限（毫秒），最后一档是「超过 1000」。
var connStatsBuckets = [...]int64{50, 100, 200, 500, 1000}

type connStatsKey struct {
	panelURL string
	token    string
	tunnelID int
	ruleID   int
	role     string
	stage    string
	endpoint string
	via      string
}

type connStatsValue struct {
	Attempts  uint64    `json:"attempts"`
	Failures  uint64    `json:"failures"`
	SumMs     uint64    `json:"sumMs"`
	MaxMs     uint64    `json:"maxMs"`
	Buckets   [6]uint64 `json:"buckets"`
	LastError string    `json:"lastError,omitempty"`
	BytesUp   uint64    `json:"bytesUp,omitempty"`
	BytesDown uint64    `json:"bytesDown,omitempty"`
}

var connStats = struct {
	sync.Mutex
	entries map[connStatsKey]*connStatsValue
	once    sync.Once
}{entries: map[connStatsKey]*connStatsValue{}}

// connStatsEndpoint 把端点写成 "host:port"；拿不到就是 "-"。
func connStatsEndpoint(host string, port int) string {
	host = strings.TrimSpace(host)
	if host == "" {
		return "-"
	}
	if port <= 0 {
		return host
	}
	return net.JoinHostPort(host, strconv.Itoa(port))
}

// connStatsErrorText 把错误压成一句短话，去掉每次都不一样的本地端口之类，便于聚合。
func connStatsErrorText(err error) string {
	if err == nil {
		return ""
	}
	var netErr net.Error
	switch {
	case errors.As(err, &netErr) && netErr.Timeout():
		return "timeout"
	case strings.Contains(err.Error(), "connection refused"):
		return "connection refused"
	case strings.Contains(err.Error(), "no route to host"):
		return "no route to host"
	case strings.Contains(err.Error(), "network is unreachable"):
		return "network unreachable"
	case strings.Contains(err.Error(), "connection reset"):
		return "connection reset"
	case strings.Contains(err.Error(), "no such host"):
		return "dns: no such host"
	}
	text := err.Error()
	if len(text) > 160 {
		text = text[:160]
	}
	return text
}

// recordConnStage 记一次阶段结果。cfg 里没有面板地址或 token（本地测试、老配置）就不记。
func recordConnStage(cfg config, tunnelID, ruleID int, role, stage, endpoint string, elapsed time.Duration, err error) {
	key, ok := connStatsKeyFor(cfg, tunnelID, ruleID, role, stage, endpoint, "")
	if !ok {
		return
	}
	recordConnStageKey(key, elapsed, err)
}

func connStatsKeyFor(cfg config, tunnelID, ruleID int, role, stage, endpoint, via string) (connStatsKey, bool) {
	panelURL := strings.TrimRight(strings.TrimSpace(cfg.PanelURL), "/")
	token := strings.TrimSpace(cfg.Token)
	if panelURL == "" || token == "" || tunnelID <= 0 {
		return connStatsKey{}, false
	}
	return connStatsKey{panelURL: panelURL, token: token, tunnelID: tunnelID, ruleID: ruleID, role: role, stage: stage, endpoint: endpoint, via: via}, true
}

func recordConnStageKey(key connStatsKey, elapsed time.Duration, err error) {
	ms := elapsed.Milliseconds()
	if ms < 0 {
		ms = 0
	}
	connStats.Lock()
	value := connStats.entries[key]
	if value == nil {
		if len(connStats.entries) >= connStatsMaxEntries {
			connStats.Unlock()
			return
		}
		value = &connStatsValue{}
		connStats.entries[key] = value
	}
	value.Attempts++
	if err != nil {
		value.Failures++
		value.LastError = connStatsErrorText(err)
	} else {
		value.SumMs += uint64(ms)
		if uint64(ms) > value.MaxMs {
			value.MaxMs = uint64(ms)
		}
		bucket := len(connStatsBuckets)
		for i, limit := range connStatsBuckets {
			if ms < limit {
				bucket = i
				break
			}
		}
		value.Buckets[bucket]++
	}
	connStats.Unlock()
	connStats.once.Do(func() { go connStatsReportLoop() })
}

type connStatsReportGroup struct {
	panelURL string
	token    string
}

type connStatsReportRow struct {
	TunnelID int    `json:"tunnelId"`
	RuleID   int    `json:"ruleId,omitempty"`
	Role     string `json:"role"`
	Stage    string `json:"stage"`
	Endpoint string `json:"endpoint"`
	Via      string `json:"via,omitempty"`
	connStatsValue
}

// takeConnStats 取出现有的计数并清空；报失败时用 restoreConnStats 放回去。
func takeConnStats() map[connStatsKey]*connStatsValue {
	flushMultipathLegTraffic()
	connStats.Lock()
	defer connStats.Unlock()
	taken := connStats.entries
	connStats.entries = map[connStatsKey]*connStatsValue{}
	return taken
}

func restoreConnStats(taken map[connStatsKey]*connStatsValue) {
	connStats.Lock()
	defer connStats.Unlock()
	for key, value := range taken {
		current := connStats.entries[key]
		if current == nil {
			if len(connStats.entries) >= connStatsMaxEntries {
				continue
			}
			connStats.entries[key] = value
			continue
		}
		current.Attempts += value.Attempts
		current.Failures += value.Failures
		current.SumMs += value.SumMs
		if value.MaxMs > current.MaxMs {
			current.MaxMs = value.MaxMs
		}
		for i := range current.Buckets {
			current.Buckets[i] += value.Buckets[i]
		}
		if current.LastError == "" {
			current.LastError = value.LastError
		}
		current.BytesUp += value.BytesUp
		current.BytesDown += value.BytesDown
	}
}

func connStatsRows(taken map[connStatsKey]*connStatsValue) map[connStatsReportGroup][]connStatsReportRow {
	groups := map[connStatsReportGroup][]connStatsReportRow{}
	for key, value := range taken {
		group := connStatsReportGroup{panelURL: key.panelURL, token: key.token}
		groups[group] = append(groups[group], connStatsReportRow{
			TunnelID: key.tunnelID, RuleID: key.ruleID, Role: key.role, Stage: key.stage, Endpoint: key.endpoint, Via: key.via,
			connStatsValue: *value,
		})
	}
	for group := range groups {
		rows := groups[group]
		sort.Slice(rows, func(i, j int) bool {
			a, b := rows[i], rows[j]
			if a.TunnelID != b.TunnelID {
				return a.TunnelID < b.TunnelID
			}
			if a.Stage != b.Stage {
				return a.Stage < b.Stage
			}
			if a.Endpoint != b.Endpoint {
				return a.Endpoint < b.Endpoint
			}
			return a.Via < b.Via
		})
	}
	return groups
}

func connStatsReportLoop() {
	ticker := time.NewTicker(connStatsReportInterval)
	defer ticker.Stop()
	for range ticker.C {
		reportConnStats()
	}
}

func reportConnStats() {
	taken := takeConnStats()
	if len(taken) == 0 {
		return
	}
	failed := map[connStatsKey]*connStatsValue{}
	for group, rows := range connStatsRows(taken) {
		for start := 0; start < len(rows); start += connStatsMaxBatch {
			end := start + connStatsMaxBatch
			if end > len(rows) {
				end = len(rows)
			}
			if err := postConnStats(group, rows[start:end]); err != nil {
				logTrafficDiagnostic("conn-stats", "connection stats report failed: %s", safeTrafficReportError(err, group.token))
				for _, row := range rows[start:end] {
					key := connStatsKey{panelURL: group.panelURL, token: group.token, tunnelID: row.TunnelID, ruleID: row.RuleID, role: row.Role, stage: row.Stage, endpoint: row.Endpoint, via: row.Via}
					value := row.connStatsValue
					failed[key] = &value
				}
			}
		}
	}
	if len(failed) > 0 {
		restoreConnStats(failed)
	}
}

func postConnStats(group connStatsReportGroup, rows []connStatsReportRow) error {
	payload := map[string]any{
		"rows":       rows,
		"bucketsMs":  connStatsBuckets,
		"reportedAt": time.Now().UnixMilli(),
	}
	env, err := encryptEnvelope(payload, group.token)
	if err != nil {
		return err
	}
	body, _ := json.Marshal(env)
	resp, err := postFXPEncryptedPanelRequest(trafficHTTPClient, group.panelURL, group.token, connStatsReportPath, body)
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("panel returned %s", resp.Status)
	}
	return nil
}
