package main

import (
	"encoding/binary"
	"math/rand"
	"net"
	"net/netip"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// 无锁的两级额度：多条规则、多个协程一起借还，任何时刻两级都不越过上限，
// 全部还完之后两级都回到 0。
func TestFXPUDPQueueBudgetConcurrentRulesNeverExceedLimits(t *testing.T) {
	const (
		processLimit = 1000
		ruleLimit    = 400
		workers      = 32
		steps        = 4000
	)
	process := newFXPUDPQueueProcessBudget(processLimit)
	rules := []*fxpUDPQueueRuleBudget{
		newFXPUDPQueueRuleBudget(process, ruleLimit),
		newFXPUDPQueueRuleBudget(process, ruleLimit),
		newFXPUDPQueueRuleBudget(process, ruleLimit),
		newFXPUDPQueueRuleBudget(process, ruleLimit),
	}
	stop := make(chan struct{})
	var violations atomic.Int64
	var monitor sync.WaitGroup
	monitor.Add(1)
	go func() {
		defer monitor.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			if process.usedBytes() > processLimit || process.usedBytes() < 0 {
				violations.Add(1)
			}
			for _, rule := range rules {
				if used := rule.usedBytes(); used > ruleLimit || used < 0 {
					violations.Add(1)
				}
			}
		}
	}()
	var wg sync.WaitGroup
	for worker := 0; worker < workers; worker++ {
		wg.Add(1)
		go func(seed int64) {
			defer wg.Done()
			source := rand.New(rand.NewSource(seed))
			rule := rules[seed%int64(len(rules))]
			held := 0
			for step := 0; step < steps; step++ {
				switch source.Intn(3) {
				case 0:
					n := 1 + source.Intn(40)
					if rule.reserve(n) {
						held += n
					}
				case 1:
					release := 0
					if held > 0 {
						release = source.Intn(held + 1)
					}
					reserve := source.Intn(60)
					if rule.replace(release, reserve) {
						held += reserve - release
					}
				case 2:
					if held > 0 {
						n := 1 + source.Intn(held)
						rule.release(n)
						held -= n
					}
				}
			}
			rule.release(held)
		}(int64(worker))
	}
	wg.Wait()
	close(stop)
	monitor.Wait()
	if got := violations.Load(); got != 0 {
		t.Fatalf("额度被越过了 %d 次", got)
	}
	for i, rule := range rules {
		if got := rule.usedBytes(); got != 0 {
			t.Fatalf("规则 %d 还欠着 %d 字节", i, got)
		}
	}
	if got := process.usedBytes(); got != 0 {
		t.Fatalf("进程级还欠着 %d 字节", got)
	}
}

// 一条规则自己满了，拒绝时不碰进程计数：别的规则照样能把进程额度用满。
func TestFXPUDPQueueBudgetRuleRejectionLeavesProcessUntouched(t *testing.T) {
	process := newFXPUDPQueueProcessBudget(100)
	full := newFXPUDPQueueRuleBudget(process, 10)
	other := newFXPUDPQueueRuleBudget(process, 100)
	if !full.reserve(10) {
		t.Fatal("初始预留被拒")
	}
	if full.reserve(1) || full.replace(0, 1) {
		t.Fatal("规则满了还收")
	}
	if got := process.usedBytes(); got != 10 {
		t.Fatalf("规则拒绝改动了进程计数：%d", got)
	}
	if !other.reserve(90) {
		t.Fatal("另一条规则用不满进程剩下的额度")
	}
	// 净减少的替换不受上限影响。
	if !full.replace(10, 4) || full.usedBytes() != 4 || process.usedBytes() != 94 {
		t.Fatalf("缩小替换后 rule=%d process=%d", full.usedBytes(), process.usedBytes())
	}
	// 进程满了：规则这一级先加上、再按增量退回去，失败之后两级都和之前一样。
	if !other.replace(0, 6) || process.usedBytes() != 100 {
		t.Fatalf("进程没有被用满：%d", process.usedBytes())
	}
	if full.reserve(1) {
		t.Fatal("进程满了还收")
	}
	if full.usedBytes() != 4 || process.usedBytes() != 100 {
		t.Fatalf("失败的预留没退干净：rule=%d process=%d", full.usedBytes(), process.usedBytes())
	}
}

type deadlineRecorder struct {
	calls []time.Time
}

func (r *deadlineRecorder) SetReadDeadline(t time.Time) error {
	r.calls = append(r.calls, t)
	return nil
}

// 读超时不再每包重设：剩下不到一半才重设；超时过了之后下一次一定重设。
func TestRearmingReadDeadlineOnlyRearmsWhenHalfSpent(t *testing.T) {
	start := time.Date(2026, 10, 4, 12, 0, 0, 0, time.UTC)
	recorder := &deadlineRecorder{}
	deadline := fxpRearmingReadDeadline{period: 5 * time.Second}

	deadline.arm(recorder, start)
	for offset := time.Duration(0); offset < 2500*time.Millisecond; offset += 100 * time.Millisecond {
		deadline.arm(recorder, start.Add(offset))
	}
	if len(recorder.calls) != 1 || !recorder.calls[0].Equal(start.Add(5*time.Second)) {
		t.Fatalf("前一半时间里设了 %d 次：%v", len(recorder.calls), recorder.calls)
	}
	deadline.arm(recorder, start.Add(2600*time.Millisecond))
	if len(recorder.calls) != 2 || !recorder.calls[1].Equal(start.Add(7600*time.Millisecond)) {
		t.Fatalf("过半之后没有重设：%v", recorder.calls)
	}
	// 一直没包：超时触发（截止时间已过）之后的那次 arm 必须重设，空闲检查才能
	// 接着按节拍醒来。
	deadline.arm(recorder, start.Add(8*time.Second))
	if len(recorder.calls) != 3 || !recorder.calls[2].Equal(start.Add(13*time.Second)) {
		t.Fatalf("超时之后没有重设：%v", recorder.calls)
	}
	// 读超时最晚在最后一个包之后 period 触发，最早在 period/2 之后：空闲判定
	// 按 lastActivity 走，醒来的间隔不会超过以前的 5 秒。
	for i := 1; i < len(recorder.calls); i++ {
		if gap := recorder.calls[i].Sub(recorder.calls[i-1]); gap > 5*time.Second+time.Second {
			t.Fatalf("两次截止时间隔了 %v", gap)
		}
	}
}

// 双栈监听收到的 IPv4 来源是 ::ffff:a.b.c.d，配置里解析出来的是纯 IPv4：规整
// 之后要相等，否则出口的回包会被当成客户端包、会话按地址也找不到。
func TestFXPUDPNormalizeAddrPortUnmapsIPv4(t *testing.T) {
	mapped := netip.MustParseAddrPort("[::ffff:192.0.2.7]:4000")
	plain := netip.MustParseAddrPort("192.0.2.7:4000")
	if fxpUDPNormalizeAddrPort(mapped) != plain {
		t.Fatalf("映射地址没有规整：%v", fxpUDPNormalizeAddrPort(mapped))
	}
	resolved := &net.UDPAddr{IP: net.ParseIP("192.0.2.7"), Port: 4000} // 16 字节形式
	if fxpUDPAddrPortOf(resolved) != plain {
		t.Fatalf("*net.UDPAddr 转换后不相等：%v", fxpUDPAddrPortOf(resolved))
	}
	if fxpUDPAddrPortOf(nil).IsValid() {
		t.Fatal("nil 地址应该得到零值")
	}
	if fxpUDPSourceIP(netip.MustParseAddrPort("[fe80::1%eth0]:1")) != netip.MustParseAddr("fe80::1") {
		t.Fatal("按来源 IP 计数应该和以前的 IP.String() 一样不区分 zone")
	}
	// 回程迁移按规整后的地址比较：同一个地址的两种写法不算换地址。
	var migration udpPeerMigration
	current := &net.UDPAddr{IP: net.ParseIP("192.0.2.7").To4(), Port: 4000}
	if migration.observeAddrPort(fxpUDPNormalizeAddrPort(mapped), fxpUDPAddrPortOf(current), 1, true, time.Now()) {
		t.Fatal("同一个地址被当成了新地址")
	}
}

// drainFXPBytePoolTier 取空某一档池子，返回取出来的缓冲。
func drainFXPBytePoolTier(size int) [][]byte {
	var drained [][]byte
	for i := range fxpBytePools {
		if fxpBytePools[i].size != size {
			continue
		}
		for {
			select {
			case buffer := <-fxpBytePools[i].pool:
				drained = append(drained, buffer)
			default:
				return drained
			}
		}
	}
	return drained
}

// 借来的包缓冲由队列负责还：挤掉、出队后 done、关闭清空，每块恰好还一次，
// 不会还两次（两次就会被两个包同时借走）。
func TestFXPUDPQueueRecyclesPooledPayloadsExactlyOnce(t *testing.T) {
	const tier = 1024
	saved := drainFXPBytePoolTier(tier)
	defer func() {
		drainFXPBytePoolTier(tier)
		for _, buffer := range saved {
			putFXPByteBuffer(buffer)
		}
	}()
	process := newFXPUDPQueueProcessBudget(1 << 20)
	budget := newFXPUDPQueueRuleBudget(process, 1<<20)
	queue := newFXPUDPQueueWithBudget(4, 1<<20, budget)
	owned := map[*byte]bool{}
	for i := 0; i < 10; i++ {
		payload := getFXPByteBuffer(700)
		owned[&payload[:1][0]] = true
		queue.enqueueOwned(payload, true) // 后 6 个挤掉最老的
	}
	done := make(chan struct{})
	for i := 0; i < 2; i++ {
		packet, ok := queue.nextTracked(done, nil)
		if !ok {
			t.Fatal("队列里应该还有包")
		}
		packet.done()
		packet.done()
	}
	queue.close()
	// 已关闭的队列不收，借来的缓冲当场还掉。
	late := getFXPByteBuffer(700)
	owned[&late[:1][0]] = true
	queue.enqueueOwned(late, true)

	returned := drainFXPBytePoolTier(tier)
	seen := map[*byte]int{}
	for _, buffer := range returned {
		seen[&buffer[:1][0]]++
	}
	for pointer := range owned {
		if seen[pointer] != 1 {
			t.Fatalf("一块借来的缓冲还了 %d 次，want 1", seen[pointer])
		}
	}
	if got := budget.usedBytes(); got != 0 {
		t.Fatalf("额度还欠着 %d 字节", got)
	}
}

// 一口气连发一批不同内容、不同大小（含要分片的）的包，经过入口 → 出口 → 目标
// 回显 → 出口 → 入口，收到的每个包都必须和发出的某个包逐字节相同：借来的缓冲
// 要是被提前还掉、被下一个包覆盖，这里就会收到串了内容的包。
func TestUDPDirectPooledPayloadsAreNotCorruptedUnderBurst(t *testing.T) {
	t.Run("direct", func(t *testing.T) { testUDPDirectBurstIntegrity(t, false) })
	// 中转的两条热路径（上一跳的数据包、下一跳的回包）也走借来的缓冲。
	t.Run("via-relay", func(t *testing.T) { testUDPDirectBurstIntegrity(t, true) })
}

func testUDPDirectBurstIntegrity(t *testing.T, viaRelay bool) {
	target := startUDPEchoTarget(t)
	defer target.Close()
	listenLoopbackUDP := func() *net.UDPConn {
		conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
		if err != nil {
			t.Fatal(err)
		}
		return conn
	}
	const (
		tunnelID = 911
		ruleID   = 912
		key      = "udp-direct-burst-key"
		relayKey = "udp-direct-burst-relay-key"
	)
	exitKey := key
	if viaRelay {
		exitKey = relayKey
	}
	exitConn := listenLoopbackUDP()
	exitCfg := config{Role: "exit", TunnelID: tunnelID, Protocol: "udp", Key: exitKey,
		UDPTargets: []udpTarget{{RuleID: ruleID, TargetIP: "127.0.0.1", TargetPort: target.LocalAddr().(*net.UDPAddr).Port}}}
	exitDone := make(chan error, 1)
	go func() { exitDone <- serveExitUDPDirect(exitConn, exitCfg) }()
	defer func() {
		_ = exitConn.Close()
		<-exitDone
	}()
	nextPort := exitConn.LocalAddr().(*net.UDPAddr).Port
	if viaRelay {
		relayConn := listenLoopbackUDP()
		relayCfg := config{Role: "relay", TunnelID: tunnelID, Protocol: "udp", Key: key, RelayKey: relayKey,
			RelayExitHost: "127.0.0.1", RelayExitPort: nextPort, UDPRelayExitPort: nextPort}
		relaySelector := newExitEndpointSelector(nil, exitEndpoint{Host: "127.0.0.1", Port: nextPort, UDPPort: nextPort, Key: relayKey}, "")
		relayDone := make(chan error, 1)
		go func() { relayDone <- serveRelayUDPDirect(relayConn, relayCfg, relaySelector) }()
		defer func() {
			_ = relayConn.Close()
			<-relayDone
		}()
		nextPort = relayConn.LocalAddr().(*net.UDPAddr).Port
	}
	entryCfg := config{Role: "entry", TunnelID: tunnelID, RuleID: ruleID, Protocol: "udp", Key: key,
		ExitHost: "127.0.0.1", ExitPort: nextPort, UDPExitPort: nextPort, TargetIP: "127.0.0.1", TargetPort: 9}
	listener := listenLoopbackUDP()
	selector := newExitEndpointSelector(nil, exitEndpoint{Host: "127.0.0.1", Port: nextPort, UDPPort: nextPort, Key: key}, "")
	entryDone := make(chan error, 1)
	go func() { entryDone <- serveEntryUDPDirect(listener, entryCfg, selector, newLimiter(0), newLimiter(0)) }()
	defer func() {
		_ = listener.Close()
		<-entryDone
	}()
	client, err := net.DialUDP("udp", nil, listener.LocalAddr().(*net.UDPAddr))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	_ = client.SetReadBuffer(4 << 20)

	makePayload := func(index int) []byte {
		sizes := []int{1, 64, 700, 1300, 2000, 3000, 5000}
		payload := make([]byte, sizes[index%len(sizes)])
		for i := range payload {
			payload[i] = byte(index*31 + i*7)
		}
		if len(payload) >= 4 {
			binary.BigEndian.PutUint32(payload, uint32(index))
		}
		return payload
	}
	// 先建会话。
	if _, err := client.Write(makePayload(0)); err != nil {
		t.Fatal(err)
	}
	_ = client.SetReadDeadline(time.Now().Add(2 * time.Second))
	reply := make([]byte, 65535)
	if _, err := client.Read(reply); err != nil {
		t.Fatalf("会话没建起来：%v", err)
	}

	const burst = 300
	sent := map[string]bool{}
	for i := 1; i <= burst; i++ {
		payload := makePayload(i)
		sent[string(payload)] = true
		if _, err := client.Write(payload); err != nil {
			t.Fatal(err)
		}
		if i%32 == 0 {
			time.Sleep(time.Millisecond)
		}
	}
	received := 0
	for {
		_ = client.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
		n, err := client.Read(reply)
		if err != nil {
			break
		}
		if !sent[string(reply[:n])] {
			t.Fatalf("收到一个和发出的都对不上的包（%d 字节，开头 %x）", n, reply[:min(n, 16)])
		}
		received++
	}
	t.Logf("一批 %d 个回来 %d 个，内容全部对得上", burst, received)
	if received < burst/2 {
		t.Fatalf("一批 %d 个只回来 %d 个", burst, received)
	}
}
