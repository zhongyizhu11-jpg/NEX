package main

import (
	"crypto/cipher"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"io"
	"log"
	"net"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	kcp "github.com/xtaci/kcp-go/v5"
	"golang.org/x/crypto/chacha20poly1305"
)

/*
抗丢包传输（配置里的 lossTolerant，默认关）：入口 / 中转到下一跳的那条承载连接不走 TCP，
改走 UDP 上的 KCP（选择重传、不因丢包收窗口）加 Reed-Solomon 前向纠错（每 10 个数据包
带 3 个冗余包，丢了当场补回来，不用等重传）。承载之上的握手、AEAD 帧、连接池、多路径、
流量统计原样复用 —— 它们只认 net.Conn。设计说明见 LOSS_TOLERANT_TRANSPORT.md。

KCP 只管「可靠 + 有序」，一条能替 TCP 的承载还缺四样，都在这一层补上：

  - 建连（OPEN / OPEN-ACK）：拨号方先问一声，对端答了才算连上。UDP 被防火墙拦了、对端
    没开这个模式、版本太旧，拨号当场超时报错（模式是严格的，不会退回 TCP）。出口也只给
    答过 OPEN 的来源地址建 KCP 会话：伪造来源的包建不了会话，占不了内存。
  - 逐包认证：每个包带 16 字节的 ChaCha20-Poly1305 标签（只认证不加密，内容本来就是上层
    AEAD 的密文）。密钥按会话从隧道密钥派生，不知道隧道密钥的人插不进包，也伪造不了
    下面的控制包。
  - 关闭（FIN / FIN-ACK）：KCP 没有 FIN。本端 Close 之后会话还要留在后台把没确认的数据
    送完（TCP 的 close 也是这样），对端读完全部字节才看到 EOF。不这么做，出口写完最后
    一块就关，尾巴上的数据直接丢。
  - 保活和复位（PING / PONG / RESET）：拨号方隔几秒没收到任何包就 PING 一次，顺带保住
    NAT 映射；45 秒什么都没收到就当对端没了。对端重启后不认识这条会话，回 RESET，这边
    立刻报错 —— 不然连接池里的旧连接会一直挂到超时。

线上格式（每个 UDP 包）：

	"FXPK"(4) | 类型(1) | 会话号 sid(4) | 计数(8) | 内容 | 认证标签(16)

sid + 计数正好 12 字节，就是认证用的 nonce；标签盖住包头和内容。开头 4 字节和 UDP 直连的
"FXPU" / "FXPF" 不同，所以能和 UDP 直连共用同一个 UDP 端口（见 loss_carrier_listen.go）。
*/

const (
	lossCarrierMagic = "FXPK"

	lcTypeOpen    = byte(1)
	lcTypeOpenAck = byte(2)
	lcTypeData    = byte(3)
	lcTypePing    = byte(4)
	lcTypePong    = byte(5)
	lcTypeFin     = byte(6)
	lcTypeFinAck  = byte(7)
	lcTypeReset   = byte(8)

	lcHeaderSize = 4 + 1 + 4 + 8
	lcTagSize    = 16
	lcOverhead   = lcHeaderSize + lcTagSize
	lcNonceSize  = 16

	// 一个 UDP 包最多这么多字节。跨境线路上常有隧道套隧道（PPPoE 1492、WireGuard 1420），
	// 分片的 UDP 包丢一片就整包作废，所以按 IPv6 下整包 1420 来留：1372 + 8 + 40。
	lcWireMTU = 1372
	lcKCPMTU  = lcWireMTU - lcOverhead

	// 前向纠错：10 个数据包配 3 个冗余包，一组里丢 3 个以内当场还原，多耗约 30% 流量。
	lcDataShards   = 10
	lcParityShards = 3

	// KCP 的窗口（包数）。关掉了拥塞窗口（丢包不降速，这是它抗丢包的来源），所以在途
	// 数据量由这个固定窗口封顶：约 1.3 MB，单条连接的速率上限 ≈ 1.3 MB ÷ 往返时间
	// （200 ms 的线路约 50 Mbit/s）。再大每条连接两个方向各多占几 MB 内存，突发也更猛。
	lcSendWindow = 1024
	lcRecvWindow = 1024
	// KCP 内部时钟（毫秒）：多久冲一次待发的确认和重传。
	lcInterval = 20

	lcOpenRetryMin = 250 * time.Millisecond
	lcOpenRetryMax = time.Second
	// 拨号方这么久没收到对端任何包就 PING 一次。
	lcPingEvery = 5 * time.Second
	// 这么久没收到对端任何包（数据、确认、PONG 都算）就当它没了。15% 丢包时一次
	// PING / PONG 来回有约 28% 的概率丢，连丢 9 次的概率不到十万分之一。
	lcDeadAfter = 45 * time.Second
	// Close 之后最多在后台留这么久把数据送完；对端一直不读也不能无限期留着。
	lcLingerMax    = 2 * time.Minute
	lcFinRetryMin  = 200 * time.Millisecond
	lcFinRetryMax  = time.Second
	lcSocketBuffer = 1 << 20

	lcMasterContext = "forwardx-fxp loss-tolerant carrier v1"
)

// lossCarrierError 是这一层自己的错误。text 里带着 isClosedErr 认得的字样时，上层把它
// 当成「对端关了」处理（和 TCP 的 RST / EPIPE 一个口径）。
type lossCarrierError struct {
	text    string
	timeout bool
}

func (e *lossCarrierError) Error() string   { return e.text }
func (e *lossCarrierError) Timeout() bool   { return e.timeout }
func (e *lossCarrierError) Temporary() bool { return false }

var (
	errLossCarrierReset      = &lossCarrierError{text: "loss-tolerant transport: connection reset by peer"}
	errLossCarrierPeerClosed = &lossCarrierError{text: "loss-tolerant transport: broken pipe (peer closed the connection)"}
	errLossCarrierPeerLost   = &lossCarrierError{text: "loss-tolerant transport: no packet from peer for " + lcDeadAfter.String(), timeout: true}
)

// lossCarrierWrapSocket 只给测试用：把拨号方的 UDP 套接字包一层有损网络。线上是 nil。
var lossCarrierWrapSocket func(net.PacketConn) net.PacketConn

// ---- 密钥和封包 ----

// lcStaticKeys 是从隧道密钥直接派生的三把钥匙，只用在还没有会话的时候：OPEN、OPEN-ACK、
// RESET 各一把，方向和用途分开，录下一种包换不成另一种。
type lcStaticKeys struct {
	open, openAck, reset cipher.AEAD
}

type lcSessionKeys struct {
	c2s, s2c cipher.AEAD
}

type lcStaticKeyID struct {
	key      string
	tunnelID int
}

var lcStaticKeyCache sync.Map // lcStaticKeyID → *lcStaticKeys

func lcMasterSecret(key string) []byte {
	sum := sha256.Sum256([]byte(key))
	return sum[:]
}

func lcTunnelSalt(tunnelID int, extra ...[]byte) []byte {
	salt := make([]byte, 8, 8+2*lcNonceSize)
	binary.BigEndian.PutUint64(salt, uint64(tunnelID))
	for _, part := range extra {
		salt = append(salt, part...)
	}
	return salt
}

func lcStaticKeysFor(key string, tunnelID int) (*lcStaticKeys, error) {
	id := lcStaticKeyID{key: key, tunnelID: tunnelID}
	if cached, ok := lcStaticKeyCache.Load(id); ok {
		return cached.(*lcStaticKeys), nil
	}
	material := blake3Derive(lcMasterSecret(key), lcTunnelSalt(tunnelID), []byte("static"), lcMasterContext, 96)
	keys := &lcStaticKeys{}
	var err error
	for index, dst := range []*cipher.AEAD{&keys.open, &keys.openAck, &keys.reset} {
		if *dst, err = chacha20poly1305.New(material[index*32 : (index+1)*32]); err != nil {
			return nil, err
		}
	}
	lcStaticKeyCache.Store(id, keys)
	return keys, nil
}

// lcDeriveSessionKeys：两边各出 16 字节随机数，会话密钥由它们和隧道密钥一起派生。
// 录下别人的 OPEN 重放过来，拿到的是另一把钥匙，后面的包一个也伪造不了。
func lcDeriveSessionKeys(key string, tunnelID int, clientNonce, serverNonce []byte) (lcSessionKeys, error) {
	material := blake3Derive(lcMasterSecret(key), lcTunnelSalt(tunnelID, clientNonce, serverNonce), []byte("session"), lcMasterContext, 64)
	var keys lcSessionKeys
	var err error
	if keys.c2s, err = chacha20poly1305.New(material[:32]); err != nil {
		return keys, err
	}
	keys.s2c, err = chacha20poly1305.New(material[32:])
	return keys, err
}

type lcHeader struct {
	typ     byte
	sid     uint32
	counter uint64
}

func lcParse(pkt []byte) (lcHeader, bool) {
	if len(pkt) < lcOverhead || string(pkt[:4]) != lossCarrierMagic {
		return lcHeader{}, false
	}
	return lcHeader{typ: pkt[4], sid: binary.BigEndian.Uint32(pkt[5:9]), counter: binary.BigEndian.Uint64(pkt[9:17])}, true
}

// lcSeal 把一个包追加到 dst：包头、内容、认证标签。
func lcSeal(dst []byte, aead cipher.AEAD, typ byte, sid uint32, counter uint64, body []byte) []byte {
	start := len(dst)
	dst = append(dst, lossCarrierMagic...)
	dst = append(dst, typ)
	dst = binary.BigEndian.AppendUint32(dst, sid)
	dst = binary.BigEndian.AppendUint64(dst, counter)
	dst = append(dst, body...)
	return aead.Seal(dst, dst[start+5:start+lcHeaderSize], nil, dst[start:])
}

// lcVerify 核对标签。只认证不解密：明文是空的，包头和内容都当附加数据。
func lcVerify(aead cipher.AEAD, pkt []byte) bool {
	if len(pkt) < lcOverhead {
		return false
	}
	split := len(pkt) - lcTagSize
	_, err := aead.Open(nil, pkt[5:lcHeaderSize], pkt[split:], pkt[:split])
	return err == nil
}

func lcBody(pkt []byte) []byte {
	return pkt[lcHeaderSize : len(pkt)-lcTagSize]
}

// lcTransientSocketError：UDP 套接字上「对端端口眼下没人听」这类错误。已连接的 UDP
// 套接字会把 ICMP 不可达报成下一次读写的错误；对端只是在重启监听时，这条会话还能救，
// 交给失联计时去判，不在这里直接判死。
func lcTransientSocketError(err error) bool {
	if err == nil {
		return false
	}
	text := strings.ToLower(err.Error())
	for _, marker := range []string{"connection refused", "no route to host", "network is unreachable", "host is down", "no buffer space", "operation not permitted", "message too long"} {
		if strings.Contains(text, marker) {
			return true
		}
	}
	return false
}

// ---- 一条承载连接 ----

// lcLink 是连接发控制包、收尾时要用到的那一头：拨号方是自己的套接字，监听方是共用套接字
// 上按来源地址记的那一项。
type lcLink interface {
	sendControl(typ byte, body []byte)
	// release 在会话彻底结束时调用一次（KCP 会话已经关掉）。
	release()
}

// lossCarrierConn 把一条 KCP 会话包成 net.Conn，补上关闭、复位和失联检测。
type lossCarrierConn struct {
	sess   *kcp.UDPSession
	link   lcLink
	dialer bool

	lastRecv atomic.Int64 // 最近一次收到对端认证过的包（UnixNano）
	lastPing atomic.Int64
	written  atomic.Uint64 // 交给 KCP 的字节数
	read     atomic.Uint64 // 交给调用方的字节数

	mu sync.Mutex
	// closed：本端调过 Close。会话可能还在后台送数据（linger）。
	closed bool
	// peerFin：对端关了，它一共写了 peerTotal 字节；读满这么多才是 EOF。
	peerFin   bool
	peerTotal uint64
	failure   error
	// rd 是调用方设的读超时。状态变化要叫醒卡在 Read 里的协程，办法是把 KCP 会话的读超时
	// 拨到「现在」；Read 醒来后按 rd 放回去。
	rd time.Time

	settleOnce  sync.Once
	settled     chan struct{} // 对端确认收齐 / 对端也关了 / 出错：不用再等了
	releaseOnce sync.Once
	done        chan struct{}
}

func newLossCarrierConn(link lcLink, dialer bool) *lossCarrierConn {
	c := &lossCarrierConn{link: link, dialer: dialer, settled: make(chan struct{}), done: make(chan struct{})}
	c.lastRecv.Store(time.Now().UnixNano())
	return c
}

func lcTuneSession(sess *kcp.UDPSession) {
	// 流模式：小的写合进同一个包；不等下一个时钟，写了就发。
	sess.SetStreamMode(true)
	sess.SetWriteDelay(false)
	// nodelay=1（最小重传超时 30 ms，超时每次只加一半）、快速重传（被跳过 2 次就重发）、
	// nc=1（不用拥塞窗口）。
	sess.SetNoDelay(1, lcInterval, 2, 1)
	sess.SetWindowSize(lcSendWindow, lcRecvWindow)
	sess.SetMtu(lcKCPMTU)
	sess.SetACKNoDelay(false)
}

func (c *lossCarrierConn) touch(now int64) {
	c.lastRecv.Store(now)
}

// pokeLocked 叫醒卡在 Read / Write 里的协程。调用方持有 mu。
func (c *lossCarrierConn) pokeLocked() {
	now := time.Now()
	_ = c.sess.SetReadDeadline(now)
	_ = c.sess.SetWriteDeadline(now)
}

func (c *lossCarrierConn) settle() {
	c.settleOnce.Do(func() { close(c.settled) })
}

func lcMapError(err error) error {
	var netErr net.Error
	switch {
	case err == nil:
		return nil
	case errors.Is(err, io.ErrClosedPipe):
		return net.ErrClosed
	case errors.As(err, &netErr) && netErr.Timeout():
		// 上层有的地方直接断言 net.Error，kcp-go 包过一层的超时断言不出来。
		return os.ErrDeadlineExceeded
	}
	return err
}

func (c *lossCarrierConn) Read(b []byte) (int, error) {
	for {
		c.mu.Lock()
		switch {
		case c.closed:
			c.mu.Unlock()
			return 0, net.ErrClosed
		case c.failure != nil:
			err := c.failure
			c.mu.Unlock()
			return 0, err
		case c.peerFin && c.read.Load() >= c.peerTotal:
			c.mu.Unlock()
			return 0, io.EOF
		}
		c.mu.Unlock()
		n, err := c.sess.Read(b)
		if n > 0 {
			total := c.read.Add(uint64(n))
			c.mu.Lock()
			complete := c.peerFin && total >= c.peerTotal
			c.mu.Unlock()
			if complete {
				// 对端在等这一声才肯拆会话。
				c.link.sendControl(lcTypeFinAck, nil)
			}
			return n, nil
		}
		c.mu.Lock()
		woken := c.closed || c.failure != nil || c.peerFin
		expired := !c.rd.IsZero() && !time.Now().Before(c.rd)
		if woken && !expired {
			// 是状态变化把读超时拨到了现在。放回调用方原来的超时再看一遍：对端 FIN 比最后
			// 几段数据先到时，要接着等数据。
			_ = c.sess.SetReadDeadline(c.rd)
			c.mu.Unlock()
			continue
		}
		c.mu.Unlock()
		return 0, lcMapError(err)
	}
}

func (c *lossCarrierConn) writeState() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	switch {
	case c.closed:
		return net.ErrClosed
	case c.failure != nil:
		return c.failure
	case c.peerFin:
		return errLossCarrierPeerClosed
	}
	return nil
}

func (c *lossCarrierConn) Write(b []byte) (int, error) {
	if err := c.writeState(); err != nil {
		return 0, err
	}
	n, err := c.sess.Write(b)
	if n > 0 {
		c.written.Add(uint64(n))
	}
	if err != nil {
		if stateErr := c.writeState(); stateErr != nil {
			return n, stateErr
		}
		return n, lcMapError(err)
	}
	return n, nil
}

// Close 立刻返回；没确认的数据由后台的 linger 接着送，送完（或者对端没了）才拆会话。
func (c *lossCarrierConn) Close() error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil
	}
	c.closed = true
	failed := c.failure != nil
	peerFin := c.peerFin
	c.pokeLocked()
	c.mu.Unlock()
	switch {
	case failed:
		c.release()
	case peerFin:
		// 对端已经关了，不会再读我们的数据；它还在等我们确认收到它的 FIN。
		c.link.sendControl(lcTypeFinAck, nil)
		c.release()
	default:
		go c.linger()
	}
	return nil
}

func (c *lossCarrierConn) linger() {
	var body [8]byte
	binary.BigEndian.PutUint64(body[:], c.written.Load())
	deadline := time.NewTimer(lcLingerMax)
	defer deadline.Stop()
	retry := time.NewTimer(lcFinRetryMin)
	defer retry.Stop()
	interval := lcFinRetryMin
	for {
		c.link.sendControl(lcTypeFin, body[:])
		select {
		case <-c.settled:
			c.release()
			return
		case <-deadline.C:
			c.release()
			return
		case <-retry.C:
		}
		if interval *= 2; interval > lcFinRetryMax {
			interval = lcFinRetryMax
		}
		retry.Reset(interval)
	}
}

func (c *lossCarrierConn) release() {
	c.releaseOnce.Do(func() {
		c.settle()
		lcUnregisterConn(c)
		_ = c.sess.Close()
		c.link.release()
		close(c.done)
	})
}

// fail 把连接判死：对端复位，或者失联。卡着的读写立刻带着这个错误返回。
func (c *lossCarrierConn) fail(err error) {
	c.mu.Lock()
	if c.failure == nil {
		c.failure = err
		c.pokeLocked()
	}
	c.mu.Unlock()
	c.release()
}

// onControl 处理对端发来的、已经认证过的控制包。
func (c *lossCarrierConn) onControl(typ byte, body []byte) {
	switch typ {
	case lcTypeFin:
		if len(body) != 8 {
			return
		}
		total := binary.BigEndian.Uint64(body)
		c.mu.Lock()
		if !c.peerFin {
			c.peerFin = true
			c.peerTotal = total
			c.pokeLocked()
		}
		closed := c.closed
		complete := closed || c.read.Load() >= c.peerTotal
		c.mu.Unlock()
		if complete {
			c.link.sendControl(lcTypeFinAck, nil)
		}
		if closed {
			// 两边都关了，谁也不会再读，不用等了。
			c.settle()
		}
	case lcTypeFinAck:
		c.settle()
	case lcTypeReset:
		c.fail(errLossCarrierReset)
	}
}

func (c *lossCarrierConn) LocalAddr() net.Addr  { return c.sess.LocalAddr() }
func (c *lossCarrierConn) RemoteAddr() net.Addr { return c.sess.RemoteAddr() }

func (c *lossCarrierConn) SetDeadline(t time.Time) error {
	if err := c.SetReadDeadline(t); err != nil {
		return err
	}
	return c.SetWriteDeadline(t)
}

func (c *lossCarrierConn) SetReadDeadline(t time.Time) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return net.ErrClosed
	}
	c.rd = t
	if c.failure != nil || c.peerFin {
		// 保持「叫醒」状态，Read 自己会把 rd 放回去。
		return c.sess.SetReadDeadline(time.Now())
	}
	return c.sess.SetReadDeadline(t)
}

func (c *lossCarrierConn) SetWriteDeadline(t time.Time) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return net.ErrClosed
	}
	if c.failure != nil || c.peerFin {
		return nil
	}
	return c.sess.SetWriteDeadline(t)
}

// alive 给连接池用：这条预热连接还能不能发给用户。
func (c *lossCarrierConn) alive() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return !c.closed && c.failure == nil && !c.peerFin
}

func isLossCarrierConn(conn net.Conn) bool {
	_, ok := conn.(*lossCarrierConn)
	return ok
}

// ---- 保活、失联、统计：整个进程一个协程，有承载连接时才起 ----

var lcRuntime = struct {
	mu        sync.Mutex
	conns     map[*lossCarrierConn]struct{}
	listeners map[*lossCarrierListener]struct{}
	once      sync.Once
}{conns: map[*lossCarrierConn]struct{}{}, listeners: map[*lossCarrierListener]struct{}{}}

func lcRegisterConn(c *lossCarrierConn) {
	lcRuntime.mu.Lock()
	lcRuntime.conns[c] = struct{}{}
	lcRuntime.mu.Unlock()
	lcRuntime.once.Do(func() { go lcMaintenanceLoop() })
}

func lcUnregisterConn(c *lossCarrierConn) {
	lcRuntime.mu.Lock()
	delete(lcRuntime.conns, c)
	lcRuntime.mu.Unlock()
}

func lcMaintenanceLoop() {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	lastStats := time.Now()
	previous := kcp.DefaultSnmp.Copy()
	for now := range ticker.C {
		lcRuntime.mu.Lock()
		conns := make([]*lossCarrierConn, 0, len(lcRuntime.conns))
		for conn := range lcRuntime.conns {
			conns = append(conns, conn)
		}
		listeners := make([]*lossCarrierListener, 0, len(lcRuntime.listeners))
		for ln := range lcRuntime.listeners {
			listeners = append(listeners, ln)
		}
		lcRuntime.mu.Unlock()
		stamp := now.UnixNano()
		for _, conn := range conns {
			idle := time.Duration(stamp - conn.lastRecv.Load())
			switch {
			case idle >= lcDeadAfter:
				conn.fail(errLossCarrierPeerLost)
			case conn.dialer && idle >= lcPingEvery && time.Duration(stamp-conn.lastPing.Load()) >= lcPingEvery:
				conn.lastPing.Store(stamp)
				conn.link.sendControl(lcTypePing, nil)
			}
		}
		for _, ln := range listeners {
			ln.sweep(now)
		}
		if now.Sub(lastStats) >= time.Minute {
			lastStats = now
			current := kcp.DefaultSnmp.Copy()
			lcLogStats(previous, current, len(conns))
			previous = current
		}
	}
}

// lcLogStats 每分钟一行：这一分钟发了多少段、重传多少、纠错补回多少。没流量不打。
func lcLogStats(previous, current *kcp.Snmp, sessions int) {
	out := current.OutSegs - previous.OutSegs
	in := current.InSegs - previous.InSegs
	if out == 0 && in == 0 {
		return
	}
	log.Printf("fxp loss-tolerant stats sessions=%d outSegs=%d retrans=%d (fast=%d timeout=%d) inSegs=%d repeat=%d fecRecovered=%d fecErrs=%d",
		sessions, out,
		current.RetransSegs-previous.RetransSegs,
		current.FastRetransSegs-previous.FastRetransSegs+current.EarlyRetransSegs-previous.EarlyRetransSegs,
		current.LostSegs-previous.LostSegs,
		in, current.RepeatSegs-previous.RepeatSegs,
		current.FECRecovered-previous.FECRecovered,
		current.FECErrs-previous.FECErrs)
}
