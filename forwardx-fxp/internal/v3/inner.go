package v3

// NEX V3 内层：认证握手 + 记录层（协议见 PROTOCOL.md 开头的「NEX 修订」一节）。
//
// 第一条消息仍是上游的形状：1 个模式字节 + 16 字节随机材料（17 字节）。NEX 把模式字节当成
// 版本 / 模式协商用：
//
//	3 / 5  AEAD 记录模式（HTTP / WS 外层，或者 TLS 低于 1.3）。3 = AES-128-GCM，
//	       5 = ChaCha20-Poly1305。客户端发的字节 o 是它想要的（本机有 AES 硬件发 3，没有发 5），
//	       服务端回的字节 m 是定下来的（o 是 5 或者服务端自己没有 AES 硬件 → 5，否则 3）：
//	     C → S  [o][c 16]
//	     S → C  [m][s 16][HMAC(Ka, "s" ‖ m ‖ c ‖ s ‖ o)[:16]]
//	     C → S  [HMAC(Ka, "c" ‖ m ‖ c ‖ s ‖ o)[:16]]，紧接着就是记录
//	   o 和 m 都在两个证明里：中间人改哪一个，两端算出的证明都对不上，握手失败（不会被悄悄压到
//	   某一种算法上）。客户端发了 5 却收到 3 也直接拒绝（服务端不该这么选）。
//	   服务端的证明和它的材料一起发，客户端收到就能验、验完马上发自己的证明和第一批数据：
//	   内层握手只占一个往返（移植版是两个）。记录：2 字节长度单独封、内容单独封，
//	   HKDF-SHA256 派生四把密钥（方向 × 长度 / 内容；AES 16 字节、ChaCha20 32 字节，两种算法的
//	   info 不同），nonce 带方向和用途。
//	4  TLS 直通模式（只在外层是 TLS 1.3 时；TLS 1.3 自己按两端硬件在 AES-GCM 和 ChaCha20 间选）：
//	     C → S  [4][c 16][HMAC(Ka, "t" ‖ 4 ‖ c ‖ exporter)[:16]]，紧接着就是明文字节
//	   exporter 是这条 TLS 连接的导出密钥（RFC 8446 §7.5），证明绑死在这一条 TLS 会话上，
//	   重放到别的连接上没用。服务端的身份由 TLS 证书钉扎证明（证书公钥由隧道密钥派生），
//	   内层不再加一层 AEAD：省掉一半的加解密和每条记录 34 字节的开销，也省掉内层握手的往返。
//
// 移植版（上游形状，模式字节 2）不再接受：NEX V3 在这之前没有发布过，线上没有那样的对端。
// 服务端收到它不认识的模式字节、或者模式和自己的外层对不上（比如不是 TLS 1.3 却收到 4），
// 一律拒绝，不会降级。

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"sync"
	"time"

	"golang.org/x/crypto/chacha20poly1305"
)

const (
	// InnerHandshakeSize 是第一条握手消息：模式字节 + 16 字节材料。
	InnerHandshakeSize = 17
	innerMaterialSize  = 16
	innerTagSize       = 16

	// InnerModeAEAD：内层自己做 AEAD 记录，AES-128-GCM（两端都有 AES 硬件时）。
	InnerModeAEAD byte = 3
	// InnerModeTLS：外层是 TLS 1.3，内层只做绑定在 TLS 会话上的双向认证，之后直通。
	InnerModeTLS byte = 4
	// InnerModeAEADChaCha：内层自己做 AEAD 记录，ChaCha20-Poly1305（任意一端没有 AES 硬件时）。
	InnerModeAEADChaCha byte = 5
	// innerModeLegacy 是移植版（上游形状）的模式字节，不再接受。
	innerModeLegacy byte = 2

	innerInfo       = "nex-v3 records"
	innerInfoChaCha = "nex-v3 records chacha20-poly1305"

	// InnerPayloadLimit 是一条记录最多装多少明文（和 TLS 一样 16 KiB：大一点的记录省的
	// 加解密开销不到 3%，却让低速线路上的接收端要多等一整条记录才能解出第一个字节）。
	InnerPayloadLimit = 16 << 10
	innerOverhead     = 2 + 16 + 16 // 封好的长度 + 两个标签

	innerNonceSize  = 12
	innerMaxCounter = 1<<62 - 1

	// innerReadBuffer：读缓冲一次系统调用最多带回几条记录。
	innerReadBuffer = 4 * (InnerPayloadLimit + innerOverhead)
)

const (
	innerDirClientToServer byte = 0x01
	innerDirServerToClient byte = 0x02
)

const (
	innerKindLength byte = 0x00
	innerKindData   byte = 0x01
)

// TLSExporterLabel 是模式 4 用来导出绑定材料的标签。
const TLSExporterLabel = "EXPORTER-NEX-V3-inner-auth"

var (
	ErrInnerHandshake = errors.New("v3: inner handshake rejected")
	ErrInnerRecord    = errors.New("v3: invalid inner record")
	ErrInnerNonce     = errors.New("v3: inner nonce exhausted")
	// ErrInnerLegacyPeer：对端是移植版（模式字节 2）。
	ErrInnerLegacyPeer = errors.New("v3: peer runs the pre-release V3 inner handshake (mode 2), upgrade it")
)

// InnerConn 是一条过了内层认证的连接。模式 3 / 5 时读写都过 AEAD 记录层；模式 4 时直通到
// 底下的 TLS 连接。写可以多个协程同时调（内部串行），读只能一个协程。
type InnerConn struct {
	conn  net.Conn
	plain bool
	mode  byte

	writeAEAD, readAEAD       cipher.AEAD
	lenWriteAEAD, lenReadAEAD cipher.AEAD
	writeCounter, readCounter uint64
	writeDir, readDir         byte
	// writeKeyID / readKeyID 是派生出的内容密钥的指纹，只给测试 / 诊断用，不泄露密钥。
	writeKeyID, readKeyID [32]byte
	writeMu               sync.Mutex
	writeErr              error

	// 读缓冲：rbuf[rstart:rend] 是收到还没解析的密文；plainBuf 是当前这条记录解出来的
	// 明文（就地解密，指向 rbuf 里），plainOff 是已经交出去的部分。
	rbuf       []byte
	rstart     int
	rend       int
	plainBuf   []byte
	plainOff   int
	readErr    error
	maxPayload int
}

// Mode 是握手协商出的模式（InnerModeAEAD / InnerModeAEADChaCha / InnerModeTLS）。
func (c *InnerConn) Mode() byte { return c.mode }

// Plain 报告这条连接是不是 TLS 直通（内层没有第二层加密）。
func (c *InnerConn) Plain() bool { return c.plain }

// Cipher 是内层记录用的算法（诊断用）；TLS 直通时内层不加密，返回 "tls"（算法由 TLS 1.3 选）。
func (c *InnerConn) Cipher() string { return innerCipherName(c.mode) }

func innerCipherName(mode byte) string {
	switch mode {
	case InnerModeAEAD:
		return "aes-128-gcm"
	case InnerModeAEADChaCha:
		return "chacha20-poly1305"
	case InnerModeTLS:
		return "tls"
	}
	return "unknown"
}

// innerOffer 是客户端在第一条消息里发的模式字节：本机有 AES 硬件要 AES-GCM，没有要 ChaCha20。
func innerOffer(localAES bool) byte {
	if localAES {
		return InnerModeAEAD
	}
	return InnerModeAEADChaCha
}

// innerChoose 是服务端的决定：任意一端没有 AES 硬件就用 ChaCha20-Poly1305，否则 AES-GCM。
// 没有硬件的一端跑纯软件 AES-GCM 比 ChaCha20 慢好几倍（而且查表实现不是常数时间），有硬件的
// 一端跑 ChaCha20 只是稍慢：所以照顾慢的那端。
func innerChoose(offered byte, localAES bool) byte {
	if offered == InnerModeAEADChaCha || !localAES {
		return InnerModeAEADChaCha
	}
	return InnerModeAEAD
}

// hkdfSHA256 实现 RFC 5869（提取 + 扩展），手写、带 RFC 测试向量（inner_test.go）。
func hkdfSHA256(secret, salt, info []byte, length int) []byte {
	if len(salt) == 0 {
		salt = make([]byte, sha256.Size)
	}
	extract := hmac.New(sha256.New, salt)
	extract.Write(secret)
	prk := extract.Sum(nil)

	out := make([]byte, 0, length)
	var block []byte
	for counter := byte(1); len(out) < length; counter++ {
		expand := hmac.New(sha256.New, prk)
		expand.Write(block)
		expand.Write(info)
		expand.Write([]byte{counter})
		block = expand.Sum(nil)
		out = append(out, block...)
	}
	return out[:length]
}

// deriveInnerKeys 把隧道密钥扩展成四把互不相同的密钥，方向和长度 / 内容都不共用。mode 定算法：
// AES-128-GCM 每把 16 字节，ChaCha20-Poly1305 每把 32 字节；两种算法的 HKDF info 不同，同一组
// 材料在两种算法下不会用到相同的密钥字节。
func deriveInnerKeys(psk string, salt []byte, mode byte) (c2sLen, c2sData, s2cLen, s2cData []byte) {
	secret := sha256.Sum256([]byte(psk))
	info, size := innerInfo, 16
	if mode == InnerModeAEADChaCha {
		info, size = innerInfoChaCha, chacha20poly1305.KeySize
	}
	material := hkdfSHA256(secret[:], salt, []byte(info), 4*size)
	return material[0:size], material[size : 2*size], material[2*size : 3*size], material[3*size : 4*size]
}

// newInnerAEAD 建一把记录用的 AEAD。两种算法的 nonce 都是 12 字节、标签都是 16 字节，记录格式
// 完全一样，也都允许就地（完全重叠）加解密。
func newInnerAEAD(mode byte, key []byte) (cipher.AEAD, error) {
	if mode == InnerModeAEADChaCha {
		return chacha20poly1305.New(key)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// innerAuthKey 是握手证明用的 HMAC 密钥（和记录密钥、TLS 证书密钥都做了域分隔）。
func innerAuthKey(psk string) [32]byte {
	return sha256.Sum256([]byte("nex-v3 inner auth\x00" + psk))
}

// innerProof 算一个证明。role 区分谁在证明（"c" 客户端、"s" 服务端、"t" TLS 模式的客户端），
// 同一组输入两个方向的证明不会相同，一方的证明不能反射回去冒充另一方。
func innerProof(psk string, role byte, mode byte, parts ...[]byte) []byte {
	key := innerAuthKey(psk)
	mac := hmac.New(sha256.New, key[:])
	mac.Write([]byte{role, mode})
	for _, part := range parts {
		var n [2]byte
		binary.BigEndian.PutUint16(n[:], uint16(len(part)))
		mac.Write(n[:])
		mac.Write(part)
	}
	return mac.Sum(nil)[:innerTagSize]
}

func innerSalt(client, server []byte) []byte {
	salt := make([]byte, 0, 2*innerMaterialSize)
	salt = append(salt, client...)
	return append(salt, server...)
}

func newMaterial() ([]byte, error) {
	material := make([]byte, innerMaterialSize)
	_, err := rand.Read(material)
	return material, err
}

// innerAEADProof 是模式 3 / 5 的证明：chosen 是服务端定下的模式字节，offered 是客户端第一条
// 消息里的模式字节。两个字节都进 HMAC，算法协商不能被中间人改。
func innerAEADProof(psk string, role, chosen, offered byte, client, server []byte) []byte {
	return innerProof(psk, role, chosen, client, server, []byte{offered})
}

// InnerClient 做客户端一侧的内层握手。tlsBinding 非空表示外层是 TLS 1.3、这是它的导出
// 材料（TLSExporterLabel，32 字节）：走模式 4，内层直通。为空走 AEAD 记录（模式 3 / 5，按两端
// 有没有 AES 硬件协商）。握手失败会关掉 conn。
func InnerClient(conn net.Conn, psk string, tlsBinding []byte) (*InnerConn, error) {
	inner, err := innerClientHandshake(conn, psk, tlsBinding, HasAESHardware())
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	return inner, nil
}

// innerClientHandshake：localAES 是本机有没有 AES 硬件（测试里两端可以各给各的）。
func innerClientHandshake(conn net.Conn, psk string, tlsBinding []byte, localAES bool) (*InnerConn, error) {
	material, err := newMaterial()
	if err != nil {
		return nil, err
	}
	if len(tlsBinding) > 0 {
		msg := make([]byte, 0, InnerHandshakeSize+innerTagSize)
		msg = append(msg, InnerModeTLS)
		msg = append(msg, material...)
		msg = append(msg, innerProof(psk, 't', InnerModeTLS, material, tlsBinding)...)
		if err := writeFull(conn, msg); err != nil {
			return nil, err
		}
		return &InnerConn{conn: conn, plain: true, mode: InnerModeTLS}, nil
	}
	offered := innerOffer(localAES)
	msg := make([]byte, 0, InnerHandshakeSize)
	msg = append(msg, offered)
	msg = append(msg, material...)
	if err := writeFull(conn, msg); err != nil {
		return nil, err
	}
	reply := make([]byte, InnerHandshakeSize+innerTagSize)
	if _, err := io.ReadFull(conn, reply); err != nil {
		return nil, err
	}
	chosen := reply[0]
	// 只接受服务端按规矩可能选的：要了 ChaCha20 只能回 ChaCha20；要了 AES 两种都可能。
	if chosen != InnerModeAEADChaCha && (chosen != InnerModeAEAD || offered != InnerModeAEAD) {
		return nil, ErrInnerHandshake
	}
	peer := reply[1:InnerHandshakeSize]
	if !hmac.Equal(reply[InnerHandshakeSize:], innerAEADProof(psk, 's', chosen, offered, material, peer)) {
		return nil, ErrInnerHandshake
	}
	inner, err := buildInnerConn(conn, psk, innerSalt(material, peer), chosen, innerDirClientToServer, innerDirServerToClient)
	if err != nil {
		return nil, err
	}
	// 证明马上写出去、不等任何回应：第一批记录紧跟在它后面，握手不多占一个往返；
	// 空闲的预热连接也因此在后台就让服务端完成了认证。
	if err := writeFull(conn, innerAEADProof(psk, 'c', chosen, offered, material, peer)); err != nil {
		return nil, err
	}
	return inner, nil
}

// InnerServer 做服务端一侧的内层握手。tlsBinding 是外层 TLS 1.3 的导出材料，外层不是
// TLS 1.3 时为空 —— 那时客户端要求模式 4 就拒绝。握手失败会关掉 conn。
func InnerServer(conn net.Conn, psk string, tlsBinding []byte) (*InnerConn, error) {
	inner, err := innerServerHandshake(conn, psk, tlsBinding, HasAESHardware())
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	return inner, nil
}

func innerServerHandshake(conn net.Conn, psk string, tlsBinding []byte, localAES bool) (*InnerConn, error) {
	first := make([]byte, InnerHandshakeSize)
	if _, err := io.ReadFull(conn, first); err != nil {
		return nil, err
	}
	offered := first[0]
	peer := first[1:]
	switch offered {
	case InnerModeTLS:
		if len(tlsBinding) == 0 {
			return nil, ErrInnerHandshake
		}
		proof := make([]byte, innerTagSize)
		if _, err := io.ReadFull(conn, proof); err != nil {
			return nil, err
		}
		if !hmac.Equal(proof, innerProof(psk, 't', InnerModeTLS, peer, tlsBinding)) {
			return nil, ErrInnerHandshake
		}
		return &InnerConn{conn: conn, plain: true, mode: InnerModeTLS}, nil
	case InnerModeAEAD, InnerModeAEADChaCha:
	case innerModeLegacy:
		return nil, ErrInnerLegacyPeer
	default:
		return nil, ErrInnerHandshake
	}
	chosen := innerChoose(offered, localAES)
	material, err := newMaterial()
	if err != nil {
		return nil, err
	}
	reply := make([]byte, 0, InnerHandshakeSize+innerTagSize)
	reply = append(reply, chosen)
	reply = append(reply, material...)
	reply = append(reply, innerAEADProof(psk, 's', chosen, offered, peer, material)...)
	if err := writeFull(conn, reply); err != nil {
		return nil, err
	}
	// 服务端在客户端证明自己之前不交出任何业务数据：先读证明。证明里有客户端真正发出的
	// offered：中间人改过第一条消息的模式字节，这里就对不上。
	proof := make([]byte, innerTagSize)
	if _, err := io.ReadFull(conn, proof); err != nil {
		return nil, err
	}
	if !hmac.Equal(proof, innerAEADProof(psk, 'c', chosen, offered, peer, material)) {
		return nil, ErrInnerHandshake
	}
	return buildInnerConn(conn, psk, innerSalt(peer, material), chosen, innerDirServerToClient, innerDirClientToServer)
}

func buildInnerConn(conn net.Conn, psk string, salt []byte, mode, writeDir, readDir byte) (*InnerConn, error) {
	c2sLen, c2sData, s2cLen, s2cData := deriveInnerKeys(psk, salt, mode)
	writeLen, err := newInnerAEAD(mode, selectKey(writeDir, c2sLen, s2cLen))
	if err != nil {
		return nil, err
	}
	writeData, err := newInnerAEAD(mode, selectKey(writeDir, c2sData, s2cData))
	if err != nil {
		return nil, err
	}
	readLen, err := newInnerAEAD(mode, selectKey(readDir, c2sLen, s2cLen))
	if err != nil {
		return nil, err
	}
	readData, err := newInnerAEAD(mode, selectKey(readDir, c2sData, s2cData))
	if err != nil {
		return nil, err
	}
	return &InnerConn{
		conn: conn, mode: mode,
		writeAEAD: writeData, readAEAD: readData,
		lenWriteAEAD: writeLen, lenReadAEAD: readLen,
		writeDir: writeDir, readDir: readDir,
		writeKeyID: sha256.Sum256(selectKey(writeDir, c2sData, s2cData)),
		readKeyID:  sha256.Sum256(selectKey(readDir, c2sData, s2cData)),
		maxPayload: InnerPayloadLimit,
	}, nil
}

func selectKey(dir byte, c2s, s2c []byte) []byte {
	if dir == innerDirClientToServer {
		return c2s
	}
	return s2c
}

func innerNonce(dst []byte, dir byte, counter uint64, kind byte) {
	dst[0] = dir
	dst[1] = kind
	dst[2] = 0
	dst[3] = 0
	binary.BigEndian.PutUint64(dst[4:12], counter)
}

// ---- 写 ----

// writeScratch 是封记录用的输出缓冲，按次借还：空闲的连接（比如预热池里的）不常驻一块。
var writeScratch = sync.Pool{New: func() any { b := make([]byte, 0, 256<<10); return &b }}

var innerZeroLength [2 + 16]byte

// sealedSize 是 n 字节明文封成记录后的长度。
func sealedSize(n int) int {
	records := (n + InnerPayloadLimit - 1) / InnerPayloadLimit
	if records == 0 {
		records = 1
	}
	return n + records*innerOverhead
}

// appendSealedLocked 把 bufs 拼起来的明文按记录上限切开、就地封好追加到 dst。明文只拷一次
// （拷到它的密文要占的位置上，GCM 和 ChaCha20-Poly1305 都允许完全重叠的就地加密）。
func (c *InnerConn) appendSealedLocked(dst []byte, bufs [][]byte, total int) ([]byte, error) {
	var lenPlain [2]byte
	var nonce [innerNonceSize]byte
	bi, bo := 0, 0
	for first := true; first || total > 0; first = false {
		n := total
		if n > c.maxPayload {
			n = c.maxPayload
		}
		if c.writeCounter > innerMaxCounter {
			return dst, ErrInnerNonce
		}
		at := len(dst)
		dst = append(dst, innerZeroLength[:]...)
		body := len(dst)
		for filled := 0; filled < n; {
			for bo >= len(bufs[bi]) {
				bi++
				bo = 0
			}
			k := copy(dstGrow(&dst, n-filled), bufs[bi][bo:])
			dst = dst[:len(dst)+k]
			bo += k
			filled += k
		}
		binary.BigEndian.PutUint16(lenPlain[:], uint16(n))
		innerNonce(nonce[:], c.writeDir, c.writeCounter, innerKindLength)
		c.lenWriteAEAD.Seal(dst[at:at], nonce[:], lenPlain[:], nil)
		innerNonce(nonce[:], c.writeDir, c.writeCounter, innerKindData)
		dstGrow(&dst, 16) // 标签的位置；扩容只会发生在密封之前
		c.writeAEAD.Seal(dst[body:body], nonce[:], dst[body:body+n], nil)
		dst = dst[:body+n+16]
		c.writeCounter++
		total -= n
	}
	return dst, nil
}

// dstGrow 让 *dst 至少还能放下 n 个字节，返回长度为 n 的空闲尾部（不改 *dst 的长度）。
func dstGrow(dst *[]byte, n int) []byte {
	if cap(*dst)-len(*dst) < n {
		grown := make([]byte, len(*dst), 2*cap(*dst)+n)
		copy(grown, *dst)
		*dst = grown
	}
	return (*dst)[len(*dst) : len(*dst)+n]
}

// WriteBuffers 把几段拼成一次写：模式 3 时一起封成记录、一次系统调用写出；模式 4 时拼成
// 一块交给 TLS（TLS 自己再切记录）。写失败之后这条连接作废，后面的写都返回同一个错误。
func (c *InnerConn) WriteBuffers(bufs [][]byte) error {
	total := 0
	for _, b := range bufs {
		total += len(b)
	}
	if total == 0 {
		return nil
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.writeErr != nil {
		return c.writeErr
	}
	if c.plain && len(bufs) == 1 {
		err := writeFull(c.conn, bufs[0])
		c.writeErr = err
		return err
	}
	scratch := writeScratch.Get().(*[]byte)
	out := (*scratch)[:0]
	if c.plain {
		for _, b := range bufs {
			out = append(out, b...)
		}
	} else {
		if cap(out) < sealedSize(total) {
			out = make([]byte, 0, sealedSize(total))
		}
		var err error
		if out, err = c.appendSealedLocked(out, bufs, total); err != nil {
			c.writeErr = err
			return err
		}
	}
	err := writeFull(c.conn, out)
	c.writeErr = err
	if cap(out) <= 1<<20 {
		*scratch = out[:0]
		writeScratch.Put(scratch)
	}
	return err
}

// WriteRecord 封好并发出恰好一条记录（测试用；模式 4 直接写）。
func (c *InnerConn) WriteRecord(payload []byte) error {
	if !c.plain && len(payload) > c.maxPayload {
		return ErrFrameTooLarge
	}
	if len(payload) == 0 && !c.plain {
		c.writeMu.Lock()
		defer c.writeMu.Unlock()
		out, err := c.appendSealedLocked(nil, nil, 0)
		if err != nil {
			return err
		}
		return writeFull(c.conn, out)
	}
	return c.WriteBuffers([][]byte{payload})
}

func (c *InnerConn) Write(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	if err := c.WriteBuffers([][]byte{p}); err != nil {
		return 0, err
	}
	return len(p), nil
}

// ---- 读 ----

// fill 让读缓冲里至少有 need 字节没解析的密文。
func (c *InnerConn) fill(need int) error {
	if c.rbuf == nil {
		c.rbuf = make([]byte, innerReadBuffer)
	}
	if c.rend-c.rstart >= need {
		return nil
	}
	if len(c.rbuf)-c.rstart < need {
		c.rend = copy(c.rbuf, c.rbuf[c.rstart:c.rend])
		c.rstart = 0
	}
	for c.rend-c.rstart < need {
		n, err := c.conn.Read(c.rbuf[c.rend:])
		c.rend += n
		if c.rend-c.rstart >= need {
			return nil
		}
		if err != nil {
			if err == io.EOF && c.rend > c.rstart {
				return io.ErrUnexpectedEOF
			}
			return err
		}
	}
	return nil
}

// readRecord 解下一条记录，结果就地留在读缓冲里（plainBuf 指向它）。
func (c *InnerConn) readRecord() error {
	lenSize := 2 + c.lenReadAEAD.Overhead()
	if err := c.fill(lenSize); err != nil {
		return err
	}
	if c.readCounter > innerMaxCounter {
		return ErrInnerNonce
	}
	var nonce [innerNonceSize]byte
	var lenPlain [2]byte
	innerNonce(nonce[:], c.readDir, c.readCounter, innerKindLength)
	if _, err := c.lenReadAEAD.Open(lenPlain[:0], nonce[:], c.rbuf[c.rstart:c.rstart+lenSize], nil); err != nil {
		return ErrInnerRecord
	}
	n := int(binary.BigEndian.Uint16(lenPlain[:]))
	if n > c.maxPayload {
		return ErrFrameTooLarge
	}
	if err := c.fill(lenSize + n + c.readAEAD.Overhead()); err != nil {
		return err
	}
	body := c.rbuf[c.rstart+lenSize : c.rstart+lenSize+n+c.readAEAD.Overhead()]
	innerNonce(nonce[:], c.readDir, c.readCounter, innerKindData)
	plain, err := c.readAEAD.Open(body[:0], nonce[:], body, nil)
	if err != nil {
		return ErrInnerRecord
	}
	c.rstart += lenSize + len(body)
	c.readCounter++
	c.plainBuf = plain
	c.plainOff = 0
	return nil
}

func (c *InnerConn) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	if c.plain {
		return c.conn.Read(p)
	}
	for c.plainOff >= len(c.plainBuf) {
		if c.readErr != nil {
			return 0, c.readErr
		}
		if err := c.readRecord(); err != nil {
			c.readErr = err
			return 0, err
		}
	}
	n := copy(p, c.plainBuf[c.plainOff:])
	c.plainOff += n
	return n, nil
}

func (c *InnerConn) Close() error                       { return c.conn.Close() }
func (c *InnerConn) LocalAddr() net.Addr                { return c.conn.LocalAddr() }
func (c *InnerConn) RemoteAddr() net.Addr               { return c.conn.RemoteAddr() }
func (c *InnerConn) SetDeadline(t time.Time) error      { return c.conn.SetDeadline(t) }
func (c *InnerConn) SetReadDeadline(t time.Time) error  { return c.conn.SetReadDeadline(t) }
func (c *InnerConn) SetWriteDeadline(t time.Time) error { return c.conn.SetWriteDeadline(t) }
