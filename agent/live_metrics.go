package main

import (
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

/*
  实时指标（Agent 2.2.225 起）。

  面板上有人打开了这台主机的详情，面板经事件流发 agent-live-metrics。这里起一个小循环，
  每秒往 /api/agent/live-metrics 发一份紧凑指标（和心跳的 m 同一顺序），面板只放内存、不进库。
  面板回包里的 intervalMs 决定下一次多久后发；回 0（没人看了）、连续出错、或者跑满上限就停，
  下次有人看再由事件叫起来。

  CPU 用自己的一份 /proc/stat 快照算，窗口正好是两次发送之间那一秒，不和心跳那份互相抢。
  df 是起子进程的，磁盘变化又慢，缓存 10 秒。
*/

const (
	liveMetricsMinInterval   = 1 * time.Second
	liveMetricsMaxInterval   = 10 * time.Second
	liveMetricsMaxDuration   = 10 * time.Minute
	liveMetricsMaxErrors     = 3
	liveMetricsDiskCacheTTL  = 10 * time.Second
	liveMetricsPostTimeLimit = 5 * time.Second
)

type liveMetricsRequest struct {
	IntervalMs int `json:"intervalMs"`
}

type liveMetricsResponse struct {
	IntervalMs int `json:"intervalMs"`
}

type liveMetricsRunner struct {
	running atomic.Bool

	cpuMu    sync.Mutex
	cpuPrev  cpuTimes
	cpuReady bool

	diskMu    sync.Mutex
	diskAt    time.Time
	diskUsage int
	diskUsed  uint64
	diskTotal uint64
}

var agentLiveMetrics = &liveMetricsRunner{}

// 实时通道单独一个 5 秒超时的 client（连接池和常规同步共用）：面板或代理接了连接却迟迟不回时，
// 用常规那个 60 秒的 client 会让循环一卡一分钟、3 次出错要好几分钟才停，期间新的开始事件都被忽略。
var agentLiveMetricsHTTPClient = &http.Client{
	Timeout:   liveMetricsPostTimeLimit,
	Transport: agentSyncHTTPClient.Transport,
}

func normalizeLiveMetricsInterval(ms int) time.Duration {
	if ms <= 0 {
		return 0
	}
	interval := time.Duration(ms) * time.Millisecond
	if interval < liveMetricsMinInterval {
		interval = liveMetricsMinInterval
	}
	if interval > liveMetricsMaxInterval {
		interval = liveMetricsMaxInterval
	}
	return interval
}

// start 起循环；已经在跑就什么都不做（返回 false）。
func (r *liveMetricsRunner) start(cfg Config, intervalMs int) bool {
	interval := normalizeLiveMetricsInterval(intervalMs)
	if interval <= 0 {
		return false
	}
	if !r.running.CompareAndSwap(false, true) {
		return false
	}
	go func() {
		defer r.running.Store(false)
		r.run(cfg, interval, func(payload map[string]any, out *liveMetricsResponse) error {
			return postWithClient(agentLiveMetricsHTTPClient, cfg, "/api/agent/live-metrics", payload, out)
		}, time.Sleep)
	}()
	return true
}

func (r *liveMetricsRunner) run(cfg Config, interval time.Duration, send func(map[string]any, *liveMetricsResponse) error, sleep func(time.Duration)) int {
	startedAt := time.Now()
	errorsInRow := 0
	sent := 0
	for time.Since(startedAt) < liveMetricsMaxDuration {
		payload := map[string]any{"m": r.sample()}
		var resp liveMetricsResponse
		if err := send(payload, &resp); err != nil {
			errorsInRow++
			if errorsInRow >= liveMetricsMaxErrors {
				if shouldLogAgentReport("live-metrics-stop-errors", agentReportLogInterval) {
					logf("live metrics stopped after %d errors: %v", errorsInRow, err)
				}
				return sent
			}
			sleep(interval)
			continue
		}
		errorsInRow = 0
		sent++
		next := normalizeLiveMetricsInterval(resp.IntervalMs)
		if next <= 0 {
			return sent
		}
		interval = next
		sleep(interval)
	}
	return sent
}

func (r *liveMetricsRunner) cpuUsage() int {
	current, ok := readCPUTimes()
	if !ok {
		return cpuLoadAveragePercentFallback()
	}
	r.cpuMu.Lock()
	previous, ready := r.cpuPrev, r.cpuReady
	r.cpuPrev, r.cpuReady = current, true
	r.cpuMu.Unlock()
	if !ready {
		// 第一份没有上一个快照：借心跳那份的算法（它会睡 200ms 取一个窗口）
		return cpuUsage()
	}
	return cpuUsagePercentBetween(previous, current)
}

func cpuUsagePercentBetween(previous, current cpuTimes) int {
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
	usage := int(((totalDelta-idleDelta)*100 + totalDelta/2) / totalDelta)
	if usage > 100 {
		return 100
	}
	return usage
}

func (r *liveMetricsRunner) disk() (int, uint64, uint64) {
	r.diskMu.Lock()
	defer r.diskMu.Unlock()
	if r.diskAt.IsZero() || time.Since(r.diskAt) >= liveMetricsDiskCacheTTL {
		r.diskUsage, r.diskUsed, r.diskTotal = diskStats()
		r.diskAt = time.Now()
	}
	return r.diskUsage, r.diskUsed, r.diskTotal
}

// sample 与心跳的紧凑指标 m 同一顺序：
// cpu, mem%, memUsed, memTotal, swap%, swapUsed, swapTotal, netIn, netOut, disk%, diskUsed, diskTotal, uptime, tcp, udp
func (r *liveMetricsRunner) sample() []any {
	memInfo := readMeminfo()
	memoryTotal := memTotalFrom(memInfo)
	memoryUsed := memUsedFrom(memInfo)
	swapTotal := swapTotalFrom(memInfo)
	swapUsed := swapUsedFrom(memInfo)
	diskUsage, diskUsed, diskTotal := r.disk()
	tcp, udp := connectionCounts()
	return []any{
		r.cpuUsage(),
		usagePercent(memoryUsed, memoryTotal),
		memoryUsed,
		memoryTotal,
		usagePercent(swapUsed, swapTotal),
		swapUsed,
		swapTotal,
		netBytes(0),
		netBytes(1),
		diskUsage,
		diskUsed,
		diskTotal,
		uptime(),
		tcp,
		udp,
	}
}
