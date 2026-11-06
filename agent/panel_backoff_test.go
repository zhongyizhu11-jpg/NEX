package main

import (
	"fmt"
	"net/http"
	"testing"
	"time"
)

func TestParsePanelRetryAfter(t *testing.T) {
	now := time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		status int
		header string
		want   time.Duration
	}{
		{http.StatusServiceUnavailable, "30", 30 * time.Second},
		{http.StatusTooManyRequests, " 12 ", 12 * time.Second},
		{http.StatusServiceUnavailable, now.Add(45 * time.Second).Format(http.TimeFormat), 45 * time.Second},
		{http.StatusServiceUnavailable, "3600", agentPanelRetryAfterMax},
		{http.StatusServiceUnavailable, "0", 0},
		{http.StatusServiceUnavailable, "-5", 0},
		{http.StatusServiceUnavailable, "soon", 0},
		{http.StatusServiceUnavailable, "", 0},
		// 别的状态码上的 Retry-After 不算（比如 500、401）
		{http.StatusInternalServerError, "30", 0},
		{http.StatusUnauthorized, "30", 0},
	}
	for _, tc := range cases {
		if got := parsePanelRetryAfter(tc.status, tc.header, now); got != tc.want {
			t.Fatalf("parsePanelRetryAfter(%d, %q) = %s, want %s", tc.status, tc.header, got, tc.want)
		}
	}
}

func TestPanelRetryAfterDelayHonoursWrappedStatusError(t *testing.T) {
	statusErr := agentHTTPStatusError{StatusCode: http.StatusServiceUnavailable, Status: "503 Service Unavailable", RetryAfter: 30 * time.Second}
	wrapped := wrapAgentRequestAttemptError(fmt.Errorf("heartbeat: %w", statusErr), agentRequestAuth{}, "accepted", true)
	for i := 0; i < 200; i++ {
		delay := panelRetryAfterDelay(wrapped)
		if delay < 30*time.Second || delay > 36*time.Second {
			t.Fatalf("delay = %s, want within [30s, 36s]", delay)
		}
		if seconds := panelRetryAfterSeconds(wrapped); seconds < 30 || seconds > 36 {
			t.Fatalf("seconds = %d, want within [30, 36]", seconds)
		}
	}
	if delay := panelRetryAfterDelay(fmt.Errorf("network down")); delay != 0 {
		t.Fatalf("plain error delay = %s, want 0", delay)
	}
	if seconds := panelRetryAfterSeconds(agentHTTPStatusError{StatusCode: http.StatusServiceUnavailable}); seconds != 0 {
		t.Fatalf("503 without Retry-After = %d, want 0", seconds)
	}
}

func TestCoalescedHeartbeatRetrySecondsIsJitteredAroundPanelHint(t *testing.T) {
	seen := map[int]bool{}
	for i := 0; i < 500; i++ {
		// 旧面板固定给 5：结果落在 5~7 秒，不再全部同一拍
		got := coalescedHeartbeatRetrySeconds(5)
		if got < 5 || got > 7 {
			t.Fatalf("coalescedHeartbeatRetrySeconds(5) = %d, want within [5, 7]", got)
		}
		seen[got] = true
	}
	if len(seen) < 2 {
		t.Fatalf("expected jitter, got only %v", seen)
	}
	if got := coalescedHeartbeatRetrySeconds(0); got < 5 || got > 7 {
		t.Fatalf("missing hint should fall back to 5s, got %d", got)
	}
	if got := coalescedHeartbeatRetrySeconds(600); got < 30 || got > 45 {
		t.Fatalf("hint must be capped at 30s (+50%%), got %d", got)
	}
}
