package main

import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

func listenPortOwnerPIDsForProtocol(port int, protocol string) []int {
	if port <= 0 {
		return nil
	}
	if _, err := exec.LookPath("ss"); err != nil {
		return nil
	}
	portText := strconv.Itoa(port)
	args := []string{"-H", "-ltnp"}
	if normalizeRuntimeProtocol(protocol) == "udp" {
		args = []string{"-H", "-lunp"}
	}
	out, _ := commandCombinedOutputWithTimeout(3*time.Second, "ss", args...)
	text := filterListenPortLines(string(out), portText)
	if strings.TrimSpace(text) == "" {
		return nil
	}
	re := regexp.MustCompile(`pid=([0-9]+)`)
	seen := map[int]bool{}
	var pids []int
	for _, match := range re.FindAllStringSubmatch(text, -1) {
		pid, err := strconv.Atoi(match[1])
		if err != nil || pid <= 0 || seen[pid] {
			continue
		}
		seen[pid] = true
		pids = append(pids, pid)
	}
	sort.Ints(pids)
	return pids
}

type runtimeListenSnapshot struct {
	tcpPorts map[int][]string
	udpPorts map[int][]string
	usable   bool
	// lazy 不为空时端口表在第一次查询时才加载（newRuntimeListenSnapshot 建的都是这种）；
	// 测试里直接构造的快照没有它，按构造时的内容原样使用。
	lazy *runtimeListenLazyLoad
}

/*
就绪检查里的进程信息（ss 的 -p）确实有用：带进程名的检查（gost / nginx / forwardx-fxp…）
要看端口是不是被对的进程占着。但 -p 会让 ss 遍历每个进程的每个文件描述符，连接多的机器上
是就绪检查里最重的一步，而以前不管有没有查询、要不要进程名，每次建快照都先跑一遍。

现在按需：第一次查询时才跑 ss，这次查询要进程名才带 -p；之前不带 -p 加载过、后来某个带
进程名的查询命中了正在监听的端口，再补跑一次带 -p 的。查一个根本没在监听的端口用不着进程
信息（结果一定是没就绪），不会触发 -p。每个查询看到的内容和以前一次 ss -ltnup 的结果一致：
不带 -p 只少了 users:(...) 那一列，端口集合相同。
*/
type runtimeListenLazyLoad struct {
	mu     sync.Mutex
	loaded bool
	// owners：当前端口表带着进程信息，或者已经不可能拿到（ss 不可用、走了 /proc 兜底）。
	owners bool
}

// runtimeListenSSOutput 测试里替换。
var runtimeListenSSOutput = func(withOwners bool) (string, bool) {
	if _, err := exec.LookPath("ss"); err != nil {
		return "", false
	}
	args := []string{"-H", "-ltnu"}
	if withOwners {
		args = []string{"-H", "-ltnup"}
	}
	out, err := commandCombinedOutputWithTimeout(3*time.Second, "ss", args...)
	if err != nil {
		return "", false
	}
	return string(out), true
}

func newRuntimeListenSnapshot() *runtimeListenSnapshot {
	return &runtimeListenSnapshot{
		tcpPorts: map[int][]string{},
		udpPorts: map[int][]string{},
		lazy:     &runtimeListenLazyLoad{},
	}
}

// loadLocked 跑一次 ss 并替换端口表（整张换掉，已经交出去的切片不会被改）。upgrade 为 true
// 是补拿进程信息：这次 ss 失败就保留原来的端口表，不再重试。
func (s *runtimeListenSnapshot) loadLocked(withOwners bool, upgrade bool) {
	fresh := &runtimeListenSnapshot{tcpPorts: map[int][]string{}, udpPorts: map[int][]string{}}
	if out, ok := runtimeListenSSOutput(withOwners); ok {
		fresh.parseSSListenOutput(out)
	}
	owners := withOwners
	if !fresh.usable {
		if upgrade {
			s.lazy.owners = true
			return
		}
		fresh.parseProcNetListenFiles()
		owners = true
	}
	s.tcpPorts, s.udpPorts, s.usable = fresh.tcpPorts, fresh.udpPorts, fresh.usable
	s.lazy.loaded = true
	s.lazy.owners = owners
}

func (s *runtimeListenSnapshot) portLinesLocked(port int, protocol string) []string {
	if normalizeRuntimeProtocol(protocol) == "udp" {
		return s.udpPorts[port]
	}
	return s.tcpPorts[port]
}

// listenLines 返回快照是否可用，以及这个端口、协议上的监听行；needOwners 表示调用方要按进程名判断。
func (s *runtimeListenSnapshot) listenLines(port int, protocol string, needOwners bool) (bool, []string) {
	if s == nil {
		return false, nil
	}
	if s.lazy == nil {
		return s.usable, s.portLinesLocked(port, protocol)
	}
	s.lazy.mu.Lock()
	defer s.lazy.mu.Unlock()
	if !s.lazy.loaded {
		s.loadLocked(needOwners, false)
	}
	lines := s.portLinesLocked(port, protocol)
	if needOwners && !s.lazy.owners && len(lines) > 0 {
		s.loadLocked(true, true)
		lines = s.portLinesLocked(port, protocol)
	}
	return s.usable, lines
}

func (s *runtimeListenSnapshot) parseSSListenOutput(text string) {
	for _, line := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 5 {
			continue
		}
		proto := strings.ToLower(strings.TrimSpace(fields[0]))
		if strings.HasPrefix(proto, "tcp") {
			proto = "tcp"
		} else if strings.HasPrefix(proto, "udp") {
			proto = "udp"
		} else {
			continue
		}
		port := addrPort(fields[4])
		if port <= 0 {
			continue
		}
		s.add(proto, port, line)
	}
}

func (s *runtimeListenSnapshot) parseProcNetListenFiles() {
	files := []struct {
		path     string
		protocol string
	}{
		{"/proc/net/tcp", "tcp"},
		{"/proc/net/tcp6", "tcp"},
		{"/proc/net/udp", "udp"},
		{"/proc/net/udp6", "udp"},
	}
	for _, file := range files {
		raw, err := os.ReadFile(file.path)
		if err != nil {
			continue
		}
		for idx, line := range strings.Split(string(raw), "\n") {
			if idx == 0 {
				continue
			}
			fields := strings.Fields(strings.TrimSpace(line))
			if len(fields) < 4 {
				continue
			}
			if file.protocol == "tcp" && strings.ToUpper(fields[3]) != "0A" {
				continue
			}
			port := procNetLocalPort(fields[1])
			if port <= 0 {
				continue
			}
			s.add(file.protocol, port, file.path+":"+fields[1])
		}
	}
}

func procNetLocalPort(value string) int {
	idx := strings.LastIndex(value, ":")
	if idx < 0 || idx >= len(value)-1 {
		return 0
	}
	raw := strings.TrimSpace(value[idx+1:])
	port64, err := strconv.ParseInt(raw, 16, 32)
	if err != nil || port64 <= 0 || port64 > 65535 {
		return 0
	}
	return int(port64)
}

func (s *runtimeListenSnapshot) add(protocol string, port int, line string) {
	if s == nil || port <= 0 {
		return
	}
	protocol = normalizeRuntimeProtocol(protocol)
	if protocol == "udp" {
		s.udpPorts[port] = append(s.udpPorts[port], line)
	} else {
		s.tcpPorts[port] = append(s.tcpPorts[port], line)
	}
	s.usable = true
}

func runtimeListenPortReady(snapshot *runtimeListenSnapshot, port int, protocol string, processNeedles []string) bool {
	if port <= 0 {
		return false
	}
	needOwners := len(normalizeRuntimeProcessNeedles(processNeedles)) > 0
	for _, proto := range runtimeProtocols(protocol) {
		if usable, _ := snapshot.listenLines(port, proto, needOwners); usable {
			if !snapshot.protocolPortReady(port, proto, processNeedles) {
				return false
			}
			continue
		}
		if !runtimePortOccupiedByProtocol(port, proto) {
			return false
		}
	}
	return true
}

func (s *runtimeListenSnapshot) protocolPortReady(port int, protocol string, processNeedles []string) bool {
	if s == nil || port <= 0 {
		return false
	}
	needles := normalizeRuntimeProcessNeedles(processNeedles)
	usable, lines := s.listenLines(port, protocol, len(needles) > 0)
	if !usable || len(lines) == 0 {
		return false
	}
	if len(needles) == 0 {
		return true
	}
	ownerSeen := false
	for _, line := range lines {
		lower := strings.ToLower(line)
		if strings.Contains(lower, "users:") || strings.Contains(lower, "pid=") {
			ownerSeen = true
			for _, needle := range needles {
				if strings.Contains(lower, needle) {
					return true
				}
			}
		}
	}
	return !ownerSeen
}

func normalizeRuntimeProcessNeedles(values []string) []string {
	seen := map[string]bool{}
	result := []string{}
	for _, value := range values {
		value = strings.ToLower(strings.TrimSpace(value))
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		result = append(result, value)
	}
	return result
}

func runtimePortOccupiedByProtocol(port int, protocol string) bool {
	if port <= 0 {
		return false
	}
	addr := ":" + strconv.Itoa(port)
	if normalizeRuntimeProtocol(protocol) == "udp" {
		conn, err := net.ListenPacket("udp", addr)
		if err != nil {
			return true
		}
		_ = conn.Close()
		return false
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return true
	}
	_ = ln.Close()
	return false
}

func listenPortBusy(proto string, port int) bool {
	if port <= 0 {
		return false
	}
	switch proto {
	case "udp":
		conn, err := net.ListenPacket("udp", ":"+strconv.Itoa(port))
		if err != nil {
			return true
		}
		_ = conn.Close()
		return false
	default:
		ln, err := net.Listen("tcp", ":"+strconv.Itoa(port))
		if err != nil {
			return true
		}
		_ = ln.Close()
		return false
	}
}

func runtimeProtocols(protocol string) []string {
	switch normalizeRuntimeProtocol(protocol) {
	case "udp":
		return []string{"udp"}
	case "both":
		return []string{"tcp", "udp"}
	default:
		return []string{"tcp"}
	}
}

func actionPortProtocolKey(port int, protocol string) string {
	if !validActionPort(port) {
		return ""
	}
	return fmt.Sprintf("%d:%s", port, normalizeRuntimeProtocol(protocol))
}

func runningRuleIDPortKey(ruleID int, port int) string {
	if ruleID <= 0 || !validActionPort(port) {
		return ""
	}
	return fmt.Sprintf("%d:%d", ruleID, port)
}

func protectedActionMatchesPort(protectedPorts map[string]bool, port string, protocol string) bool {
	if len(protectedPorts) == 0 || strings.TrimSpace(port) == "" {
		return false
	}
	if protectedPorts[port] {
		return true
	}
	portNumber := atoi(port)
	if portNumber <= 0 {
		return false
	}
	normalized := normalizeRuntimeProtocol(protocol)
	if protectedPorts[actionPortProtocolKey(portNumber, normalized)] || protectedPorts[actionPortProtocolKey(portNumber, "both")] {
		return true
	}
	if normalized == "both" {
		return protectedPorts[actionPortProtocolKey(portNumber, "tcp")] || protectedPorts[actionPortProtocolKey(portNumber, "udp")]
	}
	return false
}

func normalizeRuntimeProtocol(protocol string) string {
	value := strings.ToLower(strings.TrimSpace(protocol))
	compact := strings.NewReplacer(" ", "", "\t", "", "_", "", "+", "", "-", "", "/", "").Replace(value)
	switch {
	case value == "udp":
		return "udp"
	case value == "both" || compact == "tcpudp" || compact == "udptcp" || compact == "tcpandudp" || compact == "udpandtcp":
		return "both"
	default:
		return "tcp"
	}
}

func runtimeProtocolsOverlap(left string, right string) bool {
	leftProtocol := normalizeRuntimeProtocol(left)
	rightProtocol := normalizeRuntimeProtocol(right)
	return leftProtocol == "both" || rightProtocol == "both" || leftProtocol == rightProtocol
}

func listenPortOwnerSummary(port int) string {
	if port <= 0 {
		return ""
	}
	portText := strconv.Itoa(port)
	type probe struct {
		name       string
		args       []string
		filterPort bool
	}
	probes := []probe{
		{name: "ss", args: []string{"-ltnup"}, filterPort: true},
		{name: "lsof", args: []string{"-nP", "-iTCP:" + portText, "-sTCP:LISTEN"}},
		{name: "lsof", args: []string{"-nP", "-iUDP:" + portText}},
		{name: "fuser", args: []string{"-v", "-n", "tcp", portText}},
		{name: "fuser", args: []string{"-v", "-n", "udp", portText}},
	}
	for _, p := range probes {
		if _, err := exec.LookPath(p.name); err != nil {
			continue
		}
		out, _ := commandCombinedOutputWithTimeout(3*time.Second, p.name, p.args...)
		text := strings.TrimSpace(string(out))
		if p.filterPort {
			text = filterListenPortLines(text, portText)
		}
		if text == "" {
			continue
		}
		return compactLogOutput(p.name + " " + strings.Join(p.args, " ") + ": " + text)
	}
	return ""
}

func filterListenPortLines(text, portText string) string {
	if strings.TrimSpace(text) == "" {
		return ""
	}
	lines := strings.Split(text, "\n")
	matched := []string{}
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if listenPortLineMatches(line, portText) {
			matched = append(matched, line)
		}
	}
	return strings.Join(matched, "\n")
}

func listenPortLineMatches(line, portText string) bool {
	needle := ":" + portText
	offset := 0
	for {
		idx := strings.Index(line[offset:], needle)
		if idx < 0 {
			return false
		}
		end := offset + idx + len(needle)
		if end >= len(line) || line[end] < '0' || line[end] > '9' {
			return true
		}
		offset = end
	}
}
