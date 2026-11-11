package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

func writeState(a action) {
	if a.StatusType == "tunnel" && a.TunnelID > 0 && a.SourcePort > 0 {
		writeTunnelState(a)
		return
	}
	if a.RuleID <= 0 {
		return
	}
	port := strconv.Itoa(a.SourcePort)
	resetTrafficStateIfRuleChanged(port, a.RuleID)
	_ = writeStateFile(agentStatePath("port_"+port+".rule"), []byte(strconv.Itoa(a.RuleID)))
	_ = writeStateFile(agentStatePath("port_"+port+".fwtype"), []byte(a.ForwardType))
	writeRuleTunnelState(port, a.TunnelID)
	if a.TargetIP != "" && a.TargetPort > 0 {
		_ = writeStateFile(agentStatePath("target_"+port+".info"), []byte(fmt.Sprintf("%s\n%d\n%s\n", a.TargetIP, a.TargetPort, normalizeRuntimeProtocol(a.Protocol))))
	}
}

func writeTunnelState(a action) {
	port := strconv.Itoa(a.SourcePort)
	_ = writeStateFile(agentStatePath("tunnel_"+port+".id"), []byte(strconv.Itoa(a.TunnelID)))
	_ = writeStateFile(agentStatePath("tunnel_"+port+".fwtype"), []byte(a.ForwardType))
}

func writeRuleTunnelState(port string, tunnelID int) {
	if strings.TrimSpace(port) == "" {
		return
	}
	path := agentStatePath("port_" + port + ".tunnel")
	if tunnelID > 0 {
		_ = writeStateFile(path, []byte(strconv.Itoa(tunnelID)))
		return
	}
	_ = os.Remove(path)
}

func writeRunningRuleState(r runningRule) {
	if r.RuleID <= 0 || r.SourcePort <= 0 {
		return
	}
	port := strconv.Itoa(r.SourcePort)
	resetTrafficStateIfRuleChanged(port, r.RuleID)
	_ = writeStateFile(agentStatePath("port_"+port+".rule"), []byte(strconv.Itoa(r.RuleID)))
	_ = writeStateFile(agentStatePath("port_"+port+".fwtype"), []byte(r.ForwardType))
	writeRuleTunnelState(port, r.TunnelID)
	if r.TargetIP != "" && r.TargetPort > 0 {
		_ = writeStateFile(agentStatePath("target_"+port+".info"), []byte(fmt.Sprintf("%s\n%d\n%s\n", r.TargetIP, r.TargetPort, normalizeRuntimeProtocol(r.Protocol))))
	}
}

func runningRuleStateWriteProtected(r runningRule, protectedPorts map[string]bool) bool {
	if r.SourcePort <= 0 {
		return false
	}
	return protectedActionMatchesPort(protectedPorts, strconv.Itoa(r.SourcePort), r.Protocol)
}

func readRuleIDByPort(port string) int {
	b, err := os.ReadFile("/var/lib/forwardx-agent/port_" + port + ".rule")
	if err != nil {
		return 0
	}
	id, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	return id
}

func readForwardTypeByPort(port string) string {
	b, err := os.ReadFile("/var/lib/forwardx-agent/port_" + port + ".fwtype")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func readRuleTunnelIDByPort(port string) int {
	b, err := os.ReadFile("/var/lib/forwardx-agent/port_" + port + ".tunnel")
	if err != nil {
		return 0
	}
	id, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	return id
}

func readTunnelIDByPort(port string) int {
	b, err := os.ReadFile("/var/lib/forwardx-agent/tunnel_" + port + ".id")
	if err != nil {
		return 0
	}
	id, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	return id
}

func readTunnelForwardTypeByPort(port string) string {
	b, err := os.ReadFile("/var/lib/forwardx-agent/tunnel_" + port + ".fwtype")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func resetTrafficStateIfRuleChanged(port string, nextRuleID int) {
	if port == "" || nextRuleID <= 0 {
		return
	}
	currentRuleID := readRuleIDByPort(port)
	if currentRuleID > 0 && currentRuleID != nextRuleID {
		_ = os.Remove("/var/lib/forwardx-agent/traffic_" + port + ".prev")
		invalidateTrafficPrev(port)
		logf("traffic baseline reset port=%s oldRule=%d newRule=%d", port, currentRuleID, nextRuleID)
	}
}

// 运行规则里哪些端口要留着（端口状态、计数链），哪些调度器要开着。只跑调度器的规则
// （NEX 隧道的出口，见 runningRule.SchedulerOnly）只进后者：它不占端口，同号端口上要是
// 有别的规则留下的状态，照常按孤儿清。
func runningRuleWants(rules []runningRule) (map[string]bool, []runningRule) {
	ports := map[string]bool{}
	failovers := make([]runningRule, 0)
	for _, r := range rules {
		if r.RuleID <= 0 || r.SourcePort <= 0 {
			continue
		}
		if !r.SchedulerOnly {
			ports[strconv.Itoa(r.SourcePort)] = true
		}
		if r.Failover != nil && r.Failover.Enabled {
			failovers = append(failovers, r)
		}
	}
	return ports, failovers
}

func syncRunningRuleState(rules []runningRule, protectedPorts map[string]bool) {
	wanted, failovers := runningRuleWants(rules)
	wantedFailover := map[string]bool{}
	for _, r := range failovers {
		wantedFailover[failoverID(r.RuleID, r.SourcePort)] = true
		port := strconv.Itoa(r.SourcePort)
		if protectedActionMatchesPort(protectedPorts, port, r.Protocol) {
			logVerbosef("failover reconcile deferred for pending action rule=%d port=%d protocol=%s", r.RuleID, r.SourcePort, normalizeRuntimeProtocol(r.Protocol))
		} else {
			startFailoverProxy(r.RuleID, r.SourcePort, *r.Failover, nil)
		}
	}
	failoverMu.Lock()
	staleFailovers := make([]*failoverProxy, 0)
	for id, proxy := range failoverProxies {
		if !wantedFailover[id] {
			staleFailovers = append(staleFailovers, proxy)
		}
	}
	failoverMu.Unlock()
	for _, proxy := range staleFailovers {
		stopFailoverProxy(proxy.ruleID, proxy.sourcePort)
	}
	files, _ := os.ReadDir("/var/lib/forwardx-agent")
	for _, f := range files {
		name := f.Name()
		if !strings.HasPrefix(name, "port_") || !strings.HasSuffix(name, ".rule") {
			continue
		}
		port := strings.TrimSuffix(strings.TrimPrefix(name, "port_"), ".rule")
		if !shellSafePort(port) {
			// 状态目录里不是数字端口的文件不是 Agent 写的，别拿它的名字去拼清理命令。
			unsafeShellPortNoop("syncRunningRuleState", port)
			continue
		}
		if !wanted[port] {
			localRuleID := readRuleIDByPort(port)
			if desired, ok := desiredRunningRuleForStatePort(localRuleID, atoi(port)); ok {
				logf("reconcile skip desired local rule port=%s rule=%d desiredTunnel=%d forwardType=%s", port, localRuleID, desired.TunnelID, desired.ForwardType)
				writeRunningRuleState(desired)
				continue
			}
			_, _, protocol, _ := readTargetInfo(port)
			if protectedActionMatchesPort(protectedPorts, port, protocol) {
				logVerbosef("reconcile skip pending action port=%s protocol=%s", port, normalizeRuntimeProtocol(protocol))
				continue
			}
			reconcileRemovePort(port)
			removeStateByPort(port)
		}
	}
}

func reconcileRemovePort(port string) {
	if port == "" {
		return
	}
	ruleID := readRuleIDByPort(port)
	forwardType := readForwardTypeByPort(port)
	logf("reconcile remove stale local rule port=%s rule=%d forwardType=%s", port, ruleID, forwardType)
	if forwardType == "forwardx" && ruleID > 0 {
		_ = stopFXP(fxpSpec{Role: "entry", RuleID: ruleID, ListenPort: atoi(port), Protocol: "both"}, nil, nil)
	}
	if ruleID > 0 {
		stopFailoverProxy(ruleID, atoi(port))
	}
	if forwardType == "nftables" && ruleID > 0 {
		_ = runShell(nftRuleCleanupCmd(ruleID))
	}
	if isKernelForwardType(forwardType) {
		// 面板已经不列这条规则，没有面板命令来收它在 DOCKER-USER 里的放行，Agent 自己收。
		protocols := []string{"tcp", "udp"}
		if _, _, protocol, ok := readTargetInfo(port); ok {
			protocols = runtimeProtocols(protocol)
		}
		cleanupDockerCompatAllowances(ruleID, atoi(port), protocols)
	}
	for _, cmd := range managedPortCleanupCmds(port) {
		_ = runShell(cmd)
	}
}

func removeStateByPort(port string) {
	_ = os.Remove("/var/lib/forwardx-agent/port_" + port + ".rule")
	_ = os.Remove("/var/lib/forwardx-agent/port_" + port + ".fwtype")
	_ = os.Remove("/var/lib/forwardx-agent/port_" + port + ".tunnel")
	_ = os.Remove("/var/lib/forwardx-agent/target_" + port + ".info")
	_ = os.Remove("/var/lib/forwardx-agent/traffic_" + port + ".prev")
	invalidateTrafficPrev(port)
	clearFreshProcessConnectionCounter(port, 0)
	removeTunnelStateByPort(port)
	forgetCountingChainState(port)
}

func removeTunnelStateByPort(port string) {
	_ = os.Remove("/var/lib/forwardx-agent/tunnel_" + port + ".id")
	_ = os.Remove("/var/lib/forwardx-agent/tunnel_" + port + ".fwtype")
}

func atoi(s string) int {
	v, _ := strconv.Atoi(strings.TrimSpace(s))
	return v
}

func removeState(port int) {
	p := strconv.Itoa(port)
	_ = os.Remove("/var/lib/forwardx-agent/port_" + p + ".rule")
	_ = os.Remove("/var/lib/forwardx-agent/port_" + p + ".fwtype")
	_ = os.Remove("/var/lib/forwardx-agent/port_" + p + ".tunnel")
	_ = os.Remove("/var/lib/forwardx-agent/target_" + p + ".info")
	_ = os.Remove("/var/lib/forwardx-agent/traffic_" + p + ".prev")
	invalidateTrafficPrev(p)
	clearFreshProcessConnectionCounter(p, 0)
	removeTunnelStateByPort(p)
	forgetCountingChainState(p)
}
