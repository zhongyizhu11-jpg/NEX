package main

import (
	"net"
	"testing"
	"time"
)

// 池子上限从 16 抬到 64（见 fxpPoolMaxSize 的注释）：一秒内几十条新连接的突发
// 要能全部从池里取，平时仍按峰值备，不会一直挂着 64 条。
func TestEndpointPoolTargetFollowsBurstUpToMax(t *testing.T) {
	if fxpPoolMaxSize != 64 {
		t.Fatalf("fxpPoolMaxSize = %d, want 64", fxpPoolMaxSize)
	}
	now := time.Date(2026, 10, 4, 12, 0, 0, 0, time.UTC)
	state := &fxpEndpointState{healthy: true}

	state.mu.Lock()
	defer state.mu.Unlock()
	if got := state.poolTargetLocked(now); got != fxpPoolMinSize {
		t.Fatalf("没取过时 target = %d, want %d", got, fxpPoolMinSize)
	}
	for i := 0; i < 40; i++ {
		state.recordTakeLocked(now)
	}
	// 以前这里会被夹到 16，第 17 条起都要现拨。
	if got := state.poolTargetLocked(now); got != 41 {
		t.Fatalf("一秒取 40 条之后 target = %d, want 41", got)
	}
	for i := 0; i < 200; i++ {
		state.recordTakeLocked(now)
	}
	if got := state.poolTargetLocked(now); got != fxpPoolMaxSize {
		t.Fatalf("突发再大 target 也不超过上限：got %d, want %d", got, fxpPoolMaxSize)
	}
	// 峰值滑出 30 秒窗口之后回到下限，池子靠空闲过期慢慢缩回去。
	if got := state.poolTargetLocked(now.Add(31 * time.Second)); got != fxpPoolMinSize {
		t.Fatalf("峰值过去之后 target = %d, want %d", got, fxpPoolMinSize)
	}
}

func TestEndpointPoolDoesNotDialPastMax(t *testing.T) {
	now := time.Now()
	state := &fxpEndpointState{
		id:           fxpEndpointID{host: "127.0.0.1", port: 1, key: "pool-max-key"},
		healthy:      true,
		dialCfgKnown: true,
	}
	state.mu.Lock()
	for i := 0; i < 500; i++ {
		state.recordTakeLocked(now)
	}
	// 池子已经满了：不管最近取得多快，都不该再拨。
	for i := 0; i < fxpPoolMaxSize; i++ {
		state.idle = append(state.idle, pooledSecureConn{createdAt: now})
	}
	state.mu.Unlock()
	state.ensureFill()
	state.mu.Lock()
	dialing := state.dialing
	state.mu.Unlock()
	if dialing != 0 {
		t.Fatalf("池子满了还在拨 %d 条", dialing)
	}
}

// 池里的连接照旧在 fxpPoolMaxIdleAge 之后换掉，上限变大不改变这一点。
func TestEndpointPoolExpiresIdleConnectionsAtMaxIdleAge(t *testing.T) {
	now := time.Now()
	state := &fxpEndpointState{healthy: true, lastTake: now}
	fresh, freshPeer := net.Pipe()
	stale, stalePeer := net.Pipe()
	defer freshPeer.Close()
	defer stalePeer.Close()
	defer fresh.Close()
	state.idle = []pooledSecureConn{
		{conn: stale, createdAt: now.Add(-fxpPoolMaxIdleAge - time.Second)},
		{conn: fresh, createdAt: now},
	}
	state.maintain(now)
	state.mu.Lock()
	defer state.mu.Unlock()
	if len(state.idle) != 1 || state.idle[0].conn != fresh {
		t.Fatalf("过期的预热连接没被清掉：idle=%d", len(state.idle))
	}
	if _, err := stale.Write([]byte{0}); err == nil {
		t.Fatal("过期的预热连接应该已经被关掉")
	}
}
