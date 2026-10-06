package main

// multipathSession presents several parallel legs as one ordered frame stream.
//
// It satisfies the same writeFrame/readFrame contract as a single secureConn,
// so the existing copy loops relay a multipath session without knowing that the
// bytes are spread over more than one link.

import (
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"
)

// frameConn is the frame transport the FXP copy loops relay over. Both a plain
// secureConn and a multipathSession implement it.
type frameConn interface {
	writeFrame(plain []byte) error
	readFrame() ([]byte, error)
	// closeTransport tears down the underlying connections.
	closeTransport()
}

var (
	errMultipathLegSilent    = errors.New("multipath leg stopped delivering while its siblings kept going")
	errMultipathDuplicateLeg = errors.New("multipath session already has a leg with this id")
)

// multipathLegConn is one secure link of a multipath session.
type multipathLegConn struct {
	// index identifies the leg to both ends: it is the leg's position in the
	// entry's configuration, carried to the exit in the hello. The per-leg
	// counts in an acknowledgement are keyed by it.
	index int
	sec   *secureConn
	// label identifies the leg in logs, e.g. "direct" or a relay address.
	label string
	// healthKey is the endpoint this leg was dialled at, on the entry side,
	// so its fate feeds multipathLegHealthMemory. Empty at the exit.
	healthKey string
	// failed guards the alive-leg count: a leg's reader and its writer both
	// notice the same breakage, and only the first may retire the leg.
	failed atomic.Bool
	// dead is closed once the leg is retired or its session ends.
	dead     chan struct{}
	deadOnce sync.Once

	// recvBytes counts the data bytes read off this leg, duplicates included:
	// it has to match what the far side counts as written.
	recvBytes atomic.Uint64
	// pace is the sending side's view of this leg. Guarded by the session lock.
	pace legPacing

	// writeStartedAt is when this leg's writer entered its current write, in
	// unix nanoseconds, or zero when it is not writing. progressAtWrite is the
	// session's write counter as that write began. Together they let the
	// watchdog tell a leg that has stopped from legs that are all held up by
	// the same backpressure.
	writeStartedAt  atomic.Int64
	progressAtWrite atomic.Uint64
	// deadlineArmed is set when the watchdog has cut a write short. The writer
	// clears it before its next write, because the watchdog can land on a
	// write that was already finishing and a leftover deadline would then fail
	// the following write on a leg that is perfectly healthy.
	deadlineArmed atomic.Bool
	// writeMu keeps the bookkeeping above matched to one write at a time.
	writeMu sync.Mutex
}

// newMultipathLeg wraps one handshaked connection as a leg.
func newMultipathLeg(index int, sec *secureConn, label string) *multipathLegConn {
	return &multipathLegConn{index: index, sec: sec, label: label, dead: make(chan struct{})}
}

// retire marks the leg as finished for anyone waiting on it.
func (leg *multipathLegConn) retire() {
	leg.deadOnce.Do(func() { close(leg.dead) })
}

// clearStaleDeadline undoes a write deadline the watchdog set on a write that
// turned out to be finishing anyway. It costs one atomic load per frame in the
// normal case, where nothing was ever armed.
func (leg *multipathLegConn) clearStaleDeadline() {
	if leg.deadlineArmed.CompareAndSwap(true, false) {
		_ = leg.sec.conn.SetWriteDeadline(time.Time{})
	}
}

type multipathSession struct {
	reorder *reorderBuffer

	// mu guards the sending side, the leg list and every leg's pace. changed
	// is closed and replaced on every change a waiter may care about, so
	// waiters can select on it alongside a timer or the session closing.
	mu       sync.Mutex
	changed  chan struct{}
	legs     []*multipathLegConn
	isClosed bool

	// The retransmit buffer: out[i] is chunk outBase+i, and it holds every
	// chunk from the first one the far side has not confirmed up to sendSeq.
	// Chunks from nextFresh on have never been claimed by a leg; retry lists,
	// in order, the ones handed back by a leg that failed to deliver them.
	sendSeq   uint64
	nextFresh uint64
	outBase   uint64
	out       []*mpOut
	retry     []uint64

	// peerDelivered and peerWindow are the far side's flow control: this side
	// may not run more than peerWindow chunks past peerDelivered.
	peerDelivered uint64
	peerWindow    uint64

	// lastAckAt is when the far side last said anything; lastProgressAt when a
	// write last completed; lastLegProgressAt when any leg last showed the far
	// side receiving from it.
	lastAckAt         time.Time
	lastProgressAt    time.Time
	lastLegProgressAt time.Time

	// ackWanted asks the next free writer to send an acknowledgement; control
	// holds the other protocol frames waiting for one.
	ackWanted bool
	control   [][]byte

	// The end of the stream: finSeq is the total chunk count, and the fin is
	// repeated until the far side acknowledges it along with every chunk.
	finQueued bool
	finAcked  bool
	finSeq    uint64
	finSentAt time.Time

	// Receiving side bookkeeping for acknowledgements (multipath_flow.go).
	recvTotal      atomic.Uint64
	ackedRecvTotal atomic.Uint64
	ackedDelivered atomic.Uint64
	lastRecvAt     atomic.Int64
	lastAckSentAt  atomic.Int64
	ackTimerArmed  atomic.Bool

	// writeProgress counts frames successfully written on any leg. The
	// watchdog compares it against a leg's own snapshot to tell "this leg has
	// stopped" from "every leg is held up by the same backpressure".
	writeProgress atomic.Uint64

	// legStallTimeout, legStallCheck and sendStallTimeout hold the watchdog's
	// constants, in nanoseconds. They are fields rather than constants so the
	// tests can reach the edge in milliseconds; production never moves them.
	legStallTimeout  atomic.Int64
	legStallCheck    atomic.Int64
	sendStallTimeout atomic.Int64

	// aliveLegs drops as legs fail; reaching zero fails the session.
	aliveLegs atomic.Int64

	// coalesceLimit is multipathCoalesceTarget, as a field so tests that count
	// chunks can switch coalescing off. Guarded by mu.
	coalesceLimit int

	closeOnce sync.Once
	closed    chan struct{}
	finOnce   sync.Once

	errMu    sync.Mutex
	firstErr error
}

// newMultipathSession starts the writer and reader goroutines for the legs.
// More legs can join later through addLeg.
//
// The caller keeps ownership of the underlying connections only for closing;
// all reads and writes go through the session from here on.
func newMultipathSession(legs []*multipathLegConn, maxPending int) *multipathSession {
	now := time.Now()
	session := &multipathSession{
		reorder:       newReorderBuffer(maxPending),
		changed:       make(chan struct{}),
		closed:        make(chan struct{}),
		peerWindow:    multipathInitialWindow,
		lastAckAt:     now,
		coalesceLimit: multipathCoalesceTarget,
	}
	session.legStallTimeout.Store(int64(multipathLegStallTimeout))
	session.legStallCheck.Store(int64(multipathLegStallCheck))
	session.sendStallTimeout.Store(int64(multipathSendStallTimeout))
	session.lastAckSentAt.Store(now.UnixNano())
	session.reorder.onDeliver = session.ackDelivery
	for _, leg := range legs {
		if !session.addLeg(leg) {
			_ = leg.sec.conn.Close()
		}
	}
	// 窗口必须**先**报出去：对端还没收到回执的时候只敢按起步窗口写，等到
	// 第一次交付再报就晚了。
	session.queueAck()
	go session.housekeeping()
	return session
}

// addLeg attaches one more leg to a running session, reporting false if the
// session is already over or has a leg with that id. The caller closes a leg
// that was refused.
func (s *multipathSession) addLeg(leg *multipathLegConn) bool {
	s.mu.Lock()
	if s.closedLocked() {
		s.mu.Unlock()
		return false
	}
	if len(s.legs) >= multipathMaxLegs {
		s.mu.Unlock()
		return false
	}
	for _, existing := range s.legs {
		if existing.index == leg.index {
			s.mu.Unlock()
			return false
		}
	}
	if leg.dead == nil {
		leg.dead = make(chan struct{})
	}
	leg.pace.progressAt = time.Now()
	s.legs = append(s.legs, leg)
	s.aliveLegs.Add(1)
	s.signalLocked()
	s.mu.Unlock()
	go s.legWriter(leg)
	go s.legReader(leg)
	return true
}

// legCount reports how many legs have joined the session.
func (s *multipathSession) legCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.legs)
}

// aliveLegCount reports how many legs are still carrying traffic.
func (s *multipathSession) aliveLegCount() int {
	count := s.aliveLegs.Load()
	if count < 0 {
		return 0
	}
	return int(count)
}

// legSnapshot copies the current leg list.
func (s *multipathSession) legSnapshot() []*multipathLegConn {
	s.mu.Lock()
	defer s.mu.Unlock()
	legs := make([]*multipathLegConn, len(s.legs))
	copy(legs, s.legs)
	return legs
}

func (s *multipathSession) legByIDLocked(id int) *multipathLegConn {
	for _, leg := range s.legs {
		if leg.index == id {
			return leg
		}
	}
	return nil
}

// legBytes reports the data bytes each leg has carried outbound, for logging
// the realised split.
func (s *multipathSession) legBytes() []uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]uint64, len(s.legs))
	for i, leg := range s.legs {
		out[i] = leg.pace.sentBytes
	}
	return out
}

func (s *multipathSession) closedLocked() bool {
	return s.isClosed
}

// signalLocked wakes everything waiting on the session's state.
func (s *multipathSession) signalLocked() {
	close(s.changed)
	s.changed = make(chan struct{})
}

// maxQueuedLocked bounds the chunks accepted from the local reader that no leg
// has claimed yet. Beyond it writeFrame blocks, which is how backpressure
// reaches the connection being relayed.
func (s *multipathSession) maxQueuedLocked() uint64 {
	limit := uint64(2 * s.aliveLegCount())
	if limit < 4 {
		limit = 4
	}
	return limit
}

func (s *multipathSession) setErr(err error) {
	if err == nil {
		return
	}
	s.errMu.Lock()
	if s.firstErr == nil {
		s.firstErr = err
	}
	s.errMu.Unlock()
}

func (s *multipathSession) err() error {
	s.errMu.Lock()
	defer s.errMu.Unlock()
	return s.firstErr
}

// legWriter sends whatever claim hands this leg until the leg or the session
// is done.
func (s *multipathSession) legWriter(leg *multipathLegConn) {
	for {
		work := s.claim(leg)
		switch {
		case work.stop:
			return
		case work.ack:
			if err := s.writeLegFrame(leg, s.buildAck()); err != nil {
				s.queueAck()
				s.legFailed(leg, err)
				return
			}
		case work.control != nil:
			if err := s.writeLegFrame(leg, work.control); err != nil {
				// 协议帧还回队列让别的腿带走。
				s.sendControl(work.control)
				s.legFailed(leg, err)
				return
			}
		default:
			out := work.out
			err := s.writeLegFrame(leg, encodeMultipathFrame(multipathKindData, out.seq, out.data))
			s.wrote(leg, out, err)
			if err != nil {
				// 这一片连同这条腿上所有没确认送到的，都会在 legFailed 里交给
				// 别的腿。接收端按序号去重，写了一半的那份也无妨。
				s.legFailed(leg, err)
				return
			}
		}
	}
}

// writeLegFrame writes one frame to one leg.
//
// Every write to a leg goes through here, because a write that is not recorded
// is a write the watchdog cannot see — and an unseen write on a leg whose far
// side has stopped reading never returns.
func (s *multipathSession) writeLegFrame(leg *multipathLegConn, frame []byte) error {
	leg.writeMu.Lock()
	defer leg.writeMu.Unlock()
	leg.clearStaleDeadline()
	leg.progressAtWrite.Store(s.writeProgress.Load())
	leg.writeStartedAt.Store(time.Now().UnixNano())
	err := leg.sec.writeFrame(frame)
	leg.writeStartedAt.Store(0)
	if err == nil {
		s.writeProgress.Add(1)
	}
	return err
}

// watchStalledLegs retires any leg whose write has stopped moving while the
// other legs carry on. It is one pass; housekeeping calls it on every tick.
//
// 一条腿「还连着但对端不再读」的时候，它的写入者会永远卡在 Write 里。
// 判据是**不对称**：所有腿一起堵着是正常的背压，谁都不该动；只有别的腿还在往前
// 走、就这一条一动不动，才说明它已经废了。掐断那次写，写入者拿到超时错误，
// 走正常的下线流程 —— 它名下没送到的分片全部交给别的腿。
func (s *multipathSession) watchStalledLegs() {
	limit := time.Duration(s.legStallTimeout.Load())
	for _, leg := range s.legSnapshot() {
		startedAt := leg.writeStartedAt.Load()
		if startedAt == 0 || leg.failed.Load() {
			continue
		}
		if time.Since(time.Unix(0, startedAt)) < limit {
			continue
		}
		if s.writeProgress.Load() == leg.progressAtWrite.Load() {
			continue // 大家都没动：这是背压，不是这条腿坏了
		}
		fxpVerbosef("multipath leg %d (%s) stopped draining, retiring it", leg.index, leg.label)
		leg.deadlineArmed.Store(true)
		_ = leg.sec.conn.SetWriteDeadline(time.Now())
	}
}

// busy reports whether anything is outstanding in either direction, which is
// when housekeeping needs its fine clock.
func (s *multipathSession) busy(now time.Time) bool {
	if now.Sub(time.Unix(0, s.lastRecvAt.Load())) < multipathAckHot {
		return true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.outBase < s.sendSeq || (s.finQueued && !s.finAcked)
}

// housekeeping runs the session's periodic jobs on one timer.
//
// 一个会话对应一条客户端连接，出口上可能同时有成千上万条 —— 每条多开一个协程
// 加一个定时器都是要算的，所以这几件事合在一个节拍里做；没有在途数据的时候
// 节拍自动放慢。
func (s *multipathSession) housekeeping() {
	for {
		tick := time.Duration(s.legStallCheck.Load())
		if s.busy(time.Now()) && multipathBusyTick < tick {
			tick = multipathBusyTick
		}
		timer := time.NewTimer(tick)
		select {
		case <-s.closed:
			timer.Stop()
			return
		case <-timer.C:
		}
		now := time.Now()
		s.watchStalledLegs()
		s.maintainSender(now)
		s.refreshAcks(now)
	}
}

// maintainSender makes the sending side's timed decisions: retiring legs that
// went silent, resending what sat unconfirmed too long, and repeating an
// unacknowledged fin.
func (s *multipathSession) maintainSender(now time.Time) {
	s.mu.Lock()
	silent := s.silentLegsLocked(now)
	s.reinjectOverdueLocked(now)
	if s.finQueued && !s.finAcked && !s.closedLocked() && now.Sub(s.finSentAt) >= s.finRetryLocked() {
		s.queueFinLocked(now)
	}
	s.mu.Unlock()
	for _, leg := range silent {
		fxpVerbosef("multipath leg %d (%s) has delivered nothing while its siblings did, retiring it", leg.index, leg.label)
		s.legFailed(leg, errMultipathLegSilent)
	}
}

// finRetryLocked is how long an unacknowledged fin waits before it is sent
// again: long enough for the fastest live leg to have answered.
func (s *multipathSession) finRetryLocked() time.Duration {
	var fastest time.Duration
	for _, leg := range s.legs {
		if leg.failed.Load() || leg.pace.srtt <= 0 {
			continue
		}
		if fastest == 0 || leg.pace.srtt < fastest {
			fastest = leg.pace.srtt
		}
	}
	if fastest == 0 {
		return multipathReinjectUnmeasured
	}
	if wait := 3 * fastest; wait > multipathReinjectMin {
		return wait
	}
	return multipathReinjectMin
}

func (s *multipathSession) queueFinLocked(now time.Time) {
	s.control = append(s.control, encodeMultipathFrame(multipathKindFin, s.finSeq, nil))
	s.finSentAt = now
	s.signalLocked()
}

// sendControl queues a protocol frame for whichever leg writer is free first.
func (s *multipathSession) sendControl(frame []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closedLocked() {
		return
	}
	s.control = append(s.control, frame)
	s.signalLocked()
}

// legFailed retires one leg, failing the whole session once none are left.
//
// A broken leg surfaces to both its reader and its writer, so the count is only
// adjusted by whichever notices first. Whatever the leg had not delivered goes
// back to the queue at once, for the surviving legs to carry.
func (s *multipathSession) legFailed(leg *multipathLegConn, err error) {
	_ = leg.sec.conn.Close()
	if !leg.failed.CompareAndSwap(false, true) {
		return
	}
	leg.retire()
	s.mu.Lock()
	requeued := s.requeueLegLocked(leg)
	closing := s.closedLocked()
	s.signalLocked()
	s.mu.Unlock()
	alive := s.aliveLegs.Add(-1)
	if closing {
		return // 会话自己在收场，腿是它关的
	}
	// 对端已经把流发完了，它那边收场关掉腿是正常的，不记账。
	if leg.healthKey != "" && !s.reorder.finished() {
		multipathLegHealthMemory.failed(leg.healthKey)
	}
	if alive > 0 {
		fxpVerbosef("multipath leg %d (%s) lost, %d remaining, %d chunks handed to them: %v",
			leg.index, leg.label, s.aliveLegCount(), requeued, err)
		return
	}
	s.setErr(err)
	s.closeWith(err)
}

// legReader feeds everything arriving on one leg into the reorder buffer.
func (s *multipathSession) legReader(leg *multipathLegConn) {
	for {
		frame, err := leg.sec.readFrame()
		if err != nil {
			s.legFailed(leg, err)
			return
		}
		decoded, decodeErr := decodeMultipathFrame(frame)
		if decodeErr != nil {
			s.setErr(decodeErr)
			s.closeWith(decodeErr)
			return
		}
		switch decoded.kind {
		case multipathKindFin:
			// The fin may arrive on several legs and more than once; the first
			// one ends the stream and the rest are redundant. The ack that
			// confirms it goes back straight away, because the far side is
			// waiting on exactly that before it can let go of the session.
			s.reorder.setFinal(decoded.seq)
			s.requestAck(true)
			continue
		case multipathKindAck:
			ack, ackErr := decodeMultipathAck(decoded.seq, decoded.payload)
			if ackErr != nil {
				s.setErr(ackErr)
				s.closeWith(ackErr)
				return
			}
			s.onAck(ack)
			continue
		}
		if len(decoded.payload) > multipathMaxChunkPayload {
			err := fmt.Errorf("%w: %d bytes", errMultipathChunkLarge, len(decoded.payload))
			s.setErr(err)
			s.closeWith(err)
			return
		}
		size := uint64(len(decoded.payload))
		leg.recvBytes.Add(size)
		total := s.recvTotal.Add(size)
		if err := s.reorder.push(decoded.seq, decoded.payload); err != nil {
			if errors.Is(err, errMultipathReorderGap) {
				// 重排缓冲放弃等那一片了。整条会话跟着带原因收掉，上层重连，
				// 而不是让两端各自挂着一条永远拼不完的流。
				s.closeWith(err)
			}
			return
		}
		s.noteReceived(total)
	}
}

// multipathCoalesceTarget is how large a queued chunk may grow by absorbing
// the writes that follow it while no leg has claimed it yet.
//
// 分片的大小是复制循环一次 Read 读到多少：出口从目标读、入口从客户端读，内核
// 里攒着多少就给多少。读得勤的时候一次常常只有一两个 TCP 段（一两千字节），
// 于是一片就只有一两千字节。窗口、重排缓冲上限都是按**片数**记的（1024 片），
// 小片的时候整个窗口才一两兆：往返 200ms 的线路上这就把整条会话钉在几十兆。
// 每片还各付一份帧头、系统调用和回执。
//
// 所以腿都忙着的时候，后面的写并进队尾那片还没被认领的分片里，凑到和复制循环
// 的读缓冲一样大（64 KiB）为止。腿空着的时候分片立刻就被领走，并不进去，
// 小流量照旧一来一片、不多等。合并只改分片的大小，不改任何线上格式。
const multipathCoalesceTarget = fxpCopyChunkSize

// writeFrame queues one outbound chunk, or ends the stream when given no data.
//
// It blocks while the far side's window is closed or every leg is busy, which
// is how backpressure reaches the reader on the other side of the proxy.
func (s *multipathSession) writeFrame(plain []byte) error {
	if len(plain) == 0 {
		return s.writeFin()
	}
	// 快路径：队尾那片还没有腿认领，这次写直接并进去，既不占序号也不占窗口。
	s.mu.Lock()
	if s.coalesceLocked(plain) {
		s.mu.Unlock()
		return nil
	}
	s.mu.Unlock()
	// The copy loops reuse their read buffer, so the chunk must be copied
	// before it is handed to a leg writer running on another goroutine.
	data := make([]byte, len(plain))
	copy(data, plain)
	err := s.lockWhen(func() bool {
		return s.sendSeq < s.peerDelivered+s.peerWindow && s.sendSeq-s.nextFresh < s.maxQueuedLocked()
	})
	if err != nil {
		s.setErr(err)
		if !errors.Is(err, errMultipathClosed) {
			s.closeWith(err)
		}
		return s.closedErr()
	}
	defer s.mu.Unlock()
	if s.finQueued {
		return errors.New("multipath write after end of stream")
	}
	// 等窗口的这段时间里腿只会认领分片，不会添分片，所以队尾那片要是还在，
	// 它一定是刚才那一片；再试一次合并，省掉一个序号。
	if s.coalesceLocked(plain) {
		return nil
	}
	s.out = append(s.out, &mpOut{seq: s.sendSeq, data: data})
	s.sendSeq++
	s.signalLocked()
	return nil
}

// coalesceLocked appends plain to the newest queued chunk when no leg has
// claimed that chunk yet and the result stays within multipathCoalesceTarget.
// It reports whether the write was absorbed.
//
// 只并进从没被认领过的分片（序号不小于 nextFresh）：被腿退回来重发的那些序号
// 已经在 nextFresh 之前，对端可能已经收到过它原来的内容，不能再改。
func (s *multipathSession) coalesceLocked(plain []byte) bool {
	if s.closedLocked() || s.finQueued || s.coalesceLimit <= 0 || s.nextFresh >= s.sendSeq {
		return false
	}
	out := s.out[len(s.out)-1]
	if out.seq < s.nextFresh || out.leg != nil || out.writing {
		return false
	}
	if len(out.data)+len(plain) > s.coalesceLimit {
		return false
	}
	out.data = append(out.data, plain...)
	return true
}

// writeFin announces the total chunk count and waits until the far side has
// acknowledged it along with every chunk before it.
//
// 结束标记本身不占任何腿：它排进协议帧队列，哪条腿先空就由哪条腿带走，一条腿
// 还连着但对端不再读的时候也挡不住它。丢了就按最快那条腿的往返时间重发，
// 直到对端回执说「全收到了」—— 在那之前会话不能关，重传缓冲里的东西还要用。
func (s *multipathSession) writeFin() error {
	s.finOnce.Do(func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.closedLocked() {
			return
		}
		s.finQueued = true
		s.finSeq = s.sendSeq
		s.queueFinLocked(time.Now())
	})
	err := s.lockWhen(func() bool { return s.finAcked })
	if err == nil {
		s.mu.Unlock()
		return nil
	}
	s.mu.Lock()
	delivered := s.finQueued && s.outBase >= s.finSeq
	s.mu.Unlock()
	if delivered {
		// 数据对端全收到了，只是最后那声回执没赶上会话收场。
		return nil
	}
	if errors.Is(err, errMultipathSendStalled) {
		s.setErr(err)
		s.closeWith(err)
		return err
	}
	return s.closedErr()
}

// readFrame returns the next chunk in sequence order across all legs. It
// returns an empty, non-nil slice at end of stream, matching secureConn.
func (s *multipathSession) readFrame() ([]byte, error) {
	return s.reorder.pop()
}

func (s *multipathSession) closedErr() error {
	if err := s.err(); err != nil {
		return err
	}
	return errMultipathClosed
}

// closeWith tears the session down once, waking everything blocked on it.
func (s *multipathSession) closeWith(reason error) {
	s.closeOnce.Do(func() {
		s.setErr(reason)
		s.mu.Lock()
		s.isClosed = true
		close(s.closed)
		s.signalLocked()
		legs := make([]*multipathLegConn, len(s.legs))
		copy(legs, s.legs)
		s.mu.Unlock()
		alive := s.aliveLegCount()
		s.reorder.close(reason)
		for _, leg := range legs {
			// 正常收场时还活着的腿，说明它这一整个会话都好好的。
			if reason == nil && leg.healthKey != "" && !leg.failed.Load() {
				multipathLegHealthMemory.healthy(leg.healthKey)
			}
			_ = leg.sec.conn.Close()
			leg.retire()
		}
		// 收场时把实际跑出来的分流记一笔。overdrafts 非零说明各条腿的到达
		// 顺序比重排上限能容下的还散。
		fxpVerbosef(
			"multipath session closed: legs=%d/%d bytes=%v overdrafts=%d reason=%v",
			alive, len(legs), s.legBytes(), s.reorder.overdraftCount(), reason,
		)
	})
}

// closeTransport satisfies frameConn.
func (s *multipathSession) closeTransport() {
	s.closeWith(nil)
}

// closeTransport lets a plain secure connection stand in for a multipath one.
func (c *secureConn) closeTransport() {
	_ = c.conn.Close()
}

// multipathLegsFromSecureConns builds legs from already handshaked connections,
// numbering them by position.
func multipathLegsFromSecureConns(conns []*secureConn, labels []string) []*multipathLegConn {
	legs := make([]*multipathLegConn, 0, len(conns))
	for i, sec := range conns {
		label := fmt.Sprintf("leg-%d", i)
		if i < len(labels) {
			label = labels[i]
		}
		legs = append(legs, newMultipathLeg(i, sec, label))
	}
	return legs
}
