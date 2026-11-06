package main

import (
	"errors"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"time"
)

// logHeartbeatResponse records the control-plane result without including the
// request payload (which may contain target addresses or other user data).
// Stable heartbeats are sampled; responses that require work are sampled more
// frequently so a stalled reconciliation can be diagnosed promptly.
func logHeartbeatResponse(mode string, resp *heartbeatResp, duration time.Duration) {
	if resp == nil {
		return
	}
	mode = strings.TrimSpace(mode)
	if mode == "" {
		mode = "full"
	}
	desiredActions := 0
	if resp.DesiredState != nil {
		desiredActions = len(resp.DesiredState.Actions)
	}
	anomalous := resp.RequestLocalState
	anomalous = anomalous || resp.ReconciliationCoalesced
	anomalous = anomalous || resp.AgentUpgrade != nil || resp.PanelMigration != nil
	anomalous = anomalous || len(resp.Actions) > 0 || len(resp.SelfTests) > 0
	anomalous = anomalous || len(resp.LookingGlassTests) > 0 || len(resp.Iperf3Tasks) > 0 || len(resp.PluginTasks) > 0
	anomalous = anomalous || len(resp.DiagnosticsTasks) > 0 || len(resp.RuleConnectionTasks) > 0
	interval := agentHeartbeatSummaryLogInterval
	if anomalous {
		interval = agentReportLogInterval
	}
	if !shouldLogAgentReport("heartbeat-response:"+mode, interval) {
		return
	}
	receivedRevision, appliedRevision, _, _ := desiredRevisionSnapshot()
	logf(
		"heartbeat response mode=%s duration=%s actions=%d desiredActions=%d runningRules=%d tunnelProbes=%d "+
			"selfTests=%d interactive=%d/%d/%d next=%ds coalesced=%v requestLocalState=%v "+
			"metricsOnly=%v forceTcping=%v pendingActions=%d queued=%d ingress=%d workers=%d/%d "+
			"revisions=%d/%d eventStream=%v",
		mode,
		duration.Round(time.Millisecond),
		len(resp.Actions),
		desiredActions,
		len(resp.RunningRules),
		len(resp.TunnelProbes),
		len(resp.SelfTests),
		len(resp.LookingGlassTests),
		len(resp.Iperf3Tasks),
		len(resp.PluginTasks),
		resp.NextInterval,
		resp.ReconciliationCoalesced,
		resp.RequestLocalState,
		resp.MetricsOnly,
		resp.ForceTCPing,
		atomic.LoadInt64(&actionPendingCount),
		len(actionQueue),
		actionIngress.len(),
		atomic.LoadInt64(&actionWorkerStartedCount),
		actionWorkerConcurrency,
		receivedRevision,
		appliedRevision,
		agentEventStreamConnected.Load(),
	)
}

func heartbeatStaticChanged(a, b heartbeatStaticSnapshot) bool {
	return a.PrimaryIP != b.PrimaryIP ||
		a.IPv4 != b.IPv4 ||
		a.IPv6 != b.IPv6 ||
		a.PrivateIPv4 != b.PrivateIPv4 ||
		a.DefaultNetworkInterface != b.DefaultNetworkInterface ||
		a.CPUInfo != b.CPUInfo ||
		a.MemoryTotal != b.MemoryTotal ||
		a.SwapTotal != b.SwapTotal ||
		a.DiskTotal != b.DiskTotal ||
		a.Version != b.Version
}

func shouldCommitHeartbeatStaticReport(compactEnabled bool, shouldReportStatic bool, reconciliationCoalesced bool) bool {
	return !reconciliationCoalesced && (!compactEnabled || shouldReportStatic)
}

func heartbeatKeepalive(cfg Config) (heartbeatResult, error) {
	startedAt := time.Now()
	ipv4, ipv6 := publicIPs()
	primaryIP := ipv4
	if primaryIP == "" {
		primaryIP = ipv6
	}
	memInfo := readMeminfo()
	memoryTotal := memTotalFrom(memInfo)
	memoryUsed := memUsedFrom(memInfo)
	swapTotal := swapTotalFrom(memInfo)
	swapUsed := swapUsedFrom(memInfo)
	diskUsageValue, diskUsed, diskTotal := diskStats()
	currentStatic := heartbeatStaticSnapshot{
		PrimaryIP:               primaryIP,
		IPv4:                    ipv4,
		IPv6:                    ipv6,
		PrivateIPv4:             localPrivateIPv4(),
		DefaultNetworkInterface: defaultNetworkInterface(),
		CPUInfo:                 cpuInfo(),
		MemoryTotal:             memoryTotal,
		SwapTotal:               swapTotal,
		DiskTotal:               diskTotal,
		Version:                 Version,
	}
	previousStatic := heartbeatStaticReport
	shouldReportStatic := !previousStatic.Initialized ||
		heartbeatStaticChanged(currentStatic, previousStatic) ||
		time.Since(previousStatic.ReportedAt) >= heartbeatStaticReportInterval
	receivedRevision, appliedRevision, receivedHash, appliedHash := desiredRevisionSnapshot()
	uptimeValue := uptime()
	payload := map[string]any{
		"busy":                      true,
		"agentBootId":               agentBootID,
		"agentBootedAt":             time.Now().Unix() - uptimeValue,
		"agentProcessId":            os.Getpid(),
		"agentProcessStartedAt":     agentProcessStartedAt.Unix(),
		"agentLastReceivedRevision": receivedRevision,
		"agentLastAppliedRevision":  appliedRevision,
		"agentLastReceivedHash":     receivedHash,
		"agentLastAppliedHash":      appliedHash,
		"fxpEndpointEvents":         fxpEndpointEventsSnapshot(),
		"sniInbounds":               sniInboundStatusSnapshot(),
		"failoverEvents":            failoverProxyEventsSnapshot(),
		"failoverActive":            failoverActiveSnapshot(),
		"failoverStats":             failoverStatsSnapshot(),
	}
	payload["mimicEnvironment"] = mimicEnvironment(false)
	payload["fxpVersion"] = reportedFXPVersion()
	addGostRuntimeReport(payload)
	addAgentRuntimeReport(payload)
	tcpConnections, udpConnections := connectionCounts()
	if compactAgentReports.Load() {
		payload["m"] = []any{
			cpuUsage(),
			usagePercent(memoryUsed, memoryTotal),
			memoryUsed,
			memoryTotal,
			usagePercent(swapUsed, swapTotal),
			swapUsed,
			swapTotal,
			netBytes(0),
			netBytes(1),
			diskUsageValue,
			diskUsed,
			diskTotal,
			uptime(),
			tcpConnections,
			udpConnections,
		}
	} else {
		payload["cpuUsage"] = cpuUsage()
		payload["memoryUsage"] = usagePercent(memoryUsed, memoryTotal)
		payload["memoryUsed"] = memoryUsed
		payload["memoryTotal"] = memoryTotal
		payload["swapUsage"] = usagePercent(swapUsed, swapTotal)
		payload["swapUsed"] = swapUsed
		payload["swapTotal"] = swapTotal
		payload["networkIn"] = netBytes(0)
		payload["networkOut"] = netBytes(1)
		payload["diskUsage"] = diskUsageValue
		payload["diskUsed"] = diskUsed
		payload["diskTotal"] = diskTotal
		payload["uptime"] = uptime()
		payload["tcpConnections"] = tcpConnections
		payload["udpConnections"] = udpConnections
	}
	if shouldReportStatic && primaryIP != "" {
		payload["ip"] = primaryIP
	}
	if shouldReportStatic && ipv4 != "" {
		payload["ipv4"] = ipv4
	}
	if shouldReportStatic && ipv6 != "" {
		payload["ipv6"] = ipv6
	}
	if compactAgentReports.Load() && shouldReportStatic {
		payload["cpuInfo"] = currentStatic.CPUInfo
		payload["agentVersion"] = Version
	}
	if currentStatic.DefaultNetworkInterface != "" {
		payload["defaultNetworkInterface"] = currentStatic.DefaultNetworkInterface
	}
	if currentStatic.PrivateIPv4 != "" {
		payload["privateIpv4"] = currentStatic.PrivateIPv4
	}
	var resp heartbeatResp
	if err := postHeartbeat(cfg, "/api/agent/heartbeat", payload, &resp); err != nil {
		return heartbeatResult{NextInterval: cfg.Interval}, err
	}
	logHeartbeatResponse("keepalive", &resp, time.Since(startedAt))
	compactAgentReports.Store(resp.CompactReports)
	agentPresenceSupported.Store(resp.PresenceSupported)
	if resp.TrafficReportInterval > 0 {
		setActiveTrafficReportIntervalSeconds(resp.TrafficReportInterval)
	}
	if shouldReportStatic {
		currentStatic.ReportedAt = time.Now()
		currentStatic.Initialized = true
		heartbeatStaticReport = currentStatic
	}
	if handlePanelMigrationDirective(cfg, resp.PanelMigration) {
		return heartbeatResult{NextInterval: cfg.Interval}, nil
	}
	syncPanelURLFromResponse(resp.PanelURL)
	if resp.RequestLocalState {
		requestLocalRuntimeStateUpload()
	}
	return heartbeatResult{NextInterval: resp.NextInterval, MetricsOnly: resp.MetricsOnly}, nil
}

// heartbeatPresence only proves that the authenticated Agent is alive. It is
// intentionally separate from heartbeatKeepalive: no local readiness probes,
// metrics collection, plugin inventory or runtime plan is performed here.
func heartbeatPresence(cfg Config) (int, uint64, error) {
	return heartbeatPresenceRequest(cfg, nil)
}

func heartbeatPresenceRetry(cfg Config, expectedGeneration uint64) (int, uint64, error) {
	return heartbeatPresenceRequest(cfg, &expectedGeneration)
}

func heartbeatPresenceRequest(cfg Config, expectedGeneration *uint64) (int, uint64, error) {
	receivedRevision, appliedRevision, receivedHash, appliedHash := desiredRevisionSnapshot()
	payload := map[string]any{
		"mode":                      "presence",
		"agentBootId":               agentBootID,
		"agentProcessId":            os.Getpid(),
		"agentProcessStartedAt":     agentProcessStartedAt.Unix(),
		"agentLastReceivedRevision": receivedRevision,
		"agentLastAppliedRevision":  appliedRevision,
		"agentLastReceivedHash":     receivedHash,
		"agentLastAppliedHash":      appliedHash,
	}
	var resp heartbeatResp
	// Use the short-lived presence client, but retain the shared clock recovery
	// path so an authentication timestamp error cannot leave presence broken
	// until the next five-minute full heartbeat.
	requestGeneration := uint64(0)
	var err error
	if expectedGeneration == nil {
		requestGeneration, err = postHeartbeatWithClientTracked(agentPresenceHTTPClient, cfg, "/api/agent/presence", payload, &resp)
	} else {
		requestGeneration = *expectedGeneration
		err = postHeartbeatWithClientIfGeneration(agentPresenceHTTPClient, cfg, "/api/agent/presence", payload, &resp, *expectedGeneration)
	}
	if err != nil {
		var statusErr agentHTTPStatusError
		if errors.As(err, &statusErr) && (statusErr.StatusCode == http.StatusBadRequest ||
			statusErr.StatusCode == http.StatusNotFound ||
			statusErr.StatusCode == http.StatusMethodNotAllowed) {
			agentPresenceSupported.Store(false)
			wakeHeartbeat()
			return 0, requestGeneration, nil
		}
		return 0, requestGeneration, err
	}
	if !resp.Presence || !resp.PresenceSupported {
		// A panel older than the presence capability may return a normal
		// heartbeat response. Never discard actions from that response; stop
		// sending presence and let the legacy full-heartbeat path take over.
		agentPresenceSupported.Store(false)
		wakeHeartbeat()
		return 0, requestGeneration, nil
	}
	agentPresenceSupported.Store(true)
	if handlePanelMigrationDirective(cfg, resp.PanelMigration) {
		return resp.NextPresenceInterval, requestGeneration, nil
	}
	syncPanelURLFromResponse(resp.PanelURL)
	return resp.NextPresenceInterval, requestGeneration, nil
}

func tcpingDueInterval(serviceProbes []hostProbeServiceProbe, ruleCount int, linkProbeCount int) time.Duration {
	workCount := ruleCount + linkProbeCount
	interval := time.Minute
	switch {
	case workCount >= 500:
		interval = 15 * time.Second
	case workCount >= 200:
		interval = 20 * time.Second
	case workCount >= 100:
		interval = 30 * time.Second
	}
	for _, probe := range serviceProbes {
		seconds := probe.IntervalSeconds
		if seconds <= 0 {
			seconds = 30
		}
		if seconds < 5 {
			seconds = 5
		}
		duration := time.Duration(seconds) * time.Second
		if duration < interval {
			interval = duration
		}
	}
	return interval
}
