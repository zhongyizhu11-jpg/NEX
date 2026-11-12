package main

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	v3 "github.com/zhongyizhu11-jpg/NEX/forwardx-fxp/internal/v3"
)

/*
V3 在 NEX FXP 里的接入层。

一条 V3 下一跳连接：拨 TCP → 外层（wrapV3Client）→ 内层握手（v3.InnerClient）。之后有两种用法：

  - 不复用（v3Multiplex=false，NEX 面板的默认）：这条物理连接只跑一条业务连接，和 V1 一样
    能进入口的预热连接池（endpoint_pool.go），用户连接来了直接取一条写 hello，TCP / TLS /
    内层握手的几个往返都在后台做完了。单连接吞吐和 V1 一样只受 TCP 本身限制。
  - 多路复用：几十条业务连接共用一条物理连接（v3SessionPool，端点活跃时预热好一条），每条业务
    连接是会话里的一个逻辑流。建连只发一个 OPEN 帧、不等回话；每个逻辑流的窗口从 128 KiB 起
    按需放大到 16 MiB（internal/v3/session.go）。代价是一条物理连接丢包时所有流一起等。

出口不看自己的配置、看认证后的第一个字节分辨这两种（v3AwaitFirstByte），所以两端的复用设置
不一样也能通，多路径的腿也可以是不复用的连接。

两种用法里，业务帧都是「4 字节长度 + 明文」的逻辑帧（secureConn.logical），加密由内层负责
（外层是 TLS 1.3 时由 TLS 负责，内层直通，见 PROTOCOL.md）。hello、目标授权、PROXY 头、流量
统计和 V1 是同一套代码。
*/

// v3LogicalFrameLimit 是一个逻辑帧的上限。FXP 的数据帧最多 64 KiB（fxpCopyChunkSize）；
// 多路径的腿走 V3 时，一帧是一个多路径分片，收端最多接受 multipathMaxChunkPayload 加帧头。
// 上限不到 16 MiB，长度的最高字节一定是 0 —— 出口靠这一点分辨复用 / 不复用（v3AwaitFirstByte）。
const v3LogicalFrameLimit = multipathMaxChunkPayload + 64
const v3PoolSessionLimit = 64

// v3ClientIdleTimeout：入口一侧没有流的会话这么久就关。比出口一侧（会话默认 30 秒）短，
// 空闲会话总是入口先关，不会出现入口刚在上面开流、出口正好把它当空闲关掉。
const v3ClientIdleTimeout = 20 * time.Second

// v3SessionStaleAge：物理会话这么久没有一次成功的写，池子就不再往它上面开新流。
// 从会话写超时推出来，两者不会各改各的。
const v3SessionStaleAge = 3 * v3.DefaultWriteTimeout

// v3BusinessGate 是出口 / 中转上所有多路复用逻辑流的总闸（物理连接另有监听的连接闸）。
var v3BusinessGate = newConnGate(fxpListenerMaxConnections, 0)

// v3ErrPoolLimit：本机的物理会话数到顶了。这是本地上限，不是端点坏了，不换端点、不记失败。
var v3ErrPoolLimit = errors.New("v3: physical session pool limit reached")

// newV3SecureConn 包一条已经过内层认证的连接（内层连接本身，或者会话里的一个逻辑流）。
// raw 是底下那条 TCP，给链路整形器读 TCP_INFO、设发包速率用；逻辑流传 nil（物理连接
// 建立时已经登记过）。
func newV3SecureConn(conn net.Conn, shaper *linkShaper, raw net.Conn) *secureConn {
	sec := &secureConn{conn: conn, logical: true, shaper: shaper}
	if raw != nil {
		shaper.attach(raw)
	}
	return sec
}

// writeLogicalFrames 把几帧拼成一次写：内层记录层每次 Write 至少封一条记录，长度头和
// 内容分开写会白白多一条记录。
func (c *secureConn) writeLogicalFrames(frames [][]byte) error {
	size := 0
	for _, plain := range frames {
		if len(plain) > v3LogicalFrameLimit {
			return errors.New("v3: business frame too large")
		}
		size += 4 + len(plain)
	}
	if c.shaper != nil {
		c.shaper.wait(size - 4*len(frames))
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	// 内层连接和逻辑流都能一次收几段：长度头和内容直接交下去，不先拼进一块缓冲
	// （内层封记录、逻辑流切帧时各自只拷一次）。
	if out, ok := c.conn.(interface{ WriteBuffers([][]byte) error }); ok && len(frames) <= fxpCopyBatchFrames {
		var headers [fxpCopyBatchFrames][4]byte
		var parts [2 * fxpCopyBatchFrames][]byte
		bufs := parts[:0]
		for i, plain := range frames {
			binary.BigEndian.PutUint32(headers[i][:], uint32(len(plain)))
			bufs = append(bufs, headers[i][:], plain)
		}
		return out.WriteBuffers(bufs)
	}
	wire := getFXPByteBuffer(size)
	defer putFXPByteBuffer(wire)
	wire = wire[:0]
	for _, plain := range frames {
		var header [4]byte
		binary.BigEndian.PutUint32(header[:], uint32(len(plain)))
		wire = append(wire, header[:]...)
		wire = append(wire, plain...)
	}
	written, err := writeFull(c.conn, wire)
	if err == nil && written != len(wire) {
		err = io.ErrShortWrite
	}
	return err
}

// readLogicalFrame 读一个逻辑帧。交出的切片只在下一次读之前有效（和加密帧一样）；
// 空帧（对端写完了）交出非 nil 的空切片。
func (c *secureConn) readLogicalFrame() ([]byte, error) {
	var header [4]byte
	if _, err := io.ReadFull(c.conn, header[:]); err != nil {
		return nil, err
	}
	n := binary.BigEndian.Uint32(header[:])
	if n > v3LogicalFrameLimit {
		return nil, errors.New("v3: business frame too large")
	}
	if n == 0 {
		return []byte{}, nil
	}
	if cap(c.logicalBuf) < int(n) {
		c.logicalBuf = make([]byte, max(int(n), 16*1024))
	}
	p := c.logicalBuf[:n]
	if _, err := io.ReadFull(c.conn, p); err != nil {
		return nil, err
	}
	return p, nil
}

// ---- 拨号 ----

// dialV3Inner 拨一条物理连接并做完外层和内层握手。raw 是底下的 TCP。
func dialV3Inner(host string, port int, cfg config) (net.Conn, *v3.InnerConn, error) {
	raw, err := dialTCP(host, port, secureDialTimeout(cfg), cfg.TCPFastOpen)
	if err != nil {
		return nil, nil, err
	}
	inner, err := v3ClientHandshake(raw, cfg)
	if err != nil {
		_ = raw.Close()
		return nil, nil, err
	}
	return raw, inner, nil
}

// v3ClientHandshake 在 raw 上套外层、做内层握手，整个过程受握手超时约束。
func v3ClientHandshake(raw net.Conn, cfg config) (*v3.InnerConn, error) {
	if err := setFXPConnDeadline(raw, fxpHandshakeTimeout); err != nil {
		return nil, err
	}
	wrapped, err := wrapV3Client(raw, cfg)
	if err != nil {
		return nil, err
	}
	inner, err := v3.InnerClient(wrapped, cfg.Key, v3TLSClientBinding(wrapped))
	if err != nil {
		return nil, err
	}
	if err := clearFXPConnDeadline(raw); err != nil {
		return nil, err
	}
	return inner, nil
}

// v3OwnedStream 是一条自带物理会话的逻辑流：关流就把会话一起关掉。只给探测用 ——
// 探测要的是真实地走一遍网络，不能借池子里现成的会话。
type v3OwnedStream struct {
	*v3.Stream
	session *v3.Session
}

func (s *v3OwnedStream) Close() error {
	err := s.Stream.Close()
	s.session.Close()
	return err
}

// dialV3Fresh 不碰任何池子，现拨一条 V3 连接（dialSecureTCPFresh 的 V3 版）：连接池预热
// 和后台探测用它。返回的第一个值是要关的那条连接，第二个是读写帧用的。
func dialV3Fresh(host string, port int, cfg config) (net.Conn, *secureConn, error) {
	raw, inner, err := dialV3Inner(host, port, cfg)
	if err != nil {
		return nil, nil, err
	}
	shaper := linkShaperHandle("up", cfg)
	if !v3MuxEnabled(cfg) {
		// 关的是底下的 TCP：连接池按它「偷看」空闲连接活没活（见 pooledSecureConnAlive）。
		return raw, newV3SecureConn(inner, shaper, raw), nil
	}
	session := v3.NewSession(inner, v3.SessionOptions{Client: true, IdleTimeout: v3ClientIdleTimeout})
	stream, err := session.Open()
	if err != nil {
		session.Close()
		return nil, nil, err
	}
	owned := &v3OwnedStream{Stream: stream, session: session}
	return owned, newV3SecureConn(owned, shaper, raw), nil
}

// dialV3Transport 给入口 / 中转的一条业务连接拿一条 V3 连接：多路复用时从会话池里开一个
// 逻辑流，不复用时先看预热连接池，没有再现拨。reused 表示没有新拨物理连接。
func dialV3Transport(state *fxpEndpointState, host string, port int, cfg config) (net.Conn, *secureConn, bool, error) {
	// 端点状态按承载方式分份（复用 / 不复用的连接池不能混用）：多路径的腿把复用关掉了，
	// 选择器给的却是这个端点复用那份状态，换成不复用的那份。
	if identity := v3TransportIdentity(cfg); state != nil && state.id.transport != identity {
		state = fxpEndpointStateFor(exitEndpoint{Host: state.id.host, Port: state.id.port, Key: state.id.key, lossTolerant: state.id.lossTolerant, transport: identity})
	}
	if v3MuxEnabled(cfg) {
		if state != nil {
			state.markUsed(cfg)
		}
		return v3Outbound.openAt(host, port, cfg)
	}
	if state != nil {
		if conn, sec, ok := state.take(cfg); ok {
			return conn, sec, true, nil
		}
	}
	conn, sec, err := dialV3Fresh(host, port, cfg)
	return conn, sec, false, err
}

// v3LegConfig 是多路径一条腿用的配置：V3 时关掉复用，每条腿是一条自己的物理连接 ——
// 并进同一个复用会话，几条腿就挤在一条 TCP 上，叠加 / 并发就没意义了。V1 / V2 原样返回。
func v3LegConfig(cfg config) config {
	if !v3MuxEnabled(cfg) {
		return cfg
	}
	off := false
	cfg.V3Multiplex = &off
	return cfg
}

// v3EndpointFailureIsRetryable：换一个出口端点有没有可能好。池子到顶是本地上限，
// 换端点没用，直接报出去。
func v3EndpointFailureIsRetryable(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, net.ErrClosed) || errors.Is(err, v3.ErrDraining) || errors.Is(err, v3.ErrStreamLimit) || errors.Is(err, v3ErrPoolLimit) {
		return false
	}
	return true
}

// ---- 出口 / 中转：接入 ----

// serveV3Inbound 在出口 / 中转上接一条 V3 物理连接：外层、内层握手，然后按是否多路复用
// 把一条或多条业务连接交给 handler。handler 拿到的 in 是这条业务连接自己的监听状态
// （多路复用时每个逻辑流单独登记，重载时可以只断不再放行的那一条）。
func serveV3Inbound(role string, conn net.Conn, cfg config, in *fxpInbound, handler func(*secureConn, *fxpInbound) error) error {
	if err := setFXPConnDeadline(conn, fxpServerHandshakeTimeout); err != nil {
		return err
	}
	wrapped, err := wrapV3Server(conn, cfg)
	if err != nil {
		probeDelay()
		return err
	}
	inner, err := v3.InnerServer(wrapped, cfg.Key, v3TLSBinding(wrapped))
	if err != nil {
		probeDelay()
		return err
	}
	if err := clearFXPConnDeadline(conn); err != nil && !isClosedErr(err) {
		return err
	}
	if !in.authenticated(cfg) {
		return nil
	}
	shaper := linkShaperHandle("down", cfg)
	// 复用还是不复用，看客户端发来的第一个字节，不看本端配置：不复用的连接第一个字节是逻辑帧
	// 长度的最高字节（帧不超过 v3LogicalFrameLimit，一定是 0），复用的会话第一帧一定是 OPEN（1）。
	// 这样多路径的每条腿可以是一条不复用的物理连接，哪怕隧道开了复用（见 dialMultipathLeg）。
	first, err := v3AwaitFirstByte(inner, in.stop())
	if err != nil {
		return quietHelloError(err)
	}
	peeked := &v3PeekedConn{InnerConn: inner, first: first, pending: true}
	switch first {
	case 0:
		return handler(newV3SecureConn(peeked, shaper, conn), in)
	case v3.FrameOpen:
		shaper.attach(conn)
		// 多路复用的物理连接一直开着，不会再有「等 hello」这一段：让出 pending 份额，只占 active。
		in.helloReceived()
		return serveV3Session(role, peeked, in, shaper, handler)
	default:
		probeDelay()
		return fmt.Errorf("v3: unexpected first byte %#x after the inner handshake", first)
	}
}

// v3AwaitFirstByte 等认证过的连接上的第一个字节，规矩和等 hello 一样：最多 fxpServerHelloWait
// （预热池里的连接会空等在这里），监听停了就不等。
func v3AwaitFirstByte(inner *v3.InnerConn, stopping <-chan struct{}) (byte, error) {
	if stopping != nil {
		waiting := make(chan struct{})
		defer close(waiting)
		go func() {
			select {
			case <-stopping:
				_ = inner.Close()
			case <-waiting:
			}
		}()
	}
	if err := inner.SetReadDeadline(time.Now().Add(fxpServerHelloWait)); err != nil {
		return 0, err
	}
	var b [1]byte
	if _, err := io.ReadFull(inner, b[:]); err != nil {
		return 0, err
	}
	if err := inner.SetReadDeadline(time.Time{}); err != nil {
		return 0, err
	}
	return b[0], nil
}

// v3PeekedConn 把已经读掉的第一个字节还给后面的读者；写（含 WriteBuffers）原样交给内层。
type v3PeekedConn struct {
	*v3.InnerConn
	first   byte
	pending bool
}

func (c *v3PeekedConn) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	if c.pending {
		c.pending = false
		p[0] = c.first
		return 1, nil
	}
	return c.InnerConn.Read(p)
}

func serveV3Session(role string, inner net.Conn, in *fxpInbound, shaper *linkShaper, handler func(*secureConn, *fxpInbound) error) error {
	session := v3.NewSession(inner, v3.SessionOptions{Client: false})
	defer session.Wait()
	defer session.Close()
	var streams sync.WaitGroup
	defer streams.Wait()
	for {
		stream, err := session.Accept()
		if err != nil {
			// 先关会话，让还在跑的逻辑流退出，再等它们的处理协程。
			session.Close()
			if errors.Is(err, v3.ErrIdle) || errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || isClosedErr(err) {
				return nil
			}
			return err
		}
		release, ok, _ := v3BusinessGate.acquire(stream.RemoteAddr())
		if !ok {
			_ = stream.Close()
			fxpVerbosef("fxp %s V3 stream rejected: global business connection limit=%d", role, fxpListenerMaxConnections)
			continue
		}
		streamIn := in.forStream(stream)
		streams.Add(1)
		go func() {
			defer streams.Done()
			defer release()
			defer streamIn.releaseStream(stream)
			defer stream.Close()
			err := catchPanic("v3 stream", func() error {
				return handler(newV3SecureConn(stream, shaper, nil), streamIn)
			})
			if err != nil && !isClosedErr(err) {
				log.Printf("%s V3 stream error peer=%s: %v", role, stream.RemoteAddr(), err)
			}
		}()
	}
}

// forStream 给多路复用的一个逻辑流生成它自己的监听状态：连接闸由物理连接占着，
// 逻辑流只在监听上单独登记（重载按目标表收回时只断这一条）。
func (in *fxpInbound) forStream(stream net.Conn) *fxpInbound {
	if in == nil {
		return nil
	}
	child := &fxpInbound{role: in.role, stopping: in.stopping}
	if in.tracked != nil && in.tracked.slot != nil {
		child.tracked = in.tracked.slot.track(stream)
	}
	return child
}

func (in *fxpInbound) releaseStream(stream net.Conn) {
	if in != nil && in.tracked != nil && in.tracked.slot != nil {
		in.tracked.slot.untrack(stream)
	}
}

// ---- 入口 / 中转：多路复用会话池 ----

type v3PoolBucket struct {
	sessions []*v3.Session
	dialing  bool
	changed  chan struct{}
	lastErr  error
}

type v3SessionPool struct {
	mu      sync.Mutex
	buckets map[[32]byte]*v3PoolBucket
	count   int // 含正在握手的，并发拨号也有上限。
	closed  bool
}

var v3Outbound = &v3SessionPool{buckets: make(map[[32]byte]*v3PoolBucket)}

func v3PoolKey(host string, port int, cfg config) [32]byte {
	// 不含规则自己的目标、配额、PROXY 选项：那些在每个逻辑流的 hello 里。不同隧道密钥、
	// 不同外层选项绝不共用一条物理连接。
	data, _ := json.Marshal([]any{host, port, cfg.TunnelID, cfg.Key, cfg.V3Transport, cfg.V3Host, cfg.V3Path, cfg.V3UserAgent, cfg.V3ServerName, cfg.TCPFastOpen})
	return sha256.Sum256(data)
}

// openAt 在指定端点的物理会话上开一个逻辑流；没有可用的会话就拨一条。reused 表示没有
// 新拨物理连接。逻辑流开出去之后，hello 和业务数据都不会重放到别的会话上。
func (p *v3SessionPool) openAt(host string, port int, cfg config) (net.Conn, *secureConn, bool, error) {
	if err := validateTransportConfig(cfg); err != nil {
		return nil, nil, false, err
	}
	key := v3PoolKey(host, port, cfg)
	shaper := linkShaperHandle("up", cfg)
	dialed := false
	retries := 0
	for {
		p.mu.Lock()
		if p.closed {
			p.mu.Unlock()
			return nil, nil, false, net.ErrClosed
		}
		bucket := p.buckets[key]
		if bucket == nil {
			bucket = &v3PoolBucket{changed: make(chan struct{})}
			p.buckets[key] = bucket
		}
		var selected *v3.Session
		mostSlots := 0
		// 已经出错的会话丢掉；最近没证明过自己活着的也不用 —— 对端悄悄没了的会话
		// 还会报「有空位」，空位数不等于健康。
		alive := bucket.sessions[:0]
		for _, session := range bucket.sessions {
			if session.Err() != nil {
				continue
			}
			if !session.Alive(v3SessionStaleAge) {
				// 过期的会话移出桶并关掉；池子的名额由它自己的协程归还。
				session.Close()
				continue
			}
			alive = append(alive, session)
			if n := session.OpenSlots(); n > mostSlots {
				selected = session
				mostSlots = n
			}
		}
		bucket.sessions = alive
		if selected != nil {
			// 挑中的会话快满了：后台再备一条，下一批新连接不用排在建连后面。
			predial := mostSlots <= v3PoolLowSlots && p.startDialLocked(bucket)
			p.mu.Unlock()
			if predial {
				go func() { _ = p.finishDial(key, bucket, host, port, cfg, shaper) }()
			}
			stream, err := selected.Open()
			if errors.Is(err, v3.ErrStreamLimit) {
				continue
			}
			if err != nil {
				// 会话刚在手里死了：关掉它，下一轮拨一条新的，不重试已死的那条。
				selected.Close()
				if retries < 2 {
					retries++
					continue
				}
				return nil, nil, false, err
			}
			return stream, newV3SecureConn(stream, shaper, nil), !dialed, nil
		}
		if bucket.dialing {
			changed := bucket.changed
			p.mu.Unlock()
			<-changed
			p.mu.Lock()
			err := bucket.lastErr
			p.mu.Unlock()
			if err != nil {
				return nil, nil, false, err
			}
			continue
		}
		if p.count >= v3PoolSessionLimit {
			if len(bucket.sessions) == 0 {
				delete(p.buckets, key)
			}
			p.mu.Unlock()
			return nil, nil, false, fmt.Errorf("%w (%d sessions, 128 streams/session)", v3ErrPoolLimit, v3PoolSessionLimit)
		}
		p.startDialLocked(bucket)
		p.mu.Unlock()
		dialed = true
		if err := p.finishDial(key, bucket, host, port, cfg, shaper); err != nil {
			return nil, nil, false, err
		}
		// 回到正常的挑选流程：同时在等的业务连接可以共用这条刚认证好的会话。
	}
}

// v3PoolLowSlots：挑中的会话空位不多于这么多时，后台再备一条会话。
const v3PoolLowSlots = 16

// startDialLocked 占一个拨号名额（这个桶同时只拨一条，整个池子不超过 v3PoolSessionLimit），
// 报告占没占上。调用方持有 p.mu；占上了之后必须调一次 finishDial。
func (p *v3SessionPool) startDialLocked(bucket *v3PoolBucket) bool {
	if p.closed || bucket.dialing || p.count >= v3PoolSessionLimit {
		return false
	}
	bucket.dialing = true
	p.count++
	return true
}

// finishDial 拨一条物理会话（外层、内层握手都做完）并放进桶里，叫醒在等这个桶的业务连接。
func (p *v3SessionPool) finishDial(key [32]byte, bucket *v3PoolBucket, host string, port int, cfg config, shaper *linkShaper) error {
	raw, inner, err := dialV3Inner(host, port, cfg)
	var session *v3.Session
	if err == nil {
		shaper.attach(raw)
		session = v3.NewSession(inner, v3.SessionOptions{Client: true, IdleTimeout: v3ClientIdleTimeout})
	}
	p.mu.Lock()
	bucket.dialing = false
	if p.closed && err == nil {
		session.Close()
		err = net.ErrClosed
	}
	bucket.lastErr = err
	if err == nil {
		bucket.sessions = append(bucket.sessions, session)
	} else {
		p.count--
		if len(bucket.sessions) == 0 && p.buckets[key] == bucket {
			delete(p.buckets, key)
		}
	}
	close(bucket.changed)
	bucket.changed = make(chan struct{})
	p.mu.Unlock()
	if err != nil {
		return err
	}
	go p.releaseWhenClosed(key, bucket, session)
	return nil
}

// warm 让这个端点至少有一条认证好、有空位的物理会话（复用时的「预热」）：没有就在后台拨一条，
// 第一条用户连接只要发一个 OPEN，不用等 TCP / TLS / 内层握手。端点状态的维护循环在端点
// 活跃（最近有人用、或者规则刚起来）时每秒调一次；空闲会话入口 20 秒就关，下一秒再补。
func (p *v3SessionPool) warm(host string, port int, cfg config) {
	if validateTransportConfig(cfg) != nil {
		return
	}
	key := v3PoolKey(host, port, cfg)
	p.mu.Lock()
	bucket := p.buckets[key]
	if bucket == nil {
		if p.closed {
			p.mu.Unlock()
			return
		}
		bucket = &v3PoolBucket{changed: make(chan struct{})}
		p.buckets[key] = bucket
	}
	for _, session := range bucket.sessions {
		if session.Alive(v3SessionStaleAge) && session.OpenSlots() > v3PoolLowSlots {
			p.mu.Unlock()
			return
		}
	}
	started := p.startDialLocked(bucket)
	if !started && len(bucket.sessions) == 0 && !bucket.dialing && p.buckets[key] == bucket {
		delete(p.buckets, key)
	}
	p.mu.Unlock()
	if started {
		go func() {
			if err := p.finishDial(key, bucket, host, port, cfg, linkShaperHandle("up", cfg)); err != nil {
				fxpVerbosef("v3 session prewarm %s failed: %v", net.JoinHostPort(host, strconv.Itoa(port)), err)
			}
		}()
	}
}

// releaseWhenClosed 在物理会话结束时归还它的池子名额，恰好一次。名额在开始拨号时就算上了，
// 这里无条件减；桶可能已经把它剪掉了（过期的会话先移出再关），那就只跳过移除这一步。
func (p *v3SessionPool) releaseWhenClosed(key [32]byte, bucket *v3PoolBucket, session *v3.Session) {
	<-session.Done()
	session.Wait()
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.count > 0 {
		p.count--
	}
	for i, value := range bucket.sessions {
		if value == session {
			bucket.sessions = append(bucket.sessions[:i], bucket.sessions[i+1:]...)
			break
		}
	}
	if len(bucket.sessions) == 0 && !bucket.dialing && p.buckets[key] == bucket {
		delete(p.buckets, key)
	}
}

// Close 关掉所有物理会话并等它们退出（进程退出时）。
func (p *v3SessionPool) Close() {
	p.mu.Lock()
	p.closed = true
	var sessions []*v3.Session
	for _, bucket := range p.buckets {
		sessions = append(sessions, bucket.sessions...)
	}
	p.mu.Unlock()
	for _, session := range sessions {
		session.Close()
	}
	done := make(chan struct{})
	go func() {
		for _, session := range sessions {
			session.Wait()
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
	}
}

// v3Describe 是启动日志里的一句话。
func v3Describe(cfg config) string {
	if !v3Enabled(cfg) {
		return ""
	}
	parts := []string{"transport=" + cfg.V3Transport, fmt.Sprintf("mux=%v", v3MuxEnabled(cfg))}
	if cfg.V3Path != "" {
		parts = append(parts, "path="+cfg.V3Path)
	}
	return strings.Join(parts, " ")
}
