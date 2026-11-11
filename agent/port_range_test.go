package main

import (
	"strings"
	"testing"
)

// 下面几段是在网络命名空间里真跑面板生成的命令（server/agentActionCommands.portRange.test.ts）后
// `nft -a list table inet forwardx` / `iptables -S` 的原样输出：Agent 的就绪检查必须认得它们。
const portRangeNftListing = `table inet forwardx { # handle 1
	map fwx_pr_8_udp { # handle 11
		type inet_service : inet_service
		elements = { 21000 : 31000, 21001 : 31001, 21002 : 31002 }
	}

	chain prerouting { # handle 1
		type nat hook prerouting priority dstnat; policy accept;
		tcp dport 20000-20002 counter packets 0 bytes 0 dnat ip to 203.0.113.10 comment "fwx-rule-7-in" # handle 5
		udp dport 20000-20002 counter packets 0 bytes 0 dnat ip to 203.0.113.10 comment "fwx-rule-7-in" # handle 8
		udp dport 21000-21002 counter packets 0 bytes 0 dnat ip6 to [2001:db8::10]:udp dport map @fwx_pr_8_udp comment "fwx-rule-8-in" # handle 12
	}

	chain forward { # handle 3
		type filter hook forward priority filter; policy accept;
		ip daddr 203.0.113.10 tcp dport 20000-20002 ct original proto-dst 20000-20002 accept comment "fwx-rule-7" # handle 7
	}
}
`

const portRangeIptablesNat = `-P PREROUTING ACCEPT
-A PREROUTING -p tcp -m tcp --dport 22000:22002 -j DNAT --to-destination 203.0.113.10
-A PREROUTING -p udp -m udp --dport 23000:23002 -j DNAT --to-destination 203.0.113.11:33000-33002/23000
`

const portRangeIptablesPost = `-P POSTROUTING ACCEPT
-A POSTROUTING -d 203.0.113.10/32 -p tcp -m tcp --dport 22000:22002 -m comment --comment fwx-rule-9 -j MASQUERADE
-A POSTROUTING -d 203.0.113.11/32 -p udp -m udp --dport 33000:33002 -m comment --comment fwx-rule-10 -j MASQUERADE
`

const portRangeIptablesForward = `-P FORWARD ACCEPT
-A FORWARD -d 203.0.113.10/32 -p tcp -m tcp --dport 22000:22002 -m comment --comment fwx-rule-9 -j ACCEPT
-A FORWARD -d 203.0.113.11/32 -p udp -m udp --dport 33000:33002 -m comment --comment fwx-rule-10 -j ACCEPT
`

func portRangeSnapshot() *kernelForwardSnapshot {
	s := newKernelForwardSnapshot()
	s.nftLoaded = true
	s.nftTable = portRangeNftListing
	for key, text := range map[string]string{
		"iptables|nat|PREROUTING":  portRangeIptablesNat,
		"iptables|nat|POSTROUTING": portRangeIptablesPost,
		"iptables||FORWARD":        portRangeIptablesForward,
	} {
		s.iptablesLoaded[key] = true
		s.iptablesNatRule[key] = text
	}
	return s
}

func TestKernelLineDportSpan端口段和单端口都能读出来(t *testing.T) {
	cases := []struct {
		line       string
		proto      string
		start, end int
	}{
		{"tcp dport 20000-20002 counter packets 0 bytes 0 dnat ip to 203.0.113.10", "tcp", 20000, 20002},
		{"-A PREROUTING -p udp -m udp --dport 23000:23002 -j DNAT --to-destination 1.2.3.4", "udp", 23000, 23002},
		{"-A PREROUTING -p tcp -m tcp --dport 8080 -j DNAT --to-destination 1.2.3.4:80", "tcp", 8080, 8080},
		{"udp dport 443 counter dnat ip to 1.2.3.4:443", "udp", 443, 443},
	}
	for _, c := range cases {
		proto, start, end, ok := kernelLineDportSpan(c.line)
		if !ok || proto != c.proto || start != c.start || end != c.end {
			t.Fatalf("%q => %s %d-%d ok=%v", c.line, proto, start, end, ok)
		}
	}
	// 残留清理按起始端口认段规则。
	if _, port, ok := kernelLineDport("tcp dport 20000-20002 dnat ip to 1.2.3.4"); !ok || port != 20000 {
		t.Fatalf("range start = %d ok=%v", port, ok)
	}
	if _, _, _, ok := kernelLineDportSpan("tcp dport 20002-20000 dnat ip to 1.2.3.4"); ok {
		t.Fatal("倒过来的段不该被认成合法端口")
	}
}

func TestNft端口段同端口和平移的就绪检查(t *testing.T) {
	s := portRangeSnapshot()
	if !s.kernelRuleApplyPresent("nftables", 7, 20000, 20002, "203.0.113.10", 20000, "both") {
		t.Fatal("同端口段 TCP+UDP 应该算装好了")
	}
	if !s.kernelRuleApplyPresent("nftables", 8, 21000, 21002, "2001:db8::10", 31000, "udp") {
		t.Fatal("IPv6 平移段（映射表）应该算装好了")
	}
	// 段长不对、目标不对、映射表没了，都要判没装好，好让 Agent 重下。
	if s.kernelRuleApplyPresent("nftables", 7, 20000, 20005, "203.0.113.10", 20000, "tcp") {
		t.Fatal("段长不同不能算装好")
	}
	if s.kernelRuleApplyPresent("nftables", 7, 20000, 20002, "203.0.113.99", 20000, "tcp") {
		t.Fatal("目标地址不同不能算装好")
	}
	if s.kernelRuleApplyPresent("nftables", 7, 20000, 20002, "203.0.113.10", 30000, "tcp") {
		t.Fatal("期望平移、实际同端口，不能算装好")
	}
	noMap := portRangeSnapshot()
	noMap.nftTable = strings.Replace(portRangeNftListing, "map fwx_pr_8_udp {", "map other {", 1)
	if noMap.kernelRuleApplyPresent("nftables", 8, 21000, 21002, "2001:db8::10", 31000, "udp") {
		t.Fatal("映射表不在不能算装好")
	}
	// 单端口规则不能把同起点的段当成自己。
	if s.kernelRuleApplyPresent("nftables", 7, 20000, 0, "203.0.113.10", 20000, "tcp") {
		t.Fatal("单端口规则不能被同起点的段冒充")
	}
}

func TestIptables端口段同端口和平移的就绪检查(t *testing.T) {
	s := portRangeSnapshot()
	if !s.kernelRuleApplyPresent("iptables", 9, 22000, 22002, "203.0.113.10", 22000, "tcp") {
		t.Fatal("同端口段应该算装好了")
	}
	if !s.kernelRuleApplyPresent("iptables", 10, 23000, 23002, "203.0.113.11", 33000, "udp") {
		t.Fatal("平移段（偏移写法）应该算装好了")
	}
	if s.kernelRuleApplyPresent("iptables", 10, 23000, 23002, "203.0.113.11", 34000, "udp") {
		t.Fatal("偏移不同不能算装好")
	}
	if s.kernelRuleApplyPresent("iptables", 9, 22000, 0, "203.0.113.10", 22000, "tcp") {
		t.Fatal("单端口规则不能被同起点的段冒充")
	}
}

func TestIptables段规则的计数链按整段装(t *testing.T) {
	rule := runningRule{RuleID: 10, SourcePort: 23000, SourcePortEnd: 23002, TargetIP: "203.0.113.11", TargetPort: 33000, Protocol: "udp", ForwardType: "iptables"}
	text := strings.Join(countingRuleInstallCmds(rule), "\n")
	// 和面板 buildCountingChainCmds 生成的逐字一致（netns 实测 `iptables -S` 里也是这个）。
	for _, want := range []string{
		`FORWARD -p udp -m conntrack --ctorigdstport 23000:23002 -d 203.0.113.11 --dport 33000:33002 -m comment --comment "fwx-stat-23000:in"`,
		`FORWARD -p udp -m conntrack --ctorigdstport 23000:23002 -s 203.0.113.11 --sport 33000:33002 -m comment --comment "fwx-stat-23000:out"`,
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("missing %q in\n%s", want, text)
		}
	}
	single := rule
	single.SourcePortEnd = 0
	if strings.Contains(strings.Join(countingRuleInstallCmds(single), "\n"), "--ctorigdstport 23000:") {
		t.Fatal("单端口规则的计数链不该变成段")
	}
	if countingChainRuleSignature(rule) == countingChainRuleSignature(single) {
		t.Fatal("段长变了计数链要重装，签名必须不同")
	}
}

func Test快速转发不收端口段规则(t *testing.T) {
	ranged := localRuleState{Port: "23000", PortEnd: 23002, RuleID: 10, ForwardType: "iptables", Protocol: "udp"}
	single := localRuleState{Port: "24000", RuleID: 11, ForwardType: "nftables", Protocol: "tcp"}
	if flowOffloadCountsState(ranged) {
		t.Fatal("段规则不能进快速路径，否则段里其余端口的流量会漏计")
	}
	if !flowOffloadCountsState(single) {
		t.Fatal("单端口内核规则照旧进快速路径")
	}
	ports, tcp, udp := flowOffloadPorts([]localRuleState{ranged, single}, nil)
	if len(ports) != 1 || len(tcp) != 1 || tcp[0] != 24000 || len(udp) != 0 {
		t.Fatalf("ports=%v tcp=%v udp=%v", ports, tcp, udp)
	}
}

func Test连接清单按整段看conntrack(t *testing.T) {
	text := strings.Join([]string{
		"ipv4     2 udp      17 29 src=198.51.100.7 dst=10.0.0.1 sport=5000 dport=20001 src=203.0.113.10 dst=198.51.100.7 sport=30001 dport=5000 mark=0 use=1",
		"ipv4     2 udp      17 29 src=198.51.100.8 dst=10.0.0.1 sport=5001 dport=20003 src=203.0.113.10 dst=198.51.100.8 sport=30003 dport=5001 mark=0 use=1",
	}, "\n")
	rows := parseConntrackRowsSpan(strings.NewReader(text), 20000, 20002, map[string]bool{"udp": true})
	if len(rows) != 1 || !strings.Contains(rows[0].Peer, "198.51.100.7") {
		t.Fatalf("rows=%+v", rows)
	}
}
