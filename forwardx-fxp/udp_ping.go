package main

import (
	"bytes"
	"crypto/rand"
	"errors"
	"net"
	"net/netip"
	"sync"
	"sync/atomic"
	"time"
)

/*
UDP 直连的三种控制包（负载均衡整治，路线图 X3）。包头、加密和数据包完全一样（FXPU v4，密钥按
「隧道密钥 + 隧道号 + 规则号 + 会话号 + 包类型」派生），只是类型不同：

	3  探活（ping）   上一跳 → 下一跳。规则号 0、会话号随机、序号 1，负载 8 字节随机数。
	4  探活应答（pong）下一跳 → 上一跳。同样的规则号、会话号，负载原样带回。
	5  访客地址（client）入口 → 中转（中转再往下一台中转传）。规则号、会话号是那条会话的，
	                  负载是访客的 IP（4 或 16 字节）。在会话的第一个数据包之前发两遍。

和老版本混用：没有这三种包的老出口 / 中转只认类型 1、2，别的在解析包头时就被丢掉，不回、不报错、
不影响会话。所以：

  - 探活：对端从没回过应答，就没有结论，不拿「没回」判它坏；回过一次之后才以探活为准。这一版要求各台都升级，
    一直不回的会被标成「没验证过」并报给面板（见 endpoint_pool.go 的 watchUDP），不再悄悄退回去探 TCP 端口。
  - 访客地址：老中转收不到，照旧按会话号挑出口；新中转没等到（丢了、乱序到了数据包后面）也按会话号。
    只影响「按访客固定」在中转上固定到哪台，不影响通不通。新入口多发的这两个小包，老的下一跳直接丢。

为什么要有：UDP 直连没有握手，以前出口机没了入口完全不知道，只开 UDP 的规则没有任何健康信号；
中转上的「按访客固定」拿到的键是会话号（每条会话随机），同一个访客的几条会话被分到不同出口。
*/
const (
	fxpUDPTypePing   = byte(3)
	fxpUDPTypePong   = byte(4)
	fxpUDPTypeClient = byte(5)

	fxpUDPPingPayloadSize = 8
	// 一轮探活最多等 fxpUDPPingWait，中间每隔 fxpUDPPingWait ÷ fxpUDPPingAttempts 没等到应答就再发一个：
	// 丢一两个包不算没回。正常的出口第一个包就回了，一轮只花一个往返。
	fxpUDPPingAttempts = 3
	fxpUDPPingWait     = time.Second
	// 访客地址在第一个数据包之前发几遍（小包，丢一个还有一个）。
	fxpUDPClientHintCopies = 2
	// 中转收到访客地址后最多留这么久、这么多条，等那条会话的第一个数据包来取。
	fxpUDPClientHintTTL = 10 * time.Second
	fxpUDPClientHintMax = 8192
)

func validFXPUDPPacketType(packetType byte) bool {
	return packetType >= fxpUDPTypeData && packetType <= fxpUDPTypeClient
}

// fxpUDPPingHook 只给测试用：非 nil 时代替真的发包。探活在后台协程里跑，测试换钩子时它可能正在读，所以放在原子指针里。
var fxpUDPPingHook atomic.Pointer[func(host string, port int, cfg config) error]

func setFXPUDPPingHook(hook func(host string, port int, cfg config) error) {
	if hook == nil {
		fxpUDPPingHook.Store(nil)
		return
	}
	fxpUDPPingHook.Store(&hook)
}

/*
fxpUDPPing 向 host:port 发一轮 UDP 探活，等对端的应答。nil 表示对端回了。

地址和数据走同一套解析（resolveHopAddress：IP 原样用、方括号里的 IPv6 去掉括号、域名走带缓存的解析，DNS 挂了旧地址
接着用 5 分钟）。以前这里自己 JoinHostPort + 系统解析器：配成 [2001:db8::1] 的出口永远收不到应答，DNS 抖一下数据照常在走、
探活却判 UDP 不通（F4）。

一轮最多 fxpUDPPingWait：每隔 fxpUDPPingWait ÷ fxpUDPPingAttempts 发一个，等到下一个该发的时候（最后一个等到这一轮结束）。
*/
func fxpUDPPing(host string, port int, cfg config) error {
	if hook := fxpUDPPingHook.Load(); hook != nil {
		return (*hook)(host, port, cfg)
	}
	address, err := resolveHopAddress(host, port)
	if err != nil {
		return err
	}
	remote, err := net.ResolveUDPAddr("udp", address)
	if err != nil {
		return err
	}
	conn, err := net.DialUDP("udp", nil, remote)
	if err != nil {
		return err
	}
	defer conn.Close()
	sessionID, err := randomUint64()
	if err != nil {
		return err
	}
	nonce := make([]byte, fxpUDPPingPayloadSize)
	if _, err := rand.Read(nonce); err != nil {
		return err
	}
	reply := make([]byte, 2048)
	var lastErr error = errors.New("udp ping: no reply")
	roundEnds := time.Now().Add(fxpUDPPingWait)
	for attempt := 0; attempt < fxpUDPPingAttempts; attempt++ {
		// 每次重新封：包头里的发出时间要新鲜，序号也换一个。
		wire, err := sealFXPUDPPacket(fxpUDPPacket{
			packetType: fxpUDPTypePing,
			tunnelID:   cfg.TunnelID,
			sessionID:  sessionID,
			sequence:   uint64(attempt + 1),
			payload:    nonce,
		}, cfg.Key)
		if err != nil {
			return err
		}
		deadline := roundEnds
		if attempt < fxpUDPPingAttempts-1 {
			deadline = time.Now().Add(fxpUDPPingWait / fxpUDPPingAttempts)
		}
		// 对端端口没人听时写（或读）会拿到 ICMP 带回来的拒绝。
		if _, lastErr = conn.Write(wire); lastErr == nil {
			var answered bool
			if answered, lastErr = awaitFXPUDPPong(conn, reply, deadline, cfg, sessionID, nonce); answered {
				return nil
			}
		}
		// 没等满就出错了（写失败、ICMP 拒绝）：别空转，等到该发下一个的时候。
		if wait := time.Until(deadline); wait > 0 {
			time.Sleep(wait)
		}
	}
	return lastErr
}

// awaitFXPUDPPong 读到 deadline，等这一轮的应答（别的包跳过）。没等到时返回读出的错误（超时，或者 ICMP 拒绝之类）。
func awaitFXPUDPPong(conn *net.UDPConn, reply []byte, deadline time.Time, cfg config, sessionID uint64, nonce []byte) (bool, error) {
	_ = conn.SetReadDeadline(deadline)
	for {
		n, err := conn.Read(reply)
		if err != nil {
			return false, err
		}
		packet, err := openFXPUDPPacket(reply[:n], cfg.TunnelID, cfg.Key)
		if err == nil && packet.packetType == fxpUDPTypePong && packet.sessionID == sessionID && bytes.Equal(packet.payload, nonce) {
			return true, nil
		}
	}
}

// answerFXPUDPPing：出口 / 中转的 UDP 读循环收到探活包时调。认证过、时间新鲜就原样回一个应答。
// 应答和探活一样大，对端要知道隧道密钥才换得来，当不了放大器。
func answerFXPUDPPing(conn *net.UDPConn, raw []byte, from netip.AddrPort, cfg config) {
	packet, err := openFXPUDPPacket(raw, cfg.TunnelID, cfg.Key)
	if err != nil || packet.packetType != fxpUDPTypePing || len(packet.payload) != fxpUDPPingPayloadSize {
		return
	}
	if !fxpUDPReplayGuard.fresh(packet.sentAt, time.Now()) {
		return
	}
	wire, err := sealFXPUDPPacket(fxpUDPPacket{
		packetType: fxpUDPTypePong,
		tunnelID:   cfg.TunnelID,
		ruleID:     packet.ruleID,
		sessionID:  packet.sessionID,
		sequence:   packet.sequence,
		payload:    packet.payload,
	}, cfg.Key)
	if err != nil {
		return
	}
	_, _ = conn.WriteToUDPAddrPort(wire, from)
}

// sendFXPUDPClientHint 把访客的 IP 告诉下一跳（它是中转时拿来做「按访客固定」的键）。尽力而为，不报错。
func sendFXPUDPClientHint(conn *net.UDPConn, to *net.UDPAddr, key string, tunnelID, ruleID int, sessionID uint64, client string) {
	addr, err := netip.ParseAddr(client)
	if err != nil || conn == nil || to == nil {
		return
	}
	payload := addr.Unmap().AsSlice()
	for copyIndex := 0; copyIndex < fxpUDPClientHintCopies; copyIndex++ {
		wire, err := sealFXPUDPPacket(fxpUDPPacket{
			packetType: fxpUDPTypeClient,
			tunnelID:   tunnelID,
			ruleID:     ruleID,
			sessionID:  sessionID,
			sequence:   uint64(copyIndex + 1),
			payload:    payload,
		}, key)
		if err != nil {
			return
		}
		if _, err := conn.WriteToUDP(wire, to); err != nil {
			return
		}
	}
}

// udpClientHints：中转记下「这条会话的访客是谁」，等会话的第一个数据包来建会话时取走。
type udpClientHints struct {
	mu    sync.Mutex
	hints map[udpRuleSessionKey]udpClientHint
}

type udpClientHint struct {
	client string
	at     time.Time
}

// accept 处理一个访客地址包。
func (h *udpClientHints) accept(raw []byte, cfg config, now time.Time) {
	packet, err := openFXPUDPPacket(raw, cfg.TunnelID, cfg.Key)
	if err != nil || packet.packetType != fxpUDPTypeClient || !packetMatchesConfig(packet, cfg) {
		return
	}
	if !fxpUDPReplayGuard.fresh(packet.sentAt, now) {
		return
	}
	addr, ok := netip.AddrFromSlice(packet.payload)
	if !ok {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.hints == nil {
		h.hints = map[udpRuleSessionKey]udpClientHint{}
	}
	if len(h.hints) >= fxpUDPClientHintMax {
		h.expireLocked(now)
		if len(h.hints) >= fxpUDPClientHintMax {
			return
		}
	}
	h.hints[udpRuleSessionKey{ruleID: packet.ruleID, sessionID: packet.sessionID}] = udpClientHint{client: addr.Unmap().String(), at: now}
}

// expire 清掉等了太久没人取的（会话早就建好了、迟到的那一份）。中转的会话清扫顺带调。
func (h *udpClientHints) expire(now time.Time) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.expireLocked(now)
}

func (h *udpClientHints) expireLocked(now time.Time) {
	for key, hint := range h.hints {
		if now.Sub(hint.at) > fxpUDPClientHintTTL {
			delete(h.hints, key)
		}
	}
}

// take 取走这条会话的访客地址（没有返回空）。
func (h *udpClientHints) take(key udpRuleSessionKey, now time.Time) string {
	h.mu.Lock()
	defer h.mu.Unlock()
	hint, ok := h.hints[key]
	if !ok {
		return ""
	}
	delete(h.hints, key)
	if now.Sub(hint.at) > fxpUDPClientHintTTL {
		return ""
	}
	return hint.client
}
