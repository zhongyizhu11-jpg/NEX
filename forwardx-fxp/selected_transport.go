package main

import (
	"errors"
	"fmt"
	"log"
	"net"
	"sync"
	"time"
)

const (
	// 有备选出口时，流水线握手的确认最多等这么久就换下一个。确认只取决于
	// 下一跳本身（不等目标），正常一个往返就回来了。
	fxpPipelinedAckFast = 4 * time.Second
	// 确认到来之前，已经发出去的内容最多缓存这么多，用来换出口时重放。
	// 超过了就放弃透明切换，这条连接跟着当前出口走到底。
	fxpReplayBufferMax = 256 * 1024
	/*
		等出口回「连上目标没有」至少等这么久（路线图 X11）：出口拨目标的时限（fxpTargetDialTimeoutDefault，4 秒，
		出口解析目标域名也算在里面）再加 2 秒余量。只等 4 秒的话，「目标连接超时」的结果和入口的超时撞在一起，
		会被错当成出口的问题。入口实际等的还要加上量到的到这台出口的往返（targetStatusWaitFor）：结果帧要走一趟回程，
		往返长的线路上它晚到是常态，不能当成没回。以前这一帧没有截止时间：出口握手正常、之后卡住（进程挂起、
		回程黑洞），入口就无限期等下去。
	*/
	fxpTargetStatusWait = fxpTargetDialTimeoutDefault + fxpTargetProbeReplyGrace
)

// targetStatusWaitFor：hello 发出去之后最多等多久出口的结果帧 —— fxpTargetStatusWait 加上量到的到这台出口的握手耗时
// （exit_load.go 的 latency；按 fxpPipelinedAckFast 封顶，量歪了也不至于等太久）。
func targetStatusWaitFor(load *fxpHostLoad) time.Duration {
	rtt := load.latencyEstimate()
	if rtt > fxpPipelinedAckFast {
		rtt = fxpPipelinedAckFast
	}
	return fxpTargetStatusWait + rtt
}

/*
selectedTransport 是入口（和中转）到下一跳的一条会话连接，负责三件事：

 1. 挑端点：走出口选择器的健康、分档和策略。
 2. 省往返：优先从连接池取一条预热好的；池里没有就现拨 TCP，握手不等确认，
    跟 hello 和首包一起发出去（流水线握手）。
 3. 保透明切换：流水线握手的连接在收到确认之前，发出去的每一帧都留一份。
    确认失败（黑洞、拒绝、断开）就换下一个端点，把这些帧原样重放。以前
    「等到确认才发 hello」天然就能切，现在不等了，靠这份缓存把能力补回来。
*/
type selectedTransport struct {
	selector     *exitEndpointSelector
	cfg          config
	selectionKey string
	// sessionAffinity：叠加会话 id。非空时按它挑出口，保证同一会话的各条腿落在同一台出口上。
	sessionAffinity string

	mu        sync.Mutex
	conn      net.Conn
	sec       *secureConn
	endpoint  exitEndpoint
	index     int
	attempted map[int]bool
	// committed：这条会话不会再换出口了 —— 握手确认过（池里的连接天生如此），而且要等的「连目标的结果」
	// 也到了（见 target_health.go）。之前发出去的内容都留在 replay 里，换出口时重放。
	committed bool
	// acked：握手确认过了。statusPending：还在等出口回「连上目标没有」（只对会回报的出口等）。
	acked         bool
	statusPending bool
	// wantStatus：这条会话的 hello 带了 targetStatus（入口有几台会回报的出口时）。
	wantStatus  bool
	replay      [][]byte
	replayBytes int
	overflow    bool
	closed      bool
	// load 是当前端点所在主机的负载记账（exit_load.go）：这条会话算它的一个活动连接，收发的字节记到它头上。
	load *fxpHostLoad
	// statusDeadline：等「连目标的结果」最晚等到什么时候（hello 发出去时起算，见 targetStatusWaitFor）。
	statusDeadline time.Time
}

func newSelectedTransport(selector *exitEndpointSelector, cfg config, selectionKey string) *selectedTransport {
	return &selectedTransport{selector: selector, cfg: cfg, selectionKey: selectionKey, index: -1, attempted: map[int]bool{}}
}

// connect 挑一个端点并拿到连接，还不发送任何东西（池里的连接除外，它早已握完手）。
func (t *selectedTransport) connect() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.connectLocked()
}

func (t *selectedTransport) connectLocked() error {
	if t.selector == nil || t.selector.count() == 0 {
		return errors.New("no exit endpoints")
	}
	var lastErr error
	for len(t.attempted) < t.selector.count() {
		var (
			endpoint exitEndpoint
			index    int
			ok       bool
		)
		if t.sessionAffinity != "" {
			endpoint, index, ok = t.selector.pickSessionAffinity(t.attempted, t.sessionAffinity)
		} else {
			endpoint, index, ok = t.selector.pick(t.attempted, t.selectionKey)
		}
		if !ok {
			break
		}
		t.attempted[index] = true
		dialCfg := t.cfg
		if endpoint.Key != "" {
			dialCfg.Key = endpoint.Key
		}
		endpointLabel := connStatsEndpoint(endpoint.Host, endpoint.Port)
		if v3Enabled(dialCfg) {
			if t.selector.count() > 1 {
				/*
					有别的出口可换：现拨的物理连接握手最多等 fxpPipelinedAckFast 就换下一个，和 V1 一样。等不到
					结果帧只算一次「可疑」（不当场判坏），黑洞了的出口在判坏之前还会再被挑中一次；那一次的
					复用会话已经被收回（retireV3SessionsLocked），要现拨 —— 等满 10 秒就太久了。
				*/
				dialCfg.v3HandshakeTimeout = fxpPipelinedAckFast
			}
			done, err := t.connectV3Locked(endpoint, index, dialCfg, endpointLabel)
			if done {
				return err
			}
			lastErr = err
			continue
		}
		if conn, sec, ok := t.selector.states[index].take(dialCfg); ok {
			// 命中 / 没命中都记一笔：以前只有多路那条腿（dialSecureTCP）记，普通入口这条路看不出池子用上没有
			fxpMetricAdd(dialCfg, "pool_hit", 1)
			recordConnStage(t.cfg, t.cfg.TunnelID, t.cfg.RuleID, t.cfg.Role, "pool", endpointLabel, 0, nil)
			t.useLocked(conn, sec, endpoint, index, true)
			return nil
		}
		fxpMetricAdd(dialCfg, "pool_miss", 1)
		dialStarted := time.Now()
		conn, err := dialNextHop(endpoint.Host, endpoint.Port, secureDialTimeout(dialCfg), dialCfg)
		recordConnStage(t.cfg, t.cfg.TunnelID, t.cfg.RuleID, t.cfg.Role, nextHopDialStage(dialCfg), endpointLabel, time.Since(dialStarted), err)
		if err != nil {
			lastErr = err
			// 没拨通：挑中时记在负载里的那一条退回去（exit_load.go 的 notePick / unpick）。
			t.selector.unpick(index)
			t.selector.markFailure(index, err)
			continue
		}
		sec, err := newPipelinedClientSecureConn(conn, dialCfg, fxpWireCurrent)
		if err != nil {
			_ = conn.Close()
			t.selector.unpick(index)
			lastErr = err
			continue
		}
		if t.selector.count() > 1 {
			sec.ackTimeout = fxpPipelinedAckFast
		}
		ackIndex := index
		sec.onAck = func(err error) {
			// 连接被我们自己关掉（客户端先走了）不算下一跳的失败。
			if err == nil || !isClosedErr(err) {
				recordConnStage(t.cfg, t.cfg.TunnelID, t.cfg.RuleID, t.cfg.Role, "handshake", endpointLabel, time.Since(dialStarted), err)
			}
			if err == nil {
				t.selector.observeLatency(ackIndex, time.Since(dialStarted))
			}
			t.handleAck(sec, ackIndex, err)
		}
		t.useLocked(conn, sec, endpoint, index, false)
		// 这条连接已经有着落了，顺手派一次后台探测去看看掉线的那些回来没有 ——
		// 探测的等待由后台协程扛，不占用户的时间。
		t.selector.probeFailedEndpoint(dialCfg)
		return nil
	}
	if lastErr == nil {
		lastErr = errors.New("no exit endpoint available")
	}
	return lastErr
}

// connectV3Locked 用 V3 拿一条到这个端点的连接。V3 的握手是同步做完的：拿到连接时对端的
// 身份已经验过（模式 3 / 5 验了服务端的证明，模式 4 验了钉死的 TLS 证书），不需要重放缓存。
// done 为 true 表示这一轮到此为止（成功，或者是换端点也没用的本地错误）。
func (t *selectedTransport) connectV3Locked(endpoint exitEndpoint, index int, dialCfg config, endpointLabel string) (bool, error) {
	started := time.Now()
	conn, sec, reused, err := dialV3Transport(t.selector.states[index], endpoint.Host, endpoint.Port, dialCfg)
	stage := "handshake"
	if reused {
		stage = "pool"
	}
	if err == nil || !isClosedErr(err) {
		recordConnStage(t.cfg, t.cfg.TunnelID, t.cfg.RuleID, t.cfg.Role, stage, endpointLabel, time.Since(started), err)
	}
	if err != nil {
		t.selector.unpick(index)
		if !v3EndpointFailureIsRetryable(err) {
			return true, err
		}
		t.selector.markFailure(index, err)
		return false, err
	}
	if !reused {
		// 新拨的物理连接握手做完了，才是「它活着」的证据。借来的（预热连接、复用会话里新开的逻辑流）什么都没证明：
		// 开一个逻辑流只是往本地队列里放一个 OPEN 帧，出口已经黑洞了照样成功。以前借来的也 markHealthy ——
		// 上一条连接刚因为「出口不回话」把它判坏，下一条连接一来又把它改回健康，接着撞上去再等 6 秒（阶段 2）。
		t.selector.observeLatency(index, time.Since(started))
		t.selector.markHealthy(index)
	}
	t.useLocked(conn, sec, endpoint, index, true)
	t.selector.probeFailedEndpoint(dialCfg)
	return true, nil
}

func (t *selectedTransport) useLocked(conn net.Conn, sec *secureConn, endpoint exitEndpoint, index int, committed bool) {
	t.conn = conn
	t.sec = sec
	t.endpoint = endpoint
	t.index = index
	t.acked = committed
	// 这台出口会回「连上目标没有」时，结果到之前都不算提交：内容留着，连不上就换下一台重放。
	t.statusPending = t.wantStatus && t.selector.endpointReportsTarget(index)
	t.committed = committed && !t.statusPending
	if t.committed {
		// 重放缓存先留着：失败切换时 failoverLocked 还要把它写到这条新连接上，写完才丢。
		sec.commitSession()
	}
	// 换了端点（失败重放）就把活动连接从旧主机挪到新主机。
	t.load.close()
	t.load = nil
	if !t.closed && index >= 0 && index < len(t.selector.loads) {
		t.load = t.selector.loads[index]
		t.load.open(time.Now())
	}
}

func (t *selectedTransport) handleAck(sec *secureConn, index int, err error) {
	if err != nil {
		if !isClosedErr(err) {
			t.selector.markFailure(index, err)
		}
		return
	}
	t.selector.markHealthy(index)
	t.mu.Lock()
	if t.sec == sec {
		t.acked = true
		if !t.statusPending {
			t.commitLocked()
		} else if deadline := time.Now().Add(fxpTargetStatusWait); deadline.After(t.statusDeadline) {
			/*
				现拨的流水线连接：hello 是和握手一起发出去的，确认到的这一刻就是量到的这条连接的往返。出口的结果帧
				最晚在这之后 fxpTargetStatusWait 到（拨目标的时限 + 余量）。还没量过往返的出口（刚启动，第一条连接）
				靠这一步不被误判。handleAck 是读这条连接的协程在确认时调的，firstFrameDeadline 归它管。
			*/
			t.statusDeadline = deadline
			sec.firstFrameDeadline = deadline
		}
	}
	t.mu.Unlock()
}

/*
commitLocked：这条会话不会再换出口了 —— 重放缓存丢掉，到出口的这条连接清掉 TCP_USER_TIMEOUT（F1，见
secureConn.commitSession）：访客停下来不读、出口那一头窗口是零，也不能被内核判死。调用方持锁。
*/
func (t *selectedTransport) commitLocked() {
	t.committed = true
	t.replay = nil
	t.replayBytes = 0
	t.sec.commitSession()
}

// requestTargetStatus：hello 里带了 targetStatus。在 start 之前调，按当前这台出口会不会回报决定要不要等。
func (t *selectedTransport) requestTargetStatus() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.wantStatus = true
	t.statusPending = t.selector.endpointReportsTarget(t.index)
	if t.statusPending {
		t.committed = false
	}
}

// takeTargetStatusLocked 看刚读到的第一帧是不是出口回的「连目标的结果」。是就从 frames 里拿掉；
// 连上了就提交这条会话，连不上返回错误（调用方据此换出口重放）。调用方持锁。
func (t *selectedTransport) takeTargetStatusLocked(frames [][]byte, from int) ([][]byte, error) {
	if !t.statusPending || len(frames) <= from {
		return frames, nil
	}
	t.statusPending = false
	// 第一帧到了：不再限时，后面的读照常没有截止时间。
	t.sec.firstFrameDeadline = time.Time{}
	_ = t.sec.conn.SetReadDeadline(time.Time{})
	status, ok := decodeTargetStatus(frames[from])
	if !ok {
		// 标了会回报、却直接来了数据：当它没回，照常走。
		if t.acked {
			t.commitLocked()
		}
		return frames, nil
	}
	frames = append(frames[:from], frames[from+1:]...)
	elapsed := time.Duration(status.Ms) * time.Millisecond
	index := t.index
	t.selector.observeTarget(index, status.OK, elapsed)
	if !status.OK {
		return frames, &targetStatusError{message: status.Error}
	}
	if t.acked {
		t.commitLocked()
	}
	return frames, nil
}

// start 发出 hello（以及可选的首包）。流水线握手的连接上，握手会和它们合成一个段。
func (t *selectedTransport) start(frames ...[]byte) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.sec == nil {
		return errors.New("fxp transport is not connected")
	}
	for _, frame := range frames {
		t.bufferLocked(frame)
	}
	t.statusDeadline = time.Now().Add(targetStatusWaitFor(t.load))
	err := writeSecureFramesWithDeadline(t.sec, frames...)
	if err == nil {
		if t.committed {
			t.replay = nil
			t.replayBytes = 0
		}
		return nil
	}
	// 池里那条连接在「偷看」之后才断（对端刚好重启），或者现拨的连接一写就被
	// 重置：内容没送到任何人手里，换一个端点重放。
	t.committed = false
	return t.failoverLocked(err)
}

func (t *selectedTransport) bufferLocked(frame []byte) bool {
	if t.committed || t.overflow {
		return false
	}
	if t.replayBytes+len(frame) > fxpReplayBufferMax {
		t.overflow = true
		t.replay = nil
		t.replayBytes = 0
		return false
	}
	t.replay = append(t.replay, append([]byte(nil), frame...))
	t.replayBytes += len(frame)
	return true
}

// failoverLocked 放弃当前连接，换下一个没试过的端点，把缓存的帧原样重放。
func (t *selectedTransport) failoverLocked(cause error) error {
	if t.committed || t.overflow || t.closed || len(t.replay) == 0 {
		return cause
	}
	previous := t.endpoint
	for {
		if t.conn != nil {
			_ = t.conn.Close()
		}
		if err := t.connectLocked(); err != nil {
			return fmt.Errorf("%v; failover: %w", cause, err)
		}
		t.statusDeadline = time.Now().Add(targetStatusWaitFor(t.load))
		err := writeSecureFramesWithDeadline(t.sec, t.replay...)
		if err == nil {
			log.Printf("fxp session failed over tunnel=%d rule=%d from=%s:%d to=%s:%d replayed=%dB reason=%v",
				t.cfg.TunnelID, t.cfg.RuleID, previous.Host, previous.Port, t.endpoint.Host, t.endpoint.Port, t.replayBytes, cause)
			if t.committed {
				t.replay = nil
				t.replayBytes = 0
			}
			return nil
		}
		cause = err
	}
}

func (t *selectedTransport) writeFrame(plain []byte) error {
	return t.writeFrames(plain)
}

// writeFrames 把几帧合成一次写；每一帧都先进重放缓存（确认之前），和单帧一样。
func (t *selectedTransport) writeFrames(frames ...[]byte) error {
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return net.ErrClosed
	}
	sec := t.sec
	load := t.load
	buffered := true
	size := 0
	for _, plain := range frames {
		size += len(plain)
		if !t.bufferLocked(plain) {
			buffered = false
		}
	}
	t.mu.Unlock()
	load.addBytes(size)
	err := sec.writeFrames(frames...)
	if err != nil && buffered {
		// 还没确认的连接写失败：读协程会在等确认时发现并切走，这些帧已经在
		// 缓存里，会随重放送到新端点。
		return nil
	}
	return err
}

func (t *selectedTransport) readFrame() ([]byte, error) {
	var one [1][]byte
	frames, err := t.readFrames(one[:0], 1)
	if err != nil {
		return nil, err
	}
	return frames[0], nil
}

// readFrames 从当前连接读一批帧；确认失败就切换端点重放，再从新连接读。
func (t *selectedTransport) readFrames(dst [][]byte, max int) ([][]byte, error) {
	for {
		t.mu.Lock()
		sec := t.sec
		closed := t.closed
		if t.statusPending && !closed && sec != nil {
			// 还在等出口回「连上目标没有」：这一帧有截止时间（握手确认之后由 secureConn 设到连接上）。
			sec.firstFrameDeadline = t.statusDeadline
		}
		t.mu.Unlock()
		if closed {
			return dst, net.ErrClosed
		}
		frames, err := sec.readFrames(dst, max)
		if err == nil {
			t.mu.Lock()
			if t.sec == sec && t.statusPending {
				var statusErr error
				frames, statusErr = t.takeTargetStatusLocked(frames, len(dst))
				if statusErr != nil {
					// 目标本身挂了（每台出口到它都不通）：换哪台都一样，不再挨个重放，直接告诉客户端
					// （路线图 X8，见 targetDownEverywhere）。
					if t.selector.targetDownEverywhere() {
						t.mu.Unlock()
						return dst, statusErr
					}
					// 这台出口连不上目标：换下一台，把发出去的内容重放过去。
					failoverErr := t.failoverLocked(statusErr)
					t.mu.Unlock()
					if failoverErr != nil {
						return dst, failoverErr
					}
					continue
				}
				if len(frames) == len(dst) {
					// 这一批只有那一帧结果：接着读真正的数据。
					t.mu.Unlock()
					continue
				}
			}
			load := t.load
			t.mu.Unlock()
			size := 0
			for _, frame := range frames[len(dst):] {
				size += len(frame)
			}
			load.addBytes(size)
			return frames, nil
		}
		var ackErr *fxpAckError
		if !errors.As(err, &ackErr) {
			t.mu.Lock()
			// 等结果的时候出口把连接断了（出口进程没了之类）：还能换就换一台重放。
			if t.sec == sec && t.statusPending && !isClosedErr(err) {
				t.statusPending = false
				var netErr net.Error
				if errors.As(err, &netErr) && netErr.Timeout() {
					/*
						握手确认了，「连目标的结果」却一直没来：出口卡住了、回程不通，或者结果帧只是比等待还晚。
						算这台出口的一次「可疑」（和后台探测失败一样，连着几次才判坏；维护循环马上探它一次），
						不当场判坏（F2）。这条连接换下一台重放（路线图 X11）—— 到这里出口一个字节都没回过；
						可它也许已经连上目标、把发过去的内容转出去了（只是结果帧丢了 / 晚了），重放就会让目标收到第二份：
						这一步不保证「至多一次」（docs/dev/scheduler-spec.md）。
					*/
					err = fmt.Errorf("exit sent no target status before the deadline: %w", err)
					t.selector.probeFailed(t.index, err)
					// V3 复用：这台出口手里那几条物理会话多半也是死的，不再往上开新流（已有的流自己跑完 / 超时）。
					t.retireV3SessionsLocked()
				}
				failoverErr := t.failoverLocked(err)
				t.mu.Unlock()
				if failoverErr == nil {
					continue
				}
				return dst, failoverErr
			}
			t.mu.Unlock()
			return dst, err
		}
		t.mu.Lock()
		if t.sec != sec {
			t.mu.Unlock()
			continue
		}
		failoverErr := t.failoverLocked(err)
		t.mu.Unlock()
		if failoverErr != nil {
			return dst, failoverErr
		}
	}
}

// retireV3SessionsLocked：当前这台出口刚被判成「握手正常、之后不回话」。V3 复用时把它名下的物理会话都标成不再接新流。
func (t *selectedTransport) retireV3SessionsLocked() {
	dialCfg := t.cfg
	if t.endpoint.Key != "" {
		dialCfg.Key = t.endpoint.Key
	}
	if v3MuxEnabled(dialCfg) {
		v3Outbound.retire(t.endpoint.Host, t.endpoint.Port, dialCfg)
	}
}

func (t *selectedTransport) closeTransport() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.closed = true
	t.replay = nil
	t.replayBytes = 0
	t.load.close()
	t.load = nil
	if t.conn != nil {
		_ = t.conn.Close()
	}
}

func (t *selectedTransport) currentEndpoint() exitEndpoint {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.endpoint
}
