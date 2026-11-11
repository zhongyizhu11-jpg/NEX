package main

// 面板地址切换前先验证（主机独立的 Agent 面板连接地址，面板那头见 server/hostAgentPanelUrl.ts）。
//
// 心跳回包里的 panelUrl 和当前连的不一样时，以前是直接切过去并写进配置 —— 管理员把地址填错一个字，
// 这台 Agent 就再也连不上面板，只能登机器改配置。现在：
//
//  1. 先用本机 Token 对新地址 POST /api/agent/panel-url-probe（照常经 /api/sync 加密）。只有拿到
//     用同一个 Token 加密的成功回包，才说明新地址通、后面确实是认得这个 Token 的面板；
//  2. 通了才切换运行时地址并原子写配置；不通就继续用原来的地址，按退避稍后再试（面板每次心跳都会再给）；
//  3. 切过去之后如果紧接着心跳连续失败，而原来的地址还能通过同样的探测，就切回原地址，
//     并把新地址放进较长的退避 —— 探测那一下通、之后不通（反代只放行了部分路径之类）也不会把 Agent 弄丢。
//
// 只处理普通的地址同步；面板迁移有自己的指令和回退流程（panel_migration.go），不经过这里。

import (
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	panelURLSwitchInitialBackoff = 5 * time.Minute
	panelURLSwitchMaxBackoff     = time.Hour
	// 切换之后这段时间内心跳连续失败这么多次，就看要不要切回去。
	panelURLSwitchWatchWindow    = 10 * time.Minute
	panelURLSwitchRevertFailures = 3
	panelURLSwitchRevertBackoff  = 30 * time.Minute
)

var panelURLProbeClient = func() *http.Client { return agentSyncHTTPClient }

var panelURLSwitchState = struct {
	sync.Mutex
	inFlight   bool
	backoff    map[string]time.Duration
	retryAfter map[string]time.Time
	// 最近一次验证后切换：切换前的地址、切换时间、之后连续失败的次数。
	previous   string
	switchedTo string
	switchedAt time.Time
	failures   int
	reverting  bool
}{backoff: map[string]time.Duration{}, retryAfter: map[string]time.Time{}}

type panelURLProbeResponse struct {
	Success       bool `json:"success"`
	PanelURLProbe bool `json:"panelUrlProbe"`
}

func panelURLSwitchConfig() Config {
	token, _ := runtimeAgentToken.Load().(string)
	return Config{Token: token, PanelURL: currentPanelURL(Config{})}
}

// probePanelURL 用本机 Token 对 target 做一次认证探测。回包必须是验过 MAC 的成功信封。
func probePanelURL(cfg Config, target string) error {
	if strings.TrimSpace(cfg.Token) == "" {
		return fmt.Errorf("agent token unavailable")
	}
	var response panelURLProbeResponse
	if err := postWithClientToPanelURL(panelURLProbeClient(), cfg, target, "/api/agent/panel-url-probe", map[string]any{}, &response); err != nil {
		return err
	}
	if !response.Success || !response.PanelURLProbe {
		return fmt.Errorf("panel URL probe was not acknowledged")
	}
	return nil
}

func notePanelURLSwitchFailure(target string, minimum time.Duration) time.Duration {
	panelURLSwitchState.Lock()
	defer panelURLSwitchState.Unlock()
	next := panelURLSwitchState.backoff[target] * 2
	if next < panelURLSwitchInitialBackoff {
		next = panelURLSwitchInitialBackoff
	}
	if next < minimum {
		next = minimum
	}
	if next > panelURLSwitchMaxBackoff {
		next = panelURLSwitchMaxBackoff
	}
	panelURLSwitchState.backoff[target] = next
	panelURLSwitchState.retryAfter[target] = time.Now().Add(next)
	if len(panelURLSwitchState.retryAfter) > 64 {
		for key, until := range panelURLSwitchState.retryAfter {
			if time.Now().After(until) {
				delete(panelURLSwitchState.retryAfter, key)
				delete(panelURLSwitchState.backoff, key)
			}
		}
	}
	return next
}

// switchPanelURLVerified 同步版本（测试直接调）：验证通过才切换并落盘，返回是否切了。
func switchPanelURLVerified(cfg Config, current, target string) (bool, error) {
	target = normalizePanelURL(target)
	if target == "" || target == current {
		return false, nil
	}
	if err := probePanelURL(cfg, target); err != nil {
		return false, err
	}
	// 探测期间可能被迁移流程或另一轮同步改过当前地址：那就以那边为准，不覆盖。
	if currentPanelURL(Config{}) != current {
		return false, nil
	}
	if err := persistPanelURL(target); err != nil {
		// 落不了盘也先切运行时：探测已经证明新地址可用，重启后会回到旧地址、再验证一次切过来。
		logf("panel URL switched to %s for runtime, persist failed: %v", target, err)
	}
	setRuntimePanelURL(target)
	panelURLSwitchState.Lock()
	delete(panelURLSwitchState.backoff, target)
	delete(panelURLSwitchState.retryAfter, target)
	panelURLSwitchState.previous = current
	panelURLSwitchState.switchedTo = target
	panelURLSwitchState.switchedAt = time.Now()
	panelURLSwitchState.failures = 0
	panelURLSwitchState.Unlock()
	logf("panel URL verified and switched %s -> %s", current, target)
	return true, nil
}

// requestVerifiedPanelURLSwitch 心跳里调：后台验证，不阻塞心跳；同一时间只验一个，失败的地址按退避再试。
func requestVerifiedPanelURLSwitch(current, target string) {
	panelURLSwitchState.Lock()
	if panelURLSwitchState.inFlight || panelURLSwitchState.reverting {
		panelURLSwitchState.Unlock()
		return
	}
	if until, ok := panelURLSwitchState.retryAfter[target]; ok && time.Now().Before(until) {
		panelURLSwitchState.Unlock()
		return
	}
	panelURLSwitchState.inFlight = true
	panelURLSwitchState.Unlock()
	go func() {
		defer func() {
			panelURLSwitchState.Lock()
			panelURLSwitchState.inFlight = false
			panelURLSwitchState.Unlock()
		}()
		switched, err := switchPanelURLVerified(panelURLSwitchConfig(), current, target)
		if err != nil {
			wait := notePanelURLSwitchFailure(target, 0)
			if shouldLogAgentReport("panel-url-switch-failed:"+target, panelURLSwitchInitialBackoff) {
				logf("panel URL %s failed verification, keep using %s (retry in %s): %v", target, current, wait, err)
			}
			return
		}
		if switched {
			wakeHeartbeat()
		}
	}()
}

func recordPanelURLSwitchHeartbeatSuccess() {
	panelURLSwitchState.Lock()
	panelURLSwitchState.failures = 0
	panelURLSwitchState.Unlock()
}

// recordPanelURLSwitchHeartbeatFailure：刚验证切过去的地址，紧接着心跳连续失败，就试着切回原地址。
func recordPanelURLSwitchHeartbeatFailure() {
	panelURLSwitchState.Lock()
	if panelURLSwitchState.switchedTo == "" || panelURLSwitchState.reverting || time.Since(panelURLSwitchState.switchedAt) > panelURLSwitchWatchWindow {
		panelURLSwitchState.Unlock()
		return
	}
	panelURLSwitchState.failures++
	if panelURLSwitchState.failures < panelURLSwitchRevertFailures {
		panelURLSwitchState.Unlock()
		return
	}
	previous, target := panelURLSwitchState.previous, panelURLSwitchState.switchedTo
	panelURLSwitchState.reverting = true
	panelURLSwitchState.Unlock()
	go func() {
		revertPanelURLSwitch(panelURLSwitchConfig(), previous, target)
	}()
}

// revertPanelURLSwitch 原地址还能通过探测才切回去；都不通就别动（可能只是面板这会儿整体不可用）。
func revertPanelURLSwitch(cfg Config, previous, target string) bool {
	defer func() {
		panelURLSwitchState.Lock()
		panelURLSwitchState.reverting = false
		panelURLSwitchState.failures = 0
		panelURLSwitchState.Unlock()
	}()
	if currentPanelURL(Config{}) != target || previous == "" {
		return false
	}
	if err := probePanelURL(cfg, previous); err != nil {
		return false
	}
	if currentPanelURL(Config{}) != target {
		return false
	}
	if err := persistPanelURL(previous); err != nil {
		logf("panel URL reverted to %s for runtime, persist failed: %v", previous, err)
	}
	setRuntimePanelURL(previous)
	notePanelURLSwitchFailure(target, panelURLSwitchRevertBackoff)
	panelURLSwitchState.Lock()
	panelURLSwitchState.switchedTo = ""
	panelURLSwitchState.previous = ""
	panelURLSwitchState.Unlock()
	logf("panel URL %s kept failing after the switch; reverted to %s", target, previous)
	wakeHeartbeat()
	return true
}
