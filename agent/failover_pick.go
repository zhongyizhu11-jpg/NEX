package main

import "net"

/*
新连接 / 新 UDP 会话走哪条路径：三段。

 1. 候选（failover_pick_candidates.go）：能用的路径 —— TCP 看 TCP 健康，TCP+UDP 规格的 UDP 会话看 UDP 那一侧；
    去掉这条连接拨失败过的（exclude）；分层规格只留还有能用路径的最优一层。一条能用的都没有时退回全部
    （照样去掉 exclude、不分层），让连接去碰碰运气，而不是直接拒绝。
 2. 按策略挑（failover_pick_strategies.go）：每种「新连接怎么分」一个函数 —— 按权重、按负载、自动、轮流、
    随机、按访客固定，以及主备（fallback：在走的那条能用就走它，不能用就换，换的时候平手优先同出口 IP）。
    认不出的策略按主备。
 3. 收尾（failover_pick_refine.go）：只有主备有 —— 挑出来的那条所在线路选了「一起分」时，在这条线路的几个
    落地之间再分（route_group_line_spread.go，有落地用不了时平手优先同出口 IP）。

整个过程拿着 p.mu；随机数、轮转计数、按权重的计数都在第 2、3 段里按原来的顺序推进。
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
	p.ensureHealthStateLocked()
	if len(p.spec.Targets) == 0 {
		return failoverTarget{}, -1
	}
	candidates := p.pickCandidatesLocked(exclude, udp)
	if len(candidates) == 0 {
		return failoverTarget{}, -1
	}
	request := failoverPickRequest{candidates: candidates, hashKey: hashKey, exclude: exclude, udp: udp}
	strategy := failoverStrategyFor(p.spec.Strategy)
	index := strategy.pick(p, request)
	index = p.refinePickLocked(strategy, index, request)
	return p.spec.Targets[index], index
}

// 一次挑选的输入：第 1 段给出的候选（非空），和调用方带来的访客、排除、协议。
type failoverPickRequest struct {
	candidates []int
	hashKey    string
	exclude    map[int]bool
	udp        bool
}
