package main

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	fxpUDPAuthTagSize        = 16
	fxpUDPMaxDatagramPayload = 65507
	fxpUDPMaxSinglePayload   = 65507 - fxpUDPHeaderSize - fxpUDPAuthTagSize
	// 发送端的单包上限按传输方式定（configureFXPUDPWireLimit），夹在这两个值之间。
	// 接收端一律按上限收，所以沿途各跳用的上限不同也能互通。
	fxpUDPMinWirePacketSize = 1200
	fxpUDPMaxWirePacketSize = 1472 // 1500 MTU 减 IPv4 + UDP 头
	// V1 直接走公网：加上 mimic 的 12 字节、IPv6 外层头，1400 仍在 1500 以内，
	// 不会被拆成 IP 分片。以前固定 1200，QUIC、游戏常见的 1250~1350 字节的包
	// 全被拆成两片：每跳包数翻倍，丢包率也跟着翻倍。
	fxpUDPDefaultWirePacketSize = 1400
	// V2 的包走 userspace WireGuard：默认 MTU 1380 减内层 IPv4 + UDP 头。
	fxpUDPWireGuardWirePacketSize = 1352
	fxpUDPMaxFragmentPayload      = fxpUDPMaxWirePacketSize - fxpUDPHeaderSize - fxpUDPAuthTagSize
	fxpUDPMinFragmentPayload      = fxpUDPMinWirePacketSize - fxpUDPHeaderSize - fxpUDPAuthTagSize
	fxpUDPMaxFragments            = (fxpUDPMaxDatagramPayload + fxpUDPMinFragmentPayload - 1) / fxpUDPMinFragmentPayload
	fxpUDPFragmentTimeout         = 5 * time.Second
	fxpUDPMaxPendingFragmentSets  = 8
)

var fxpUDPWirePacketLimit atomic.Int64

func init() {
	fxpUDPWirePacketLimit.Store(fxpUDPDefaultWirePacketSize)
}

// configureFXPUDPWireLimit 在进程启动时按配置定下发送端的单包上限。
func configureFXPUDPWireLimit(cfg config) int {
	limit := fxpUDPDefaultWirePacketSize
	if strings.EqualFold(strings.TrimSpace(cfg.TransportVersion), "v2") {
		limit = fxpUDPWireGuardWirePacketSize
	}
	if cfg.UDPWirePacketSize > 0 {
		limit = cfg.UDPWirePacketSize
	}
	limit = max(fxpUDPMinWirePacketSize, min(fxpUDPMaxWirePacketSize, limit))
	fxpUDPWirePacketLimit.Store(int64(limit))
	return limit
}

func fxpUDPFragmentPayloadLimit() int {
	return int(fxpUDPWirePacketLimit.Load()) - fxpUDPHeaderSize - fxpUDPAuthTagSize
}

type fxpUDPSequenceSeedAllocator struct {
	last atomic.Uint64
}

var fxpUDPDefaultSequenceSeeds fxpUDPSequenceSeedAllocator

type udpFragmentAssembly struct {
	fragments uint8
	chunks    [][]byte
	received  int
	total     int
	createdAt time.Time
}

type udpFragmentReassembler struct {
	mu      sync.Mutex
	pending map[uint64]*udpFragmentAssembly
	budget  *fxpUDPQueueRuleBudget
	closed  atomic.Bool
}

func (r *udpFragmentReassembler) bindBudget(budget *fxpUDPQueueRuleBudget) {
	r.setBudget(budget)
}

func (r *udpFragmentReassembler) setBudget(budget *fxpUDPQueueRuleBudget) {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.budget == budget {
		return
	}
	r.clearLocked()
	r.budget = budget
}

func (r *udpFragmentReassembler) clear() {
	if r == nil {
		return
	}
	r.mu.Lock()
	r.clearLocked()
	r.mu.Unlock()
}

func (r *udpFragmentReassembler) close() {
	if r == nil {
		return
	}
	r.closed.Store(true)
	r.mu.Lock()
	r.clearLocked()
	r.mu.Unlock()
}

func (r *udpFragmentReassembler) expire(now time.Time) {
	if r == nil || r.closed.Load() {
		return
	}
	r.mu.Lock()
	if !r.closed.Load() {
		r.expireLocked(now)
	}
	r.mu.Unlock()
}

func (r *udpFragmentReassembler) pendingCount() int {
	if r == nil || r.closed.Load() {
		return 0
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.pending)
}

func validFXPUDPFragmentMetadata(fragment, fragments uint8) bool {
	if fragments == 0 {
		return fragment == 0
	}
	return fragments >= 2 && int(fragments) <= fxpUDPMaxFragments && fragment < fragments
}

func fxpUDPFragmentCount(payloadSize int) (int, error) {
	if payloadSize < 0 || payloadSize > fxpUDPMaxDatagramPayload {
		return 0, fmt.Errorf("udp datagram payload too large: %d", payloadSize)
	}
	fragmentPayload := fxpUDPFragmentPayloadLimit()
	if payloadSize <= fragmentPayload {
		return 1, nil
	}
	count := (payloadSize + fragmentPayload - 1) / fragmentPayload
	if count > fxpUDPMaxFragments {
		return 0, fmt.Errorf("udp datagram requires too many fragments: %d", count)
	}
	return count, nil
}

func nextFXPUDPSequence(counter *atomic.Uint64) (uint64, error) {
	if counter == nil {
		return 0, errors.New("invalid udp sequence counter")
	}
	for {
		current := counter.Load()
		if current == ^uint64(0) {
			return 0, errors.New("udp packet sequence exhausted")
		}
		if counter.CompareAndSwap(current, current+1) {
			return current + 1, nil
		}
	}
}

func (a *fxpUDPSequenceSeedAllocator) next(now time.Time) (uint64, error) {
	if a == nil {
		return 0, errors.New("invalid udp sequence seed allocator")
	}
	nanos := now.UnixNano()
	if nanos <= 0 {
		return 0, errors.New("udp sequence seed time out of range")
	}
	candidate := uint64(nanos)
	for {
		last := a.last.Load()
		if candidate <= last {
			if last == ^uint64(0) {
				return 0, errors.New("udp sequence seed exhausted")
			}
			candidate = last + 1
		}
		if a.last.CompareAndSwap(last, candidate) {
			return candidate, nil
		}
	}
}

func (a *fxpUDPSequenceSeedAllocator) observe(sequence uint64) {
	if a == nil || sequence == 0 {
		return
	}
	for {
		last := a.last.Load()
		if sequence <= last || a.last.CompareAndSwap(last, sequence) {
			return
		}
	}
}

func allocateFXPUDPSequenceSeed() (uint64, error) {
	return fxpUDPDefaultSequenceSeeds.next(time.Now())
}

func observeFXPUDPSequence(counter *atomic.Uint64) {
	if counter != nil {
		fxpUDPDefaultSequenceSeeds.observe(counter.Load())
	}
}

func sealFXPUDPDatagrams(packet fxpUDPPacket, key string, counter *atomic.Uint64) ([][]byte, error) {
	if packet.fragment != 0 || packet.fragments != 0 || packet.sequence != 0 {
		return nil, errors.New("udp datagram already has wire metadata")
	}
	codec, err := newFXPUDPCodec(key, packet)
	if err != nil {
		return nil, err
	}
	return sealFXPUDPDatagramsWithCodec(packet, codec, counter)
}

func sealFXPUDPDatagramsWithCodec(packet fxpUDPPacket, codec *fxpUDPCodec, counter *atomic.Uint64) ([][]byte, error) {
	var frames [][]byte
	err := sealFXPUDPDatagramFragments(packet, codec, counter, nil, func(sealed []byte) error {
		frames = append(frames, sealed)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return frames, nil
}

// sealFXPUDPDatagramsEach 和 sealFXPUDPDatagramsWithCodec 封出来的线上字节完全
// 一样，只是每一片都封进 ws 里同一块缓冲、立刻交给 emit，不再每片分配一块、再
// 分配一个切片装它们。emit 返回之后这块缓冲就被下一片覆盖，所以 emit 只能同步
// 用完（写进 socket），不能留着。emit 返回错误就停下、原样返回这个错误。
func sealFXPUDPDatagramsEach(packet fxpUDPPacket, codec *fxpUDPCodec, counter *atomic.Uint64, ws *fxpUDPWorkspace, emit func([]byte) error) error {
	if ws == nil {
		return errors.New("udp seal workspace is nil")
	}
	return sealFXPUDPDatagramFragments(packet, codec, counter, ws, emit)
}

// sealFXPUDPDatagramFragments 分片、取序号、逐片封包。ws 为 nil 时每片单独分配，
// 交给 emit 的切片可以留着。
func sealFXPUDPDatagramFragments(packet fxpUDPPacket, codec *fxpUDPCodec, counter *atomic.Uint64, ws *fxpUDPWorkspace, emit func([]byte) error) error {
	if packet.fragment != 0 || packet.fragments != 0 || packet.sequence != 0 {
		return errors.New("udp datagram already has wire metadata")
	}
	if codec == nil || !codec.matches(packet) {
		return errors.New("udp datagram does not match cached encryption context")
	}
	count, err := fxpUDPFragmentCount(len(packet.payload))
	if err != nil {
		return err
	}
	sequence, err := nextFXPUDPSequence(counter)
	if err != nil {
		return err
	}
	fragmentPayload := fxpUDPFragmentPayloadLimit()
	for index := 0; index < count; index++ {
		start := index * fragmentPayload
		end := min(start+fragmentPayload, len(packet.payload))
		fragment := packet
		fragment.sequence = sequence
		fragment.payload = packet.payload[start:end]
		if count > 1 {
			fragment.fragment = uint8(index)
			fragment.fragments = uint8(count)
		}
		var sealed []byte
		if ws != nil {
			sealed, err = codec.sealPacketInto(ws.wire, fragment, &ws.nonce)
		} else {
			sealed, err = codec.sealPacket(fragment)
		}
		if err != nil {
			return err
		}
		if len(sealed) > fxpUDPMaxWirePacketSize {
			return fmt.Errorf("sealed udp fragment exceeds wire limit: %d", len(sealed))
		}
		if err := emit(sealed); err != nil {
			return err
		}
	}
	return nil
}

// acceptOwned 是收包热路径用的 accept：pooled 表示 packet.payload 是从池里借的、
// 所有权交给这里。返回能入队的明文、它是不是借来的（入队时连同所有权交给队列）。
//   - 单包：明文就是传进来的那块缓冲，原样交出去；没收下就当场还掉。
//   - 分片：重组器已经把这一片拷走了，传进来的缓冲当场还掉；拼好的整包是重组器
//     从池里借的。
func (r *udpFragmentReassembler) acceptOwned(packet fxpUDPPacket, replay *udpReplayWindow, pooled bool) ([]byte, bool, bool) {
	payload, ok := r.accept(packet, replay)
	if packet.fragments == 0 {
		if !ok {
			if pooled {
				putFXPByteBuffer(packet.payload)
			}
			return nil, false, false
		}
		return payload, pooled, true
	}
	if pooled {
		putFXPByteBuffer(packet.payload)
	}
	return payload, ok, ok
}

// accept 收一个包。分片会被拷进重组器自己的缓冲（调用方之后可以随意复用
// packet.payload）；拼好的整包从 fxpBytePools 借，调用方用完可以还回去，不还
// 也只是交给 GC。单包原样返回 packet.payload。
func (r *udpFragmentReassembler) accept(packet fxpUDPPacket, replay *udpReplayWindow) ([]byte, bool) {
	if r == nil || r.closed.Load() || replay == nil || !validFXPUDPFragmentMetadata(packet.fragment, packet.fragments) {
		return nil, false
	}
	if packet.fragments == 0 {
		if !replay.accept(packet.sequence) {
			return nil, false
		}
		return packet.payload, true
	}
	if len(packet.payload) == 0 || len(packet.payload) > fxpUDPMaxFragmentPayload {
		return nil, false
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed.Load() {
		return nil, false
	}
	now := time.Now()
	r.expireLocked(now)
	assembly := r.pending[packet.sequence]
	newAssembly := assembly == nil
	if assembly == nil {
		if len(r.pending) >= fxpUDPMaxPendingFragmentSets {
			r.evictOldestLocked()
		}
		assembly = &udpFragmentAssembly{
			fragments: packet.fragments,
			chunks:    make([][]byte, int(packet.fragments)),
			createdAt: now,
		}
	} else if assembly.fragments != packet.fragments {
		r.removeAssemblyLocked(packet.sequence)
		return nil, false
	}

	index := int(packet.fragment)
	if assembly.chunks[index] != nil {
		return nil, false
	}
	if assembly.total+len(packet.payload) > fxpUDPMaxDatagramPayload {
		if !newAssembly {
			r.removeAssemblyLocked(packet.sequence)
		}
		return nil, false
	}
	if r.budget != nil && !r.budget.reserve(len(packet.payload)) {
		if !newAssembly {
			r.removeAssemblyLocked(packet.sequence)
		}
		return nil, false
	}
	if newAssembly {
		if r.pending == nil {
			r.pending = make(map[uint64]*udpFragmentAssembly)
		}
		r.pending[packet.sequence] = assembly
	}
	// 拷一份：收包缓冲（或者解密用的借来的缓冲）在这个包处理完之后就要被复用了。
	chunk := getFXPByteBuffer(len(packet.payload))
	copy(chunk, packet.payload)
	assembly.total += len(packet.payload)
	assembly.chunks[index] = chunk
	assembly.received++
	if assembly.received != int(assembly.fragments) {
		return nil, false
	}
	r.detachAssemblyLocked(packet.sequence)
	defer assembly.recycle()
	if !replay.accept(packet.sequence) {
		return nil, false
	}
	payload := getFXPByteBuffer(assembly.total)
	offset := 0
	for _, chunk := range assembly.chunks {
		offset += copy(payload[offset:], chunk)
	}
	return payload, true
}

// recycle 把各片的缓冲还回池里。只在组已经从 pending 里摘下之后调用。
func (a *udpFragmentAssembly) recycle() {
	for i, chunk := range a.chunks {
		putFXPByteBuffer(chunk)
		a.chunks[i] = nil
	}
}

func (r *udpFragmentReassembler) expireLocked(now time.Time) {
	for sequence, assembly := range r.pending {
		if now.Sub(assembly.createdAt) >= fxpUDPFragmentTimeout {
			r.removeAssemblyLocked(sequence)
		}
	}
}

func (r *udpFragmentReassembler) evictOldestLocked() {
	var oldestSequence uint64
	var oldestTime time.Time
	for sequence, assembly := range r.pending {
		if oldestTime.IsZero() || assembly.createdAt.Before(oldestTime) {
			oldestSequence = sequence
			oldestTime = assembly.createdAt
		}
	}
	if !oldestTime.IsZero() {
		r.removeAssemblyLocked(oldestSequence)
	}
}

func (r *udpFragmentReassembler) removeAssemblyLocked(sequence uint64) {
	if assembly := r.detachAssemblyLocked(sequence); assembly != nil {
		assembly.recycle()
	}
}

// detachAssemblyLocked 把一组从 pending 里摘下、归还额度，缓冲留给调用方处理。
func (r *udpFragmentReassembler) detachAssemblyLocked(sequence uint64) *udpFragmentAssembly {
	assembly := r.pending[sequence]
	if assembly == nil {
		return nil
	}
	delete(r.pending, sequence)
	if r.budget != nil {
		r.budget.release(assembly.total)
	}
	return assembly
}

func (r *udpFragmentReassembler) clearLocked() {
	for sequence := range r.pending {
		r.removeAssemblyLocked(sequence)
	}
	r.pending = nil
}
