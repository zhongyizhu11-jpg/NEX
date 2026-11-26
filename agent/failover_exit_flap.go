package main

import (
	"time"

	"github.com/zhongyizhu11-jpg/NEX/lbcore"
)

/*
出口组「出口到目标来回断」的防抖（2.2.272 起，GOST 出口组；NEX 出口组在 FXP 里有自己的一份，forwardx-fxp/target_health.go）。

用户面板实测（2026-11-26）：高防目标时不时拦掉两台出口，jinx(39.9y) 对「广港hkt/2」09:24 断、09:53 恢复、09:55 又断，
hep ix 09:55:56 恢复、09:56:47 又断。每次「恢复」都是一份探测 / 一条真实连接说通了，这台马上放回；指定的就是它时，
这条规则的流量一下子全回到它身上，两三分钟后再断一次 —— 客户端看到的就是时不时超时。

现在每台出口记最近一小时的中断（好 → 坏，exitOutages）。中断到了 exitFlapPolicy 的门槛，它下一次恢复后先「观察」
一段（exitProbationLocked）：
  - 指定的就是它：观察期里不吃指定，照常按分法走别的出口（exitPinPickLocked）；
  - 挑候选时，还有别的能用的出口就先不分给它（pickCandidatesLocked）；都不能用了才用它，不至于没路可走；
  - 上报里它是「备用」，不是「在用」。

观察期从恢复那一刻算，长短按一小时里断了几次：第 2 次起 2 分钟，每多一次翻倍，最长 10 分钟。门槛比 FXP 的
（4 次、固定 5 分钟）低：GOST 出口组还在用「真实连接试探」放回（failover_exit_group.go），放回得快，就得压得早。
上限不再往上加：压太久等于把一台好出口长期排除在外。

只记「这台出口能不能用」的中断：探测、真实拨号、经出口复核判的坏，和面板的「连不上目标」提示。管理上排除
（暂停 / 维护 / 流量停机）和演练不算。只管出口组（规格带 BalanceReport）。
*/
var exitFlapPolicy = lbcore.FlapPolicy{Window: time.Hour, Threshold: 2, Base: 2 * time.Minute, Max: 10 * time.Minute}

func (p *failoverProxy) exitFlapDamperLocked(i int) lbcore.FlapDamper {
	var events []time.Time
	if i < len(p.exitOutages) {
		events = p.exitOutages[i]
	}
	return lbcore.FlapDamper{Policy: exitFlapPolicy, Events: events}
}

// noteExitOutageLocked 第 i 台出口刚从能用变成不能用：记一次中断。不是出口组不记。调用方持有 p.mu。
func (p *failoverProxy) noteExitOutageLocked(i int, now time.Time) {
	if !p.exitGroupLocked() || i < 0 || i >= len(p.exitOutages) {
		return
	}
	damper := p.exitFlapDamperLocked(i)
	damper.Note(now)
	p.exitOutages[i] = damper.Events
	// 又断了：上一段观察作废，下一次恢复重新算
	p.exitRecoveredAt[i] = time.Time{}
}

// noteExitRecoveredLocked 第 i 台出口刚放回（探测、经出口、真实连接试探、面板提示撤掉）：观察期从这一刻算。调用方持有 p.mu。
func (p *failoverProxy) noteExitRecoveredLocked(i int, now time.Time) {
	if !p.exitGroupLocked() || i < 0 || i >= len(p.exitRecoveredAt) {
		return
	}
	p.exitRecoveredAt[i] = now
	if hold := p.exitProbationLeftLocked(i, now); hold > 0 {
		logf("failover exit flapping rule=%d source=%d index=%d target=%s outages=%d probation=%s", p.ruleID, p.sourcePort, i, failoverTargetLabel(p.spec.Targets[i]), len(p.exitOutages[i]), hold.Round(time.Second))
	}
}

// exitProbationLeftLocked 第 i 台出口的观察期还剩多久；不在观察期是 0。调用方持有 p.mu（读锁就行）。
func (p *failoverProxy) exitProbationLeftLocked(i int, now time.Time) time.Duration {
	if i < 0 || i >= len(p.exitRecoveredAt) || p.exitRecoveredAt[i].IsZero() {
		return 0
	}
	damper := p.exitFlapDamperLocked(i)
	hold := damper.Hold(now)
	if left := hold - now.Sub(p.exitRecoveredAt[i]); left > 0 {
		return left
	}
	return 0
}

// exitProbationLocked 第 i 台出口此刻是不是在「刚恢复、先观察」。调用方持有 p.mu（读锁就行）。
func (p *failoverProxy) exitProbationLocked(i int, now time.Time) bool {
	return p.exitProbationLeftLocked(i, now) > 0
}

// exitProbationSetLocked 此刻在观察期的出口（下标 → true）；一台都没有返回 nil。调用方持有 p.mu。
func (p *failoverProxy) exitProbationSetLocked(now time.Time) []bool {
	if !p.exitGroupLocked() {
		return nil
	}
	var set []bool
	for i := range p.spec.Targets {
		if p.exitProbationLocked(i, now) {
			if set == nil {
				set = make([]bool, len(p.spec.Targets))
			}
			set[i] = true
		}
	}
	return set
}
