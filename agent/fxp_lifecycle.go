package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

func startFXPLocked(cfg Config, spec fxpSpec, desiredGroup *fxpSpec, actionMessage *actionMessage) bool {
	spec = normalizeFXPSpec(spec)
	if isSharedFXPEntry(spec) {
		var group fxpSpec
		ok := false
		if desiredGroup != nil {
			group = normalizeFXPSpec(*desiredGroup)
			ok = isFXPEntryGroup(group) && group.TransportVersion == spec.TransportVersion && group.TunnelID == spec.TunnelID && fxpEntryGroupContains(group, spec)
		}
		if desiredGroup == nil {
			group, ok = desiredSharedFXPEntryGroup(&spec, nil)
		}
		if !ok {
			actionMessage.set("fxp entry group invalid tunnel=%d rule=%d port=%d", spec.TunnelID, spec.RuleID, spec.ListenPort)
			return false
		}
		return startFXPProcessLocked(cfg, group, actionMessage)
	}
	return startFXPProcessLocked(cfg, spec, actionMessage)
}

func startFXPProcessLocked(cfg Config, spec fxpSpec, actionMessage *actionMessage) bool {
	return startFXPProcessLockedWithPersistence(cfg, spec, actionMessage, true)
}

func startFXPProcessLockedWithPersistence(cfg Config, spec fxpSpec, actionMessage *actionMessage, persistenceEnabled bool) bool {
	spec = normalizeFXPSpec(spec)
	if (!isFXPEntryGroup(spec) && (spec.Key == "" || spec.ListenPort <= 0)) || (isFXPEntryGroup(spec) && len(spec.Entries) == 0) {
		actionMessage.set("fxp invalid config role=%s tunnel=%d rule=%d port=%d", spec.Role, spec.TunnelID, spec.RuleID, spec.ListenPort)
		return false
	}
	runtimePath, err := resolveFXPRuntimeExecutable()
	if err != nil || runtimePath == "" {
		actionMessage.set("fxp runtime missing: install /usr/local/bin/forwardx-fxp to use custom encrypted tunnels")
		return false
	}
	// 旧 FXP 握不上新协议：宁可让动作失败、在面板上写清楚原因，也不要跑一个注定连不通的进程。
	if err := fxpRuntimeCompatibilityError(); err != nil {
		actionMessage.set("%v", err)
		return false
	}
	originalSpec := spec
	runtimeExecutable := currentFXPRuntimeExecutableInfo()
	expectedCredentialDigest := fxpPanelCredentialDigest(currentPanelURL(cfg), cfg.Token)

	id := fxpServerID(spec)
	wireGuardRefID := id
	if spec.TransportVersion == forwardXWireGuardVersion {
		wireGuardRefID = fmt.Sprintf("%s#%d", id, atomic.AddUint64(&fxpWireGuardRefSequence, 1))
	}
	signature := fxpServerSignature(spec)
	configPath := fxpConfigPath(spec)
	var previousSame *fxpSpec
	fxpMu.Lock()
	existing := fxpServers[id]
	existingActive := existing != nil && fxpProcessActive(existing)
	existingMatches := existingActive && existing.signature == signature
	if existingActive {
		copy := existing.spec
		previousSame = &copy
	}
	fxpMu.Unlock()
	if existingMatches {
		existingMatches = fxpProcessUsesCurrentExecutable(existing) &&
			fxpProcessUsesPanelCredentialDigest(existing, expectedCredentialDigest)
	}
	if existingMatches {
		readiness := readLocalRuntimeReadinessCached()
		existingMatches = fxpRuntimeListenersReady(spec, readiness.listenSnapshot) &&
			wireGuardFXPProxiesReady(spec)
	}
	if existingMatches {
		logf("fxp %s already running tunnel=%d rule=%d listen=:%d protocol=%s", spec.Role, spec.TunnelID, spec.RuleID, spec.ListenPort, spec.Protocol)
		// A tracked process can outlive its persistent snapshot (for example
		// after a handoff or a partial state-directory cleanup). Refresh the
		// last-known-good plan while reusing the healthy listener so the next
		// Agent restart can restore it without disrupting traffic now.
		if persistenceEnabled {
			if err := persistFXPSpec(originalSpec); err != nil {
				logf("fxp persistent snapshot refresh failed tunnel=%d rule=%d port=%d: %v", originalSpec.TunnelID, originalSpec.RuleID, originalSpec.ListenPort, err)
			}
		}
		return true
	}
	// 配置变了、进程还活着：先试着原地热更新，连接一条不断；不行再走下面的重建。
	if existingActive && existing.signature != signature &&
		reloadFXPRuntimeLocked(cfg, existing, id, spec, signature, configPath, expectedCredentialDigest, persistenceEnabled) {
		return true
	}
	if existingActive && existing.signature == signature {
		logf("fxp dependency or listener drift detected; rebuilding role=%s version=%s tunnel=%d rule=%d", spec.Role, spec.TransportVersion, spec.TunnelID, spec.RuleID)
	}
	if adoptExistingFXP(spec, signature, configPath, expectedCredentialDigest) {
		if persistenceEnabled {
			if err := persistFXPSpec(originalSpec); err != nil {
				logf("fxp persistent snapshot refresh failed tunnel=%d rule=%d port=%d: %v", originalSpec.TunnelID, originalSpec.RuleID, originalSpec.ListenPort, err)
				return false
			}
		}
		return true
	}
	// The persistent snapshot belongs to the desired runtime and must survive
	// this in-process replacement. Explicit remove paths call stopFXP instead.
	stopFXPRuntime(spec)
	conflictingSpecs := stopConflictingFXPRuntime(spec)
	transitionCommitted := false
	desiredStarted := false
	replacementSpecs := make([]fxpSpec, 0, len(conflictingSpecs))
	defer func() {
		if !transitionCommitted {
			restoreFXPTransitionLocked(cfg, originalSpec, desiredStarted, previousSame, conflictingSpecs, replacementSpecs, persistenceEnabled)
		}
	}()
	// When mimic is enabled, UDPListenPort (mimicPort) differs from ListenPort (TCP port).
	// fxpPortCleanupCmds matches by config filename which always ends in ListenPort, so
	// using it with mimicPort would never match. Clear stale FXP occupants of the UDP port.
	if spec.UDPListenPort > 0 && spec.UDPListenPort != spec.ListenPort {
		killManagedFXPOnUDPPort(spec.UDPListenPort)
	}
	if ready, lane, owner := waitForFXPListenEndpointsFree(spec); !ready {
		staleConfigPaths := []string{configPath}
		for _, conflicting := range conflictingSpecs {
			staleConfigPaths = append(staleConfigPaths, fxpConfigPath(conflicting))
		}
		for _, staleConfigPath := range staleConfigPaths {
			killFXPByConfigPath(staleConfigPath)
		}
		logf("fxp replacement forced stale runtime exit role=%s tunnel=%d rule=%d lane=%s owner=%s", spec.Role, spec.TunnelID, spec.RuleID, lane, owner)
		if forcedReady, forcedLane, forcedOwner := waitForFXPListenEndpointsFree(spec); !forcedReady {
			actionMessage.set("fxp listen port still busy role=%s tunnel=%d rule=%d lane=%s owner=%s", spec.Role, spec.TunnelID, spec.RuleID, forcedLane, forcedOwner)
			return false
		}
	}
	if spec.TransportVersion == forwardXWireGuardVersion {
		prepared, err := prepareFXPWireGuard(spec, wireGuardRefID)
		if err != nil {
			actionMessage.set("fxp wireguard prepare failed role=%s tunnel=%d rule=%d: %v", spec.Role, spec.TunnelID, spec.RuleID, err)
			return false
		}
		spec = prepared
	}
	releaseWireGuardRef := func() {
		if originalSpec.TransportVersion == forwardXWireGuardVersion {
			releaseWireGuardRuntimeRef(originalSpec.TunnelID, wireGuardRefID)
		}
	}

	if err := os.MkdirAll("/run/forwardx-agent", 0700); err != nil {
		releaseWireGuardRef()
		actionMessage.set("fxp create runtime dir failed: %v", err)
		return false
	}
	spec = fxpSpecWithPanelCredentials(cfg, spec)
	logf(
		"proxy-debug fxp config role=%s tunnel=%d rule=%d listen=%d udpListen=%d protocol=%s exitStrategy=%s proxyReceive=%v proxySend=%v proxyExitReceive=%v proxyExitSend=%v tcpFastOpen=%v linkShaping=%s linkUp=%d linkDown=%d egress=%s/%d exit=%s:%d udpExit=%d relayNext=%s:%d udpRelayNext=%d target=%s:%d udpTargets=%d",
		spec.Role,
		spec.TunnelID,
		spec.RuleID,
		spec.ListenPort,
		spec.UDPListenPort,
		spec.Protocol,
		spec.ExitStrategy,
		spec.ProxyProtocolReceive,
		spec.ProxyProtocolSend,
		spec.ProxyProtocolExitReceive,
		spec.ProxyProtocolExitSend,
		spec.TCPFastOpen,
		spec.LinkShaping,
		spec.LinkUpMbps,
		spec.LinkDownMbps,
		spec.EgressShaping,
		spec.EgressMbps,
		spec.ExitHost,
		spec.ExitPort,
		spec.UDPExitPort,
		spec.RelayExitHost,
		spec.RelayExitPort,
		spec.UDPRelayExitPort,
		spec.TargetIP,
		spec.TargetPort,
		len(spec.UDPTargets),
	)
	cfgBytes, err := json.Marshal(spec)
	if err != nil {
		releaseWireGuardRef()
		actionMessage.set("fxp marshal config failed: %v", err)
		return false
	}
	if err := os.WriteFile(configPath, cfgBytes, 0600); err != nil {
		releaseWireGuardRef()
		actionMessage.set("fxp write config failed: %v", err)
		return false
	}
	cmd := exec.Command(runtimePath, "-config", configPath)
	logWriter := fxpLogWriter{message: actionMessage, spec: originalSpec}
	// 标准输出/错误接到日志文件而不是管道：Agent 重启（KillMode=process）后 FXP 仍在跑，
	// 管道读端没了它会在下一次写日志时死于 SIGPIPE。见 fxp_log_file.go。
	var logTail *fxpLogTail
	logPath := fxpRuntimeLogPath(configPath)
	logFile, logOffset, logErr := openFXPRuntimeLogFile(logPath)
	if logErr == nil {
		cmd.Stdout = logFile
		cmd.Stderr = logFile
		logTail = newFXPLogTail(logPath, logOffset, func() io.Writer { return logWriter })
	} else {
		logf("fxp runtime log file unavailable path=%s, falling back to pipe: %v", logPath, logErr)
		cmd.Stdout = logWriter
		cmd.Stderr = logWriter
	}
	startErr := cmd.Start()
	if logFile != nil {
		// 子进程已经继承了描述符，父进程这份用不着了。
		_ = logFile.Close()
	}
	if startErr != nil {
		releaseWireGuardRef()
		_ = os.Remove(configPath)
		actionMessage.set("fxp runtime start failed: %v", startErr)
		return false
	}
	logTailStop := make(chan struct{})
	var logTailStopOnce sync.Once
	stopLogTail := func() {
		logTailStopOnce.Do(func() { close(logTailStop) })
	}
	if logTail != nil {
		go logTail.run(logTailStop)
	}

	exited := make(chan error, 1)
	go func() {
		exited <- cmd.Wait()
	}()
	select {
	case err := <-exited:
		// 先同步读完它退出前写的日志，启动失败的原因要进这次动作的消息里。
		logTail.poll()
		stopLogTail()
		releaseWireGuardRef()
		_ = os.Remove(configPath)
		if err != nil {
			actionMessage.set("fxp runtime exited immediately: %v", err)
		} else {
			actionMessage.set("fxp runtime exited immediately")
		}
		if owner := listenPortOwnerSummary(spec.ListenPort); owner != "" {
			logf("fxp listen port owner role=%s tunnel=%d rule=%d listen=:%d owner=%s", spec.Role, spec.TunnelID, spec.RuleID, spec.ListenPort, owner)
		}
		return false
	case <-time.After(300 * time.Millisecond):
	}
	if isFXPEntryGroup(originalSpec) && !waitForFXPListenEndpointsReady(originalSpec, 3*time.Second) {
		_ = cmd.Process.Kill()
		stopLogTail()
		releaseWireGuardRef()
		_ = os.Remove(configPath)
		actionMessage.set("fxp entry group listeners not ready tunnel=%d entries=%d", originalSpec.TunnelID, len(originalSpec.Entries))
		return false
	}

	if persistenceEnabled {
		if err := persistFXPSpec(originalSpec); err != nil {
			logf("fxp persistent snapshot write failed tunnel=%d rule=%d port=%d: %v", originalSpec.TunnelID, originalSpec.RuleID, originalSpec.ListenPort, err)
			_ = cmd.Process.Kill()
			stopLogTail()
			releaseWireGuardRef()
			_ = os.Remove(configPath)
			actionMessage.set("fxp persistent snapshot write failed tunnel=%d", originalSpec.TunnelID)
			return false
		}
	}

	fxpMu.Lock()
	fxpServers[id] = &fxpProcess{
		signature:             signature,
		cmd:                   cmd,
		configPath:            configPath,
		spec:                  originalSpec,
		wireGuardRefID:        wireGuardRefID,
		runtimeExecutable:     runtimeExecutable,
		panelCredentialDigest: expectedCredentialDigest,
	}
	fxpMu.Unlock()
	desiredStarted = true
	startedAt := time.Now()
	go func() {
		err := <-exited
		stopLogTail()
		fxpMu.Lock()
		current := fxpServers[id]
		// 记录还指着这个进程，说明不是 Agent 主动停的（主动停会先删记录）。
		unexpected := current != nil && current.cmd == cmd
		if unexpected {
			delete(fxpServers, id)
		}
		fxpMu.Unlock()
		if err != nil {
			logf("fxp runtime exited tunnel=%d rule=%d: %v", spec.TunnelID, spec.RuleID, err)
		}
		releaseWireGuardRef()
		if unexpected && persistenceEnabled {
			noteFXPUnexpectedExit(id, time.Since(startedAt))
		}
	}()
	for _, conflicting := range conflictingSpecs {
		replacement, hasRemaining := fxpSpecWithoutListenConflicts(conflicting, originalSpec)
		if !hasRemaining {
			continue
		}
		message := newActionMessage()
		if !startFXPProcessLockedWithPersistence(cfg, replacement, message, persistenceEnabled) {
			actionMessage.set("fxp conflicting entry group rebuild failed tunnel=%d: %s", replacement.TunnelID, message.get())
			return false
		}
		replacementSpecs = append(replacementSpecs, replacement)
	}
	if persistenceEnabled {
		for _, conflicting := range conflictingSpecs {
			if _, hasRemaining := fxpSpecWithoutListenConflicts(conflicting, originalSpec); !hasRemaining {
				removePersistedFXPSpec(conflicting)
			}
		}
	}
	transitionCommitted = true
	logf("fxp %s started tunnel=%d rule=%d listen=:%d protocol=%s runtime=%s", spec.Role, spec.TunnelID, spec.RuleID, spec.ListenPort, spec.Protocol, runtimePath)
	return true
}

func stopFXP(spec fxpSpec, desiredGroup *fxpSpec, actionMessage *actionMessage) bool {
	fxpControlMu.Lock()
	defer fxpControlMu.Unlock()
	return stopFXPLocked(spec, desiredGroup, actionMessage)
}

func stopFXPLocked(spec fxpSpec, desiredGroup *fxpSpec, actionMessage *actionMessage) bool {
	requestedTransportVersion := strings.TrimSpace(spec.TransportVersion)
	spec = normalizeFXPSpec(spec)
	if requestedTransportVersion == "" {
		spec.TransportVersion = ""
	}
	if isSharedFXPEntry(spec) || (strings.EqualFold(spec.Role, "entry") && spec.RuleID > 0 && spec.ListenPort > 0) {
		var group fxpSpec
		groupKnown := false
		if desiredGroup != nil {
			group = normalizeFXPSpec(*desiredGroup)
			groupKnown = isFXPEntryGroup(group) &&
				(spec.TunnelID <= 0 || group.TunnelID == spec.TunnelID) &&
				(strings.TrimSpace(spec.TransportVersion) == "" || group.TransportVersion == spec.TransportVersion)
		}
		hasRemaining := groupKnown && len(group.Entries) > 0
		if !groupKnown {
			group, hasRemaining = desiredSharedFXPEntryGroup(nil, &spec)
		}
		tunnelID := spec.TunnelID
		if tunnelID <= 0 {
			tunnelID = group.TunnelID
		}
		if hasRemaining {
			cfg, _ := loadConfig(activeConfigPath)
			if !startFXPProcessLocked(cfg, group, actionMessage) {
				logf("fxp entry group rebuild failed after removal tunnel=%d rule=%d port=%d: %s", group.TunnelID, spec.RuleID, spec.ListenPort, actionMessage.get())
				return false
			}
		} else if tunnelID > 0 {
			transportVersion := spec.TransportVersion
			if group.TransportVersion != "" {
				transportVersion = group.TransportVersion
			}
			stopFXPRuntime(fxpSpec{Role: fxpEntryGroupRole, TransportVersion: transportVersion, TunnelID: tunnelID})
			spec.TransportVersion = transportVersion
			removePersistedFXPSpec(spec)
		}
		return true
	}
	stopFXPRuntime(spec)
	removePersistedFXPSpec(spec)
	return true
}

func stopFXPRuntime(spec fxpSpec) {
	spec = normalizeFXPSpec(spec)
	if isSharedFXPEntry(spec) {
		spec = fxpSpec{Role: fxpEntryGroupRole, TransportVersion: spec.TransportVersion, TunnelID: spec.TunnelID}
	}
	id := fxpServerID(spec)
	fxpMu.Lock()
	s := fxpServers[id]
	if s != nil {
		delete(fxpServers, id)
	}
	fxpMu.Unlock()
	if s == nil {
		configPath := fxpConfigPath(spec)
		killFXPByConfigPath(configPath)
		_ = os.Remove(configPath)
		return
	}
	if s.cmd != nil && s.cmd.Process != nil {
		_ = s.cmd.Process.Signal(os.Interrupt)
		process := s.cmd.Process
		go func() {
			timer := time.NewTimer(6 * time.Second)
			defer timer.Stop()
			<-timer.C
			if process.Signal(syscall.Signal(0)) == nil {
				logf("fxp graceful shutdown timeout; force kill tunnel=%d rule=%d port=%d", s.spec.TunnelID, s.spec.RuleID, s.spec.ListenPort)
				_ = process.Kill()
			}
		}()
	} else if s.configPath != "" {
		killFXPByConfigPath(s.configPath)
	}
	if s.configPath != "" {
		_ = os.Remove(s.configPath)
		_ = os.Remove(fxpReloadAckPath(s.configPath))
	}
}

type fxpLogWriter struct {
	message *actionMessage
	spec    fxpSpec
}

func (w fxpLogWriter) Write(p []byte) (int, error) {
	msg := compactLogOutput(string(p))
	if msg != "" {
		logf("fxp runtime: %s", msg)
		recordFXPEndpointLog(w.spec, msg)
		if w.message != nil {
			w.message.remember("fxp runtime: %s", msg)
		}
	}
	return len(p), nil
}
