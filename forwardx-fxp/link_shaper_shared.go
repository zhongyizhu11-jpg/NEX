package main

import (
	"errors"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"
	"unsafe"
)

/*
主机公网出口整形要整台机器一个，可一台机器上 Agent 会起好几个 FXP 进程（每条隧道
的入口组、每条隧道的出口各一个）。每个进程自己一个整形器的话，两个忙的进程各按
500M 发，合起来就是 1G，限速器照样丢。

所以令牌桶放在共享内存里：/dev/shm 下一个小文件，所有 FXP 进程 mmap 同一份。
  · 虚拟时钟（下一字节允许发出的时刻）是共享的一个 int64，领额度用 CAS，哪个进程
    发都从同一个桶里扣；
  · 每个进程占一个槽，每秒把自己成员连接的累计送达、重传、段数、发出量写进去；
  · 拿到文件锁的那个进程是领头的：把所有活着的槽这一秒的增量加起来交给检测逻辑
    （和单进程时一模一样），把算出来的速率、学到的值写回头部；其它进程每秒读一次
    跟着走。锁随进程退出自动释放，下一秒别的进程接手，不用选举协议。
文件损坏或打不开就退回进程内的桶（只保护自己这一份流量），不影响转发。
*/

const (
	linkSharedMagic     = int64(0x3153524745505846) // "FXPEGRS1"
	linkSharedSize      = 8192
	linkSharedSlots     = 32
	linkSharedSlotBase  = 256
	linkSharedSlotSize  = 64
	linkSharedStaleSlot = 10 * time.Second // 槽多久没心跳就能被别的进程占
	linkSharedStaleBeat = 3 * time.Second  // 槽多久没心跳就不计入合计
)

// 头部字段偏移（都是 8 字节对齐的 int64）。
const (
	linkSharedOffMagic   = 0
	linkSharedOffRate    = 8  // 当前整形速率（字节/秒），0 = 不整形
	linkSharedOffNext    = 16 // 虚拟时钟（unix 纳秒）
	linkSharedOffLearned = 24 // 学到的限速点（字节/秒）
	linkSharedOffLeader  = 32 // 领头进程的 pid
	linkSharedOffBeat    = 40 // 领头进程最近一次心跳（unix 纳秒）
)

// 槽内字段偏移。
const (
	linkSlotPid     = 0
	linkSlotBeat    = 8
	linkSlotAcked   = 16 // 累计送达（被确认）的字节
	linkSlotRetrans = 24 // 累计重传段数
	linkSlotSegs    = 32 // 累计发出段数
	linkSlotSent    = 40 // 累计从桶里领走的字节
	linkSlotBusy    = 48 // 这一秒有没有积压
)

var linkShaperSharedDir = func() string {
	if value := strings.TrimSpace(os.Getenv("FORWARDX_FXP_SHM_DIR")); value != "" {
		return value
	}
	if info, err := os.Stat("/dev/shm"); err == nil && info.IsDir() {
		return "/dev/shm/forwardx-fxp"
	}
	return linkShaperStateDir
}()

type linkSlotSeen struct {
	pid                        int64
	acked, retrans, segs, sent uint64
}

type linkShaperShared struct {
	buf    []byte
	file   *os.File
	lock   *os.File
	slot   int
	pid    int64
	leader atomic.Bool
	// 本进程发布的累计量。
	acked, retrans, segs, sent uint64
	// 领头的进程上一秒看到的每个槽的累计量，算增量用。
	seen [linkSharedSlots]linkSlotSeen
}

func (sh *linkShaperShared) i64(off int) *int64  { return (*int64)(unsafe.Pointer(&sh.buf[off])) }
func (sh *linkShaperShared) u64(off int) *uint64 { return (*uint64)(unsafe.Pointer(&sh.buf[off])) }
func linkSlotOff(slot, field int) int            { return linkSharedSlotBase + slot*linkSharedSlotSize + field }

// openLinkShaperShared 打开（没有就建）共享文件并占一个槽。
func openLinkShaperShared(dir string) (*linkShaperShared, error) {
	if strings.TrimSpace(dir) == "" {
		return nil, errors.New("no shared state dir")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, "egress-shaper.state")
	file, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	if info, err := file.Stat(); err != nil || info.Size() < linkSharedSize {
		if err := file.Truncate(linkSharedSize); err != nil {
			_ = file.Close()
			return nil, err
		}
	}
	buf, err := mmapShared(file, linkSharedSize)
	if err != nil {
		_ = file.Close()
		return nil, err
	}
	lock, err := os.OpenFile(path+".lock", os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		unmapShared(buf)
		_ = file.Close()
		return nil, err
	}
	sh := &linkShaperShared{buf: buf, file: file, lock: lock, slot: -1, pid: int64(os.Getpid())}
	atomic.CompareAndSwapInt64(sh.i64(linkSharedOffMagic), 0, linkSharedMagic)
	if atomic.LoadInt64(sh.i64(linkSharedOffMagic)) != linkSharedMagic {
		sh.close()
		return nil, errors.New("egress shaper shared state has an unknown layout")
	}
	now := time.Now().UnixNano()
	for i := 0; i < linkSharedSlots; i++ {
		pidPtr := sh.i64(linkSlotOff(i, linkSlotPid))
		pid := atomic.LoadInt64(pidPtr)
		beat := atomic.LoadInt64(sh.i64(linkSlotOff(i, linkSlotBeat)))
		if pid != 0 && now-beat < int64(linkSharedStaleSlot) {
			continue
		}
		if !atomic.CompareAndSwapInt64(pidPtr, pid, sh.pid) {
			continue
		}
		for _, field := range []int{linkSlotAcked, linkSlotRetrans, linkSlotSegs, linkSlotSent, linkSlotBusy} {
			atomic.StoreUint64(sh.u64(linkSlotOff(i, field)), 0)
		}
		atomic.StoreInt64(sh.i64(linkSlotOff(i, linkSlotBeat)), now)
		sh.slot = i
		break
	}
	if sh.slot < 0 {
		sh.close()
		return nil, errors.New("no free egress shaper slot")
	}
	return sh, nil
}

func (sh *linkShaperShared) close() {
	if sh.slot >= 0 {
		atomic.CompareAndSwapInt64(sh.i64(linkSlotOff(sh.slot, linkSlotPid)), sh.pid, 0)
	}
	if sh.lock != nil {
		_ = sh.lock.Close()
	}
	unmapShared(sh.buf)
	_ = sh.file.Close()
}

// publish 把本进程这一秒的量累加后写进自己的槽。
func (sh *linkShaperShared) publish(now time.Time, acked, retrans, segs, sent uint64, busy bool) {
	sh.acked += acked
	sh.retrans += retrans
	sh.segs += segs
	sh.sent += sent
	atomic.StoreUint64(sh.u64(linkSlotOff(sh.slot, linkSlotAcked)), sh.acked)
	atomic.StoreUint64(sh.u64(linkSlotOff(sh.slot, linkSlotRetrans)), sh.retrans)
	atomic.StoreUint64(sh.u64(linkSlotOff(sh.slot, linkSlotSegs)), sh.segs)
	atomic.StoreUint64(sh.u64(linkSlotOff(sh.slot, linkSlotSent)), sh.sent)
	flag := uint64(0)
	if busy {
		flag = 1
	}
	atomic.StoreUint64(sh.u64(linkSlotOff(sh.slot, linkSlotBusy)), flag)
	atomic.StoreInt64(sh.i64(linkSlotOff(sh.slot, linkSlotBeat)), now.UnixNano())
}

// electLeader：拿到文件锁的进程是领头的；锁随进程退出释放，别的进程下一秒接手。
func (sh *linkShaperShared) electLeader(now time.Time) bool {
	if !sh.leader.Load() && flockTry(sh.lock) {
		sh.leader.Store(true)
		atomic.StoreInt64(sh.i64(linkSharedOffLeader), sh.pid)
		log.Printf("fxp link shaper egress: this process (pid %d) now runs the host-wide detector", sh.pid)
	}
	if sh.leader.Load() {
		atomic.StoreInt64(sh.i64(linkSharedOffBeat), now.UnixNano())
	}
	return sh.leader.Load()
}

func (sh *linkShaperShared) isLeader() bool { return sh != nil && sh.leader.Load() }

// aggregate 领头的进程把所有活着的槽这一秒的增量加起来（含自己的槽）。
func (sh *linkShaperShared) aggregate(now time.Time) (acked, retrans, segs, sent uint64, busy bool) {
	cutoff := now.UnixNano() - int64(linkSharedStaleBeat)
	for i := 0; i < linkSharedSlots; i++ {
		seen := &sh.seen[i]
		pid := atomic.LoadInt64(sh.i64(linkSlotOff(i, linkSlotPid)))
		beat := atomic.LoadInt64(sh.i64(linkSlotOff(i, linkSlotBeat)))
		if pid == 0 || beat < cutoff {
			seen.pid = 0
			continue
		}
		cur := linkSlotSeen{
			pid:     pid,
			acked:   atomic.LoadUint64(sh.u64(linkSlotOff(i, linkSlotAcked))),
			retrans: atomic.LoadUint64(sh.u64(linkSlotOff(i, linkSlotRetrans))),
			segs:    atomic.LoadUint64(sh.u64(linkSlotOff(i, linkSlotSegs))),
			sent:    atomic.LoadUint64(sh.u64(linkSlotOff(i, linkSlotSent))),
		}
		if seen.pid == pid {
			acked += linkSharedDelta(cur.acked, seen.acked)
			retrans += linkSharedDelta(cur.retrans, seen.retrans)
			segs += linkSharedDelta(cur.segs, seen.segs)
			sent += linkSharedDelta(cur.sent, seen.sent)
			if atomic.LoadUint64(sh.u64(linkSlotOff(i, linkSlotBusy))) == 1 {
				busy = true
			}
		}
		*seen = cur
	}
	return acked, retrans, segs, sent, busy
}

// 槽被新进程占了会从 0 重新累计：比上次小就当是重新开始。
func linkSharedDelta(cur, prev uint64) uint64 {
	if cur < prev {
		return cur
	}
	return cur - prev
}

func (sh *linkShaperShared) storeRate(rate, learned int64) {
	atomic.StoreInt64(sh.i64(linkSharedOffRate), rate)
	atomic.StoreInt64(sh.i64(linkSharedOffLearned), learned)
}

func (sh *linkShaperShared) loadRate() (rate, learned int64) {
	return atomic.LoadInt64(sh.i64(linkSharedOffRate)), atomic.LoadInt64(sh.i64(linkSharedOffLearned))
}

// take 在共享的虚拟时钟上为 n 字节领额度，返回允许发出的时刻。
func (sh *linkShaperShared) take(now time.Time, n int, rate int64) time.Time {
	ptr := sh.i64(linkSharedOffNext)
	cost := int64(float64(n) * float64(time.Second) / float64(rate))
	credit := now.UnixNano() - int64(linkShaperBurst)
	for {
		next := atomic.LoadInt64(ptr)
		start := next
		if start < credit {
			start = credit
		}
		if atomic.CompareAndSwapInt64(ptr, next, start+cost) {
			return time.Unix(0, start)
		}
	}
}
