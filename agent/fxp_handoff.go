package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func stopFXPByTunnelTransport(tunnelID int, transportVersion string) {
	for _, spec := range fxpSpecsByTunnelTransport(tunnelID, transportVersion) {
		stopFXPRuntime(spec)
	}
}

func fxpSpecsByTunnelTransport(tunnelID int, transportVersion string) []fxpSpec {
	transportVersion = strings.ToLower(strings.TrimSpace(transportVersion))
	fxpMu.Lock()
	specs := make([]fxpSpec, 0)
	for _, process := range fxpServers {
		if process == nil || process.spec.TunnelID != tunnelID || process.spec.TransportVersion != transportVersion {
			continue
		}
		specs = append(specs, process.spec)
	}
	fxpMu.Unlock()
	sort.Slice(specs, func(i, j int) bool {
		return fxpServerID(specs[i]) < fxpServerID(specs[j])
	})
	return specs
}

type fxpRuntimeSelector struct {
	role       string
	tunnelID   int
	ruleID     int
	listenPort int
	protocol   string
}

func (selector fxpRuntimeSelector) valid() bool {
	return selector.listenPort > 0 && selector.listenPort <= 65535
}

func (selector fxpRuntimeSelector) matches(spec fxpSpec) bool {
	if !selector.valid() {
		return false
	}
	spec = normalizeFXPSpec(spec)
	if selector.tunnelID > 0 && spec.TunnelID != selector.tunnelID {
		return false
	}
	if isFXPEntryGroup(spec) {
		for _, entry := range spec.Entries {
			if selector.matches(entry) {
				return true
			}
		}
		return false
	}
	if role := strings.ToLower(strings.TrimSpace(selector.role)); role != "" && spec.Role != role {
		return false
	}
	if selector.ruleID > 0 && spec.RuleID != selector.ruleID {
		return false
	}
	return fxpSpecUsesListenEndpoint(spec, selector.listenPort, selector.protocol)
}

func fxpSpecUsesListenEndpoint(spec fxpSpec, listenPort int, protocol string) bool {
	if listenPort <= 0 {
		return false
	}
	wanted := map[string]bool{}
	for _, lane := range runtimeProtocols(protocol) {
		wanted[lane] = true
	}
	for lane, port := range fxpListenEndpoints(spec) {
		laneProtocol := strings.SplitN(lane, ":", 2)[0]
		if port == listenPort && wanted[laneProtocol] {
			return true
		}
	}
	return false
}

func stopFXPByListenEndpoint(listenPort int, protocol string) bool {
	return stopFXPBySelector(fxpRuntimeSelector{listenPort: listenPort, protocol: protocol})
}

func stopFXPByListenPort(listenPort int) bool {
	return stopFXPByListenEndpoint(listenPort, "both")
}

func stopFXPBySelector(selector fxpRuntimeSelector) bool {
	if !selector.valid() {
		return true
	}
	fxpControlMu.Lock()
	defer fxpControlMu.Unlock()
	return stopFXPSpecsLocked(fxpSpecsForSelectorLocked(selector), selector)
}

func handoffFXPBySelector(cfg Config, selector fxpRuntimeSelector, statusMessage *actionMessage) bool {
	return handoffFXPBySelectorWithRollback(cfg, selector, statusMessage, nil)
}

func handoffFXPBySelectorWithRollback(cfg Config, selector fxpRuntimeSelector, statusMessage *actionMessage, handoffState *actionHandoffState) bool {
	if !selector.valid() {
		return true
	}
	fxpControlMu.Lock()
	defer fxpControlMu.Unlock()

	specs := fxpSpecsForSelectorLocked(selector)
	originals := append([]fxpSpec(nil), specs...)
	transactional := handoffState != nil && len(originals) > 0
	batch := handoffState.handoffBatch()
	if batch != nil && !batch.prepareFXPTransition(cfg, originals, selector) {
		statusMessage.set("fxp handoff batch recovery snapshot failed port=%d protocol=%s", selector.listenPort, normalizeRuntimeProtocol(selector.protocol))
		return false
	}
	if batch == nil && transactional && !persistFXPHandoffRecoverySnapshot(originals) {
		statusMessage.set("fxp handoff recovery snapshot failed port=%d protocol=%s", selector.listenPort, normalizeRuntimeProtocol(selector.protocol))
		return false
	}
	start := func(spec fxpSpec, message *actionMessage) bool {
		return startFXPProcessLockedWithPersistence(cfg, spec, message, !transactional)
	}
	stop := func(spec fxpSpec) bool {
		return stopFXPSpecsLocked([]fxpSpec{spec}, selector)
	}
	if !transitionFXPSelectorLocked(selector, specs, start, stop, statusMessage) {
		return false
	}
	if !transactional || batch != nil {
		return true
	}

	handoffState.setFinalizers(
		func() { commitFXPHandoffPersistence(originals, selector) },
		func() { restoreFXPHandoffOriginalsForHandoff(cfg, originals) },
	)
	return true
}

func persistFXPHandoffRecoverySnapshot(originals []fxpSpec) bool {
	ok := true
	for _, original := range originals {
		if err := persistFXPSpec(original); err != nil {
			ok = false
			logf("fxp handoff recovery snapshot write failed runtime=%s: %v", fxpServerID(original), err)
		}
	}
	return ok
}

func commitFXPHandoffPersistence(originals []fxpSpec, selector fxpRuntimeSelector) {
	fxpControlMu.Lock()
	defer fxpControlMu.Unlock()
	for _, original := range originals {
		original = normalizeFXPSpec(original)
		if isFXPEntryGroup(original) {
			replacement, removed := fxpEntryGroupWithoutSelector(original, selector)
			if !removed {
				continue
			}
			if len(replacement.Entries) > 0 {
				if err := persistFXPSpec(replacement); err != nil {
					logf("fxp handoff persistence commit failed runtime=%s: %v", fxpServerID(original), err)
				}
				continue
			}
		}
		removePersistedFXPSpec(original)
	}
}

func commitFXPHandoffBatchPersistence(originals []fxpSpec, selectors []fxpRuntimeSelector) {
	fxpControlMu.Lock()
	defer fxpControlMu.Unlock()
	for _, original := range originals {
		original = normalizeFXPSpec(original)
		if isFXPEntryGroup(original) {
			replacement := original
			removed := false
			for _, selector := range selectors {
				var matched bool
				replacement, matched = fxpEntryGroupWithoutSelector(replacement, selector)
				removed = removed || matched
			}
			if !removed {
				continue
			}
			if len(replacement.Entries) > 0 {
				if err := persistFXPSpec(replacement); err != nil {
					logf("fxp handoff batch persistence commit failed runtime=%s: %v", fxpServerID(original), err)
				}
				continue
			}
			removePersistedFXPSpec(original)
			continue
		}
		for _, selector := range selectors {
			if selector.matches(original) {
				removePersistedFXPSpec(original)
				break
			}
		}
	}
	// A selector can have no live original when the Agent adopted an orphaned
	// runtime incompletely or only a stale recovery snapshot remains. Commit
	// against the persisted entries too, so a successful handoff cannot revive
	// that old listener after restart.
	for _, persisted := range loadPersistedFXPSpecs() {
		for _, selector := range selectors {
			if selector.matches(persisted) {
				removePersistedFXPSpec(persisted)
				break
			}
		}
	}
}

func restoreFXPHandoffOriginalsLocked(cfg Config, originals []fxpSpec) {
	for _, original := range originals {
		message := newActionMessage()
		if !startFXPProcessLocked(cfg, original, message) {
			logf("fxp handoff batch rollback failed runtime=%s: %s", fxpServerID(original), message.get())
		}
	}
}

func restoreFXPHandoffOriginals(cfg Config, originals []fxpSpec) {
	fxpControlMu.Lock()
	defer fxpControlMu.Unlock()
	restoreFXPHandoffOriginalsLocked(cfg, originals)
}

var restoreFXPHandoffOriginalsForHandoff = restoreFXPHandoffOriginals

type fxpHandoffStartFunc func(fxpSpec, *actionMessage) bool

type fxpHandoffStopFunc func(fxpSpec) bool

func transitionFXPSelectorLocked(selector fxpRuntimeSelector, specs []fxpSpec, start fxpHandoffStartFunc, stop fxpHandoffStopFunc, statusMessage *actionMessage) bool {
	if !selector.valid() || len(specs) == 0 {
		return true
	}
	if start == nil || stop == nil {
		statusMessage.set("fxp handoff operations unavailable port=%d protocol=%s", selector.listenPort, normalizeRuntimeProtocol(selector.protocol))
		return false
	}

	transitioned := make([]fxpSpec, 0, len(specs))
	rollback := func() {
		for index := len(transitioned) - 1; index >= 0; index-- {
			message := newActionMessage()
			if !start(transitioned[index], message) {
				logf("fxp handoff rollback failed runtime=%s: %s", fxpServerID(transitioned[index]), message.get())
			}
		}
	}

	for _, current := range specs {
		current = normalizeFXPSpec(current)
		if isFXPEntryGroup(current) {
			replacement, removed := fxpEntryGroupWithoutSelector(current, selector)
			if !removed {
				continue
			}
			if len(replacement.Entries) > 0 {
				if !start(replacement, statusMessage) {
					message := newActionMessage()
					if !start(current, message) {
						logf("fxp handoff current-group rollback failed runtime=%s: %s", fxpServerID(current), message.get())
					}
					rollback()
					return false
				}
				transitioned = append(transitioned, current)
				continue
			}
		}

		// Standalone runtimes and entry groups with no remaining members can be
		// stopped outright. Persistence is deliberately retained until the target
		// apply succeeds, so the last member remains restart-recoverable.
		transitioned = append(transitioned, current)
		if !stop(current) {
			rollback()
			statusMessage.set("fxp handoff stop failed runtime=%s port=%d protocol=%s", fxpServerID(current), selector.listenPort, normalizeRuntimeProtocol(selector.protocol))
			return false
		}
	}
	return true
}

func fxpEntryGroupWithoutSelector(group fxpSpec, selector fxpRuntimeSelector) (fxpSpec, bool) {
	group = normalizeFXPSpec(group)
	if !isFXPEntryGroup(group) || !selector.valid() {
		return group, false
	}
	remaining := make([]fxpSpec, 0, len(group.Entries))
	removed := false
	for _, entry := range group.Entries {
		if selector.matches(entry) {
			removed = true
			continue
		}
		remaining = append(remaining, entry)
	}
	group.Entries = remaining
	return normalizeFXPSpec(group), removed
}

func fxpSpecsForSelectorLocked(selector fxpRuntimeSelector) []fxpSpec {
	return fxpSpecsForSelectorLockedWithLiveFilter(selector, nil)
}

func runningFXPSpecsForSelectorLocked(selector fxpRuntimeSelector) []fxpSpec {
	return fxpSpecsForSelectorLockedWithLiveFilter(selector, fxpProcessActive)
}

func fxpSpecsForSelectorLockedWithLiveFilter(selector fxpRuntimeSelector, liveFilter func(*fxpProcess) bool) []fxpSpec {
	if !selector.valid() {
		return nil
	}

	tracked := make([]*fxpProcess, 0)
	fxpMu.Lock()
	for _, process := range fxpServers {
		tracked = append(tracked, process)
	}
	fxpMu.Unlock()

	liveSpecs := make([]fxpSpec, 0, len(tracked))
	for _, process := range tracked {
		if process == nil || !selector.matches(process.spec) || (liveFilter != nil && !liveFilter(process)) {
			continue
		}
		liveSpecs = append(liveSpecs, process.spec)
	}

	runtimeSpecs := make([]fxpSpec, 0)
	paths, _ := filepath.Glob("/run/forwardx-agent/fxp-*.json")
	for _, path := range paths {
		if !fxpRuntimeProcessExists(path) {
			continue
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var spec fxpSpec
		if json.Unmarshal(raw, &spec) == nil {
			runtimeSpecs = append(runtimeSpecs, spec)
		}
	}

	// Persistence is only a discovery fallback for a verified orphan process
	// whose runtime JSON was removed. A stale snapshot must not restart an old
	// group or block a new listener during handoff.
	persistedCandidates := fxpSpecsMatchingSelector(
		selector,
		planPersistedFXPRestoreSpecs(loadPersistedFXPSpecs()),
	)
	persistedSpecs := fxpSpecsWithRunningProcess(
		persistedCandidates,
		fxpRuntimeProcessExists,
	)
	return fxpSpecsMatchingSelector(selector, liveSpecs, runtimeSpecs, persistedSpecs)
}

func fxpSpecsWithRunningProcess(specs []fxpSpec, processExists func(string) bool) []fxpSpec {
	if len(specs) == 0 || processExists == nil {
		return nil
	}
	running := make([]fxpSpec, 0, len(specs))
	for _, spec := range specs {
		if processExists(fxpConfigPath(spec)) {
			running = append(running, spec)
		}
	}
	return running
}

func stopFXPSpecsLocked(specs []fxpSpec, selector fxpRuntimeSelector) bool {
	configPaths := make([]string, 0, len(specs))
	trackedProcesses := trackedFXPOSProcesses(specs)
	hadRuntime := len(trackedProcesses) > 0
	for _, spec := range specs {
		configPath := fxpConfigPath(spec)
		configPaths = append(configPaths, configPath)
		hadRuntime = hadRuntime || fxpRuntimeProcessExists(configPath)
		stopFXPRuntime(spec)
	}
	if len(specs) == 0 {
		return true
	}
	if waitForFXPProcessesExit(configPaths, trackedProcesses, 2*time.Second) {
		return !hadRuntime || waitForFXPSelectorEndpointFree(selector, 2*time.Second)
	}

	// A graceful FXP shutdown normally completes immediately. Do not let a
	// stuck process survive until the generic six-second watchdog: the
	// replacement runtime must only start after the old process has exited.
	for _, configPath := range configPaths {
		killFXPByConfigPath(configPath)
	}
	for _, process := range trackedProcesses {
		_ = process.Kill()
	}
	if waitForFXPProcessesExit(configPaths, trackedProcesses, 2*time.Second) {
		return !hadRuntime || waitForFXPSelectorEndpointFree(selector, 2*time.Second)
	}
	logf("fxp handoff process still running port=%d protocol=%s owner=%s", selector.listenPort, normalizeRuntimeProtocol(selector.protocol), listenPortOwnerSummary(selector.listenPort))
	return false
}

func waitForFXPSelectorEndpointFree(selector fxpRuntimeSelector, timeout time.Duration) bool {
	if !selector.valid() {
		return true
	}
	spec := fxpSpec{
		ListenPort:    selector.listenPort,
		UDPListenPort: selector.listenPort,
		Protocol:      selector.protocol,
	}
	if waitForFXPListenPortFree(&spec, selector.listenPort, timeout) {
		return true
	}
	logf("fxp handoff endpoint still busy port=%d protocol=%s owner=%s", selector.listenPort, normalizeRuntimeProtocol(selector.protocol), listenPortOwnerSummary(selector.listenPort))
	return false
}

func trackedFXPOSProcesses(specs []fxpSpec) []*os.Process {
	if len(specs) == 0 {
		return nil
	}
	seen := map[int]bool{}
	processes := make([]*os.Process, 0, len(specs))
	fxpMu.Lock()
	for _, spec := range specs {
		tracked := fxpServers[fxpServerID(spec)]
		if tracked == nil || tracked.cmd == nil || tracked.cmd.Process == nil {
			continue
		}
		process := tracked.cmd.Process
		if process.Pid <= 0 || seen[process.Pid] {
			continue
		}
		seen[process.Pid] = true
		processes = append(processes, process)
	}
	fxpMu.Unlock()
	return processes
}

func waitForFXPProcessesExit(configPaths []string, trackedProcesses []*os.Process, timeout time.Duration) bool {
	if len(configPaths) == 0 && len(trackedProcesses) == 0 {
		return true
	}
	if timeout <= 0 {
		timeout = time.Millisecond
	}
	deadline := time.Now().Add(timeout)
	for {
		running := false
		for _, process := range trackedProcesses {
			if process != nil && process.Signal(syscall.Signal(0)) == nil {
				running = true
				break
			}
		}
		for _, configPath := range configPaths {
			if running {
				break
			}
			if fxpRuntimeProcessExists(configPath) {
				running = true
				break
			}
		}
		if !running {
			return true
		}
		if !time.Now().Before(deadline) {
			return false
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func fxpSpecsMatchingSelector(selector fxpRuntimeSelector, sources ...[]fxpSpec) []fxpSpec {
	if !selector.valid() {
		return nil
	}
	byID := map[string]fxpSpec{}
	for _, source := range sources {
		for _, spec := range source {
			spec = normalizeFXPSpec(spec)
			id := fxpServerID(spec)
			if _, exists := byID[id]; exists {
				continue
			}
			byID[id] = spec
		}
	}
	specs := make([]fxpSpec, 0)
	for _, spec := range byID {
		if selector.matches(spec) {
			// Keep the complete original spec so a V2 process releases its
			// WireGuard reference correctly when it exits.
			specs = append(specs, spec)
		}
	}
	sort.Slice(specs, func(i, j int) bool {
		return fxpServerID(specs[i]) < fxpServerID(specs[j])
	})
	return specs
}

func fxpSpecsUsingListenPort(listenPort int, sources ...[]fxpSpec) []fxpSpec {
	return fxpSpecsMatchingSelector(fxpRuntimeSelector{listenPort: listenPort, protocol: "both"}, sources...)
}

func fxpPortReleaseTimeout(owner string) time.Duration {
	if strings.Contains(strings.ToLower(owner), "forwardx-nginx") {
		return 15 * time.Second
	}
	return 3 * time.Second
}

func waitForFXPListenEndpointsFree(spec fxpSpec) (bool, string, string) {
	endpoints := fxpListenEndpoints(spec)
	lanes := make([]string, 0, len(endpoints))
	for lane := range endpoints {
		lanes = append(lanes, lane)
	}
	sort.Strings(lanes)
	deadline := time.Now().Add(3 * time.Second)
	for _, lane := range lanes {
		port := endpoints[lane]
		protocol := strings.SplitN(lane, ":", 2)[0]
		owner := ""
		if listenPortBusy(protocol, port) {
			owner = listenPortOwnerSummary(port)
		}
		if timeout := fxpPortReleaseTimeout(owner); timeout > 3*time.Second {
			candidate := time.Now().Add(timeout)
			if candidate.After(deadline) {
				deadline = candidate
			}
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			remaining = time.Millisecond
		}
		laneSpec := fxpSpec{ListenPort: port, UDPListenPort: port, Protocol: protocol}
		if !waitForFXPListenPortFree(&laneSpec, port, remaining) {
			return false, protocol + ":" + strconv.Itoa(port), listenPortOwnerSummary(port)
		}
	}
	return true, "", ""
}

func waitForFXPListenEndpointsReady(spec fxpSpec, timeout time.Duration) bool {
	endpoints := fxpListenEndpoints(spec)
	deadline := time.Now().Add(timeout)
	for {
		ready := len(endpoints) > 0
		for lane, port := range endpoints {
			protocol := strings.SplitN(lane, ":", 2)[0]
			if !listenPortBusy(protocol, port) {
				ready = false
				break
			}
		}
		if ready {
			return true
		}
		if !time.Now().Before(deadline) {
			return false
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func waitForFXPListenPortFree(spec *fxpSpec, listenPort int, timeout time.Duration) bool {
	if spec == nil || listenPort <= 0 {
		return true
	}
	normalized := normalizeFXPSpec(*spec)
	protos := runtimeProtocols(normalized.Protocol)
	if len(protos) == 0 {
		protos = []string{"tcp"}
	}
	deadline := time.Now().Add(timeout)
	for {
		busy := false
		checked := map[string]bool{}
		for _, proto := range protos {
			port := listenPort
			if proto == "udp" {
				port = normalized.UDPListenPort
			} else if normalized.ListenPort > 0 {
				port = normalized.ListenPort
			}
			key := proto + ":" + strconv.Itoa(port)
			if checked[key] {
				continue
			}
			checked[key] = true
			if listenPortBusy(proto, port) {
				busy = true
				break
			}
		}
		if !busy {
			return true
		}
		if !time.Now().Before(deadline) {
			return false
		}
		time.Sleep(100 * time.Millisecond)
	}
}
