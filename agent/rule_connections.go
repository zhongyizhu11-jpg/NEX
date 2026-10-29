package main

import (
	"bufio"
	"bytes"
	"context"
	"io"
	"net"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

/*
规则的「连接」清单（面板 server/ruleConnectionsAgentTasks，2.2.237 起）：面板问「这条规则此刻
谁连着」，这里现场读一遍回给它。

	用户态转发（gost / realm / socat / nginx）的 TCP：/proc/net/tcp{,6} 里本地端口 = 规则端口、
	  状态 ESTABLISHED 的行，远端就是客户端；有 ss 的话再问一次 ss 补上每条连接的字节数。
	内核转发（iptables / nftables）和 UDP：连接不在 /proc/net/tcp 里，读 nf_conntrack 原始方向
	  dport = 规则端口的条目，bytes= 有就带上。

最多 limit 行（面板给 200），超过的只报总数。整个任务 8 秒封顶：这是排障时点一下的事，
不能让一台连接几十万条的机器扫半天。
*/

type ruleConnectionsTask struct {
	TaskID    string `json:"taskId"`
	RuleID    int    `json:"ruleId"`
	Port      int    `json:"port"`
	Protocol  string `json:"protocol"`
	DNAT      bool   `json:"dnat"`
	Limit     int    `json:"limit"`
	TimeoutMs int    `json:"timeoutMs"`
}

type ruleConnectionRow struct {
	Protocol string `json:"protocol"`
	Peer     string `json:"peer"`
	Local    string `json:"local"`
	BytesIn  *int64 `json:"bytesIn,omitempty"`
	BytesOut *int64 `json:"bytesOut,omitempty"`
	State    string `json:"state,omitempty"`
}

type ruleConnectionsResult struct {
	TaskID    string              `json:"taskId"`
	Rows      []ruleConnectionRow `json:"rows"`
	Total     int                 `json:"total"`
	Truncated bool                `json:"truncated"`
	Source    string              `json:"source"`
	Error     string              `json:"error,omitempty"`
}

const (
	ruleConnectionsDefaultLimit = 200
	ruleConnectionsMaxDuration  = 8 * time.Second
	ruleConnectionsScanMaxLines = 2_000_000
)

var ruleConnectionsInFlightMu sync.Mutex
var ruleConnectionsInFlight = map[string]bool{}
var ruleConnectionsSlots = make(chan struct{}, 2)

func handleRuleConnectionsTask(cfg Config, task ruleConnectionsTask) {
	if strings.TrimSpace(task.TaskID) == "" {
		return
	}
	ruleConnectionsInFlightMu.Lock()
	if ruleConnectionsInFlight[task.TaskID] {
		ruleConnectionsInFlightMu.Unlock()
		return
	}
	ruleConnectionsInFlight[task.TaskID] = true
	ruleConnectionsInFlightMu.Unlock()
	defer func() {
		ruleConnectionsInFlightMu.Lock()
		delete(ruleConnectionsInFlight, task.TaskID)
		ruleConnectionsInFlightMu.Unlock()
	}()
	ruleConnectionsSlots <- struct{}{}
	result := runRuleConnectionsTask(task)
	<-ruleConnectionsSlots
	if err := post(cfg, "/api/agent/rule-connections-result", map[string]any{"result": result}, &map[string]any{}); err != nil {
		if isTransientAgentCommError(err) {
			logAgentCommError("rule-connections-result", err)
		} else {
			logf("rule connections report failed task=%s: %v", task.TaskID, err)
		}
	}
}

func ruleConnectionsTimeout(task ruleConnectionsTask) time.Duration {
	timeout := time.Duration(task.TimeoutMs) * time.Millisecond
	if timeout <= 0 || timeout > ruleConnectionsMaxDuration {
		timeout = ruleConnectionsMaxDuration
	}
	return timeout
}

func runRuleConnectionsTask(task ruleConnectionsTask) ruleConnectionsResult {
	result := ruleConnectionsResult{TaskID: task.TaskID, Rows: []ruleConnectionRow{}}
	if task.Port <= 0 || task.Port > 65535 {
		result.Error = "端口不对"
		return result
	}
	limit := task.Limit
	if limit <= 0 || limit > 1000 {
		limit = ruleConnectionsDefaultLimit
	}
	ctx, cancel := context.WithTimeout(context.Background(), ruleConnectionsTimeout(task))
	defer cancel()
	protocol := strings.ToLower(strings.TrimSpace(task.Protocol))
	wantTCP := protocol == "" || protocol == "tcp" || protocol == "both"
	wantUDP := protocol == "udp" || protocol == "both"

	var rows []ruleConnectionRow
	sources := []string{}
	if wantTCP && !task.DNAT {
		tcpRows := procNetTCPConnections(task.Port)
		if len(tcpRows) > 0 {
			sources = append(sources, "proc")
			if counters := ssConnectionBytes(ctx, task.Port); len(counters) > 0 {
				sources = append(sources, "ss")
				for i := range tcpRows {
					if c, ok := counters[tcpRows[i].Peer]; ok {
						tcpRows[i].BytesIn, tcpRows[i].BytesOut = c.in, c.out
					}
				}
			}
		}
		rows = append(rows, tcpRows...)
	}
	if wantUDP || (wantTCP && task.DNAT) {
		protocols := map[string]bool{}
		if wantUDP {
			protocols["udp"] = true
		}
		if wantTCP && task.DNAT {
			protocols["tcp"] = true
		}
		ctRows := conntrackConnections(task.Port, protocols)
		if len(ctRows) > 0 {
			sources = append(sources, "conntrack")
		}
		rows = append(rows, ctRows...)
	}
	// 跑得多的排前面；没计数的按地址排，输出稳定。
	sort.SliceStable(rows, func(i, j int) bool {
		bi := rowBytes(rows[i])
		bj := rowBytes(rows[j])
		if bi != bj {
			return bi > bj
		}
		return rows[i].Peer < rows[j].Peer
	})
	result.Total = len(rows)
	if len(rows) > limit {
		rows = rows[:limit]
		result.Truncated = true
	}
	result.Rows = rows
	result.Source = strings.Join(sources, "+")
	if result.Source == "" {
		result.Source = "proc"
	}
	return result
}

func rowBytes(row ruleConnectionRow) int64 {
	var total int64
	if row.BytesIn != nil {
		total += *row.BytesIn
	}
	if row.BytesOut != nil {
		total += *row.BytesOut
	}
	return total
}

// procNetTCPConnections 读 /proc/net/tcp{,6}：本地端口 = port、ESTABLISHED 的行。回环对端不算客户端。
func procNetTCPConnections(port int) []ruleConnectionRow {
	var rows []ruleConnectionRow
	for _, path := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		f, err := os.Open(path)
		if err != nil {
			continue
		}
		rows = append(rows, parseProcNetTCPRows(f, port)...)
		_ = f.Close()
	}
	return rows
}

func parseProcNetTCPRows(r io.Reader, port int) []ruleConnectionRow {
	var rows []ruleConnectionRow
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	first := true
	for scanner.Scan() {
		if first {
			first = false
			continue
		}
		fields := strings.Fields(scanner.Text())
		if len(fields) < 4 || fields[3] != "01" {
			continue
		}
		localIP, localPort, ok := decodeProcNetAddr(fields[1])
		if !ok || localPort != port {
			continue
		}
		remoteIP, remotePort, ok := decodeProcNetAddr(fields[2])
		if !ok || remoteIP.IsLoopback() || remoteIP.IsUnspecified() {
			continue
		}
		rows = append(rows, ruleConnectionRow{
			Protocol: "tcp",
			Peer:     net.JoinHostPort(remoteIP.String(), strconv.Itoa(remotePort)),
			Local:    net.JoinHostPort(localIP.String(), strconv.Itoa(localPort)),
			State:    "ESTABLISHED",
		})
		if len(rows) >= ruleConnectionsDefaultLimit*5 {
			break
		}
	}
	return rows
}

type ssByteCounter struct{ in, out *int64 }

// ssConnectionBytes 问 ss 每条连接收发了多少字节：`ss -tinH state established ( sport = :P )`。
// 输出是两行一条（地址行 + 信息行），信息行里有 bytes_received / bytes_sent。没有 ss 就没有。
func ssConnectionBytes(ctx context.Context, port int) map[string]ssByteCounter {
	if _, err := exec.LookPath("ss"); err != nil {
		return nil
	}
	out, err := exec.CommandContext(ctx, "ss", "-tinH", "state", "established", "( sport = :"+strconv.Itoa(port)+" )").Output()
	if err != nil && len(bytes.TrimSpace(out)) == 0 {
		return nil
	}
	return parseSSByteCounters(string(out))
}

func parseSSByteCounters(text string) map[string]ssByteCounter {
	counters := map[string]ssByteCounter{}
	var peer string
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}
		// 地址行：Recv-Q Send-Q Local:Port Peer:Port（-H 去掉了表头，列数可能是 4 或 5）
		if !strings.HasPrefix(raw, " ") && !strings.HasPrefix(raw, "\t") {
			fields := strings.Fields(line)
			peer = ""
			if len(fields) >= 4 {
				peer = normalizeSSAddress(fields[len(fields)-1])
			}
			continue
		}
		if peer == "" {
			continue
		}
		counter := counters[peer]
		for _, token := range strings.Fields(line) {
			if value, ok := strings.CutPrefix(token, "bytes_received:"); ok {
				if n, err := strconv.ParseInt(value, 10, 64); err == nil {
					counter.in = &n
				}
			} else if value, ok := strings.CutPrefix(token, "bytes_sent:"); ok {
				if n, err := strconv.ParseInt(value, 10, 64); err == nil {
					counter.out = &n
				}
			}
		}
		counters[peer] = counter
	}
	return counters
}

// ss 把 v4-mapped 的地址写成 [::ffff:1.2.3.4]:port，和 /proc 解出来的 1.2.3.4:port 对不上，统一一下。
func normalizeSSAddress(value string) string {
	host, port, err := net.SplitHostPort(strings.TrimSpace(value))
	if err != nil {
		return strings.TrimSpace(value)
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return strings.TrimSpace(value)
	}
	if v4 := ip.To4(); v4 != nil {
		ip = v4
	}
	return net.JoinHostPort(ip.String(), port)
}

// conntrackConnections 读 nf_conntrack：原始方向 dport = port、协议对得上的条目。TCP 只要 ESTABLISHED。
func conntrackConnections(port int, protocols map[string]bool) []ruleConnectionRow {
	for _, path := range []string{"/proc/net/nf_conntrack", "/proc/net/ip_conntrack"} {
		f, err := os.Open(path)
		if err != nil {
			continue
		}
		rows := parseConntrackRows(f, port, protocols)
		_ = f.Close()
		return rows
	}
	return nil
}

func parseConntrackRows(r io.Reader, port int, protocols map[string]bool) []ruleConnectionRow {
	var rows []ruleConnectionRow
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 64*1024), conntrackScanBufferMax)
	lines := 0
	for scanner.Scan() {
		lines++
		if lines > ruleConnectionsScanMaxLines {
			break
		}
		line := scanner.Bytes()
		protocol, sourceIP, targetIP, sourcePort, targetPort, ok := conntrackOriginalTupleBytes(line)
		if !ok {
			continue
		}
		dport, err := strconv.Atoi(string(targetPort))
		if err != nil || dport != port || !protocols[string(protocol)] {
			continue
		}
		if string(protocol) == "tcp" && !bytes.Contains(line, conntrackEstablished) {
			continue
		}
		src := net.ParseIP(string(sourceIP))
		if src == nil || src.IsLoopback() || src.IsUnspecified() {
			continue
		}
		row := ruleConnectionRow{
			Protocol: string(protocol),
			Peer:     net.JoinHostPort(src.String(), string(sourcePort)),
			Local:    net.JoinHostPort(string(targetIP), strconv.Itoa(dport)),
		}
		if string(protocol) == "tcp" {
			row.State = "ESTABLISHED"
		}
		// bytes= 出现两次：先是原始方向（客户端发来的），再是回复方向。开了 nf_conntrack_acct 才有。
		if in, out, ok := conntrackLineBytes(line); ok {
			row.BytesIn, row.BytesOut = &in, &out
		}
		rows = append(rows, row)
		if len(rows) >= ruleConnectionsDefaultLimit*5 {
			break
		}
	}
	return rows
}

func conntrackLineBytes(line []byte) (int64, int64, bool) {
	var values []int64
	rest := line
	for len(values) < 2 {
		index := bytes.Index(rest, []byte("bytes="))
		if index < 0 {
			break
		}
		rest = rest[index+len("bytes="):]
		end := 0
		for end < len(rest) && rest[end] >= '0' && rest[end] <= '9' {
			end++
		}
		if end == 0 {
			break
		}
		n, err := strconv.ParseInt(string(rest[:end]), 10, 64)
		if err != nil {
			break
		}
		values = append(values, n)
		rest = rest[end:]
	}
	if len(values) < 2 {
		return 0, 0, false
	}
	return values[0], values[1], true
}
