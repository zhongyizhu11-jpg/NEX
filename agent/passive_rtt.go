package main

import (
	"bufio"
	"bytes"
	"context"
	"net"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

/*
真实流量量延迟（2.2.260 起）：这台机器上正在往某个目标转发的 TCP 连接，内核一直在按每个数据包的确认算 RTT
（平滑值 srtt、波动 rttvar、最小值 minrtt）、记重传。用户嫌「延迟抖动判断不准」—— 以前只靠每 2 秒建一次连接
量：握手包丢了系统 1 秒后重发，这一次就被记成 1000ms 延迟，抖动一下子被拉高；目标机忙、本机 CPU 忙也算进去；
频繁建连还可能被目标当扫描挡掉。

这里用 ss -tin 一次读出到这些目标的连接（不新建连接）。只认最近 5 秒内还在收发的连接（闲着的连接 RTT 是旧的）。
没有 ss（个别精简系统）或到这个目标没有活跃连接时，退回主动探测。
*/

const (
	passiveRTTScanEvery  = 2 * time.Second
	passiveRTTFresh      = 5 * time.Second
	passiveRTTRecentMs   = 5000
	passiveRTTMaxTargets = 64
)

// passiveTargetStats：到一个目标（ip:port）的活跃连接这一刻的情况。
type passiveTargetStats struct {
	conns  int
	srttMs float64 // 各连接延迟（平滑 RTT 减一个波动、不低于最小 RTT）的中位数
	varMs  float64 // 各连接 RTT 波动（rttvar）的中位数
	minMs  float64 // 各连接最小 RTT 里最小的（这条路本身的延迟）
	// 这两次扫描之间的重传 / 发出的包（同一条连接前后相减，新连接只算之后的）
	retransDelta uint64
	segsDelta    uint64
	at           time.Time
}

type passiveConnCounters struct {
	segsOut uint64
	retrans uint64
}

type passiveRTTScanner struct {
	mu       sync.Mutex
	run      func(ctx context.Context, args []string) ([]byte, error)
	previous map[string]passiveConnCounters // 「目标|本地地址」→ 上一次的计数
	disabled bool
}

func newPassiveRTTScanner() *passiveRTTScanner {
	return &passiveRTTScanner{
		previous: map[string]passiveConnCounters{},
		run: func(ctx context.Context, args []string) ([]byte, error) {
			path, err := exec.LookPath("ss")
			if err != nil {
				return nil, err
			}
			return exec.CommandContext(ctx, path, args...).Output()
		},
	}
}

// normalizePassiveTarget 统一成 net.JoinHostPort 的写法；IPv4 映射的 IPv6 还原成 IPv4。不是 IP 的（域名）返回空。
func normalizePassiveTarget(hostPort string) string {
	host, port, err := net.SplitHostPort(strings.TrimSpace(hostPort))
	if err != nil {
		return ""
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	if ip == nil {
		return ""
	}
	if v4 := ip.To4(); v4 != nil {
		ip = v4
	}
	return net.JoinHostPort(ip.String(), port)
}

// scan 读到这些目标的活跃连接。targets 是 net.JoinHostPort 写法；返回按同样的键。
func (s *passiveRTTScanner) scan(targets []string, now time.Time) map[string]passiveTargetStats {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.disabled || len(targets) == 0 {
		return nil
	}
	wanted := map[string]bool{}
	filter := []string{}
	for _, target := range targets {
		key := normalizePassiveTarget(target)
		if key == "" || wanted[key] {
			continue
		}
		wanted[key] = true
		if len(filter) > 0 {
			filter = append(filter, "or")
		}
		filter = append(filter, "dst", key)
		if len(wanted) >= passiveRTTMaxTargets {
			break
		}
	}
	if len(wanted) == 0 {
		return nil
	}
	args := append([]string{"-tinH", "state", "established", "("}, filter...)
	args = append(args, ")")
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	output, err := s.run(ctx, args)
	if err != nil {
		if _, lookErr := exec.LookPath("ss"); lookErr != nil {
			// 没有 ss：以后不再试，全走主动探测
			s.disabled = true
		}
		return nil
	}
	conns := parseSSConnections(output)
	type acc struct {
		srtt, vars    []float64
		min           float64
		retrans, segs uint64
	}
	byTarget := map[string]*acc{}
	seen := map[string]bool{}
	for _, conn := range conns {
		key := normalizePassiveTarget(conn.peer)
		if !wanted[key] {
			continue
		}
		counterKey := key + "|" + conn.local
		seen[counterKey] = true
		if previous, ok := s.previous[counterKey]; ok && conn.segsOut >= previous.segsOut && conn.retrans >= previous.retrans {
			entry := byTarget[key]
			if entry == nil {
				entry = &acc{}
				byTarget[key] = entry
			}
			entry.segs += conn.segsOut - previous.segsOut
			entry.retrans += conn.retrans - previous.retrans
		}
		s.previous[counterKey] = passiveConnCounters{segsOut: conn.segsOut, retrans: conn.retrans}
		if conn.srttMs <= 0 || conn.idleMs > passiveRTTRecentMs {
			continue
		}
		entry := byTarget[key]
		if entry == nil {
			entry = &acc{}
			byTarget[key] = entry
		}
		/*
			延迟用「平滑 RTT 减一个波动、不低于这条连接的最小 RTT」：请求 / 响应式的流量，内核的平滑 RTT 会把对方的延迟
			确认、处理请求的时间算进去（实测 0.15ms 的路，平滑值 7ms）。减掉一个波动大致去掉这部分；路真的变慢了
			平滑值整体抬高，照样看得出来。
		*/
		effective := conn.srttMs
		if conn.minRttMs > 0 {
			effective = conn.srttMs - conn.varMs
			if effective < conn.minRttMs {
				effective = conn.minRttMs
			}
		}
		entry.srtt = append(entry.srtt, effective)
		entry.vars = append(entry.vars, conn.varMs)
		if conn.minRttMs > 0 && (entry.min == 0 || conn.minRttMs < entry.min) {
			entry.min = conn.minRttMs
		}
	}
	for key := range s.previous {
		if !seen[key] {
			delete(s.previous, key)
		}
	}
	out := map[string]passiveTargetStats{}
	for key, entry := range byTarget {
		stats := passiveTargetStats{conns: len(entry.srtt), retransDelta: entry.retrans, segsDelta: entry.segs, at: now}
		if len(entry.srtt) > 0 {
			stats.srttMs = medianFloat(entry.srtt)
			stats.varMs = medianFloat(entry.vars)
			stats.minMs = entry.min
		}
		out[key] = stats
	}
	return out
}

type ssConnection struct {
	local    string
	peer     string
	srttMs   float64
	varMs    float64
	minRttMs float64
	idleMs   float64 // 最近一次收到确认 / 数据到现在多久
	segsOut  uint64
	retrans  uint64
}

// parseSSConnections 解析 ss -tinH state established 的输出：一行地址（Recv-Q Send-Q 本地 对端），下一行（缩进）是 -i 的信息。
func parseSSConnections(output []byte) []ssConnection {
	out := []ssConnection{}
	scanner := bufio.NewScanner(bytes.NewReader(output))
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	var current *ssConnection
	for scanner.Scan() {
		line := scanner.Text()
		if strings.TrimSpace(line) == "" {
			continue
		}
		if line[0] != ' ' && line[0] != '\t' {
			fields := strings.Fields(line)
			if len(fields) < 4 {
				current = nil
				continue
			}
			out = append(out, ssConnection{local: fields[2], peer: fields[3], idleMs: -1})
			current = &out[len(out)-1]
			continue
		}
		if current == nil {
			continue
		}
		lastAck, lastRcv := -1.0, -1.0
		for _, token := range strings.Fields(line) {
			name, value, ok := strings.Cut(token, ":")
			if !ok {
				continue
			}
			switch name {
			case "rtt":
				srtt, variance, _ := strings.Cut(value, "/")
				current.srttMs, _ = strconv.ParseFloat(srtt, 64)
				current.varMs, _ = strconv.ParseFloat(variance, 64)
			case "minrtt":
				current.minRttMs, _ = strconv.ParseFloat(value, 64)
			case "lastack":
				lastAck, _ = strconv.ParseFloat(value, 64)
			case "lastrcv":
				lastRcv, _ = strconv.ParseFloat(value, 64)
			case "segs_out":
				current.segsOut, _ = strconv.ParseUint(value, 10, 64)
			case "retrans":
				// retrans:<现在没确认的>/<一共>
				_, total, found := strings.Cut(value, "/")
				if found {
					current.retrans, _ = strconv.ParseUint(total, 10, 64)
				}
			}
		}
		switch {
		case lastAck >= 0 && lastRcv >= 0:
			current.idleMs = minFloat(lastAck, lastRcv)
		case lastAck >= 0:
			current.idleMs = lastAck
		case lastRcv >= 0:
			current.idleMs = lastRcv
		default:
			current.idleMs = passiveRTTRecentMs + 1
		}
		current = nil
	}
	return out
}

func medianFloat(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	sorted := append([]float64(nil), values...)
	sort.Float64s(sorted)
	middle := len(sorted) / 2
	if len(sorted)%2 == 0 {
		return (sorted[middle-1] + sorted[middle]) / 2
	}
	return sorted[middle]
}

func minFloat(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}
