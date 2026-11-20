package main

import (
	"log"
	"time"

	"github.com/zhongyizhu11-jpg/NEX/lbcore"
)

/*
延迟优先「只走最快的一台」（面板「检测与切换」高级里的开关，下发在 balanceDetect.fastestOnly）。

不在「一样快」的几台里分：新连接、新 UDP 会话只给一台 —— 整链延迟（入口到出口握手的普通平均 + 出口到目标的中位数，
再加抖动，fillMembersLocked 填的、延迟优先圈「一样快」用的就是这个数）最低的那台，别的候补。算法和 GOST 出口组
（agent/failover_fastest.go）是同一份 lbcore.Fastest（lbcore/fastest.go）：

  - 另一台要快出「差多少算一样快」的门槛而且快两成、并且连着领先 60 秒，才换过去；
  - 在用的那台连不上了 / 到目标不通被摘了（lbcore.Candidates 的软硬信号照旧）：当场换到次快的，不等；
  - 手动指定由面板只下发那一台，不经过这里；
  - 一条连接拨在用的那台失败、带着排除重挑时只给这条连接换，不挪在用的那台（Options.Transient）。

「连着领先 60 秒」要有钟：新连接挑的时候算一次，入口每秒给面板报负载均衡状态时（balanceSnapshotLocked）也算一次，
没有新连接时也按时换，面板上「在用」的那台就是下一条连接会走的那台。
*/

// latencyMarginLocked：延迟优先「一样快」的门槛（毫秒）：面板带了检测参数就用那里的，否则默认 50ms。
func (s *exitEndpointSelector) latencyMarginLocked() float64 {
	if s.targetAware() {
		return s.target.detect.margin
	}
	return lbcore.DefaultLatencyMargin
}

// latencyGroupContainsLocked：这台这一轮因为延迟在不在被分的那一组里（不在的维护循环会勤量它，路线图 X10）。
func (s *exitEndpointSelector) latencyGroupContainsLocked(index int) bool {
	if s.fastestOnly {
		current, ok := s.fastest.Current()
		return ok && current == index
	}
	return s.near.Contains(index)
}

// fastestChoiceLocked：按此刻的健康和延迟重新看一遍在用的该是谁（会换就换），返回它；没有能挑的返回 -1。调用方持锁。
func (s *exitEndpointSelector) fastestChoiceLocked(now time.Time) int {
	if !s.fastestOnly || len(s.endpoints) == 0 {
		return -1
	}
	candidates, _ := s.candidatesLocked(nil, now, false)
	if len(candidates) == 0 {
		return -1
	}
	s.fillMembersLocked(candidates, now)
	before, _ := s.fastest.Current()
	index := s.fastest.Select(s.members, candidates, lbcore.FastestPolicy{Margin: s.latencyMarginLocked()}, now, true)
	s.noteFastestSwitchLocked(before, "report")
	for _, candidate := range candidates {
		if candidate != index && s.members[candidate].Latency > 0 {
			s.loads[candidate].noteLatencyStarved(now)
		}
	}
	return index
}

// noteFastestSwitchLocked：在用的换了就记一行日志（面板「最近切换」由上报的状态变化生成）。
func (s *exitEndpointSelector) noteFastestSwitchLocked(before int, reason string) {
	after, ok := s.fastest.Current()
	if !ok || after == before || before < 0 || before >= len(s.endpoints) || after >= len(s.endpoints) {
		return
	}
	from, to := s.endpoints[before], s.endpoints[after]
	log.Printf("entry exit fastest-only switch from=%s:%d to=%s:%d reason=%s", from.Host, from.Port, to.Host, to.Port, reason)
}
