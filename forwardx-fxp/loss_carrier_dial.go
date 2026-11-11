package main

import (
	"bytes"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"time"

	kcp "github.com/xtaci/kcp-go/v5"
)

// 抗丢包传输的拨号方（入口、中转拨下一跳）。每条承载连接一个 UDP 套接字。

// lossCarrierDialError：没连上。模式是严格的 —— 连不上就报这个错，不退回 TCP。
// 错误文字会原样出现在日志和面板的连接监控里，所以把最可能的原因直接写出来。
type lossCarrierDialError struct {
	address string
	refused bool
	waited  time.Duration
	cause   error
}

func (e *lossCarrierDialError) Error() string {
	switch {
	case e.cause != nil:
		return fmt.Sprintf("loss-tolerant transport: dial udp %s: %v", e.address, e.cause)
	case e.refused:
		return fmt.Sprintf("loss-tolerant transport: udp %s refused (nothing is listening on that udp port: peer not running, or its loss-tolerant transport is off / not upgraded)", e.address)
	default:
		return fmt.Sprintf("loss-tolerant transport: no answer from udp %s in %s (udp blocked by a firewall / security group, or the peer's loss-tolerant transport is off / not upgraded)", e.address, e.waited.Round(time.Millisecond))
	}
}

// statsText 是连接监控里「最近一次失败原因」那一栏的短话，不带地址（端点另有一栏）。
func (e *lossCarrierDialError) statsText() string {
	switch {
	case e.cause != nil:
		text := "loss-tolerant udp: " + e.cause.Error()
		if len(text) > 160 {
			text = text[:160]
		}
		return text
	case e.refused:
		return "loss-tolerant udp refused: peer udp port closed (peer down, or its loss-tolerant transport is off)"
	default:
		return "loss-tolerant udp no answer: udp blocked by firewall, or peer's loss-tolerant transport is off"
	}
}

func (e *lossCarrierDialError) Timeout() bool   { return e.cause == nil && !e.refused }
func (e *lossCarrierDialError) Temporary() bool { return false }
func (e *lossCarrierDialError) Unwrap() error   { return e.cause }

// lcConnectedUDP 把已连接的 UDP 套接字当 net.PacketConn 用。用已连接的套接字是为了让
// 内核把 ICMP 端口不可达报上来：对端 UDP 口没人听，拨号立刻知道，不用等到超时。
type lcConnectedUDP struct {
	*net.UDPConn
	remote *net.UDPAddr
}

func (c lcConnectedUDP) ReadFrom(p []byte) (int, net.Addr, error) {
	n, err := c.UDPConn.Read(p)
	return n, c.remote, err
}

func (c lcConnectedUDP) WriteTo(p []byte, _ net.Addr) (int, error) {
	return c.UDPConn.Write(p)
}

// lcDialLink 是拨号方的一条会话：它既是交给 kcp-go 的 net.PacketConn（封包、验包、
// 截下控制包），也是 lossCarrierConn 发控制包用的那一头。
type lcDialLink struct {
	sock   net.PacketConn
	remote *net.UDPAddr
	sid    uint32
	keys   lcSessionKeys
	static *lcStaticKeys

	sendCounter atomic.Uint64
	conn        *lossCarrierConn
	// ready 在 conn.sess 填好之后关闭：kcp-go 一建会话就起读协程，那时 conn 还没装完。
	ready     chan struct{}
	rbuf      []byte
	closeOnce sync.Once
}

func (l *lcDialLink) ReadFrom(p []byte) (int, net.Addr, error) {
	<-l.ready
	transient := 0
	for {
		n, _, err := l.sock.ReadFrom(l.rbuf)
		if err != nil {
			if lcTransientSocketError(err) {
				// 已连接的 UDP 套接字每收到一个 ICMP 不可达报一次错，套接字照样能用。连着报
				// 就歇一下：真坏了由失联计时判死，这里不能空转把一个核吃满。
				if transient++; transient > 3 {
					time.Sleep(10 * time.Millisecond)
				}
				continue
			}
			return 0, nil, err
		}
		transient = 0
		pkt := l.rbuf[:n]
		header, ok := lcParse(pkt)
		if !ok || header.sid != l.sid {
			continue
		}
		if header.typ == lcTypeReset {
			// 对端不认识这条会话（重启过，或者已经把它拆了）。计数是它照抄我们发过的包，
			// 比我们发过的还大的就是伪造的。
			if header.counter <= l.sendCounter.Load() && lcVerify(l.static.reset, pkt) {
				l.conn.fail(errLossCarrierReset)
			}
			continue
		}
		if !lcVerify(l.keys.s2c, pkt) {
			continue
		}
		l.conn.touch(time.Now().UnixNano())
		switch header.typ {
		case lcTypeData:
			return copy(p, lcBody(pkt)), l.remote, nil
		case lcTypePing:
			l.sendControl(lcTypePong, nil)
		case lcTypeFin, lcTypeFinAck:
			l.conn.onControl(header.typ, lcBody(pkt))
		}
	}
}

func (l *lcDialLink) WriteTo(p []byte, _ net.Addr) (int, error) {
	buf := getFXPByteBuffer(len(p) + lcOverhead)
	pkt := lcSeal(buf[:0], l.keys.c2s, lcTypeData, l.sid, l.sendCounter.Add(1), p)
	_, err := l.sock.WriteTo(pkt, l.remote)
	putFXPByteBuffer(buf)
	if err != nil && !lcTransientSocketError(err) {
		return 0, err
	}
	return len(p), nil
}

func (l *lcDialLink) sendControl(typ byte, body []byte) {
	var buf [lcOverhead + 16]byte
	pkt := lcSeal(buf[:0], l.keys.c2s, typ, l.sid, l.sendCounter.Add(1), body)
	_, _ = l.sock.WriteTo(pkt, l.remote)
}

func (l *lcDialLink) release() {
	_ = l.Close()
}

func (l *lcDialLink) Close() error {
	var err error
	l.closeOnce.Do(func() { err = l.sock.Close() })
	return err
}

func (l *lcDialLink) LocalAddr() net.Addr                { return l.sock.LocalAddr() }
func (l *lcDialLink) SetDeadline(t time.Time) error      { return l.sock.SetDeadline(t) }
func (l *lcDialLink) SetReadDeadline(t time.Time) error  { return l.sock.SetReadDeadline(t) }
func (l *lcDialLink) SetWriteDeadline(t time.Time) error { return l.sock.SetWriteDeadline(t) }

func lcRandomUint32() (uint32, error) {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		return 0, err
	}
	return binary.BigEndian.Uint32(b[:]), nil
}

// dialNextHop 拨下一跳的承载连接：平时就是原来的 TCP，一个字节都不变；隧道开了抗丢包
// 传输就只拨 UDP 上的 KCP，拨不通就是拨不通，不退回 TCP。
func dialNextHop(host string, port int, timeout time.Duration, cfg config) (net.Conn, error) {
	if cfg.LossTolerant {
		return dialLossCarrier(host, port, timeout, cfg)
	}
	return dialTCP(host, port, timeout, cfg.TCPFastOpen)
}

// nextHopDialStage 是连接监控里「拨下一跳」那一行的阶段名。
func nextHopDialStage(cfg config) string {
	if cfg.LossTolerant {
		return "carrier"
	}
	return "tcp"
}

// dialLossCarrier 拨一条抗丢包承载：先 OPEN 问到对端答应，再在这个套接字上起 KCP。
// 返回的连接和 dialTCP 的一样用。
func dialLossCarrier(host string, port int, timeout time.Duration, cfg config) (net.Conn, error) {
	address, err := resolveHopAddress(host, port)
	if err != nil {
		return nil, err
	}
	remote, err := net.ResolveUDPAddr("udp", address)
	if err != nil {
		return nil, &lossCarrierDialError{address: address, cause: err}
	}
	static, err := lcStaticKeysFor(cfg.Key, cfg.TunnelID)
	if err != nil {
		return nil, &lossCarrierDialError{address: address, cause: err}
	}
	udp, err := net.DialUDP("udp", nil, remote)
	if err != nil {
		return nil, &lossCarrierDialError{address: address, cause: err}
	}
	_ = udp.SetReadBuffer(lcSocketBuffer)
	_ = udp.SetWriteBuffer(lcSocketBuffer)
	var sock net.PacketConn = lcConnectedUDP{UDPConn: udp, remote: remote}
	if lossCarrierWrapSocket != nil {
		sock = lossCarrierWrapSocket(sock)
	}
	link, conv, err := lcOpenHandshake(sock, remote, address, static, timeout, cfg)
	if err != nil {
		_ = sock.Close()
		return nil, err
	}
	conn := newLossCarrierConn(link, true)
	link.conn = conn
	sess, err := kcp.NewConn4(conv, remote, nil, lcDataShards, lcParityShards, true, link)
	if err != nil {
		_ = sock.Close()
		return nil, &lossCarrierDialError{address: address, cause: err}
	}
	lcTuneSession(sess)
	conn.sess = sess
	lcRegisterConn(conn)
	close(link.ready)
	return conn, nil
}

func lcOpenHandshake(sock net.PacketConn, remote *net.UDPAddr, address string, static *lcStaticKeys, timeout time.Duration, cfg config) (*lcDialLink, uint32, error) {
	fail := func(cause error) (*lcDialLink, uint32, error) {
		return nil, 0, &lossCarrierDialError{address: address, cause: cause}
	}
	// body = 拨号方随机数(16) + KCP 会话号 conv(4)
	var body [lcNonceSize + 4]byte
	if _, err := rand.Read(body[:]); err != nil {
		return fail(err)
	}
	conv := binary.BigEndian.Uint32(body[lcNonceSize:])
	if conv == 0 {
		conv = 1
		binary.BigEndian.PutUint32(body[lcNonceSize:], conv)
	}
	sid, err := lcRandomUint32()
	if err != nil {
		return fail(err)
	}
	var counterBytes [8]byte
	if _, err := rand.Read(counterBytes[:]); err != nil {
		return fail(err)
	}
	open := lcSeal(make([]byte, 0, lcOverhead+len(body)), static.open, lcTypeOpen, sid, binary.BigEndian.Uint64(counterBytes[:]), body[:])

	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	started := time.Now()
	deadline := started.Add(timeout)
	interval := lcOpenRetryMin
	// refused 数连着几次问都被 ICMP 顶回来。一次可能是对端正在重启监听，连着两次就是
	// 那个 UDP 口确实没人听：和 TCP 的 connection refused 一样马上报错，有备选出口的
	// 能立刻换下一个，不用等满超时。
	refused := 0
	buf := make([]byte, 2048)
	for time.Now().Before(deadline) && refused < 2 {
		wasRefused := refused
		if _, err := sock.WriteTo(open, remote); err != nil {
			if !lcTransientSocketError(err) {
				return fail(err)
			}
			refused++
		}
		attemptEnd := time.Now().Add(interval)
		if attemptEnd.After(deadline) {
			attemptEnd = deadline
		}
		for {
			_ = sock.SetReadDeadline(attemptEnd)
			n, _, err := sock.ReadFrom(buf)
			if err != nil {
				var netErr net.Error
				if errors.As(err, &netErr) && netErr.Timeout() {
					break
				}
				if lcTransientSocketError(err) {
					if refused == wasRefused {
						refused++
					}
					if refused < 2 {
						time.Sleep(time.Until(attemptEnd))
					}
					break
				}
				return fail(err)
			}
			pkt := buf[:n]
			header, ok := lcParse(pkt)
			if !ok || header.typ != lcTypeOpenAck || header.sid != sid || len(pkt) != lcOverhead+2*lcNonceSize || !lcVerify(static.openAck, pkt) {
				continue
			}
			ack := lcBody(pkt)
			if !bytes.Equal(ack[:lcNonceSize], body[:lcNonceSize]) {
				continue
			}
			keys, err := lcDeriveSessionKeys(cfg.Key, cfg.TunnelID, body[:lcNonceSize], ack[lcNonceSize:])
			if err != nil {
				return fail(err)
			}
			_ = sock.SetReadDeadline(time.Time{})
			return &lcDialLink{sock: sock, remote: remote, sid: sid, keys: keys, static: static, ready: make(chan struct{}), rbuf: make([]byte, 2048)}, conv, nil
		}
		if refused == wasRefused {
			// 这一轮没被顶回来（只是没人答），前面那次算偶然。
			refused = 0
		}
		if interval *= 2; interval > lcOpenRetryMax {
			interval = lcOpenRetryMax
		}
	}
	return nil, 0, &lossCarrierDialError{address: address, refused: refused >= 2, waited: time.Since(started)}
}
