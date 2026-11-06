package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

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
		retryAfter := parsePanelRetryAfter(res.StatusCode, res.Header.Get("Retry-After"), time.Now())
		if decryptErr != nil {
			return wrapAgentRequestAttemptError(
				agentHTTPStatusError{StatusCode: res.StatusCode, Status: res.Status, Detail: decryptErr.Error(), RetryAfter: retryAfter},
				auth, authResult, responseAuthenticated,
			)
		}
		return wrapAgentRequestAttemptError(
			agentHTTPStatusError{StatusCode: res.StatusCode, Status: res.Status, Detail: formatPanelErrorBody(decodedBody), RetryAfter: retryAfter},
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
