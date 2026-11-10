package main

import (
	"crypto/rand"
	"encoding/binary"
	"net"
	"net/netip"
	"sync"
	"sync/atomic"
	"time"

	kcp "github.com/xtaci/kcp-go/v5"
)

/*
抗丢包传输的监听方（出口、中转）。

不另开端口：KCP 的包走和 TCP 监听同号的 UDP 端口。那个 UDP 端口平时已经被 UDP 直连
（udp_direct.go）的读循环占着，所以这里不自己读套接字 —— UDP 直连的读循环把认不出来的、
"FXPK" 开头的包交过来（lossCarrierDeliver），回包也从同一个套接字发出去。隧道不跑 UDP
直连、或者 UDP 直连在别的端口（mimic）时，运行时另起一个只做这件事的读循环
（serveLossCarrierUDP）。两种情况下，线上只有这一个 UDP 端口。

一个监听上的所有会话按来源地址区分：先收到并核对过 OPEN，才给这个地址记一项（lcPeer）、
派生会话密钥；之后这个地址来的数据包验过标签才交给 kcp-go 建会话。没有这一项的地址
发数据过来（本机重启过、会话已经拆了），回一个 RESET。
*/

const (
	// 一个监听最多记这么多来源地址（含还没建起会话的）。每项几百字节。
	lcMaxPeers = 16384
	// 答过 OPEN 之后这么久还没见到数据包，这一项就收回。
	lcPendingPeerTTL = 15 * time.Second
	// 同一地址换了随机数再来 OPEN：旧会话这么久没动静才让位（拨号方崩了重启、碰巧又用了
	// 同一个端口）。还活着的会话不让别人顶掉。
	lcPeerTakeoverAfter = 15 * time.Second
	lcInboundQueue      = 4096
	// RESET 每秒最多回这么多个：它回给的是没验过的来源，不能让人拿来刷流量。
	lcResetPerSecond = 200
)

var lossCarrierRefuseLog = newRateLimitedLog(30 * time.Second)

// lossCarrierRefusesTCP：隧道开了抗丢包传输，上一跳却从 TCP 连进来 —— 它的 FXP 还是旧版本、
// 或者新配置还没到它那儿。这种连接不接：接了，用户以为开了抗丢包，其实走的还是 TCP。
// 握手通过以后才判断，没认证的连接不会刷这条日志。
func lossCarrierRefusesTCP(role string, cfg config, conn net.Conn) bool {
	if !cfg.LossTolerant || isLossCarrierConn(conn) {
		return false
	}
	lossCarrierRefuseLog.Printf("%s refused tcp session tunnel=%d from=%s: this tunnel uses the loss-tolerant (udp) transport, the upstream hop dialled over tcp (its agent / fxp is outdated or has not applied the new config yet)", role, cfg.TunnelID, conn.RemoteAddr())
	return true
}

type lcDatagram struct {
	buf  []byte
	from netip.AddrPort
}

type lcPeer struct {
	ln          *lossCarrierListener
	addr        netip.AddrPort
	udpAddr     *net.UDPAddr
	sid         uint32
	conv        uint32
	clientNonce [lcNonceSize]byte
	serverNonce [lcNonceSize]byte
	keys        lcSessionKeys
	createdAt   time.Time
	lastSeen    atomic.Int64
	sendCounter atomic.Uint64
	conn        atomic.Pointer[lossCarrierConn]
}

func (p *lcPeer) sendControl(typ byte, body []byte) {
	var buf [lcOverhead + 16]byte
	p.ln.send(p.addr, lcSeal(buf[:0], p.keys.s2c, typ, p.sid, p.sendCounter.Add(1), body))
}

func (p *lcPeer) release() {
	p.ln.removePeer(p)
}

// lossCarrierListener 同时是给运行时用的 net.Listener 和交给 kcp-go 的 net.PacketConn。
type lossCarrierListener struct {
	registryKey string
	addr        *net.UDPAddr
	tunnelID    int
	static      atomic.Pointer[lcStaticKeys]
	key         atomic.Pointer[string]
	// sock 是眼下收包的那个 UDP 套接字，回包从它发。UDP 监听被重载换掉时跟着换。
	sock    atomic.Pointer[net.UDPConn]
	inbound chan lcDatagram

	mu    sync.RWMutex
	peers map[netip.AddrPort]*lcPeer

	kcpListener *kcp.Listener
	accepts     chan net.Conn
	// stopping：运行时关了监听，不再接新会话；已有的会话照常收发，直到它们自己结束
	// （和 TCP 监听关掉后旧连接继续跑一样）。closed：最后一条会话也走了，彻底停。
	stopping     chan struct{}
	stopOnce     sync.Once
	closed       chan struct{}
	finalizeOnce sync.Once

	resetWindow atomic.Int64
	resetCount  atomic.Int64
}

// lossCarrierListeners：UDP 监听键（listenSlotKey("udp", host, port)）→ 监听。
// UDP 读循环按自己的监听键来这里找。
var lossCarrierListeners sync.Map

func lossCarrierListenKey(host string, port int) string {
	return listenSlotKey("udp", host, port)
}

// lossCarrierDeliver 由 UDP 读循环调用：raw 不是它自己的包。不是 "FXPK" 开头、或者这个
// 端口上没开抗丢包监听，什么都不做 —— 没开这个模式的隧道只多一次 4 字节比较，而且
// 只发生在本来就要丢掉的包上。
func lossCarrierDeliver(registryKey string, sock *net.UDPConn, raw []byte, from netip.AddrPort) {
	if len(raw) < lcOverhead || string(raw[:4]) != lossCarrierMagic {
		return
	}
	if ln, ok := lossCarrierListeners.Load(registryKey); ok {
		ln.(*lossCarrierListener).deliver(sock, raw, from)
	}
}

// serveLossCarrierUDP：这个 UDP 端口上没有 UDP 直连时，只替抗丢包监听收包。
func serveLossCarrierUDP(conn *net.UDPConn, registryKey string) error {
	buf := make([]byte, 2048)
	for {
		n, from, err := conn.ReadFromUDPAddrPort(buf)
		if err != nil {
			return err
		}
		lossCarrierDeliver(registryKey, conn, buf[:n], fxpUDPNormalizeAddrPort(from))
	}
}

func listenLossCarrier(host string, port int, cfg config) (*lossCarrierListener, error) {
	static, err := lcStaticKeysFor(cfg.Key, cfg.TunnelID)
	if err != nil {
		return nil, err
	}
	addr, err := net.ResolveUDPAddr("udp", listenAddress(host, port))
	if err != nil {
		return nil, err
	}
	ln := &lossCarrierListener{
		registryKey: lossCarrierListenKey(host, port),
		addr:        addr,
		tunnelID:    cfg.TunnelID,
		inbound:     make(chan lcDatagram, lcInboundQueue),
		peers:       map[netip.AddrPort]*lcPeer{},
		accepts:     make(chan net.Conn, 64),
		stopping:    make(chan struct{}),
		closed:      make(chan struct{}),
	}
	ln.static.Store(static)
	key := cfg.Key
	ln.key.Store(&key)
	if ln.kcpListener, err = kcp.ServeConn(nil, lcDataShards, lcParityShards, ln); err != nil {
		return nil, err
	}
	lossCarrierListeners.Store(ln.registryKey, ln)
	lcRuntime.mu.Lock()
	lcRuntime.listeners[ln] = struct{}{}
	lcRuntime.mu.Unlock()
	lcRuntime.once.Do(func() { go lcMaintenanceLoop() })
	go ln.acceptLoop()
	return ln, nil
}

// updateKey 在重载换了隧道密钥时调用：之后的 OPEN 按新密钥核对。已经建起来的会话用的是
// 各自的会话密钥，由运行时按「密钥变了全部断开」的老规矩关掉。
func (ln *lossCarrierListener) updateKey(cfg config) error {
	if current := ln.key.Load(); current != nil && *current == cfg.Key {
		return nil
	}
	static, err := lcStaticKeysFor(cfg.Key, cfg.TunnelID)
	if err != nil {
		return err
	}
	key := cfg.Key
	ln.key.Store(&key)
	ln.static.Store(static)
	return nil
}

func (ln *lossCarrierListener) deliver(sock *net.UDPConn, raw []byte, from netip.AddrPort) {
	if ln.sock.Load() != sock {
		ln.sock.Store(sock)
	}
	buf := getFXPByteBuffer(len(raw))
	copy(buf, raw)
	select {
	case ln.inbound <- lcDatagram{buf: buf, from: from}:
	default:
		// 处理不过来就丢：对 KCP 来说和线路丢包一样，会重传。
		putFXPByteBuffer(buf)
	}
}

func (ln *lossCarrierListener) send(to netip.AddrPort, pkt []byte) {
	if sock := ln.sock.Load(); sock != nil {
		// 发不出去（套接字正被重载换掉、对端不可达）不算会话的错，KCP 会重传。
		_, _ = sock.WriteToUDPAddrPort(pkt, to)
	}
}

func (ln *lossCarrierListener) peer(addr netip.AddrPort) *lcPeer {
	ln.mu.RLock()
	peer := ln.peers[addr]
	ln.mu.RUnlock()
	return peer
}

func (ln *lossCarrierListener) removePeer(peer *lcPeer) {
	ln.mu.Lock()
	if ln.peers[peer.addr] == peer {
		delete(ln.peers, peer.addr)
	}
	ln.mu.Unlock()
}

// sweep 每秒一次：收回答过 OPEN 却一直没建起会话的项；监听已经关了、会话也都走了就收尾。
func (ln *lossCarrierListener) sweep(now time.Time) {
	ln.mu.Lock()
	for addr, peer := range ln.peers {
		if peer.conn.Load() == nil && now.Sub(peer.createdAt) > lcPendingPeerTTL {
			delete(ln.peers, addr)
		}
	}
	remaining := len(ln.peers)
	ln.mu.Unlock()
	if remaining == 0 && ln.isStopping() {
		ln.finalize()
	}
}

func (ln *lossCarrierListener) isStopping() bool {
	select {
	case <-ln.stopping:
		return true
	default:
		return false
	}
}

func (ln *lossCarrierListener) finalize() {
	ln.finalizeOnce.Do(func() {
		lossCarrierListeners.CompareAndDelete(ln.registryKey, ln)
		lcRuntime.mu.Lock()
		delete(lcRuntime.listeners, ln)
		lcRuntime.mu.Unlock()
		close(ln.closed)
		_ = ln.kcpListener.Close()
	})
}

// ---- net.PacketConn：kcp-go 从这里收发 ----

func (ln *lossCarrierListener) ReadFrom(p []byte) (int, net.Addr, error) {
	for {
		select {
		case dg := <-ln.inbound:
			n, addr, ok := ln.handle(dg, p)
			putFXPByteBuffer(dg.buf)
			if ok {
				return n, addr, nil
			}
		case <-ln.closed:
			return 0, nil, net.ErrClosed
		}
	}
}

func (ln *lossCarrierListener) handle(dg lcDatagram, p []byte) (int, net.Addr, bool) {
	pkt := dg.buf
	header, ok := lcParse(pkt)
	if !ok {
		return 0, nil, false
	}
	if header.typ == lcTypeOpen {
		ln.handleOpen(dg.from, header, pkt)
		return 0, nil, false
	}
	peer := ln.peer(dg.from)
	if peer == nil || peer.sid != header.sid {
		ln.sendReset(dg.from, header)
		return 0, nil, false
	}
	if !lcVerify(peer.keys.c2s, pkt) {
		return 0, nil, false
	}
	now := time.Now().UnixNano()
	peer.lastSeen.Store(now)
	conn := peer.conn.Load()
	if conn != nil {
		conn.touch(now)
	}
	switch header.typ {
	case lcTypeData:
		return copy(p, lcBody(pkt)), peer.udpAddr, true
	case lcTypePing:
		peer.sendControl(lcTypePong, nil)
	case lcTypeFin:
		body := lcBody(pkt)
		switch {
		case conn != nil:
			conn.onControl(lcTypeFin, body)
		case len(body) == 8 && binary.BigEndian.Uint64(body) == 0:
			// 一个字节都没写就关了（连接池换新连接）：答应它，收回这一项。
			peer.sendControl(lcTypeFinAck, nil)
			ln.removePeer(peer)
		default:
			// 写过数据、但会话还没建起来（数据包丢了、FIN 先到）：先不理，对端会重发 FIN，
			// 等数据到了、会话交到运行时手里再处理。这时答应了，对端就把没送到的数据扔了。
		}
	case lcTypeFinAck:
		if conn != nil {
			conn.onControl(lcTypeFinAck, nil)
		}
	}
	return 0, nil, false
}

func (ln *lossCarrierListener) handleOpen(from netip.AddrPort, header lcHeader, pkt []byte) {
	static := ln.static.Load()
	if ln.isStopping() || len(pkt) != lcOverhead+lcNonceSize+4 || !lcVerify(static.open, pkt) {
		return
	}
	body := lcBody(pkt)
	now := time.Now()
	ln.mu.Lock()
	peer := ln.peers[from]
	if peer != nil && string(peer.clientNonce[:]) != string(body[:lcNonceSize]) {
		conn := peer.conn.Load()
		if conn != nil && now.UnixNano()-peer.lastSeen.Load() < int64(lcPeerTakeoverAfter) {
			ln.mu.Unlock()
			return
		}
		delete(ln.peers, from)
		if conn != nil {
			go conn.fail(errLossCarrierReset)
		}
		peer = nil
	}
	if peer == nil {
		if len(ln.peers) >= lcMaxPeers {
			ln.mu.Unlock()
			return
		}
		peer = &lcPeer{ln: ln, addr: from, udpAddr: net.UDPAddrFromAddrPort(from), sid: header.sid, createdAt: now}
		copy(peer.clientNonce[:], body[:lcNonceSize])
		peer.conv = binary.BigEndian.Uint32(body[lcNonceSize:])
		if _, err := rand.Read(peer.serverNonce[:]); err != nil {
			ln.mu.Unlock()
			return
		}
		keys, err := lcDeriveSessionKeys(*ln.key.Load(), ln.tunnelID, peer.clientNonce[:], peer.serverNonce[:])
		if err != nil {
			ln.mu.Unlock()
			return
		}
		peer.keys = keys
		peer.lastSeen.Store(now.UnixNano())
		ln.peers[from] = peer
	}
	ln.mu.Unlock()
	// OPEN-ACK 用隧道密钥派生的静态钥匙，nonce 里的计数取随机数：同一个 OPEN 重发几次，
	// 每次回的包 nonce 都不一样。
	var counter [8]byte
	if _, err := rand.Read(counter[:]); err != nil {
		return
	}
	var ack [2 * lcNonceSize]byte
	copy(ack[:lcNonceSize], peer.clientNonce[:])
	copy(ack[lcNonceSize:], peer.serverNonce[:])
	var buf [lcOverhead + 2*lcNonceSize]byte
	ln.send(from, lcSeal(buf[:0], static.openAck, lcTypeOpenAck, header.sid, binary.BigEndian.Uint64(counter[:]), ack[:]))
}

func (ln *lossCarrierListener) sendReset(to netip.AddrPort, header lcHeader) {
	second := time.Now().Unix()
	if ln.resetWindow.Swap(second) != second {
		ln.resetCount.Store(0)
	}
	if ln.resetCount.Add(1) > lcResetPerSecond {
		return
	}
	var buf [lcOverhead]byte
	// 计数照抄对方那个包的：拨号方只认「计数是自己发过的」RESET。
	ln.send(to, lcSeal(buf[:0], ln.static.Load().reset, lcTypeReset, header.sid, header.counter, nil))
}

func (ln *lossCarrierListener) WriteTo(p []byte, addr net.Addr) (int, error) {
	udpAddr, ok := addr.(*net.UDPAddr)
	if !ok {
		return len(p), nil
	}
	peer := ln.peer(fxpUDPAddrPortOf(udpAddr))
	if peer == nil {
		return len(p), nil
	}
	buf := getFXPByteBuffer(len(p) + lcOverhead)
	ln.send(peer.addr, lcSeal(buf[:0], peer.keys.s2c, lcTypeData, peer.sid, peer.sendCounter.Add(1), p))
	putFXPByteBuffer(buf)
	return len(p), nil
}

func (ln *lossCarrierListener) LocalAddr() net.Addr              { return ln.addr }
func (ln *lossCarrierListener) SetDeadline(time.Time) error      { return nil }
func (ln *lossCarrierListener) SetReadDeadline(time.Time) error  { return nil }
func (ln *lossCarrierListener) SetWriteDeadline(time.Time) error { return nil }

// ---- net.Listener：运行时从这里接连接 ----

func (ln *lossCarrierListener) acceptLoop() {
	for {
		sess, err := ln.kcpListener.AcceptKCP()
		if err != nil {
			return
		}
		var peer *lcPeer
		if udpAddr, ok := sess.RemoteAddr().(*net.UDPAddr); ok {
			peer = ln.peer(fxpUDPAddrPortOf(udpAddr))
		}
		if peer == nil || peer.conn.Load() != nil || sess.GetConv() != peer.conv {
			_ = sess.Close()
			continue
		}
		lcTuneSession(sess)
		conn := newLossCarrierConn(peer, false)
		conn.sess = sess
		peer.conn.Store(conn)
		lcRegisterConn(conn)
		select {
		case ln.accepts <- conn:
		case <-ln.stopping:
			conn.fail(errLossCarrierReset)
		}
	}
}

func (ln *lossCarrierListener) Accept() (net.Conn, error) {
	select {
	case <-ln.stopping:
		return nil, net.ErrClosed
	default:
	}
	select {
	case conn := <-ln.accepts:
		return conn, nil
	case <-ln.stopping:
		return nil, net.ErrClosed
	}
}

func (ln *lossCarrierListener) Addr() net.Addr { return ln.addr }

// Close 停止接新会话。已经交出去的连接由运行时自己关（和 TCP 监听一样），它们都结束
// 之后 sweep 才把收包停掉。
func (ln *lossCarrierListener) Close() error {
	ln.stopOnce.Do(func() {
		close(ln.stopping)
		// 还排在队里没被接走的会话没人管了。
		for {
			select {
			case conn := <-ln.accepts:
				if carrier, ok := conn.(*lossCarrierConn); ok {
					carrier.fail(errLossCarrierReset)
				}
				continue
			default:
			}
			break
		}
	})
	return nil
}
