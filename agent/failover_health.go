package main

import (
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

func (p *failoverProxy) healthInterval() time.Duration {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return failoverHealthInterval(p.spec.FailoverSeconds)
}

func (p *failoverProxy) healthLoop() {
	timer := time.NewTimer(p.healthInterval())
	defer timer.Stop()
	for {
		select {
		case <-p.done:
			return
		case <-timer.C:
			p.checkHealthShared()
			// 面板改了「异常多久切」（热更新，代理不重建）：下一轮就按新的间隔
			timer.Reset(p.healthInterval())
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
	p.mu.RUnlock()
	if len(targets) == 0 {
		return
	}
	// 各条路径并行探测：客户端在所有路径都拨不通时会同步等这一轮（checkHealthShared），
	// 串行时 N 条路径就要等 N×2 秒。
	latencies, results := probeFailoverTargets(protocol, targets)
	p.mu.Lock()
	defer p.mu.Unlock()
	if failoverSignature(p.spec) != specSignature {
		return
	}
	p.ensureHealthStateLocked()
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
		target := p.spec.Targets[i]
		if ok {
			p.failureSince[i] = time.Time{}
			if !p.targetHealth[i] {
				if p.recoveredSince[i].IsZero() {
					p.recoveredSince[i] = now
				} else if now.Sub(p.recoveredSince[i]) >= time.Duration(recoverSeconds)*time.Second {
					p.targetHealth[i] = true
					p.recoveredSince[i] = time.Time{}
					p.markSlowStartLocked(i, now)
					logf("failover target recovered rule=%d source=%d index=%d target=%s:%d", p.ruleID, p.sourcePort, i, target.TargetIP, target.TargetPort)
					p.recordTargetEventLocked(i, "recovered", "health check")
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
			// 两道门槛都要过：连续失败够 FailureThreshold 次，而且持续异常够 FailoverSeconds 秒。
			// 只按次数，一次探测超时 + 一次拨号失败就切；只按时间，老规格（阈值 1）的行为不变。
			if p.statsLocked(i).consecutiveFailures >= failureThreshold && now.Sub(p.failureSince[i]) >= time.Duration(failoverSeconds)*time.Second {
				p.targetHealth[i] = false
				p.failureSince[i] = time.Time{}
				logf("failover target unhealthy rule=%d source=%d index=%d target=%s:%d reason=health check", p.ruleID, p.sourcePort, i, target.TargetIP, target.TargetPort)
				p.recordTargetEventLocked(i, "unhealthy", "health check")
			}
		}
	}
	p.updateFallbackActiveLocked("health check")
}
