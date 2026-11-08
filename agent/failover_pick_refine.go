package main

/*
选路第 3 段：收尾（见 failover_pick.go）。

只有主备有：挑出来的那条所在线路选了「一起分」（2.2.245）时，在这条线路的几个落地之间按它的分法再分
（spreadWithinLineLocked，route_group_line_spread.go）；有落地用不了时，平手优先挑和它同出口 IP 的落地
（2.2.251）。线路没选「一起分」、或能用的落地不到两个时，就是第 2 段挑出来的那条。
*/
func (p *failoverProxy) refinePickLocked(strategy failoverStrategy, index int, request failoverPickRequest) int {
	if !strategy.spreadWithinLine {
		return index
	}
	return p.spreadWithinLineLocked(index, request.hashKey, request.exclude, request.udp)
}
