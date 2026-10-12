package main

// 在线 IP（扩展模块 "online"，面板那头见 server/ops/onlineIpsAgent.ts）。
//
// 面板在指令里告诉 Agent 盯哪些端口（端口 → 规则 / 入站），Agent 每一轮把这些端口上
// 「此刻连着的远端 IP、每个 IP 几条连接、从什么时候开始连着」报上去。Agent 自己不需要
// 知道端口属于谁 —— 端口到用户的对应在面板算，这样换了归属不用等 Agent。
//
// 数据来源：
//   - 用户态转发（gost / realm / 代理入站）的 TCP：/proc/net/tcp{,6} 里本地端口命中、
//     状态 ESTABLISHED（01）的行，远端地址就是客户端。
//   - iptables / nftables 这类 DNAT 转发：连接根本不落在本机 socket 上，/proc/net/tcp 里没有，
//     只能看 conntrack —— 原始方向的 dport 是入口端口，src 是客户端。
//   - UDP：没有连接状态，同样看 conntrack（读不到就只报 TCP）。
//
// 读不到的来源静默跳过：少几个 IP 比整轮失败好。

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type onlineWatchPort struct {
	Port      int    `json:"port"`
	Proto     string `json:"proto"` // tcp | udp | both
	RuleID    int    `json:"ruleId,omitempty"`
	InboundID int    `json:"inboundId,omitempty"`
	// DNAT 为真表示 iptables / nftables 转发：TCP 也只能从 conntrack 看。
	DNAT bool `json:"dnat,omitempty"`
}

type onlineDirective struct {
	Ports []onlineWatchPort `json:"ports"`
}

type onlineIPEntry struct {
	IP    string `json:"ip"`
	Conns int    `json:"conns"`
	Since int64  `json:"since"`
}

type onlinePortReport struct {
	Port      int             `json:"port"`
	RuleID    int             `json:"ruleId,omitempty"`
	InboundID int             `json:"inboundId,omitempty"`
	IPs       []onlineIPEntry `json:"ips"`
	Truncated bool            `json:"truncated,omitempty"`
}

type onlineReport struct {
	At        int64              `json:"at"`
	Conntrack bool               `json:"conntrack"`
	Ports     []onlinePortReport `json:"ports"`
}

const (
	// 一个端口最多报多少个 IP；被扫的端口可能一瞬间几千个源，全报上去没有意义。
	onlineMaxIPsPerPort = 256
	// conntrack 表可能有几十万行，最多看这么多行，防止一台忙机器每 10 秒扫一遍大表。
	onlineConntrackMaxLines = 200000
)

type onlineModule struct {
	mu        sync.Mutex
	hash      string
	ports     []onlineWatchPort
	firstSeen map[string]int64
}

func init() {
	registerExtModule(&onlineModule{firstSeen: map[string]int64{}})
}

func (m *onlineModule) Name() string { return "online" }

func (m *onlineModule) Apply(cfg Config, directive json.RawMessage) {
	sum := sha256.Sum256(directive)
	hash := hex.EncodeToString(sum[:])
	m.mu.Lock()
	defer m.mu.Unlock()
	if hash == m.hash {
		return
	}
	var d onlineDirective
	if err := json.Unmarshal(directive, &d); err != nil {
		logf("ext online: bad directive: %v", err)
		return
	}
	ports := make([]onlineWatchPort, 0, len(d.Ports))
	for _, p := range d.Ports {
		if p.Port <= 0 || p.Port > 65535 {
			continue
		}
		p.Proto = strings.ToLower(strings.TrimSpace(p.Proto))
		if p.Proto != "tcp" && p.Proto != "udp" {
			p.Proto = "both"
		}
		ports = append(ports, p)
	}
	m.ports = ports
	m.hash = hash
	if len(ports) == 0 {
		m.firstSeen = map[string]int64{}
	}
}

func (m *onlineModule) Report(cfg Config) any {
	m.mu.Lock()
	ports := append([]onlineWatchPort(nil), m.ports...)
	m.mu.Unlock()
	if len(ports) == 0 {
		return nil
	}
	sel := buildOnlinePortSelection(ports)
	counts := map[int]map[string]int{}
	add := func(port int, ip string) {
		if counts[port] == nil {
			counts[port] = map[string]int{}
		}
		counts[port][ip]++
	}
	if len(sel.procTCP) > 0 {
		for _, path := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
			if f, err := os.Open(path); err == nil {
				parseProcNetEstablished(f, sel.procTCP, add)
				f.Close()
			}
		}
	}
	conntrackOK := false
	if len(sel.conntrack) > 0 {
		for _, path := range []string{"/proc/net/nf_conntrack", "/proc/net/ip_conntrack"} {
			if f, err := os.Open(path); err == nil {
				parseConntrackOnline(f, sel.conntrack, onlineConntrackMaxLines, add)
				f.Close()
				conntrackOK = true
				break
			}
		}
	}
	now := time.Now().Unix()
	m.mu.Lock()
	report := buildOnlineReport(ports, counts, m.firstSeen, now)
	m.mu.Unlock()
	report.Conntrack = conntrackOK
	return report
}

// onlinePortSelection：哪些端口从 /proc/net/tcp 数，哪些端口 / 协议从 conntrack 数。
type onlinePortSelection struct {
	procTCP   map[int]bool
	conntrack map[int]map[string]bool
}

func buildOnlinePortSelection(ports []onlineWatchPort) onlinePortSelection {
	sel := onlinePortSelection{procTCP: map[int]bool{}, conntrack: map[int]map[string]bool{}}
	addCT := func(port int, proto string) {
		if sel.conntrack[port] == nil {
			sel.conntrack[port] = map[string]bool{}
		}
		sel.conntrack[port][proto] = true
	}
	for _, p := range ports {
		tcp := p.Proto == "tcp" || p.Proto == "both"
		udp := p.Proto == "udp" || p.Proto == "both"
		if tcp {
			if p.DNAT {
				addCT(p.Port, "tcp")
			} else {
				sel.procTCP[p.Port] = true
			}
		}
		if udp {
			addCT(p.Port, "udp")
		}
	}
	// 同一个端口既有用户态 TCP 又有 DNAT TCP 不会发生（一个端口只属于一条规则）；真遇上了
	// 以 /proc 为准，conntrack 那边不再数 TCP，免得同一条连接算两次。
	for port := range sel.procTCP {
		if protos := sel.conntrack[port]; protos != nil {
			delete(protos, "tcp")
			if len(protos) == 0 {
				delete(sel.conntrack, port)
			}
		}
	}
	return sel
}

// buildOnlineReport 把这一轮的计数整理成上报，并维护「从什么时候开始连着」：这一轮没出现的
// IP 从 firstSeen 里删掉，下次再来就是新的一段。
func buildOnlineReport(ports []onlineWatchPort, counts map[int]map[string]int, firstSeen map[string]int64, now int64) onlineReport {
	report := onlineReport{At: now, Ports: make([]onlinePortReport, 0, len(ports))}
	seen := map[string]bool{}
	reported := map[int]bool{}
	for _, p := range ports {
		if reported[p.Port] {
			continue
		}
		reported[p.Port] = true
		ips := counts[p.Port]
		entry := onlinePortReport{Port: p.Port, RuleID: p.RuleID, InboundID: p.InboundID, IPs: make([]onlineIPEntry, 0, len(ips))}
		for ip, n := range ips {
			key := strconv.Itoa(p.Port) + "|" + ip
			seen[key] = true
			since, ok := firstSeen[key]
			if !ok {
				since = now
				firstSeen[key] = now
			}
			entry.IPs = append(entry.IPs, onlineIPEntry{IP: ip, Conns: n, Since: since})
		}
		sort.Slice(entry.IPs, func(i, j int) bool {
			if entry.IPs[i].Conns != entry.IPs[j].Conns {
				return entry.IPs[i].Conns > entry.IPs[j].Conns
			}
			return entry.IPs[i].IP < entry.IPs[j].IP
		})
		if len(entry.IPs) > onlineMaxIPsPerPort {
			entry.IPs = entry.IPs[:onlineMaxIPsPerPort]
			entry.Truncated = true
		}
		report.Ports = append(report.Ports, entry)
	}
	for key := range firstSeen {
		if !seen[key] {
			delete(firstSeen, key)
		}
	}
	return report
}

// parseProcNetEstablished 读 /proc/net/tcp{,6}：本地端口在 ports 里、状态 ESTABLISHED 的行，
// 把远端 IP 交给 add。回环地址（本机自己连自己，例如隧道的本地一跳）不算客户端。
func parseProcNetEstablished(r io.Reader, ports map[int]bool, add func(port int, ip string)) {
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
		_, localPort, ok := decodeProcNetAddr(fields[1])
		if !ok || !ports[localPort] {
			continue
		}
		remoteIP, _, ok := decodeProcNetAddr(fields[2])
		if !ok || remoteIP.IsLoopback() || remoteIP.IsUnspecified() {
			continue
		}
		add(localPort, remoteIP.String())
	}
}

// decodeProcNetAddr 解 /proc/net/tcp 里的 "0100007F:1F90"：IP 按 32 位小端字一组存，端口是大端十六进制。
func decodeProcNetAddr(value string) (net.IP, int, bool) {
	ipHex, portHex, found := strings.Cut(value, ":")
	if !found {
		return nil, 0, false
	}
	port64, err := strconv.ParseUint(portHex, 16, 16)
	if err != nil {
		return nil, 0, false
	}
	raw, err := hex.DecodeString(ipHex)
	if err != nil || (len(raw) != 4 && len(raw) != 16) {
		return nil, 0, false
	}
	ip := make(net.IP, len(raw))
	for word := 0; word < len(raw); word += 4 {
		ip[word], ip[word+1], ip[word+2], ip[word+3] = raw[word+3], raw[word+2], raw[word+1], raw[word]
	}
	if v4 := ip.To4(); v4 != nil {
		ip = v4
	}
	return ip, int(port64), true
}

var conntrackEstablished = []byte(" ESTABLISHED ")

// parseConntrackOnline 读 /proc/net/nf_conntrack：原始方向 dport 命中、协议对得上的条目，
// 原始方向的 src 就是客户端。TCP 只要 ESTABLISHED（半开 / 正在关的不算在线），UDP 有条目就算。
func parseConntrackOnline(r io.Reader, ports map[int]map[string]bool, maxLines int, add func(port int, ip string)) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 64*1024), conntrackScanBufferMax)
	lines := 0
	for scanner.Scan() {
		lines++
		if maxLines > 0 && lines > maxLines {
			return
		}
		line := scanner.Bytes()
		protocol, sourceIP, _, _, targetPort, ok := conntrackOriginalTupleBytes(line)
		if !ok {
			continue
		}
		port, err := strconv.Atoi(string(targetPort))
		if err != nil || !ports[port][string(protocol)] {
			continue
		}
		if string(protocol) == "tcp" && !bytes.Contains(line, conntrackEstablished) {
			continue
		}
		ip := net.ParseIP(string(sourceIP))
		if ip == nil || ip.IsLoopback() || ip.IsUnspecified() {
			continue
		}
		add(port, ip.String())
	}
}
