package main

import (
	"fmt"
	"net"
	"strconv"
	"strings"
)

func nftRuleCleanupCmd(ruleID int) string {
	id := strconv.Itoa(ruleID)
	comment := "fwx-rule-" + id
	return "if nft list table inet forwardx >/dev/null 2>&1; then for c in prerouting postrouting forward traffic_prerouting traffic_postrouting traffic_forward; do for h in $(nft -a list chain inet forwardx \"$c\" 2>/dev/null | awk -v marker=\"" + comment + "\" '$0 ~ marker {print $NF}'); do nft delete rule inet forwardx \"$c\" handle \"$h\" 2>/dev/null; true; done; done; nft flush chain inet forwardx in_" + id + " 2>/dev/null; true; nft delete chain inet forwardx in_" + id + " 2>/dev/null; true; nft flush chain inet forwardx out_" + id + " 2>/dev/null; true; nft delete chain inet forwardx out_" + id + " 2>/dev/null; true; fi; true"
}

func nftPortCleanupCmd(port string, protocol string) string {
	if !shellSafePort(port) {
		return unsafeShellPortNoop("nftPortCleanupCmd", port)
	}
	protos := []string{"tcp", "udp"}
	if protocol == "tcp" || protocol == "udp" {
		protos = []string{protocol}
	}
	parts := make([]string, 0, len(protos))
	for _, proto := range protos {
		awk := fmt.Sprintf(`awk '/ %s dport %s( |$)/ && / dnat / {print $NF}'`, proto, port)
		parts = append(parts, fmt.Sprintf(`if nft list chain inet forwardx prerouting >/dev/null 2>&1; then for h in $(nft -a list chain inet forwardx prerouting 2>/dev/null | %s); do nft delete rule inet forwardx prerouting handle "$h" 2>/dev/null; true; done; fi`, awk))
	}
	return strings.Join(parts, "; ") + "; true"
}

func iptablesAgentBinaries() []string {
	return []string{"iptables", "ip6tables"}
}

func iptablesAgentAddress(value string) string {
	text := strings.TrimSpace(value)
	text = strings.TrimPrefix(strings.TrimSuffix(text, "]"), "[")
	return text
}

func iptablesAgentBinaryForTarget(targetIP string) string {
	if strings.Contains(iptablesAgentAddress(targetIP), ":") {
		return "ip6tables"
	}
	return "iptables"
}

func iptablesAgentIsIPAddress(value string) bool {
	return net.ParseIP(iptablesAgentAddress(value)) != nil
}

func iptablesAgentCountingForwardTargetRule(proto, port, target, targetPort string, inbound bool) string {
	match := fmt.Sprintf("-s %s --sport %s", target, targetPort)
	if inbound {
		match = fmt.Sprintf("-d %s --dport %s", target, targetPort)
	}
	return fmt.Sprintf("FORWARD -p %s -m conntrack --ctorigdstport %s %s", proto, port, match)
}

// iptablesAgentBin 返回带锁等待参数占位的 iptables 调用前缀，见 iptables_wait.go。
func iptablesAgentBin(binary string) string {
	return binary + " " + iptablesWaitShellArg
}

func iptablesAgentCommand(binary string, args string, optional bool) string {
	if binary == "ip6tables" {
		if optional {
			return "if command -v ip6tables >/dev/null 2>&1; then " + iptablesAgentBin("ip6tables") + " " + args + "; fi; true"
		}
		return "if command -v ip6tables >/dev/null 2>&1; then " + iptablesAgentBin("ip6tables") + " " + args + "; else exit 1; fi"
	}
	cmd := iptablesAgentBin("iptables") + " " + args
	if optional {
		return cmd + "; true"
	}
	return cmd
}

// iptablesAgentEnsureShell 只在 -C 明确返回 1（规则不存在）时才追加。
// 退出码 4（xtables 锁忙）、2（参数/模块问题）等都不代表“不存在”，此时追加只会造出重复规则
// ——计数规则重复就是流量被数两遍——所以直接失败，交给下一轮重试。
func iptablesAgentEnsureShell(bin string, tableArg string, rule string, appendFlag string) string {
	return bin + " " + tableArg + "-C " + rule + " 2>/dev/null; __fwx_rc=$?; if [ \"$__fwx_rc\" -eq 1 ]; then " + bin + " " + tableArg + appendFlag + " " + rule + "; elif [ \"$__fwx_rc\" -ne 0 ]; then echo \"[iptables] check failed rc=$__fwx_rc, skip append\" >&2; false; fi"
}

func iptablesAgentEnsure(binary string, table string, rule string) string {
	tableArg := ""
	if table != "" {
		tableArg = "-t " + table + " "
	}
	cmd := iptablesAgentEnsureShell(iptablesAgentBin(binary), tableArg, rule, "-A")
	if binary == "ip6tables" {
		return "if command -v ip6tables >/dev/null 2>&1; then " + cmd + "; fi"
	}
	return cmd
}

func iptablesAgentDelete(binary string, table string, rule string) string {
	tableArg := ""
	if table != "" {
		tableArg = "-t " + table + " "
	}
	bin := iptablesAgentBin(binary)
	cmd := "while " + bin + " " + tableArg + "-C " + rule + " 2>/dev/null; do if " + bin + " " + tableArg + "-D " + rule + " 2>/dev/null; then :; else break; fi; done"
	if binary == "ip6tables" {
		return "if command -v ip6tables >/dev/null 2>&1; then " + cmd + "; fi; true"
	}
	return cmd + "; true"
}

func iptablesAgentDeleteByComment(binary string, table string, marker string) string {
	tableArg := ""
	if table != "" {
		tableArg = "-t " + table + " "
	}
	bin := iptablesAgentBin(binary)
	cmd := fmt.Sprintf(`%s %s-S 2>/dev/null | awk -v marker=%s '/^-A / {chain=$2; position[chain]++; if (index($0, marker)) {count++; chains[count]=chain; numbers[count]=position[chain]}} END {for (i=count; i>=1; i--) print chains[i], numbers[i]}' | while read -r chain number; do [ -n "$chain" ] && [ -n "$number" ] && %s %s-D "$chain" "$number" 2>/dev/null || true; done`, bin, tableArg, shellQuote(marker), bin, tableArg)
	if binary == "ip6tables" {
		return "if command -v ip6tables >/dev/null 2>&1; then " + cmd + "; fi; true"
	}
	return cmd + "; true"
}

// iptablesAgentDeleteByRuleTag 按 `--comment fwx-rule-<id>` 精确删除（不会误删 fwx-rule-<id>0）。
// 每条规则自己的 MASQUERADE / FORWARD 放行都带这个标记，删一条规则不会动到共享同一目标的其它规则。
func iptablesAgentDeleteByRuleTag(binary string, table string, chain string, ruleID int) string {
	if ruleID <= 0 {
		return ""
	}
	tableArg := ""
	if table != "" {
		tableArg = "-t " + table + " "
	}
	bin := iptablesAgentBin(binary)
	tag := iptablesRuleTag(ruleID)
	cmd := fmt.Sprintf(`%s %s-S %s 2>/dev/null | awk -v tag=%s '/^-A / {position++; for (i=1; i<NF; i++) if ($i=="--comment") {c=$(i+1); gsub(/"/, "", c); if (c==tag) {count++; numbers[count]=position; break}}} END {for (i=count; i>=1; i--) print numbers[i]}' | while read -r number; do [ -n "$number" ] && %s %s-D %s "$number" 2>/dev/null || true; done`, bin, tableArg, chain, shellQuote(tag), bin, tableArg, chain)
	if binary == "ip6tables" {
		return "if command -v ip6tables >/dev/null 2>&1; then " + cmd + "; fi; true"
	}
	return cmd + "; true"
}

func iptablesRuleTag(ruleID int) string {
	return "fwx-rule-" + strconv.Itoa(ruleID)
}

func iptablesAgentDeleteCountingRules(binary string, port string) string {
	if !shellSafePort(port) {
		return unsafeShellPortNoop("iptablesAgentDeleteCountingRules", port)
	}
	marker := "fwx-stat-" + port + ":"
	inChain := "FWX_IN_" + port
	outChain := "FWX_OUT_" + port
	bin := iptablesAgentBin(binary)
	cmd := fmt.Sprintf(`%s -t mangle -S 2>/dev/null | awk -v marker=%s -v in_chain=%s -v out_chain=%s '/^-A / {chain=$2; position[chain]++; matched=index($0, marker)>0; if (!matched) for (i=1; i<=NF; i++) if ($i==in_chain || $i==out_chain) {matched=1; break} if (matched) {count++; chains[count]=chain; numbers[count]=position[chain]}} END {for (i=count; i>=1; i--) print chains[i], numbers[i]}' | while read -r chain number; do [ -n "$chain" ] && [ -n "$number" ] && %s -t mangle -D "$chain" "$number" 2>/dev/null || true; done`, bin, shellQuote(marker), shellQuote(inChain), shellQuote(outChain), bin)
	if binary == "ip6tables" {
		return "if command -v ip6tables >/dev/null 2>&1; then " + cmd + "; fi; true"
	}
	return cmd + "; true"
}

// iptablesAgentDedupeCountingRules 删掉同一链里逐字相同的重复计数规则，只保留第一条
// （保留下来的那条计数器不动）。重复来自旧版本 `-C || -A` 在 xtables 锁忙时的重复追加。
func iptablesAgentDedupeCountingRules(binary string, port string) string {
	if !shellSafePort(port) {
		return unsafeShellPortNoop("iptablesAgentDedupeCountingRules", port)
	}
	marker := "fwx-stat-" + port + ":"
	bin := iptablesAgentBin(binary)
	cmd := fmt.Sprintf(`%s -t mangle -S 2>/dev/null | awk -v marker=%s '/^-A / {chain=$2; position[chain]++; if (index($0, marker) && seen[$0]++) {count++; chains[count]=chain; numbers[count]=position[chain]}} END {for (i=count; i>=1; i--) print chains[i], numbers[i]}' | while read -r chain number; do [ -n "$chain" ] && [ -n "$number" ] && %s -t mangle -D "$chain" "$number" 2>/dev/null || true; done`, bin, shellQuote(marker), bin)
	if binary == "ip6tables" {
		return "if command -v ip6tables >/dev/null 2>&1; then " + cmd + "; fi; true"
	}
	return cmd + "; true"
}

func iptablesAgentFlush(binary string, table string, chain string) string {
	return iptablesAgentCommand(binary, "-t "+table+" -F "+chain+" 2>/dev/null", true)
}

func iptablesAgentDeleteChain(binary string, table string, chain string) string {
	return iptablesAgentCommand(binary, "-t "+table+" -X "+chain+" 2>/dev/null", true)
}

func iptablesAgentDnatTarget(targetIP string, targetPort int) string {
	host := iptablesAgentAddress(targetIP)
	port := strconv.Itoa(targetPort)
	if strings.Contains(host, ":") {
		return "[" + host + "]:" + port
	}
	return host + ":" + port
}

func iptablesAgentDeleteDnatRulesForPort(binary string, port string, protocol string) string {
	if !shellSafePort(port) {
		return unsafeShellPortNoop("iptablesAgentDeleteDnatRulesForPort", port)
	}
	protos := []string{"tcp", "udp"}
	if protocol == "tcp" || protocol == "udp" {
		protos = []string{protocol}
	}
	parts := make([]string, 0, len(protos))
	for _, proto := range protos {
		awk := fmt.Sprintf(`awk '/^-A PREROUTING / && / -p %s / && /--dport %s( |$)/ && / -j DNAT / {sub(/^-A/, "-D"); print}'`, proto, port)
		bin := iptablesAgentBin(binary)
		parts = append(parts, fmt.Sprintf(`while rule=$(%s -t nat -S PREROUTING 2>/dev/null | %s | head -n 1) && [ -n "$rule" ]; do %s -t nat $rule 2>/dev/null || break; done`, bin, awk, bin))
	}
	cmd := strings.Join(parts, "; ")
	if binary == "ip6tables" {
		return "if command -v ip6tables >/dev/null 2>&1; then " + cmd + "; fi; true"
	}
	return cmd + "; true"
}

// iptablesAgentTargetCleanupCmds 清理一条 iptables 规则在目标侧留下的 DNAT / SNAT / FORWARD / 计数规则。
//
// MASQUERADE 与 FORWARD 放行只按目标（-d target --dport tport）匹配，多条规则转发到同一个目标时
// 旧版本共用同一份：删掉其中一条规则会把共享的那份一起删掉，另一条规则随即断流。
// 现在每条规则的这两段都带 `-m comment --comment fwx-rule-<id>`，按标记删除只动自己那份；
// 旧 Agent/面板留下的无标记副本，只有在本机没有别的规则还在用同一目标时才删：
//   - Agent 期望状态里没有其它 iptables 规则指向这个目标；
//   - 内核 nat PREROUTING 里也没有别的端口 DNAT 到这个目标（面板直接下发、期望状态尚未同步时的兜底）。
//
// 读取 PREROUTING 失败时宁可保留无标记副本（最多留一条无害的放行/伪装），也不误删。
func iptablesAgentTargetCleanupCmds(ruleID int, port string, targetIP string, targetPort int, protocol string) []string {
	if !shellSafePort(port) || !iptablesAgentIsIPAddress(targetIP) || targetPort <= 0 {
		return nil
	}
	target := iptablesAgentAddress(targetIP)
	if parsed := net.ParseIP(target); parsed != nil {
		target = parsed.String()
	}
	targetPortText := strconv.Itoa(targetPort)
	binary := iptablesAgentBinaryForTarget(target)
	dnatTarget := iptablesAgentDnatTarget(target, targetPort)
	inMarker := "fwx-stat-" + port + ":in"
	outMarker := "fwx-stat-" + port + ":out"
	commands := []string{}
	if ruleID > 0 {
		commands = append(commands,
			iptablesAgentDeleteByRuleTag(binary, "nat", "POSTROUTING", ruleID),
			iptablesAgentDeleteByRuleTag(binary, "", "FORWARD", ruleID),
		)
	}
	for _, proto := range runtimeProtocols(protocol) {
		stateMatch := ""
		if proto == "tcp" {
			stateMatch = "-m state --state ESTABLISHED,RELATED "
		}
		commands = append(commands, iptablesAgentDelete(binary, "nat", fmt.Sprintf(`PREROUTING -p %s --dport %s -j DNAT --to-destination %s`, proto, port, dnatTarget)))
		if !iptablesTargetSharedByOtherDesiredRule(ruleID, atoi(port), target, targetPort, proto) {
			legacy := []string{
				iptablesAgentDelete(binary, "nat", fmt.Sprintf(`POSTROUTING -p %s -d %s --dport %s -j MASQUERADE`, proto, target, targetPortText)),
				iptablesAgentDelete(binary, "", fmt.Sprintf(`FORWARD -p %s -d %s --dport %s -j ACCEPT`, proto, target, targetPortText)),
				iptablesAgentDelete(binary, "", fmt.Sprintf(`FORWARD -p %s -s %s --sport %s %s-j ACCEPT`, proto, target, targetPortText, stateMatch)),
			}
			commands = append(commands, iptablesAgentUnreferencedTargetGuard(binary, proto, port, dnatTarget, legacy))
		}
		rules := []struct {
			table string
			rule  string
		}{
			{"mangle", fmt.Sprintf(`FORWARD -p %s -d %s --dport %s -m comment --comment %q`, proto, target, targetPortText, inMarker)},
			{"mangle", fmt.Sprintf(`OUTPUT -p %s -d %s --dport %s -m comment --comment %q`, proto, target, targetPortText, inMarker)},
			{"mangle", fmt.Sprintf(`POSTROUTING -p %s -d %s --dport %s -m comment --comment %q`, proto, target, targetPortText, inMarker)},
			{"mangle", fmt.Sprintf(`PREROUTING -p %s -s %s --sport %s -m comment --comment %q`, proto, target, targetPortText, outMarker)},
			{"mangle", fmt.Sprintf(`INPUT -p %s -s %s --sport %s -m comment --comment %q`, proto, target, targetPortText, outMarker)},
			{"mangle", fmt.Sprintf(`FORWARD -p %s -s %s --sport %s -m comment --comment %q`, proto, target, targetPortText, outMarker)},
			{"mangle", fmt.Sprintf(`FORWARD -p %s -d %s --dport %s -j FWX_IN_%s`, proto, target, targetPortText, port)},
			{"mangle", fmt.Sprintf(`FORWARD -p %s -s %s --sport %s -j FWX_OUT_%s`, proto, target, targetPortText, port)},
		}
		for _, item := range rules {
			commands = append(commands, iptablesAgentDelete(binary, item.table, item.rule))
		}
	}
	return commands
}

// iptablesAgentUnreferencedTargetGuard 只有在 nat PREROUTING 里没有其它端口 DNAT 到同一目标时
// 才执行 deletes（删除旧版无标记的共享 MASQUERADE/FORWARD）。读取失败按“仍被引用”处理。
func iptablesAgentUnreferencedTargetGuard(binary string, proto string, port string, dnatTarget string, deletes []string) string {
	bin := iptablesAgentBin(binary)
	check := fmt.Sprintf(`printf '%%s\n' "$__fwx_nat" | awk -v proto=%s -v port=%s -v target=%s '/^-A PREROUTING / && / -j DNAT / {p=""; d=""; t=""; for (i=1; i<NF; i++) {if ($i=="-p") p=$(i+1); else if ($i=="--dport") d=$(i+1); else if ($i=="--to-destination") t=$(i+1)} if (p==proto && d!=port && tolower(t)==tolower(target)) found=1} END {exit found ? 0 : 1}'`, shellQuote(proto), shellQuote(port), shellQuote(dnatTarget))
	cmd := "if __fwx_nat=$(" + bin + " -t nat -S PREROUTING 2>/dev/null); then if " + check + "; then :; else " + strings.Join(deletes, "; ") + "; fi; fi"
	if binary == "ip6tables" {
		return "if command -v ip6tables >/dev/null 2>&1; then " + cmd + "; fi; true"
	}
	return cmd + "; true"
}

// iptablesTargetSharedByOtherDesiredRule 查 Agent 的期望状态：是否还有别的 iptables 规则转发到同一目标。
func iptablesTargetSharedByOtherDesiredRule(ruleID int, port int, targetIP string, targetPort int, proto string) bool {
	want := net.ParseIP(iptablesAgentAddress(targetIP))
	if want == nil || targetPort <= 0 {
		return false
	}
	desiredRunningRuleMu.Lock()
	defer desiredRunningRuleMu.Unlock()
	for _, r := range desiredRunningRulesByRulePort {
		if strings.TrimSpace(r.ForwardType) != "iptables" || r.TargetPort != targetPort {
			continue
		}
		if r.SourcePort == port && (ruleID <= 0 || r.RuleID == ruleID) {
			continue
		}
		if !runtimeProtocolsOverlap(r.Protocol, proto) {
			continue
		}
		if got := net.ParseIP(iptablesAgentAddress(r.TargetIP)); got != nil && got.Equal(want) {
			return true
		}
	}
	return false
}

func managedPortCleanupCmds(port string) []string {
	return managedPortCleanupCmdsWithNginx(port, true)
}

func managedPortCleanupCmdsWithNginx(port string, cleanupNginx bool) []string {
	if !shellSafePort(port) {
		unsafeShellPortNoop("managedPortCleanupCmds", port)
		return nil
	}
	inMarker := "fwx-stat-" + port + ":in"
	outMarker := "fwx-stat-" + port + ":out"
	cmds := append(managedListenerCleanupCmds(port),
		managedServiceCleanupShell("forwardx-socat-"+port),
		managedServiceCleanupShell("forwardx-socat-tcp-"+port),
		managedServiceCleanupShell("forwardx-socat-udp-"+port),
		managedServiceCleanupShell("forwardx-realm-"+port),
		managedServiceCleanupShell("forwardx-realm-tcp-"+port),
		managedServiceCleanupShell("forwardx-realm-udp-"+port),
		managedServiceCleanupShell("forwardx-realm-both-"+port),
		"rm -f /etc/forwardx/realm/forwardx-realm-"+port+".toml /etc/forwardx/realm/forwardx-realm-"+port+".toml.sha256 /etc/forwardx/realm/forwardx-realm-tcp-"+port+".toml /etc/forwardx/realm/forwardx-realm-tcp-"+port+".toml.sha256 /etc/forwardx/realm/forwardx-realm-udp-"+port+".toml /etc/forwardx/realm/forwardx-realm-udp-"+port+".toml.sha256 /etc/forwardx/realm/forwardx-realm-both-"+port+".toml /etc/forwardx/realm/forwardx-realm-both-"+port+".toml.sha256 2>/dev/null || true",
	)
	if cleanupNginx {
		cmds = append(cmds, managedNginxCleanupShell(port))
	}
	cmds = append(cmds, nftPortCleanupCmd(port, "both"), nftProcessCountingCleanupCmd(port))
	for _, binary := range iptablesAgentBinaries() {
		cmds = append(cmds,
			iptablesAgentDeleteByComment(binary, "mangle", inMarker),
			iptablesAgentDeleteByComment(binary, "mangle", outMarker),
		)
		cmds = append(cmds, iptablesAgentDeleteDnatRulesForPort(binary, port, "both"))
		directRules := []string{
			fmt.Sprintf(`PREROUTING -p tcp --dport %s -m comment --comment %q`, port, inMarker),
			fmt.Sprintf(`PREROUTING -p udp --dport %s -m comment --comment %q`, port, inMarker),
			fmt.Sprintf(`INPUT -p tcp --dport %s -m comment --comment %q`, port, inMarker),
			fmt.Sprintf(`INPUT -p udp --dport %s -m comment --comment %q`, port, inMarker),
			fmt.Sprintf(`POSTROUTING -p tcp --sport %s -m comment --comment %q`, port, outMarker),
			fmt.Sprintf(`POSTROUTING -p udp --sport %s -m comment --comment %q`, port, outMarker),
			fmt.Sprintf(`OUTPUT -p tcp --sport %s -m comment --comment %q`, port, outMarker),
			fmt.Sprintf(`OUTPUT -p udp --sport %s -m comment --comment %q`, port, outMarker),
		}
		for _, rule := range directRules {
			cmds = append(cmds, iptablesAgentDelete(binary, "mangle", rule))
		}
		legacyRules := []string{
			fmt.Sprintf(`PREROUTING -p tcp --dport %s -j FWX_IN_%s`, port, port),
			fmt.Sprintf(`PREROUTING -p udp --dport %s -j FWX_IN_%s`, port, port),
			fmt.Sprintf(`POSTROUTING -p tcp --sport %s -j FWX_OUT_%s`, port, port),
			fmt.Sprintf(`POSTROUTING -p udp --sport %s -j FWX_OUT_%s`, port, port),
			fmt.Sprintf(`INPUT -p tcp --dport %s -j FWX_IN_%s`, port, port),
			fmt.Sprintf(`INPUT -p udp --dport %s -j FWX_IN_%s`, port, port),
			fmt.Sprintf(`OUTPUT -p tcp --sport %s -j FWX_OUT_%s`, port, port),
			fmt.Sprintf(`OUTPUT -p udp --sport %s -j FWX_OUT_%s`, port, port),
			fmt.Sprintf(`FORWARD -p tcp -j FWX_IN_%s`, port),
			fmt.Sprintf(`FORWARD -p udp -j FWX_IN_%s`, port),
			fmt.Sprintf(`FORWARD -p tcp -j FWX_OUT_%s`, port),
			fmt.Sprintf(`FORWARD -p udp -j FWX_OUT_%s`, port),
		}
		for _, rule := range legacyRules {
			cmds = append(cmds, iptablesAgentDelete(binary, "mangle", rule))
		}
		cmds = append(cmds,
			iptablesAgentFlush(binary, "mangle", "FWX_IN_"+port),
			iptablesAgentDeleteChain(binary, "mangle", "FWX_IN_"+port),
			iptablesAgentFlush(binary, "mangle", "FWX_OUT_"+port),
			iptablesAgentDeleteChain(binary, "mangle", "FWX_OUT_"+port),
		)
	}
	cmds = append(cmds, "rm -f /var/lib/forwardx-agent/traffic_"+port+".prev /var/lib/forwardx-agent/port_"+port+".rule /var/lib/forwardx-agent/port_"+port+".fwtype /var/lib/forwardx-agent/port_"+port+".tunnel /var/lib/forwardx-agent/target_"+port+".info 2>/dev/null || true")
	if targetIP, targetPort, protocol, ok := readTargetInfo(port); ok {
		cmds = append(iptablesAgentTargetCleanupCmds(readRuleIDByPort(port), port, targetIP, targetPort, protocol), cmds...)
	}
	return cmds
}

func managedListenerCleanupCmds(port string) []string {
	cmds := append([]string{}, fxpPortCleanupCmds(port)...)
	cmds = append(cmds, managedListenerCleanupCmdsForProtocol(port, "both")...)
	return cmds
}

func managedListenerCleanupCmdsForProtocol(port string, protocol string) []string {
	if !shellSafePort(port) {
		unsafeShellPortNoop("managedListenerCleanupCmds", port)
		return nil
	}
	protocol = normalizeRuntimeProtocol(protocol)
	cmds := []string{}
	seen := map[string]bool{}
	appendKill := func(pattern string) {
		if pattern == "" || seen[pattern] {
			return
		}
		seen[pattern] = true
		cmds = append(cmds, "for pid in $(pgrep -f '"+pattern+"' 2>/dev/null || true); do if [ \"$pid\" = \"$$\" ] || [ \"$pid\" = \"$PPID\" ]; then continue; fi; kill \"$pid\" 2>/dev/null || true; done")
	}
	for _, proto := range runtimeProtocols(protocol) {
		if proto == "udp" {
			appendKill("[s]ocat .*UDP.*LISTEN:" + port)
			appendKill("[r]ealm .*forwardx-realm-udp-" + port + "[.]toml")
			appendKill("[r]ealm .*forwardx-realm-both-" + port + "[.]toml")
			appendKill("[f]orwardx-udp2raw .*:" + port)
			continue
		}
		appendKill("[s]ocat .*TCP.*LISTEN:" + port)
		appendKill("[r]ealm .*forwardx-realm-" + port + "[.]toml")
		appendKill("[r]ealm .*forwardx-realm-tcp-" + port + "[.]toml")
		appendKill("[r]ealm .*forwardx-realm-both-" + port + "[.]toml")
	}
	return cmds
}

func managedNginxCleanupShell(port string) string {
	if !shellSafePort(port) {
		return unsafeShellPortNoop("managedNginxCleanupShell", port)
	}
	return "if [ -f /etc/forwardx/nginx/nginx.conf ] && grep -Eq \"listen .*:" + port + "( |;)|listen \\\\[::\\\\]:" + port + "( |;)|listen 0.0.0.0:" + port + "( |;)\" /etc/forwardx/nginx/nginx.conf 2>/dev/null; then listen_count=$(grep -E '^[[:space:]]*listen[[:space:]]+' /etc/forwardx/nginx/nginx.conf 2>/dev/null | wc -l | tr -d ' '); if [ \"${listen_count:-0}\" -le 1 ]; then " + managedServiceCleanupShell("forwardx-nginx") + "; else echo \"[nginx] keep shared forwardx-nginx while replacing port " + port + "\"; fi; fi"
}

func fxpPortCleanupCmds(port string) []string {
	if !shellSafePort(port) {
		unsafeShellPortNoop("fxpPortCleanupCmds", port)
		return nil
	}
	return []string{
		"for pid in $(pgrep -f '[f]orwardx-fxp.*fxp-.*-" + port + "\\.json' 2>/dev/null || true); do if [ \"$pid\" = \"$$\" ] || [ \"$pid\" = \"$PPID\" ]; then continue; fi; kill \"$pid\" 2>/dev/null || true; done",
		"rm -f /run/forwardx-agent/fxp-*-" + port + ".json 2>/dev/null || true",
	}
}
