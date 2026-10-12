package main

import (
	"encoding/binary"
	"errors"
	"log"
	"net"
	"net/netip"
	"sync"
	"sync/atomic"
	"time"

	"github.com/klauspost/reedsolomon"
)

/*
UDP 直连的抗丢包（前向纠错，FEC）。隧道上打开「抗丢包」后才启用，默认关。

做法：发送端把同一条会话、同一个方向、发往同一个地址的线上包（已经封好、加密过
的 FXPU 包）按发出顺序凑成一组，最多 fxpUDPFECMaxData 个；凑满或者组里第一个包
已经等了 fxpUDPFECFlushDelay，就用 Reed-Solomon 算出几个冗余包（每 5 个数据包
一个，见 fxpUDPFECParityCount）单独发出去。数据包本身一个字节都不改，照常立刻发。
接收端记着最近收到的线上包；冗余包到了，看组里缺了几个，缺的不超过收到的冗余包数
就当场还原，把还原出来的线上包当成刚从网卡上读到的交给原来的处理流程。

为什么这样做：
  - 和旧版本完全互通。冗余包用另一个魔数（FXPF），旧出口、旧中转按「不是 FXP 包」
    直接丢掉；数据包格式没变。只有旧入口要小心：它的监听口同时收客户端的包，会把
    FXPF 当成客户端数据建会话。所以回程方向（出口→入口、中转→上一跳）的冗余包只发给
    已经给我们发过冗余包的地址（fxpUDPFECPeers）：对端发过，说明它是新版本而且开了。
  - 安全性不变。冗余包本身不认证，但还原出来的是原来的密文，照样要过 AEAD、重放窗口
    和时间窗；伪造的冗余包最多还原出一个解不开的包。迟到的原包和还原的包重复时，
    重放窗口只收一个。
  - 不加延迟。数据包不等组凑满；还原最多晚 fxpUDPFECFlushDelay 加一个单程。

代价：组满时多 20% 流量；包很稀（游戏、语音）时一组可能只有一两个包，冗余包等于
复制一份，流量翻倍，但这类流量本来就小。冗余包比组里最大的包长 fxpUDPFECHeaderSize
+ 2*k + 2 字节。

一个监听口一份 fxpUDPFEC：接收只在读循环那一个协程里跑，不加锁；发送在各会话的
写协程里并发调用，按流加锁。
*/

const (
	fxpUDPFECMagic   = "FXPF"
	fxpUDPFECVersion = byte(1)
	// 头部 32 字节，后面跟 k 个成员（每个 2 字节：序号差、分片号），再跟冗余分片。
	fxpUDPFECHeaderSize = 32
	fxpUDPFECMaxData    = 10
	fxpUDPFECMaxParity  = 2
	// 分片 = 2 字节长度 + 线上包，补零到组里最长的那个。
	fxpUDPFECMaxShard = 2 + fxpUDPMaxWirePacketSize
	fxpUDPFECMinShard = 2 + fxpUDPHeaderSize + fxpUDPAuthTagSize
	// 组里第一个包最多等这么久就发冗余包：游戏、语音每秒几十个包，等久了还原出来
	// 也已经晚了。
	fxpUDPFECFlushDelay = 8 * time.Millisecond
	// 接收端每条流记最近这么多个线上包；组最大 10 个，留出乱序的余量。
	fxpUDPFECRecvSlots = 32
	// 冗余包等后面的冗余包（缺得多）最多等这么久。
	fxpUDPFECGroupTTL = 250 * time.Millisecond
	// 每条流同时挂着的未完成组。
	fxpUDPFECMaxPendingGroups = 8
	fxpUDPFECMaxRecvStreams   = 256
	fxpUDPFECMaxSendStreams   = 4096
	fxpUDPFECStreamIdle       = 30 * time.Second
	// 对端多久没发过冗余包就不再给它发回程冗余包。
	fxpUDPFECPeerTTL       = 2 * time.Minute
	fxpUDPFECMaxPeers      = 4096
	fxpUDPFECStatsInterval = time.Minute
)

// fxpUDPFECParityCount 是 k 个数据包配几个冗余包：每 5 个一个，最少一个。
func fxpUDPFECParityCount(k int) int {
	if k <= 0 {
		return 0
	}
	return min(fxpUDPFECMaxParity, (k+4)/5)
}

// fxpUDPFECStreamKey 是一条流：同一会话、同一方向、同一个对端地址。
type fxpUDPFECStreamKey struct {
	addr       netip.AddrPort
	packetType byte
	ruleID     uint32
	sessionID  uint64
}

type fxpUDPFECMemberID struct {
	sequence uint64
	fragment uint8
}

// fxpUDPWireMember 从封好的 FXPU 线上包里读出流和成员身份（只看明文包头）。
func fxpUDPWireMember(wire []byte) (packetType byte, ruleID uint32, sessionID uint64, id fxpUDPFECMemberID, ok bool) {
	if !fxpUDPHasMagic(wire) || wire[4] != fxpUDPVersion || len(wire) < fxpUDPHeaderSize+fxpUDPAuthTagSize {
		return 0, 0, 0, fxpUDPFECMemberID{}, false
	}
	packetType = wire[5]
	if packetType != fxpUDPTypeData && packetType != fxpUDPTypeReturn {
		return 0, 0, 0, fxpUDPFECMemberID{}, false
	}
	ruleID = binary.BigEndian.Uint32(wire[12:16])
	sessionID = binary.BigEndian.Uint64(wire[16:24])
	id = fxpUDPFECMemberID{sequence: binary.BigEndian.Uint64(wire[24:32]), fragment: wire[6]}
	if sessionID == 0 || id.sequence == 0 {
		return 0, 0, 0, fxpUDPFECMemberID{}, false
	}
	return packetType, ruleID, sessionID, id, true
}

func fxpUDPFECHasMagic(raw []byte) bool {
	return len(raw) >= fxpUDPFECHeaderSize && string(raw[0:4]) == fxpUDPFECMagic
}

// fxpUDPFECParity 是解析过的一个冗余包。shard 指向收包缓冲，要留着得先拷走。
type fxpUDPFECParity struct {
	packetType byte
	k          int
	m          int
	index      int
	shardLen   int
	ruleID     uint32
	sessionID  uint64
	baseSeq    uint64
	members    [fxpUDPFECMaxData]fxpUDPFECMemberID
	shard      []byte
}

var errFXPUDPFECBadPacket = errors.New("invalid udp fec packet")

func parseFXPUDPFECParity(raw []byte) (fxpUDPFECParity, error) {
	var p fxpUDPFECParity
	if !fxpUDPFECHasMagic(raw) || raw[4] != fxpUDPFECVersion || raw[9] != 0 {
		return p, errFXPUDPFECBadPacket
	}
	p.packetType = raw[5]
	p.k = int(raw[6])
	p.m = int(raw[7])
	p.index = int(raw[8])
	p.shardLen = int(binary.BigEndian.Uint16(raw[10:12]))
	p.ruleID = binary.BigEndian.Uint32(raw[12:16])
	p.sessionID = binary.BigEndian.Uint64(raw[16:24])
	p.baseSeq = binary.BigEndian.Uint64(raw[24:32])
	if p.packetType != fxpUDPTypeData && p.packetType != fxpUDPTypeReturn {
		return p, errFXPUDPFECBadPacket
	}
	if p.k < 1 || p.k > fxpUDPFECMaxData || p.m != fxpUDPFECParityCount(p.k) || p.index >= p.m {
		return p, errFXPUDPFECBadPacket
	}
	if p.shardLen < fxpUDPFECMinShard || p.shardLen > fxpUDPFECMaxShard || p.sessionID == 0 || p.baseSeq == 0 {
		return p, errFXPUDPFECBadPacket
	}
	membersEnd := fxpUDPFECHeaderSize + 2*p.k
	if len(raw) != membersEnd+p.shardLen {
		return p, errFXPUDPFECBadPacket
	}
	for i := 0; i < p.k; i++ {
		delta := uint64(raw[fxpUDPFECHeaderSize+2*i])
		p.members[i] = fxpUDPFECMemberID{sequence: p.baseSeq + delta, fragment: raw[fxpUDPFECHeaderSize+2*i+1]}
		if p.members[i].sequence < p.baseSeq {
			return p, errFXPUDPFECBadPacket
		}
		for j := 0; j < i; j++ {
			if p.members[j] == p.members[i] {
				return p, errFXPUDPFECBadPacket
			}
		}
	}
	p.shard = raw[membersEnd:]
	return p, nil
}

// ---- Reed-Solomon 编码器：每种 (k, m) 一个池（库没说明编码器能不能并发用）----

var fxpUDPFECEncoderPools [fxpUDPFECMaxData + 1]sync.Pool

func getFXPUDPFECEncoder(k int) (reedsolomon.Encoder, error) {
	if k < 1 || k > fxpUDPFECMaxData {
		return nil, errFXPUDPFECBadPacket
	}
	if enc, ok := fxpUDPFECEncoderPools[k].Get().(reedsolomon.Encoder); ok && enc != nil {
		return enc, nil
	}
	return reedsolomon.New(k, fxpUDPFECParityCount(k), reedsolomon.WithMaxGoroutines(1))
}

func putFXPUDPFECEncoder(k int, enc reedsolomon.Encoder) {
	if enc != nil && k >= 1 && k <= fxpUDPFECMaxData {
		fxpUDPFECEncoderPools[k].Put(enc)
	}
}

// ---- 对端记录：谁给我们发过冗余包 ----

type fxpUDPFECPeers struct {
	mu   sync.RWMutex
	seen map[netip.AddrPort]time.Time
}

func (p *fxpUDPFECPeers) saw(addr netip.AddrPort, now time.Time) {
	// 每个冗余包都会来一次：已经记着、而且是最近记的，就不抢写锁。
	p.mu.RLock()
	at, ok := p.seen[addr]
	p.mu.RUnlock()
	if ok && now.Sub(at) < time.Second {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.seen == nil {
		p.seen = map[netip.AddrPort]time.Time{}
	}
	if _, ok := p.seen[addr]; !ok && len(p.seen) >= fxpUDPFECMaxPeers {
		for key, at := range p.seen {
			if now.Sub(at) > fxpUDPFECPeerTTL {
				delete(p.seen, key)
			}
		}
		if len(p.seen) >= fxpUDPFECMaxPeers {
			return
		}
	}
	p.seen[addr] = now
}

func (p *fxpUDPFECPeers) speaks(addr netip.AddrPort, now time.Time) bool {
	p.mu.RLock()
	defer p.mu.RUnlock()
	at, ok := p.seen[addr]
	return ok && now.Sub(at) <= fxpUDPFECPeerTTL
}

// ---- 统计 ----

type fxpUDPFECStats struct {
	groups        atomic.Uint64 // 发出的组
	parity        atomic.Uint64 // 发出的冗余包
	recovered     atomic.Uint64 // 还原出来的包
	unrecoverable atomic.Uint64 // 缺得太多、没能还原的组
}

// ---- 监听口一份 ----

// fxpUDPFECAcceptParity 判断一个冗余包是不是这个监听口上一条现有会话的：入口要
// 核对来源地址，免得把客户端发来的、碰巧以 FXPF 开头的数据当成冗余包吞掉。
type fxpUDPFECAcceptParity func(from netip.AddrPort, packetType byte, ruleID int, sessionID uint64) bool

type fxpUDPFEC struct {
	label string
	conn  *net.UDPConn
	peers fxpUDPFECPeers
	stats fxpUDPFECStats

	// 发送
	sendMu      sync.Mutex
	sendStreams map[fxpUDPFECStreamKey]*fxpUDPFECSendStream
	openGroups  atomic.Int64
	wake        chan struct{}
	stop        chan struct{}
	stopOnce    sync.Once
	flusherDone chan struct{}
	// flushScratch 只在 flusher 协程里用。
	flushScratch []*fxpUDPFECSendStream
	// now 可以在测试里换掉。
	now func() time.Time

	// 接收（只在读循环里用）
	accept      fxpUDPFECAcceptParity
	recvStreams map[fxpUDPFECStreamKey]*fxpUDPFECRecvStream
	recovered   []fxpUDPFECRecovered
	lastSweep   time.Time
	lastStats   time.Time
	loggedStats [4]uint64
}

type fxpUDPFECRecovered struct {
	wire []byte
	from netip.AddrPort
}

// newFXPUDPFEC 在隧道打开了抗丢包时返回这个监听口的 FEC，没打开返回 nil
// （nil 上的方法都是原样直通）。
func newFXPUDPFEC(conn *net.UDPConn, cfg config, label string, accept fxpUDPFECAcceptParity) *fxpUDPFEC {
	if !cfg.UDPFEC || conn == nil {
		return nil
	}
	f := &fxpUDPFEC{
		label:       label,
		conn:        conn,
		sendStreams: map[fxpUDPFECStreamKey]*fxpUDPFECSendStream{},
		wake:        make(chan struct{}, 1),
		stop:        make(chan struct{}),
		flusherDone: make(chan struct{}),
		now:         time.Now,
		accept:      accept,
		recvStreams: map[fxpUDPFECStreamKey]*fxpUDPFECRecvStream{},
	}
	now := f.now()
	f.lastSweep = now
	f.lastStats = now
	go f.flusher()
	log.Printf("fxp udp fec enabled %s group=%d+%d flush=%s", label, fxpUDPFECMaxData, fxpUDPFECParityCount(fxpUDPFECMaxData), fxpUDPFECFlushDelay)
	return f
}

func (f *fxpUDPFEC) close() {
	if f == nil {
		return
	}
	f.stopOnce.Do(func() {
		close(f.stop)
		<-f.flusherDone
		f.logStats(true)
	})
}

// ---- 发送端 ----

type fxpUDPFECSendStream struct {
	mu       sync.Mutex
	addr     *net.UDPAddr
	lastUsed time.Time
	openedAt time.Time
	baseSeq  uint64
	count    int
	ids      [fxpUDPFECMaxData]fxpUDPFECMemberID
	// shards[i] 是第 i 个成员：2 字节长度 + 线上包，容量 fxpUDPFECMaxShard。
	shards  [fxpUDPFECMaxData][]byte
	lengths [fxpUDPFECMaxData]int
	parity  [fxpUDPFECMaxParity][]byte
	scratch []byte
	all     [fxpUDPFECMaxData + fxpUDPFECMaxParity][]byte
}

// sent 在一个线上包写进 socket 之后调用。wire 用完就会被覆盖，这里同步拷走。
// requirePeer 是回程方向：只给发过冗余包的对端发（见文件头）。
func (f *fxpUDPFEC) sent(wire []byte, to *net.UDPAddr, requirePeer bool) {
	if f == nil || to == nil {
		return
	}
	packetType, ruleID, sessionID, id, ok := fxpUDPWireMember(wire)
	if !ok || len(wire) > fxpUDPMaxWirePacketSize {
		return
	}
	addr := fxpUDPAddrPortOf(to)
	now := f.now()
	if requirePeer && !f.peers.speaks(addr, now) {
		return
	}
	key := fxpUDPFECStreamKey{addr: addr, packetType: packetType, ruleID: ruleID, sessionID: sessionID}
	f.sendMu.Lock()
	stream := f.sendStreams[key]
	if stream == nil {
		if len(f.sendStreams) >= fxpUDPFECMaxSendStreams {
			f.sendMu.Unlock()
			return
		}
		stream = &fxpUDPFECSendStream{addr: to}
		f.sendStreams[key] = stream
	}
	f.sendMu.Unlock()

	stream.mu.Lock()
	defer stream.mu.Unlock()
	stream.lastUsed = now
	stream.addr = to
	if stream.count > 0 && (id.sequence < stream.baseSeq || id.sequence-stream.baseSeq > 255) {
		f.flushLocked(stream)
	}
	if stream.count == 0 {
		stream.baseSeq = id.sequence
		stream.openedAt = now
		if f.openGroups.Add(1) == 1 {
			select {
			case f.wake <- struct{}{}:
			default:
			}
		}
	}
	i := stream.count
	if stream.shards[i] == nil {
		stream.shards[i] = make([]byte, fxpUDPFECMaxShard)
	}
	shard := stream.shards[i][:cap(stream.shards[i])]
	binary.BigEndian.PutUint16(shard[0:2], uint16(len(wire)))
	copy(shard[2:], wire)
	stream.lengths[i] = 2 + len(wire)
	stream.ids[i] = id
	stream.count++
	if stream.count == fxpUDPFECMaxData {
		f.flushLocked(stream)
	}
}

// flushLocked 给流里攒着的这一组算冗余包并发出去，然后清空。调用方持有 stream.mu。
func (f *fxpUDPFEC) flushLocked(stream *fxpUDPFECSendStream) {
	k := stream.count
	if k == 0 {
		return
	}
	stream.count = 0
	f.openGroups.Add(-1)
	m := fxpUDPFECParityCount(k)
	shardLen := 0
	for i := 0; i < k; i++ {
		shardLen = max(shardLen, stream.lengths[i])
	}
	for i := 0; i < k; i++ {
		shard := stream.shards[i][:shardLen]
		clear(shard[stream.lengths[i]:])
		stream.all[i] = shard
	}
	for j := 0; j < m; j++ {
		if cap(stream.parity[j]) < fxpUDPFECMaxShard {
			stream.parity[j] = make([]byte, fxpUDPFECMaxShard)
		}
		stream.all[k+j] = stream.parity[j][:shardLen]
	}
	enc, err := getFXPUDPFECEncoder(k)
	if err != nil {
		return
	}
	err = enc.Encode(stream.all[:k+m])
	putFXPUDPFECEncoder(k, enc)
	if err != nil {
		fxpUDPDropLog.Printf("fxp udp fec encode failed %s k=%d: %v", f.label, k, err)
		return
	}
	membersEnd := fxpUDPFECHeaderSize + 2*k
	size := membersEnd + shardLen
	if cap(stream.scratch) < size {
		stream.scratch = make([]byte, fxpUDPFECHeaderSize+2*fxpUDPFECMaxData+fxpUDPFECMaxShard)
	}
	pkt := stream.scratch[:size]
	// 头部里的会话字段从第一个成员的线上包里抄（流里每个成员都一样）。
	first := stream.shards[0][2:]
	copy(pkt[0:4], fxpUDPFECMagic)
	pkt[4] = fxpUDPFECVersion
	pkt[5] = first[5]
	pkt[6] = byte(k)
	pkt[7] = byte(m)
	pkt[9] = 0
	binary.BigEndian.PutUint16(pkt[10:12], uint16(shardLen))
	copy(pkt[12:24], first[12:24])
	binary.BigEndian.PutUint64(pkt[24:32], stream.baseSeq)
	for i := 0; i < k; i++ {
		pkt[fxpUDPFECHeaderSize+2*i] = byte(stream.ids[i].sequence - stream.baseSeq)
		pkt[fxpUDPFECHeaderSize+2*i+1] = stream.ids[i].fragment
	}
	f.stats.groups.Add(1)
	for j := 0; j < m; j++ {
		pkt[8] = byte(j)
		copy(pkt[membersEnd:], stream.all[k+j])
		if _, err := f.conn.WriteToUDP(pkt, stream.addr); err != nil {
			if !isClosedErr(err) {
				fxpUDPDropLog.Printf("fxp udp fec parity write failed %s to=%s: %v", f.label, stream.addr, err)
			}
			return
		}
		f.stats.parity.Add(1)
	}
}

// flusher 把等够 fxpUDPFECFlushDelay 的组发出去，顺便清掉闲置的流。没有攒着的组时
// 睡着，不空转。
func (f *fxpUDPFEC) flusher() {
	defer close(f.flusherDone)
	tick := fxpUDPFECFlushDelay / 2
	timer := time.NewTimer(tick)
	defer timer.Stop()
	for {
		if f.openGroups.Load() == 0 {
			select {
			case <-f.stop:
				return
			case <-f.wake:
			case <-timer.C:
				// 没有组也定期醒，清闲置的流。
				f.flushDue()
				timer.Reset(fxpUDPFECStreamIdle)
				continue
			}
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer.Reset(tick)
			continue
		}
		select {
		case <-f.stop:
			return
		case <-f.wake:
			continue
		case <-timer.C:
		}
		f.flushDue()
		timer.Reset(tick)
	}
}

func (f *fxpUDPFEC) flushDue() {
	now := f.now()
	f.sendMu.Lock()
	streams := f.flushScratch[:0]
	for key, stream := range f.sendStreams {
		stream.mu.Lock()
		idle := stream.count == 0 && now.Sub(stream.lastUsed) > fxpUDPFECStreamIdle
		stream.mu.Unlock()
		if idle {
			delete(f.sendStreams, key)
			continue
		}
		streams = append(streams, stream)
	}
	f.sendMu.Unlock()
	for _, stream := range streams {
		stream.mu.Lock()
		if stream.count > 0 && now.Sub(stream.openedAt) >= fxpUDPFECFlushDelay {
			f.flushLocked(stream)
		}
		stream.mu.Unlock()
	}
	clear(streams)
	f.flushScratch = streams[:0]
}

// ---- 接收端 ----

type fxpUDPFECRecvSlot struct {
	id    fxpUDPFECMemberID
	valid bool
	// data 是 2 字节长度 + 线上包，和发送端的分片同样的格式。
	data []byte
}

type fxpUDPFECRecvGroup struct {
	baseSeq   uint64
	k         int
	shardLen  int
	members   [fxpUDPFECMaxData]fxpUDPFECMemberID
	parity    [fxpUDPFECMaxParity][]byte
	have      int
	createdAt time.Time
	done      bool
}

type fxpUDPFECRecvStream struct {
	slots  [fxpUDPFECRecvSlots]fxpUDPFECRecvSlot
	next   int
	groups []*fxpUDPFECRecvGroup
	// free 是用过的组，连同它们的冗余分片缓冲留着复用，收包路径上不再分配。
	free     []*fxpUDPFECRecvGroup
	lastSeen time.Time
}

// newGroup 拿一个空组：先用回收的，没有就新建。
func (s *fxpUDPFECRecvStream) newGroup() *fxpUDPFECRecvGroup {
	if n := len(s.free); n > 0 {
		group := s.free[n-1]
		s.free[n-1] = nil
		s.free = s.free[:n-1]
		parity := group.parity
		*group = fxpUDPFECRecvGroup{}
		for j := range parity {
			group.parity[j] = parity[j][:0]
		}
		return group
	}
	return &fxpUDPFECRecvGroup{}
}

func (s *fxpUDPFECRecvStream) recycle(group *fxpUDPFECRecvGroup) {
	if group != nil && len(s.free) < fxpUDPFECMaxPendingGroups {
		s.free = append(s.free, group)
	}
}

func (s *fxpUDPFECRecvStream) find(id fxpUDPFECMemberID) []byte {
	for i := range s.slots {
		if s.slots[i].valid && s.slots[i].id == id {
			return s.slots[i].data
		}
	}
	return nil
}

func (s *fxpUDPFECRecvStream) remember(id fxpUDPFECMemberID, wire []byte) {
	slot := &s.slots[s.next]
	s.next = (s.next + 1) % fxpUDPFECRecvSlots
	if cap(slot.data) < fxpUDPFECMaxShard {
		slot.data = make([]byte, fxpUDPFECMaxShard)
	}
	data := slot.data[:2+len(wire)]
	binary.BigEndian.PutUint16(data[0:2], uint16(len(wire)))
	copy(data[2:], wire)
	slot.data = data
	slot.id = id
	slot.valid = true
}

// read 替代 conn.ReadFromUDPAddrPort：先交还原出来的包；冗余包自己吃掉；记下属于
// 有冗余的流的线上包。返回的地址没有规整，和 ReadFromUDPAddrPort 一样。
func (f *fxpUDPFEC) read(conn *net.UDPConn, buf []byte) (int, netip.AddrPort, error) {
	if f == nil {
		return conn.ReadFromUDPAddrPort(buf)
	}
	for {
		if len(f.recovered) > 0 {
			item := f.recovered[0]
			f.recovered[0] = fxpUDPFECRecovered{}
			f.recovered = f.recovered[1:]
			if len(f.recovered) == 0 {
				f.recovered = nil
			}
			n := copy(buf, item.wire)
			return n, item.from, nil
		}
		n, from, err := conn.ReadFromUDPAddrPort(buf)
		if err != nil {
			return n, from, err
		}
		if f.observe(buf[:n], fxpUDPNormalizeAddrPort(from)) {
			continue
		}
		return n, from, nil
	}
}

// observe 看一个刚读到的包。返回 true 表示它是冗余包、已经处理完，不要交给读循环。
func (f *fxpUDPFEC) observe(raw []byte, from netip.AddrPort) bool {
	now := f.now()
	if now.Sub(f.lastSweep) >= time.Second {
		f.sweep(now)
	}
	if fxpUDPFECHasMagic(raw) {
		parity, err := parseFXPUDPFECParity(raw)
		if err != nil {
			// 解析不了：可能是入口的客户端碰巧发了 FXPF 开头的数据，原样交回去。
			return false
		}
		if f.accept != nil && !f.accept(from, parity.packetType, int(parity.ruleID), parity.sessionID) {
			return false
		}
		f.peers.saw(from, now)
		f.handleParity(parity, from, now)
		return true
	}
	packetType, ruleID, sessionID, id, ok := fxpUDPWireMember(raw)
	if !ok || len(raw) > fxpUDPMaxWirePacketSize {
		return false
	}
	stream := f.recvStreams[fxpUDPFECStreamKey{addr: from, packetType: packetType, ruleID: ruleID, sessionID: sessionID}]
	if stream != nil {
		stream.lastSeen = now
		stream.remember(id, raw)
	}
	return false
}

func (f *fxpUDPFEC) handleParity(parity fxpUDPFECParity, from netip.AddrPort, now time.Time) {
	key := fxpUDPFECStreamKey{addr: from, packetType: parity.packetType, ruleID: parity.ruleID, sessionID: parity.sessionID}
	stream := f.recvStreams[key]
	if stream == nil {
		// 第一个冗余包才建流：对端不发冗余包就一点开销都没有。这一组里先到的
		// 数据包没记下，还原不了，也不算「还原失败」，从下一组开始生效。
		if len(f.recvStreams) >= fxpUDPFECMaxRecvStreams {
			f.evictOldestRecvStream()
		}
		f.recvStreams[key] = &fxpUDPFECRecvStream{lastSeen: now}
		return
	}
	stream.lastSeen = now
	var group *fxpUDPFECRecvGroup
	for _, g := range stream.groups {
		if g.baseSeq == parity.baseSeq && g.k == parity.k && g.members[0] == parity.members[0] {
			group = g
			break
		}
	}
	if group == nil {
		if len(stream.groups) >= fxpUDPFECMaxPendingGroups {
			oldest := stream.groups[0]
			f.retireGroup(stream, oldest)
			copy(stream.groups, stream.groups[1:])
			stream.groups[len(stream.groups)-1] = nil
			stream.groups = stream.groups[:len(stream.groups)-1]
			stream.recycle(oldest)
		}
		group = stream.newGroup()
		group.baseSeq = parity.baseSeq
		group.k = parity.k
		group.shardLen = parity.shardLen
		group.members = parity.members
		group.createdAt = now
		stream.groups = append(stream.groups, group)
	}
	if group.done || group.shardLen != parity.shardLen || group.members != parity.members {
		return
	}
	if len(group.parity[parity.index]) == 0 {
		group.parity[parity.index] = append(group.parity[parity.index][:0], parity.shard...)
		group.have++
	}
	f.tryRecover(stream, group, from)
}

func (f *fxpUDPFEC) tryRecover(stream *fxpUDPFECRecvStream, group *fxpUDPFECRecvGroup, from netip.AddrPort) {
	missing := 0
	for i := 0; i < group.k; i++ {
		if stream.find(group.members[i]) == nil {
			missing++
		}
	}
	if missing == 0 {
		group.done = true
		return
	}
	if missing > group.have {
		return
	}
	m := fxpUDPFECParityCount(group.k)
	shards := make([][]byte, group.k+m)
	for i := 0; i < group.k; i++ {
		data := stream.find(group.members[i])
		if data == nil {
			continue
		}
		if len(data) > group.shardLen {
			// 对端算冗余时这个包没这么长：不是同一个包（被别的同号包顶掉了），还原不了。
			group.done = true
			return
		}
		shard := make([]byte, group.shardLen)
		copy(shard, data)
		shards[i] = shard
	}
	for j := 0; j < m; j++ {
		if len(group.parity[j]) > 0 {
			// 拷一份：重建会改写传进去的切片，组的缓冲还要复用。
			shards[group.k+j] = append([]byte(nil), group.parity[j]...)
		}
	}
	enc, err := getFXPUDPFECEncoder(group.k)
	if err != nil {
		return
	}
	err = enc.ReconstructData(shards)
	putFXPUDPFECEncoder(group.k, enc)
	group.done = true
	if err != nil {
		f.stats.unrecoverable.Add(1)
		return
	}
	for i := 0; i < group.k; i++ {
		if stream.find(group.members[i]) != nil {
			continue
		}
		shard := shards[i]
		if len(shard) < 2 {
			continue
		}
		size := int(binary.BigEndian.Uint16(shard[0:2]))
		if size < fxpUDPHeaderSize+fxpUDPAuthTagSize || 2+size > len(shard) {
			continue
		}
		wire := shard[2 : 2+size]
		_, _, _, id, ok := fxpUDPWireMember(wire)
		if !ok || id != group.members[i] {
			continue
		}
		stream.remember(id, wire)
		f.recovered = append(f.recovered, fxpUDPFECRecovered{wire: append([]byte(nil), wire...), from: from})
		f.stats.recovered.Add(1)
	}
}

// retireGroup 在丢掉一个还没完成的组时记一笔：到这时还缺包，就是还原不了。
// 冗余包比数据包先到（乱序）、数据包后来都到齐了的组不算。
func (f *fxpUDPFEC) retireGroup(stream *fxpUDPFECRecvStream, group *fxpUDPFECRecvGroup) {
	if group == nil || group.done {
		return
	}
	for i := 0; i < group.k; i++ {
		if stream.find(group.members[i]) == nil {
			f.stats.unrecoverable.Add(1)
			return
		}
	}
}

func (f *fxpUDPFEC) evictOldestRecvStream() {
	var oldestKey fxpUDPFECStreamKey
	var oldest *fxpUDPFECRecvStream
	for key, stream := range f.recvStreams {
		if oldest == nil || stream.lastSeen.Before(oldest.lastSeen) {
			oldestKey, oldest = key, stream
		}
	}
	if oldest != nil {
		for _, group := range oldest.groups {
			f.retireGroup(oldest, group)
		}
		delete(f.recvStreams, oldestKey)
	}
}

func (f *fxpUDPFEC) sweep(now time.Time) {
	f.lastSweep = now
	for key, stream := range f.recvStreams {
		if now.Sub(stream.lastSeen) > fxpUDPFECStreamIdle {
			for _, group := range stream.groups {
				f.retireGroup(stream, group)
			}
			delete(f.recvStreams, key)
			continue
		}
		kept := stream.groups[:0]
		for _, group := range stream.groups {
			if group.done {
				stream.recycle(group)
				continue
			}
			if now.Sub(group.createdAt) > fxpUDPFECGroupTTL {
				f.retireGroup(stream, group)
				stream.recycle(group)
				continue
			}
			kept = append(kept, group)
		}
		clear(stream.groups[len(kept):])
		stream.groups = kept
	}
	if now.Sub(f.lastStats) >= fxpUDPFECStatsInterval {
		f.lastStats = now
		f.logStats(false)
	}
}

// logStats 每分钟有变化时打一行：发了多少组 / 冗余包，还原了多少，多少组缺得太多。
func (f *fxpUDPFEC) logStats(final bool) {
	current := [4]uint64{f.stats.groups.Load(), f.stats.parity.Load(), f.stats.recovered.Load(), f.stats.unrecoverable.Load()}
	if current == f.loggedStats && !final {
		return
	}
	if current == ([4]uint64{}) {
		return
	}
	log.Printf("fxp udp fec stats %s sentGroups=%d sentParity=%d recovered=%d unrecoverableGroups=%d", f.label, current[0], current[1], current[2], current[3])
	f.loggedStats = current
}
