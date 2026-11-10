package main

import (
	"math/rand"
	"net"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

/*
进程内的有损网络：包在拨号方的 UDP 套接字外面一层 net.PacketConn，两个方向各自按比例
丢包、加延迟和抖动、把一部分包压后（乱序）。抗丢包传输的测试和基准都用它
（lossCarrierWrapSocket），对面的监听是真的 UDP 套接字。

丢包是每个包独立掷骰子（均匀随机丢包）。真实线路上还有成串的丢包，这里没有模拟。

抖动不打乱顺序：真实线路的抖动来自排队，前后的包一起变慢，不会因为抖动互相超车。所以
每个方向按到达时间排成一队（后面的包不早于前面的到），只有 reorder 比例的包单独多等
reorderExtra、真的落到后发的包后面。以前每包独立加随机抖动，微秒间隔发出的包被彻底
打乱，任何按序号判断丢包的协议（TCP 也一样）都会把大部分包当丢了重发。
*/

type lossyNetConfig struct {
	// loss 是每个方向的丢包率（0~1）。
	loss float64
	// delay 是单向延迟，jitter 是在它上面均匀加的 0~jitter。
	delay  time.Duration
	jitter time.Duration
	// reorder 比例的包额外多等 reorderExtra，落到后发的包后面。
	reorder      float64
	reorderExtra time.Duration
	seed         int64
}

type lossyNetStats struct {
	sent    atomic.Uint64 // 拨号方发出、进到有损网络的包
	sentOK  atomic.Uint64 // 其中送到了对面的
	recv    atomic.Uint64 // 对面发回、进到有损网络的包
	recvOK  atomic.Uint64
	bytesTx atomic.Uint64 // 拨号方发出的 UDP 负载字节（含被丢的）
	bytesRx atomic.Uint64
}

type lossyPacket struct {
	data []byte
	addr net.Addr
}

type lossyPacketConn struct {
	net.PacketConn
	cfg   lossyNetConfig
	stats *lossyNetStats

	outMu   sync.Mutex
	outRand *rand.Rand
	inRand  *rand.Rand

	inbound   chan lossyPacket
	outLane   *lossyLane
	inLane    *lossyLane
	closed    chan struct{}
	closeOnce sync.Once
	readErr   atomic.Value
	deadline  atomic.Value // time.Time
	poke      chan struct{}
}

func newLossyPacketConn(inner net.PacketConn, cfg lossyNetConfig, stats *lossyNetStats) *lossyPacketConn {
	if stats == nil {
		stats = &lossyNetStats{}
	}
	c := &lossyPacketConn{
		PacketConn: inner,
		cfg:        cfg,
		stats:      stats,
		outRand:    rand.New(rand.NewSource(cfg.seed*2 + 1)),
		inRand:     rand.New(rand.NewSource(cfg.seed*2 + 2)),
		inbound:    make(chan lossyPacket, 8192),
		closed:     make(chan struct{}),
		poke:       make(chan struct{}, 1),
	}
	c.outLane = newLossyLane(c.closed)
	c.inLane = newLossyLane(c.closed)
	go c.pump()
	return c
}

// lossyLane 是一个方向的「线路」：按到达时间先后交付，后面的包不超车。
type lossyLane struct {
	mu     sync.Mutex
	last   time.Time
	queue  chan lossyScheduled
	closed chan struct{}
}

type lossyScheduled struct {
	at      time.Time
	deliver func()
}

func newLossyLane(closed chan struct{}) *lossyLane {
	lane := &lossyLane{queue: make(chan lossyScheduled, 16384), closed: closed}
	go lane.run()
	return lane
}

func (l *lossyLane) push(wait time.Duration, deliver func()) {
	l.mu.Lock()
	at := time.Now().Add(wait)
	if at.Before(l.last) {
		at = l.last
	}
	l.last = at
	l.mu.Unlock()
	select {
	case l.queue <- lossyScheduled{at: at, deliver: deliver}:
	default:
		// 线路上排满了：和真实线路的队列溢出一样，丢掉。
	}
}

func (l *lossyLane) run() {
	for {
		select {
		case item := <-l.queue:
			if wait := time.Until(item.at); wait > 0 {
				time.Sleep(wait)
			}
			item.deliver()
		case <-l.closed:
			return
		}
	}
}

// verdict 决定一个包丢不丢、晚多久到。
func (c *lossyPacketConn) verdict(r *rand.Rand) (drop bool, wait time.Duration, late bool) {
	if c.cfg.loss > 0 && r.Float64() < c.cfg.loss {
		return true, 0, false
	}
	wait = c.cfg.delay
	if c.cfg.jitter > 0 {
		wait += time.Duration(r.Int63n(int64(c.cfg.jitter) + 1))
	}
	if c.cfg.reorder > 0 && r.Float64() < c.cfg.reorder {
		return false, wait + c.cfg.reorderExtra, true
	}
	return false, wait, false
}

// schedule 把一个包交给线路：被挑中乱序的单独多等，其余按队列先后。
func schedule(lane *lossyLane, wait time.Duration, late bool, deliver func()) {
	switch {
	case late:
		time.AfterFunc(wait, deliver)
	case wait <= 0:
		deliver()
	default:
		lane.push(wait, deliver)
	}
}

func (c *lossyPacketConn) WriteTo(p []byte, addr net.Addr) (int, error) {
	c.stats.sent.Add(1)
	c.stats.bytesTx.Add(uint64(len(p)))
	c.outMu.Lock()
	drop, wait, late := c.verdict(c.outRand)
	c.outMu.Unlock()
	if drop {
		return len(p), nil
	}
	c.stats.sentOK.Add(1)
	if wait <= 0 && !late {
		return c.PacketConn.WriteTo(p, addr)
	}
	data := append([]byte(nil), p...)
	schedule(c.outLane, wait, late, func() { _, _ = c.PacketConn.WriteTo(data, addr) })
	return len(p), nil
}

func (c *lossyPacketConn) pump() {
	buf := make([]byte, 65535)
	for {
		n, addr, err := c.PacketConn.ReadFrom(buf)
		if err != nil && lcTransientSocketError(err) {
			// ICMP 不可达报上来的错误只是一次性的，套接字还能接着用。
			select {
			case <-c.closed:
				return
			default:
				continue
			}
		}
		if err != nil {
			// 读超时是上面那层设的（只在建连阶段），这里不认。
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				select {
				case <-c.closed:
					return
				default:
					continue
				}
			}
			c.readErr.Store(err)
			c.closeOnce.Do(func() { close(c.closed) })
			return
		}
		c.stats.recv.Add(1)
		c.stats.bytesRx.Add(uint64(n))
		drop, wait, late := c.verdict(c.inRand)
		if drop {
			continue
		}
		c.stats.recvOK.Add(1)
		packet := lossyPacket{data: append([]byte(nil), buf[:n]...), addr: addr}
		deliver := func() {
			select {
			case c.inbound <- packet:
			case <-c.closed:
			}
		}
		schedule(c.inLane, wait, late, deliver)
	}
}

func (c *lossyPacketConn) ReadFrom(p []byte) (int, net.Addr, error) {
	for {
		var timeout <-chan time.Time
		if deadline, ok := c.deadline.Load().(time.Time); ok && !deadline.IsZero() {
			wait := time.Until(deadline)
			if wait <= 0 {
				return 0, nil, os.ErrDeadlineExceeded
			}
			timer := time.NewTimer(wait)
			defer timer.Stop()
			timeout = timer.C
		}
		select {
		case packet := <-c.inbound:
			return copy(p, packet.data), packet.addr, nil
		case <-timeout:
			return 0, nil, os.ErrDeadlineExceeded
		case <-c.poke:
		case <-c.closed:
			if err, ok := c.readErr.Load().(error); ok {
				return 0, nil, err
			}
			return 0, nil, net.ErrClosed
		}
	}
}

func (c *lossyPacketConn) SetReadDeadline(t time.Time) error {
	c.deadline.Store(t)
	select {
	case c.poke <- struct{}{}:
	default:
	}
	return nil
}

func (c *lossyPacketConn) SetDeadline(t time.Time) error { return c.SetReadDeadline(t) }

func (c *lossyPacketConn) Close() error {
	c.closeOnce.Do(func() { close(c.closed) })
	return c.PacketConn.Close()
}

// useLossyNetwork 让之后拨出的抗丢包连接都经过有损网络，测试结束时还原。返回统计。
func useLossyNetwork(tb testing.TB, cfg lossyNetConfig) *lossyNetStats {
	tb.Helper()
	stats := &lossyNetStats{}
	var seed atomic.Int64
	seed.Store(cfg.seed)
	previous := lossCarrierWrapSocket
	lossCarrierWrapSocket = func(inner net.PacketConn) net.PacketConn {
		perConn := cfg
		// 每条连接换一个种子，不然并行的几条连接丢的是同一批序号。
		perConn.seed = seed.Add(1)
		return newLossyPacketConn(inner, perConn, stats)
	}
	tb.Cleanup(func() { lossCarrierWrapSocket = previous })
	return stats
}
