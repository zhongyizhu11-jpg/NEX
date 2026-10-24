package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
)

/*
主机「内核快速转发」（nftables flowtable，面板主机设置里的开关，2.3.432 / Agent 2.2.221 起，默认关）。

开着时 Agent 维护一张独立的 nft 表 inet nex_offload：

	table inet nex_offload {
	  flowtable ft { hook ingress priority 0; devices = { 公网网卡, nexwg…, 规则目标的出口网卡 }; counter; }
	  set tcp_ports { type inet_service; elements = { 本机内核规则的端口 } }
	  set udp_ports { … }
	  chain forward {
	    type filter hook forward priority 50; policy accept;
	    ct status dnat meta l4proto tcp ct original proto-dst @tcp_ports flow add @ft
	    ct status dnat meta l4proto udp ct original proto-dst @udp_ports flow add @ft
	  }
	}

连接建立后后续的包在网卡 ingress 上直接查 flowtable、改 NAT、发出去，跳过 PREROUTING / FORWARD /
POSTROUTING 和路由查找。只挑本机 iptables / nftables 规则和内核直通出口的端口、且做了 DNAT 的连接，
别的转发（docker 之类）不碰。forward 链放在 priority 50：iptables / firewalld / ufw 的 FORWARD 都在它
前面，被它们丢掉的包到不了这里，不会被这条规则绕过放行。

flowtable 带 counter，快速路径上的包仍然记进 conntrack 的字节计数，这些端口的流量改由
conntrack_acct.go 计；所以开启的前提是 nf_conntrack_acct 能打开、DESTROY 事件订阅得上，任何一步
不成就不建表，照旧走原来的路径。

需要 Linux 6.1 起：flowtable 的 counter 要 5.7，空闲连接从快速路径退回时按 ESTABLISHED 的超时
续上要 5.18 左右（更早的内核退回后只给 120 秒，长时间空闲的 TCP 连接会被掐）；取 6.1 这个 LTS。
*/

const (
	flowOffloadTable           = "nex_offload"
	flowOffloadMinKernel       = "6.1"
	flowOffloadAcctSysctl      = "/proc/sys/net/netfilter/nf_conntrack_acct"
	flowOffloadForwardPrio     = 50
	flowOffloadMaxTargets      = 64
	flowOffloadDeviceNameRe    = `^[A-Za-z0-9_.:-]{1,15}$`
	flowOffloadWireGuardPrefix = "nexwg"
)

var flowOffloadDeviceName = regexp.MustCompile(flowOffloadDeviceNameRe)

// flowOffloadPlan 是要装进 nex_offload 表的内容。
type flowOffloadPlan struct {
	Devices  []string
	TCPPorts []int
	UDPPorts []int
}

func flowOffloadPortList(ports []int) string {
	parts := make([]string, 0, len(ports))
	for _, port := range ports {
		parts = append(parts, strconv.Itoa(port))
	}
	return strings.Join(parts, ", ")
}

// buildFlowOffloadScript 生成一次性替换整张表的 nft 脚本（先建空表再删，删不存在的表也不报错）。
func buildFlowOffloadScript(plan flowOffloadPlan) string {
	var b strings.Builder
	fmt.Fprintf(&b, "table inet %s {}\ndelete table inet %s\n", flowOffloadTable, flowOffloadTable)
	fmt.Fprintf(&b, "table inet %s {\n", flowOffloadTable)
	quoted := make([]string, 0, len(plan.Devices))
	for _, device := range plan.Devices {
		quoted = append(quoted, strconv.Quote(device))
	}
	fmt.Fprintf(&b, "  flowtable ft {\n    hook ingress priority 0\n    devices = { %s }\n    counter\n  }\n", strings.Join(quoted, ", "))
	for _, set := range []struct {
		name  string
		ports []int
	}{{"tcp_ports", plan.TCPPorts}, {"udp_ports", plan.UDPPorts}} {
		if len(set.ports) == 0 {
			fmt.Fprintf(&b, "  set %s { type inet_service; }\n", set.name)
		} else {
			fmt.Fprintf(&b, "  set %s { type inet_service; elements = { %s } }\n", set.name, flowOffloadPortList(set.ports))
		}
	}
	fmt.Fprintf(&b, "  chain forward {\n    type filter hook forward priority %d; policy accept;\n", flowOffloadForwardPrio)
	b.WriteString("    ct status dnat meta l4proto tcp ct original proto-dst @tcp_ports flow add @ft\n")
	b.WriteString("    ct status dnat meta l4proto udp ct original proto-dst @udp_ports flow add @ft\n")
	b.WriteString("  }\n}\n")
	return b.String()
}

func buildFlowOffloadDeleteScript() string {
	return fmt.Sprintf("table inet %s {}\ndelete table inet %s\n", flowOffloadTable, flowOffloadTable)
}

// flowOffloadPorts 从本机规则状态里挑出走内核转发（iptables / nftables）的端口，加上内核直通出口
// 的端口，按协议分开。
func flowOffloadPorts(states []localRuleState, passthroughExit map[int]map[string]bool) (map[int]map[string]bool, []int, []int) {
	ports := map[int]map[string]bool{}
	add := func(port int, protocol string) {
		if port <= 0 || port > 65535 {
			return
		}
		if ports[port] == nil {
			ports[port] = map[string]bool{}
		}
		ports[port][protocol] = true
	}
	for _, state := range states {
		if !flowOffloadCountsState(state) {
			continue
		}
		port := parseStatePort(state.Port)
		for _, protocol := range runtimeProtocols(state.Protocol) {
			add(port, protocol)
		}
	}
	for port, protocols := range passthroughExit {
		for protocol, ok := range protocols {
			if ok {
				add(port, protocol)
			}
		}
	}
	tcp, udp := []int{}, []int{}
	for port, protocols := range ports {
		if protocols["tcp"] {
			tcp = append(tcp, port)
		}
		if protocols["udp"] {
			udp = append(udp, port)
		}
	}
	sort.Ints(tcp)
	sort.Ints(udp)
	return ports, tcp, udp
}

// flowOffloadCountsState：这条规则的流量走内核 DNAT，开了快速转发后要改从 conntrack 计。
func flowOffloadCountsState(state localRuleState) bool {
	if state.RuleID <= 0 || parseStatePort(state.Port) <= 0 {
		return false
	}
	switch trafficCounterFamilyForForwardType(state.ForwardType) {
	case trafficCounterFamilyIptables, trafficCounterFamilyNativeNFT:
		return true
	default:
		return false
	}
}

// flowOffloadAccountingPorts 是流量采集要改从 conntrack 计的端口 → 协议（只含本机规则，不含直通出口）。
func flowOffloadAccountingPorts(states []localRuleState) map[int]map[string]bool {
	ports, _, _ := flowOffloadPorts(states, nil)
	return ports
}

// parseRouteDevices 从 `ip -o route …` 的输出里取出 dev 后面的网卡名。
func parseRouteDevices(output string) []string {
	devices := []string{}
	for _, line := range strings.Split(output, "\n") {
		fields := strings.Fields(line)
		for i := 0; i+1 < len(fields); i++ {
			if fields[i] == "dev" {
				devices = append(devices, fields[i+1])
			}
		}
	}
	return devices
}

// parseLinkNames 从 `ip -o link show` 的输出里取出网卡名（去掉 veth 那种 @ 后缀）。
func parseLinkNames(output string) []string {
	names := []string{}
	for _, line := range strings.Split(output, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		name := strings.TrimSuffix(fields[1], ":")
		if at := strings.IndexByte(name, '@'); at >= 0 {
			name = name[:at]
		}
		names = append(names, name)
	}
	return names
}

func normalizeFlowOffloadDevices(names []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, name := range names {
		name = strings.TrimSpace(name)
		if at := strings.IndexByte(name, '@'); at >= 0 {
			name = name[:at]
		}
		if name == "" || name == "lo" || seen[name] || !flowOffloadDeviceName.MatchString(name) {
			continue
		}
		seen[name] = true
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

// flowOffloadTargets 是本机内核规则的目标 IP（去重，最多 flowOffloadMaxTargets 个），用来找它们的出口网卡。
func flowOffloadTargets(states []localRuleState) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, state := range states {
		if !flowOffloadCountsState(state) {
			continue
		}
		target := strings.Trim(strings.TrimSpace(state.TargetIP), "[]")
		if net.ParseIP(target) == nil || seen[target] {
			continue
		}
		seen[target] = true
		out = append(out, target)
		if len(out) >= flowOffloadMaxTargets {
			break
		}
	}
	sort.Strings(out)
	return out
}

// kernelReleaseAtLeast 比较 /proc/sys/kernel/osrelease 那种 "6.8.0-45-generic" 的主次版本号。
func kernelReleaseAtLeast(release string, minimum string) bool {
	parse := func(value string) (int, int, bool) {
		value = strings.TrimSpace(value)
		end := 0
		for end < len(value) && (value[end] == '.' || (value[end] >= '0' && value[end] <= '9')) {
			end++
		}
		parts := strings.Split(value[:end], ".")
		if len(parts) < 2 {
			return 0, 0, false
		}
		major, err1 := strconv.Atoi(parts[0])
		minor, err2 := strconv.Atoi(parts[1])
		return major, minor, err1 == nil && err2 == nil
	}
	major, minor, ok := parse(release)
	wantMajor, wantMinor, _ := parse(minimum)
	if !ok {
		return false
	}
	return major > wantMajor || (major == wantMajor && minor >= wantMinor)
}

// flowOffloadSystem 是快速转发对系统的全部调用，测试里换成假的。
type flowOffloadSystem interface {
	kernelRelease() (string, error)
	hasNft() bool
	applyNft(script string) error
	tableExists() bool
	enableConntrackAcct() error
	routeDevices(targets []string) []string
	linkNames() []string
}

type flowOffloadStatus struct {
	Enabled    bool                      `json:"enabled"`
	Active     bool                      `json:"active"`
	Error      string                    `json:"error,omitempty"`
	Kernel     string                    `json:"kernel,omitempty"`
	Devices    []string                  `json:"devices,omitempty"`
	TCPPorts   int                       `json:"tcpPorts"`
	UDPPorts   int                       `json:"udpPorts"`
	Accounting conntrackAccountingStatus `json:"accounting"`
}

// flowOffloadManager 把「开 / 关」落到 nft 表和 conntrack 计数上。
type flowOffloadManager struct {
	system     flowOffloadSystem
	accountant *conntrackAccountant

	mu          sync.Mutex
	enabled     bool
	active      bool
	appliedHash string
	lastErr     string
	kernel      string
	plan        flowOffloadPlan
}

func newFlowOffloadManager(system flowOffloadSystem, accountant *conntrackAccountant) *flowOffloadManager {
	return &flowOffloadManager{system: system, accountant: accountant}
}

// accountingActive：流量采集是否要对内核规则端口改从 conntrack 计。
// 表在内核里（哪怕 Agent 刚重启、还没收到面板指令）就算：快速路径上的包已经不进 iptables 计数了。
func (m *flowOffloadManager) accountingActive() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.active
}

func (m *flowOffloadManager) setEnabled(enabled bool) {
	m.mu.Lock()
	m.enabled = enabled
	m.mu.Unlock()
}

func (m *flowOffloadManager) isEnabled() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.enabled
}

// adoptExisting 在 Agent 启动时调用：上一次运行留下的表还在内核里，先把计数接上，等面板指令再决定去留。
func (m *flowOffloadManager) adoptExisting() {
	if !m.system.tableExists() {
		return
	}
	if err := m.accountant.start(); err != nil {
		// 计数接不上就不能让快速路径继续跑，不然这段时间的流量全丢：删表退回原路径。
		_ = m.system.applyNft(buildFlowOffloadDeleteScript())
		m.mu.Lock()
		m.lastErr = "conntrack 计数接不上，已关掉快速转发：" + err.Error()
		m.mu.Unlock()
		return
	}
	m.mu.Lock()
	m.active = true
	m.appliedHash = ""
	m.mu.Unlock()
}

// sync 按当前开关和本机规则同步一次。states / passthroughExit 是这一刻本机的内核规则。
func (m *flowOffloadManager) sync(states []localRuleState, passthroughExit map[int]map[string]bool) {
	m.mu.Lock()
	enabled := m.enabled
	m.mu.Unlock()
	if !enabled {
		m.disable()
		return
	}
	if err := m.enable(states, passthroughExit); err != nil {
		m.mu.Lock()
		m.lastErr = err.Error()
		m.mu.Unlock()
		if !m.accountingActive() {
			m.accountant.close()
		}
		return
	}
	m.mu.Lock()
	m.lastErr = ""
	m.mu.Unlock()
}

func (m *flowOffloadManager) enable(states []localRuleState, passthroughExit map[int]map[string]bool) error {
	release, err := m.system.kernelRelease()
	if err != nil {
		return fmt.Errorf("读不到内核版本：%w", err)
	}
	m.mu.Lock()
	m.kernel = release
	m.mu.Unlock()
	if !kernelReleaseAtLeast(release, flowOffloadMinKernel) {
		m.disable()
		return fmt.Errorf("内核 %s 太旧，快速转发需要 Linux %s 起", release, flowOffloadMinKernel)
	}
	if !m.system.hasNft() {
		m.disable()
		return errors.New("没有 nft 命令（装 nftables 包）")
	}
	if err := m.system.enableConntrackAcct(); err != nil {
		m.disable()
		return fmt.Errorf("打不开 conntrack 字节计数：%w", err)
	}
	if err := m.accountant.start(); err != nil {
		m.disable()
		return fmt.Errorf("订阅不了 conntrack 事件：%w", err)
	}
	_, tcp, udp := flowOffloadPorts(states, passthroughExit)
	devices := append(m.system.routeDevices(flowOffloadTargets(states)), filterWireGuardLinks(m.system.linkNames())...)
	plan := flowOffloadPlan{Devices: normalizeFlowOffloadDevices(devices), TCPPorts: tcp, UDPPorts: udp}
	if len(plan.Devices) == 0 {
		m.disable()
		return errors.New("找不到公网网卡")
	}
	script := buildFlowOffloadScript(plan)
	sum := sha256.Sum256([]byte(script))
	hash := hex.EncodeToString(sum[:])
	m.mu.Lock()
	unchanged := m.active && m.appliedHash == hash
	m.mu.Unlock()
	if unchanged && m.system.tableExists() {
		return nil
	}
	if err := m.system.applyNft(script); err != nil {
		m.disable()
		return fmt.Errorf("建 flowtable 失败（内核可能没编进 nf_flow_table）：%w", err)
	}
	m.mu.Lock()
	m.active = true
	m.appliedHash = hash
	m.plan = plan
	m.mu.Unlock()
	return nil
}

// disable 删表（快速路径上的连接回到普通路径，iptables 计数重新接手），停掉 conntrack 计数。
func (m *flowOffloadManager) disable() {
	m.mu.Lock()
	wasActive := m.active
	m.mu.Unlock()
	if wasActive || m.system.tableExists() {
		if err := m.system.applyNft(buildFlowOffloadDeleteScript()); err != nil {
			m.mu.Lock()
			m.lastErr = "删 nex_offload 表失败：" + err.Error()
			m.mu.Unlock()
			return
		}
	}
	m.mu.Lock()
	m.active = false
	m.appliedHash = ""
	m.plan = flowOffloadPlan{}
	m.mu.Unlock()
	m.accountant.close()
}

func (m *flowOffloadManager) status() flowOffloadStatus {
	m.mu.Lock()
	status := flowOffloadStatus{
		Enabled: m.enabled, Active: m.active, Error: m.lastErr, Kernel: m.kernel,
		Devices: append([]string(nil), m.plan.Devices...), TCPPorts: len(m.plan.TCPPorts), UDPPorts: len(m.plan.UDPPorts),
	}
	m.mu.Unlock()
	status.Accounting = m.accountant.status()
	return status
}

func filterWireGuardLinks(names []string) []string {
	out := []string{}
	for _, name := range names {
		if strings.HasPrefix(name, flowOffloadWireGuardPrefix) {
			out = append(out, name)
		}
	}
	return out
}

// systemFlowOffload 是真的系统调用。
type systemFlowOffload struct {
	runner firewallRunner
}

func (s systemFlowOffload) kernelRelease() (string, error) {
	raw, err := os.ReadFile("/proc/sys/kernel/osrelease")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(raw)), nil
}

func (s systemFlowOffload) hasNft() bool { return s.runner.Has("nft") }

func (s systemFlowOffload) applyNft(script string) error {
	out, err := s.runner.RunStdin(script, "nft", "-f", "-")
	if err != nil {
		return fmt.Errorf("%v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func (s systemFlowOffload) tableExists() bool {
	if !s.runner.Has("nft") {
		return false
	}
	_, err := s.runner.Run("nft", "list", "table", "inet", flowOffloadTable)
	return err == nil
}

func (s systemFlowOffload) enableConntrackAcct() error {
	if raw, err := os.ReadFile(flowOffloadAcctSysctl); err == nil && strings.TrimSpace(string(raw)) == "1" {
		return nil
	}
	if s.runner.Has("modprobe") {
		_, _ = s.runner.Run("modprobe", "nf_conntrack")
	}
	if err := os.WriteFile(flowOffloadAcctSysctl, []byte("1\n"), 0644); err != nil {
		return err
	}
	raw, err := os.ReadFile(flowOffloadAcctSysctl)
	if err != nil {
		return err
	}
	if strings.TrimSpace(string(raw)) != "1" {
		return errors.New("nf_conntrack_acct 写了 1 读回来不是 1")
	}
	return nil
}

func (s systemFlowOffload) routeDevices(targets []string) []string {
	devices := []string{}
	for _, args := range [][]string{{"-o", "route", "show", "default"}, {"-o", "-6", "route", "show", "default"}} {
		if out, err := s.runner.Run("ip", args...); err == nil {
			devices = append(devices, parseRouteDevices(string(out))...)
		}
	}
	for _, target := range targets {
		args := []string{"-o", "route", "get", target}
		if strings.Contains(target, ":") {
			args = []string{"-o", "-6", "route", "get", target}
		}
		if out, err := s.runner.Run("ip", args...); err == nil {
			devices = append(devices, parseRouteDevices(string(out))...)
		}
	}
	return devices
}

func (s systemFlowOffload) linkNames() []string {
	out, err := s.runner.Run("ip", "-o", "link", "show")
	if err != nil {
		return nil
	}
	return parseLinkNames(string(out))
}
