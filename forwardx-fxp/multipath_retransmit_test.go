package main

// 重传、去重、晚加入的腿、调度偏好和腿的健康记忆。
//
// 这一组钉的是「一条腿出事不丢数据、不拖慢建连」：
//   · 腿把写进去的东西吞掉然后报错 —— 吞掉的那批必须由别的腿补上；
//   · 腿一直吞、永远不报错 —— 靠回执看出它不动了，重发并摘掉它；
//   · 同一片从两条腿各到一次 —— 只交付一次；
//   · 一条腿拨号挂住 —— 会话照样立刻开始。

import (
	"bytes"
	"errors"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// swallowConn stands in for a leg whose path dies with data in flight: once
// armed, writes still succeed but nothing reaches the far side — exactly what
// the kernel send buffer of a connection that is about to be reset looks like
// from the writer — and after failAfter swallowed bytes it errors out. With
// failAfter zero it swallows forever and never errors, like a path that went
// silent without an RST.
type swallowConn struct {
	net.Conn
	armed     atomic.Bool
	failAfter int64
	swallowed atomic.Int64
}

func (c *swallowConn) Write(p []byte) (int, error) {
	if !c.armed.Load() {
		return c.Conn.Write(p)
	}
	total := c.swallowed.Add(int64(len(p)))
	if c.failAfter > 0 && total >= c.failAfter {
		_ = c.Conn.Close()
		return 0, errors.New("connection reset by peer (simulated)")
	}
	return len(p), nil
}

// newWrappedMultipathPair builds a pair over net.Pipe legs, letting the caller
// wrap the entry side of each leg.
func newWrappedMultipathPair(t *testing.T, legCount, maxPending int, wrap func(index int, conn net.Conn) net.Conn) (*multipathSession, *multipathSession) {
	t.Helper()
	salt := make([]byte, fxpSaltSize)
	for i := range salt {
		salt[i] = byte(i + 11)
	}
	var clientConns, serverConns []*secureConn
	for i := 0; i < legCount; i++ {
		clientSide, serverSide := net.Pipe()
		var entrySide net.Conn = clientSide
		if wrap != nil {
			entrySide = wrap(i, clientSide)
		}
		cs, err := newSessionSecureConn(entrySide, "retransmit-test-key", salt, true)
		if err != nil {
			t.Fatal(err)
		}
		ss, err := newSessionSecureConn(serverSide, "retransmit-test-key", salt, false)
		if err != nil {
			t.Fatal(err)
		}
		clientConns = append(clientConns, cs)
		serverConns = append(serverConns, ss)
	}
	client := newMultipathSession(multipathLegsFromSecureConns(clientConns, nil), maxPending)
	server := newMultipathSession(multipathLegsFromSecureConns(serverConns, nil), maxPending)
	t.Cleanup(func() {
		client.closeTransport()
		server.closeTransport()
	})
	return client, server
}

// streamAndVerify pushes chunks through client, arming the fault after armAt
// of them, and checks the server reassembles every byte in order.
func streamAndVerify(t *testing.T, client, server *multipathSession, chunks, size, armAt int, arm func()) {
	t.Helper()
	var expected bytes.Buffer
	for i := 0; i < chunks; i++ {
		expected.Write(markedChunk(i, size))
	}
	type result struct {
		data []byte
		err  error
	}
	received := make(chan result, 1)
	go func() {
		data, err := drainStream(server)
		received <- result{data, err}
	}()
	sent := make(chan error, 1)
	go func() {
		for i := 0; i < chunks; i++ {
			if i == armAt {
				arm()
			}
			if err := client.writeFrame(markedChunk(i, size)); err != nil {
				sent <- fmt.Errorf("write %d: %w", i, err)
				return
			}
		}
		sent <- client.writeFrame(nil)
	}()
	select {
	case got := <-received:
		if got.err != nil {
			t.Fatalf("流没能拼完：%v（收到 %d 字节，应为 %d）", got.err, len(got.data), expected.Len())
		}
		if !bytes.Equal(got.data, expected.Bytes()) {
			t.Fatalf("数据对不上：收到 %d 字节，应为 %d", len(got.data), expected.Len())
		}
	case <-time.After(20 * time.Second):
		t.Fatalf("接收端卡住：等 seq %d，缓冲 %d 片", server.reorder.delivered(), server.reorder.pendingCount())
	}
	select {
	case err := <-sent:
		if err != nil {
			t.Fatalf("send: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("发送端的结束标记一直没被确认")
	}
}

func TestMultipathSessionResendsWhatADyingLegSwallowed(t *testing.T) {
	// 腿断掉之前，已经「写成功」进了内核队列、却再也送不到的那一批，必须由
	// 别的腿补上。原来只重发写失败的那一片，接收端会一直等那个洞，15 秒后重置。
	var hole *swallowConn
	client, server := newWrappedMultipathPair(t, 3, 256, func(index int, conn net.Conn) net.Conn {
		if index != 1 {
			return conn
		}
		hole = &swallowConn{Conn: conn, failAfter: 96 * 1024}
		return hole
	})
	// 超时拉长，确保通过靠的是重发，不是缓冲放弃之后碰巧对上。
	server.reorder.setStallTuning(multipathReorderStallGrace, multipathReorderOverdraftChunks, time.Minute)

	streamAndVerify(t, client, server, 3000, 1024, 200, func() { hole.armed.Store(true) })

	if hole.swallowed.Load() == 0 {
		t.Fatal("那条腿一片都没吞：用例没逼出要测的局面")
	}
	if !client.legSnapshot()[1].failed.Load() {
		t.Fatal("报错的那条腿应该已经被摘掉")
	}
}

func TestMultipathSessionResendsAndRetiresALegThatSilentlySwallows(t *testing.T) {
	// 更刁的一种：腿一直收、一直「写成功」，但一个字节都不送到，也永远不报错。
	// 写入者不会卡住，写入看门狗看不见它；只有对端回执能说明它不动了。
	var hole *swallowConn
	client, server := newWrappedMultipathPair(t, 3, 256, func(index int, conn net.Conn) net.Conn {
		if index != 2 {
			return conn
		}
		hole = &swallowConn{Conn: conn}
		return hole
	})
	client.setLegStallTuning(500*time.Millisecond, 50*time.Millisecond)
	server.reorder.setStallTuning(multipathReorderStallGrace, multipathReorderOverdraftChunks, time.Minute)

	streamAndVerify(t, client, server, 3000, 1024, 200, func() { hole.armed.Store(true) })

	if hole.swallowed.Load() == 0 {
		t.Fatal("那条腿一片都没吞：用例没逼出要测的局面")
	}
	// 在途上限封住了它能吞下的量：不能把整条流都塞进一条死腿。
	if swallowed := hole.swallowed.Load(); swallowed > 4*multipathLegInitialInflight {
		t.Fatalf("一条不送数据的腿吞下了 %d 字节，在途上限没起作用", swallowed)
	}
	deadline := time.Now().Add(3 * time.Second)
	for !client.legSnapshot()[2].failed.Load() && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if !client.legSnapshot()[2].failed.Load() {
		t.Fatal("一直不送数据的腿应该被回执看出来并摘掉")
	}
}

func TestMultipathReceiverDeliversAChunkArrivingOnTwoLegsOnce(t *testing.T) {
	// 同一片可能从两条腿各到一次（重发、或者抢先补发）。接收端只能交付一次。
	salt := make([]byte, fxpSaltSize)
	var raw []*secureConn
	var serverConns []*secureConn
	for i := 0; i < 2; i++ {
		clientSide, serverSide := net.Pipe()
		cs, err := newSessionSecureConn(clientSide, "dedup-key", salt, true)
		if err != nil {
			t.Fatal(err)
		}
		ss, err := newSessionSecureConn(serverSide, "dedup-key", salt, false)
		if err != nil {
			t.Fatal(err)
		}
		raw = append(raw, cs)
		serverConns = append(serverConns, ss)
		// 对端会回 ack，这里读掉丢弃，免得同步管道把它堵住。
		go func(conn *secureConn) {
			for {
				if _, err := conn.readFrame(); err != nil {
					return
				}
			}
		}(cs)
	}
	server := newMultipathSession(multipathLegsFromSecureConns(serverConns, nil), 64)
	t.Cleanup(server.closeTransport)

	received := make(chan []byte, 1)
	go func() {
		data, _ := drainStream(server)
		received <- data
	}()
	frames := []struct {
		leg  int
		kind byte
		seq  uint64
		data string
	}{
		{1, multipathKindData, 1, "b"},
		{0, multipathKindData, 0, "a"},
		{1, multipathKindData, 0, "a"}, // 已经交付过的重复
		{0, multipathKindData, 1, "b"}, // 还在缓冲里的重复
		{0, multipathKindData, 2, "c"},
		{1, multipathKindFin, 3, ""},
		{0, multipathKindData, 2, "c"}, // 流结束之后才到的重复
		{0, multipathKindFin, 3, ""},
	}
	for _, frame := range frames {
		if err := raw[frame.leg].writeFrame(encodeMultipathFrame(frame.kind, frame.seq, []byte(frame.data))); err != nil {
			t.Fatalf("write seq %d on leg %d: %v", frame.seq, frame.leg, err)
		}
	}
	select {
	case got := <-received:
		if string(got) != "abc" {
			t.Fatalf("重复的分片被交付了：收到 %q", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("流没有结束")
	}
	// 两条腿各自收到的字节都要记上，包括重复的 —— 发送端靠它核对每条腿送到了多少。
	legs := server.legSnapshot()
	if got := legs[0].recvBytes.Load(); got != 4 {
		t.Fatalf("leg 0 should count 4 data bytes, got %d", got)
	}
	if got := legs[1].recvBytes.Load(); got != 2 {
		t.Fatalf("leg 1 should count 2 data bytes, got %d", got)
	}
}

// reinjectEverything hands every unconfirmed chunk to another leg at once, the
// way the overdue check does for one slow leg, so the receiver sees a flood of
// duplicates.
func (s *multipathSession) reinjectEverything() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	count := 0
	for _, out := range s.out {
		if out.leg != nil && !out.confirmed() {
			s.requeueLocked(out, out.leg)
			count++
		}
	}
	s.signalLocked()
	return count
}

func TestMultipathSessionSurvivesAFloodOfDuplicates(t *testing.T) {
	client, server, _ := newTCPMultipathPair(t, 3, 256)
	stop := make(chan struct{})
	var reinjected atomic.Int64
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			case <-time.After(time.Millisecond):
				reinjected.Add(int64(client.reinjectEverything()))
			}
		}
	}()
	streamAndVerify(t, client, server, 4000, 1500, 0, func() {})
	close(stop)
	wg.Wait()
	if reinjected.Load() == 0 {
		t.Fatal("一片都没重发：用例没逼出重复")
	}
	if server.recvTotal.Load() <= uint64(4000*1500) {
		t.Fatalf("接收端没收到任何重复（%d 字节）：用例没逼出要测的局面", server.recvTotal.Load())
	}
	t.Logf("重发 %d 次，接收端多收了 %d 字节，交付无误", reinjected.Load(), server.recvTotal.Load()-uint64(4000*1500))
}

func TestMultipathSessionTakesALegThatJoinsMidStream(t *testing.T) {
	// 会话先只在一条腿上跑，另一条晚到的腿中途加进来，照样分担流量。
	salt := make([]byte, fxpSaltSize)
	pairLeg := func(index int) (*multipathLegConn, *multipathLegConn) {
		clientSide, serverSide := net.Pipe()
		cs, err := newSessionSecureConn(clientSide, "late-key", salt, true)
		if err != nil {
			t.Fatal(err)
		}
		ss, err := newSessionSecureConn(serverSide, "late-key", salt, false)
		if err != nil {
			t.Fatal(err)
		}
		return newMultipathLeg(index, cs, fmt.Sprintf("leg-%d", index)), newMultipathLeg(index, ss, fmt.Sprintf("leg-%d", index))
	}
	c0, s0 := pairLeg(0)
	client := newMultipathSession([]*multipathLegConn{c0}, 256)
	server := newMultipathSession([]*multipathLegConn{s0}, 256)
	t.Cleanup(func() { client.closeTransport(); server.closeTransport() })

	streamAndVerify(t, client, server, 2000, 2048, 300, func() {
		c1, s1 := pairLeg(1)
		// 出口那边先到、入口那边后加，两个顺序都得行；这里是前者。
		if !server.addLeg(s1) || !client.addLeg(c1) {
			t.Error("a late leg was refused by a running session")
		}
	})
	perLeg := client.legBytes()
	if len(perLeg) != 2 || perLeg[1] == 0 {
		t.Fatalf("晚到的腿一个字节都没带：%v", perLeg)
	}
	// 同一个编号不能进来两次，否则两边按编号记的账就乱了。
	dup, _ := pairLeg(1)
	if client.addLeg(dup) {
		t.Fatal("a second leg with the same id was accepted")
	}
}

// delayedLink joins two net.Pipes through a delay line in each direction, so a
// leg can have real latency without throttling what it carries.
func delayedLink(t *testing.T, delay time.Duration) (net.Conn, net.Conn) {
	t.Helper()
	entry, entryInner := net.Pipe()
	exitInner, exit := net.Pipe()
	forward := func(src, dst net.Conn) {
		type item struct {
			data []byte
			at   time.Time
		}
		queue := make(chan item, 1024)
		go func() {
			defer close(queue)
			buf := make([]byte, 64*1024)
			for {
				n, err := src.Read(buf)
				if n > 0 {
					queue <- item{append([]byte(nil), buf[:n]...), time.Now().Add(delay)}
				}
				if err != nil {
					return
				}
			}
		}()
		go func() {
			defer dst.Close()
			for it := range queue {
				time.Sleep(time.Until(it.at))
				if _, err := dst.Write(it.data); err != nil {
					return
				}
			}
		}()
	}
	forward(entryInner, exitInner)
	forward(exitInner, entryInner)
	return entry, exit
}

func TestMultipathSchedulerKeepsLightTrafficOnTheLowLatencyLeg(t *testing.T) {
	// 交互式的小流量：几条腿都闲着的时候，应该走预计最先送到的那条。
	// 原来是谁抢到算谁的，一半的请求要白白多等慢腿那一程。
	salt := make([]byte, fxpSaltSize)
	var clientConns, serverConns []*secureConn
	for i := 0; i < 2; i++ {
		var entrySide, exitSide net.Conn
		if i == 1 {
			entrySide, exitSide = delayedLink(t, 40*time.Millisecond)
		} else {
			entrySide, exitSide = net.Pipe()
		}
		cs, err := newSessionSecureConn(entrySide, "latency-key", salt, true)
		if err != nil {
			t.Fatal(err)
		}
		ss, err := newSessionSecureConn(exitSide, "latency-key", salt, false)
		if err != nil {
			t.Fatal(err)
		}
		clientConns = append(clientConns, cs)
		serverConns = append(serverConns, ss)
	}
	client := newMultipathSession(multipathLegsFromSecureConns(clientConns, nil), 256)
	server := newMultipathSession(multipathLegsFromSecureConns(serverConns, nil), 256)
	t.Cleanup(func() { client.closeTransport(); server.closeTransport() })

	const requests = 80
	for i := 0; i < requests; i++ {
		if err := client.writeFrame([]byte{byte(i)}); err != nil {
			t.Fatalf("write %d: %v", i, err)
		}
		got, err := server.readFrame()
		if err != nil || len(got) != 1 || got[0] != byte(i) {
			t.Fatalf("read %d: %v %v", i, got, err)
		}
		time.Sleep(3 * time.Millisecond)
	}
	perLeg := client.legBytes()
	t.Logf("fast leg carried %d, slow leg %d of %d requests", perLeg[0], perLeg[1], requests)
	if perLeg[1] > requests/4 {
		t.Fatalf("慢腿带了 %d/%d 个请求：调度没有偏向延迟低的那条", perLeg[1], requests)
	}
}

func TestMultipathAckRoundTrip(t *testing.T) {
	ack := multipathAck{
		delivered: 7,
		window:    1024,
		received:  12,
		finSeen:   true,
		legs:      []multipathLegAck{{id: 0, bytes: 1 << 40}, {id: 3, bytes: 5}},
	}
	decoded, err := decodeMultipathFrame(encodeMultipathAck(ack))
	if err != nil || decoded.kind != multipathKindAck {
		t.Fatalf("decode frame: %v %+v", err, decoded)
	}
	got, err := decodeMultipathAck(decoded.seq, decoded.payload)
	if err != nil {
		t.Fatalf("decode ack: %v", err)
	}
	if fmt.Sprint(got) != fmt.Sprint(ack) {
		t.Fatalf("ack changed on the wire: %+v vs %+v", got, ack)
	}
	if _, err := decodeMultipathAck(0, decoded.payload[:len(decoded.payload)-1]); err == nil {
		t.Fatal("a truncated leg list must be rejected")
	}
	// 老格式的两个类型号不再认得：对上老版本要直接报错，不能读错。
	for _, retired := range []byte{2, 3} {
		if _, err := decodeMultipathFrame(encodeMultipathFrame(retired, 0, make([]byte, 8))); !errors.Is(err, errMultipathBadKind) {
			t.Fatalf("retired kind %d should be rejected, got %v", retired, err)
		}
	}
}

// rawAckPeer is a far side that reads and discards everything and only says
// what the test tells it to.
func rawAckPeer(t *testing.T) (*multipathSession, *secureConn) {
	t.Helper()
	salt := make([]byte, fxpSaltSize)
	clientSide, serverSide := net.Pipe()
	cs, err := newSessionSecureConn(clientSide, "raw-peer-key", salt, true)
	if err != nil {
		t.Fatal(err)
	}
	peer, err := newSessionSecureConn(serverSide, "raw-peer-key", salt, false)
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		for {
			if _, err := peer.readFrame(); err != nil {
				return
			}
		}
	}()
	session := newMultipathSession(multipathLegsFromSecureConns([]*secureConn{cs}, nil), 64)
	t.Cleanup(session.closeTransport)
	return session, peer
}

func TestMultipathSenderStaysInsideTheReportedWindow(t *testing.T) {
	session, peer := rawAckPeer(t)
	// 这个用例按片数数窗口，小写不能并进同一片里。
	session.mu.Lock()
	session.coalesceLimit = 0
	session.mu.Unlock()
	if err := peer.writeFrame(encodeMultipathAck(multipathAck{window: 4})); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		session.mu.Lock()
		window := session.peerWindow
		session.mu.Unlock()
		if window == 4 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("reported window never applied, still %d", window)
		}
		time.Sleep(5 * time.Millisecond)
	}
	for i := 0; i < 4; i++ {
		if err := session.writeFrame([]byte{byte(i)}); err != nil {
			t.Fatalf("write %d inside the window: %v", i, err)
		}
	}
	blocked := make(chan error, 1)
	go func() { blocked <- session.writeFrame([]byte{4}) }()
	select {
	case err := <-blocked:
		t.Fatalf("seq 4 是窗口外的第一个，不该放行（%v）", err)
	case <-time.After(100 * time.Millisecond):
	}
	// 对端交付了一片，窗口往前挪一格。
	if err := peer.writeFrame(encodeMultipathAck(multipathAck{delivered: 1, window: 4, received: 4})); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-blocked:
		if err != nil {
			t.Fatalf("window advanced: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("窗口挪了，等在外面的那片却没被放行")
	}
	// 收到的前四片就此从重传缓冲里放掉。
	session.mu.Lock()
	base, held := session.outBase, len(session.out)
	session.mu.Unlock()
	if base != 4 || held != 1 {
		t.Fatalf("retransmit buffer should hold only seq 4, has base=%d len=%d", base, held)
	}
}

func TestMultipathSenderGivesUpWhenTheFarSideGoesSilent(t *testing.T) {
	// 对端彻底没声音的时候，发送端不能永远挂着 —— 宁可带着原因收掉，让上层重连。
	session, _ := rawAckPeer(t)
	session.sendStallTimeout.Store(int64(200 * time.Millisecond))
	// 按片数把窗口写满：单字节的写会并进同一片，这里不要合并。
	session.mu.Lock()
	session.coalesceLimit = 0
	session.mu.Unlock()
	var err error
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 10*multipathInitialWindow; i++ {
			if err = session.writeFrame([]byte("x")); err != nil {
				return
			}
		}
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("对端一声不吭，发送端却一直挂着")
	}
	if !errors.Is(err, errMultipathSendStalled) {
		t.Fatalf("expected the sender to give up, got %v", err)
	}
}

func TestMultipathSessionStartDoesNotWaitForABlackHoledLeg(t *testing.T) {
	// 一条腿的拨号挂住（中转接了连接却一声不吭）的时候，会话不能等它：原来
	// 入口要等所有腿拨完，每条新连接都白等满拨号超时（10 秒）。
	multipathLegHealthMemory.reset()
	t.Cleanup(multipathLegHealthMemory.reset)
	targetPort, stopTarget := startEchoTarget(t)
	defer stopTarget()

	blackHole, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var held []net.Conn
	var heldMu sync.Mutex
	go func() {
		for {
			conn, err := blackHole.Accept()
			if err != nil {
				return
			}
			heldMu.Lock()
			held = append(held, conn)
			heldMu.Unlock()
		}
	}()
	t.Cleanup(func() {
		_ = blackHole.Close()
		heldMu.Lock()
		for _, conn := range held {
			_ = conn.Close()
		}
		heldMu.Unlock()
	})

	const tunnelID = 9300
	exitKey := "multipath-black-hole-key"
	exitPort := freeTCPPort(t)
	exitDone := make(chan struct{})
	defer close(exitDone)
	go func() {
		_ = runExit(exitDone, config{
			Role: "exit", TunnelID: tunnelID, ListenPort: exitPort, Protocol: "tcp",
			Key: exitKey, TargetIP: "127.0.0.1", TargetPort: targetPort,
		})
	}()
	waitForTCPPort(t, exitPort)

	entryPort := freeTCPPort(t)
	entryDone := make(chan struct{})
	defer close(entryDone)
	blackPort := blackHole.Addr().(*net.TCPAddr).Port
	go func() {
		_ = runEntry(entryDone, config{
			Role: "entry", TunnelID: tunnelID, RuleID: 9301, ListenPort: entryPort, Protocol: "tcp",
			ExitHost: "127.0.0.1", ExitPort: exitPort, Key: exitKey,
			TargetIP: "127.0.0.1", TargetPort: targetPort,
			MultipathEnabled: true,
			MultipathLegs: []multipathLeg{
				{Host: "127.0.0.1", Port: blackPort, Key: exitKey, Via: "black-hole"},
				{Host: "127.0.0.1", Port: exitPort, Key: exitKey, Via: "direct"},
			},
		})
	}()
	waitForTCPPort(t, entryPort)

	for round := 0; round < 3; round++ {
		started := time.Now()
		payload := bytes.Repeat([]byte(fmt.Sprintf("round-%d;", round)), 256)
		got := echoThroughEntry(t, entryPort, payload)
		if !bytes.Equal(got, payload) {
			t.Fatalf("round %d: payload corrupted", round)
		}
		if elapsed := time.Since(started); elapsed > 2*time.Second {
			t.Fatalf("round %d took %s: the session waited on the black-holed leg", round, elapsed)
		}
	}
}

func TestMultipathExitStartsOnTheFirstLegAndTakesLateOnes(t *testing.T) {
	registry := newMultipathExitRegistry()
	salt := make([]byte, fxpSaltSize)
	leg := func(index int) *multipathLegConn {
		a, b := net.Pipe()
		t.Cleanup(func() { _ = a.Close(); _ = b.Close() })
		sec, err := newSessionSecureConn(a, "registry-key", salt, false)
		if err != nil {
			t.Fatal(err)
		}
		return newMultipathLeg(index, sec, fmt.Sprintf("leg-%d", index))
	}
	session, leader, err := registry.join("s1", leg(2), 64)
	if err != nil || !leader || session == nil {
		t.Fatalf("the first leg should lead a new session: %v leader=%v", err, leader)
	}
	// 会话已经在跑，晚到的腿直接加进来，不用等谁。
	late, leader, err := registry.join("s1", leg(0), 64)
	if err != nil || leader || late != session {
		t.Fatalf("a late leg should join the running session: %v leader=%v", err, leader)
	}
	if session.legCount() != 2 {
		t.Fatalf("expected 2 legs, got %d", session.legCount())
	}
	if _, _, err := registry.join("s1", leg(0), 64); err == nil {
		t.Fatal("the same leg id must not join twice")
	}
	session.closeTransport()
	registry.finish("s1")
	// 会话结束之后才到的腿不能再拉起一个新会话 —— 那会又连一次目标。
	if _, _, err := registry.join("s1", leg(1), 64); err == nil {
		t.Fatal("a leg arriving after its session ended must be refused")
	}
	if registry.pendingCount() != 0 {
		t.Fatalf("finished session still registered")
	}
}

func TestMultipathLegHealthBacksOffAndProbes(t *testing.T) {
	health := newMultipathLegHealth()
	now := time.Unix(1000, 0)
	health.now = func() time.Time { return now }
	const key = "10.0.0.1:443"

	if !health.allow(key) {
		t.Fatal("an unknown leg should be allowed")
	}
	health.failed(key)
	if health.allow(key) {
		t.Fatal("a leg that just failed should be skipped")
	}
	now = now.Add(multipathLegBackoffBase)
	if !health.allow(key) {
		t.Fatal("after the backoff one session should get to probe the leg")
	}
	if health.allow(key) {
		t.Fatal("only one session should probe at a time")
	}
	// 连着坏，退避翻倍，封顶 60 秒。
	for i := 0; i < 10; i++ {
		health.failed(key)
	}
	now = now.Add(multipathLegBackoffMax - time.Second)
	if health.allow(key) {
		t.Fatal("the backoff should have grown to its cap")
	}
	now = now.Add(time.Second)
	if !health.allow(key) {
		t.Fatal("the backoff must not grow past its cap")
	}
	// 拨通了就重新开放，但坏的次数还记着。
	health.dialed(key)
	if !health.allow(key) {
		t.Fatal("a leg that dialled fine should be open again")
	}
	health.failed(key)
	now = now.Add(multipathLegBackoffBase)
	if health.allow(key) {
		t.Fatal("a leg that keeps breaking right after connecting should keep backing off")
	}
	health.healthy(key)
	if !health.allow(key) {
		t.Fatal("a leg that carried a whole session should be forgiven")
	}
}

func TestMultipathLegCandidatesSkipRecentFailuresButNeverAll(t *testing.T) {
	multipathLegHealthMemory.reset()
	t.Cleanup(multipathLegHealthMemory.reset)
	cfg := config{MultipathLegs: []multipathLeg{
		{Host: "10.0.0.1", Port: 1},
		{Host: "10.0.0.2", Port: 2},
	}}
	multipathLegHealthMemory.failed(multipathLegHealthKey(cfg.MultipathLegs[1]))
	if got := multipathLegCandidates(cfg); fmt.Sprint(got) != "[0]" {
		t.Fatalf("expected only leg 0, got %v", got)
	}
	multipathLegHealthMemory.failed(multipathLegHealthKey(cfg.MultipathLegs[0]))
	if got := multipathLegCandidates(cfg); fmt.Sprint(got) != "[0 1]" {
		t.Fatalf("with every leg in backoff all of them must still be tried, got %v", got)
	}
}
