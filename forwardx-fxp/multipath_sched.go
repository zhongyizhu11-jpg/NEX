package main

// Leg scheduling for multipath sessions.
//
// 原来的调度只有一句话：每条腿一个写入者，谁空谁去抢下一片。吞吐上这没毛病，
// 但它看不见内核发送队列 —— 一条慢腿（或者已经不通、但还没报错的腿）的内核
// 缓冲有好几兆，写入照样秒回，于是它照样抢、照样塞，塞进去的那几兆要很久才
// 送得到，接收端就一直卡在它欠的那一片上等。
//
// 现在每条腿按对端回执各自记账：
//
//   · 在途字节 = 这条腿写出去的 − 对端确认从这条腿收到的。超过上限就不再抢，
//     慢腿、死腿都塞不进去太多东西。
//   · 上限跟着这条腿自己量出来的吞吐和最小往返时间走（约两倍带宽时延积），
//     快腿放得开、慢腿收得紧；还没量出来之前给一个起步值。
//   · 几条腿同时空着的时候，让预计最先送到的那条去拿 —— 交互式的小流量于是
//     总走延迟最低的那条路。大流量下各条腿都忙，这条规则自然不起作用。
//   · 一片发出去太久还没被确认（超过那条腿平滑往返时间的三倍），就交给别的腿
//     再发一份。接收端卡在一个洞上的时间，于是不再取决于最慢的那条腿。

import (
	"sort"
	"time"
)

// multipathLegMinInflight is the backlog every live leg may keep regardless of
// what it has measured, so a leg whose estimate collapsed can still show that
// it recovered.
const multipathLegMinInflight = 256 * 1024

// multipathLegInitialInflight is a leg's backlog allowance before it has
// measured anything.
const multipathLegInitialInflight = 1024 * 1024

// multipathLegMaxInflight caps one leg's backlog however fast it measures.
//
// 在途 = 写出去还没被对端确认收到的字节，其中包括还躺在本机内核发送缓冲里的。
// 这个上限除以往返时间就是一条腿的速率上限：以前 16 MiB 在 200 ms 的线路上封顶
// 约 640 Mbps，千兆中转跑不满。32 MiB 把这条线抬到约 1.3 Gbps；重传缓冲本来就被
// 对端的窗口（1024 片）封着顶，这里放宽不会让内存失控。
const multipathLegMaxInflight = 32 * 1024 * 1024

// multipathRateInterval is how often a leg's delivery rate is sampled.
const multipathRateInterval = 100 * time.Millisecond

// multipathMinRTTWindow is how long a minimum round trip stays valid. Routes
// change; a minimum that is never forgotten would size the backlog for a path
// that no longer exists.
const multipathMinRTTWindow = 10 * time.Second

// multipathReinjectMin and multipathReinjectUnmeasured bound how long a chunk
// may sit unconfirmed on its leg before another leg sends it again.
const (
	multipathReinjectMin        = 200 * time.Millisecond
	multipathReinjectUnmeasured = time.Second
	multipathReinjectBurst      = 64
)

// multipathRTTMarks bounds the timestamps kept per leg for round trip samples.
const multipathRTTMarks = 32

// multipathPreferMargin is how much sooner an idle leg must be expected to
// deliver before a writer leaves a chunk to it: 4/5 of the writer's own
// estimate. Without a margin two nearly equal legs would keep deferring on
// measurement noise.
const (
	multipathPreferNum = 4
	multipathPreferDen = 5
)

// mpOut is one chunk in the sender's retransmit buffer.
type mpOut struct {
	seq  uint64
	data []byte
	// leg is the leg currently responsible for this chunk: writing it, or
	// having written it and waiting for the far side to confirm. Nil while it
	// waits in a queue.
	leg     *multipathLegConn
	writing bool
	// legEnd is leg's byte count once this chunk was written, so the per-leg
	// acknowledgement says whether this copy got through.
	legEnd uint64
	// claimedAt is when leg took the chunk.
	claimedAt time.Time
	// avoid is a leg that already failed to deliver this chunk in time.
	avoid *multipathLegConn
}

// rttMark remembers when a leg's byte count reached end, for round trips.
type rttMark struct {
	end uint64
	at  time.Time
}

// legPacing is one leg's sending state. Guarded by the session lock.
type legPacing struct {
	// sentBytes counts data bytes fully written; writingBytes those in the
	// write under way; ackedBytes those the far side has read off this leg.
	sentBytes    uint64
	writingBytes uint64
	ackedBytes   uint64
	// progressAt is when this leg last showed the far side receiving from it,
	// or started carrying something after being empty.
	progressAt time.Time

	marks      []rttMark
	srtt       time.Duration
	minRTT     time.Duration
	minRTTAt   time.Time
	rate       float64 // bytes per second
	rateAt     time.Time
	rateBytes  uint64
	lastMarkAt time.Time

	// parked is whether the leg's writer is waiting for work, which makes it
	// a candidate for chunks another writer would rather leave to it.
	parked bool
}

func (p *legPacing) inflight() uint64 {
	total := p.sentBytes + p.writingBytes
	if total <= p.ackedBytes {
		return 0
	}
	return total - p.ackedBytes
}

// capacity is how much this leg may have outstanding: about twice what it has
// shown it can carry in one round trip, which leaves room to grow and keeps the
// queue in front of the path to roughly one more round trip.
func (p *legPacing) capacity() uint64 {
	if p.rate <= 0 || p.minRTT <= 0 {
		return multipathLegInitialInflight
	}
	bdp := p.rate * p.minRTT.Seconds()
	limit := uint64(2*bdp) + multipathLegMinInflight
	if limit > multipathLegMaxInflight {
		return multipathLegMaxInflight
	}
	return limit
}

// eligible reports whether the leg may take another chunk.
func (p *legPacing) eligible() bool {
	return p.inflight() < p.capacity()
}

// expectedDelay estimates how long a chunk handed to this leg now takes to be
// confirmed: the bare round trip plus the backlog already in front of it. Zero
// means not measured yet.
//
// 估计是拿过去的回执算的，一条刚刚断掉的腿看上去还会很快。所以它手上压着
// 东西、又已经有一阵没见到进展的话，就按「已经等了多久」来算 —— 否则别的腿
// 会一直把分片让给一条死腿。
func (p *legPacing) expectedDelay(now time.Time) time.Duration {
	delay := p.srtt
	if p.minRTT > 0 && p.rate > 0 {
		delay = p.minRTT + time.Duration(float64(p.inflight())/p.rate*float64(time.Second))
	}
	if delay > 0 && p.inflight() > 0 {
		if stuck := now.Sub(p.progressAt); stuck > delay {
			delay = stuck
		}
	}
	return delay
}

// onWritten records a completed data write of n bytes.
func (p *legPacing) onWritten(n uint64, now time.Time) {
	if p.inflight() == 0 {
		p.progressAt = now
	}
	p.sentBytes += n
	// 每隔几毫秒记一个时间点就够量往返时间了，不必每片都记。
	if len(p.marks) < multipathRTTMarks && now.Sub(p.lastMarkAt) >= 2*time.Millisecond {
		p.marks = append(p.marks, rttMark{end: p.sentBytes, at: now})
		p.lastMarkAt = now
	}
}

// onAcked applies the far side's count for this leg, reporting whether it
// moved.
func (p *legPacing) onAcked(bytes uint64, now time.Time) bool {
	if bytes <= p.ackedBytes {
		return false
	}
	delta := bytes - p.ackedBytes
	p.ackedBytes = bytes
	p.progressAt = now

	// 最近一个被覆盖到的时间点给出这一轮的往返时间。
	var sample time.Duration
	consumed := 0
	for consumed < len(p.marks) && p.marks[consumed].end <= bytes {
		sample = now.Sub(p.marks[consumed].at)
		consumed++
	}
	if consumed > 0 {
		p.marks = append(p.marks[:0], p.marks[consumed:]...)
		if sample <= 0 {
			sample = time.Microsecond
		}
		if p.srtt == 0 {
			p.srtt = sample
		} else {
			p.srtt = (7*p.srtt + sample) / 8
		}
		if p.minRTT == 0 || sample < p.minRTT || now.Sub(p.minRTTAt) > multipathMinRTTWindow {
			p.minRTT, p.minRTTAt = sample, now
		}
	}

	// 吞吐取「最近一段的峰值、慢慢衰减」：空闲时段不会把它拉到零，
	// 真的变慢了几个采样周期之后也就跟下来了。
	if p.rateAt.IsZero() {
		p.rateAt = now
		return true
	}
	p.rateBytes += delta
	if elapsed := now.Sub(p.rateAt); elapsed >= multipathRateInterval {
		sampleRate := float64(p.rateBytes) / elapsed.Seconds()
		if decayed := p.rate * 0.8; sampleRate < decayed {
			sampleRate = decayed
		}
		p.rate = sampleRate
		p.rateAt, p.rateBytes = now, 0
	}
	return true
}

// confirmed reports whether the far side has read this chunk's copy off the
// leg it was sent on.
func (e *mpOut) confirmed() bool {
	return e.leg != nil && !e.writing && e.legEnd > 0 && e.legEnd <= e.leg.pace.ackedBytes
}

// mpWork is one thing for a leg writer to do.
type mpWork struct {
	ack     bool
	control []byte
	out     *mpOut
	stop    bool
}

// claim blocks until there is something for this leg's writer to do.
//
// Priority: an acknowledgement, then protocol frames — both tiny and time
// critical, and never held back by the leg's backlog — then chunks being
// resent, lowest sequence first because the receiver is waiting on them, then
// fresh chunks.
func (s *multipathSession) claim(leg *multipathLegConn) mpWork {
	s.mu.Lock()
	defer s.mu.Unlock()
	for {
		if s.closedLocked() || leg.failed.Load() {
			return mpWork{stop: true}
		}
		if s.ackWanted {
			s.ackWanted = false
			return mpWork{ack: true}
		}
		if len(s.control) > 0 {
			frame := s.control[0]
			s.control[0] = nil
			s.control = s.control[1:]
			return mpWork{control: frame}
		}
		if out := s.pickLocked(leg); out != nil {
			now := time.Now()
			if leg.pace.inflight() == 0 {
				leg.pace.progressAt = now
			}
			out.leg, out.writing, out.legEnd, out.claimedAt = leg, true, 0, now
			leg.pace.writingBytes += uint64(len(out.data))
			// 取走一片，队列就腾出了位置：叫醒等着写的一方，也叫醒让过路的腿。
			s.signalLocked()
			return mpWork{out: out}
		}
		leg.pace.parked = true
		changed := s.changed
		s.mu.Unlock()
		select {
		case <-changed:
		case <-s.closed:
		}
		s.mu.Lock()
		leg.pace.parked = false
	}
}

// pickLocked chooses the chunk this leg should send next, or nil if it should
// wait: it is at its backlog limit, there is nothing to send, or an idle leg
// would deliver the chunk sooner.
func (s *multipathSession) pickLocked(leg *multipathLegConn) *mpOut {
	if !leg.pace.eligible() {
		return nil
	}
	if out := s.pickRetryLocked(leg); out != nil {
		return out
	}
	if s.nextFresh >= s.sendSeq || s.betterIdleLegLocked(leg, nil) {
		return nil
	}
	out := s.out[s.nextFresh-s.outBase]
	s.nextFresh++
	return out
}

// pickRetryLocked takes the lowest chunk waiting to be resent that this leg
// should carry, dropping entries the far side has confirmed meanwhile.
//
// A chunk is left alone by the leg that already let it down, as long as some
// other leg is free to take it right now. Only right now: a sibling that is
// busy may be the one that is stuck, and waiting on it would stall the very
// chunk the receiver needs.
func (s *multipathSession) pickRetryLocked(leg *multipathLegConn) *mpOut {
	if len(s.retry) == 0 {
		return nil
	}
	kept := s.retry[:0]
	var picked *mpOut
	for _, seq := range s.retry {
		if seq < s.outBase {
			continue // 对端已经收到了
		}
		out := s.out[seq-s.outBase]
		if out.leg != nil {
			continue // 已经有腿接手了
		}
		if picked == nil && (out.avoid != leg || !s.idleTakerLocked(leg)) {
			picked = out
			continue
		}
		kept = append(kept, seq)
	}
	s.retry = kept
	if picked != nil && s.betterIdleLegLocked(leg, picked.avoid) {
		s.insertRetryLocked(picked.seq)
		return nil
	}
	return picked
}

// betterIdleLegLocked reports whether another leg — other than avoid, which
// already failed to deliver the chunk in question — is idle, has room, and is
// expected to deliver clearly sooner than this one.
func (s *multipathSession) betterIdleLegLocked(leg, avoid *multipathLegConn) bool {
	now := time.Now()
	mine := leg.pace.expectedDelay(now)
	if mine <= 0 {
		return false
	}
	for _, other := range s.legs {
		if other == leg || other == avoid || !other.idleLocked() {
			continue
		}
		theirs := other.pace.expectedDelay(now)
		if theirs > 0 && theirs*multipathPreferDen < mine*multipathPreferNum {
			return true
		}
	}
	return false
}

// idleTakerLocked reports whether some other leg could take a chunk this
// instant.
func (s *multipathSession) idleTakerLocked(leg *multipathLegConn) bool {
	for _, other := range s.legs {
		if other != leg && other.idleLocked() {
			return true
		}
	}
	return false
}

// idleLocked reports whether this leg's writer is waiting for work it would
// be allowed to take.
func (leg *multipathLegConn) idleLocked() bool {
	return !leg.failed.Load() && leg.pace.parked && leg.pace.eligible()
}

// otherLiveLegLocked reports whether any leg but this one can still carry
// traffic.
func (s *multipathSession) otherLiveLegLocked(leg *multipathLegConn) bool {
	for _, other := range s.legs {
		if other != leg && !other.failed.Load() {
			return true
		}
	}
	return false
}

// wrote settles the accounting for one data write.
func (s *multipathSession) wrote(leg *multipathLegConn, out *mpOut, err error) {
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	n := uint64(len(out.data))
	leg.pace.writingBytes -= n
	if err != nil {
		return
	}
	// 字节数一定要记：对端读到这一帧就会算进这条腿，不管这一片后来归谁。
	leg.pace.onWritten(n, now)
	s.lastProgressAt = now
	if out.leg == leg && out.writing {
		out.writing = false
		out.legEnd = leg.pace.sentBytes
	}
}

// requeueLegLocked gives back every chunk a retired leg had not delivered.
func (s *multipathSession) requeueLegLocked(leg *multipathLegConn) int {
	requeued := 0
	for _, out := range s.out {
		if out.leg != leg {
			continue
		}
		if out.confirmed() {
			continue // 这条腿确实送到了，只是前面还有洞，不用重发
		}
		s.requeueLocked(out, leg)
		requeued++
	}
	if requeued > 0 {
		s.signalLocked()
	}
	return requeued
}

// requeueLocked moves one chunk back to the retry queue, remembering the leg
// that let it down.
func (s *multipathSession) requeueLocked(out *mpOut, from *multipathLegConn) {
	out.leg, out.writing, out.legEnd = nil, false, 0
	out.avoid = from
	s.insertRetryLocked(out.seq)
}

// insertRetryLocked adds seq to the retry queue, which stays sorted so the
// chunk the receiver is waiting on longest goes first.
func (s *multipathSession) insertRetryLocked(seq uint64) {
	index := sort.Search(len(s.retry), func(i int) bool { return s.retry[i] >= seq })
	if index < len(s.retry) && s.retry[index] == seq {
		return
	}
	s.retry = append(s.retry, 0)
	copy(s.retry[index+1:], s.retry[index:])
	s.retry[index] = seq
}

// reinjectAfter is how long a chunk may stay unconfirmed on leg before it is
// sent again elsewhere.
func reinjectAfter(leg *multipathLegConn) time.Duration {
	if leg.pace.srtt <= 0 {
		return multipathReinjectUnmeasured
	}
	wait := 3 * leg.pace.srtt
	if wait < multipathReinjectMin {
		return multipathReinjectMin
	}
	return wait
}

// reinjectOverdueLocked sends again, on some other leg, every chunk whose leg
// has sat on it too long. The original copy may still arrive; the receiver
// keeps whichever lands first.
//
// At most multipathReinjectBurst chunks go per call, lowest first: those are
// the ones the receiver is stuck on, and a leg that is merely having a latency
// spike should not get its whole backlog duplicated onto its siblings.
func (s *multipathSession) reinjectOverdueLocked(now time.Time) int {
	reinjected := 0
	for _, out := range s.out {
		if reinjected >= multipathReinjectBurst {
			break
		}
		leg := out.leg
		if leg == nil || out.confirmed() || !s.otherLiveLegLocked(leg) {
			continue
		}
		if now.Sub(out.claimedAt) < reinjectAfter(leg) {
			continue
		}
		s.requeueLocked(out, leg)
		reinjected++
	}
	if reinjected > 0 {
		s.signalLocked()
	}
	return reinjected
}

// silentLegsLocked lists legs that hold unconfirmed data and have not shown
// the far side receiving any of it for the stall timeout, while other legs
// have. Every leg silent together is a problem with the far side, not with a
// leg, and retiring them all would not help.
func (s *multipathSession) silentLegsLocked(now time.Time) []*multipathLegConn {
	limit := time.Duration(s.legStallTimeout.Load())
	var silent []*multipathLegConn
	for _, leg := range s.legs {
		if leg.failed.Load() || leg.pace.inflight() == 0 {
			continue
		}
		if now.Sub(leg.pace.progressAt) < limit {
			continue
		}
		if !s.lastLegProgressAt.After(leg.pace.progressAt) {
			continue // 大家都没动：这是对端的问题，不是这条腿坏了
		}
		silent = append(silent, leg)
	}
	return silent
}
