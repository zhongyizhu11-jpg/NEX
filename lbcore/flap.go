package lbcore

import "time"

/*
抖动抑制：切得越勤，下一次等得越久。

切换保护（连续失败次数、分差、持续时间）挡的是**单次**误判；两个成员质量接近、轮流领先时，每一次切换都各自
合规，合起来却是来回漂。对付它不能再加一道单次门槛，得看频率：Window 里记了 Threshold 次起，驻留从 Base 开始，
每多一次翻一倍，最多 Max。

三条规矩两边一样：

  - 人定的不计（人工指定、切换演练）：调用方不调 Note 就是了。
  - 启动预热期里的不计（WarmupUntil）：刚起来时对端往往晚几秒才就绪，头几轮探测会判坏、切走、马上又切回，
    那是开机抖动，不是线路在漂。切换照常发生，只是不记账。
  - 逃生不受限：当前这个挂了，立刻换，不管驻留。守着一条死路比抖动更糟（Holding 的 escape 参数）。
*/
type FlapPolicy struct {
	// Window：数多久以内的。
	Window time.Duration
	// Threshold：Window 里到了这么多次就开始压。
	Threshold int
	// Base、Max：驻留从 Base 起，每多一次翻一倍，最多 Max。Base = Max 就是固定的驻留。
	Base time.Duration
	Max  time.Duration
}

// HoldFor 记了 count 次时要求的驻留；没到门槛是 0。
func (p FlapPolicy) HoldFor(count int) time.Duration {
	if p.Threshold <= 0 || count < p.Threshold || p.Base <= 0 {
		return 0
	}
	hold := p.Base
	for extra := count - p.Threshold; extra > 0 && hold < p.Max; extra-- {
		hold *= 2
		if hold <= 0 { // 溢出
			hold = p.Max
		}
	}
	if p.Max > 0 && hold > p.Max {
		hold = p.Max
	}
	return hold
}

/*
FlapDamper 是一份抖动抑制的账。字段都是导出的：调用方可以把 Events 直接放在自己的结构里
（[]time.Time），用的时候临时拼一个 FlapDamper 出来，改完把 Events 存回去。
*/
type FlapDamper struct {
	Policy FlapPolicy
	// WarmupUntil：这个时刻之前发生的不记（零值 = 没有预热期）。
	WarmupUntil time.Time
	// Events：Window 以内记下的时刻。
	Events []time.Time
}

// Note 记一次（切换、中断）。在预热期里的不记，返回 false。顺手丢掉 Window 以外的。
func (d *FlapDamper) Note(at time.Time) bool {
	if !d.WarmupUntil.IsZero() && at.Before(d.WarmupUntil) {
		return false
	}
	kept := d.Events[:0]
	for _, event := range d.Events {
		if at.Sub(event) < d.Policy.Window {
			kept = append(kept, event)
		}
	}
	d.Events = append(kept, at)
	return true
}

// Count Window 以内记了几次。
func (d *FlapDamper) Count(now time.Time) int {
	count := 0
	for _, event := range d.Events {
		if now.Sub(event) < d.Policy.Window {
			count++
		}
	}
	return count
}

// Hold 此刻抖动抑制要求的驻留；没在抖是 0。
func (d *FlapDamper) Hold(now time.Time) time.Duration {
	return d.Policy.HoldFor(d.Count(now))
}

// Flapping 此刻是不是在抖（到了门槛）。
func (d *FlapDamper) Flapping(now time.Time) bool {
	return d.Hold(now) > 0
}

/*
Holding 现在该不该压着不动：since 是上一次变动的时刻（切过去的时刻、坏掉的时刻），min 是调用方自己配置的
最短驻留（和抖动抑制取长的那个）。escape 为 true（当前这个挂了，要逃生）时永远不压。since 是零值（还没变动过）不压。
*/
func (d *FlapDamper) Holding(now, since time.Time, min time.Duration, escape bool) bool {
	if escape || since.IsZero() {
		return false
	}
	hold := min
	if flap := d.Hold(now); flap > hold {
		hold = flap
	}
	return hold > 0 && now.Sub(since) < hold
}
