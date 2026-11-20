package main

import (
	mathrand "math/rand"
	"time"
)

/*
探测间隔跟着「异常多久切」走（2.2.244 起）：它的一半，夹在 1–5 秒。设 3 秒就 1.5 秒探一轮，几秒内真能切走；
默认 60 秒的老规格照旧 5 秒一轮。下一轮从这一轮探完开始算，探得慢（超时）的时候不会叠起来。
*/
func failoverHealthInterval(failoverSeconds int) time.Duration {
	interval := time.Duration(failoverSeconds) * time.Second / 2
	if interval < time.Second {
		interval = time.Second
	}
	if interval > 5*time.Second {
		interval = 5 * time.Second
	}
	return interval
}

// jitterDuration 给一个间隔加 ±10% 的随机抖动。
func jitterDuration(interval time.Duration) time.Duration {
	if interval <= 0 {
		return interval
	}
	return time.Duration(float64(interval) * (0.9 + 0.2*mathrand.Float64()))
}

/*
固定节拍（规格带 ProbeIntervalSeconds，出口组）的两个数：

  - 「持续够久」那道门槛按 fixedTickGatePercent% 算。面板把它算成「间隔 × (次数 − 1)」，而每轮间隔有 ±10% 的抖动 ——
    不留余量的话，抖到 0.9 倍的那一半时候「2 秒一轮、2 次判坏」差 0.2 秒不够数，要多等一整轮。
  - 一轮探得再慢（黑洞的出口要等满超时），到下一轮也至少歇间隔的 1/fixedTickMinRestDivisor。
*/
const (
	fixedTickGatePercent    = 85
	fixedTickMinRestDivisor = 4
)

func (p *failoverProxy) healthInterval() time.Duration {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if p.spec.ProbeIntervalSeconds > 0 {
		return time.Duration(p.spec.ProbeIntervalSeconds) * time.Second
	}
	return failoverHealthInterval(p.spec.FailoverSeconds)
}

/*
nextHealthDelay 这一轮探完以后隔多久探下一轮。started 是这一轮开始的时刻。

老规矩（规格没带 ProbeIntervalSeconds）：从探完开始算一个间隔。出口组带了探测节奏，按固定节拍：间隔从这一轮
**开始**算，探得慢（黑洞的出口要等满超时）不会把下一轮往后推 —— 不然「2 秒一轮、2 次判坏」实际是
2 + 超时 + 2 + 超时。再慢也至少歇四分之一个间隔。
*/
func (p *failoverProxy) nextHealthDelay(started time.Time) time.Duration {
	interval := jitterDuration(p.healthInterval())
	p.mu.RLock()
	fixedTick := p.spec.ProbeIntervalSeconds > 0
	p.mu.RUnlock()
	if !fixedTick {
		return interval
	}
	delay := interval - time.Since(started)
	if floor := interval / fixedTickMinRestDivisor; delay < floor {
		delay = floor
	}
	return delay
}

func (p *failoverProxy) healthLoop() {
	// 间隔带 ±10% 的抖动（A13）：一台机器上几十条规则同一刻起来，不抖的话每一轮都在同一毫秒一起探。
	timer := time.NewTimer(jitterDuration(p.healthInterval()))
	defer timer.Stop()
	for {
		select {
		case <-p.done:
			return
		case <-timer.C:
			started := time.Now()
			p.checkHealthShared()
			// 面板改了「异常多久切」（热更新，代理不重建）：下一轮就按新的间隔
			timer.Reset(p.nextHealthDelay(started))
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
	probeTimeout := p.probeTimeoutLocked()
	// 带探测节奏的规格（固定节拍）：「持续够久」那道门槛留余量（fixedTickGatePercent；真实 gost 上实测不留的话
	// 进程死掉 6 秒、黑洞 7 秒才摘，本来该是 4、5 秒）。次数那道门槛照旧。
	fixedTick := p.spec.ProbeIntervalSeconds > 0
	gateReached := func(elapsed time.Duration, seconds int) bool {
		gate := time.Duration(seconds) * time.Second
		if fixedTick {
			gate = gate * fixedTickGatePercent / 100
		}
		return elapsed >= gate
	}
	// 出口组：直接探出口机，经出口复核判坏过的还要经出口探通（failover_exit_group.go）。
	exitGroup := p.exitGroupLocked()
	p.mu.RUnlock()
	if len(targets) == 0 {
		return
	}
	// 各条路径并行探测：客户端在所有路径都拨不通时会同步等这一轮（checkHealthShared），
	// 串行时 N 条路径就要等 N×2 秒。TCP+UDP 规格的 UDP 那一侧同时探（route_group_udp_health.go）。
	var udpLatencies []int
	var udpVerdicts []udpProbeVerdict
	udpDone := make(chan struct{})
	if protocol == "both" && !exitGroup {
		go func() {
			defer close(udpDone)
			udpLatencies, udpVerdicts = probeFailoverTargetsUDP(targets)
		}()
	} else {
		close(udpDone)
	}
	var latencies []int
	var results []bool
	if exitGroup {
		latencies, results = probeExitGroupTargets(protocol, targets, probeTimeout)
	} else {
		latencies, results = probeFailoverTargetsWithin(protocol, targets, probeTimeout)
	}
	<-udpDone
	p.mu.Lock()
	defer p.mu.Unlock()
	if failoverSignature(p.spec) != specSignature {
		return
	}
	p.ensureHealthStateLocked()
	if exitGroup {
		p.gateExitThroughLocked(results)
	}
	if udpVerdicts != nil {
		udpResults, udpLatencyMs := mergeUDPSide(results, latencies, udpVerdicts, udpLatencies)
		p.applyUDPProbeLocked(udpResults, udpLatencyMs, now)
	}
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
		if ok {
			p.failureSince[i] = time.Time{}
			if !p.targetHealth[i] {
				if p.recoveredSince[i].IsZero() {
					p.recoveredSince[i] = now
				} else if gateReached(now.Sub(p.recoveredSince[i]), recoverSeconds) && p.exitThroughRecoveredLocked(i) {
					p.readmitLocked(i, now)
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
			// 两道门槛都要过：探测连续失败够 FailureThreshold 次，而且持续异常够 FailoverSeconds 秒。
			// 只看探测这本账（A2）：真实连接拨通了不清它 —— 拨得通第一跳不等于探测目标还活着。
			if p.statsLocked(i).probeFailures >= failureThreshold && gateReached(now.Sub(p.failureSince[i]), failoverSeconds) {
				p.markUnhealthyLocked(i, "health check", "")
			}
		}
	}
	p.updateFallbackActiveLocked("health check")
}

/*
readmitLocked 把判坏的路径放回（TCP 那一侧 / 不分侧的主健康）：两处放回都走这里 —— 探测（checkHealth）和出口组
经出口探通够次数（recheckExitThrough）。重新选路由调用方做。调用方持有 p.mu、下标有效。
*/
func (p *failoverProxy) readmitLocked(i int, now time.Time) {
	p.readmitForLocked(i, now, "health check")
}

// readmitForLocked：readmitLocked 带原因（日志和事件里写的那个）。
func (p *failoverProxy) readmitForLocked(i int, now time.Time, reason string) {
	target := p.spec.Targets[i]
	p.targetHealth[i] = true
	p.recoveredSince[i] = time.Time{}
	if i < len(p.exitThroughFailed) {
		p.exitThroughFailed[i], p.exitThroughOKs[i] = false, 0
	}
	if !p.spec.NoSlowStart {
		p.markSlowStartLocked(i, now)
	}
	// 恢复了：拨号那本账也从头来，不然恢复前攒的失败会让它再拨坏一次就又被判坏。
	p.statsLocked(i).dialFailures = 0
	logf("failover target recovered rule=%d source=%d index=%d target=%s:%d reason=%s", p.ruleID, p.sourcePort, i, target.TargetIP, target.TargetPort, reason)
	p.recordTargetEventLocked(i, "recovered", reason)
}

// probeTimeoutLocked 一次直接探测的超时：规格给了 ProbeTimeoutMs 就用它。调用方持有 p.mu（读锁就行）。
func (p *failoverProxy) probeTimeoutLocked() time.Duration {
	if p.spec.ProbeTimeoutMs > 0 {
		return time.Duration(p.spec.ProbeTimeoutMs) * time.Millisecond
	}
	return failoverProbeDefaultTimeout
}

// recoverGateReachedLocked 「连着通了 elapsed」够不够 RecoverSeconds（固定节拍的规格留 fixedTickGatePercent 的余量，
// 和 checkHealth 里那道门槛一样）。调用方持有 p.mu。
func (p *failoverProxy) recoverGateReachedLocked(elapsed time.Duration) bool {
	gate := time.Duration(p.spec.RecoverSeconds) * time.Second
	if p.spec.ProbeIntervalSeconds > 0 {
		gate = gate * fixedTickGatePercent / 100
	}
	return elapsed >= gate
}

/*
markUnhealthyLocked 把这条路径判坏（TCP 那一侧 / 不分侧的主健康）：记日志和事件，按切换方式关它上面的连接、
UDP 会话（onTargetDownLocked）。四个地方判坏都走这里：探测（checkHealth）、真实拨号连着失败（markDialFailure）、
「回之前就关」（markEarlyClose）、出口组经出口复核（confirmExitEarlyClose）。detail 接在日志的原因后面（可以空）。
重新选路（updateFallbackActiveLocked）由调用方做：探测一轮判坏几条只选一次。调用方持有 p.mu、下标有效。
*/
func (p *failoverProxy) markUnhealthyLocked(index int, reason string, detail string) {
	target := p.spec.Targets[index]
	p.targetHealth[index] = false
	p.failureSince[index] = time.Time{}
	p.recoveredSince[index] = time.Time{}
	logf("failover target unhealthy rule=%d source=%d index=%d target=%s:%d reason=%s%s", p.ruleID, p.sourcePort, index, target.TargetIP, target.TargetPort, reason, detail)
	p.recordTargetEventLocked(index, "unhealthy", reason)
	p.onTargetDownLocked(index, true, false)
}
