package lbcore

import (
	"math"
	"time"
)

/*
SlowStart 是慢启动：刚从挂掉恢复的成员，在 Window 里从 Floor 按时间线性加到满份（Envoy / HAProxy 的 slow start）。

不这样的话，刚恢复、一条连接都没有的成员在「按负载」里成本最低，新连接一下子全涌过去；它要是还没完全好
（探测通了但一压就垮），这一下正好把它再压垮一次。
*/
type SlowStart struct {
	Window time.Duration
	Floor  float64
}

// DefaultSlowStart：60 秒，从 10% 起。线路组和出口组都用它。
var DefaultSlowStart = SlowStart{Window: 60 * time.Second, Floor: 0.1}

// Factor 恢复于 recoveredAt 的成员在 now 这一刻按几成算。recoveredAt 是零值（没挂过）返回 1。
func (s SlowStart) Factor(recoveredAt, now time.Time) float64 {
	if recoveredAt.IsZero() || s.Window <= 0 {
		return 1
	}
	since := now.Sub(recoveredAt)
	if since >= s.Window {
		return 1
	}
	return math.Min(1, math.Max(s.Floor, float64(since)/float64(s.Window)))
}
