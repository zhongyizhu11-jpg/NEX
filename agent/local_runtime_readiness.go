package main

import (
	"net"
	"os"
	"strconv"
	"strings"
	"time"
)

type localRuntimeReadiness struct {
	runtimePorts               map[int]bool
	gostRuntimePorts           map[int]bool
	tunnelRuntimePorts         map[int]bool
	nginxRuntimePorts          map[int]bool
	gostRuntimePortProtocols   map[int]map[string]bool
	tunnelRuntimePortProtocols map[int]map[string]bool
	nginxRuntimePortProtocols  map[int]map[string]bool
	gostRuntimeReady           bool
	tunnelRuntimeReady         bool
	nginxRuntimeReady          bool
	sharedRuntimeReady         bool
	serviceStates              []localRuntimeServiceState
	serviceActiveCache         map[string]bool
	kernelSnapshot             *kernelForwardSnapshot
	listenSnapshot             *runtimeListenSnapshot
}

func heartbeatStateSignaturePayload() map[string]string {
	heartbeatStateMu.Lock()
	defer heartbeatStateMu.Unlock()
	if len(heartbeatStateSignatures) == 0 {
		return nil
	}
	out := make(map[string]string, len(heartbeatStateSignatures))
	for key, value := range heartbeatStateSignatures {
		if strings.TrimSpace(value) != "" {
			out[key] = value
		}
	}
	return out
}

func applyHeartbeatState(resp heartbeatResp) heartbeatStateSnapshot {
	heartbeatStateMu.Lock()
	defer heartbeatStateMu.Unlock()
	hasStateSignature := func(name string) bool {
		return strings.TrimSpace(resp.StateSignatures[name]) != ""
	}
	if resp.RunningRules != nil {
		heartbeatStateCache.RunningRules = append([]runningRule(nil), resp.RunningRules...)
		if !hasStateSignature("runningRules") {
			delete(heartbeatStateSignatures, "runningRules")
		}
	}
	if resp.RuleLatencyProbes != nil {
		heartbeatStateCache.RuleLatencyProbes = append([]ruleLatencyProbe(nil), resp.RuleLatencyProbes...)
		if !hasStateSignature("ruleLatencyProbes") {
			delete(heartbeatStateSignatures, "ruleLatencyProbes")
		}
	}
	if resp.TunnelProbes != nil {
		heartbeatStateCache.TunnelProbes = append([]tunnelProbe(nil), resp.TunnelProbes...)
		if !hasStateSignature("tunnelProbes") {
			delete(heartbeatStateSignatures, "tunnelProbes")
		}
	}
	if resp.ForwardGroupProbes != nil {
		heartbeatStateCache.ForwardGroupProbes = append([]forwardGroupProbe(nil), resp.ForwardGroupProbes...)
		if !hasStateSignature("forwardGroupProbes") {
			delete(heartbeatStateSignatures, "forwardGroupProbes")
		}
	}
	if resp.HostProbeServices != nil {
		heartbeatStateCache.HostProbeServices = append([]hostProbeServiceProbe(nil), resp.HostProbeServices...)
		if !hasStateSignature("hostProbeServices") {
			delete(heartbeatStateSignatures, "hostProbeServices")
		}
	}
	if resp.GuardRules != nil {
		heartbeatStateCache.GuardRules = append([]guardRule(nil), resp.GuardRules...)
		if !hasStateSignature("guardRules") {
			delete(heartbeatStateSignatures, "guardRules")
		}
	}
	if resp.SNIInbounds != nil {
		heartbeatStateCache.SNIInbounds = append([]sniInboundSpec(nil), resp.SNIInbounds...)
		if !hasStateSignature("sniInbounds") {
			delete(heartbeatStateSignatures, "sniInbounds")
		}
	}
	if resp.DNSWatch != nil {
		heartbeatStateCache.DNSWatch = append([]dnsWatchItem(nil), resp.DNSWatch...)
		if !hasStateSignature("dnsWatch") {
			delete(heartbeatStateSignatures, "dnsWatch")
		}
	}
	if len(resp.StateSignatures) > 0 {
		for key, value := range resp.StateSignatures {
			if strings.TrimSpace(value) != "" {
				heartbeatStateSignatures[key] = value
			}
		}
	}
	return heartbeatStateSnapshot{
		RunningRules:       append([]runningRule(nil), heartbeatStateCache.RunningRules...),
		RuleLatencyProbes:  append([]ruleLatencyProbe(nil), heartbeatStateCache.RuleLatencyProbes...),
		TunnelProbes:       append([]tunnelProbe(nil), heartbeatStateCache.TunnelProbes...),
		ForwardGroupProbes: append([]forwardGroupProbe(nil), heartbeatStateCache.ForwardGroupProbes...),
		HostProbeServices:  append([]hostProbeServiceProbe(nil), heartbeatStateCache.HostProbeServices...),
		GuardRules:         append([]guardRule(nil), heartbeatStateCache.GuardRules...),
		SNIInbounds:        append([]sniInboundSpec(nil), heartbeatStateCache.SNIInbounds...),
		DNSWatch:           append([]dnsWatchItem(nil), heartbeatStateCache.DNSWatch...),
	}
}

func readLocalRuntimeReadiness() localRuntimeReadiness {
	readiness := localRuntimeReadiness{
		runtimePorts:               map[int]bool{},
		gostRuntimePorts:           map[int]bool{},
		tunnelRuntimePorts:         map[int]bool{},
		nginxRuntimePorts:          map[int]bool{},
		gostRuntimePortProtocols:   map[int]map[string]bool{},
		tunnelRuntimePortProtocols: map[int]map[string]bool{},
		nginxRuntimePortProtocols:  map[int]map[string]bool{},
		gostRuntimeReady:           true,
		tunnelRuntimeReady:         true,
		nginxRuntimeReady:          true,
		sharedRuntimeReady:         true,
		serviceActiveCache:         map[string]bool{},
		kernelSnapshot:             newKernelForwardSnapshot(),
		listenSnapshot:             newRuntimeListenSnapshot(),
	}
	configs := []struct {
		path    string
		service string
		kind    string
	}{
		{runtimeConfigPath, runtimeServiceName, "gost"},
		{tunnelRuntimeConfigPath, tunnelRuntimeServiceName, "tunnel-gost"},
		{nginxConfigPath, nginxServiceName, "nginx"},
	}
	for _, cfg := range configs {
		var listens []runtimeListenConfig
		var ok bool
		if cfg.kind == "nginx" {
			listens, ok = nginxRuntimeListenConfigs(cfg.path)
		} else {
			listens, ok = readGostRuntimeServiceListens(cfg.path)
		}
		hasWork := ok && len(listens) > 0
		if !ok {
			if _, statErr := os.Stat(cfg.path); statErr == nil && shouldLogAgentReport("runtime-config-unreadable:"+cfg.kind, agentReportLogInterval) {
				logf("runtime readiness config unreadable kind=%s service=%s path=%s", cfg.kind, cfg.service, cfg.path)
			}
		} else if len(listens) == 0 && shouldLogAgentReport("runtime-config-empty:"+cfg.kind, 5*time.Minute) {
			// An empty managed config is valid when no rules use this runtime. It is
			// recorded at a low rate because it helps distinguish an idle runtime
			// from a malformed or truncated config during support investigations.
			logf("runtime readiness config empty kind=%s service=%s path=%s", cfg.kind, cfg.service, cfg.path)
		}
		for _, listen := range listens {
			if port := addrPort(listen.Addr); port > 0 {
				readiness.runtimePorts[port] = true
				protocol := normalizeRuntimeProtocol(listen.Protocol)
				switch cfg.kind {
				case "nginx":
					readiness.nginxRuntimePorts[port] = true
					addRuntimePortProtocol(readiness.nginxRuntimePortProtocols, port, protocol)
				case "tunnel-gost":
					readiness.tunnelRuntimePorts[port] = true
					addRuntimePortProtocol(readiness.tunnelRuntimePortProtocols, port, protocol)
				default:
					readiness.gostRuntimePorts[port] = true
					addRuntimePortProtocol(readiness.gostRuntimePortProtocols, port, protocol)
				}
			}
		}
		active := false
		if hasWork {
			active = managedServiceActive(cfg.service)
		}
		readiness.serviceActiveCache[cfg.service] = active
		if hasWork && !active {
			if shouldLogAgentReport("runtime-service-inactive:"+cfg.kind, agentReportLogInterval) {
				logf("runtime readiness service inactive kind=%s service=%s listeners=%d path=%s", cfg.kind, cfg.service, len(listens), cfg.path)
			}
			readiness.sharedRuntimeReady = false
			switch cfg.kind {
			case "nginx":
				readiness.nginxRuntimeReady = false
			case "tunnel-gost":
				readiness.tunnelRuntimeReady = false
			default:
				readiness.gostRuntimeReady = false
			}
		}
		readiness.serviceStates = append(readiness.serviceStates, localRuntimeServiceState{
			Name:    cfg.service,
			Active:  active,
			HasWork: hasWork,
		})
	}
	mimicServices := managedMimicServicesFromLocalConfig()
	restoreUnusedMimicNetworkCompatibility()
	for _, service := range mimicServices {
		report := mimicRuntimeServiceReportFor(service)
		active := report.Active
		readiness.serviceActiveCache[service] = active
		readiness.serviceStates = append(readiness.serviceStates, report)
	}
	return readiness
}

// readLocalRuntimeReadinessCached 返回带 TTL 缓存的 readLocalRuntimeReadiness 结果。
// 相同 TTL 窗口内多次调用（SSE 唤醒风暴、primeDesiredRuntimeReadyCacheForActions）
// 只产生一次 ss/systemctl/config 读取。
// 调用 invalidateLocalRuntimeReadinessCache() 可提前失效（如 action 执行完毕后）。
func readLocalRuntimeReadinessCached() localRuntimeReadiness {
	localRuntimeReadinessCacheMu.Lock()
	defer localRuntimeReadinessCacheMu.Unlock()
	if !localRuntimeReadinessCacheInvalid &&
		localRuntimeReadinessCacheResult != nil &&
		time.Since(localRuntimeReadinessCachedAt) < localRuntimeReadinessCacheTTL {
		return *localRuntimeReadinessCacheResult
	}
	r := readLocalRuntimeReadiness()
	localRuntimeReadinessCacheResult = &r
	localRuntimeReadinessCachedAt = time.Now()
	localRuntimeReadinessCacheInvalid = false
	return r
}

func invalidateLocalRuntimeReadinessCache() {
	localRuntimeReadinessCacheMu.Lock()
	localRuntimeReadinessCacheInvalid = true
	localRuntimeReadinessCacheMu.Unlock()
	desiredRuntimeReadyMu.Lock()
	desiredNginxRuntimeReadyCache = map[string]desiredRuntimeReadyCacheEntry{}
	desiredGostRuntimeReadyCache = map[string]desiredRuntimeReadyCacheEntry{}
	desiredRuntimeReadyMu.Unlock()
	broadcastManagedRuntimeListenReady()
}

func (r *localRuntimeReadiness) managedServiceActiveCached(name string) bool {
	name = sanitizeServiceName(name)
	if name == "" {
		return false
	}
	if r.serviceActiveCache == nil {
		r.serviceActiveCache = map[string]bool{}
	}
	if active, ok := r.serviceActiveCache[name]; ok {
		return active
	}
	active := managedServiceActive(name)
	r.serviceActiveCache[name] = active
	return active
}

func addRuntimePortProtocol(ports map[int]map[string]bool, port int, protocol string) {
	if ports == nil || port <= 0 {
		return
	}
	protocol = normalizeRuntimeProtocol(protocol)
	if ports[port] == nil {
		ports[port] = map[string]bool{}
	}
	for _, proto := range runtimeProtocols(protocol) {
		ports[port][proto] = true
	}
}

func runtimePortProtocolConfigured(ports map[int]map[string]bool, port int, protocol string) bool {
	if ports == nil || port <= 0 {
		return false
	}
	configured := ports[port]
	if len(configured) == 0 {
		return false
	}
	for _, proto := range runtimeProtocols(protocol) {
		if !configured[proto] && !configured["both"] {
			return false
		}
	}
	return true
}

func (r *localRuntimeReadiness) gostMainReadyForPort(port int, protocol string) bool {
	if r == nil || port <= 0 {
		return false
	}
	// runtimeServiceName ("forwardx-runtime") is the actual binary; Linux ss(8)
	// truncates comm to 15 chars so it appears as "forwardx-runtim" in ss output.
	// Keep "gost" for environments that still run the upstream gost binary directly.
	runtimeNeedles := []string{"gost", "forwardx-runt"}
	return r.gostRuntimeReady &&
		r.gostRuntimePorts[port] &&
		runtimePortProtocolConfigured(r.gostRuntimePortProtocols, port, protocol) &&
		runtimeListenPortReady(r.listenSnapshot, port, protocol, runtimeNeedles)
}

func (r *localRuntimeReadiness) gostTunnelReadyForPort(port int, protocol string) bool {
	if r == nil || port <= 0 {
		return false
	}
	runtimeNeedles := []string{"gost", "forwardx-runt"}
	return r.tunnelRuntimeReady &&
		r.tunnelRuntimePorts[port] &&
		runtimePortProtocolConfigured(r.tunnelRuntimePortProtocols, port, protocol) &&
		runtimeListenPortReady(r.listenSnapshot, port, protocol, runtimeNeedles)
}

// Prefer the runtime family that owns the action. Falling back only when the
// preferred config does not declare the port keeps rolling upgrades compatible,
// while preventing a stale duplicate in the other config from marking a healthy
// TLS listener as failed.
func (r *localRuntimeReadiness) gostReadyForPortInScope(port int, protocol string, scope string) bool {
	if r == nil || port <= 0 {
		return false
	}
	switch strings.TrimSpace(scope) {
	case desiredGostTunnelRuntimeScope:
		if r.tunnelRuntimePorts[port] {
			return r.gostTunnelReadyForPort(port, protocol)
		}
		return r.gostMainReadyForPort(port, protocol)
	default:
		if r.gostRuntimePorts[port] {
			return r.gostMainReadyForPort(port, protocol)
		}
		return r.gostTunnelReadyForPort(port, protocol)
	}
}

func (r *localRuntimeReadiness) nginxReadyForPort(port int, protocol string) bool {
	if r == nil || port <= 0 {
		return false
	}
	return r.nginxRuntimeReady &&
		r.nginxRuntimePorts[port] &&
		runtimePortProtocolConfigured(r.nginxRuntimePortProtocols, port, protocol) &&
		runtimeListenPortReady(r.listenSnapshot, port, protocol, []string{"nginx"})
}

func addrPort(addr string) int {
	text := strings.TrimSpace(addr)
	if text == "" {
		return 0
	}
	if idx := strings.LastIndex(text, "://"); idx >= 0 {
		text = text[idx+3:]
	}
	_, rawPort, err := net.SplitHostPort(text)
	if err != nil {
		idx := strings.LastIndex(text, ":")
		if idx < 0 || idx >= len(text)-1 {
			return 0
		}
		rawPort = text[idx+1:]
	}
	port, err := strconv.Atoi(strings.Trim(strings.TrimSpace(rawPort), "[]"))
	if err != nil || port <= 0 || port > 65535 {
		return 0
	}
	return port
}

func localRuleManagedServiceGroups(forwardType string, port int, protocol string) [][]string {
	if port <= 0 {
		return nil
	}
	portText := strconv.Itoa(port)
	normalizedProtocol := normalizeRuntimeProtocol(protocol)
	switch strings.TrimSpace(forwardType) {
	case "realm":
		alternatives := []string{"forwardx-realm-" + normalizedProtocol + "-" + portText}
		if normalizedProtocol != "udp" {
			alternatives = append(alternatives, "forwardx-realm-"+portText)
		}
		return [][]string{alternatives}
	case "socat":
		if normalizedProtocol == "both" {
			return [][]string{
				{"forwardx-socat-tcp-" + portText},
				{"forwardx-socat-udp-" + portText},
			}
		}
		alternatives := []string{"forwardx-socat-" + normalizedProtocol + "-" + portText}
		if normalizedProtocol != "udp" {
			alternatives = append(alternatives, "forwardx-socat-"+portText)
		}
		return [][]string{alternatives}
	default:
		return nil
	}
}

func managedServiceGroupsActiveCached(readiness *localRuntimeReadiness, groups [][]string) bool {
	if readiness == nil || len(groups) == 0 {
		return false
	}
	for _, alternatives := range groups {
		active := false
		for _, name := range alternatives {
			if readiness.managedServiceActiveCached(name) {
				active = true
				break
			}
		}
		if !active {
			return false
		}
	}
	return true
}

func managedRuleListenProcessNeedles(forwardType string) []string {
	switch strings.TrimSpace(forwardType) {
	case "realm":
		return []string{"realm"}
	case "socat":
		return []string{"socat"}
	default:
		return nil
	}
}

func managedRuleServiceListenReady(forwardType string, port int, protocol string, readiness *localRuntimeReadiness) bool {
	groups := localRuleManagedServiceGroups(forwardType, port, protocol)
	if !managedServiceGroupsActiveCached(readiness, groups) {
		return false
	}
	return runtimeListenPortReady(readiness.listenSnapshot, port, protocol, managedRuleListenProcessNeedles(forwardType))
}

func localRuleStateReady(state localRuleState, readiness *localRuntimeReadiness) bool {
	port := atoi(state.Port)
	if port <= 0 || readiness == nil {
		return false
	}
	forwardType := strings.TrimSpace(state.ForwardType)
	switch forwardType {
	case "guard":
		return protocolGuardRuleStateReady(state, readiness)
	case "realm", "socat":
		return managedRuleServiceListenReady(forwardType, port, state.Protocol, readiness)
	case "iptables":
		return readiness.kernelSnapshot != nil && readiness.kernelSnapshot.localRuleStateReady(state)
	case "nftables":
		return readiness.kernelSnapshot != nil && readiness.kernelSnapshot.localRuleStateReady(state)
	case "gost", "gost-tunnel", "gost-tunnel-exit", "gost-tunnel-hop":
		// Main and tunnel GOST runtimes can briefly share a port during a
		// rolling restart. Do not let a listener owned by the other runtime
		// family make this rule look ready and suppress its recovery action.
		return readiness.gostReadyForPortInScope(
			port,
			gostRuntimeListenProtocol(forwardType, state.Protocol),
			desiredGostRuntimeScope(forwardType),
		)
	case "nginx", "nginx-tunnel", "nginx-tunnel-exit":
		return readiness.nginxReadyForPort(port, state.Protocol)
	case "forwardx":
		return fxpRuntimeReadyForRulePort(state.RuleID, port, state.Protocol, readiness.listenSnapshot)
	default:
		return true
	}
}

func localTunnelStateReady(tunnelID int, port int, forwardType string, readiness *localRuntimeReadiness) bool {
	if tunnelID <= 0 || port <= 0 || readiness == nil {
		return false
	}
	switch strings.TrimSpace(forwardType) {
	case "gost-tunnel":
		return readiness.gostReadyForPortInScope(port, "tcp", desiredGostTunnelRuntimeScope)
	case "nginx-tunnel", "nginx-tunnel-exit":
		return readiness.nginxReadyForPort(port, "tcp")
	case "forwardx-tunnel":
		return fxpRuntimeReadyForTunnelPort(tunnelID, port, readiness.listenSnapshot)
	default:
		return true
	}
}
