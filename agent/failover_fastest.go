package main

import (
	"time"

	"github.com/zhongyizhu11-jpg/NEX/lbcore"
)

/*
延迟优先「只走最快的一台」（规格的 FastestOnly；面板「检测与切换」高级里的开关，GOST 出口组下发）。

不在「一样快」的几台里分：新连接、新 UDP 会话只给一台 —— 整链延迟（入口到出口的探测平均 + 面板给的出口到目标，
qualityLocked(peak=false)，和延迟优先圈「一样快」用的是同一个数）最低的那台，别的候补。算法和 NEX 隧道的出口选择器
是同一份（lbcore.Fastest，lbcore/fastest.go）：

  - 另一台要快出 LatencyMarginMs 而且快两成、并且连着领先 60 秒，才换过去；
  - 在用的那台连不上了（不在候选里）：当场换到次快的，不等；
  - 手动指定照旧压过它（pickLocked 先处理手动指定）；
  - 一条连接拨在用的那台失败、带着排除重挑时只给这条连接换，不挪「在用的」（spreadPickForLocked 的 transient）。

「连着领先 60 秒」要有钟：新连接挑的时候算一次，每轮探测之后（updateFallbackActiveAtLocked）、每秒的负载均衡上报
（balanceSnapshot）也各算一次，没有新连接时也会按时换过去，面板上「在用」的那台和下一条连接真会走的一致。
*/

// fastestOnlyLocked：这个代理是不是「延迟优先 · 只走最快的一台」。
func (p *failoverProxy) fastestOnlyLocked() bool {
	return p.spec.FastestOnly && p.spec.Strategy == lbcore.StrategyLatency && len(p.spec.Targets) > 0
}

func (p *failoverProxy) fastestPolicyLocked() lbcore.FastestPolicy {
	return lbcore.FastestPolicy{Margin: p.latencyMarginLocked()}
}

/*
evaluateFastestLocked 按此刻的健康和延迟重新看一遍「在用的」该是谁（会换就换），返回它；没有能挑的返回 -1。
候选和新连接的一样（pickCandidatesLocked：能用的，分层规格只留最优一层；全都不能用时在没被排除的里挑）。
调用方持有 p.mu（写锁）。
*/
func (p *failoverProxy) evaluateFastestLocked(now time.Time, reason string) int {
	if !p.fastestOnlyLocked() {
		return -1
	}
	p.ensureHealthStateLocked()
	candidates := p.pickCandidatesLocked(nil, false)
	if len(candidates) == 0 {
		return -1
	}
	members := p.membersLocked(candidates, lbcore.StrategyLatency, now, false, p.pathLoadLocked)
	before, _ := p.lbFastest.Current()
	index := p.lbFastest.Select(members, candidates, p.fastestPolicyLocked(), now, true)
	p.noteFastestSwitchLocked(before, reason)
	return index
}

// noteFastestSwitchLocked：在用的换了就记一行日志（面板「最近切换」由负载均衡上报的状态变化生成，不另报）。
func (p *failoverProxy) noteFastestSwitchLocked(before int, reason string) {
	after, ok := p.lbFastest.Current()
	if !ok || after == before || after < 0 || after >= len(p.spec.Targets) {
		return
	}
	if before < 0 || before >= len(p.spec.Targets) {
		logVerbosef("failover fastest-only start rule=%d source=%d index=%d target=%s reason=%s", p.ruleID, p.sourcePort, after, failoverTargetLabel(p.spec.Targets[after]), reason)
		return
	}
	logf("failover fastest-only switch rule=%d source=%d from=%d(%s) to=%d(%s) reason=%s", p.ruleID, p.sourcePort,
		before, failoverTargetLabel(p.spec.Targets[before]), after, failoverTargetLabel(p.spec.Targets[after]), reason)
}
