package main

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// 扩展模块 ports：主机实际监听端口核对（端口占用告警）。面板那头见 server/ops/portOccupancyAgent.ts
// 和 server/rulePortOccupancy.ts。
//
// 面板指令 {"enabled": true}（只发给 2.2.255 起的 Agent）；开着时每一轮上报一次：
// 这台机器上启用规则用到的入口端口（按协议）上，有没有不归 ForwardX 管的进程在监听。
// 只看规则端口，不报整机所有监听：一来上报有界，二来别的端口有谁在听不关面板的事。
//
// 内核转发（iptables / nftables）自己不绑 socket，所以它的端口上任何外来监听都要报 ——
// 外来进程不会因为「端口被占」而报错，规则看着在跑，实际谁收到流量取决于防火墙顺序。
// 用户态转发绑不上会在动作状态里报「端口被占」（红），这里报的是「有人在听」（黄）。

const (
	portOccupancyMaxConflicts      = 200
	portOccupancyMaxListeners      = 8
	portOccupancyActionPortTTL     = 10 * time.Minute
	portOccupancyProcessNameMaxLen = 64
)

type portOccupancyDirective struct {
	Enabled bool `json:"enabled"`
}

type portOccupancyListener struct {
	Address string `json:"address"`
	Process string `json:"process,omitempty"`
	PID     int    `json:"pid,omitempty"`
}

type portOccupancyConflict struct {
	RuleID      int                     `json:"ruleId"`
	Port        int                     `json:"port"`
	Protocol    string                  `json:"protocol"`
	ForwardType string                  `json:"forwardType,omitempty"`
	Listeners   []portOccupancyListener `json:"listeners"`
}

type portOccupancyReport struct {
	Schema      int   `json:"schema"`
	CollectedAt int64 `json:"collectedAt"`
	// Usable 为 false：拿不到带进程信息的监听表（没有 ss 之类），这一轮什么都确认不了，面板保留上一轮的结论。
	Usable       bool                    `json:"usable"`
	CheckedPorts int                     `json:"checkedPorts"`
	Conflicts    []portOccupancyConflict `json:"conflicts"`
}

// portOccupancyTarget 是要核对的一个（规则，端口，协议）。
type portOccupancyTarget struct {
	ruleID      int
	port        int
	protocol    string // tcp / udp
	forwardType string
}

type portOccupancyModule struct {
	mu      sync.Mutex
	enabled bool
	// 最近一次期望状态里的 apply 动作：没在运行的规则（例如绑不上的）不在 runningRules 里，靠它补上。
	actionPorts map[string]portOccupancyActionPort
}

type portOccupancyActionPort struct {
	target portOccupancyTarget
	seenAt time.Time
}

var sharedPortOccupancyModule = &portOccupancyModule{actionPorts: map[string]portOccupancyActionPort{}}

func init() {
	registerExtModule(sharedPortOccupancyModule)
}

func (m *portOccupancyModule) Name() string { return "ports" }

func (m *portOccupancyModule) Apply(cfg Config, raw json.RawMessage) {
	var directive portOccupancyDirective
	if err := json.Unmarshal(raw, &directive); err != nil {
		return
	}
	m.mu.Lock()
	first := directive.Enabled && !m.enabled
	m.enabled = directive.Enabled
	m.mu.Unlock()
	if first {
		// 刚打开：下一轮马上报，不用等一整个间隔。
		go func() {
			time.Sleep(2 * time.Second)
			wakeAgentExt()
		}()
	}
}

func (m *portOccupancyModule) Report(cfg Config) any {
	m.mu.Lock()
	enabled := m.enabled
	m.mu.Unlock()
	if !enabled {
		return nil
	}
	targets := m.targets(time.Now())
	out, ok := runtimeListenSSOutput(true)
	return buildPortOccupancyReport(targets, out, ok, newPortOccupancyClassifier(), time.Now())
}

// rememberPortOccupancyDesiredActions 记下期望状态里的 apply 动作端口（actions.go 的 syncDesiredState 调）。
func rememberPortOccupancyDesiredActions(actions []action) {
	sharedPortOccupancyModule.rememberActions(actions, time.Now())
}

func (m *portOccupancyModule) rememberActions(actions []action, now time.Time) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, a := range actions {
		if strings.TrimSpace(a.Op) != "apply" || a.RuleID <= 0 || !validActionPort(a.SourcePort) {
			continue
		}
		statusType := strings.TrimSpace(a.StatusType)
		if statusType == "runtime" || statusType == "tunnel" {
			continue
		}
		for _, proto := range runtimeProtocols(a.Protocol) {
			target := portOccupancyTarget{ruleID: a.RuleID, port: a.SourcePort, protocol: proto, forwardType: strings.TrimSpace(a.ForwardType)}
			m.actionPorts[portOccupancyTargetKey(target)] = portOccupancyActionPort{target: target, seenAt: now}
		}
	}
	for key, item := range m.actionPorts {
		if now.Sub(item.seenAt) > portOccupancyActionPortTTL {
			delete(m.actionPorts, key)
		}
	}
}

func portOccupancyTargetKey(target portOccupancyTarget) string {
	return fmt.Sprintf("%d/%s", target.port, target.protocol)
}

// targets：在跑的规则（runningRules）优先，再补上最近期望状态里还在下发的规则。同一个端口 + 协议只核对一次。
func (m *portOccupancyModule) targets(now time.Time) []portOccupancyTarget {
	byKey := map[string]portOccupancyTarget{}
	desiredRunningRuleMu.Lock()
	for _, rule := range desiredRunningRulesByRulePort {
		if rule.RuleID <= 0 || !validActionPort(rule.SourcePort) || rule.SchedulerOnly {
			continue
		}
		for _, proto := range runtimeProtocols(rule.Protocol) {
			target := portOccupancyTarget{ruleID: rule.RuleID, port: rule.SourcePort, protocol: proto, forwardType: strings.TrimSpace(rule.ForwardType)}
			byKey[portOccupancyTargetKey(target)] = target
		}
	}
	desiredRunningRuleMu.Unlock()
	m.mu.Lock()
	for key, item := range m.actionPorts {
		if now.Sub(item.seenAt) > portOccupancyActionPortTTL {
			continue
		}
		if _, exists := byKey[key]; !exists {
			byKey[key] = item.target
		}
	}
	m.mu.Unlock()
	targets := make([]portOccupancyTarget, 0, len(byKey))
	for _, target := range byKey {
		targets = append(targets, target)
	}
	sort.Slice(targets, func(i, j int) bool {
		if targets[i].port != targets[j].port {
			return targets[i].port < targets[j].port
		}
		return targets[i].protocol < targets[j].protocol
	})
	return targets
}

// portOccupancyClassifier 判断一个监听进程归不归 ForwardX 管，每轮新建一个，同一个 pid 只查一次 /proc。
type portOccupancyClassifier struct {
	selfPID  int
	readFile func(path string) ([]byte, error)
	cache    map[int]bool
}

func newPortOccupancyClassifier() *portOccupancyClassifier {
	return &portOccupancyClassifier{selfPID: os.Getpid(), readFile: os.ReadFile, cache: map[int]bool{}}
}

// managed：Agent 自己（守卫、主备代理、线路组、SNI 分流都在 Agent 进程里听）、它的子进程（FXP、插件），
// 或者 ForwardX 起的服务（systemd 的 forwardx-*.service 在 cgroup 里；OpenRC / procd 下看命令行里的
// /etc/forwardx/… 配置路径和 forwardx-* 程序名）。Agent 重启时 FXP 不跟着停，父进程会变成 1，
// 但它们的 cgroup 和命令行还是 ForwardX 的。
func (c *portOccupancyClassifier) managed(pid int, process string) bool {
	if pid <= 0 {
		return strings.HasPrefix(strings.ToLower(process), "forwardx")
	}
	if pid == c.selfPID {
		return true
	}
	if value, ok := c.cache[pid]; ok {
		return value
	}
	value := c.lookup(pid, process)
	c.cache[pid] = value
	return value
}

func (c *portOccupancyClassifier) lookup(pid int, process string) bool {
	if strings.HasPrefix(strings.ToLower(process), "forwardx") {
		return true
	}
	base := "/proc/" + strconv.Itoa(pid) + "/"
	if stat, err := c.readFile(base + "stat"); err == nil {
		if parent := procStatParentPID(string(stat)); parent > 0 && parent == c.selfPID {
			return true
		}
	}
	if cgroup, err := c.readFile(base + "cgroup"); err == nil && strings.Contains(strings.ToLower(string(cgroup)), "forwardx") {
		return true
	}
	if cmdline, err := c.readFile(base + "cmdline"); err == nil && strings.Contains(strings.ToLower(string(cmdline)), "forwardx") {
		return true
	}
	return false
}

// procStatParentPID 取 /proc/<pid>/stat 的第 4 个字段；进程名在括号里、自己可能带空格，从最后一个 ')' 往后数。
func procStatParentPID(stat string) int {
	end := strings.LastIndexByte(stat, ')')
	if end < 0 {
		return 0
	}
	fields := strings.Fields(stat[end+1:])
	if len(fields) < 2 {
		return 0
	}
	parent, _ := strconv.Atoi(fields[1])
	return parent
}

var ssUserPattern = regexp.MustCompile(`\("([^"]*)",pid=([0-9]+)`)

type ssListenEntry struct {
	protocol string
	port     int
	address  string
	users    []portOccupancyListener
}

// parsePortOccupancySSOutput 解析 `ss -H -ltnup`：协议、本地地址、users:(("名字",pid=…,fd=…),…)。
func parsePortOccupancySSOutput(text string) []ssListenEntry {
	entries := []ssListenEntry{}
	for _, line := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 5 {
			continue
		}
		proto := strings.ToLower(fields[0])
		switch {
		case strings.HasPrefix(proto, "tcp"):
			proto = "tcp"
		case strings.HasPrefix(proto, "udp"):
			proto = "udp"
		default:
			continue
		}
		local := fields[4]
		port := addrPort(local)
		if port <= 0 {
			continue
		}
		address := local
		if index := strings.LastIndex(address, ":"); index >= 0 {
			address = address[:index]
		}
		address = strings.Trim(address, "[]")
		if index := strings.IndexByte(address, '%'); index >= 0 {
			address = address[:index]
		}
		entry := ssListenEntry{protocol: proto, port: port, address: address}
		for _, match := range ssUserPattern.FindAllStringSubmatch(line, -1) {
			pid, _ := strconv.Atoi(match[2])
			name := match[1]
			if len(name) > portOccupancyProcessNameMaxLen {
				name = name[:portOccupancyProcessNameMaxLen]
			}
			entry.users = append(entry.users, portOccupancyListener{Address: address, Process: name, PID: pid})
		}
		entries = append(entries, entry)
	}
	return entries
}

func portOccupancyLoopback(address string) bool {
	ip := net.ParseIP(strings.TrimPrefix(address, "::ffff:"))
	return ip != nil && ip.IsLoopback()
}

// buildPortOccupancyReport 把要核对的端口和监听表对一遍，只报外来监听。拿不到监听表、或监听表里没有进程信息
// （判断不了是谁）时 usable=false。
func buildPortOccupancyReport(targets []portOccupancyTarget, ssOutput string, ssOK bool, classifier *portOccupancyClassifier, now time.Time) portOccupancyReport {
	report := portOccupancyReport{Schema: 1, CollectedAt: now.UnixMilli(), Conflicts: []portOccupancyConflict{}}
	if len(targets) == 0 {
		report.Usable = true
		return report
	}
	if !ssOK {
		return report
	}
	entries := parsePortOccupancySSOutput(ssOutput)
	byKey := map[string][]ssListenEntry{}
	ownersSeen := false
	for _, entry := range entries {
		key := fmt.Sprintf("%d/%s", entry.port, entry.protocol)
		byKey[key] = append(byKey[key], entry)
		if len(entry.users) > 0 {
			ownersSeen = true
		}
	}
	if len(entries) > 0 && !ownersSeen {
		// 有监听却一个进程信息都没有：不是 root、或者 ss 太老。分不清是谁，宁可不报。
		return report
	}
	report.Usable = true
	report.CheckedPorts = len(targets)
	for _, target := range targets {
		kernel := isKernelForwardType(target.forwardType)
		listeners := []portOccupancyListener{}
		for _, entry := range byKey[portOccupancyTargetKey(target)] {
			// 内核转发在 PREROUTING 做 DNAT，从网卡进来的包到不了本机回环上的监听，那不算冲突。
			if kernel && portOccupancyLoopback(entry.address) {
				continue
			}
			if len(entry.users) == 0 {
				listeners = append(listeners, portOccupancyListener{Address: entry.address})
				continue
			}
			managed := false
			for _, user := range entry.users {
				if classifier.managed(user.PID, user.Process) {
					managed = true
					break
				}
			}
			if !managed {
				listeners = append(listeners, entry.users[0])
			}
		}
		if len(listeners) == 0 {
			continue
		}
		if len(listeners) > portOccupancyMaxListeners {
			listeners = listeners[:portOccupancyMaxListeners]
		}
		report.Conflicts = append(report.Conflicts, portOccupancyConflict{
			RuleID: target.ruleID, Port: target.port, Protocol: target.protocol, ForwardType: target.forwardType, Listeners: listeners,
		})
		if len(report.Conflicts) >= portOccupancyMaxConflicts {
			break
		}
	}
	return report
}

// portOccupantSummary 绑定失败时说清楚是谁占着端口：「port 443/tcp occupied by nginx (pid 812)」。
// 面板据此在规则卡上显示红色的端口占用原因（server/rulePortOccupancy.ts 认这个格式）。占着的是
// ForwardX 自己的进程、或者查不到时返回 ""。
func portOccupantSummary(port int, protocol string) string {
	if port <= 0 {
		return ""
	}
	out, ok := runtimeListenSSOutput(true)
	if !ok {
		return ""
	}
	classifier := newPortOccupancyClassifier()
	parts := []string{}
	entries := parsePortOccupancySSOutput(out)
	for _, proto := range runtimeProtocols(protocol) {
		occupant := ""
		for _, entry := range entries {
			if entry.port != port || entry.protocol != proto {
				continue
			}
			for _, user := range entry.users {
				if !classifier.managed(user.PID, user.Process) {
					occupant = fmt.Sprintf("port %d/%s occupied by %s (pid %d)", port, proto, user.Process, user.PID)
					break
				}
			}
			if occupant != "" {
				break
			}
		}
		if occupant != "" {
			parts = append(parts, occupant)
		}
	}
	return strings.Join(parts, "; ")
}
