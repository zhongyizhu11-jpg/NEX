package main

import (
	"errors"
	"fmt"
	"hash/fnv"
	"net/netip"
	"sort"
	"strconv"
	"strings"
)

/*
V2 隧道内核直通（面板隧道开关「内核直通」，2.3.431 / Agent 2.2.220 起）。

开着的时候，隧道上的普通规则不再经过 FXP：入口机把规则端口 DNAT 到出口机的 WireGuard 地址
（同一个端口），包在内核里直接进 nexwg；出口机在 nexwg 上把来自入口 WireGuard 地址的这个端口
DNAT 到规则目标。两头都没有用户态进程，加密只有 WireGuard 这一层。

入口那边面板下发的就是一条普通 iptables 规则（目标 = 出口 WireGuard 地址:规则端口），走 Agent
现成的 iptables 路径。出口这边的 DNAT 跟着 WireGuard 配置一起来（wireGuardSpec.Passthrough，
每条带 ruleId / 对端 / 端口 / 目标），由内核数据面在建接口和更新配置时同步，接口删掉时一起清。
入口的配置里也带一份（role=entry，不带目标），只为了告诉运行时「有内核规则在用这条隧道」：
FXP 进程全停掉以后运行时的引用计数会归零、一分钟后把接口拆掉，直通规则得靠这个引用把接口留住。

用户态数据面（wireguard-go）没有内核路由可用，直通表到了那里只记日志；面板只在两头都报告
内核数据面时才会下发直通。
*/

// wireGuardPassthroughRule 是面板下发的一条直通规则。
type wireGuardPassthroughRule struct {
	RuleID     int    `json:"ruleId"`
	Role       string `json:"role"`
	PeerID     string `json:"peerId"`
	Port       int    `json:"port"`
	Protocol   string `json:"protocol,omitempty"`
	TargetIP   string `json:"targetIp,omitempty"`
	TargetPort int    `json:"targetPort,omitempty"`
}

const (
	wireGuardPassthroughRoleEntry = "entry"
	wireGuardPassthroughRoleExit  = "exit"
	// wireGuardPassthroughRefID 是直通规则在运行时引用表里占的名字。
	wireGuardPassthroughRefID = "passthrough"
	// wireGuardPassthroughCommentPrefix 是直通 iptables 规则注释的前缀，后面跟接口名。
	wireGuardPassthroughCommentPrefix = "nex-pt-"
)

// wireGuardPassthroughSyncer 是数据面里「把直通表同步进防火墙」的那一小部分；内核数据面实现它。
type wireGuardPassthroughSyncer interface {
	syncPassthrough(spec wireGuardSpec) error
}

// normalizeWireGuardPassthrough 校验直通表：角色、端口、协议、出口的目标都要合法，对端必须在
// peers 里。按规则 id 排序、去重，让签名稳定。
func normalizeWireGuardPassthrough(rules []wireGuardPassthroughRule, peers []wireGuardPeerSpec) ([]wireGuardPassthroughRule, error) {
	if len(rules) == 0 {
		return nil, nil
	}
	known := map[string]bool{}
	for _, peer := range peers {
		known[peer.ID] = true
	}
	seen := map[string]bool{}
	out := make([]wireGuardPassthroughRule, 0, len(rules))
	for _, rule := range rules {
		rule.Role = strings.ToLower(strings.TrimSpace(rule.Role))
		rule.PeerID = strings.TrimSpace(rule.PeerID)
		rule.Protocol = normalizeRuntimeProtocol(rule.Protocol)
		rule.TargetIP = strings.TrimSpace(rule.TargetIP)
		if rule.RuleID <= 0 {
			return nil, errors.New("wireguard passthrough rule id is required")
		}
		if rule.Role != wireGuardPassthroughRoleEntry && rule.Role != wireGuardPassthroughRoleExit {
			return nil, fmt.Errorf("wireguard passthrough rule %d role %q is invalid", rule.RuleID, rule.Role)
		}
		if rule.PeerID == "" || !known[rule.PeerID] {
			return nil, fmt.Errorf("wireguard passthrough rule %d peer %q is not configured", rule.RuleID, rule.PeerID)
		}
		if rule.Port <= 0 || rule.Port > 65535 {
			return nil, fmt.Errorf("wireguard passthrough rule %d port %d is invalid", rule.RuleID, rule.Port)
		}
		if rule.Role == wireGuardPassthroughRoleExit {
			target, err := netip.ParseAddr(rule.TargetIP)
			if err != nil || !target.Unmap().Is4() || rule.TargetPort <= 0 || rule.TargetPort > 65535 {
				return nil, fmt.Errorf("wireguard passthrough rule %d target %s:%d is invalid", rule.RuleID, rule.TargetIP, rule.TargetPort)
			}
			rule.TargetIP = target.Unmap().String()
		} else {
			rule.TargetIP = ""
			rule.TargetPort = 0
		}
		key := fmt.Sprintf("%d|%s|%s|%d", rule.RuleID, rule.Role, rule.PeerID, rule.Port)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, rule)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].RuleID != out[j].RuleID {
			return out[i].RuleID < out[j].RuleID
		}
		if out[i].Role != out[j].Role {
			return out[i].Role < out[j].Role
		}
		if out[i].PeerID != out[j].PeerID {
			return out[i].PeerID < out[j].PeerID
		}
		return out[i].Port < out[j].Port
	})
	return out, nil
}

// wireGuardPassthroughFirewallRule 是一条要装进 iptables 的直通规则：表、链、参数（不含 -A/-I 链名）。
// 注释里带着内容哈希，同步时只比注释：-S 打出来的规则会被 iptables 规范化（加 /32、-m tcp），
// 逐字比参数不可靠。
type wireGuardPassthroughFirewallRule struct {
	table   string
	chain   string
	comment string
	args    []string
}

func wireGuardPassthroughComment(iface string, ruleID int, proto string, fields ...string) string {
	h := fnv.New32a()
	for _, field := range fields {
		_, _ = h.Write([]byte(field))
		_, _ = h.Write([]byte{0})
	}
	return fmt.Sprintf("%s%s-%d-%s-%08x", wireGuardPassthroughCommentPrefix, iface, ruleID, proto, h.Sum32())
}

func wireGuardPassthroughMSSComment(iface string) string {
	return wireGuardPassthroughCommentPrefix + iface + "-mss"
}

// wireGuardPassthroughFirewallRules 算出出口上这张直通表对应的全部 iptables 规则。
// 入口角色的条目不产生规则（入口的 DNAT 由面板按普通 iptables 规则下发）。
func wireGuardPassthroughFirewallRules(iface string, self string, peers map[string]string, rules []wireGuardPassthroughRule) []wireGuardPassthroughFirewallRule {
	out := []wireGuardPassthroughFirewallRule{}
	for _, rule := range rules {
		if rule.Role != wireGuardPassthroughRoleExit {
			continue
		}
		peer := peers[rule.PeerID]
		if peer == "" {
			continue
		}
		port := strconv.Itoa(rule.Port)
		targetPort := strconv.Itoa(rule.TargetPort)
		for _, proto := range runtimeProtocolList(rule.Protocol) {
			comment := wireGuardPassthroughComment(iface, rule.RuleID, proto, peer, self, port, rule.TargetIP, targetPort)
			out = append(out,
				wireGuardPassthroughFirewallRule{table: "nat", chain: "PREROUTING", comment: comment, args: []string{
					"-i", iface, "-s", peer + "/32", "-d", self + "/32", "-p", proto, "--dport", port,
					"-m", "comment", "--comment", comment, "-j", "DNAT", "--to-destination", rule.TargetIP + ":" + targetPort,
				}},
				wireGuardPassthroughFirewallRule{table: "nat", chain: "POSTROUTING", comment: comment, args: []string{
					"-s", peer + "/32", "-d", rule.TargetIP + "/32", "-p", proto, "--dport", targetPort,
					"-m", "comment", "--comment", comment, "-j", "MASQUERADE",
				}},
				wireGuardPassthroughFirewallRule{table: "filter", chain: "FORWARD", comment: comment, args: []string{
					"-i", iface, "-s", peer + "/32", "-d", rule.TargetIP + "/32", "-p", proto, "--dport", targetPort,
					"-m", "comment", "--comment", comment, "-j", "ACCEPT",
				}},
				// 同一条链里两条规则注释要不同，同步时才分得清哪条在、哪条不在。
				wireGuardPassthroughFirewallRule{table: "filter", chain: "FORWARD", comment: comment + "-ret", args: []string{
					"-o", iface, "-d", peer + "/32", "-s", rule.TargetIP + "/32", "-p", proto, "--sport", targetPort,
					"-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED",
					"-m", "comment", "--comment", comment + "-ret", "-j", "ACCEPT",
				}},
			)
		}
	}
	return out
}

// wireGuardPassthroughMSSRules 是接口出方向的 MSS 钳制：WireGuard 内层 MTU 比以太网小，不钳的话
// 对端按 1460 发的段要靠路径 MTU 发现才收得到；两头各自对出 nexwg 的 SYN / SYN-ACK 钳一次，
// 两个方向的 MSS 都压到接口 MTU 之下。
func wireGuardPassthroughMSSRules(iface string) []wireGuardPassthroughFirewallRule {
	comment := wireGuardPassthroughMSSComment(iface)
	return []wireGuardPassthroughFirewallRule{{table: "mangle", chain: "FORWARD", comment: comment, args: []string{
		"-o", iface, "-p", "tcp", "--tcp-flags", "SYN,RST", "SYN",
		"-m", "comment", "--comment", comment, "-j", "TCPMSS", "--clamp-mss-to-pmtu",
	}}}
}

// runtimeProtocolList 把 tcp / udp / both 展开成要装规则的协议列表。
func runtimeProtocolList(protocol string) []string {
	switch normalizeRuntimeProtocol(protocol) {
	case "tcp":
		return []string{"tcp"}
	case "udp":
		return []string{"udp"}
	default:
		return []string{"tcp", "udp"}
	}
}

// wireGuardPassthroughChains 是直通规则会落到的表 / 链，清理时逐个扫。
var wireGuardPassthroughChains = [][2]string{
	{"nat", "PREROUTING"},
	{"nat", "POSTROUTING"},
	{"filter", "FORWARD"},
	{"mangle", "FORWARD"},
}

// wireGuardPassthroughInstalledComments 从 `iptables -t X -S CHAIN` 的输出里挑出带本接口直通注释的
// 规则，返回注释 → 删除参数（-S 的一行去掉 "-A CHAIN"）。
func wireGuardPassthroughInstalledComments(listing string, iface string) map[string][]string {
	prefix := wireGuardPassthroughCommentPrefix + iface + "-"
	out := map[string][]string{}
	for _, line := range strings.Split(listing, "\n") {
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) < 3 || fields[0] != "-A" {
			continue
		}
		comment := ""
		for i := 0; i+1 < len(fields); i++ {
			if fields[i] == "--comment" {
				comment = strings.Trim(fields[i+1], "\"")
				break
			}
		}
		if comment == "" || !strings.HasPrefix(comment, prefix) {
			continue
		}
		out[comment] = append([]string(nil), fields[2:]...)
	}
	return out
}
