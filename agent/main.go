package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	"flag"
	"fmt"
	"net"
	"os"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

var Version = "2.2.250"
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

// 突发那一级的桶可以很深（例如 300 Mbps 多跑 60 秒 ≈ 2.2 GB），但别大到溢出。
const protocolGuardRateBurstOverrideMax = 64 * 1024 * 1024 * 1024

// 一条规则最多挂几级限速（用户上下行、突发、隧道、转发组、规则、整台主机）。
const protocolGuardMaxRateTiers = 8

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
const desiredStateVersionPath = agentStateDir + "/desired_state_agent_version"

var upgradeStarted int32
var upgradeStartedAt int64
var fxpMu sync.Mutex
var fxpServers = map[string]*fxpProcess{}
var fxpControlMu sync.Mutex
var fxpWireGuardRefSequence uint64
var fxpEndpointEventMu sync.Mutex
var fxpEndpointEvents = map[string]fxpEndpointEvent{}

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
	ProxyURL                  string `json:"proxyUrl,omitempty"` // 管理流量代理，见 management_proxy.go
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
	// RetryAfter 是面板在 429 / 503 上带的 Retry-After（比如切换数据库期间回 503 + Retry-After: 30），没有就是 0。
	RetryAfter time.Duration
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
	SNIInbounds             []sniInboundSpec         `json:"sniInbounds"`
	DNSWatch                []dnsWatchItem           `json:"dnsWatch"`
	LookingGlassTests       []lookingGlassTask       `json:"lookingGlassTests"`
	DiagnosticsTasks        []diagnosticsTask        `json:"diagnosticsTasks,omitempty"`
	RuleConnectionTasks     []ruleConnectionsTask    `json:"ruleConnectionTasks,omitempty"`
	Iperf3Tasks             []iperf3Task             `json:"iperf3Tasks"`
	PluginTasks             []pluginAgentTask        `json:"pluginTasks"`
	MimicInstallTask        *mimicInstallTask        `json:"mimicInstallTask,omitempty"`
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
	SNIInbounds        []sniInboundSpec
	DNSWatch           []dnsWatchItem
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

	// 普通端口转发的单 IP 接入限制快照（port_access_limits.go），只出现在
	// forwardType=port-access-limit-sync 的运行时动作里。
	PortAccessLimits []portAccessLimitSpec `json:"portAccessLimits,omitempty"`
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
	// 分层线路组：0 = 主线路组，1.. = 备用组（数字越小越优先）；nil = 不分层。
	// 规格里**每一条**都带了 Tier 才按分层走（见 failoverSpecTiered），否则一律是老行为。
	// 这是行为参数，进 failoverSignature。
	Tier *int `json:"tier,omitempty"`
	// 面板算好的、这条路径在下游各段中转上的延迟之和（毫秒）。评分和自动择优按
	// 「本机探测延迟 + 它」比整条链路；上报的 latencyMs 仍只是第一段。
	// 和 Down 一样是运行时提示：不进签名、不落盘，变了也不重建代理、不清统计。
	ExtraLatencyMs int `json:"extraLatencyMs,omitempty"`
	// 「落地怎么分」（2.2.245，面板 2.3.501）：一次走一条线路时，选了「一起分」的那条线路上的目标带着
	// 第几条线路（Line）、落在哪个落地（Landing：同一个落地经不同中转的几条一样）、怎么分（Spread：
	// least_load / round_robin / random / ip_hash）。主备逻辑挑出该走的那条之后，新连接在它那条线路的
	// 几个落地之间按 Spread 分（route_group_line_spread.go）。行为参数，进签名；不带时签名逐字不变。
	Line    *int   `json:"line,omitempty"`
	Landing string `json:"landing,omitempty"`
	Spread  string `json:"spread,omitempty"`
	// 这条路径最后从哪个 IP 出去（2.2.251，面板 2.3.520「故障切换优先同出口 IP」）：落地是 NEX 主机时是那台的
	// 出口地址（面板看到的心跳来源，没有就是登记的 IPv4 / IPv6），落地是手填地址时就是那个地址。当前这条挂了
	// 要换的时候，在同样够格的候选里优先挑出口 IP 和它一样的（failover_exit_ip.go）—— 对端看到的来源不变，
	// 登录态、IP 绑定不丢。只是平手时的取舍，不压过分层、人工指定和时段表。
	// 和 Down 一样是运行时提示：不进签名、不落盘，变了也不重建代理。
	ExitIP string `json:"exitIp,omitempty"`
}

// 规格是不是分层的：每一条出站都标了 Tier。缺一条就整组按不分层处理（老面板）。
func failoverSpecTiered(spec failoverSpec) bool {
	if len(spec.Targets) == 0 {
		return false
	}
	for _, target := range spec.Targets {
		if target.Tier == nil {
			return false
		}
	}
	return true
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
	// 投递方式：""（老行为）/ cold（冷备，同 ""）/ hot（热备：主备策略也竞速拨备线）/
	// aggregate（聚合，面板配 least_load 下发）/ replicate（多发，Agent 侧只用到分层）。
	Delivery string `json:"delivery,omitempty"`
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
	// 目标是域名时只用这一族的地址：ipv4 / ipv6；空或 auto 照旧（2.2.226 起，见 probe_family.go）
	Family string `json:"family,omitempty"`
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
	EgressShaping  string `json:"egressShaping,omitempty"`
	EgressMbps     int    `json:"egressMbps,omitempty"`
	EgressHintMbps int    `json:"egressHintMbps,omitempty"`
	// UDPFEC 是隧道的「抗丢包」开关（见 forwardx-fxp/udp_fec.go），原样交给 FXP。
	UDPFEC           bool   `json:"udpFec,omitempty"`
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
	// MultipathReplicate：复制模式，每一片从两条腿各发一份（FXP 2.2.133 起认）。
	MultipathReplicate bool `json:"multipathReplicate,omitempty"`
}

// fxpMultipathLeg is one parallel path from the entry to the exit, either a
// direct dial or a dial to a relay front that forwards on to the exit.
type fxpMultipathLeg struct {
	Host string `json:"host"`
	Port int    `json:"port"`
	Key  string `json:"key,omitempty"`
	Via  string `json:"via,omitempty"`
	// CapacityMbps：这一路（中转主机）的线路带宽，FXP 按它给单连接叠加的各路定初始份额。
	CapacityMbps int `json:"capacityMbps,omitempty"`
	// Standby：热备腿（面板 2.3.489 / FXP 2.2.137 起）。连着不送，主腿停了才接手，连接不断。
	Standby bool `json:"standby,omitempty"`
}

type fxpExitEndpoint struct {
	Host    string `json:"host"`
	Port    int    `json:"port"`
	UDPPort int    `json:"udpPort,omitempty"`
	Key     string `json:"key,omitempty"`
	PeerID  string `json:"peerId,omitempty"`
	// Weight 给出口策略 weighted 用，原样交给 FXP；没写按 1 算。
	Weight int `json:"weight,omitempty"`
	// CapacityMbps 是出口主机的线路带宽，FXP「按负载」按它折算；没写按一样大。
	CapacityMbps int `json:"capacityMbps,omitempty"`
	// ExitIP 是这个出口主机的出口地址（2.2.251，面板 2.3.520）：原样写进 FXP 的配置，留给以后 FXP 主备换出口时
	// 按「同出口 IP」取舍用 —— 现在的 FXP 还不读它。不进 fxpServerSignature：它是面板随时会变的提示，
	// 进了签名的话一变就要重载 FXP（WireGuard 的隧道没有热更新，是整个重启）。
	ExitIP string `json:"exitIp,omitempty"`
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
	// RateLimits（Agent 2.2.230 起）：多级限速，每一级一个共享桶，同一方向上所有级都要过。
	// 给了就以它为准，LimitIn / LimitOut / RateLimitScope 只留给旧 Agent。
	RateLimits []guardRateTier `json:"rateLimits,omitempty"`
}

func main() {
	configPath := flag.String("config", defaultConfigPath, "config file")
	onceRegister := flag.Bool("register", false, "register and exit")
	printVersion := flag.Bool("version", false, "print the Agent version and exit")
	flag.Parse()
	if *printVersion {
		// fwxm 和安装脚本靠它判断这个二进制认不认 proxyUrl（老版本不认这个参数，直接报错退出）。
		fmt.Println(Version)
		return
	}

	resolvedConfigPath, cfg, err := loadConfigWithFallback(*configPath)
	if err != nil {
		fatal("load config: %v", err)
	}
	if cfg.Interval <= 0 {
		cfg.Interval = 30
	}
	cfg.PanelURL = strings.TrimRight(cfg.PanelURL, "/")
	activeConfigPath = resolvedConfigPath
	// 在注册和任何通信协程之前：注册本身也要走代理。配置写错就直接退出，不悄悄改成直连。
	if err := configureAgentManagementProxy(cfg.ProxyURL); err != nil {
		fatal("proxy configuration: %v", err)
	}
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
	go applyReceivePacketSteering()
	restoreCountingChainStates(agentBootID)
	// 问一次 gost 运行时的版本（-V），处理安装脚本留下的待确认升级（见 gost_runtime_version.go）。
	go gostRuntimeStartupSelfCheck()

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
	// 快速转发的表留在内核里时，流量采集第一轮之前就得把 conntrack 计数接上。
	startFlowOffloadLoop()
	go agentMetricsScheduler(cfg)
	go agentDNSWatchScheduler()
	go agentExtLoop(cfg)
	// 端口接入限制快照失败后面板不会重发（期望状态没变），由 Agent 自己重试 / 定期核对。
	go portAccessLimitMaintenanceLoop()
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
				nextInterval = max(fullJitterSeconds(cfg.Interval, 2), panelRetryAfterSeconds(err))
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
				nextInterval = max(fullJitterSeconds(cfg.Interval, 2), panelRetryAfterSeconds(err))
			} else if result.ReconciliationCoalesced {
				nextInterval = coalescedHeartbeatRetrySeconds(result.NextInterval)
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
	tcpConnections, udpConnections := connectionCounts()
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
	payload["sniInbounds"] = sniInboundStatusSnapshot()
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
			tcpConnections,
			udpConnections,
		}
	} else {
		payload = map[string]any{
			"cpuUsage":       cpuUsageValue,
			"memoryUsage":    usagePercent(memoryUsed, memoryTotal),
			"memoryUsed":     memoryUsed,
			"memoryTotal":    memoryTotal,
			"swapUsage":      usagePercent(swapUsed, swapTotal),
			"swapUsed":       swapUsed,
			"swapTotal":      swapTotal,
			"networkIn":      netBytes(0),
			"networkOut":     netBytes(1),
			"diskUsage":      diskUsageValue,
			"diskUsed":       diskUsed,
			"diskTotal":      diskTotal,
			"uptime":         uptimeValue,
			"tcpConnections": tcpConnections,
			"udpConnections": udpConnections,
			"cpuInfo":        currentStatic.CPUInfo,
			"agentVersion":   Version,
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
	addGostRuntimeReport(payload)
	addHostHealthCounters(payload)
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
	// 都走 interactiveTasks：按任务 ID 去重、全局限并发、超出时给面板回失败结果（interactive_tasks.go）。
	for _, task := range resp.LookingGlassTests {
		dispatchLookingGlassTask(cfg, task)
	}
	// 一键链路诊断（2.2.226 起）：每个任务一组检查，并发跑完整包回报。
	for _, task := range resp.DiagnosticsTasks {
		dispatchDiagnosticsTask(cfg, task)
	}
	// 规则的「连接」清单（2.2.237 起）：现场读一遍 /proc 或 conntrack 回给面板。
	for _, task := range resp.RuleConnectionTasks {
		dispatchRuleConnectionsTask(cfg, task)
	}
	for _, task := range resp.Iperf3Tasks {
		dispatchIperf3Task(cfg, task)
	}
	for _, task := range resp.PluginTasks {
		enqueuePluginAgentTask(cfg, task)
	}
	if resp.MimicInstallTask != nil {
		go handleMimicInstallTask(cfg, *resp.MimicInstallTask)
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
	// 共享 TLS 入站：路由表整份换；规则的守卫起来之前拨不通就直接断开，不必等动作做完。
	syncSNIInbounds(state.SNIInbounds)
	if resp.ForceTCPing {
		agentMetricsForceTCPing.Store(true)
	}
	wakeAgentMetricsScheduler()
	return heartbeatResult{NextInterval: resp.NextInterval, MetricsOnly: resp.MetricsOnly}, nil
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

/*
好得多就不用等满 ScoreHoldSeconds（2.2.244 起）：整条链快 100 毫秒以上、而且只要一半的时间，连着 10 秒都是它
就切。557ms 的线路旁边摆着 3ms 的，等三分钟只会让人以为「整链最优」没生效；只好一点点的照旧等满，防来回漂。
*/
const failoverDramaticMarginMs = 100
const failoverDramaticHold = 10 * time.Second

// 面板给的下游延迟提示最多算到这么大（再大评分早就是 0 了），防一个离谱值溢出。
const failoverMaxExtraLatencyMs = 60000

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

// trimLeadingHTTPBlankLines 去掉开头的 CR/LF。只用于协议识别的采样，转发的
// 数据原样不动。TLS、SOCKS 的首字节不会是 CR/LF，去掉不影响它们的识别。
// 和 forwardx-fxp 里的同名函数保持一致（对照样本见仓库根目录 testdata/protocol_detection.json）。
func trimLeadingHTTPBlankLines(data []byte) []byte {
	return bytes.TrimLeft(data, "\r\n")
}

func detectHTTPProtocol(data []byte) bool {
	// 服务端会跳过请求行之前的空行，这里也跳过，免得前面垫一个 CRLF 就绕过拦截。
	data = trimLeadingHTTPBlankLines(data)
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
	// 连续多个空格按一个算：nginx 之类的服务端容忍请求行里的多余空格。
	parts := bytes.FieldsFunc(data[:lineEnd], func(r rune) bool { return r == ' ' })
	if len(parts) != 3 {
		return false
	}
	// 方法不分大小写：有的服务端和代理照收小写方法，大小写一换就绕过去了。
	method := strings.ToUpper(string(parts[0]))
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

// detectTLSProtocol 只认 ClientHello 的形状（记录头 + 握手类型 + 长度对得上），不只看前三个字节：
// 加密协议（SS2022 等）的随机首包碰巧以 16 03 0x 开头时不能被当成 TLS 拦掉。
// 和 forwardx-fxp 里的同名函数保持一致（对照样本见仓库根目录 testdata/protocol_detection.json）。
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

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func fatal(format string, args ...any) {
	logf(format, args...)
	os.Exit(1)
}
