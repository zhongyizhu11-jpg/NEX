package main

import (
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

func successfulHeartbeatDelaySeconds(serverInterval int, fallbackInterval int, presenceSupported bool, eventStreamConnected bool) int {
	interval := serverInterval
	if interval <= 0 {
		interval = fallbackInterval
	}
	if presenceSupported {
		// New Agents schedule service and link probes locally. A service probe's
		// short interval must not force an expensive full panel reconciliation.
		// Values up to three seconds are reserved for interactive work and live
		// metrics, while SSE wakes configuration changes immediately.
		if eventStreamConnected && interval > agentInteractiveHeartbeatMaxIntervalSeconds {
			interval = int(agentFullHeartbeatInterval / time.Second)
		} else if !eventStreamConnected && interval > agentIdleHeartbeatIntervalSeconds {
			interval = agentIdleHeartbeatIntervalSeconds
		}
	}
	if interval < 2 {
		interval = 2
	}
	return interval
}

func jitterSuccessfulHeartbeatDelaySeconds(seconds int) int {
	if seconds < 60 {
		return seconds
	}
	base := time.Duration(seconds) * time.Second
	jittered := stableIntervalJitterBelow(base, agentBootID+":full-heartbeat", agentPeriodicJitterPercent)
	return max(2, int(jittered/time.Second))
}

func heartbeatStateSnapshotCopy() heartbeatStateSnapshot {
	heartbeatStateMu.Lock()
	defer heartbeatStateMu.Unlock()
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

func nextHeartbeatRetryInterval(previous time.Duration) time.Duration {
	if previous < agentHeartbeatRetryMinInterval {
		return agentHeartbeatRetryMinInterval
	}
	next := previous * 2
	if next > agentHeartbeatRetryMaxInterval {
		return agentHeartbeatRetryMaxInterval
	}
	return next
}

type heartbeatRetryState struct {
	failures int
	delay    time.Duration
	pending  bool
}

func (state *heartbeatRetryState) active() bool {
	return state.pending
}

var errHeartbeatRequestInFlight = errors.New("another heartbeat request is already in flight")

var errHeartbeatRetrySuperseded = errors.New("heartbeat retry canceled by a successful heartbeat")

// A full reconciliation may occupy its HTTP client for up to 60 seconds.
// Presence needs its own single-flight lane so that slow work cannot suppress
// liveness, while the shared success generation still cancels stale retries.
type heartbeatRequestLane uint8

const (
	heartbeatRequestLaneFull heartbeatRequestLane = iota
	heartbeatRequestLanePresence
	heartbeatRequestLaneCount
)

type heartbeatRequestCoordinator struct {
	mu                sync.Mutex
	inFlight          [heartbeatRequestLaneCount]bool
	successGeneration uint64
	successCh         chan struct{}
}

func newHeartbeatRequestCoordinator() *heartbeatRequestCoordinator {
	return &heartbeatRequestCoordinator{successCh: make(chan struct{})}
}

func (coordinator *heartbeatRequestCoordinator) tryStart(lane heartbeatRequestLane) (func(bool), bool) {
	finish, _, ok := coordinator.tryStartTracked(lane)
	return finish, ok
}

func (coordinator *heartbeatRequestCoordinator) tryStartTracked(lane heartbeatRequestLane) (func(bool), uint64, bool) {
	coordinator.mu.Lock()
	defer coordinator.mu.Unlock()
	if coordinator.inFlight[lane] {
		return nil, coordinator.successGeneration, false
	}
	return coordinator.startLocked(lane), coordinator.successGeneration, true
}

func (coordinator *heartbeatRequestCoordinator) tryStartIfGeneration(lane heartbeatRequestLane, expected uint64) (func(bool), error) {
	coordinator.mu.Lock()
	defer coordinator.mu.Unlock()
	if coordinator.successGeneration != expected {
		return nil, errHeartbeatRetrySuperseded
	}
	if coordinator.inFlight[lane] {
		return nil, errHeartbeatRequestInFlight
	}
	return coordinator.startLocked(lane), nil
}

func (coordinator *heartbeatRequestCoordinator) startLocked(lane heartbeatRequestLane) func(bool) {
	coordinator.inFlight[lane] = true
	var once sync.Once
	return func(success bool) {
		once.Do(func() {
			coordinator.mu.Lock()
			coordinator.inFlight[lane] = false
			if success {
				coordinator.successGeneration++
				close(coordinator.successCh)
				coordinator.successCh = make(chan struct{})
			}
			coordinator.mu.Unlock()
		})
	}
}

func (coordinator *heartbeatRequestCoordinator) successSnapshot() (uint64, <-chan struct{}) {
	coordinator.mu.Lock()
	defer coordinator.mu.Unlock()
	return coordinator.successGeneration, coordinator.successCh
}

var heartbeatRequests = newHeartbeatRequestCoordinator()

func (state *heartbeatRetryState) reset() {
	state.failures = 0
	state.delay = 0
	state.pending = false
}

// failure returns the next delay and whether the next request belongs to the
// current retry burst. Four retries plus the initial request bound each burst
// to five attempts; a later scheduled heartbeat starts a fresh burst.
func (state *heartbeatRetryState) failure(err error) (time.Duration, bool) {
	state.pending = true
	if !isRetryableHeartbeatError(err) {
		state.failures = 0
		state.delay = 0
		return agentHeartbeatRetryCooldown, false
	}
	state.failures++
	if state.failures > agentHeartbeatRetryLimit {
		state.failures = 0
		state.delay = 0
		return agentHeartbeatRetryCooldown, false
	}
	state.delay = nextHeartbeatRetryInterval(state.delay)
	return state.delay, true
}

func signalHeartbeatWake() {
	select {
	case heartbeatWakeCh <- struct{}{}:
	default:
	}
}

func restoreHeartbeatWakeIntent(fromSSE bool, urgentRefresh bool, forceReconcile bool) {
	if fromSSE {
		heartbeatWakeFromSSE.Store(true)
	}
	if urgentRefresh {
		heartbeatUrgentWakeFromSSE.Store(true)
	}
	if forceReconcile {
		heartbeatForceReconcileWake.Store(true)
	}
}

func wakeHeartbeat() {
	heartbeatForceReconcileWake.Store(true)
	signalHeartbeatWake()
}

// wakeHeartbeatFromSSE 由 SSE 推送触发，标记本次唤醒来源为 SSE。
// 主循环据此判断：若 Agent 正忙（actions pending），只发轻量 keepalive，
// 避免在 churn 窗口内重复执行 ss/systemctl/config 全扫描。
func shouldUseBusyHeartbeat(fromSSE bool, urgentRefresh bool, pending int64, lastFullHeartbeatAt time.Time, now time.Time) bool {
	return fromSSE && !urgentRefresh && pending > 0 && !lastFullHeartbeatAt.IsZero() && now.Sub(lastFullHeartbeatAt) < actionBacklogKeepaliveInterval
}

func shouldUseMetricsOnlyHeartbeat(metricsOnly bool, fromSSE bool, urgentRefresh bool, forceReconcileWake bool, pending int64, lastFullHeartbeatAt time.Time, now time.Time) bool {
	return metricsOnly && !fromSSE && !urgentRefresh && !forceReconcileWake && pending == 0 &&
		!lastFullHeartbeatAt.IsZero() && now.Sub(lastFullHeartbeatAt) < agentFullHeartbeatInterval
}

func wakeHeartbeatFromSSE(urgent bool) {
	heartbeatWakeFromSSE.Store(true)
	if urgent {
		heartbeatUrgentWakeFromSSE.Store(true)
	}
	signalHeartbeatWake()
}

func wakeAgentMetricsScheduler() {
	select {
	case agentMetricsWakeCh <- struct{}{}:
	default:
	}
}

func retainForcedTCPingRequest() {
	agentMetricsForceTCPing.Store(true)
	// Pair with finishTCPingCollection so either side wakes after a busy collector releases.
	if atomic.LoadInt32(&tcpingCollectRunning) == 0 && atomic.LoadInt64(&actionPendingCount) == 0 {
		wakeAgentMetricsScheduler()
	}
}

func agentPresenceLoop(cfg Config) {
	delay := scheduledAgentPresenceInterval(0)
	var retries heartbeatRetryState
	retryGeneration := uint64(0)
	for {
		timer := time.NewTimer(delay)
		if retries.active() {
			generation, successCh := heartbeatRequests.successSnapshot()
			if generation != retryGeneration {
				if !timer.Stop() {
					select {
					case <-timer.C:
					default:
					}
				}
				retries.reset()
				delay = scheduledAgentPresenceInterval(0)
				continue
			}
			select {
			case <-timer.C:
			case <-successCh:
				if !timer.Stop() {
					select {
					case <-timer.C:
					default:
					}
				}
				retries.reset()
				delay = scheduledAgentPresenceInterval(0)
				continue
			}
		} else {
			<-timer.C
		}
		if !agentPresenceSupported.Load() {
			delay = scheduledAgentPresenceInterval(0)
			retries.reset()
			continue
		}
		retryAttempt := retries.active()
		var nextInterval int
		var attemptGeneration uint64
		var err error
		if retryAttempt {
			nextInterval, attemptGeneration, err = heartbeatPresenceRetry(cfg, retryGeneration)
		} else {
			nextInterval, attemptGeneration, err = heartbeatPresence(cfg)
		}
		if errors.Is(err, errHeartbeatRetrySuperseded) {
			retries.reset()
			delay = scheduledAgentPresenceInterval(0)
			continue
		}
		if errors.Is(err, errHeartbeatRequestInFlight) {
			if retryAttempt {
				delay = agentPresenceMinInterval
			} else {
				delay = scheduledAgentPresenceInterval(0)
			}
			continue
		}
		if err != nil {
			logAgentCommError("presence", err)
			currentGeneration, _ := heartbeatRequests.successSnapshot()
			if currentGeneration != attemptGeneration {
				retries.reset()
				delay = scheduledAgentPresenceInterval(0)
				continue
			}
			var retrying bool
			delay, retrying = retries.failure(err)
			// 重试节奏（指数退避与冷却）不变，只把每次的等待在 [最小间隔, delay] 里随机化。
			delay = fullJitterDelay(delay, agentPresenceMinInterval)
			retryGeneration = currentGeneration
			if !retrying && shouldLogAgentReport("presence-retry-paused", agentReportLogInterval) {
				logf("presence retry burst stopped; next scheduled attempt in %s: %v", delay, err)
			}
			continue
		}
		retries.reset()
		delay = scheduledAgentPresenceInterval(nextInterval)
	}
}

func boundedAgentPresenceInterval(serverIntervalSeconds int) time.Duration {
	interval := agentPresenceInterval
	if serverIntervalSeconds > 0 {
		interval = time.Duration(serverIntervalSeconds) * time.Second
	}
	if interval < agentPresenceMinInterval {
		return agentPresenceMinInterval
	}
	if interval > agentPresenceMaxInterval {
		return agentPresenceMaxInterval
	}
	return interval
}

func scheduledAgentPresenceInterval(serverIntervalSeconds int) time.Duration {
	upperBound := boundedAgentPresenceInterval(serverIntervalSeconds)
	delay := stableIntervalJitterBelow(
		upperBound,
		agentBootID+":presence",
		agentPeriodicJitterPercent,
	)
	if delay < agentPresenceMinInterval {
		return agentPresenceMinInterval
	}
	return delay
}

func agentMetricsScheduler(cfg Config) {
	ticker := time.NewTicker(agentMetricsSchedulerResolution)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			scheduleTrafficCollection(cfg)
			force := agentMetricsForceTCPing.Swap(false)
			if !scheduleAgentTCPing(cfg, force) && force {
				retainForcedTCPingRequest()
			}
		case <-agentMetricsWakeCh:
			force := agentMetricsForceTCPing.Swap(false)
			state := heartbeatStateSnapshotCopy()
			prioritizeTrafficCollectionForRules(len(state.RunningRules))
			scheduleTrafficCollection(cfg)
			if force && !scheduleAgentTCPing(cfg, true) {
				retainForcedTCPingRequest()
			}
		}
	}
}

func scheduleAgentTCPing(cfg Config, force bool) bool {
	state := heartbeatStateSnapshotCopy()
	interval := tcpingDueInterval(
		state.HostProbeServices,
		len(state.RunningRules)+len(state.RuleLatencyProbes),
		len(state.TunnelProbes)+len(state.ForwardGroupProbes),
	)
	interval = agentPeriodicInterval(interval, "tcping")
	interval = capForwardGroupHealthProbeInterval(interval, state.ForwardGroupProbes)
	for _, rule := range state.RunningRules {
		interval = capForwardGroupHealthSpecInterval(interval, rule.GroupHealth)
	}
	for _, probe := range state.RuleLatencyProbes {
		interval = capForwardGroupHealthSpecInterval(interval, probe.GroupHealth)
	}
	tcpingScheduleMu.Lock()
	due := lastTCPingAt.IsZero() || time.Since(lastTCPingAt) >= interval
	tcpingScheduleMu.Unlock()
	if !force && !due {
		return false
	}
	if scheduleTCPingCollection(cfg, state.RuleLatencyProbes, state.TunnelProbes, state.ForwardGroupProbes, state.HostProbeServices, force) {
		tcpingScheduleMu.Lock()
		lastTCPingAt = time.Now()
		tcpingScheduleMu.Unlock()
		return true
	}
	return false
}

func capForwardGroupHealthProbeInterval(interval time.Duration, probes []forwardGroupProbe) time.Duration {
	for _, probe := range probes {
		probeType := strings.ToLower(strings.TrimSpace(probe.ProbeType))
		if probeType != "china" && probeType != "entry" {
			continue
		}
		interval = capForwardGroupHealthSpecInterval(interval, &forwardGroupHealthSpec{
			FailoverSeconds: probe.FailoverSeconds,
			RecoverSeconds:  probe.RecoverSeconds,
		})
	}
	return interval
}

func capForwardGroupHealthSpecInterval(interval time.Duration, health *forwardGroupHealthSpec) time.Duration {
	if health == nil {
		return interval
	}
	windowSeconds := health.FailoverSeconds
	if windowSeconds <= 0 || (health.RecoverSeconds > 0 && health.RecoverSeconds < windowSeconds) {
		windowSeconds = health.RecoverSeconds
	}
	if windowSeconds <= 0 {
		windowSeconds = 60
	}
	probeInterval := time.Duration(windowSeconds) * time.Second / 2
	if probeInterval < 5*time.Second {
		probeInterval = 5 * time.Second
	}
	if probeInterval > agentForwardGroupHealthProbeMaxInterval {
		probeInterval = agentForwardGroupHealthProbeMaxInterval
	}
	if interval > probeInterval {
		return probeInterval
	}
	return interval
}
