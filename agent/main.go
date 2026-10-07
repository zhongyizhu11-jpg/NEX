package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"hash/fnv"
	"io"
	mathrand "math/rand"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"golang.org/x/time/rate"
)

var Version = "2.2.214"
var agentProcessStartedAt = time.Now()
var agentBootID = readAgentBootID()
var runtimeAgentToken atomic.Value
var encryptedResponseReplayMu sync.Mutex
var encryptedResponseReplay = make(map[string]time.Time)
var encryptedResponseClockMu sync.RWMutex
var encryptedResponseClock = make(map[string]time.Duration)

const selfUpgradeLockTimeout = 10 * time.Minute
const encryptedResponseReplayWindow = 5 * time.Minute
const encryptedResponseReplayCacheLimit = 4096
const encryptedResponseClockMaxOffset = 24 * time.Hour
const encryptedResponseClockHeader = "X-ForwardX-Panel-Time"
const iperf3IdleTimeout = 3 * time.Minute
const selfTestIdlePollInterval = 60 * time.Second
const selfTestActivePollInterval = 2 * time.Second
const selfTestActiveWindow = 2 * time.Minute
const publicIPRefreshInterval = time.Minute
const heartbeatStaticReportInterval = 10 * time.Minute
const trafficCollectInterval = 3 * time.Second
const trafficCollectMaxInterval = 30 * time.Second
const countingChainRepairInitialDelay = 2 * time.Second
const countingChainRepairPace = 100 * time.Millisecond
const runtimeActionRefreshInterval = 30 * time.Minute
const agentLogRetention = 72 * time.Hour
const agentLogMaxBytes int64 = 8 * 1024 * 1024
const agentLogTailBytes int64 = 4 * 1024 * 1024
const agentLogMinimumTailBytes int64 = 256 * 1024
const agentLogDirectoryMaxBytes int64 = 64 * 1024 * 1024
const agentLogDirectoryTargetBytes int64 = 48 * 1024 * 1024
const agentLogSizeCheckInterval = 10 * time.Second
const agentLogRetentionCheckInterval = time.Hour
const agentMemoryCacheRetention = 24 * time.Hour
const agentReportLogMaxKeys = 2048
const agentSlowRequestThreshold = 1500 * time.Millisecond
const agentReportLogInterval = 30 * time.Second
const transientAgentCommLogInterval = 5 * time.Minute

// A successful heartbeat is useful when diagnosing a silent Agent, but it
// must not turn the normal heartbeat cadence into a log stream.  Anomalous
// responses use the shorter agentReportLogInterval below.
const agentHeartbeatSummaryLogInterval = 5 * time.Minute
const agentEventStreamReconnectMinDelay = 3 * time.Second
const agentEventStreamReconnectMaxDelay = 30 * time.Second
const agentEventStreamStableResetInterval = 5 * time.Minute

// agentEventStreamReconnectJitterFloor 是 SSE 重连随机等待的下限。
const agentEventStreamReconnectJitterFloor = time.Second

// agentEventStreamReconnectHeartbeatMaxDelay：SSE 连上后补做的那次完整心跳随机推迟 0~10 秒，
// 面板重启后成百上千个 Agent 几乎同时重连，不推迟就会同时来一轮完整对账。
const agentEventStreamReconnectHeartbeatMaxDelay = 10 * time.Second
const agentEventStreamInactivityTimeout = 75 * time.Second
const agentEventStreamMaxTokenBytes = 8 * 1024 * 1024
const actionBacklogKeepaliveInterval = 10 * time.Second
const agentPresenceInterval = 5 * time.Second
const agentPresenceMinInterval = 2 * time.Second
const agentPresenceMaxInterval = 5 * time.Second
const agentFullHeartbeatInterval = 5 * time.Minute
const agentIdleHeartbeatIntervalSeconds = 60
const agentInteractiveHeartbeatMaxIntervalSeconds = 3
const agentHeartbeatRetryMinInterval = 5 * time.Second
const agentHeartbeatRetryMaxInterval = 30 * time.Second
const agentHeartbeatRetryLimit = 4
const agentHeartbeatRetryCooldown = time.Minute
const agentMetricsSchedulerResolution = 5 * time.Second
const agentForwardGroupHealthProbeMaxInterval = 30 * time.Second
const actionQueueCapacity = 4096

// 动作 worker 从基础并发起步，积压时自动扩容到上限。空闲 worker 只阻塞等待队列，
// 不消耗 CPU；状态上报由独立批处理器完成，因此 worker 只负责实际转发动作。
var actionWorkerBaseConcurrency = resolveActionWorkerBaseConcurrency()
var actionWorkerConcurrency = resolveActionWorkerMaxConcurrency()
var actionWorkerStartedCount int64

func resolveActionWorkerBaseConcurrency() int {
	cores := runtime.NumCPU()
	workers := cores * 2
	if workers < 8 {
		workers = 8
	}
	if workers > 16 {
		workers = 16
	}
	return workers
}

func resolveActionWorkerMaxConcurrency() int {
	workers := runtime.NumCPU() * 8
	if workers < 16 {
		workers = 16
	}
	if workers > 64 {
		workers = 64
	}
	if workers < actionWorkerBaseConcurrency {
		workers = actionWorkerBaseConcurrency
	}
	return workers
}

const actionQueueBacklogLogThreshold = 50
const actionQueueSlowWaitThreshold = 3 * time.Second
const actionSlowHandleThreshold = 15 * time.Second
const actionShellTimeout = 90 * time.Second
const actionShellSlowThreshold = 5 * time.Second
const shellInlineMaxBytes = 8 * 1024
const protocolGuardSampleMaxBytes = 512
const protocolGuardTLSMinRecordSize = 64
const protocolGuardSOCKS5MaxMethods = 16
const protocolGuardUDPIdleTimeout = 2 * time.Minute

// Each UDP session owns a socket, goroutine and maximum-size datagram buffer.
// Bound each rule so a source flood cannot reserve hundreds of megabytes before cleanup.
const protocolGuardUDPMaxSessions = 512

// failoverProxyDialTimeout 是线路组调度器拨每条路径的超时。以前是 10 秒：主路径
// 被黑洞时，每个新连接都要干等 10 秒才换下一条。4 秒够 SYN 重传两次（1s、3s），
// 跨境丢包的线路也拨得通；拨不通就换路，和 gost 的 fastFailover（3s）一个量级。
const failoverProxyDialTimeout = 4 * time.Second

// Protocol guard copies use 32 KiB chunks while UDP packets may be almost
// 64 KiB. Keep the bucket burst large enough for either without allowing an
// unbounded one-time burst when a very high rate is configured.
// 上限 4 MiB：突发取速率的 1/10 再截断，1 Gbps 时 1 MiB 只够 8 ms，令牌桶在调度
// 抖动下频繁见底，实际速率明显低于设定值；4 MiB 约 32 ms，高速率下也能跟上。
const protocolGuardRateBurstMin = 64 * 1024
const protocolGuardRateBurstMax = 4 * 1024 * 1024
const protocolGuardRateWaitChunk = 16 * 1024

// Protocol-block notifications are advisory: the local Guard already blocks
// the connection. Keep panel reporting bounded when the panel is unavailable
// or a scanner opens many blocked connections at once.
const protocolBlockReportQueueSize = 32
const protocolBlockReportCooldown = 30 * time.Second
const protocolBlockReportStateMaxKeys = 2048
const agentVerboseEnv = "FORWARDX_AGENT_VERBOSE_LOG"

const agentLogDir = "/var/log/forwardx-agent"
const agentLogPath = agentLogDir + "/agent-go.log"
const defaultConfigPath = "/etc/forwardx/agent/config.json"
const legacyConfigPath = "/etc/forwardx-agent/config.json"
const runtimeServiceName = "forwardx-runtime"
const tunnelRuntimeServiceName = "forwardx-tunnel-runtime"
const nginxServiceName = "forwardx-nginx"
const runtimeConfigPath = "/etc/forwardx/runtime/gost.json"
const tunnelRuntimeConfigPath = "/etc/forwardx/runtime/tunnel-gost.json"
const nginxConfigPath = "/etc/forwardx/nginx/nginx.conf"
const mimicConfigDir = "/etc/mimic"
const legacyGostServiceName = "forwardx-gost"
const legacyTunnelServiceName = "forwardx-tunnels"
const legacyGostConfigPath = "/etc/forwardx-gost/config.json"
const legacyTunnelConfigPath = "/etc/forwardx-tunnels/config.json"
const legacyRuntimeConfigPath = "/etc/forwardx-runtime/config.json"
const legacyTunnelRuntimeConfigPath = "/etc/forwardx-tunnel-runtime/config.json"
const desiredStateRecordPath = "/var/lib/forwardx-agent/desired_state_records.json"
const desiredStateVersionPath = "/var/lib/forwardx-agent/desired_state_agent_version"

var upgradeStarted int32
var upgradeStartedAt int64
var fxpMu sync.Mutex
var fxpServers = map[string]*fxpProcess{}
var fxpControlMu sync.Mutex
var fxpWireGuardRefSequence uint64
var fxpEndpointEventMu sync.Mutex
var fxpEndpointEvents = map[string]fxpEndpointEvent{}
var fxpEndpointLogPattern = regexp.MustCompile(`exit endpoint (unhealthy|recovered) index=[0-9]+ endpoint=([^[:space:]]+)(?: reason=(.*))?`)

type fxpEndpointEvent struct {
	TunnelID   int    `json:"tunnelId"`
	RuleID     int    `json:"ruleId,omitempty"`
	Role       string `json:"role"`
	Endpoint   string `json:"endpoint"`
	Status     string `json:"status"`
	Message    string `json:"message,omitempty"`
	StartedAt  int64  `json:"startedAt,omitempty"`
	OccurredAt int64  `json:"occurredAt"`
}

func recordFXPEndpointLog(spec fxpSpec, message string) {
	for _, line := range strings.Split(message, "\n") {
		match := fxpEndpointLogPattern.FindStringSubmatch(strings.TrimSpace(line))
		if len(match) < 3 {
			continue
		}
		status := strings.TrimSpace(match[1])
		endpoint := strings.TrimSpace(match[2])
		key := fmt.Sprintf("%s:%d:%d:%s", spec.Role, spec.TunnelID, spec.RuleID, endpoint)
		now := time.Now().UnixMilli()
		fxpEndpointEventMu.Lock()
		previous := fxpEndpointEvents[key]
		startedAt := previous.StartedAt
		if status == "unhealthy" && (previous.Status != "unhealthy" || startedAt <= 0) {
			startedAt = now
		}
		eventMessage := ""
		if len(match) > 3 {
			eventMessage = compactLogOutput(match[3])
		}
		fxpEndpointEvents[key] = fxpEndpointEvent{
			TunnelID: spec.TunnelID, RuleID: spec.RuleID, Role: spec.Role, Endpoint: endpoint,
			Status: status, Message: eventMessage, StartedAt: startedAt, OccurredAt: now,
		}
		fxpEndpointEventMu.Unlock()
	}
}

func fxpEndpointEventsSnapshot() []fxpEndpointEvent {
	now := time.Now().Add(-30 * time.Minute).UnixMilli()
	fxpEndpointEventMu.Lock()
	defer fxpEndpointEventMu.Unlock()
	result := make([]fxpEndpointEvent, 0, len(fxpEndpointEvents))
	for key, event := range fxpEndpointEvents {
		if event.OccurredAt < now {
			delete(fxpEndpointEvents, key)
			continue
		}
		result = append(result, event)
	}
	return result
}

/*
主备切换的事件队列。

setActiveLocked 早就把切换写进 Agent 自己的日志了，但那份日志留在机器上 —— 面板
不知道这条规则什么时候切过、为什么切。而主备恰恰是「平时看不出来、出事才知道有没有
用」的东西：切了没人知道，没切更没人知道。

所以把切换和健康翻转攒起来，随心跳带回面板。攒的是**发生过的事**，不是当前状态，
所以用追加队列而不是按键覆盖的映射 —— 一小时里切了三次和切了一次，是完全不同的
两件事。

心跳发失败的话这一批会丢（取快照即出队，和 fxpEndpointEvents 一样）。机器本地的
日志仍然有，所以丢的是「面板上少一条记录」，不是「查不出来」。
*/
const failoverEventQueueMax = 128

var failoverEventMu sync.Mutex
var failoverEventQueue []failoverProxyEvent

type failoverProxyEvent struct {
	RuleID     int `json:"ruleId"`
	SourcePort int `json:"sourcePort"`
	// switch / unhealthy / recovered / prewarm / precheck_failed / unpinned
	Kind       string `json:"kind"`
	FromTarget string `json:"fromTarget,omitempty"`
	ToTarget   string `json:"toTarget"`
	Reason     string `json:"reason,omitempty"`
	// 这条出站最近一次探测的往返耗时（毫秒）；探不通是 0。
	LatencyMs int `json:"latencyMs,omitempty"`
	// 出站在清单里的序号：面板按它对回路径，不用再拿地址去猜。没有是 -1。
	FromIndex int `json:"fromIndex"`
	ToIndex   int `json:"toIndex"`
	// 目标出站当时的评分（routeScore）；没法打分是 -1。
	Score      int   `json:"score"`
	OccurredAt int64 `json:"occurredAt"`
}

func recordFailoverProxyEvent(event failoverProxyEvent) {
	event.OccurredAt = time.Now().UnixMilli()
	failoverEventMu.Lock()
	defer failoverEventMu.Unlock()
	// 队列满了丢最老的：面板更关心刚刚发生了什么，而不是一小时前的第一条。
	if len(failoverEventQueue) >= failoverEventQueueMax {
		failoverEventQueue = failoverEventQueue[len(failoverEventQueue)-failoverEventQueueMax+1:]
	}
	failoverEventQueue = append(failoverEventQueue, event)
}

func failoverProxyEventsSnapshot() []failoverProxyEvent {
	failoverEventMu.Lock()
	defer failoverEventMu.Unlock()
	if len(failoverEventQueue) == 0 {
		return []failoverProxyEvent{}
	}
	drained := failoverEventQueue
	failoverEventQueue = nil
	return drained
}

/*
每台主备代理此刻走的是哪条出站，每次心跳原样报一遍。

切换事件只在「换了」的那一刻报一次，而代理还会不报事件就回到第 0 条：换规格时
（面板上改了主备设置）、Agent 重启之后。只靠事件的话，面板会一直写着最后一次报上
来的那条 —— 机器早就回到主出站了，面板还说「走 备用 1」。赶上心跳请求失败，那一批
事件也就永远丢了。所以把「现在」本身报上去，面板拿它当准，事件只当记录。

只报主备（fallback）：轮询、随机、哈希本来就没有「现在走哪条」。
*/
type failoverActiveReport struct {
	RuleID     int    `json:"ruleId"`
	SourcePort int    `json:"sourcePort"`
	Target     string `json:"target"`
	// 从什么时候开始走这条（Unix 毫秒）。
	Since int64 `json:"since"`
}

func failoverActiveSnapshot() []failoverActiveReport {
	// 先把代理拷出来再逐个加读锁，不在持有 failoverMu 的时候去拿代理自己的锁。
	failoverMu.Lock()
	proxies := make([]*failoverProxy, 0, len(failoverProxies))
	for _, proxy := range failoverProxies {
		proxies = append(proxies, proxy)
	}
	failoverMu.Unlock()
	reports := make([]failoverActiveReport, 0, len(proxies))
	for _, proxy := range proxies {
		proxy.mu.RLock()
		if proxy.spec.Strategy == "fallback" && proxy.activeIndex >= 0 && proxy.activeIndex < len(proxy.spec.Targets) && !proxy.activeSince.IsZero() {
			reports = append(reports, failoverActiveReport{
				RuleID:     proxy.ruleID,
				SourcePort: proxy.sourcePort,
				Target:     failoverTargetLabel(proxy.spec.Targets[proxy.activeIndex]),
				Since:      proxy.activeSince.UnixMilli(),
			})
		}
		proxy.mu.RUnlock()
	}
	sort.Slice(reports, func(i, j int) bool {
		if reports[i].RuleID != reports[j].RuleID {
			return reports[i].RuleID < reports[j].RuleID
		}
		return reports[i].SourcePort < reports[j].SourcePort
	})
	return reports
}

func failoverTargetLabel(target failoverTarget) string {
	host := target.TargetIP
	if strings.Contains(host, ":") && !strings.HasPrefix(host, "[") {
		host = "[" + host + "]"
	}
	return host + ":" + strconv.Itoa(target.TargetPort)
}

var protocolGuardMu sync.Mutex
var protocolGuards = map[string]*protocolGuardServer{}
var protocolGuardSyncMu sync.Mutex
var protocolGuardSyncGeneration atomic.Uint64
var protocolGuardSyncWaitMu sync.Mutex
var protocolGuardRateMu sync.Mutex
var protocolGuardRates = map[protocolGuardRateKey]*protocolGuardSharedRateLimiter{}
var failoverControlMu sync.Mutex
var failoverMu sync.Mutex
var failoverProxies = map[string]*failoverProxy{}
var lastTCPingAt time.Time
var tcpingScheduleMu sync.Mutex
var agentMetricsWakeCh = make(chan struct{}, 1)
var agentMetricsForceTCPing atomic.Bool
var agentLogMu sync.Mutex
var agentLogSizePrunedAt time.Time
var agentLogRetentionPrunedAt time.Time
var agentLogMaintenanceOnce sync.Once
var activeConfigPath string
var runtimePanelURL atomic.Value
var actionQueue = make(chan actionJob, actionQueueCapacity)
var actionEpochMu sync.Mutex
var latestActionIssuedAt = map[string]int64{}
var desiredRunningRuleMu sync.Mutex
var desiredRunningRulesByPort = map[string]runningRule{}
var desiredRunningRulesByRulePort = map[string]runningRule{}
var iperf3Mu sync.Mutex
var iperf3Server *iperf3Process
var dnsWatchMu sync.Mutex
var dnsWatchSnapshot = map[string][]string{}
var dnsWatchCandidates = map[string]dnsWatchCandidate{}
var dnsWatchRetiredSnapshots = map[string]dnsWatchRetiredSnapshot{}
var pendingDNSChanges []dnsChangeReport
var publicIPMu sync.Mutex
var publicIPv4Cache string
var publicIPv6Cache string
var publicIPCheckedAt time.Time
var publicIPRefreshRunning bool
var lastTrafficCollectAt time.Time
var nextTrafficCollectInterval = trafficCollectInterval
var trafficCollectMu sync.Mutex
var trafficCollectRunning bool
var cpuUsageMu sync.Mutex
var previousCPUTimes cpuTimes
var previousCPUReady bool
var countingChainMu sync.Mutex
var countingChainSignatures = map[string]string{}
var countingChainCheckedAt = map[string]time.Time{}
var countingChainRepairPending = map[string]bool{}
var countingChainRepairCleanup = map[string]bool{}
var countingChainRepairQueue = make(chan runningRule, actionQueueCapacity)
var countingChainRepairWorkersOnce sync.Once
var runtimeActionMu sync.Mutex
var runtimeActionCache = map[string]runtimeActionState{}
var runtimeProxyLogMu sync.Mutex
var runtimeProxyLogSignatures = map[string]string{}
var dnsWatchHostPattern = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9\-_.]*[A-Za-z0-9])?$`)
var agentReportLogMu sync.Mutex
var agentReportLogAt = map[string]time.Time{}
var agentMemoryPrunedAt time.Time
var actionPendingCount int64
var runtimeActionEpoch atomic.Uint64
var heartbeatWakeCh = make(chan struct{}, 1)
var heartbeatWakeFromSSE atomic.Bool // SSE 唤醒时置 true；主循环读取后清零
var heartbeatUrgentWakeFromSSE atomic.Bool
var heartbeatForceReconcileWake atomic.Bool
var agentEventStreamConnected atomic.Bool
var agentVerboseLogs = isEnvTruthy(os.Getenv(agentVerboseEnv))
var queuedActionMu sync.Mutex
var queuedActionKeys = map[string]int64{}
var protectedActionPortMu sync.Mutex
var protectedActionPorts = map[string]int{}
var compactAgentReports atomic.Bool
var agentPresenceSupported atomic.Bool
var heartbeatStaticReport heartbeatStaticSnapshot
var mimicEnvironmentMu sync.Mutex
var mimicEnvironmentCached mimicEnvironmentReport
var mimicEnvironmentCheckedAt time.Time
var heartbeatStateMu sync.Mutex
var heartbeatStateCache heartbeatStateSnapshot
var heartbeatStateSignatures = map[string]string{}
var localRuntimeStateMu sync.Mutex
var lastLocalRuntimeStateSignature string
var forceSendLocalRuntimeState = true

// readLocalRuntimeReadiness 的跨心跳缓存。
// TTL 5s：正常心跳间隔 30s，对数据新鲜度无影响；
// 在 SSE 唤醒风暴（churn）期间可消除重复的 ss/systemctl 调用。
const localRuntimeReadinessCacheTTL = 5 * time.Second

var localRuntimeReadinessCacheMu sync.Mutex
var localRuntimeReadinessCacheResult *localRuntimeReadiness
var localRuntimeReadinessCachedAt time.Time
var localRuntimeReadinessCacheInvalid bool

// Closing and replacing this channel broadcasts readiness invalidation to every
// waiter. A buffered single-value channel only wakes one worker and leaves the
// rest waiting for the polling interval.
var managedRuntimeListenReadyMu sync.Mutex
var managedRuntimeListenReadyCh = make(chan struct{})

func managedRuntimeListenReadySignal() <-chan struct{} {
	managedRuntimeListenReadyMu.Lock()
	defer managedRuntimeListenReadyMu.Unlock()
	return managedRuntimeListenReadyCh
}

func broadcastManagedRuntimeListenReady() {
	managedRuntimeListenReadyMu.Lock()
	close(managedRuntimeListenReadyCh)
	managedRuntimeListenReadyCh = make(chan struct{})
	managedRuntimeListenReadyMu.Unlock()
}

type actionJob struct {
	cfg                      Config
	action                   action
	previousRuntime          localActionRuntimeSnapshot
	done                     chan struct{}
	result                   *actionJobResult
	resultOK                 bool
	resultReady              bool
	dependentResultOK        bool
	dependentResultReady     bool
	handoffFinalizedByResult bool
	desiredKey               string
	desiredSignature         string
	enqueuedAt               time.Time
	protectedPort            string
	prerequisites            []<-chan struct{}
	resultPrereqs            []*actionJobResult
	dependentResults         []*actionJobResult
}

type localActionRuntimeSnapshot struct {
	valid        bool
	tunnel       bool
	ruleID       int
	tunnelID     int
	forwardType  string
	protocol     string
	hasProtocol  bool
	handoffState *actionHandoffState
}

type actionHandoffState struct {
	mu                      sync.Mutex
	once                    sync.Once
	commit                  func()
	rollback                func()
	batch                   *actionHandoffBatch
	stoppedSharedServices   []string
	stoppedSharedServiceSet map[string]bool
}

type actionHandoffBatch struct {
	mu              sync.Mutex
	finalizerOnce   sync.Once
	participants    int
	resolved        int
	failed          bool
	cancelled       bool
	cfg             Config
	originals       map[string]fxpSpec
	selectors       []fxpRuntimeSelector
	selectorKeys    map[string]bool
	guardActions    []action
	finalizeForTest func(bool, Config, []fxpSpec, []fxpRuntimeSelector)
}

func newActionHandoffBatch() *actionHandoffBatch {
	return &actionHandoffBatch{
		originals:    map[string]fxpSpec{},
		selectorKeys: map[string]bool{},
	}
}

func (batch *actionHandoffBatch) addParticipant(guards ...action) {
	if batch == nil {
		return
	}
	batch.mu.Lock()
	batch.participants++
	batch.guardActions = append(batch.guardActions, guards...)
	batch.mu.Unlock()
}

func fxpHandoffSelectorKey(selector fxpRuntimeSelector) string {
	return fmt.Sprintf("%s:%d:%d:%d:%s", strings.TrimSpace(selector.role), selector.tunnelID, selector.ruleID, selector.listenPort, normalizeRuntimeProtocol(selector.protocol))
}

func (batch *actionHandoffBatch) registerSelector(selector fxpRuntimeSelector) {
	if batch == nil || !selector.valid() {
		return
	}
	batch.mu.Lock()
	defer batch.mu.Unlock()
	batch.registerSelectorLocked(selector)
}

func (batch *actionHandoffBatch) registerSelectorLocked(selector fxpRuntimeSelector) {
	selectorKey := fxpHandoffSelectorKey(selector)
	if batch.selectorKeys[selectorKey] {
		return
	}
	batch.selectorKeys[selectorKey] = true
	batch.selectors = append(batch.selectors, selector)
}

func (batch *actionHandoffBatch) prepareFXPTransition(cfg Config, originals []fxpSpec, selector fxpRuntimeSelector) bool {
	if batch == nil {
		return false
	}
	batch.mu.Lock()
	defer batch.mu.Unlock()
	batch.cfg = cfg
	batch.registerSelectorLocked(selector)
	for _, original := range originals {
		original = normalizeFXPSpec(original)
		id := fxpServerID(original)
		if _, exists := batch.originals[id]; exists {
			continue
		}
		if err := persistFXPSpec(original); err != nil {
			logf("fxp handoff batch recovery snapshot write failed runtime=%s: %v", id, err)
			return false
		}
		batch.originals[id] = original
	}
	return true
}

func (batch *actionHandoffBatch) resolve(ok bool) {
	if batch == nil {
		return
	}
	batch.mu.Lock()
	if batch.resolved >= batch.participants {
		batch.mu.Unlock()
		return
	}
	batch.resolved++
	if !ok {
		batch.failed = true
	}
	ready := batch.participants > 0 && batch.resolved == batch.participants
	failed := batch.failed
	cfg := batch.cfg
	originals := make([]fxpSpec, 0, len(batch.originals))
	for _, original := range batch.originals {
		originals = append(originals, original)
	}
	sort.Slice(originals, func(i, j int) bool {
		return fxpServerID(originals[i]) < fxpServerID(originals[j])
	})
	selectors := append([]fxpRuntimeSelector(nil), batch.selectors...)
	guardActions := append([]action(nil), batch.guardActions...)
	finalizeForTest := batch.finalizeForTest
	batch.mu.Unlock()
	if !ready {
		return
	}
	batch.finalizerOnce.Do(func() {
		unlock := acquireActionSerialLocks(actionSerialKeysForActions(guardActions))
		if unlock != nil {
			defer unlock()
		}
		for _, guard := range guardActions {
			if !isOlderAction(guard, false) {
				continue
			}
			batch.mu.Lock()
			batch.cancelled = true
			batch.mu.Unlock()
			logf("fxp handoff batch finalization cancelled by newer desired state %s", actionLogSummary(guard))
			return
		}
		if finalizeForTest != nil {
			finalizeForTest(!failed, cfg, originals, selectors)
			return
		}
		if !failed {
			commitFXPHandoffBatchPersistence(originals, selectors)
			return
		}
		fxpControlMu.Lock()
		defer fxpControlMu.Unlock()
		restoreFXPHandoffOriginalsLocked(cfg, originals)
	})
}

func (state *actionHandoffState) attachBatch(batch *actionHandoffBatch) {
	if state == nil || batch == nil {
		return
	}
	state.mu.Lock()
	state.batch = batch
	state.mu.Unlock()
}

func (state *actionHandoffState) handoffBatch() *actionHandoffBatch {
	if state == nil {
		return nil
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	return state.batch
}

func (state *actionHandoffState) setFinalizers(commit, rollback func()) {
	if state == nil {
		return
	}
	state.mu.Lock()
	state.commit = commit
	state.rollback = rollback
	state.mu.Unlock()
}

func (state *actionHandoffState) managesFXPPersistence() bool {
	if state == nil {
		return false
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	return state.batch != nil || state.commit != nil || state.rollback != nil
}

func (state *actionHandoffState) registerStoppedSharedService(name string) bool {
	if state == nil {
		return false
	}
	name = sanitizeServiceName(name)
	if name == "" {
		return false
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.stoppedSharedServiceSet == nil {
		state.stoppedSharedServiceSet = map[string]bool{}
	}
	if state.stoppedSharedServiceSet[name] {
		return false
	}
	state.stoppedSharedServiceSet[name] = true
	state.stoppedSharedServices = append(state.stoppedSharedServices, name)
	return true
}

func (state *actionHandoffState) runCommit() {
	if state == nil {
		return
	}
	state.mu.Lock()
	commit := state.commit
	batch := state.batch
	state.mu.Unlock()
	state.once.Do(func() {
		if batch != nil {
			batch.resolve(true)
			return
		}
		if commit != nil {
			commit()
		}
	})
}

func (state *actionHandoffState) finish() {
	if state == nil {
		return
	}
	state.mu.Lock()
	batch := state.batch
	state.mu.Unlock()
	state.once.Do(func() {
		if batch != nil {
			batch.resolve(true)
		}
	})
}

func (state *actionHandoffState) cancel() {
	if state == nil {
		return
	}
	state.once.Do(func() {})
}

func (state *actionHandoffState) runRollback() {
	if state == nil {
		return
	}
	state.mu.Lock()
	rollback := state.rollback
	batch := state.batch
	stoppedSharedServices := append([]string(nil), state.stoppedSharedServices...)
	state.mu.Unlock()
	state.once.Do(func() {
		if batch != nil {
			batch.resolve(false)
		} else if rollback != nil {
			rollback()
		}
		for _, service := range stoppedSharedServices {
			restartManagedServiceProcessForHandoff(service)
		}
		if len(stoppedSharedServices) > 0 {
			invalidateLocalRuntimeReadinessCache()
			requestLocalRuntimeStateUpload()
		}
	})
}

type actionJobResult struct {
	done            chan struct{}
	once            sync.Once
	ok              atomic.Bool
	finalizerMu     sync.Mutex
	finalizerOnce   sync.Once
	dependentCount  int
	dependentFailed bool
	commitFn        func()
	rollbackFn      func()
}

func newActionJobResult() *actionJobResult {
	return &actionJobResult{done: make(chan struct{})}
}

func (result *actionJobResult) complete(ok bool) {
	if result == nil {
		return
	}
	result.once.Do(func() {
		result.ok.Store(ok)
		close(result.done)
	})
}

func (result *actionJobResult) wait() bool {
	if result == nil {
		return true
	}
	<-result.done
	return result.ok.Load()
}

func (result *actionJobResult) setFinalizers(commit, rollback func()) {
	if result == nil {
		return
	}
	result.finalizerMu.Lock()
	result.commitFn = commit
	result.rollbackFn = rollback
	result.finalizerMu.Unlock()
}

func (result *actionJobResult) addDependent() {
	if result == nil {
		return
	}
	result.finalizerMu.Lock()
	result.dependentCount++
	result.finalizerMu.Unlock()
}

func (result *actionJobResult) hasDependents() bool {
	if result == nil {
		return false
	}
	result.finalizerMu.Lock()
	defer result.finalizerMu.Unlock()
	return result.dependentCount > 0
}

func (result *actionJobResult) resolveDependent(ok bool) {
	if result == nil {
		return
	}
	result.finalizerMu.Lock()
	if result.dependentCount <= 0 {
		result.finalizerMu.Unlock()
		return
	}
	if !ok {
		result.dependentFailed = true
	}
	result.dependentCount--
	ready := result.dependentCount == 0
	failed := result.dependentFailed
	commit := result.commitFn
	rollback := result.rollbackFn
	result.finalizerMu.Unlock()
	if !ready {
		return
	}
	result.finalizerOnce.Do(func() {
		if failed {
			if rollback != nil {
				rollback()
			}
			return
		}
		if commit != nil {
			commit()
		}
	})
}

func (result *actionJobResult) rollback() {
	if result == nil {
		return
	}
	result.finalizerMu.Lock()
	rollback := result.rollbackFn
	result.finalizerMu.Unlock()
	result.finalizerOnce.Do(func() {
		if rollback != nil {
			rollback()
		}
	})
}

type heartbeatStaticSnapshot struct {
	PrimaryIP               string
	IPv4                    string
	IPv6                    string
	PrivateIPv4             string
	DefaultNetworkInterface string
	CPUInfo                 string
	MemoryTotal             uint64
	SwapTotal               uint64
	DiskTotal               uint64
	Version                 string
	ReportedAt              time.Time
	Initialized             bool
}

type mimicEnvironmentReport struct {
	Available    bool   `json:"available"`
	CommandReady bool   `json:"commandReady"`
	ModuleReady  bool   `json:"moduleReady"`
	Version      string `json:"version,omitempty"`
	Status       string `json:"status"`
	Message      string `json:"message,omitempty"`
}

type runtimeActionState struct {
	Signature string
	CheckedAt time.Time
	Success   bool
}

type Config struct {
	PanelURL                  string `json:"panelUrl"`
	Token                     string `json:"token"`
	Interval                  int    `json:"interval"`
	MigrationFallbackPanelURL string `json:"migrationFallbackPanelUrl,omitempty"`
	PanelMigrationID          string `json:"panelMigrationId,omitempty"`
	PanelMigrationStartedAt   int64  `json:"panelMigrationStartedAt,omitempty"`
}

type envelope struct {
	V   int    `json:"v"`
	IV  string `json:"iv"`
	CT  string `json:"ct"`
	MAC string `json:"mac"`
	TS  int64  `json:"ts"`
}

type panelErrorResp struct {
	Error   string `json:"error"`
	Message string `json:"message"`
	Hint    string `json:"hint"`
}

type agentHTTPStatusError struct {
	StatusCode int
	Status     string
	Detail     string
}

func (e agentHTTPStatusError) Error() string {
	if strings.TrimSpace(e.Detail) == "" {
		return e.Status
	}
	return e.Status + ": " + e.Detail
}

type heartbeatResp struct {
	Actions                 []action                 `json:"actions"`
	DesiredState            *desiredState            `json:"desiredState,omitempty"`
	SelfTests               []selfTest               `json:"selfTests"`
	RunningRules            []runningRule            `json:"runningRules"`
	RuleLatencyProbes       []ruleLatencyProbe       `json:"ruleLatencyProbes"`
	TunnelProbes            []tunnelProbe            `json:"tunnelProbes"`
	ForwardGroupProbes      []forwardGroupProbe      `json:"forwardGroupProbes"`
	HostProbeServices       []hostProbeServiceProbe  `json:"hostProbeServices"`
	GuardRules              []guardRule              `json:"guardRules"`
	DNSWatch                []dnsWatchItem           `json:"dnsWatch"`
	LookingGlassTests       []lookingGlassTask       `json:"lookingGlassTests"`
	Iperf3Tasks             []iperf3Task             `json:"iperf3Tasks"`
	PluginTasks             []pluginAgentTask        `json:"pluginTasks"`
	AgentUpgrade            *agentUpgrade            `json:"agentUpgrade"`
	StateSignatures         map[string]string        `json:"stateSignatures,omitempty"`
	RequestLocalState       bool                     `json:"requestLocalState,omitempty"`
	PanelURL                string                   `json:"panelUrl"`
	ForceTCPing             bool                     `json:"forceTcping"`
	NextInterval            int                      `json:"nextInterval"`
	CompactReports          bool                     `json:"compactReports"`
	PanelMigration          *panelMigrationDirective `json:"panelMigration,omitempty"`
	Presence                bool                     `json:"presence,omitempty"`
	PresenceSupported       bool                     `json:"presenceSupported,omitempty"`
	ReconciliationCoalesced bool                     `json:"reconciliationCoalesced,omitempty"`
	NextPresenceInterval    int                      `json:"nextPresenceInterval,omitempty"`
	MetricsOnly             bool                     `json:"metricsOnly,omitempty"`
	TrafficReportInterval   int                      `json:"trafficReportInterval,omitempty"`
}

type heartbeatResult struct {
	NextInterval            int
	ReconciliationCoalesced bool
	MetricsOnly             bool
}

type panelMigrationDirective struct {
	ID               string `json:"id"`
	State            string `json:"state"`
	TargetPanelURL   string `json:"targetPanelUrl,omitempty"`
	FallbackPanelURL string `json:"fallbackPanelUrl,omitempty"`
	StartedAt        int64  `json:"startedAt,omitempty"`
}

type heartbeatStateSnapshot struct {
	RunningRules       []runningRule
	RuleLatencyProbes  []ruleLatencyProbe
	TunnelProbes       []tunnelProbe
	ForwardGroupProbes []forwardGroupProbe
	HostProbeServices  []hostProbeServiceProbe
	GuardRules         []guardRule
	DNSWatch           []dnsWatchItem
}

type localRuntimeStatePayload struct {
	Rules    []localRuntimeRuleState    `json:"rules,omitempty"`
	Tunnels  []localRuntimeTunnelState  `json:"tunnels,omitempty"`
	Services []localRuntimeServiceState `json:"services,omitempty"`
}

type localRuntimeRuleState struct {
	Port             int    `json:"port"`
	RuleID           int    `json:"ruleId"`
	TunnelID         int    `json:"tunnelId,omitempty"`
	ForwardType      string `json:"forwardType"`
	TargetIP         string `json:"targetIp,omitempty"`
	TargetPort       int    `json:"targetPort,omitempty"`
	Protocol         string `json:"protocol,omitempty"`
	TransportVersion string `json:"transportVersion,omitempty"`
	Ready            bool   `json:"ready"`
}

type localRuntimeTunnelState struct {
	Port             int    `json:"port"`
	TunnelID         int    `json:"tunnelId"`
	ForwardType      string `json:"forwardType"`
	TransportVersion string `json:"transportVersion,omitempty"`
	Ready            bool   `json:"ready"`
}

type localRuntimeServiceState struct {
	Name            string `json:"name"`
	Active          bool   `json:"active"`
	HasWork         bool   `json:"hasWork"`
	Status          string `json:"status,omitempty"`
	Message         string `json:"message,omitempty"`
	HooksReady      *bool  `json:"hooksReady,omitempty"`
	ConnectionState string `json:"connectionState,omitempty"`
}

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

func (r *localRuntimeReadiness) gostReadyForPort(port int, protocol string) bool {
	if r == nil || port <= 0 {
		return false
	}
	return r.gostMainReadyForPort(port, protocol) || r.gostTunnelReadyForPort(port, protocol)
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

type kernelForwardSnapshot struct {
	nftLoaded               bool
	nftTable                string
	iptablesLoaded          map[string]bool
	iptablesNatRule         map[string]string
	iptablesMangleLoaded    bool
	iptablesForwardxMarkers map[int]bool
}

func newKernelForwardSnapshot() *kernelForwardSnapshot {
	return &kernelForwardSnapshot{
		iptablesLoaded:          map[string]bool{},
		iptablesNatRule:         map[string]string{},
		iptablesForwardxMarkers: map[int]bool{},
	}
}

func actionRequiresKernelForwardConsistency(a action) bool {
	if a.SourcePort <= 0 || strings.TrimSpace(a.StatusType) == "runtime" || strings.TrimSpace(a.StatusType) == "tunnel" {
		return false
	}
	switch strings.TrimSpace(a.ForwardType) {
	case "iptables", "nftables":
		return true
	default:
		return false
	}
}

func (s *kernelForwardSnapshot) desiredActionConsistent(a action) bool {
	if !actionRequiresKernelForwardConsistency(a) {
		return true
	}
	switch strings.TrimSpace(a.Op) {
	case "apply":
		return s.actionApplyReady(a)
	case "remove":
		return s.actionRemoveDone(a)
	default:
		return true
	}
}

func (s *kernelForwardSnapshot) actionApplyReady(a action) bool {
	return s.kernelRuleApplyPresent(a.ForwardType, a.RuleID, a.SourcePort, a.TargetIP, a.TargetPort, a.Protocol)
}

// accessLimitWaitArg 容忍面板在二进制名后面插入的锁等待参数（`$FWX_IPT_WAIT`、`-w`、`-w 5`）。
const accessLimitWaitArg = `(?:\s+(?:\$\{?FWX_IPT_WAIT\}?|-w(?:\s+[0-9]+)?))?`

var accessLimitRejectPattern = regexp.MustCompile(`(?i)(iptables|ip6tables)` + accessLimitWaitArg + ` -A (FWX_LIMIT_[A-Za-z0-9_]+) -p tcp -m connlimit --connlimit-above ([0-9]+) --connlimit-mask ([0-9]+) -j REJECT --reject-with tcp-reset`)
var accessLimitReturnPattern = regexp.MustCompile(`(?i)(iptables|ip6tables)` + accessLimitWaitArg + ` -A (FWX_LIMIT_[A-Za-z0-9_]+) -j RETURN`)
var accessLimitJumpPattern = regexp.MustCompile(`(?i)(iptables|ip6tables)` + accessLimitWaitArg + ` -C (INPUT|FORWARD) -p tcp --dport ([0-9]+) -j (FWX_LIMIT_[A-Za-z0-9_]+)`)
var accessLimitChainPattern = regexp.MustCompile(`\bFWX_LIMIT_[A-Za-z0-9_]+\b`)

type accessLimitRuleExpectation struct {
	binary string
	chain  string
	args   string
}

type accessLimitJumpExpectation struct {
	binary string
	base   string
	port   string
	chain  string
}

const accessLimitMaintenanceInterval = 30 * time.Minute

// accessLimitMaintenanceWaitTimeout 是访问限制维护等待本批动作完成的上限（单条 shell 最长 90 秒）。
const accessLimitMaintenanceWaitTimeout = 10 * time.Minute

var (
	accessLimitMaintenanceMu    sync.Mutex
	accessLimitMaintenanceLast  = map[string]time.Time{}
	accessLimitMaintenanceRunMu sync.Mutex
)

func accessLimitCommands(a action) []string {
	commands := make([]string, 0)
	for _, command := range append(append(append([]string{}, a.PreCommands...), a.Commands...), a.PostCommands...) {
		if strings.Contains(command, "FWX_LIMIT_") {
			commands = append(commands, command)
		}
	}
	return commands
}

func accessLimitActionSerialKeys(a action) []string {
	seen := map[string]bool{}
	keys := make([]string, 0)
	for _, command := range accessLimitCommands(a) {
		for _, chain := range accessLimitChainPattern.FindAllString(command, -1) {
			key := "access-limit:" + chain
			if seen[key] {
				continue
			}
			seen[key] = true
			keys = append(keys, key)
		}
	}
	return keys
}

func hasConfiguredAccessLimits(a action) bool {
	for _, command := range accessLimitCommands(a) {
		if strings.Contains(command, "--connlimit-above") {
			return true
		}
	}
	return false
}

func needsAccessLimitMaintenance(a action) bool {
	return len(accessLimitCommands(a)) > 0
}

func claimAccessLimitMaintenance(a action, now time.Time) bool {
	actionKey := desiredActionKey(a)
	if actionKey == "" {
		return false
	}
	key := actionKey + ":" + desiredActionSignature(a)
	accessLimitMaintenanceMu.Lock()
	defer accessLimitMaintenanceMu.Unlock()
	if previous := accessLimitMaintenanceLast[key]; !previous.IsZero() && now.Sub(previous) < accessLimitMaintenanceInterval {
		return false
	}
	accessLimitMaintenanceLast[key] = now
	if len(accessLimitMaintenanceLast) > 4096 {
		cutoff := now.Add(-2 * accessLimitMaintenanceInterval)
		for existingKey, checkedAt := range accessLimitMaintenanceLast {
			if checkedAt.Before(cutoff) {
				delete(accessLimitMaintenanceLast, existingKey)
			}
		}
	}
	return true
}

func maintainAccessLimitAction(
	a action,
	now time.Time,
	ready func(action) bool,
	run func([]string) bool,
) (attempted bool, ok bool) {
	unlock, current := acquireCurrentActionSerialLocks(a)
	if !current {
		return false, true
	}
	if unlock != nil {
		defer unlock()
	}
	if !desiredActionRecordIsCurrent(a) || !claimAccessLimitMaintenance(a, now) || ready(a) {
		return false, true
	}
	commands := accessLimitCommands(a)
	runOK := run(commands)
	return true, runOK && ready(a)
}

func scheduleAccessLimitMaintenance(actions []action, completed []<-chan struct{}) {
	candidates := make([]action, 0)
	for _, a := range actions {
		if strings.TrimSpace(a.Op) == "apply" && needsAccessLimitMaintenance(a) {
			candidates = append(candidates, a)
		}
	}
	if len(candidates) == 0 {
		return
	}
	waits := append([]<-chan struct{}(nil), completed...)
	go func() {
		// 等本批动作跑完再做维护；某个动作卡死（done 永远不关）时以前这个协程会永久泄漏，
		// 现在最多等 accessLimitMaintenanceWaitTimeout，超时就放弃这一轮（下一批动作会再安排）。
		deadline := time.NewTimer(accessLimitMaintenanceWaitTimeout)
		defer deadline.Stop()
		for _, done := range waits {
			if done == nil {
				continue
			}
			select {
			case <-done:
			case <-deadline.C:
				if shouldLogAgentReport("access-limit-maintenance-wait-timeout", accessLimitMaintenanceInterval) {
					logf("optional access limit maintenance skipped: actions still running after %s", accessLimitMaintenanceWaitTimeout)
				}
				return
			}
		}
		accessLimitMaintenanceRunMu.Lock()
		defer accessLimitMaintenanceRunMu.Unlock()
		for _, a := range candidates {
			commands := accessLimitCommands(a)
			attempted, ok := maintainAccessLimitAction(a, time.Now(), accessLimitActionReady, runShellBatch)
			if attempted && !ok && shouldLogAgentReport("access-limit-maintenance:"+desiredActionKey(a), accessLimitMaintenanceInterval) {
				logf("optional access limit maintenance incomplete rule=%d tunnel=%d port=%d commands=%d; forwarding runtime remains active", a.RuleID, a.TunnelID, a.SourcePort, len(commands))
			}
		}
	}()
}

// accessLimitActionReady verifies only the auxiliary FWX_LIMIT rules emitted
// by the panel. It intentionally uses -C checks and never flushes or rewrites
// a chain, so existing iptables counters remain intact during recovery.
func accessLimitActionReady(a action) bool {
	commands := strings.Join(append(append(append([]string{}, a.PreCommands...), a.Commands...), a.PostCommands...), "\n")
	if !strings.Contains(commands, "FWX_LIMIT_") {
		return true
	}

	ruleExpectations := map[string]accessLimitRuleExpectation{}
	for _, match := range accessLimitRejectPattern.FindAllStringSubmatch(commands, -1) {
		if len(match) != 5 {
			continue
		}
		expectation := accessLimitRuleExpectation{
			binary: match[1],
			chain:  match[2],
			args:   fmt.Sprintf("-p tcp -m connlimit --connlimit-above %s --connlimit-mask %s -j REJECT --reject-with tcp-reset", match[3], match[4]),
		}
		key := expectation.binary + "|" + expectation.chain + "|" + expectation.args
		ruleExpectations[key] = expectation
	}
	for _, match := range accessLimitReturnPattern.FindAllStringSubmatch(commands, -1) {
		if len(match) != 3 {
			continue
		}
		expectation := accessLimitRuleExpectation{binary: match[1], chain: match[2], args: "-j RETURN"}
		key := expectation.binary + "|" + expectation.chain + "|" + expectation.args
		ruleExpectations[key] = expectation
	}

	jumps := map[string]accessLimitJumpExpectation{}
	for _, match := range accessLimitJumpPattern.FindAllStringSubmatch(commands, -1) {
		if len(match) != 5 {
			continue
		}
		expectation := accessLimitJumpExpectation{binary: match[1], base: match[2], port: match[3], chain: match[4]}
		key := expectation.binary + "|" + expectation.base + "|" + expectation.port + "|" + expectation.chain
		jumps[key] = expectation
	}

	// A cleanup-only action has no expected chain rules and must leave all
	// matching jumps absent. Apply actions, in contrast, expect every emitted
	// reject/RETURN rule and jump to be present.
	for _, expectation := range ruleExpectations {
		if !commandExists(expectation.binary) {
			continue
		}
		if !runIptablesShellQuiet(iptablesAgentBin(expectation.binary) + " -C " + expectation.chain + " " + expectation.args + " 2>/dev/null") {
			return false
		}
	}
	for _, expectation := range jumps {
		if !commandExists(expectation.binary) {
			continue
		}
		command := iptablesAgentBin(expectation.binary) + " -C " + expectation.base + " -p tcp --dport " + expectation.port + " -j " + expectation.chain + " 2>/dev/null"
		hasJump := runIptablesShellQuiet(command)
		if len(ruleExpectations) > 0 {
			if !hasJump {
				return false
			}
		} else if hasJump {
			return false
		}
	}
	return true
}

func (s *kernelForwardSnapshot) actionRemoveDone(a action) bool {
	return !s.kernelRuleResiduePresent(a.ForwardType, a.RuleID, a.SourcePort, a.Protocol)
}

func (s *kernelForwardSnapshot) localRuleStateReady(state localRuleState) bool {
	return s.kernelRuleApplyPresent(state.ForwardType, state.RuleID, atoi(state.Port), state.TargetIP, state.TargetPort, state.Protocol)
}

func readLocalRuntimeRuleStates() []localRuleState {
	states := readLocalRuleStates()
	return appendKernelForwardResidueStates(states)
}

type kernelForwardResidueState struct {
	state localRuleState
	tcp   bool
	udp   bool
}

func appendKernelForwardResidueStates(states []localRuleState) []localRuleState {
	existingPorts := map[string]bool{}
	for _, state := range states {
		if strings.TrimSpace(state.Port) != "" {
			existingPorts[state.Port] = true
		}
	}
	residue := newKernelForwardSnapshot().localResidueStates(existingPorts)
	if len(residue) == 0 {
		return states
	}
	return append(states, residue...)
}

func (s *kernelForwardSnapshot) localResidueStates(existingPorts map[string]bool) []localRuleState {
	byPort := map[string]*kernelForwardResidueState{}
	add := func(forwardType string, ruleID int, port int, proto string, targetIP string, targetPort int) {
		if port <= 0 {
			return
		}
		portText := strconv.Itoa(port)
		if existingPorts != nil && existingPorts[portText] {
			return
		}
		item := byPort[portText]
		if item == nil {
			item = &kernelForwardResidueState{
				state: localRuleState{
					Port:        portText,
					RuleID:      ruleID,
					ForwardType: forwardType,
					TargetIP:    targetIP,
					TargetPort:  targetPort,
				},
			}
			byPort[portText] = item
		}
		if item.state.RuleID <= 0 && ruleID > 0 {
			item.state.RuleID = ruleID
		}
		if item.state.TargetIP == "" && targetIP != "" {
			item.state.TargetIP = targetIP
		}
		if item.state.TargetPort <= 0 && targetPort > 0 {
			item.state.TargetPort = targetPort
		}
		switch proto {
		case "udp":
			item.udp = true
		default:
			item.tcp = true
		}
	}
	for _, rawLine := range strings.Split(s.nftTableText(), "\n") {
		line := kernelNormalizeLine(rawLine)
		if line == "" || !strings.Contains(line, "dnat") {
			continue
		}
		proto, port, ok := kernelLineDport(line)
		if !ok {
			continue
		}
		ruleID := kernelLineRuleID(line)
		targetIP, targetPort, _ := kernelLineDnatTarget(line)
		add("nftables", ruleID, port, proto, targetIP, targetPort)
	}
	for _, binary := range iptablesAgentBinaries() {
		for _, rawLine := range strings.Split(s.iptablesNatPreroutingText(binary), "\n") {
			line := kernelNormalizeLine(rawLine)
			if line == "" || !strings.Contains(line, "-j DNAT") {
				continue
			}
			proto, port, ok := kernelLineDport(line)
			if !ok || !s.iptablesForwardxMarkerSeenForPort(port) {
				continue
			}
			targetIP, targetPort, _ := kernelLineDnatTarget(line)
			add("iptables", 0, port, proto, targetIP, targetPort)
		}
	}
	if len(byPort) == 0 {
		return nil
	}
	ports := make([]string, 0, len(byPort))
	for port := range byPort {
		ports = append(ports, port)
	}
	sort.Slice(ports, func(i, j int) bool { return atoi(ports[i]) < atoi(ports[j]) })
	out := make([]localRuleState, 0, len(ports))
	for _, port := range ports {
		item := byPort[port]
		if item.tcp && item.udp {
			item.state.Protocol = "both"
		} else if item.udp {
			item.state.Protocol = "udp"
		} else {
			item.state.Protocol = "tcp"
		}
		out = append(out, item.state)
	}
	return out
}

func (s *kernelForwardSnapshot) kernelRuleApplyPresent(forwardType string, ruleID int, sourcePort int, targetIP string, targetPort int, protocol string) bool {
	if sourcePort <= 0 {
		return false
	}
	switch strings.TrimSpace(forwardType) {
	case "nftables":
		return s.nftForwardRulePresent(ruleID, sourcePort, targetIP, targetPort, protocol)
	case "iptables":
		return s.iptablesForwardRulePresent(sourcePort, targetIP, targetPort, protocol)
	default:
		return true
	}
}

func (s *kernelForwardSnapshot) kernelRuleResiduePresent(forwardType string, ruleID int, sourcePort int, protocol string) bool {
	if sourcePort <= 0 {
		return false
	}
	switch strings.TrimSpace(forwardType) {
	case "nftables":
		return s.nftForwardRuleResiduePresent(ruleID, sourcePort, protocol)
	case "iptables":
		return s.iptablesForwardRuleResiduePresent(sourcePort, protocol)
	default:
		return false
	}
}

func (s *kernelForwardSnapshot) nftTableText() string {
	if s == nil {
		return ""
	}
	if s.nftLoaded {
		return s.nftTable
	}
	s.nftLoaded = true
	if !commandExists("nft") {
		return ""
	}
	raw, err := commandOutputWithTimeout(5*time.Second, "nft", "-a", "list", "table", "inet", "forwardx")
	if err != nil {
		return ""
	}
	s.nftTable = string(raw)
	return s.nftTable
}

func (s *kernelForwardSnapshot) iptablesNatPreroutingText(binary string) string {
	return s.iptablesChainText(binary, "nat", "PREROUTING")
}

// iptablesChainText 读取并缓存一个表/链的 `-S` 输出；读取失败返回空串（按“未就绪”处理）。
func (s *kernelForwardSnapshot) iptablesChainText(binary string, table string, chain string) string {
	if s == nil || strings.TrimSpace(binary) == "" {
		return ""
	}
	if s.iptablesLoaded == nil {
		s.iptablesLoaded = map[string]bool{}
	}
	if s.iptablesNatRule == nil {
		s.iptablesNatRule = map[string]string{}
	}
	key := binary + "|" + table + "|" + chain
	if s.iptablesLoaded[key] {
		return s.iptablesNatRule[key]
	}
	s.iptablesLoaded[key] = true
	if binary == "ip6tables" && !commandExists("ip6tables") {
		return ""
	}
	args := []string{"-S", chain}
	if table != "" {
		args = append([]string{"-t", table}, args...)
	}
	raw, err := iptablesCommandOutput(binary, args...)
	if err != nil {
		return ""
	}
	s.iptablesNatRule[key] = string(raw)
	return s.iptablesNatRule[key]
}

func (s *kernelForwardSnapshot) nftForwardRulePresent(ruleID int, sourcePort int, targetIP string, targetPort int, protocol string) bool {
	text := s.nftTableText()
	if text == "" {
		return false
	}
	for _, proto := range runtimeProtocols(protocol) {
		if !nftDnatLinePresent(text, ruleID, proto, sourcePort, targetIP, targetPort) {
			return false
		}
	}
	return true
}

func (s *kernelForwardSnapshot) nftForwardRuleResiduePresent(ruleID int, sourcePort int, protocol string) bool {
	text := s.nftTableText()
	if text == "" {
		return false
	}
	marker := ""
	if ruleID > 0 {
		marker = "fwx-rule-" + strconv.Itoa(ruleID)
	}
	for _, rawLine := range strings.Split(text, "\n") {
		line := kernelNormalizeLine(rawLine)
		if line == "" {
			continue
		}
		if marker != "" && strings.Contains(line, marker) {
			return true
		}
		if strings.Contains(line, "dnat") {
			for _, proto := range runtimeProtocols(protocol) {
				if kernelLineHasProtoDport(line, proto, sourcePort) {
					return true
				}
			}
		}
	}
	return false
}

func nftDnatLinePresent(text string, ruleID int, proto string, sourcePort int, targetIP string, targetPort int) bool {
	marker := ""
	if ruleID > 0 {
		marker = "fwx-rule-" + strconv.Itoa(ruleID)
	}
	for _, rawLine := range strings.Split(text, "\n") {
		line := kernelNormalizeLine(rawLine)
		if line == "" || !strings.Contains(line, "dnat") || !kernelLineHasProtoDport(line, proto, sourcePort) {
			continue
		}
		if marker != "" && !strings.Contains(line, marker) && !kernelLineDnatTargetMatches(line, targetIP, targetPort) {
			continue
		}
		if !kernelLineDnatTargetMatches(line, targetIP, targetPort) {
			continue
		}
		return true
	}
	return false
}

func (s *kernelForwardSnapshot) iptablesForwardRulePresent(sourcePort int, targetIP string, targetPort int, protocol string) bool {
	target := kernelCleanAddress(targetIP)
	binary := iptablesAgentBinaryForTarget(target)
	for _, proto := range runtimeProtocols(protocol) {
		if !iptablesDnatLinePresent(s.iptablesNatPreroutingText(binary), proto, sourcePort, target, targetPort) {
			return false
		}
		// 只有 DNAT 没有 MASQUERADE / FORWARD 放行时流量同样不通：共享目标的规则被删、
		// 或用户防火墙脚本清掉了这两段，都要让就绪检查失败以触发重下发。
		// 目标不是 IP（尚未解析）时无法按目标匹配，保持只看 DNAT 的旧行为。
		if net.ParseIP(target) == nil || targetPort <= 0 {
			continue
		}
		if !iptablesTargetRuleLinePresent(s.iptablesChainText(binary, "nat", "POSTROUTING"), "POSTROUTING", "MASQUERADE", proto, target, targetPort) {
			return false
		}
		if !iptablesTargetRuleLinePresent(s.iptablesChainText(binary, "", "FORWARD"), "FORWARD", "ACCEPT", proto, target, targetPort) {
			return false
		}
	}
	return true
}

// iptablesTargetRuleLinePresent 在 `-S` 输出里找 `-A <chain> -d <target> -p <proto> --dport <port> ... -j <jump>`，
// 带不带 fwx-rule-<id> 注释都算（兼容旧 Agent/面板留下的无标记规则）。
func iptablesTargetRuleLinePresent(text string, chain string, jump string, proto string, targetIP string, targetPort int) bool {
	want := net.ParseIP(kernelCleanAddress(targetIP))
	if want == nil || targetPort <= 0 {
		return false
	}
	for _, rawLine := range strings.Split(text, "\n") {
		fields := strings.Fields(rawLine)
		if len(fields) < 2 || fields[0] != "-A" || fields[1] != chain {
			continue
		}
		var dest net.IP
		protoOK, portOK, jumpOK := false, false, false
		for i := 2; i+1 < len(fields); i++ {
			switch fields[i] {
			case "-d":
				addr := fields[i+1]
				if slash := strings.IndexByte(addr, '/'); slash >= 0 {
					if mask := addr[slash+1:]; mask != "32" && mask != "128" {
						continue
					}
					addr = addr[:slash]
				}
				dest = net.ParseIP(kernelCleanAddress(addr))
			case "-p":
				protoOK = strings.EqualFold(fields[i+1], proto)
			case "--dport":
				portOK = fields[i+1] == strconv.Itoa(targetPort)
			case "-j":
				jumpOK = fields[i+1] == jump
			}
		}
		if dest != nil && dest.Equal(want) && protoOK && portOK && jumpOK {
			return true
		}
	}
	return false
}

func (s *kernelForwardSnapshot) iptablesForwardRuleResiduePresent(sourcePort int, protocol string) bool {
	for _, binary := range iptablesAgentBinaries() {
		text := s.iptablesNatPreroutingText(binary)
		for _, rawLine := range strings.Split(text, "\n") {
			line := kernelNormalizeLine(rawLine)
			if line == "" || !strings.Contains(line, "-j DNAT") {
				continue
			}
			for _, proto := range runtimeProtocols(protocol) {
				if kernelLineHasProtoDport(line, proto, sourcePort) {
					return true
				}
			}
		}
	}
	return false
}

func iptablesDnatLinePresent(text string, proto string, sourcePort int, targetIP string, targetPort int) bool {
	for _, rawLine := range strings.Split(text, "\n") {
		line := kernelNormalizeLine(rawLine)
		if line == "" || !strings.Contains(line, "-j DNAT") || !kernelLineHasProtoDport(line, proto, sourcePort) {
			continue
		}
		if kernelLineDnatTargetMatches(line, targetIP, targetPort) {
			return true
		}
	}
	return false
}

func kernelNormalizeLine(line string) string {
	return strings.Join(strings.Fields(line), " ")
}

func kernelCleanAddress(value string) string {
	return strings.ToLower(strings.Trim(strings.TrimSpace(value), "[]"))
}

func kernelLineHasProtoDport(line string, proto string, port int) bool {
	if port <= 0 {
		return false
	}
	lineProto, linePort, ok := kernelLineDport(line)
	return ok && lineProto == strings.TrimSpace(proto) && linePort == port
}

func kernelLineDnatTargetMatches(line string, targetIP string, targetPort int) bool {
	target := kernelCleanAddress(targetIP)
	if target == "" || targetPort <= 0 || net.ParseIP(target) == nil {
		return true
	}
	lineTarget, linePort, ok := kernelLineDnatTarget(strings.ToLower(line))
	if ok == false {
		return false
	}
	return kernelCleanAddress(lineTarget) == target && linePort == targetPort
}

func kernelLineDport(line string) (string, int, bool) {
	for _, proto := range []string{"tcp", "udp"} {
		prefixes := []string{"--dport ", proto + " dport "}
		if !strings.Contains(line, "-p "+proto+" ") && !strings.Contains(line, "meta l4proto "+proto) && !strings.Contains(line, proto+" dport ") {
			continue
		}
		for _, prefix := range prefixes {
			idx := strings.Index(line, prefix)
			if idx < 0 {
				continue
			}
			rest := strings.TrimSpace(line[idx+len(prefix):])
			if rest == "" {
				continue
			}
			fields := strings.Fields(rest)
			if len(fields) == 0 {
				continue
			}
			portText := strings.Trim(fields[0], "[];,")
			port, err := strconv.Atoi(portText)
			if err == nil && port > 0 && port <= 65535 {
				return proto, port, true
			}
		}
	}
	return "", 0, false
}

func kernelLineRuleID(line string) int {
	match := regexp.MustCompile(`fwx-rule-([0-9]+)`).FindStringSubmatch(line)
	if len(match) < 2 {
		return 0
	}
	id, _ := strconv.Atoi(match[1])
	return id
}

func kernelLineDnatTarget(line string) (string, int, bool) {
	tail := line
	if idx := strings.Index(tail, "--to-destination "); idx >= 0 {
		tail = tail[idx+len("--to-destination "):]
	} else if idx := strings.Index(tail, " to "); idx >= 0 {
		tail = tail[idx+len(" to "):]
	} else {
		return "", 0, false
	}
	fields := strings.Fields(tail)
	if len(fields) == 0 {
		return "", 0, false
	}
	token := strings.Trim(fields[0], "\"'`;")
	if strings.HasPrefix(token, "[") {
		if end := strings.Index(token, "]"); end > 0 && len(token) > end+2 && token[end+1] == ':' {
			port, err := strconv.Atoi(strings.Trim(token[end+2:], "[];,"))
			if err == nil && port > 0 {
				return strings.Trim(token[1:end], "[]"), port, true
			}
		}
	}
	idx := strings.LastIndex(token, ":")
	if idx <= 0 || idx >= len(token)-1 {
		return strings.Trim(token, "[]"), 0, false
	}
	port, err := strconv.Atoi(strings.Trim(token[idx+1:], "[];,"))
	if err != nil || port <= 0 {
		return strings.Trim(token, "[]"), 0, false
	}
	return strings.Trim(token[:idx], "[]"), port, true
}

func (s *kernelForwardSnapshot) iptablesForwardxMarkerSeenForPort(port int) bool {
	if s == nil || port <= 0 {
		return false
	}
	if !s.iptablesMangleLoaded {
		s.iptablesMangleLoaded = true
		markerPattern := regexp.MustCompile(`fwx-stat-([0-9]+):`)
		for _, binary := range iptablesAgentBinaries() {
			if binary == "ip6tables" && !commandExists("ip6tables") {
				continue
			}
			raw, err := iptablesCommandOutput(binary, "-t", "mangle", "-S")
			if err != nil {
				continue
			}
			for _, match := range markerPattern.FindAllStringSubmatch(string(raw), -1) {
				if len(match) < 2 {
					continue
				}
				markerPort, err := strconv.Atoi(match[1])
				if err == nil && markerPort > 0 {
					s.iptablesForwardxMarkers[markerPort] = true
				}
			}
		}
	}
	return s.iptablesForwardxMarkers[port]
}

func readLocalRuntimeStatePayload() localRuntimeStatePayload {
	readiness := readLocalRuntimeReadinessCached()
	ruleStates := readLocalRuntimeRuleStates()
	ruleStates = mergeDesiredDisjointRuleStates(ruleStates, desiredRunningRuleStatesSnapshot())
	activeFXPSpecs := activeFXPSpecsSnapshot()
	activeFXPEntries := activeFXPEntrySpecsSnapshot()
	var persistedFXPEntries []fxpSpec
	persistedFXPLoaded := false
	rules := make([]localRuntimeRuleState, 0, len(ruleStates))
	for _, state := range ruleStates {
		port := atoi(state.Port)
		if port <= 0 {
			continue
		}
		transportVersion := fxpTransportVersionForLocalRule(state, activeFXPEntries)
		if transportVersion == "" && strings.EqualFold(strings.TrimSpace(state.ForwardType), "forwardx") {
			if !persistedFXPLoaded {
				persistedFXPEntries = loadPersistedFXPSpecs()
				persistedFXPLoaded = true
			}
			transportVersion = fxpTransportVersionForLocalRule(state, persistedFXPEntries)
		}
		rules = append(rules, localRuntimeRuleState{
			Port:             port,
			RuleID:           state.RuleID,
			TunnelID:         state.TunnelID,
			ForwardType:      strings.TrimSpace(state.ForwardType),
			TargetIP:         strings.TrimSpace(state.TargetIP),
			TargetPort:       state.TargetPort,
			Protocol:         strings.TrimSpace(state.Protocol),
			TransportVersion: transportVersion,
			Ready:            localRuleStateReady(state, &readiness),
		})
	}
	tunnels := []localRuntimeTunnelState{}
	files, err := os.ReadDir(agentStateDir)
	if err == nil {
		for _, f := range files {
			name := f.Name()
			if !strings.HasPrefix(name, "tunnel_") || !strings.HasSuffix(name, ".id") {
				continue
			}
			port := strings.TrimSuffix(strings.TrimPrefix(name, "tunnel_"), ".id")
			portValue := atoi(port)
			if portValue <= 0 {
				continue
			}
			tunnelID := readTunnelIDByPort(port)
			if tunnelID <= 0 {
				continue
			}
			forwardType := strings.TrimSpace(readTunnelForwardTypeByPort(port))
			transportVersion := fxpTransportVersionForLocalTunnel(tunnelID, portValue, activeFXPSpecs)
			if transportVersion == "" {
				if !persistedFXPLoaded {
					persistedFXPEntries = loadPersistedFXPSpecs()
					persistedFXPLoaded = true
				}
				transportVersion = fxpTransportVersionForLocalTunnel(tunnelID, portValue, persistedFXPEntries)
			}
			tunnels = append(tunnels, localRuntimeTunnelState{
				Port:             portValue,
				TunnelID:         tunnelID,
				ForwardType:      forwardType,
				TransportVersion: transportVersion,
				Ready:            localTunnelStateReady(tunnelID, portValue, forwardType, &readiness),
			})
		}
	}
	sort.Slice(rules, func(i, j int) bool {
		if rules[i].Port == rules[j].Port {
			return rules[i].RuleID < rules[j].RuleID
		}
		return rules[i].Port < rules[j].Port
	})
	sort.Slice(tunnels, func(i, j int) bool {
		if tunnels[i].Port == tunnels[j].Port {
			return tunnels[i].TunnelID < tunnels[j].TunnelID
		}
		return tunnels[i].Port < tunnels[j].Port
	})
	return localRuntimeStatePayload{Rules: rules, Tunnels: tunnels, Services: readiness.serviceStates}
}

func activeFXPEntrySpecsSnapshot() []fxpSpec {
	return flattenFXPEntrySpecs(activeFXPSpecsSnapshot())
}

func activeFXPSpecsSnapshot() []fxpSpec {
	fxpMu.Lock()
	specs := make([]fxpSpec, 0, len(fxpServers))
	for _, process := range fxpServers {
		if process != nil {
			specs = append(specs, normalizeFXPSpec(process.spec))
		}
	}
	fxpMu.Unlock()
	return specs
}

func flattenFXPEntrySpecs(specs []fxpSpec) []fxpSpec {
	entries := make([]fxpSpec, 0, len(specs))
	for _, spec := range specs {
		spec = normalizeFXPSpec(spec)
		if isFXPEntryGroup(spec) {
			entries = append(entries, spec.Entries...)
			continue
		}
		if isSharedFXPEntry(spec) {
			entries = append(entries, spec)
		}
	}
	return entries
}

func fxpTransportVersionForLocalRule(state localRuleState, entries []fxpSpec) string {
	if !strings.EqualFold(strings.TrimSpace(state.ForwardType), "forwardx") || state.RuleID <= 0 || atoi(state.Port) <= 0 {
		return ""
	}
	version := ""
	for _, entry := range flattenFXPEntrySpecs(entries) {
		entry = normalizeFXPSpec(entry)
		if entry.RuleID != state.RuleID || entry.ListenPort != atoi(state.Port) {
			continue
		}
		if state.TunnelID > 0 && entry.TunnelID != state.TunnelID {
			continue
		}
		if strings.TrimSpace(state.Protocol) != "" && !runtimeProtocolsOverlap(entry.Protocol, state.Protocol) {
			continue
		}
		if version != "" && version != entry.TransportVersion {
			return ""
		}
		version = entry.TransportVersion
	}
	return version
}

func fxpTransportVersionForLocalTunnel(tunnelID int, port int, specs []fxpSpec) string {
	if tunnelID <= 0 || port <= 0 {
		return ""
	}
	version := ""
	for _, raw := range specs {
		raw = normalizeFXPSpec(raw)
		candidates := []fxpSpec{raw}
		if isFXPEntryGroup(raw) {
			candidates = raw.Entries
		}
		for _, candidate := range candidates {
			candidate = normalizeFXPSpec(candidate)
			if candidate.TunnelID != tunnelID || candidate.Role != "relay" && candidate.Role != "exit" {
				continue
			}
			if !fxpSpecUsesListenEndpoint(candidate, port, "both") {
				continue
			}
			if version != "" && version != candidate.TransportVersion {
				return ""
			}
			version = candidate.TransportVersion
		}
	}
	return version
}

func mergeDesiredDisjointRuleStates(ruleStates []localRuleState, desiredStates []localRuleState) []localRuleState {
	seenRuleStates := map[string]bool{}
	reportedProtocolsByPort := map[string][]string{}
	for _, state := range ruleStates {
		key := fmt.Sprintf("%d:%s:%s", state.RuleID, state.Port, normalizeRuntimeProtocol(state.Protocol))
		seenRuleStates[key] = true
		reportedProtocolsByPort[state.Port] = append(reportedProtocolsByPort[state.Port], state.Protocol)
	}
	// The legacy on-disk marker is keyed only by port. Merge the desired rule
	// snapshot only when another disjoint protocol is already recorded on that
	// port, so a completely missing listener cannot be mistaken for desired state.
	for _, state := range desiredStates {
		key := fmt.Sprintf("%d:%s:%s", state.RuleID, state.Port, normalizeRuntimeProtocol(state.Protocol))
		if seenRuleStates[key] {
			continue
		}
		hasDisjointReportedProtocol := false
		for _, reportedProtocol := range reportedProtocolsByPort[state.Port] {
			if !runtimeProtocolsOverlap(reportedProtocol, state.Protocol) {
				hasDisjointReportedProtocol = true
				break
			}
		}
		if !hasDisjointReportedProtocol {
			continue
		}
		seenRuleStates[key] = true
		ruleStates = append(ruleStates, state)
	}
	return ruleStates
}

func localRuntimeStateSignature(state localRuntimeStatePayload) string {
	raw, err := json.Marshal(state)
	if err != nil {
		return ""
	}
	h := fnv.New64a()
	_, _ = h.Write(raw)
	return strconv.FormatUint(h.Sum64(), 16)
}

func localRuntimeStateForHeartbeat() (string, *localRuntimeStatePayload) {
	state := readLocalRuntimeStatePayload()
	signature := localRuntimeStateSignature(state)
	localRuntimeStateMu.Lock()
	sendFull := forceSendLocalRuntimeState || signature != lastLocalRuntimeStateSignature
	if sendFull {
		lastLocalRuntimeStateSignature = signature
		forceSendLocalRuntimeState = false
	}
	localRuntimeStateMu.Unlock()
	if sendFull {
		return signature, &state
	}
	return signature, nil
}

func requestLocalRuntimeStateUpload() {
	localRuntimeStateMu.Lock()
	forceSendLocalRuntimeState = true
	localRuntimeStateMu.Unlock()
	// 运行时状态有变化，丢弃 readiness 缓存以便下次心跳重新采集。
	invalidateLocalRuntimeReadinessCache()
}

type selfTestResp struct {
	SelfTests []selfTest `json:"selfTests"`
}

type action struct {
	TunnelID                  int                 `json:"tunnelId"`
	StatusType                string              `json:"statusType"`
	RuleID                    int                 `json:"ruleId"`
	PluginID                  string              `json:"pluginId,omitempty"`
	IssuedAt                  int64               `json:"issuedAt,omitempty"`
	ConfigRevision            int64               `json:"configRevision,omitempty"`
	ConfigHash                string              `json:"configHash,omitempty"`
	KnownRunning              bool                `json:"knownRunning,omitempty"`
	Op                        string              `json:"op"`
	ForwardType               string              `json:"forwardType"`
	RuntimeBackendForwardType string              `json:"runtimeBackendForwardType,omitempty"`
	SourcePort                int                 `json:"sourcePort"`
	TargetIP                  string              `json:"targetIp"`
	TargetPort                int                 `json:"targetPort"`
	Protocol                  string              `json:"protocol"`
	PreCommands               []string            `json:"preCommands"`
	ServiceName               string              `json:"svcName"`
	ServiceNameExtra          string              `json:"svcNameExtra"`
	Unit                      string              `json:"unit"`
	UnitExtra                 string              `json:"unitExtra"`
	Commands                  []string            `json:"commands"`
	RemovalCommands           []string            `json:"removalCommands,omitempty"`
	RemovalToken              string              `json:"removalToken,omitempty"`
	ManagedConfigs            []managedConfigSpec `json:"managedConfigs,omitempty"`
	RollbackCommands          []string            `json:"rollbackCommands,omitempty"`
	PostCommands              []string            `json:"postCommands"`
	Fxp                       *fxpSpec            `json:"fxp,omitempty"`
	FXPEntryGroup             *fxpSpec            `json:"-"`
	WireGuard                 *wireGuardSpec      `json:"wireGuard,omitempty"`
	Failover                  *failoverSpec       `json:"failover,omitempty"`
	ReportStatus              *bool               `json:"reportStatus,omitempty"`
	FailureMessage            string              `json:"failureMessage,omitempty"`
	ForceRuntimeSync          bool                `json:"forceRuntimeSync,omitempty"`
	RequiresMimicEnvironment  bool                `json:"requiresMimicEnvironment,omitempty"`
	HandoffOnly               bool                `json:"-"`
}

type desiredState struct {
	Version        int      `json:"version"`
	IssuedAt       int64    `json:"issuedAt,omitempty"`
	ConfigRevision int64    `json:"configRevision,omitempty"`
	ConfigHash     string   `json:"configHash,omitempty"`
	Actions        []action `json:"actions"`
}

type desiredActionRecord struct {
	Signature   string `json:"signature"`
	Success     bool   `json:"success"`
	UpdatedAt   int64  `json:"updatedAt"`
	ApplySchema int    `json:"applySchema,omitempty"`
}

type runningRule struct {
	RuleID      int                     `json:"ruleId"`
	TunnelID    int                     `json:"tunnelId,omitempty"`
	SourcePort  int                     `json:"sourcePort"`
	TargetIP    string                  `json:"targetIp"`
	TargetPort  int                     `json:"targetPort"`
	Protocol    string                  `json:"protocol"`
	ForwardType string                  `json:"forwardType"`
	Failover    *failoverSpec           `json:"failover,omitempty"`
	GroupHealth *forwardGroupHealthSpec `json:"forwardGroupHealth,omitempty"`
	// 只跑线路组的调度器（2.2.199 起）：NEX 隧道的出口机上没有这条规则自己的进程，出口的
	// FXP 拨本机的调度器。它不占规则端口 —— SourcePort 是调度器自己的监听端口，只当标识用；
	// 不写端口状态、不装计数链、不算进要保留的端口，流量照旧在入口计。
	SchedulerOnly bool `json:"schedulerOnly,omitempty"`
}

type forwardGroupHealthSpec struct {
	GroupID         int `json:"groupId"`
	MemberID        int `json:"memberId"`
	FailoverSeconds int `json:"failoverSeconds"`
	RecoverSeconds  int `json:"recoverSeconds"`
}

type failoverTarget struct {
	TargetIP   string `json:"targetIp"`
	TargetPort int    `json:"targetPort"`
	// 这条出站的健康探测目标；留空就探出站地址本身。
	//
	// 出站是 iptables/DNAT 类中转时，握手实际是和最终落地完成的，探出站地址就是
	// 端到端的。出站是 gost、realm 这类用户态转发时，中转在本地就把连接收下了 ——
	// 连得上只能证明中转活着，证明不了它到落地那一段还通。后一种情况下中转的上游
	// 断了主备不会切，流量继续往死路里送，而面板上一切正常。
	ProbeIP   string `json:"probeIp,omitempty"`
	ProbePort int    `json:"probePort,omitempty"`
	// 权重负载（strategy=weighted）下新连接分到这条的比重，1–100；0 当成不参与。
	Weight int `json:"weight,omitempty"`
	// 面板从中转机的探测得知这条路径的中转挂了：按不可用处理，直到面板把它清掉。
	// 这是运行时提示，不进 failoverSignature，也不落盘（见 applyRelayHintsLocked）。
	Down       bool   `json:"down,omitempty"`
	DownReason string `json:"downReason,omitempty"`
}

// 这条出站实际该探哪儿。和面板的 failoverProbeEndpoint 是同一条规则。
func (t failoverTarget) probeEndpoint() (string, int) {
	host := strings.TrimSpace(t.ProbeIP)
	if host != "" && t.ProbePort >= 1 && t.ProbePort <= 65535 {
		return host, t.ProbePort
	}
	return t.TargetIP, t.TargetPort
}

type failoverSpec struct {
	Enabled         bool             `json:"enabled"`
	ListenPort      int              `json:"listenPort"`
	BindAddress     string           `json:"bindAddress"`
	Protocol        string           `json:"protocol"`
	Strategy        string           `json:"strategy"`
	Targets         []failoverTarget `json:"targets"`
	FailoverSeconds int              `json:"failoverSeconds"`
	RecoverSeconds  int              `json:"recoverSeconds"`
	AutoFailback    bool             `json:"autoFailback"`
	// 时段表：某几个时段里优先走哪一条出站（晚高峰错峰）。只对 fallback 生效。
	Schedule *failoverSchedule `json:"schedule,omitempty"`
	// 刚切过去之后至少待多久才允许再按优先级切回，防止线路来回抖。
	// 当前这条**挂了**的时候不受它限制 —— 守着一条死路比抖动更糟。
	MinHoldSeconds int `json:"minHoldSeconds,omitempty"`
	// 人工指定优先走第几条出站；nil 或负数表示交回自动。
	//
	// 语义是「把它排到最前」，**不是「只许走它」**：钉住的那条要是挂了，仍然按
	// 优先级往下找。运维想要的是「现在走 B」，不是「B 死了也守着 B」—— 后者等于
	// 用一个应急开关制造一次故障。
	//
	// **为什么是指针**：Go 的 int 零值是 0，而 0 是一个合法的出站序号（主出站）。
	// 用 int 的话，任何没带这个字段的规格 —— 老 Agent 落在盘上的快照、面板漏传的
	// 那一次 —— 都会被解成「钉死在主出站」，于是时段表和自动择优全部静默失效，
	// 而面板上看不出任何异常。用例 TestPinnedIndexZeroValueIsNotAPin 钉住这件事。
	PinnedIndex *int `json:"pinnedIndex,omitempty"`
	// 钉到什么时候（Unix 毫秒）；0 表示一直钉着。
	//
	// 有期限这件事很要紧：应急处理完没人记得去关，那条线就一直被钉着，后面所有
	// 自动切换（包括时段表）全部静默失效，而面板上看不出任何异常。
	PinnedUntil int64 `json:"pinnedUntil,omitempty"`
	// 按实测延迟自动择优。
	//
	// 不是「谁快切谁」：那样线路会一直漂。候选必须**明显**更快（同时满足绝对值和
	// 百分比两个门槛），而且要连着好一阵子都更快，才会被提到最前。
	PreferFastest bool `json:"preferFastest,omitempty"`
	// 连续失败几次才标记异常（探测不通和真实连接拨不通都算）。不带就是 1，即上一版的行为。
	FailureThreshold int `json:"failureThreshold,omitempty"`
	// 自动择优：候选要高出多少分、持续多少秒才切。不带就是 10 分 / 180 秒。
	ScoreMargin      int `json:"scoreMargin,omitempty"`
	ScoreHoldSeconds int `json:"scoreHoldSeconds,omitempty"`
	// 计划切换提前多少秒预热并预检目标线路；0 = 不预检，到点就切（上一版的行为）。
	PrewarmSeconds int `json:"prewarmSeconds,omitempty"`
	// 切换时旧连接怎么办：smooth 不动（默认）、fast 只在故障切换时断、force 每次都断。
	SwitchMode string `json:"switchMode,omitempty"`
	// 进到调度器的连接开头带着 PROXY protocol 头（前面的转发工具加的）。调度器照样原样转给
	// 路径，只是「按访客固定」要从这个头里读访客地址 —— 调度器只监听 127.0.0.1，不读的话
	// 看到的来源永远是本机，所有访客会被分到同一条路径上。
	ProxyProtocolReceive bool `json:"proxyProtocolReceive,omitempty"`
	// 这个 PROXY 头是面板专门让前面的转发工具加给调度器的（规则本身不往目标发 PROXY 头，
	// 可「按访客固定」要知道访客是谁）：调度器读完就扔，不转给路径。
	ProxyProtocolStrip bool `json:"proxyProtocolStrip,omitempty"`
}

type tunnelProbe struct {
	TunnelID        int    `json:"tunnelId"`
	TargetIP        string `json:"targetIp"`
	TargetPort      int    `json:"targetPort"`
	Protocol        string `json:"protocol"`
	HopIndex        int    `json:"hopIndex"`
	HopCount        int    `json:"hopCount"`
	SeriesKey       string `json:"seriesKey"`
	SeriesLabel     string `json:"seriesLabel"`
	WireGuardPeerID string `json:"wireGuardPeerId,omitempty"`
	ProbeKey        string `json:"probeKey,omitempty"`
	TopologyKey     string `json:"topologyKey,omitempty"`
}

type ruleLatencyProbe struct {
	RuleID      int                     `json:"ruleId"`
	TunnelID    int                     `json:"tunnelId"`
	TargetIP    string                  `json:"targetIp"`
	TargetPort  int                     `json:"targetPort"`
	Method      string                  `json:"method"`
	ProbeKey    string                  `json:"probeKey,omitempty"`
	TopologyKey string                  `json:"topologyKey,omitempty"`
	GroupHealth *forwardGroupHealthSpec `json:"forwardGroupHealth,omitempty"`
}

type hostProbeServiceProbe struct {
	ServiceID       int    `json:"serviceId"`
	TargetIP        string `json:"targetIp"`
	TargetPort      int    `json:"targetPort"`
	Method          string `json:"method"`
	IntervalSeconds int    `json:"intervalSeconds"`
}
type forwardGroupProbe struct {
	GroupID         int    `json:"groupId"`
	MemberID        int    `json:"memberId"`
	ProbeType       string `json:"probeType"`
	TargetIP        string `json:"targetIp"`
	TargetPort      int    `json:"targetPort"`
	Method          string `json:"method"`
	HopIndex        int    `json:"hopIndex"`
	HopCount        int    `json:"hopCount"`
	FailoverSeconds int    `json:"failoverSeconds,omitempty"`
	RecoverSeconds  int    `json:"recoverSeconds,omitempty"`
	ProbeKey        string `json:"probeKey,omitempty"`
	TopologyKey     string `json:"topologyKey,omitempty"`
}

type dnsWatchItem struct {
	Host  string `json:"host"`
	Scope string `json:"scope"`
	RefID int    `json:"refId"`
}

type dnsChangeReport struct {
	Host  string   `json:"host"`
	Scope string   `json:"scope,omitempty"`
	RefID int      `json:"refId,omitempty"`
	Old   []string `json:"old,omitempty"`
	New   []string `json:"new,omitempty"`
}

type agentUpgrade struct {
	TargetVersion  string `json:"targetVersion"`
	PanelURL       string `json:"panelUrl"`
	ReleaseVersion string `json:"releaseVersion"`
}

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

type migratedPanelError struct {
	PanelURL string
}

func (e migratedPanelError) Error() string {
	return "panel migrated to " + e.PanelURL
}

type selfTest struct {
	TestID               int    `json:"testId"`
	Kind                 string `json:"kind,omitempty"`
	RuleID               int    `json:"ruleId"`
	ForwardType          string `json:"forwardType"`
	SourcePort           int    `json:"sourcePort"`
	Protocol             string `json:"protocol"`
	Method               string `json:"method"`
	TargetIP             string `json:"targetIp"`
	TargetPort           int    `json:"targetPort"`
	TunnelID             int    `json:"tunnelId,omitempty"`
	WireGuardPeerID      string `json:"wireGuardPeerId,omitempty"`
	runtimeActionsWaited bool
}

type fxpSpec struct {
	Role                     string            `json:"role"`
	TransportVersion         string            `json:"transportVersion,omitempty"`
	Entries                  []fxpSpec         `json:"entries,omitempty"`
	TunnelID                 int               `json:"tunnelId"`
	RuleID                   int               `json:"ruleId"`
	ListenPort               int               `json:"listenPort"`
	UDPListenPort            int               `json:"udpListenPort,omitempty"`
	ListenHost               string            `json:"listenHost,omitempty"`
	Protocol                 string            `json:"protocol"`
	ExitHost                 string            `json:"exitHost"`
	ExitPort                 int               `json:"exitPort"`
	UDPExitPort              int               `json:"udpExitPort,omitempty"`
	ExitPeerID               string            `json:"exitPeerId,omitempty"`
	Exits                    []fxpExitEndpoint `json:"exits,omitempty"`
	ExitStrategy             string            `json:"exitStrategy,omitempty"`
	TargetIP                 string            `json:"targetIp"`
	TargetPort               int               `json:"targetPort"`
	UDPTargets               []fxpUDPTarget    `json:"udpTargets,omitempty"`
	StreamTargets            []fxpUDPTarget    `json:"streamTargets,omitempty"` // 出口允许按 hello 拨的 TCP 目标，原样交给 FXP
	Key                      string            `json:"key"`
	LimitIn                  int64             `json:"limitIn"`
	LimitOut                 int64             `json:"limitOut"`
	MaxConnections           int               `json:"maxConnections"`
	MaxIPs                   int               `json:"maxIPs"`
	AccessScope              string            `json:"accessScope"`
	BlockHTTP                bool              `json:"blockHttp"`
	BlockSocks               bool              `json:"blockSocks"`
	BlockTLS                 bool              `json:"blockTls"`
	ProxyProtocolReceive     bool              `json:"proxyProtocolReceive"`
	ProxyProtocolSend        bool              `json:"proxyProtocolSend"`
	ProxyProtocolExitReceive bool              `json:"proxyProtocolExitReceive"`
	ProxyProtocolExitSend    bool              `json:"proxyProtocolExitSend"`
	ProxyProtocolVersion     int               `json:"proxyProtocolVersion"`
	TCPFastOpen              bool              `json:"tcpFastOpen"`
	// 链路整形（见 forwardx-fxp/link_shaper.go），原样交给 FXP：LinkShaping 是档位
	// （auto / manual / off），LinkUpMbps / LinkDownMbps 是手动上限（Mbit/s），
	// LinkUpHintMbps / LinkDownHintMbps 是自动模式的提示值（面板记住的限速点）。
	LinkShaping      string `json:"linkShaping,omitempty"`
	LinkUpMbps       int    `json:"linkUpMbps,omitempty"`
	LinkDownMbps     int    `json:"linkDownMbps,omitempty"`
	LinkUpHintMbps   int    `json:"linkUpHintMbps,omitempty"`
	LinkDownHintMbps int    `json:"linkDownHintMbps,omitempty"`
	// 主机公网出口整形（也见 link_shaper.go）：整台机器往客户端、往目标发的明文流量
	// 合起来整形到公网带宽上限之下。EgressShaping 档位、EgressMbps 手动上限、
	// EgressHintMbps 自动模式提示值。按主机配置，每条隧道的 spec 都带同一份。
	EgressShaping    string `json:"egressShaping,omitempty"`
	EgressMbps       int    `json:"egressMbps,omitempty"`
	EgressHintMbps   int    `json:"egressHintMbps,omitempty"`
	PanelURL         string `json:"panelUrl,omitempty"`
	Token            string `json:"token,omitempty"`
	RelayExitHost    string `json:"relayExitHost,omitempty"`
	RelayExitPort    int    `json:"relayExitPort,omitempty"`
	UDPRelayExitPort int    `json:"udpRelayExitPort,omitempty"`
	RelayPeerID      string `json:"relayPeerId,omitempty"`
	RelayKey         string `json:"relayKey,omitempty"`
	DNSGeneration    int    `json:"dnsGeneration,omitempty"`
	// Single-connection multipath aggregation: the entry stripes each client
	// connection over every leg and the exit reassembles it.
	MultipathEnabled    bool              `json:"multipathEnabled,omitempty"`
	MultipathLegs       []fxpMultipathLeg `json:"multipathLegs,omitempty"`
	MultipathMaxPending int               `json:"multipathMaxPending,omitempty"`
}

// fxpMultipathLeg is one parallel path from the entry to the exit, either a
// direct dial or a dial to a relay front that forwards on to the exit.
type fxpMultipathLeg struct {
	Host string `json:"host"`
	Port int    `json:"port"`
	Key  string `json:"key,omitempty"`
	Via  string `json:"via,omitempty"`
}

type fxpExitEndpoint struct {
	Host    string `json:"host"`
	Port    int    `json:"port"`
	UDPPort int    `json:"udpPort,omitempty"`
	Key     string `json:"key,omitempty"`
	PeerID  string `json:"peerId,omitempty"`
}

type fxpUDPTarget struct {
	RuleID     int    `json:"ruleId"`
	TargetIP   string `json:"targetIp"`
	TargetPort int    `json:"targetPort"`
}

type protocolPolicy struct {
	BlockHTTP  bool `json:"blockHttp"`
	BlockSocks bool `json:"blockSocks"`
	BlockTLS   bool `json:"blockTls"`
}

func (p protocolPolicy) enabled() bool {
	return p.BlockHTTP || p.BlockSocks || p.BlockTLS
}

type guardRule struct {
	RuleID               int            `json:"ruleId"`
	TunnelID             int            `json:"tunnelId"`
	ListenPort           int            `json:"listenPort"`
	BindAddress          string         `json:"bindAddress"`
	TargetIP             string         `json:"targetIp"`
	TargetPort           int            `json:"targetPort"`
	BackendPort          int            `json:"backendPort"`
	BackendForwardType   string         `json:"backendForwardType"`
	Protocol             string         `json:"protocol"`
	Policy               protocolPolicy `json:"policy"`
	ProxyProtocolReceive bool           `json:"proxyProtocolReceive"`
	ProxyProtocolSend    bool           `json:"proxyProtocolSend"`
	ProxyProtocolVersion int            `json:"proxyProtocolVersion"`
	LimitIn              int64          `json:"limitIn"`
	LimitOut             int64          `json:"limitOut"`
	RateLimitScope       string         `json:"rateLimitScope"`
}

func main() {
	configPath := flag.String("config", defaultConfigPath, "config file")
	onceRegister := flag.Bool("register", false, "register and exit")
	flag.Parse()

	resolvedConfigPath, cfg, err := loadConfigWithFallback(*configPath)
	if err != nil {
		fatal("load config: %v", err)
	}
	if cfg.Interval <= 0 {
		cfg.Interval = 30
	}
	cfg.PanelURL = strings.TrimRight(cfg.PanelURL, "/")
	activeConfigPath = resolvedConfigPath
	setRuntimePanelURL(cfg.PanelURL)
	runtimeAgentToken.Store(cfg.Token)
	initializePanelMigration(cfg)

	if *onceRegister {
		if err := register(cfg); err != nil {
			fatal("register: %v", err)
		}
		return
	}
	stateLock, err := acquireAgentStateLock(trafficStateDir)
	if err != nil {
		fatal("acquire Agent state lock: %v", err)
	}
	defer stateLock.Close()
	restoreCountingChainStates(agentBootID)

	startAgentLogMaintenance()
	// Restore persisted runtimes (WireGuard / FXP / failover) in the background
	// *before* registering: register() can block for the full HTTP client
	// timeout when the panel is unreachable, and forwarding must come back
	// immediately after an Agent restart regardless of panel reachability.
	// Restore only needs the local snapshots, and the action queue plus the
	// FXP/failover control locks make restore and server-driven reconciliation
	// idempotent when they overlap.
	if err := startRuntimeRestoreThenRegister(cfg, func(cfg Config) {
		restorePersistedForwardXRuntimes(cfg)
		wakeHeartbeat()
	}, register); err != nil {
		// Registration is intentionally non-fatal; the regular heartbeat path
		// will retry communication. Keep the failure visible in the Agent log so
		// an installation that never reaches the panel is diagnosable.
		logAgentCommError("register", err)
	} else if shouldLogAgentReport("register-ok", agentHeartbeatSummaryLogInterval) {
		logf("agent registration succeeded version=%s", Version)
	}
	resetDesiredActionRecordsAfterAgentUpgrade()
	startDesiredActionRecordsFlusher()
	startActionStatusReporter()
	startPluginAgentTaskWorkers(cfg)
	go actionWorker()
	go selfTestPoller(cfg)
	go agentEventStream(cfg)
	go agentPresenceLoop(cfg)
	go agentMetricsScheduler(cfg)
	go agentDNSWatchScheduler()
	lastFullHeartbeatAt := time.Time{}
	metricsOnlyMode := false
	for {
		pending := atomic.LoadInt64(&actionPendingCount)
		fromSSE := heartbeatWakeFromSSE.Swap(false)
		urgentRefresh := heartbeatUrgentWakeFromSSE.Swap(false)
		forceReconcileWake := heartbeatForceReconcileWake.Swap(false)
		now := time.Now()
		if pending > 0 {
			if shouldLogAgentReport("heartbeat-pending-continue", agentReportLogInterval) {
				logf("heartbeat continue while actions pending=%d queued=%d workers=%d/%d fromSSE=%v", pending, len(actionQueue), atomic.LoadInt64(&actionWorkerStartedCount), actionWorkerConcurrency, fromSSE)
			}
		}
		// SSE 唤醒 + 有 actions 正在处理：只发轻量 keepalive（不做 readiness 扫描，
		// 仅上报指标并告知面板 Agent 正忙）。完整心跳由定时器或下一次 SSE 唤醒触发。
		useActionBacklogKeepalive := !forceReconcileWake && shouldUseBusyHeartbeat(fromSSE, urgentRefresh, pending, lastFullHeartbeatAt, now)
		useMetricsOnlyHeartbeat := shouldUseMetricsOnlyHeartbeat(metricsOnlyMode, fromSSE, urgentRefresh, forceReconcileWake, pending, lastFullHeartbeatAt, now)
		if useActionBacklogKeepalive || useMetricsOnlyHeartbeat {
			result, err := heartbeatKeepalive(cfg)
			requestSkipped := errors.Is(err, errHeartbeatRequestInFlight)
			if requestSkipped {
				restoreHeartbeatWakeIntent(fromSSE, urgentRefresh, forceReconcileWake)
			}
			if err != nil && !requestSkipped {
				recordPanelMigrationHeartbeatFailure(cfg, err)
				logAgentCommError("heartbeat-keepalive", err)
			} else {
				if err == nil {
					recordPanelMigrationHeartbeatSuccess()
					metricsOnlyMode = result.MetricsOnly
				}
			}
			nextInterval := result.NextInterval
			if requestSkipped {
				nextInterval = int(agentPresenceInterval / time.Second)
			} else if err != nil {
				// 失败重试加随机抖动，避免面板恢复时所有 Agent 同一秒一起打过来。
				nextInterval = fullJitterSeconds(cfg.Interval, 2)
			} else if nextInterval < 2 {
				nextInterval = cfg.Interval
			}
			if nextInterval < 2 {
				nextInterval = 2
			}
			select {
			case <-heartbeatWakeCh:
			case <-time.After(time.Duration(nextInterval) * time.Second):
			}
			continue
		} else {
			forceFullAudit := metricsOnlyMode && !lastFullHeartbeatAt.IsZero() && now.Sub(lastFullHeartbeatAt) >= agentFullHeartbeatInterval
			result, err := heartbeat(cfg, fromSSE || urgentRefresh || forceReconcileWake || forceFullAudit)
			requestSkipped := errors.Is(err, errHeartbeatRequestInFlight)
			if requestSkipped {
				restoreHeartbeatWakeIntent(fromSSE, urgentRefresh, forceReconcileWake || forceFullAudit)
			}
			if err != nil && !requestSkipped {
				recordPanelMigrationHeartbeatFailure(cfg, err)
				logAgentCommError("heartbeat", err)
			} else {
				if err == nil {
					recordPanelMigrationHeartbeatSuccess()
					metricsOnlyMode = result.MetricsOnly
					if !result.ReconciliationCoalesced {
						lastFullHeartbeatAt = time.Now()
					}
				}
			}
			nextInterval := result.NextInterval
			if requestSkipped {
				nextInterval = int(agentPresenceInterval / time.Second)
			} else if err != nil {
				nextInterval = fullJitterSeconds(cfg.Interval, 2)
			} else if result.ReconciliationCoalesced {
				nextInterval = 5
			} else {
				nextInterval = successfulHeartbeatDelaySeconds(
					nextInterval,
					cfg.Interval,
					agentPresenceSupported.Load(),
					agentEventStreamConnected.Load(),
				)
				nextInterval = jitterSuccessfulHeartbeatDelaySeconds(nextInterval)
			}
			if nextInterval < 2 {
				nextInterval = 2
			}
			select {
			case <-heartbeatWakeCh:
			case <-time.After(time.Duration(nextInterval) * time.Second):
			}
			continue
		}
	}
}

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

func loadConfigWithFallback(path string) (string, Config, error) {
	resolvedPath, cfg, migrated, err := loadConfigWithFallbackPaths(path, defaultConfigPath, legacyConfigPath)
	if migrated {
		logf("config migrated from %s to %s", legacyConfigPath, defaultConfigPath)
	}
	return resolvedPath, cfg, err
}

func loadConfigWithFallbackPaths(path string, canonicalPath string, legacyPath string) (string, Config, bool, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		path = canonicalPath
	}
	cfg, err := loadConfig(path)
	if err == nil {
		return path, cfg, false, nil
	}
	if path != canonicalPath {
		return path, Config{}, false, err
	}
	legacyCfg, legacyRaw, legacyErr := readConfigFile(legacyPath)
	if legacyErr != nil {
		return path, Config{}, false, err
	}
	if writeConfigFileAtomic(canonicalPath, legacyRaw) == nil {
		return canonicalPath, legacyCfg, true, nil
	}
	return legacyPath, legacyCfg, false, nil
}

func loadConfig(path string) (Config, error) {
	cfg, _, err := readConfigFile(path)
	return cfg, err
}

func readConfigFile(path string) (Config, []byte, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return Config{}, nil, err
	}
	var cfg Config
	if err := json.Unmarshal(b, &cfg); err != nil {
		return Config{}, nil, err
	}
	if cfg.PanelURL == "" || cfg.Token == "" {
		return Config{}, nil, fmt.Errorf("panelUrl/token required")
	}
	return cfg, b, nil
}

func writeConfigFileAtomic(path string, raw []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	return writeFileAtomicDurable(path, raw, 0600)
}

// writeFileAtomicDurable 用唯一的临时文件写入、fsync、rename，再 fsync 目录。
// 掉电或崩溃后文件要么是旧内容、要么是完整的新内容，不会是空文件或半截；
// 也不会像固定的 path+".tmp" 那样被两个并发写入者互相覆盖。
func writeFileAtomicDurable(path string, raw []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".forwardx-agent-write-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(perm); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(raw); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return err
	}
	// 目录项落盘是尽力而为：个别文件系统不支持对目录 fsync，此时 rename 本身已经完成。
	if directory, err := os.Open(dir); err == nil {
		_ = directory.Sync()
		_ = directory.Close()
	}
	return nil
}

func normalizePanelURL(raw string) string {
	value := strings.TrimSpace(raw)
	if value == "" {
		return ""
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return ""
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return ""
	}
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return strings.TrimRight(parsed.String(), "/")
}

func setRuntimePanelURL(panelURL string) {
	normalized := normalizePanelURL(panelURL)
	if normalized == "" {
		return
	}
	runtimePanelURL.Store(normalized)
}

func currentPanelURL(cfg Config) string {
	if value, ok := runtimePanelURL.Load().(string); ok && value != "" {
		return value
	}
	return strings.TrimRight(cfg.PanelURL, "/")
}

func persistPanelURL(panelURL string) error {
	normalized := normalizePanelURL(panelURL)
	if normalized == "" {
		return fmt.Errorf("invalid panelUrl")
	}
	path := strings.TrimSpace(activeConfigPath)
	if path == "" {
		return fmt.Errorf("config path is empty")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var data map[string]any
	if err := json.Unmarshal(raw, &data); err != nil {
		return err
	}
	if data == nil {
		data = map[string]any{}
	}
	if strings.TrimRight(fmt.Sprint(data["panelUrl"]), "/") == normalized {
		return nil
	}
	data["panelUrl"] = normalized
	next, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}
	next = append(next, '\n')
	// 配置文件里有 token，写坏了 Agent 下次启动就连不上面板：必须原子且落盘。
	return writeConfigFileAtomic(path, next)
}

func syncPanelURLFromResponse(panelURL string) {
	normalized := normalizePanelURL(panelURL)
	if normalized == "" {
		return
	}
	current := currentPanelURL(Config{})
	if current == normalized {
		return
	}
	setRuntimePanelURL(normalized)
	if err := persistPanelURL(normalized); err != nil {
		logf("panel URL switched to %s for runtime, persist failed: %v", normalized, err)
		return
	}
	logf("panel URL updated to %s", normalized)
}

func register(cfg Config) error {
	ipv4, ipv6 := publicIPs()
	primaryIP := ipv4
	if primaryIP == "" {
		primaryIP = ipv6
	}
	if primaryIP == "" {
		primaryIP = "unknown"
	}
	payload := map[string]any{
		"token":        cfg.Token,
		"ip":           primaryIP,
		"ipv4":         ipv4,
		"ipv6":         ipv6,
		"privateIpv4":  localPrivateIPv4(),
		"osInfo":       osInfo(),
		"cpuInfo":      cpuInfo(),
		"memoryTotal":  memTotal(),
		"agentVersion": Version,
		"fxpVersion":   reportedFXPVersion(),
	}
	var out map[string]any
	return post(cfg, "/api/agent/register", payload, &out)
}

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

// localPrivateIPv4 returns the private IPv4 (10/8, 172.16/12, 192.168/16,
// 100.64/10) bound to the default-route interface, so the panel can offer it
// as the host's "内网地址". Only the default interface is looked at: falling
// back to every interface would pick up docker0 / br-* bridge addresses.
func localPrivateIPv4() string {
	name := defaultNetworkInterface()
	if name == "" {
		return ""
	}
	iface, err := net.InterfaceByName(name)
	if err != nil || iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
		return ""
	}
	addrs, err := iface.Addrs()
	if err != nil {
		return ""
	}
	return firstPrivateIPv4(addrs)
}

func firstPrivateIPv4(addrs []net.Addr) string {
	for _, addr := range addrs {
		ipNet, ok := addr.(*net.IPNet)
		if !ok {
			continue
		}
		ip := ipNet.IP.To4()
		if ip == nil {
			continue
		}
		if ip.IsPrivate() || (ip[0] == 100 && ip[1]&0xc0 == 64) {
			return ip.String()
		}
	}
	return ""
}

func defaultNetworkInterface() string {
	if runtime.GOOS != "linux" {
		return ""
	}
	if raw, err := os.ReadFile("/proc/net/route"); err == nil {
		if name := defaultIPv4NetworkInterface(raw); name != "" {
			return name
		}
	}
	if raw, err := os.ReadFile("/proc/net/ipv6_route"); err == nil {
		return defaultIPv6NetworkInterface(raw)
	}
	return ""
}

func mimicEnvironment(force bool) mimicEnvironmentReport {
	mimicEnvironmentMu.Lock()
	defer mimicEnvironmentMu.Unlock()
	if !force && !mimicEnvironmentCheckedAt.IsZero() && time.Since(mimicEnvironmentCheckedAt) < 30*time.Second {
		return mimicEnvironmentCached
	}
	report := inspectMimicEnvironment(runtime.GOOS, commandExists, func() bool {
		_, err := os.Stat("/sys/module/mimic")
		return err == nil
	}, runMimicEnvironmentCommand)
	mimicEnvironmentCached = report
	mimicEnvironmentCheckedAt = time.Now()
	return report
}

func invalidateMimicEnvironmentCache() {
	mimicEnvironmentMu.Lock()
	mimicEnvironmentCached = mimicEnvironmentReport{}
	mimicEnvironmentCheckedAt = time.Time{}
	mimicEnvironmentMu.Unlock()
}

func mimicRuntimeEnvironment() mimicEnvironmentReport {
	report := mimicEnvironment(true)
	if !report.Available {
		return report
	}
	output, err := runMimicEnvironmentCommand("modprobe", "mimic")
	if err != nil {
		report.Available = false
		report.ModuleReady = false
		report.Status = "kernel-module-load-failed"
		report.Message = compactMimicEnvironmentOutput(output, 160)
		if report.Message == "" {
			report.Message = err.Error()
		}
		mimicEnvironmentMu.Lock()
		mimicEnvironmentCached = report
		mimicEnvironmentCheckedAt = time.Now()
		mimicEnvironmentMu.Unlock()
	}
	return report
}

func inspectMimicEnvironment(
	goos string,
	hasCommand func(string) bool,
	moduleLoaded func() bool,
	runCommand func(string, ...string) (string, error),
) mimicEnvironmentReport {
	report := mimicEnvironmentReport{Status: "unknown"}
	if goos != "linux" {
		report.Status = "unsupported-os"
		report.Message = "mimic requires Linux"
		return report
	}
	if !hasCommand("mimic") {
		report.Status = "command-missing"
		report.Message = "mimic command is not installed"
		return report
	}
	report.CommandReady = true
	if output, err := runCommand("mimic", "--version"); err == nil {
		report.Version = compactMimicEnvironmentOutput(output, 64)
	} else {
		report.Status = "command-unusable"
		report.Message = compactMimicEnvironmentOutput(output, 160)
		if report.Message == "" {
			report.Message = err.Error()
		}
		return report
	}
	if moduleLoaded() {
		report.ModuleReady = true
	} else {
		var output string
		var moduleErr error
		switch {
		case hasCommand("modprobe"):
			output, moduleErr = runCommand("modprobe", "-n", "mimic")
		case hasCommand("modinfo"):
			output, moduleErr = runCommand("modinfo", "mimic")
		default:
			report.Status = "module-check-unavailable"
			report.Message = "modprobe and modinfo are unavailable"
			return report
		}
		if moduleErr != nil {
			report.Status = "kernel-module-missing"
			report.Message = compactMimicEnvironmentOutput(output, 160)
			if report.Message == "" {
				report.Message = moduleErr.Error()
			}
			return report
		}
		report.ModuleReady = true
	}
	report.Available = report.CommandReady && report.ModuleReady
	report.Status = "ready"
	return report
}

func runMimicEnvironmentCommand(name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
	if ctx.Err() == context.DeadlineExceeded {
		return string(output), fmt.Errorf("%s check timed out", name)
	}
	return string(output), err
}

func compactMimicEnvironmentOutput(value string, limit int) string {
	text := strings.Join(strings.Fields(strings.TrimSpace(value)), " ")
	if limit > 0 && len(text) > limit {
		return text[:limit]
	}
	return text
}

func defaultIPv4NetworkInterface(raw []byte) string {
	lines := strings.Split(string(raw), "\n")
	for _, line := range lines[1:] {
		fields := strings.Fields(line)
		if len(fields) < 4 || fields[1] != "00000000" {
			continue
		}
		flags, err := strconv.ParseUint(fields[3], 16, 64)
		if err != nil || flags&0x1 == 0 {
			continue
		}
		name := strings.TrimSpace(fields[0])
		if validNetworkInterfaceName(name) {
			return name
		}
	}
	return ""
}

func defaultIPv6NetworkInterface(raw []byte) string {
	for _, line := range strings.Split(string(raw), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 10 || strings.Trim(fields[0], "0") != "" {
			continue
		}
		prefixLength, err := strconv.ParseUint(fields[1], 16, 16)
		if err != nil || prefixLength != 0 {
			continue
		}
		flags, err := strconv.ParseUint(fields[len(fields)-2], 16, 64)
		if err != nil || flags&0x1 == 0 {
			continue
		}
		name := strings.TrimSpace(fields[len(fields)-1])
		if validNetworkInterfaceName(name) {
			return name
		}
	}
	return ""
}

func heartbeat(cfg Config, forceReconcile ...bool) (heartbeatResult, error) {
	startedAt := time.Now()
	pruneAgentRuntimeData()
	ipv4, ipv6 := publicIPs()
	primaryIP := ipv4
	if primaryIP == "" {
		primaryIP = ipv6
	}
	dnsChanges := takePendingDNSChanges()
	memInfo := readMeminfo()
	memoryTotal := memTotalFrom(memInfo)
	memoryUsed := memUsedFrom(memInfo)
	swapTotal := swapTotalFrom(memInfo)
	swapUsed := swapUsedFrom(memInfo)
	diskUsageValue, diskUsed, diskTotal := diskStats()
	cpuUsageValue := cpuUsage()
	uptimeValue := uptime()
	receivedRevision, appliedRevision, receivedHash, appliedHash := desiredRevisionSnapshot()
	compactEnabled := compactAgentReports.Load()
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
	payload := map[string]any{}
	payload["agentBootId"] = agentBootID
	payload["agentBootedAt"] = time.Now().Unix() - uptimeValue
	payload["agentProcessId"] = os.Getpid()
	payload["agentProcessStartedAt"] = agentProcessStartedAt.Unix()
	payload["agentLastReceivedRevision"] = receivedRevision
	payload["agentLastAppliedRevision"] = appliedRevision
	payload["agentLastReceivedHash"] = receivedHash
	payload["agentLastAppliedHash"] = appliedHash
	payload["fxpEndpointEvents"] = fxpEndpointEventsSnapshot()
	payload["failoverEvents"] = failoverProxyEventsSnapshot()
	payload["failoverActive"] = failoverActiveSnapshot()
	payload["failoverStats"] = failoverStatsSnapshot()
	if compactEnabled {
		payload["m"] = []any{
			cpuUsageValue,
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
			uptimeValue,
		}
	} else {
		payload = map[string]any{
			"cpuUsage":     cpuUsageValue,
			"memoryUsage":  usagePercent(memoryUsed, memoryTotal),
			"memoryUsed":   memoryUsed,
			"memoryTotal":  memoryTotal,
			"swapUsage":    usagePercent(swapUsed, swapTotal),
			"swapUsed":     swapUsed,
			"swapTotal":    swapTotal,
			"networkIn":    netBytes(0),
			"networkOut":   netBytes(1),
			"diskUsage":    diskUsageValue,
			"diskUsed":     diskUsed,
			"diskTotal":    diskTotal,
			"uptime":       uptimeValue,
			"cpuInfo":      currentStatic.CPUInfo,
			"agentVersion": Version,
		}
	}
	if len(forceReconcile) > 0 && forceReconcile[0] {
		payload["forceReconcile"] = true
	}
	pluginVersions, pluginSyncSignatures := installedPluginInventory()
	payload["pluginVersions"] = pluginVersions
	payload["pluginSyncSignatures"] = pluginSyncSignatures
	payload["mimicEnvironment"] = mimicEnvironment(false)
	payload["fxpVersion"] = reportedFXPVersion()
	if (!compactEnabled || shouldReportStatic) && primaryIP != "" {
		payload["ip"] = primaryIP
	}
	if (!compactEnabled || shouldReportStatic) && ipv4 != "" {
		payload["ipv4"] = ipv4
	}
	if (!compactEnabled || shouldReportStatic) && ipv6 != "" {
		payload["ipv6"] = ipv6
	}
	if compactEnabled && shouldReportStatic {
		payload["cpuInfo"] = currentStatic.CPUInfo
		payload["agentVersion"] = Version
	}
	if currentStatic.DefaultNetworkInterface != "" {
		payload["defaultNetworkInterface"] = currentStatic.DefaultNetworkInterface
	}
	if currentStatic.PrivateIPv4 != "" {
		payload["privateIpv4"] = currentStatic.PrivateIPv4
	}
	if len(dnsChanges) > 0 {
		payload["dnsChanged"] = dnsChanges
	}
	if signatures := heartbeatStateSignaturePayload(); len(signatures) > 0 {
		payload["stateSignatures"] = signatures
	}
	if signature, localState := localRuntimeStateForHeartbeat(); signature != "" {
		payload["localStateSignature"] = signature
		if localState != nil {
			payload["localState"] = localState
		}
	}
	var resp heartbeatResp
	if err := postHeartbeat(cfg, "/api/agent/heartbeat", payload, &resp); err != nil {
		queuePendingDNSChanges(dnsChanges)
		var migrated migratedPanelError
		if errors.As(err, &migrated) {
			if switchToCommittedPanel(cfg, migrated.PanelURL, "", "old panel redirect") {
				return heartbeatResult{NextInterval: cfg.Interval}, nil
			}
		}
		return heartbeatResult{NextInterval: cfg.Interval}, err
	}
	logHeartbeatResponse("full", &resp, time.Since(startedAt))
	compactAgentReports.Store(resp.CompactReports)
	agentPresenceSupported.Store(resp.PresenceSupported)
	if resp.TrafficReportInterval > 0 {
		setActiveTrafficReportIntervalSeconds(resp.TrafficReportInterval)
	}
	preserveDNSChangesAfterHeartbeat(dnsChanges, resp.ReconciliationCoalesced)
	if shouldCommitHeartbeatStaticReport(compactEnabled, shouldReportStatic, resp.ReconciliationCoalesced) {
		currentStatic.ReportedAt = time.Now()
		currentStatic.Initialized = true
		heartbeatStaticReport = currentStatic
	}
	if handlePanelMigrationDirective(cfg, resp.PanelMigration) {
		return heartbeatResult{NextInterval: cfg.Interval}, nil
	}
	syncPanelURLFromResponse(resp.PanelURL)
	if resp.AgentUpgrade != nil {
		if handleLegacyPanelMigrationUpgrade(cfg, resp.AgentUpgrade) {
			return heartbeatResult{NextInterval: cfg.Interval}, nil
		}
		go selfUpgrade(cfg, resp.AgentUpgrade)
	}
	// Interactive tasks are independent from desired-state reconciliation. Accept
	// them before an early local-state return so a heartbeat response cannot drop
	// a task while the Agent is rebuilding its runtime snapshot.
	for _, task := range resp.LookingGlassTests {
		go handleLookingGlassTask(cfg, task)
	}
	for _, task := range resp.Iperf3Tasks {
		go handleIperf3Task(cfg, task)
	}
	for _, task := range resp.PluginTasks {
		enqueuePluginAgentTask(cfg, task)
	}
	if resp.RequestLocalState {
		requestLocalRuntimeStateUpload()
		next := resp.NextInterval
		if next <= 0 || next > 2 {
			next = 2
		}
		return heartbeatResult{NextInterval: next, ReconciliationCoalesced: resp.ReconciliationCoalesced, MetricsOnly: false}, nil
	}
	if resp.ReconciliationCoalesced {
		return heartbeatResult{NextInterval: resp.NextInterval, ReconciliationCoalesced: true, MetricsOnly: resp.MetricsOnly}, nil
	}
	state := applyHeartbeatState(resp)
	wakeAgentDNSWatchScheduler()
	rememberDesiredRunningRules(state.RunningRules)
	pendingActionPorts := map[string]bool{}
	actionDone := make([]<-chan struct{}, 0, len(resp.Actions)+len(desiredStateActions(resp.DesiredState)))
	for _, a := range desiredStateActions(resp.DesiredState) {
		if a.SourcePort > 0 && shouldReportActionStatus(a) {
			if key := actionProtectedPort(a); key != "" {
				pendingActionPorts[key] = true
			}
		}
	}
	for _, done := range syncDesiredState(cfg, resp.DesiredState) {
		actionDone = append(actionDone, done)
	}
	for _, a := range resp.Actions {
		if a.SourcePort > 0 && shouldReportActionStatus(a) {
			if key := actionProtectedPort(a); key != "" {
				pendingActionPorts[key] = true
			}
		}
		actionDone = append(actionDone, enqueueAction(cfg, a))
	}
	dependentSelfTests := make([]selfTest, 0, len(resp.SelfTests))
	for _, t := range resp.SelfTests {
		if !selfTestDependsOnRuntime(t) {
			enqueueSelfTest(cfg, t)
			continue
		}
		dependentSelfTests = append(dependentSelfTests, t)
	}
	enqueueSelfTestsAfterActions(cfg, dependentSelfTests, actionDone)
	activeActionPorts := snapshotProtectedActionPorts()
	for port := range activeActionPorts {
		pendingActionPorts[port] = true
	}
	syncRunningRuleState(state.RunningRules, pendingActionPorts)
	for _, r := range state.RunningRules {
		if r.SchedulerOnly {
			continue
		}
		if runningRuleStateWriteProtected(r, pendingActionPorts) {
			logVerbosef("running rule state write deferred for pending action rule=%d port=%d protocol=%s", r.RuleID, r.SourcePort, normalizeRuntimeProtocol(r.Protocol))
			continue
		}
		writeRunningRuleState(r)
		ensureCountingChainsIfNeeded(r)
	}
	syncProtocolGuardsAfterActions(cfg, state.GuardRules, actionDone)
	if resp.ForceTCPing {
		agentMetricsForceTCPing.Store(true)
	}
	wakeAgentMetricsScheduler()
	return heartbeatResult{NextInterval: resp.NextInterval, MetricsOnly: resp.MetricsOnly}, nil
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
		"failoverEvents":            failoverProxyEventsSnapshot(),
		"failoverActive":            failoverActiveSnapshot(),
		"failoverStats":             failoverStatsSnapshot(),
	}
	payload["mimicEnvironment"] = mimicEnvironment(false)
	payload["fxpVersion"] = reportedFXPVersion()
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
func handleLookingGlassTask(cfg Config, task lookingGlassTask) {
	result := runLookingGlassTask(cfg, task)
	if err := post(cfg, "/api/agent/looking-glass-result", map[string]any{"result": result}, &map[string]any{}); err != nil {
		if isTransientAgentCommError(err) {
			logAgentCommError("looking-glass-result", err)
		} else {
			logf("looking glass result report failed task=%s method=%s target=%s: %v", task.TaskID, task.Method, task.ResolvedAddress, err)
		}
	}
}

func reportLookingGlassProgress(cfg Config, result lookingGlassResult) {
	if err := post(cfg, "/api/agent/looking-glass-progress", map[string]any{"result": result}, &map[string]any{}); err != nil {
		if isTransientAgentCommError(err) {
			logAgentCommError("looking-glass-progress", err)
		} else {
			logf("looking glass progress report failed task=%s method=%s target=%s: %v", result.TaskID, result.Method, result.ResolvedAddress, err)
		}
	}
}

func handleIperf3Task(cfg Config, task iperf3Task) {
	result := runIperf3Task(cfg, task)
	if err := post(cfg, "/api/agent/iperf3-result", map[string]any{"result": result}, &map[string]any{}); err != nil {
		if isTransientAgentCommError(err) {
			logAgentCommError("iperf3-result", err)
		} else {
			logf("iperf3 result report failed task=%s op=%s port=%d: %v", task.TaskID, task.Op, task.Port, err)
		}
	}
}

func reportIperf3Result(cfg Config, result iperf3Result) {
	if result.UpdatedAt == "" {
		result.UpdatedAt = time.Now().Format(time.RFC3339Nano)
	}
	if err := post(cfg, "/api/agent/iperf3-result", map[string]any{"result": result}, &map[string]any{}); err != nil {
		if isTransientAgentCommError(err) {
			logAgentCommError("iperf3-status", err)
		} else {
			logf("iperf3 status report failed task=%s op=%s port=%d: %v", result.TaskID, result.Op, result.Port, err)
		}
	}
}

func runIperf3Task(cfg Config, task iperf3Task) iperf3Result {
	port := task.Port
	if port < 0 || port > 65535 {
		return iperf3Result{
			TaskID:    task.TaskID,
			Op:        task.Op,
			Port:      port,
			Status:    "error",
			Output:    "iperf3 端口必须在 1-65535 之间",
			Error:     "invalid iperf3 port",
			UpdatedAt: time.Now().Format(time.RFC3339Nano),
		}
	}
	if task.Op == "stop" {
		output := stopIperf3Server("用户从面板停止 iperf3 服务端")
		return iperf3Result{
			TaskID:    task.TaskID,
			Op:        task.Op,
			Port:      port,
			Status:    "stopped",
			Output:    output,
			UpdatedAt: time.Now().Format(time.RFC3339Nano),
		}
	}
	if port == 0 {
		selectedPort, err := pickAvailableIperf3Port()
		if err != nil {
			message := fmt.Sprintf("Agent 无法自动分配 iperf3 监听端口：%v", err)
			return iperf3Result{
				TaskID:    task.TaskID,
				Op:        task.Op,
				Port:      port,
				Status:    "error",
				Output:    message,
				Error:     message,
				UpdatedAt: time.Now().Format(time.RFC3339Nano),
			}
		}
		port = selectedPort
	}
	if _, err := exec.LookPath("iperf3"); err != nil {
		message := missingNetworkToolMessage("iperf3")
		return iperf3Result{
			TaskID:    task.TaskID,
			Op:        task.Op,
			Port:      port,
			Status:    "error",
			Output:    message,
			Error:     message,
			UpdatedAt: time.Now().Format(time.RFC3339Nano),
		}
	}
	if _, err := exec.LookPath("iperf3"); err != nil {
		message := "Agent 未安装 iperf3，请重新运行安装脚本或手动安装 iperf3"
		return iperf3Result{
			TaskID:    task.TaskID,
			Op:        task.Op,
			Port:      port,
			Status:    "error",
			Output:    message,
			Error:     message,
			UpdatedAt: time.Now().Format(time.RFC3339Nano),
		}
	}
	return startIperf3Server(cfg, task, port)
}

func startIperf3Server(cfg Config, task iperf3Task, port int) iperf3Result {
	iperf3Mu.Lock()
	if iperf3Server != nil {
		iperf3Server.stopLocked("启动新的 iperf3 服务端，已停止旧实例")
	}
	if err := checkIperf3PortAvailable(port); err != nil {
		iperf3Mu.Unlock()
		message := formatIperf3PortError(port, err)
		return iperf3Result{
			TaskID:    task.TaskID,
			Op:        task.Op,
			Port:      port,
			Status:    "error",
			Output:    message,
			Error:     message,
			UpdatedAt: time.Now().Format(time.RFC3339Nano),
		}
	}
	cmd := exec.Command("iperf3", "-s", "-p", strconv.Itoa(port))
	bindChildToAgent(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		iperf3Mu.Unlock()
		return iperf3StartError(task, port, err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		iperf3Mu.Unlock()
		return iperf3StartError(task, port, err)
	}
	if err := cmd.Start(); err != nil {
		iperf3Mu.Unlock()
		return iperf3StartError(task, port, err)
	}
	startedAt := time.Now()
	process := &iperf3Process{
		taskID:    task.TaskID,
		port:      port,
		cfg:       cfg,
		cmd:       cmd,
		startedAt: startedAt,
		output:    "iperf3 服务端已启动，等待客户端连接...",
		done:      make(chan struct{}),
	}
	process.lastActivity.Store(startedAt.UnixNano())
	iperf3Server = process
	iperf3Mu.Unlock()

	var wg sync.WaitGroup
	wg.Add(2)
	go process.readPipe(stdout, &wg)
	go process.readPipe(stderr, &wg)
	go process.watchIdleTimeout()
	go func() {
		err := cmd.Wait()
		wg.Wait()
		process.markExited(err)
	}()

	return iperf3Result{
		TaskID:    task.TaskID,
		Op:        "start",
		Port:      port,
		Status:    "running",
		Output:    process.currentOutput(),
		PID:       cmd.Process.Pid,
		StartedAt: startedAt.Format(time.RFC3339Nano),
		UpdatedAt: time.Now().Format(time.RFC3339Nano),
	}
}

func iperf3StartError(task iperf3Task, port int, err error) iperf3Result {
	if errors.Is(err, exec.ErrNotFound) {
		message := missingNetworkToolMessage("iperf3")
		return iperf3Result{
			TaskID:    task.TaskID,
			Op:        task.Op,
			Port:      port,
			Status:    "error",
			Output:    message,
			Error:     message,
			UpdatedAt: time.Now().Format(time.RFC3339Nano),
		}
	}
	message := fmt.Sprintf("iperf3 服务端启动失败：%v", err)
	return iperf3Result{
		TaskID:    task.TaskID,
		Op:        task.Op,
		Port:      port,
		Status:    "error",
		Output:    message,
		Error:     message,
		UpdatedAt: time.Now().Format(time.RFC3339Nano),
	}
}

func checkIperf3PortAvailable(port int) error {
	ln, err := net.Listen("tcp", net.JoinHostPort("", strconv.Itoa(port)))
	if err != nil {
		return err
	}
	return ln.Close()
}

func pickAvailableIperf3Port() (int, error) {
	ln, err := net.Listen("tcp", ":0")
	if err != nil {
		return 0, err
	}
	defer ln.Close()
	addr, ok := ln.Addr().(*net.TCPAddr)
	if !ok || addr.Port <= 0 {
		return 0, fmt.Errorf("无法读取自动分配的端口")
	}
	return addr.Port, nil
}

func formatIperf3PortError(port int, err error) string {
	message := strings.ToLower(err.Error())
	if strings.Contains(message, "address already in use") || strings.Contains(message, "only one usage of each socket address") {
		return fmt.Sprintf("iperf3 监听端口 %d 已被占用，请换一个端口，或在服务器上停止占用该端口的进程后重试。", port)
	}
	return fmt.Sprintf("iperf3 监听端口 %d 不可用：%v", port, err)
}

func stopIperf3Server(reason string) string {
	iperf3Mu.Lock()
	defer iperf3Mu.Unlock()
	if iperf3Server == nil {
		return "iperf3 服务端未在运行"
	}
	output := iperf3Server.stopLocked(reason)
	iperf3Server = nil
	return output
}

func runLookingGlassTask(cfg Config, task lookingGlassTask) lookingGlassResult {
	started := time.Now()
	result := lookingGlassResult{
		TaskID:            task.TaskID,
		Method:            task.Method,
		Target:            task.Target,
		ResolvedAddress:   task.ResolvedAddress,
		ResolvedAddresses: task.ResolvedAddresses,
		StartedAt:         started.Format(time.RFC3339Nano),
	}
	result.Output = fmt.Sprintf("Agent 已开始执行 %s 测试\n目标: %s", task.Method, task.ResolvedAddress)
	reportLookingGlassProgress(cfg, result)
	if task.Method == "tcp" {
		port := task.Port
		if port <= 0 {
			port = 443
		}
		result.Port = port
		result.Output = fmt.Sprintf("正在测试 TCP %s ...", net.JoinHostPort(task.ResolvedAddress, strconv.Itoa(port)))
		result.DurationMs = int(time.Since(started).Milliseconds())
		reportLookingGlassProgress(cfg, result)
		latency, ok := tcpLatency(task.ResolvedAddress, port, 10*time.Second)
		result.DurationMs = int(time.Since(started).Milliseconds())
		if ok {
			code := 0
			result.ExitCode = &code
			result.Output = fmt.Sprintf("TCP %s 连接成功\n耗时: %d ms", net.JoinHostPort(task.ResolvedAddress, strconv.Itoa(port)), latency)
		} else {
			code := 1
			result.ExitCode = &code
			result.Output = fmt.Sprintf("TCP %s 连接失败或超时\n耗时: %d ms", net.JoinHostPort(task.ResolvedAddress, strconv.Itoa(port)), result.DurationMs)
		}
		result.FinishedAt = time.Now().Format(time.RFC3339Nano)
		return result
	}

	timeout := 30 * time.Second
	if task.Method == "iperf3-client" {
		// 跑满 -t 秒才出汇总，再给建连和收尾留一点。
		timeout = time.Duration(iperf3ClientSeconds(task))*time.Second + 20*time.Second
		result.Port = iperf3ClientPort(task)
	}
	command, args, err := lookingGlassCommand(task.Method, task.ResolvedAddress)
	if task.Method == "iperf3-client" {
		command, args, err = iperf3ClientCommand(task)
	}
	if err != nil {
		code := 1
		result.ExitCode = &code
		result.Error = err.Error()
		result.Output = err.Error()
		result.DurationMs = int(time.Since(started).Milliseconds())
		result.FinishedAt = time.Now().Format(time.RFC3339Nano)
		return result
	}
	if _, err := exec.LookPath(command); err != nil {
		code := 1
		message := missingNetworkToolMessage(command)
		result.ExitCode = &code
		result.Error = message
		result.Output = message
		result.DurationMs = int(time.Since(started).Milliseconds())
		result.FinishedAt = time.Now().Format(time.RFC3339Nano)
		return result
	}
	progress := func(output string, durationMs int) {
		result.Output = output
		result.DurationMs = durationMs
		reportLookingGlassProgress(cfg, result)
	}
	output, exitCode, timedOut := runLookingGlassCommand(command, args, timeout, progress)
	result.Output = output
	if strings.TrimSpace(result.Output) == "" {
		result.Output = "命令没有返回输出"
	}
	result.ExitCode = exitCode
	result.TimedOut = timedOut
	result.DurationMs = int(time.Since(started).Milliseconds())
	result.FinishedAt = time.Now().Format(time.RFC3339Nano)
	return result
}

func lookingGlassCommand(method string, host string) (string, []string, error) {
	ipv6 := strings.HasSuffix(method, "6")
	switch method {
	case "ping", "ping6":
		return "ping", []string{mapBool(ipv6, "-6", "-4"), "-c", "4", "-W", "3", host}, nil
	case "traceroute", "traceroute6":
		return "traceroute", []string{mapBool(ipv6, "-6", "-4"), "-n", "-m", "20", "-w", "2", host}, nil
	case "mtr", "mtr6":
		return "mtr", []string{mapBool(ipv6, "-6", "-4"), "--report", "--report-cycles", "10", "--no-dns", host}, nil
	default:
		return "", nil, fmt.Errorf("不支持的网络测试方法: %s", method)
	}
}

/*
iperf3 客户端：从这台 Agent 往目标上的 iperf3 服务端跑一次带宽测试，面板里另一台
主机一键开的服务端就是典型的对端。面板给的参数在这里再收一次边界，免得旧面板或
手改的任务把 -P 开到几百。

--forceflush 让 iperf3 在 stdout 不是终端时也逐秒刷出中间行，面板上才看得到实时
速率；iperf 3.1 起就有这个参数。-f m 固定用 Mbits/sec 显示，各机器输出一致。
*/
const (
	iperf3ClientDefaultPort    = 5201
	iperf3ClientDefaultStreams = 4
	iperf3ClientMaxStreams     = 16
	iperf3ClientDefaultSeconds = 10
	iperf3ClientMinSeconds     = 5
	iperf3ClientMaxSeconds     = 30
)

func iperf3ClientPort(task lookingGlassTask) int {
	if task.Port <= 0 || task.Port > 65535 {
		return iperf3ClientDefaultPort
	}
	return task.Port
}

func iperf3ClientStreams(task lookingGlassTask) int {
	if task.Streams <= 0 {
		return iperf3ClientDefaultStreams
	}
	if task.Streams > iperf3ClientMaxStreams {
		return iperf3ClientMaxStreams
	}
	return task.Streams
}

func iperf3ClientSeconds(task lookingGlassTask) int {
	if task.Seconds <= 0 {
		return iperf3ClientDefaultSeconds
	}
	if task.Seconds < iperf3ClientMinSeconds {
		return iperf3ClientMinSeconds
	}
	if task.Seconds > iperf3ClientMaxSeconds {
		return iperf3ClientMaxSeconds
	}
	return task.Seconds
}

func iperf3ClientCommand(task lookingGlassTask) (string, []string, error) {
	host := strings.TrimSpace(task.ResolvedAddress)
	if host == "" {
		return "", nil, fmt.Errorf("iperf3 客户端测试缺少目标地址")
	}
	args := []string{
		"-c", host,
		"-p", strconv.Itoa(iperf3ClientPort(task)),
		"-P", strconv.Itoa(iperf3ClientStreams(task)),
		"-t", strconv.Itoa(iperf3ClientSeconds(task)),
		"-i", "1",
		"-f", "m",
		"--forceflush",
	}
	if task.Family == 6 || strings.Contains(host, ":") {
		args = append(args, "-6")
	} else if task.Family == 4 {
		args = append(args, "-4")
	}
	if task.Reverse {
		args = append(args, "-R")
	}
	if task.UDP {
		// UDP 的 -b 默认只有 1 Mbit/s，必须显式给；0 表示不限速（iperf3 自己的约定）。
		args = append(args, "-u", "-b", strconv.Itoa(iperf3ClientUDPMbps(task))+"M")
	}
	return "iperf3", args, nil
}

// iperf3ClientUDPMbps 是 UDP 模式每条流的发送速率（Mbit/s），0 = 不限；上限 100 Gbit/s。
func iperf3ClientUDPMbps(task lookingGlassTask) int {
	if task.UDPMbps <= 0 {
		return 0
	}
	if task.UDPMbps > 100000 {
		return 100000
	}
	return task.UDPMbps
}

func missingNetworkToolMessage(tool string) string {
	switch tool {
	case "ping":
		return "Agent 主机缺少 ping 工具，无法执行 Ping 测试。\n请在该 Agent 主机安装后重试：Debian/Ubuntu: apt install iputils-ping；RHEL/CentOS: yum install iputils；Alpine: apk add iputils。"
	case "traceroute":
		return "Agent 主机缺少 traceroute 工具，无法执行 Traceroute 测试。\n请在该 Agent 主机安装后重试：Debian/Ubuntu: apt install traceroute；RHEL/CentOS: yum install traceroute；Alpine: apk add traceroute。"
	case "mtr":
		return "Agent 主机缺少 mtr 工具，无法执行 MTR 测试。\n请在该 Agent 主机安装后重试：Debian/Ubuntu: apt install mtr-tiny；RHEL/CentOS: yum install mtr；Alpine: apk add mtr。"
	case "iperf3":
		return "Agent 主机缺少 iperf3，无法启动 iperf3 服务端测试。\n请在该 Agent 主机安装后重试：Debian/Ubuntu: apt install iperf3；RHEL/CentOS: yum install iperf3；Alpine: apk add iperf3。"
	default:
		return fmt.Sprintf("Agent 主机缺少 %s 工具，无法执行该网络测试。请在该 Agent 主机安装 %s 后重试。", tool, tool)
	}
}

// lookingGlassProgressInterval 是输出行触发的进度回报的最小间隔。
const lookingGlassProgressInterval = time.Second

func runLookingGlassCommand(name string, args []string, timeout time.Duration, onProgress func(string, int)) (string, *int, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	started := time.Now()
	cmd := exec.CommandContext(ctx, name, args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		code := 1
		return err.Error(), &code, false
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		code := 1
		return err.Error(), &code, false
	}

	var mu sync.Mutex
	var output strings.Builder
	appendLine := func(line string) {
		mu.Lock()
		defer mu.Unlock()
		if output.Len() >= 32000 {
			return
		}
		if output.Len() > 0 {
			output.WriteByte('\n')
		}
		output.WriteString(line)
		if output.Len() > 32000 {
			text := output.String()
			output.Reset()
			output.WriteString(text[:32000])
			output.WriteString("\n... 输出已截断")
		}
	}
	currentOutput := func() string {
		mu.Lock()
		defer mu.Unlock()
		return strings.TrimSpace(output.String())
	}
	// 每次进度回报都是一次同步的 HTTP POST。ping / mtr 一共没几行无所谓，iperf3
	// 开 16 条流、--forceflush 之后每秒十几行：逐行回报会让读管道的协程排在网络
	// 往返后面，iperf3 早跑完了这边还在一条条发，面板也白白多收几百个快照。所以
	// 输出行触发的回报每秒最多一次（下面的定时器本来就每秒报一次），最后一次
	// 完整输出随结果一起发，不会漏。
	var lastProgressAt atomic.Int64
	report := func(fallback string) {
		text := currentOutput()
		if text == "" {
			text = fallback
		}
		lastProgressAt.Store(time.Now().UnixNano())
		onProgress(text, int(time.Since(started).Milliseconds()))
	}
	reportThrottled := func(fallback string) {
		now := time.Now().UnixNano()
		last := lastProgressAt.Load()
		if now-last < int64(lookingGlassProgressInterval) {
			return
		}
		if !lastProgressAt.CompareAndSwap(last, now) {
			return // 另一条管道的协程刚报过
		}
		text := currentOutput()
		if text == "" {
			text = fallback
		}
		onProgress(text, int(time.Since(started).Milliseconds()))
	}

	if err := cmd.Start(); err != nil {
		code := 1
		if errors.Is(err, exec.ErrNotFound) {
			return missingNetworkToolMessage(name), &code, false
		}
		return fmt.Sprintf("网络测试工具 %s 启动失败：%v", name, err), &code, false
	}

	var wg sync.WaitGroup
	readPipe := func(r io.Reader) {
		defer wg.Done()
		scanner := bufio.NewScanner(r)
		scanner.Buffer(make([]byte, 0, 4096), 1024*1024)
		for scanner.Scan() {
			appendLine(scanner.Text())
			reportThrottled("命令正在执行，等待输出...")
		}
	}
	wg.Add(2)
	go readPipe(stdout)
	go readPipe(stderr)

	ticker := time.NewTicker(time.Second)
	readDone := make(chan struct{})
	go func() {
		wg.Wait()
		close(readDone)
	}()

	running := true
	for running {
		select {
		case <-ticker.C:
			report(fmt.Sprintf("命令正在执行，已运行 %ds...", int(time.Since(started).Seconds())))
		case <-readDone:
			running = false
		}
	}
	ticker.Stop()
	waitErr := cmd.Wait()

	outputText := currentOutput()
	timedOut := ctx.Err() == context.DeadlineExceeded
	code := 0
	if waitErr != nil {
		code = 1
		if exitErr, ok := waitErr.(*exec.ExitError); ok {
			code = exitErr.ExitCode()
		}
		if strings.TrimSpace(outputText) == "" {
			outputText = waitErr.Error()
		}
	}
	if timedOut && !strings.Contains(outputText, "超时") {
		if outputText != "" {
			outputText += "\n"
		}
		outputText += "命令执行超时"
	}
	report(outputText)
	return strings.TrimSpace(outputText), &code, timedOut
}

func mapBool(ok bool, yes string, no string) string {
	if ok {
		return yes
	}
	return no
}

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

func decodeEventData(raw string, token string, out any) error {
	return decodeEventDataForPanel(raw, token, "", "", out)
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
		runRuntimeShellBatch := func(commands []string, phase string) bool {
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
		var managedConfigTx *managedConfigTransaction
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
			ok = runShellBatch(a.Commands) && ok
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
			actionMessage.set(message)
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
			ok = runShellBatch(a.Commands) && ok
			if shouldReportActionStatus(a) && !actionRequiresKernelForwardConsistency(a) {
				removeState(a.SourcePort)
			}
		}
		if releaseRuntimeGate != nil {
			releaseRuntimeGate()
		}
	}
	if ok && !skippedStaleRemove && actionRequiresKernelForwardConsistency(a) && !newKernelForwardSnapshot().desiredActionConsistent(a) {
		ok = false
		message := fmt.Sprintf("kernel firewall state mismatch after %s", strings.TrimSpace(a.Op))
		actionMessage.set(message)
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

func mimicRuntimeDiagnostics() string {
	services := managedMimicServicesFromLocalConfig()
	if len(services) == 0 {
		return "services=none"
	}
	parts := make([]string, 0, len(services))
	for _, name := range services {
		ok, reason := mimicRuntimeServiceHealth(name)
		parts = append(parts, fmt.Sprintf("%s healthy=%v %s", name, ok, reason))
	}
	return compactLogOutput(strings.Join(parts, " | "))
}

func requiredRuntimeServicesFromLocalConfig() []string {
	services := requiredSharedRuntimeServicesFromLocalConfig()
	services = append(services, managedMimicServicesFromLocalConfig()...)
	return services
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

func managedMimicServicesFromLocalConfig() []string {
	return managedMimicServicesFromConfigDir(mimicConfigDir)
}

func managedMimicServicesFromConfigDir(configDir string) []string {
	entries, err := os.ReadDir(configDir)
	if err != nil {
		return nil
	}
	services := []string{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".conf") {
			continue
		}
		path := filepath.Join(configDir, entry.Name())
		raw, err := os.ReadFile(path)
		if err != nil || !strings.Contains(string(raw), "# Managed by ForwardX") {
			continue
		}
		iface := strings.TrimSuffix(entry.Name(), ".conf")
		if !validNetworkInterfaceName(iface) {
			continue
		}
		services = append(services, "mimic@"+iface)
	}
	sort.Strings(services)
	return services
}

func mimicRuntimeServiceHealthy(name string) bool {
	ok, _ := mimicRuntimeServiceHealth(name)
	return ok
}

func mimicConnectionState(output string) string {
	text := strings.ToLower(output)
	switch {
	case strings.Contains(text, "established"):
		return "established"
	case strings.Contains(text, "connecting"), strings.Contains(text, "syn sent"), strings.Contains(text, "syn received"):
		return "connecting"
	case strings.Contains(text, "no active connection"), strings.Contains(text, "waiting"):
		return "waiting"
	case strings.Contains(text, "idle"):
		return "idle"
	default:
		return "unknown"
	}
}

func mimicHooksReady(iface string) (bool, string) {
	if !validNetworkInterfaceName(iface) {
		return false, "invalid-interface"
	}
	parts := []string{}
	hasXDP := false
	hasTCEgress := false
	if commandExists("ip") {
		if out, err := commandCombinedOutputWithTimeout(3*time.Second, "ip", "-details", "link", "show", "dev", iface); err == nil && strings.Contains(strings.ToLower(string(out)), "xdp") {
			hasXDP = true
			parts = append(parts, "xdp")
		}
	}
	if commandExists("tc") {
		if out, err := commandCombinedOutputWithTimeout(3*time.Second, "tc", "filter", "show", "dev", iface, "egress"); err == nil && strings.TrimSpace(string(out)) != "" {
			hasTCEgress = true
			parts = append(parts, "tc-egress")
		}
	}
	return hasXDP && hasTCEgress, strings.Join(parts, ",")
}

func mimicRuntimeServiceReportFor(name string) localRuntimeServiceState {
	report := localRuntimeServiceState{Name: name, HasWork: true, Status: "unknown", ConnectionState: "unknown"}
	iface := strings.TrimPrefix(name, "mimic@")
	if validNetworkInterfaceName(iface) {
		hooksReady, hooks := mimicHooksReady(iface)
		report.HooksReady = new(bool)
		*report.HooksReady = hooksReady
		if hooks != "" {
			report.Message = "hooks=" + hooks
		}
	}
	ok, message := mimicRuntimeServiceHealth(name)
	report.Active = ok
	if strings.TrimSpace(message) != "" {
		report.Message = strings.TrimSpace(strings.TrimSpace(report.Message) + " " + compactLogOutput(message))
	}
	if !ok {
		report.Status = "unavailable"
		return report
	}
	report.ConnectionState = mimicConnectionState(message)
	report.Status = report.ConnectionState
	if report.Status == "unknown" {
		report.Status = "active"
	}
	return report
}

func mimicRuntimeServiceHealth(name string) (bool, string) {
	if !strings.HasPrefix(name, "mimic@") {
		return false, "invalid-service-name"
	}
	if !managedServiceActive(name) {
		return false, "service-inactive"
	}
	iface := strings.TrimPrefix(name, "mimic@")
	if !validNetworkInterfaceName(iface) {
		return false, "invalid-interface"
	}
	if !commandExists("mimic") {
		return false, "mimic-command-missing"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "mimic", "show", iface).CombinedOutput()
	output := compactLogOutput(string(out))
	if ctx.Err() == context.DeadlineExceeded {
		return false, "mimic-show-timeout"
	}
	if err != nil {
		if output == "" {
			output = err.Error()
		}
		return false, "mimic-show-failed " + output
	}
	if output == "" {
		output = "mimic-show-ok"
	}
	hooksReady, hooks := mimicHooksReady(iface)
	if !hooksReady {
		if hooks == "" {
			hooks = "none"
		}
		return false, "mimic-hooks-unavailable hooks=" + hooks
	}
	network := ensureMimicNetworkCompatibility(iface)
	if strings.Contains(network, "ethtool-missing") || strings.Contains(network, "still-on:") || strings.Contains(network, "inspect-failed") || strings.Contains(network, "state-failed:") {
		if shouldLogAgentReport("mimic-network:"+iface, agentReportLogInterval) {
			logf("mimic network compatibility warning interface=%s %s", iface, network)
		}
	}
	return true, strings.TrimSpace(output + " network=" + network)
}

func validNetworkInterfaceName(name string) bool {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 32 {
		return false
	}
	for _, r := range name {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') ||
			r == '_' || r == '-' || r == '.' || r == ':' || r == '@' {
			continue
		}
		return false
	}
	return true
}

func gostRuntimeConfigHasServices(path string) bool {
	raw, err := os.ReadFile(path)
	if err != nil || len(raw) == 0 {
		return false
	}
	var cfg struct {
		Services []json.RawMessage `json:"services"`
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return false
	}
	return len(cfg.Services) > 0
}

func nginxRuntimeConfigHasServers(path string) bool {
	raw, err := os.ReadFile(path)
	if err != nil || len(raw) == 0 {
		return false
	}
	text := string(raw)
	return strings.Contains(text, "server {") || strings.Contains(text, "server{")
}

func logGostRuntimeProxySummary(path string, label string) {
	b, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var cfg struct {
		Services []struct {
			Name     string         `json:"name"`
			Addr     string         `json:"addr"`
			Metadata map[string]any `json:"metadata"`
			Handler  struct {
				Type     string         `json:"type"`
				Chain    string         `json:"chain"`
				Metadata map[string]any `json:"metadata"`
			} `json:"handler"`
			Listener struct {
				Type string `json:"type"`
			} `json:"listener"`
			Forwarder struct {
				Nodes []struct {
					Name string `json:"name"`
					Addr string `json:"addr"`
				} `json:"nodes"`
			} `json:"forwarder"`
		} `json:"services"`
		Chains []struct {
			Name string `json:"name"`
			Hops []struct {
				Name     string         `json:"name"`
				Metadata map[string]any `json:"metadata"`
				Nodes    []struct {
					Name     string         `json:"name"`
					Addr     string         `json:"addr"`
					Metadata map[string]any `json:"metadata"`
				} `json:"nodes"`
			} `json:"hops"`
		} `json:"chains"`
	}
	if err := json.Unmarshal(b, &cfg); err != nil {
		logf("proxy-debug %s config parse failed path=%s: %v", label, path, err)
		return
	}
	lines := make([]string, 0)
	for _, svc := range cfg.Services {
		receive := hasProxyProtocolMetadata(svc.Metadata)
		send := hasProxyProtocolMetadata(svc.Handler.Metadata)
		targets := make([]string, 0, len(svc.Forwarder.Nodes))
		for _, node := range svc.Forwarder.Nodes {
			targets = append(targets, fmt.Sprintf("%s@%s", emptyDash(node.Name), emptyDash(node.Addr)))
		}
		if len(targets) == 0 {
			targets = append(targets, "-")
		}
		if receive || send || strings.TrimSpace(svc.Handler.Chain) != "" {
			lines = append(lines, fmt.Sprintf(
				"service=%s addr=%s listener=%s handler=%s chain=%s acceptProxy=%v sendProxy=%v targets=%s",
				emptyDash(svc.Name),
				emptyDash(svc.Addr),
				emptyDash(svc.Listener.Type),
				emptyDash(svc.Handler.Type),
				emptyDash(svc.Handler.Chain),
				receive,
				send,
				strings.Join(targets, ","),
			))
		}
	}
	for _, chain := range cfg.Chains {
		for _, hop := range chain.Hops {
			hopSend := hasProxyProtocolMetadata(hop.Metadata)
			nodeSend := false
			targets := make([]string, 0, len(hop.Nodes))
			for _, node := range hop.Nodes {
				if hasProxyProtocolMetadata(node.Metadata) {
					nodeSend = true
				}
				targets = append(targets, fmt.Sprintf("%s@%s", emptyDash(node.Name), emptyDash(node.Addr)))
			}
			if !hopSend && !nodeSend {
				continue
			}
			lines = append(lines, fmt.Sprintf(
				"chain=%s hop=%s sendProxy=%v hopProxy=%v nodeProxy=%v nodes=%s",
				emptyDash(chain.Name),
				emptyDash(hop.Name),
				hopSend || nodeSend,
				hopSend,
				nodeSend,
				strings.Join(targets, ","),
			))
		}
	}
	sort.Strings(lines)
	signature := strings.Join(lines, "\n")
	runtimeProxyLogMu.Lock()
	if runtimeProxyLogSignatures[label] == signature {
		runtimeProxyLogMu.Unlock()
		return
	}
	runtimeProxyLogSignatures[label] = signature
	runtimeProxyLogMu.Unlock()
	if len(lines) == 0 {
		logVerbosef("proxy-debug %s no proxyProtocol entries services=%d chains=%d path=%s", label, len(cfg.Services), len(cfg.Chains), path)
		return
	}
	logVerbosef("proxy-debug %s proxyProtocol summary entries=%d path=%s", label, len(lines), path)
	for _, line := range lines {
		logVerbosef("proxy-debug %s %s", label, line)
	}
}

func hasProxyProtocolMetadata(metadata map[string]any) bool {
	if len(metadata) == 0 {
		return false
	}
	value, ok := metadata["proxyProtocol"]
	if !ok {
		return false
	}
	switch v := value.(type) {
	case bool:
		return v
	case float64:
		return v != 0
	case string:
		text := strings.ToLower(strings.TrimSpace(v))
		return text != "" && text != "0" && text != "false"
	default:
		return value != nil
	}
}

func emptyDash(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "-"
	}
	return value
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
	if a.Failover != nil {
		if raw, err := json.Marshal(a.Failover); err == nil {
			write(string(raw))
		}
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

func managedRuntimeConfigServiceCount(path string) (int, bool) {
	if strings.HasSuffix(path, ".json") {
		return gostRuntimeConfigServiceCount(path)
	}
	return nginxRuntimeConfigServiceCount(path)
}

func gostRuntimeConfigUsesPort(path string, port int) bool {
	addrs, ok := readGostRuntimeServiceAddrs(path)
	if !ok {
		return false
	}
	for _, addr := range addrs {
		if addrUsesPort(addr, port) {
			return true
		}
	}
	return false
}

func gostRuntimeConfigServiceCount(path string) (int, bool) {
	addrs, ok := readGostRuntimeServiceAddrs(path)
	return len(addrs), ok
}

type runtimeListenConfig struct {
	Addr     string
	Protocol string
}

func readGostRuntimeServiceListens(path string) ([]runtimeListenConfig, bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, false
	}
	var cfg struct {
		Services []struct {
			Addr     string `json:"addr"`
			Listener struct {
				Type string `json:"type"`
			} `json:"listener"`
		} `json:"services"`
	}
	if err := json.Unmarshal(b, &cfg); err != nil {
		return nil, false
	}
	listens := make([]runtimeListenConfig, 0, len(cfg.Services))
	for _, svc := range cfg.Services {
		protocol := strings.TrimSpace(svc.Listener.Type)
		if protocol == "" {
			protocol = protocolFromListenAddr(svc.Addr)
		}
		listens = append(listens, runtimeListenConfig{Addr: svc.Addr, Protocol: protocol})
	}
	return listens, true
}

func readGostRuntimeServiceAddrs(path string) ([]string, bool) {
	listens, ok := readGostRuntimeServiceListens(path)
	if !ok {
		return nil, false
	}
	addrs := make([]string, 0, len(listens))
	for _, listen := range listens {
		addrs = append(addrs, listen.Addr)
	}
	return addrs, true
}

func protocolFromListenAddr(addr string) string {
	value := strings.ToLower(strings.TrimSpace(addr))
	switch {
	case strings.HasPrefix(value, "udp://"):
		return "udp"
	case strings.HasPrefix(value, "tcp://"):
		return "tcp"
	default:
		return "tcp"
	}
}

func nginxRuntimeListenConfigs(path string) ([]runtimeListenConfig, bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, false
	}
	re := regexp.MustCompile(`(?m)\blisten\s+([^;]+);`)
	matches := re.FindAllStringSubmatch(string(b), -1)
	listens := make([]runtimeListenConfig, 0, len(matches))
	for _, match := range matches {
		if len(match) < 2 {
			continue
		}
		fields := strings.Fields(match[1])
		if len(fields) == 0 {
			continue
		}
		protocol := "tcp"
		for _, field := range fields[1:] {
			if strings.EqualFold(strings.TrimSpace(field), "udp") {
				protocol = "udp"
				break
			}
		}
		listens = append(listens, runtimeListenConfig{Addr: fields[0], Protocol: protocol})
	}
	return listens, true
}

func nginxRuntimeListenAddrs(path string) ([]string, bool) {
	listens, ok := nginxRuntimeListenConfigs(path)
	if !ok {
		return nil, false
	}
	addrs := make([]string, 0, len(listens))
	for _, listen := range listens {
		addrs = append(addrs, listen.Addr)
	}
	return addrs, true
}

func nginxRuntimeConfigUsesPort(path string, port int) bool {
	addrs, ok := nginxRuntimeListenAddrs(path)
	if !ok {
		return false
	}
	for _, addr := range addrs {
		if addrUsesPort(addr, port) {
			return true
		}
	}
	return false
}

func nginxRuntimeConfigServiceCount(path string) (int, bool) {
	addrs, ok := nginxRuntimeListenAddrs(path)
	return len(addrs), ok
}

func addrUsesPort(addr string, port int) bool {
	text := strings.TrimSpace(addr)
	if text == "" || port <= 0 {
		return false
	}
	if text == ":"+strconv.Itoa(port) {
		return true
	}
	_, rawPort, err := net.SplitHostPort(text)
	if err != nil {
		return strings.HasSuffix(text, ":"+strconv.Itoa(port))
	}
	value, err := strconv.Atoi(rawPort)
	return err == nil && value == port
}

func managedGostConfigPathsForListenPort(port int) []string {
	paths := map[string]bool{}
	for _, protocol := range []string{"tcp", "udp"} {
		for _, path := range managedGostConfigPathsForListenPortProtocol(port, protocol) {
			paths[path] = true
		}
	}
	result := make([]string, 0, len(paths))
	for path := range paths {
		result = append(result, path)
	}
	sort.Strings(result)
	return result
}

func managedGostConfigPathsForListenPortProtocol(port int, protocol string) []string {
	paths := map[string]bool{}
	for _, pid := range listenPortOwnerPIDsForProtocol(port, protocol) {
		cmdline, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/cmdline")
		if err != nil {
			continue
		}
		cmd := strings.ReplaceAll(string(cmdline), "\x00", " ")
		for _, item := range managedRuntimeConfigs() {
			if strings.Contains(cmd, item.path) {
				paths[item.path] = true
			}
		}
	}
	result := make([]string, 0, len(paths))
	for path := range paths {
		result = append(result, path)
	}
	sort.Strings(result)
	return result
}

func managedGostServiceNameForConfig(path string) string {
	for _, item := range managedRuntimeConfigs() {
		if path == item.path {
			return item.service
		}
	}
	return ""
}

func managedRuntimeConfigs() []struct {
	path    string
	service string
} {
	return []struct {
		path    string
		service string
	}{
		{runtimeConfigPath, runtimeServiceName},
		{tunnelRuntimeConfigPath, tunnelRuntimeServiceName},
		{nginxConfigPath, nginxServiceName},
		{legacyRuntimeConfigPath, runtimeServiceName},
		{legacyTunnelRuntimeConfigPath, tunnelRuntimeServiceName},
		{legacyGostConfigPath, legacyGostServiceName},
		{legacyTunnelConfigPath, legacyTunnelServiceName},
	}
}

func shouldReportActionStatus(a action) bool {
	return a.ReportStatus == nil || *a.ReportStatus
}

func listenPortOwnerPIDs(port int) []int {
	seen := map[int]bool{}
	for _, protocol := range []string{"tcp", "udp"} {
		for _, pid := range listenPortOwnerPIDsForProtocol(port, protocol) {
			seen[pid] = true
		}
	}
	pids := make([]int, 0, len(seen))
	for pid := range seen {
		pids = append(pids, pid)
	}
	sort.Ints(pids)
	return pids
}

func listenPortOwnerPIDsForProtocol(port int, protocol string) []int {
	if port <= 0 {
		return nil
	}
	if _, err := exec.LookPath("ss"); err != nil {
		return nil
	}
	portText := strconv.Itoa(port)
	args := []string{"-H", "-ltnp"}
	if normalizeRuntimeProtocol(protocol) == "udp" {
		args = []string{"-H", "-lunp"}
	}
	out, _ := commandCombinedOutputWithTimeout(3*time.Second, "ss", args...)
	text := filterListenPortLines(string(out), portText)
	if strings.TrimSpace(text) == "" {
		return nil
	}
	re := regexp.MustCompile(`pid=([0-9]+)`)
	seen := map[int]bool{}
	var pids []int
	for _, match := range re.FindAllStringSubmatch(text, -1) {
		pid, err := strconv.Atoi(match[1])
		if err != nil || pid <= 0 || seen[pid] {
			continue
		}
		seen[pid] = true
		pids = append(pids, pid)
	}
	sort.Ints(pids)
	return pids
}

type runtimeListenSnapshot struct {
	tcpPorts map[int][]string
	udpPorts map[int][]string
	usable   bool
	// lazy 不为空时端口表在第一次查询时才加载（newRuntimeListenSnapshot 建的都是这种）；
	// 测试里直接构造的快照没有它，按构造时的内容原样使用。
	lazy *runtimeListenLazyLoad
}

/*
就绪检查里的进程信息（ss 的 -p）确实有用：带进程名的检查（gost / nginx / forwardx-fxp…）
要看端口是不是被对的进程占着。但 -p 会让 ss 遍历每个进程的每个文件描述符，连接多的机器上
是就绪检查里最重的一步，而以前不管有没有查询、要不要进程名，每次建快照都先跑一遍。

现在按需：第一次查询时才跑 ss，这次查询要进程名才带 -p；之前不带 -p 加载过、后来某个带
进程名的查询命中了正在监听的端口，再补跑一次带 -p 的。查一个根本没在监听的端口用不着进程
信息（结果一定是没就绪），不会触发 -p。每个查询看到的内容和以前一次 ss -ltnup 的结果一致：
不带 -p 只少了 users:(...) 那一列，端口集合相同。
*/
type runtimeListenLazyLoad struct {
	mu     sync.Mutex
	loaded bool
	// owners：当前端口表带着进程信息，或者已经不可能拿到（ss 不可用、走了 /proc 兜底）。
	owners bool
}

// runtimeListenSSOutput 测试里替换。
var runtimeListenSSOutput = func(withOwners bool) (string, bool) {
	if _, err := exec.LookPath("ss"); err != nil {
		return "", false
	}
	args := []string{"-H", "-ltnu"}
	if withOwners {
		args = []string{"-H", "-ltnup"}
	}
	out, err := commandCombinedOutputWithTimeout(3*time.Second, "ss", args...)
	if err != nil {
		return "", false
	}
	return string(out), true
}

func newRuntimeListenSnapshot() *runtimeListenSnapshot {
	return &runtimeListenSnapshot{
		tcpPorts: map[int][]string{},
		udpPorts: map[int][]string{},
		lazy:     &runtimeListenLazyLoad{},
	}
}

// loadLocked 跑一次 ss 并替换端口表（整张换掉，已经交出去的切片不会被改）。upgrade 为 true
// 是补拿进程信息：这次 ss 失败就保留原来的端口表，不再重试。
func (s *runtimeListenSnapshot) loadLocked(withOwners bool, upgrade bool) {
	fresh := &runtimeListenSnapshot{tcpPorts: map[int][]string{}, udpPorts: map[int][]string{}}
	if out, ok := runtimeListenSSOutput(withOwners); ok {
		fresh.parseSSListenOutput(out)
	}
	owners := withOwners
	if !fresh.usable {
		if upgrade {
			s.lazy.owners = true
			return
		}
		fresh.parseProcNetListenFiles()
		owners = true
	}
	s.tcpPorts, s.udpPorts, s.usable = fresh.tcpPorts, fresh.udpPorts, fresh.usable
	s.lazy.loaded = true
	s.lazy.owners = owners
}

func (s *runtimeListenSnapshot) portLinesLocked(port int, protocol string) []string {
	if normalizeRuntimeProtocol(protocol) == "udp" {
		return s.udpPorts[port]
	}
	return s.tcpPorts[port]
}

// listenLines 返回快照是否可用，以及这个端口、协议上的监听行；needOwners 表示调用方要按进程名判断。
func (s *runtimeListenSnapshot) listenLines(port int, protocol string, needOwners bool) (bool, []string) {
	if s == nil {
		return false, nil
	}
	if s.lazy == nil {
		return s.usable, s.portLinesLocked(port, protocol)
	}
	s.lazy.mu.Lock()
	defer s.lazy.mu.Unlock()
	if !s.lazy.loaded {
		s.loadLocked(needOwners, false)
	}
	lines := s.portLinesLocked(port, protocol)
	if needOwners && !s.lazy.owners && len(lines) > 0 {
		s.loadLocked(true, true)
		lines = s.portLinesLocked(port, protocol)
	}
	return s.usable, lines
}

func (s *runtimeListenSnapshot) parseSSListenOutput(text string) {
	for _, line := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 5 {
			continue
		}
		proto := strings.ToLower(strings.TrimSpace(fields[0]))
		if strings.HasPrefix(proto, "tcp") {
			proto = "tcp"
		} else if strings.HasPrefix(proto, "udp") {
			proto = "udp"
		} else {
			continue
		}
		port := addrPort(fields[4])
		if port <= 0 {
			continue
		}
		s.add(proto, port, line)
	}
}

func (s *runtimeListenSnapshot) parseProcNetListenFiles() {
	files := []struct {
		path     string
		protocol string
	}{
		{"/proc/net/tcp", "tcp"},
		{"/proc/net/tcp6", "tcp"},
		{"/proc/net/udp", "udp"},
		{"/proc/net/udp6", "udp"},
	}
	for _, file := range files {
		raw, err := os.ReadFile(file.path)
		if err != nil {
			continue
		}
		for idx, line := range strings.Split(string(raw), "\n") {
			if idx == 0 {
				continue
			}
			fields := strings.Fields(strings.TrimSpace(line))
			if len(fields) < 4 {
				continue
			}
			if file.protocol == "tcp" && strings.ToUpper(fields[3]) != "0A" {
				continue
			}
			port := procNetLocalPort(fields[1])
			if port <= 0 {
				continue
			}
			s.add(file.protocol, port, file.path+":"+fields[1])
		}
	}
}

func procNetLocalPort(value string) int {
	idx := strings.LastIndex(value, ":")
	if idx < 0 || idx >= len(value)-1 {
		return 0
	}
	raw := strings.TrimSpace(value[idx+1:])
	port64, err := strconv.ParseInt(raw, 16, 32)
	if err != nil || port64 <= 0 || port64 > 65535 {
		return 0
	}
	return int(port64)
}

func (s *runtimeListenSnapshot) add(protocol string, port int, line string) {
	if s == nil || port <= 0 {
		return
	}
	protocol = normalizeRuntimeProtocol(protocol)
	if protocol == "udp" {
		s.udpPorts[port] = append(s.udpPorts[port], line)
	} else {
		s.tcpPorts[port] = append(s.tcpPorts[port], line)
	}
	s.usable = true
}

func runtimeListenPortReady(snapshot *runtimeListenSnapshot, port int, protocol string, processNeedles []string) bool {
	if port <= 0 {
		return false
	}
	needOwners := len(normalizeRuntimeProcessNeedles(processNeedles)) > 0
	for _, proto := range runtimeProtocols(protocol) {
		if usable, _ := snapshot.listenLines(port, proto, needOwners); usable {
			if !snapshot.protocolPortReady(port, proto, processNeedles) {
				return false
			}
			continue
		}
		if !runtimePortOccupiedByProtocol(port, proto) {
			return false
		}
	}
	return true
}

func (s *runtimeListenSnapshot) protocolPortReady(port int, protocol string, processNeedles []string) bool {
	if s == nil || port <= 0 {
		return false
	}
	needles := normalizeRuntimeProcessNeedles(processNeedles)
	usable, lines := s.listenLines(port, protocol, len(needles) > 0)
	if !usable || len(lines) == 0 {
		return false
	}
	if len(needles) == 0 {
		return true
	}
	ownerSeen := false
	for _, line := range lines {
		lower := strings.ToLower(line)
		if strings.Contains(lower, "users:") || strings.Contains(lower, "pid=") {
			ownerSeen = true
			for _, needle := range needles {
				if strings.Contains(lower, needle) {
					return true
				}
			}
		}
	}
	return !ownerSeen
}

func normalizeRuntimeProcessNeedles(values []string) []string {
	seen := map[string]bool{}
	result := []string{}
	for _, value := range values {
		value = strings.ToLower(strings.TrimSpace(value))
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		result = append(result, value)
	}
	return result
}

func runtimePortOccupiedByProtocol(port int, protocol string) bool {
	if port <= 0 {
		return false
	}
	addr := ":" + strconv.Itoa(port)
	if normalizeRuntimeProtocol(protocol) == "udp" {
		conn, err := net.ListenPacket("udp", addr)
		if err != nil {
			return true
		}
		_ = conn.Close()
		return false
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return true
	}
	_ = ln.Close()
	return false
}

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

func waitForActionListenPortFree(a action, timeout time.Duration) bool {
	spec := a.Fxp
	if spec == nil && a.SourcePort > 0 {
		spec = &fxpSpec{ListenPort: a.SourcePort, Protocol: a.Protocol}
	}
	return waitForFXPListenPortFree(spec, a.SourcePort, timeout)
}

func runPostCommands(commands []string, actionMessage *actionMessage) {
	if len(commands) == 0 {
		return
	}
	if !runShellBatch(commands) {
		if actionMessage != nil {
			actionMessage.remember("non-critical post apply commands failed; forwarding service may still be running")
		}
		logf("post apply commands completed with failures total=%d", len(commands))
	}
}

func writeUnitAndRestart(name, unit string, signature string) bool {
	name = sanitizeServiceName(name)
	if name == "" {
		logf("write service: empty service name")
		return false
	}
	unit = hardenManagedSystemdUnit(unit)
	execStart := systemdUnitExecStart(unit)
	if execStart == "" {
		logf("write service %s: missing ExecStart", name)
		return false
	}
	if isSystemdHost() {
		path := "/etc/systemd/system/" + name + ".service"
		changed, err := writeFileIfChanged(path, []byte(unit), 0644)
		if err != nil {
			logf("write systemd unit %s: %v", name, err)
			return false
		}
		signatureMatches := !changed && managedServiceSignatureMatches(name, signature)
		ok := systemdManagedServiceBatcher.submit(name, changed, signatureMatches)
		cacheManagedServiceActivity(name, ok)
		if ok {
			writeManagedServiceSignature(name, signature)
		}
		return ok
	}
	if commandExists("rc-service") && commandExists("rc-update") {
		path := "/etc/init.d/" + name
		changed, err := writeFileIfChanged(path, []byte(openRCServiceScript(name, execStart, systemdUnitLimitNOFILE(unit))), 0755)
		if err != nil {
			logf("write openrc service %s: %v", name, err)
			return false
		}
		if !changed && managedServiceSignatureMatches(name, signature) && managedServiceActive(name) {
			logVerbosef("service %s unchanged and active; skip restart", name)
			return true
		}
		_ = runManagedServiceCommand("rc-update", "add", name, "default")
		ok := runManagedServiceCommand("rc-service", name, "restart")
		cacheManagedServiceActivity(name, ok)
		if ok {
			writeManagedServiceSignature(name, signature)
		}
		return ok
	}
	if _, err := os.Stat("/etc/init.d"); err == nil {
		path := "/etc/init.d/" + name
		changed, err := writeFileIfChanged(path, []byte(sysVServiceScript(name, execStart, systemdUnitLimitNOFILE(unit))), 0755)
		if err != nil {
			logf("write sysv service %s: %v", name, err)
			return false
		}
		if !changed && managedServiceSignatureMatches(name, signature) && managedServiceActive(name) {
			logVerbosef("service %s unchanged and active; skip restart", name)
			return true
		}
		if commandExists("update-rc.d") {
			_ = runManagedServiceCommand("update-rc.d", name, "defaults")
		}
		if commandExists("chkconfig") {
			_ = runManagedServiceCommand("chkconfig", name, "on")
		}
		ok := runManagedServiceCommand("/etc/init.d/"+name, "restart")
		cacheManagedServiceActivity(name, ok)
		if ok {
			writeManagedServiceSignature(name, signature)
		}
		return ok
	}
	logf("write service %s: unsupported init system", name)
	return false
}

func writeFileIfChanged(path string, data []byte, perm os.FileMode) (bool, error) {
	if existing, err := os.ReadFile(path); err == nil && bytes.Equal(existing, data) {
		_ = os.Chmod(path, perm)
		return false, nil
	}
	// 服务单元/启动脚本：掉电后留下空文件或半截文件，开机时服务就起不来，
	// 要等 Agent 连上面板重新下发才恢复。只在内容变化时写，原子 + 落盘的开销可以接受。
	if err := writeFileAtomicDurable(path, data, perm); err != nil {
		return false, err
	}
	return true, nil
}

func managedServiceActionSignature(a action, serviceName string, unit string) string {
	h := sha256.New()
	write := func(value string) {
		_, _ = h.Write([]byte(value))
		_, _ = h.Write([]byte{0})
	}
	write(strings.TrimSpace(serviceName))
	write(unit)
	write(a.Op)
	write(a.StatusType)
	write(a.ForwardType)
	write(strconv.Itoa(a.RuleID))
	write(strconv.Itoa(a.TunnelID))
	write(strconv.Itoa(a.SourcePort))
	write(strings.TrimSpace(a.TargetIP))
	write(strconv.Itoa(a.TargetPort))
	write(normalizeRuntimeProtocol(a.Protocol))
	for _, cmd := range a.PreCommands {
		write(cmd)
	}
	for _, cmd := range a.Commands {
		write(cmd)
	}
	for _, cmd := range a.PostCommands {
		write(cmd)
	}
	if a.Failover != nil {
		if raw, err := json.Marshal(a.Failover); err == nil {
			write(string(raw))
		}
	}
	return "sha256:" + hex.EncodeToString(h.Sum(nil))
}

func managedServiceSignaturePath(name string) string {
	return "/var/lib/forwardx-agent/service_" + name + ".signature"
}

func managedServiceSignatureMatches(name string, signature string) bool {
	signature = strings.TrimSpace(signature)
	if signature == "" {
		return false
	}
	raw, err := os.ReadFile(managedServiceSignaturePath(name))
	return err == nil && strings.TrimSpace(string(raw)) == signature
}

func writeManagedServiceSignature(name string, signature string) {
	signature = strings.TrimSpace(signature)
	if signature == "" {
		return
	}
	_ = os.MkdirAll("/var/lib/forwardx-agent", 0755)
	_ = os.WriteFile(managedServiceSignaturePath(name), []byte(signature+"\n"), 0644)
}

func managedServiceActive(name string) bool {
	name = sanitizeServiceName(name)
	if name == "" {
		return false
	}
	if active, ok := cachedManagedServiceActivity(name); ok {
		return active
	}
	active := false
	if isSystemdHost() {
		_, err := commandCombinedOutputWithTimeout(10*time.Second, "systemctl", "is-active", "--quiet", name+".service")
		active = err == nil
	} else if commandExists("rc-service") {
		_, err := commandCombinedOutputWithTimeout(10*time.Second, "rc-service", name, "status")
		active = err == nil
	} else if _, err := os.Stat("/etc/init.d/" + name); err == nil {
		_, err = commandCombinedOutputWithTimeout(10*time.Second, "/etc/init.d/"+name, "status")
		active = err == nil
	}
	cacheManagedServiceActivity(name, active)
	return active
}

func managedServiceNamesForAction(a action) []string {
	port := a.SourcePort
	if port <= 0 {
		return nil
	}
	if a.ServiceName != "" || a.ServiceNameExtra != "" {
		names := []string{}
		if a.ServiceName != "" {
			names = append(names, a.ServiceName)
		}
		if a.ServiceNameExtra != "" {
			names = append(names, a.ServiceNameExtra)
		}
		return names
	}
	switch a.ForwardType {
	case "realm":
		return []string{"forwardx-realm-" + strconv.Itoa(port)}
	case "socat":
		if normalizeRuntimeProtocol(a.Protocol) == "both" {
			return []string{"forwardx-socat-tcp-" + strconv.Itoa(port), "forwardx-socat-udp-" + strconv.Itoa(port)}
		}
		return []string{"forwardx-socat-" + strconv.Itoa(port)}
	default:
		return nil
	}
}

func managedRuleProtocolServiceNames(forwardType string, port int, protocol string) []string {
	groups := localRuleManagedServiceGroups(forwardType, port, protocol)
	seen := map[string]bool{}
	names := make([]string, 0, 4)
	for _, group := range groups {
		for _, name := range group {
			name = sanitizeServiceName(name)
			if name == "" || seen[name] {
				continue
			}
			seen[name] = true
			names = append(names, name)
		}
	}
	return names
}

func cleanupManagedRuleProtocol(forwardType string, port int, protocol string) bool {
	forwardType = strings.TrimSpace(forwardType)
	if forwardType != "realm" && forwardType != "socat" {
		return false
	}
	names := managedRuleProtocolServiceNames(forwardType, port, protocol)
	for _, name := range names {
		cleanupManagedService(name)
		if forwardType == "realm" {
			_ = runShell("rm -f /etc/forwardx/realm/" + name + ".toml /etc/forwardx/realm/" + name + ".toml.sha256 2>/dev/null || true")
		}
	}
	for _, cmd := range managedListenerCleanupCmdsForProtocol(strconv.Itoa(port), protocol) {
		_ = runShell(cmd)
	}
	return len(names) > 0
}

func cleanupLocalManagedRuleServices(a action) {
	if a.RuleID <= 0 || a.SourcePort <= 0 {
		return
	}
	port := strconv.Itoa(a.SourcePort)
	if readRuleIDByPort(port) != a.RuleID {
		return
	}
	forwardType := readForwardTypeByPort(port)
	_, _, protocol, ok := readTargetInfo(port)
	if !ok {
		protocol = a.Protocol
	}
	cleanupManagedRuleProtocol(forwardType, a.SourcePort, protocol)
}

func cleanupManagedService(name string) {
	name = sanitizeServiceName(name)
	if name == "" {
		return
	}
	_ = runShell(managedServiceCleanupShell(name))
	cacheManagedServiceActivity(name, false)
}

var stopManagedServiceProcessForHandoff = stopManagedServiceProcess
var restartManagedServiceProcessForHandoff = restartManagedService

func stopManagedServiceProcess(name string) bool {
	name = sanitizeServiceName(name)
	if name == "" {
		return false
	}
	ok := runShell(managedServiceStopShell(name))
	if ok {
		cacheManagedServiceActivity(name, false)
	}
	return ok
}

func managedServiceStopShell(name string) string {
	name = sanitizeServiceName(name)
	if name == "" {
		return "true"
	}
	q := shellQuote(name)
	return "if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then systemctl stop " + q + ".service 2>/dev/null || true; " +
		"elif command -v rc-service >/dev/null 2>&1; then rc-service " + q + " stop 2>/dev/null || true; " +
		"elif [ -x /etc/init.d/" + name + " ]; then /etc/init.d/" + name + " stop 2>/dev/null || true; fi"
}

func unknownManagedListenerCleanupNeeded(port int, protocol string) bool {
	if !validActionPort(port) {
		return false
	}
	for _, proto := range runtimeProtocols(protocol) {
		if listenPortBusy(proto, port) {
			return true
		}
	}
	for _, name := range managedListenerServiceNamesForProtocol(port, protocol) {
		paths := []string{
			"/etc/systemd/system/" + name + ".service",
			"/etc/init.d/" + name,
			managedServiceSignaturePath(name),
			"/etc/forwardx/realm/" + name + ".toml",
		}
		for _, path := range paths {
			if _, err := os.Stat(path); err == nil {
				return true
			}
		}
	}
	configs, _ := filepath.Glob(fmt.Sprintf("/run/forwardx-agent/fxp-*-%d.json", port))
	if len(configs) > 0 {
		return true
	}
	groupConfigs, _ := filepath.Glob("/run/forwardx-agent/fxp-entry-group-*-*.json")
	for _, path := range groupConfigs {
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var group fxpSpec
		if json.Unmarshal(raw, &group) != nil {
			continue
		}
		for _, entry := range normalizeFXPSpec(group).Entries {
			if entry.ListenPort == port || entry.UDPListenPort == port {
				return true
			}
		}
	}
	return false
}

func restartManagedService(name string) {
	name = sanitizeServiceName(name)
	if name == "" {
		return
	}
	q := shellQuote(name)
	ok := runShell("if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then systemctl reset-failed " + q + ".service 2>/dev/null || true; systemctl restart " + q + ".service; elif command -v rc-service >/dev/null 2>&1; then rc-service " + q + " restart; elif [ -x /etc/init.d/" + name + " ]; then /etc/init.d/" + name + " restart; else exit 1; fi")
	cacheManagedServiceActivity(name, ok)
}

func sanitizeServiceName(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return ""
	}
	for _, r := range name {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.' || r == '@' {
			continue
		}
		return ""
	}
	return name
}

func commandExists(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

func isSystemdHost() bool {
	if !commandExists("systemctl") {
		return false
	}
	if st, err := os.Stat("/run/systemd/system"); err == nil && st.IsDir() {
		return true
	}
	return false
}

func systemdUnitExecStart(unit string) string {
	for _, line := range strings.Split(unit, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "ExecStart=") {
			return strings.TrimSpace(strings.TrimPrefix(line, "ExecStart="))
		}
	}
	return ""
}

// managedServiceDefaultNOFILE 是单元没写 LimitNOFILE（或写了 infinity / 看不懂的值）时
// OpenRC / SysV 脚本里设的文件描述符上限。和内核默认的 fs.nr_open 一样大；转发程序每条
// 连接占两个描述符，发行版默认的 1024 撑不了几百个并发。
const managedServiceDefaultNOFILE = "1048576"

// systemdUnitLimitNOFILE 取单元 [Service] 里的 LimitNOFILE，原样返回（"65535" 或
// "软:硬"）；没有就返回空串。
func systemdUnitLimitNOFILE(unit string) string {
	value := ""
	inService := false
	for _, line := range strings.Split(strings.ReplaceAll(unit, "\r\n", "\n"), "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]") {
			inService = strings.EqualFold(trimmed, "[Service]")
			continue
		}
		if !inService {
			continue
		}
		if key, raw, ok := strings.Cut(trimmed, "="); ok && strings.EqualFold(strings.TrimSpace(key), "LimitNOFILE") {
			// systemd 以最后一次出现的为准。
			value = strings.TrimSpace(raw)
		}
	}
	return value
}

// managedServiceNOFILEShell 把 LimitNOFILE 换成 sh 的 ulimit。转成 OpenRC / SysV 脚本以后
// systemd 的 Limit* 不再生效，以前这些服务只能用发行版默认的 1024 个描述符，并发一多就
// 报 too many open files。只接受纯数字（防止单元里的值被当成命令拼进脚本），其余情况用
// 默认值；硬上限不允许时静默保持原样，不影响服务启动。
func managedServiceNOFILEShell(limit string) string {
	isNumber := func(value string) bool {
		if value == "" || len(value) > 10 {
			return false
		}
		for _, c := range value {
			if c < '0' || c > '9' {
				return false
			}
		}
		return value != "0"
	}
	limit = strings.TrimSpace(limit)
	if soft, hard, ok := strings.Cut(limit, ":"); ok {
		soft, hard = strings.TrimSpace(soft), strings.TrimSpace(hard)
		if isNumber(soft) && isNumber(hard) {
			return "ulimit -Hn " + hard + " 2>/dev/null || true; ulimit -Sn " + soft + " 2>/dev/null || true; "
		}
		limit = ""
	}
	if !isNumber(limit) {
		limit = managedServiceDefaultNOFILE
	}
	return "ulimit -n " + limit + " 2>/dev/null || true; "
}

func hardenManagedSystemdUnit(unit string) string {
	lines := strings.Split(strings.ReplaceAll(unit, "\r\n", "\n"), "\n")
	serviceIndex := -1
	existing := map[string]bool{}
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.EqualFold(trimmed, "[Service]") {
			serviceIndex = i
			continue
		}
		if serviceIndex < 0 || (strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]")) {
			if serviceIndex >= 0 && i > serviceIndex {
				break
			}
			continue
		}
		if key, _, ok := strings.Cut(trimmed, "="); ok {
			existing[strings.ToLower(strings.TrimSpace(key))] = true
		}
	}
	if serviceIndex < 0 {
		return unit
	}
	directives := []string{
		"LimitCORE=0",
		"LogRateLimitIntervalSec=30s",
		"LogRateLimitBurst=200",
	}
	insert := make([]string, 0, len(directives))
	for _, directive := range directives {
		key, _, _ := strings.Cut(directive, "=")
		if !existing[strings.ToLower(key)] {
			insert = append(insert, directive)
		}
	}
	if len(insert) == 0 {
		return strings.Join(lines, "\n")
	}
	result := make([]string, 0, len(lines)+len(insert))
	result = append(result, lines[:serviceIndex+1]...)
	result = append(result, insert...)
	result = append(result, lines[serviceIndex+1:]...)
	return strings.Join(result, "\n")
}

func openRCServiceScript(name, execStart, limitNOFILE string) string {
	return strings.Join([]string{
		"#!/sbin/openrc-run",
		"name=\"" + name + "\"",
		"description=\"ForwardX managed service " + name + "\"",
		"command=\"/bin/sh\"",
		"command_args=\"-lc " + shellQuote(managedServiceNOFILEShell(limitNOFILE)+"ulimit -c 0 2>/dev/null || true; exec "+execStart) + "\"",
		"command_background=true",
		"pidfile=\"/run/${RC_SVCNAME}.pid\"",
		"output_log=\"/var/log/forwardx-agent/${RC_SVCNAME}.log\"",
		"error_log=\"/var/log/forwardx-agent/${RC_SVCNAME}.log\"",
		"depend() {",
		"  need net",
		"}",
		"",
	}, "\n")
}

func sysVServiceScript(name, execStart, limitNOFILE string) string {
	quotedCmd := shellQuote(managedServiceNOFILEShell(limitNOFILE) + "ulimit -c 0 2>/dev/null || true; exec " + execStart)
	return strings.Join([]string{
		"#!/bin/sh",
		"### BEGIN INIT INFO",
		"# Provides:          " + name,
		"# Required-Start:    $network",
		"# Required-Stop:     $network",
		"# Default-Start:     2 3 4 5",
		"# Default-Stop:      0 1 6",
		"# Short-Description: ForwardX managed service " + name,
		"### END INIT INFO",
		"PIDFILE=/run/" + name + ".pid",
		"LOGFILE=/var/log/forwardx-agent/" + name + ".log",
		"CMD=" + quotedCmd,
		"start() {",
		"  mkdir -p /run /var/log/forwardx-agent",
		"  if [ -s \"$PIDFILE\" ] && kill -0 \"$(cat \"$PIDFILE\")\" 2>/dev/null; then return 0; fi",
		"  nohup sh -lc \"$CMD\" >> \"$LOGFILE\" 2>&1 &",
		"  echo $! > \"$PIDFILE\"",
		"}",
		"stop() {",
		"  if [ -s \"$PIDFILE\" ]; then kill \"$(cat \"$PIDFILE\")\" 2>/dev/null || true; rm -f \"$PIDFILE\"; fi",
		"}",
		"case \"$1\" in",
		"  start) start ;;",
		"  stop) stop ;;",
		"  restart) stop; sleep 1; start ;;",
		"  status) [ -s \"$PIDFILE\" ] && kill -0 \"$(cat \"$PIDFILE\")\" 2>/dev/null ;;",
		"  *) echo \"Usage: $0 {start|stop|restart|status}\"; exit 1 ;;",
		"esac",
		"",
	}, "\n")
}

func managedServiceCleanupShell(name string) string {
	q := shellQuote(name)
	return "if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then systemctl stop " + q + ".service 2>/dev/null || true; systemctl disable " + q + ".service 2>/dev/null || true; systemd_unit=/etc/systemd/system/" + name + ".service; systemd_removed=0; if [ -e \"$systemd_unit\" ]; then rm -f \"$systemd_unit\"; systemd_removed=1; fi; if [ \"$systemd_removed\" = \"1\" ]; then systemctl daemon-reload 2>/dev/null || true; fi; systemctl reset-failed " + q + ".service 2>/dev/null || true; fi; " +
		"if command -v rc-service >/dev/null 2>&1; then rc-service " + q + " stop 2>/dev/null || true; fi; " +
		"if command -v rc-update >/dev/null 2>&1; then rc-update del " + q + " default 2>/dev/null || true; fi; " +
		"if [ -x /etc/init.d/" + name + " ]; then /etc/init.d/" + name + " stop 2>/dev/null || true; fi; " +
		"if command -v update-rc.d >/dev/null 2>&1; then update-rc.d -f " + q + " remove >/dev/null 2>&1 || true; fi; " +
		"if command -v chkconfig >/dev/null 2>&1; then chkconfig " + q + " off >/dev/null 2>&1 || true; fi; " +
		"rm -f /etc/init.d/" + name + " /var/lib/forwardx-agent/service_" + name + ".signature /var/log/forwardx-agent/" + name + ".log"
}

func writeState(a action) {
	if a.StatusType == "tunnel" && a.TunnelID > 0 && a.SourcePort > 0 {
		writeTunnelState(a)
		return
	}
	if a.RuleID <= 0 {
		return
	}
	_ = os.MkdirAll("/var/lib/forwardx-agent", 0755)
	port := strconv.Itoa(a.SourcePort)
	resetTrafficStateIfRuleChanged(port, a.RuleID)
	_ = os.WriteFile("/var/lib/forwardx-agent/port_"+port+".rule", []byte(strconv.Itoa(a.RuleID)), 0644)
	_ = os.WriteFile("/var/lib/forwardx-agent/port_"+port+".fwtype", []byte(a.ForwardType), 0644)
	writeRuleTunnelState(port, a.TunnelID)
	if a.TargetIP != "" && a.TargetPort > 0 {
		_ = os.WriteFile("/var/lib/forwardx-agent/target_"+port+".info", []byte(fmt.Sprintf("%s\n%d\n%s\n", a.TargetIP, a.TargetPort, normalizeRuntimeProtocol(a.Protocol))), 0644)
	}
}

func writeTunnelState(a action) {
	_ = os.MkdirAll("/var/lib/forwardx-agent", 0755)
	port := strconv.Itoa(a.SourcePort)
	_ = os.WriteFile("/var/lib/forwardx-agent/tunnel_"+port+".id", []byte(strconv.Itoa(a.TunnelID)), 0644)
	_ = os.WriteFile("/var/lib/forwardx-agent/tunnel_"+port+".fwtype", []byte(a.ForwardType), 0644)
}

func writeRuleTunnelState(port string, tunnelID int) {
	if strings.TrimSpace(port) == "" {
		return
	}
	path := "/var/lib/forwardx-agent/port_" + port + ".tunnel"
	if tunnelID > 0 {
		_ = os.WriteFile(path, []byte(strconv.Itoa(tunnelID)), 0644)
		return
	}
	_ = os.Remove(path)
}

func writeRunningRuleState(r runningRule) {
	if r.RuleID <= 0 || r.SourcePort <= 0 {
		return
	}
	_ = os.MkdirAll("/var/lib/forwardx-agent", 0755)
	port := strconv.Itoa(r.SourcePort)
	resetTrafficStateIfRuleChanged(port, r.RuleID)
	_ = os.WriteFile("/var/lib/forwardx-agent/port_"+port+".rule", []byte(strconv.Itoa(r.RuleID)), 0644)
	_ = os.WriteFile("/var/lib/forwardx-agent/port_"+port+".fwtype", []byte(r.ForwardType), 0644)
	writeRuleTunnelState(port, r.TunnelID)
	if r.TargetIP != "" && r.TargetPort > 0 {
		_ = os.WriteFile("/var/lib/forwardx-agent/target_"+port+".info", []byte(fmt.Sprintf("%s\n%d\n%s\n", r.TargetIP, r.TargetPort, normalizeRuntimeProtocol(r.Protocol))), 0644)
	}
}

func runningRuleStateWriteProtected(r runningRule, protectedPorts map[string]bool) bool {
	if r.SourcePort <= 0 {
		return false
	}
	return protectedActionMatchesPort(protectedPorts, strconv.Itoa(r.SourcePort), r.Protocol)
}

func readRuleIDByPort(port string) int {
	b, err := os.ReadFile("/var/lib/forwardx-agent/port_" + port + ".rule")
	if err != nil {
		return 0
	}
	id, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	return id
}

func readForwardTypeByPort(port string) string {
	b, err := os.ReadFile("/var/lib/forwardx-agent/port_" + port + ".fwtype")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func readRuleTunnelIDByPort(port string) int {
	b, err := os.ReadFile("/var/lib/forwardx-agent/port_" + port + ".tunnel")
	if err != nil {
		return 0
	}
	id, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	return id
}

func readTunnelIDByPort(port string) int {
	b, err := os.ReadFile("/var/lib/forwardx-agent/tunnel_" + port + ".id")
	if err != nil {
		return 0
	}
	id, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	return id
}

func readTunnelForwardTypeByPort(port string) string {
	b, err := os.ReadFile("/var/lib/forwardx-agent/tunnel_" + port + ".fwtype")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func resetTrafficStateIfRuleChanged(port string, nextRuleID int) {
	if port == "" || nextRuleID <= 0 {
		return
	}
	currentRuleID := readRuleIDByPort(port)
	if currentRuleID > 0 && currentRuleID != nextRuleID {
		_ = os.Remove("/var/lib/forwardx-agent/traffic_" + port + ".prev")
		invalidateTrafficPrev(port)
		logf("traffic baseline reset port=%s oldRule=%d newRule=%d", port, currentRuleID, nextRuleID)
	}
}

// 运行规则里哪些端口要留着（端口状态、计数链），哪些调度器要开着。只跑调度器的规则
// （NEX 隧道的出口，见 runningRule.SchedulerOnly）只进后者：它不占端口，同号端口上要是
// 有别的规则留下的状态，照常按孤儿清。
func runningRuleWants(rules []runningRule) (map[string]bool, []runningRule) {
	ports := map[string]bool{}
	failovers := make([]runningRule, 0)
	for _, r := range rules {
		if r.RuleID <= 0 || r.SourcePort <= 0 {
			continue
		}
		if !r.SchedulerOnly {
			ports[strconv.Itoa(r.SourcePort)] = true
		}
		if r.Failover != nil && r.Failover.Enabled {
			failovers = append(failovers, r)
		}
	}
	return ports, failovers
}

func syncRunningRuleState(rules []runningRule, protectedPorts map[string]bool) {
	wanted, failovers := runningRuleWants(rules)
	wantedFailover := map[string]bool{}
	for _, r := range failovers {
		wantedFailover[failoverID(r.RuleID, r.SourcePort)] = true
		port := strconv.Itoa(r.SourcePort)
		if protectedActionMatchesPort(protectedPorts, port, r.Protocol) {
			logVerbosef("failover reconcile deferred for pending action rule=%d port=%d protocol=%s", r.RuleID, r.SourcePort, normalizeRuntimeProtocol(r.Protocol))
		} else {
			startFailoverProxy(r.RuleID, r.SourcePort, *r.Failover, nil)
		}
	}
	failoverMu.Lock()
	staleFailovers := make([]*failoverProxy, 0)
	for id, proxy := range failoverProxies {
		if !wantedFailover[id] {
			staleFailovers = append(staleFailovers, proxy)
		}
	}
	failoverMu.Unlock()
	for _, proxy := range staleFailovers {
		stopFailoverProxy(proxy.ruleID, proxy.sourcePort)
	}
	files, _ := os.ReadDir("/var/lib/forwardx-agent")
	for _, f := range files {
		name := f.Name()
		if !strings.HasPrefix(name, "port_") || !strings.HasSuffix(name, ".rule") {
			continue
		}
		port := strings.TrimSuffix(strings.TrimPrefix(name, "port_"), ".rule")
		if !wanted[port] {
			localRuleID := readRuleIDByPort(port)
			if desired, ok := desiredRunningRuleForStatePort(localRuleID, atoi(port)); ok {
				logf("reconcile skip desired local rule port=%s rule=%d desiredTunnel=%d forwardType=%s", port, localRuleID, desired.TunnelID, desired.ForwardType)
				writeRunningRuleState(desired)
				continue
			}
			_, _, protocol, _ := readTargetInfo(port)
			if protectedActionMatchesPort(protectedPorts, port, protocol) {
				logVerbosef("reconcile skip pending action port=%s protocol=%s", port, normalizeRuntimeProtocol(protocol))
				continue
			}
			reconcileRemovePort(port)
			removeStateByPort(port)
		}
	}
}

func reconcileRemovePort(port string) {
	if port == "" {
		return
	}
	ruleID := readRuleIDByPort(port)
	forwardType := readForwardTypeByPort(port)
	logf("reconcile remove stale local rule port=%s rule=%d forwardType=%s", port, ruleID, forwardType)
	if forwardType == "forwardx" && ruleID > 0 {
		_ = stopFXP(fxpSpec{Role: "entry", RuleID: ruleID, ListenPort: atoi(port), Protocol: "both"}, nil, nil)
	}
	if ruleID > 0 {
		stopFailoverProxy(ruleID, atoi(port))
	}
	if forwardType == "nftables" && ruleID > 0 {
		_ = runShell(nftRuleCleanupCmd(ruleID))
	}
	for _, cmd := range managedPortCleanupCmds(port) {
		_ = runShell(cmd)
	}
}

func nftRuleCleanupCmd(ruleID int) string {
	id := strconv.Itoa(ruleID)
	comment := "fwx-rule-" + id
	return "if nft list table inet forwardx >/dev/null 2>&1; then for c in prerouting postrouting forward traffic_prerouting traffic_postrouting traffic_forward; do for h in $(nft -a list chain inet forwardx \"$c\" 2>/dev/null | awk -v marker=\"" + comment + "\" '$0 ~ marker {print $NF}'); do nft delete rule inet forwardx \"$c\" handle \"$h\" 2>/dev/null; true; done; done; nft flush chain inet forwardx in_" + id + " 2>/dev/null; true; nft delete chain inet forwardx in_" + id + " 2>/dev/null; true; nft flush chain inet forwardx out_" + id + " 2>/dev/null; true; nft delete chain inet forwardx out_" + id + " 2>/dev/null; true; fi; true"
}

func nftPortCleanupCmd(port string, protocol string) string {
	protos := []string{"tcp", "udp"}
	if protocol == "tcp" || protocol == "udp" {
		protos = []string{protocol}
	}
	parts := make([]string, 0, len(protos))
	for _, proto := range protos {
		awk := fmt.Sprintf(`awk '/ %s dport %s( |$)/ && / dnat / {print $NF}'`, proto, port)
		parts = append(parts, fmt.Sprintf(`if nft list chain inet forwardx prerouting >/dev/null 2>&1; then for h in $(nft -a list chain inet forwardx prerouting 2>/dev/null | %s); do nft delete rule inet forwardx prerouting handle "$h" 2>/dev/null; true; done; fi`, awk))
	}
	return strings.Join(parts, "; ") + "; true"
}

func iptablesAgentBinaries() []string {
	return []string{"iptables", "ip6tables"}
}

func iptablesAgentAddress(value string) string {
	text := strings.TrimSpace(value)
	text = strings.TrimPrefix(strings.TrimSuffix(text, "]"), "[")
	return text
}

func iptablesAgentBinaryForTarget(targetIP string) string {
	if strings.Contains(iptablesAgentAddress(targetIP), ":") {
		return "ip6tables"
	}
	return "iptables"
}

func iptablesAgentIsIPAddress(value string) bool {
	return net.ParseIP(iptablesAgentAddress(value)) != nil
}

func iptablesAgentCountingForwardTargetRule(proto, port, target, targetPort string, inbound bool) string {
	match := fmt.Sprintf("-s %s --sport %s", target, targetPort)
	if inbound {
		match = fmt.Sprintf("-d %s --dport %s", target, targetPort)
	}
	return fmt.Sprintf("FORWARD -p %s -m conntrack --ctorigdstport %s %s", proto, port, match)
}

// iptablesAgentBin 返回带锁等待参数占位的 iptables 调用前缀，见 iptables_wait.go。
func iptablesAgentBin(binary string) string {
	return binary + " " + iptablesWaitShellArg
}

func iptablesAgentCommand(binary string, args string, optional bool) string {
	if binary == "ip6tables" {
		if optional {
			return "if command -v ip6tables >/dev/null 2>&1; then " + iptablesAgentBin("ip6tables") + " " + args + "; fi; true"
		}
		return "if command -v ip6tables >/dev/null 2>&1; then " + iptablesAgentBin("ip6tables") + " " + args + "; else exit 1; fi"
	}
	cmd := iptablesAgentBin("iptables") + " " + args
	if optional {
		return cmd + "; true"
	}
	return cmd
}

// iptablesAgentEnsureShell 只在 -C 明确返回 1（规则不存在）时才追加。
// 退出码 4（xtables 锁忙）、2（参数/模块问题）等都不代表“不存在”，此时追加只会造出重复规则
// ——计数规则重复就是流量被数两遍——所以直接失败，交给下一轮重试。
func iptablesAgentEnsureShell(bin string, tableArg string, rule string, appendFlag string) string {
	return bin + " " + tableArg + "-C " + rule + " 2>/dev/null; __fwx_rc=$?; if [ \"$__fwx_rc\" -eq 1 ]; then " + bin + " " + tableArg + appendFlag + " " + rule + "; elif [ \"$__fwx_rc\" -ne 0 ]; then echo \"[iptables] check failed rc=$__fwx_rc, skip append\" >&2; false; fi"
}

func iptablesAgentEnsure(binary string, table string, rule string) string {
	tableArg := ""
	if table != "" {
		tableArg = "-t " + table + " "
	}
	cmd := iptablesAgentEnsureShell(iptablesAgentBin(binary), tableArg, rule, "-A")
	if binary == "ip6tables" {
		return "if command -v ip6tables >/dev/null 2>&1; then " + cmd + "; fi"
	}
	return cmd
}

func iptablesAgentDelete(binary string, table string, rule string) string {
	tableArg := ""
	if table != "" {
		tableArg = "-t " + table + " "
	}
	bin := iptablesAgentBin(binary)
	cmd := "while " + bin + " " + tableArg + "-C " + rule + " 2>/dev/null; do if " + bin + " " + tableArg + "-D " + rule + " 2>/dev/null; then :; else break; fi; done"
	if binary == "ip6tables" {
		return "if command -v ip6tables >/dev/null 2>&1; then " + cmd + "; fi; true"
	}
	return cmd + "; true"
}

func iptablesAgentDeleteByComment(binary string, table string, marker string) string {
	tableArg := ""
	if table != "" {
		tableArg = "-t " + table + " "
	}
	bin := iptablesAgentBin(binary)
	cmd := fmt.Sprintf(`%s %s-S 2>/dev/null | awk -v marker=%s '/^-A / {chain=$2; position[chain]++; if (index($0, marker)) {count++; chains[count]=chain; numbers[count]=position[chain]}} END {for (i=count; i>=1; i--) print chains[i], numbers[i]}' | while read -r chain number; do [ -n "$chain" ] && [ -n "$number" ] && %s %s-D "$chain" "$number" 2>/dev/null || true; done`, bin, tableArg, shellQuote(marker), bin, tableArg)
	if binary == "ip6tables" {
		return "if command -v ip6tables >/dev/null 2>&1; then " + cmd + "; fi; true"
	}
	return cmd + "; true"
}

// iptablesAgentDeleteByRuleTag 按 `--comment fwx-rule-<id>` 精确删除（不会误删 fwx-rule-<id>0）。
// 每条规则自己的 MASQUERADE / FORWARD 放行都带这个标记，删一条规则不会动到共享同一目标的其它规则。
func iptablesAgentDeleteByRuleTag(binary string, table string, chain string, ruleID int) string {
	if ruleID <= 0 {
		return ""
	}
	tableArg := ""
	if table != "" {
		tableArg = "-t " + table + " "
	}
	bin := iptablesAgentBin(binary)
	tag := iptablesRuleTag(ruleID)
	cmd := fmt.Sprintf(`%s %s-S %s 2>/dev/null | awk -v tag=%s '/^-A / {position++; for (i=1; i<NF; i++) if ($i=="--comment") {c=$(i+1); gsub(/"/, "", c); if (c==tag) {count++; numbers[count]=position; break}}} END {for (i=count; i>=1; i--) print numbers[i]}' | while read -r number; do [ -n "$number" ] && %s %s-D %s "$number" 2>/dev/null || true; done`, bin, tableArg, chain, shellQuote(tag), bin, tableArg, chain)
	if binary == "ip6tables" {
		return "if command -v ip6tables >/dev/null 2>&1; then " + cmd + "; fi; true"
	}
	return cmd + "; true"
}

func iptablesRuleTag(ruleID int) string {
	return "fwx-rule-" + strconv.Itoa(ruleID)
}

func iptablesAgentDeleteCountingRules(binary string, port string) string {
	marker := "fwx-stat-" + port + ":"
	inChain := "FWX_IN_" + port
	outChain := "FWX_OUT_" + port
	bin := iptablesAgentBin(binary)
	cmd := fmt.Sprintf(`%s -t mangle -S 2>/dev/null | awk -v marker=%s -v in_chain=%s -v out_chain=%s '/^-A / {chain=$2; position[chain]++; matched=index($0, marker)>0; if (!matched) for (i=1; i<=NF; i++) if ($i==in_chain || $i==out_chain) {matched=1; break} if (matched) {count++; chains[count]=chain; numbers[count]=position[chain]}} END {for (i=count; i>=1; i--) print chains[i], numbers[i]}' | while read -r chain number; do [ -n "$chain" ] && [ -n "$number" ] && %s -t mangle -D "$chain" "$number" 2>/dev/null || true; done`, bin, shellQuote(marker), shellQuote(inChain), shellQuote(outChain), bin)
	if binary == "ip6tables" {
		return "if command -v ip6tables >/dev/null 2>&1; then " + cmd + "; fi; true"
	}
	return cmd + "; true"
}

// iptablesAgentDedupeCountingRules 删掉同一链里逐字相同的重复计数规则，只保留第一条
// （保留下来的那条计数器不动）。重复来自旧版本 `-C || -A` 在 xtables 锁忙时的重复追加。
func iptablesAgentDedupeCountingRules(binary string, port string) string {
	marker := "fwx-stat-" + port + ":"
	bin := iptablesAgentBin(binary)
	cmd := fmt.Sprintf(`%s -t mangle -S 2>/dev/null | awk -v marker=%s '/^-A / {chain=$2; position[chain]++; if (index($0, marker) && seen[$0]++) {count++; chains[count]=chain; numbers[count]=position[chain]}} END {for (i=count; i>=1; i--) print chains[i], numbers[i]}' | while read -r chain number; do [ -n "$chain" ] && [ -n "$number" ] && %s -t mangle -D "$chain" "$number" 2>/dev/null || true; done`, bin, shellQuote(marker), bin)
	if binary == "ip6tables" {
		return "if command -v ip6tables >/dev/null 2>&1; then " + cmd + "; fi; true"
	}
	return cmd + "; true"
}

func iptablesAgentFlush(binary string, table string, chain string) string {
	return iptablesAgentCommand(binary, "-t "+table+" -F "+chain+" 2>/dev/null", true)
}

func iptablesAgentDeleteChain(binary string, table string, chain string) string {
	return iptablesAgentCommand(binary, "-t "+table+" -X "+chain+" 2>/dev/null", true)
}

func iptablesAgentDnatTarget(targetIP string, targetPort int) string {
	host := iptablesAgentAddress(targetIP)
	port := strconv.Itoa(targetPort)
	if strings.Contains(host, ":") {
		return "[" + host + "]:" + port
	}
	return host + ":" + port
}

func iptablesAgentDeleteDnatRulesForPort(binary string, port string, protocol string) string {
	protos := []string{"tcp", "udp"}
	if protocol == "tcp" || protocol == "udp" {
		protos = []string{protocol}
	}
	parts := make([]string, 0, len(protos))
	for _, proto := range protos {
		awk := fmt.Sprintf(`awk '/^-A PREROUTING / && / -p %s / && /--dport %s( |$)/ && / -j DNAT / {sub(/^-A/, "-D"); print}'`, proto, port)
		bin := iptablesAgentBin(binary)
		parts = append(parts, fmt.Sprintf(`while rule=$(%s -t nat -S PREROUTING 2>/dev/null | %s | head -n 1) && [ -n "$rule" ]; do %s -t nat $rule 2>/dev/null || break; done`, bin, awk, bin))
	}
	cmd := strings.Join(parts, "; ")
	if binary == "ip6tables" {
		return "if command -v ip6tables >/dev/null 2>&1; then " + cmd + "; fi; true"
	}
	return cmd + "; true"
}

// iptablesAgentTargetCleanupCmds 清理一条 iptables 规则在目标侧留下的 DNAT / SNAT / FORWARD / 计数规则。
//
// MASQUERADE 与 FORWARD 放行只按目标（-d target --dport tport）匹配，多条规则转发到同一个目标时
// 旧版本共用同一份：删掉其中一条规则会把共享的那份一起删掉，另一条规则随即断流。
// 现在每条规则的这两段都带 `-m comment --comment fwx-rule-<id>`，按标记删除只动自己那份；
// 旧 Agent/面板留下的无标记副本，只有在本机没有别的规则还在用同一目标时才删：
//   - Agent 期望状态里没有其它 iptables 规则指向这个目标；
//   - 内核 nat PREROUTING 里也没有别的端口 DNAT 到这个目标（面板直接下发、期望状态尚未同步时的兜底）。
//
// 读取 PREROUTING 失败时宁可保留无标记副本（最多留一条无害的放行/伪装），也不误删。
func iptablesAgentTargetCleanupCmds(ruleID int, port string, targetIP string, targetPort int, protocol string) []string {
	if strings.TrimSpace(port) == "" || !iptablesAgentIsIPAddress(targetIP) || targetPort <= 0 {
		return nil
	}
	target := iptablesAgentAddress(targetIP)
	if parsed := net.ParseIP(target); parsed != nil {
		target = parsed.String()
	}
	targetPortText := strconv.Itoa(targetPort)
	binary := iptablesAgentBinaryForTarget(target)
	dnatTarget := iptablesAgentDnatTarget(target, targetPort)
	inMarker := "fwx-stat-" + port + ":in"
	outMarker := "fwx-stat-" + port + ":out"
	commands := []string{}
	if ruleID > 0 {
		commands = append(commands,
			iptablesAgentDeleteByRuleTag(binary, "nat", "POSTROUTING", ruleID),
			iptablesAgentDeleteByRuleTag(binary, "", "FORWARD", ruleID),
		)
	}
	for _, proto := range runtimeProtocols(protocol) {
		stateMatch := ""
		if proto == "tcp" {
			stateMatch = "-m state --state ESTABLISHED,RELATED "
		}
		commands = append(commands, iptablesAgentDelete(binary, "nat", fmt.Sprintf(`PREROUTING -p %s --dport %s -j DNAT --to-destination %s`, proto, port, dnatTarget)))
		if !iptablesTargetSharedByOtherDesiredRule(ruleID, atoi(port), target, targetPort, proto) {
			legacy := []string{
				iptablesAgentDelete(binary, "nat", fmt.Sprintf(`POSTROUTING -p %s -d %s --dport %s -j MASQUERADE`, proto, target, targetPortText)),
				iptablesAgentDelete(binary, "", fmt.Sprintf(`FORWARD -p %s -d %s --dport %s -j ACCEPT`, proto, target, targetPortText)),
				iptablesAgentDelete(binary, "", fmt.Sprintf(`FORWARD -p %s -s %s --sport %s %s-j ACCEPT`, proto, target, targetPortText, stateMatch)),
			}
			commands = append(commands, iptablesAgentUnreferencedTargetGuard(binary, proto, port, dnatTarget, legacy))
		}
		rules := []struct {
			table string
			rule  string
		}{
			{"mangle", fmt.Sprintf(`FORWARD -p %s -d %s --dport %s -m comment --comment %q`, proto, target, targetPortText, inMarker)},
			{"mangle", fmt.Sprintf(`OUTPUT -p %s -d %s --dport %s -m comment --comment %q`, proto, target, targetPortText, inMarker)},
			{"mangle", fmt.Sprintf(`POSTROUTING -p %s -d %s --dport %s -m comment --comment %q`, proto, target, targetPortText, inMarker)},
			{"mangle", fmt.Sprintf(`PREROUTING -p %s -s %s --sport %s -m comment --comment %q`, proto, target, targetPortText, outMarker)},
			{"mangle", fmt.Sprintf(`INPUT -p %s -s %s --sport %s -m comment --comment %q`, proto, target, targetPortText, outMarker)},
			{"mangle", fmt.Sprintf(`FORWARD -p %s -s %s --sport %s -m comment --comment %q`, proto, target, targetPortText, outMarker)},
			{"mangle", fmt.Sprintf(`FORWARD -p %s -d %s --dport %s -j FWX_IN_%s`, proto, target, targetPortText, port)},
			{"mangle", fmt.Sprintf(`FORWARD -p %s -s %s --sport %s -j FWX_OUT_%s`, proto, target, targetPortText, port)},
		}
		for _, item := range rules {
			commands = append(commands, iptablesAgentDelete(binary, item.table, item.rule))
		}
	}
	return commands
}

// iptablesAgentUnreferencedTargetGuard 只有在 nat PREROUTING 里没有其它端口 DNAT 到同一目标时
// 才执行 deletes（删除旧版无标记的共享 MASQUERADE/FORWARD）。读取失败按“仍被引用”处理。
func iptablesAgentUnreferencedTargetGuard(binary string, proto string, port string, dnatTarget string, deletes []string) string {
	bin := iptablesAgentBin(binary)
	check := fmt.Sprintf(`printf '%%s\n' "$__fwx_nat" | awk -v proto=%s -v port=%s -v target=%s '/^-A PREROUTING / && / -j DNAT / {p=""; d=""; t=""; for (i=1; i<NF; i++) {if ($i=="-p") p=$(i+1); else if ($i=="--dport") d=$(i+1); else if ($i=="--to-destination") t=$(i+1)} if (p==proto && d!=port && tolower(t)==tolower(target)) found=1} END {exit found ? 0 : 1}'`, shellQuote(proto), shellQuote(port), shellQuote(dnatTarget))
	cmd := "if __fwx_nat=$(" + bin + " -t nat -S PREROUTING 2>/dev/null); then if " + check + "; then :; else " + strings.Join(deletes, "; ") + "; fi; fi"
	if binary == "ip6tables" {
		return "if command -v ip6tables >/dev/null 2>&1; then " + cmd + "; fi; true"
	}
	return cmd + "; true"
}

// iptablesTargetSharedByOtherDesiredRule 查 Agent 的期望状态：是否还有别的 iptables 规则转发到同一目标。
func iptablesTargetSharedByOtherDesiredRule(ruleID int, port int, targetIP string, targetPort int, proto string) bool {
	want := net.ParseIP(iptablesAgentAddress(targetIP))
	if want == nil || targetPort <= 0 {
		return false
	}
	desiredRunningRuleMu.Lock()
	defer desiredRunningRuleMu.Unlock()
	for _, r := range desiredRunningRulesByRulePort {
		if strings.TrimSpace(r.ForwardType) != "iptables" || r.TargetPort != targetPort {
			continue
		}
		if r.SourcePort == port && (ruleID <= 0 || r.RuleID == ruleID) {
			continue
		}
		if !runtimeProtocolsOverlap(r.Protocol, proto) {
			continue
		}
		if got := net.ParseIP(iptablesAgentAddress(r.TargetIP)); got != nil && got.Equal(want) {
			return true
		}
	}
	return false
}

func managedPortCleanupCmds(port string) []string {
	return managedPortCleanupCmdsWithNginx(port, true)
}

func managedPortCleanupCmdsWithNginx(port string, cleanupNginx bool) []string {
	inMarker := "fwx-stat-" + port + ":in"
	outMarker := "fwx-stat-" + port + ":out"
	cmds := append(managedListenerCleanupCmds(port),
		managedServiceCleanupShell("forwardx-socat-"+port),
		managedServiceCleanupShell("forwardx-socat-tcp-"+port),
		managedServiceCleanupShell("forwardx-socat-udp-"+port),
		managedServiceCleanupShell("forwardx-realm-"+port),
		managedServiceCleanupShell("forwardx-realm-tcp-"+port),
		managedServiceCleanupShell("forwardx-realm-udp-"+port),
		managedServiceCleanupShell("forwardx-realm-both-"+port),
		"rm -f /etc/forwardx/realm/forwardx-realm-"+port+".toml /etc/forwardx/realm/forwardx-realm-"+port+".toml.sha256 /etc/forwardx/realm/forwardx-realm-tcp-"+port+".toml /etc/forwardx/realm/forwardx-realm-tcp-"+port+".toml.sha256 /etc/forwardx/realm/forwardx-realm-udp-"+port+".toml /etc/forwardx/realm/forwardx-realm-udp-"+port+".toml.sha256 /etc/forwardx/realm/forwardx-realm-both-"+port+".toml /etc/forwardx/realm/forwardx-realm-both-"+port+".toml.sha256 2>/dev/null || true",
	)
	if cleanupNginx {
		cmds = append(cmds, managedNginxCleanupShell(port))
	}
	cmds = append(cmds, nftPortCleanupCmd(port, "both"), nftProcessCountingCleanupCmd(port))
	for _, binary := range iptablesAgentBinaries() {
		cmds = append(cmds,
			iptablesAgentDeleteByComment(binary, "mangle", inMarker),
			iptablesAgentDeleteByComment(binary, "mangle", outMarker),
		)
		cmds = append(cmds, iptablesAgentDeleteDnatRulesForPort(binary, port, "both"))
		directRules := []string{
			fmt.Sprintf(`PREROUTING -p tcp --dport %s -m comment --comment %q`, port, inMarker),
			fmt.Sprintf(`PREROUTING -p udp --dport %s -m comment --comment %q`, port, inMarker),
			fmt.Sprintf(`INPUT -p tcp --dport %s -m comment --comment %q`, port, inMarker),
			fmt.Sprintf(`INPUT -p udp --dport %s -m comment --comment %q`, port, inMarker),
			fmt.Sprintf(`POSTROUTING -p tcp --sport %s -m comment --comment %q`, port, outMarker),
			fmt.Sprintf(`POSTROUTING -p udp --sport %s -m comment --comment %q`, port, outMarker),
			fmt.Sprintf(`OUTPUT -p tcp --sport %s -m comment --comment %q`, port, outMarker),
			fmt.Sprintf(`OUTPUT -p udp --sport %s -m comment --comment %q`, port, outMarker),
		}
		for _, rule := range directRules {
			cmds = append(cmds, iptablesAgentDelete(binary, "mangle", rule))
		}
		legacyRules := []string{
			fmt.Sprintf(`PREROUTING -p tcp --dport %s -j FWX_IN_%s`, port, port),
			fmt.Sprintf(`PREROUTING -p udp --dport %s -j FWX_IN_%s`, port, port),
			fmt.Sprintf(`POSTROUTING -p tcp --sport %s -j FWX_OUT_%s`, port, port),
			fmt.Sprintf(`POSTROUTING -p udp --sport %s -j FWX_OUT_%s`, port, port),
			fmt.Sprintf(`INPUT -p tcp --dport %s -j FWX_IN_%s`, port, port),
			fmt.Sprintf(`INPUT -p udp --dport %s -j FWX_IN_%s`, port, port),
			fmt.Sprintf(`OUTPUT -p tcp --sport %s -j FWX_OUT_%s`, port, port),
			fmt.Sprintf(`OUTPUT -p udp --sport %s -j FWX_OUT_%s`, port, port),
			fmt.Sprintf(`FORWARD -p tcp -j FWX_IN_%s`, port),
			fmt.Sprintf(`FORWARD -p udp -j FWX_IN_%s`, port),
			fmt.Sprintf(`FORWARD -p tcp -j FWX_OUT_%s`, port),
			fmt.Sprintf(`FORWARD -p udp -j FWX_OUT_%s`, port),
		}
		for _, rule := range legacyRules {
			cmds = append(cmds, iptablesAgentDelete(binary, "mangle", rule))
		}
		cmds = append(cmds,
			iptablesAgentFlush(binary, "mangle", "FWX_IN_"+port),
			iptablesAgentDeleteChain(binary, "mangle", "FWX_IN_"+port),
			iptablesAgentFlush(binary, "mangle", "FWX_OUT_"+port),
			iptablesAgentDeleteChain(binary, "mangle", "FWX_OUT_"+port),
		)
	}
	cmds = append(cmds, "rm -f /var/lib/forwardx-agent/traffic_"+port+".prev /var/lib/forwardx-agent/port_"+port+".rule /var/lib/forwardx-agent/port_"+port+".fwtype /var/lib/forwardx-agent/port_"+port+".tunnel /var/lib/forwardx-agent/target_"+port+".info 2>/dev/null || true")
	if targetIP, targetPort, protocol, ok := readTargetInfo(port); ok {
		cmds = append(iptablesAgentTargetCleanupCmds(readRuleIDByPort(port), port, targetIP, targetPort, protocol), cmds...)
	}
	return cmds
}

func managedListenerCleanupCmds(port string) []string {
	cmds := append([]string{}, fxpPortCleanupCmds(port)...)
	cmds = append(cmds, managedListenerCleanupCmdsForProtocol(port, "both")...)
	return cmds
}

func managedListenerCleanupCmdsForProtocol(port string, protocol string) []string {
	protocol = normalizeRuntimeProtocol(protocol)
	cmds := []string{}
	seen := map[string]bool{}
	appendKill := func(pattern string) {
		if pattern == "" || seen[pattern] {
			return
		}
		seen[pattern] = true
		cmds = append(cmds, "for pid in $(pgrep -f '"+pattern+"' 2>/dev/null || true); do if [ \"$pid\" = \"$$\" ] || [ \"$pid\" = \"$PPID\" ]; then continue; fi; kill \"$pid\" 2>/dev/null || true; done")
	}
	for _, proto := range runtimeProtocols(protocol) {
		if proto == "udp" {
			appendKill("[s]ocat .*UDP.*LISTEN:" + port)
			appendKill("[r]ealm .*forwardx-realm-udp-" + port + "[.]toml")
			appendKill("[r]ealm .*forwardx-realm-both-" + port + "[.]toml")
			appendKill("[f]orwardx-udp2raw .*:" + port)
			continue
		}
		appendKill("[s]ocat .*TCP.*LISTEN:" + port)
		appendKill("[r]ealm .*forwardx-realm-" + port + "[.]toml")
		appendKill("[r]ealm .*forwardx-realm-tcp-" + port + "[.]toml")
		appendKill("[r]ealm .*forwardx-realm-both-" + port + "[.]toml")
	}
	return cmds
}

func managedNginxCleanupShell(port string) string {
	return "if [ -f /etc/forwardx/nginx/nginx.conf ] && grep -Eq \"listen .*:" + port + "( |;)|listen \\\\[::\\\\]:" + port + "( |;)|listen 0.0.0.0:" + port + "( |;)\" /etc/forwardx/nginx/nginx.conf 2>/dev/null; then listen_count=$(grep -E '^[[:space:]]*listen[[:space:]]+' /etc/forwardx/nginx/nginx.conf 2>/dev/null | wc -l | tr -d ' '); if [ \"${listen_count:-0}\" -le 1 ]; then " + managedServiceCleanupShell("forwardx-nginx") + "; else echo \"[nginx] keep shared forwardx-nginx while replacing port " + port + "\"; fi; fi"
}

func fxpPortCleanupCmds(port string) []string {
	return []string{
		"for pid in $(pgrep -f '[f]orwardx-fxp.*fxp-.*-" + port + "\\.json' 2>/dev/null || true); do if [ \"$pid\" = \"$$\" ] || [ \"$pid\" = \"$PPID\" ]; then continue; fi; kill \"$pid\" 2>/dev/null || true; done",
		"rm -f /run/forwardx-agent/fxp-*-" + port + ".json 2>/dev/null || true",
	}
}

func removeStateByPort(port string) {
	_ = os.Remove("/var/lib/forwardx-agent/port_" + port + ".rule")
	_ = os.Remove("/var/lib/forwardx-agent/port_" + port + ".fwtype")
	_ = os.Remove("/var/lib/forwardx-agent/port_" + port + ".tunnel")
	_ = os.Remove("/var/lib/forwardx-agent/target_" + port + ".info")
	_ = os.Remove("/var/lib/forwardx-agent/traffic_" + port + ".prev")
	invalidateTrafficPrev(port)
	clearFreshProcessConnectionCounter(port, 0)
	removeTunnelStateByPort(port)
	forgetCountingChainState(port)
}

func removeTunnelStateByPort(port string) {
	_ = os.Remove("/var/lib/forwardx-agent/tunnel_" + port + ".id")
	_ = os.Remove("/var/lib/forwardx-agent/tunnel_" + port + ".fwtype")
}

func atoi(s string) int {
	v, _ := strconv.Atoi(strings.TrimSpace(s))
	return v
}

const nftProcessTrafficTable = "forwardx_traffic"

func nftProcessCountingCleanupCmd(port string) string {
	marker := "fwx-stat-" + port + ":"
	return fmt.Sprintf(`if command -v nft >/dev/null 2>&1 && nft list table inet %s >/dev/null 2>&1; then for c in input output forward; do for h in $(nft -a list chain inet %s "$c" 2>/dev/null | awk -v marker=%s 'index($0, marker) {print $NF}'); do nft delete rule inet %s "$c" handle "$h" 2>/dev/null || true; done; done; fi; true`, nftProcessTrafficTable, nftProcessTrafficTable, shellQuote(marker), nftProcessTrafficTable)
}

func nftProcessCountingCmds(port int, protocol string) []string {
	p := strconv.Itoa(port)
	commands := []string{
		"nft add table inet " + nftProcessTrafficTable + " 2>/dev/null || true",
		"nft add chain inet " + nftProcessTrafficTable + " input '{ type filter hook input priority mangle; policy accept; }' 2>/dev/null || true",
		"nft add chain inet " + nftProcessTrafficTable + " output '{ type filter hook output priority mangle; policy accept; }' 2>/dev/null || true",
	}
	for _, proto := range runtimeProtocols(protocol) {
		inComment := shellQuote(`"fwx-stat-` + p + `:in"`)
		outComment := shellQuote(`"fwx-stat-` + p + `:out"`)
		connectionComment := shellQuote(`"fwx-stat-` + p + `:conn"`)
		commands = append(commands,
			fmt.Sprintf(`nft add rule inet %s input meta l4proto %s %s dport %s counter comment %s 2>/dev/null || nft add rule inet %s input meta l4proto %s %s dport %s comment %s counter`, nftProcessTrafficTable, proto, proto, p, inComment, nftProcessTrafficTable, proto, proto, p, inComment),
			fmt.Sprintf(`nft add rule inet %s output meta l4proto %s %s sport %s counter comment %s 2>/dev/null || nft add rule inet %s output meta l4proto %s %s sport %s comment %s counter`, nftProcessTrafficTable, proto, proto, p, outComment, nftProcessTrafficTable, proto, proto, p, outComment),
			fmt.Sprintf(`nft add rule inet %s input meta l4proto %s %s dport %s ct state new ct status != confirmed counter comment %s`, nftProcessTrafficTable, proto, proto, p, connectionComment),
		)
	}
	return commands
}

func nftProcessCountingEnsureCmds(port int, protocol string) []string {
	p := strconv.Itoa(port)
	commands := []string{
		"nft add table inet " + nftProcessTrafficTable + " 2>/dev/null || true",
		"nft add chain inet " + nftProcessTrafficTable + " input '{ type filter hook input priority mangle; policy accept; }' 2>/dev/null || true",
		"nft add chain inet " + nftProcessTrafficTable + " output '{ type filter hook output priority mangle; policy accept; }' 2>/dev/null || true",
	}
	for _, proto := range runtimeProtocols(protocol) {
		inMarker := "fwx-stat-" + p + ":in"
		outMarker := "fwx-stat-" + p + ":out"
		connectionMarker := "fwx-stat-" + p + ":conn"
		inMatch := proto + " dport " + p
		outMatch := proto + " sport " + p
		inAdd := fmt.Sprintf("nft add rule inet %s input meta l4proto %s %s dport %s counter comment %s 2>/dev/null || nft add rule inet %s input meta l4proto %s %s dport %s comment %s counter", nftProcessTrafficTable, proto, proto, p, shellQuote(`"`+inMarker+`"`), nftProcessTrafficTable, proto, proto, p, shellQuote(`"`+inMarker+`"`))
		outAdd := fmt.Sprintf("nft add rule inet %s output meta l4proto %s %s sport %s counter comment %s 2>/dev/null || nft add rule inet %s output meta l4proto %s %s sport %s comment %s counter", nftProcessTrafficTable, proto, proto, p, shellQuote(`"`+outMarker+`"`), nftProcessTrafficTable, proto, proto, p, shellQuote(`"`+outMarker+`"`))
		connectionAdd := fmt.Sprintf("nft add rule inet %s input meta l4proto %s %s dport %s ct state new ct status != confirmed counter comment %s", nftProcessTrafficTable, proto, proto, p, shellQuote(`"`+connectionMarker+`"`))
		commands = append(commands,
			fmt.Sprintf("if nft list chain inet %s input 2>/dev/null | grep -F %s | grep -F %s >/dev/null 2>&1; then :; else %s; fi", nftProcessTrafficTable, shellQuote(inMarker), shellQuote(inMatch), inAdd),
			fmt.Sprintf("if nft list chain inet %s output 2>/dev/null | grep -F %s | grep -F %s >/dev/null 2>&1; then :; else %s; fi", nftProcessTrafficTable, shellQuote(outMarker), shellQuote(outMatch), outAdd),
			fmt.Sprintf("if %s; then :; else %s; fi", nftProcessConnectionRuleCheckCmd(port, proto), connectionAdd),
		)
	}
	return commands
}

func nftProcessConnectionRuleCheckCmd(port int, protocol string) string {
	p := strconv.Itoa(port)
	marker := "fwx-stat-" + p + ":conn"
	inMatch := protocol + " dport " + p
	return fmt.Sprintf(
		"nft list chain inet %s input 2>/dev/null | grep -F %s | grep -F %s | grep -F %s | grep -F %s >/dev/null 2>&1",
		nftProcessTrafficTable, shellQuote(marker), shellQuote(inMatch), shellQuote("ct state new"), shellQuote("ct status != confirmed"),
	)
}

func nftProcessConnectionLayoutPresent(port int, protocol string) bool {
	if port <= 0 {
		return false
	}
	for _, proto := range runtimeProtocols(protocol) {
		if !runShellQuiet(nftProcessConnectionRuleCheckCmd(port, proto)) {
			return false
		}
	}
	return true
}

func iptablesProcessConnectionRule(port int, protocol string) string {
	marker := "fwx-stat-" + strconv.Itoa(port) + ":conn"
	return fmt.Sprintf(`INPUT -p %s --dport %d -m conntrack --ctstate NEW ! --ctstatus CONFIRMED -m comment --comment %q`, protocol, port, marker)
}

func iptablesProcessConnectionLayoutPresent(port int, protocol string) bool {
	if port <= 0 {
		return false
	}
	for _, binary := range iptablesAgentBinaries() {
		if !runShellQuiet("command -v " + binary + " >/dev/null 2>&1") {
			continue
		}
		complete := true
		for _, proto := range runtimeProtocols(protocol) {
			if !runIptablesShellQuiet(iptablesAgentBin(binary) + " -t mangle -C " + iptablesProcessConnectionRule(port, proto) + " 2>/dev/null") {
				complete = false
				break
			}
		}
		if complete {
			return true
		}
	}
	return false
}

func iptablesProcessCountingCmds(port int, protocol string) []string {
	if port <= 0 {
		return nil
	}
	p := strconv.Itoa(port)
	inMarker := "fwx-stat-" + p + ":in"
	outMarker := "fwx-stat-" + p + ":out"
	commands := []string{}
	for _, binary := range iptablesAgentBinaries() {
		for _, proto := range runtimeProtocols(protocol) {
			commands = append(commands,
				iptablesAgentEnsure(binary, "mangle", fmt.Sprintf(`INPUT -p %s --dport %s -m comment --comment %q`, proto, p, inMarker)),
				iptablesAgentEnsure(binary, "mangle", fmt.Sprintf(`OUTPUT -p %s --sport %s -m comment --comment %q`, proto, p, outMarker)),
				iptablesAgentEnsure(binary, "mangle", iptablesProcessConnectionRule(port, proto)),
			)
		}
	}
	return commands
}

type countingRuleMode string

const (
	countingRuleNone      countingRuleMode = "none"
	countingRuleKernel    countingRuleMode = "kernel"
	countingRuleProcess   countingRuleMode = "process"
	countingLayoutVersion                  = "v2"
)

func countingRuleModeForForwardType(forwardType string) countingRuleMode {
	normalized := strings.ToLower(strings.TrimSpace(forwardType))
	if normalized == "nftables" || normalized == "forwardx" || strings.HasPrefix(normalized, "forwardx-") {
		return countingRuleNone
	}
	if normalized == "iptables" {
		return countingRuleKernel
	}
	return countingRuleProcess
}

func countingRuleInstallCmds(rule runningRule) []string {
	if rule.SourcePort <= 0 {
		return nil
	}
	p := strconv.Itoa(rule.SourcePort)
	inMarker := "fwx-stat-" + p + ":in"
	outMarker := "fwx-stat-" + p + ":out"
	mode := countingRuleModeForForwardType(rule.ForwardType)
	commands := []string{}
	if mode == countingRuleProcess {
		return nftProcessCountingCmds(rule.SourcePort, rule.Protocol)
	}
	if mode != countingRuleKernel {
		return commands
	}
	target := iptablesAgentAddress(rule.TargetIP)
	if !iptablesAgentIsIPAddress(target) || rule.TargetPort <= 0 {
		return commands
	}
	targetPort := strconv.Itoa(rule.TargetPort)
	binary := iptablesAgentBinaryForTarget(target)
	for _, proto := range runtimeProtocols(rule.Protocol) {
		inRule := iptablesAgentCountingForwardTargetRule(proto, p, target, targetPort, true) + fmt.Sprintf(` -m comment --comment %q`, inMarker)
		outRule := iptablesAgentCountingForwardTargetRule(proto, p, target, targetPort, false) + fmt.Sprintf(` -m comment --comment %q`, outMarker)
		commands = append(commands,
			iptablesAgentEnsure(binary, "mangle", inRule),
			iptablesAgentEnsure(binary, "mangle", outRule),
		)
	}
	return commands
}

func countingRuleCleanupCmds(port int) []string {
	if port <= 0 {
		return nil
	}
	p := strconv.Itoa(port)
	commands := []string{nftProcessCountingCleanupCmd(p)}
	for _, binary := range iptablesAgentBinaries() {
		commands = append(commands,
			iptablesAgentDeleteCountingRules(binary, p),
			iptablesAgentFlush(binary, "mangle", "FWX_IN_"+p),
			iptablesAgentDeleteChain(binary, "mangle", "FWX_IN_"+p),
			iptablesAgentFlush(binary, "mangle", "FWX_OUT_"+p),
			iptablesAgentDeleteChain(binary, "mangle", "FWX_OUT_"+p),
		)
	}
	return commands
}

func ensureCountingChains(rule runningRule) bool {
	return ensureCountingChainsWithCleanup(rule, true)
}

func ensureCountingChainsWithCleanup(rule runningRule, cleanup bool) bool {
	if rule.SourcePort <= 0 {
		return true
	}
	p := strconv.Itoa(rule.SourcePort)
	mode := countingRuleModeForForwardType(rule.ForwardType)
	if mode == countingRuleKernel {
		target := iptablesAgentAddress(rule.TargetIP)
		if !iptablesAgentIsIPAddress(target) || rule.TargetPort <= 0 {
			if shouldLogAgentReport("traffic-counting-unresolved:"+p, 5*time.Minute) {
				logf("traffic counting repair deferred port=%s target=%s:%d type=%s reason=target-unresolved", p, rule.TargetIP, rule.TargetPort, rule.ForwardType)
			}
			return false
		}
	}
	if !cleanup {
		return ensureCountingChainsNonDestructive(rule, mode)
	}

	cleanupOK := runIptablesShellBatch(countingRuleCleanupCmds(rule.SourcePort))
	installOK := false
	backend := string(mode)
	if cleanupOK {
		switch mode {
		case countingRuleNone:
			installOK = true
		case countingRuleKernel:
			backend = iptablesAgentBinaryForTarget(rule.TargetIP)
			installOK = runShellQuiet("command -v "+backend+" >/dev/null 2>&1") && runIptablesShellBatch(countingRuleInstallCmds(rule))
		case countingRuleProcess:
			if runShellQuiet("command -v nft >/dev/null 2>&1") && runShellBatch(nftProcessCountingCmds(rule.SourcePort, rule.Protocol)) {
				backend = "nft"
				installOK = true
			} else {
				// Remove a partially installed nft layout before selecting the
				// iptables listener hooks as the sole authoritative backend.
				fallbackCleanupOK := runIptablesShellBatch(countingRuleCleanupCmds(rule.SourcePort))
				backend = "iptables"
				installOK = fallbackCleanupOK && runShellQuiet("command -v iptables >/dev/null 2>&1") && runIptablesShellBatch(iptablesProcessCountingCmds(rule.SourcePort, rule.Protocol))
			}
		}
	}
	ok := cleanupOK && installOK
	if ok && cleanup && mode == countingRuleProcess {
		markFreshProcessConnectionCounter(rule.SourcePort, rule.RuleID)
	}
	if !ok && shouldLogAgentReport("traffic-counting-repair:"+p, 5*time.Minute) {
		logf("traffic counting repair failed port=%s target=%s:%d protocol=%s type=%s mode=%s backend=%s cleanup=%v install=%v", p, rule.TargetIP, rule.TargetPort, rule.Protocol, rule.ForwardType, mode, backend, cleanupOK, installOK)
	}
	return ok
}

// ensureCountingChainsNonDestructive repairs missing rules without flushing
// existing chains. This preserves counters when only the Agent process was
// restarted and the firewall layout is still present.
func ensureCountingChainsNonDestructive(rule runningRule, mode countingRuleMode) bool {
	if mode == countingRuleNone {
		return true
	}
	if mode == countingRuleKernel {
		target := iptablesAgentAddress(rule.TargetIP)
		binary := iptablesAgentBinaryForTarget(target)
		// 先删掉逐字重复的计数规则（保留第一条及其计数器），再补缺失的规则。
		commands := append([]string{iptablesAgentDedupeCountingRules(binary, strconv.Itoa(rule.SourcePort))}, countingRuleInstallCmds(rule)...)
		return runShellQuiet("command -v "+binary+" >/dev/null 2>&1") && runIptablesShellBatch(commands)
	}
	nftAvailable := runShellQuiet("command -v nft >/dev/null 2>&1")
	nftConnectionLayoutPresent := nftAvailable && nftProcessConnectionLayoutPresent(rule.SourcePort, rule.Protocol)
	if nftAvailable && runShellBatch(nftProcessCountingEnsureCmds(rule.SourcePort, rule.Protocol)) {
		if nftConnectionLayoutPresent {
			clearFreshProcessConnectionCounter(strconv.Itoa(rule.SourcePort), rule.RuleID)
		} else {
			markFreshProcessConnectionCounter(rule.SourcePort, rule.RuleID)
		}
		return true
	}
	iptablesConnectionLayoutPresent := iptablesProcessConnectionLayoutPresent(rule.SourcePort, rule.Protocol)
	processCommands := []string{}
	for _, binary := range iptablesAgentBinaries() {
		processCommands = append(processCommands, iptablesAgentDedupeCountingRules(binary, strconv.Itoa(rule.SourcePort)))
	}
	processCommands = append(processCommands, iptablesProcessCountingCmds(rule.SourcePort, rule.Protocol)...)
	ok := runShellQuiet("command -v iptables >/dev/null 2>&1") && runIptablesShellBatch(processCommands)
	if ok {
		if iptablesConnectionLayoutPresent {
			clearFreshProcessConnectionCounter(strconv.Itoa(rule.SourcePort), rule.RuleID)
		} else {
			markFreshProcessConnectionCounter(rule.SourcePort, rule.RuleID)
		}
	}
	return ok
}

func ensureCountingChainsIfNeeded(r runningRule) {
	if r.SourcePort <= 0 {
		return
	}
	signature := countingChainRuleSignature(r)
	key := strconv.Itoa(r.SourcePort)
	countingChainMu.Lock()
	lastSig := countingChainSignatures[key]
	lastChecked := countingChainCheckedAt[key]
	if (lastSig == signature && !lastChecked.IsZero()) || countingChainRepairPending[key] {
		countingChainMu.Unlock()
		return
	}
	countingChainSignatures[key] = signature
	if lastSig != signature {
		countingChainCheckedAt[key] = time.Time{}
	}
	countingChainRepairCleanup[key] = lastSig != signature
	countingChainRepairPending[key] = true
	countingChainMu.Unlock()
	countingChainRepairWorkersOnce.Do(startCountingChainRepairWorkers)
	select {
	case countingChainRepairQueue <- r:
	default:
		countingChainMu.Lock()
		delete(countingChainRepairPending, key)
		delete(countingChainRepairCleanup, key)
		countingChainCheckedAt[key] = time.Time{}
		countingChainMu.Unlock()
		if shouldLogAgentReport("traffic-counting-queue-full", agentReportLogInterval) {
			logf("traffic counting repair queue full pending=%d", len(countingChainRepairQueue))
		}
	}
}

func startCountingChainRepairWorkers() {
	go countingChainRepairWorker()
}

func countingChainRepairWorker() {
	for rule := range countingChainRepairQueue {
		for atomic.LoadInt64(&actionPendingCount) > 0 || time.Since(agentProcessStartedAt) < countingChainRepairInitialDelay {
			time.Sleep(250 * time.Millisecond)
		}
		cleanup := true
		key := strconv.Itoa(rule.SourcePort)
		countingChainMu.Lock()
		if value, exists := countingChainRepairCleanup[key]; exists {
			cleanup = value
		}
		countingChainMu.Unlock()
		ok := true
		current, exists := desiredRunningRuleForStatePort(rule.RuleID, rule.SourcePort)
		if exists && countingChainRuleSignature(current) == countingChainRuleSignature(rule) {
			ok = ensureCountingChainsWithCleanup(rule, cleanup)
		} else {
			ok = false
		}
		finishCountingChainRepair(rule, ok)
		time.Sleep(countingChainRepairPace)
	}
}

func countingChainRuleSignature(rule runningRule) string {
	forwardType := strings.ToLower(strings.TrimSpace(rule.ForwardType))
	prefix := fmt.Sprintf("%s|%d|%s|%s", countingLayoutVersion, rule.SourcePort, forwardType, normalizeRuntimeProtocol(rule.Protocol))
	if countingRuleModeForForwardType(forwardType) != countingRuleKernel {
		return prefix
	}
	return fmt.Sprintf("%s|%s|%d", prefix, strings.TrimSpace(rule.TargetIP), rule.TargetPort)
}

func removeState(port int) {
	p := strconv.Itoa(port)
	_ = os.Remove("/var/lib/forwardx-agent/port_" + p + ".rule")
	_ = os.Remove("/var/lib/forwardx-agent/port_" + p + ".fwtype")
	_ = os.Remove("/var/lib/forwardx-agent/port_" + p + ".tunnel")
	_ = os.Remove("/var/lib/forwardx-agent/target_" + p + ".info")
	_ = os.Remove("/var/lib/forwardx-agent/traffic_" + p + ".prev")
	invalidateTrafficPrev(p)
	clearFreshProcessConnectionCounter(p, 0)
	removeTunnelStateByPort(p)
	forgetCountingChainState(p)
}

type fxpProcess struct {
	signature             string
	cmd                   *exec.Cmd
	configPath            string
	spec                  fxpSpec
	wireGuardRefID        string
	runtimeExecutable     os.FileInfo
	panelCredentialDigest string
}

const fxpEntryGroupRole = "entry-group"

func normalizeFXPTransportVersion(version string) string {
	if strings.EqualFold(strings.TrimSpace(version), forwardXWireGuardVersion) {
		return forwardXWireGuardVersion
	}
	return "v1"
}

func isSharedFXPEntry(spec fxpSpec) bool {
	version := normalizeFXPTransportVersion(spec.TransportVersion)
	return strings.EqualFold(strings.TrimSpace(spec.Role), "entry") &&
		(version == "v1" || version == forwardXWireGuardVersion) &&
		spec.TunnelID > 0 && spec.RuleID > 0 && spec.ListenPort > 0
}

func isFXPEntryGroup(spec fxpSpec) bool {
	version := normalizeFXPTransportVersion(spec.TransportVersion)
	return strings.EqualFold(strings.TrimSpace(spec.Role), fxpEntryGroupRole) &&
		(version == "v1" || version == forwardXWireGuardVersion) &&
		spec.TunnelID > 0
}

func fxpEntryGroupKey(transportVersion string, tunnelID int) string {
	return normalizeFXPTransportVersion(transportVersion) + ":" + strconv.Itoa(tunnelID)
}

func fxpEntryGroupServerID(transportVersion string, tunnelID int) string {
	return fxpEntryGroupRole + ":" + fxpEntryGroupKey(transportVersion, tunnelID)
}

func fxpEntryIdentity(spec fxpSpec) string {
	spec = normalizeFXPSpec(spec)
	return strconv.Itoa(spec.RuleID) + ":" + strconv.Itoa(spec.ListenPort) + ":" + spec.Protocol
}

func fxpEntryMatches(left fxpSpec, right fxpSpec) bool {
	left = normalizeFXPSpec(left)
	right = normalizeFXPSpec(right)
	return isSharedFXPEntry(left) && isSharedFXPEntry(right) &&
		left.TransportVersion == right.TransportVersion &&
		left.TunnelID == right.TunnelID &&
		fxpServerSignature(left) == fxpServerSignature(right)
}

func fxpEntryGroupContains(group fxpSpec, entry fxpSpec) bool {
	group = normalizeFXPSpec(group)
	entry = normalizeFXPSpec(entry)
	if !isFXPEntryGroup(group) || !isSharedFXPEntry(entry) || group.TransportVersion != entry.TransportVersion || group.TunnelID != entry.TunnelID {
		return false
	}
	for _, candidate := range group.Entries {
		if fxpEntryMatches(candidate, entry) {
			return true
		}
	}
	return false
}

func fxpRemovalMatchesEntry(request fxpSpec, entry fxpSpec) bool {
	requestedProtocol := strings.TrimSpace(request.Protocol)
	requestedTransportVersion := strings.TrimSpace(request.TransportVersion)
	entry = normalizeFXPSpec(entry)
	if !isSharedFXPEntry(entry) {
		return false
	}
	if role := strings.TrimSpace(request.Role); role != "" && !strings.EqualFold(role, entry.Role) {
		return false
	}
	if request.TunnelID > 0 && request.TunnelID != entry.TunnelID {
		return false
	}
	if requestedTransportVersion != "" && normalizeFXPTransportVersion(requestedTransportVersion) != entry.TransportVersion {
		return false
	}
	if request.RuleID > 0 && request.RuleID != entry.RuleID {
		return false
	}
	if request.ListenPort > 0 && request.ListenPort != entry.ListenPort {
		return false
	}
	return requestedProtocol == "" || runtimeProtocolsOverlap(entry.Protocol, request.Protocol)
}

func buildSharedFXPEntryGroup(entries []fxpSpec, tunnelID int, transportVersion string) (fxpSpec, bool) {
	transportVersion = normalizeFXPTransportVersion(transportVersion)
	compatible := make([]fxpSpec, 0, len(entries))
	for _, entry := range entries {
		entry = normalizeFXPSpec(entry)
		if entry.TunnelID == tunnelID && entry.TransportVersion == transportVersion && isSharedFXPEntry(entry) {
			compatible = append(compatible, entry)
		}
	}
	group := fxpSpec{
		Role:             fxpEntryGroupRole,
		TransportVersion: transportVersion,
		TunnelID:         tunnelID,
		Entries:          compatible,
	}
	group = normalizeFXPSpec(group)
	return group, tunnelID > 0 && len(group.Entries) > 0
}

func desiredSharedFXPEntryGroup(current *fxpSpec, removal *fxpSpec) (fxpSpec, bool) {
	tunnelID := 0
	transportVersion := ""
	if current != nil {
		tunnelID = current.TunnelID
		transportVersion = normalizeFXPTransportVersion(current.TransportVersion)
	}
	if tunnelID <= 0 && removal != nil {
		tunnelID = removal.TunnelID
	}
	if removal != nil && strings.TrimSpace(removal.TransportVersion) != "" {
		transportVersion = normalizeFXPTransportVersion(removal.TransportVersion)
	}
	if removal != nil && (tunnelID <= 0 || transportVersion == "") {
		for _, persisted := range loadPersistedFXPSpecs() {
			if fxpRemovalMatchesEntry(*removal, persisted) {
				tunnelID = persisted.TunnelID
				transportVersion = persisted.TransportVersion
				break
			}
		}
	}
	if transportVersion == "" {
		transportVersion = "v1"
	}
	entries := make([]fxpSpec, 0)
	for _, persisted := range loadPersistedFXPSpecs() {
		if !isSharedFXPEntry(persisted) {
			continue
		}
		if tunnelID > 0 && persisted.TunnelID != tunnelID {
			continue
		}
		if persisted.TransportVersion != transportVersion {
			continue
		}
		if removal != nil && fxpRemovalMatchesEntry(*removal, persisted) {
			if tunnelID <= 0 {
				tunnelID = persisted.TunnelID
			}
			continue
		}
		if current != nil && (persisted.RuleID == current.RuleID || fxpSpecsListenConflict(persisted, *current)) {
			continue
		}
		entries = append(entries, persisted)
	}
	if current != nil {
		entries = append(entries, *current)
	}
	return buildSharedFXPEntryGroup(entries, tunnelID, transportVersion)
}

type sharedFXPEntryEndpoint struct {
	protocol string
	port     int
}

type sharedFXPEntrySlot struct {
	entry  fxpSpec
	active bool
}

type mutableSharedFXPEntryGroup struct {
	tunnelID         int
	transportVersion string
	slots            []sharedFXPEntrySlot
	active           map[int]struct{}
	byRule           map[int][]int
	byListenPort     map[int][]int
	byEndpoint       map[sharedFXPEntryEndpoint][]int
}

func newMutableSharedFXPEntryGroup(tunnelID int, transportVersion string) *mutableSharedFXPEntryGroup {
	return &mutableSharedFXPEntryGroup{
		tunnelID:         tunnelID,
		transportVersion: normalizeFXPTransportVersion(transportVersion),
		active:           map[int]struct{}{},
		byRule:           map[int][]int{},
		byListenPort:     map[int][]int{},
		byEndpoint:       map[sharedFXPEntryEndpoint][]int{},
	}
}

func sharedFXPEntryEndpoints(spec fxpSpec) ([2]sharedFXPEntryEndpoint, int) {
	var endpoints [2]sharedFXPEntryEndpoint
	count := 0
	switch normalizeRuntimeProtocol(spec.Protocol) {
	case "udp":
		if spec.UDPListenPort > 0 {
			endpoints[count] = sharedFXPEntryEndpoint{protocol: "udp", port: spec.UDPListenPort}
			count++
		}
	case "both":
		if spec.ListenPort > 0 {
			endpoints[count] = sharedFXPEntryEndpoint{protocol: "tcp", port: spec.ListenPort}
			count++
		}
		if spec.UDPListenPort > 0 {
			endpoints[count] = sharedFXPEntryEndpoint{protocol: "udp", port: spec.UDPListenPort}
			count++
		}
	default:
		if spec.ListenPort > 0 {
			endpoints[count] = sharedFXPEntryEndpoint{protocol: "tcp", port: spec.ListenPort}
			count++
		}
	}
	return endpoints, count
}

func (group *mutableSharedFXPEntryGroup) add(entry fxpSpec) {
	entry = normalizeFXPSpec(entry)
	if !isSharedFXPEntry(entry) || entry.TunnelID != group.tunnelID || entry.TransportVersion != group.transportVersion {
		return
	}
	endpoints, endpointCount := sharedFXPEntryEndpoints(entry)
	index := len(group.slots)
	group.slots = append(group.slots, sharedFXPEntrySlot{
		entry:  entry,
		active: true,
	})
	group.active[index] = struct{}{}
	group.byRule[entry.RuleID] = append(group.byRule[entry.RuleID], index)
	group.byListenPort[entry.ListenPort] = append(group.byListenPort[entry.ListenPort], index)
	for endpointIndex := 0; endpointIndex < endpointCount; endpointIndex++ {
		endpoint := endpoints[endpointIndex]
		group.byEndpoint[endpoint] = append(group.byEndpoint[endpoint], index)
	}
}

func (group *mutableSharedFXPEntryGroup) removeSlot(index int) {
	if index < 0 || index >= len(group.slots) || !group.slots[index].active {
		return
	}
	group.slots[index].active = false
	delete(group.active, index)
}

func (group *mutableSharedFXPEntryGroup) removeMatching(request fxpSpec) {
	var candidates []int
	selectedByRule := request.RuleID > 0
	selectedByListenPort := !selectedByRule && request.ListenPort > 0
	switch {
	case selectedByRule:
		candidates = group.byRule[request.RuleID]
	case selectedByListenPort:
		candidates = group.byListenPort[request.ListenPort]
	default:
		for index := range group.active {
			if fxpRemovalMatchesEntry(request, group.slots[index].entry) {
				group.removeSlot(index)
			}
		}
		return
	}

	remaining := candidates[:0]
	for _, index := range candidates {
		if !group.slots[index].active {
			continue
		}
		if fxpRemovalMatchesEntry(request, group.slots[index].entry) {
			group.removeSlot(index)
			continue
		}
		remaining = append(remaining, index)
	}
	if selectedByRule {
		if len(remaining) == 0 {
			delete(group.byRule, request.RuleID)
		} else {
			group.byRule[request.RuleID] = remaining
		}
		return
	}
	if len(remaining) == 0 {
		delete(group.byListenPort, request.ListenPort)
	} else {
		group.byListenPort[request.ListenPort] = remaining
	}
}

func (group *mutableSharedFXPEntryGroup) removeRule(ruleID int) {
	for _, index := range group.byRule[ruleID] {
		group.removeSlot(index)
	}
	delete(group.byRule, ruleID)
}

func (group *mutableSharedFXPEntryGroup) removeListenConflicts(entry fxpSpec) {
	endpoints, endpointCount := sharedFXPEntryEndpoints(entry)
	for endpointIndex := 0; endpointIndex < endpointCount; endpointIndex++ {
		endpoint := endpoints[endpointIndex]
		for _, index := range group.byEndpoint[endpoint] {
			group.removeSlot(index)
		}
		delete(group.byEndpoint, endpoint)
	}
}

func (group *mutableSharedFXPEntryGroup) snapshot() fxpSpec {
	entries := make([]fxpSpec, 0, len(group.active))
	for index := range group.slots {
		if group.slots[index].active {
			entries = append(entries, group.slots[index].entry)
		}
	}
	snapshot, _ := buildSharedFXPEntryGroup(entries, group.tunnelID, group.transportVersion)
	return snapshot
}

type sharedFXPEntryGroupMutation struct {
	actionIndex      int
	key              string
	spec             fxpSpec
	appendEntry      bool
	replaceConflicts bool
}

func sharedFXPEntryGroupMutationForAction(actionIndex int, item action) (sharedFXPEntryGroupMutation, bool) {
	if item.Fxp == nil {
		return sharedFXPEntryGroupMutation{}, false
	}

	op := strings.TrimSpace(item.Op)
	raw := *item.Fxp
	if op == "remove" {
		role := strings.TrimSpace(raw.Role)
		if raw.TunnelID <= 0 || (role != "" && !strings.EqualFold(role, "entry")) {
			return sharedFXPEntryGroupMutation{}, false
		}
		transportVersion := normalizeFXPTransportVersion(raw.TransportVersion)
		return sharedFXPEntryGroupMutation{
			actionIndex: actionIndex,
			key:         fxpEntryGroupKey(transportVersion, raw.TunnelID),
			spec:        raw,
		}, true
	}

	spec := normalizeFXPSpec(raw)
	if !isSharedFXPEntry(spec) {
		return sharedFXPEntryGroupMutation{}, false
	}
	return sharedFXPEntryGroupMutation{
		actionIndex:      actionIndex,
		key:              fxpEntryGroupKey(spec.TransportVersion, spec.TunnelID),
		spec:             spec,
		appendEntry:      op == "apply",
		replaceConflicts: item.Op == "apply",
	}, true
}

func attachDesiredSharedFXPEntryGroups(actions []action) {
	mutations := make([]sharedFXPEntryGroupMutation, 0, len(actions))
	groups := map[string]*mutableSharedFXPEntryGroup{}
	for index, item := range actions {
		mutation, ok := sharedFXPEntryGroupMutationForAction(index, item)
		if !ok {
			continue
		}
		mutations = append(mutations, mutation)
		if groups[mutation.key] != nil {
			continue
		}
		transportVersion := normalizeFXPTransportVersion(mutation.spec.TransportVersion)
		groups[mutation.key] = newMutableSharedFXPEntryGroup(mutation.spec.TunnelID, transportVersion)
	}
	if len(mutations) == 0 {
		return
	}

	for _, persisted := range loadPersistedFXPSpecs() {
		if !isSharedFXPEntry(persisted) {
			continue
		}
		if group := groups[fxpEntryGroupKey(persisted.TransportVersion, persisted.TunnelID)]; group != nil {
			group.add(persisted)
		}
	}
	// A desired non-FXP apply supersedes any persisted NEX member with the
	// same rule identity. Remove it before attaching the final group to sibling
	// NEX actions so those siblings rebuild immediately in this batch.
	for _, item := range actions {
		if strings.TrimSpace(item.Op) != "apply" || item.Fxp != nil || item.RuleID <= 0 {
			continue
		}
		removal := fxpSpec{Role: "entry", RuleID: item.RuleID, TunnelID: item.TunnelID}
		for _, group := range groups {
			group.removeMatching(removal)
		}
	}
	for _, mutation := range mutations {
		group := groups[mutation.key]
		group.removeMatching(mutation.spec)
		if mutation.replaceConflicts {
			group.removeRule(mutation.spec.RuleID)
			group.removeListenConflicts(mutation.spec)
		}
		if mutation.appendEntry {
			group.add(mutation.spec)
		}
	}

	staged := map[string]fxpSpec{}
	for key, group := range groups {
		staged[key] = group.snapshot()
	}
	for _, mutation := range mutations {
		group := staged[mutation.key]
		groupCopy := group
		actions[mutation.actionIndex].FXPEntryGroup = &groupCopy
	}
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

func fxpServerID(spec fxpSpec) string {
	if isFXPEntryGroup(spec) {
		return fxpEntryGroupServerID(spec.TransportVersion, spec.TunnelID)
	}
	return normalizeFXPTransportVersion(spec.TransportVersion) + ":" + spec.Role + ":" + strconv.Itoa(spec.TunnelID) + ":" + strconv.Itoa(spec.RuleID) + ":" + strconv.Itoa(spec.ListenPort)
}

func normalizeFXPSpec(spec fxpSpec) fxpSpec {
	spec.Role = strings.ToLower(strings.TrimSpace(spec.Role))
	spec.TransportVersion = strings.ToLower(strings.TrimSpace(spec.TransportVersion))
	if spec.TransportVersion != forwardXWireGuardVersion {
		spec.TransportVersion = "v1"
	}
	if spec.Role == fxpEntryGroupRole {
		entries := make([]fxpSpec, 0, len(spec.Entries))
		byIdentity := map[string]int{}
		for _, entry := range spec.Entries {
			entry.Entries = nil
			entry.Role = "entry"
			entry.TransportVersion = spec.TransportVersion
			entry.TunnelID = spec.TunnelID
			entry = normalizeFXPSpec(entry)
			if !isSharedFXPEntry(entry) || entry.Key == "" {
				continue
			}
			identity := fxpEntryIdentity(entry)
			if index, exists := byIdentity[identity]; exists {
				entries[index] = entry
				continue
			}
			byIdentity[identity] = len(entries)
			entries = append(entries, entry)
		}
		sort.Slice(entries, func(i, j int) bool {
			if entries[i].RuleID != entries[j].RuleID {
				return entries[i].RuleID < entries[j].RuleID
			}
			if entries[i].ListenPort != entries[j].ListenPort {
				return entries[i].ListenPort < entries[j].ListenPort
			}
			return entries[i].Protocol < entries[j].Protocol
		})
		spec.Entries = entries
		spec.RuleID = 0
		spec.ListenPort = 0
		spec.UDPListenPort = 0
		spec.Protocol = ""
		spec.Key = ""
		return spec
	}
	spec.Entries = nil
	spec.Protocol = normalizeRuntimeProtocol(spec.Protocol)
	spec.ListenHost = strings.TrimSpace(spec.ListenHost)
	spec.ExitHost = strings.TrimSpace(spec.ExitHost)
	switch strings.ToLower(strings.TrimSpace(spec.ExitStrategy)) {
	case "fallback", "random", "ip_hash":
		spec.ExitStrategy = strings.ToLower(strings.TrimSpace(spec.ExitStrategy))
	default:
		spec.ExitStrategy = "round_robin"
	}
	spec.ExitPeerID = strings.TrimSpace(spec.ExitPeerID)
	spec.TargetIP = strings.TrimSpace(spec.TargetIP)
	spec.RelayExitHost = strings.TrimSpace(spec.RelayExitHost)
	spec.RelayPeerID = strings.TrimSpace(spec.RelayPeerID)
	if spec.UDPListenPort <= 0 {
		spec.UDPListenPort = spec.ListenPort
	}
	if spec.UDPExitPort <= 0 {
		spec.UDPExitPort = spec.ExitPort
	}
	if spec.UDPRelayExitPort <= 0 {
		spec.UDPRelayExitPort = spec.RelayExitPort
	}
	for i := range spec.Exits {
		spec.Exits[i].Host = strings.TrimSpace(spec.Exits[i].Host)
		spec.Exits[i].PeerID = strings.TrimSpace(spec.Exits[i].PeerID)
		if spec.Exits[i].UDPPort <= 0 {
			spec.Exits[i].UDPPort = spec.Exits[i].Port
		}
		if spec.Exits[i].Key == "" {
			spec.Exits[i].Key = spec.Key
		}
	}
	targets := make([]fxpUDPTarget, 0, len(spec.UDPTargets))
	seenTargets := map[int]bool{}
	for _, target := range spec.UDPTargets {
		target.TargetIP = strings.TrimSpace(target.TargetIP)
		if target.RuleID <= 0 || target.TargetIP == "" || target.TargetPort <= 0 || target.TargetPort > 65535 || seenTargets[target.RuleID] {
			continue
		}
		seenTargets[target.RuleID] = true
		targets = append(targets, target)
	}
	sort.Slice(targets, func(i, j int) bool { return targets[i].RuleID < targets[j].RuleID })
	spec.UDPTargets = targets
	streamTargets := make([]fxpUDPTarget, 0, len(spec.StreamTargets))
	seenStreamTargets := map[fxpUDPTarget]bool{}
	for _, target := range spec.StreamTargets {
		target.TargetIP = strings.TrimSpace(target.TargetIP)
		if target.RuleID <= 0 || target.TargetIP == "" || target.TargetPort <= 0 || target.TargetPort > 65535 || seenStreamTargets[target] {
			continue
		}
		seenStreamTargets[target] = true
		streamTargets = append(streamTargets, target)
	}
	sort.SliceStable(streamTargets, func(i, j int) bool { return streamTargets[i].RuleID < streamTargets[j].RuleID })
	spec.StreamTargets = streamTargets
	spec = normalizeFXPMultipath(spec)
	return spec
}

// normalizeFXPMultipath cleans the multipath leg list and only leaves striping
// enabled when there are at least two usable legs, since one leg is just an
// ordinary single-path session.
func normalizeFXPMultipath(spec fxpSpec) fxpSpec {
	legs := make([]fxpMultipathLeg, 0, len(spec.MultipathLegs))
	seen := map[string]bool{}
	for _, leg := range spec.MultipathLegs {
		leg.Host = strings.TrimSpace(leg.Host)
		leg.Via = strings.TrimSpace(leg.Via)
		if leg.Host == "" || leg.Port <= 0 || leg.Port > 65535 {
			continue
		}
		if strings.TrimSpace(leg.Key) == "" {
			leg.Key = spec.Key
		}
		endpoint := net.JoinHostPort(leg.Host, strconv.Itoa(leg.Port))
		if seen[endpoint] {
			continue
		}
		seen[endpoint] = true
		legs = append(legs, leg)
	}
	if len(legs) < 2 {
		spec.MultipathEnabled = false
		spec.MultipathLegs = nil
		return spec
	}
	spec.MultipathLegs = legs
	if spec.MultipathMaxPending < 0 {
		spec.MultipathMaxPending = 0
	}
	return spec
}

func fxpServerSignature(spec fxpSpec) string {
	spec = normalizeFXPSpec(spec)
	if isFXPEntryGroup(spec) {
		parts := []string{spec.Role, spec.TransportVersion, strconv.Itoa(spec.TunnelID)}
		for _, entry := range spec.Entries {
			parts = append(parts, fxpServerSignature(entry))
		}
		return strings.Join(parts, "||")
	}
	parts := []string{
		spec.Role,
		spec.TransportVersion,
		strconv.Itoa(spec.TunnelID),
		strconv.Itoa(spec.RuleID),
		strconv.Itoa(spec.ListenPort),
		strconv.Itoa(spec.UDPListenPort),
		spec.ListenHost,
		spec.Protocol,
		spec.ExitHost,
		strconv.Itoa(spec.ExitPort),
		strconv.Itoa(spec.UDPExitPort),
		spec.ExitPeerID,
		spec.ExitStrategy,
		spec.TargetIP,
		strconv.Itoa(spec.TargetPort),
		spec.Key,
		strconv.FormatInt(spec.LimitIn, 10),
		strconv.FormatInt(spec.LimitOut, 10),
		strconv.Itoa(spec.MaxConnections),
		strconv.Itoa(spec.MaxIPs),
		spec.AccessScope,
		strconv.FormatBool(spec.BlockHTTP),
		strconv.FormatBool(spec.BlockSocks),
		strconv.FormatBool(spec.BlockTLS),
		strconv.FormatBool(spec.ProxyProtocolReceive),
		strconv.FormatBool(spec.ProxyProtocolSend),
		strconv.FormatBool(spec.ProxyProtocolExitReceive),
		strconv.FormatBool(spec.ProxyProtocolExitSend),
		strconv.Itoa(normalizeProxyProtocolVersion(spec.ProxyProtocolVersion)),
		strconv.FormatBool(spec.TCPFastOpen),
		// 链路整形的档位和上限变了要让 FXP 重读配置（热更新就够，监听不动）；
		// 提示值只在 FXP 启动时用，不进签名。
		strings.ToLower(strings.TrimSpace(spec.LinkShaping)),
		strconv.Itoa(spec.LinkUpMbps),
		strconv.Itoa(spec.LinkDownMbps),
		strings.ToLower(strings.TrimSpace(spec.EgressShaping)),
		strconv.Itoa(spec.EgressMbps),
		spec.RelayExitHost,
		strconv.Itoa(spec.RelayExitPort),
		strconv.Itoa(spec.UDPRelayExitPort),
		spec.RelayPeerID,
		spec.RelayKey,
		strconv.Itoa(spec.DNSGeneration),
		// Multipath belongs in the signature: switching a tunnel between
		// failover and aggregate changes only these fields, and the runtime
		// must restart to pick the new mode up.
		strconv.FormatBool(spec.MultipathEnabled),
		strconv.Itoa(spec.MultipathMaxPending),
	}
	for _, leg := range spec.MultipathLegs {
		parts = append(parts, strings.TrimSpace(leg.Host), strconv.Itoa(leg.Port), strings.TrimSpace(leg.Key))
	}
	for _, exit := range spec.Exits {
		parts = append(parts, strings.TrimSpace(exit.Host), strconv.Itoa(exit.Port), strconv.Itoa(exit.UDPPort), strings.TrimSpace(exit.Key), strings.TrimSpace(exit.PeerID))
	}
	for _, target := range spec.UDPTargets {
		parts = append(parts, strconv.Itoa(target.RuleID), strings.TrimSpace(target.TargetIP), strconv.Itoa(target.TargetPort))
	}
	// TCP 目标表变了出口必须拿到新配置，否则新规则的连接会被出口拒掉。
	parts = append(parts, "stream")
	for _, target := range spec.StreamTargets {
		parts = append(parts, strconv.Itoa(target.RuleID), strings.TrimSpace(target.TargetIP), strconv.Itoa(target.TargetPort))
	}
	return strings.Join(parts, "|")
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

func stopConflictingFXP(spec fxpSpec) {
	for _, conflicting := range stopConflictingFXPRuntime(spec) {
		if !isFXPEntryGroup(spec) || !fxpEntryGroupContains(spec, conflicting) {
			removePersistedFXPSpec(conflicting)
		}
	}
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

func stopFXPByPort(tunnelID int, listenPort int, protocol string) bool {
	if tunnelID <= 0 {
		return true
	}
	return stopFXPBySelector(fxpRuntimeSelector{tunnelID: tunnelID, listenPort: listenPort, protocol: protocol})
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

func listenPortBusy(proto string, port int) bool {
	if port <= 0 {
		return false
	}
	switch proto {
	case "udp":
		conn, err := net.ListenPacket("udp", ":"+strconv.Itoa(port))
		if err != nil {
			return true
		}
		_ = conn.Close()
		return false
	default:
		ln, err := net.Listen("tcp", ":"+strconv.Itoa(port))
		if err != nil {
			return true
		}
		_ = ln.Close()
		return false
	}
}

func runtimeProtocols(protocol string) []string {
	switch normalizeRuntimeProtocol(protocol) {
	case "udp":
		return []string{"udp"}
	case "both":
		return []string{"tcp", "udp"}
	default:
		return []string{"tcp"}
	}
}

func actionPortProtocolKey(port int, protocol string) string {
	if !validActionPort(port) {
		return ""
	}
	return fmt.Sprintf("%d:%s", port, normalizeRuntimeProtocol(protocol))
}

func runningRuleIDPortKey(ruleID int, port int) string {
	if ruleID <= 0 || !validActionPort(port) {
		return ""
	}
	return fmt.Sprintf("%d:%d", ruleID, port)
}

func protectedActionMatchesPort(protectedPorts map[string]bool, port string, protocol string) bool {
	if len(protectedPorts) == 0 || strings.TrimSpace(port) == "" {
		return false
	}
	if protectedPorts[port] {
		return true
	}
	portNumber := atoi(port)
	if portNumber <= 0 {
		return false
	}
	normalized := normalizeRuntimeProtocol(protocol)
	if protectedPorts[actionPortProtocolKey(portNumber, normalized)] || protectedPorts[actionPortProtocolKey(portNumber, "both")] {
		return true
	}
	if normalized == "both" {
		return protectedPorts[actionPortProtocolKey(portNumber, "tcp")] || protectedPorts[actionPortProtocolKey(portNumber, "udp")]
	}
	return false
}

func normalizeRuntimeProtocol(protocol string) string {
	value := strings.ToLower(strings.TrimSpace(protocol))
	compact := strings.NewReplacer(" ", "", "\t", "", "_", "", "+", "", "-", "", "/", "").Replace(value)
	switch {
	case value == "udp":
		return "udp"
	case value == "both" || compact == "tcpudp" || compact == "udptcp" || compact == "tcpandudp" || compact == "udpandtcp":
		return "both"
	default:
		return "tcp"
	}
}

func runtimeProtocolsOverlap(left string, right string) bool {
	leftProtocol := normalizeRuntimeProtocol(left)
	rightProtocol := normalizeRuntimeProtocol(right)
	return leftProtocol == "both" || rightProtocol == "both" || leftProtocol == rightProtocol
}

type protocolGuardRateDirection string

const (
	protocolGuardRateIn  protocolGuardRateDirection = "in"
	protocolGuardRateOut protocolGuardRateDirection = "out"
)

type protocolGuardRateKey struct {
	scope     string
	direction protocolGuardRateDirection
}

// protocolGuardSharedRateLimiter is shared by all guards using the same
// scope and direction. rate.Limiter is safe for concurrent use; the mutex
// protects the small amount of configuration metadata used for hot updates.
type protocolGuardSharedRateLimiter struct {
	mu             sync.Mutex
	limiter        *rate.Limiter
	changed        chan struct{}
	bytesPerSecond int64
	burst          int
	refs           int
}

var errProtocolGuardRateLimiterChanged = errors.New("protocol guard rate limiter changed")

func normalizeProtocolGuardRateLimit(value int64) int64 {
	if value <= 0 {
		return 0
	}
	return value
}

func protocolGuardRateBurst(bytesPerSecond int64) int {
	bytesPerSecond = normalizeProtocolGuardRateLimit(bytesPerSecond)
	if bytesPerSecond <= 0 {
		return protocolGuardRateBurstMin
	}
	// A 100 ms burst keeps the limiter smooth at normal rates while the
	// minimum still admits one maximum-sized UDP datagram or copy chunk.
	burst := bytesPerSecond / 10
	if burst < protocolGuardRateBurstMin {
		burst = protocolGuardRateBurstMin
	}
	if burst > protocolGuardRateBurstMax {
		burst = protocolGuardRateBurstMax
	}
	return int(burst)
}

func normalizeProtocolGuardRateLimitScope(scope string, ruleID, listenPort int) string {
	scope = strings.ToLower(strings.TrimSpace(scope))
	if scope != "" {
		return scope
	}
	// Empty scopes must not accidentally pool unrelated rules. Rule IDs are
	// stable across heartbeats and therefore provide a deterministic fallback.
	return fmt.Sprintf("guard:%d:%d", ruleID, listenPort)
}

func (l *protocolGuardSharedRateLimiter) setRate(bytesPerSecond int64) {
	if l == nil {
		return
	}
	bytesPerSecond = normalizeProtocolGuardRateLimit(bytesPerSecond)
	burst := protocolGuardRateBurst(bytesPerSecond)
	l.mu.Lock()
	if l.bytesPerSecond == bytesPerSecond && l.burst == burst {
		l.mu.Unlock()
		return
	}
	now := time.Now()
	// SetBurstAt before SetLimitAt preserves accumulated tokens as much as
	// possible when a user changes the value while traffic is flowing.
	l.limiter.SetBurstAt(now, burst)
	l.limiter.SetLimitAt(now, rate.Limit(bytesPerSecond))
	l.bytesPerSecond = bytesPerSecond
	l.burst = burst
	oldChanged := l.changed
	l.changed = make(chan struct{})
	l.mu.Unlock()
	if oldChanged != nil {
		// Cancel reservations made against the previous configuration. Waiters
		// retry against the new rate without tearing down their TCP connection.
		close(oldChanged)
	}
}

func acquireProtocolGuardRateLimiter(scope string, direction protocolGuardRateDirection, bytesPerSecond int64) *protocolGuardSharedRateLimiter {
	bytesPerSecond = normalizeProtocolGuardRateLimit(bytesPerSecond)
	if bytesPerSecond <= 0 {
		return nil
	}
	key := protocolGuardRateKey{scope: scope, direction: direction}
	protocolGuardRateMu.Lock()
	defer protocolGuardRateMu.Unlock()
	limiter := protocolGuardRates[key]
	if limiter == nil {
		burst := protocolGuardRateBurst(bytesPerSecond)
		limiter = &protocolGuardSharedRateLimiter{
			limiter:        rate.NewLimiter(rate.Limit(bytesPerSecond), burst),
			changed:        make(chan struct{}),
			bytesPerSecond: bytesPerSecond,
			burst:          burst,
		}
		protocolGuardRates[key] = limiter
	} else {
		limiter.setRate(bytesPerSecond)
	}
	limiter.refs++
	return limiter
}

func releaseProtocolGuardRateLimiter(scope string, direction protocolGuardRateDirection, limiter *protocolGuardSharedRateLimiter) {
	if limiter == nil {
		return
	}
	key := protocolGuardRateKey{scope: scope, direction: direction}
	protocolGuardRateMu.Lock()
	current := protocolGuardRates[key]
	if current != limiter {
		protocolGuardRateMu.Unlock()
		return
	}
	if limiter.refs > 0 {
		limiter.refs--
	}
	if limiter.refs == 0 {
		delete(protocolGuardRates, key)
	}
	shouldCancel := limiter.refs == 0
	protocolGuardRateMu.Unlock()
	if shouldCancel {
		limiter.cancelWaiters()
	}
}

func (l *protocolGuardSharedRateLimiter) cancelWaiters() {
	if l == nil {
		return
	}
	l.mu.Lock()
	changed := l.changed
	l.changed = nil
	l.mu.Unlock()
	if changed != nil {
		close(changed)
	}
}

func (l *protocolGuardSharedRateLimiter) wait(ctx context.Context, guardChanged <-chan struct{}, bytes int) error {
	if l == nil || bytes <= 0 {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	// The configured burst is intentionally at least the largest payload we
	// pass here. Keep a defensive split for future callers with larger chunks.
	for bytes > 0 {
		n := bytes
		// Every configured bucket has at least this burst. Using the stable
		// minimum prevents a concurrent burst decrease from invalidating a
		// WaitN request that was sized using stale configuration.
		if n > protocolGuardRateWaitChunk {
			n = protocolGuardRateWaitChunk
		}
		for {
			l.mu.Lock()
			limiter, limiterChanged := l.limiter, l.changed
			l.mu.Unlock()
			if limiter == nil || limiterChanged == nil {
				return errProtocolGuardRateLimiterChanged
			}
			now := time.Now()
			reservation := limiter.ReserveN(now, n)
			if !reservation.OK() {
				return fmt.Errorf("protocol guard rate reservation exceeds burst: bytes=%d", n)
			}
			delay := reservation.DelayFrom(now)
			if delay <= 0 {
				break
			}
			readyAt := now.Add(delay)
			timer := time.NewTimer(delay)
			select {
			case <-timer.C:
				break
			case <-ctx.Done():
				stopProtocolGuardRateTimer(timer)
				reservation.CancelAt(time.Now())
				return ctx.Err()
			case <-guardChanged:
				now = time.Now()
				stopProtocolGuardRateTimer(timer)
				if !now.Before(readyAt) {
					break
				}
				reservation.CancelAt(now)
				return errProtocolGuardRateLimiterChanged
			case <-limiterChanged:
				now = time.Now()
				stopProtocolGuardRateTimer(timer)
				if !now.Before(readyAt) {
					break
				}
				reservation.CancelAt(now)
				continue
			}
			break
		}
		bytes -= n
	}
	return nil
}

func stopProtocolGuardRateTimer(timer *time.Timer) {
	if timer == nil || timer.Stop() {
		return
	}
	select {
	case <-timer.C:
	default:
	}
}

type protocolGuardServer struct {
	rule        guardRule
	tcpLn       net.Listener
	udpConn     net.PacketConn
	done        chan struct{}
	doneOnce    sync.Once
	ctx         context.Context
	cancel      context.CancelFunc
	rateMu      sync.RWMutex
	rateScope   string
	rateIn      *protocolGuardSharedRateLimiter
	rateOut     *protocolGuardSharedRateLimiter
	rateChanged chan struct{}
	closed      bool
	// halfCloseLinger 为 0 时用 tcpRelayHalfCloseLinger；测试里调短。
	halfCloseLinger time.Duration
}

func newProtocolGuardServer(rule guardRule) *protocolGuardServer {
	ctx, cancel := context.WithCancel(context.Background())
	server := &protocolGuardServer{
		rule:   rule,
		done:   make(chan struct{}),
		ctx:    ctx,
		cancel: cancel,
	}
	server.updateRateLimits(rule)
	return server
}

func (s *protocolGuardServer) updateRateLimits(rule guardRule) {
	if s == nil {
		return
	}
	scope := normalizeProtocolGuardRateLimitScope(rule.RateLimitScope, rule.RuleID, rule.ListenPort)
	limitIn := normalizeProtocolGuardRateLimit(rule.LimitIn)
	limitOut := normalizeProtocolGuardRateLimit(rule.LimitOut)
	in := acquireProtocolGuardRateLimiter(scope, protocolGuardRateIn, limitIn)
	out := acquireProtocolGuardRateLimiter(scope, protocolGuardRateOut, limitOut)
	s.rateMu.Lock()
	if s.closed {
		s.rateMu.Unlock()
		releaseProtocolGuardRateLimiter(scope, protocolGuardRateIn, in)
		releaseProtocolGuardRateLimiter(scope, protocolGuardRateOut, out)
		return
	}
	oldScope, oldIn, oldOut := s.rateScope, s.rateIn, s.rateOut
	changed := oldScope != scope || oldIn != in || oldOut != out
	var oldRateChanged chan struct{}
	if changed {
		oldRateChanged = s.rateChanged
		s.rateChanged = make(chan struct{})
	}
	s.rateScope, s.rateIn, s.rateOut = scope, in, out
	s.rateMu.Unlock()
	if oldRateChanged != nil {
		close(oldRateChanged)
	}
	if oldIn != nil {
		releaseProtocolGuardRateLimiter(oldScope, protocolGuardRateIn, oldIn)
	}
	if oldOut != nil {
		releaseProtocolGuardRateLimiter(oldScope, protocolGuardRateOut, oldOut)
	}
}

func (s *protocolGuardServer) rateLimiter(direction protocolGuardRateDirection) *protocolGuardSharedRateLimiter {
	if s == nil {
		return nil
	}
	s.rateMu.RLock()
	defer s.rateMu.RUnlock()
	if direction == protocolGuardRateOut {
		return s.rateOut
	}
	return s.rateIn
}

func (s *protocolGuardServer) rateWaitState(direction protocolGuardRateDirection) (*protocolGuardSharedRateLimiter, <-chan struct{}) {
	if s == nil {
		return nil, nil
	}
	s.rateMu.RLock()
	defer s.rateMu.RUnlock()
	if direction == protocolGuardRateOut {
		return s.rateOut, s.rateChanged
	}
	return s.rateIn, s.rateChanged
}

func (s *protocolGuardServer) waitRate(ctx context.Context, direction protocolGuardRateDirection, bytes int) error {
	if s == nil || bytes <= 0 {
		return nil
	}
	if ctx == nil {
		ctx = s.ctx
	}
	if ctx == nil {
		ctx = context.Background()
	}
	for bytes > 0 {
		n := bytes
		if n > protocolGuardRateWaitChunk {
			n = protocolGuardRateWaitChunk
		}
		for {
			if s.ctx != nil {
				if serverErr := s.ctx.Err(); serverErr != nil {
					return serverErr
				}
			}
			limiter, rateChanged := s.rateWaitState(direction)
			if limiter == nil {
				return nil
			}
			err := limiter.wait(ctx, rateChanged, n)
			if err == nil {
				break
			}
			if ctxErr := ctx.Err(); ctxErr != nil {
				return ctxErr
			}
			if s.ctx != nil {
				if serverErr := s.ctx.Err(); serverErr != nil {
					return serverErr
				}
			}
			if errors.Is(err, errProtocolGuardRateLimiterChanged) {
				// The guard switched scope, enabled/disabled a direction, or changed
				// rate. Fetch the current limiter and retry only this unfinished chunk.
				continue
			}
			return err
		}
		bytes -= n
	}
	return nil
}

type protocolGuardInspection struct {
	mu                   sync.Mutex
	policy               protocolPolicy
	clientSample         []byte
	serverSample         []byte
	socksVersion         byte
	socks5Methods        map[byte]bool
	socksCandidate       atomic.Bool
	clientInspectionDone bool
	blocked              bool
}

func newProtocolGuardInspection(policy protocolPolicy) *protocolGuardInspection {
	return &protocolGuardInspection{policy: policy}
}

func (i *protocolGuardInspection) inspectClient(chunk []byte) (string, bool) {
	if i == nil || len(chunk) == 0 || !i.policy.enabled() {
		return "", false
	}
	i.mu.Lock()
	defer i.mu.Unlock()
	if i.blocked || i.clientInspectionDone {
		return "", false
	}
	if len(i.clientSample) < protocolGuardSampleMaxBytes {
		remaining := protocolGuardSampleMaxBytes - len(i.clientSample)
		if remaining > len(chunk) {
			remaining = len(chunk)
		}
		i.clientSample = append(i.clientSample, chunk[:remaining]...)
	}
	if i.policy.BlockHTTP && detectHTTPProtocol(i.clientSample) {
		i.blocked = true
		i.clientInspectionDone = true
		i.socksCandidate.Store(false)
		return "http", true
	}
	if i.policy.BlockTLS && detectTLSProtocol(i.clientSample) {
		i.blocked = true
		i.clientInspectionDone = true
		i.socksCandidate.Store(false)
		return "tls", true
	}
	if !i.policy.BlockSocks {
		i.clientInspectionDone = len(i.clientSample) >= protocolGuardSampleMaxBytes
		return "", false
	}
	version, methods, ok := detectSocksClientHandshake(i.clientSample)
	if !ok {
		i.socksVersion = 0
		i.socks5Methods = nil
		i.serverSample = nil
		i.socksCandidate.Store(false)
		i.clientInspectionDone = len(i.clientSample) >= protocolGuardSampleMaxBytes
		return "", false
	}
	i.socksVersion = version
	i.socks5Methods = methods
	i.serverSample = nil
	i.socksCandidate.Store(true)
	return "", false
}

// clientFinished 表示客户端方向不再需要逐块检测：没开协议拦截，或者样本已经
// 收满且不是待确认的 SOCKS 握手。clientInspectionDone 一旦置位就不会再被清掉
// （inspectClient 之后直接返回），所以这个结论是终态，可以放心切到 splice。
func (i *protocolGuardInspection) clientFinished() bool {
	if i == nil || !i.policy.enabled() {
		return true
	}
	i.mu.Lock()
	defer i.mu.Unlock()
	return i.clientInspectionDone && !i.blocked && !i.socksCandidate.Load()
}

// serverFinished 表示服务端方向不再需要逐块检测。服务端数据只用来确认 SOCKS
// 握手，没开 SOCKS 拦截时从一开始就不用看；开了的话要等客户端检测结束，否则
// 后面的客户端数据还可能让连接变成待确认的 SOCKS 候选。
func (i *protocolGuardInspection) serverFinished() bool {
	if i == nil || !i.policy.enabled() || !i.policy.BlockSocks {
		return true
	}
	return i.clientFinished()
}

func (i *protocolGuardInspection) inspectServer(chunk []byte) (string, bool) {
	if i == nil || len(chunk) == 0 || !i.socksCandidate.Load() {
		return "", false
	}
	i.mu.Lock()
	defer i.mu.Unlock()
	if i.blocked || i.socksVersion == 0 {
		return "", false
	}
	if len(i.serverSample) < 16 {
		remaining := 16 - len(i.serverSample)
		if remaining > len(chunk) {
			remaining = len(chunk)
		}
		i.serverSample = append(i.serverSample, chunk[:remaining]...)
	}
	switch i.socksVersion {
	case 0x05:
		if len(i.serverSample) < 2 {
			return "", false
		}
		method := i.serverSample[1]
		if i.serverSample[0] == 0x05 && (method == 0xff || i.socks5Methods[method]) {
			i.blocked = true
			i.clientInspectionDone = true
			i.socksCandidate.Store(false)
			return "socks", true
		}
	case 0x04:
		if len(i.serverSample) < 8 {
			return "", false
		}
		status := i.serverSample[1]
		if (i.serverSample[0] == 0x00 || i.serverSample[0] == 0x04) && status >= 0x5a && status <= 0x5d {
			i.blocked = true
			i.clientInspectionDone = true
			i.socksCandidate.Store(false)
			return "socks", true
		}
	}
	i.socksVersion = 0
	i.socks5Methods = nil
	i.serverSample = nil
	i.socksCandidate.Store(false)
	return "", false
}

type lookingGlassTask struct {
	TaskID            string   `json:"taskId"`
	Method            string   `json:"method"`
	Target            string   `json:"target"`
	ResolvedAddress   string   `json:"resolvedAddress"`
	ResolvedAddresses []string `json:"resolvedAddresses"`
	Family            int      `json:"family"`
	Port              int      `json:"port"`
	// iperf3 客户端（method = iperf3-client）：-R、-P、-t；UDP 模式（-u -b）用来测
	// 链路的限速点，UDPMbps 是每条流的发送速率（0 = 不限）。
	Reverse   bool   `json:"reverse,omitempty"`
	Streams   int    `json:"streams,omitempty"`
	Seconds   int    `json:"seconds,omitempty"`
	UDP       bool   `json:"udp,omitempty"`
	UDPMbps   int    `json:"udpMbps,omitempty"`
	CreatedAt string `json:"createdAt"`
}

type lookingGlassResult struct {
	TaskID            string   `json:"taskId"`
	Method            string   `json:"method"`
	Target            string   `json:"target"`
	Port              int      `json:"port,omitempty"`
	ResolvedAddress   string   `json:"resolvedAddress"`
	ResolvedAddresses []string `json:"resolvedAddresses"`
	Output            string   `json:"output"`
	ExitCode          *int     `json:"exitCode"`
	TimedOut          bool     `json:"timedOut"`
	DurationMs        int      `json:"durationMs"`
	StartedAt         string   `json:"startedAt"`
	FinishedAt        string   `json:"finishedAt"`
	Error             string   `json:"error,omitempty"`
}

type iperf3Task struct {
	TaskID    string `json:"taskId"`
	Op        string `json:"op"`
	Port      int    `json:"port"`
	CreatedAt string `json:"createdAt"`
}

type iperf3Result struct {
	TaskID    string `json:"taskId"`
	Op        string `json:"op"`
	Port      int    `json:"port"`
	Status    string `json:"status"`
	Output    string `json:"output"`
	PID       int    `json:"pid,omitempty"`
	StartedAt string `json:"startedAt,omitempty"`
	UpdatedAt string `json:"updatedAt,omitempty"`
	Error     string `json:"error,omitempty"`
}

type iperf3Process struct {
	taskID       string
	port         int
	cfg          Config
	cmd          *exec.Cmd
	startedAt    time.Time
	outputMu     sync.Mutex
	output       string
	done         chan struct{}
	doneOnce     sync.Once
	lastActivity atomic.Int64
}

func (p *iperf3Process) appendLine(line string) {
	line = strings.TrimSpace(line)
	if line == "" {
		return
	}
	p.lastActivity.Store(time.Now().UnixNano())
	p.outputMu.Lock()
	defer p.outputMu.Unlock()
	if p.output == "" {
		p.output = line
		return
	}
	if len(p.output) > 32000 {
		p.output = p.output[len(p.output)-24000:]
		p.output = "... 输出已截断\n" + p.output
	}
	p.output += "\n" + line
}

func (p *iperf3Process) currentOutput() string {
	p.outputMu.Lock()
	defer p.outputMu.Unlock()
	return strings.TrimSpace(p.output)
}

func (p *iperf3Process) readPipe(r io.Reader, wg *sync.WaitGroup) {
	defer wg.Done()
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 4096), 1024*1024)
	for scanner.Scan() {
		p.appendLine(scanner.Text())
	}
	if err := scanner.Err(); err != nil {
		message := strings.ToLower(err.Error())
		if strings.Contains(message, "file already closed") || strings.Contains(message, "closed pipe") {
			return
		}
		p.appendLine(fmt.Sprintf("读取 iperf3 输出失败：%v", err))
	}
}

func (p *iperf3Process) watchIdleTimeout() {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			last := time.Unix(0, p.lastActivity.Load())
			if time.Since(last) < iperf3IdleTimeout {
				continue
			}
			var result *iperf3Result
			iperf3Mu.Lock()
			if iperf3Server == p {
				p.stopLocked("3 分钟无客户端测试，已自动停止 iperf3 服务端")
				iperf3Server = nil
				result = &iperf3Result{
					TaskID:    p.taskID,
					Op:        "stop",
					Port:      p.port,
					Status:    "stopped",
					Output:    p.currentOutput(),
					StartedAt: p.startedAt.Format(time.RFC3339Nano),
				}
			}
			iperf3Mu.Unlock()
			if result != nil {
				reportIperf3Result(p.cfg, *result)
			}
			return
		case <-p.done:
			return
		}
	}
}

func (p *iperf3Process) stopLocked(reason string) string {
	p.appendLine(reason)
	if p.cmd != nil && p.cmd.Process != nil {
		_ = p.cmd.Process.Kill()
	}
	p.doneOnce.Do(func() { close(p.done) })
	return p.currentOutput()
}

func (p *iperf3Process) markExited(err error) {
	status := "stopped"
	errText := ""
	if err != nil && !strings.Contains(err.Error(), "killed") {
		status = "error"
		errText = fmt.Sprintf("iperf3 服务端异常退出：%v", err)
		p.appendLine(errText)
	} else {
		p.appendLine("iperf3 服务端已停止")
	}
	p.doneOnce.Do(func() { close(p.done) })
	var result *iperf3Result
	iperf3Mu.Lock()
	if iperf3Server == p {
		iperf3Server = nil
		result = &iperf3Result{
			TaskID:    p.taskID,
			Op:        "stop",
			Port:      p.port,
			Status:    status,
			Output:    p.currentOutput(),
			StartedAt: p.startedAt.Format(time.RFC3339Nano),
			Error:     errText,
		}
	}
	iperf3Mu.Unlock()
	if result != nil {
		reportIperf3Result(p.cfg, *result)
	}
}

type failoverProxy struct {
	ruleID         int
	sourcePort     int
	spec           failoverSpec
	signature      string
	activeIndex    int
	roundRobinNext int
	targetHealth   []bool
	failureSince   []time.Time
	recoveredSince []time.Time
	// 每条出站最近一次探测的往返耗时（毫秒）。原来 tcpLatency 的返回值是直接
	// 丢掉的 —— 数据一直在采，白扔了，而它正是「哪条线路更快」唯一的现成原料。
	lastLatencyMs []int
	// 每条出站的探测样本窗口：评分、丢包、抖动、可用率、连续失败都从它算（route_group.go）。
	stats []*routeTargetStats
	// 面板从中转机的探测得知这条路径的中转挂了（failoverTarget.Down）。不是本机探出来的，
	// 单独记着，本机的探测结果盖不掉它，规格重下发也不会把它清掉。
	relayDown       []bool
	relayDownReason []string
	// 走各条出站的客户端连接：「快速故障转移 / 强制切换」要断旧连接时用。
	conns []map[net.Conn]struct{}
	rng   *mathrand.Rand
	// 上一次切换的时刻，最短驻留时间从这儿算。
	lastSwitchAt time.Time
	// 现在这条是从什么时候开始走的。和 lastSwitchAt 不同，起代理、换规格（活跃
	// 线路会被重置回第 0 条）也要重新计时 —— 这两种情况不算「切换」，不该拿去
	// 卡最短驻留，但面板要知道「从什么时候起走的这条」。
	activeSince time.Time
	// 自动择优的候选，以及它从什么时候开始一直是候选。
	fastestCandidate int
	fastestSince     time.Time
	// 计划切换：正在预热的那条、预检没过的那条（-1 = 没有）。
	prewarmIndex        int
	precheckFailedIndex int
	// 上一轮评估时人工指定的是哪条（-1 = 没有）：从「有」变成「没有」要报一条「指定到期」。
	pinnedLast int
	// 上面三个 -1 才是「没有」，而 Go 的零值是 0（一个合法的出站序号），所以第一次用之前
	// 要显式初始化一遍；见 ensureHealthStateLocked。
	stateInitialized bool
	// TCP 和 UDP 各一个监听，按规格的 protocol 开：tcp 只有 ln，udp 只有 udp，both 两个都有。
	ln         net.Listener
	udp        net.PacketConn
	done       chan struct{}
	retireOnce sync.Once
	mu         sync.RWMutex
	// UDP 会话：按来源地址记，一个会话一直走它挑中的那条路径，空闲够久回收（route_group_udp.go）。
	// 每个包都要查会话表，查表只拿读锁；增删会话才拿写锁。
	udpMu       sync.RWMutex
	udpSessions map[netip.AddrPort]*failoverUDPSession
	// 进行中的一轮健康检查：所有目标都拨不通时，每个新连接都会要求立即检查一次，
	// 同一时刻只跑一轮，其余连接等它的结果（见 checkHealthShared）。
	healthFlightMu sync.Mutex
	healthFlight   chan struct{}
}

func failoverID(ruleID int, sourcePort int) string {
	return strconv.Itoa(ruleID) + ":" + strconv.Itoa(sourcePort)
}

func newFailoverRand(ruleID int, sourcePort int) *mathrand.Rand {
	return mathrand.New(mathrand.NewSource(time.Now().UnixNano() + int64(ruleID*100000+sourcePort)))
}

func failoverSignature(spec failoverSpec) string {
	parts := []string{
		strconv.Itoa(spec.ListenPort),
		spec.BindAddress,
		failoverProtocol(spec),
		spec.Strategy,
		strconv.Itoa(spec.FailoverSeconds),
		strconv.Itoa(spec.RecoverSeconds),
		strconv.FormatBool(spec.AutoFailback),
		strconv.Itoa(spec.MinHoldSeconds),
		func() string {
			if spec.PinnedIndex == nil {
				return "-"
			}
			return strconv.Itoa(*spec.PinnedIndex)
		}(),
		strconv.FormatInt(spec.PinnedUntil, 10),
		strconv.FormatBool(spec.PreferFastest),
		failoverScheduleSignature(spec.Schedule),
		strconv.Itoa(spec.FailureThreshold),
		strconv.Itoa(spec.ScoreMargin),
		strconv.Itoa(spec.ScoreHoldSeconds),
		strconv.Itoa(spec.PrewarmSeconds),
		spec.SwitchMode,
		strconv.FormatBool(spec.ProxyProtocolReceive),
		strconv.FormatBool(spec.ProxyProtocolStrip),
	}
	for _, target := range spec.Targets {
		// Down / DownReason 是面板随时会变的运行时提示，故意不进签名：进了的话每次提示变化
		// 都会重建代理，探测样本和「现在走哪条」全部归零。它们走 applyRelayHintsLocked。
		parts = append(parts, target.TargetIP, strconv.Itoa(target.TargetPort), target.ProbeIP, strconv.Itoa(target.ProbePort), strconv.Itoa(target.Weight))
	}
	return strings.Join(parts, "|")
}

func normalizeFailoverSpec(spec failoverSpec) failoverSpec {
	if spec.BindAddress == "" {
		spec.BindAddress = "127.0.0.1"
	}
	spec.Protocol = failoverProtocol(spec)
	switch strings.TrimSpace(spec.Strategy) {
	case "round_robin", "random", "ip_hash", "weighted", "fallback":
		spec.Strategy = strings.TrimSpace(spec.Strategy)
	default:
		spec.Strategy = "fallback"
	}
	if spec.FailoverSeconds <= 0 {
		spec.FailoverSeconds = 60
	}
	if spec.RecoverSeconds <= 0 {
		spec.RecoverSeconds = 120
	}
	if spec.MinHoldSeconds < 0 {
		spec.MinHoldSeconds = 0
	}
	// 没带这几个字段的规格（老面板、老快照）按上一版的行为走：失败一次就算、评分门槛按
	// 原来写死的常数、不预热。
	if spec.FailureThreshold < 1 {
		spec.FailureThreshold = 1
	}
	if spec.FailureThreshold > 20 {
		spec.FailureThreshold = 20
	}
	if spec.ScoreMargin <= 0 {
		spec.ScoreMargin = 10
	}
	if spec.ScoreHoldSeconds <= 0 {
		spec.ScoreHoldSeconds = failoverFastestHoldSeconds
	}
	if spec.PrewarmSeconds < 0 {
		spec.PrewarmSeconds = 0
	}
	switch strings.TrimSpace(spec.SwitchMode) {
	case "fast", "force":
		spec.SwitchMode = strings.TrimSpace(spec.SwitchMode)
	default:
		spec.SwitchMode = "smooth"
	}
	if spec.PinnedIndex != nil && (*spec.PinnedIndex < 0 || *spec.PinnedIndex >= len(spec.Targets)) {
		spec.PinnedIndex = nil
		spec.PinnedUntil = 0
	}
	if spec.PinnedIndex == nil {
		spec.PinnedUntil = 0
	}
	spec.Schedule = normalizeFailoverSchedule(spec.Schedule)
	cleaned := make([]failoverTarget, 0, len(spec.Targets))
	for _, target := range spec.Targets {
		target.TargetIP = strings.TrimSpace(target.TargetIP)
		if target.TargetIP == "" || target.TargetPort <= 0 || target.TargetPort > 65535 {
			continue
		}
		// 探测目标填得不合法时退回「探出站地址本身」，也就是老行为 —— 不能因为
		// 一个填错的探测地址就让这条出站永远探不通、被当成挂了。
		target.ProbeIP = strings.TrimSpace(target.ProbeIP)
		if target.ProbeIP == "" || target.ProbePort <= 0 || target.ProbePort > 65535 {
			target.ProbeIP = ""
			target.ProbePort = 0
		}
		if target.Weight < 0 {
			target.Weight = 0
		}
		if target.Weight > 100 {
			target.Weight = 100
		}
		target.DownReason = strings.TrimSpace(target.DownReason)
		if !target.Down {
			target.DownReason = ""
		}
		cleaned = append(cleaned, target)
		if len(cleaned) >= 11 {
			break
		}
	}
	spec.Targets = cleaned
	return spec
}

func startFailoverProxy(ruleID int, sourcePort int, spec failoverSpec, actionMessage *actionMessage) bool {
	failoverControlMu.Lock()
	defer failoverControlMu.Unlock()
	return startFailoverProxyLocked(ruleID, sourcePort, spec, actionMessage)
}

func startFailoverProxyLocked(ruleID int, sourcePort int, spec failoverSpec, actionMessage *actionMessage) bool {
	spec = normalizeFailoverSpec(spec)
	if !spec.Enabled || spec.ListenPort <= 0 || len(spec.Targets) < 2 {
		removePersistedFailoverSpec(ruleID, sourcePort)
		return true
	}
	id := failoverID(ruleID, sourcePort)
	signature := failoverSignature(spec)
	failoverMu.Lock()
	existing := failoverProxies[id]
	if existing != nil && existing.signature == signature {
		failoverMu.Unlock()
		// 规格没变，变的只可能是面板附带的中转提示。
		existing.mu.Lock()
		existing.applyRelayHintsLocked(spec.Targets)
		existing.mu.Unlock()
		if err := persistFailoverSpec(ruleID, sourcePort, spec); err != nil {
			logf("failover persistent snapshot write failed rule=%d port=%d: %v", ruleID, sourcePort, err)
		}
		return true
	}
	if existing != nil {
		existing.mu.Lock()
		sameAddress := existing.spec.ListenPort == spec.ListenPort && existing.spec.BindAddress == spec.BindAddress
		sameProtocol := failoverProtocol(existing.spec) == failoverProtocol(spec)
		sameEndpoint := sameAddress && sameProtocol
		if !sameEndpoint {
			existing.mu.Unlock()
			if sameAddress {
				/*
					同一个地址换了协议（tcp → both 之类）：新监听要绑的端口旧的还占着，先起新的再收
					旧的那一套在这里行不通。先收旧的 —— 换协议是用户改了规则，前面的转发工具本来
					也要重启，这一下中断躲不掉。
				*/
				delete(failoverProxies, id)
				failoverMu.Unlock()
				existing.retire()
			} else {
				failoverMu.Unlock()
			}
		} else {
			existing.rebuildForSpecLocked(spec, time.Now())
			existing.mu.Unlock()
			existing.signature = signature
			failoverMu.Unlock()
			if err := persistFailoverSpec(ruleID, sourcePort, spec); err != nil {
				logf("failover persistent snapshot write failed rule=%d port=%d: %v", ruleID, sourcePort, err)
			}
			logf("failover proxy updated rule=%d source=%d listen=%s:%d strategy=%s targets=%d", ruleID, sourcePort, spec.BindAddress, spec.ListenPort, spec.Strategy, len(spec.Targets))
			return true
		}
	} else {
		failoverMu.Unlock()
	}

	addr := net.JoinHostPort(spec.BindAddress, strconv.Itoa(spec.ListenPort))
	protocol := failoverProtocol(spec)
	var ln net.Listener
	var udpConn net.PacketConn
	var err error
	if protocol != "udp" {
		ln, err = net.Listen("tcp", addr)
	}
	if err == nil && protocol != "tcp" {
		udpConn, err = net.ListenPacket("udp", addr)
		if err != nil && ln != nil {
			_ = ln.Close()
			ln = nil
		}
	}
	if err != nil {
		if actionMessage != nil {
			actionMessage.set("failover proxy listen failed rule=%d addr=%s protocol=%s: %v", ruleID, addr, protocol, err)
		} else {
			logf("failover proxy listen failed rule=%d addr=%s protocol=%s: %v", ruleID, addr, protocol, err)
		}
		return false
	}
	p := &failoverProxy{
		ruleID:      ruleID,
		sourcePort:  sourcePort,
		spec:        spec,
		signature:   signature,
		activeSince: time.Now(),
		rng:         newFailoverRand(ruleID, sourcePort),
		ln:          ln,
		udp:         udpConn,
		done:        make(chan struct{}),
	}
	p.ensureHealthStateLocked()
	failoverMu.Lock()
	previous := failoverProxies[id]
	failoverProxies[id] = p
	failoverMu.Unlock()
	// The new socket is already listening before the old one is retired. This
	// keeps a failed bind from tearing down the working proxy and makes dynamic
	// internal-port handoffs continuous once the backend action completes.
	go p.healthLoop()
	if p.ln != nil {
		go p.acceptLoop()
	}
	if p.udp != nil {
		go p.serveUDP()
	}
	if previous != nil {
		previous.retire()
	}
	if err := persistFailoverSpec(ruleID, sourcePort, spec); err != nil {
		logf("failover persistent snapshot write failed rule=%d port=%d: %v", ruleID, sourcePort, err)
	}
	logf("failover proxy started rule=%d source=%d listen=%s protocol=%s strategy=%s targets=%d", ruleID, sourcePort, addr, protocol, spec.Strategy, len(spec.Targets))
	return true
}

func stopFailoverProxy(ruleID int, sourcePort int) {
	failoverControlMu.Lock()
	defer failoverControlMu.Unlock()
	stopFailoverProxyLocked(ruleID, sourcePort)
}

func stopFailoverProxyLocked(ruleID int, sourcePort int) {
	stopFailoverProxyRuntime(ruleID, sourcePort)
	removePersistedFailoverSpec(ruleID, sourcePort)
}

func stopFailoverProxyRuntime(ruleID int, sourcePort int) {
	if ruleID <= 0 || sourcePort <= 0 {
		return
	}
	id := failoverID(ruleID, sourcePort)
	failoverMu.Lock()
	p := failoverProxies[id]
	if p != nil {
		delete(failoverProxies, id)
	}
	failoverMu.Unlock()
	if p == nil {
		return
	}
	p.retire()
}

func (p *failoverProxy) ensureHealthStateLocked() {
	n := len(p.spec.Targets)
	if !p.stateInitialized {
		p.stateInitialized = true
		p.fastestCandidate = -1
		p.prewarmIndex = -1
		p.precheckFailedIndex = -1
		p.pinnedLast = -1
	}
	if len(p.lastLatencyMs) != n {
		p.lastLatencyMs = make([]int, n)
	}
	if len(p.targetHealth) != n {
		p.targetHealth = make([]bool, n)
		for i := range p.targetHealth {
			p.targetHealth[i] = true
		}
	}
	if len(p.failureSince) != n {
		p.failureSince = make([]time.Time, n)
	}
	if len(p.recoveredSince) != n {
		p.recoveredSince = make([]time.Time, n)
	}
	if len(p.stats) != n {
		p.stats = make([]*routeTargetStats, n)
	}
	for i := range p.stats {
		if p.stats[i] == nil {
			p.stats[i] = &routeTargetStats{}
		}
	}
	if len(p.relayDown) != n {
		p.relayDown = make([]bool, n)
		p.relayDownReason = make([]string, n)
		for i, target := range p.spec.Targets {
			p.relayDown[i] = target.Down
			if target.Down {
				p.relayDownReason[i] = strings.TrimSpace(target.DownReason)
			}
		}
	}
	if len(p.conns) != n {
		p.conns = make([]map[net.Conn]struct{}, n)
	}
	for i := range p.conns {
		if p.conns[i] == nil {
			p.conns[i] = map[net.Conn]struct{}{}
		}
	}
	if p.activeIndex < 0 || p.activeIndex >= n {
		p.activeIndex = 0
	}
}

func failoverRemoteIP(conn net.Conn) string {
	if conn == nil || conn.RemoteAddr() == nil {
		return ""
	}
	host, _, err := net.SplitHostPort(conn.RemoteAddr().String())
	if err == nil {
		return host
	}
	return conn.RemoteAddr().String()
}

func failoverHashIndex(key string, count int) int {
	if count <= 0 {
		return 0
	}
	h := fnv.New32a()
	_, _ = h.Write([]byte(key))
	return int(h.Sum32() % uint32(count))
}

func (p *failoverProxy) candidateIndicesLocked(exclude map[int]bool, healthyOnly bool) []int {
	indices := make([]int, 0, len(p.spec.Targets))
	for i := range p.spec.Targets {
		if exclude != nil && exclude[i] {
			continue
		}
		if healthyOnly && !p.healthyLocked(i) {
			continue
		}
		indices = append(indices, i)
	}
	return indices
}

func (p *failoverProxy) pickTarget(client net.Conn, exclude map[int]bool) (failoverTarget, int) {
	return p.pickTargetForKey(failoverRemoteIP(client), exclude)
}

// 挑一条路径。hashKey 只有「按访客固定」用：TCP 是访客 IP（带 PROXY 头时从头里读），
// UDP 是会话的来源地址。
func (p *failoverProxy) pickTargetForKey(hashKey string, exclude map[int]bool) (failoverTarget, int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.ensureHealthStateLocked()
	if len(p.spec.Targets) == 0 {
		return failoverTarget{}, -1
	}
	candidates := p.candidateIndicesLocked(exclude, true)
	if len(candidates) == 0 {
		candidates = p.candidateIndicesLocked(exclude, false)
	}
	if len(candidates) == 0 {
		return failoverTarget{}, -1
	}
	index := candidates[0]
	switch p.spec.Strategy {
	case "weighted":
		index = p.weightedPickLocked(candidates)
	case "round_robin":
		index = candidates[p.roundRobinNext%len(candidates)]
		p.roundRobinNext = (p.roundRobinNext + 1) % 1000000
	case "random":
		if p.rng == nil {
			p.rng = newFailoverRand(p.ruleID, p.sourcePort)
		}
		index = candidates[p.rng.Intn(len(candidates))]
	case "ip_hash":
		key := hashKey
		if key == "" {
			key = strconv.Itoa(p.sourcePort)
		}
		index = candidates[failoverHashIndex(key, len(candidates))]
	default:
		if !p.healthyLocked(p.activeIndex) || (exclude != nil && exclude[p.activeIndex]) {
			index = candidates[0]
		} else {
			index = p.activeIndex
		}
	}
	return p.spec.Targets[index], index
}

func (p *failoverProxy) setActiveLocked(index int, reason string) {
	if index < 0 || index >= len(p.spec.Targets) || p.activeIndex == index {
		return
	}
	old := p.activeIndex
	closeOld := p.shouldCloseOldConnsLocked(old)
	p.activeIndex = index
	p.lastSwitchAt = time.Now()
	p.activeSince = p.lastSwitchAt
	p.precheckFailedIndex = -1
	next := p.spec.Targets[index]
	logf("failover switch rule=%d source=%d %d->%d target=%s:%d reason=%s", p.ruleID, p.sourcePort, old, index, next.TargetIP, next.TargetPort, reason)
	from := ""
	if old >= 0 && old < len(p.spec.Targets) {
		from = failoverTargetLabel(p.spec.Targets[old])
	}
	recordFailoverProxyEvent(failoverProxyEvent{
		RuleID: p.ruleID, SourcePort: p.sourcePort, Kind: "switch",
		FromTarget: from, ToTarget: failoverTargetLabel(next),
		FromIndex: old, ToIndex: index,
		Reason: reason, LatencyMs: p.latencyMsLocked(index), Score: p.scoreValueLocked(index),
	})
	if closeOld {
		if closed := p.closeConnsLocked(old); closed > 0 {
			logf("failover closed %d connection(s) on old target rule=%d source=%d index=%d mode=%s", closed, p.ruleID, p.sourcePort, old, p.spec.SwitchMode)
		}
	}
}

// 调用方必须已经持有 p.mu。
func (p *failoverProxy) recordTargetEventLocked(index int, kind string, reason string) {
	if index < 0 || index >= len(p.spec.Targets) {
		return
	}
	recordFailoverProxyEvent(failoverProxyEvent{
		RuleID: p.ruleID, SourcePort: p.sourcePort, Kind: kind,
		ToTarget:  failoverTargetLabel(p.spec.Targets[index]),
		FromIndex: -1, ToIndex: index,
		Reason: reason, LatencyMs: p.latencyMsLocked(index), Score: p.scoreValueLocked(index),
	})
}

func (p *failoverProxy) latencyMsLocked(index int) int {
	if index < 0 || index >= len(p.lastLatencyMs) || p.lastLatencyMs[index] <= 0 {
		return 0
	}
	return p.lastLatencyMs[index]
}

/*
出站的优先次序。

没有时段表时就是数组顺序（也就是这个功能加进来之前的行为）。时段表命中时，把它
指定的那一条提到最前，其余保持原来的相对次序 —— 时段表只改「谁是首选」，不重排
剩下的兜底顺序。
*/
// 人工钉住的那条还算不算数。
func (p *failoverProxy) pinnedIndexAt(now time.Time) int {
	if p.spec.PinnedIndex == nil {
		return -1
	}
	index := *p.spec.PinnedIndex
	if index < 0 || index >= len(p.spec.Targets) {
		return -1
	}
	if p.spec.PinnedUntil > 0 && now.UnixMilli() >= p.spec.PinnedUntil {
		return -1
	}
	return index
}

// 此刻的首选是哪条、是谁定的：人工 > 时段表 > 自动择优 > 数组顺序（-1, ""）。
//
// 人工钉住是运维拿来压过自动判断的，压不过就没有意义；时段表是人**事先**排好
// 的意图，也该压过机器自己算出来的择优。
func (p *failoverProxy) preferredLocked(now time.Time) (int, string) {
	count := len(p.spec.Targets)
	if index := p.pinnedIndexAt(now); index >= 0 && index < count {
		return index, "pin"
	}
	if index := failoverScheduleTargetIndexAt(p.spec.Schedule, now); index >= 0 && index < count {
		return index, "schedule"
	}
	if index := p.fastestIndexLocked(now); index >= 0 && index < count {
		return index, "score"
	}
	return -1, ""
}

func (p *failoverProxy) orderFromPreferredLocked(preferred int) []int {
	count := len(p.spec.Targets)
	order := make([]int, 0, count)
	if preferred >= 0 && preferred < count {
		order = append(order, preferred)
	}
	for index := 0; index < count; index++ {
		if len(order) > 0 && order[0] == index {
			continue
		}
		order = append(order, index)
	}
	return order
}

func (p *failoverProxy) priorityOrderLocked(now time.Time) []int {
	preferred, _ := p.preferredLocked(now)
	return p.orderFromPreferredLocked(preferred)
}

/*
自动择优（智能择优）：按线路评分挑一条明显更好的。

**不是「谁好切谁」** —— 那样线路会一直漂：两条线在几分之间来回，每次探测都能得出不同的
结论，而每次切换都会让新连接换一条路。所以要过两道门槛：

	· 明显更好：候选评分高出 ScoreMargin 分（默认 10）；或者延迟快 20 毫秒且快 20%（延迟优先
	  的用法：两条都很好的线路评分只差一两分，可 60ms 和 35ms 对游戏是两回事）而评分不比当前低
	· 持续时间：连着 ScoreHoldSeconds（默认 180 秒）都是它，才算数

评分本身由 routeScore 算（延迟、丢包、抖动、可用率），和面板同一份公式。
*/
const failoverFastestMarginMs = 20
const failoverFastestMarginRatio = 0.2
const failoverFastestHoldSeconds = 180

func (p *failoverProxy) resetFastestLocked() {
	p.fastestCandidate = -1
	p.fastestSince = time.Time{}
}

func (p *failoverProxy) fastestIndexLocked(now time.Time) int {
	if !p.spec.PreferFastest || len(p.spec.Targets) < 2 {
		return -1
	}
	p.ensureHealthStateLocked()
	activeScore, activeScored := p.scoreLocked(p.activeIndex)
	activeLatency := p.scoreInputLocked(p.activeIndex).latencyMs
	best := -1
	bestScore := 0
	bestLatency := 0
	for index := range p.spec.Targets {
		if index == p.activeIndex || !p.healthyLocked(index) {
			continue
		}
		// 还没法打分（没探出耗时）的不能当成「好得不得了」。
		score, scored := p.scoreLocked(index)
		if !scored {
			continue
		}
		latency := p.scoreInputLocked(index).latencyMs
		if best < 0 || score > bestScore || (score == bestScore && latency > 0 && latency < bestLatency) {
			best, bestScore, bestLatency = index, score, latency
		}
	}
	if best < 0 || !activeScored || !p.healthyLocked(p.activeIndex) {
		p.resetFastestLocked()
		return -1
	}
	better := bestScore-activeScore >= p.spec.ScoreMargin
	if !better && activeLatency > 0 && bestLatency > 0 && bestScore >= activeScore {
		margin := activeLatency - bestLatency
		better = margin >= failoverFastestMarginMs && float64(margin) >= float64(activeLatency)*failoverFastestMarginRatio
	}
	if !better {
		p.resetFastestLocked()
		return -1
	}
	// fastestSince 是零值时必须当成「还没开始计时」。
	//
	// fastestCandidate 的 Go 零值是 0，所以第一次评估如果恰好选中第 0 条，
	// `p.fastestCandidate != best` 会是 false，而 now.Sub(零时刻) 是个巨大的数 ——
	// 持续时间那道门槛会被整个跳过，第一次探测就切。这三道门槛里最重要的一道
	// 就这么没了，而且只在「最快的恰好是第 0 条」时发生，最难查。
	if p.fastestCandidate != best || p.fastestSince.IsZero() {
		p.fastestCandidate = best
		p.fastestSince = now
		return -1
	}
	if now.Sub(p.fastestSince) < time.Duration(p.spec.ScoreHoldSeconds)*time.Second {
		return -1
	}
	return best
}

// 刚切过去，还在最短驻留时间里。
func (p *failoverProxy) holdingLocked(now time.Time) bool {
	if p.spec.MinHoldSeconds <= 0 || p.lastSwitchAt.IsZero() {
		return false
	}
	return now.Sub(p.lastSwitchAt) < time.Duration(p.spec.MinHoldSeconds)*time.Second
}

func (p *failoverProxy) updateFallbackActiveLocked(reason string) {
	p.updateFallbackActiveAtLocked(time.Now(), reason)
}

// 人工指定到期了：报一条「指定到期」，这一轮切回去的原因也随之写成「指定到期」。
func (p *failoverProxy) notePinStateLocked(now time.Time) bool {
	pinned := p.pinnedIndexAt(now)
	expired := false
	if p.pinnedLast >= 0 && pinned < 0 && p.spec.PinnedIndex != nil {
		expired = true
		logf("failover pin expired rule=%d source=%d index=%d", p.ruleID, p.sourcePort, p.pinnedLast)
		p.recordTargetEventLocked(p.pinnedLast, "unpinned", "pin expired")
	}
	p.pinnedLast = pinned
	return expired
}

/*
计划切换的预热：时段表再过 PrewarmSeconds 就要换首选了，提前把那条标成「预热中」。

所有出站本来就每 5 秒探一次，预热并不需要额外的探测；它的意义是让面板提前告诉人
「17:55 起预热 B，18:00 切」，以及到点时预检拿得出足够新的样本。只在开始预热那一刻记一条事件。
*/
func (p *failoverProxy) notePrewarmLocked(now time.Time) {
	if p.spec.PrewarmSeconds <= 0 || p.spec.Schedule == nil || p.pinnedIndexAt(now) >= 0 {
		p.prewarmIndex = -1
		return
	}
	current := failoverScheduleTargetIndexAt(p.spec.Schedule, now)
	if current < 0 {
		current = 0
	}
	upcoming := failoverScheduleTargetIndexAt(p.spec.Schedule, now.Add(time.Duration(p.spec.PrewarmSeconds)*time.Second))
	if upcoming < 0 {
		upcoming = 0
	}
	if upcoming >= len(p.spec.Targets) || upcoming == current || upcoming == p.activeIndex {
		p.prewarmIndex = -1
		return
	}
	if p.prewarmIndex == upcoming {
		return
	}
	p.prewarmIndex = upcoming
	logf("failover prewarm rule=%d source=%d target=%d in=%ds", p.ruleID, p.sourcePort, upcoming, p.spec.PrewarmSeconds)
	p.recordTargetEventLocked(upcoming, "prewarm", "schedule")
}

func (p *failoverProxy) notePrecheckFailedLocked(index int, issue string) {
	if p.precheckFailedIndex == index {
		return
	}
	p.precheckFailedIndex = index
	logf("failover planned switch held rule=%d source=%d target=%d precheck=%s", p.ruleID, p.sourcePort, index, issue)
	p.recordTargetEventLocked(index, "precheck_failed", "precheck: "+issue)
}

/*
把「现在几点」作为参数传进来，而不是在里面读 time.Now()。

时段表的行为只有按指定时刻才测得准：读真实时钟的话，「18 点到了而那条线正挂着，
不该切过去」这条用例只在真实时间落在 18-23 点时才真的走到判断，其余时候压根没有
窗口命中 —— 测试照常绿，但什么都没验证。这种测试比没有更糟，因为它看起来在保护。
*/
func (p *failoverProxy) updateFallbackActiveAtLocked(now time.Time, reason string) {
	if len(p.spec.Targets) == 0 || p.spec.Strategy != "fallback" {
		return
	}
	p.ensureHealthStateLocked()
	pinExpired := p.notePinStateLocked(now)
	preferred, source := p.preferredLocked(now)
	p.notePrewarmLocked(now)
	order := p.orderFromPreferredLocked(preferred)

	if p.healthyLocked(p.activeIndex) {
		candidate := -1
		for _, index := range order {
			// 走到当前这条了，说明前面没有更优且健康的，保持不动。
			if index == p.activeIndex {
				break
			}
			if p.healthyLocked(index) {
				candidate = index
				break
			}
		}
		if candidate < 0 {
			p.precheckFailedIndex = -1
			return
		}
		// 切换的原因写给人看：按时段表、线路评分更优、人工指定，其余都是「首选恢复，切回」。
		switchReason := "failback"
		if candidate == preferred {
			switch source {
			case "pin", "schedule", "score":
				switchReason = source
			}
		}
		if switchReason == "failback" && pinExpired {
			switchReason = "pin expired"
		}
		// 「首选恢复后切不切回」只管切回这件事；人定的时段表和指定、机器算出来的择优照常。
		if switchReason == "failback" && !p.spec.AutoFailback {
			return
		}
		// 按优先级往回切是可以等的：刚切过来就被拽回去，线路会来回抖。
		// 人工指定不等：人说了算，等上 10 分钟只会让人以为没生效。
		if switchReason != "pin" && p.holdingLocked(now) {
			return
		}
		// 计划内的切换（到点、切回）先预检，不过就不切；故障逃生和人工指定不预检。
		if p.spec.PrewarmSeconds > 0 && switchReason != "pin" && switchReason != "score" {
			if issue := p.precheckIssueLocked(candidate); issue != "" {
				p.notePrecheckFailedLocked(candidate, issue)
				return
			}
		}
		p.setActiveLocked(candidate, switchReason)
		return
	}
	/*
		当前这条挂了：按优先级找第一条健康的，**不受最短驻留限制**。

		守着一条死路比抖动更糟 —— 最短驻留是拿来防「好线路之间来回切」的，
		不是拿来拖着不逃生的。
	*/
	for _, index := range order {
		if p.healthyLocked(index) {
			p.setActiveLocked(index, reason)
			return
		}
	}
}

/*
真实连接拨不通。

上一版拨不通一次就把这条出站标成坏的。一次拨号失败在公网上太常见了（对端偶尔 RST、
中间设备抽风），为它切一次线路等于把抖动放大成切换。现在算进连续失败次数，到了
FailureThreshold 才标记 —— 那条连接本身照样换下一条出站去拨，客户端不会因此失败。
*/
func (p *failoverProxy) markTargetFailure(index int, reason string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.ensureHealthStateLocked()
	if index < 0 || index >= len(p.spec.Targets) {
		return
	}
	stats := p.statsLocked(index)
	stats.recordDialFailure()
	if p.targetHealth[index] {
		target := p.spec.Targets[index]
		if stats.consecutiveFailures < p.spec.FailureThreshold {
			logVerbosef("failover target dial failed rule=%d source=%d index=%d target=%s:%d failures=%d/%d", p.ruleID, p.sourcePort, index, target.TargetIP, target.TargetPort, stats.consecutiveFailures, p.spec.FailureThreshold)
			return
		}
		p.targetHealth[index] = false
		p.failureSince[index] = time.Now()
		p.recoveredSince[index] = time.Time{}
		logf("failover target unhealthy rule=%d source=%d index=%d target=%s:%d reason=%s", p.ruleID, p.sourcePort, index, target.TargetIP, target.TargetPort, reason)
		p.recordTargetEventLocked(index, "unhealthy", reason)
	}
	p.updateFallbackActiveLocked(reason)
}

func (p *failoverProxy) healthLoop() {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-p.done:
			return
		case <-ticker.C:
			p.checkHealthShared()
		}
	}
}

// checkHealthShared 单飞版的 checkHealth：已有一轮在跑就等它跑完直接用结果。
// 所有目标都不通时大量客户端同时进来，以前每个连接都同步探测全部目标一遍，
// 探测本身把机器和目标都压住了。
func (p *failoverProxy) checkHealthShared() {
	p.healthFlightMu.Lock()
	if flight := p.healthFlight; flight != nil {
		p.healthFlightMu.Unlock()
		select {
		case <-flight:
		case <-p.done:
		}
		return
	}
	flight := make(chan struct{})
	p.healthFlight = flight
	p.healthFlightMu.Unlock()
	defer func() {
		p.healthFlightMu.Lock()
		p.healthFlight = nil
		p.healthFlightMu.Unlock()
		close(flight)
	}()
	p.checkHealth()
}

func (p *failoverProxy) checkHealth() {
	now := time.Now()
	p.mu.RLock()
	targets := append([]failoverTarget(nil), p.spec.Targets...)
	failoverSeconds := p.spec.FailoverSeconds
	recoverSeconds := p.spec.RecoverSeconds
	failureThreshold := p.spec.FailureThreshold
	protocol := failoverProtocol(p.spec)
	specSignature := failoverSignature(p.spec)
	p.mu.RUnlock()
	if len(targets) == 0 {
		return
	}
	// 各条路径并行探测：客户端在所有路径都拨不通时会同步等这一轮（checkHealthShared），
	// 串行时 N 条路径就要等 N×2 秒。
	latencies, results := probeFailoverTargets(protocol, targets)
	p.mu.Lock()
	defer p.mu.Unlock()
	if failoverSignature(p.spec) != specSignature {
		return
	}
	p.ensureHealthStateLocked()
	for i := range results {
		if i < len(p.lastLatencyMs) {
			p.lastLatencyMs[i] = latencies[i]
		}
		if i < len(p.stats) {
			p.statsLocked(i).recordProbe(results[i], latencies[i], now)
		}
	}
	for i, ok := range results {
		if i >= len(p.spec.Targets) {
			break
		}
		target := p.spec.Targets[i]
		if ok {
			p.failureSince[i] = time.Time{}
			if !p.targetHealth[i] {
				if p.recoveredSince[i].IsZero() {
					p.recoveredSince[i] = now
				} else if now.Sub(p.recoveredSince[i]) >= time.Duration(recoverSeconds)*time.Second {
					p.targetHealth[i] = true
					p.recoveredSince[i] = time.Time{}
					logf("failover target recovered rule=%d source=%d index=%d target=%s:%d", p.ruleID, p.sourcePort, i, target.TargetIP, target.TargetPort)
					p.recordTargetEventLocked(i, "recovered", "health check")
				}
			} else {
				p.recoveredSince[i] = time.Time{}
			}
			continue
		}
		p.recoveredSince[i] = time.Time{}
		if p.targetHealth[i] {
			if p.failureSince[i].IsZero() {
				p.failureSince[i] = now
			}
			// 两道门槛都要过：连续失败够 FailureThreshold 次，而且持续异常够 FailoverSeconds 秒。
			// 只按次数，一次探测超时 + 一次拨号失败就切；只按时间，老规格（阈值 1）的行为不变。
			if p.statsLocked(i).consecutiveFailures >= failureThreshold && now.Sub(p.failureSince[i]) >= time.Duration(failoverSeconds)*time.Second {
				p.targetHealth[i] = false
				p.failureSince[i] = time.Time{}
				logf("failover target unhealthy rule=%d source=%d index=%d target=%s:%d reason=health check", p.ruleID, p.sourcePort, i, target.TargetIP, target.TargetPort)
				p.recordTargetEventLocked(i, "unhealthy", "health check")
			}
		}
	}
	p.updateFallbackActiveLocked("health check")
}

func (p *failoverProxy) acceptLoop() {
	var backoff serveLoopBackoff
	for {
		client, err := p.ln.Accept()
		if err != nil {
			// 以前临时错误（如 EMFILE）会在这里零间隔空转并每次刷一条日志。
			exit, fatal := serveLoopHandleError(p.done, &backoff, err, func(err error, suppressed int) {
				logf("failover accept failed rule=%d source=%d suppressed=%d: %v", p.ruleID, p.sourcePort, suppressed, err)
			})
			if fatal {
				p.abandonAfterServeFailure("tcp accept", err)
			}
			if exit {
				return
			}
			continue
		}
		backoff.success()
		go p.handleConn(client)
	}
}

// abandonAfterServeFailure 监听意外失效时把代理从运行表里摘掉并收尾，
// 下一轮对账看到它不在了就会重建；不摘掉的话规格签名没变，对账会一直认为它还在跑。
func (p *failoverProxy) abandonAfterServeFailure(what string, err error) {
	id := failoverID(p.ruleID, p.sourcePort)
	failoverMu.Lock()
	current := failoverProxies[id] == p
	if current {
		delete(failoverProxies, id)
	}
	failoverMu.Unlock()
	p.retire()
	if current {
		logf("failover proxy %s stopped unexpectedly rule=%d source=%d; it will be rebuilt: %v", what, p.ruleID, p.sourcePort, err)
		wakeHeartbeat()
	}
}

func (p *failoverProxy) handleConn(client net.Conn) {
	defer client.Close()
	visitor, prefix := p.readVisitor(client)
	var upstream net.Conn
	var target failoverTarget
	var index int
	var err error
	attempted := map[int]bool{}
	for {
		target, index = p.pickTargetForKey(visitor, attempted)
		if index < 0 {
			logf("failover no target available rule=%d source=%d", p.ruleID, p.sourcePort)
			return
		}
		// 拨失败的路径在里面记失败、加进 attempted；允许竞速的策略可能实际连上的是另一条。
		upstream, target, index, err = p.dialFailoverPath(visitor, target, index, attempted, failoverProxyDialTimeout)
		if err == nil {
			break
		}
		p.mu.RLock()
		exhausted := len(attempted) >= len(p.spec.Targets)
		p.mu.RUnlock()
		if exhausted {
			break
		}
	}
	if err != nil {
		p.checkHealthShared()
		target, index = p.pickTargetForKey(visitor, attempted)
		if index >= 0 {
			upstream, err = failoverDialTCP(context.Background(), target, failoverProxyDialTimeout)
		} else {
			logf("failover dial failed rule=%d no target available after trying %d targets: %v", p.ruleID, len(attempted), err)
			return
		}
		if err != nil {
			logf("failover dial failed rule=%d target=%s:%d: %v", p.ruleID, target.TargetIP, target.TargetPort, err)
			return
		}
	}
	defer upstream.Close()
	// 读 PROXY 头时多读到的字节（以及透传模式下的头本身）要先补给路径，再接着原样拷。
	if len(prefix) > 0 {
		if _, err := upstream.Write(prefix); err != nil {
			return
		}
	}
	p.trackConn(index, client)
	defer p.untrackConn(index, client)
	// 等两个方向都结束（带半关闭 linger），客户端半关闭后仍能收完响应。
	relayTCPBidirectional(client, upstream, tcpRelayHalfCloseLinger)
}

func guardID(rule guardRule) string {
	return strconv.Itoa(rule.RuleID) + ":" + strconv.Itoa(rule.ListenPort)
}

func guardRoutingSignature(rule guardRule) string {
	return strings.Join([]string{
		strconv.Itoa(rule.RuleID),
		strconv.Itoa(rule.TunnelID),
		strconv.Itoa(rule.ListenPort),
		protocolGuardBindAddress(rule),
		rule.TargetIP,
		strconv.Itoa(rule.TargetPort),
		strconv.Itoa(rule.BackendPort),
		strings.TrimSpace(rule.BackendForwardType),
		normalizeRuntimeProtocol(rule.Protocol),
		strconv.FormatBool(rule.Policy.BlockHTTP),
		strconv.FormatBool(rule.Policy.BlockSocks),
		strconv.FormatBool(rule.Policy.BlockTLS),
		strconv.FormatBool(rule.ProxyProtocolReceive),
		strconv.FormatBool(rule.ProxyProtocolSend),
		strconv.Itoa(normalizeProxyProtocolVersion(rule.ProxyProtocolVersion)),
	}, "|")
}

func protocolGuardBindAddress(rule guardRule) string {
	return strings.Trim(strings.TrimSpace(rule.BindAddress), "[]")
}

func protocolGuardListenAddress(rule guardRule) string {
	return net.JoinHostPort(protocolGuardBindAddress(rule), strconv.Itoa(rule.ListenPort))
}

func protocolGuardBackendReady(rule guardRule, readiness *localRuntimeReadiness) bool {
	if rule.BackendPort <= 0 {
		return true
	}
	if readiness == nil {
		return false
	}
	backendType := strings.TrimSpace(rule.BackendForwardType)
	switch backendType {
	case "nginx", "nginx-tunnel", "nginx-tunnel-exit":
		return readiness.nginxReadyForPort(rule.BackendPort, rule.Protocol)
	case "gost", "gost-tunnel", "gost-tunnel-exit", "gost-tunnel-hop":
		return readiness.gostReadyForPortInScope(
			rule.BackendPort,
			gostRuntimeListenProtocol(backendType, rule.Protocol),
			desiredGostRuntimeScope(backendType),
		)
	case "realm", "socat":
		return runtimeListenPortReady(readiness.listenSnapshot, rule.BackendPort, rule.Protocol, managedRuleListenProcessNeedles(backendType))
	default:
		return runtimeListenPortReady(readiness.listenSnapshot, rule.BackendPort, rule.Protocol, nil)
	}
}

func protocolGuardRuleStateReady(state localRuleState, readiness *localRuntimeReadiness) bool {
	port := atoi(state.Port)
	if state.RuleID <= 0 || port <= 0 {
		return false
	}
	id := guardID(guardRule{RuleID: state.RuleID, ListenPort: port})
	protocolGuardMu.Lock()
	server := protocolGuards[id]
	protocolGuardMu.Unlock()
	if server == nil {
		return false
	}
	select {
	case <-server.done:
		return false
	default:
	}
	expected := guardRule{Protocol: state.Protocol}
	if guardTCPEnabled(expected) && server.tcpLn == nil {
		return false
	}
	if guardUDPEnabled(expected) && server.udpConn == nil {
		return false
	}
	return protocolGuardBackendReady(server.rule, readiness)
}

// guardSignature is retained for tests and callers that only need the stable
// route identity. Rate configuration is intentionally hot-swappable.
func guardSignature(rule guardRule) string {
	return guardRoutingSignature(rule)
}

func guardTCPEnabled(rule guardRule) bool {
	return normalizeRuntimeProtocol(rule.Protocol) != "udp"
}

func guardUDPEnabled(rule guardRule) bool {
	return normalizeRuntimeProtocol(rule.Protocol) != "tcp"
}

func protocolGuardTargetsOwnListener(rule guardRule) bool {
	if rule.ListenPort <= 0 || rule.TargetPort != rule.ListenPort {
		return false
	}
	host := strings.Trim(strings.TrimSpace(rule.TargetIP), "[]")
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && (ip.IsLoopback() || ip.IsUnspecified())
}

type protocolGuardSyncWaiter struct {
	cancel  chan struct{}
	started chan struct{}
	done    chan struct{}
}

func newProtocolGuardSyncWaiter() *protocolGuardSyncWaiter {
	return &protocolGuardSyncWaiter{
		cancel:  make(chan struct{}),
		started: make(chan struct{}),
		done:    make(chan struct{}),
	}
}

var protocolGuardSyncWaiterCurrent = newProtocolGuardSyncWaiter()

// Every reconciliation owns one waiter lifecycle. Replacing it closes the
// previous cancellation channel, so an obsolete generation exits even when
// its action never completes.
func advanceProtocolGuardSyncWaiter() *protocolGuardSyncWaiter {
	next := newProtocolGuardSyncWaiter()
	protocolGuardSyncWaitMu.Lock()
	previous := protocolGuardSyncWaiterCurrent
	protocolGuardSyncWaiterCurrent = next
	protocolGuardSyncWaitMu.Unlock()
	if previous != nil {
		close(previous.cancel)
	}
	return next
}

func syncProtocolGuards(cfg Config, rules []guardRule) {
	protocolGuardSyncGeneration.Add(1)
	waiter := advanceProtocolGuardSyncWaiter()
	close(waiter.started)
	defer close(waiter.done)
	protocolGuardSyncMu.Lock()
	defer protocolGuardSyncMu.Unlock()
	syncProtocolGuardsLocked(cfg, rules)
}

func syncProtocolGuardsAfterActions(cfg Config, rules []guardRule, completed []<-chan struct{}) *protocolGuardSyncWaiter {
	generation := protocolGuardSyncGeneration.Add(1)
	waiter := advanceProtocolGuardSyncWaiter()
	rules = append([]guardRule(nil), rules...)
	if len(completed) == 0 {
		syncProtocolGuardsForGeneration(cfg, rules, generation)
		close(waiter.started)
		close(waiter.done)
		return waiter
	}
	waits := append([]<-chan struct{}(nil), completed...)
	go func() {
		close(waiter.started)
		defer close(waiter.done)
		for _, done := range waits {
			if done == nil {
				continue
			}
			select {
			case <-done:
			case <-waiter.cancel:
				return
			}
		}
		select {
		case <-waiter.cancel:
			return
		default:
		}
		// Keep the existing route until its backend action completes. The final
		// sync also verifies the new backend listener before switching the Guard.
		syncProtocolGuardsForGeneration(cfg, rules, generation)
	}()
	return waiter
}

func syncProtocolGuardsForGeneration(cfg Config, rules []guardRule, generation uint64) {
	protocolGuardSyncMu.Lock()
	defer protocolGuardSyncMu.Unlock()
	if protocolGuardSyncGeneration.Load() != generation {
		return
	}
	syncProtocolGuardsLocked(cfg, rules)
}

func syncProtocolGuardsLocked(cfg Config, rules []guardRule) {
	wanted := map[string]string{}
	readiness := readLocalRuntimeReadinessCached()
	for _, rule := range rules {
		if rule.RuleID <= 0 || rule.ListenPort <= 0 || rule.TargetIP == "" || rule.TargetPort <= 0 {
			continue
		}
		if protocolGuardTargetsOwnListener(rule) {
			if shouldLogAgentReport(fmt.Sprintf("protocol-guard-self-target:%d:%d", rule.RuleID, rule.ListenPort), agentReportLogInterval) {
				logf("protocol guard rejected self target rule=%d listen=:%d target=%s:%d", rule.RuleID, rule.ListenPort, rule.TargetIP, rule.TargetPort)
			}
			continue
		}
		id := guardID(rule)
		sig := guardRoutingSignature(rule)
		wanted[id] = sig
		protocolGuardMu.Lock()
		existing := protocolGuards[id]
		protocolGuardMu.Unlock()
		if existing != nil && guardRoutingSignature(existing.rule) == sig {
			// Rate values and scope are deliberately outside the routing
			// signature. Update the token buckets in place so active listeners
			// and connections do not flap when a user changes a limit.
			existing.updateRateLimits(rule)
			continue
		}
		if !protocolGuardBackendReady(rule, &readiness) {
			if existing != nil && !protocolGuardBackendReady(existing.rule, &readiness) {
				stopProtocolGuard(id)
			}
			if shouldLogAgentReport(fmt.Sprintf("protocol-guard-backend-not-ready:%d:%d", rule.RuleID, rule.ListenPort), agentReportLogInterval) {
				logf("protocol guard backend not ready rule=%d listen=%d backend=%s:%d protocol=%s", rule.RuleID, rule.ListenPort, rule.BackendForwardType, rule.BackendPort, normalizeRuntimeProtocol(rule.Protocol))
			}
			continue
		}
		stopProtocolGuard(id)
		startProtocolGuard(cfg, rule)
	}

	protocolGuardMu.Lock()
	ids := make([]string, 0, len(protocolGuards))
	for id := range protocolGuards {
		if _, ok := wanted[id]; !ok {
			ids = append(ids, id)
		}
	}
	protocolGuardMu.Unlock()
	for _, id := range ids {
		stopProtocolGuard(id)
	}
}

func startProtocolGuard(cfg Config, rule guardRule) {
	prepareProtocolGuardPort(rule)
	server := newProtocolGuardServer(rule)
	listenAddress := protocolGuardListenAddress(rule)
	if guardTCPEnabled(rule) {
		ln, err := net.Listen("tcp", listenAddress)
		if err != nil {
			server.close()
			logf("protocol guard tcp listen failed rule=%d port=%d: %v", rule.RuleID, rule.ListenPort, err)
			return
		}
		server.tcpLn = ln
	}
	if guardUDPEnabled(rule) {
		conn, err := net.ListenPacket("udp", listenAddress)
		if err != nil {
			server.close()
			logf("protocol guard udp listen failed rule=%d port=%d: %v", rule.RuleID, rule.ListenPort, err)
			return
		}
		if udpConn, ok := conn.(*net.UDPConn); ok {
			_ = udpConn.SetReadBuffer(protocolGuardUDPReadBuffer)
		}
		server.udpConn = conn
	}
	if server.tcpLn == nil && server.udpConn == nil {
		server.close()
		logf("protocol guard no protocol enabled rule=%d port=%d protocol=%s", rule.RuleID, rule.ListenPort, rule.Protocol)
		return
	}
	protocolGuardMu.Lock()
	protocolGuards[guardID(rule)] = server
	protocolGuardMu.Unlock()
	if server.tcpLn != nil {
		go server.serveTCP(cfg)
	}
	if server.udpConn != nil {
		go server.serveUDP()
	}
	logf("protocol guard started rule=%d tunnel=%d listen=%s protocol=%s target=%s:%d proxyReceive=%v proxySend=%v proxyVersion=%d", rule.RuleID, rule.TunnelID, listenAddress, normalizeRuntimeProtocol(rule.Protocol), rule.TargetIP, rule.TargetPort, rule.ProxyProtocolReceive, rule.ProxyProtocolSend, normalizeProxyProtocolVersion(rule.ProxyProtocolVersion))
}

func prepareProtocolGuardPort(rule guardRule) {
	if rule.ListenPort <= 0 {
		return
	}
	port := strconv.Itoa(rule.ListenPort)
	stopFXPByListenEndpoint(rule.ListenPort, rule.Protocol)
	backendPort := rule.BackendPort
	if backendPort <= 0 {
		backendPort = rule.TargetPort
	}
	if backendPort != rule.ListenPort {
		cleanupGostRuntimeIfPortBusy(rule.ListenPort, rule.Protocol)
	}
	for _, cmd := range managedListenerCleanupCmds(port) {
		_ = runShell(cmd)
	}
	backendType := strings.TrimSpace(rule.BackendForwardType)
	if backendType == "" || backendPort == rule.ListenPort {
		for _, name := range []string{
			"forwardx-socat-" + port,
			"forwardx-socat-tcp-" + port,
			"forwardx-socat-udp-" + port,
			"forwardx-realm-" + port,
			"forwardx-realm-tcp-" + port,
			"forwardx-realm-udp-" + port,
			"forwardx-realm-both-" + port,
		} {
			_ = runShell(managedServiceCleanupShell(name))
		}
		_ = runShell("rm -f /etc/forwardx/realm/forwardx-realm-" + port + ".toml /etc/forwardx/realm/forwardx-realm-" + port + ".toml.sha256 /etc/forwardx/realm/forwardx-realm-tcp-" + port + ".toml /etc/forwardx/realm/forwardx-realm-tcp-" + port + ".toml.sha256 /etc/forwardx/realm/forwardx-realm-udp-" + port + ".toml /etc/forwardx/realm/forwardx-realm-udp-" + port + ".toml.sha256 /etc/forwardx/realm/forwardx-realm-both-" + port + ".toml /etc/forwardx/realm/forwardx-realm-both-" + port + ".toml.sha256 2>/dev/null || true")
	}
	if backendType != "nginx" || backendPort == rule.ListenPort {
		_ = runShell(managedNginxCleanupShell(port))
	}
	_ = runShell(nftPortCleanupCmd(port, "both"))
	for _, binary := range iptablesAgentBinaries() {
		_ = runShell(iptablesAgentDeleteDnatRulesForPort(binary, port, "both"))
	}
}

func stopProtocolGuard(id string) {
	protocolGuardMu.Lock()
	server := protocolGuards[id]
	if server != nil {
		delete(protocolGuards, id)
	}
	protocolGuardMu.Unlock()
	if server == nil {
		return
	}
	server.close()
	logf("protocol guard stopped rule=%d port=%d", server.rule.RuleID, server.rule.ListenPort)
}

func (s *protocolGuardServer) close() {
	s.doneOnce.Do(func() {
		if s.done != nil {
			close(s.done)
		}
		if s.cancel != nil {
			s.cancel()
		}
		if s.tcpLn != nil {
			_ = s.tcpLn.Close()
		}
		if s.udpConn != nil {
			_ = s.udpConn.Close()
		}
		s.rateMu.Lock()
		scope, in, out := s.rateScope, s.rateIn, s.rateOut
		rateChanged := s.rateChanged
		s.closed = true
		s.rateScope, s.rateIn, s.rateOut = "", nil, nil
		s.rateChanged = nil
		s.rateMu.Unlock()
		if rateChanged != nil {
			close(rateChanged)
		}
		releaseProtocolGuardRateLimiter(scope, protocolGuardRateIn, in)
		releaseProtocolGuardRateLimiter(scope, protocolGuardRateOut, out)
	})
}

func (s *protocolGuardServer) serveTCP(cfg Config) {
	var backoff serveLoopBackoff
	for {
		conn, err := s.tcpLn.Accept()
		if err != nil {
			// 以前第一次出错就悄悄退出，而 done 没关，就绪检查一直报“就绪”，端口却没人接。
			exit, fatal := serveLoopHandleError(s.done, &backoff, err, func(err error, suppressed int) {
				logf("protocol guard accept rule=%d suppressed=%d: %v", s.rule.RuleID, suppressed, err)
			})
			if fatal {
				s.abandonAfterServeFailure("tcp accept", err)
			}
			if exit {
				return
			}
			continue
		}
		backoff.success()
		go s.handleConn(cfg, conn)
	}
}

// abandonAfterServeFailure 监听意外失效时摘掉并关闭这个守护，done 关闭后就绪检查随即失败，
// 下一轮对账（签名相同但已不在表里）会重新启动它。
func (s *protocolGuardServer) abandonAfterServeFailure(what string, err error) {
	id := guardID(s.rule)
	protocolGuardMu.Lock()
	current := protocolGuards[id] == s
	if current {
		delete(protocolGuards, id)
	}
	protocolGuardMu.Unlock()
	s.close()
	if current {
		logf("protocol guard %s stopped unexpectedly rule=%d port=%d; it will be rebuilt: %v", what, s.rule.RuleID, s.rule.ListenPort, err)
		wakeHeartbeat()
	}
}

func (s *protocolGuardServer) handleConn(cfg Config, client net.Conn) {
	baseCtx := s.ctx
	if baseCtx == nil {
		baseCtx = context.Background()
	}
	connCtx, cancelConn := context.WithCancel(baseCtx)
	defer cancelConn()
	defer client.Close()
	stopClientClose := context.AfterFunc(connCtx, func() { _ = client.Close() })
	defer stopClientClose()
	proxyInfo := proxyProtocolInfoFromConn(client)
	first := []byte(nil)
	if s.rule.ProxyProtocolReceive {
		_ = client.SetReadDeadline(time.Now().Add(5 * time.Second))
		buf := make([]byte, 4096)
		n, err := client.Read(buf)
		_ = client.SetReadDeadline(time.Time{})
		if err != nil {
			return
		}
		if n > 0 {
			first = append(first, buf[:n]...)
		}
		parsed, remaining, ok, err := consumeProxyProtocolFromConn(client, first, 5*time.Second)
		if err != nil {
			logf("protocol guard proxy receive failed rule=%d: %v", s.rule.RuleID, err)
			return
		}
		if ok {
			proxyInfo = parsed
			first = remaining
		}
	}
	dialer := net.Dialer{Timeout: 10 * time.Second}
	target, err := dialer.DialContext(connCtx, "tcp", net.JoinHostPort(s.rule.TargetIP, strconv.Itoa(s.rule.TargetPort)))
	if err != nil {
		if connCtx.Err() == nil {
			logf("protocol guard dial target rule=%d: %v", s.rule.RuleID, err)
		}
		return
	}
	defer target.Close()
	stopTargetClose := context.AfterFunc(connCtx, func() { _ = target.Close() })
	defer stopTargetClose()
	if s.rule.ProxyProtocolSend {
		header := buildProxyProtocol(s.rule.ProxyProtocolVersion, proxyInfo, client.RemoteAddr(), target.LocalAddr(), target.RemoteAddr())
		if len(header) > 0 {
			if _, err := target.Write(header); err != nil {
				return
			}
		}
	}
	inspection := newProtocolGuardInspection(s.rule.Policy)
	type copyResult struct {
		toTarget bool
		err      error
	}
	var progress atomic.Int64
	toTarget := &protocolGuardTCPPipe{src: client, dst: target, direction: protocolGuardRateIn, progress: &progress}
	toClient := &protocolGuardTCPPipe{src: target, dst: client, direction: protocolGuardRateOut, progress: &progress}
	results := make(chan copyResult, 2)
	go func() {
		results <- copyResult{toTarget: true, err: s.copyTCPToTargetWithGuard(connCtx, cfg, toTarget, first, inspection)}
	}()
	go func() {
		results <- copyResult{toTarget: false, err: s.copyTCPToClientWithGuard(connCtx, cfg, toClient, inspection)}
	}()
	closeAll := func() {
		// Cancel rate reservations and close both sockets so the other copy
		// goroutine cannot remain blocked in WaitN or network I/O.
		cancelConn()
		_ = client.Close()
		_ = target.Close()
	}
	firstResult := <-results
	source, destination, remaining := client, target, toClient
	if !firstResult.toTarget {
		source, destination, remaining = target, client, toTarget
	}
	_, sourceHalfCloses := source.(*net.TCPConn)
	destinationTCP, destinationHalfCloses := destination.(*net.TCPConn)
	if (firstResult.err != nil && !errors.Is(firstResult.err, io.EOF)) || !sourceHalfCloses || !destinationHalfCloses {
		// 出错、被策略拦截，或者连接本身没有半关闭（EOF 就是对端彻底走了）：
		// 整条连接一起结束。
		closeAll()
		<-results
		return
	}
	// 一个方向干净地读到 EOF 是半关闭（比如客户端发完请求 shutdown 写端再等响应）：
	// 把半关闭传给另一端，另一个方向接着跑；它有数据在走就一直等，空闲超过
	// linger 才收掉，免得一个永远不关的对端把协程钉住。
	_ = destinationTCP.CloseWrite()
	// 剩下的方向如果正在 splice，先把它踢回逐块循环：下面按字节计数判断空闲，
	// splice 一次搬一大块、中途不更新计数，而且写端卡住时也没有机会返回。
	remaining.leaveSplice()
	linger := s.halfCloseLinger
	if linger <= 0 {
		linger = tcpRelayHalfCloseLinger
	}
	ticker := time.NewTicker(linger)
	defer ticker.Stop()
	last := progress.Load()
	for {
		select {
		case <-results:
			closeAll()
			return
		case <-ticker.C:
			current := progress.Load()
			if current == last {
				closeAll()
				<-results
				return
			}
			last = current
		}
	}
}

// protocolGuardSpliceChunk 是零拷贝阶段每次 io.Copy 搬运的上限。每搬完一块就重新
// 看一眼这个方向有没有被热更新挂上限速：限速加上以后最多再放过这么多字节不受限
// （和 protocolGuardRateBurstMax 一样大，相当于多给一次突发），换来的是不用为每条
// 连接再起一个监听协程去打断 splice。
const protocolGuardSpliceChunk = 4 * 1024 * 1024

// protocolGuardTCPPipe 是协议防护 TCP 连接里的一个转发方向。
type protocolGuardTCPPipe struct {
	src       net.Conn
	dst       net.Conn
	direction protocolGuardRateDirection
	// progress 两个方向共用，半关闭以后 handleConn 靠它判断剩下的方向是否空闲。
	progress *atomic.Int64
	// halfClosed 置位以后这个方向不再进入 splice。
	halfClosed atomic.Bool
	// rateKick 表示读超时是限速热更新踢出来的（见 spliceTCPWithGuard），不是错误。
	rateKick atomic.Bool
	// spliced 记录这个方向是否进入过零拷贝阶段（测试用，读写都很便宜）。
	spliced atomic.Bool
}

func (p *protocolGuardTCPPipe) addProgress(n int64) {
	if p.progress != nil && n > 0 {
		p.progress.Add(n)
	}
}

// leaveSplice 在另一个方向半关闭后调用：读超时设成现在，把可能阻塞在 splice 里的
// io.Copy 踢出来（读超时不会丢数据：splice 是先等可读再搬）。逐块循环里的 Read 被
// 踢到也只是返回超时，清掉超时接着读。
func (p *protocolGuardTCPPipe) leaveSplice() {
	p.halfClosed.Store(true)
	_ = p.src.SetReadDeadline(time.Now())
}

// resumeAfterKick 判断一个读错误是不是 leaveSplice 踢出来的；是的话清掉读超时，
// 调用方接着用逐块循环转发。
func (p *protocolGuardTCPPipe) resumeAfterKick(err error) bool {
	if !isNetTimeout(err) {
		return false
	}
	// 先看限速踢（一次性），再看半关闭踢（之后一直有效）。
	if !p.rateKick.Swap(false) && !p.halfClosed.Load() {
		return false
	}
	_ = p.src.SetReadDeadline(time.Time{})
	return true
}

// spliceCapable 只有两端都是原生 *net.TCPConn 时 io.Copy 才会走 splice；
// 其他连接类型（测试里的 net.Pipe 等）继续用逐块循环，行为不变。
func (p *protocolGuardTCPPipe) spliceCapable() bool {
	_, srcTCP := p.src.(*net.TCPConn)
	_, dstTCP := p.dst.(*net.TCPConn)
	return srcTCP && dstTCP
}

// spliceTCPWithGuard 在协议检测已经结束、这个方向又没有限速时把剩下的数据交给
// 内核搬（*net.TCPConn 之间的 io.Copy 在 Linux 上走 splice），省掉每个字节两次
// 用户态拷贝。按方向各自切换而不是整条连接交给 relayTCPBidirectional：两个方向
// 的检测结束时间不同（服务端方向只有 SOCKS 检测需要看），限速可以热更新到已有
// 连接上，半关闭以后的空闲判断也要沿用原来按字节计数的办法，所以切走以后必须
// 还能回到逐块循环。
// switchBack=true 表示要回到逐块循环（中途挂上了限速，或者另一个方向半关闭了）；
// 此时已经读出来的数据都已完整写出，不会丢也不会乱序。
func (s *protocolGuardServer) spliceTCPWithGuard(p *protocolGuardTCPPipe) (switchBack bool, err error) {
	p.spliced.Store(true)
	for {
		limiter, rateChanged := s.rateWaitState(p.direction)
		if p.halfClosed.Load() || limiter != nil {
			return true, nil
		}
		// 限速热更新时把阻塞在 splice 里的读踢出来，回到循环开头重新判断：不然一条
		// 安静的长连接（SSH、长轮询）要等到再搬满一块才会受新限速约束。
		stopWatch := make(chan struct{})
		if rateChanged != nil {
			go func() {
				select {
				case <-rateChanged:
					p.rateKick.Store(true)
					_ = p.src.SetReadDeadline(time.Now())
				case <-stopWatch:
				}
			}()
		}
		reader := &io.LimitedReader{R: p.src, N: protocolGuardSpliceChunk}
		n, copyErr := io.Copy(p.dst, reader)
		close(stopWatch)
		p.addProgress(n)
		if copyErr != nil {
			if p.resumeAfterKick(copyErr) {
				continue
			}
			return false, copyErr
		}
		if reader.N > 0 {
			// 没搬满一块、也没有错误：源端读到了 EOF（对端半关闭或关闭）。
			return false, io.EOF
		}
	}
}

func (s *protocolGuardServer) canSpliceTCP(p *protocolGuardTCPPipe, inspectionFinished bool) bool {
	return inspectionFinished && !p.halfClosed.Load() && s.rateLimiter(p.direction) == nil
}

func (s *protocolGuardServer) copyTCPToTargetWithGuard(ctx context.Context, cfg Config, p *protocolGuardTCPPipe, initial []byte, inspection *protocolGuardInspection) error {
	writeChunk := func(chunk []byte) error {
		if len(chunk) == 0 {
			return nil
		}
		if proto, blocked := inspection.inspectClient(chunk); blocked {
			enqueueProtocolBlockReport(cfg, s.rule, proto)
			return fmt.Errorf("protocol blocked: %s", proto)
		}
		if err := s.waitRate(ctx, protocolGuardRateIn, len(chunk)); err != nil {
			return err
		}
		_, err := p.dst.Write(chunk)
		p.addProgress(int64(len(chunk)))
		return err
	}
	// 解析 PROXY 协议时多读出来的字节必须先写出去，之后才可能切到 splice。
	if err := writeChunk(initial); err != nil {
		return err
	}
	spliceCapable := p.spliceCapable()
	buf := getAgentByteBuffer(32 * 1024)
	defer putAgentByteBuffer(buf)
	for {
		if spliceCapable && s.canSpliceTCP(p, inspection.clientFinished()) {
			switchBack, err := s.spliceTCPWithGuard(p)
			if !switchBack {
				return err
			}
		}
		n, err := p.src.Read(buf)
		if n > 0 {
			if writeErr := writeChunk(buf[:n]); writeErr != nil {
				return writeErr
			}
		}
		if err != nil {
			if p.resumeAfterKick(err) {
				continue
			}
			return err
		}
	}
}

func (s *protocolGuardServer) copyTCPToClientWithGuard(ctx context.Context, cfg Config, p *protocolGuardTCPPipe, inspection *protocolGuardInspection) error {
	spliceCapable := p.spliceCapable()
	buf := getAgentByteBuffer(32 * 1024)
	defer putAgentByteBuffer(buf)
	for {
		if spliceCapable && s.canSpliceTCP(p, inspection.serverFinished()) {
			switchBack, err := s.spliceTCPWithGuard(p)
			if !switchBack {
				return err
			}
		}
		n, err := p.src.Read(buf)
		if n > 0 {
			chunk := buf[:n]
			if proto, blocked := inspection.inspectServer(chunk); blocked {
				enqueueProtocolBlockReport(cfg, s.rule, proto)
				return fmt.Errorf("protocol blocked: %s", proto)
			}
			if err := s.waitRate(ctx, protocolGuardRateOut, len(chunk)); err != nil {
				return err
			}
			if _, writeErr := p.dst.Write(chunk); writeErr != nil {
				return writeErr
			}
			p.addProgress(int64(n))
		}
		if err != nil {
			if p.resumeAfterKick(err) {
				continue
			}
			return err
		}
	}
}

// protocolGuardUDPEvictMinIdle：会话数到上限时，只有空闲至少这么久的最久未用会话
// 才会被挤掉给新来源。正在收发的会话不会被一波新来源（扫描、伪造源地址）冲掉；
// DNS/QUIC 这种一问一答后就闲着的会话能尽快让位，而不是像以前那样新来源一律被丢。
const protocolGuardUDPEvictMinIdle = 10 * time.Second

// protocolGuardUDPReadBuffer：守护 UDP 监听只有一个读协程，突发时内核默认的
// 接收缓冲（常见 208 KiB）很快溢出丢包；调大失败（超过 rmem_max）就保持默认。
const protocolGuardUDPReadBuffer = 4 << 20

type protocolGuardUDPSession struct {
	target net.Conn
	// last 是最近一次收发的 UnixNano。回包方向每个包都要更新，用原子量避免
	// 每个包都去抢整张会话表的锁。
	last atomic.Int64
}

func (session *protocolGuardUDPSession) touch(now time.Time) {
	session.last.Store(now.UnixNano())
}

func (session *protocolGuardUDPSession) idleFor(now time.Time) time.Duration {
	return now.Sub(time.Unix(0, session.last.Load()))
}

// evictProtocolGuardUDPSessionLocked 在会话数到上限时挤掉空闲最久、且空闲超过
// protocolGuardUDPEvictMinIdle 的会话。调用方持有 sessionMu。返回被挤掉的会话
// （调用方在锁外关闭它的连接），没有可挤的返回 nil。
func evictProtocolGuardUDPSessionLocked(sessions map[string]*protocolGuardUDPSession, now time.Time) *protocolGuardUDPSession {
	var oldestKey string
	var oldest *protocolGuardUDPSession
	var oldestLast int64
	for key, session := range sessions {
		last := session.last.Load()
		if oldest == nil || last < oldestLast {
			oldestKey, oldest, oldestLast = key, session, last
		}
	}
	if oldest == nil || oldest.idleFor(now) < protocolGuardUDPEvictMinIdle {
		return nil
	}
	delete(sessions, oldestKey)
	return oldest
}

func (s *protocolGuardServer) serveUDP() {
	sessions := map[string]*protocolGuardUDPSession{}
	var sessionMu sync.Mutex
	closeSessions := func() {
		sessionMu.Lock()
		defer sessionMu.Unlock()
		for key, session := range sessions {
			_ = session.target.Close()
			delete(sessions, key)
		}
	}
	cleanupTicker := time.NewTicker(30 * time.Second)
	stopCleanup := make(chan struct{})
	defer func() {
		close(stopCleanup)
		cleanupTicker.Stop()
		closeSessions()
	}()
	go func() {
		for {
			select {
			case <-s.done:
				closeSessions()
				return
			case <-stopCleanup:
				return
			case <-cleanupTicker.C:
				now := time.Now()
				sessionMu.Lock()
				for key, session := range sessions {
					if session.idleFor(now) <= protocolGuardUDPIdleTimeout {
						continue
					}
					_ = session.target.Close()
					delete(sessions, key)
				}
				sessionMu.Unlock()
			}
		}
	}()

	buf := make([]byte, 65535)
	var backoff serveLoopBackoff
	for {
		n, clientAddr, err := s.udpConn.ReadFrom(buf)
		if err != nil {
			exit, fatal := serveLoopHandleError(s.done, &backoff, err, func(err error, suppressed int) {
				logf("protocol guard udp read rule=%d suppressed=%d: %v", s.rule.RuleID, suppressed, err)
			})
			if fatal {
				s.abandonAfterServeFailure("udp read", err)
			}
			if exit {
				return
			}
			continue
		}
		backoff.success()
		if n <= 0 || clientAddr == nil {
			continue
		}
		// The loop consumes the packet synchronously before the next ReadFrom,
		// so the read buffer remains valid for the target Write. Avoid a heap
		// allocation for every datagram on high-PPS UDP rules.
		packet := buf[:n]
		// 限速等待留在读协程里：它就是这条规则入方向的背压，挪到每个会话各自的
		// 队列里要额外的缓冲和排队丢包策略，收益不大。
		if err := s.waitRate(s.ctx, protocolGuardRateIn, len(packet)); err != nil {
			select {
			case <-s.done:
				return
			default:
			}
			continue
		}
		key := clientAddr.String()
		now := time.Now()
		sessionMu.Lock()
		session := sessions[key]
		sessionMu.Unlock()
		if session == nil {
			session = s.openUDPSession(key, clientAddr, now, sessions, &sessionMu)
			if session == nil {
				continue
			}
		}
		session.touch(now)
		target := session.target
		if _, err := target.Write(packet); err != nil {
			sessionMu.Lock()
			if sessions[key] == session {
				delete(sessions, key)
			}
			sessionMu.Unlock()
			_ = target.Close()
			if shouldLogAgentReport(fmt.Sprintf("protocol-guard-udp-write:%d", s.rule.RuleID), agentReportLogInterval) {
				logf("protocol guard udp write target rule=%d client=%s: %v", s.rule.RuleID, key, err)
			}
		}
	}
}

// openUDPSession 为新来源建会话。拨号在锁外做：以前拨号时一直拿着 sessionMu，
// 期间所有会话的回包协程更新时间戳、清理协程都得等它。
func (s *protocolGuardServer) openUDPSession(key string, clientAddr net.Addr, now time.Time, sessions map[string]*protocolGuardUDPSession, sessionMu *sync.Mutex) *protocolGuardUDPSession {
	sessionMu.Lock()
	full := len(sessions) >= protocolGuardUDPMaxSessions
	sessionMu.Unlock()
	if full && !s.makeUDPSessionRoom(sessions, sessionMu, now) {
		return nil
	}
	target, err := net.DialTimeout("udp", net.JoinHostPort(s.rule.TargetIP, strconv.Itoa(s.rule.TargetPort)), 10*time.Second)
	if err != nil {
		if shouldLogAgentReport(fmt.Sprintf("protocol-guard-udp-dial:%d", s.rule.RuleID), agentReportLogInterval) {
			logf("protocol guard udp dial target rule=%d: %v", s.rule.RuleID, err)
		}
		return nil
	}
	session := &protocolGuardUDPSession{target: target}
	session.touch(now)
	sessionMu.Lock()
	if existing := sessions[key]; existing != nil {
		// 拨号期间已经有人建好了同一来源的会话：用现成的，关掉多拨的这条。
		sessionMu.Unlock()
		_ = target.Close()
		return existing
	}
	var evicted *protocolGuardUDPSession
	if len(sessions) >= protocolGuardUDPMaxSessions {
		evicted = evictProtocolGuardUDPSessionLocked(sessions, now)
		if evicted == nil {
			sessionMu.Unlock()
			_ = target.Close()
			s.logUDPSessionLimit(false)
			return nil
		}
	}
	sessions[key] = session
	sessionMu.Unlock()
	if evicted != nil {
		_ = evicted.target.Close()
		s.logUDPSessionLimit(true)
	}
	go s.copyUDPToClient(key, clientAddr, session, sessions, sessionMu)
	return session
}

// makeUDPSessionRoom 在拨号前先腾位置，腾不出来就不必白拨一次。
func (s *protocolGuardServer) makeUDPSessionRoom(sessions map[string]*protocolGuardUDPSession, sessionMu *sync.Mutex, now time.Time) bool {
	sessionMu.Lock()
	if len(sessions) < protocolGuardUDPMaxSessions {
		sessionMu.Unlock()
		return true
	}
	evicted := evictProtocolGuardUDPSessionLocked(sessions, now)
	sessionMu.Unlock()
	if evicted == nil {
		s.logUDPSessionLimit(false)
		return false
	}
	_ = evicted.target.Close()
	s.logUDPSessionLimit(true)
	return true
}

func (s *protocolGuardServer) logUDPSessionLimit(evicted bool) {
	if !shouldLogAgentReport(fmt.Sprintf("protocol-guard-udp-session-limit:%d", s.rule.RuleID), agentReportLogInterval) {
		return
	}
	if evicted {
		logf("protocol guard udp session limit reached rule=%d sessions=%d; evicted least recently used idle session", s.rule.RuleID, protocolGuardUDPMaxSessions)
		return
	}
	logf("protocol guard udp session limit reached rule=%d sessions=%d", s.rule.RuleID, protocolGuardUDPMaxSessions)
}

func (s *protocolGuardServer) copyUDPToClient(key string, clientAddr net.Addr, session *protocolGuardUDPSession, sessions map[string]*protocolGuardUDPSession, sessionMu *sync.Mutex) {
	target := session.target
	buf := getAgentByteBuffer(65535)
	defer putAgentByteBuffer(buf)
	for {
		_ = target.SetReadDeadline(time.Now().Add(protocolGuardUDPIdleTimeout))
		n, err := target.Read(buf)
		if err != nil {
			break
		}
		if n > 0 {
			if err := s.waitRate(s.ctx, protocolGuardRateOut, n); err != nil {
				break
			}
			_, _ = s.udpConn.WriteTo(buf[:n], clientAddr)
		}
		// 会话被挤掉或清理后连接已关闭，下一次 Read 会出错退出；这里更新一个
		// 已经不在表里的会话时间戳没有副作用，所以不用再拿锁核对。
		session.touch(time.Now())
	}
	sessionMu.Lock()
	if sessions[key] == session {
		delete(sessions, key)
	}
	sessionMu.Unlock()
	_ = target.Close()
}

type proxyProtocolInfo struct {
	SourceIP   string
	DestIP     string
	SourcePort int
	DestPort   int
}

func proxyProtocolInfoFromConn(conn net.Conn) proxyProtocolInfo {
	info := proxyProtocolInfo{}
	if addr, ok := conn.RemoteAddr().(*net.TCPAddr); ok {
		info.SourceIP = addr.IP.String()
		info.SourcePort = addr.Port
	}
	if addr, ok := conn.LocalAddr().(*net.TCPAddr); ok {
		info.DestIP = addr.IP.String()
		info.DestPort = addr.Port
	}
	return info
}

func consumeProxyProtocolV1(data []byte) (proxyProtocolInfo, []byte, bool, error) {
	if !bytes.HasPrefix(data, []byte("PROXY ")) {
		return proxyProtocolInfo{}, data, false, nil
	}
	end := bytes.Index(data, []byte("\r\n"))
	if end < 0 {
		return proxyProtocolInfo{}, nil, false, errors.New("incomplete proxy protocol header")
	}
	line := string(data[:end])
	parts := strings.Fields(line)
	if len(parts) < 2 || parts[0] != "PROXY" {
		return proxyProtocolInfo{}, nil, false, errors.New("invalid proxy protocol header")
	}
	if parts[1] == "UNKNOWN" {
		return proxyProtocolInfo{}, data[end+2:], true, nil
	}
	if len(parts) != 6 || (parts[1] != "TCP4" && parts[1] != "TCP6") {
		return proxyProtocolInfo{}, nil, false, errors.New("unsupported proxy protocol header")
	}
	sourcePort, err := strconv.Atoi(parts[4])
	if err != nil || sourcePort < 0 || sourcePort > 65535 {
		return proxyProtocolInfo{}, nil, false, errors.New("invalid proxy protocol source port")
	}
	destPort, err := strconv.Atoi(parts[5])
	if err != nil || destPort < 0 || destPort > 65535 {
		return proxyProtocolInfo{}, nil, false, errors.New("invalid proxy protocol destination port")
	}
	return proxyProtocolInfo{
		SourceIP:   parts[2],
		DestIP:     parts[3],
		SourcePort: sourcePort,
		DestPort:   destPort,
	}, data[end+2:], true, nil
}

func consumeProxyProtocolV1FromConn(conn net.Conn, data []byte, timeout time.Duration) (proxyProtocolInfo, []byte, bool, error) {
	buf := append([]byte(nil), data...)
	for len(buf) > 0 && len(buf) < 108 && (bytes.HasPrefix(buf, []byte("PROXY ")) || bytes.HasPrefix([]byte("PROXY "), buf)) && bytes.Index(buf, []byte("\r\n")) < 0 {
		if timeout > 0 {
			_ = conn.SetReadDeadline(time.Now().Add(timeout))
		}
		tmp := make([]byte, 108-len(buf))
		n, err := conn.Read(tmp)
		if timeout > 0 {
			_ = conn.SetReadDeadline(time.Time{})
		}
		if n > 0 {
			buf = append(buf, tmp[:n]...)
		}
		if err != nil {
			if len(buf) > 0 && bytes.HasPrefix([]byte("PROXY "), buf) {
				return proxyProtocolInfo{}, nil, false, err
			}
			break
		}
	}
	return consumeProxyProtocolV1(buf)
}

var proxyProtocolV2Signature = []byte{0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a}

func normalizeProxyProtocolVersion(version int) int {
	if version == 2 {
		return 2
	}
	return 1
}

func consumeProxyProtocol(data []byte) (proxyProtocolInfo, []byte, bool, error) {
	if bytes.HasPrefix(data, []byte("PROXY ")) {
		return consumeProxyProtocolV1(data)
	}
	if bytes.HasPrefix(data, proxyProtocolV2Signature) {
		return consumeProxyProtocolV2(data)
	}
	if len(data) > 0 && len(data) < len(proxyProtocolV2Signature) && bytes.HasPrefix(proxyProtocolV2Signature, data) {
		return proxyProtocolInfo{}, nil, false, errors.New("incomplete proxy protocol v2 header")
	}
	return proxyProtocolInfo{}, data, false, nil
}

func consumeProxyProtocolFromConn(conn net.Conn, data []byte, timeout time.Duration) (proxyProtocolInfo, []byte, bool, error) {
	buf := append([]byte(nil), data...)
	if len(buf) == 0 {
		return consumeProxyProtocol(buf)
	}
	if bytes.HasPrefix(buf, []byte("PROXY ")) || bytes.HasPrefix([]byte("PROXY "), buf) {
		return consumeProxyProtocolV1FromConn(conn, buf, timeout)
	}
	if bytes.HasPrefix(buf, proxyProtocolV2Signature) || bytes.HasPrefix(proxyProtocolV2Signature, buf) {
		for len(buf) < 16 {
			more, err := readProxyProtocolMore(conn, timeout, 16-len(buf))
			if len(more) > 0 {
				buf = append(buf, more...)
			}
			if err != nil {
				return proxyProtocolInfo{}, nil, false, err
			}
			if len(more) == 0 {
				return proxyProtocolInfo{}, nil, false, errors.New("incomplete proxy protocol v2 header")
			}
		}
		length := int(binary.BigEndian.Uint16(buf[14:16]))
		need := 16 + length
		for len(buf) < need {
			more, err := readProxyProtocolMore(conn, timeout, need-len(buf))
			if len(more) > 0 {
				buf = append(buf, more...)
			}
			if err != nil {
				return proxyProtocolInfo{}, nil, false, err
			}
			if len(more) == 0 {
				return proxyProtocolInfo{}, nil, false, errors.New("incomplete proxy protocol v2 payload")
			}
		}
	}
	return consumeProxyProtocol(buf)
}

func readProxyProtocolMore(conn net.Conn, timeout time.Duration, limit int) ([]byte, error) {
	if limit <= 0 {
		return nil, nil
	}
	if timeout > 0 {
		_ = conn.SetReadDeadline(time.Now().Add(timeout))
	}
	tmp := make([]byte, limit)
	n, err := conn.Read(tmp)
	if timeout > 0 {
		_ = conn.SetReadDeadline(time.Time{})
	}
	if n > 0 {
		return tmp[:n], err
	}
	return nil, err
}

func consumeProxyProtocolV2(data []byte) (proxyProtocolInfo, []byte, bool, error) {
	if !bytes.HasPrefix(data, proxyProtocolV2Signature) {
		return proxyProtocolInfo{}, data, false, nil
	}
	if len(data) < 16 {
		return proxyProtocolInfo{}, nil, false, errors.New("incomplete proxy protocol v2 header")
	}
	versionCommand := data[12]
	if versionCommand>>4 != 0x2 {
		return proxyProtocolInfo{}, nil, false, errors.New("invalid proxy protocol v2 version")
	}
	command := versionCommand & 0x0f
	familyProtocol := data[13]
	length := int(binary.BigEndian.Uint16(data[14:16]))
	if len(data) < 16+length {
		return proxyProtocolInfo{}, nil, false, errors.New("incomplete proxy protocol v2 payload")
	}
	payload := data[16 : 16+length]
	remaining := data[16+length:]
	if command == 0x0 {
		return proxyProtocolInfo{}, remaining, true, nil
	}
	if command != 0x1 {
		return proxyProtocolInfo{}, nil, false, errors.New("unsupported proxy protocol v2 command")
	}
	switch familyProtocol {
	case 0x11:
		if len(payload) < 12 {
			return proxyProtocolInfo{}, nil, false, errors.New("invalid proxy protocol v2 tcp4 payload")
		}
		return proxyProtocolInfo{SourceIP: net.IP(payload[0:4]).String(), DestIP: net.IP(payload[4:8]).String(), SourcePort: int(binary.BigEndian.Uint16(payload[8:10])), DestPort: int(binary.BigEndian.Uint16(payload[10:12]))}, remaining, true, nil
	case 0x21:
		if len(payload) < 36 {
			return proxyProtocolInfo{}, nil, false, errors.New("invalid proxy protocol v2 tcp6 payload")
		}
		return proxyProtocolInfo{SourceIP: net.IP(payload[0:16]).String(), DestIP: net.IP(payload[16:32]).String(), SourcePort: int(binary.BigEndian.Uint16(payload[32:34])), DestPort: int(binary.BigEndian.Uint16(payload[34:36]))}, remaining, true, nil
	case 0x00:
		return proxyProtocolInfo{}, remaining, true, nil
	default:
		return proxyProtocolInfo{}, nil, false, errors.New("unsupported proxy protocol v2 address family")
	}
}

func buildProxyProtocol(version int, info proxyProtocolInfo, fallbackSource net.Addr, targetLocal net.Addr, targetRemote net.Addr) []byte {
	if normalizeProxyProtocolVersion(version) == 2 {
		return buildProxyProtocolV2(info, fallbackSource, targetLocal, targetRemote)
	}
	return []byte(buildProxyProtocolV1(info, fallbackSource, targetLocal, targetRemote))
}

func buildProxyProtocolV2(info proxyProtocolInfo, fallbackSource net.Addr, targetLocal net.Addr, targetRemote net.Addr) []byte {
	sourceIP, destIP, sourcePort, destPort := proxyProtocolEndpointValues(info, fallbackSource, targetLocal, targetRemote)
	src := net.ParseIP(sourceIP)
	dst := net.ParseIP(destIP)
	if src == nil || dst == nil || sourcePort <= 0 || destPort <= 0 {
		return buildProxyProtocolV2Local()
	}
	if src4, dst4 := src.To4(), dst.To4(); src4 != nil && dst4 != nil {
		buf := make([]byte, 28)
		copy(buf, proxyProtocolV2Signature)
		buf[12] = 0x21
		buf[13] = 0x11
		binary.BigEndian.PutUint16(buf[14:16], 12)
		copy(buf[16:20], src4)
		copy(buf[20:24], dst4)
		binary.BigEndian.PutUint16(buf[24:26], uint16(sourcePort))
		binary.BigEndian.PutUint16(buf[26:28], uint16(destPort))
		return buf
	}
	src16 := src.To16()
	dst16 := dst.To16()
	if src16 == nil || dst16 == nil || src.To4() != nil || dst.To4() != nil {
		return buildProxyProtocolV2Local()
	}
	buf := make([]byte, 52)
	copy(buf, proxyProtocolV2Signature)
	buf[12] = 0x21
	buf[13] = 0x21
	binary.BigEndian.PutUint16(buf[14:16], 36)
	copy(buf[16:32], src16)
	copy(buf[32:48], dst16)
	binary.BigEndian.PutUint16(buf[48:50], uint16(sourcePort))
	binary.BigEndian.PutUint16(buf[50:52], uint16(destPort))
	return buf
}

func buildProxyProtocolV2Local() []byte {
	buf := make([]byte, 16)
	copy(buf, proxyProtocolV2Signature)
	buf[12] = 0x20
	buf[13] = 0x00
	return buf
}

func proxyProtocolEndpointValues(info proxyProtocolInfo, fallbackSource net.Addr, targetLocal net.Addr, targetRemote net.Addr) (string, string, int, int) {
	sourceIP := strings.TrimSpace(info.SourceIP)
	destIP := strings.TrimSpace(info.DestIP)
	sourcePort := info.SourcePort
	destPort := info.DestPort
	if sourceIP == "" {
		if addr, ok := fallbackSource.(*net.TCPAddr); ok {
			sourceIP = addr.IP.String()
			sourcePort = addr.Port
		}
	}
	if destIP == "" {
		if addr, ok := targetRemote.(*net.TCPAddr); ok {
			destIP = addr.IP.String()
			destPort = addr.Port
		}
	}
	if destPort <= 0 {
		if addr, ok := targetRemote.(*net.TCPAddr); ok {
			destPort = addr.Port
		}
	}
	if sourcePort <= 0 {
		if addr, ok := fallbackSource.(*net.TCPAddr); ok {
			sourcePort = addr.Port
		}
	}
	if destIP == "" {
		if addr, ok := targetLocal.(*net.TCPAddr); ok {
			destIP = addr.IP.String()
		}
	}
	return sourceIP, destIP, sourcePort, destPort
}
func buildProxyProtocolV1(info proxyProtocolInfo, fallbackSource net.Addr, targetLocal net.Addr, targetRemote net.Addr) string {
	sourceIP := strings.TrimSpace(info.SourceIP)
	destIP := strings.TrimSpace(info.DestIP)
	sourcePort := info.SourcePort
	destPort := info.DestPort
	if sourceIP == "" {
		if addr, ok := fallbackSource.(*net.TCPAddr); ok {
			sourceIP = addr.IP.String()
			sourcePort = addr.Port
		}
	}
	if destIP == "" {
		if addr, ok := targetRemote.(*net.TCPAddr); ok {
			destIP = addr.IP.String()
			destPort = addr.Port
		}
	}
	if destPort <= 0 {
		if addr, ok := targetRemote.(*net.TCPAddr); ok {
			destPort = addr.Port
		}
	}
	if sourcePort <= 0 {
		if addr, ok := fallbackSource.(*net.TCPAddr); ok {
			sourcePort = addr.Port
		}
	}
	if destIP == "" {
		if addr, ok := targetLocal.(*net.TCPAddr); ok {
			destIP = addr.IP.String()
		}
	}
	family := "TCP4"
	if ip := net.ParseIP(sourceIP); ip != nil && ip.To4() == nil {
		family = "TCP6"
	}
	if sourceIP == "" || destIP == "" || sourcePort <= 0 || destPort <= 0 {
		return "PROXY UNKNOWN\r\n"
	}
	return fmt.Sprintf("PROXY %s %s %s %d %d\r\n", family, sourceIP, destIP, sourcePort, destPort)
}

func detectHTTPProtocol(data []byte) bool {
	if bytes.HasPrefix(data, []byte("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n")) {
		return true
	}
	limit := minInt(len(data), 256)
	if limit < len("GET / HTTP/1.0\r\n") {
		return false
	}
	lineEnd := bytes.Index(data[:limit], []byte("\r\n"))
	if lineEnd < 0 {
		return false
	}
	parts := bytes.Split(data[:lineEnd], []byte{' '})
	if len(parts) != 3 {
		return false
	}
	method := string(parts[0])
	switch method {
	case "GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS", "PATCH", "CONNECT", "TRACE":
	default:
		return false
	}
	version := string(parts[2])
	if version != "HTTP/1.0" && version != "HTTP/1.1" {
		return false
	}
	return validHTTPRequestTarget(method, parts[1])
}

func validHTTPRequestTarget(method string, target []byte) bool {
	if len(target) == 0 {
		return false
	}
	for _, value := range target {
		if value < 0x21 || value > 0x7e {
			return false
		}
	}
	if method == "CONNECT" {
		return bytes.Contains(target, []byte{':'})
	}
	if bytes.Equal(target, []byte("*")) {
		return method == "OPTIONS"
	}
	if target[0] == '/' {
		return true
	}
	lower := bytes.ToLower(target)
	return bytes.HasPrefix(lower, []byte("http://")) || bytes.HasPrefix(lower, []byte("https://"))
}

func detectTLSProtocol(data []byte) bool {
	if len(data) < 9 {
		return false
	}
	if data[0] != 0x16 || data[1] != 0x03 || data[2] < 0x01 || data[2] > 0x04 {
		return false
	}
	recordLen := int(binary.BigEndian.Uint16(data[3:5]))
	if recordLen < protocolGuardTLSMinRecordSize || recordLen > 18432 {
		return false
	}
	if data[5] != 0x01 {
		return false
	}
	handshakeLen := int(data[6])<<16 | int(data[7])<<8 | int(data[8])
	if handshakeLen <= 0 || handshakeLen+4 > recordLen {
		return false
	}
	return true
}

func detectSocksProtocol(data []byte) bool {
	_, _, ok := detectSocksClientHandshake(data)
	return ok
}

func detectSocksClientHandshake(data []byte) (byte, map[byte]bool, bool) {
	if len(data) < 2 {
		return 0, nil, false
	}
	if data[0] == 0x04 {
		return 0x04, nil, detectSocks4Request(data)
	}
	if data[0] != 0x05 {
		return 0, nil, false
	}
	nMethods := int(data[1])
	if nMethods <= 0 || nMethods > protocolGuardSOCKS5MaxMethods || len(data) != 2+nMethods {
		return 0, nil, false
	}
	methods := make(map[byte]bool, nMethods)
	for _, method := range data[2:] {
		if method == 0xff || methods[method] {
			return 0, nil, false
		}
		methods[method] = true
	}
	return 0x05, methods, true
}

func detectSocks4Request(data []byte) bool {
	if len(data) < 9 || data[0] != 0x04 || (data[1] != 0x01 && data[1] != 0x02) {
		return false
	}
	userEnd := bytes.IndexByte(data[8:], 0x00)
	if userEnd < 0 {
		return false
	}
	end := 8 + userEnd + 1
	isSocks4A := data[4] == 0x00 && data[5] == 0x00 && data[6] == 0x00 && data[7] != 0x00
	if isSocks4A {
		domainEnd := bytes.IndexByte(data[end:], 0x00)
		if domainEnd <= 0 {
			return false
		}
		end += domainEnd + 1
	}
	return end == len(data)
}

type protocolBlockReportEvent struct {
	cfg   Config
	rule  guardRule
	proto string
	key   string
}

type protocolBlockReportState struct {
	last    time.Time
	pending bool
}

// protocolBlockReporter keeps protocol-block reporting off the connection
// goroutines. A blocked connection is already handled locally, so a failed or
// slow panel request must never be allowed to create an unbounded backlog.
type protocolBlockReporter struct {
	mu        sync.Mutex
	queue     chan protocolBlockReportEvent
	stop      chan struct{}
	done      chan struct{}
	closeOnce sync.Once
	closed    bool
	cooldown  time.Duration
	maxKeys   int
	states    map[string]*protocolBlockReportState
	report    func(Config, guardRule, string)
}

func newProtocolBlockReporter(queueSize int, cooldown time.Duration, maxKeys int, report func(Config, guardRule, string)) *protocolBlockReporter {
	if queueSize <= 0 {
		queueSize = 1
	}
	if cooldown < 0 {
		cooldown = 0
	}
	if maxKeys <= 0 {
		maxKeys = queueSize * 4
	}
	reporter := &protocolBlockReporter{
		queue:    make(chan protocolBlockReportEvent, queueSize),
		stop:     make(chan struct{}),
		done:     make(chan struct{}),
		cooldown: cooldown,
		maxKeys:  maxKeys,
		states:   make(map[string]*protocolBlockReportState),
		report:   report,
	}
	go reporter.run()
	return reporter
}

func protocolBlockReportKey(rule guardRule, proto string) string {
	// Include the route signature so a changed rule is not suppressed by a
	// cooldown entry left over from its previous target or policy.
	return guardRoutingSignature(rule) + "|" + strings.ToLower(strings.TrimSpace(proto))
}

func (r *protocolBlockReporter) pruneLocked(now time.Time) {
	for key, state := range r.states {
		if state == nil || state.pending || state.last.IsZero() {
			continue
		}
		if r.cooldown <= 0 || !now.Before(state.last.Add(r.cooldown)) {
			delete(r.states, key)
		}
	}
}

func (r *protocolBlockReporter) makeRoomLocked() bool {
	if len(r.states) < r.maxKeys {
		return true
	}
	oldestKey := ""
	var oldest time.Time
	for key, state := range r.states {
		if state == nil || state.pending {
			continue
		}
		if oldestKey == "" || state.last.Before(oldest) {
			oldestKey = key
			oldest = state.last
		}
	}
	if oldestKey == "" {
		return false
	}
	delete(r.states, oldestKey)
	return true
}

func (r *protocolBlockReporter) enqueue(cfg Config, rule guardRule, proto string) bool {
	if r == nil {
		return false
	}
	key := protocolBlockReportKey(rule, proto)
	now := time.Now()
	event := protocolBlockReportEvent{cfg: cfg, rule: rule, proto: strings.ToLower(strings.TrimSpace(proto)), key: key}
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return false
	}
	r.pruneLocked(now)
	state := r.states[key]
	if state != nil && (state.pending || (r.cooldown > 0 && now.Before(state.last.Add(r.cooldown)))) {
		r.mu.Unlock()
		return false
	}
	if state == nil {
		if !r.makeRoomLocked() {
			r.mu.Unlock()
			return false
		}
		state = &protocolBlockReportState{}
		r.states[key] = state
	}
	state.last = now
	state.pending = true
	select {
	case r.queue <- event:
		r.mu.Unlock()
		return true
	default:
		// Keep the cooldown timestamp but release the pending flag. A later
		// connection can retry after the bounded cooldown without spinning.
		state.pending = false
		r.mu.Unlock()
		return false
	}
}

func (r *protocolBlockReporter) run() {
	defer close(r.done)
	for {
		select {
		case <-r.stop:
			return
		case event := <-r.queue:
			func() {
				defer func() {
					if recovered := recover(); recovered != nil {
						logf("protocol block reporter panic: %v", recovered)
					}
					r.mu.Lock()
					if state := r.states[event.key]; state != nil {
						state.pending = false
						state.last = time.Now()
					}
					r.mu.Unlock()
				}()
				if r.report != nil {
					r.report(event.cfg, event.rule, event.proto)
				}
			}()
		}
	}
}

func (r *protocolBlockReporter) close() {
	if r == nil {
		return
	}
	r.closeOnce.Do(func() {
		r.mu.Lock()
		r.closed = true
		r.mu.Unlock()
		close(r.stop)
		<-r.done
	})
}

var protocolBlockReports = newProtocolBlockReporter(
	protocolBlockReportQueueSize,
	protocolBlockReportCooldown,
	protocolBlockReportStateMaxKeys,
	reportProtocolBlock,
)

func enqueueProtocolBlockReport(cfg Config, rule guardRule, proto string) {
	_ = protocolBlockReports.enqueue(cfg, rule, proto)
}

func reportProtocolBlock(cfg Config, rule guardRule, proto string) {
	payload := map[string]any{
		"ruleId":     rule.RuleID,
		"tunnelId":   rule.TunnelID,
		"sourcePort": rule.ListenPort,
		"protocol":   proto,
	}
	if err := post(cfg, "/api/agent/protocol-block", payload, &map[string]any{}); err != nil {
		if isTransientAgentCommError(err) {
			logAgentCommError("protocol-block", err)
		} else {
			logf("protocol block report failed rule=%d protocol=%s: %v", rule.RuleID, proto, err)
		}
	} else {
		logf("protocol block reported rule=%d tunnel=%d protocol=%s", rule.RuleID, rule.TunnelID, proto)
	}
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
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

func post(cfg Config, path string, payload any, out any) error {
	return postWithClient(agentSyncHTTPClient, cfg, path, payload, out)
}

func postHeartbeat(cfg Config, path string, payload any, out any) error {
	return postHeartbeatWithClient(agentSyncHTTPClient, cfg, path, payload, out)
}

func postHeartbeatWithClient(client *http.Client, cfg Config, path string, payload any, out any) error {
	finish, ok := heartbeatRequests.tryStart(heartbeatRequestLaneFull)
	if !ok {
		return errHeartbeatRequestInFlight
	}
	return postHeartbeatAfterStart(client, cfg, path, payload, out, finish)
}

func postHeartbeatWithClientTracked(client *http.Client, cfg Config, path string, payload any, out any) (uint64, error) {
	finish, generation, ok := heartbeatRequests.tryStartTracked(heartbeatRequestLanePresence)
	if !ok {
		return generation, errHeartbeatRequestInFlight
	}
	return generation, postHeartbeatAfterStart(client, cfg, path, payload, out, finish)
}

func postHeartbeatWithClientIfGeneration(client *http.Client, cfg Config, path string, payload any, out any, expectedGeneration uint64) error {
	finish, err := heartbeatRequests.tryStartIfGeneration(heartbeatRequestLanePresence, expectedGeneration)
	if err != nil {
		return err
	}
	return postHeartbeatAfterStart(client, cfg, path, payload, out, finish)
}

func postHeartbeatAfterStart(client *http.Client, cfg Config, path string, payload any, out any, finish func(bool)) error {
	err := postWithClient(client, cfg, path, payload, out)
	finish(err == nil)
	return err
}

func postWithClient(client *http.Client, cfg Config, path string, payload any, out any) error {
	return postWithClientToPanelURL(client, cfg, currentPanelURL(cfg), path, payload, out)
}

func postToPanelURL(cfg Config, panelURL string, path string, payload any, out any) error {
	return postWithClientToPanelURL(agentSyncHTTPClient, cfg, panelURL, path, payload, out)
}

func postWithClientToPanelURL(client *http.Client, cfg Config, panelURL string, path string, payload any, out any) error {
	negotiationRetryUsed := false
	rejectionRetryUsed := false
	var err error
	for requestNumber := 0; requestNumber < 4; requestNumber++ {
		err = postOnceWithClientToPanelURL(client, cfg, panelURL, path, payload, out)
		if err == nil {
			return nil
		}
		if agentRequestResponseAuthenticated(err) {
			return err
		}
		attempt, hasAttempt := agentRequestAttemptFromError(err)
		if agentRequestAuthRejected(err) && hasAttempt && attempt.auth.version == "v2" && !rejectionRetryUsed {
			rejectionRetryUsed = true
			logf("retrying agent request after challenge rejection path=%s", path)
			continue
		}
		if !isClockSyncCandidateError(err) || (hasAttempt && attempt.auth.version == "v2") {
			return err
		}
		if hasAttempt && !attempt.auth.challengeKnownAtStart && agentAuthChallengeV2Known(panelURL) && !negotiationRetryUsed {
			negotiationRetryUsed = true
			logf("retrying agent request with challenge auth path=%s", path)
			continue
		}
		return err
	}
	return err
}

func postOnce(cfg Config, path string, payload any, out any) error {
	return postOnceWithClient(agentSyncHTTPClient, cfg, path, payload, out)
}

func postOnceWithClient(client *http.Client, cfg Config, path string, payload any, out any) error {
	return postOnceWithClientToPanelURL(client, cfg, currentPanelURL(cfg), path, payload, out)
}

// 面板单次响应的上限。最大的是心跳下发的全量配置，几千条规则也远小于这个数；
// 不设上限的话，一个恶意/出错的响应就能把 Agent 内存吃光。
const agentMaxPanelResponseBytes = 64 << 20

var errUnauthenticatedPanelResponse = errors.New("panel response is not an authenticated envelope")

func postOnceWithClientToPanelURL(client *http.Client, cfg Config, panelURL string, path string, payload any, out any) error {
	startedAt := time.Now()
	env, err := encrypt(map[string]any{
		"path":    path,
		"payload": payload,
	}, cfg.Token)
	if err != nil {
		return err
	}
	body, _ := json.Marshal(env)
	panelURL = strings.TrimRight(strings.TrimSpace(panelURL), "/")
	if panelURL == "" {
		return fmt.Errorf("panel URL is empty")
	}
	req, err := http.NewRequest("POST", panelURL+"/api/sync", bytes.NewReader(body))
	if err != nil {
		return err
	}
	auth, err := newAgentRequestAuth(req.Context(), client, panelURL, cfg.Token, req.Method, req.URL.Path, body)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+auth.proof)
	res, err := client.Do(req)
	if err != nil {
		if isTransientAgentCommError(err) {
			logAgentCommError("post:"+path, err)
		} else if shouldLogAgentReport("post-error:"+path, agentReportLogInterval) {
			logf("agent request failed path=%s duration=%s error=%v", path, time.Since(startedAt).Round(time.Millisecond), err)
		}
		return wrapAgentRequestAttemptError(err, auth, "", false)
	}
	defer res.Body.Close()
	observeAgentAuthCapability(panelURL, res.Header.Get(agentAuthCapabilityHeader))
	authResult := res.Header.Get(agentAuthResultHeader)
	resBody, _ := io.ReadAll(io.LimitReader(res.Body, agentMaxPanelResponseBytes))
	decodedBody := resBody
	var respEnv envelope
	var decryptErr error
	responseAuthenticated := strings.EqualFold(strings.TrimSpace(authResult), agentAuthResultAccepted)
	// 只有用本机 token 验过 MAC 的信封才算面板说的话。响应头谁都能伪造；面板对
	// 认证通过的请求总是回加密信封（包括 410 迁移），明文只会出现在认证失败时。
	envelopeVerified := false
	if err := json.Unmarshal(resBody, &respEnv); err == nil && respEnv.V == 1 {
		if plain, err := decryptForPanel(respEnv, cfg.Token, panelURL, res.Header.Get(encryptedResponseClockHeader)); err == nil {
			decodedBody = plain
			responseAuthenticated = true
			envelopeVerified = true
		} else {
			decryptErr = err
		}
	}
	if auth.version == "v2" && !responseAuthenticated && strings.EqualFold(strings.TrimSpace(authResult), agentAuthResultRejected) {
		invalidateAgentAuthChallenges(panelURL, auth.challengeGeneration)
	}
	if res.StatusCode >= 300 {
		var migrated struct {
			PanelURL     string        `json:"panelUrl"`
			AgentUpgrade *agentUpgrade `json:"agentUpgrade"`
		}
		// 迁移会把新地址永久写进配置：没验过的响应一律不信，否则网络路径上的人
		// 回一个 4xx 就能把这台 Agent 永久劫持到他的面板。
		if err := json.Unmarshal(decodedBody, &migrated); err == nil && envelopeVerified {
			panelURL := strings.TrimSpace(migrated.PanelURL)
			if panelURL == "" && migrated.AgentUpgrade != nil {
				panelURL = strings.TrimSpace(migrated.AgentUpgrade.PanelURL)
			}
			if panelURL != "" {
				return wrapAgentRequestAttemptError(migratedPanelError{PanelURL: panelURL}, auth, authResult, responseAuthenticated)
			}
		}
		if decryptErr != nil {
			return wrapAgentRequestAttemptError(
				agentHTTPStatusError{StatusCode: res.StatusCode, Status: res.Status, Detail: decryptErr.Error()},
				auth, authResult, responseAuthenticated,
			)
		}
		return wrapAgentRequestAttemptError(
			agentHTTPStatusError{StatusCode: res.StatusCode, Status: res.Status, Detail: formatPanelErrorBody(decodedBody)},
			auth, authResult, responseAuthenticated,
		)
	}
	if decryptErr != nil {
		return wrapAgentRequestAttemptError(decryptErr, auth, authResult, responseAuthenticated)
	}
	if !envelopeVerified {
		// 2xx 却不是信封：不是我们的面板（或者被人改过）。里面的命令会以 root 执行，绝不能用。
		return wrapAgentRequestAttemptError(errUnauthenticatedPanelResponse, auth, authResult, false)
	}
	if err := json.Unmarshal(decodedBody, out); err != nil {
		return wrapAgentRequestAttemptError(err, auth, authResult, responseAuthenticated)
	}
	if elapsed := time.Since(startedAt); elapsed >= agentSlowRequestThreshold && shouldLogAgentReport("post-slow:"+path, agentReportLogInterval) {
		logf("agent request slow path=%s duration=%s status=%d", path, elapsed.Round(time.Millisecond), res.StatusCode)
	}
	return nil
}

func formatPanelErrorBody(body []byte) string {
	trimmed := strings.TrimSpace(string(body))
	if trimmed == "" {
		return ""
	}
	var panelErr panelErrorResp
	if err := json.Unmarshal(body, &panelErr); err != nil {
		return trimmed
	}
	parts := make([]string, 0, 3)
	if panelErr.Error != "" {
		parts = append(parts, panelErr.Error)
	}
	if panelErr.Message != "" && panelErr.Message != panelErr.Error {
		parts = append(parts, panelErr.Message)
	}
	if panelErr.Hint != "" {
		parts = append(parts, "提示: "+panelErr.Hint)
	}
	if len(parts) == 0 {
		return trimmed
	}
	return strings.Join(parts, "；")
}

func logAgentCommError(scope string, err error) {
	if err == nil {
		return
	}
	scope = strings.TrimSpace(scope)
	if scope == "" {
		scope = "unknown"
	}
	if isTransientAgentCommError(err) {
		if shouldLogAgentReport("agent-comm-transient:"+scope, transientAgentCommLogInterval) {
			logf("agent communication temporary issue scope=%s; will retry: %v", scope, err)
		}
		return
	}
	if shouldLogAgentReport("agent-comm-error:"+scope, agentReportLogInterval) {
		logf("agent communication error scope=%s: %v", scope, err)
	}
}

func isTransientAgentCommError(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(strings.TrimSpace(err.Error()))
	if msg == "" {
		return false
	}
	permanentMarkers := []string{
		"400 bad request",
		"401 unauthorized",
		"403 forbidden",
		"mac verification failed",
		"invalid encrypted request",
		"decryption failed",
	}
	for _, marker := range permanentMarkers {
		if strings.Contains(msg, marker) {
			return false
		}
	}
	transientMarkers := []string{
		"520",
		"502 bad gateway",
		"503 service unavailable",
		"504 gateway timeout",
		"internal_error",
		"stream error",
		"connection reset",
		"connection refused",
		"connection aborted",
		"unexpected eof",
		"eof",
		"timeout",
		"temporarily unavailable",
		"tls handshake timeout",
		"no such host",
	}
	for _, marker := range transientMarkers {
		if strings.Contains(msg, marker) {
			return true
		}
	}
	return false
}

func isRetryableHeartbeatError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var networkErr net.Error
	if errors.As(err, &networkErr) && (networkErr.Timeout() || networkErr.Temporary()) {
		return true
	}
	var statusErr agentHTTPStatusError
	if errors.As(err, &statusErr) {
		return statusErr.StatusCode == http.StatusRequestTimeout ||
			statusErr.StatusCode == http.StatusTooEarly ||
			statusErr.StatusCode == http.StatusTooManyRequests ||
			statusErr.StatusCode >= http.StatusInternalServerError
	}
	return isTransientAgentCommError(err)
}

func isClockSyncCandidateError(err error) bool {
	if err == nil {
		return false
	}
	if agentRequestResponseAuthenticated(err) {
		return false
	}
	msg := strings.ToLower(err.Error())
	if strings.Contains(msg, "mac verification failed") {
		return false
	}
	if strings.Contains(msg, "timestamp") || strings.Contains(msg, "replay protection") {
		return true
	}
	if strings.Contains(msg, "400 bad request") || strings.Contains(msg, "401 unauthorized") {
		return true
	}
	if strings.Contains(msg, "event stream status: 400") || strings.Contains(msg, "event stream status: 401") {
		return true
	}
	if strings.Contains(msg, "invalid encrypted request") || strings.Contains(msg, "decryption failed") {
		return true
	}
	return false
}

func encrypt(payload any, token string) (envelope, error) {
	return encryptAt(payload, token, time.Now().UnixMilli())
}

func encryptAt(payload any, token string, ts int64) (envelope, error) {
	plain, _ := json.Marshal(payload)
	keyEnc := sha256.Sum256([]byte(token + "|forwardx-agent-v1"))
	keyMac := sha256.Sum256([]byte(token + "|forwardx-agent-mac"))
	iv := make([]byte, aes.BlockSize)
	if _, err := rand.Read(iv); err != nil {
		return envelope{}, err
	}
	block, err := aes.NewCipher(keyEnc[:])
	if err != nil {
		return envelope{}, err
	}
	ct := make([]byte, len(plain))
	cipher.NewCTR(block, iv).XORKeyStream(ct, plain)
	mac := calcMAC(keyMac[:], iv, ct, ts)
	return envelope{V: 1, IV: hex.EncodeToString(iv), CT: hex.EncodeToString(ct), MAC: hex.EncodeToString(mac), TS: ts}, nil
}

func decrypt(env envelope, token string) ([]byte, error) {
	return decryptForPanel(env, token, "", "")
}

// decryptForPanel authenticates the envelope before using the optional panel
// time header. This lets an Agent tolerate a bounded clock skew without
// allowing an unauthenticated response header to bypass the MAC check.
func decryptForPanel(env envelope, token, panelURL, serverTimeHeader string) ([]byte, error) {
	keyEnc := sha256.Sum256([]byte(token + "|forwardx-agent-v1"))
	keyMac := sha256.Sum256([]byte(token + "|forwardx-agent-mac"))
	iv, err := hex.DecodeString(env.IV)
	if err != nil {
		return nil, err
	}
	ct, err := hex.DecodeString(env.CT)
	if err != nil {
		return nil, err
	}
	got, _ := hex.DecodeString(env.MAC)
	want := calcMAC(keyMac[:], iv, ct, env.TS)
	if !hmac.Equal(got, want) {
		return nil, fmt.Errorf("mac verification failed")
	}
	if serverTime, ok := parseEncryptedResponseTime(serverTimeHeader); ok {
		observeEncryptedResponseClock(panelURL, serverTime)
	}
	now := encryptedResponseNow(panelURL)
	responseAge := now.Sub(time.UnixMilli(env.TS))
	if env.TS <= 0 || responseAge > encryptedResponseReplayWindow || responseAge < -encryptedResponseReplayWindow {
		return nil, fmt.Errorf("encrypted response timestamp out of window")
	}
	encryptedResponseReplayMu.Lock()
	for key, expiresAt := range encryptedResponseReplay {
		if expiresAt.Before(now) {
			delete(encryptedResponseReplay, key)
		}
	}
	if _, exists := encryptedResponseReplay[env.MAC]; exists {
		encryptedResponseReplayMu.Unlock()
		return nil, fmt.Errorf("encrypted response replay detected")
	}
	if len(encryptedResponseReplay) >= encryptedResponseReplayCacheLimit {
		var oldestKey string
		var oldestExpiry time.Time
		for key, expiresAt := range encryptedResponseReplay {
			if oldestKey == "" || expiresAt.Before(oldestExpiry) {
				oldestKey, oldestExpiry = key, expiresAt
			}
		}
		if oldestKey != "" {
			delete(encryptedResponseReplay, oldestKey)
		}
	}
	encryptedResponseReplay[env.MAC] = now.Add(encryptedResponseReplayWindow)
	encryptedResponseReplayMu.Unlock()
	block, err := aes.NewCipher(keyEnc[:])
	if err != nil {
		return nil, err
	}
	plain := make([]byte, len(ct))
	cipher.NewCTR(block, iv).XORKeyStream(plain, ct)
	return plain, nil
}

func parseEncryptedResponseTime(raw string) (time.Time, bool) {
	now := time.Now()
	offset, ok := parseEncryptedResponseClockOffsetAt(raw, now)
	if !ok {
		return time.Time{}, false
	}
	return now.Add(offset), true
}

func parseEncryptedResponseClockOffsetAt(raw string, now time.Time) (time.Duration, bool) {
	value, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if err != nil || value <= 0 {
		return 0, false
	}
	offset := time.UnixMilli(value).Sub(now)
	if absDuration(offset) > encryptedResponseClockMaxOffset {
		return 0, false
	}
	return offset, true
}

func encryptedResponseClockHeaderAt(offset time.Duration, now time.Time) string {
	return strconv.FormatInt(now.Add(offset).UnixMilli(), 10)
}

func observeEncryptedResponseClock(panelURL string, serverTime time.Time) {
	panelURL = normalizePanelURL(panelURL)
	if panelURL == "" || serverTime.IsZero() {
		return
	}
	offset := serverTime.Sub(time.Now())
	if absDuration(offset) > encryptedResponseClockMaxOffset {
		return
	}
	encryptedResponseClockMu.Lock()
	encryptedResponseClock[panelURL] = offset
	encryptedResponseClockMu.Unlock()
}

func encryptedResponseNow(panelURL string) time.Time {
	offset := time.Duration(0)
	if normalized := normalizePanelURL(panelURL); normalized != "" {
		encryptedResponseClockMu.RLock()
		offset = encryptedResponseClock[normalized]
		encryptedResponseClockMu.RUnlock()
	}
	return time.Now().Add(offset)
}

func hasEncryptedResponseClock(panelURL string) bool {
	normalized := normalizePanelURL(panelURL)
	if normalized == "" {
		return false
	}
	encryptedResponseClockMu.RLock()
	_, ok := encryptedResponseClock[normalized]
	encryptedResponseClockMu.RUnlock()
	return ok
}

func absDuration(value time.Duration) time.Duration {
	if value < 0 {
		return -value
	}
	return value
}

func resetEncryptedResponseStateForTests() {
	encryptedResponseReplayMu.Lock()
	encryptedResponseReplay = make(map[string]time.Time)
	encryptedResponseReplayMu.Unlock()
	encryptedResponseClockMu.Lock()
	encryptedResponseClock = make(map[string]time.Duration)
	encryptedResponseClockMu.Unlock()
}

func calcMAC(key, iv, ct []byte, ts int64) []byte {
	buf := bytes.NewBufferString("v1")
	buf.Write(iv)
	buf.Write(ct)
	tsb := make([]byte, 8)
	binary.BigEndian.PutUint64(tsb, uint64(ts))
	buf.Write(tsb)
	m := hmac.New(sha256.New, key)
	m.Write(buf.Bytes())
	return m.Sum(nil)
}

func runShell(cmd string) bool {
	ok, _ := runShellWithOutput(cmd)
	return ok
}

func runShellWithOutput(cmd string) (bool, string) {
	if len(cmd) > shellInlineMaxBytes {
		logVerbosef("exec: long shell command bytes=%d via temp script", len(cmd))
	} else {
		logVerbosef("exec: %s", cmd)
	}
	started := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), actionShellTimeout)
	defer cancel()
	c, cleanup, viaTemp, err := shellCommand(ctx, cmd)
	if err != nil {
		logf("exec failed before start err=%v %s", err, shellCommandLogSummary(cmd))
		return false, compactShellFailureOutput(nil, err, false)
	}
	out, err := c.CombinedOutput()
	cleanup()
	retriedViaTemp := false
	if isArgumentListTooLong(err) && !viaTemp && ctx.Err() != context.DeadlineExceeded {
		logf("exec retry via temp script after argument list too long bytes=%d", len(cmd))
		c, cleanup, _, err = shellCommandTempScript(ctx, cmd)
		if err != nil {
			logf("exec failed before temp retry err=%v %s", err, shellCommandLogSummary(cmd))
			return false, compactShellFailureOutput(nil, err, false)
		}
		retriedViaTemp = true
		viaTemp = true
		out, err = c.CombinedOutput()
		cleanup()
	}
	elapsed := time.Since(started)
	if len(out) > 0 && (err != nil || ctx.Err() == context.DeadlineExceeded || agentVerboseLogs) {
		logf("%s", strings.TrimSpace(string(out)))
	}
	if ctx.Err() == context.DeadlineExceeded {
		logf("exec timeout duration=%s temp=%v retriedTemp=%v outputBytes=%d %s", elapsed.Round(time.Millisecond), viaTemp, retriedViaTemp, len(out), shellCommandLogSummary(cmd))
		return false, compactShellFailureOutput(out, ctx.Err(), true)
	}
	if err != nil {
		logf("exec failed duration=%s temp=%v retriedTemp=%v outputBytes=%d err=%v %s", elapsed.Round(time.Millisecond), viaTemp, retriedViaTemp, len(out), err, shellCommandLogSummary(cmd))
		return false, compactShellFailureOutput(out, err, false)
	}
	if elapsed >= actionShellSlowThreshold {
		logf("exec slow duration=%s temp=%v retriedTemp=%v outputBytes=%d %s", elapsed.Round(time.Millisecond), viaTemp, retriedViaTemp, len(out), shellCommandLogSummary(cmd))
	}
	return true, ""
}

func runShellQuiet(cmd string) bool {
	if strings.TrimSpace(cmd) == "" {
		return true
	}
	started := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, cleanup, viaTemp, err := shellCommand(ctx, cmd)
	if err != nil {
		return false
	}
	err = c.Run()
	cleanup()
	retriedViaTemp := false
	if isArgumentListTooLong(err) && !viaTemp && ctx.Err() != context.DeadlineExceeded {
		c, cleanup, _, err = shellCommandTempScript(ctx, cmd)
		if err != nil {
			return false
		}
		retriedViaTemp = true
		viaTemp = true
		err = c.Run()
		cleanup()
	}
	elapsed := time.Since(started)
	ok := err == nil && ctx.Err() != context.DeadlineExceeded
	if ctx.Err() == context.DeadlineExceeded {
		logf("exec quiet timeout duration=%s temp=%v retriedTemp=%v %s", elapsed.Round(time.Millisecond), viaTemp, retriedViaTemp, shellCommandLogSummary(cmd))
	} else if elapsed >= actionShellSlowThreshold {
		logf("exec quiet slow ok=%v duration=%s temp=%v retriedTemp=%v %s", ok, elapsed.Round(time.Millisecond), viaTemp, retriedViaTemp, shellCommandLogSummary(cmd))
	}
	return ok
}

func runShellBatch(commands []string) bool {
	ok, _ := runShellBatchWithOutput(commands)
	return ok
}

func runShellBatchWithOutput(commands []string) (bool, string) {
	filtered := make([]string, 0, len(commands))
	for _, cmd := range commands {
		if strings.TrimSpace(cmd) != "" {
			filtered = append(filtered, cmd)
		}
	}
	if len(filtered) == 0 {
		return true, ""
	}
	if len(filtered) == 1 {
		return runShellWithOutput(filtered[0])
	}
	var script strings.Builder
	script.WriteString("set +e\n")
	script.WriteString("__forwardx_status=0\n")
	for _, cmd := range filtered {
		script.WriteString("(\n")
		script.WriteString(cmd)
		script.WriteString("\n) || __forwardx_status=1\n")
	}
	script.WriteString("exit $__forwardx_status\n")
	return runShellWithOutput(script.String())
}

func compactShellFailureOutput(out []byte, err error, timedOut bool) string {
	detail := strings.Join(strings.Fields(string(out)), " ")
	if detail == "" {
		switch {
		case timedOut:
			detail = "command timed out"
		case err != nil:
			detail = err.Error()
		}
	}
	const maxRunes = 240
	runes := []rune(detail)
	if len(runes) > maxRunes {
		return "..." + string(runes[len(runes)-(maxRunes-3):])
	}
	return detail
}

func isArgumentListTooLong(err error) bool {
	return err != nil && strings.Contains(strings.ToLower(err.Error()), "argument list too long")
}

func shellCommandLogSummary(cmd string) string {
	h := fnv.New64a()
	_, _ = h.Write([]byte(cmd))
	return fmt.Sprintf("cmdHash=%016x cmdBytes=%d", h.Sum64(), len(cmd))
}

func shellCommand(ctx context.Context, cmd string) (*exec.Cmd, func(), bool, error) {
	if len(cmd) <= shellInlineMaxBytes {
		c := exec.CommandContext(ctx, "sh", "-c", cmd)
		prepareShellCommand(c)
		return c, func() {}, false, nil
	}
	return shellCommandTempScript(ctx, cmd)
}

// shellCommandWaitDelay：sh 退出（或超时被杀）后，最多再等这么久让输出管道关闭。
// 命令里后台起的孙进程如果继承了 stdout/stderr，不设这个值 Wait 会一直阻塞，
// 进而让 actionPendingCount 永远降不下来、流量采集再也不跑。
var shellCommandWaitDelay = 5 * time.Second

// shellStandardPath 是 systemd 默认的 PATH。改用 `sh -c`（不再 `-l` 读 /etc/profile，
// 那里的脚本可能很慢甚至卡住）之后，用它补齐 Agent 进程 PATH 里缺的标准目录，
// 保证 iptables/nft/systemctl 以及装在 /usr/local/bin 下的转发程序都能找到。
const shellStandardPath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

func prepareShellCommand(c *exec.Cmd) {
	// 单独的进程组 + 超时时杀整个组：只杀 sh 会留下卡住的孙进程继续占着管道。
	configureShellProcessGroup(c)
	c.WaitDelay = shellCommandWaitDelay
	c.Env = shellCommandEnv(os.Environ())
}

func shellCommandEnv(base []string) []string {
	env := make([]string, 0, len(base)+2)
	pathValue := ""
	for _, item := range base {
		if strings.HasPrefix(item, "PATH=") {
			pathValue = strings.TrimPrefix(item, "PATH=")
			continue
		}
		if strings.HasPrefix(item, iptablesWaitEnvName+"=") {
			continue
		}
		env = append(env, item)
	}
	env = append(env, "PATH="+mergeShellPath(pathValue, shellStandardPath))
	env = append(env, iptablesWaitEnvName+"="+iptablesWaitFlag())
	return env
}

func mergeShellPath(current string, required string) string {
	parts := []string{}
	seen := map[string]bool{}
	for _, list := range []string{current, required} {
		for _, dir := range strings.Split(list, ":") {
			dir = strings.TrimSpace(dir)
			if dir == "" || seen[dir] {
				continue
			}
			seen[dir] = true
			parts = append(parts, dir)
		}
	}
	return strings.Join(parts, ":")
}

func shellCommandTempScript(ctx context.Context, cmd string) (*exec.Cmd, func(), bool, error) {
	dir := filepath.Join(os.TempDir(), "forwardx-agent")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, func() {}, true, err
	}
	file, err := os.CreateTemp(dir, "shell-*.sh")
	if err != nil {
		return nil, func() {}, true, err
	}
	path := file.Name()
	cleanup := func() {
		_ = os.Remove(path)
	}
	if _, err := file.WriteString("#!/bin/sh\n" + cmd + "\n"); err != nil {
		_ = file.Close()
		cleanup()
		return nil, func() {}, true, err
	}
	if err := file.Close(); err != nil {
		cleanup()
		return nil, func() {}, true, err
	}
	if err := os.Chmod(path, 0700); err != nil {
		cleanup()
		return nil, func() {}, true, err
	}
	c := exec.CommandContext(ctx, "sh", path)
	prepareShellCommand(c)
	return c, cleanup, true, nil
}

func listenPortOwnerSummary(port int) string {
	if port <= 0 {
		return ""
	}
	portText := strconv.Itoa(port)
	type probe struct {
		name       string
		args       []string
		filterPort bool
	}
	probes := []probe{
		{name: "ss", args: []string{"-ltnup"}, filterPort: true},
		{name: "lsof", args: []string{"-nP", "-iTCP:" + portText, "-sTCP:LISTEN"}},
		{name: "lsof", args: []string{"-nP", "-iUDP:" + portText}},
		{name: "fuser", args: []string{"-v", "-n", "tcp", portText}},
		{name: "fuser", args: []string{"-v", "-n", "udp", portText}},
	}
	for _, p := range probes {
		if _, err := exec.LookPath(p.name); err != nil {
			continue
		}
		out, _ := commandCombinedOutputWithTimeout(3*time.Second, p.name, p.args...)
		text := strings.TrimSpace(string(out))
		if p.filterPort {
			text = filterListenPortLines(text, portText)
		}
		if text == "" {
			continue
		}
		return compactLogOutput(p.name + " " + strings.Join(p.args, " ") + ": " + text)
	}
	return ""
}

func filterListenPortLines(text, portText string) string {
	if strings.TrimSpace(text) == "" {
		return ""
	}
	lines := strings.Split(text, "\n")
	matched := []string{}
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if listenPortLineMatches(line, portText) {
			matched = append(matched, line)
		}
	}
	return strings.Join(matched, "\n")
}

func listenPortLineMatches(line, portText string) bool {
	needle := ":" + portText
	offset := 0
	for {
		idx := strings.Index(line[offset:], needle)
		if idx < 0 {
			return false
		}
		end := offset + idx + len(needle)
		if end >= len(line) || line[end] < '0' || line[end] > '9' {
			return true
		}
		offset = end
	}
}

func compactLogOutput(text string) string {
	lines := strings.Split(strings.ReplaceAll(strings.TrimSpace(text), "\r\n", "\n"), "\n")
	parts := []string{}
	for _, line := range lines {
		line = strings.Join(strings.Fields(line), " ")
		if line != "" {
			parts = append(parts, line)
		}
	}
	compact := strings.Join(parts, " | ")
	if len(compact) > 900 {
		return compact[:900] + "..."
	}
	return compact
}

// compactLogField keeps control-plane values on one log line. Values are
// normally generated by the panel, but stripping newlines also protects the
// local diagnostic file if a malformed value is ever returned.
func compactLogField(value string, limit int) string {
	cleaned := strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, value)
	compact := strings.Join(strings.Fields(strings.TrimSpace(cleaned)), " ")
	if compact == "" {
		return "-"
	}
	if limit > 0 && len(compact) > limit {
		return compact[:limit] + "..."
	}
	return compact
}

func osInfo() string {
	if b, err := os.ReadFile("/etc/os-release"); err == nil {
		for _, line := range strings.Split(string(b), "\n") {
			if strings.HasPrefix(line, "PRETTY_NAME=") {
				return strings.Trim(strings.TrimPrefix(line, "PRETTY_NAME="), `"`)
			}
		}
	}
	return runtime.GOOS + "/" + runtime.GOARCH
}

func publicIPs() (string, string) {
	publicIPMu.Lock()
	ipv4, ipv6 := publicIPv4Cache, publicIPv6Cache
	stale := publicIPCheckedAt.IsZero() || time.Since(publicIPCheckedAt) >= publicIPRefreshInterval
	if stale && !publicIPRefreshRunning {
		publicIPRefreshRunning = true
		go refreshPublicIPs()
	}
	publicIPMu.Unlock()
	return ipv4, ipv6
}

func refreshPublicIPs() {
	ipv4Ch := make(chan string, 1)
	ipv6Ch := make(chan string, 1)
	go func() {
		ipv4Ch <- fetchPublicIP([]string{
			"https://api.ipify.org",
			"https://ipv4.icanhazip.com",
			"https://v4.ident.me",
		})
	}()
	go func() {
		ipv6 := localPublicIPv6()
		if ipv6 == "" {
			ipv6 = fetchPublicIP([]string{
				"https://api6.ipify.org",
				"https://ipv6.icanhazip.com",
				"https://v6.ident.me",
			})
		}
		ipv6Ch <- ipv6
	}()
	ipv4 := <-ipv4Ch
	ipv6 := <-ipv6Ch
	publicIPMu.Lock()
	if ipv4 != "" {
		publicIPv4Cache = ipv4
	}
	if ipv6 != "" {
		publicIPv6Cache = ipv6
	}
	publicIPCheckedAt = time.Now()
	publicIPRefreshRunning = false
	publicIPMu.Unlock()
}

func fetchPublicIP(urls []string) string {
	if len(urls) == 0 {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	results := make(chan string, len(urls))
	for _, u := range urls {
		u := u
		go func() {
			req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
			if err != nil {
				results <- ""
				return
			}
			res, err := agentPublicHTTPClient.Do(req)
			if err != nil {
				results <- ""
				return
			}
			body, _ := io.ReadAll(io.LimitReader(res.Body, 128))
			_ = res.Body.Close()
			ip := strings.TrimSpace(string(body))
			if res.StatusCode >= 300 || net.ParseIP(ip) == nil {
				ip = ""
			}
			results <- ip
		}()
	}
	for range urls {
		select {
		case ip := <-results:
			if ip != "" {
				cancel()
				return ip
			}
		case <-ctx.Done():
			return ""
		}
	}
	return ""
}

func localPublicIPv6() string {
	if ip := localPublicIPv6FromIPCommand(); ip != "" {
		return ip
	}
	return localPublicIPv6FromInterfaces()
}

func localPublicIPv6FromIPCommand() string {
	out, err := commandOutputWithTimeout(3*time.Second, "ip", "-o", "-6", "addr", "show", "scope", "global")
	if err != nil {
		return ""
	}
	type candidate struct {
		ip    string
		score int
	}
	candidates := []candidate{}
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		for i, field := range fields {
			if field != "inet6" || i+1 >= len(fields) {
				continue
			}
			ip := publicIPv6Literal(strings.Split(fields[i+1], "/")[0])
			if ip == "" {
				continue
			}
			flags := strings.ToLower(strings.Join(fields[i+2:], " "))
			if strings.Contains(flags, "tentative") || strings.Contains(flags, "dadfailed") {
				continue
			}
			score := 100
			if strings.Contains(flags, "deprecated") {
				score -= 40
			}
			if strings.Contains(flags, "temporary") {
				score -= 20
			}
			candidates = append(candidates, candidate{ip: ip, score: score})
			break
		}
	}
	if len(candidates) == 0 {
		return ""
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		return candidates[i].score > candidates[j].score
	})
	return candidates[0].ip
}

func localPublicIPv6FromInterfaces() string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			var ip net.IP
			switch value := addr.(type) {
			case *net.IPNet:
				ip = value.IP
			case *net.IPAddr:
				ip = value.IP
			}
			if ip := publicIPv6Literal(ip.String()); ip != "" {
				return ip
			}
		}
	}
	return ""
}

func publicIPv6Literal(value string) string {
	ip := net.ParseIP(strings.Trim(strings.TrimSpace(value), "[]"))
	if ip == nil || ip.To4() != nil || !ip.IsGlobalUnicast() || isUniqueLocalIPv6(ip) {
		return ""
	}
	return ip.String()
}

func isUniqueLocalIPv6(ip net.IP) bool {
	ip = ip.To16()
	return ip != nil && ip[0]&0xfe == 0xfc
}

func readMeminfo() map[string]uint64 {
	out := map[string]uint64{}
	b, _ := os.ReadFile("/proc/meminfo")
	for _, line := range strings.Split(string(b), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 {
			v, _ := strconv.ParseUint(fields[1], 10, 64)
			out[strings.TrimSuffix(fields[0], ":")] = v * 1024
		}
	}
	return out
}

func memTotalFrom(m map[string]uint64) uint64 { return m["MemTotal"] }

func memUsedFrom(m map[string]uint64) uint64 {
	total := m["MemTotal"]
	available := m["MemAvailable"]
	if total <= available {
		return 0
	}
	return total - available
}

func swapTotalFrom(m map[string]uint64) uint64 { return m["SwapTotal"] }

func swapUsedFrom(m map[string]uint64) uint64 {
	total := m["SwapTotal"]
	free := m["SwapFree"]
	if total <= free {
		return 0
	}
	return total - free
}

func usagePercent(used, total uint64) int {
	if total == 0 {
		return 0
	}
	return int(used * 100 / total)
}

func memTotal() uint64 { return memTotalFrom(readMeminfo()) }
func memUsed() uint64 {
	return memUsedFrom(readMeminfo())
}
func memUsagePercent() int {
	return usagePercent(memUsed(), memTotal())
}

func uptime() int64 {
	b, _ := os.ReadFile("/proc/uptime")
	f := strings.Fields(string(b))
	if len(f) == 0 {
		return 0
	}
	v, _ := strconv.ParseFloat(f[0], 64)
	return int64(v)
}

func readAgentBootID() string {
	raw, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(raw))
}

func cpuInfo() string {
	model := ""
	cores := runtime.NumCPU()
	if b, err := os.ReadFile("/proc/cpuinfo"); err == nil {
		for _, line := range strings.Split(string(b), "\n") {
			if strings.HasPrefix(line, "model name") {
				parts := strings.SplitN(line, ":", 2)
				if len(parts) == 2 {
					model = strings.TrimSpace(parts[1])
				}
				break
			}
		}
	}
	if model == "" {
		model = "Unknown CPU"
	}
	coreLabel := "Virtual Cores"
	if cores == 1 {
		coreLabel = "Virtual Core"
	}
	if cores > 0 {
		return fmt.Sprintf("%s %d %s", model, cores, coreLabel)
	}
	return model
}

type cpuTimes struct {
	Idle  uint64
	Total uint64
}

func cpuUsage() int {
	current, ok := readCPUTimes()
	if !ok {
		return cpuLoadAveragePercentFallback()
	}
	cpuUsageMu.Lock()
	ready := previousCPUReady
	if !ready {
		previousCPUTimes = current
		previousCPUReady = true
	}
	cpuUsageMu.Unlock()
	if !ready {
		time.Sleep(200 * time.Millisecond)
		if next, ok := readCPUTimes(); ok {
			current = next
		}
	}
	return cpuUsageFromTimes(current)
}

func cpuUsageFromTimes(current cpuTimes) int {
	cpuUsageMu.Lock()
	defer cpuUsageMu.Unlock()
	previous := previousCPUTimes
	previousCPUTimes = current
	previousCPUReady = true
	if current.Total <= previous.Total {
		return 0
	}
	totalDelta := current.Total - previous.Total
	idleDelta := uint64(0)
	if current.Idle > previous.Idle {
		idleDelta = current.Idle - previous.Idle
	}
	if idleDelta >= totalDelta {
		return 0
	}
	busyDelta := totalDelta - idleDelta
	usage := int((busyDelta*100 + totalDelta/2) / totalDelta)
	if usage < 0 {
		return 0
	}
	if usage > 100 {
		return 100
	}
	return usage
}

func readCPUTimes() (cpuTimes, bool) {
	b, err := os.ReadFile("/proc/stat")
	if err != nil {
		return cpuTimes{}, false
	}
	for _, line := range strings.Split(string(b), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 5 || fields[0] != "cpu" {
			continue
		}
		values := make([]uint64, 0, len(fields)-1)
		for _, field := range fields[1:] {
			value, err := strconv.ParseUint(field, 10, 64)
			if err != nil {
				value = 0
			}
			values = append(values, value)
		}
		total := uint64(0)
		for _, value := range values {
			total += value
		}
		idle := values[3]
		if len(values) > 4 {
			idle += values[4]
		}
		if total == 0 {
			return cpuTimes{}, false
		}
		return cpuTimes{Idle: idle, Total: total}, true
	}
	return cpuTimes{}, false
}

func cpuLoadAveragePercentFallback() int {
	b, _ := os.ReadFile("/proc/loadavg")
	f := strings.Fields(string(b))
	if len(f) == 0 {
		return 0
	}
	v, _ := strconv.ParseFloat(f[0], 64)
	cores := runtime.NumCPU()
	if cores <= 0 {
		cores = 1
	}
	usage := int((v/float64(cores))*100 + 0.5)
	if usage < 0 {
		return 0
	}
	if usage > 100 {
		return 100
	}
	return usage
}

func netBytes(idx int) uint64 {
	b, _ := os.ReadFile("/proc/net/dev")
	var total uint64
	for _, line := range strings.Split(string(b), "\n") {
		if !strings.Contains(line, ":") || strings.Contains(line, "lo:") {
			continue
		}
		parts := strings.Fields(strings.ReplaceAll(line, ":", " "))
		if len(parts) > 9 {
			if idx == 0 {
				v, _ := strconv.ParseUint(parts[1], 10, 64)
				total += v
			} else {
				v, _ := strconv.ParseUint(parts[9], 10, 64)
				total += v
			}
		}
	}
	return total
}

func diskStats() (usage int, used uint64, total uint64) {
	out, err := commandOutputWithTimeout(3*time.Second, "sh", "-c", `df -P -B1 / | awk 'NR==2 {gsub("%","",$5); print $5, $3, $2}'`)
	if err != nil {
		return 0, 0, 0
	}
	fields := strings.Fields(string(out))
	if len(fields) >= 1 {
		usage, _ = strconv.Atoi(fields[0])
	}
	if len(fields) >= 2 {
		used, _ = strconv.ParseUint(fields[1], 10, 64)
	}
	if len(fields) >= 3 {
		total, _ = strconv.ParseUint(fields[2], 10, 64)
	}
	return usage, used, total
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'"
}

func shouldLogAgentReport(key string, interval time.Duration) bool {
	now := time.Now()
	agentReportLogMu.Lock()
	defer agentReportLogMu.Unlock()
	pruneTimeMapLocked(agentReportLogAt, now, agentMemoryCacheRetention, agentReportLogMaxKeys)
	last := agentReportLogAt[key]
	if !last.IsZero() && now.Sub(last) < interval {
		return false
	}
	agentReportLogAt[key] = now
	return true
}

func isEnvTruthy(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func logVerbosef(format string, args ...any) {
	if agentVerboseLogs {
		logf(format, args...)
	}
}

func logf(format string, args ...any) {
	message := fmt.Sprintf(format, args...)
	createdAt := time.Now().Format(time.RFC3339)
	line := createdAt + " " + message + "\n"
	fmt.Print(line)
	_ = os.MkdirAll(agentLogDir, 0755)
	agentLogMu.Lock()
	defer agentLogMu.Unlock()
	f, err := os.OpenFile(agentLogPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	if err == nil {
		_, _ = f.WriteString(line)
		info, _ := f.Stat()
		_ = f.Close()
		if info != nil && info.Size() > agentLogMaxBytes {
			trimLogFileTail(agentLogPath, agentLogTailBytes)
		}
	}
	pruneAgentLocalLogsLocked()
}

func startAgentLogMaintenance() {
	agentLogMaintenanceOnce.Do(func() {
		pruneAgentLocalLogs()
		go func() {
			ticker := time.NewTicker(agentLogSizeCheckInterval)
			defer ticker.Stop()
			for range ticker.C {
				pruneAgentLocalLogs()
			}
		}()
	})
}

func pruneAgentRuntimeData() {
	pruneAgentLocalLogs()
	pruneAgentMemoryCaches()
}

func pruneAgentLocalLogs() {
	agentLogMu.Lock()
	defer agentLogMu.Unlock()
	pruneAgentLocalLogsLocked()
}

func pruneAgentLocalLogsLocked() {
	now := time.Now()
	checkSizes := agentLogSizePrunedAt.IsZero() || now.Sub(agentLogSizePrunedAt) >= agentLogSizeCheckInterval
	checkRetention := agentLogRetentionPrunedAt.IsZero() || now.Sub(agentLogRetentionPrunedAt) >= agentLogRetentionCheckInterval
	if !checkSizes && !checkRetention {
		return
	}
	if checkSizes {
		agentLogSizePrunedAt = now
	}
	if checkRetention {
		agentLogRetentionPrunedAt = now
	}
	pruneLogDirectory(agentLogDir, agentLogPath, now, checkRetention, logPruneLimits{
		fileMaxBytes:    agentLogMaxBytes,
		fileTailBytes:   agentLogTailBytes,
		minimumTail:     agentLogMinimumTailBytes,
		directoryMax:    agentLogDirectoryMaxBytes,
		directoryTarget: agentLogDirectoryTargetBytes,
		retention:       agentLogRetention,
	})
}

type logPruneLimits struct {
	fileMaxBytes    int64
	fileTailBytes   int64
	minimumTail     int64
	directoryMax    int64
	directoryTarget int64
	retention       time.Duration
}

type logFileUsage struct {
	path    string
	size    int64
	modTime time.Time
}

func pruneLogDirectory(dir string, primaryPath string, now time.Time, checkRetention bool, limits logPruneLimits) {
	paths, err := filepath.Glob(filepath.Join(dir, "*.log"))
	if err != nil || len(paths) == 0 {
		paths = []string{primaryPath}
	}
	for _, path := range paths {
		pruneAgentLocalLogFile(path, now, checkRetention, limits)
	}
	enforceLogDirectoryLimit(paths, primaryPath, limits)
}

func pruneAgentLocalLogFile(path string, now time.Time, checkRetention bool, limits logPruneLimits) {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return
	}
	if info.Size() > limits.fileMaxBytes {
		trimLogFileTail(path, limits.fileTailBytes)
	}
	if !checkRetention || limits.retention <= 0 {
		return
	}
	info, err = os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return
	}
	cutoff := now.Add(-limits.retention)
	if info.ModTime().Before(cutoff) {
		_ = os.Truncate(path, 0)
		return
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return
	}
	lines := strings.Split(string(raw), "\n")
	retained := make([]string, 0, len(lines))
	changed := false
	for _, line := range lines {
		if strings.TrimSpace(line) == "" {
			continue
		}
		t, ok := parseLogLineTime(line)
		if !ok {
			retained = append(retained, line)
			continue
		}
		if t.After(cutoff) {
			retained = append(retained, line)
			continue
		}
		changed = true
	}
	if changed {
		if len(retained) == 0 {
			_ = os.WriteFile(path, nil, 0644)
		} else {
			_ = os.WriteFile(path, []byte(strings.Join(retained, "\n")+"\n"), 0644)
		}
	}
	if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() && info.Size() > limits.fileMaxBytes {
		trimLogFileTail(path, limits.fileTailBytes)
	}
}

func parseLogLineTime(line string) (time.Time, bool) {
	fields := strings.Fields(line)
	if len(fields) == 0 {
		return time.Time{}, false
	}
	if parsed, err := time.Parse(time.RFC3339, fields[0]); err == nil {
		return parsed, true
	}
	if len(fields) >= 2 {
		for _, layout := range []string{"2006/01/02 15:04:05.000000", "2006/01/02 15:04:05"} {
			if parsed, err := time.ParseInLocation(layout, fields[0]+" "+fields[1], time.Local); err == nil {
				return parsed, true
			}
		}
	}
	return time.Time{}, false
}

func enforceLogDirectoryLimit(paths []string, primaryPath string, limits logPruneLimits) {
	if limits.directoryMax <= 0 || limits.directoryTarget <= 0 {
		return
	}
	files := make([]logFileUsage, 0, len(paths))
	var total int64
	for _, path := range paths {
		info, err := os.Stat(path)
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		files = append(files, logFileUsage{path: path, size: info.Size(), modTime: info.ModTime()})
		total += info.Size()
	}
	if total <= limits.directoryMax {
		return
	}

	sort.Slice(files, func(i, j int) bool {
		if files[i].size == files[j].size {
			return files[i].modTime.Before(files[j].modTime)
		}
		return files[i].size > files[j].size
	})
	for i := range files {
		if total <= limits.directoryTarget {
			return
		}
		keep := limits.minimumTail
		if filepath.Clean(files[i].path) == filepath.Clean(primaryPath) && limits.fileTailBytes > keep {
			keep = limits.fileTailBytes
		}
		if keep < 0 || files[i].size <= keep {
			continue
		}
		before := files[i].size
		trimLogFileTail(files[i].path, keep)
		if info, err := os.Stat(files[i].path); err == nil {
			files[i].size = info.Size()
			total -= before - info.Size()
		}
	}
	if total <= limits.directoryTarget {
		return
	}

	// A host with hundreds of noisy per-rule logs can exceed the directory cap
	// even after every file keeps a small tail. Drop the oldest runtime logs first.
	sort.Slice(files, func(i, j int) bool {
		iPrimary := filepath.Clean(files[i].path) == filepath.Clean(primaryPath)
		jPrimary := filepath.Clean(files[j].path) == filepath.Clean(primaryPath)
		if iPrimary != jPrimary {
			return !iPrimary
		}
		return files[i].modTime.Before(files[j].modTime)
	})
	for i := range files {
		if total <= limits.directoryTarget {
			return
		}
		if files[i].size <= 0 {
			continue
		}
		keep := int64(0)
		if filepath.Clean(files[i].path) == filepath.Clean(primaryPath) {
			keep = limits.minimumTail
		}
		before := files[i].size
		if keep > 0 {
			trimLogFileTail(files[i].path, keep)
		} else {
			_ = os.Truncate(files[i].path, 0)
		}
		if info, err := os.Stat(files[i].path); err == nil {
			files[i].size = info.Size()
			total -= before - info.Size()
		}
	}
}

func trimLogFileTail(path string, keepBytes int64) {
	if keepBytes <= 0 || keepBytes > int64(int(keepBytes)) {
		return
	}
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || info.IsDir() || info.Size() <= keepBytes {
		return
	}
	buf := make([]byte, int(keepBytes))
	n, err := f.ReadAt(buf, info.Size()-keepBytes)
	if err != nil && err != io.EOF {
		return
	}
	data := buf[:n]
	if idx := bytes.IndexByte(data, '\n'); idx >= 0 && idx+1 < len(data) {
		data = data[idx+1:]
	}
	_ = os.WriteFile(path, data, 0644)
}

func pruneAgentMemoryCaches() {
	now := time.Now()
	if !agentMemoryPrunedAt.IsZero() && now.Sub(agentMemoryPrunedAt) < time.Hour {
		return
	}
	agentMemoryPrunedAt = now
	agentReportLogMu.Lock()
	pruneTimeMapLocked(agentReportLogAt, now, agentMemoryCacheRetention, agentReportLogMaxKeys)
	agentReportLogMu.Unlock()
	actionEpochMu.Lock()
	pruneIssuedAtMapLocked(latestActionIssuedAt, now, agentMemoryCacheRetention)
	actionEpochMu.Unlock()
	runtimeActionMu.Lock()
	for key, state := range runtimeActionCache {
		if state.CheckedAt.IsZero() || now.Sub(state.CheckedAt) > agentMemoryCacheRetention {
			delete(runtimeActionCache, key)
		}
	}
	runtimeActionMu.Unlock()
}

func pruneTimeMapLocked(values map[string]time.Time, now time.Time, maxAge time.Duration, maxKeys int) {
	if len(values) == 0 {
		return
	}
	for key, seenAt := range values {
		if seenAt.IsZero() || now.Sub(seenAt) > maxAge {
			delete(values, key)
		}
	}
	if maxKeys <= 0 || len(values) <= maxKeys {
		return
	}
	type entry struct {
		key string
		at  time.Time
	}
	entries := make([]entry, 0, len(values))
	for key, seenAt := range values {
		entries = append(entries, entry{key: key, at: seenAt})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].at.Before(entries[j].at) })
	for i := 0; i < len(entries)-maxKeys; i++ {
		delete(values, entries[i].key)
	}
}

func pruneIssuedAtMapLocked(values map[string]int64, now time.Time, maxAge time.Duration) {
	for key, issuedAt := range values {
		at := unixMillisOrSecondsTime(issuedAt)
		if at.IsZero() || now.Sub(at) > maxAge {
			delete(values, key)
		}
	}
}

func unixMillisOrSecondsTime(value int64) time.Time {
	if value <= 0 {
		return time.Time{}
	}
	if value > 1_000_000_000_000 {
		return time.UnixMilli(value)
	}
	return time.Unix(value, 0)
}

func fatal(format string, args ...any) {
	logf(format, args...)
	os.Exit(1)
}
