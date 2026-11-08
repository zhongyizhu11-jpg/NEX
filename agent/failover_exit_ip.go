package main

import "strings"

/*
故障切换优先同出口 IP（2.2.251，面板 2.3.520）。

面板给每条路径带一个出口 IP（failoverTarget.ExitIP）：这条路径最后从哪个地址出去。当前这条挂了要换的时候，
对端（网站、游戏服）看到的来源最好别变 —— 变了登录态可能掉、IP 绑定的会被踢。所以在**同样够格**的候选里，
优先挑出口 IP 和挂掉那条一样的。

什么叫同样够格：
  - 分层规格里只在和原本该换去的那条同一层里挑（备用组再像也不越级）；
  - 评分要落在这一层最高分减 ScoreMargin 之内；一条都打不出分（刚起来还没探）时都算平手，
    有打出分的时候没分的不算（不能把「没探过」当成「一样好」）；
  - 人工指定、时段表定的首选健康就直接走它，这里不插手。

只是平手时的取舍：没有出口 IP、或者没有一条候选和它一样时，和以前逐字一样 —— 按顺序挑第一条健康的。
事件原因后面带上 failoverSameExitReasonSuffix，面板写成「换到同出口 IP 的备用」。
*/

const failoverSameExitReasonSuffix = "; same exit ip"

func (p *failoverProxy) exitIPLocked(index int) string {
	if index < 0 || index >= len(p.spec.Targets) {
		return ""
	}
	return strings.TrimSpace(p.spec.Targets[index].ExitIP)
}

/*
escapePickLocked：当前这条（failed）用不了，按 order 的次序换哪条。

返回挑中的下标（没有能用的是 -1）和「是不是因为出口 IP 一样才挑它 / 它正好和挂掉那条同出口」。
explicit 是人工指定或时段表定的首选（-1 = 没有）：它能用就是它。udp 为 true 按 UDP 那一侧判能不能用
（usableLocked）—— TCP 在走的那条 UDP 不通时，UDP 会话也优先换到和它同出口的那条，同一个访客的 TCP 和 UDP
在对端看到的是同一个来源。调用方持有 p.mu。
*/
func (p *failoverProxy) escapePickLocked(order []int, failed int, explicit int, udp bool) (int, bool) {
	healthy := make([]int, 0, len(order))
	for _, index := range order {
		if index == failed || !p.usableLocked(index, udp) {
			continue
		}
		healthy = append(healthy, index)
	}
	if len(healthy) == 0 {
		return -1, false
	}
	first := healthy[0]
	want := p.exitIPLocked(failed)
	if want == "" {
		return first, false
	}
	if explicit >= 0 && explicit == first {
		return first, p.exitIPLocked(first) == want
	}
	if p.exitIPLocked(first) == want {
		return first, true
	}
	// 和原本该换去的那条同一层才算平手；不分层的规格全部健康的都算。
	equals := healthy
	if failoverSpecTiered(p.spec) {
		tier := *p.spec.Targets[first].Tier
		equals = make([]int, 0, len(healthy))
		for _, index := range healthy {
			if *p.spec.Targets[index].Tier == tier {
				equals = append(equals, index)
			}
		}
	}
	// 评分差得太多就不算平手（不管开没开整链最优，分都在算）。一条都没分时都算。
	best, scoredAny := 0, false
	for _, index := range equals {
		if score, ok := p.scoreLocked(index); ok && (!scoredAny || score > best) {
			best, scoredAny = score, true
		}
	}
	if scoredAny {
		filtered := make([]int, 0, len(equals))
		for _, index := range equals {
			if score, ok := p.scoreLocked(index); ok && best-score <= p.spec.ScoreMargin {
				filtered = append(filtered, index)
			}
		}
		equals = filtered
	}
	for _, index := range equals {
		if p.exitIPLocked(index) == want {
			return index, true
		}
	}
	return first, false
}

/*
一条「一起分」的线路上，这会儿用不了的落地（挂了、或这条连接拨失败过）各自的出口 IP。
reps 是能用的落地代表。ip_hash / least_load 平手时优先挑出口 IP 在这里面的落地：原来在那个落地上的访客
换到同出口的落地上，对端看到的来源不变。udp 为 true 时「用不了」按 UDP 那一侧判（和挑 reps 时一样）。
调用方持有 p.mu。
*/
func (p *failoverProxy) lineDeadExitIPsLocked(line int, reps []int, exclude map[int]bool, udp bool) map[string]bool {
	alive := map[string]bool{}
	for _, index := range reps {
		alive[p.lineLandingLocked(index)] = true
	}
	dead := map[string]bool{}
	for i := range p.spec.Targets {
		if !p.sameLineLocked(i, line) || alive[p.lineLandingLocked(i)] {
			continue
		}
		if (exclude != nil && exclude[i]) || !p.usableLocked(i, udp) {
			if ip := p.exitIPLocked(i); ip != "" {
				dead[ip] = true
			}
		}
	}
	return dead
}
