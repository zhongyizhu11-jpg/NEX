package main

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

func shouldSkipRemoveForReassignedPort(a action) bool {
	if a.Op != "remove" || a.RuleID <= 0 || a.SourcePort <= 0 || strings.TrimSpace(a.StatusType) == "tunnel" {
		return false
	}
	if desired, ok := desiredRunningRuleForAction(a); ok && desired.RuleID > 0 {
		if desired.RuleID != a.RuleID {
			logf("skip stale remove for desired reassigned port=%d protocol=%s removeRule=%d desiredRule=%d forwardType=%s", a.SourcePort, normalizeRuntimeProtocol(a.Protocol), a.RuleID, desired.RuleID, a.ForwardType)
			return true
		}
		if desired.TunnelID != a.TunnelID && (desired.TunnelID > 0 || a.TunnelID > 0) {
			logf("skip stale remove for desired tunnel reassigned port=%d protocol=%s rule=%d removeTunnel=%d desiredTunnel=%d forwardType=%s", a.SourcePort, normalizeRuntimeProtocol(a.Protocol), a.RuleID, a.TunnelID, desired.TunnelID, a.ForwardType)
			return true
		}
		if strings.TrimSpace(desired.ForwardType) != "" && strings.TrimSpace(a.ForwardType) != "" && strings.TrimSpace(desired.ForwardType) != strings.TrimSpace(a.ForwardType) {
			logf("skip stale remove for desired type reassigned port=%d protocol=%s rule=%d removeType=%s desiredType=%s", a.SourcePort, normalizeRuntimeProtocol(a.Protocol), a.RuleID, a.ForwardType, desired.ForwardType)
			return true
		}
		if normalizeRuntimeProtocol(desired.Protocol) != normalizeRuntimeProtocol(a.Protocol) {
			logf("skip stale remove for desired protocol reassigned port=%d rule=%d removeProtocol=%s desiredProtocol=%s forwardType=%s", a.SourcePort, a.RuleID, normalizeRuntimeProtocol(a.Protocol), normalizeRuntimeProtocol(desired.Protocol), a.ForwardType)
			return true
		}
	}
	port := strconv.Itoa(a.SourcePort)
	localRuleID := readRuleIDByPort(port)
	localRuleTunnelID := readRuleTunnelIDByPort(port)
	if localRuleID > 0 && localRuleID == a.RuleID && localRuleTunnelID != a.TunnelID && (localRuleTunnelID > 0 || a.TunnelID > 0) {
		logf("skip stale remove for tunnel reassigned port=%d rule=%d removeTunnel=%d currentTunnel=%d forwardType=%s", a.SourcePort, a.RuleID, a.TunnelID, localRuleTunnelID, a.ForwardType)
		return true
	}
	if localRuleID <= 0 || localRuleID == a.RuleID {
		return false
	}
	if _, _, localProtocol, ok := readTargetInfo(port); ok && !runtimeProtocolsOverlap(localProtocol, a.Protocol) {
		return false
	}
	logf("skip stale remove for reassigned port=%d removeRule=%d currentRule=%d forwardType=%s", a.SourcePort, a.RuleID, localRuleID, a.ForwardType)
	return true
}

func rememberDesiredRunningRules(rules []runningRule) {
	next := map[string]runningRule{}
	nextByRulePort := map[string]runningRule{}
	for _, r := range rules {
		// 只跑调度器的不占端口：不能让它顶替端口上真正的规则，也不能上报成本机的端口状态。
		if r.RuleID <= 0 || r.SourcePort <= 0 || r.SchedulerOnly {
			continue
		}
		next[actionPortProtocolKey(r.SourcePort, r.Protocol)] = r
		if key := runningRuleIDPortKey(r.RuleID, r.SourcePort); key != "" {
			nextByRulePort[key] = r
		}
	}
	desiredRunningRuleMu.Lock()
	desiredRunningRulesByPort = next
	desiredRunningRulesByRulePort = nextByRulePort
	desiredRunningRuleMu.Unlock()
}

func desiredRunningRuleStatesSnapshot() []localRuleState {
	desiredRunningRuleMu.Lock()
	defer desiredRunningRuleMu.Unlock()
	states := make([]localRuleState, 0, len(desiredRunningRulesByRulePort))
	for _, rule := range desiredRunningRulesByRulePort {
		if rule.RuleID <= 0 || rule.SourcePort <= 0 {
			continue
		}
		states = append(states, localRuleState{
			Port:        strconv.Itoa(rule.SourcePort),
			RuleID:      rule.RuleID,
			TunnelID:    rule.TunnelID,
			ForwardType: rule.ForwardType,
			TargetIP:    rule.TargetIP,
			TargetPort:  rule.TargetPort,
			Protocol:    normalizeRuntimeProtocol(rule.Protocol),
		})
	}
	return states
}

func desiredRunningRuleForAction(a action) (runningRule, bool) {
	if a.SourcePort <= 0 {
		return runningRule{}, false
	}
	protocol := normalizeRuntimeProtocol(a.Protocol)
	keys := []string{actionPortProtocolKey(a.SourcePort, protocol)}
	if protocol == "both" {
		keys = append(keys, actionPortProtocolKey(a.SourcePort, "tcp"), actionPortProtocolKey(a.SourcePort, "udp"))
	} else {
		keys = append(keys, actionPortProtocolKey(a.SourcePort, "both"))
	}
	desiredRunningRuleMu.Lock()
	defer desiredRunningRuleMu.Unlock()
	for _, key := range keys {
		if key == "" {
			continue
		}
		if r, ok := desiredRunningRulesByPort[key]; ok {
			return r, true
		}
	}
	if key := runningRuleIDPortKey(a.RuleID, a.SourcePort); key != "" {
		if r, ok := desiredRunningRulesByRulePort[key]; ok && runtimeProtocolsOverlap(r.Protocol, a.Protocol) {
			return r, true
		}
	}
	return runningRule{}, false
}

func desiredRunningRuleForStatePort(ruleID int, port int) (runningRule, bool) {
	if ruleID <= 0 || port <= 0 {
		return runningRule{}, false
	}
	desiredRunningRuleMu.Lock()
	defer desiredRunningRuleMu.Unlock()
	if r, ok := desiredRunningRulesByRulePort[runningRuleIDPortKey(ruleID, port)]; ok {
		return r, true
	}
	return runningRule{}, false
}

func cleanupKernelForwardPortBeforeApply(a action) {
	if a.Op != "apply" || a.SourcePort <= 0 {
		return
	}
	port := strconv.Itoa(a.SourcePort)
	localRuleID := readRuleIDByPort(port)
	localForwardType := readForwardTypeByPort(port)
	localTargetIP, localTargetPort, localProtocol, hasLocalTarget := readTargetInfo(port)
	cleanupProtocol := normalizeRuntimeProtocol(a.Protocol)
	if localRuleID == a.RuleID && hasLocalTarget {
		cleanupProtocol = normalizeRuntimeProtocol(localProtocol)
		switch localForwardType {
		case "iptables":
			_ = runIptablesShellBatch(iptablesAgentTargetCleanupCmds(localRuleID, port, localTargetIP, localTargetPort, cleanupProtocol))
		case "nftables":
			_ = runShell(nftRuleCleanupCmd(localRuleID))
		}
	}
	reassignedRule := a.RuleID > 0 && localRuleID > 0 && localRuleID != a.RuleID
	changedFromKernelForward := reassignedRule && (localForwardType == "iptables" || localForwardType == "nftables")
	if changedFromKernelForward && a.ForwardType != "iptables" {
		for _, binary := range iptablesAgentBinaries() {
			_ = runShell(iptablesAgentDeleteDnatRulesForPort(binary, port, cleanupProtocol))
		}
	}
	if changedFromKernelForward && a.ForwardType != "nftables" {
		_ = runShell(nftPortCleanupCmd(port, cleanupProtocol))
	}
	switch a.ForwardType {
	case "iptables":
		for _, binary := range iptablesAgentBinaries() {
			_ = runShell(iptablesAgentDeleteDnatRulesForPort(binary, port, cleanupProtocol))
		}
	case "nftables":
		_ = runShell(nftPortCleanupCmd(port, cleanupProtocol))
	}
}

func logIPv6ActionDiagnostic(a action) {
	if a.SourcePort <= 0 || a.Op != "apply" {
		return
	}
	target := strings.Trim(strings.TrimSpace(a.TargetIP), "[]")
	targetIPv6 := strings.Contains(target, ":")
	commandText := strings.Join(append(append([]string{}, a.PreCommands...), append(a.Commands, a.PostCommands...)...), "\n")
	usesIP6Tables := strings.Contains(commandText, "ip6tables")
	usesNFT := strings.Contains(commandText, "nft ") || strings.Contains(commandText, "nftables")
	serviceMode := a.Unit != "" || a.UnitExtra != "" || a.Fxp != nil || (a.Failover != nil && a.Failover.Enabled)
	if !targetIPv6 && !usesIP6Tables && !usesNFT && !serviceMode {
		return
	}
	if !shouldLogAgentReport(fmt.Sprintf("ipv6-forward-diag:%d:%d:%s", a.RuleID, a.SourcePort, a.ForwardType), 5*time.Minute) {
		return
	}
	logf(
		"ipv6-forward diag op=%s rule=%d tunnel=%d type=%s port=%d protocol=%s target=%s:%d targetIPv6=%v ip6tablesCmd=%v nftCmd=%v service=%v fxp=%v failover=%v ip6tablesInstalled=%v",
		a.Op,
		a.RuleID,
		a.TunnelID,
		a.ForwardType,
		a.SourcePort,
		a.Protocol,
		target,
		a.TargetPort,
		targetIPv6,
		usesIP6Tables,
		usesNFT,
		serviceMode,
		a.Fxp != nil,
		a.Failover != nil && a.Failover.Enabled,
		commandExists("ip6tables"),
	)
}

func shouldSkipRuntimeAction(a action) bool {
	if a.ForceRuntimeSync {
		return false
	}
	key := runtimeActionKey(a)
	signature := actionCommandSignature(a)
	now := time.Now()
	runtimeActionMu.Lock()
	state := runtimeActionCache[key]
	recentMatch := state.Success && state.Signature == signature && !state.CheckedAt.IsZero() && now.Sub(state.CheckedAt) < runtimeActionRefreshInterval
	runtimeActionMu.Unlock()
	if recentMatch && runtimeActionReady(a) {
		return true
	}
	runtimeActionMu.Lock()
	runtimeActionCache[key] = runtimeActionState{Signature: signature, CheckedAt: now, Success: false}
	runtimeActionMu.Unlock()
	return false
}

func rememberRuntimeActionResult(a action, ok bool) {
	key := runtimeActionKey(a)
	signature := actionCommandSignature(a)
	runtimeActionMu.Lock()
	state := runtimeActionCache[key]
	if state.Signature == signature {
		state.Success = ok
		state.CheckedAt = time.Now()
		runtimeActionCache[key] = state
	}
	runtimeActionMu.Unlock()
}

func isMimicRuntimeAction(a action) bool {
	return strings.TrimSpace(a.ForwardType) == "mimic-runtime-sync"
}

func isWireGuardRuntimeAction(a action) bool {
	return strings.TrimSpace(a.ForwardType) == "forwardx-wireguard"
}

func runtimeActionKey(a action) string {
	key := strings.TrimSpace(a.ForwardType)
	if key == "" {
		key = "runtime"
	}
	if isWireGuardRuntimeAction(a) && a.TunnelID > 0 {
		return key + ":" + strconv.Itoa(a.TunnelID)
	}
	return key
}

func runtimeActionServicesHealthy(a action) bool {
	if isPortAccessLimitAction(a) {
		return portAccessLimitsReady(a)
	}
	if isWireGuardRuntimeAction(a) {
		if a.Op == "remove" {
			return !wireGuardRuntimeReady(a.TunnelID, nil)
		}
		return wireGuardRuntimeReady(a.TunnelID, a.WireGuard)
	}
	if isMimicRuntimeAction(a) {
		for _, name := range managedMimicServicesFromLocalConfig() {
			if ok, reason := mimicRuntimeServiceHealth(name); !ok {
				if shouldLogAgentReport("mimic-runtime-unhealthy:"+name, agentReportLogInterval) {
					logf("mimic runtime unhealthy service=%s reason=%s", name, reason)
				}
				return false
			}
		}
		return true
	}
	services := requiredSharedRuntimeServicesFromLocalConfig()
	switch strings.TrimSpace(a.ForwardType) {
	case "nginx-runtime-sync":
		services = requiredNginxRuntimeServicesFromLocalConfig()
	case "gost-runtime-sync":
		services = requiredGostRuntimeServicesFromLocalConfig()
		// Panels before the split runtime protocol included Nginx commands in the
		// gost action. Keep that payload compatible during rolling upgrades.
		if runtimeActionReferencesNginx(a) {
			services = append(services, requiredNginxRuntimeServicesFromLocalConfig()...)
		}
	}
	for _, name := range services {
		if !managedServiceActive(name) {
			if shouldLogAgentReport("runtime-action-service-inactive:"+strings.TrimSpace(a.ForwardType)+":"+name, agentReportLogInterval) {
				logf("runtime action service inactive service=%s forwardType=%s op=%s", name, strings.TrimSpace(a.ForwardType), strings.TrimSpace(a.Op))
			}
			return false
		}
	}
	return true
}

func runtimeActionReady(a action) bool {
	if shouldVerifyManagedRuntimeSync(a) {
		return managedRuntimeSyncReady(a)
	}
	return runtimeActionServicesHealthy(a)
}

func shouldVerifyManagedRuntimeSync(a action) bool {
	if strings.TrimSpace(a.StatusType) != "runtime" || strings.TrimSpace(a.Op) != "apply" || len(a.ManagedConfigs) == 0 {
		return false
	}
	switch strings.TrimSpace(a.ForwardType) {
	case "gost-runtime-sync", "nginx-runtime-sync":
		return true
	default:
		return false
	}
}

func waitForManagedRuntimeSyncReady(a action, timeout time.Duration) bool {
	if managedRuntimeSyncReady(a) {
		return true
	}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		time.Sleep(300 * time.Millisecond)
		if managedRuntimeSyncReady(a) {
			return true
		}
	}
	return managedRuntimeSyncReady(a)
}

func managedRuntimeSyncReady(a action) bool {
	snapshot := newRuntimeListenSnapshot()
	for _, spec := range a.ManagedConfigs {
		service := sanitizeServiceName(spec.ServiceName)
		if service == "" {
			continue
		}
		listens, ok := managedConfigRuntimeListens(spec)
		if !ok {
			return false
		}
		if len(listens) == 0 {
			if managedServiceActive(service) {
				return false
			}
			continue
		}
		if !managedServiceActive(service) {
			return false
		}
		needles := []string{"gost", "forwardx-runt"}
		if strings.Contains(strings.ToLower(service), "nginx") || strings.Contains(strings.ToLower(spec.Path), "nginx") {
			needles = []string{"nginx"}
		}
		for _, listen := range listens {
			port := addrPort(listen.Addr)
			if port <= 0 || !runtimeListenPortReady(snapshot, port, listen.Protocol, needles) {
				return false
			}
		}
	}
	return true
}

func managedConfigRuntimeListens(spec managedConfigSpec) ([]runtimeListenConfig, bool) {
	path := strings.TrimSpace(spec.Path)
	if strings.HasSuffix(strings.ToLower(path), ".json") {
		return readGostRuntimeServiceListens(path)
	}
	if strings.Contains(strings.ToLower(spec.ServiceName), "nginx") || strings.Contains(strings.ToLower(path), "nginx") {
		return nginxRuntimeListenConfigs(path)
	}
	return nil, true
}

func requiredSharedRuntimeServicesFromLocalConfig() []string {
	services := requiredGostRuntimeServicesFromLocalConfig()
	services = append(services, requiredNginxRuntimeServicesFromLocalConfig()...)
	return services
}

func requiredGostRuntimeServicesFromLocalConfig() []string {
	services := []string{}
	if gostRuntimeConfigHasServices(runtimeConfigPath) {
		services = append(services, runtimeServiceName)
	}
	if gostRuntimeConfigHasServices(tunnelRuntimeConfigPath) {
		services = append(services, tunnelRuntimeServiceName)
	}
	return services
}

func requiredNginxRuntimeServicesFromLocalConfig() []string {
	if nginxRuntimeConfigHasServers(nginxConfigPath) {
		return []string{nginxServiceName}
	}
	return nil
}

func runtimeActionReferencesNginx(a action) bool {
	for _, command := range append(append([]string{}, a.PreCommands...), append(a.Commands, a.PostCommands...)...) {
		if strings.Contains(command, nginxConfigPath) || strings.Contains(command, nginxServiceName) {
			return true
		}
	}
	return false
}
