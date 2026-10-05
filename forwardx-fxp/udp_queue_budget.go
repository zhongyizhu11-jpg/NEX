package main

import "sync/atomic"

const (
	fxpUDPQueueRuleBudgetBytes    int64 = 16 * 1024 * 1024
	fxpUDPQueueProcessBudgetBytes int64 = 64 * 1024 * 1024
)

/*
UDP 排队字节的两级额度：每条规则一份，整个进程共用一份。

以前两级额度共用进程级的一把锁，每个包入队、出队各拿一次 —— 所有规则、所有
会话的收发协程都挤在这一把锁上。现在每一级都是一个原子计数，用 CAS 循环做
「看一眼余额、够就扣」，不再有锁。

两级之间不再是同一个临界区，所以顺序是定死的：
  - 净增加（预留、换成更大的包）：先加规则，再加进程，各自在 CAS 里对着自己
    的上限检查；进程加不下就把规则那份按增量退回去。规则自己满了根本碰不到
    进程计数，一条堵住的规则不会让别的规则看到虚高的进程用量。
  - 净减少（归还、换成更小的包）：碰不到上限，两级直接减。

这样每个计数只会短暂地多算、不会少算，而且只有加法要过上限检查，所以两级上限
都严格成立，和加锁时一样。唯一的差别是并发边界上可能多拒一个包（另一个协程
刚加了规则、正要被进程退回），对 UDP 来说就是满载时多丢一个包。
*/
type fxpUDPQueueProcessBudget struct {
	limit int64
	used  atomic.Int64
}

type fxpUDPQueueRuleBudget struct {
	process *fxpUDPQueueProcessBudget
	limit   int64
	used    atomic.Int64
}

var fxpUDPDefaultProcessQueueBudget = newFXPUDPQueueProcessBudget(fxpUDPQueueProcessBudgetBytes)

func newFXPUDPQueueProcessBudget(limit int64) *fxpUDPQueueProcessBudget {
	if limit < 0 {
		limit = 0
	}
	return &fxpUDPQueueProcessBudget{limit: limit}
}

func newFXPUDPQueueRuleBudget(process *fxpUDPQueueProcessBudget, limit int64) *fxpUDPQueueRuleBudget {
	if limit < 0 {
		limit = 0
	}
	return &fxpUDPQueueRuleBudget{process: process, limit: limit}
}

func newDefaultFXPUDPQueueRuleBudget() *fxpUDPQueueRuleBudget {
	return newFXPUDPQueueRuleBudget(fxpUDPDefaultProcessQueueBudget, fxpUDPQueueRuleBudgetBytes)
}

// addFXPUDPBudgetCounter 在一个计数上原子地加 delta（> 0），加完超出上限就不加、
// 返回 false。
func addFXPUDPBudgetCounter(counter *atomic.Int64, limit, delta int64) bool {
	for {
		current := counter.Load()
		if delta > limit-current {
			return false
		}
		if counter.CompareAndSwap(current, current+delta) {
			return true
		}
	}
}

// releaseFXPUDPBudgetCounter 最多减掉 n、不减到负数，返回实际减掉的量。
func releaseFXPUDPBudgetCounter(counter *atomic.Int64, n int64) int64 {
	for {
		current := counter.Load()
		take := n
		if take > current {
			take = current
		}
		if take <= 0 {
			return 0
		}
		if counter.CompareAndSwap(current, current-take) {
			return take
		}
	}
}

func (b *fxpUDPQueueRuleBudget) reserve(bytes int) bool {
	if b == nil || b.process == nil || bytes < 0 {
		return false
	}
	if bytes == 0 {
		return true
	}
	return b.replace(0, bytes)
}

// replace atomically swaps bytes already owned by one queue for a new packet.
// This lets a congested queue keep its existing packets when a shared limit
// cannot admit the replacement.
func (b *fxpUDPQueueRuleBudget) replace(releaseBytes, reserveBytes int) bool {
	if b == nil || b.process == nil || releaseBytes < 0 || reserveBytes < 0 {
		return false
	}
	release := int64(releaseBytes)
	reserve := int64(reserveBytes)
	// 还的比记在账上的多，说明这些字节不是这个队列借的。别的协程只会动它们
	// 自己的那份，所以这里读到的余额只会比这个队列自己占着的多，检查不会误判。
	if release > b.used.Load() || release > b.process.used.Load() {
		return false
	}
	delta := reserve - release
	if delta <= 0 {
		// 净归还碰不到上限，直接减。
		b.used.Add(delta)
		b.process.used.Add(delta)
		return true
	}
	if !addFXPUDPBudgetCounter(&b.used, b.limit, delta) {
		return false
	}
	if !addFXPUDPBudgetCounter(&b.process.used, b.process.limit, delta) {
		// 进程级放不下：把规则这一级退回去。回滚是减法，不会让任何计数越过上限；
		// 期间别的协程可能也动过这个计数，所以按增量退、不能写回旧值。
		b.used.Add(-delta)
		return false
	}
	return true
}

func (b *fxpUDPQueueRuleBudget) release(bytes int) {
	if b == nil || b.process == nil || bytes <= 0 {
		return
	}
	// 和加锁时一样：规则这一级还多少，进程这一级就还多少。
	n := releaseFXPUDPBudgetCounter(&b.used, int64(bytes))
	if n > 0 {
		releaseFXPUDPBudgetCounter(&b.process.used, n)
	}
}

func (b *fxpUDPQueueRuleBudget) usedBytes() int64 {
	if b == nil || b.process == nil {
		return 0
	}
	return b.used.Load()
}

func (b *fxpUDPQueueProcessBudget) usedBytes() int64 {
	if b == nil {
		return 0
	}
	return b.used.Load()
}
