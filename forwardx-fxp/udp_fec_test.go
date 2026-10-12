package main

import (
	"encoding/binary"
	"net"
	"net/netip"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// lossyUDPProxy 坐在入口和出口之间：入口把它当出口，它把包转给真出口、把出口的回包
// 转回入口。drop 决定丢不丢（toExit 表示入口→出口方向）。
type lossyUDPProxy struct {
	conn     *net.UDPConn
	exit     netip.AddrPort
	mu       sync.Mutex
	entry    netip.AddrPort
	drop     func(toExit bool, raw []byte) bool
	fecUp    atomic.Int64 // 入口→出口方向的冗余包
	fecDown  atomic.Int64 // 出口→入口方向的冗余包
	dataUp   atomic.Int64
	dataDown atomic.Int64
	done     chan struct{}
}

func startLossyUDPProxy(t *testing.T, exit netip.AddrPort, drop func(toExit bool, raw []byte) bool) *lossyUDPProxy {
	t.Helper()
	conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	p := &lossyUDPProxy{conn: conn, exit: exit, drop: drop, done: make(chan struct{})}
	go func() {
		defer close(p.done)
		buf := make([]byte, 65535)
		for {
			n, from, err := conn.ReadFromUDPAddrPort(buf)
			if err != nil {
				return
			}
			from = fxpUDPNormalizeAddrPort(from)
			raw := buf[:n]
			toExit := from != p.exit
			if fxpUDPFECHasMagic(raw) {
				if toExit {
					p.fecUp.Add(1)
				} else {
					p.fecDown.Add(1)
				}
			} else if toExit {
				p.dataUp.Add(1)
			} else {
				p.dataDown.Add(1)
			}
			if p.drop != nil && p.drop(toExit, raw) {
				continue
			}
			if toExit {
				p.mu.Lock()
				p.entry = from
				p.mu.Unlock()
				_, _ = conn.WriteToUDPAddrPort(raw, p.exit)
				continue
			}
			p.mu.Lock()
			entry := p.entry
			p.mu.Unlock()
			if entry.IsValid() {
				_, _ = conn.WriteToUDPAddrPort(raw, entry)
			}
		}
	}()
	t.Cleanup(func() {
		_ = conn.Close()
		<-p.done
	})
	return p
}

func (p *lossyUDPProxy) port() int { return p.conn.LocalAddr().(*net.UDPAddr).Port }

// everyNthData 丢掉每个方向上第 n 个、第 2n 个……数据包（冗余包不丢），确定性的丢包。
func everyNthData(n int64) func(bool, []byte) bool {
	var up, down atomic.Int64
	return func(toExit bool, raw []byte) bool {
		if !fxpUDPHasMagic(raw) {
			return false
		}
		counter := &down
		if toExit {
			counter = &up
		}
		return counter.Add(1)%n == 0
	}
}

type udpFECHarness struct {
	client *net.UDPConn
	proxy  *lossyUDPProxy
}

func startUDPFECHarness(t *testing.T, entryFEC, exitFEC bool, drop func(bool, []byte) bool) *udpFECHarness {
	return startUDPFECHarnessVia(t, entryFEC, exitFEC, false, drop, nil)
}

// startUDPFECHarnessVia 搭 入口 → 丢包代理 →（中转 → 丢包代理 →）出口 → 回声目标。
// 中转和出口用同一个抗丢包开关 exitFEC。
func startUDPFECHarnessVia(t *testing.T, entryFEC, exitFEC, viaRelay bool, drop, relayDrop func(bool, []byte) bool) *udpFECHarness {
	t.Helper()
	target := startUDPEchoTarget(t)
	t.Cleanup(func() { _ = target.Close() })
	listen := func() *net.UDPConn {
		conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
		if err != nil {
			t.Fatal(err)
		}
		return conn
	}
	const (
		tunnelID = 931
		ruleID   = 932
		key      = "udp-fec-test-key"
		relayKey = "udp-fec-test-relay-key"
	)
	exitKey := key
	if viaRelay {
		exitKey = relayKey
	}
	exitConn := listen()
	exitCfg := config{Role: "exit", TunnelID: tunnelID, Protocol: "udp", Key: exitKey, UDPFEC: exitFEC,
		UDPTargets: []udpTarget{{RuleID: ruleID, TargetIP: "127.0.0.1", TargetPort: target.LocalAddr().(*net.UDPAddr).Port}}}
	exitDone := make(chan error, 1)
	go func() { exitDone <- serveExitUDPDirect(exitConn, exitCfg) }()
	t.Cleanup(func() {
		_ = exitConn.Close()
		<-exitDone
	})
	next := fxpUDPAddrPortOf(exitConn.LocalAddr().(*net.UDPAddr))
	if viaRelay {
		relayProxy := startLossyUDPProxy(t, next, relayDrop)
		relayConn := listen()
		relayCfg := config{Role: "relay", TunnelID: tunnelID, Protocol: "udp", Key: key, RelayKey: relayKey, UDPFEC: exitFEC,
			RelayExitHost: "127.0.0.1", RelayExitPort: relayProxy.port(), UDPRelayExitPort: relayProxy.port()}
		relaySelector := newExitEndpointSelector(nil, exitEndpoint{Host: "127.0.0.1", Port: relayProxy.port(), UDPPort: relayProxy.port(), Key: relayKey}, "")
		relayDone := make(chan error, 1)
		go func() { relayDone <- serveRelayUDPDirect(relayConn, relayCfg, relaySelector) }()
		t.Cleanup(func() {
			_ = relayConn.Close()
			<-relayDone
		})
		next = fxpUDPAddrPortOf(relayConn.LocalAddr().(*net.UDPAddr))
	}
	proxy := startLossyUDPProxy(t, next, drop)
	entryCfg := config{Role: "entry", TunnelID: tunnelID, RuleID: ruleID, Protocol: "udp", Key: key, UDPFEC: entryFEC,
		ExitHost: "127.0.0.1", ExitPort: proxy.port(), UDPExitPort: proxy.port(), TargetIP: "127.0.0.1", TargetPort: 9}
	listener := listen()
	selector := newExitEndpointSelector(nil, exitEndpoint{Host: "127.0.0.1", Port: proxy.port(), UDPPort: proxy.port(), Key: key}, "")
	entryDone := make(chan error, 1)
	go func() { entryDone <- serveEntryUDPDirect(listener, entryCfg, selector, newLimiter(0), newLimiter(0)) }()
	t.Cleanup(func() {
		_ = listener.Close()
		<-entryDone
	})
	client, err := net.DialUDP("udp", nil, listener.LocalAddr().(*net.UDPAddr))
	if err != nil {
		t.Fatal(err)
	}
	_ = client.SetReadBuffer(4 << 20)
	t.Cleanup(func() { _ = client.Close() })
	return &udpFECHarness{client: client, proxy: proxy}
}

// run 发 count 个带编号的包，等回声，返回收到了几个不同编号的回声。
func (h *udpFECHarness) run(t *testing.T, count, size int, gap time.Duration) int {
	t.Helper()
	got := make(map[uint32]bool, count)
	var mu sync.Mutex
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		buf := make([]byte, 65535)
		for {
			_ = h.client.SetReadDeadline(time.Now().Add(700 * time.Millisecond))
			n, err := h.client.Read(buf)
			if err != nil {
				return
			}
			if n == size {
				mu.Lock()
				got[binary.BigEndian.Uint32(buf[:4])] = true
				mu.Unlock()
			}
		}
	}()
	payload := make([]byte, size)
	for i := 0; i < count; i++ {
		binary.BigEndian.PutUint32(payload[:4], uint32(i))
		if _, err := h.client.Write(payload); err != nil {
			t.Fatal(err)
		}
		time.Sleep(gap)
	}
	<-readDone
	mu.Lock()
	defer mu.Unlock()
	return len(got)
}

func TestUDPFECRecoversDeterministicLossBothDirections(t *testing.T) {
	// 两个方向各丢 1/12 的数据包。不开抗丢包时一来一回大约丢 16%。
	h := startUDPFECHarness(t, true, true, everyNthData(12))
	// 先暖一下：让会话建起来、出口确认入口会发冗余包（回程才开始带冗余）。
	h.run(t, 20, 200, 2*time.Millisecond)
	const count = 600
	got := h.run(t, count, 1000, 300*time.Microsecond)
	t.Logf("fec on, 1/12 loss each way: %d of %d round trips", got, count)
	if got < count*99/100 {
		t.Fatalf("with fec only %d of %d round trips survived (up parity=%d down parity=%d)", got, count, h.proxy.fecUp.Load(), h.proxy.fecDown.Load())
	}
	if h.proxy.fecUp.Load() == 0 || h.proxy.fecDown.Load() == 0 {
		t.Fatalf("expected parity both ways, up=%d down=%d", h.proxy.fecUp.Load(), h.proxy.fecDown.Load())
	}
}

func TestUDPFECRecoversLossOnBothHopsViaRelay(t *testing.T) {
	// 入口→中转、中转→出口两跳都丢，每跳各自纠错（中转重新封包、重新分组）。
	h := startUDPFECHarnessVia(t, true, true, true, everyNthData(12), everyNthData(13))
	h.run(t, 20, 200, 2*time.Millisecond)
	const count = 600
	got := h.run(t, count, 1000, 300*time.Microsecond)
	t.Logf("fec on via relay, loss on both hops: %d of %d round trips", got, count)
	if got < count*98/100 {
		t.Fatalf("with fec via relay only %d of %d round trips survived", got, count)
	}
}

func TestUDPFECRandomLoss(t *testing.T) {
	// 3% 随机丢包（固定种子，冗余包也会丢），一来一回两次过丢包代理。
	random := func(seed uint64) func(bool, []byte) bool {
		var mu sync.Mutex
		state := seed
		return func(_ bool, raw []byte) bool {
			if !fxpUDPHasMagic(raw) && !fxpUDPFECHasMagic(raw) {
				return false
			}
			mu.Lock()
			defer mu.Unlock()
			state ^= state << 13
			state ^= state >> 7
			state ^= state << 17
			return state%100 < 3
		}
	}
	const count = 1000
	off := startUDPFECHarness(t, false, false, random(42))
	off.run(t, 20, 200, 2*time.Millisecond)
	lostOff := count - off.run(t, count, 1000, 300*time.Microsecond)
	on := startUDPFECHarness(t, true, true, random(42))
	on.run(t, 20, 200, 2*time.Millisecond)
	lostOn := count - on.run(t, count, 1000, 300*time.Microsecond)
	t.Logf("3%% random loss (parity can be lost too): lost %d of %d without fec, %d with fec", lostOff, count, lostOn)
	if lostOn*4 > lostOff {
		t.Fatalf("fec should cut random loss by at least 4x: off=%d on=%d", lostOff, lostOn)
	}
}

func TestUDPFECRecoversFragmentedDatagrams(t *testing.T) {
	h := startUDPFECHarness(t, true, true, everyNthData(9))
	h.run(t, 20, 200, 2*time.Millisecond)
	const count = 300
	// 3000 字节拆成 3 片，丢一片整个包就没了，最能看出纠错的作用。
	got := h.run(t, count, 3000, 500*time.Microsecond)
	t.Logf("fec on, 3-fragment datagrams, 1/9 loss each way: %d of %d round trips", got, count)
	if got < count*98/100 {
		t.Fatalf("with fec only %d of %d fragmented round trips survived", got, count)
	}
}

func TestUDPFECBaselineLosesWithoutFEC(t *testing.T) {
	// 对照组：同样的丢包、不开抗丢包，确认上面的测试确实在丢包。
	h := startUDPFECHarness(t, false, false, everyNthData(12))
	h.run(t, 20, 200, 2*time.Millisecond)
	const count = 600
	got := h.run(t, count, 1000, 300*time.Microsecond)
	t.Logf("fec off, 1/12 loss each way: %d of %d round trips", got, count)
	if got > count*95/100 {
		t.Fatalf("baseline should lose round trips, got %d of %d", got, count)
	}
	if h.proxy.fecUp.Load() != 0 || h.proxy.fecDown.Load() != 0 {
		t.Fatalf("fec disabled but parity was sent: up=%d down=%d", h.proxy.fecUp.Load(), h.proxy.fecDown.Load())
	}
}

func TestUDPFECOnlyEntryEnabledStillWorksWithOldExit(t *testing.T) {
	// 出口没开（等同旧版本）：入口的冗余包被出口丢掉，业务照常；出口不回冗余包。
	h := startUDPFECHarness(t, true, false, nil)
	const count = 200
	got := h.run(t, count, 1000, 300*time.Microsecond)
	if got < count {
		t.Fatalf("lossless path lost round trips: %d of %d", got, count)
	}
	if h.proxy.fecUp.Load() == 0 {
		t.Fatal("entry with fec should send parity")
	}
	if h.proxy.fecDown.Load() != 0 {
		t.Fatalf("exit without fec sent parity: %d", h.proxy.fecDown.Load())
	}
}

func TestUDPFECExitNeverSendsReturnParityToEntryWithoutFEC(t *testing.T) {
	// 入口没开（可能是旧版本，会把 FXPF 当客户端数据）：出口一个回程冗余包都不能发。
	h := startUDPFECHarness(t, false, true, nil)
	const count = 200
	got := h.run(t, count, 1000, 300*time.Microsecond)
	if got < count {
		t.Fatalf("lossless path lost round trips: %d of %d", got, count)
	}
	if h.proxy.fecDown.Load() != 0 || h.proxy.fecUp.Load() != 0 {
		t.Fatalf("parity must not flow: up=%d down=%d", h.proxy.fecUp.Load(), h.proxy.fecDown.Load())
	}
}

func TestUDPFECParityRoundTripAndValidation(t *testing.T) {
	codec, err := newFXPUDPCodec("k", fxpUDPPacket{packetType: fxpUDPTypeData, tunnelID: 1, ruleID: 2, sessionID: 3})
	if err != nil {
		t.Fatal(err)
	}
	conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	sink, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer sink.Close()
	f := newFXPUDPFEC(conn, config{UDPFEC: true}, "test", nil)
	defer f.close()
	to := sink.LocalAddr().(*net.UDPAddr)
	var wires [][]byte
	for i := 0; i < 7; i++ {
		wire, err := codec.sealPacket(fxpUDPPacket{packetType: fxpUDPTypeData, tunnelID: 1, ruleID: 2, sessionID: 3, sequence: uint64(100 + i), payload: make([]byte, 50+i*100)})
		if err != nil {
			t.Fatal(err)
		}
		wires = append(wires, wire)
	}
	for i := 0; i < 7; i++ {
		f.sent(wires[i], to, false)
	}
	// 7 个不满一组，等定时器发出去：7 个配 2 个冗余包。
	buf := make([]byte, 65535)
	var parities [][]byte
	for len(parities) < 2 {
		_ = sink.SetReadDeadline(time.Now().Add(time.Second))
		n, _, err := sink.ReadFromUDPAddrPort(buf)
		if err != nil {
			t.Fatalf("waiting for parity: %v (got %d)", err, len(parities))
		}
		parities = append(parities, append([]byte(nil), buf[:n]...))
	}
	for j, raw := range parities {
		p, err := parseFXPUDPFECParity(raw)
		if err != nil {
			t.Fatal(err)
		}
		if p.k != 7 || p.m != 2 || p.index != j || p.baseSeq != 100 || p.sessionID != 3 || p.ruleID != 2 {
			t.Fatalf("unexpected parity header %+v", p)
		}
		if want := fxpUDPFECHeaderSize + 2*7 + 2 + len(wires[6]); len(raw) != want {
			t.Fatalf("parity size %d, want %d", len(raw), want)
		}
	}
	// 接收端：丢掉第 2、5 个，两个冗余包把它们原样还原出来。
	recv := &fxpUDPFEC{now: time.Now, recvStreams: map[fxpUDPFECStreamKey]*fxpUDPFECRecvStream{}, lastSweep: time.Now(), lastStats: time.Now()}
	from := netip.MustParseAddrPort("127.0.0.1:5000")
	// 第一个冗余包先建流（真实情况下前一组的冗余包就建好了）。
	recv.recvStreams[fxpUDPFECStreamKey{addr: from, packetType: fxpUDPTypeData, ruleID: 2, sessionID: 3}] = &fxpUDPFECRecvStream{}
	for i, wire := range wires {
		if i == 2 || i == 5 {
			continue
		}
		if recv.observe(wire, from) {
			t.Fatal("data packet must not be consumed")
		}
	}
	for _, raw := range parities {
		if !recv.observe(raw, from) {
			t.Fatal("parity must be consumed")
		}
	}
	if len(recv.recovered) != 2 {
		t.Fatalf("recovered %d packets, want 2", len(recv.recovered))
	}
	for _, item := range recv.recovered {
		_, _, _, id, ok := fxpUDPWireMember(item.wire)
		if !ok {
			t.Fatal("recovered packet is not an fxp packet")
		}
		want := wires[id.sequence-100]
		if string(item.wire) != string(want) {
			t.Fatalf("recovered packet %d differs", id.sequence)
		}
		if _, err := codec.openPacket(item.wire); err != nil {
			t.Fatalf("recovered packet does not authenticate: %v", err)
		}
	}

	// 乱序：两个冗余包在大部分数据包之前到，后面的数据包到齐时照样还原。
	reordered := &fxpUDPFEC{now: time.Now, recvStreams: map[fxpUDPFECStreamKey]*fxpUDPFECRecvStream{}, lastSweep: time.Now(), lastStats: time.Now()}
	reordered.recvStreams[fxpUDPFECStreamKey{addr: from, packetType: fxpUDPTypeData, ruleID: 2, sessionID: 3}] = &fxpUDPFECRecvStream{}
	reordered.observe(wires[0], from)
	for _, raw := range parities {
		reordered.observe(raw, from)
	}
	if len(reordered.recovered) != 0 {
		t.Fatalf("recovered %d packets with 6 missing", len(reordered.recovered))
	}
	for _, i := range []int{1, 3, 4, 6} {
		reordered.observe(wires[i], from)
	}
	if len(reordered.recovered) != 2 {
		t.Fatalf("reordered: recovered %d packets, want 2", len(reordered.recovered))
	}
	for _, item := range reordered.recovered {
		_, _, _, id, _ := fxpUDPWireMember(item.wire)
		if string(item.wire) != string(wires[id.sequence-100]) {
			t.Fatalf("reordered: recovered packet %d differs", id.sequence)
		}
	}

	// 改坏的冗余包：长度不对、成员重复、版本不对都不认。
	bad := append([]byte(nil), parities[0]...)
	if _, err := parseFXPUDPFECParity(bad[:len(bad)-1]); err == nil {
		t.Fatal("truncated parity accepted")
	}
	bad[4] = 9
	if _, err := parseFXPUDPFECParity(bad); err == nil {
		t.Fatal("wrong version accepted")
	}
	bad = append([]byte(nil), parities[0]...)
	bad[fxpUDPFECHeaderSize+2] = bad[fxpUDPFECHeaderSize]
	bad[fxpUDPFECHeaderSize+3] = bad[fxpUDPFECHeaderSize+1]
	if _, err := parseFXPUDPFECParity(bad); err == nil {
		t.Fatal("duplicate member accepted")
	}
}

func TestUDPFECRejectedParityIsHandedBack(t *testing.T) {
	// 入口上：不属于任何会话的 FXPF 开头的包是客户端数据，要原样交回读循环。
	f := &fxpUDPFEC{now: time.Now, recvStreams: map[fxpUDPFECStreamKey]*fxpUDPFECRecvStream{}, lastSweep: time.Now(), lastStats: time.Now(),
		accept: func(netip.AddrPort, byte, int, uint64) bool { return false }}
	raw := make([]byte, fxpUDPFECHeaderSize+2+fxpUDPFECMinShard)
	copy(raw, fxpUDPFECMagic)
	raw[4] = fxpUDPFECVersion
	raw[5] = fxpUDPTypeReturn
	raw[6] = 1
	raw[7] = 1
	binary.BigEndian.PutUint16(raw[10:12], fxpUDPFECMinShard)
	binary.BigEndian.PutUint64(raw[16:24], 7)
	binary.BigEndian.PutUint64(raw[24:32], 1)
	if _, err := parseFXPUDPFECParity(raw); err != nil {
		t.Fatalf("test packet should parse: %v", err)
	}
	from := netip.MustParseAddrPort("127.0.0.1:6000")
	if f.observe(raw, from) {
		t.Fatal("parity for an unknown session must be handed back")
	}
	if f.peers.speaks(from, time.Now()) {
		t.Fatal("rejected parity must not mark the peer as fec-capable")
	}
	// 随便什么 FXPF 开头的客户端数据也一样。
	if f.observe([]byte("FXPF hello from a client application, not a tunnel"), from) {
		t.Fatal("unparsable FXPF data must be handed back")
	}
}
