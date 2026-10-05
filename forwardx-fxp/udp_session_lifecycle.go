package main

import (
	"sync"
	"time"
)

const (
	fxpUDPSweepInterval    = 5 * time.Second
	fxpUDPMinSweepInterval = 250 * time.Millisecond
	fxpUDPStalledTimeout   = 2 * fxpUDPIdleTimeout
	// fxpUDPTargetReadWake 是出口读目标的协程最长多久醒一次（看会话关没关、
	// 空闲够不够久）。
	fxpUDPTargetReadWake = 5 * time.Second
)

type fxpReadDeadlineSetter interface {
	SetReadDeadline(t time.Time) error
}

/*
fxpRearmingReadDeadline 让读协程不必每个包都重设读超时。

出口读目标的协程以前每读一个包之前都 SetReadDeadline(now+5s)：每次都要进
运行时改一次定时器（带锁），满载时每秒几万次，而这个超时只是用来隔一阵醒一下。
现在记下已经设好的截止时间，剩下不到一半才重设：

  - 一直有包：大约每 period/2 才真正设一次；
  - 没包了：超时最晚在最后一次设定之后 period 触发，最早在最后一个包之后
    period/2 触发，醒来照旧检查会话关没关、空闲有没有到 fxpUDPIdleTimeout。
    空闲超时按 lastActivity 算，不按读超时算，所以判定空闲的时刻不变；醒得
    早一点只是多检查一次。
  - 超时触发之后截止时间已经过了，下一次 arm 一定重设。

只能给一个协程用。
*/
type fxpRearmingReadDeadline struct {
	period   time.Duration
	deadline time.Time
}

// arm 在每次读之前调用。
func (d *fxpRearmingReadDeadline) arm(conn fxpReadDeadlineSetter, now time.Time) {
	if !d.deadline.IsZero() && d.deadline.Sub(now) > d.period/2 {
		return
	}
	d.deadline = now.Add(d.period)
	_ = conn.SetReadDeadline(d.deadline)
}

func fxpUDPSessionIdleAt(now time.Time, lastActivity int64) bool {
	if lastActivity <= 0 {
		return false
	}
	return now.Sub(time.Unix(0, lastActivity)) >= fxpUDPIdleTimeout
}

// Normal idle sessions are reclaimed only after their queues drain. A worker
// stuck in a socket write or limiter wait must not keep its session, socket and
// 65 KiB read buffer forever, so a longer hard timeout closes it regardless of
// the pending count. Active sessions keep touching lastActivity and are never
// affected by either path.
func fxpUDPSessionExpiredAt(now time.Time, lastActivity int64, pending int) bool {
	if lastActivity <= 0 {
		return false
	}
	idle := now.Sub(time.Unix(0, lastActivity))
	return idle >= fxpUDPStalledTimeout || (pending <= 0 && idle >= fxpUDPIdleTimeout)
}

func startFXPUDPSessionSweeper(sweep func(time.Time)) (stop func(), wake func()) {
	done := make(chan struct{})
	stopped := make(chan struct{})
	wakeCh := make(chan struct{}, 1)
	go func() {
		defer close(stopped)
		ticker := time.NewTicker(fxpUDPSweepInterval)
		defer ticker.Stop()
		var lastSweep time.Time
		run := func(now time.Time) {
			if sweep != nil {
				sweep(now)
			}
			lastSweep = now
		}
		for {
			select {
			case <-done:
				return
			case now := <-ticker.C:
				run(now)
			case <-wakeCh:
				now := time.Now()
				if lastSweep.IsZero() || now.Sub(lastSweep) >= fxpUDPMinSweepInterval {
					run(now)
				}
			}
		}
	}()

	var once sync.Once
	stop = func() {
		once.Do(func() {
			close(done)
			<-stopped
		})
	}
	wake = func() {
		select {
		case wakeCh <- struct{}{}:
		default:
		}
	}
	return stop, wake
}

func startFXPUDPSessionWorker(wg *sync.WaitGroup, worker func()) {
	if worker == nil {
		return
	}
	if wg != nil {
		wg.Add(1)
	}
	go func() {
		if wg != nil {
			defer wg.Done()
		}
		_ = catchPanic("udp session worker", func() error {
			worker()
			return nil
		})
	}()
}
