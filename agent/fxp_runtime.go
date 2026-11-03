package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

func fxpMatchesRunning(spec *fxpSpec, desiredGroups ...*fxpSpec) bool {
	if spec == nil {
		return false
	}
	// 装着的 FXP 太旧时不能算“已在运行”，否则动作会被当成成功跳过，面板看不到原因。
	if fxpVersionWireIncompatible(installedFXPVersion()) {
		return false
	}
	normalized := normalizeFXPSpec(*spec)
	if isSharedFXPEntry(normalized) {
		id := fxpEntryGroupServerID(normalized.TransportVersion, normalized.TunnelID)
		configPath := fxpConfigPath(normalized)
		var desiredGroup *fxpSpec
		if len(desiredGroups) > 0 && desiredGroups[0] != nil {
			candidate := normalizeFXPSpec(*desiredGroups[0])
			if isFXPEntryGroup(candidate) && candidate.TransportVersion == normalized.TransportVersion && candidate.TunnelID == normalized.TunnelID && fxpEntryGroupContains(candidate, normalized) {
				desiredGroup = &candidate
			}
		}
		matchesDesiredGroup := func(group fxpSpec) bool {
			return desiredGroup == nil || fxpServerSignature(group) == fxpServerSignature(*desiredGroup)
		}
		fxpMu.Lock()
		existing := fxpServers[id]
		existingActive := existing != nil && fxpProcessActive(existing)
		matches := existingActive && fxpEntryGroupContains(existing.spec, normalized) && matchesDesiredGroup(existing.spec)
		if existing != nil && !existingActive {
			delete(fxpServers, id)
		}
		fxpMu.Unlock()
		if matches {
			matches = fxpProcessMatchesCurrentRuntime(existing)
		}
		if !matches {
			raw, err := os.ReadFile(configPath)
			if err == nil && !fxpConfigUsesRemovedTrafficPadding(raw) {
				var group fxpSpec
				if json.Unmarshal(raw, &group) == nil {
					group = normalizeFXPSpec(group)
					if fxpEntryGroupContains(group, normalized) && matchesDesiredGroup(group) &&
						fxpRuntimeUsesCurrentExecutable(configPath) && fxpRuntimeUsesCurrentPanelCredentials(configPath) {
						credentialDigest, _ := fxpSpecPanelCredentialDigest(group)
						fxpMu.Lock()
						fxpServers[id] = &fxpProcess{
							signature:             fxpServerSignature(group),
							configPath:            configPath,
							spec:                  group,
							runtimeExecutable:     currentFXPRuntimeExecutableInfo(),
							panelCredentialDigest: credentialDigest,
						}
						fxpMu.Unlock()
						watchAdoptedFXPProcess(id, configPath)
						matches = true
					}
				}
			}
		}
		if matches {
			readiness := readLocalRuntimeReadinessCached()
			matches = fxpRuntimeListenersReady(normalized, readiness.listenSnapshot) &&
				wireGuardFXPProxiesReady(normalized)
		}
		return matches
	}
	id := fxpServerID(normalized)
	signature := fxpServerSignature(normalized)
	configPath := fxpConfigPath(normalized)
	fxpMu.Lock()
	existing := fxpServers[id]
	existingActive := existing != nil && fxpProcessActive(existing)
	matches := existingActive && existing.signature == signature
	if existing != nil && !existingActive {
		delete(fxpServers, id)
	}
	fxpMu.Unlock()
	if matches {
		matches = fxpProcessMatchesCurrentRuntime(existing)
	}
	if !matches {
		matches = adoptExistingFXP(normalized, signature, configPath)
	}
	if matches {
		readiness := readLocalRuntimeReadinessCached()
		matches = fxpRuntimeListenersReady(normalized, readiness.listenSnapshot) &&
			wireGuardFXPProxiesReady(normalized)
	}
	if matches {
		logf("fxp %s already running with matching runtime tunnel=%d rule=%d listen=:%d protocol=%s", normalized.Role, normalized.TunnelID, normalized.RuleID, normalized.ListenPort, normalized.Protocol)
	}
	return matches
}

func fxpConfigPath(spec fxpSpec) string {
	if isFXPEntryGroup(spec) || isSharedFXPEntry(spec) {
		return fmt.Sprintf("/run/forwardx-agent/fxp-entry-group-%s-%d.json", normalizeFXPTransportVersion(spec.TransportVersion), spec.TunnelID)
	}
	role := strings.ToLower(strings.TrimSpace(spec.Role))
	return fmt.Sprintf("/run/forwardx-agent/fxp-%s-%d-%d-%d.json", role, spec.TunnelID, spec.RuleID, spec.ListenPort)
}

func fxpProcessActive(process *fxpProcess) bool {
	if process == nil {
		return false
	}
	if process.cmd != nil && process.cmd.Process != nil {
		return true
	}
	if process.configPath != "" {
		return fxpRuntimeProcessExists(process.configPath)
	}
	return false
}

func fxpRuntimePIDs(configPath string) []int {
	configPath = strings.TrimSpace(configPath)
	if configPath == "" {
		return nil
	}
	patterns := []string{
		`[f]orwardx-fxp.*` + regexp.QuoteMeta(configPath),
		`[f]orwardx-fxp.*` + regexp.QuoteMeta(filepath.Base(configPath)),
	}
	seen := map[int]bool{}
	pids := []int{}
	for _, pattern := range patterns {
		out, err := commandOutputWithTimeout(3*time.Second, "pgrep", "-f", pattern)
		if err != nil {
			continue
		}
		for _, line := range strings.Fields(string(out)) {
			pid, err := strconv.Atoi(strings.TrimSpace(line))
			if err != nil || pid <= 0 || pid == os.Getpid() || seen[pid] {
				continue
			}
			seen[pid] = true
			pids = append(pids, pid)
		}
	}
	return pids
}

func fxpRuntimeProcessExists(configPath string) bool {
	return len(fxpRuntimePIDs(configPath)) > 0
}

var resolveFXPRuntimeExecutable = findFXPRuntimeExecutable

var listFXPRuntimePIDs = fxpRuntimePIDs

var fxpPIDUsesExecutable = fxpPIDUsesCurrentExecutable

func findFXPRuntimeExecutable() (string, error) {
	runtimePath, err := exec.LookPath("forwardx-fxp")
	if err == nil && strings.TrimSpace(runtimePath) != "" {
		return runtimePath, nil
	}
	for _, candidate := range []string{"/usr/local/bin/forwardx-fxp", "/opt/forwardx-agent/forwardx-fxp"} {
		if st, statErr := os.Stat(candidate); statErr == nil && !st.IsDir() {
			return candidate, nil
		}
	}
	return "", err
}

func fxpPIDUsesCurrentExecutable(pid int, runtimePath string) bool {
	if pid <= 0 || strings.TrimSpace(runtimePath) == "" {
		return false
	}
	installed, err := os.Stat(runtimePath)
	if err != nil || installed.IsDir() {
		return false
	}
	running, err := os.Stat(fmt.Sprintf("/proc/%d/exe", pid))
	return err == nil && os.SameFile(installed, running)
}

// An FXP process can outlive the Agent that launched it. Reuse it only when it
// still maps the installed runtime binary; package upgrades replace that file
// while the old process continues forwarding with outdated reporting/auth code.
func fxpRuntimeUsesCurrentExecutable(configPath string) bool {
	runtimePath, err := resolveFXPRuntimeExecutable()
	if err != nil || strings.TrimSpace(runtimePath) == "" {
		return false
	}
	pids := listFXPRuntimePIDs(configPath)
	if len(pids) == 0 {
		return false
	}
	for _, pid := range pids {
		if fxpPIDUsesExecutable(pid, runtimePath) {
			continue
		}
		if shouldLogAgentReport("fxp-runtime-executable-drift:"+configPath, agentReportLogInterval) {
			logf("fxp runtime executable drift detected; replacement required config=%s pid=%d runtime=%s", configPath, pid, runtimePath)
		}
		return false
	}
	return true
}

func currentFXPRuntimeExecutableInfo() os.FileInfo {
	runtimePath, err := resolveFXPRuntimeExecutable()
	if err != nil || strings.TrimSpace(runtimePath) == "" {
		return nil
	}
	info, err := os.Stat(runtimePath)
	if err != nil || info.IsDir() {
		return nil
	}
	return info
}

func fxpProcessUsesCurrentExecutable(process *fxpProcess) bool {
	if process == nil {
		return false
	}
	if process.runtimeExecutable != nil {
		installed := currentFXPRuntimeExecutableInfo()
		return installed != nil && os.SameFile(process.runtimeExecutable, installed)
	}
	if process.cmd != nil && process.cmd.Process != nil {
		runtimePath, err := resolveFXPRuntimeExecutable()
		return err == nil && fxpPIDUsesExecutable(process.cmd.Process.Pid, runtimePath)
	}
	return fxpRuntimeUsesCurrentExecutable(process.configPath)
}

func fxpPanelCredentialDigest(panelURL string, token string) string {
	panelURL = normalizePanelURL(panelURL)
	if panelURL == "" || token == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(panelURL + "\x00" + token))
	return hex.EncodeToString(sum[:])
}

// fxpRoleReportsTraffic：哪些 FXP 角色自己往面板报流量（入口，以及 NEX 隧道按出口
// 记账时的出口）。这些角色的运行时配置里带面板地址和令牌，令牌或面板地址一变就要重建。
func fxpRoleReportsTraffic(role string) bool {
	role = strings.ToLower(strings.TrimSpace(role))
	return role == "entry" || role == "exit"
}

func fxpSpecNeedsPanelCredentials(spec fxpSpec) bool {
	spec = normalizeFXPSpec(spec)
	return fxpRoleReportsTraffic(spec.Role) || isFXPEntryGroup(spec)
}

func fxpSpecPanelCredentialDigest(spec fxpSpec) (string, bool) {
	spec = normalizeFXPSpec(spec)
	if !fxpSpecNeedsPanelCredentials(spec) {
		return "", true
	}
	if isFXPEntryGroup(spec) {
		digest := ""
		for _, entry := range spec.Entries {
			candidate := fxpPanelCredentialDigest(entry.PanelURL, entry.Token)
			if candidate == "" || (digest != "" && digest != candidate) {
				return "", false
			}
			digest = candidate
		}
		return digest, digest != ""
	}
	digest := fxpPanelCredentialDigest(spec.PanelURL, spec.Token)
	return digest, digest != ""
}

func currentFXPPanelCredentialDigest() (string, bool) {
	panelURL := currentPanelURL(Config{})
	token, _ := runtimeAgentToken.Load().(string)
	if panelURL != "" && token != "" {
		return fxpPanelCredentialDigest(panelURL, token), true
	}
	path := strings.TrimSpace(activeConfigPath)
	if path == "" {
		return "", false
	}
	cfg, err := loadConfig(path)
	if err != nil {
		return "", false
	}
	digest := fxpPanelCredentialDigest(currentPanelURL(cfg), cfg.Token)
	return digest, digest != ""
}

func fxpRuntimeUsesPanelCredentialDigest(configPath string, expected string) bool {
	if expected == "" {
		return false
	}
	raw, err := os.ReadFile(configPath)
	if err != nil {
		return false
	}
	var spec fxpSpec
	if json.Unmarshal(raw, &spec) != nil {
		return false
	}
	if !fxpSpecNeedsPanelCredentials(spec) {
		return true
	}
	digest, ok := fxpSpecPanelCredentialDigest(spec)
	return ok && hmac.Equal([]byte(digest), []byte(expected))
}

func fxpRuntimeUsesCurrentPanelCredentials(configPath string) bool {
	expected, known := currentFXPPanelCredentialDigest()
	if !known {
		return true
	}
	return fxpRuntimeUsesPanelCredentialDigest(configPath, expected)
}

func fxpProcessUsesPanelCredentialDigest(process *fxpProcess, expected string) bool {
	if process == nil || !fxpSpecNeedsPanelCredentials(process.spec) {
		return process != nil
	}
	if expected == "" {
		var known bool
		expected, known = currentFXPPanelCredentialDigest()
		if !known {
			return true
		}
	}
	if process.panelCredentialDigest != "" {
		return hmac.Equal([]byte(process.panelCredentialDigest), []byte(expected))
	}
	if strings.TrimSpace(process.configPath) != "" {
		return fxpRuntimeUsesPanelCredentialDigest(process.configPath, expected)
	}
	return false
}

func fxpProcessMatchesCurrentRuntime(process *fxpProcess) bool {
	if process == nil {
		return false
	}
	if fxpRuntimeConfigUsesRemovedTrafficPadding(process.configPath) {
		return false
	}
	return fxpProcessUsesCurrentExecutable(process) && fxpProcessUsesPanelCredentialDigest(process, "")
}

/*
fxpActionListenerOwnedByRuntime：动作要的端口正由本机「同一身份」的 FXP 运行时监听着——
隧道动作是这条隧道自己的出口 / 中转，规则动作是这条规则在入口（组）里的那一路。

这种端口不是来历不明的监听，只是配置旧了（出口的目标表多了 / 少了规则、入口换了目标）：
交给 startFXP 原地热更新（热更新不了它自己会换进程）。以前执行前的清理把它当未知监听先杀掉，
规则换隧道时出口机上新旧两条隧道的出口进程都被重启，两条隧道上所有连接全断，热更新形同虚设。
V2（WireGuard）的运行时和代理端口绑在一起、从来不热更新，保持原来的清理。
*/
func fxpActionListenerOwnedByRuntime(a action) bool {
	if a.Fxp == nil || !validActionPort(a.SourcePort) {
		return false
	}
	if normalizeFXPSpec(*a.Fxp).TransportVersion == forwardXWireGuardVersion {
		return false
	}
	listenSnapshot := readLocalRuntimeReadinessCached().listenSnapshot
	if strings.TrimSpace(a.StatusType) == "tunnel" || (a.TunnelID > 0 && a.RuleID <= 0) {
		return a.TunnelID > 0 && fxpRuntimeReadyForTunnelPort(a.TunnelID, a.SourcePort, listenSnapshot)
	}
	return a.RuleID > 0 && fxpRuntimeReadyForRulePort(a.RuleID, a.SourcePort, a.Protocol, listenSnapshot)
}

func fxpRuntimeReadyForRulePort(ruleID int, port int, protocol string, listenSnapshot *runtimeListenSnapshot) bool {
	if ruleID <= 0 || port <= 0 {
		return false
	}
	fxpMu.Lock()
	tracked := make([]*fxpProcess, 0, len(fxpServers))
	for _, process := range fxpServers {
		tracked = append(tracked, process)
	}
	fxpMu.Unlock()
	for _, process := range tracked {
		if process == nil || !fxpProcessActive(process) || !fxpProcessMatchesCurrentRuntime(process) {
			continue
		}
		for _, candidate := range fxpRuleReadinessCandidates(process.spec) {
			candidate = normalizeFXPSpec(candidate)
			if candidate.Role != "entry" || candidate.RuleID != ruleID || candidate.ListenPort != port ||
				!runtimeProtocolsOverlap(candidate.Protocol, protocol) {
				continue
			}
			if !fxpRuntimeListenersReady(candidate, listenSnapshot) {
				continue
			}
			if candidate.TransportVersion != forwardXWireGuardVersion || wireGuardFXPProxiesReady(candidate) {
				return true
			}
		}
	}

	pattern := fmt.Sprintf("/run/forwardx-agent/fxp-*-*-%d-%d.json", ruleID, port)
	paths, _ := filepath.Glob(pattern)
	for _, path := range paths {
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var spec fxpSpec
		if fxpConfigUsesRemovedTrafficPadding(raw) {
			continue
		}
		if json.Unmarshal(raw, &spec) == nil {
			spec = normalizeFXPSpec(spec)
			if spec.TransportVersion != forwardXWireGuardVersion && runtimeProtocolsOverlap(spec.Protocol, protocol) &&
				fxpRuntimeUsesCurrentExecutable(path) && fxpRuntimeUsesCurrentPanelCredentials(path) && fxpRuntimeListenersReady(spec, listenSnapshot) {
				return true
			}
		}
	}
	groupPaths, _ := filepath.Glob("/run/forwardx-agent/fxp-entry-group-*-*.json")
	for _, path := range groupPaths {
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var group fxpSpec
		if fxpConfigUsesRemovedTrafficPadding(raw) || json.Unmarshal(raw, &group) != nil {
			continue
		}
		group = normalizeFXPSpec(group)
		if group.TransportVersion == forwardXWireGuardVersion {
			continue
		}
		for _, entry := range group.Entries {
			if entry.RuleID == ruleID && entry.ListenPort == port && runtimeProtocolsOverlap(entry.Protocol, protocol) &&
				fxpRuntimeUsesCurrentExecutable(path) && fxpRuntimeUsesCurrentPanelCredentials(path) && fxpRuntimeListenersReady(entry, listenSnapshot) {
				return true
			}
		}
	}
	return false
}

func fxpRuleReadinessCandidates(spec fxpSpec) []fxpSpec {
	spec = normalizeFXPSpec(spec)
	if isFXPEntryGroup(spec) {
		return spec.Entries
	}
	return []fxpSpec{spec}
}

func fxpRuntimeListenersReady(spec fxpSpec, listenSnapshot *runtimeListenSnapshot) bool {
	endpoints := fxpListenEndpoints(spec)
	if len(endpoints) == 0 {
		return false
	}
	for lane, port := range endpoints {
		protocol := strings.SplitN(lane, ":", 2)[0]
		if !runtimeListenPortReady(listenSnapshot, port, protocol, []string{"forwardx-fxp"}) {
			return false
		}
	}
	return true
}

func fxpRuntimeReadyForTunnelPort(tunnelID int, port int, listenSnapshot *runtimeListenSnapshot) bool {
	if tunnelID <= 0 || port <= 0 {
		return false
	}
	fxpMu.Lock()
	tracked := make([]*fxpProcess, 0, len(fxpServers))
	for _, process := range fxpServers {
		tracked = append(tracked, process)
	}
	fxpMu.Unlock()
	for _, process := range tracked {
		if process == nil || !fxpProcessActive(process) || !fxpProcessMatchesCurrentRuntime(process) {
			continue
		}
		spec := normalizeFXPSpec(process.spec)
		if isFXPEntryGroup(spec) || spec.TunnelID != tunnelID || !fxpSpecUsesListenEndpoint(spec, port, "both") {
			continue
		}
		if !fxpRuntimeListenersReady(spec, listenSnapshot) {
			continue
		}
		if spec.TransportVersion != forwardXWireGuardVersion || wireGuardFXPProxiesReady(spec) {
			return true
		}
	}

	pattern := fmt.Sprintf("/run/forwardx-agent/fxp-*-%d-*-%d.json", tunnelID, port)
	paths, _ := filepath.Glob(pattern)
	for _, path := range paths {
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var spec fxpSpec
		if fxpConfigUsesRemovedTrafficPadding(raw) || json.Unmarshal(raw, &spec) != nil {
			continue
		}
		spec = normalizeFXPSpec(spec)
		if spec.TransportVersion != forwardXWireGuardVersion && fxpRuntimeUsesCurrentExecutable(path) &&
			fxpRuntimeUsesCurrentPanelCredentials(path) && fxpRuntimeListenersReady(spec, listenSnapshot) {
			return true
		}
	}
	return false
}

var listUDPListenPortPIDs = func(port int) []int { return listenPortOwnerPIDsForProtocol(port, "udp") }

var readProcessCmdline = func(pid int) ([]string, error) {
	raw, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	if err != nil {
		return nil, err
	}
	return strings.Split(strings.TrimRight(string(raw), "\x00"), "\x00"), nil
}

var killProcessByPID = func(pid int) {
	if proc, err := os.FindProcess(pid); err == nil {
		_ = proc.Kill()
	}
}

// isManagedFXPCmdline 只认 Agent 自己拉起的 FXP 进程：forwardx-fxp -config /run/forwardx-agent/fxp-*.json。
func isManagedFXPCmdline(args []string) bool {
	if len(args) < 3 || !strings.HasPrefix(filepath.Base(args[0]), "forwardx-fxp") {
		return false
	}
	for i := 1; i+1 < len(args); i++ {
		if args[i] != "-config" {
			continue
		}
		configPath := filepath.Clean(args[i+1])
		if filepath.Dir(configPath) == "/run/forwardx-agent" &&
			strings.HasPrefix(filepath.Base(configPath), "fxp-") && strings.HasSuffix(configPath, ".json") {
			return true
		}
	}
	return false
}

// mimicPort 是租户可以自选的 UDP 端口。以前直接杀掉该端口上的所有进程，
// 选 53 就会把宿主机的 systemd-resolved 杀掉；现在只清理 Agent 自己的 FXP 残留进程，
// 其他占用者保持不动，后面的端口空闲检查会报端口被占用。
func killManagedFXPOnUDPPort(port int) {
	if port <= 0 {
		return
	}
	self := os.Getpid()
	for _, pid := range listUDPListenPortPIDs(port) {
		if pid <= 0 || pid == self {
			continue
		}
		args, err := readProcessCmdline(pid)
		if err != nil || !isManagedFXPCmdline(args) {
			logf("fxp mimic port occupant is not an Agent-managed FXP process; leaving it running port=%d pid=%d", port, pid)
			continue
		}
		killProcessByPID(pid)
	}
}

func killFXPByConfigPath(configPath string) {
	for _, pid := range fxpRuntimePIDs(configPath) {
		if proc, err := os.FindProcess(pid); err == nil {
			_ = proc.Kill()
		}
	}
}

func adoptExistingFXP(spec fxpSpec, signature string, configPath string, expectedCredentialDigests ...string) bool {
	if spec.TransportVersion == forwardXWireGuardVersion {
		return false
	}
	raw, err := os.ReadFile(configPath)
	if err != nil {
		return false
	}
	if fxpConfigUsesRemovedTrafficPadding(raw) {
		logf("fxp runtime uses removed traffic-padding config; forcing rebuild config=%s", configPath)
		return false
	}
	var existing fxpSpec
	if err := json.Unmarshal(raw, &existing); err != nil {
		return false
	}
	existing = normalizeFXPSpec(existing)
	if fxpServerSignature(existing) != signature {
		return false
	}
	if !fxpRuntimeUsesCurrentExecutable(configPath) {
		return false
	}
	credentialDigest, credentialsValid := fxpSpecPanelCredentialDigest(existing)
	expectedCredentialDigest := ""
	if len(expectedCredentialDigests) > 0 {
		expectedCredentialDigest = expectedCredentialDigests[0]
	} else if current, known := currentFXPPanelCredentialDigest(); known {
		expectedCredentialDigest = current
	}
	if fxpSpecNeedsPanelCredentials(existing) && expectedCredentialDigest != "" &&
		(!credentialsValid || !hmac.Equal([]byte(credentialDigest), []byte(expectedCredentialDigest))) {
		return false
	}
	readiness := readLocalRuntimeReadinessCached()
	if !fxpRuntimeListenersReady(spec, readiness.listenSnapshot) {
		return false
	}
	id := fxpServerID(spec)
	fxpMu.Lock()
	fxpServers[id] = &fxpProcess{
		signature:             signature,
		configPath:            configPath,
		spec:                  spec,
		runtimeExecutable:     currentFXPRuntimeExecutableInfo(),
		panelCredentialDigest: credentialDigest,
	}
	fxpMu.Unlock()
	watchAdoptedFXPProcess(id, configPath)
	logf("fxp %s adopted existing runtime tunnel=%d rule=%d listen=:%d protocol=%s config=%s", spec.Role, spec.TunnelID, spec.RuleID, spec.ListenPort, spec.Protocol, configPath)
	return true
}

func fxpListenEndpoints(spec fxpSpec) map[string]int {
	spec = normalizeFXPSpec(spec)
	endpoints := map[string]int{}
	if isFXPEntryGroup(spec) {
		for _, entry := range spec.Entries {
			for protocol, port := range fxpListenEndpoints(entry) {
				endpoints[protocol+":"+strconv.Itoa(port)] = port
			}
		}
		return endpoints
	}
	for _, protocol := range runtimeProtocols(spec.Protocol) {
		if protocol == "udp" {
			if spec.UDPListenPort > 0 {
				endpoints[protocol] = spec.UDPListenPort
			}
			continue
		}
		if spec.ListenPort > 0 {
			endpoints[protocol] = spec.ListenPort
		}
	}
	return endpoints
}

func fxpSpecsListenConflict(left fxpSpec, right fxpSpec) bool {
	leftEndpoints := fxpListenEndpoints(left)
	rightEndpoints := fxpListenEndpoints(right)
	for leftLane, leftPort := range leftEndpoints {
		leftProtocol := strings.SplitN(leftLane, ":", 2)[0]
		for rightLane, rightPort := range rightEndpoints {
			rightProtocol := strings.SplitN(rightLane, ":", 2)[0]
			if leftPort > 0 && leftPort == rightPort && leftProtocol == rightProtocol {
				return true
			}
		}
	}
	return false
}

// stopConflictingFXPRuntime removes listeners that would block a replacement,
// but leaves their last-known-good snapshots intact until the replacement has
// passed its startup check. A failed apply must remain recoverable after an
// Agent restart.
func stopConflictingFXPRuntime(spec fxpSpec) []fxpSpec {
	spec = normalizeFXPSpec(spec)
	desiredID := fxpServerID(spec)
	conflictingByID := map[string]fxpSpec{}
	addConflict := func(candidate fxpSpec) {
		candidate = normalizeFXPSpec(candidate)
		if candidate.Role == "" || candidate.TunnelID <= 0 || len(fxpListenEndpoints(candidate)) == 0 {
			return
		}
		if fxpServerID(candidate) == desiredID || !fxpSpecsListenConflict(candidate, spec) {
			return
		}
		conflictingByID[fxpServerID(candidate)] = candidate
	}
	fxpMu.Lock()
	for id, process := range fxpServers {
		if id == desiredID || process == nil || !fxpSpecsListenConflict(process.spec, spec) {
			continue
		}
		addConflict(process.spec)
	}
	fxpMu.Unlock()

	paths, _ := filepath.Glob("/run/forwardx-agent/fxp-*.json")
	for _, path := range paths {
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var existing fxpSpec
		if json.Unmarshal(raw, &existing) != nil {
			continue
		}
		existing = normalizeFXPSpec(existing)
		if fxpServerID(existing) == desiredID || !fxpSpecsListenConflict(existing, spec) {
			continue
		}
		addConflict(existing)
		killFXPByConfigPath(path)
		_ = os.Remove(path)
	}
	for _, existing := range planPersistedFXPRestoreSpecs(loadPersistedFXPSpecs()) {
		if isFXPEntryGroup(spec) && fxpEntryGroupContains(spec, existing) {
			continue
		}
		addConflict(existing)
	}

	conflictingSpecs := make([]fxpSpec, 0, len(conflictingByID))
	for _, conflicting := range conflictingByID {
		conflictingSpecs = append(conflictingSpecs, conflicting)
	}
	sort.Slice(conflictingSpecs, func(i, j int) bool {
		return fxpServerID(conflictingSpecs[i]) < fxpServerID(conflictingSpecs[j])
	})
	for _, conflicting := range conflictingSpecs {
		stopFXPRuntime(conflicting)
	}
	return conflictingSpecs
}

func fxpSpecWithoutListenConflicts(existing fxpSpec, desired fxpSpec) (fxpSpec, bool) {
	existing = normalizeFXPSpec(existing)
	desired = normalizeFXPSpec(desired)
	if !isFXPEntryGroup(existing) {
		return fxpSpec{}, false
	}
	remaining := make([]fxpSpec, 0, len(existing.Entries))
	for _, entry := range existing.Entries {
		if !fxpSpecsListenConflict(entry, desired) {
			remaining = append(remaining, entry)
		}
	}
	existing.Entries = remaining
	existing = normalizeFXPSpec(existing)
	return existing, len(existing.Entries) > 0
}

type fxpTransitionRestoreStarter func(Config, fxpSpec, *actionMessage, bool) bool

func restoreFXPTransitionLocked(cfg Config, desired fxpSpec, desiredStarted bool, previousSame *fxpSpec, conflicts []fxpSpec, replacements []fxpSpec, persistenceEnabled bool) {
	restoreFXPTransitionLockedWithStarter(cfg, desired, desiredStarted, previousSame, conflicts, replacements, persistenceEnabled, startFXPProcessLockedWithPersistence)
}

func restoreFXPTransitionLockedWithStarter(cfg Config, desired fxpSpec, desiredStarted bool, previousSame *fxpSpec, conflicts []fxpSpec, replacements []fxpSpec, persistenceEnabled bool, start fxpTransitionRestoreStarter) {
	if desiredStarted {
		stopFXPRuntime(desired)
	}
	for _, replacement := range replacements {
		stopFXPRuntime(replacement)
	}
	if persistenceEnabled && previousSame == nil {
		removePersistedFXPSpec(desired)
	}
	if start == nil {
		start = startFXPProcessLockedWithPersistence
	}
	restore := func(spec fxpSpec, reason string) {
		message := newActionMessage()
		if !start(cfg, spec, message, persistenceEnabled) {
			logf("fxp rollback restore failed reason=%s role=%s tunnel=%d rule=%d: %s", reason, spec.Role, spec.TunnelID, spec.RuleID, message.get())
		}
	}
	if previousSame != nil {
		restore(*previousSame, "same-runtime")
	}
	for _, conflict := range conflicts {
		restore(conflict, "listen-conflict")
	}
}

func startFXP(cfg Config, spec fxpSpec, desiredGroup *fxpSpec, actionMessage *actionMessage) bool {
	fxpControlMu.Lock()
	defer fxpControlMu.Unlock()
	return startFXPLocked(cfg, spec, desiredGroup, actionMessage)
}
