package main

import (
	"sync"
	"sync/atomic"
	"time"
)

/*
单连接叠加每一路跑了多少（连接监控里的「每一路」，FXP 2.2.135 起）。

入口这一端两个方向都看得见：上行是它自己往每一路上写的，下行是出口分到每一路、它从那一路读到的。
所以只在入口记，出口不用报。

每一路一个计数器，收发时只做一次原子加；每分钟报连接统计之前（takeConnStats）把这一分钟的增量
并进 stage=leg 那一行。同一台中转同一时刻可能有几十个会话的腿，它们的 key 一样，并到一行里。
腿断了以后最后一次增量照样报，之后从表里拿掉。
*/

type multipathLegTraffic struct {
	key  connStatsKey
	up   atomic.Uint64
	down atomic.Uint64
	done atomic.Bool
	// reportedUp / reportedDown 是已经并进连接统计的部分，只在 legTraffic 锁里动。
	reportedUp   uint64
	reportedDown uint64
}

var legTraffic = struct {
	sync.Mutex
	live map[*multipathLegTraffic]struct{}
}{live: map[*multipathLegTraffic]struct{}{}}

func multipathLegStatsKey(cfg config, legCfg multipathLeg) (connStatsKey, bool) {
	return connStatsKeyFor(cfg, cfg.TunnelID, cfg.RuleID, "entry", "leg", connStatsEndpoint(legCfg.Host, legCfg.Port), multipathLegLabel(legCfg))
}

// recordMultipathLegDial 记一次拨这一路（拨号加报到）的结果。
func recordMultipathLegDial(cfg config, legCfg multipathLeg, elapsed time.Duration, err error) {
	if key, ok := multipathLegStatsKey(cfg, legCfg); ok {
		recordConnStageKey(key, elapsed, err)
	}
}

// newMultipathLegTraffic 给拨通的一路开计数器；不报统计的配置（没有面板地址）给 nil，后面的调用都不做事。
func newMultipathLegTraffic(cfg config, legCfg multipathLeg) *multipathLegTraffic {
	key, ok := multipathLegStatsKey(cfg, legCfg)
	if !ok {
		return nil
	}
	traffic := &multipathLegTraffic{key: key}
	legTraffic.Lock()
	legTraffic.live[traffic] = struct{}{}
	legTraffic.Unlock()
	return traffic
}

func (t *multipathLegTraffic) addUp(n uint64) {
	if t != nil {
		t.up.Add(n)
	}
}

func (t *multipathLegTraffic) addDown(n uint64) {
	if t != nil {
		t.down.Add(n)
	}
}

// finish 是这一路不会再有流量了：下次报完就拿掉。
func (t *multipathLegTraffic) finish() {
	if t != nil {
		t.done.Store(true)
	}
}

// flushMultipathLegTraffic 把每一路这一分钟的增量并进连接统计。
func flushMultipathLegTraffic() {
	type delta struct {
		key      connStatsKey
		up, down uint64
	}
	legTraffic.Lock()
	deltas := make([]delta, 0, len(legTraffic.live))
	for traffic := range legTraffic.live {
		// 先看 done 再读计数：done 之后才到的那几个字节（写入者收尾时的最后一帧）丢了也无妨，
		// 反过来会让一条早就结束的腿一直挂在表里。
		done := traffic.done.Load()
		up, down := traffic.up.Load(), traffic.down.Load()
		if up > traffic.reportedUp || down > traffic.reportedDown {
			deltas = append(deltas, delta{key: traffic.key, up: up - traffic.reportedUp, down: down - traffic.reportedDown})
			traffic.reportedUp, traffic.reportedDown = up, down
		}
		if done {
			delete(legTraffic.live, traffic)
		}
	}
	legTraffic.Unlock()
	if len(deltas) == 0 {
		return
	}
	connStats.Lock()
	for _, item := range deltas {
		value := connStats.entries[item.key]
		if value == nil {
			if len(connStats.entries) >= connStatsMaxEntries {
				continue
			}
			value = &connStatsValue{}
			connStats.entries[item.key] = value
		}
		value.BytesUp += item.up
		value.BytesDown += item.down
	}
	connStats.Unlock()
}
