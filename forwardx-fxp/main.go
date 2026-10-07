package main

import (
	"bytes"
	"container/heap"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"hash/fnv"
	"io"
	"log"
	"net"
	"net/netip"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"lukechampine.com/blake3"
)

type helloFrame struct {
	Network                  string `json:"network"`
	TargetIP                 string `json:"targetIp"`
	TargetPort               int    `json:"targetPort"`
	TunnelID                 int    `json:"tunnelId"`
	RuleID                   int    `json:"ruleId"`
	SelectionKey             string `json:"selectionKey,omitempty"`
	ProxySourceIP            string `json:"proxySourceIp,omitempty"`
	ProxySourcePort          int    `json:"proxySourcePort,omitempty"`
	ProxyDestIP              string `json:"proxyDestIp,omitempty"`
	ProxyDestPort            int    `json:"proxyDestPort,omitempty"`
	ProxyProtocolExitReceive bool   `json:"proxyProtocolExitReceive,omitempty"`
	ProxyProtocolExitSend    bool   `json:"proxyProtocolExitSend,omitempty"`
	ProxyProtocolVersion     int    `json:"proxyProtocolVersion,omitempty"`
	// Multipath legs that share a session id are reassembled into one stream
	// at the exit. Empty on an ordinary single-path session.
	MultipathSessionID string `json:"multipathSessionId,omitempty"`
	MultipathLegIndex  int    `json:"multipathLegIndex,omitempty"`
	MultipathLegCount  int    `json:"multipathLegCount,omitempty"`
	// MultipathExtended says the entry understands the extended multipath
	// frame kinds, so the exit may use them. An older exit does not know the
	// field and drops it, which is exactly the answer "no" — it then never
	// sends one, and neither side uses anything the other cannot parse.
	// Relays forward the hello verbatim, so this reaches the exit end to end.
	MultipathExtended bool `json:"multipathExtended,omitempty"`
	// targetLiteral 不上线：出口核对过目标之后记下「配置里写的就是这个 IP」。
	// 写死的 IP 是面板明确配的（比如出口本机调度器的 127.0.0.1），照拨；写的是
	// 域名时，解析出来落到环回、链路本地这些地址上就不拨（见 dialExitTarget）。
	targetLiteral bool
	// accountingRuleID 也不上线：出口核对目标时记下「这趟是替哪条规则拨的」，
	// 出口按它记流量。只有目标表里那条规则的目标对上了才有值；hello 里写的
	// 规则号是入口说的，不能拿来直接记账（见 exit_traffic.go）。
	accountingRuleID int
}

type protocolPolicy struct {
	BlockHTTP  bool
	BlockSocks bool
	BlockTLS   bool
}

type envelope struct {
	V   int    `json:"v"`
	IV  string `json:"iv"`
	CT  string `json:"ct"`
	MAC string `json:"mac"`
	TS  int64  `json:"ts"`
}

// fxpHandshake 是握手帧和握手确认的内容。TSMilli 是发出时刻（Unix 毫秒）：
// 服务端只收 ±fxpHandshakeWindow 以内的握手，重放缓存记 2 倍窗口就够；用毫秒是
// 为了进程刚启动时「启动前生成的握手一律不收」这条线划得准（见 fxpReplaySeen）。
type fxpHandshake struct {
	V        int   `json:"v"`
	TSMilli  int64 `json:"tsMs"`
	TunnelID int   `json:"tunnelId"`
	// AEADs 是客户端能用的帧加密算法，偏好的排前面；旧版本不写，只会 AES-256-GCM。
	AEADs []string `json:"aeads,omitempty"`
	// AEAD 是服务端在确认里选定的算法；省略表示 AES-256-GCM（旧版本也从不写）。
	// 见 aead.go。
	AEAD string `json:"aead,omitempty"`
}

type secureConn struct {
	conn          net.Conn
	lenWriteAEAD  cipher.AEAD
	dataWriteAEAD cipher.AEAD
	lenReadAEAD   cipher.AEAD
	dataReadAEAD  cipher.AEAD
	lengthAD      []byte
	payloadAD     []byte
	writeDir      uint32
	readDir       uint32
	writeCounter  uint64
	readCounter   uint64
	// A secure connection can be written by the data and control goroutines
	// concurrently. Keep complete encrypted frames serialized so their length
	// and payload records cannot interleave on the underlying stream.
	writeMu sync.Mutex
	// 流水线握手：客户端的 salt 和握手帧先攒在 pendingPrefix 里，跟第一次写
	// （hello、首包）合成一个 TCP 段发出去；握手确认也不等，ackPending 让第一次
	// readFrame 先把它读掉再交出数据帧。每一跳因此省掉一个往返。
	pendingPrefix []byte
	// readBuf 是上一帧解密用的池缓冲，下一次读帧前归还。只由读协程访问。
	readBuf     []byte
	ackPending  bool
	ackTunnelID int
	ackTimeout  time.Duration
	// onAck 报告握手确认的结果，出口择优靠它更新健康状态。
	onAck func(error)
	// 客户端在收到确认之前留着派生会话密钥的材料：确认里带着服务端的 salt，
	// 两边的 salt 合起来才得到这条连接真正的会话密钥（见 finishServerHandshake）。
	handshakeMaster []byte
	handshakeSalt   []byte
	handshakeWire   fxpWireContext
	// 服务端：客户端在见到确认之前写的帧（握手帧之后的 hello、首包）只能用
	// 客户端 salt 派生的「首轮密钥」。读到第一帧会话密钥的帧之后就把它丢掉，
	// 之后再出现首轮密钥的帧一律当作伪造。
	earlyLenReadAEAD  cipher.AEAD
	earlyDataReadAEAD cipher.AEAD
	// aead 是这条连接确认之后两个方向用的算法名，空表示 AES-256-GCM；
	// offeredAEADs 是客户端报出去的列表，用来核对服务端的选择。
	aead         string
	offeredAEADs []string
	// shaper 是这条连接所属方向的链路整形器（可能为 nil）：写帧前先领额度。
	shaper *linkShaper
}

// fxpAckError 表示对端没有确认握手：连不通的黑洞、拒绝了密钥、半路断开。
// 这时对端还没回过任何数据，入口可以换一个出口把已发出的内容原样重放。
type fxpAckError struct {
	err error
}

func (e *fxpAckError) Error() string { return "fxp handshake ack: " + e.err.Error() }
func (e *fxpAckError) Unwrap() error { return e.err }

type fxpWireContext struct {
	name          string
	sessionInfo   []byte
	lengthAD      []byte
	payloadAD     []byte
	masterContext string
	compat        bool
}

type replayCache struct {
	ttl    time.Duration
	max    int
	mu     sync.Mutex
	seen   map[string]time.Time
	expiry replayExpiryHeap
	// floor 只对带时间戳的记录（addStampedAt）生效：时间戳不大于它的一律当重放。
	// 它从创建时给的下限（进程启动时刻）开始，容量满了挤掉旧记录时抬到被挤掉
	// 那条的时间戳 —— 被挤掉的记录再来一次，缓存已经认不出了，只能靠这条线挡住。
	floor int64
}

type replayExpiry struct {
	key       string
	expiresAt time.Time
	stamp     int64
}

type replayExpiryHeap []replayExpiry

func (h replayExpiryHeap) Len() int           { return len(h) }
func (h replayExpiryHeap) Less(i, j int) bool { return h[i].expiresAt.Before(h[j].expiresAt) }
func (h replayExpiryHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *replayExpiryHeap) Push(value any)    { *h = append(*h, value.(replayExpiry)) }
func (h *replayExpiryHeap) Pop() any {
	old := *h
	last := len(old) - 1
	value := old[last]
	old[last] = replayExpiry{}
	*h = old[:last]
	return value
}

const (
	// 3：服务端在确认里带回自己的 salt，会话密钥由两边的 salt 一起派生；握手
	// 时间戳改成毫秒并强制检查。和 2 不互通，版本号不同直接拒绝，免得混跑时
	// 解密失败得莫名其妙。
	fxpHandshakeVersion  = 3
	fxpSaltSize          = 32
	fxpMaxFrame          = 16 * 1024 * 1024
	fxpEntryToExit       = uint32(1)
	fxpExitToEntry       = uint32(2)
	fxpHandshakeWindow   = 5 * time.Minute
	fxpHandshakeTimeout  = 10 * time.Second
	fxpHelloTimeout      = 10 * time.Second
	fxpTCPKeepAlive      = 30 * time.Second
	fxpHalfCloseLinger   = 30 * time.Second
	fxpUDPIdleTimeout    = 5 * time.Minute
	fxpProtocolSampleMax = 512
	fxpMasterContext     = "forwardx-fxp-v2 master"
	fxpRuntimeVersion    = "2.2.128"
	fxpFallbackRetry     = 5 * time.Second
	// A node that stays down is re-probed on a growing delay, because probing a
	// peer that accepts but never answers costs a whole handshake timeout.
	fxpFallbackRetryMax = 2 * time.Minute
	fxpFallbackDial     = 3 * time.Second
	fxpShutdownDrain    = 5 * time.Second

	// Exit and relay ports are reachable by other nodes and must remain bounded
	// even when user-facing access limits are disabled. The active limits are
	// intentionally well above the standard plan limits; the lower pending
	// limits only cover the short handshake/hello phase.
	fxpListenerMaxConnections = 8192
	// 待定连接里包括上一跳连接池预热、正在等 hello 的连接（每个上一跳进程每个
	// 端点最多 fxpPoolMaxSize 条），所以比单纯的握手阶段放宽一些。只有握手
	// 通过（证明知道隧道密钥）的连接才占这份额度。
	fxpListenerMaxPendingConnections = 2048
	fxpListenerMaxPendingPerIP       = 1024
	// 握手阶段（还没证明知道密钥）单独一道闸，每个来源 IP 只给很小的份额：
	// 以前握手和等 hello 共用上面那份 1024/IP，两个 IP 各挂 1024 条不说话的
	// 连接就能把出口/中转的待定额度占满，合法的入口、中转一条都进不来。正常
	// 的上一跳连上就立刻发握手（流水线握手随 hello 一起写，预热连接也是连上
	// 就握手），同一 IP 同时停在这个阶段的连接只有几条。
	fxpListenerMaxHandshakePerIP = 64
	// 同一个上一跳的突发：用户那边一下开几百条连接（网页、测速、多规则共用一台
	// 入口）时，入口会同时现拨几百条到出口，这些连接在出口的握手阶段一起停留
	// 半个往返，远超上面那 64 条。超出的部分走单独的突发份额（每 IP 加上它
	// 最多 fxpListenerMaxPendingPerIP 条，和 2.3.389 之前一样），但只给
	// fxpServerBurstHandshakeTimeout 读握手：合法的上一跳连上就发握手，几个
	// 往返内就完成；不说话的连接很快让位。突发份额单独计数，占满了也不影响
	// 每个 IP 那 64 条保底份额 —— 慢速连接攻击的效果不比没有突发份额时更大。
	fxpListenerMaxHandshakeBurstPerIP = fxpListenerMaxPendingPerIP - fxpListenerMaxHandshakePerIP
	fxpServerBurstHandshakeTimeout    = 2 * time.Second
	// 服务端读完初始握手字节的时限。比 fxpHandshakeTimeout 短：不说话的连接
	// 早点让位。留到 5 秒是为了照顾 2.2.121 及更早的入口 —— 它们在
	// proxyProtocolReceive 规则上先拨出口、再最多等 5 秒客户端的 PROXY 头，
	// 然后才把握手写出去。
	fxpServerHandshakeTimeout = 5 * time.Second
)

var (
	fxpSessionInfo       = []byte("forwardx-fxp-v2 session")
	fxpLengthAD          = []byte("forwardx-fxp-v2 length")
	fxpPayloadAD         = []byte("forwardx-fxp-v2 payload")
	fxpCompatSessionInfo = []byte("forwardx-fxp session")
	fxpCompatLengthAD    = []byte("forwardx-fxp length")
	fxpCompatPayloadAD   = []byte("forwardx-fxp payload")
	fxpWireCurrent       = fxpWireContext{name: "current", sessionInfo: fxpSessionInfo, lengthAD: fxpLengthAD, payloadAD: fxpPayloadAD, masterContext: fxpMasterContext}
	fxpWireCompat2390    = fxpWireContext{name: "2.3.90-compat", sessionInfo: fxpCompatSessionInfo, lengthAD: fxpCompatLengthAD, payloadAD: fxpCompatPayloadAD, masterContext: "forwardx-fxp master", compat: true}
	fxpWireContexts      = []fxpWireContext{fxpWireCurrent, fxpWireCompat2390}
	// 握手重放缓存。时间窗是 ±fxpHandshakeWindow，一个握手从被接受起最多还能
	// 在窗口里待 2 倍窗口长（对端时钟快一个窗口时），所以记 2 倍窗口。
	// 初始下限是进程启动时刻：缓存在内存里，重启后是空的，启动前生成的握手
	// 这个进程不可能见过、也就判断不了是不是重放，干脆不收。时钟比本机慢的
	// 对端因此在重启后的头几秒（慢多少就是多少）会被拒，重试即可。
	fxpReplaySeen = newStampedReplayCache(2*fxpHandshakeWindow, 100000, time.Now().UnixMilli()-1)
)

type connGate struct {
	maxConnections int64
	maxPerIP       int
	active         int64
	mu             sync.Mutex
	ips            map[string]int
}

// listenerConnGates 是出口/中转监听的三道闸：
//   - handshake：接受之后到握手读完。未认证的连接只能占这一道，每 IP 份额很小；
//   - pending：握手通过之后到 hello 读完（含上一跳连接池里空等 hello 的连接）；
//   - active：握手通过之后整个会话期间，全局上限。
//
// 未认证的连接不再占 pending 和 active：慢速连接攻击最多把 handshake 这道闸
// 占满，已经握过手的连接池和会话不受影响。
type listenerConnGates struct {
	handshake *connGate
	// burst：handshake 这道闸按 IP 满了之后的突发份额，读握手的时限更短
	// （见 fxpListenerMaxHandshakeBurstPerIP）。
	burst   *connGate
	pending *connGate
	active  *connGate
}

// listenerAdmission 是一条连接在三道闸上的租约。方法对 nil 安全：直接调用
// handleExitSession 之类（测试）时不走闸。
type listenerAdmission struct {
	gates            *listenerConnGates
	remote           net.Addr
	mu               sync.Mutex
	releaseHandshake func()
	releasePending   func()
	releaseActive    func()
	// burst：这条连接占的是突发份额，burstTimer 到点还没握完手就关掉它。
	burst      bool
	burstTimer *time.Timer
}

type exitEndpointSelector struct {
	endpoints []exitEndpoint
	// states 是这些端点在整个进程里共享的健康和连接池（见 endpoint_pool.go）。
	// 同一个出口被入口组里多条规则引用时，大家看到的是同一份。
	states   []*fxpEndpointState
	strategy string
	next     int
	mu       sync.Mutex
	// probed 表示有 TCP 探测在盯这些端点；UDP 那条路就不再拿「地址解析成功」
	// 去覆盖探测得出的健康结论。
	probed atomic.Bool
}

// fallbackRetryDelay backs off a repeatedly failing endpoint.
//
// 重新探一次挂掉的出口不是免费的：连得上但不回话的对端，一次探测要等满整个
// 握手超时。固定 5 秒去探，等于把大部分时间都花在探一个死节点上。
func fallbackRetryDelay(failures int) time.Duration {
	delay := fxpFallbackRetry
	for i := 1; i < failures && delay < fxpFallbackRetryMax; i++ {
		delay *= 2
	}
	if delay > fxpFallbackRetryMax {
		delay = fxpFallbackRetryMax
	}
	return delay
}

func newConnGate(maxConnections, maxIPs int) *connGate {
	return &connGate{
		maxConnections: int64(maxConnections),
		maxPerIP:       maxIPs,
		ips:            make(map[string]int),
	}
}

func newListenerConnGates(cfg config) *listenerConnGates {
	maxConnections := cfg.MaxConnections
	if maxConnections <= 0 || maxConnections > fxpListenerMaxConnections {
		maxConnections = fxpListenerMaxConnections
	}
	// Exit and relay listeners see the entry/previous-hop node address rather
	// than the end user's address. The user-facing per-IP limit is enforced at
	// the entry; applying it here would cap an entire node as one user. Keep the
	// listener-level protection global instead of tracking the upstream address
	// as a per-user address. In a multi-hop route all clients can legitimately
	// arrive from the same entry Agent IP.
	maxPerIP := 0
	pendingConnections := minInt(maxConnections, fxpListenerMaxPendingConnections)
	pendingPerIP := minInt(pendingConnections, fxpListenerMaxPendingPerIP)
	handshakePerIP := minInt(pendingConnections, fxpListenerMaxHandshakePerIP)
	burstPerIP := minInt(pendingConnections, fxpListenerMaxHandshakeBurstPerIP)
	return &listenerConnGates{
		handshake: newConnGate(pendingConnections, handshakePerIP),
		burst:     newConnGate(pendingConnections, burstPerIP),
		pending:   newConnGate(pendingConnections, pendingPerIP),
		active:    newConnGate(maxConnections, maxPerIP),
	}
}

// normalizeExitEndpoints 去重、补默认值，丢掉无效端点。选择器和拨号超时都按它算。
func normalizeExitEndpoints(exits []exitEndpoint, fallback exitEndpoint) []exitEndpoint {
	endpoints := make([]exitEndpoint, 0, len(exits)+1)
	seen := map[string]bool{}
	add := func(endpoint exitEndpoint) {
		endpoint.Host = strings.TrimSpace(endpoint.Host)
		if endpoint.UDPPort <= 0 {
			endpoint.UDPPort = endpoint.Port
		}
		if endpoint.Key == "" {
			endpoint.Key = fallback.Key
		}
		if endpoint.Host == "" || endpoint.Port <= 0 || endpoint.Port > 65535 || endpoint.UDPPort <= 0 || endpoint.UDPPort > 65535 {
			return
		}
		key := endpoint.Host + ":" + strconv.Itoa(endpoint.Port) + ":" + strconv.Itoa(endpoint.UDPPort) + ":" + endpoint.Key
		if seen[key] {
			return
		}
		seen[key] = true
		endpoints = append(endpoints, endpoint)
	}
	add(fallback)
	for _, endpoint := range exits {
		add(endpoint)
	}
	return endpoints
}

func newExitEndpointSelector(exits []exitEndpoint, fallback exitEndpoint, strategy string) *exitEndpointSelector {
	endpoints := normalizeExitEndpoints(exits, fallback)
	states := make([]*fxpEndpointState, len(endpoints))
	for i, endpoint := range endpoints {
		states[i] = fxpEndpointStateFor(endpoint)
	}
	return &exitEndpointSelector{
		endpoints: endpoints,
		states:    states,
		strategy:  normalizeExitStrategy(strategy),
	}
}

// activate 在一个 TCP 运行时启动时调用：马上给当前首选的端点预热连接池，
// 有备选时再让维护循环主动探测每个端点。返回的函数在运行时关闭时撤销探测。
func (s *exitEndpointSelector) activate(cfg config) func() {
	if s == nil || len(s.endpoints) == 0 {
		return func() {}
	}
	if endpoint, index, ok := s.pick(nil); ok {
		dialCfg := cfg
		if endpoint.Key != "" {
			dialCfg.Key = endpoint.Key
		}
		s.states[index].prewarm(dialCfg)
	}
	if len(s.endpoints) < 2 {
		return func() {}
	}
	s.probed.Store(true)
	releases := make([]func(), 0, len(s.states))
	for i, state := range s.states {
		dialCfg := cfg
		if s.endpoints[i].Key != "" {
			dialCfg.Key = s.endpoints[i].Key
		}
		releases = append(releases, state.watch(dialCfg))
	}
	return func() {
		for _, release := range releases {
			release()
		}
	}
}

// claimProbe hands out one endpoint that is due to be re-checked, if any.
//
// 它把那个节点标成「正在探」，所以同时来的一堆连接只会派出一次探测，而不是
// 一起往同一个死节点上撞。
func (s *exitEndpointSelector) claimProbe(now time.Time) (exitEndpoint, int, bool) {
	if s == nil {
		return exitEndpoint{}, -1, false
	}
	for i, state := range s.states {
		if state.claimProbe(now) {
			return s.endpoints[i], i, true
		}
	}
	return exitEndpoint{}, -1, false
}

func (s *exitEndpointSelector) releaseProbe(index int) {
	if s == nil || index < 0 || index >= len(s.states) {
		return
	}
	s.states[index].releaseProbe()
}

// probeFailedEndpoint re-checks one endpoint that has been down, off the path
// of any user connection.
//
// 探测本身可能要等满一个握手超时。放在后台，等多久都只是这一个协程的事；
// 放在用户连接上，就是那条连接卡多久 —— 实测就是每隔几秒有人卡二十秒。
func (s *exitEndpointSelector) probeFailedEndpoint(cfg config) {
	endpoint, index, ok := s.claimProbe(time.Now())
	if !ok {
		return
	}
	dialCfg := cfg
	if endpoint.Key != "" {
		dialCfg.Key = endpoint.Key
	}
	go s.states[index].runProbe(dialCfg)
}

func (s *exitEndpointSelector) count() int {
	if s == nil {
		return 0
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.endpoints)
}

func (s *exitEndpointSelector) pick(excluded map[int]bool, selectionKeys ...string) (exitEndpoint, int, bool) {
	if s == nil {
		return exitEndpoint{}, -1, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.endpoints) == 0 {
		return exitEndpoint{}, -1, false
	}
	now := time.Now()
	tiers := make([]int, len(s.states))
	for i, state := range s.states {
		tiers[i] = state.tier(now)
	}
	// 分三档挑，而不是「够格/不够格」两档：
	//
	//	1. 确认健康的（含从没失败过的）
	//	2. 挂过、但冷却已经到期的
	//	3. 剩下的全部 —— 一个都不剩时总得选一个，否则等于直接断服
	//
	// 为什么要把第 2 档单独分出来：重新探一个「连得上但不回话」的出口，要等满
	// 一整个握手超时。以前它和第 1 档混在一起，于是每过一个冷却窗口就有一条
	// 用户连接被派去探那个死节点，卡满十几秒（实测）。分开之后，只要还有健康
	// 的，用户就走健康的；死节点由后台探测去认领。
	//
	// 但第 2 档不能干脆去掉：像 UDP 直连那条路根本不拨号，只做一次地址解析，
	// 没有后台探测可言。真把它去掉，一次 DNS 抖动就能把那条规则的出口永久停用。
	tier := func(index int) int { return tiers[index] }
	if s.strategy == "fallback" {
		for wanted := 1; wanted <= 3; wanted++ {
			for i := range s.endpoints {
				if excluded != nil && excluded[i] {
					continue
				}
				if wanted == 3 || tier(i) == wanted {
					return s.endpoints[i], i, true
				}
			}
		}
		return exitEndpoint{}, -1, false
	}
	candidates := make([]int, 0, len(s.endpoints))
	for wanted := 1; wanted <= 3 && len(candidates) == 0; wanted++ {
		for i := range s.endpoints {
			if excluded != nil && excluded[i] {
				continue
			}
			if wanted == 3 || tier(i) == wanted {
				candidates = append(candidates, i)
			}
		}
	}
	if len(candidates) == 0 {
		return exitEndpoint{}, -1, false
	}
	if s.strategy == "random" {
		if value, err := randomUint64(); err == nil {
			index := candidates[int(value%uint64(len(candidates)))]
			return s.endpoints[index], index, true
		}
	}
	if s.strategy == "ip_hash" {
		selectionKey := ""
		if len(selectionKeys) > 0 {
			selectionKey = strings.TrimSpace(selectionKeys[0])
		}
		if selectionKey != "" {
			hash := fnv.New64a()
			_, _ = hash.Write([]byte(selectionKey))
			index := candidates[int(hash.Sum64()%uint64(len(candidates)))]
			return s.endpoints[index], index, true
		}
	}
	index := candidates[s.next%len(candidates)]
	s.next = (s.next + 1) % 1000000
	return s.endpoints[index], index, true
}

func (s *exitEndpointSelector) markFailure(index int, err error) {
	if s == nil || index < 0 || index >= len(s.states) {
		return
	}
	s.states[index].markFailure(err)
}

func (s *exitEndpointSelector) markHealthy(index int) {
	if s == nil || index < 0 || index >= len(s.states) {
		return
	}
	s.states[index].markHealthy()
}

// markResolved 是 UDP 直连那条路「解析到地址了」。它不说明对端活着，所以有
// TCP 探测盯着时不拿它覆盖健康；纯 UDP 的规则没有别的信号，才照旧当成健康。
func (s *exitEndpointSelector) markResolved(index int) {
	if s == nil || s.probed.Load() {
		return
	}
	s.markHealthy(index)
}

// dialSelectedSecureTCP 按选择器挑端点，返回一条确认过握手的连接（池里有就用
// 池里的）。只剩 UDP-over-TCP 的旧会话在用；TCP 会话走 selectedTransport，
// 那里不等确认、失败了还能重放。
func dialSelectedSecureTCP(selector *exitEndpointSelector, cfg config, selectionKey string) (net.Conn, *secureConn, exitEndpoint, error) {
	if selector == nil || selector.count() == 0 {
		return nil, nil, exitEndpoint{}, errors.New("no exit endpoints")
	}
	attempted := map[int]bool{}
	var lastErr error
	for len(attempted) < selector.count() {
		endpoint, index, ok := selector.pick(attempted, selectionKey)
		if !ok {
			break
		}
		attempted[index] = true
		dialCfg := cfg
		if endpoint.Key != "" {
			dialCfg.Key = endpoint.Key
		}
		conn, sec, err := dialSecureTCP(endpoint.Host, endpoint.Port, dialCfg)
		if err == nil {
			selector.markHealthy(index)
			selector.probeFailedEndpoint(cfg)
			return conn, sec, endpoint, nil
		}
		lastErr = err
		selector.markFailure(index, err)
	}
	if lastErr == nil {
		lastErr = errors.New("no exit endpoint available")
	}
	return nil, nil, exitEndpoint{}, lastErr
}

func endpointSelectionSource(address string) string {
	host, _, err := net.SplitHostPort(strings.TrimSpace(address))
	if err == nil && host != "" {
		return host
	}
	return strings.TrimSpace(address)
}

func formatEndpointList(selector *exitEndpointSelector) string {
	if selector == nil {
		return ""
	}
	selector.mu.Lock()
	defer selector.mu.Unlock()
	parts := make([]string, 0, len(selector.endpoints))
	for _, endpoint := range selector.endpoints {
		part := endpoint.Host + ":" + strconv.Itoa(endpoint.Port)
		if endpoint.UDPPort != endpoint.Port {
			part += "/udp:" + strconv.Itoa(endpoint.UDPPort)
		}
		parts = append(parts, part)
	}
	return strings.Join(parts, ",")
}

func udpListenPort(cfg config) int {
	if cfg.UDPListenPort > 0 {
		return cfg.UDPListenPort
	}
	return cfg.ListenPort
}

func listenAddress(host string, port int) string {
	return net.JoinHostPort(strings.TrimSpace(host), strconv.Itoa(port))
}

func (g *connGate) acquire(remoteAddr net.Addr) (func(), bool, string) {
	ip := remoteIP(remoteAddr)
	trackIP := g.maxPerIP > 0 && ip != ""
	g.mu.Lock()
	if g.maxConnections > 0 && g.active >= g.maxConnections {
		g.mu.Unlock()
		return func() {}, false, "maxConnections"
	}
	if trackIP && g.ips[ip] >= g.maxPerIP {
		g.mu.Unlock()
		return func() {}, false, "maxIPs"
	}
	g.active++
	if trackIP {
		g.ips[ip]++
	}
	g.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			g.mu.Lock()
			if g.active > 0 {
				g.active--
			}
			if trackIP {
				if g.ips[ip] <= 1 {
					delete(g.ips, ip)
				} else {
					g.ips[ip]--
				}
			}
			g.mu.Unlock()
		})
	}, true, ""
}

func (g *connGate) stats() (int64, int) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.active, len(g.ips)
}

func (g *connGate) statsFor(remoteAddr net.Addr) (int64, int, int) {
	ip := remoteIP(remoteAddr)
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.active, len(g.ips), g.ips[ip]
}

// admit 在接受连接时调用，只占握手这道闸；这道闸满了再试突发份额。
func (g *listenerConnGates) admit(remoteAddr net.Addr) (*listenerAdmission, bool, string) {
	releaseHandshake, ok, reason := g.handshake.acquire(remoteAddr)
	if ok {
		return &listenerAdmission{gates: g, remote: remoteAddr, releaseHandshake: releaseHandshake}, true, ""
	}
	if g.burst != nil {
		releaseBurst, burstOK, burstReason := g.burst.acquire(remoteAddr)
		if burstOK {
			return &listenerAdmission{gates: g, remote: remoteAddr, releaseHandshake: releaseBurst, burst: true}, true, ""
		}
		reason += ",burst/" + burstReason
	}
	return nil, false, "handshake/" + reason
}

// admitConn 是监听上用的 admit：占了突发份额的连接，fxpServerBurstHandshakeTimeout
// 之内没握完手就直接关掉，让出份额。
func (g *listenerConnGates) admitConn(conn net.Conn) (*listenerAdmission, bool, string) {
	admission, ok, reason := g.admit(conn.RemoteAddr())
	if ok && admission.burst {
		admission.mu.Lock()
		admission.burstTimer = time.AfterFunc(fxpServerBurstHandshakeTimeout, func() {
			admission.mu.Lock()
			expired := admission.releaseHandshake != nil
			admission.mu.Unlock()
			if expired {
				_ = conn.Close()
			}
		})
		admission.mu.Unlock()
	}
	return admission, ok, reason
}

func (a *listenerAdmission) stopBurstTimerLocked() {
	if a.burstTimer != nil {
		a.burstTimer.Stop()
		a.burstTimer = nil
	}
}

// authenticated 在握手通过后调用：让出握手闸，换成 pending + active。
func (a *listenerAdmission) authenticated() (bool, string) {
	if a == nil {
		return true, ""
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.stopBurstTimerLocked()
	if a.releaseHandshake != nil {
		a.releaseHandshake()
		a.releaseHandshake = nil
	}
	if a.releaseActive != nil {
		return true, ""
	}
	releasePending, ok, reason := a.gates.pending.acquire(a.remote)
	if !ok {
		return false, "pending/" + reason
	}
	releaseActive, ok, reason := a.gates.active.acquire(a.remote)
	if !ok {
		releasePending()
		return false, "active/" + reason
	}
	a.releasePending, a.releaseActive = releasePending, releaseActive
	return true, ""
}

// helloReceived 在读到 hello 后调用：让出 pending，只留 active。
func (a *listenerAdmission) helloReceived() {
	if a == nil {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.releasePending != nil {
		a.releasePending()
		a.releasePending = nil
	}
}

// release 在连接结束时调用，归还还占着的所有份额。可重复调用。
func (a *listenerAdmission) release() {
	if a == nil {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.stopBurstTimerLocked()
	for _, release := range []*func(){&a.releaseHandshake, &a.releasePending, &a.releaseActive} {
		if *release != nil {
			(*release)()
			*release = nil
		}
	}
}

func (a *listenerAdmission) logRejection(role string, cfg config, reason string) {
	if a == nil {
		return
	}
	logListenerConnGateRejection(role, cfg, a.remote, a.gates, reason)
}

func logListenerConnGateRejection(role string, cfg config, remoteAddr net.Addr, gates *listenerConnGates, reason string) {
	handshake, handshakeIPs, handshakeForIP := gates.handshake.statsFor(remoteAddr)
	var burst int64
	var burstForIP, burstMax int
	if gates.burst != nil {
		burst, _, burstForIP = gates.burst.statsFor(remoteAddr)
		burstMax = gates.burst.maxPerIP
	}
	pending, pendingIPs, pendingForIP := gates.pending.statsFor(remoteAddr)
	active, activeIPs, activeForIP := gates.active.statsFor(remoteAddr)
	log.Printf("%s tcp rejected by connection gate tunnel=%d client=%s reason=%s handshake=%d/%d handshakeIPs=%d handshakeForIP=%d/%d burst=%d burstForIP=%d/%d pending=%d/%d pendingIPs=%d pendingForIP=%d/%d active=%d/%d activeIPs=%d activeForIP=%d/%d", role, cfg.TunnelID, remoteAddr, reason, handshake, gates.handshake.maxConnections, handshakeIPs, handshakeForIP, gates.handshake.maxPerIP, burst, burstForIP, burstMax, pending, gates.pending.maxConnections, pendingIPs, pendingForIP, gates.pending.maxPerIP, active, gates.active.maxConnections, activeIPs, activeForIP, gates.active.maxPerIP)
}

/*
parseRuntimeFlags 解析命令行。

-version 打印运行时版本后退出：Agent 和安装脚本据此判断装着的 FXP 能不能和别的机器握手
（隧道协议有过不兼容的升级，Agent 升上去了而 FXP 还是旧的，这条隧道就连不通）。不认识这个
参数的旧版本会报 "flag provided but not defined" 并以退出码 2 结束，调用方据此认出旧版本。
*/
func parseRuntimeFlags(args []string, output io.Writer) (configPath string, showVersion bool, err error) {
	flags := flag.NewFlagSet("forwardx-fxp", flag.ContinueOnError)
	flags.SetOutput(output)
	config := flags.String("config", "", "config file")
	version := flags.Bool("version", false, "print the runtime version and exit")
	if err := flags.Parse(args); err != nil {
		return "", false, err
	}
	return *config, *version, nil
}

func printRuntimeVersion(output io.Writer) {
	fmt.Fprintln(output, fxpRuntimeVersion)
}

func main() {
	configPathValue, showVersion, flagErr := parseRuntimeFlags(os.Args[1:], os.Stderr)
	if errors.Is(flagErr, flag.ErrHelp) {
		os.Exit(0)
	}
	if flagErr != nil {
		os.Exit(2)
	}
	if showVersion {
		printRuntimeVersion(os.Stdout)
		return
	}
	ignoreBrokenPipeSignal()
	configureFXPLogging()
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	configPath := &configPathValue
	if *configPath == "" {
		log.Fatal("missing -config")
	}
	cfg, err := readConfig(*configPath)
	if err != nil {
		log.Fatalf("read config: %v", err)
	}
	if err := validateConfig(cfg); err != nil {
		log.Fatalf("invalid config: %v", err)
	}
	log.Printf(
		"forwardx-fxp runtime version=%s role=%s tunnel=%d rule=%d listen=:%d udpListen=:%d protocol=%s exit=%s:%d udpExit=%d relayNext=%s:%d udpRelayNext=%d target=%s:%d proxyReceive=%v proxySend=%v proxyExitReceive=%v proxyExitSend=%v limits=maxConnections:%d,maxIPs:%d,limitIn:%d,limitOut:%d",
		fxpRuntimeVersion,
		cfg.Role,
		cfg.TunnelID,
		cfg.RuleID,
		cfg.ListenPort,
		cfg.UDPListenPort,
		cfg.Protocol,
		cfg.ExitHost,
		cfg.ExitPort,
		cfg.UDPExitPort,
		cfg.RelayExitHost,
		cfg.RelayExitPort,
		cfg.UDPRelayExitPort,
		cfg.TargetIP,
		cfg.TargetPort,
		cfg.ProxyProtocolReceive,
		cfg.ProxyProtocolSend,
		cfg.ProxyProtocolExitReceive,
		cfg.ProxyProtocolExitSend,
		cfg.MaxConnections,
		cfg.MaxIPs,
		cfg.LimitIn,
		cfg.LimitOut,
	)
	log.Printf("forwardx-fxp udp wire packet limit=%dB transport=%s", configureFXPUDPWireLimit(cfg), cfg.TransportVersion)
	// 启动时就把帧加密算法的实测结果打出来（没写死时），排查「跑不满」能第一眼看到
	// 这台机器的 AES 快不快。
	if pinned := normalizeAEADConfig(cfg.AEAD); pinned != "" {
		log.Printf("fxp aead pinned=%s by config", pinned)
	} else {
		_ = preferredAEAD()
	}
	ctx := shutdownContext()
	writeFXPReloadAck(*configPath, cfg.ReloadNonce, nil)
	err = runManaged(ctx.done, cfg, watchFXPConfigReloads(*configPath))
	if err != nil && !errors.Is(err, net.ErrClosed) {
		log.Fatal(err)
	}
}

// watchFXPConfigReloads：收到 SIGHUP 就重读配置文件并交给运行时原地生效，
// 结果写进 <config>.applied，Agent 据此判断热更新成没成，不成就回退成重启。
func watchFXPConfigReloads(configPath string) <-chan fxpReloadRequest {
	requests := make(chan fxpReloadRequest)
	hup := make(chan os.Signal, 1)
	signal.Notify(hup, syscall.SIGHUP)
	go func() {
		for range hup {
			next, err := readConfig(configPath)
			if err == nil {
				err = validateConfig(next)
			}
			if err != nil {
				log.Printf("fxp config reload rejected: %v", err)
				writeFXPReloadAck(configPath, next.ReloadNonce, err)
				continue
			}
			result := make(chan error, 1)
			requests <- fxpReloadRequest{cfg: next, result: result}
			writeFXPReloadAck(configPath, next.ReloadNonce, <-result)
		}
	}()
	return requests
}

func writeFXPReloadAck(configPath, nonce string, applyErr error) {
	ack := struct {
		Nonce string `json:"nonce"`
		OK    bool   `json:"ok"`
		Error string `json:"error,omitempty"`
		PID   int    `json:"pid"`
	}{Nonce: nonce, OK: applyErr == nil, PID: os.Getpid()}
	if applyErr != nil {
		ack.Error = applyErr.Error()
	}
	raw, _ := json.Marshal(ack)
	tmp := configPath + ".applied.tmp"
	if err := os.WriteFile(tmp, raw, 0600); err != nil {
		return
	}
	_ = os.Rename(tmp, configPath+".applied")
}

type signalContext struct {
	done <-chan struct{}
}

func shutdownContext() signalContext {
	done := make(chan struct{})
	ch := make(chan os.Signal, 2)
	signal.Notify(ch, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-ch
		close(done)
	}()
	return signalContext{done: done}
}

func waitForFXPSessionDrain(role string, cfg config, sessions *sync.WaitGroup) {
	if sessions == nil {
		return
	}
	if waitForWaitGroup(sessions, fxpShutdownDrain) {
		log.Printf("%s tcp sessions drained tunnel=%d rule=%d", role, cfg.TunnelID, cfg.RuleID)
		return
	}
	log.Printf("%s tcp session drain timeout tunnel=%d rule=%d timeout=%s", role, cfg.TunnelID, cfg.RuleID, fxpShutdownDrain)
}

func waitForWaitGroup(group *sync.WaitGroup, timeout time.Duration) bool {
	drained := make(chan struct{})
	go func() {
		group.Wait()
		close(drained)
	}()
	select {
	case <-drained:
		return true
	case <-time.After(timeout):
		return false
	}
}

func normalizeProtocol(protocol string) string {
	switch strings.ToLower(strings.TrimSpace(protocol)) {
	case "udp":
		return "udp"
	case "both", "tcp+udp":
		return "both"
	default:
		return "tcp"
	}
}

func protocolHas(cfg config, network string) bool {
	return cfg.Protocol == "both" || cfg.Protocol == network
}

// dialTCP 拨下一跳。fastOpen 跟着面板上的 TFO 开关（cfg.TCPFastOpen），见
// tcpFastOpenDialControl。
func dialTCP(host string, port int, timeout time.Duration, fastOpen bool) (net.Conn, error) {
	d := net.Dialer{Timeout: timeout, KeepAlive: fxpTCPKeepAlive, Control: tcpFastOpenDialControl(fastOpen)}
	address, err := resolveHopAddress(host, port)
	if err != nil {
		return nil, err
	}
	conn, err := d.Dial("tcp", address)
	if err != nil {
		return nil, err
	}
	enableTCPKeepAlive(conn)
	return conn, nil
}

func secureDialTimeout(cfg config) time.Duration {
	// The panel includes the primary endpoint in Exits even when no extra
	// endpoint is configured. Treat a duplicate primary entry as a single
	// endpoint so ordinary routes retain the normal dial grace period.
	fallback := exitEndpoint{
		Host:    cfg.ExitHost,
		Port:    cfg.ExitPort,
		UDPPort: cfg.UDPExitPort,
		Key:     cfg.Key,
	}
	if strings.EqualFold(strings.TrimSpace(cfg.Role), "relay") {
		fallback = exitEndpoint{
			Host:    cfg.RelayExitHost,
			Port:    cfg.RelayExitPort,
			UDPPort: cfg.UDPRelayExitPort,
			Key:     cfg.RelayKey,
		}
	}
	if len(normalizeExitEndpoints(cfg.Exits, fallback)) > 1 {
		return fxpFallbackDial
	}
	return 10 * time.Second
}

// dialSecureTCP 返回一条握完手、确认过的安全连接：池里有预热好的就直接用，
// 没有才现拨。多路径的腿走这里。
func dialSecureTCP(host string, port int, cfg config) (net.Conn, *secureConn, error) {
	state := fxpEndpointStateFor(exitEndpoint{Host: host, Port: port, Key: cfg.Key})
	if conn, sec, ok := state.take(cfg); ok {
		return conn, sec, nil
	}
	return dialSecureTCPFresh(host, port, cfg)
}

// dialSecureTCPFresh 不碰连接池，现拨一条并完整握手。连接池预热和后台探测用它：
// 它们要的就是真实地走一遍网络。
func dialSecureTCPFresh(host string, port int, cfg config) (net.Conn, *secureConn, error) {
	conn, err := dialTCP(host, port, secureDialTimeout(cfg), cfg.TCPFastOpen)
	if err != nil {
		return nil, nil, err
	}
	sec, err := newClientSecureConnWithWire(conn, cfg, fxpWireCurrent)
	if err != nil {
		_ = conn.Close()
		return nil, nil, err
	}
	return conn, sec, nil
}

// enableTCPKeepAlive 是 FXP 拨出和接受的每一条 TCP 连接都要过的一道：
// 关 Nagle、开保活，以及按策略设拥塞控制（tcp_congestion.go）。
func enableTCPKeepAlive(conn net.Conn) {
	tcp, ok := conn.(*net.TCPConn)
	if !ok {
		return
	}
	_ = tcp.SetNoDelay(true)
	_ = tcp.SetKeepAlive(true)
	_ = tcp.SetKeepAlivePeriod(fxpTCPKeepAlive)
	tuneTCPCongestion(tcp)
}

func closeWriteConn(conn net.Conn) {
	if tcp, ok := conn.(*net.TCPConn); ok {
		_ = tcp.CloseWrite()
	}
}

func runEntry(done <-chan struct{}, cfg config) error {
	return runManaged(done, cfg, nil)
}

func runEntryGroup(done <-chan struct{}, cfg config) error {
	return runManaged(done, cfg, nil)
}

func handleEntryTCP(client net.Conn, cfg config, selector *exitEndpointSelector, inLimiter, outLimiter *limiter) error {
	defer client.Close()
	selectionKey := endpointSelectionSource(client.RemoteAddr().String())
	// 单路径：一接受就开始连下一跳（池里有就是现成的），不再先等客户端首包。
	// 以前先读首包、最多等 150ms 才拨号：SSH、SMTP、MySQL 这类服务端先说话的
	// 协议每条连接白等 150ms，客户端先说话的也要把「读」和「拨」串起来。
	var selected *selectedTransport
	var connectDone chan error
	startConnect := func() {
		if multipathEnabled(cfg) {
			return
		}
		selected = newSelectedTransport(selector, cfg, selectionKey)
		connectDone = make(chan error, 1)
		go func() { connectDone <- selected.connect() }()
	}
	// 要收 PROXY 头的规则等头读完再拨：现拨的连接在 hello 写出之前一直停在
	// 出口的握手阶段，而出口按来源 IP 只给握手阶段很小的份额。先拨再等头，
	// 外面随便开几十条不说话的连接，就能让这台入口占满出口给它的握手份额，
	// 其它规则跟着连不上。PROXY 头是负载均衡器连上就发的，先读它几乎不花时间。
	if !cfg.ProxyProtocolReceive {
		startConnect()
	}
	started := false
	defer func() {
		if selected != nil && !started {
			// 提前返回时连接可能还在建立，等它有了结果再关，免得漏掉。
			go func() {
				<-connectDone
				selected.closeTransport()
			}()
		}
	}()
	var first []byte
	proxyInfo := proxyProtocolInfoFromConn(client)
	// 只有要解析客户端送来的 PROXY 头时才需要先读：hello 里要带上真实来源。
	if cfg.ProxyProtocolReceive {
		initialTimeout := 5 * time.Second
		initial, err := readInitialTCPPayload(client, initialTimeout)
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
		parsed, remaining, ok, err := consumeProxyProtocolFromConn(client, initial, initialTimeout)
		if err != nil {
			return err
		}
		if !ok {
			return errors.New("missing proxy protocol header")
		}
		proxyInfo = parsed
		first = remaining
		startConnect()
	}
	if cfg.ProxyProtocolReceive || cfg.ProxyProtocolSend {
		fxpVerbosef(
			"entry proxy protocol tunnel=%d rule=%d receive=%v send=%v client=%s parsed=%v proxySource=%s:%d proxyDest=%s:%d",
			cfg.TunnelID,
			cfg.RuleID,
			cfg.ProxyProtocolReceive,
			cfg.ProxyProtocolSend,
			client.RemoteAddr(),
			proxyInfo.SourceIP != "",
			proxyInfo.SourceIP,
			proxyInfo.SourcePort,
			proxyInfo.DestIP,
			proxyInfo.DestPort,
		)
	}
	if !cfg.ProxyProtocolSend {
		proxyInfo = proxyProtocolInfo{}
	}
	helloValues := helloFrame{
		Network:                  "tcp",
		TargetIP:                 cfg.TargetIP,
		TargetPort:               cfg.TargetPort,
		TunnelID:                 cfg.TunnelID,
		RuleID:                   cfg.RuleID,
		SelectionKey:             selectionKey,
		ProxySourceIP:            proxyInfo.SourceIP,
		ProxySourcePort:          proxyInfo.SourcePort,
		ProxyDestIP:              proxyInfo.DestIP,
		ProxyDestPort:            proxyInfo.DestPort,
		ProxyProtocolExitReceive: cfg.ProxyProtocolExitReceive,
		ProxyProtocolExitSend:    cfg.ProxyProtocolExitSend,
		ProxyProtocolVersion:     normalizeProxyProtocolVersion(cfg.ProxyProtocolVersion),
	}
	policy := protocolPolicy{BlockHTTP: cfg.BlockHTTP, BlockSocks: cfg.BlockSocks, BlockTLS: cfg.BlockTLS}
	reportBlock := func(proto string) {
		reportProtocolBlock(cfg, proto)
	}
	if len(first) > 0 {
		if proto := detectBlockedProtocol(first, policy); proto != "" {
			reportBlock(proto)
			return nil
		}
	}
	// A multipath entry spreads this one client connection over every leg, so
	// the session is no longer capped by the slowest single path.
	var transport frameConn
	if multipathEnabled(cfg) {
		session, err := dialEntryMultipath(cfg, helloValues, client)
		if err != nil {
			return fmt.Errorf("dial multipath exit: %w", err)
		}
		transport = session
		if len(first) > 0 {
			inLimiter.wait(len(first))
			if err := transport.writeFrame(first); err != nil {
				transport.closeTransport()
				return err
			}
		}
	} else {
		if err := <-connectDone; err != nil {
			return fmt.Errorf("dial exit: %w", err)
		}
		hello, _ := json.Marshal(helloValues)
		frames := [][]byte{hello}
		if len(first) > 0 {
			inLimiter.wait(len(first))
			frames = append(frames, first)
		}
		started = true
		if err := selected.start(frames...); err != nil {
			selected.closeTransport()
			return fmt.Errorf("dial exit: %w", err)
		}
		endpoint := selected.currentEndpoint()
		fxpVerbosef("entry tcp routed tunnel=%d rule=%d client=%s exit=%s:%d target=%s:%d", cfg.TunnelID, cfg.RuleID, client.RemoteAddr(), endpoint.Host, endpoint.Port, cfg.TargetIP, cfg.TargetPort)
		transport = selected
	}
	defer transport.closeTransport()
	counter := &trafficCounter{}
	// Count the accepted FXP client session even when it carries no payload.
	counter.connections.Store(1)
	counter.in.Add(uint64(len(first)))
	stopReporting := startTrafficReporter(cfg, counter)
	defer stopReporting()
	return proxyPlainSecureWithPolicy(client, transport, inLimiter, outLimiter, counter, policy, reportBlock, first)
}

func readInitialTCPPayload(conn net.Conn, timeout time.Duration) ([]byte, error) {
	if timeout > 0 {
		_ = conn.SetReadDeadline(time.Now().Add(timeout))
	}
	buf := make([]byte, 4096)
	n, err := conn.Read(buf)
	_ = conn.SetReadDeadline(time.Time{})
	if n > 0 {
		return append([]byte(nil), buf[:n]...), nil
	}
	if err != nil {
		if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
			return nil, nil
		}
		return nil, err
	}
	return nil, nil
}

type proxyProtocolInfo struct {
	SourceIP   string
	SourcePort int
	DestIP     string
	DestPort   int
}

func proxyProtocolInfoFromConn(conn net.Conn) proxyProtocolInfo {
	info := proxyProtocolInfo{}
	if conn == nil {
		return info
	}
	if host, port := splitAddrHostPort(conn.RemoteAddr()); host != "" {
		info.SourceIP = host
		info.SourcePort = port
	}
	if host, port := splitAddrHostPort(conn.LocalAddr()); host != "" {
		info.DestIP = host
		info.DestPort = port
	}
	return info
}

func splitAddrHostPort(addr net.Addr) (string, int) {
	if addr == nil {
		return "", 0
	}
	host, portText, err := net.SplitHostPort(addr.String())
	if err != nil {
		return addr.String(), 0
	}
	port, _ := strconv.Atoi(portText)
	return host, port
}

func consumeProxyProtocolV1(data []byte) (proxyProtocolInfo, []byte, bool, error) {
	if !bytes.HasPrefix(data, []byte("PROXY ")) {
		return proxyProtocolInfo{}, data, false, nil
	}
	end := bytes.Index(data, []byte("\r\n"))
	if end < 0 {
		return proxyProtocolInfo{}, nil, false, errors.New("incomplete proxy protocol header")
	}
	line := string(data[:end])
	parts := strings.Fields(line)
	if len(parts) < 2 || parts[0] != "PROXY" {
		return proxyProtocolInfo{}, nil, false, errors.New("invalid proxy protocol header")
	}
	if parts[1] == "UNKNOWN" {
		return proxyProtocolInfo{}, data[end+2:], true, nil
	}
	if len(parts) != 6 || (parts[1] != "TCP4" && parts[1] != "TCP6") {
		return proxyProtocolInfo{}, nil, false, errors.New("unsupported proxy protocol header")
	}
	srcPort, err := strconv.Atoi(parts[4])
	if err != nil || srcPort <= 0 || srcPort > 65535 {
		return proxyProtocolInfo{}, nil, false, errors.New("invalid proxy protocol source port")
	}
	dstPort, err := strconv.Atoi(parts[5])
	if err != nil || dstPort <= 0 || dstPort > 65535 {
		return proxyProtocolInfo{}, nil, false, errors.New("invalid proxy protocol destination port")
	}
	return proxyProtocolInfo{
		SourceIP:   parts[2],
		DestIP:     parts[3],
		SourcePort: srcPort,
		DestPort:   dstPort,
	}, data[end+2:], true, nil
}

func consumeProxyProtocolV1FromConn(conn net.Conn, data []byte, timeout time.Duration) (proxyProtocolInfo, []byte, bool, error) {
	buf := append([]byte(nil), data...)
	for len(buf) > 0 && len(buf) < 108 && (bytes.HasPrefix(buf, []byte("PROXY ")) || bytes.HasPrefix([]byte("PROXY "), buf)) && bytes.Index(buf, []byte("\r\n")) < 0 {
		if timeout > 0 {
			_ = conn.SetReadDeadline(time.Now().Add(timeout))
		}
		tmp := make([]byte, 108-len(buf))
		n, err := conn.Read(tmp)
		_ = conn.SetReadDeadline(time.Time{})
		if n > 0 {
			buf = append(buf, tmp[:n]...)
		}
		if err != nil {
			if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
				break
			}
			return proxyProtocolInfo{}, nil, false, err
		}
		if n == 0 {
			break
		}
	}
	return consumeProxyProtocolV1(buf)
}

var proxyProtocolV2Signature = []byte{0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a}

func normalizeProxyProtocolVersion(version int) int {
	if version == 2 {
		return 2
	}
	return 1
}

func consumeProxyProtocol(data []byte) (proxyProtocolInfo, []byte, bool, error) {
	if bytes.HasPrefix(data, []byte("PROXY ")) {
		return consumeProxyProtocolV1(data)
	}
	if bytes.HasPrefix(data, proxyProtocolV2Signature) {
		return consumeProxyProtocolV2(data)
	}
	if len(data) > 0 && len(data) < len(proxyProtocolV2Signature) && bytes.HasPrefix(proxyProtocolV2Signature, data) {
		return proxyProtocolInfo{}, nil, false, errors.New("incomplete proxy protocol v2 header")
	}
	return proxyProtocolInfo{}, data, false, nil
}

func consumeProxyProtocolFromConn(conn net.Conn, data []byte, timeout time.Duration) (proxyProtocolInfo, []byte, bool, error) {
	buf := append([]byte(nil), data...)
	if len(buf) == 0 {
		return consumeProxyProtocol(buf)
	}
	if bytes.HasPrefix(buf, []byte("PROXY ")) || bytes.HasPrefix([]byte("PROXY "), buf) {
		return consumeProxyProtocolV1FromConn(conn, buf, timeout)
	}
	if bytes.HasPrefix(buf, proxyProtocolV2Signature) || bytes.HasPrefix(proxyProtocolV2Signature, buf) {
		for len(buf) < 16 {
			more, err := readProxyProtocolMore(conn, timeout, 16-len(buf))
			if len(more) > 0 {
				buf = append(buf, more...)
			}
			if err != nil {
				return proxyProtocolInfo{}, nil, false, err
			}
			if len(more) == 0 {
				return proxyProtocolInfo{}, nil, false, errors.New("incomplete proxy protocol v2 header")
			}
		}
		length := int(binary.BigEndian.Uint16(buf[14:16]))
		need := 16 + length
		for len(buf) < need {
			more, err := readProxyProtocolMore(conn, timeout, need-len(buf))
			if len(more) > 0 {
				buf = append(buf, more...)
			}
			if err != nil {
				return proxyProtocolInfo{}, nil, false, err
			}
			if len(more) == 0 {
				return proxyProtocolInfo{}, nil, false, errors.New("incomplete proxy protocol v2 payload")
			}
		}
	}
	return consumeProxyProtocol(buf)
}

func readProxyProtocolMore(conn net.Conn, timeout time.Duration, limit int) ([]byte, error) {
	if limit <= 0 {
		return nil, nil
	}
	if timeout > 0 {
		_ = conn.SetReadDeadline(time.Now().Add(timeout))
	}
	tmp := make([]byte, limit)
	n, err := conn.Read(tmp)
	_ = conn.SetReadDeadline(time.Time{})
	if n > 0 {
		return tmp[:n], err
	}
	return nil, err
}

func consumeProxyProtocolV2(data []byte) (proxyProtocolInfo, []byte, bool, error) {
	if !bytes.HasPrefix(data, proxyProtocolV2Signature) {
		return proxyProtocolInfo{}, data, false, nil
	}
	if len(data) < 16 {
		return proxyProtocolInfo{}, nil, false, errors.New("incomplete proxy protocol v2 header")
	}
	versionCommand := data[12]
	if versionCommand>>4 != 0x2 {
		return proxyProtocolInfo{}, nil, false, errors.New("invalid proxy protocol v2 version")
	}
	command := versionCommand & 0x0f
	familyProtocol := data[13]
	length := int(binary.BigEndian.Uint16(data[14:16]))
	if len(data) < 16+length {
		return proxyProtocolInfo{}, nil, false, errors.New("incomplete proxy protocol v2 payload")
	}
	payload := data[16 : 16+length]
	remaining := data[16+length:]
	if command == 0x0 {
		return proxyProtocolInfo{}, remaining, true, nil
	}
	if command != 0x1 {
		return proxyProtocolInfo{}, nil, false, errors.New("unsupported proxy protocol v2 command")
	}
	switch familyProtocol {
	case 0x11:
		if len(payload) < 12 {
			return proxyProtocolInfo{}, nil, false, errors.New("invalid proxy protocol v2 tcp4 payload")
		}
		return proxyProtocolInfo{SourceIP: net.IP(payload[0:4]).String(), DestIP: net.IP(payload[4:8]).String(), SourcePort: int(binary.BigEndian.Uint16(payload[8:10])), DestPort: int(binary.BigEndian.Uint16(payload[10:12]))}, remaining, true, nil
	case 0x21:
		if len(payload) < 36 {
			return proxyProtocolInfo{}, nil, false, errors.New("invalid proxy protocol v2 tcp6 payload")
		}
		return proxyProtocolInfo{SourceIP: net.IP(payload[0:16]).String(), DestIP: net.IP(payload[16:32]).String(), SourcePort: int(binary.BigEndian.Uint16(payload[32:34])), DestPort: int(binary.BigEndian.Uint16(payload[34:36]))}, remaining, true, nil
	case 0x00:
		return proxyProtocolInfo{}, remaining, true, nil
	default:
		return proxyProtocolInfo{}, nil, false, errors.New("unsupported proxy protocol v2 address family")
	}
}

func formatProxyProtocol(hello helloFrame) []byte {
	if normalizeProxyProtocolVersion(hello.ProxyProtocolVersion) == 2 {
		return formatProxyProtocolV2(hello)
	}
	return []byte(formatProxyProtocolV1(hello))
}

func formatProxyProtocolV2(hello helloFrame) []byte {
	sourceIP, destIP, sourcePort, destPort := proxyProtocolHelloValues(hello)
	src := net.ParseIP(sourceIP)
	dst := net.ParseIP(destIP)
	if src == nil || dst == nil || sourcePort <= 0 || destPort <= 0 {
		return formatProxyProtocolV2Local()
	}
	if src4, dst4 := src.To4(), dst.To4(); src4 != nil && dst4 != nil {
		buf := make([]byte, 28)
		copy(buf, proxyProtocolV2Signature)
		buf[12] = 0x21
		buf[13] = 0x11
		binary.BigEndian.PutUint16(buf[14:16], 12)
		copy(buf[16:20], src4)
		copy(buf[20:24], dst4)
		binary.BigEndian.PutUint16(buf[24:26], uint16(sourcePort))
		binary.BigEndian.PutUint16(buf[26:28], uint16(destPort))
		return buf
	}
	src16 := src.To16()
	dst16 := dst.To16()
	if src16 == nil || dst16 == nil || src.To4() != nil || dst.To4() != nil {
		return formatProxyProtocolV2Local()
	}
	buf := make([]byte, 52)
	copy(buf, proxyProtocolV2Signature)
	buf[12] = 0x21
	buf[13] = 0x21
	binary.BigEndian.PutUint16(buf[14:16], 36)
	copy(buf[16:32], src16)
	copy(buf[32:48], dst16)
	binary.BigEndian.PutUint16(buf[48:50], uint16(sourcePort))
	binary.BigEndian.PutUint16(buf[50:52], uint16(destPort))
	return buf
}

func formatProxyProtocolV2Local() []byte {
	buf := make([]byte, 16)
	copy(buf, proxyProtocolV2Signature)
	buf[12] = 0x20
	buf[13] = 0x00
	return buf
}

func proxyProtocolHelloValues(hello helloFrame) (string, string, int, int) {
	sourceIP := strings.TrimSpace(hello.ProxySourceIP)
	destIP := strings.TrimSpace(hello.ProxyDestIP)
	if destIP == "" {
		destIP = strings.TrimSpace(hello.TargetIP)
	}
	sourcePort := hello.ProxySourcePort
	destPort := hello.ProxyDestPort
	if destPort <= 0 {
		destPort = hello.TargetPort
	}
	return sourceIP, destIP, sourcePort, destPort
}
func formatProxyProtocolV1(hello helloFrame) string {
	sourceIP := strings.TrimSpace(hello.ProxySourceIP)
	destIP := strings.TrimSpace(hello.ProxyDestIP)
	if destIP == "" {
		destIP = strings.TrimSpace(hello.TargetIP)
	}
	sourcePort := hello.ProxySourcePort
	destPort := hello.ProxyDestPort
	if destPort <= 0 {
		destPort = hello.TargetPort
	}
	family := "TCP4"
	if strings.Contains(sourceIP, ":") || strings.Contains(destIP, ":") {
		family = "TCP6"
	}
	return fmt.Sprintf("PROXY %s %s %s %d %d\r\n", family, sourceIP, destIP, sourcePort, destPort)
}

type udpEntrySession struct {
	key          netip.AddrPort
	sourceIP     netip.Addr
	clientAddr   *net.UDPAddr
	conn         *net.UDPConn
	exit         net.Conn
	sec          *secureConn
	cfg          config
	endpoint     exitEndpoint
	inLimiter    *limiter
	outLimiter   *limiter
	counter      *trafficCounter
	send         *fxpUDPQueue
	done         chan struct{}
	closeOnce    sync.Once
	lastActivity atomic.Int64
	inFlight     atomic.Int64
	remove       func(*udpEntrySession)
}

func udpEntrySessionSnapshot(session *udpEntrySession) fxpUDPSessionSnapshot {
	state := fxpUDPSessionSnapshot{}
	if session == nil {
		return state
	}
	if session.clientAddr != nil {
		state.sourceIP = session.clientAddr.IP.String()
	}
	state.lastActivity = session.lastActivity.Load()
	if session.send != nil {
		state.pending = session.send.pending()
	}
	state.pending += int(session.inFlight.Load())
	return state
}

func serveEntryUDP(conn *net.UDPConn, cfg config, selector *exitEndpointSelector, inLimiter, outLimiter *limiter) error {
	// 和 UDP 直连入口一样按 netip 地址找会话，读循环里不再每包格式化地址。
	sessions := map[netip.AddrPort]*udpEntrySession{}
	sessionsPerIP := map[netip.Addr]int{}
	policy := defaultFXPUDPSessionPolicy()
	var sessionsMu sync.Mutex
	var workerWG sync.WaitGroup
	counter := &trafficCounter{}
	stopReporting := startTrafficReporter(cfg, counter)
	defer stopReporting()
	queueBudget := newDefaultFXPUDPQueueRuleBudget()
	detachSessionLocked := func(session *udpEntrySession) bool {
		if session == nil || sessions[session.key] != session {
			return false
		}
		delete(sessions, session.key)
		if session.sourceIP.IsValid() {
			if sessionsPerIP[session.sourceIP] <= 1 {
				delete(sessionsPerIP, session.sourceIP)
			} else {
				sessionsPerIP[session.sourceIP]--
			}
		}
		return true
	}
	removeSession := func(session *udpEntrySession) {
		sessionsMu.Lock()
		detachSessionLocked(session)
		sessionsMu.Unlock()
	}
	stopSweeper, wakeSweeper := startFXPUDPSessionSweeper(func(now time.Time) {
		var expired []*udpEntrySession
		var reclaimed []*udpEntrySession
		sessionsMu.Lock()
		for key, session := range sessions {
			state := udpEntrySessionSnapshot(session)
			if session != nil && fxpUDPSessionExpiredAt(now, state.lastActivity, state.pending) {
				if sessions[key] == session && detachSessionLocked(session) {
					expired = append(expired, session)
				}
			}
		}
		for _, victim := range planFXPUDPPressureReclamation(now, sessions, policy, udpEntrySessionSnapshot) {
			if sessions[victim.key] == victim.session && detachSessionLocked(victim.session) {
				reclaimed = append(reclaimed, victim.session)
			}
		}
		sessionsMu.Unlock()
		for _, session := range expired {
			fxpVerbosef("entry udp session idle timeout tunnel=%d rule=%d client=%s", session.cfg.TunnelID, session.cfg.RuleID, session.clientAddr)
			session.close()
		}
		for _, session := range reclaimed {
			session.close()
			fxpUDPDropLog.Printf("entry udp stream reclaimed idle session tunnel=%d rule=%d client=%s reason=capacity-pressure", session.cfg.TunnelID, session.cfg.RuleID, session.clientAddr)
		}
	})
	defer stopSweeper()
	buf := make([]byte, 65535)
	for {
		n, clientAddrPort, err := conn.ReadFromUDPAddrPort(buf)
		if err != nil {
			var closing []*udpEntrySession
			sessionsMu.Lock()
			for _, session := range sessions {
				closing = append(closing, session)
			}
			sessionsMu.Unlock()
			for _, session := range closing {
				session.close()
			}
			workerWG.Wait()
			return err
		}
		clientAddrPort = fxpUDPNormalizeAddrPort(clientAddrPort)
		key := clientAddrPort
		sourceIP := fxpUDPSourceIP(clientAddrPort)
		sessionsMu.Lock()
		session := sessions[key]
		if session != nil {
			session.touch()
		}
		preflight := fxpUDPAdmission{allow: true}
		if session == nil {
			preflight = checkFXPUDPSessionCapacity(len(sessions), sessionsPerIP[sourceIP], sourceIP.String(), policy)
		}
		sessionsMu.Unlock()
		if !preflight.allow {
			wakeSweeper()
			fxpUDPDropLog.Printf("entry udp stream rejected new session tunnel=%d rule=%d client=%s reason=%s sessions=%d perIP=%d hardSessions=%d hardPerIP=%d", cfg.TunnelID, cfg.RuleID, clientAddrPort, preflight.reason, preflight.total, preflight.perIP, policy.hardSessions, policy.hardPerIP)
			continue
		}
		startSession := false
		if session == nil {
			clientAddr := net.UDPAddrFromAddrPort(clientAddrPort)
			sourceIPLabel := sourceIP.String()
			created, err := newUDPEntrySession(conn, clientAddr, cfg, selector, inLimiter, outLimiter, counter, queueBudget, removeSession)
			if err != nil {
				if !isClosedErr(err) {
					log.Printf("entry udp session create failed tunnel=%d rule=%d client=%s: %v", cfg.TunnelID, cfg.RuleID, clientAddr, err)
				}
				continue
			}
			var closeCreated *udpEntrySession
			var admission fxpUDPAdmission
			rejected := false
			pressure := false
			sessionsMu.Lock()
			if existing := sessions[key]; existing != nil {
				session = existing
				session.touch()
				closeCreated = created
			} else {
				admission = checkFXPUDPSessionCapacity(len(sessions), sessionsPerIP[sourceIP], sourceIPLabel, policy)
				if !admission.allow {
					closeCreated = created
					rejected = true
				} else {
					sessions[key] = created
					sessionsPerIP[sourceIP]++
					session = created
					startSession = true
					pressure = fxpUDPSessionPressure(len(sessions), sessionsPerIP[sourceIP], sourceIPLabel, policy)
				}
			}
			sessionsMu.Unlock()
			if closeCreated != nil {
				closeCreated.close()
			}
			if rejected {
				wakeSweeper()
				fxpUDPDropLog.Printf("entry udp stream rejected new session tunnel=%d rule=%d client=%s reason=%s sessions=%d perIP=%d hardSessions=%d hardPerIP=%d", cfg.TunnelID, cfg.RuleID, clientAddr, admission.reason, admission.total, admission.perIP, policy.hardSessions, policy.hardPerIP)
				continue
			}
			if pressure {
				wakeSweeper()
			}
		}
		if startSession {
			session.counter.connections.Add(1)
			session.start(&workerWG)
		}
		// 明文拷进借来的缓冲，连同所有权交给发送队列，写出去之后还回池里。
		payload := getFXPByteBuffer(n)
		copy(payload, buf[:n])
		session.enqueue(payload, true)
	}
}

func newUDPEntrySession(conn *net.UDPConn, clientAddr *net.UDPAddr, cfg config, selector *exitEndpointSelector, inLimiter, outLimiter *limiter, counter *trafficCounter, queueBudget *fxpUDPQueueRuleBudget, remove func(*udpEntrySession)) (*udpEntrySession, error) {
	selectionKey := clientAddr.IP.String()
	exit, sec, endpoint, err := dialSelectedSecureTCP(selector, cfg, selectionKey)
	if err != nil {
		return nil, err
	}
	hello, _ := json.Marshal(helloFrame{
		Network:      "udp",
		TargetIP:     cfg.TargetIP,
		TargetPort:   cfg.TargetPort,
		TunnelID:     cfg.TunnelID,
		RuleID:       cfg.RuleID,
		SelectionKey: selectionKey,
	})
	if err := writeSecureHello(sec, hello); err != nil {
		_ = exit.Close()
		return nil, err
	}
	if counter == nil {
		counter = &trafficCounter{}
	}
	clientAddrPort := fxpUDPAddrPortOf(clientAddr)
	session := &udpEntrySession{
		key:        clientAddrPort,
		sourceIP:   fxpUDPSourceIP(clientAddrPort),
		clientAddr: clientAddr,
		conn:       conn,
		exit:       exit,
		sec:        sec,
		cfg:        cfg,
		endpoint:   endpoint,
		inLimiter:  inLimiter,
		outLimiter: outLimiter,
		counter:    counter,
		send:       newFXPUDPQueueWithBudget(fxpUDPStreamQueueSize, fxpUDPQueueMaxBytes, queueBudget),
		done:       make(chan struct{}),
		remove:     remove,
	}
	session.touch()
	return session, nil
}

func (s *udpEntrySession) touch() {
	s.lastActivity.Store(time.Now().UnixNano())
}

func (s *udpEntrySession) start(workerWG *sync.WaitGroup) {
	startFXPUDPSessionWorker(workerWG, s.writeLoop)
	startFXPUDPSessionWorker(workerWG, s.readLoop)
	fxpVerbosef("entry udp session started tunnel=%d rule=%d client=%s exit=%s:%d target=%s:%d", s.cfg.TunnelID, s.cfg.RuleID, s.clientAddr, s.endpoint.Host, s.endpoint.Port, s.cfg.TargetIP, s.cfg.TargetPort)
}

// enqueue 把客户端发来的一个包放进发送队列。pooled 时 payload 的所有权一并交出。
func (s *udpEntrySession) enqueue(payload []byte, pooled bool) {
	s.touch()
	select {
	case <-s.done:
		recycleFXPUDPPayload(payload, pooled)
		return
	default:
		if s.send.enqueueOwned(payload, pooled) {
			fxpUDPDropLog.Printf("entry udp session queue congested tunnel=%d rule=%d client=%s; packet dropped", s.cfg.TunnelID, s.cfg.RuleID, s.clientAddr)
		}
	}
}

func (s *udpEntrySession) writeLoop() {
	for {
		packet, ok := s.send.nextTracked(s.done, &s.inFlight)
		if !ok {
			return
		}
		if packet.superseded(time.Now(), s.send.pending()) {
			fxpUDPDropLog.Printf("entry udp queued packet expired tunnel=%d rule=%d client=%s; dropping stale packet", s.cfg.TunnelID, s.cfg.RuleID, s.clientAddr)
			packet.done()
			continue
		}
		payload := packet.payload
		s.touch()
		if !s.inLimiter.waitDone(s.done, len(payload)) {
			packet.done()
			return
		}
		if packet.superseded(time.Now(), s.send.pending()) {
			fxpUDPDropLog.Printf("entry udp queued packet expired after wait tunnel=%d rule=%d client=%s; dropping stale packet", s.cfg.TunnelID, s.cfg.RuleID, s.clientAddr)
			packet.done()
			continue
		}
		if err := s.sec.writeFrame(payload); err != nil {
			if !isClosedErr(err) {
				log.Printf("entry udp write failed tunnel=%d rule=%d client=%s: %v", s.cfg.TunnelID, s.cfg.RuleID, s.clientAddr, err)
			}
			packet.done()
			s.close()
			return
		}
		s.counter.in.Add(uint64(len(payload)))
		packet.done()
	}
}

func (s *udpEntrySession) readLoop() {
	for {
		frame, err := s.sec.readFrame()
		if err != nil {
			if !isClosedErr(err) {
				log.Printf("entry udp read failed tunnel=%d rule=%d client=%s: %v", s.cfg.TunnelID, s.cfg.RuleID, s.clientAddr, err)
			}
			s.close()
			return
		}
		if len(frame) == 0 {
			s.close()
			return
		}
		s.touch()
		s.inFlight.Add(1)
		if !s.outLimiter.waitDone(s.done, len(frame)) {
			s.inFlight.Add(-1)
			return
		}
		if _, err := s.conn.WriteToUDP(frame, s.clientAddr); err != nil {
			if !isClosedErr(err) {
				log.Printf("entry udp client write failed tunnel=%d rule=%d client=%s: %v", s.cfg.TunnelID, s.cfg.RuleID, s.clientAddr, err)
			}
			s.inFlight.Add(-1)
			s.close()
			return
		}
		s.counter.out.Add(uint64(len(frame)))
		s.touch()
		s.inFlight.Add(-1)
	}
}

func (s *udpEntrySession) close() {
	s.closeOnce.Do(func() {
		close(s.done)
		s.send.close()
		if s.remove != nil {
			s.remove(s)
		}
		_ = s.exit.Close()
	})
}

func runExit(done <-chan struct{}, cfg config) error {
	return runManaged(done, cfg, nil)
}

func handleExitSession(conn net.Conn, cfg config) error {
	return handleExitSessionWithStartup(conn, cfg, nil)
}

func handleExitSessionWithStartup(conn net.Conn, cfg config, in *fxpInbound) error {
	defer conn.Close()
	sec, err := newExitSecureConn(conn, cfg)
	if err != nil {
		probeDelay()
		return err
	}
	if !in.authenticated(cfg) {
		return nil
	}
	frame, err := awaitSecureHello(sec, in.stop())
	if err != nil {
		return quietHelloError(err)
	}
	var hello helloFrame
	if err := json.Unmarshal(frame, &hello); err != nil {
		probeDelay()
		return err
	}
	in.helloReceived()
	if hello.Network == "probe" {
		return nil
	}
	if hello.TargetIP == "" {
		hello.TargetIP = cfg.TargetIP
	}
	if hello.TargetPort <= 0 {
		hello.TargetPort = cfg.TargetPort
	}
	// 连接可能是重载之前接受的（上一跳池子里的连接最多空等 fxpServerHelloWait），
	// 按监听当前的配置核对，不用接受那一刻的旧配置。
	in.recordHello(hello)
	if cfg, err = in.currentConfig(cfg); err != nil {
		return err
	}
	// 出口只拨面板给它的目标表里的目标（见 exit_targets.go）。多路径的每条腿
	// 都走到这里，领头那条拨目标之前已经核对过。
	if err := authorizeExitTarget(cfg, &hello); err != nil {
		return err
	}
	if !hello.ProxyProtocolExitReceive {
		hello.ProxySourceIP = ""
		hello.ProxySourcePort = 0
		hello.ProxyDestIP = ""
		hello.ProxyDestPort = 0
	}
	switch strings.ToLower(hello.Network) {
	case "udp":
		return handleExitUDP(sec, hello, cfg)
	default:
		// Legs sharing a multipath session id are reassembled into one stream
		// before the target is dialled, so only the leading leg connects out.
		if strings.TrimSpace(hello.MultipathSessionID) != "" {
			return handleExitMultipath(sec, hello, cfg)
		}
		return handleExitTCP(sec, hello, cfg)
	}
}

func handleExitTCP(sec *secureConn, hello helloFrame, cfg config) error {
	return relayExitTCPToTarget(sec, hello, cfg)
}

// relayExitTCPToTarget connects to the target and relays one exit session over
// the given transport, which is a single secure connection for an ordinary
// session and a multipath session when the entry striped it over several legs.
func relayExitTCPToTarget(sec frameConn, hello helloFrame, cfg config) error {
	target, err := dialExitTarget(hello, 10*time.Second)
	if err != nil {
		return fmt.Errorf("dial target: %w", err)
	}
	defer target.Close()
	// 出口按放行的规则记一份流量（见 exit_traffic.go）。多路径会话只有领头那条腿
	// 走到这里，一个会话只记一次。
	counter, stopReporting := startExitTrafficReporter(cfg, hello.accountingRuleID)
	defer stopReporting()
	var toTarget, fromTarget *atomic.Uint64
	if counter != nil {
		counter.connections.Store(1)
		toTarget, fromTarget = &counter.in, &counter.out
	}
	if hello.ProxyProtocolExitSend && hello.ProxySourceIP != "" && hello.ProxySourcePort > 0 {
		fxpVerbosef(
			"exit proxy protocol send tunnel=%d rule=%d source=%s:%d dest=%s:%d target=%s:%d",
			hello.TunnelID,
			hello.RuleID,
			hello.ProxySourceIP,
			hello.ProxySourcePort,
			hello.ProxyDestIP,
			hello.ProxyDestPort,
			hello.TargetIP,
			hello.TargetPort,
		)
		if _, err := target.Write(formatProxyProtocol(hello)); err != nil {
			return fmt.Errorf("write proxy protocol: %w", err)
		}
	} else if hello.ProxyProtocolExitSend {
		fxpVerbosef("exit proxy protocol skipped tunnel=%d rule=%d target=%s:%d missingSource=%v", hello.TunnelID, hello.RuleID, hello.TargetIP, hello.TargetPort, hello.ProxySourceIP == "" || hello.ProxySourcePort <= 0)
	}
	fxpVerbosef("exit tcp routed tunnel=%d rule=%d target=%s:%d", hello.TunnelID, hello.RuleID, hello.TargetIP, hello.TargetPort)
	// 出口这边 plain 是目标：目标 → 入口是 out，入口 → 目标是 in，和入口的记法一样。
	return proxyPlainSecureCounted(target, sec, nil, nil, fromTarget, toTarget, protocolPolicy{}, nil, nil)
}

func handleExitUDP(sec *secureConn, hello helloFrame, cfg config) error {
	targetAddr, err := resolveExitUDPTarget(hello)
	if err != nil {
		return err
	}
	target, err := net.DialUDP("udp", nil, targetAddr)
	if err != nil {
		return err
	}
	tuneUDPConn(target, "exit target", fxpUDPSessionBufferBytes)
	defer target.Close()
	counter, stopReporting := startExitTrafficReporter(cfg, hello.accountingRuleID)
	defer stopReporting()
	if counter == nil {
		counter = &trafficCounter{}
	}
	counter.connections.Store(1)
	fxpVerbosef("exit udp session routed tunnel=%d rule=%d peer=%s target=%s:%d", hello.TunnelID, hello.RuleID, sec.conn.RemoteAddr(), hello.TargetIP, hello.TargetPort)
	var lastActivity atomic.Int64
	lastActivity.Store(time.Now().UnixNano())
	touch := func() { lastActivity.Store(time.Now().UnixNano()) }
	errCh := make(chan error, 2)
	go func() {
		for {
			frame, err := sec.readFrame()
			if err != nil {
				errCh <- err
				return
			}
			if len(frame) == 0 {
				errCh <- nil
				return
			}
			if _, err := target.Write(frame); err != nil {
				errCh <- err
				return
			}
			counter.in.Add(uint64(len(frame)))
			touch()
		}
	}()
	go func() {
		buf := getFXPByteBuffer(fxpUDPMaxDatagramPayload)
		defer putFXPByteBuffer(buf)
		// 读超时只用来定期醒来检查空闲（按 lastActivity 算），不再每包重设，
		// 见 fxpRearmingReadDeadline。
		deadline := fxpRearmingReadDeadline{period: fxpUDPTargetReadWake}
		for {
			deadline.arm(target, time.Now())
			n, err := target.Read(buf)
			if err != nil {
				if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
					last := time.Unix(0, lastActivity.Load())
					if time.Since(last) >= fxpUDPIdleTimeout {
						errCh <- nil
						return
					}
					continue
				}
				errCh <- err
				return
			}
			if n <= 0 {
				continue
			}
			if err := sec.writeFrame(buf[:n]); err != nil {
				errCh <- err
				return
			}
			counter.out.Add(uint64(n))
			touch()
		}
	}()
	err = <-errCh
	_ = target.Close()
	_ = sec.conn.Close()
	if err != nil && !isClosedErr(err) {
		return err
	}
	return nil
}

// runRelay acts as an intermediate hop in a multi-hop FXP chain.
// It listens for encrypted connections from the upstream, reads the helloFrame,
// connects to the next downstream hop with a new key, re-sends the helloFrame,
// and bidirectionally relays decrypted frames between the two secure connections.
func runRelay(done <-chan struct{}, cfg config) error {
	return runManaged(done, cfg, nil)
}

func handleRelaySession(upConn net.Conn, cfg config, selector *exitEndpointSelector) error {
	return handleRelaySessionWithStartup(upConn, cfg, selector, nil)
}

func handleRelaySessionWithStartup(upConn net.Conn, cfg config, selector *exitEndpointSelector, in *fxpInbound) error {
	defer upConn.Close()
	// Accept upstream encrypted connection (like exit)
	upSec, err := newExitSecureConn(upConn, cfg)
	if err != nil {
		probeDelay()
		return err
	}
	if !in.authenticated(cfg) {
		return nil
	}
	frame, err := awaitSecureHello(upSec, in.stop())
	if err != nil {
		return quietHelloError(err)
	}
	var hello helloFrame
	if err := json.Unmarshal(frame, &hello); err != nil {
		probeDelay()
		return err
	}
	in.helloReceived()
	if hello.Network == "probe" {
		// 上一跳在探这台中转本身活没活，不往下传。
		return nil
	}
	// 握手用的密钥被重载换掉了（连接在重载之前接受，或在上一跳池子里空等了
	// 一阵），不再往下传。中转不核对目标，下游选择器沿用这条连接的处理器。
	if _, err := in.currentConfig(cfg); err != nil {
		return err
	}
	fxpVerbosef(
		"relay proxy protocol tunnel=%d rule=%d upstream=%s downstream=%s:%d hasProxy=%v source=%s:%d dest=%s:%d",
		cfg.TunnelID,
		hello.RuleID,
		upConn.RemoteAddr(),
		cfg.RelayExitHost,
		cfg.RelayExitPort,
		hello.ProxySourceIP != "" && hello.ProxySourcePort > 0,
		hello.ProxySourceIP,
		hello.ProxySourcePort,
		hello.ProxyDestIP,
		hello.ProxyDestPort,
	)
	// Connect to downstream (like entry)
	downCfg := cfg
	downCfg.Key = cfg.RelayKey
	selectionKey := strings.TrimSpace(hello.SelectionKey)
	if selectionKey == "" {
		selectionKey = strings.TrimSpace(hello.ProxySourceIP)
	}
	if selectionKey == "" {
		selectionKey = endpointSelectionSource(upConn.RemoteAddr().String())
	}
	down := newSelectedTransport(selector, downCfg, selectionKey)
	if err := down.connect(); err != nil {
		down.closeTransport()
		log.Printf("relay dial downstream %s:%d: %v", cfg.RelayExitHost, cfg.RelayExitPort, err)
		return err
	}
	defer down.closeTransport()
	// Re-send helloFrame to downstream
	helloBytes, _ := json.Marshal(hello)
	if err := down.start(helloBytes); err != nil {
		return err
	}
	endpoint := down.currentEndpoint()
	fxpVerbosef("relay tcp routed tunnel=%d upstream=%s downstream=%s:%d target=%s:%d", cfg.TunnelID, upConn.RemoteAddr(), endpoint.Host, endpoint.Port, hello.TargetIP, hello.TargetPort)
	// Bidirectional relay: upstream ↔ downstream
	return relayBidir(upSec, down)
}

func relayBidir(up *secureConn, down frameConn) error {
	errCh := make(chan error, 2)
	go func() { errCh <- catchPanic("relay upstream copy", func() error { return relayCopy(up, down) }) }()
	go func() { errCh <- catchPanic("relay downstream copy", func() error { return relayCopy(down, up) }) }()
	return waitBidirectional(errCh, func() {
		_ = up.conn.Close()
		down.closeTransport()
	})
}

func relayCopy(src, dst frameConn) error {
	for {
		frame, err := src.readFrame()
		if err != nil {
			return err
		}
		if len(frame) == 0 {
			return dst.writeFrame(nil)
		}
		if err := dst.writeFrame(frame); err != nil {
			return err
		}
	}
}

func proxyPlainSecure(plain net.Conn, sec frameConn, inLimiter, outLimiter *limiter, counter *trafficCounter) error {
	return proxyPlainSecureWithPolicy(plain, sec, inLimiter, outLimiter, counter, protocolPolicy{}, nil, nil)
}

func proxyPlainSecureWithPolicy(plain net.Conn, sec frameConn, inLimiter, outLimiter *limiter, counter *trafficCounter, policy protocolPolicy, onBlock func(string), initialSample []byte) error {
	var inCounter, outCounter *atomic.Uint64
	if counter != nil {
		inCounter = &counter.in
		outCounter = &counter.out
	}
	return proxyPlainSecureCounted(plain, sec, inLimiter, outLimiter, inCounter, outCounter, policy, onBlock, initialSample)
}

// proxyPlainSecureCounted 在明文连接和加密帧之间双向转发。inCounter 记 plain → 加密
// 的字节，outCounter 记加密 → plain 的；入口的 plain 是客户端，出口的 plain 是目标，
// 方向正好相反，由调用方决定哪个算 in。
func proxyPlainSecureCounted(plain net.Conn, sec frameConn, inLimiter, outLimiter *limiter, inCounter, outCounter *atomic.Uint64, policy protocolPolicy, onBlock func(string), initialSample []byte) error {
	errCh := make(chan error, 2)
	go func() {
		errCh <- catchPanic("plain to secure copy", func() error {
			return copyPlainToSecureWithPolicy(sec, plain, inLimiter, inCounter, policy, onBlock, initialSample)
		})
	}()
	go func() {
		errCh <- catchPanic("secure to plain copy", func() error { return copySecureToPlain(plain, sec, outLimiter, outCounter) })
	}()
	return waitBidirectional(errCh, func() {
		_ = plain.Close()
		sec.closeTransport()
	})
}

func waitBidirectional(errCh <-chan error, closeAll func()) error {
	return waitBidirectionalWithLinger(errCh, closeAll, fxpHalfCloseLinger)
}

func waitBidirectionalWithLinger(errCh <-chan error, closeAll func(), halfCloseLinger time.Duration) error {
	first := <-errCh
	if first == nil {
		second := <-errCh
		if second != nil && !isClosedErr(second) {
			closeAll()
			return second
		}
		return nil
	}
	if !isClosedErr(first) {
		closeAll()
		return first
	}
	timer := time.NewTimer(halfCloseLinger)
	defer timer.Stop()
	select {
	case second := <-errCh:
		if second != nil && !isClosedErr(second) {
			closeAll()
			return second
		}
		return nil
	case <-timer.C:
		closeAll()
		if first != nil && !isClosedErr(first) {
			return first
		}
		return nil
	}
}

var errSecurePeerVanished = errors.New("fxp peer closed without end-of-stream")

func copyPlainToSecure(dst frameConn, src net.Conn, limiter *limiter, counter *atomic.Uint64) error {
	return copyPlainToSecureWithPolicy(dst, src, limiter, counter, protocolPolicy{}, nil, nil)
}

func copyPlainToSecureWithPolicy(dst frameConn, src net.Conn, limiter *limiter, counter *atomic.Uint64, policy protocolPolicy, onBlock func(string), initialSample []byte) error {
	buf := getFXPByteBuffer(fxpCopyChunkSize)
	defer putFXPByteBuffer(buf)
	sample := make([]byte, 0, fxpProtocolSampleMax)
	initialSample = trimLeadingHTTPBlankLines(initialSample)
	if len(initialSample) > 0 {
		n := len(initialSample)
		if n > fxpProtocolSampleMax {
			n = fxpProtocolSampleMax
		}
		sample = append(sample, initialSample[:n]...)
	}
	policyEnabled := policy.BlockHTTP || policy.BlockSocks || policy.BlockTLS
	inspect := func(chunk []byte) (string, bool) {
		if len(sample) == 0 {
			// 请求行前面的空行不占采样额度：HTTP 服务端会跳过它们（RFC 9112
			// 2.2），不跳的话先发几百字节 CRLF 就能把采样撑满、绕过拦截。
			chunk = trimLeadingHTTPBlankLines(chunk)
		}
		if !policyEnabled || len(chunk) == 0 || len(sample) >= fxpProtocolSampleMax {
			return "", false
		}
		remaining := fxpProtocolSampleMax - len(sample)
		if remaining > len(chunk) {
			remaining = len(chunk)
		}
		sample = append(sample, chunk[:remaining]...)
		proto := detectBlockedProtocol(sample, policy)
		return proto, proto != ""
	}
	for {
		n, err := src.Read(buf)
		if n > 0 {
			chunk := buf[:n]
			if proto, blocked := inspect(chunk); blocked {
				if onBlock != nil {
					go onBlock(proto)
				}
				return fmt.Errorf("protocol blocked: %s", proto)
			}
			limiter.wait(n)
			if wErr := dst.writeFrame(chunk); wErr != nil {
				return wErr
			}
			if counter != nil {
				counter.Add(uint64(n))
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return dst.writeFrame(nil)
			}
			return err
		}
	}
}

func copySecureToPlain(dst net.Conn, src frameConn, limiter *limiter, counter *atomic.Uint64) error {
	for {
		frame, err := src.readFrame()
		if err != nil {
			if errors.Is(err, io.EOF) {
				// 正常结束是一个空帧（下面那个分支）。没等到空帧就读到 EOF，是上一跳
				// 直接断了（进程崩溃、连接被掐）：整条会话一起收掉。以前当成正常结束，
				// 另一个方向就一直挂在目标连接上，直到目标自己关。
				return errSecurePeerVanished
			}
			return err
		}
		if len(frame) == 0 {
			closeWriteConn(dst)
			return nil
		}
		limiter.wait(len(frame))
		if _, err := dst.Write(frame); err != nil {
			return err
		}
		if counter != nil {
			counter.Add(uint64(len(frame)))
		}
	}
}

type limiter struct {
	rate   int64
	burst  int64
	mu     sync.Mutex
	tokens float64
	last   time.Time
}

func newLimiter(rate int64) *limiter {
	limiter := &limiter{rate: rate}
	if rate > 0 {
		limiter.burst = rate
		if limiter.burst < 64*1024 {
			limiter.burst = 64 * 1024
		}
		limiter.tokens = float64(limiter.burst)
		limiter.last = time.Now()
	}
	return limiter
}

func (l *limiter) wait(n int) {
	_ = l.waitDone(nil, n)
}

func (l *limiter) waitDone(done <-chan struct{}, n int) bool {
	if l == nil || l.rate <= 0 || n <= 0 {
		return true
	}
	remaining := int64(n)
	for remaining > 0 {
		wanted := remaining
		if wanted > l.burst {
			wanted = l.burst
		}
		for {
			select {
			case <-done:
				return false
			default:
			}
			l.mu.Lock()
			now := time.Now()
			if l.last.IsZero() {
				l.last = now
			}
			if now.After(l.last) {
				l.tokens += now.Sub(l.last).Seconds() * float64(l.rate)
				if l.tokens > float64(l.burst) {
					l.tokens = float64(l.burst)
				}
				l.last = now
			}
			if l.tokens >= float64(wanted) {
				l.tokens -= float64(wanted)
				l.mu.Unlock()
				break
			}
			deficit := float64(wanted) - l.tokens
			waitFor := time.Duration(deficit * float64(time.Second) / float64(l.rate))
			if waitFor <= 0 {
				waitFor = time.Nanosecond
			}
			l.mu.Unlock()
			timer := time.NewTimer(waitFor)
			select {
			case <-timer.C:
			case <-done:
				if !timer.Stop() {
					select {
					case <-timer.C:
					default:
					}
				}
				return false
			}
		}
		remaining -= wanted
	}
	select {
	case <-done:
		return false
	default:
		return true
	}
}

func newAEAD(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func newEntrySecureConn(conn net.Conn, cfg config) (*secureConn, error) {
	sec, err := newClientSecureConn(conn, cfg)
	if err == nil {
		return sec, nil
	}
	_ = conn.Close()
	return nil, err
}

func newExitSecureConn(conn net.Conn, cfg config) (*secureConn, error) {
	return newServerSecureConn(conn, cfg)
}

func newClientSecureConn(conn net.Conn, cfg config) (*secureConn, error) {
	return newClientSecureConnWithWire(conn, cfg, fxpWireCurrent)
}

// newClientSecureConnWithWire 做一次完整握手：发出去，等到确认才返回。
// 连接池预热、后台探测和多路径的腿用它 —— 它们要的是一条确认可用的连接。
func newClientSecureConnWithWire(conn net.Conn, cfg config, wire fxpWireContext) (*secureConn, error) {
	sec, err := newPipelinedClientSecureConn(conn, cfg, wire)
	if err != nil {
		return nil, err
	}
	sec.ackTimeout = fxpHandshakeTimeout
	if err := sec.consumeHandshakeAck(); err != nil {
		return nil, err
	}
	return sec, nil
}

// newPipelinedClientSecureConn 只在本地准备好握手，一个字节都还没发。
// salt 和握手帧挂在 pendingPrefix 上，随第一次写一起出去。
func newPipelinedClientSecureConn(conn net.Conn, cfg config, wire fxpWireContext) (*secureConn, error) {
	if conn == nil {
		return nil, errors.New("fxp connection is nil")
	}
	salt := make([]byte, fxpSaltSize)
	if _, err := rand.Read(salt); err != nil {
		return nil, err
	}
	sec, err := newSessionSecureConnWithWire(conn, cfg.Key, salt, true, wire)
	if err != nil {
		return nil, err
	}
	offered := fxpOfferedAEADs(cfg)
	hs, _ := json.Marshal(fxpHandshake{V: fxpHandshakeVersion, TSMilli: time.Now().UnixMilli(), TunnelID: cfg.TunnelID, AEADs: offered})
	sec.offeredAEADs = offered
	prefix := make([]byte, 0, fxpSaltSize+4+sec.lenWriteAEAD.Overhead()+len(hs)+sec.dataWriteAEAD.Overhead())
	prefix = append(prefix, salt...)
	prefix = sec.appendSealedFrameLocked(prefix, hs)
	sec.pendingPrefix = prefix
	sec.ackPending = true
	sec.ackTunnelID = cfg.TunnelID
	sec.ackTimeout = fxpHandshakeTimeout
	master := sha256.Sum256([]byte(cfg.Key))
	sec.handshakeMaster = master[:]
	sec.handshakeSalt = salt
	sec.handshakeWire = wire
	// 主动拨出去的连接发的是往出口方向的流量：按 linkUpMbps 整形。
	sec.shaper = linkShaperFor("up", cfg)
	sec.shaper.attach(conn)
	return sec, nil
}

// consumeHandshakeAck 读掉并校验对端的握手确认。流水线握手时由第一次
// readFrame 调用；完整握手时在建连阶段直接调用。
func (c *secureConn) consumeHandshakeAck() error {
	c.ackPending = false
	err := c.flushPendingPrefix()
	var ack []byte
	if err == nil {
		timeout := c.ackTimeout
		if timeout <= 0 {
			timeout = fxpHandshakeTimeout
		}
		err = c.conn.SetReadDeadline(time.Now().Add(timeout))
	}
	// 确认 = 服务端 salt（明文）+ 用会话密钥加密的确认帧。先派生会话密钥装到读
	// 方向，确认帧能解开就说明对端确实持有隧道密钥、而且是这次新握的手。
	var final fxpSessionAEADs
	var finalSalt []byte
	if err == nil {
		serverSalt := make([]byte, fxpSaltSize)
		if _, err = io.ReadFull(c.conn, serverSalt); err == nil {
			finalSalt = fxpFinalSessionSalt(c.handshakeSalt, serverSalt)
			final, err = deriveFXPSessionAEADs(c.handshakeMaster, finalSalt, fxpFinalSessionInfo(c.handshakeWire), c.handshakeWire, fxpAEADAESGCM)
		}
	}
	if err == nil {
		c.lenReadAEAD, c.dataReadAEAD = final.s2cLen, final.s2cData
		ack, err = c.readEncryptedFrame()
	}
	if err == nil {
		var reply fxpHandshake
		if jsonErr := json.Unmarshal(ack, &reply); jsonErr != nil || reply.V != fxpHandshakeVersion || reply.TunnelID != c.ackTunnelID {
			err = errors.New("fxp handshake rejected")
		} else if chosen := strings.TrimSpace(reply.AEAD); chosen != "" && chosen != fxpAEADAESGCM {
			// 服务端选了别的算法：必须是我们报过的，确认之后两个方向换成它的密钥。
			if !containsAEAD(c.offeredAEADs, chosen) {
				err = fmt.Errorf("fxp handshake rejected: peer chose aead %q we did not offer", chosen)
			} else {
				final, err = deriveFXPSessionAEADs(c.handshakeMaster, finalSalt, fxpNegotiatedSessionInfo(c.handshakeWire, chosen), c.handshakeWire, chosen)
				if err == nil {
					c.aead = chosen
				}
			}
		}
	}
	if err == nil {
		// 从这里起客户端往服务端写的帧也换成会话密钥（计数接着往下走）。确认之前
		// 已经写出去的那些用的是首轮密钥，服务端两把都认，见 openFrameLength。
		// 服务端确认之后写来的帧也用选定算法的密钥（没换算法时和确认帧同一套）。
		c.lenReadAEAD, c.dataReadAEAD = final.s2cLen, final.s2cData
		c.writeMu.Lock()
		c.lenWriteAEAD, c.dataWriteAEAD = final.c2sLen, final.c2sData
		c.writeMu.Unlock()
	}
	c.handshakeMaster, c.handshakeSalt = nil, nil
	if err == nil {
		if clearErr := c.conn.SetReadDeadline(time.Time{}); clearErr != nil && !isClosedErr(clearErr) {
			err = clearErr
		}
	}
	if c.onAck != nil {
		c.onAck(err)
	}
	if err != nil {
		return &fxpAckError{err: err}
	}
	return nil
}

// flushPendingPrefix 把还没发出去的握手送走。正常路径上它跟第一次写合并，
// 这里只兜底「还没写过就先读」的情况，免得双方互相干等。
func (c *secureConn) flushPendingPrefix() error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if len(c.pendingPrefix) == 0 {
		return nil
	}
	prefix := c.pendingPrefix
	c.pendingPrefix = nil
	if err := c.conn.SetWriteDeadline(time.Now().Add(fxpHandshakeTimeout)); err != nil {
		return err
	}
	_, err := writeFull(c.conn, prefix)
	if clearErr := c.conn.SetWriteDeadline(time.Time{}); err == nil && clearErr != nil && !isClosedErr(clearErr) {
		err = clearErr
	}
	return err
}

func newServerSecureConn(conn net.Conn, cfg config) (*secureConn, error) {
	return newServerSecureConnWithWires(conn, cfg, fxpWireContexts)
}

func newServerSecureConnWithWires(conn net.Conn, cfg config, wires []fxpWireContext) (*secureConn, error) {
	if err := setFXPConnDeadline(conn, fxpServerHandshakeTimeout); err != nil {
		return nil, err
	}
	salt := make([]byte, fxpSaltSize)
	if _, err := io.ReadFull(conn, salt); err != nil {
		return nil, err
	}
	var lenCipher [64]byte
	lenSize := 4 + 16
	if _, err := io.ReadFull(conn, lenCipher[:lenSize]); err != nil {
		return nil, err
	}
	var lastErr error
	for _, wire := range wires {
		sec, err := newSessionSecureConnWithWire(conn, cfg.Key, salt, false, wire)
		if err != nil {
			lastErr = err
			continue
		}
		n, err := sec.decryptFrameLength(0, lenCipher[:lenSize])
		if err != nil {
			lastErr = err
			continue
		}
		dataCipher := getFXPByteBuffer(int(n) + sec.dataReadAEAD.Overhead())
		if _, err := io.ReadFull(conn, dataCipher); err != nil {
			putFXPByteBuffer(dataCipher)
			return nil, err
		}
		ack, err := sec.decryptFrameData(0, dataCipher)
		putFXPByteBuffer(dataCipher)
		if err != nil {
			return nil, err
		}
		hs, err := validateServerHandshake(cfg, ack, time.Now())
		if err != nil {
			return nil, err
		}
		// Do not let unauthenticated connections populate the replay cache.
		// The AEAD-authenticated first frame proves knowledge of the tunnel key;
		// Add remains atomic, so concurrent replays still admit only one request.
		if !fxpReplaySeen.AddStamped(replayKey(cfg, salt), hs.TSMilli) {
			return nil, errors.New("fxp replay detected")
		}
		sec.readCounter = 1
		sec, err = finishServerHandshake(sec, cfg, salt, wire, hs)
		if err != nil {
			return nil, err
		}
		if err := clearFXPConnDeadline(conn); err != nil && !isClosedErr(err) {
			return nil, err
		}
		// 接进来的连接发的是往入口方向的流量：按 linkDownMbps 整形。
		sec.shaper = linkShaperFor("down", cfg)
		sec.shaper.attach(conn)
		return sec, nil
	}
	if lastErr == nil {
		lastErr = errors.New("fxp handshake rejected")
	}
	return nil, lastErr
}

func setFXPConnDeadline(conn net.Conn, timeout time.Duration) error {
	if conn == nil {
		return errors.New("fxp connection is nil")
	}
	if err := conn.SetDeadline(time.Now().Add(timeout)); err != nil {
		return fmt.Errorf("set fxp connection deadline: %w", err)
	}
	return nil
}

func clearFXPConnDeadline(conn net.Conn) error {
	if conn == nil {
		return errors.New("fxp connection is nil")
	}
	if err := conn.SetDeadline(time.Time{}); err != nil {
		return fmt.Errorf("clear fxp connection deadline: %w", err)
	}
	return nil
}

// awaitSecureHello 在已经认证过的连接上等 hello。上一跳的连接池会让连接在这里
// 空等一阵（fxpServerHelloWait），进程要退出时不必等满，直接关掉。
func awaitSecureHello(sec *secureConn, stopping <-chan struct{}) ([]byte, error) {
	if stopping == nil {
		return readSecureHelloWithin(sec, fxpServerHelloWait)
	}
	waiting := make(chan struct{})
	defer close(waiting)
	go func() {
		select {
		case <-stopping:
			_ = sec.conn.Close()
		case <-waiting:
		}
	}()
	return readSecureHelloWithin(sec, fxpServerHelloWait)
}

// quietHelloError：握手已经通过了，hello 之前对端关掉连接是连接池在换新连接，
// 不是出错。
func quietHelloError(err error) error {
	if errors.Is(err, io.EOF) || isClosedErr(err) || errors.Is(err, io.ErrUnexpectedEOF) {
		return nil
	}
	if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
		return nil
	}
	return err
}

func writeSecureHello(sec *secureConn, hello []byte) error {
	if sec == nil {
		return errors.New("fxp secure connection is nil")
	}
	return writeSecureFramesWithDeadline(sec, hello)
}

// writeSecureFramesWithDeadline 把几帧合成一次写，只设写超时 —— 同时可能有
// 读协程在等握手确认，碰读超时会把它的超时清掉。
func writeSecureFramesWithDeadline(sec *secureConn, frames ...[]byte) error {
	if err := sec.conn.SetWriteDeadline(time.Now().Add(fxpHelloTimeout)); err != nil {
		return fmt.Errorf("set fxp write deadline: %w", err)
	}
	if err := sec.writeFrames(frames...); err != nil {
		return err
	}
	if err := sec.conn.SetWriteDeadline(time.Time{}); err != nil && !isClosedErr(err) {
		return err
	}
	return nil
}

func readSecureHello(sec *secureConn) ([]byte, error) {
	return readSecureHelloWithin(sec, fxpHelloTimeout)
}

func readSecureHelloWithin(sec *secureConn, timeout time.Duration) ([]byte, error) {
	if sec == nil {
		return nil, errors.New("fxp secure connection is nil")
	}
	if err := sec.conn.SetReadDeadline(time.Now().Add(timeout)); err != nil {
		return nil, fmt.Errorf("set fxp read deadline: %w", err)
	}
	hello, err := sec.readFrame()
	if err != nil {
		return nil, err
	}
	if err := sec.conn.SetReadDeadline(time.Time{}); err != nil && !isClosedErr(err) {
		return nil, err
	}
	return hello, nil
}

// validateServerHandshake 检查握手帧：版本、隧道、发出时间在 ±fxpHandshakeWindow
// 以内。时间窗配合重放缓存（记 2 倍窗口）才能挡住重放：窗口外的旧握手靠时间
// 戳拒，窗口内的靠缓存拒。以前只记日志不拒，缓存一过期、进程一重启，录下来的
// 握手就又能用了。
func validateServerHandshake(cfg config, frame []byte, now time.Time) (fxpHandshake, error) {
	var hs fxpHandshake
	if err := json.Unmarshal(frame, &hs); err != nil || hs.V != fxpHandshakeVersion || hs.TunnelID != cfg.TunnelID || hs.TSMilli <= 0 {
		return hs, errors.New("fxp handshake rejected")
	}
	skew := time.Duration(now.UnixMilli()-hs.TSMilli) * time.Millisecond
	if skew > fxpHandshakeWindow || skew < -fxpHandshakeWindow {
		log.Printf("fxp handshake rejected tunnel=%d clock skew=%s exceeds %s; check NTP on both nodes", cfg.TunnelID, skew, fxpHandshakeWindow)
		return hs, errors.New("fxp handshake timestamp outside window")
	}
	return hs, nil
}

// finishServerHandshake 生成服务端自己的 salt，和客户端的 salt 一起派生这条
// 连接的会话密钥，把 salt 和确认帧回给客户端。
//
// 为什么要服务端出一份随机数：以前会话密钥只由客户端 salt 决定，录下一条会话
// 原样重放，服务端派生出一模一样的密钥，回给「客户端」的数据又用同样的密钥和
// 计数（nonce）加密一遍 —— AES-GCM 的 nonce 重用，两份密文一异或就漏明文，还能
// 算出认证密钥。现在服务端每次都换新 salt，重放得到的是另一套密钥：回程密文和
// 原会话毫无关系，录下来的、确认之后的客户端帧在新密钥下也解不开。
//
// 流水线握手（客户端不等确认就把 hello 和首包跟在握手后面发出来）因此分两段：
//   - 客户端 → 服务端，见到确认之前写的帧（首轮）：只能用客户端 salt 派生的
//     首轮密钥，服务端这时还没开口；
//   - 服务端 → 客户端的全部帧，以及客户端见到确认之后写的帧：用两边 salt 派生
//     的会话密钥，计数不重置、接着往下走。
//
// 首轮帧能被重放，这是省掉一个往返的代价：挡它靠 validateServerHandshake 的
// 时间窗 + 重放缓存（进程重启后，启动前的握手一律不收）。窗口之内换一台共用
// 隧道密钥的出口去重放首轮，那台出口会照 hello 再拨一次目标、再发一遍首包，
// 但回程用的是它自己新派生的密钥，攻击者什么也读不到，首轮之后录下的数据也
// 放不进去。
func finishServerHandshake(sec *secureConn, cfg config, clientSalt []byte, wire fxpWireContext, hs fxpHandshake) (*secureConn, error) {
	if wire.compat {
		log.Printf("fxp accepted compatibility wire context=%s tunnel=%d", wire.name, cfg.TunnelID)
	}
	serverSalt := make([]byte, fxpSaltSize)
	if _, err := rand.Read(serverSalt); err != nil {
		return nil, err
	}
	master := sha256.Sum256([]byte(cfg.Key))
	finalSalt := fxpFinalSessionSalt(clientSalt, serverSalt)
	final, err := deriveFXPSessionAEADs(master[:], finalSalt, fxpFinalSessionInfo(wire), wire, fxpAEADAESGCM)
	if err != nil {
		return nil, err
	}
	// 客户端报了能用的算法就选一个（aead.go）。确认帧本身仍用 AES-256-GCM 的会话
	// 密钥：客户端读到确认之前不知道选了什么。确认之后两个方向换成选定算法。
	session := final
	chosen := chooseAEAD(cfg, hs.AEADs)
	if chosen != fxpAEADAESGCM {
		if session, err = deriveFXPSessionAEADs(master[:], finalSalt, fxpNegotiatedSessionInfo(wire, chosen), wire, chosen); err != nil {
			return nil, err
		}
		sec.aead = chosen
	}
	sec.earlyLenReadAEAD, sec.earlyDataReadAEAD = sec.lenReadAEAD, sec.dataReadAEAD
	sec.lenReadAEAD, sec.dataReadAEAD = session.c2sLen, session.c2sData
	sec.lenWriteAEAD, sec.dataWriteAEAD = final.s2cLen, final.s2cData
	reply := fxpHandshake{V: fxpHandshakeVersion, TSMilli: time.Now().UnixMilli(), TunnelID: cfg.TunnelID}
	if chosen != fxpAEADAESGCM {
		reply.AEAD = chosen
	}
	replyFrame, _ := json.Marshal(reply)
	// 服务端 salt 挂在 pendingPrefix 上，和确认帧一次写出。
	sec.pendingPrefix = serverSalt
	if err := sec.writeFrame(replyFrame); err != nil {
		return nil, err
	}
	// 确认已经按 AES-256-GCM 写出去了，之后的帧换成选定算法（计数接着往下走）。
	sec.writeMu.Lock()
	sec.lenWriteAEAD, sec.dataWriteAEAD = session.s2cLen, session.s2cData
	sec.writeMu.Unlock()
	noteNegotiatedAEAD(cfg.Role, cfg, chosen)
	return sec, nil
}

func newSessionSecureConn(conn net.Conn, key string, salt []byte, client bool) (*secureConn, error) {
	return newSessionSecureConnWithWire(conn, key, salt, client, fxpWireCurrent)
}

// fxpSessionAEADs 是两个方向各一套的帧长度 / 帧内容密钥。
type fxpSessionAEADs struct {
	c2sLen, c2sData, s2cLen, s2cData cipher.AEAD
}

// deriveFXPSessionAEADs 从主密钥、salt 和派生上下文得到两个方向各一套的帧密钥。
// aead 是这套密钥用的算法（空 = AES-256-GCM）；不同算法用不同的 info，密钥材料
// 本身也就不同。
func deriveFXPSessionAEADs(master, salt, info []byte, wire fxpWireContext, aead string) (fxpSessionAEADs, error) {
	material := blake3Derive(master, salt, info, wire.masterContext, 128)
	var out fxpSessionAEADs
	var err error
	for index, dst := range []*cipher.AEAD{&out.c2sLen, &out.c2sData, &out.s2cLen, &out.s2cData} {
		if *dst, err = newAEADNamed(aead, material[index*32:(index+1)*32]); err != nil {
			return fxpSessionAEADs{}, err
		}
	}
	return out, nil
}

// fxpFinalSessionSalt 把两边的 salt 接起来，作为会话密钥的 salt。
func fxpFinalSessionSalt(clientSalt, serverSalt []byte) []byte {
	out := make([]byte, 0, len(clientSalt)+len(serverSalt))
	out = append(out, clientSalt...)
	return append(out, serverSalt...)
}

// fxpFinalSessionInfo 给会话密钥一个和首轮密钥不同的派生上下文，两者从结构上
// 就分开。
func fxpFinalSessionInfo(wire fxpWireContext) []byte {
	const suffix = " +server-salt"
	info := make([]byte, 0, len(wire.sessionInfo)+len(suffix))
	info = append(info, wire.sessionInfo...)
	return append(info, suffix...)
}

func newSessionSecureConnWithWire(conn net.Conn, key string, salt []byte, client bool, wire fxpWireContext) (*secureConn, error) {
	master := sha256.Sum256([]byte(key))
	keys, err := deriveFXPSessionAEADs(master[:], salt, wire.sessionInfo, wire, fxpAEADAESGCM)
	if err != nil {
		return nil, err
	}
	sec := &secureConn{conn: conn, lengthAD: wire.lengthAD, payloadAD: wire.payloadAD}
	if client {
		sec.lenWriteAEAD, sec.dataWriteAEAD = keys.c2sLen, keys.c2sData
		sec.lenReadAEAD, sec.dataReadAEAD = keys.s2cLen, keys.s2cData
		sec.writeDir, sec.readDir = fxpEntryToExit, fxpExitToEntry
	} else {
		sec.lenWriteAEAD, sec.dataWriteAEAD = keys.s2cLen, keys.s2cData
		sec.lenReadAEAD, sec.dataReadAEAD = keys.c2sLen, keys.c2sData
		sec.writeDir, sec.readDir = fxpExitToEntry, fxpEntryToExit
	}
	return sec, nil
}

func blake3Derive(secret, salt, context []byte, masterContext string, length int) []byte {
	material := make([]byte, 0, len(secret)+len(salt))
	material = append(material, secret...)
	material = append(material, salt...)
	keyMaterial := make([]byte, 32)
	blake3.DeriveKey(keyMaterial, masterContext, context)
	deriver := blake3.New(length, keyMaterial)
	_, _ = deriver.Write(material)
	out := make([]byte, length)
	reader := deriver.XOF()
	_, _ = io.ReadFull(reader, out)
	return out
}

func (c *secureConn) writeFrame(plain []byte) error {
	return c.writeEncryptedFrame(plain)
}

func (c *secureConn) readFrame() ([]byte, error) {
	if c.ackPending {
		if err := c.consumeHandshakeAck(); err != nil {
			return nil, err
		}
	}
	return c.readEncryptedFrame()
}

func (c *secureConn) writeEncryptedFrame(plain []byte) error {
	return c.writeFrames(plain)
}

// writeFrames 把几帧（连同还没发出去的握手）封进一个缓冲区，一次系统调用写出。
func (c *secureConn) writeFrames(frames ...[]byte) error {
	if c == nil {
		return errors.New("nil secure connection")
	}
	if c.shaper != nil {
		total := 0
		for _, plain := range frames {
			total += len(plain)
		}
		c.shaper.wait(total)
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	wireSize := len(c.pendingPrefix)
	for _, plain := range frames {
		if len(plain) > fxpMaxFrame {
			return errors.New("frame too large")
		}
		wireSize += 4 + c.lenWriteAEAD.Overhead() + len(plain) + c.dataWriteAEAD.Overhead()
	}
	wire := getFXPByteBuffer(wireSize)
	defer putFXPByteBuffer(wire)
	wire = append(wire[:0], c.pendingPrefix...)
	startCounter := c.writeCounter
	for _, plain := range frames {
		wire = c.appendSealedFrameLocked(wire, plain)
	}
	written, err := writeFull(c.conn, wire)
	if err == nil && written != len(wire) {
		err = io.ErrShortWrite
	}
	if err != nil {
		// 帧没完整写出去，这条连接的计数已经和对端对不上了，只能作废。
		c.writeCounter = startCounter
		return err
	}
	c.pendingPrefix = nil
	return nil
}

// appendSealedFrameLocked 把一帧加密追加到 dst，并推进写计数。调用方持有 writeMu
// （或者连接还没交给任何其他协程）。
func (c *secureConn) appendSealedFrameLocked(dst []byte, plain []byte) []byte {
	counter := c.writeCounter
	var lenPlain [4]byte
	binary.BigEndian.PutUint32(lenPlain[:], uint32(len(plain)))
	var lenNonce [12]byte
	var dataNonce [12]byte
	fillFXPNonce(lenNonce[:], c.writeDir, counter, 0)
	fillFXPNonce(dataNonce[:], c.writeDir, counter, 1)
	dst = c.lenWriteAEAD.Seal(dst, lenNonce[:], lenPlain[:], c.lengthAD)
	dst = c.dataWriteAEAD.Seal(dst, dataNonce[:], plain, c.payloadAD)
	c.writeCounter++
	return dst
}

func (c *secureConn) readEncryptedFrame() ([]byte, error) {
	c.releaseReadBuffer()
	counter := c.readCounter
	c.readCounter++
	var lenCipher [64]byte
	lenSize := 4 + c.lenReadAEAD.Overhead()
	if lenSize > len(lenCipher) {
		return nil, errors.New("invalid encrypted frame length")
	}
	if _, err := io.ReadFull(c.conn, lenCipher[:lenSize]); err != nil {
		return nil, err
	}
	n, dataAEAD, err := c.openFrameLength(counter, lenCipher[:lenSize])
	if err != nil {
		return nil, err
	}
	dataCipher := getFXPByteBuffer(int(n) + dataAEAD.Overhead())
	if _, err := io.ReadFull(c.conn, dataCipher); err != nil {
		putFXPByteBuffer(dataCipher)
		return nil, err
	}
	var nonce [12]byte
	fillFXPNonce(nonce[:], c.readDir, counter, 1)
	// 就地解密：明文直接覆盖在密文缓冲上，不再每帧新分配一块。这块缓冲留到下一次
	// readFrame 才还回池里（见 releaseReadBuffer），所以调用方拿到的切片只在下一次
	// 读之前有效 —— 现有调用方都是读完立刻写出或自行拷贝。
	plain, err := dataAEAD.Open(dataCipher[:0], nonce[:], dataCipher, c.payloadAD)
	if err != nil {
		putFXPByteBuffer(dataCipher)
		return nil, err
	}
	c.readBuf = dataCipher
	return plain, nil
}

// releaseReadBuffer 把上一帧占着的缓冲还回池里。在阻塞等下一帧之前调用，
// 空闲连接因此不占缓冲。
func (c *secureConn) releaseReadBuffer() {
	if c.readBuf != nil {
		putFXPByteBuffer(c.readBuf)
		c.readBuf = nil
	}
}

// openFrameLength 解开帧长度，并告诉调用方这一帧的内容该用哪把密钥。服务端在
// 客户端切到会话密钥之前两把都认：会话密钥解得开，说明客户端已经切过去了，
// 首轮密钥从此作废；只有首轮密钥解得开的，是客户端见到确认之前写的帧。
func (c *secureConn) openFrameLength(counter uint64, lenCipher []byte) (uint32, cipher.AEAD, error) {
	n, err := c.decryptFrameLength(counter, lenCipher)
	if err == nil {
		c.earlyLenReadAEAD, c.earlyDataReadAEAD = nil, nil
		return n, c.dataReadAEAD, nil
	}
	if c.earlyLenReadAEAD == nil {
		return 0, nil, err
	}
	n, earlyErr := decryptFXPFrameLength(c.earlyLenReadAEAD, c.readDir, counter, lenCipher, c.lengthAD)
	if earlyErr != nil {
		return 0, nil, err
	}
	return n, c.earlyDataReadAEAD, nil
}

func (c *secureConn) decryptFrameLength(counter uint64, lenCipher []byte) (uint32, error) {
	return decryptFXPFrameLength(c.lenReadAEAD, c.readDir, counter, lenCipher, c.lengthAD)
}

func decryptFXPFrameLength(aead cipher.AEAD, direction uint32, counter uint64, lenCipher, lengthAD []byte) (uint32, error) {
	var nonce [12]byte
	var plain [4]byte
	fillFXPNonce(nonce[:], direction, counter, 0)
	lenPlain, err := aead.Open(plain[:0], nonce[:], lenCipher, lengthAD)
	if err != nil {
		return 0, err
	}
	if len(lenPlain) != 4 {
		return 0, errors.New("invalid frame length")
	}
	n := binary.BigEndian.Uint32(lenPlain)
	if n > fxpMaxFrame {
		return 0, fmt.Errorf("invalid frame size %d", n)
	}
	return n, nil
}

func (c *secureConn) decryptFrameData(counter uint64, dataCipher []byte) ([]byte, error) {
	var nonce [12]byte
	fillFXPNonce(nonce[:], c.readDir, counter, 1)
	return c.dataReadAEAD.Open(nil, nonce[:], dataCipher, c.payloadAD)
}

func fxpNonce(direction uint32, counter uint64, kind byte) []byte {
	nonce := make([]byte, 12)
	fillFXPNonce(nonce, direction, counter, kind)
	return nonce
}

func fillFXPNonce(nonce []byte, direction uint32, counter uint64, kind byte) {
	if len(nonce) < 12 {
		return
	}
	binary.BigEndian.PutUint32(nonce[0:4], direction)
	binary.BigEndian.PutUint64(nonce[4:12], counter)
	nonce[3] ^= kind
}

func replayKey(cfg config, salt []byte) string {
	scope := fmt.Sprintf("%d:%d:%d:", cfg.TunnelID, cfg.RuleID, cfg.ListenPort)
	return scope + hex.EncodeToString(salt)
}

func newReplayCache(ttl time.Duration, max int) *replayCache {
	return &replayCache{ttl: ttl, max: max, seen: make(map[string]time.Time)}
}

// newStampedReplayCache 建一个带时间戳下限的缓存，floor 以下（含）的时间戳一律拒收。
func newStampedReplayCache(ttl time.Duration, max int, floor int64) *replayCache {
	cache := newReplayCache(ttl, max)
	cache.floor = floor
	return cache
}

func (c *replayCache) Add(key string) bool {
	return c.addAt(key, time.Now())
}

func (c *replayCache) addAt(key string, now time.Time) bool {
	return c.addStampedAt(key, 0, now, false)
}

// AddStamped 记下一条带发出时间戳的记录；时间戳落在下限以下或者记录已经在，
// 都返回 false。
func (c *replayCache) AddStamped(key string, stamp int64) bool {
	return c.addStampedAt(key, stamp, time.Now(), true)
}

func (c *replayCache) addStampedAt(key string, stamp int64, now time.Time, stamped bool) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.sweepLocked(now)
	if stamped && stamp <= c.floor {
		return false
	}
	if expiresAt, ok := c.seen[key]; ok && expiresAt.After(now) {
		return false
	}
	expiresAt := now.Add(c.ttl)
	c.seen[key] = expiresAt
	heap.Push(&c.expiry, replayExpiry{key: key, expiresAt: expiresAt, stamp: stamp})
	for len(c.seen) > c.max {
		if !c.evictOldestLocked() {
			break
		}
	}
	return true
}

func (c *replayCache) sweepLocked(now time.Time) {
	for len(c.expiry) > 0 && !c.expiry[0].expiresAt.After(now) {
		entry := heap.Pop(&c.expiry).(replayExpiry)
		if expiresAt, ok := c.seen[entry.key]; ok && expiresAt.Equal(entry.expiresAt) {
			delete(c.seen, entry.key)
		}
	}
}

func (c *replayCache) evictOldestLocked() bool {
	for len(c.expiry) > 0 {
		entry := heap.Pop(&c.expiry).(replayExpiry)
		if expiresAt, ok := c.seen[entry.key]; ok && expiresAt.Equal(entry.expiresAt) {
			delete(c.seen, entry.key)
			if entry.stamp > c.floor {
				c.floor = entry.stamp
			}
			return true
		}
	}
	return false
}

func probeDelay() {
	var b [1]byte
	_, _ = rand.Read(b[:])
	time.Sleep(time.Duration(150+int(b[0])%350) * time.Millisecond)
}

func remoteIP(addr net.Addr) string {
	if addr == nil {
		return ""
	}
	host, _, err := net.SplitHostPort(addr.String())
	if err != nil {
		return addr.String()
	}
	return host
}

func detectBlockedProtocol(data []byte, policy protocolPolicy) string {
	if policy.BlockHTTP && detectHTTPProtocol(data) {
		return "http"
	}
	if policy.BlockTLS && detectTLSProtocol(data) {
		return "tls"
	}
	if policy.BlockSocks && detectSocksProtocol(data) {
		return "socks"
	}
	return ""
}

// trimLeadingHTTPBlankLines 去掉开头的 CR/LF。只用于协议识别的采样，转发的
// 数据原样不动。TLS、SOCKS 的首字节不会是 CR/LF，去掉不影响它们的识别。
func trimLeadingHTTPBlankLines(data []byte) []byte {
	return bytes.TrimLeft(data, "\r\n")
}

func detectHTTPProtocol(data []byte) bool {
	// 服务端会跳过请求行之前的空行，这里也跳过，免得前面垫一个 CRLF 就绕过拦截。
	data = trimLeadingHTTPBlankLines(data)
	if bytes.HasPrefix(data, []byte("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n")) {
		return true
	}
	limit := minInt(len(data), 256)
	if limit < len("GET / HTTP/1.0\r\n") {
		return false
	}
	lineEnd := bytes.Index(data[:limit], []byte("\r\n"))
	if lineEnd < 0 {
		return false
	}
	// 连续多个空格按一个算：nginx 之类的服务端容忍请求行里的多余空格。
	parts := bytes.FieldsFunc(data[:lineEnd], func(r rune) bool { return r == ' ' })
	if len(parts) != 3 {
		return false
	}
	// 方法不分大小写：有的服务端和代理照收小写方法，大小写一换就绕过去了。
	method := strings.ToUpper(string(parts[0]))
	switch method {
	case "GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS", "PATCH", "CONNECT", "TRACE":
	default:
		return false
	}
	version := string(parts[2])
	if version != "HTTP/1.0" && version != "HTTP/1.1" {
		return false
	}
	return validHTTPRequestTarget(method, parts[1])
}

func validHTTPRequestTarget(method string, target []byte) bool {
	if len(target) == 0 {
		return false
	}
	for _, value := range target {
		if value < 0x21 || value > 0x7e {
			return false
		}
	}
	if method == "CONNECT" {
		return bytes.Contains(target, []byte{':'})
	}
	if bytes.Equal(target, []byte("*")) {
		return method == "OPTIONS"
	}
	if target[0] == '/' {
		return true
	}
	lower := bytes.ToLower(target)
	return bytes.HasPrefix(lower, []byte("http://")) || bytes.HasPrefix(lower, []byte("https://"))
}

func detectTLSProtocol(data []byte) bool {
	return len(data) >= 5 && data[0] == 0x16 && data[1] == 0x03 && data[2] >= 0x01 && data[2] <= 0x04
}

func detectSocksProtocol(data []byte) bool {
	if len(data) < 2 {
		return false
	}
	if data[0] == 0x04 {
		return len(data) >= 7 && (data[1] == 0x01 || data[1] == 0x02)
	}
	if data[0] != 0x05 {
		return false
	}
	nMethods := int(data[1])
	if nMethods <= 0 || len(data) < 2+nMethods {
		return false
	}
	for _, method := range data[2 : 2+nMethods] {
		if method == 0x00 || method == 0x02 {
			return true
		}
	}
	return false
}

func reportProtocolBlock(cfg config, proto string) {
	if cfg.PanelURL == "" || cfg.Token == "" || cfg.RuleID <= 0 {
		log.Printf("protocol blocked rule=%d tunnel=%d protocol=%s", cfg.RuleID, cfg.TunnelID, proto)
		return
	}
	payload := map[string]any{
		"ruleId":     cfg.RuleID,
		"tunnelId":   cfg.TunnelID,
		"sourcePort": cfg.ListenPort,
		"protocol":   proto,
	}
	env, err := encryptEnvelope(payload, cfg.Token)
	if err != nil {
		log.Printf("protocol block encrypt failed: %v", err)
		return
	}
	body, _ := json.Marshal(env)
	resp, err := postFXPEncryptedPanelRequest(
		trafficHTTPClient,
		cfg.PanelURL,
		cfg.Token,
		"/api/agent/protocol-block",
		body,
	)
	if err != nil {
		log.Printf("protocol block report failed: %v", err)
		return
	}
	log.Printf("protocol block reported rule=%d tunnel=%d protocol=%s status=%s", cfg.RuleID, cfg.TunnelID, proto, resp.Status)
}

func encryptEnvelope(payload any, token string) (envelope, error) {
	return encryptEnvelopeAt(payload, token, time.Now().UnixMilli())
}

func encryptEnvelopeAt(payload any, token string, timestamp int64) (envelope, error) {
	plain, _ := json.Marshal(payload)
	keyEnc := sha256.Sum256([]byte(token + "|forwardx-agent-v1"))
	keyMac := sha256.Sum256([]byte(token + "|forwardx-agent-mac"))
	iv := make([]byte, aes.BlockSize)
	if _, err := rand.Read(iv); err != nil {
		return envelope{}, err
	}
	block, err := aes.NewCipher(keyEnc[:])
	if err != nil {
		return envelope{}, err
	}
	ct := make([]byte, len(plain))
	cipher.NewCTR(block, iv).XORKeyStream(ct, plain)
	mac := calcMAC(keyMac[:], iv, ct, timestamp)
	return envelope{
		V: 1, IV: hex.EncodeToString(iv), CT: hex.EncodeToString(ct),
		MAC: hex.EncodeToString(mac), TS: timestamp,
	}, nil
}

func calcMAC(key, iv, ct []byte, ts int64) []byte {
	buf := bytes.NewBufferString("v1")
	buf.Write(iv)
	buf.Write(ct)
	tsb := make([]byte, 8)
	binary.BigEndian.PutUint64(tsb, uint64(ts))
	buf.Write(tsb)
	m := hmac.New(sha256.New, key)
	m.Write(buf.Bytes())
	return m.Sum(nil)
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func writeFull(w io.Writer, b []byte) (int, error) {
	written := 0
	for written < len(b) {
		n, err := w.Write(b[written:])
		written += n
		if err != nil {
			return written, err
		}
		if n == 0 {
			return written, io.ErrShortWrite
		}
	}
	return written, nil
}

func isClosedErr(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrClosedPipe) || errors.Is(err, net.ErrClosed) {
		return true
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "use of closed network connection") ||
		strings.Contains(msg, "connection reset by peer") ||
		strings.Contains(msg, "broken pipe")
}
