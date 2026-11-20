package main

import (
	"net"
	"time"

	"github.com/zhongyizhu11-jpg/NEX/lbcore"
)

/*
新连接 / 新 UDP 会话走哪条路径：三段。

 1. 候选（failover_pick_candidates.go）：能用的路径 —— TCP 看 TCP 健康，TCP+UDP 规格的 UDP 会话看 UDP 那一侧；
    去掉这条连接拨失败过的（exclude）；分层规格只留还有能用路径的最优一层。一条能用的都没有时退回
    「不健康但没被暂停 / 维护 / 停机」的那些（照样去掉 exclude、不分层），让连接去碰碰运气，而不是直接拒绝；
    连这样的都没有才拒绝。
 2. 按策略挑（failover_pick_strategies.go）：主备（fallback：在走的那条能用就走它，不能用就换，换的时候平手
    优先同出口 IP）以外的七种都在候选里「分」，交给 lbcore（spreadPickLocked）。认不出的策略按主备。
 3. 只有主备有：挑出来的那条所在线路选了「一起分」时，在这条线路的几个落地之间按它的分法再分
    （spreadWithinLineLocked，route_group_line_spread.go）。按权重这些本来就在整组里分，没有这一段。

整个过程拿着 p.mu；随机数、轮转计数、按权重的计数都在第 2、3 段里推进。udp 一路显式传下去：慢启动、
健康都按它看哪一侧（A11）。
*/

func (p *failoverProxy) pickTarget(client net.Conn, exclude map[int]bool) (failoverTarget, int) {
	return p.pickTargetForKey(failoverRemoteIP(client), exclude)
}

// 挑一条路径。hashKey 只有「按访客固定」用：TCP 是访客 IP（带 PROXY 头时从头里读），
// UDP 是会话的来源地址。
func (p *failoverProxy) pickTargetForKey(hashKey string, exclude map[int]bool) (failoverTarget, int) {
	return p.pickTargetForKeyProto(hashKey, exclude, false)
}

// udp 为 true 是给 UDP 会话挑：TCP+UDP 规格下只在 UDP 通的路径里挑（route_group_udp_health.go），
// 别的规格和 TCP 完全一样。
func (p *failoverProxy) pickTargetForKeyProto(hashKey string, exclude map[int]bool, udp bool) (failoverTarget, int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.pickLocked(hashKey, exclude, udp)
}

// pickLocked：三段挑选本身。调用方持有 p.mu。
func (p *failoverProxy) pickLocked(hashKey string, exclude map[int]bool, udp bool) (failoverTarget, int) {
	p.ensureHealthStateLocked()
	if len(p.spec.Targets) == 0 {
		return failoverTarget{}, -1
	}
	candidates := p.pickCandidatesLocked(exclude, udp)
	if len(candidates) == 0 {
		return failoverTarget{}, -1
	}
	// 出口组的手动指定：指定的那台能用就只走它，所有分法都一样（failover_exit_group.go）。
	if pinned := p.exitPinPickLocked(candidates, udp); pinned >= 0 {
		return p.spec.Targets[pinned], pinned
	}
	var index int
	if strategy := p.spec.Strategy; strategy != lbcore.StrategyFallback && lbcore.ValidStrategy(strategy) {
		index = p.spreadPickForLocked(strategy, candidates, hashKey, udp, len(exclude) > 0)
	} else {
		index = p.spreadWithinLineLocked(p.fallbackPickLocked(candidates, exclude, udp), hashKey, exclude, udp)
	}
	return p.spec.Targets[index], index
}

/*
pickReserved 挑一条路径并当场记一笔「在途」（A8）。

「按负载」「自动」看的是每条路径上挂着多少连接，而连接是拨通以后才记到路径名下的（trackConn）。一下子进来
50 条连接时，它们挑路径的那一刻谁都还没拨通，看到的连接数全是旧的 —— 50 条全压到同一条上。所以挑中就先
算一笔在途，拨通后转成连接（trackConnReserved），拨失败、竞速输了就退掉（releaseReservation）。

只给真要去拨的调用方用；pickTarget / pickTargetForKey 不记在途（测试、探查用，没有人替它们退）。
*/
func (p *failoverProxy) pickReserved(hashKey string, exclude map[int]bool, udp bool) (failoverTarget, int, failoverReservation) {
	// 挑和记在同一把锁里：分两次拿锁的话，同时到的另一条连接可以插在中间，看不见这一笔在途。
	p.mu.Lock()
	defer p.mu.Unlock()
	// 出口组：经出口判坏过的出口到点了，这条真实 TCP 连接先试它（failover_exit_group.go 的 exitCanaryIndexLocked）。
	// 只在新连接的第一次挑（exclude 空）；换路重拨不试。
	if !udp && len(exclude) == 0 {
		if canary := p.exitCanaryIndexLocked(time.Now()); canary >= 0 {
			return p.spec.Targets[canary], canary, p.reserveLocked(canary)
		}
	}
	target, index := p.pickLocked(hashKey, exclude, udp)
	if index < 0 {
		return target, index, failoverReservation{}
	}
	return target, index, p.reserveLocked(index)
}
