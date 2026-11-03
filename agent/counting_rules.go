package main

import (
	"fmt"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

const nftProcessTrafficTable = "forwardx_traffic"

func nftProcessCountingCleanupCmd(port string) string {
	if !shellSafePort(port) {
		return unsafeShellPortNoop("nftProcessCountingCleanupCmd", port)
	}
	marker := "fwx-stat-" + port + ":"
	return fmt.Sprintf(`if command -v nft >/dev/null 2>&1 && nft list table inet %s >/dev/null 2>&1; then for c in input output forward; do for h in $(nft -a list chain inet %s "$c" 2>/dev/null | awk -v marker=%s 'index($0, marker) {print $NF}'); do nft delete rule inet %s "$c" handle "$h" 2>/dev/null || true; done; done; fi; true`, nftProcessTrafficTable, nftProcessTrafficTable, shellQuote(marker), nftProcessTrafficTable)
}

func nftProcessCountingCmds(port int, protocol string) []string {
	p := strconv.Itoa(port)
	commands := []string{
		"nft add table inet " + nftProcessTrafficTable + " 2>/dev/null || true",
		"nft add chain inet " + nftProcessTrafficTable + " input '{ type filter hook input priority mangle; policy accept; }' 2>/dev/null || true",
		"nft add chain inet " + nftProcessTrafficTable + " output '{ type filter hook output priority mangle; policy accept; }' 2>/dev/null || true",
	}
	for _, proto := range runtimeProtocols(protocol) {
		inComment := shellQuote(`"fwx-stat-` + p + `:in"`)
		outComment := shellQuote(`"fwx-stat-` + p + `:out"`)
		connectionComment := shellQuote(`"fwx-stat-` + p + `:conn"`)
		commands = append(commands,
			fmt.Sprintf(`nft add rule inet %s input meta l4proto %s %s dport %s counter comment %s 2>/dev/null || nft add rule inet %s input meta l4proto %s %s dport %s comment %s counter`, nftProcessTrafficTable, proto, proto, p, inComment, nftProcessTrafficTable, proto, proto, p, inComment),
			fmt.Sprintf(`nft add rule inet %s output meta l4proto %s %s sport %s counter comment %s 2>/dev/null || nft add rule inet %s output meta l4proto %s %s sport %s comment %s counter`, nftProcessTrafficTable, proto, proto, p, outComment, nftProcessTrafficTable, proto, proto, p, outComment),
			fmt.Sprintf(`nft add rule inet %s input meta l4proto %s %s dport %s ct state new ct status != confirmed counter comment %s`, nftProcessTrafficTable, proto, proto, p, connectionComment),
		)
	}
	return commands
}

func nftProcessCountingEnsureCmds(port int, protocol string) []string {
	p := strconv.Itoa(port)
	commands := []string{
		"nft add table inet " + nftProcessTrafficTable + " 2>/dev/null || true",
		"nft add chain inet " + nftProcessTrafficTable + " input '{ type filter hook input priority mangle; policy accept; }' 2>/dev/null || true",
		"nft add chain inet " + nftProcessTrafficTable + " output '{ type filter hook output priority mangle; policy accept; }' 2>/dev/null || true",
	}
	for _, proto := range runtimeProtocols(protocol) {
		inMarker := "fwx-stat-" + p + ":in"
		outMarker := "fwx-stat-" + p + ":out"
		connectionMarker := "fwx-stat-" + p + ":conn"
		inMatch := proto + " dport " + p
		outMatch := proto + " sport " + p
		inAdd := fmt.Sprintf("nft add rule inet %s input meta l4proto %s %s dport %s counter comment %s 2>/dev/null || nft add rule inet %s input meta l4proto %s %s dport %s comment %s counter", nftProcessTrafficTable, proto, proto, p, shellQuote(`"`+inMarker+`"`), nftProcessTrafficTable, proto, proto, p, shellQuote(`"`+inMarker+`"`))
		outAdd := fmt.Sprintf("nft add rule inet %s output meta l4proto %s %s sport %s counter comment %s 2>/dev/null || nft add rule inet %s output meta l4proto %s %s sport %s comment %s counter", nftProcessTrafficTable, proto, proto, p, shellQuote(`"`+outMarker+`"`), nftProcessTrafficTable, proto, proto, p, shellQuote(`"`+outMarker+`"`))
		connectionAdd := fmt.Sprintf("nft add rule inet %s input meta l4proto %s %s dport %s ct state new ct status != confirmed counter comment %s", nftProcessTrafficTable, proto, proto, p, shellQuote(`"`+connectionMarker+`"`))
		commands = append(commands,
			fmt.Sprintf("if nft list chain inet %s input 2>/dev/null | grep -F %s | grep -F %s >/dev/null 2>&1; then :; else %s; fi", nftProcessTrafficTable, shellQuote(inMarker), shellQuote(inMatch), inAdd),
			fmt.Sprintf("if nft list chain inet %s output 2>/dev/null | grep -F %s | grep -F %s >/dev/null 2>&1; then :; else %s; fi", nftProcessTrafficTable, shellQuote(outMarker), shellQuote(outMatch), outAdd),
			fmt.Sprintf("if %s; then :; else %s; fi", nftProcessConnectionRuleCheckCmd(port, proto), connectionAdd),
		)
	}
	return commands
}

func nftProcessConnectionRuleCheckCmd(port int, protocol string) string {
	p := strconv.Itoa(port)
	marker := "fwx-stat-" + p + ":conn"
	inMatch := protocol + " dport " + p
	return fmt.Sprintf(
		"nft list chain inet %s input 2>/dev/null | grep -F %s | grep -F %s | grep -F %s | grep -F %s >/dev/null 2>&1",
		nftProcessTrafficTable, shellQuote(marker), shellQuote(inMatch), shellQuote("ct state new"), shellQuote("ct status != confirmed"),
	)
}

func nftProcessConnectionLayoutPresent(port int, protocol string) bool {
	if port <= 0 {
		return false
	}
	for _, proto := range runtimeProtocols(protocol) {
		if !runShellQuiet(nftProcessConnectionRuleCheckCmd(port, proto)) {
			return false
		}
	}
	return true
}

func iptablesProcessConnectionRule(port int, protocol string) string {
	marker := "fwx-stat-" + strconv.Itoa(port) + ":conn"
	return fmt.Sprintf(`INPUT -p %s --dport %d -m conntrack --ctstate NEW ! --ctstatus CONFIRMED -m comment --comment %q`, protocol, port, marker)
}

func iptablesProcessConnectionLayoutPresent(port int, protocol string) bool {
	if port <= 0 {
		return false
	}
	for _, binary := range iptablesAgentBinaries() {
		if !runShellQuiet("command -v " + binary + " >/dev/null 2>&1") {
			continue
		}
		complete := true
		for _, proto := range runtimeProtocols(protocol) {
			if !runIptablesShellQuiet(iptablesAgentBin(binary) + " -t mangle -C " + iptablesProcessConnectionRule(port, proto) + " 2>/dev/null") {
				complete = false
				break
			}
		}
		if complete {
			return true
		}
	}
	return false
}

func iptablesProcessCountingCmds(port int, protocol string) []string {
	if port <= 0 {
		return nil
	}
	p := strconv.Itoa(port)
	inMarker := "fwx-stat-" + p + ":in"
	outMarker := "fwx-stat-" + p + ":out"
	commands := []string{}
	for _, binary := range iptablesAgentBinaries() {
		for _, proto := range runtimeProtocols(protocol) {
			commands = append(commands,
				iptablesAgentEnsure(binary, "mangle", fmt.Sprintf(`INPUT -p %s --dport %s -m comment --comment %q`, proto, p, inMarker)),
				iptablesAgentEnsure(binary, "mangle", fmt.Sprintf(`OUTPUT -p %s --sport %s -m comment --comment %q`, proto, p, outMarker)),
				iptablesAgentEnsure(binary, "mangle", iptablesProcessConnectionRule(port, proto)),
			)
		}
	}
	return commands
}

type countingRuleMode string

const (
	countingRuleNone      countingRuleMode = "none"
	countingRuleKernel    countingRuleMode = "kernel"
	countingRuleProcess   countingRuleMode = "process"
	countingLayoutVersion                  = "v2"
)

func countingRuleModeForForwardType(forwardType string) countingRuleMode {
	normalized := strings.ToLower(strings.TrimSpace(forwardType))
	if normalized == "nftables" || normalized == "forwardx" || strings.HasPrefix(normalized, "forwardx-") {
		return countingRuleNone
	}
	if normalized == "iptables" {
		return countingRuleKernel
	}
	return countingRuleProcess
}

func countingRuleInstallCmds(rule runningRule) []string {
	if rule.SourcePort <= 0 {
		return nil
	}
	p := strconv.Itoa(rule.SourcePort)
	inMarker := "fwx-stat-" + p + ":in"
	outMarker := "fwx-stat-" + p + ":out"
	mode := countingRuleModeForForwardType(rule.ForwardType)
	commands := []string{}
	if mode == countingRuleProcess {
		return nftProcessCountingCmds(rule.SourcePort, rule.Protocol)
	}
	if mode != countingRuleKernel {
		return commands
	}
	target := iptablesAgentAddress(rule.TargetIP)
	if !iptablesAgentIsIPAddress(target) || rule.TargetPort <= 0 {
		return commands
	}
	targetPort := strconv.Itoa(rule.TargetPort)
	binary := iptablesAgentBinaryForTarget(target)
	for _, proto := range runtimeProtocols(rule.Protocol) {
		inRule := iptablesAgentCountingForwardTargetRule(proto, p, target, targetPort, true) + fmt.Sprintf(` -m comment --comment %q`, inMarker)
		outRule := iptablesAgentCountingForwardTargetRule(proto, p, target, targetPort, false) + fmt.Sprintf(` -m comment --comment %q`, outMarker)
		commands = append(commands,
			iptablesAgentEnsure(binary, "mangle", inRule),
			iptablesAgentEnsure(binary, "mangle", outRule),
		)
	}
	return commands
}

func countingRuleCleanupCmds(port int) []string {
	if port <= 0 {
		return nil
	}
	p := strconv.Itoa(port)
	commands := []string{nftProcessCountingCleanupCmd(p)}
	for _, binary := range iptablesAgentBinaries() {
		commands = append(commands,
			iptablesAgentDeleteCountingRules(binary, p),
			iptablesAgentFlush(binary, "mangle", "FWX_IN_"+p),
			iptablesAgentDeleteChain(binary, "mangle", "FWX_IN_"+p),
			iptablesAgentFlush(binary, "mangle", "FWX_OUT_"+p),
			iptablesAgentDeleteChain(binary, "mangle", "FWX_OUT_"+p),
		)
	}
	return commands
}

func ensureCountingChainsWithCleanup(rule runningRule, cleanup bool) bool {
	if rule.SourcePort <= 0 {
		return true
	}
	p := strconv.Itoa(rule.SourcePort)
	mode := countingRuleModeForForwardType(rule.ForwardType)
	if mode == countingRuleKernel {
		target := iptablesAgentAddress(rule.TargetIP)
		if !iptablesAgentIsIPAddress(target) || rule.TargetPort <= 0 {
			if shouldLogAgentReport("traffic-counting-unresolved:"+p, 5*time.Minute) {
				logf("traffic counting repair deferred port=%s target=%s:%d type=%s reason=target-unresolved", p, rule.TargetIP, rule.TargetPort, rule.ForwardType)
			}
			return false
		}
	}
	if !cleanup {
		return ensureCountingChainsNonDestructive(rule, mode)
	}

	cleanupOK := runIptablesShellBatch(countingRuleCleanupCmds(rule.SourcePort))
	installOK := false
	backend := string(mode)
	if cleanupOK {
		switch mode {
		case countingRuleNone:
			installOK = true
		case countingRuleKernel:
			backend = iptablesAgentBinaryForTarget(rule.TargetIP)
			installOK = runShellQuiet("command -v "+backend+" >/dev/null 2>&1") && runIptablesShellBatch(countingRuleInstallCmds(rule))
		case countingRuleProcess:
			if runShellQuiet("command -v nft >/dev/null 2>&1") && runShellBatch(nftProcessCountingCmds(rule.SourcePort, rule.Protocol)) {
				backend = "nft"
				installOK = true
			} else {
				// Remove a partially installed nft layout before selecting the
				// iptables listener hooks as the sole authoritative backend.
				fallbackCleanupOK := runIptablesShellBatch(countingRuleCleanupCmds(rule.SourcePort))
				backend = "iptables"
				installOK = fallbackCleanupOK && runShellQuiet("command -v iptables >/dev/null 2>&1") && runIptablesShellBatch(iptablesProcessCountingCmds(rule.SourcePort, rule.Protocol))
			}
		}
	}
	ok := cleanupOK && installOK
	if ok && cleanup && mode == countingRuleProcess {
		markFreshProcessConnectionCounter(rule.SourcePort, rule.RuleID)
	}
	if !ok && shouldLogAgentReport("traffic-counting-repair:"+p, 5*time.Minute) {
		logf("traffic counting repair failed port=%s target=%s:%d protocol=%s type=%s mode=%s backend=%s cleanup=%v install=%v", p, rule.TargetIP, rule.TargetPort, rule.Protocol, rule.ForwardType, mode, backend, cleanupOK, installOK)
	}
	return ok
}

// ensureCountingChainsNonDestructive repairs missing rules without flushing
// existing chains. This preserves counters when only the Agent process was
// restarted and the firewall layout is still present.
func ensureCountingChainsNonDestructive(rule runningRule, mode countingRuleMode) bool {
	if mode == countingRuleNone {
		return true
	}
	if mode == countingRuleKernel {
		target := iptablesAgentAddress(rule.TargetIP)
		binary := iptablesAgentBinaryForTarget(target)
		// 先删掉逐字重复的计数规则（保留第一条及其计数器），再补缺失的规则。
		commands := append([]string{iptablesAgentDedupeCountingRules(binary, strconv.Itoa(rule.SourcePort))}, countingRuleInstallCmds(rule)...)
		return runShellQuiet("command -v "+binary+" >/dev/null 2>&1") && runIptablesShellBatch(commands)
	}
	nftAvailable := runShellQuiet("command -v nft >/dev/null 2>&1")
	nftConnectionLayoutPresent := nftAvailable && nftProcessConnectionLayoutPresent(rule.SourcePort, rule.Protocol)
	if nftAvailable && runShellBatch(nftProcessCountingEnsureCmds(rule.SourcePort, rule.Protocol)) {
		if nftConnectionLayoutPresent {
			clearFreshProcessConnectionCounter(strconv.Itoa(rule.SourcePort), rule.RuleID)
		} else {
			markFreshProcessConnectionCounter(rule.SourcePort, rule.RuleID)
		}
		return true
	}
	iptablesConnectionLayoutPresent := iptablesProcessConnectionLayoutPresent(rule.SourcePort, rule.Protocol)
	processCommands := []string{}
	for _, binary := range iptablesAgentBinaries() {
		processCommands = append(processCommands, iptablesAgentDedupeCountingRules(binary, strconv.Itoa(rule.SourcePort)))
	}
	processCommands = append(processCommands, iptablesProcessCountingCmds(rule.SourcePort, rule.Protocol)...)
	ok := runShellQuiet("command -v iptables >/dev/null 2>&1") && runIptablesShellBatch(processCommands)
	if ok {
		if iptablesConnectionLayoutPresent {
			clearFreshProcessConnectionCounter(strconv.Itoa(rule.SourcePort), rule.RuleID)
		} else {
			markFreshProcessConnectionCounter(rule.SourcePort, rule.RuleID)
		}
	}
	return ok
}

func ensureCountingChainsIfNeeded(r runningRule) {
	if r.SourcePort <= 0 {
		return
	}
	signature := countingChainRuleSignature(r)
	key := strconv.Itoa(r.SourcePort)
	countingChainMu.Lock()
	lastSig := countingChainSignatures[key]
	lastChecked := countingChainCheckedAt[key]
	if (lastSig == signature && !lastChecked.IsZero()) || countingChainRepairPending[key] {
		countingChainMu.Unlock()
		return
	}
	countingChainSignatures[key] = signature
	if lastSig != signature {
		countingChainCheckedAt[key] = time.Time{}
	}
	countingChainRepairCleanup[key] = lastSig != signature
	countingChainRepairPending[key] = true
	countingChainMu.Unlock()
	countingChainRepairWorkersOnce.Do(startCountingChainRepairWorkers)
	select {
	case countingChainRepairQueue <- r:
	default:
		countingChainMu.Lock()
		delete(countingChainRepairPending, key)
		delete(countingChainRepairCleanup, key)
		countingChainCheckedAt[key] = time.Time{}
		countingChainMu.Unlock()
		if shouldLogAgentReport("traffic-counting-queue-full", agentReportLogInterval) {
			logf("traffic counting repair queue full pending=%d", len(countingChainRepairQueue))
		}
	}
}

func startCountingChainRepairWorkers() {
	go countingChainRepairWorker()
}

func countingChainRepairWorker() {
	for rule := range countingChainRepairQueue {
		for atomic.LoadInt64(&actionPendingCount) > 0 || time.Since(agentProcessStartedAt) < countingChainRepairInitialDelay {
			time.Sleep(250 * time.Millisecond)
		}
		cleanup := true
		key := strconv.Itoa(rule.SourcePort)
		countingChainMu.Lock()
		if value, exists := countingChainRepairCleanup[key]; exists {
			cleanup = value
		}
		countingChainMu.Unlock()
		ok := true
		current, exists := desiredRunningRuleForStatePort(rule.RuleID, rule.SourcePort)
		if exists && countingChainRuleSignature(current) == countingChainRuleSignature(rule) {
			ok = ensureCountingChainsWithCleanup(rule, cleanup)
		} else {
			ok = false
		}
		finishCountingChainRepair(rule, ok)
		time.Sleep(countingChainRepairPace)
	}
}

func countingChainRuleSignature(rule runningRule) string {
	forwardType := strings.ToLower(strings.TrimSpace(rule.ForwardType))
	prefix := fmt.Sprintf("%s|%d|%s|%s", countingLayoutVersion, rule.SourcePort, forwardType, normalizeRuntimeProtocol(rule.Protocol))
	if countingRuleModeForForwardType(forwardType) != countingRuleKernel {
		return prefix
	}
	return fmt.Sprintf("%s|%s|%d", prefix, strings.TrimSpace(rule.TargetIP), rule.TargetPort)
}
