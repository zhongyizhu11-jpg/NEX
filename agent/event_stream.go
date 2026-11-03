package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type agentEventMessage struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

type agentRefreshEvent struct {
	Reason          string `json:"reason"`
	Urgent          bool   `json:"urgent"`
	ForceMimicCheck bool   `json:"forceMimicCheck"`
}

// agentDesiredStatePush 是服务端经 SSE 下发的 desiredState 推送载荷，
// 包含运行规则及其延迟探测配置，让 Agent 无需等待下一个心跳即可立即执行。
type agentDesiredStatePush struct {
	DesiredState      *desiredState      `json:"desiredState,omitempty"`
	RunningRules      []runningRule      `json:"runningRules,omitempty"`
	RuleLatencyProbes []ruleLatencyProbe `json:"ruleLatencyProbes,omitempty"`
	StateSignatures   map[string]string  `json:"stateSignatures,omitempty"`
}

type desiredStatePushJob struct {
	cfg  Config
	push agentDesiredStatePush
}

// desiredStatePushScheduler serializes reconciliation work and keeps at most
// the newest not-yet-started push. Desired-state events are snapshots, so an
// older pending snapshot must not delay a newer one during a push burst.
type desiredStatePushScheduler struct {
	mu      sync.Mutex
	running bool
	pending *desiredStatePushJob
	process func(Config, agentDesiredStatePush)
}

func newDesiredStatePushScheduler(process func(Config, agentDesiredStatePush)) *desiredStatePushScheduler {
	return &desiredStatePushScheduler{process: process}
}

func (scheduler *desiredStatePushScheduler) schedule(cfg Config, push agentDesiredStatePush) {
	job := desiredStatePushJob{cfg: cfg, push: push}
	scheduler.mu.Lock()
	if scheduler.running {
		scheduler.pending = &job
		scheduler.mu.Unlock()
		if shouldLogAgentReport("desired-state-push-coalesced", agentHeartbeatSummaryLogInterval) {
			actionCount := 0
			if push.DesiredState != nil {
				actionCount = len(push.DesiredState.Actions)
			}
			logf("desired state push coalesced actions=%d runningRules=%d latencyProbes=%d", actionCount, len(push.RunningRules), len(push.RuleLatencyProbes))
		}
		return
	}
	scheduler.running = true
	scheduler.mu.Unlock()
	if shouldLogAgentReport("desired-state-push-queued", agentHeartbeatSummaryLogInterval) {
		actionCount := 0
		if push.DesiredState != nil {
			actionCount = len(push.DesiredState.Actions)
		}
		logf("desired state push accepted actions=%d runningRules=%d latencyProbes=%d", actionCount, len(push.RunningRules), len(push.RuleLatencyProbes))
	}
	go scheduler.run(job)
}

func (scheduler *desiredStatePushScheduler) run(job desiredStatePushJob) {
	for {
		startedAt := time.Now()
		scheduler.process(job.cfg, job.push)
		scheduler.mu.Lock()
		hasPending := scheduler.pending != nil
		scheduler.mu.Unlock()
		if shouldLogAgentReport("desired-state-push-processed", agentHeartbeatSummaryLogInterval) {
			actionCount := 0
			if job.push.DesiredState != nil {
				actionCount = len(job.push.DesiredState.Actions)
			}
			logf("desired state push processed actions=%d duration=%s pending=%v", actionCount, time.Since(startedAt).Round(time.Millisecond), hasPending)
		}
		scheduler.mu.Lock()
		if scheduler.pending == nil {
			scheduler.running = false
			scheduler.mu.Unlock()
			return
		}
		job = *scheduler.pending
		scheduler.pending = nil
		scheduler.mu.Unlock()
	}
}

var agentDesiredStatePushes = newDesiredStatePushScheduler(handleAgentDesiredStatePush)

func prepareAgentEventStreamRetry(cfg Config, err error) bool {
	if agentRequestResponseAuthenticated(err) {
		return false
	}
	attempt, hasAttempt := agentRequestAttemptFromError(err)
	if agentRequestAuthRejected(err) && hasAttempt && attempt.auth.version == "v2" {
		return true
	}
	if !isClockSyncCandidateError(err) {
		return false
	}
	if hasAttempt {
		if attempt.auth.version == "v2" {
			return false
		}
		if !attempt.auth.challengeKnownAtStart && agentAuthChallengeV2Known(currentPanelURL(cfg)) {
			return true
		}
	}
	return false
}

func agentEventStream(cfg Config) {
	delay := agentEventStreamReconnectMinDelay
	for {
		startedAt := time.Now()
		if err := runAgentEventStream(cfg); err != nil {
			logAgentCommError("event-stream", err)
			challengeAuthKnown := prepareAgentEventStreamRetry(cfg, err)
			if challengeAuthKnown {
				delay = agentEventStreamReconnectMinDelay
			}
			// full jitter：面板重启后所有 Agent 的 SSE 同时断开，固定退避会让它们同一时刻重连。
			time.Sleep(fullJitterDelay(delay, agentEventStreamReconnectJitterFloor))
			if challengeAuthKnown {
				continue
			}
			if time.Since(startedAt) >= agentEventStreamStableResetInterval {
				delay = agentEventStreamReconnectMinDelay
			} else {
				delay *= 2
				if delay > agentEventStreamReconnectMaxDelay {
					delay = agentEventStreamReconnectMaxDelay
				}
			}
			continue
		}
		delay = agentEventStreamReconnectMinDelay
	}
}

func runAgentEventStream(cfg Config) error {
	env, err := encrypt(map[string]any{"agentVersion": Version, "fxpVersion": reportedFXPVersion()}, cfg.Token)
	if err != nil {
		return err
	}
	query, _ := json.Marshal(env)
	panelURL := currentPanelURL(cfg)
	req, err := http.NewRequest("GET", panelURL+"/api/stream?e="+url.QueryEscape(string(query)), nil)
	if err != nil {
		return err
	}
	auth, err := newAgentRequestAuthWithBodies(
		req.Context(), agentEventHTTPClient, panelURL, cfg.Token, req.Method, req.URL.Path, nil, query,
	)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Cache-Control", "no-cache")
	req.Header.Set("Authorization", "Bearer "+auth.proof)

	resp, err := agentEventHTTPClient.Do(req)
	if err != nil {
		return wrapAgentRequestAttemptError(err, auth, "", false)
	}
	defer resp.Body.Close()
	observeAgentAuthCapability(panelURL, resp.Header.Get(agentAuthCapabilityHeader))
	streamClockOffset, hasStreamClockOffset := parseEncryptedResponseClockOffsetAt(
		resp.Header.Get(encryptedResponseClockHeader),
		time.Now(),
	)
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		authResult := resp.Header.Get(agentAuthResultHeader)
		responseAuthenticated := strings.EqualFold(strings.TrimSpace(authResult), agentAuthResultAccepted)
		if auth.version == "v2" && !responseAuthenticated && strings.EqualFold(strings.TrimSpace(authResult), agentAuthResultRejected) {
			invalidateAgentAuthChallenges(panelURL, auth.challengeGeneration)
		}
		return wrapAgentRequestAttemptError(
			fmt.Errorf("event stream status: %s: %s", resp.Status, strings.TrimSpace(string(body))),
			auth,
			authResult,
			responseAuthenticated,
		)
	}
	agentEventStreamConnected.Store(true)
	if shouldLogAgentReport("event-stream-connected", agentHeartbeatSummaryLogInterval) {
		logf("event stream connected")
	}
	recordPanelMigrationStreamConnection(true)
	defer func() {
		agentEventStreamConnected.Store(false)
		recordPanelMigrationStreamConnection(false)
	}()
	// A reconnect may have happened after a self-test was queued while the
	// stream was unavailable. Reconcile once so SSE-connected Agents do not
	// wait for the fallback self-test poller.
	// 随机推迟 0~10 秒再唤醒，把面板重启后的集中重连摊开。
	time.AfterFunc(randomDelayUpTo(agentEventStreamReconnectHeartbeatMaxDelay), func() {
		wakeHeartbeatFromSSE(true)
	})

	scanner := newAgentEventStreamScanner(resp.Body)
	var inactivityExpired atomic.Bool
	inactivityTimer := time.AfterFunc(agentEventStreamInactivityTimeout, func() {
		inactivityExpired.Store(true)
		_ = resp.Body.Close()
	})
	defer inactivityTimer.Stop()
	var data strings.Builder
	for scanner.Scan() {
		inactivityTimer.Reset(agentEventStreamInactivityTimeout)
		line := scanner.Text()
		if line == "" {
			if data.Len() > 0 {
				var msg agentEventMessage
				serverTimeHeader := ""
				if hasStreamClockOffset && !hasEncryptedResponseClock(panelURL) {
					serverTimeHeader = encryptedResponseClockHeaderAt(streamClockOffset, time.Now())
				}
				if err := decodeEventDataForPanel(data.String(), cfg.Token, panelURL, serverTimeHeader, &msg); err != nil {
					logf("decode agent upgrade event: %v", err)
				} else if msg.Type == "agent-upgrade" {
					var up agentUpgrade
					if err := json.Unmarshal(msg.Data, &up); err != nil {
						logf("decode agent upgrade payload: %v", err)
					} else if handleLegacyPanelMigrationUpgrade(cfg, &up) {
						return io.EOF
					} else {
						if shouldLogAgentReport("event-stream-upgrade", agentReportLogInterval) {
							logf("event stream upgrade requested target=%s release=%s", compactLogField(up.TargetVersion, 128), compactLogField(up.ReleaseVersion, 128))
						}
						go selfUpgrade(cfg, &up)
					}
				} else if msg.Type == "agent-refresh" {
					var refresh agentRefreshEvent
					if err := json.Unmarshal(msg.Data, &refresh); err != nil {
						logf("decode agent-refresh payload: %v", err)
					} else if refresh.ForceMimicCheck {
						invalidateMimicEnvironmentCache()
						logf("mimic environment cache invalidated reason=%s", compactLogField(refresh.Reason, 160))
					}
					if (refresh.Urgent || refresh.ForceMimicCheck) && shouldLogAgentReport("event-stream-refresh-urgent", agentReportLogInterval) {
						logf("event stream refresh received urgent=%v forceMimicCheck=%v reason=%s", refresh.Urgent, refresh.ForceMimicCheck, compactLogField(refresh.Reason, 160))
					}
					wakeHeartbeatFromSSE(refresh.Urgent)
				} else if msg.Type == "agent-desired-state" {
					var push agentDesiredStatePush
					if err := json.Unmarshal(msg.Data, &push); err != nil {
						logf("decode agent-desired-state payload: %v", err)
					} else {
						if shouldLogAgentReport("event-stream-desired-state", agentHeartbeatSummaryLogInterval) {
							actionCount := 0
							revision := int64(0)
							if push.DesiredState != nil {
								actionCount = len(push.DesiredState.Actions)
								revision = push.DesiredState.ConfigRevision
							}
							logf("event stream desired state received revision=%d actions=%d runningRules=%d latencyProbes=%d", revision, actionCount, len(push.RunningRules), len(push.RuleLatencyProbes))
						}
						agentDesiredStatePushes.schedule(cfg, push)
					}
				} else if msg.Type == "agent-panel-migration" {
					var directive panelMigrationDirective
					if err := json.Unmarshal(msg.Data, &directive); err != nil {
						logf("decode agent-panel-migration payload: %v", err)
					} else if handlePanelMigrationDirective(cfg, &directive) {
						return io.EOF
					}
				} else if msg.Type == "agent-live-metrics" {
					var request liveMetricsRequest
					if err := json.Unmarshal(msg.Data, &request); err != nil {
						logf("decode agent-live-metrics payload: %v", err)
					} else {
						agentLiveMetrics.start(cfg, request.IntervalMs)
					}
				} else if msg.Type == "agent-ext" {
					wakeAgentExt()
				} else if msg.Type == "agent-support-bundle" {
					var request supportBundleRequest
					if err := json.Unmarshal(msg.Data, &request); err != nil {
						logf("decode agent-support-bundle payload: %v", err)
					} else {
						accepted := agentSupportBundles.schedule(cfg, request)
						interval := agentHeartbeatSummaryLogInterval
						if !accepted {
							interval = agentReportLogInterval
						}
						if shouldLogAgentReport("event-stream-support-bundle", interval) {
							logf("event stream support bundle received task=%s accepted=%v", compactLogField(request.TaskID, 128), accepted)
						}
					}
				}
			}
			data.Reset()
			continue
		}
		if strings.HasPrefix(line, "data:") {
			if data.Len() > 0 {
				data.WriteByte('\n')
			}
			data.WriteString(strings.TrimSpace(strings.TrimPrefix(line, "data:")))
		}
	}
	if inactivityExpired.Load() {
		return fmt.Errorf("event stream inactive for %s", agentEventStreamInactivityTimeout)
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	return io.EOF
}

func newAgentEventStreamScanner(r io.Reader) *bufio.Scanner {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 64*1024), agentEventStreamMaxTokenBytes)
	return scanner
}

func decodeEventDataForPanel(raw string, token string, panelURL string, serverTimeHeader string, out any) error {
	var env envelope
	if err := json.Unmarshal([]byte(raw), &env); err != nil {
		return err
	}
	plain, err := decryptForPanel(env, token, panelURL, serverTimeHeader)
	if err != nil {
		return err
	}
	return json.Unmarshal(plain, out)
}

// handleAgentDesiredStatePush 处理服务端通过 SSE 推送的 desiredState，
// 立即执行 desired state 对账，无需等待下一个心跳周期。
// 与心跳路径的 syncDesiredState 共享同一幂等性机制（签名 + desired_state_records.json），
// 因此即使心跳和 SSE 推送同时触发也不会重复执行。
func handleAgentDesiredStatePush(cfg Config, push agentDesiredStatePush) {
	if push.DesiredState == nil && len(push.RunningRules) == 0 && len(push.RuleLatencyProbes) == 0 && len(push.StateSignatures) == 0 {
		return
	}
	// 先应用 running rules，stale-remove 保护依赖这份数据。
	if len(push.RunningRules) > 0 || len(push.RuleLatencyProbes) > 0 || len(push.StateSignatures) > 0 {
		partial := heartbeatResp{
			RunningRules:      push.RunningRules,
			RuleLatencyProbes: push.RuleLatencyProbes,
			StateSignatures:   push.StateSignatures,
		}
		state := applyHeartbeatState(partial)
		rememberDesiredRunningRules(state.RunningRules)
	}
	if push.DesiredState == nil {
		return
	}
	done := syncDesiredState(cfg, push.DesiredState)
	// desired state 里可能夹带 apply 动作，这些动作执行完才能准确上报端口 ready，
	// 这里不阻塞等待，让 worker pool 自行处理；后续心跳会确认最终状态。
	_ = done
	// 通知下一次心跳重新采集本地状态（可能由于 worker 还未完成所以暂缓），
	// 同时失效 readiness 缓存，让采集结果反映最新运行时状态。
	requestLocalRuntimeStateUpload()
}
