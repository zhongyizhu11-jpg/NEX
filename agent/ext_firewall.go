package main

// 地区规则 + IP 封禁（扩展模块 "firewall"，面板那头见 server/ops/firewallAgent.ts）。
//
// 面板每轮下发一份指令：要守的端口（规则入口、隧道入口、落地入站，tcp / udp 分开）、
// 地区模式（off / block / allow）和国家 IP 段、封禁的 IP 段、面板自己那几台主机的地址（永远放行）。
// 这里把它落成一张自己的 nftables 表 inet forwardx_guard；没有 nft 时退回 ipset + iptables
// 的 mangle 表里一条自己的链 FWX_GUARD。和已有的 forwardx / forwardx_traffic 表、FWX_* 计数链互不相干。
//
// 为什么挂在 prerouting、优先级 -150（mangle）：
//   - realm / gost / socat 在本机监听，包走 prerouting → input；
//   - iptables / nftables 类型的转发是 DNAT，包在 prerouting 的 dstnat（-100）里改了目标，
//     之后走 forward，根本不经过 input —— 只挂 input 会被这类转发整条绕过去。
//   - prerouting 是两条路的共同起点；-150 在 conntrack（-200）之后，ct state 已经可用，
//     又在 dstnat（-100）之前，tcp/udp dport 还是用户连进来的那个原始端口。
//   iptables 退路用 mangle PREROUTING，同样是 -150、同样在 nat PREROUTING 之前。
//
// 只看「新连接」（ct state new）：已经建立的连接和本机主动连出去的回包一律不碰；
// 环回、内网、链路本地、保留段不碰；sshd 的端口（22 和 sshd_config 里写的）从端口集合里剔掉，
// 面板就算误把 22 当成规则端口下发，也锁不住 SSH。
//
// 幂等：面板每轮都下发，哈希没变就什么也不做（每 5 分钟顺手确认一次表还在，被 flush 掉了就重建）。
// 原子：nft 用一份完整的表定义一次 nft -f；iptables 用 ipset swap + iptables-restore --noflush。

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	firewallNftTable      = "forwardx_guard"
	firewallIptChain      = "FWX_GUARD"
	firewallIptCheckChain = "FWX_GUARD_CHK"
	firewallSetPrefix     = "fwx_g_"
	firewallBlockComment  = "fwx-guard-block"
	firewallGeoComment    = "fwx-guard-country"
	firewallVerifyEvery   = 5 * time.Minute
	firewallCommandTimout = 60 * time.Second
	firewallIpsetMaxElem  = 524288
)

// 永远不过滤的来源：环回、内网（含 CGNAT）、链路本地、组播、保留段、IPv4-mapped。
var firewallSkipV4 = []string{
	"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16",
	"172.16.0.0/12", "192.168.0.0/16", "224.0.0.0/4", "240.0.0.0/4",
}

var firewallSkipV6 = []string{
	"::/127", "::ffff:0:0/96", "fc00::/7", "fe80::/10", "ff00::/8",
}

type firewallDirective struct {
	V           int      `json:"v"`
	Enabled     bool     `json:"enabled"`
	Hash        string   `json:"hash"`
	Mode        string   `json:"mode"`
	TCP         []int    `json:"tcp"`
	UDP         []int    `json:"udp"`
	Block4      []string `json:"block4"`
	Block6      []string `json:"block6"`
	Allow4      []string `json:"allow4"`
	Allow6      []string `json:"allow6"`
	CountryHash string   `json:"countryHash"`
	// GeoIncluded=false 表示面板认为我们手里已经有 CountryHash 那份国家段，这一轮省掉大列表。
	GeoIncluded bool     `json:"geoIncluded"`
	Geo4        []string `json:"geo4"`
	Geo6        []string `json:"geo6"`
}

type firewallReport struct {
	Hash        string `json:"hash"`
	CountryHash string `json:"countryHash"`
	Backend     string `json:"backend"`
	Active      bool   `json:"active"`
	Error       string `json:"error,omitempty"`
	Since       int64  `json:"since"`
	Block       uint64 `json:"block"`
	Country     uint64 `json:"country"`
	Ports       int    `json:"ports"`
	SSHPorts    []int  `json:"sshPorts,omitempty"`
}

// firewallPlan 是校验、去重之后真正要落到机器上的东西。
type firewallPlan struct {
	Mode   string
	TCP    []int
	UDP    []int
	Block4 []string
	Block6 []string
	Allow4 []string
	Allow6 []string
	Geo4   []string
	Geo6   []string
}

func (p firewallPlan) portCount() int { return len(p.TCP) + len(p.UDP) }

// firewallRunner 把对系统的调用收在一处，测试里换成假的。
type firewallRunner interface {
	Has(binary string) bool
	Run(name string, args ...string) ([]byte, error)
	RunStdin(stdin string, name string, args ...string) ([]byte, error)
}

type firewallExecRunner struct{}

func (firewallExecRunner) Has(binary string) bool {
	_, err := exec.LookPath(binary)
	return err == nil
}

func (firewallExecRunner) Run(name string, args ...string) ([]byte, error) {
	return commandCombinedOutputWithTimeout(firewallCommandTimout, name, args...)
}

func (firewallExecRunner) RunStdin(stdin string, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), firewallCommandTimout)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.WaitDelay = shellCommandWaitDelay
	cmd.Stdin = strings.NewReader(stdin)
	out, err := cmd.CombinedOutput()
	if ctx.Err() == context.DeadlineExceeded {
		return out, fmt.Errorf("%s timed out: %w", name, ctx.Err())
	}
	return out, err
}

type firewallGeoCache struct {
	hash string
	v4   []string
	v6   []string
}

type firewallModule struct {
	mu          sync.Mutex
	runner      firewallRunner
	readSSHD    func() []int
	now         func() time.Time
	appliedHash string // "" = 还没处理过；"off" = 已确认清理干净
	backend     string // nft / iptables / ""
	active      bool
	lastError   string
	lastVerify  time.Time
	geo         firewallGeoCache
	since       int64
	baseBlock   uint64
	baseCountry uint64
	ports       int
	sshPorts    []int
}

func newFirewallModule(runner firewallRunner) *firewallModule {
	return &firewallModule{
		runner:   runner,
		readSSHD: readSSHDPorts,
		now:      time.Now,
		since:    time.Now().Unix(),
	}
}

func init() {
	registerExtModule(newFirewallModule(firewallExecRunner{}))
}

func (m *firewallModule) Name() string { return "firewall" }

func (m *firewallModule) Report(cfg Config) any {
	m.mu.Lock()
	defer m.mu.Unlock()
	block, country := uint64(0), uint64(0)
	if m.active {
		block, country = m.readCountersLocked()
	}
	return firewallReport{
		Hash:        m.appliedHash,
		CountryHash: m.geo.hash,
		Backend:     m.backend,
		Active:      m.active,
		Error:       m.lastError,
		Since:       m.since,
		Block:       m.baseBlock + block,
		Country:     m.baseCountry + country,
		Ports:       m.ports,
		SSHPorts:    m.sshPorts,
	}
}

func (m *firewallModule) Apply(cfg Config, raw json.RawMessage) {
	var d firewallDirective
	if err := json.Unmarshal(raw, &d); err != nil {
		m.mu.Lock()
		m.lastError = "指令格式不对：" + err.Error()
		m.mu.Unlock()
		return
	}
	m.applyDirective(d)
}

func (m *firewallModule) applyDirective(d firewallDirective) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if d.GeoIncluded {
		m.geo = firewallGeoCache{hash: d.CountryHash, v4: d.Geo4, v6: d.Geo6}
	}
	now := m.now()
	if !d.Enabled {
		if m.appliedHash != "off" {
			m.cleanupLocked()
			m.appliedHash = "off"
			m.lastError = ""
			m.ports = 0
		}
		return
	}
	if d.Hash != "" && d.Hash == m.appliedHash {
		if now.Sub(m.lastVerify) < firewallVerifyEvery {
			return
		}
		m.lastVerify = now
		if !m.active || m.verifyLocked() {
			return
		}
		logf("firewall: guard table missing, re-applying")
	}
	var geo4, geo6 []string
	if d.Mode == "block" || d.Mode == "allow" {
		if m.geo.hash != d.CountryHash {
			// 面板以为我们有这份国家段，其实没有（例如刚重启）。这一轮上报的 countryHash 不一样，
			// 面板下一轮会带上完整列表；在那之前保持原样，不要半套规则上去。
			m.lastError = "等面板发来国家 IP 段"
			return
		}
		geo4, geo6 = m.geo.v4, m.geo.v6
	}
	m.sshPorts = m.readSSHD()
	plan, warn := buildFirewallPlan(d, geo4, geo6, m.sshPorts)
	m.ports = plan.portCount()
	if plan.portCount() == 0 || (plan.Mode == "off" && len(plan.Block4)+len(plan.Block6) == 0) {
		m.cleanupLocked()
		m.appliedHash = d.Hash
		m.lastError = warn
		m.lastVerify = now
		return
	}
	backend, err := m.applyPlanLocked(plan)
	if err != nil {
		m.lastError = err.Error()
		logf("firewall: apply failed: %v", err)
		return
	}
	m.backend = backend
	m.active = true
	m.appliedHash = d.Hash
	m.lastError = warn
	m.lastVerify = now
}

// buildFirewallPlan 校验并整理指令：非法 CIDR 丢掉，嵌套的段只留外层（nft 的区间集合不接受重叠），
// sshd 端口剔掉。allow 模式下国家段一条都没有时退回 off —— 否则等于把所有人都挡在外面。
func buildFirewallPlan(d firewallDirective, geo4, geo6 []string, sshPorts []int) (firewallPlan, string) {
	plan := firewallPlan{Mode: d.Mode}
	warn := ""
	skip := map[int]bool{22: true}
	for _, p := range sshPorts {
		skip[p] = true
	}
	plan.TCP = firewallPorts(d.TCP, skip)
	plan.UDP = firewallPorts(d.UDP, nil)
	plan.Block4 = normalizeFirewallPrefixes(d.Block4, false)
	plan.Block6 = normalizeFirewallPrefixes(d.Block6, true)
	plan.Allow4 = normalizeFirewallPrefixes(d.Allow4, false)
	plan.Allow6 = normalizeFirewallPrefixes(d.Allow6, true)
	switch d.Mode {
	case "block", "allow":
		plan.Geo4 = normalizeFirewallPrefixes(geo4, false)
		plan.Geo6 = normalizeFirewallPrefixes(geo6, true)
		if d.Mode == "allow" && len(plan.Geo4)+len(plan.Geo6) == 0 {
			plan.Mode = "off"
			warn = "只放行模式下没有国家 IP 段，地区规则暂不生效"
		}
	default:
		plan.Mode = "off"
	}
	if plan.Mode == "off" {
		plan.Geo4, plan.Geo6 = nil, nil
	}
	return plan, warn
}

func firewallPorts(list []int, skip map[int]bool) []int {
	seen := map[int]bool{}
	out := []int{}
	for _, p := range list {
		if p < 1 || p > 65535 || seen[p] || skip[p] {
			continue
		}
		seen[p] = true
		out = append(out, p)
	}
	sort.Ints(out)
	return out
}

// normalizeFirewallPrefixes：解析、归一到网络地址、去掉被别的段包含的段，按地址排序。
// 两个 CIDR 要么不相交要么一个包含另一个，所以按（起始地址，前缀长度升序）排好后，
// 一个段若被包含，包含它的一定是上一个留下来的段。
func normalizeFirewallPrefixes(list []string, v6 bool) []string {
	prefixes := make([]netip.Prefix, 0, len(list))
	for _, item := range list {
		text := strings.TrimSpace(item)
		if text == "" {
			continue
		}
		var prefix netip.Prefix
		if strings.Contains(text, "/") {
			p, err := netip.ParsePrefix(text)
			if err != nil {
				continue
			}
			prefix = p.Masked()
		} else {
			addr, err := netip.ParseAddr(text)
			if err != nil {
				continue
			}
			prefix = netip.PrefixFrom(addr, addr.BitLen())
		}
		addr := prefix.Addr()
		if addr.Zone() != "" || addr.Is4In6() {
			continue
		}
		if v6 != addr.Is6() || prefix.Bits() < 1 {
			continue
		}
		prefixes = append(prefixes, prefix)
	}
	sort.Slice(prefixes, func(i, j int) bool {
		if c := prefixes[i].Addr().Compare(prefixes[j].Addr()); c != 0 {
			return c < 0
		}
		return prefixes[i].Bits() < prefixes[j].Bits()
	})
	out := make([]string, 0, len(prefixes))
	var last netip.Prefix
	hasLast := false
	for _, p := range prefixes {
		if hasLast && last.Bits() <= p.Bits() && last.Contains(p.Addr()) {
			continue
		}
		last, hasLast = p, true
		out = append(out, p.String())
	}
	return out
}

func nftSetBlock(name, typ string, interval bool, elements []string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "\tset %s {\n\t\ttype %s\n", name, typ)
	if interval {
		b.WriteString("\t\tflags interval\n")
	}
	if len(elements) > 0 {
		b.WriteString("\t\telements = { ")
		for i, e := range elements {
			if i > 0 {
				b.WriteString(", ")
				if i%16 == 0 {
					b.WriteString("\n\t\t\t")
				}
			}
			b.WriteString(e)
		}
		b.WriteString(" }\n")
	}
	b.WriteString("\t}\n")
	return b.String()
}

func intsToStrings(list []int) []string {
	out := make([]string, len(list))
	for i, v := range list {
		out[i] = strconv.Itoa(v)
	}
	return out
}

// buildNftGuardScript 生成一整份 nft -f 脚本：先「建或保留」再删掉再完整定义，同一个事务里换掉整张表。
func buildNftGuardScript(plan firewallPlan) string {
	var b strings.Builder
	fmt.Fprintf(&b, "table inet %s\ndelete table inet %s\ntable inet %s {\n", firewallNftTable, firewallNftTable, firewallNftTable)
	b.WriteString("\tcounter cnt_block {\n\t}\n\tcounter cnt_country {\n\t}\n")
	b.WriteString(nftSetBlock("tcp_ports", "inet_service", false, intsToStrings(plan.TCP)))
	b.WriteString(nftSetBlock("udp_ports", "inet_service", false, intsToStrings(plan.UDP)))
	b.WriteString(nftSetBlock("skip4", "ipv4_addr", true, firewallSkipV4))
	b.WriteString(nftSetBlock("skip6", "ipv6_addr", true, firewallSkipV6))
	b.WriteString(nftSetBlock("allow4", "ipv4_addr", true, plan.Allow4))
	b.WriteString(nftSetBlock("allow6", "ipv6_addr", true, plan.Allow6))
	b.WriteString(nftSetBlock("block4", "ipv4_addr", true, plan.Block4))
	b.WriteString(nftSetBlock("block6", "ipv6_addr", true, plan.Block6))
	if plan.Mode != "off" {
		b.WriteString(nftSetBlock("geo4", "ipv4_addr", true, plan.Geo4))
		b.WriteString(nftSetBlock("geo6", "ipv6_addr", true, plan.Geo6))
	}
	b.WriteString("\tchain prerouting {\n\t\ttype filter hook prerouting priority -150; policy accept;\n")
	b.WriteString("\t\tiifname \"lo\" return\n")
	b.WriteString("\t\tct state != new return\n")
	if len(plan.TCP) > 0 {
		b.WriteString("\t\ttcp dport @tcp_ports jump guard\n")
	}
	if len(plan.UDP) > 0 {
		b.WriteString("\t\tudp dport @udp_ports jump guard\n")
	}
	b.WriteString("\t}\n\tchain guard {\n")
	b.WriteString("\t\tip saddr @skip4 return\n\t\tip6 saddr @skip6 return\n")
	b.WriteString("\t\tip saddr @allow4 return\n\t\tip6 saddr @allow6 return\n")
	b.WriteString("\t\tip saddr @block4 counter name cnt_block drop\n\t\tip6 saddr @block6 counter name cnt_block drop\n")
	switch plan.Mode {
	case "block":
		b.WriteString("\t\tip saddr @geo4 counter name cnt_country drop\n\t\tip6 saddr @geo6 counter name cnt_country drop\n")
	case "allow":
		b.WriteString("\t\tmeta nfproto ipv4 ip saddr != @geo4 counter name cnt_country drop\n")
		b.WriteString("\t\tmeta nfproto ipv6 ip6 saddr != @geo6 counter name cnt_country drop\n")
	}
	b.WriteString("\t}\n}\n")
	return b.String()
}

type firewallIpset struct {
	name   string
	family string // inet / inet6 / port
	items  []string
}

func firewallIpsets(plan firewallPlan) []firewallIpset {
	sets := []firewallIpset{
		{firewallSetPrefix + "tcp", "port", intsToStrings(plan.TCP)},
		{firewallSetPrefix + "udp", "port", intsToStrings(plan.UDP)},
		{firewallSetPrefix + "skip4", "inet", firewallSkipV4},
		{firewallSetPrefix + "skip6", "inet6", firewallSkipV6},
		{firewallSetPrefix + "allow4", "inet", plan.Allow4},
		{firewallSetPrefix + "allow6", "inet6", plan.Allow6},
		{firewallSetPrefix + "block4", "inet", plan.Block4},
		{firewallSetPrefix + "block6", "inet6", plan.Block6},
		{firewallSetPrefix + "geo4", "inet", plan.Geo4},
		{firewallSetPrefix + "geo6", "inet6", plan.Geo6},
	}
	return sets
}

func firewallIpsetCreate(name, family string) string {
	if family == "port" {
		return fmt.Sprintf("create %s bitmap:port range 0-65535", name)
	}
	return fmt.Sprintf("create %s hash:net family %s hashsize 4096 maxelem %d", name, family, firewallIpsetMaxElem)
}

// buildIpsetRestoreScript：每个集合先灌进一个临时集合，再 swap 过去 —— 换的那一下是原子的，
// 规则一直引用着同一个名字，中间没有「集合是空的」那一刻。
func buildIpsetRestoreScript(plan firewallPlan) string {
	var b strings.Builder
	for _, set := range firewallIpsets(plan) {
		tmp := set.name + "_t"
		b.WriteString(firewallIpsetCreate(set.name, set.family) + "\n")
		b.WriteString(firewallIpsetCreate(tmp, set.family) + "\n")
		fmt.Fprintf(&b, "flush %s\n", tmp)
		for _, item := range set.items {
			if strings.HasSuffix(item, "/32") && set.family == "inet" {
				item = strings.TrimSuffix(item, "/32")
			}
			if strings.HasSuffix(item, "/128") && set.family == "inet6" {
				item = strings.TrimSuffix(item, "/128")
			}
			fmt.Fprintf(&b, "add %s %s\n", tmp, item)
		}
		fmt.Fprintf(&b, "swap %s %s\n", tmp, set.name)
		fmt.Fprintf(&b, "destroy %s\n", tmp)
	}
	return b.String()
}

// buildIptablesRestoreInput 生成 iptables-restore --noflush 的输入（v6=true 给 ip6tables）。
// --noflush 下声明一条已存在的自定义链会先清空它，整段在 COMMIT 时一次生效。
func buildIptablesRestoreInput(plan firewallPlan, v6 bool) string {
	suffix := "4"
	if v6 {
		suffix = "6"
	}
	set := func(name string) string { return firewallSetPrefix + name + suffix }
	var b strings.Builder
	b.WriteString("*mangle\n")
	fmt.Fprintf(&b, ":%s - [0:0]\n:%s - [0:0]\n", firewallIptChain, firewallIptCheckChain)
	fmt.Fprintf(&b, "-A %s -i lo -j RETURN\n", firewallIptChain)
	fmt.Fprintf(&b, "-A %s -m conntrack ! --ctstate NEW -j RETURN\n", firewallIptChain)
	if len(plan.TCP) > 0 {
		fmt.Fprintf(&b, "-A %s -p tcp -m set --match-set %stcp dst -j %s\n", firewallIptChain, firewallSetPrefix, firewallIptCheckChain)
	}
	if len(plan.UDP) > 0 {
		fmt.Fprintf(&b, "-A %s -p udp -m set --match-set %sudp dst -j %s\n", firewallIptChain, firewallSetPrefix, firewallIptCheckChain)
	}
	fmt.Fprintf(&b, "-A %s -m set --match-set %s src -j RETURN\n", firewallIptCheckChain, set("skip"))
	fmt.Fprintf(&b, "-A %s -m set --match-set %s src -j RETURN\n", firewallIptCheckChain, set("allow"))
	fmt.Fprintf(&b, "-A %s -m set --match-set %s src -m comment --comment %s -j DROP\n", firewallIptCheckChain, set("block"), firewallBlockComment)
	switch plan.Mode {
	case "block":
		fmt.Fprintf(&b, "-A %s -m set --match-set %s src -m comment --comment %s -j DROP\n", firewallIptCheckChain, set("geo"), firewallGeoComment)
	case "allow":
		fmt.Fprintf(&b, "-A %s -m set ! --match-set %s src -m comment --comment %s -j DROP\n", firewallIptCheckChain, set("geo"), firewallGeoComment)
	}
	b.WriteString("COMMIT\n")
	return b.String()
}

func (m *firewallModule) applyPlanLocked(plan firewallPlan) (string, error) {
	block, country := uint64(0), uint64(0)
	if m.active {
		block, country = m.readCountersLocked()
	}
	if m.runner.Has("nft") {
		out, err := m.runner.RunStdin(buildNftGuardScript(plan), "nft", "-f", "-")
		if err != nil {
			return "", fmt.Errorf("nft 写入失败：%s", firewallTrimOutput(out, err))
		}
		m.baseBlock += block
		m.baseCountry += country
		if m.backend != "nft" {
			// 换过后端，或者这是本进程第一次落规则：上一个进程可能用 iptables 留过东西。
			iptablesExecMu.Lock()
			m.cleanupIptablesLocked()
			iptablesExecMu.Unlock()
		}
		return "nft", nil
	}
	if !m.runner.Has("iptables") || !m.runner.Has("iptables-restore") {
		return "", errors.New("这台机器既没有 nft 也没有 iptables，无法拦截")
	}
	if !m.runner.Has("ipset") {
		return "", errors.New("这台机器没有 nft，也没有 ipset（apt install ipset 或 nftables 之后会自动生效）")
	}
	iptablesExecMu.Lock()
	defer iptablesExecMu.Unlock()
	if out, err := m.runner.RunStdin(buildIpsetRestoreScript(plan), "ipset", "-exist", "restore"); err != nil {
		return "", fmt.Errorf("ipset 写入失败：%s", firewallTrimOutput(out, err))
	}
	type fam struct {
		bin, restore string
		v6           bool
	}
	families := []fam{{"iptables", "iptables-restore", false}}
	if m.runner.Has("ip6tables") && m.runner.Has("ip6tables-restore") {
		families = append(families, fam{"ip6tables", "ip6tables-restore", true})
	}
	for _, f := range families {
		if out, err := m.runner.RunStdin(buildIptablesRestoreInput(plan, f.v6), f.restore, "--noflush"); err != nil {
			if f.v6 {
				logf("firewall: ip6tables-restore failed: %s", firewallTrimOutput(out, err))
				continue
			}
			return "", fmt.Errorf("iptables 写入失败：%s", firewallTrimOutput(out, err))
		}
		wait := iptablesWaitArgs()
		check := append(append([]string{}, wait...), "-t", "mangle", "-C", "PREROUTING", "-j", firewallIptChain)
		if _, err := m.runner.Run(f.bin, check...); err != nil {
			insert := append(append([]string{}, wait...), "-t", "mangle", "-I", "PREROUTING", "1", "-j", firewallIptChain)
			if out, err := m.runner.Run(f.bin, insert...); err != nil && !f.v6 {
				return "", fmt.Errorf("iptables 挂链失败：%s", firewallTrimOutput(out, err))
			}
		}
	}
	m.baseBlock += block
	m.baseCountry += country
	return "iptables", nil
}

func firewallTrimOutput(out []byte, err error) string {
	text := strings.TrimSpace(string(out))
	if len(text) > 300 {
		text = text[:300]
	}
	if text == "" && err != nil {
		text = err.Error()
	}
	return text
}

// cleanupLocked 把两种后端的东西都清掉（换过后端、或者上一个 Agent 进程留下的）。
func (m *firewallModule) cleanupLocked() {
	if m.active {
		block, country := m.readCountersLocked()
		m.baseBlock += block
		m.baseCountry += country
	}
	if m.runner.Has("nft") {
		if _, err := m.runner.Run("nft", "list", "table", "inet", firewallNftTable); err == nil {
			if out, err := m.runner.Run("nft", "delete", "table", "inet", firewallNftTable); err != nil {
				logf("firewall: nft delete table failed: %s", firewallTrimOutput(out, err))
			}
		}
	}
	iptablesExecMu.Lock()
	m.cleanupIptablesLocked()
	iptablesExecMu.Unlock()
	m.active = false
	m.backend = ""
}

// cleanupIptablesLocked 调用方要持有 iptablesExecMu。
func (m *firewallModule) cleanupIptablesLocked() {
	wait := iptablesWaitArgs()
	args := func(extra ...string) []string { return append(append([]string{}, wait...), extra...) }
	for _, bin := range []string{"iptables", "ip6tables"} {
		if !m.runner.Has(bin) {
			continue
		}
		if _, err := m.runner.Run(bin, args("-t", "mangle", "-S", firewallIptChain)...); err != nil {
			continue
		}
		for i := 0; i < 8; i++ {
			if _, err := m.runner.Run(bin, args("-t", "mangle", "-D", "PREROUTING", "-j", firewallIptChain)...); err != nil {
				break
			}
		}
		for _, chain := range []string{firewallIptChain, firewallIptCheckChain} {
			_, _ = m.runner.Run(bin, args("-t", "mangle", "-F", chain)...)
		}
		for _, chain := range []string{firewallIptChain, firewallIptCheckChain} {
			_, _ = m.runner.Run(bin, args("-t", "mangle", "-X", chain)...)
		}
	}
	if m.runner.Has("ipset") {
		for _, set := range firewallIpsets(firewallPlan{}) {
			_, _ = m.runner.Run("ipset", "destroy", set.name)
		}
	}
}

func (m *firewallModule) verifyLocked() bool {
	switch m.backend {
	case "nft":
		_, err := m.runner.Run("nft", "list", "chain", "inet", firewallNftTable, "prerouting")
		return err == nil
	case "iptables":
		args := append(append([]string{}, iptablesWaitArgs()...), "-t", "mangle", "-C", "PREROUTING", "-j", firewallIptChain)
		_, err := m.runner.Run("iptables", args...)
		return err == nil
	}
	return true
}

var nftCounterPacketsPattern = regexp.MustCompile(`packets\s+(\d+)`)

func parseNftCounterPackets(out string) uint64 {
	match := nftCounterPacketsPattern.FindStringSubmatch(out)
	if len(match) < 2 {
		return 0
	}
	n, _ := strconv.ParseUint(match[1], 10, 64)
	return n
}

// parseIptablesCommentPackets 从 `iptables -L 链 -n -v -x` 的输出里，把带这个注释的规则的包数加起来。
func parseIptablesCommentPackets(out string, comment string) uint64 {
	var total uint64
	scanner := bufio.NewScanner(strings.NewReader(out))
	marker := "/* " + comment + " */"
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.Contains(line, marker) {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		n, err := strconv.ParseUint(fields[0], 10, 64)
		if err == nil {
			total += n
		}
	}
	return total
}

func (m *firewallModule) readCountersLocked() (uint64, uint64) {
	switch m.backend {
	case "nft":
		blockOut, _ := m.runner.Run("nft", "list", "counter", "inet", firewallNftTable, "cnt_block")
		countryOut, _ := m.runner.Run("nft", "list", "counter", "inet", firewallNftTable, "cnt_country")
		return parseNftCounterPackets(string(blockOut)), parseNftCounterPackets(string(countryOut))
	case "iptables":
		var block, country uint64
		for _, bin := range []string{"iptables", "ip6tables"} {
			if !m.runner.Has(bin) {
				continue
			}
			args := append(append([]string{}, iptablesWaitArgs()...), "-t", "mangle", "-L", firewallIptCheckChain, "-n", "-v", "-x")
			out, err := m.runner.Run(bin, args...)
			if err != nil {
				continue
			}
			block += parseIptablesCommentPackets(string(out), firewallBlockComment)
			country += parseIptablesCommentPackets(string(out), firewallGeoComment)
		}
		return block, country
	}
	return 0, 0
}

var sshdPortPattern = regexp.MustCompile(`(?i)^\s*port\s+(\d+)\s*$`)
var sshdListenPattern = regexp.MustCompile(`(?i)^\s*listenaddress\s+\S*:(\d+)\s*$`)

// parseSSHDPorts 读 sshd_config 里的 Port / ListenAddress 端口。
func parseSSHDPorts(text string) []int {
	seen := map[int]bool{}
	out := []int{}
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		for _, re := range []*regexp.Regexp{sshdPortPattern, sshdListenPattern} {
			if match := re.FindStringSubmatch(line); len(match) == 2 {
				if p, err := strconv.Atoi(match[1]); err == nil && p > 0 && p <= 65535 && !seen[p] {
					seen[p] = true
					out = append(out, p)
				}
			}
		}
	}
	sort.Ints(out)
	return out
}

func readSSHDPorts() []int {
	var buf bytes.Buffer
	if data, err := os.ReadFile("/etc/ssh/sshd_config"); err == nil {
		buf.Write(data)
		buf.WriteByte('\n')
	}
	if files, err := filepath.Glob("/etc/ssh/sshd_config.d/*.conf"); err == nil {
		for _, file := range files {
			if data, err := os.ReadFile(file); err == nil {
				buf.Write(data)
				buf.WriteByte('\n')
			}
		}
	}
	ports := parseSSHDPorts(buf.String())
	has22 := false
	for _, p := range ports {
		if p == 22 {
			has22 = true
		}
	}
	if !has22 {
		ports = append([]int{22}, ports...)
	}
	return ports
}
