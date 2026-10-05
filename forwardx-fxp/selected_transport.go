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
)

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

	mu        sync.Mutex
	conn      net.Conn
	sec       *secureConn
	endpoint  exitEndpoint
	index     int
	attempted map[int]bool
	// committed：当前连接已经确认过握手（池里的连接天生如此）。
	committed   bool
	replay      [][]byte
	replayBytes int
	overflow    bool
	closed      bool
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
		endpoint, index, ok := t.selector.pick(t.attempted, t.selectionKey)
		if !ok {
			break
		}
		t.attempted[index] = true
		dialCfg := t.cfg
		if endpoint.Key != "" {
			dialCfg.Key = endpoint.Key
		}
		if conn, sec, ok := t.selector.states[index].take(dialCfg); ok {
			t.useLocked(conn, sec, endpoint, index, true)
			return nil
		}
		conn, err := dialTCP(endpoint.Host, endpoint.Port, secureDialTimeout(dialCfg), dialCfg.TCPFastOpen)
		if err != nil {
			lastErr = err
			t.selector.markFailure(index, err)
			continue
		}
		sec, err := newPipelinedClientSecureConn(conn, dialCfg, fxpWireCurrent)
		if err != nil {
			_ = conn.Close()
			lastErr = err
			continue
		}
		if t.selector.count() > 1 {
			sec.ackTimeout = fxpPipelinedAckFast
		}
		ackIndex := index
		sec.onAck = func(err error) { t.handleAck(sec, ackIndex, err) }
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

func (t *selectedTransport) useLocked(conn net.Conn, sec *secureConn, endpoint exitEndpoint, index int, committed bool) {
	t.conn = conn
	t.sec = sec
	t.endpoint = endpoint
	t.index = index
	t.committed = committed
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
		t.committed = true
		t.replay = nil
		t.replayBytes = 0
	}
	t.mu.Unlock()
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
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return net.ErrClosed
	}
	sec := t.sec
	buffered := t.bufferLocked(plain)
	t.mu.Unlock()
	err := sec.writeFrame(plain)
	if err != nil && buffered {
		// 还没确认的连接写失败：读协程会在等确认时发现并切走，这一帧已经在
		// 缓存里，会随重放送到新端点。
		return nil
	}
	return err
}

func (t *selectedTransport) readFrame() ([]byte, error) {
	for {
		t.mu.Lock()
		sec := t.sec
		closed := t.closed
		t.mu.Unlock()
		if closed {
			return nil, net.ErrClosed
		}
		frame, err := sec.readFrame()
		if err == nil {
			return frame, nil
		}
		var ackErr *fxpAckError
		if !errors.As(err, &ackErr) {
			return nil, err
		}
		t.mu.Lock()
		if t.sec != sec {
			t.mu.Unlock()
			continue
		}
		failoverErr := t.failoverLocked(err)
		t.mu.Unlock()
		if failoverErr != nil {
			return nil, failoverErr
		}
	}
}

func (t *selectedTransport) closeTransport() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.closed = true
	t.replay = nil
	t.replayBytes = 0
	if t.conn != nil {
		_ = t.conn.Close()
	}
}

func (t *selectedTransport) currentEndpoint() exitEndpoint {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.endpoint
}
