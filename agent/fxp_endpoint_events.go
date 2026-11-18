package main

import (
	"fmt"
	"regexp"
	"strings"
	"time"
)

/*
FXP 出口状态变化的日志行。现行格式（forwardx-fxp/endpoint_pool.go）：

	exit endpoint unhealthy endpoint=%s retryIn=%s reason=%v
	exit endpoint recovered endpoint=%s

老版本 FXP 在 endpoint= 前面还有一个 index=N，没有 retryIn。两种都认（A14）：以前这里写死了要 index=N，
FXP 去掉这个字段以后一行都匹配不上，出口事件一直是空的，面板上看不到「哪台出口什么时候断过」。
FXP 改这两行日志时要同步改这里和 testdata/fxp_endpoint_log_sample.txt（测试拿那份样本对）。
*/
var fxpEndpointLogPattern = regexp.MustCompile(`exit endpoint (unhealthy|recovered)(?: index=[0-9]+)? endpoint=([^[:space:]]+)(?: retryIn=[^[:space:]]+)?(?: reason=(.*))?`)

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
