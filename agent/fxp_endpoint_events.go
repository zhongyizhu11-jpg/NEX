package main

import (
	"fmt"
	"regexp"
	"strings"
	"time"
)

/*
FXP 出口状态变化的日志行。现行格式（forwardx-fxp/endpoint_pool.go）：

	exit endpoint unhealthy index=%d endpoint=%s retryIn=%s reason=%v
	exit endpoint recovered index=%d endpoint=%s
	exit endpoint udp unreachable index=%d endpoint=%s reason=%v
	exit endpoint udp recovered index=%d endpoint=%s

前两行是出口本身（TCP 那一侧）断了 / 好了；后两行是 UDP 那一侧（出口的 TCP 通、UDP ping 不回）。以前只认前两行，
UDP 那一侧的中断从来不进面板的出口事件。UDP 的两行照样报成 unhealthy / recovered（面板只认这两个词），
另带 Side="udp"、消息前面加「udp:」，和 TCP 那一侧分开记（各有各的开始时刻，互不覆盖）。

老版本 FXP 在 endpoint= 前面还有一个 index=N，没有 retryIn。两种都认（A14）：以前这里写死了要 index=N，
FXP 去掉这个字段以后一行都匹配不上，出口事件一直是空的，面板上看不到「哪台出口什么时候断过」。
FXP 改这几行日志时要同步改这里和 testdata/fxp_endpoint_log_sample.txt（测试拿那份样本对）。
*/
var fxpEndpointLogPattern = regexp.MustCompile(`exit endpoint (?:(udp) (unreachable|recovered)|(unhealthy|recovered))(?: index=[0-9]+)? endpoint=([^[:space:]]+)(?: retryIn=[^[:space:]]+)?(?: reason=(.*))?`)

// fxpEndpointSideUDP：UDP 那一侧的事件（fxpEndpointEvent.Side）。TCP 那一侧不带 Side。
const fxpEndpointSideUDP = "udp"

type fxpEndpointEvent struct {
	TunnelID int    `json:"tunnelId"`
	RuleID   int    `json:"ruleId,omitempty"`
	Role     string `json:"role"`
	Endpoint string `json:"endpoint"`
	Status   string `json:"status"`
	// Side：空 = 出口本身（TCP 那一侧）；"udp" = UDP 那一侧。
	Side       string `json:"side,omitempty"`
	Message    string `json:"message,omitempty"`
	StartedAt  int64  `json:"startedAt,omitempty"`
	OccurredAt int64  `json:"occurredAt"`
}

func recordFXPEndpointLog(spec fxpSpec, message string) {
	for _, line := range strings.Split(message, "\n") {
		match := fxpEndpointLogPattern.FindStringSubmatch(strings.TrimSpace(line))
		if match == nil {
			continue
		}
		side, status := "", match[3]
		if match[1] != "" {
			side, status = fxpEndpointSideUDP, "recovered"
			if match[2] == "unreachable" {
				status = "unhealthy"
			}
		}
		endpoint := strings.TrimSpace(match[4])
		key := fmt.Sprintf("%s:%d:%d:%s", spec.Role, spec.TunnelID, spec.RuleID, endpoint)
		if side != "" {
			key += "#" + side
		}
		now := time.Now().UnixMilli()
		fxpEndpointEventMu.Lock()
		previous := fxpEndpointEvents[key]
		startedAt := previous.StartedAt
		if status == "unhealthy" && (previous.Status != "unhealthy" || startedAt <= 0) {
			startedAt = now
		}
		eventMessage := compactLogOutput(match[5])
		if side != "" {
			// 面板的日志行只写 status 和 message：不加这个前缀就看不出是 UDP 那一侧。
			eventMessage = strings.TrimSuffix(side+": "+eventMessage, ": ")
		}
		fxpEndpointEvents[key] = fxpEndpointEvent{
			TunnelID: spec.TunnelID, RuleID: spec.RuleID, Role: spec.Role, Endpoint: endpoint,
			Status: status, Side: side, Message: eventMessage, StartedAt: startedAt, OccurredAt: now,
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
