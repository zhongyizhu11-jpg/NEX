package main

import (
	"errors"
	"math/rand/v2"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// 面板说「等一下再来」的两种方式，以前 Agent 都没听：
//
//   - 429 / 503 带 Retry-After（切换数据库期间面板回 503 + Retry-After: 30）：Agent 照自己的
//     2~30 秒随机重试，那半分钟里被反复打回来。现在至少等到面板说的时间，再加 0~20% 随机。
//   - 心跳回 reconciliationCoalesced（面板正在对账的主机太多，这台先排队）：Agent 固定 5 秒后再来，
//     面板重启后排着队的 Agent 每 5 秒同一拍一起回来。现在按面板给的 nextInterval（新面板按队伍
//     长短给，旧面板给的就是 5），再加 0~50% 随机。
//
// 旧面板不发这些也照样工作：没有 Retry-After 就是原来的退避，nextInterval 是 5 就在 5~7 秒之间。
const (
	agentPanelRetryAfterMax          = 5 * time.Minute
	agentCoalescedRetryMaxSeconds    = 30
	agentCoalescedRetryDefaultSecond = 5
)

// parsePanelRetryAfter 解析 429 / 503 响应的 Retry-After（秒数或 HTTP 日期）；别的状态码、没带或解析不了返回 0。
// 上限 5 分钟：一个伪造或写错的头不能让 Agent 长时间不上报。
func parsePanelRetryAfter(statusCode int, header string, now time.Time) time.Duration {
	if statusCode != http.StatusTooManyRequests && statusCode != http.StatusServiceUnavailable {
		return 0
	}
	value := strings.TrimSpace(header)
	if value == "" {
		return 0
	}
	var delay time.Duration
	if seconds, err := strconv.Atoi(value); err == nil {
		delay = time.Duration(seconds) * time.Second
	} else if at, err := http.ParseTime(value); err == nil {
		delay = at.Sub(now)
	}
	if delay <= 0 {
		return 0
	}
	if delay > agentPanelRetryAfterMax {
		delay = agentPanelRetryAfterMax
	}
	return delay
}

// panelRetryAfterDelay 是这次失败该至少等多久：面板给了 Retry-After 就是它再加 0~20% 随机，没给返回 0。
func panelRetryAfterDelay(err error) time.Duration {
	var statusErr agentHTTPStatusError
	if !errors.As(err, &statusErr) || statusErr.RetryAfter <= 0 {
		return 0
	}
	delay := statusErr.RetryAfter
	return delay + time.Duration(rand.Int64N(int64(delay)/5+1))
}

// panelRetryAfterSeconds 是 panelRetryAfterDelay 按秒向上取整（心跳循环按秒排）。
func panelRetryAfterSeconds(err error) int {
	delay := panelRetryAfterDelay(err)
	if delay <= 0 {
		return 0
	}
	return int((delay + time.Second - 1) / time.Second)
}

// coalescedHeartbeatRetrySeconds 是面板回 reconciliationCoalesced 之后多久再发完整心跳。
func coalescedHeartbeatRetrySeconds(serverIntervalSeconds int) int {
	base := serverIntervalSeconds
	if base < 2 {
		base = agentCoalescedRetryDefaultSecond
	}
	if base > agentCoalescedRetryMaxSeconds {
		base = agentCoalescedRetryMaxSeconds
	}
	return base + rand.IntN(base/2+1)
}
