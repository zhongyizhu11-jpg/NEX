package main

import (
	"sync/atomic"
	"testing"
	"time"
)

func resetSelfTestBorrowState(t *testing.T) {
	t.Helper()
	selfTestInFlightMu.Lock()
	selfTestInFlight = map[int]bool{}
	selfTestInFlightMu.Unlock()
	selfTestLastClaimAt.Store(0)
	atomic.StoreInt64(&actionPendingCount, 0)
	t.Cleanup(func() {
		selfTestInFlightMu.Lock()
		selfTestInFlight = map[int]bool{}
		selfTestInFlightMu.Unlock()
		selfTestLastClaimAt.Store(0)
	})
}

// 手动测速闲着、后台活比名额多：借空名额；活不多不借。
func TestTCPingBorrowsIdleSelfTestSlots(t *testing.T) {
	resetSelfTestBorrowState(t)
	if got := tcpingBorrowableWorkers(100, 32); got != selfTestWorkerConcurrency {
		t.Fatalf("应当借满 %d 个：%d", selfTestWorkerConcurrency, got)
	}
	if got := tcpingBorrowableWorkers(40, 32); got != 8 {
		t.Fatalf("只差 8 条就只借 8 个：%d", got)
	}
	if got := tcpingBorrowableWorkers(20, 32); got != 0 {
		t.Fatalf("活不比名额多不借：%d", got)
	}
	if got := tcpingBorrowedRuleLimit(24, 500, 256); got != 24*(tcpingMaxConcurrency+selfTestWorkerConcurrency)/tcpingMaxConcurrency {
		t.Fatalf("借到名额时一轮按比例多选：%d", got)
	}
	if got := tcpingBorrowedRuleLimit(24, 24, 256); got != 24 {
		t.Fatalf("本来就能全选时不变：%d", got)
	}
}

// 手动测速在跑、刚来过一批、或者有动作在执行：不借。
func TestTCPingDoesNotBorrowWhileSelfTestsActive(t *testing.T) {
	resetSelfTestBorrowState(t)
	if !claimSelfTest(91) {
		t.Fatal("claim failed")
	}
	if got := tcpingBorrowableWorkers(100, 32); got != 0 {
		t.Fatalf("手动测速在跑时不该借：%d", got)
	}
	releaseSelfTest(91)
	if got := tcpingBorrowableWorkers(100, 32); got != 0 {
		t.Fatalf("刚来过一批（10 秒内）不该借：%d", got)
	}
	selfTestLastClaimAt.Store(time.Now().Add(-selfTestBorrowQuietWindow - time.Second).UnixNano())
	if got := tcpingBorrowableWorkers(100, 32); got == 0 {
		t.Fatal("安静够久了应当能借")
	}
	atomic.StoreInt64(&actionPendingCount, 1)
	defer atomic.StoreInt64(&actionPendingCount, 0)
	if got := tcpingBorrowableWorkers(100, 32); got != 0 {
		t.Fatalf("有动作在执行时不借：%d", got)
	}
	if got := tcpingBorrowedRuleLimit(24, 500, 256); got != 24 {
		t.Fatalf("借不到时规则数不放大：%d", got)
	}
}
