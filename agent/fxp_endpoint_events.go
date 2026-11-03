package main

import (
	"fmt"
	"regexp"
	"strings"
	"time"
)

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
