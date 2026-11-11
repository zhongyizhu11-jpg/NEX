package main

import (
	"strconv"
	"strings"
	"time"
)

type staleRuntimeCleanupResult struct {
	preserveRunningFXP bool
	ok                 bool
}

func sharedRuntimeOwnerTransition(a action, previousRuntime *localActionRuntimeSnapshot) (string, string, bool) {
	if previousRuntime == nil || !previousRuntime.valid {
		return "", "", false
	}
	previousOwner := sharedRuntimeOwnerForForwardType(previousRuntime.forwardType)
	desiredOwner := sharedRuntimeOwnerForAction(a)
	return previousOwner, desiredOwner, previousOwner != "" && previousOwner != desiredOwner
}

func previousSharedRuntimeServiceNames(previousRuntime *localActionRuntimeSnapshot, listenPort int, protocol string) []string {
	if previousRuntime == nil {
		return nil
	}
	previousForwardType := strings.TrimSpace(previousRuntime.forwardType)
	switch sharedRuntimeOwnerForForwardType(previousForwardType) {
	case "nginx-runtime-sync":
		return []string{nginxServiceName}
	case "gost-runtime-sync":
		seen := map[string]bool{}
		services := make([]string, 0, 2)
		appendService := func(name string) {
			name = sanitizeServiceName(name)
			if name == "" || seen[name] {
				return
			}
			seen[name] = true
			services = append(services, name)
		}
		for _, path := range managedGostConfigPathsForListenPortProtocol(listenPort, protocol) {
			if path == nginxConfigPath {
				continue
			}
			appendService(managedGostServiceNameForConfig(path))
		}
		if len(services) > 0 {
			return services
		}

		candidates := []string{runtimeConfigPath, legacyRuntimeConfigPath, legacyGostConfigPath}
		fallback := runtimeServiceName
		if desiredGostRuntimeScope(previousForwardType) == desiredGostTunnelRuntimeScope {
			candidates = []string{tunnelRuntimeConfigPath, legacyTunnelRuntimeConfigPath, legacyTunnelConfigPath}
			fallback = tunnelRuntimeServiceName
		}
		for _, path := range candidates {
			if managedRuntimeConfigUsesPort(path, listenPort) {
				appendService(managedGostServiceNameForConfig(path))
			}
		}
		if len(services) == 0 {
			appendService(fallback)
		}
		return services
	default:
		return nil
	}
}

func stopPreviousSharedRuntimeForHandoff(a action, previousRuntime *localActionRuntimeSnapshot, actionMessage *actionMessage) bool {
	previousOwner, desiredOwner, changed := sharedRuntimeOwnerTransition(a, previousRuntime)
	if !changed {
		return true
	}
	if previousRuntime.handoffState == nil {
		previousRuntime.handoffState = &actionHandoffState{}
	}
	protocol := a.Protocol
	if previousRuntime.hasProtocol {
		protocol = previousRuntime.protocol
	}
	services := previousSharedRuntimeServiceNames(previousRuntime, a.SourcePort, protocol)
	for _, service := range services {
		if !previousRuntime.handoffState.registerStoppedSharedService(service) {
			continue
		}
		logf("shared runtime handoff stopping old service=%s owner=%s desiredOwner=%s port=%d protocol=%s", service, previousOwner, desiredOwner, a.SourcePort, normalizeRuntimeProtocol(protocol))
		if !stopManagedServiceProcessForHandoff(service) {
			actionMessage.set("shared runtime handoff failed stopping %s for port=%d", service, a.SourcePort)
			return false
		}
	}
	invalidateLocalRuntimeReadinessCache()
	oldAction := a
	oldAction.ForwardType = previousRuntime.forwardType
	oldAction.Protocol = protocol
	if !waitForActionListenPortFree(oldAction, 3*time.Second) {
		actionMessage.set("shared runtime handoff port still busy after stopping owner=%s port=%d protocol=%s", previousOwner, a.SourcePort, normalizeRuntimeProtocol(protocol))
		logf("shared runtime handoff port still busy owner=%s desiredOwner=%s port=%d protocol=%s listeners=%s", previousOwner, desiredOwner, a.SourcePort, normalizeRuntimeProtocol(protocol), listenPortOwnerSummary(a.SourcePort))
		return false
	}
	return true
}

func cleanupStaleRuntimeBeforeApply(cfg Config, a action, actionMessage *actionMessage, previousRuntime *localActionRuntimeSnapshot) staleRuntimeCleanupResult {
	if a.Op != "apply" || !validActionPort(a.SourcePort) {
		return staleRuntimeCleanupResult{ok: true}
	}
	if a.HandoffOnly && !stopPreviousSharedRuntimeForHandoff(a, previousRuntime, actionMessage) {
		return staleRuntimeCleanupResult{}
	}
	port := strconv.Itoa(a.SourcePort)
	previousOwner, _, sharedOwnerChanged := sharedRuntimeOwnerTransition(a, previousRuntime)
	preservePreviousSharedNginx := a.HandoffOnly && sharedOwnerChanged && previousOwner == "nginx-runtime-sync"
	sharedNginxRuntimePort := actionPortOwnedBySharedNginx(a) || preservePreviousSharedNginx
	if a.StatusType == "tunnel" && a.TunnelID > 0 {
		localTunnelID := readTunnelIDByPort(port)
		localForwardType := readTunnelForwardTypeByPort(port)
		if shouldUsePreviousTunnelRuntime(a, localTunnelID, localForwardType, previousRuntime) {
			localTunnelID = previousRuntime.tunnelID
			localForwardType = previousRuntime.forwardType
			logf("tunnel runtime cleanup uses queued owner snapshot port=%d oldTunnel=%d oldForwardType=%s", a.SourcePort, localTunnelID, localForwardType)
		}
		if localTunnelID <= 0 && localForwardType == "" {
			if fxpMatchesRunning(a.Fxp, a.FXPEntryGroup) {
				writeState(a)
				return staleRuntimeCleanupResult{preserveRunningFXP: true, ok: true}
			}
			if actionUsesManagedListener(a) && unknownManagedListenerCleanupNeeded(a.SourcePort, gostRuntimeListenProtocol(a.ForwardType, a.Protocol)) {
				if !cleanupUnknownManagedListener(cfg, port, a.SourcePort, a.ForwardType, gostRuntimeListenProtocol(a.ForwardType, a.Protocol), actionMessage) {
					return staleRuntimeCleanupResult{}
				}
				if !sharedNginxRuntimePort {
					waitForActionListenPortFree(a, 2*time.Second)
				}
			}
			cleanupGostRuntimeIfPortBusy(a.SourcePort, gostRuntimeListenProtocol(a.ForwardType, a.Protocol))
			if !sharedNginxRuntimePort {
				waitForActionListenPortFree(a, 2*time.Second)
			}
			return staleRuntimeCleanupResult{ok: true}
		}
		if localTunnelID == a.TunnelID && (localForwardType == "" || localForwardType == a.ForwardType) {
			if fxpMatchesRunning(a.Fxp, a.FXPEntryGroup) {
				writeState(a)
				return staleRuntimeCleanupResult{preserveRunningFXP: true, ok: true}
			}
			if desiredActionLocalRuntimeReady(a) {
				return staleRuntimeCleanupResult{ok: true}
			}
			if actionUsesManagedListener(a) && !fxpActionListenerOwnedByRuntime(a) && unknownManagedListenerCleanupNeeded(a.SourcePort, gostRuntimeListenProtocol(a.ForwardType, a.Protocol)) {
				if !cleanupUnknownManagedListener(cfg, port, a.SourcePort, a.ForwardType, gostRuntimeListenProtocol(a.ForwardType, a.Protocol), actionMessage) {
					return staleRuntimeCleanupResult{}
				}
				if !sharedNginxRuntimePort {
					waitForActionListenPortFree(a, 2*time.Second)
				}
			}
			return staleRuntimeCleanupResult{ok: true}
		}
		logf(
			"tunnel runtime cleanup before apply port=%d oldTunnel=%d oldForwardType=%s newTunnel=%d newForwardType=%s",
			a.SourcePort,
			localTunnelID,
			localForwardType,
			a.TunnelID,
			a.ForwardType,
		)
		if localForwardType == "forwardx-tunnel" && localTunnelID > 0 {
			handoffProtocol := a.Protocol
			var handoffState *actionHandoffState
			if previousRuntime != nil {
				handoffState = previousRuntime.handoffState
				if previousRuntime.hasProtocol {
					handoffProtocol = previousRuntime.protocol
				}
			}
			if !stopStaleForwardXTunnelRuntimeWithRollback(
				cfg,
				localForwardType,
				localTunnelID,
				a.SourcePort,
				handoffProtocol,
				actionMessage,
				handoffState,
			) {
				actionMessage.set("fxp tunnel handoff failed tunnel=%d port=%d protocol=%s", localTunnelID, a.SourcePort, normalizeRuntimeProtocol(handoffProtocol))
				return staleRuntimeCleanupResult{}
			}
		}
		if a.Fxp != nil {
			if !stopFXPByListenEndpoint(a.SourcePort, a.Protocol) {
				actionMessage.set("fxp listen handoff failed port=%d protocol=%s", a.SourcePort, normalizeRuntimeProtocol(a.Protocol))
				return staleRuntimeCleanupResult{}
			}
		}
		for _, cmd := range managedPortCleanupCmdsForApply(port, sharedNginxRuntimePort) {
			_ = runShell(cmd)
		}
		if !sharedNginxRuntimePort {
			waitForActionListenPortFree(a, 2*time.Second)
		}
		removeTunnelStateByPort(port)
		return staleRuntimeCleanupResult{ok: true}
	}
	if a.RuleID <= 0 {
		return staleRuntimeCleanupResult{ok: true}
	}
	localRuleID := readRuleIDByPort(port)
	localForwardType := readForwardTypeByPort(port)
	localRuleTunnelID := readRuleTunnelIDByPort(port)
	_, _, localProtocol, hasLocalProtocol := readTargetInfo(port)
	if shouldUsePreviousRuleRuntime(a, localRuleID, localForwardType, localRuleTunnelID, localProtocol, hasLocalProtocol, previousRuntime) {
		localRuleID = previousRuntime.ruleID
		localForwardType = previousRuntime.forwardType
		localRuleTunnelID = previousRuntime.tunnelID
		localProtocol = previousRuntime.protocol
		hasLocalProtocol = previousRuntime.hasProtocol
		logf("rule runtime cleanup uses queued owner snapshot port=%d oldRule=%d oldTunnel=%d oldForwardType=%s", a.SourcePort, localRuleID, localRuleTunnelID, localForwardType)
	}
	if localRuleID <= 0 && localForwardType == "" {
		if fxpMatchesRunning(a.Fxp, a.FXPEntryGroup) {
			writeState(a)
			if a.Fxp != nil && isSharedFXPEntry(*a.Fxp) {
				// The first action can start every listener in the shared group.
				// Each sibling action must still install its own counters and marker files.
				return staleRuntimeCleanupResult{ok: true}
			}
			return staleRuntimeCleanupResult{preserveRunningFXP: true, ok: true}
		}
		if actionUsesManagedListener(a) && unknownManagedListenerCleanupNeeded(a.SourcePort, gostRuntimeListenProtocol(a.ForwardType, a.Protocol)) {
			if !cleanupUnknownManagedListener(cfg, port, a.SourcePort, a.ForwardType, gostRuntimeListenProtocol(a.ForwardType, a.Protocol), actionMessage) {
				return staleRuntimeCleanupResult{}
			}
			if !sharedNginxRuntimePort {
				waitForActionListenPortFree(a, 2*time.Second)
			}
		}
		cleanupGostRuntimeIfPortBusy(a.SourcePort, gostRuntimeListenProtocol(a.ForwardType, a.Protocol))
		if !sharedNginxRuntimePort {
			waitForActionListenPortFree(a, 2*time.Second)
		}
		return staleRuntimeCleanupResult{ok: true}
	}
	if localRuleID == a.RuleID && (localRuleTunnelID <= 0 || localRuleTunnelID == a.TunnelID) && (localForwardType == "" || localForwardType == a.ForwardType) {
		if fxpMatchesRunning(a.Fxp, a.FXPEntryGroup) {
			writeState(a)
			if a.Fxp != nil && isSharedFXPEntry(*a.Fxp) {
				return staleRuntimeCleanupResult{ok: true}
			}
			return staleRuntimeCleanupResult{preserveRunningFXP: true, ok: true}
		}
		if desiredActionLocalRuntimeReady(a) {
			return staleRuntimeCleanupResult{ok: true}
		}
		if hasLocalProtocol && normalizeRuntimeProtocol(localProtocol) != normalizeRuntimeProtocol(a.Protocol) {
			if cleanupManagedRuleProtocol(localForwardType, a.SourcePort, localProtocol) {
				waitForActionListenPortFree(a, 2*time.Second)
			}
		}
		if actionUsesManagedListener(a) && !fxpActionListenerOwnedByRuntime(a) && unknownManagedListenerCleanupNeeded(a.SourcePort, gostRuntimeListenProtocol(a.ForwardType, a.Protocol)) {
			if !cleanupUnknownManagedListener(cfg, port, a.SourcePort, a.ForwardType, gostRuntimeListenProtocol(a.ForwardType, a.Protocol), actionMessage) {
				return staleRuntimeCleanupResult{}
			}
			if !sharedNginxRuntimePort {
				waitForActionListenPortFree(a, 2*time.Second)
			}
		}
		return staleRuntimeCleanupResult{ok: true}
	}
	if localRuleID > 0 && localRuleID != a.RuleID && hasLocalProtocol && !runtimeProtocolsOverlap(localProtocol, a.Protocol) {
		// The legacy marker stores only one rule per numeric port. A valid UDP
		// marker can therefore hide a leaked TCP Realm/Socat service (and vice
		// versa). Clean only the lane needed by this apply; keep the disjoint rule.
		if unknownManagedListenerCleanupNeeded(a.SourcePort, gostRuntimeListenProtocol(a.ForwardType, a.Protocol)) {
			if !cleanupUnknownManagedListener(cfg, port, a.SourcePort, a.ForwardType, gostRuntimeListenProtocol(a.ForwardType, a.Protocol), actionMessage) {
				return staleRuntimeCleanupResult{}
			}
		}
		cleanupGostRuntimeIfPortBusy(a.SourcePort, gostRuntimeListenProtocol(a.ForwardType, a.Protocol))
		if !sharedNginxRuntimePort {
			waitForActionListenPortFree(a, 2*time.Second)
		}
		return staleRuntimeCleanupResult{ok: true}
	}
	logf(
		"runtime cleanup before apply port=%d oldRule=%d oldForwardType=%s newRule=%d newForwardType=%s",
		a.SourcePort,
		localRuleID,
		localForwardType,
		a.RuleID,
		a.ForwardType,
	)
	cleanupProtocol := "both"
	if hasLocalProtocol {
		cleanupProtocol = localProtocol
	}
	var handoffState *actionHandoffState
	if previousRuntime != nil {
		handoffState = previousRuntime.handoffState
	}
	if !stopStaleForwardXRuleRuntimeWithRollback(cfg, localForwardType, localRuleID, localRuleTunnelID, a.SourcePort, cleanupProtocol, actionMessage, handoffState) {
		return staleRuntimeCleanupResult{}
	}
	if a.Fxp != nil {
		if !stopFXPByListenEndpoint(a.SourcePort, a.Protocol) {
			actionMessage.set("fxp listen handoff failed port=%d protocol=%s", a.SourcePort, normalizeRuntimeProtocol(a.Protocol))
			return staleRuntimeCleanupResult{}
		}
	}
	if localRuleID > 0 {
		stopFailoverProxyRuntime(localRuleID, a.SourcePort)
	}
	if localForwardType == "nftables" && localRuleID > 0 {
		_ = runShell(nftRuleCleanupCmd(localRuleID))
	}
	if isKernelForwardType(localForwardType) && !isKernelForwardType(a.ForwardType) && localRuleID > 0 {
		cleanupDockerCompatAllowances(localRuleID, a.SourcePort, runtimeProtocols(cleanupProtocol))
	}
	for _, cmd := range managedPortCleanupCmdsForApply(port, sharedNginxRuntimePort) {
		_ = runShell(cmd)
	}
	if !sharedNginxRuntimePort {
		waitForActionListenPortFree(a, 2*time.Second)
	}
	return staleRuntimeCleanupResult{ok: true}
}

func shouldUsePreviousTunnelRuntime(a action, localTunnelID int, localForwardType string, previous *localActionRuntimeSnapshot, targetReadyOverride ...bool) bool {
	if previous == nil || !previous.valid || !previous.tunnel {
		return false
	}
	currentMatches := !tunnelActionNeedsPreRuntimeHandoff(a, localTunnelID, localForwardType)
	previousDiffers := tunnelActionNeedsPreRuntimeHandoff(a, previous.tunnelID, previous.forwardType)
	targetReady := false
	if len(targetReadyOverride) > 0 {
		targetReady = targetReadyOverride[0]
	} else {
		targetReady = desiredActionLocalRuntimeReady(a)
	}
	return currentMatches && previousDiffers && !targetReady
}

func shouldUsePreviousRuleRuntime(a action, localRuleID int, localForwardType string, localTunnelID int, localProtocol string, hasLocalProtocol bool, previous *localActionRuntimeSnapshot, targetReadyOverride ...bool) bool {
	if previous == nil || !previous.valid || previous.tunnel {
		return false
	}
	currentMatches := !ruleActionNeedsPreRuntimeHandoff(a, localRuleID, localForwardType, localTunnelID, localProtocol, hasLocalProtocol)
	previousDiffers := ruleActionNeedsPreRuntimeHandoff(a, previous.ruleID, previous.forwardType, previous.tunnelID, previous.protocol, previous.hasProtocol)
	targetReady := false
	if len(targetReadyOverride) > 0 {
		targetReady = targetReadyOverride[0]
	} else {
		targetReady = desiredActionLocalRuntimeReady(a)
	}
	return currentMatches && previousDiffers && !targetReady
}

func stopStaleForwardXRuleRuntime(cfg Config, localForwardType string, localRuleID int, localTunnelID int, listenPort int, protocol string, actionMessage *actionMessage) bool {
	return stopStaleForwardXRuleRuntimeWithRollback(cfg, localForwardType, localRuleID, localTunnelID, listenPort, protocol, actionMessage, nil)
}

func stopStaleForwardXTunnelRuntimeWithRollback(cfg Config, localForwardType string, localTunnelID int, listenPort int, protocol string, actionMessage *actionMessage, handoffState *actionHandoffState) bool {
	if strings.TrimSpace(localForwardType) != "forwardx-tunnel" || localTunnelID <= 0 || !validActionPort(listenPort) {
		return true
	}
	return handoffFXPBySelectorWithRollback(cfg, fxpRuntimeSelector{
		tunnelID:   localTunnelID,
		listenPort: listenPort,
		protocol:   protocol,
	}, actionMessage, handoffState)
}

func stopStaleForwardXRuleRuntimeWithRollback(cfg Config, localForwardType string, localRuleID int, localTunnelID int, listenPort int, protocol string, actionMessage *actionMessage, handoffState *actionHandoffState) bool {
	if strings.TrimSpace(localForwardType) != "forwardx" || localRuleID <= 0 || listenPort <= 0 {
		return true
	}

	// V1 and V2 entry rules can share one entry-group process. Its runtime ID
	// no longer contains the individual rule ID, so retire the actual listener
	// owner before applying a non-FXP replacement. Keep the persisted snapshot
	// until the replacement succeeds so a failed handoff remains recoverable.
	return handoffFXPBySelectorWithRollback(cfg, fxpRuntimeSelector{
		role:       "entry",
		tunnelID:   localTunnelID,
		ruleID:     localRuleID,
		listenPort: listenPort,
		protocol:   protocol,
	}, actionMessage, handoffState)
}

func actionUsesSharedNginxRuntime(a action) bool {
	switch strings.TrimSpace(a.ForwardType) {
	case "nginx", "nginx-tunnel", "nginx-tunnel-exit":
		return true
	default:
		return false
	}
}

func actionPortOwnedBySharedNginx(a action) bool {
	return actionUsesSharedNginxRuntime(a) && validActionPort(a.SourcePort) && nginxRuntimeConfigUsesPort(nginxConfigPath, a.SourcePort)
}

func managedPortCleanupCmdsForApply(port string, keepSharedNginx bool) []string {
	if keepSharedNginx {
		return managedPortCleanupCmdsWithNginx(port, false)
	}
	return managedPortCleanupCmds(port)
}

func actionUsesManagedListener(a action) bool {
	if a.Fxp != nil {
		return true
	}
	switch a.ForwardType {
	case "realm", "socat", "gost", "nginx", "forwardx", "forwardx-tunnel", "gost-tunnel", "nginx-tunnel":
		return true
	default:
		return false
	}
}

func cleanupUnknownManagedListener(cfg Config, port string, listenPort int, forwardType string, protocol string, actionMessage *actionMessage) bool {
	logf("runtime cleanup unknown local state port=%s protocol=%s newForwardType=%s", port, normalizeRuntimeProtocol(protocol), forwardType)
	if !handoffFXPBySelector(cfg, fxpRuntimeSelector{listenPort: listenPort, protocol: protocol}, actionMessage) {
		return false
	}
	for _, name := range managedListenerServiceNamesForProtocol(listenPort, protocol) {
		cleanupManagedService(name)
		if strings.HasPrefix(name, "forwardx-realm-") {
			_ = runShell("rm -f /etc/forwardx/realm/" + name + ".toml /etc/forwardx/realm/" + name + ".toml.sha256 2>/dev/null || true")
		}
	}
	for _, cmd := range managedListenerCleanupCmdsForProtocol(port, protocol) {
		_ = runShell(cmd)
	}
	return true
}

func managedListenerServiceNamesForProtocol(port int, protocol string) []string {
	if !validActionPort(port) {
		return nil
	}
	portText := strconv.Itoa(port)
	seen := map[string]bool{}
	names := []string{}
	appendName := func(name string) {
		if name == "" || seen[name] {
			return
		}
		seen[name] = true
		names = append(names, name)
	}
	for _, proto := range runtimeProtocols(protocol) {
		if proto == "udp" {
			appendName("forwardx-socat-udp-" + portText)
			appendName("forwardx-realm-udp-" + portText)
			appendName("forwardx-realm-both-" + portText)
			continue
		}
		appendName("forwardx-socat-" + portText)
		appendName("forwardx-socat-tcp-" + portText)
		appendName("forwardx-realm-" + portText)
		appendName("forwardx-realm-tcp-" + portText)
		appendName("forwardx-realm-both-" + portText)
	}
	return names
}

func cleanupGostRuntimeIfPortBusy(port int, protocol string) {
	if !validActionPort(port) {
		return
	}
	for _, proto := range runtimeProtocols(protocol) {
		cleanupGostRuntimeProtocolIfPortBusy(port, proto)
	}
}

func cleanupGostRuntimeProtocolIfPortBusy(port int, protocol string) {
	protocol = normalizeRuntimeProtocol(protocol)
	if !listenPortBusy(protocol, port) {
		return
	}
	handled := false
	for _, configPath := range managedGostConfigPathsForListenPortProtocol(port, protocol) {
		svcName := managedGostServiceNameForConfig(configPath)
		if svcName == "" {
			continue
		}
		if managedRuntimeConfigUsesPortProtocol(configPath, port, protocol) {
			// Only preserve the shared runtime when the process that actually owns
			// this protocol lane uses the matching managed config. Merely seeing the
			// port in a new config is insufficient; a leaked Realm process may own it.
			logf("runtime cleanup keeps shared %s for busy port=%d protocol=%s config=%s", svcName, port, protocol, configPath)
			handled = true
			continue
		}
		serviceCount, ok := managedRuntimeConfigServiceCount(configPath)
		if !ok || serviceCount > 0 {
			logf("runtime cleanup restarting %s for stale gost listener port=%d protocol=%s config=%s", svcName, port, protocol, configPath)
			restartManagedService(svcName)
		} else {
			logf("runtime cleanup stopping %s for stale gost listener port=%d protocol=%s config=%s", svcName, port, protocol, configPath)
			cleanupManagedService(svcName)
		}
		handled = true
	}
	if !handled {
		logf("runtime cleanup found busy port=%d protocol=%s but owner is not a managed shared runtime: %s", port, protocol, listenPortOwnerSummary(port))
	}
}

func sharedManagedRuntimeOwnsPort(configPath string, port int) bool {
	return validActionPort(port) && managedRuntimeConfigUsesPort(configPath, port)
}

func sharedManagedRuntimeOwnsPortProtocol(configPath string, port int, protocol string) bool {
	return validActionPort(port) && managedRuntimeConfigUsesPortProtocol(configPath, port, protocol)
}

func managedRuntimeConfigUsesPort(path string, port int) bool {
	if strings.HasSuffix(path, ".json") {
		return gostRuntimeConfigUsesPort(path, port)
	}
	return nginxRuntimeConfigUsesPort(path, port)
}

func managedRuntimeConfigUsesPortProtocol(path string, port int, protocol string) bool {
	var listens []runtimeListenConfig
	var ok bool
	if strings.HasSuffix(path, ".json") {
		listens, ok = readGostRuntimeServiceListens(path)
	} else {
		listens, ok = nginxRuntimeListenConfigs(path)
	}
	if !ok {
		return false
	}
	protocol = normalizeRuntimeProtocol(protocol)
	for _, listen := range listens {
		if addrUsesPort(listen.Addr, port) && normalizeRuntimeProtocol(listen.Protocol) == protocol {
			return true
		}
	}
	return false
}
