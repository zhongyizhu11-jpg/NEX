package main

import (
	"encoding/json"
	"fmt"
	"hash/fnv"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

func handleAction(cfg Config, a action) bool {
	return handleActionWithRuntimeGate(cfg, a, nil)
}

func handleActionWithRuntimeGate(cfg Config, a action, releaseRuntimeGate func()) bool {
	return handleActionWithRuntimeSnapshot(cfg, a, releaseRuntimeGate, nil)
}

func handleActionWithRuntimeSnapshot(cfg Config, a action, releaseRuntimeGate func(), previousRuntime *localActionRuntimeSnapshot) bool {
	return handleActionJobWithRuntimeSnapshot(cfg, a, releaseRuntimeGate, previousRuntime, nil)
}

func handleActionJobWithRuntimeSnapshot(cfg Config, a action, releaseRuntimeGate func(), previousRuntime *localActionRuntimeSnapshot, jobResult *actionJobResult) bool {
	if strings.TrimSpace(a.StatusType) == "runtime" && pluginAgentTaskIDPattern.MatchString(strings.TrimSpace(a.PluginID)) {
		releasePluginLock := acquirePluginAgentTaskLock(pluginAgentTask{PluginID: strings.TrimSpace(a.PluginID), Intent: "write"})
		defer releasePluginLock()
	}
	ok := true
	actionMessage := &actionMessage{}
	skippedStaleRemove := false
	if strings.TrimSpace(a.StatusType) == "runtime" {
		mimicAction := isMimicRuntimeAction(a)
		wireGuardAction := isWireGuardRuntimeAction(a)
		var managedConfigTx *managedConfigTransaction
		runRuntimeShellBatch := func(commands []string, phase string) bool {
			if phase == "sync" && strings.TrimSpace(a.ForwardType) == "gost-runtime-sync" && hasGostAPISyncMarker(commands) {
				// gost 规则的增删改走 gost API，不重启共享进程（gost_api_sync.go）；API 做不了或失败才重启。
				return runGostAPISyncCommands(commands, managedConfigTx, actionMessage)
			}
			if !mimicAction {
				return runShellBatch(commands)
			}
			commandOK, failureOutput := runShellBatchWithOutput(commands)
			if !commandOK && failureOutput != "" {
				actionMessage.set("mimic runtime %s failed: %s", phase, failureOutput)
			}
			return commandOK
		}
		if shouldSkipRuntimeAction(a) {
			if mimicAction && shouldLogAgentReport("mimic-runtime-skip", agentReportLogInterval) {
				logf("mimic runtime sync skipped; cached state healthy diagnostics=%s", mimicRuntimeDiagnostics())
			}
			return true
		}
		if isPortAccessLimitAction(a) {
			return applyPortAccessLimitAction(cfg, a, actionMessage)
		}
		if wireGuardAction {
			if a.Op == "remove" {
				stopWireGuardRuntime(a.TunnelID)
				ok = true
			} else if a.WireGuard == nil {
				ok = false
				actionMessage.set("wireguard runtime config missing tunnel=%d", a.TunnelID)
			} else if err := applyWireGuardRuntime(*a.WireGuard); err != nil {
				ok = false
				actionMessage.set("wireguard runtime apply failed tunnel=%d: %v", a.TunnelID, err)
			}
			rememberRuntimeActionResult(a, ok)
			invalidateLocalRuntimeReadinessCache()
			return ok
		}
		if mimicAction {
			logf("mimic runtime sync start commands=%d diagnosticsBefore=%s", len(a.Commands), mimicRuntimeDiagnostics())
		} else if a.ForceRuntimeSync {
			logf("runtime reconciliation start forwardType=%s commands=%d", strings.TrimSpace(a.ForwardType), len(a.Commands))
		}
		logVerbosef("action start op=%s statusType=%s rule=%d tunnel=%d forwardType=%s port=%d protocol=%s", a.Op, a.StatusType, a.RuleID, a.TunnelID, a.ForwardType, a.SourcePort, a.Protocol)
		if mimicAction && a.RequiresMimicEnvironment {
			environment := mimicRuntimeEnvironment()
			if !environment.Available {
				ok = false
				actionMessage.set("mimic environment unavailable (%s); install mimic/mimic-dkms manually and retry", environment.Status)
				logf("mimic environment check failed status=%s commandReady=%v moduleReady=%v message=%s", environment.Status, environment.CommandReady, environment.ModuleReady, environment.Message)
			}
		}
		if ok && len(a.PreCommands) > 0 {
			ok = runRuntimeShellBatch(a.PreCommands, "prepare") && ok
		}
		if ok && len(a.ManagedConfigs) > 0 {
			var err error
			managedConfigTx, err = applyManagedConfigs(a.ManagedConfigs)
			if err != nil {
				ok = false
				actionMessage.set("managed config validation failed: %v", err)
				logf("managed config apply failed forwardType=%s configs=%d error=%v", a.ForwardType, len(a.ManagedConfigs), err)
			}
		}
		if ok {
			ok = runRuntimeShellBatch(append(append([]string{}, a.Commands...), a.PostCommands...), "sync") && ok
		}
		if ok && shouldVerifyManagedRuntimeSync(a) {
			invalidateLocalRuntimeReadinessCache()
			if !waitForManagedRuntimeSyncReady(a, 12*time.Second) {
				ok = false
				actionMessage.set("managed runtime listeners not ready after sync: %s", strings.TrimSpace(a.ForwardType))
				logf("managed runtime sync listener verification failed forwardType=%s configs=%d; rolling back", strings.TrimSpace(a.ForwardType), len(a.ManagedConfigs))
			}
		}
		if ok && mimicAction && len(a.RemovalCommands) > 0 {
			if strings.TrimSpace(a.RemovalToken) == "" {
				ok = false
				actionMessage.set("mimic removal rejected: explicit removal token missing")
				logf("mimic runtime removal rejected commands=%d reason=missing-token", len(a.RemovalCommands))
			} else {
				ok = runRuntimeShellBatch(a.RemovalCommands, "cleanup") && ok
			}
		}
		if !ok && (managedConfigTx != nil || len(a.RollbackCommands) > 0) {
			rollbackOK := true
			if managedConfigTx != nil {
				rollbackOK = managedConfigTx.rollback()
			}
			if len(a.RollbackCommands) > 0 {
				rollbackOK = runShellBatch(a.RollbackCommands) && rollbackOK
			}
			logf("managed config rollback complete forwardType=%s ok=%v configs=%d", a.ForwardType, rollbackOK, len(a.ManagedConfigs))
		} else if ok && managedConfigTx != nil {
			if jobResult != nil && jobResult.hasDependents() {
				rollbackCommands := append([]string(nil), a.RollbackCommands...)
				jobResult.setFinalizers(
					managedConfigTx.commit,
					func() {
						rollbackOK := managedConfigTx.rollback()
						if len(rollbackCommands) > 0 {
							rollbackOK = runShellBatch(rollbackCommands) && rollbackOK
						}
						invalidateLocalRuntimeReadinessCache()
						requestLocalRuntimeStateUpload()
						logf("managed config dependent rollback complete forwardType=%s ok=%v configs=%d", a.ForwardType, rollbackOK, len(a.ManagedConfigs))
					},
				)
			} else {
				managedConfigTx.commit()
			}
		}
		logGostRuntimeProxySummary(runtimeConfigPath, runtimeServiceName)
		logGostRuntimeProxySummary(tunnelRuntimeConfigPath, tunnelRuntimeServiceName)
		if mimicAction {
			logf("mimic runtime sync complete ok=%v diagnosticsAfter=%s", ok, mimicRuntimeDiagnostics())
		} else if a.ForceRuntimeSync || !ok || agentVerboseLogs {
			logf("runtime action complete forwardType=%s ok=%v", a.ForwardType, ok)
		}
		rememberRuntimeActionResult(a, ok)
		invalidateLocalRuntimeReadinessCache()
		if a.ReportStatus != nil && *a.ReportStatus {
			if !ok {
				message := strings.TrimSpace(actionMessage.get())
				if message == "" {
					message = strings.TrimSpace(a.FailureMessage)
				}
				if message == "" {
					message = fmt.Sprintf("runtime action failed: %s", strings.TrimSpace(a.ForwardType))
				}
				actionMessage.set("%s", message)
			}
			reportActionStatus(cfg, a, ok, actionMessage.get())
		}
		return ok
	}
	if a.HandoffOnly {
		logf("runtime handoff cleanup start %s", actionLogSummary(a))
		cleanup := cleanupStaleRuntimeBeforeApply(cfg, a, actionMessage, previousRuntime)
		invalidateLocalRuntimeReadinessCache()
		return cleanup.ok
	}
	logVerbosef("action start op=%s statusType=%s rule=%d tunnel=%d forwardType=%s port=%d protocol=%s", a.Op, a.StatusType, a.RuleID, a.TunnelID, a.ForwardType, a.SourcePort, a.Protocol)
	logIPv6ActionDiagnostic(a)
	logActionPortHandoff(a)
	if a.Op == "apply" {
		cleanup := cleanupStaleRuntimeBeforeApply(cfg, a, actionMessage, previousRuntime)
		if !cleanup.ok {
			ok = false
		} else if cleanup.preserveRunningFXP {
			logf("action preserves already-running fxp rule=%d tunnel=%d port=%d; skipping disruptive apply commands", a.RuleID, a.TunnelID, a.SourcePort)
		} else {
			cleanupKernelForwardPortBeforeApply(a)
			ok = runShellBatch(a.PreCommands) && ok
			if a.Unit != "" && a.ServiceName != "" {
				ok = writeUnitAndRestart(a.ServiceName, a.Unit, managedServiceActionSignature(a, a.ServiceName, a.Unit)) && ok
			}
			if a.UnitExtra != "" && a.ServiceNameExtra != "" {
				ok = writeUnitAndRestart(a.ServiceNameExtra, a.UnitExtra, managedServiceActionSignature(a, a.ServiceNameExtra, a.UnitExtra)) && ok
			}
			commandsOK, failureOutput := runShellBatchWithOutput(a.Commands)
			if !commandsOK && actionRequiresKernelForwardConsistency(a) {
				// 内核转发的安装失败（例如 [docker-compat] 装不上 DOCKER-USER 放行）要带着原因上报，不能只剩一个「没运行」。
				if detail := kernelForwardFailureDetail(failureOutput); detail != "" {
					actionMessage.set("kernel forward apply failed: %s", detail)
				}
			}
			ok = commandsOK && ok
		}
		if cleanup.ok && a.Fxp != nil {
			fxpOK := startFXP(cfg, *a.Fxp, a.FXPEntryGroup, actionMessage)
			if !fxpOK || agentVerboseLogs {
				logf("action fxp role=%s tunnel=%d rule=%d listen=%d udpListen=%d protocol=%s proxyReceive=%v proxySend=%v ok=%v", a.Fxp.Role, a.Fxp.TunnelID, a.Fxp.RuleID, a.Fxp.ListenPort, a.Fxp.UDPListenPort, a.Fxp.Protocol, a.Fxp.ProxyProtocolReceive, a.Fxp.ProxyProtocolSend, fxpOK)
			}
			ok = fxpOK && ok
		}
		if cleanup.ok && a.Failover != nil && a.Failover.Enabled {
			failoverOK := startFailoverProxy(a.RuleID, a.SourcePort, *a.Failover, actionMessage)
			if !failoverOK || agentVerboseLogs {
				logf("action failover rule=%d listen=%d targets=%d ok=%v", a.RuleID, a.Failover.ListenPort, len(a.Failover.Targets), failoverOK)
			}
			ok = failoverOK && ok
		}
		if cleanup.ok {
			runPostCommands(a.PostCommands, actionMessage)
		}
		if releaseRuntimeGate != nil {
			releaseRuntimeGate()
		}
		if ok && shouldVerifyManagedRuntimeListen(a) && !waitForManagedRuntimeActionListenReady(a, 12*time.Second) {
			ok = false
			message := fmt.Sprintf("managed runtime listener not ready after apply port=%d protocol=%s forwardType=%s", a.SourcePort, normalizeRuntimeProtocol(a.Protocol), strings.TrimSpace(a.ForwardType))
			// 端口被别的进程占着就说出是谁：面板在规则卡上显示红色的「端口被占用」和这个原因。
			if occupant := portOccupantSummary(a.SourcePort, a.Protocol); occupant != "" {
				message += "; " + occupant
			}
			// 服务自己的日志里最后一两行原因（IPv6 不可用、二进制没装、绑定失败……），面板换成中文显示。
			message = appendManagedRuntimeFailureDetail(message, a, defaultRuntimeFailureEnv())
			actionMessage.set("%s", message)
			if shouldLogAgentReport(fmt.Sprintf("managed-runtime-listen-missing:%d:%s:%s", a.SourcePort, normalizeRuntimeProtocol(a.Protocol), a.ForwardType), agentReportLogInterval) {
				logf("%s %s readiness={%s} owner=%s", message, actionLogSummary(a), managedRuntimeActionReadinessDiagnostic(a), listenPortOwnerSummary(a.SourcePort))
			}
			requestLocalRuntimeStateUpload()
		}
		if ok && shouldReportActionStatus(a) {
			writeState(a)
		}
	} else {
		if shouldSkipRemoveForReassignedPort(a) {
			ok = true
			skippedStaleRemove = true
		} else {
			stopFailoverProxy(a.RuleID, a.SourcePort)
			if a.Fxp != nil {
				ok = stopFXP(*a.Fxp, a.FXPEntryGroup, actionMessage) && ok
			}
			cleanupLocalManagedRuleServices(a)
			for _, name := range managedServiceNamesForAction(a) {
				cleanupManagedService(name)
			}
			commandsOK, failureOutput := runShellBatchWithOutput(a.Commands)
			if !commandsOK && actionRequiresKernelForwardConsistency(a) {
				if detail := kernelForwardFailureDetail(failureOutput); detail != "" {
					actionMessage.set("kernel forward cleanup failed: %s", detail)
				}
			}
			ok = commandsOK && ok
			if shouldReportActionStatus(a) && !actionRequiresKernelForwardConsistency(a) {
				removeState(a.SourcePort)
			}
		}
		if releaseRuntimeGate != nil {
			releaseRuntimeGate()
		}
	}
	if kernelSnapshot := newKernelForwardSnapshot(); ok && !skippedStaleRemove && actionRequiresKernelForwardConsistency(a) && !kernelSnapshot.desiredActionConsistent(a) {
		ok = false
		message := fmt.Sprintf("kernel firewall state mismatch after %s", strings.TrimSpace(a.Op))
		if reason := kernelSnapshot.actionNotReadyReason(a); reason != "" {
			message += ": " + reason
		}
		actionMessage.set("%s", message)
		if shouldLogAgentReport(fmt.Sprintf("kernel-forward-mismatch:%d:%d:%s:%s", a.RuleID, a.SourcePort, a.ForwardType, a.Op), agentReportLogInterval) {
			logf("%s %s", message, actionLogSummary(a))
		}
		requestLocalRuntimeStateUpload()
	}
	if ok && !skippedStaleRemove {
		cleanupSupersededFXPPersistence(a, previousRuntime)
	}
	if ok && !skippedStaleRemove && a.Op == "apply" {
		if desired, exists := desiredRunningRuleForAction(a); exists && countingRuleModeForForwardType(desired.ForwardType) == countingRuleProcess {
			// Heartbeat reconciliation defers counter work while this action owns
			// the listener. Schedule it as soon as the apply completes so a
			// stable next heartbeat cannot leave the new process path uncounted.
			ensureCountingChainsIfNeeded(desired)
		}
	}

	if ok && !skippedStaleRemove && a.Op == "remove" && shouldReportActionStatus(a) && actionRequiresKernelForwardConsistency(a) {
		removeState(a.SourcePort)
	}
	if skippedStaleRemove {
		requestLocalRuntimeStateUpload()
		return ok
	}
	if !shouldReportActionStatus(a) {
		// 即使不上报状态，运行时状态已变，让下次 readiness 重新采集。
		invalidateLocalRuntimeReadinessCache()
		return ok
	}
	running := ok && a.Op == "apply"
	reportActionStatus(cfg, a, running, actionMessage.get())
	invalidateLocalRuntimeReadinessCache()
	return ok
}

func cleanupSupersededFXPPersistence(a action, previousRuntime *localActionRuntimeSnapshot) {
	if !validActionPort(a.SourcePort) || a.Fxp != nil {
		return
	}
	if a.Op == "apply" {
		if previousRuntime != nil && previousRuntime.handoffState.managesFXPPersistence() {
			// The handoff transaction owns the recovery snapshot until every
			// participant has committed or the complete batch has rolled back.
			return
		}
		// A successful non-FXP replacement supersedes any old local FXP
		// snapshot on the same protocol lane. Keep it while this apply is
		// failing so a later Agent restart can still restore the last good
		// runtime.
		fxpControlMu.Lock()
		removePersistedFXPSpec(fxpSpec{ListenPort: a.SourcePort, Protocol: normalizeRuntimeProtocol(a.Protocol)})
		fxpControlMu.Unlock()
		return
	}
	if a.Op == "remove" {
		// Older panel actions may omit the FXP payload on remove. Remove the
		// matching lane by port so such actions cannot resurrect stale FXP.
		fxpControlMu.Lock()
		removePersistedFXPSpec(fxpSpec{ListenPort: a.SourcePort, Protocol: normalizeRuntimeProtocol(a.Protocol)})
		fxpControlMu.Unlock()
	}
}

func shouldVerifyManagedRuntimeListen(a action) bool {
	if strings.TrimSpace(a.Op) != "apply" || strings.TrimSpace(a.StatusType) == "runtime" || a.SourcePort <= 0 {
		return false
	}
	if a.Fxp != nil {
		return false
	}
	switch strings.TrimSpace(a.ForwardType) {
	case "realm", "socat", "gost", "gost-tunnel", "gost-tunnel-exit", "gost-tunnel-hop", "nginx", "nginx-tunnel", "nginx-tunnel-exit":
		return true
	default:
		return false
	}
}

func waitForManagedRuntimeActionListenReady(a action, timeout time.Duration) bool {
	if managedRuntimeActionListenReady(a) {
		return true
	}
	deadline := time.Now().Add(timeout)
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return managedRuntimeActionListenReady(a)
		}
		// 优先响应 invalidateLocalRuntimeReadinessCache 发出的信号（另一个 worker
		// 刚完成了影响 runtime 的动作），其次是 200ms 周期 tick，最后是超时。
		signal := managedRuntimeListenReadySignal()
		select {
		case <-signal:
		case <-ticker.C:
		case <-time.After(remaining):
			return managedRuntimeActionListenReady(a)
		}
		if managedRuntimeActionListenReady(a) {
			return true
		}
	}
}

func managedRuntimeActionListenReady(a action) bool {
	switch strings.TrimSpace(a.ForwardType) {
	case "realm", "socat":
		readiness := readLocalRuntimeReadinessCached()
		return managedRuleServiceListenReady(a.ForwardType, a.SourcePort, a.Protocol, &readiness)
	case "nginx", "nginx-tunnel", "nginx-tunnel-exit":
		return desiredNginxRuntimeReady(a.SourcePort, a.Protocol)
	case "gost", "gost-tunnel", "gost-tunnel-exit", "gost-tunnel-hop":
		return desiredGostRuntimeReady(a.SourcePort, a.Protocol, a.ForwardType)
	default:
		return true
	}
}

func managedRuntimeActionReadinessDiagnostic(a action) string {
	port := a.SourcePort
	protocol := gostRuntimeListenProtocol(a.ForwardType, a.Protocol)
	readiness := readLocalRuntimeReadiness()
	configPath := ""
	serviceName := ""
	configured := false
	protocolConfigured := false
	serviceActive := false
	socketReady := false
	ready := false
	scope := ""

	switch strings.TrimSpace(a.ForwardType) {
	case "realm", "socat":
		scope = strings.TrimSpace(a.ForwardType)
		serviceNames := managedRuleProtocolServiceNames(a.ForwardType, port, protocol)
		serviceName = strings.Join(serviceNames, ",")
		configured = len(serviceNames) > 0
		protocolConfigured = configured
		serviceActive = managedServiceGroupsActiveCached(&readiness, localRuleManagedServiceGroups(a.ForwardType, port, protocol))
		socketReady = runtimeListenPortReady(readiness.listenSnapshot, port, protocol, managedRuleListenProcessNeedles(a.ForwardType))
		ready = serviceActive && socketReady
	case "nginx", "nginx-tunnel", "nginx-tunnel-exit":
		scope = "nginx"
		configPath = nginxConfigPath
		serviceName = nginxServiceName
		configured = readiness.nginxRuntimePorts[port]
		protocolConfigured = runtimePortProtocolConfigured(readiness.nginxRuntimePortProtocols, port, protocol)
		serviceActive = readiness.serviceActiveCache[serviceName]
		socketReady = runtimeListenPortReady(readiness.listenSnapshot, port, protocol, []string{"nginx"})
		ready = readiness.nginxReadyForPort(port, protocol)
	default:
		scope = desiredGostRuntimeScope(a.ForwardType)
		useTunnelRuntime := scope == desiredGostTunnelRuntimeScope
		if useTunnelRuntime && !readiness.tunnelRuntimePorts[port] && readiness.gostRuntimePorts[port] {
			useTunnelRuntime = false
		} else if !useTunnelRuntime && !readiness.gostRuntimePorts[port] && readiness.tunnelRuntimePorts[port] {
			useTunnelRuntime = true
		}
		if useTunnelRuntime {
			configPath = tunnelRuntimeConfigPath
			serviceName = tunnelRuntimeServiceName
			configured = readiness.tunnelRuntimePorts[port]
			protocolConfigured = runtimePortProtocolConfigured(readiness.tunnelRuntimePortProtocols, port, protocol)
			socketReady = runtimeListenPortReady(readiness.listenSnapshot, port, protocol, []string{"gost", "forwardx-runt"})
			ready = readiness.gostTunnelReadyForPort(port, protocol)
		} else {
			configPath = runtimeConfigPath
			serviceName = runtimeServiceName
			configured = readiness.gostRuntimePorts[port]
			protocolConfigured = runtimePortProtocolConfigured(readiness.gostRuntimePortProtocols, port, protocol)
			socketReady = runtimeListenPortReady(readiness.listenSnapshot, port, protocol, []string{"gost", "forwardx-runt"})
			ready = readiness.gostMainReadyForPort(port, protocol)
		}
		serviceActive = readiness.serviceActiveCache[serviceName]
	}

	return fmt.Sprintf(
		"scope=%s config=%s listener=%s configured=%v protocolConfigured=%v service=%s active=%v socketReady=%v ready=%v",
		scope,
		configPath,
		managedRuntimeConfigListenSummary(configPath, port),
		configured,
		protocolConfigured,
		serviceName,
		serviceActive,
		socketReady,
		ready,
	)
}

func managedRuntimeConfigListenSummary(path string, port int) string {
	if strings.TrimSpace(path) == "" || port <= 0 {
		return "none"
	}
	var listens []runtimeListenConfig
	var ok bool
	if strings.HasSuffix(path, ".json") {
		listens, ok = readGostRuntimeServiceListens(path)
	} else {
		listens, ok = nginxRuntimeListenConfigs(path)
	}
	if !ok {
		return "unreadable"
	}
	matches := make([]string, 0, 2)
	for _, listen := range listens {
		if addrUsesPort(listen.Addr, port) {
			matches = append(matches, fmt.Sprintf("%s@%s", strings.TrimSpace(listen.Protocol), strings.TrimSpace(listen.Addr)))
		}
	}
	if len(matches) == 0 {
		return "none"
	}
	sort.Strings(matches)
	return strings.Join(matches, ",")
}

func reportActionStatus(cfg Config, a action, running bool, message string) {
	if !shouldReportActionStatus(a) {
		return
	}
	enqueueActionStatusReport(cfg, a, running, message)
}

func actionCommandSignature(a action) string {
	h := fnv.New64a()
	write := func(value string) {
		_, _ = h.Write([]byte(value))
		_, _ = h.Write([]byte{0})
	}
	write(a.Op)
	write(a.StatusType)
	write(a.ForwardType)
	write(strings.TrimSpace(a.RuntimeBackendForwardType))
	write(strconv.Itoa(a.RuleID))
	write(strconv.Itoa(a.TunnelID))
	write(strconv.Itoa(a.SourcePort))
	write(strings.TrimSpace(a.TargetIP))
	write(strconv.Itoa(a.TargetPort))
	write(normalizeRuntimeProtocol(a.Protocol))
	write(a.ServiceName)
	write(a.ServiceNameExtra)
	write(a.Unit)
	write(a.UnitExtra)
	if len(a.PortAccessLimits) > 0 {
		if raw, err := json.Marshal(a.PortAccessLimits); err == nil {
			write(string(raw))
		}
	}
	if a.ForceRuntimeSync {
		write("force-runtime-sync")
	}
	for _, cmd := range a.PreCommands {
		write(cmd)
	}
	for _, cmd := range a.Commands {
		write(cmd)
	}
	for _, cmd := range a.RemovalCommands {
		write(cmd)
	}
	write(strings.TrimSpace(a.RemovalToken))
	for _, config := range a.ManagedConfigs {
		if raw, err := json.Marshal(config); err == nil {
			write(string(raw))
		}
	}
	for _, cmd := range a.RollbackCommands {
		write(cmd)
	}
	for _, cmd := range a.PostCommands {
		write(cmd)
	}
	if a.Fxp != nil {
		if raw, err := json.Marshal(a.Fxp); err == nil {
			write(string(raw))
		}
	}
	if a.WireGuard != nil {
		if raw, err := json.Marshal(a.WireGuard); err == nil {
			write(string(raw))
		}
	}
	// 线路组规格去掉运行时提示再算（failoverSpecSignatureJSON）：提示变了不重新执行动作。
	if raw, ok := failoverSpecSignatureJSON(a.Failover); ok {
		write(raw)
	}
	return strconv.FormatUint(h.Sum64(), 16)
}

func logActionPortHandoff(a action) {
	if a.SourcePort <= 0 {
		return
	}
	port := strconv.Itoa(a.SourcePort)
	localRuleID := readRuleIDByPort(port)
	localForwardType := readForwardTypeByPort(port)
	if localRuleID <= 0 && localForwardType == "" {
		return
	}
	if a.Op == "apply" && (localRuleID != a.RuleID || (localForwardType != "" && localForwardType != a.ForwardType)) {
		logf(
			"runtime handoff port=%d oldRule=%d oldForwardType=%s newRule=%d newForwardType=%s tunnel=%d hasFXP=%v commands=%d",
			a.SourcePort,
			localRuleID,
			localForwardType,
			a.RuleID,
			a.ForwardType,
			a.TunnelID,
			a.Fxp != nil,
			len(a.Commands),
		)
	}
	if a.Op == "remove" {
		logf(
			"runtime remove port=%d localRule=%d localForwardType=%s rule=%d forwardType=%s tunnel=%d hasFXP=%v commands=%d",
			a.SourcePort,
			localRuleID,
			localForwardType,
			a.RuleID,
			a.ForwardType,
			a.TunnelID,
			a.Fxp != nil,
			len(a.Commands),
		)
	}
}

func shouldReportActionStatus(a action) bool {
	return a.ReportStatus == nil || *a.ReportStatus
}

type actionMessage struct {
	mu  sync.Mutex
	msg string
}

func newActionMessage() *actionMessage {
	return &actionMessage{}
}

func (m *actionMessage) set(format string, args ...any) {
	if m == nil {
		return
	}
	msg := fmt.Sprintf(format, args...)
	m.mu.Lock()
	m.msg = msg
	m.mu.Unlock()
	logf("%s", msg)
}

func (m *actionMessage) remember(format string, args ...any) {
	if m == nil {
		return
	}
	msg := fmt.Sprintf(format, args...)
	m.mu.Lock()
	m.msg = msg
	m.mu.Unlock()
}

func (m *actionMessage) get() string {
	if m == nil {
		return ""
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.msg
}
