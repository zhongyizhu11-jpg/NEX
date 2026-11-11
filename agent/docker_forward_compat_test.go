package main

import (
	"errors"
	"fmt"
	"strings"
	"testing"
)

// 面板生成的命令（server/dockerForwardCompat.ts）和 Agent 从内核读回来的就绪结论之间的契约：
// 内核转发规则只有在 ForwardX 自己那段转发路径、以及 Docker 主机上要的 DOCKER-USER 放行都在时才算就绪。
// 全部用 iptables-save / nft 输出做夹具，不碰真防火墙。

const dcTarget = "203.0.113.10"

// sha1("203.0.113.10:443") 的前 8 位，独立算好写死，不靠被测代码。
const dcTargetDigest = "3b5b6cf2"

func dcNftTable(ruleID int, sourcePort int, protocols ...string) string {
	var out strings.Builder
	out.WriteString("table inet forwardx { # handle 1\n")
	out.WriteString("\tchain prerouting { # handle 1\n\t\ttype nat hook prerouting priority dstnat; policy accept;\n")
	for _, proto := range protocols {
		fmt.Fprintf(&out, "\t\tmeta l4proto %s %s dport %d counter packets 0 bytes 0 dnat ip to %s:443 comment \"fwx-rule-%d-in\" # handle 5\n", proto, proto, sourcePort, dcTarget, ruleID)
	}
	out.WriteString("\t}\n\tchain postrouting { # handle 2\n\t\ttype nat hook postrouting priority srcnat; policy accept;\n")
	out.WriteString("\t\tct status dnat masquerade comment \"fwx-dnat-masquerade\" # handle 4\n\t}\n")
	out.WriteString("\tchain forward { # handle 3\n\t\ttype filter hook forward priority filter; policy accept;\n")
	for _, proto := range protocols {
		fmt.Fprintf(&out, "\t\tmeta l4proto %s ip saddr %s %s sport 443 ct original proto-dst %d ct state established,related counter packets 0 bytes 0 accept comment \"fwx-rule-%d-out\" # handle 6\n", proto, dcTarget, proto, sourcePort, ruleID)
		fmt.Fprintf(&out, "\t\tmeta l4proto %s ip daddr %s %s dport 443 ct original proto-dst %d accept comment \"fwx-rule-%d\" # handle 7\n", proto, dcTarget, proto, sourcePort, ruleID)
	}
	out.WriteString("\t}\n}\n")
	return out.String()
}

func dcAllowance(ruleID int, sourcePort int, proto string, direction string) string {
	comment := fmt.Sprintf("fwx-docker-%d-%d-%s-%s-%s", ruleID, sourcePort, proto, direction, dcTargetDigest)
	if direction == "in" {
		return fmt.Sprintf("-A DOCKER-USER -d %s/32 -p %s -m %s --dport 443 -m conntrack --ctorigdstport %d -m comment --comment %s -j ACCEPT", dcTarget, proto, proto, sourcePort, comment)
	}
	return fmt.Sprintf("-A DOCKER-USER -s %s/32 -p %s -m %s --sport 443 -m conntrack --ctstate RELATED,ESTABLISHED --ctorigdstport %d --ctdir REPLY -m comment --comment %s -j ACCEPT", dcTarget, proto, proto, sourcePort, comment)
}

func dcAllAllowances(ruleID int, sourcePort int, protocols ...string) []string {
	rules := []string{}
	for _, proto := range protocols {
		rules = append(rules, dcAllowance(ruleID, sourcePort, proto, "in"), dcAllowance(ruleID, sourcePort, proto, "out"))
	}
	return rules
}

type dcFront struct {
	forward    string
	dockerUser string
	forwardErr error
	userErr    error
	tableErr   error
	noChain    bool
}

type dcHost struct {
	ipForward string
	tools     map[string]bool
	legacy    string
	fronts    map[string]*dcFront
	restores  []string
}

func dcDockerFront(rules ...string) *dcFront {
	return &dcFront{
		forward:    "-P FORWARD DROP\n-A FORWARD -j DOCKER-USER\n-A FORWARD -j DOCKER-FORWARD\n",
		dockerUser: "-N DOCKER-USER\n" + strings.Join(rules, "\n") + "\n",
	}
}

func dcPlainHost() *dcHost {
	return &dcHost{ipForward: "1\n", tools: map[string]bool{}, fronts: map[string]*dcFront{}}
}

func dcDockerHost(rules ...string) *dcHost {
	host := dcPlainHost()
	host.tools = map[string]bool{"iptables-nft": true, "iptables-legacy": true}
	host.fronts["iptables-nft"] = dcDockerFront(rules...)
	host.fronts["iptables-legacy"] = &dcFront{forward: "-P FORWARD ACCEPT\n"}
	host.legacy = "filter\n"
	return host
}

func (h *dcHost) snapshot(nft string) *kernelForwardSnapshot {
	s := newKernelForwardSnapshot()
	s.nftLoaded = true
	s.nftTable = nft
	s.env = &kernelForwardEnv{
		readFile: func(path string) ([]byte, error) {
			switch path {
			case kernelIPv4ForwardPath:
				return []byte(h.ipForward), nil
			case kernelLegacyTablesPath:
				return []byte(h.legacy), nil
			}
			return nil, errors.New("not found")
		},
		hasCommand: func(name string) bool { return h.tools[name] },
		runIptables: func(binary string, args ...string) ([]byte, error) {
			front, ok := h.fronts[binary]
			if !ok {
				return nil, errors.New("no such front end")
			}
			switch strings.Join(args, " ") {
			case "-S FORWARD":
				return []byte(front.forward), front.forwardErr
			case "-S DOCKER-USER":
				if front.noChain {
					return nil, errors.New("iptables: No chain/target/match by that name.")
				}
				return []byte(front.dockerUser), front.userErr
			case "-S":
				if front.tableErr != nil {
					return nil, front.tableErr
				}
				if front.noChain {
					return []byte("-P FORWARD DROP\n"), nil
				}
				return []byte("-P FORWARD DROP\n-N DOCKER-USER\n"), nil
			}
			return nil, errors.New("unexpected iptables call: " + strings.Join(args, " "))
		},
		runRestore: func(binary string, input string) error {
			h.restores = append(h.restores, binary+"\n"+input)
			front := h.fronts[binary]
			for _, line := range strings.Split(input, "\n") {
				if !strings.HasPrefix(line, "-D ") {
					continue
				}
				want := "-A " + strings.TrimPrefix(line, "-D ")
				kept := []string{}
				removed := false
				for _, existing := range strings.Split(front.dockerUser, "\n") {
					if !removed && kernelNormalizeLine(existing) == want {
						removed = true
						continue
					}
					kept = append(kept, existing)
				}
				if !removed {
					return errors.New("Bad rule: " + line)
				}
				front.dockerUser = strings.Join(kept, "\n")
			}
			return nil
		},
	}
	return s
}

func dcReason(s *kernelForwardSnapshot, protocol string) string {
	return s.nftForwardRuleNotReadyReason(42, 22022, dcTarget, 443, protocol)
}

func TestNftReadinessChecksTheWholeForwardingPath(t *testing.T) {
	complete := dcNftTable(42, 22022, "tcp", "udp")
	if reason := dcReason(dcPlainHost().snapshot(complete), "both"); reason != "" {
		t.Fatalf("complete path on a host without Docker should be ready, got %q", reason)
	}
	cases := []struct {
		name   string
		nft    string
		ipFwd  string
		expect string
	}{
		{"no table", "", "1", "table is missing"},
		{"ip_forward off", complete, "0", "ip_forward"},
		{"no masquerade", strings.Replace(complete, "ct status dnat masquerade", "counter", 1), "1", "masquerade"},
		{"no forward accept", strings.Replace(complete, "ip daddr 203.0.113.10 tcp dport 443", "ip daddr 203.0.113.99 tcp dport 443", 1), "1", "forward accept"},
		{"no return accept", strings.Replace(complete, "ip saddr 203.0.113.10 udp sport 443", "ip saddr 203.0.113.10 udp sport 4430", 1), "1", "return accept"},
		{"dnat to old target", strings.Replace(complete, "dnat ip to 203.0.113.10:443", "dnat ip to 198.51.100.1:443", 1), "1", "DNAT"},
	}
	for _, item := range cases {
		host := dcPlainHost()
		host.ipForward = item.ipFwd
		reason := dcReason(host.snapshot(item.nft), "both")
		if !strings.Contains(reason, item.expect) {
			t.Fatalf("%s: reason = %q, want it to mention %q", item.name, reason, item.expect)
		}
	}
	// 改成只要 TCP 之后，UDP 那几条还在就是没收敛。
	if reason := dcReason(dcPlainHost().snapshot(complete), "tcp"); !strings.Contains(reason, "stale udp") {
		t.Fatalf("leftover udp rules should be reported, got %q", reason)
	}
	// IPv6 / 没解析的目标保持只看 DNAT。
	v6 := "table inet forwardx {\n chain prerouting {\n meta l4proto tcp tcp dport 22022 dnat ip6 to [2001:db8::1]:443 comment \"fwx-rule-42-in\"\n }\n}\n"
	if reason := dcPlainHost().snapshot(v6).nftForwardRuleNotReadyReason(42, 22022, "2001:db8::1", 443, "tcp"); reason != "" {
		t.Fatalf("IPv6 target keeps DNAT-only readiness, got %q", reason)
	}
}

func TestNftReadinessRequiresDockerAllowance(t *testing.T) {
	complete := dcNftTable(42, 22022, "tcp")
	reason := dcReason(dcDockerHost().snapshot(complete), "tcp")
	if !strings.Contains(reason, "iptables-nft: DOCKER-USER allowance missing for 22022/tcp (in)") {
		t.Fatalf("missing allowance should be reported with the front end, got %q", reason)
	}
	host := dcDockerHost(append([]string{"-A DOCKER-USER -s 198.51.100.0/24 -j DROP"}, append(dcAllAllowances(42, 22022, "tcp"), "-A DOCKER-USER -j RETURN")...)...)
	if reason := dcReason(host.snapshot(complete), "tcp"); reason != "" {
		t.Fatalf("allowances present should be ready, got %q", reason)
	}
	// 返程那条少了 --ctdir REPLY 就不算（会放开目标主动连进来的流量）。
	weak := strings.Replace(dcAllowance(42, 22022, "tcp", "out"), " --ctdir REPLY", "", 1)
	host = dcDockerHost(dcAllowance(42, 22022, "tcp", "in"), weak)
	if reason := dcReason(host.snapshot(complete), "tcp"); !strings.Contains(reason, "(out)") {
		t.Fatalf("a return allowance without --ctdir REPLY must not count, got %q", reason)
	}
}

func TestDockerAllowanceJudgedPerFrontEnd(t *testing.T) {
	complete := dcNftTable(42, 22022, "tcp")
	// legacy 前端是 Docker 的那套，nft 前端没 Docker：放行要在 legacy 里。
	host := dcPlainHost()
	host.tools = map[string]bool{"iptables-nft": true, "iptables-legacy": true}
	host.legacy = "filter\n"
	host.fronts["iptables-nft"] = &dcFront{forward: "-P FORWARD ACCEPT\n"}
	host.fronts["iptables-legacy"] = dcDockerFront()
	if reason := dcReason(host.snapshot(complete), "tcp"); !strings.Contains(reason, "iptables-legacy") {
		t.Fatalf("legacy Docker front end should be judged on its own, got %q", reason)
	}
	// legacy 表没加载：不读它（读了会拉起内核模块）。
	host.legacy = ""
	if reason := dcReason(host.snapshot(complete), "tcp"); reason != "" {
		t.Fatalf("unloaded legacy tables must not be read, got %q", reason)
	}
	// 列不出 FORWARD 的前端（容器里没有 nf_tables）不算。
	host = dcPlainHost()
	host.tools = map[string]bool{"iptables-nft": true}
	host.fronts["iptables-nft"] = &dcFront{forwardErr: errors.New("Protocol not supported")}
	if reason := dcReason(host.snapshot(complete), "tcp"); reason != "" {
		t.Fatalf("an unusable front end is skipped, got %q", reason)
	}
	// FORWARD 默认 DROP 但不跳 DOCKER-USER（ufw / 自定义防火墙）：不判断。
	host = dcPlainHost()
	host.tools = map[string]bool{"iptables": true}
	host.fronts["iptables"] = &dcFront{forward: "-P FORWARD DROP\n-A FORWARD -j ufw-before-forward\n"}
	if reason := dcReason(host.snapshot(complete), "tcp"); reason != "" {
		t.Fatalf("non-Docker layouts are not judged, got %q", reason)
	}
	// DOCKER-USER 读不出来（锁忙）：说明原因，不当成「放行在」。
	host = dcDockerHost()
	host.fronts["iptables-nft"].userErr = errors.New("Another app is currently holding the xtables lock")
	if reason := dcReason(host.snapshot(complete), "tcp"); !strings.Contains(reason, "cannot read DOCKER-USER") {
		t.Fatalf("an unreadable chain must be reported, got %q", reason)
	}
}

func TestDockerStaleAllowancesAreNotConverged(t *testing.T) {
	complete := dcNftTable(42, 22022, "tcp")
	oldTarget := strings.ReplaceAll(dcAllowance(42, 22022, "tcp", "in"), dcTarget, "192.0.2.1")
	host := dcDockerHost(append(dcAllAllowances(42, 22022, "tcp"), oldTarget)...)
	if reason := dcReason(host.snapshot(complete), "tcp"); !strings.Contains(reason, "stale DOCKER-USER") {
		t.Fatalf("allowance for an old target should block convergence, got %q", reason)
	}
	// 同端口同协议的前任规则留下的放行也是。
	previous := dcAllowance(7, 22022, "tcp", "in")
	host = dcDockerHost(append(dcAllAllowances(42, 22022, "tcp"), previous)...)
	if reason := dcReason(host.snapshot(complete), "tcp"); !strings.Contains(reason, "fwx-docker-7-22022-tcp-in") {
		t.Fatalf("previous owner's allowance should be reported, got %q", reason)
	}
	// 同端口另一种协议上别的规则的放行不算这条规则的事。
	other := dcAllowance(7, 22022, "udp", "in")
	host = dcDockerHost(append(dcAllAllowances(42, 22022, "tcp"), other)...)
	if reason := dcReason(host.snapshot(complete), "tcp"); reason != "" {
		t.Fatalf("another rule on the other protocol is not stale, got %q", reason)
	}
}

func TestIptablesReadinessChecksReturnAndDocker(t *testing.T) {
	nat := "-P PREROUTING ACCEPT\n-A PREROUTING -p tcp -m tcp --dport 22022 -j DNAT --to-destination 203.0.113.10:443\n"
	post := "-P POSTROUTING ACCEPT\n-A POSTROUTING -d 203.0.113.10/32 -p tcp -m tcp --dport 443 -m comment --comment fwx-rule-42 -j MASQUERADE\n"
	forward := "-P FORWARD ACCEPT\n-A FORWARD -d 203.0.113.10/32 -p tcp -m tcp --dport 443 -m comment --comment fwx-rule-42 -j ACCEPT\n" +
		"-A FORWARD -s 203.0.113.10/32 -p tcp -m tcp --sport 443 -m state --state RELATED,ESTABLISHED -m comment --comment fwx-rule-42 -j ACCEPT\n"
	build := func(host *dcHost, forwardText string) *kernelForwardSnapshot {
		s := host.snapshot("")
		s.iptablesLoaded["iptables|nat|PREROUTING"] = true
		s.iptablesNatRule["iptables|nat|PREROUTING"] = nat
		s.iptablesLoaded["iptables|nat|POSTROUTING"] = true
		s.iptablesNatRule["iptables|nat|POSTROUTING"] = post
		s.iptablesLoaded["iptables||FORWARD"] = true
		s.iptablesNatRule["iptables||FORWARD"] = forwardText
		return s
	}
	reason := func(s *kernelForwardSnapshot) string {
		return s.iptablesForwardRuleNotReadyReason(42, 22022, dcTarget, 443, "tcp")
	}
	if got := reason(build(dcPlainHost(), forward)); got != "" {
		t.Fatalf("complete iptables path should be ready, got %q", got)
	}
	noReturn := strings.Split(forward, "\n")[0] + "\n" + strings.Split(forward, "\n")[1] + "\n"
	if got := reason(build(dcPlainHost(), noReturn)); !strings.Contains(got, "return accept") {
		t.Fatalf("missing return accept should be reported, got %q", got)
	}
	host := dcPlainHost()
	host.ipForward = "0"
	if got := reason(build(host, forward)); !strings.Contains(got, "ip_forward") {
		t.Fatalf("ip_forward off should be reported, got %q", got)
	}
	if got := reason(build(dcDockerHost(), forward)); !strings.Contains(got, "DOCKER-USER allowance missing") {
		t.Fatalf("Docker host without allowance should be reported, got %q", got)
	}
	if got := reason(build(dcDockerHost(dcAllAllowances(42, 22022, "tcp")...), forward)); got != "" {
		t.Fatalf("Docker host with allowance should be ready, got %q", got)
	}
}

func TestDockerResidueAndLocalCleanup(t *testing.T) {
	host := dcDockerHost(append([]string{"-A DOCKER-USER -s 198.51.100.0/24 -j DROP"}, append(append(dcAllAllowances(42, 22022, "tcp", "udp"), dcAllAllowances(7, 30000, "tcp")...), "-A DOCKER-USER -j RETURN")...)...)
	if !host.snapshot("").dockerCompatResidue(42, 22022, "both") {
		t.Fatalf("allowances of rule 42 are residue")
	}
	if !host.snapshot("").cleanupDockerCompatAllowances(42, 0, nil) {
		t.Fatalf("cleanup should succeed")
	}
	if host.snapshot("").dockerCompatResidue(42, 22022, "both") {
		t.Fatalf("rule 42 allowances should be gone: %s", host.fronts["iptables-nft"].dockerUser)
	}
	user := host.fronts["iptables-nft"].dockerUser
	if !strings.Contains(user, "fwx-docker-7-30000-tcp-in") || !strings.Contains(user, "198.51.100.0/24 -j DROP") || !strings.Contains(user, "-j RETURN") {
		t.Fatalf("other rules and the administrator's rules must stay:\n%s", user)
	}
	if len(host.restores) != 1 || !strings.HasPrefix(host.restores[0], "iptables-nft\n*filter\n-D DOCKER-USER ") || !strings.HasSuffix(host.restores[0], "COMMIT\n") {
		t.Fatalf("removal should be one restore transaction by rule content, got %q", host.restores)
	}
	// 按端口删只删给出的协议。
	host = dcDockerHost(append(dcAllAllowances(42, 22022, "tcp"), dcAllAllowances(8, 22022, "udp")...)...)
	host.snapshot("").cleanupDockerCompatAllowances(0, 22022, []string{"tcp"})
	user = host.fronts["iptables-nft"].dockerUser
	if strings.Contains(user, "fwx-docker-42-") || !strings.Contains(user, "fwx-docker-8-22022-udp") {
		t.Fatalf("port cleanup should only remove the given protocol:\n%s", user)
	}
	// 读不出链：删除没法确认，残留按「还在」算。
	host = dcDockerHost()
	host.fronts["iptables-nft"].userErr = errors.New("lock")
	if !host.snapshot("").dockerCompatResidue(42, 22022, "tcp") {
		t.Fatalf("an unreadable chain on a Docker front end leaves removal unconfirmed")
	}
	if host.snapshot("").cleanupDockerCompatAllowances(42, 22022, []string{"tcp"}) {
		t.Fatalf("cleanup cannot be confirmed when the chain cannot be read")
	}
	// 链不存在：没有残留。
	host = dcDockerHost()
	host.fronts["iptables-nft"].noChain = true
	host.fronts["iptables-nft"].forward = "-P FORWARD ACCEPT\n"
	if host.snapshot("").dockerCompatResidue(42, 22022, "tcp") {
		t.Fatalf("a missing chain holds no residue")
	}
}

func TestKernelForwardFailureDetailPrefersDockerCompat(t *testing.T) {
	out := "[nftables] counter rule failed, fallback=x [docker-compat] iptables-nft: cannot install DOCKER-USER allowance for rule 42 port 22022/tcp (in)"
	if got := kernelForwardFailureDetail(out); !strings.HasPrefix(got, "[docker-compat] iptables-nft: cannot install") {
		t.Fatalf("detail = %q", got)
	}
	if got := kernelForwardFailureDetail("exit status 1"); got != "exit status 1" {
		t.Fatalf("plain detail = %q", got)
	}
}
