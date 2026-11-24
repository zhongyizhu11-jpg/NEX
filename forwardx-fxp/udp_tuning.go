package main

import (
	"log"
	"net"
	"net/netip"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	// Keep one listener from reserving several megabytes on every FXP process.
	// The queue budget above the socket still absorbs short bursts, while the
	// kernel can drop stale UDP packets instead of growing process RSS.
	fxpUDPListenBufferBytes = 2 * 1024 * 1024
	// A connected target socket is created for every UDP session. 128 KiB is
	// enough for normal game bursts and halves the kernel accounting compared
	// with the previous 256 KiB setting (Linux may account SO_*BUF at 2x).
	fxpUDPSessionBufferBytes = 128 * 1024
	fxpUDPDirectQueueSize    = 64
	fxpUDPStreamQueueSize    = 64
	fxpUDPQueueMaxBytes      = 512 * 1024
	fxpUDPSoftSessions       = 512
	fxpUDPMaxSessions        = 1024
	fxpUDPSoftSessionsPerIP  = 48
	fxpUDPMaxSessionsPerIP   = 64
	fxpUDPReclaimAfter       = 30 * time.Second
	fxpUDPMaxQueueDelay      = 75 * time.Millisecond
	fxpUDPDropLogInterval    = 5 * time.Second
)

type fxpUDPQueuedPacket struct {
	payload  []byte
	queuedAt time.Time
	// pooled：payload 是从 fxpBytePools 借的，队列拥有它。丢包（挤掉、清空、
	// 关闭）时由队列还回去；出队之后归取包的协程，用完调 done() 时还回去。
	// 一个借来的缓冲同一时刻只有一个主人，所以不会被还两次、也不会还了还在用。
	pooled        bool
	leaseBudget   *fxpUDPQueueRuleBudget
	leaseInFlight *atomic.Int64
	leaseBytes    int
	leaseDone     bool
}

func (packet *fxpUDPQueuedPacket) done() {
	if packet == nil || packet.leaseDone {
		return
	}
	packet.leaseDone = true
	if packet.leaseBudget != nil {
		packet.leaseBudget.release(packet.leaseBytes)
	}
	if packet.leaseInFlight != nil {
		packet.leaseInFlight.Add(-1)
	}
	packet.recycle()
}

// recycle 把借来的 payload 还回池里。只能由这个包当前的主人调用一次。
func (packet *fxpUDPQueuedPacket) recycle() {
	if packet.pooled {
		putFXPByteBuffer(packet.payload)
		packet.pooled = false
		packet.payload = nil
	}
}

type fxpUDPQueue struct {
	mu          sync.Mutex
	packets     []fxpUDPQueuedPacket
	head        int
	size        int
	queuedBytes int
	maxBytes    int
	budget      *fxpUDPQueueRuleBudget
	closed      bool
	ready       chan struct{}
}

func newFXPUDPQueue(maxPackets, maxBytes int) *fxpUDPQueue {
	return newFXPUDPQueueWithBudget(maxPackets, maxBytes, nil)
}

func newFXPUDPQueueWithBudget(maxPackets, maxBytes int, budget *fxpUDPQueueRuleBudget) *fxpUDPQueue {
	if maxPackets <= 0 {
		maxPackets = 1
	}
	if maxBytes <= 0 {
		maxBytes = 1
	}
	return &fxpUDPQueue{
		packets:  make([]fxpUDPQueuedPacket, maxPackets),
		maxBytes: maxBytes,
		budget:   budget,
		ready:    make(chan struct{}, 1),
	}
}

func (q *fxpUDPQueue) enqueue(payload []byte) bool {
	return q.enqueueOwned(payload, false)
}

// enqueueOwned 和 enqueue 一样，pooled 为 true 时 payload 是从池里借的，所有权
// 一并交给队列：不论收没收下，调用方之后都不能再碰它。
func (q *fxpUDPQueue) enqueueOwned(payload []byte, pooled bool) bool {
	packet := fxpUDPQueuedPacket{payload: payload, queuedAt: time.Now(), pooled: pooled}
	if q == nil {
		packet.recycle()
		return true
	}
	packetBytes := len(payload)
	q.mu.Lock()
	defer q.mu.Unlock()
	admitted, droppedOlder := q.admitLocked(packet, packetBytes)
	if !admitted {
		packet.recycle()
		return true
	}
	return droppedOlder
}

// admitLocked 收下一个包，必要时先挤掉最老的几个（droppedOlder）。收不下返回
// admitted=false，包原样留给调用方处理。
func (q *fxpUDPQueue) admitLocked(packet fxpUDPQueuedPacket, packetBytes int) (admitted, droppedOlder bool) {
	if q.closed {
		return false, false
	}
	if packetBytes > q.maxBytes {
		return false, false
	}
	dropCount := 0
	releaseBytes := 0
	remainingPackets := q.size
	remainingBytes := q.queuedBytes
	for remainingPackets > 0 && (remainingPackets >= len(q.packets) || remainingBytes+packetBytes > q.maxBytes) {
		index := (q.head + dropCount) % len(q.packets)
		bytes := len(q.packets[index].payload)
		dropCount++
		releaseBytes += bytes
		remainingPackets--
		remainingBytes -= bytes
	}
	if remainingPackets >= len(q.packets) || remainingBytes+packetBytes > q.maxBytes {
		return false, false
	}
	if q.budget != nil && !q.budget.replace(releaseBytes, packetBytes) {
		return false, false
	}
	for i := 0; i < dropCount; i++ {
		q.dropOldestLocked(false)
	}
	index := (q.head + q.size) % len(q.packets)
	q.packets[index] = packet
	q.size++
	q.queuedBytes += packetBytes
	q.signalLocked()
	return true, dropCount > 0
}

func (q *fxpUDPQueue) next(done <-chan struct{}) (fxpUDPQueuedPacket, bool) {
	return q.nextTracked(done, nil)
}

func (q *fxpUDPQueue) nextTracked(done <-chan struct{}, inFlight *atomic.Int64) (fxpUDPQueuedPacket, bool) {
	if q == nil {
		return fxpUDPQueuedPacket{}, false
	}
	for {
		select {
		case <-done:
			return fxpUDPQueuedPacket{}, false
		default:
		}
		select {
		case <-done:
			return fxpUDPQueuedPacket{}, false
		case <-q.ready:
		}
		q.mu.Lock()
		if q.size == 0 {
			q.mu.Unlock()
			continue
		}
		packet := q.popOldestLocked(false)
		packet.leaseBudget = q.budget
		packet.leaseInFlight = inFlight
		packet.leaseBytes = len(packet.payload)
		if inFlight != nil {
			inFlight.Add(1)
		}
		q.signalLocked()
		q.mu.Unlock()
		return packet, true
	}
}

// nextBatchTracked 和 nextTracked 一样等第一个包，然后把队列里已经在的包一并取走，最多 max 个，
// 追加在 out 后面。发送协程醒一次就把攒下的都发掉（见 udp_batch_linux.go）。
func (q *fxpUDPQueue) nextBatchTracked(done <-chan struct{}, inFlight *atomic.Int64, out []fxpUDPQueuedPacket, max int) ([]fxpUDPQueuedPacket, bool) {
	first, ok := q.nextTracked(done, inFlight)
	if !ok {
		return out, false
	}
	out = append(out, first)
	if max <= 1 {
		return out, true
	}
	q.mu.Lock()
	for len(out) < max && q.size > 0 {
		packet := q.popOldestLocked(false)
		packet.leaseBudget = q.budget
		packet.leaseInFlight = inFlight
		packet.leaseBytes = len(packet.payload)
		if inFlight != nil {
			inFlight.Add(1)
		}
		out = append(out, packet)
	}
	q.mu.Unlock()
	return out, true
}

// fxpUDPQueuedDone 把一批包都交还（还缓冲、还额度）。
func fxpUDPQueuedDone(batch []fxpUDPQueuedPacket) {
	for i := range batch {
		batch[i].done()
	}
}

func (q *fxpUDPQueue) pending() int {
	if q == nil {
		return 0
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.size
}

func (q *fxpUDPQueue) bytes() int {
	if q == nil {
		return 0
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.queuedBytes
}

func (q *fxpUDPQueue) clear() {
	if q == nil {
		return
	}
	q.mu.Lock()
	for q.size > 0 {
		q.dropOldestLocked(true)
	}
	select {
	case <-q.ready:
	default:
	}
	q.mu.Unlock()
}

func (q *fxpUDPQueue) close() {
	if q == nil {
		return
	}
	q.mu.Lock()
	q.closed = true
	for q.size > 0 {
		q.dropOldestLocked(true)
	}
	select {
	case <-q.ready:
	default:
	}
	q.mu.Unlock()
}

func (q *fxpUDPQueue) popOldestLocked(releaseBudget bool) fxpUDPQueuedPacket {
	packet := q.packets[q.head]
	q.packets[q.head] = fxpUDPQueuedPacket{}
	q.head = (q.head + 1) % len(q.packets)
	q.size--
	q.queuedBytes -= len(packet.payload)
	if q.queuedBytes < 0 {
		q.queuedBytes = 0
	}
	if releaseBudget && q.budget != nil {
		q.budget.release(len(packet.payload))
	}
	return packet
}

// dropOldestLocked 扔掉最老的一个包：队列是它的主人，借来的缓冲由队列还回去。
func (q *fxpUDPQueue) dropOldestLocked(releaseBudget bool) {
	packet := q.popOldestLocked(releaseBudget)
	packet.recycle()
}

func (q *fxpUDPQueue) signalLocked() {
	if q.size == 0 {
		return
	}
	select {
	case q.ready <- struct{}{}:
	default:
	}
}

type fxpUDPSessionPolicy struct {
	softSessions int
	hardSessions int
	softPerIP    int
	hardPerIP    int
	reclaimAfter time.Duration
}

/*
UDP 会话上限可以用环境变量改（写进 Agent 的 systemd 单元，FXP 是它的子进程）：

	FORWARDX_FXP_UDP_MAX_SESSIONS          一个监听进程同时保留的 UDP 会话总数硬上限（默认 1024）
	FORWARDX_FXP_UDP_SOFT_SESSIONS         总数软上限，到了就开始回收闲置最久的会话（默认 512；只给硬上限时取其 3/4）
	FORWARDX_FXP_UDP_MAX_SESSIONS_PER_IP   同一来源 IP 的硬上限（默认 64）
	FORWARDX_FXP_UDP_SOFT_SESSIONS_PER_IP  同一来源 IP 的软上限（默认 48；只给硬上限时取其 3/4）

0 表示不限；软上限超过硬上限时按硬上限算；写错的值当没写。NAT 后面几十上百个玩家共用一个出口 IP、
或者单台机器要承载更多游戏会话的场景，调大每 IP 上限；总数上限要和内存一起看（每个会话一个 128 KiB
缓冲的已连接套接字）。进程起来时把生效值打一行日志，方便核对。
*/
const (
	fxpUDPMaxSessionsEnv       = "FORWARDX_FXP_UDP_MAX_SESSIONS"
	fxpUDPSoftSessionsEnv      = "FORWARDX_FXP_UDP_SOFT_SESSIONS"
	fxpUDPMaxSessionsPerIPEnv  = "FORWARDX_FXP_UDP_MAX_SESSIONS_PER_IP"
	fxpUDPSoftSessionsPerIPEnv = "FORWARDX_FXP_UDP_SOFT_SESSIONS_PER_IP"
)

var fxpUDPSessionPolicyFromEnv = udpSessionPolicyFromEnv(os.Getenv)

func defaultFXPUDPSessionPolicy() fxpUDPSessionPolicy {
	return fxpUDPSessionPolicyFromEnv
}

func builtinFXPUDPSessionPolicy() fxpUDPSessionPolicy {
	return fxpUDPSessionPolicy{
		softSessions: fxpUDPSoftSessions,
		hardSessions: fxpUDPMaxSessions,
		softPerIP:    fxpUDPSoftSessionsPerIP,
		hardPerIP:    fxpUDPMaxSessionsPerIP,
		reclaimAfter: fxpUDPReclaimAfter,
	}
}

// udpSessionPolicyFromEnv 按上面的环境变量算出会话上限；getenv 可替换，测试不用动真环境。
func udpSessionPolicyFromEnv(getenv func(string) string) fxpUDPSessionPolicy {
	policy := builtinFXPUDPSessionPolicy()
	parse := func(name string) (int, bool) {
		raw := strings.TrimSpace(getenv(name))
		if raw == "" {
			return 0, false
		}
		value, err := strconv.Atoi(raw)
		if err != nil || value < 0 {
			log.Printf("udp session policy: %s=%q 不是非负整数，按默认值", name, raw)
			return 0, false
		}
		return value, true
	}
	applyPair := func(hardName, softName string, hard, soft *int) {
		hardValue, hardSet := parse(hardName)
		softValue, softSet := parse(softName)
		if hardSet {
			*hard = hardValue
			if !softSet {
				*soft = hardValue * 3 / 4
			}
		}
		if softSet {
			*soft = softValue
		}
		if *hard > 0 && (*soft == 0 || *soft > *hard) {
			*soft = *hard
		}
	}
	applyPair(fxpUDPMaxSessionsEnv, fxpUDPSoftSessionsEnv, &policy.hardSessions, &policy.softSessions)
	applyPair(fxpUDPMaxSessionsPerIPEnv, fxpUDPSoftSessionsPerIPEnv, &policy.hardPerIP, &policy.softPerIP)
	if policy != builtinFXPUDPSessionPolicy() {
		log.Printf("udp session policy: total soft/hard=%d/%d per-ip soft/hard=%d/%d (0 = unlimited)", policy.softSessions, policy.hardSessions, policy.softPerIP, policy.hardPerIP)
	}
	return policy
}

type fxpUDPSessionSnapshot struct {
	sourceIP     string
	lastActivity int64
	pending      int
}

type fxpUDPAdmissionReason string

const (
	fxpUDPAdmissionBelowLimit         fxpUDPAdmissionReason = "below-limit"
	fxpUDPAdmissionRejectActivePerIP  fxpUDPAdmissionReason = "reject-active-per-ip"
	fxpUDPAdmissionRejectActiveGlobal fxpUDPAdmissionReason = "reject-active-global"
)

type fxpUDPAdmission struct {
	allow  bool
	reason fxpUDPAdmissionReason
	total  int
	perIP  int
}

type fxpUDPReclamation[K comparable, T any] struct {
	key     K
	session *T
}

// compareFXPUDPSessionKeys 给容量回收排序打破平局：会话表的键现在有字符串（测试、
// 旧路径）、netip.AddrPort（入口按客户端地址）和 udpRuleSessionKey（出口、中转）
// 几种，都能比大小。只在清扫协程里调用，不在收包热路径上。
func compareFXPUDPSessionKeys[K comparable](a, b K) int {
	switch left := any(a).(type) {
	case string:
		return strings.Compare(left, any(b).(string))
	case netip.AddrPort:
		return left.Compare(any(b).(netip.AddrPort))
	case udpRuleSessionKey:
		return left.compare(any(b).(udpRuleSessionKey))
	}
	return 0
}

func checkFXPUDPSessionCapacity(total, perIP int, incomingIP string, policy fxpUDPSessionPolicy) fxpUDPAdmission {
	decision := fxpUDPAdmission{allow: true, reason: fxpUDPAdmissionBelowLimit, total: total, perIP: perIP}
	if incomingIP != "" && policy.hardPerIP > 0 && perIP >= policy.hardPerIP {
		decision.allow = false
		decision.reason = fxpUDPAdmissionRejectActivePerIP
		return decision
	}
	if policy.hardSessions > 0 && total >= policy.hardSessions {
		decision.allow = false
		decision.reason = fxpUDPAdmissionRejectActiveGlobal
	}
	return decision
}

func fxpUDPSessionPressure(total, perIP int, incomingIP string, policy fxpUDPSessionPolicy) bool {
	return (policy.softSessions > 0 && total >= policy.softSessions) ||
		(incomingIP != "" && policy.softPerIP > 0 && perIP >= policy.softPerIP)
}

func planFXPUDPPressureReclamation[K comparable, T any](
	now time.Time,
	sessions map[K]*T,
	policy fxpUDPSessionPolicy,
	snapshot func(*T) fxpUDPSessionSnapshot,
) []fxpUDPReclamation[K, T] {
	if snapshot == nil || len(sessions) == 0 {
		return nil
	}
	reclaimAfter := policy.reclaimAfter
	if reclaimAfter <= 0 {
		reclaimAfter = fxpUDPReclaimAfter
	}
	cutoff := now.Add(-reclaimAfter).UnixNano()
	total := 0
	perIP := make(map[string]int)
	type candidate struct {
		key          K
		session      *T
		sourceIP     string
		lastActivity int64
	}
	candidates := make([]candidate, 0)
	for key, session := range sessions {
		if session == nil {
			continue
		}
		state := snapshot(session)
		total++
		if state.sourceIP != "" {
			perIP[state.sourceIP]++
		}
		if state.lastActivity > 0 && state.lastActivity <= cutoff && state.pending <= 0 {
			candidates = append(candidates, candidate{key: key, session: session, sourceIP: state.sourceIP, lastActivity: state.lastActivity})
		}
	}
	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].lastActivity == candidates[j].lastActivity {
			return compareFXPUDPSessionKeys(candidates[i].key, candidates[j].key) < 0
		}
		return candidates[i].lastActivity < candidates[j].lastActivity
	})

	reclaimed := make([]fxpUDPReclamation[K, T], 0, len(candidates))
	for _, candidate := range candidates {
		globalPressure := policy.softSessions > 0 && total >= policy.softSessions
		perIPPressure := candidate.sourceIP != "" && policy.softPerIP > 0 && perIP[candidate.sourceIP] >= policy.softPerIP
		if !globalPressure && !perIPPressure {
			continue
		}
		reclaimed = append(reclaimed, fxpUDPReclamation[K, T]{key: candidate.key, session: candidate.session})
		total--
		if candidate.sourceIP != "" {
			perIP[candidate.sourceIP]--
		}
	}
	return reclaimed
}

func (packet fxpUDPQueuedPacket) expired(now time.Time) bool {
	return !packet.queuedAt.IsZero() && now.Sub(packet.queuedAt) >= fxpUDPMaxQueueDelay
}

func (packet fxpUDPQueuedPacket) superseded(now time.Time, pendingNewer int) bool {
	return pendingNewer > 0 && packet.expired(now)
}

// supersededIn 和 superseded 一样，但先看这个包过没过期、过期了才去问队列里还有没有更新的包：
// 问队列要拿它的锁，发送协程每个包都问一次就是和入队方（读循环）每包抢一次锁；绝大多数包根本没过期。
func (packet fxpUDPQueuedPacket) supersededIn(now time.Time, newer *fxpUDPQueue) bool {
	return packet.expired(now) && newer.pending() > 0
}

type rateLimitedLog struct {
	interval   time.Duration
	last       atomic.Int64
	suppressed atomic.Uint64
}

func newRateLimitedLog(interval time.Duration) *rateLimitedLog {
	return &rateLimitedLog{interval: interval}
}

func (l *rateLimitedLog) Printf(format string, args ...any) {
	if l == nil {
		log.Printf(format, args...)
		return
	}
	now := time.Now().UnixNano()
	interval := int64(l.interval)
	if interval <= 0 {
		log.Printf(format, args...)
		return
	}
	last := l.last.Load()
	if now-last >= interval && l.last.CompareAndSwap(last, now) {
		if suppressed := l.suppressed.Swap(0); suppressed > 0 {
			format += " suppressed=%d"
			args = append(args, suppressed)
		}
		log.Printf(format, args...)
		return
	}
	l.suppressed.Add(1)
}

var fxpUDPDropLog = newRateLimitedLog(fxpUDPDropLogInterval)
var fxpUDPTuneLog = newRateLimitedLog(time.Minute)

func tuneUDPConn(conn *net.UDPConn, label string, bytes int) {
	if conn == nil {
		return
	}
	if bytes <= 0 {
		return
	}
	if err := conn.SetReadBuffer(bytes); err != nil {
		fxpUDPTuneLog.Printf("%s udp read buffer tune skipped: %v", label, err)
	}
	if err := conn.SetWriteBuffer(bytes); err != nil {
		fxpUDPTuneLog.Printf("%s udp write buffer tune skipped: %v", label, err)
	}
	forceUDPSocketBuffers(conn, bytes)
}
