package main

import (
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

/*
负载均衡整治路线图（docs/dev/load-balancing-roadmap.md）里 FXP 这一侧各条的回归测试。
每条先写出来、在没改的代码上跑红过，再改代码。编号和路线图一致。
*/

// startEchoTCPTarget 起一个回显目标，返回端口。
func startEchoTCPTarget(t *testing.T) int {
	t.Helper()
	target, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = target.Close() })
	go func() {
		for {
			c, e := target.Accept()
			if e != nil {
				return
			}
			go func() { defer c.Close(); _, _ = io.Copy(c, c) }()
		}
	}()
	return target.Addr().(*net.TCPAddr).Port
}

// startRoadmapExits 起 n 台出口（都在本机，端口不同），返回端口。
func startRoadmapExits(t *testing.T, n, tunnelID, ruleID int, key string, targetPort int) []int {
	t.Helper()
	done := make(chan struct{})
	t.Cleanup(func() { close(done) })
	ports := make([]int, n)
	for i := range ports {
		port := freeTCPUDPPort(t)
		ports[i] = port
		go func() {
			_ = runExit(done, config{Role: "exit", TunnelID: tunnelID, ListenPort: port, Protocol: "tcp", Key: key, StreamTargets: loopbackStreamTargets(ruleID, targetPort)})
		}()
		waitForTCP(t, port)
	}
	return ports
}

func roadmapEcho(t *testing.T, entryPort int, prefix, payload string, within time.Duration) (time.Duration, error) {
	t.Helper()
	started := time.Now()
	c, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(entryPort)), 5*time.Second)
	if err != nil {
		return time.Since(started), err
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(within))
	if _, err := c.Write([]byte(prefix + payload)); err != nil {
		return time.Since(started), err
	}
	reply := make([]byte, len(payload))
	if _, err := io.ReadFull(c, reply); err != nil {
		return time.Since(started), err
	}
	if string(reply) != payload {
		return time.Since(started), fmt.Errorf("回声不对：%q", reply)
	}
	return time.Since(started), nil
}

/* ───────────────────────── X1 主备挑到死的主出口 ───────────────────────── */

// 主出口本身连不上（还在冷却里），备用只是「刚恢复不满 5 分钟」/「不稳」：以前照样挑主出口，
// 新连接全部撞死；UDP 新会话更是终身钉在上面。出口本身连不上的，只要还有一台连得上就不能挑。
func TestFallbackNeverPicksAnEndpointDeadPrimaryWhileABackupIsReachable(t *testing.T) {
	selector := targetAwareSelector("fallback", nil)
	selector.markFailure(0, errTestEndpointDown)
	selector.mu.Lock()
	selector.target.health[1].upAt = time.Now().Add(-time.Minute) // 刚恢复 1 分钟
	selector.target.health[2].unstable = true                     // 不稳
	selector.mu.Unlock()
	for round, retryAfter := range []time.Time{time.Now().Add(time.Hour), time.Now().Add(-time.Second)} {
		setEndpointRetryAfter(selector, 0, retryAfter)
		for i := 0; i < 10; i++ {
			if _, index, ok := selector.pick(nil); !ok || index != 1 {
				t.Fatalf("第 %d 轮：主出口连不上时应该用第一台连得上的备用（1），得到 %d ok=%v", round, index, ok)
			}
		}
	}
	// 上报里「在用」的就是实际挑的那台。
	selector.mu.Lock()
	exits := selector.balanceSnapshotLocked(time.Now())
	selector.mu.Unlock()
	if exits[0].State != "down" || exits[1].State != "active" {
		t.Fatalf("上报应该是主出口 down、第二台 active：%+v", exits)
	}
	// 两台备用都只是不稳 / 刚恢复时，按顺序先用前面那台；前面那台也连不上了才用后面的。
	selector.markFailure(1, errTestEndpointDown)
	setEndpointRetryAfter(selector, 1, time.Now().Add(time.Hour))
	if _, index, _ := selector.pick(nil); index != 2 {
		t.Fatalf("前两台都连不上，应该用不稳的第三台，得到 %d", index)
	}
	// 全都连不上：冷却到期的优先。
	selector.markFailure(2, errTestEndpointDown)
	setEndpointRetryAfter(selector, 0, time.Now().Add(time.Hour))
	setEndpointRetryAfter(selector, 1, time.Now().Add(-time.Second))
	setEndpointRetryAfter(selector, 2, time.Now().Add(time.Hour))
	if _, index, ok := selector.pick(nil); !ok || index != 1 {
		t.Fatalf("全都连不上时挑冷却到期的那台（1），得到 %d ok=%v", index, ok)
	}
}

/* ───────────────────────── X2 负载分桶 ───────────────────────── */

// V2（用户态 WireGuard）下出口都被改写成 127.0.0.1:端口。以前负载按主机名记，几台出口共用一份，
// 「按负载」全压最大的那台。
func TestLoadIsTrackedPerLoopbackPort(t *testing.T) {
	resetFXPEndpointRegistry()
	selector := newExitEndpointSelector(
		[]exitEndpoint{{Host: "127.0.0.1", Port: 30002, CapacityMbps: 300}},
		exitEndpoint{Host: "127.0.0.1", Port: 30001, CapacityMbps: 500},
		"least_load",
	)
	selector.random = seededExitRandom(20261118)
	counts := map[int]int{}
	for i := 0; i < 1000; i++ {
		_, index, ok := selector.pick(nil)
		if !ok {
			t.Fatal("挑不出端点")
		}
		counts[index]++
		selector.loads[index].open(time.Now())
	}
	if counts[0] < 605 || counts[0] > 645 {
		t.Fatalf("500:300 应该约 625/375：%v", counts)
	}
}

func TestIPHashFollowsCapacityPerLoopbackPort(t *testing.T) {
	resetFXPEndpointRegistry()
	selector := newExitEndpointSelector(
		[]exitEndpoint{{Host: "127.0.0.1", Port: 30012, CapacityMbps: 100}},
		exitEndpoint{Host: "127.0.0.1", Port: 30011, CapacityMbps: 900},
		"ip_hash",
	)
	counts := map[int]int{}
	for i := 0; i < 2000; i++ {
		_, index, ok := selector.pick(nil, fmt.Sprintf("198.51.%d.%d", i/250, i%250))
		if !ok {
			t.Fatal("挑不出端点")
		}
		counts[index]++
		selector.loads[index].open(time.Now())
	}
	if counts[0] < 1700 || counts[0] > 1900 {
		t.Fatalf("900:100 应该约 1800/200：%v", counts)
	}
}

/* ───────────────────────── X4 起步位置 ───────────────────────── */

// 每条规则的轮询 / 加权都从第一台起步：几百条规则同时重启，第一条连接全打在同一台出口上。
func TestRoundRobinAndWeightedStartAtARandomOffset(t *testing.T) {
	for _, strategy := range []string{"round_robin", "weighted", "least_load"} {
		first := map[int]int{}
		for i := 0; i < 300; i++ {
			resetFXPEndpointRegistry()
			selector := newExitEndpointSelector(
				[]exitEndpoint{{Host: "10.9.0.2", Port: 2, Weight: 1}, {Host: "10.9.0.3", Port: 3, Weight: 1}},
				exitEndpoint{Host: "10.9.0.1", Port: 1, Weight: 1},
				strategy,
			)
			_, index, _ := selector.pick(nil)
			first[index]++
		}
		for index := 0; index < 3; index++ {
			if first[index] < 50 {
				t.Fatalf("%s：300 个选择器的第一次挑选应该大致均匀，实际 %v", strategy, first)
			}
		}
	}
}

// 加权的份额不受起步位置影响：一整圈里还是 5:3:2。
func TestWeightedSharesSurviveTheRandomPhase(t *testing.T) {
	for i := 0; i < 20; i++ {
		resetFXPEndpointRegistry()
		selector := newExitEndpointSelector(
			[]exitEndpoint{{Host: "10.9.1.2", Port: 2, Weight: 3}, {Host: "10.9.1.3", Port: 3, Weight: 2}},
			exitEndpoint{Host: "10.9.1.1", Port: 1, Weight: 5},
			"weighted",
		)
		counts := map[int]int{}
		for n := 0; n < 100; n++ {
			_, index, _ := selector.pick(nil)
			counts[index]++
		}
		if counts[0] != 50 || counts[1] != 30 || counts[2] != 20 {
			t.Fatalf("加权 5:3:2 的 100 次应该正好 50/30/20：%v", counts)
		}
	}
}

// activate（运行时启动时预热）不该算一次挑选：以前它吃掉轮询的第一格，还在上报里记一次「新连接」。
func TestActivateDoesNotConsumeAPick(t *testing.T) {
	resetFXPEndpointRegistry()
	selector := newExitEndpointSelector(
		[]exitEndpoint{{Host: "127.0.0.1", Port: 30022, Weight: 3}},
		exitEndpoint{Host: "127.0.0.1", Port: 30021, Weight: 5},
		"weighted",
	)
	selector.mu.Lock()
	next := selector.next
	current := append([]int(nil), selector.current...)
	selector.mu.Unlock()
	release := selector.activate(config{Role: "relay", TunnelID: 7, Key: "k"})
	defer release()
	selector.mu.Lock()
	defer selector.mu.Unlock()
	var picks uint64
	for _, n := range selector.picks {
		picks += n
	}
	if picks != 0 || selector.next != next || fmt.Sprint(selector.current) != fmt.Sprint(current) {
		t.Fatalf("activate 动了挑选状态：picks=%d next=%d→%d current=%v→%v", picks, next, selector.next, current, selector.current)
	}
}

/* ───────────────────────── X5 按负载 ───────────────────────── */

// 一下子来 100 条连接（还没有一条拨通）：以前拨通了才记数，这 100 条全压在「看起来最闲」的那台上。
func TestLeastLoadSpreadsABurstBeforeAnyDialCompletes(t *testing.T) {
	selector := leastLoadSelector(
		[]exitEndpoint{{Host: "10.0.5.2", Port: 2, CapacityMbps: 300}, {Host: "10.0.5.3", Port: 3, CapacityMbps: 200}},
		exitEndpoint{Host: "10.0.5.1", Port: 1, CapacityMbps: 500},
	)
	counts := map[int]int{}
	for i := 0; i < 100; i++ {
		_, index, ok := selector.pick(nil)
		if !ok {
			t.Fatal("挑不出端点")
		}
		counts[index]++
	}
	for index, want := range []int{50, 30, 20} {
		if counts[index] < want-5 || counts[index] > want+5 {
			t.Fatalf("100 条同时到的连接应该约 50/30/20：%v", counts)
		}
	}
}

// 界面写的是「连接数」：一台上挂着 5000 条闲着的长连接、另一台空着，新连接应该先给空着的那台。
// 以前成本里只有流量，闲连接不算，两台看起来一样闲。
func TestLeastLoadCountsIdleStreams(t *testing.T) {
	selector := leastLoadSelector(
		[]exitEndpoint{{Host: "10.0.6.2", Port: 2}},
		exitEndpoint{Host: "10.0.6.1", Port: 1},
	)
	selector.loads[0].active.Store(5000)
	idle := func(load *fxpHostLoad) {
		// 这条连接开了有一阵、没有流量：「刚开的连接」那一项已经衰减完。
		load.mu.Lock()
		load.recent = 0
		load.mu.Unlock()
	}
	for i := 0; i < 1000; i++ {
		_, index, _ := selector.pick(nil)
		if index != 1 {
			t.Fatalf("第 %d 条：另一台挂着 5000 条闲连接，应该给空着的那台", i+1)
		}
		selector.loads[index].open(time.Now())
		idle(selector.loads[index])
	}
	// 流量通过「利用率 = 流量 ÷ 线路带宽」算进来（阶段 2 起，lbcore 的成本）：一台 30M 的线路上跑着一条 3.4 MiB/s 的
	// 视频（利用率九成多，按 95% 封顶，余量 5%），另一台挂着 5 条闲连接 —— 给闲连接那台。
	selector = leastLoadSelector(
		[]exitEndpoint{{Host: "10.0.6.4", Port: 2, CapacityMbps: 30}},
		exitEndpoint{Host: "10.0.6.3", Port: 1, CapacityMbps: 30},
	)
	selector.loads[0].active.Store(1)
	setBusy(selector.loads[0], 3.4*1024*1024)
	selector.loads[1].active.Store(5)
	if _, index, _ := selector.pick(nil); index != 1 {
		t.Fatalf("一条把线路跑满的视频比 5 条闲连接重，应该给 1，得到 %d", index)
	}
}

/* ───────────────────────── X6 访客地址 ───────────────────────── */

// SNI 共享入口 / 前面有负载均衡器时，TCP 对端都是 127.0.0.1；「按访客固定」要认 PROXY 头里的来源。
func TestIPHashUsesTheProxyProtocolSource(t *testing.T) {
	resetFXPEndpointRegistry()
	targetPort := startEchoTCPTarget(t)
	key := "x6-key"
	ports := startRoadmapExits(t, 2, 161, 162, key, targetPort)
	var mu sync.Mutex
	keys := map[string]int{}
	setExitTargetDialHook(func(_ int, hello helloFrame) error {
		if !hello.TargetProbe {
			mu.Lock()
			keys[hello.SelectionKey]++
			mu.Unlock()
		}
		return nil
	})
	defer setExitTargetDialHook(nil)
	entryPort := freeTCPUDPPort(t)
	done := make(chan struct{})
	defer close(done)
	go func() {
		_ = runEntry(done, config{
			Role: "entry", TunnelID: 161, RuleID: 162, ListenPort: entryPort, Protocol: "tcp",
			ExitHost: "127.0.0.1", ExitPort: ports[0], ExitStrategy: "ip_hash",
			Exits:    []exitEndpoint{{Host: "127.0.0.1", Port: ports[0], Key: key}, {Host: "127.0.0.1", Port: ports[1], Key: key}},
			TargetIP: "127.0.0.1", TargetPort: targetPort, Key: key,
			ProxyProtocolReceive: true,
		})
	}()
	waitForTCP(t, entryPort)
	for i := 0; i < 6; i++ {
		header := fmt.Sprintf("PROXY TCP4 203.0.113.%d 192.0.2.1 %d 443\r\n", 10+i, 40000+i)
		if _, err := roadmapEcho(t, entryPort, header, "hello-x6", 10*time.Second); err != nil {
			t.Fatalf("第 %d 条：%v", i+1, err)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if keys["127.0.0.1"] != 0 || len(keys) != 6 {
		t.Fatalf("hello 里的访客地址应该是 PROXY 头里的 6 个来源，实际 %v", keys)
	}
}

/* ───────────────────────── X7 未探测的选择器 ───────────────────────── */

// 中转 UDP、纯 UDP 规则的选择器「解析到地址了」不说明对端活着：不能把共享的健康改回健康、清掉退避。
func TestResolvingAnAddressDoesNotReviveADeadEndpoint(t *testing.T) {
	resetFXPEndpointRegistry()
	selector := newExitEndpointSelector(
		[]exitEndpoint{{Host: "127.0.0.1", Port: 30032}},
		exitEndpoint{Host: "127.0.0.1", Port: 30031},
		"fallback",
	)
	selector.markFailure(0, errTestEndpointDown)
	selector.markFailure(0, errTestEndpointDown)
	state := selector.states[0]
	state.mu.Lock()
	failures, retryAfter := state.tcp.failures, state.tcp.retryAfter
	state.mu.Unlock()
	selector.markResolved(0)
	state.mu.Lock()
	defer state.mu.Unlock()
	if !state.tcp.down || state.tcp.failures != failures || !state.tcp.retryAfter.Equal(retryAfter) {
		t.Fatalf("解析成功把连不上的出口改回了健康 / 清了退避：healthy=%v failures=%d→%d", !state.tcp.down, failures, state.tcp.failures)
	}
}

/* ───────────────────────── X8 目标本身挂了时的重放风暴 ───────────────────────── */

// 目标本身挂了（每台出口都连不上）：以前每条连接还是挨个出口重放一遍，3 台出口 = 3 次目标拨号，
// 目标超时的话客户端等 3×4 秒。现在只试一台（轮着来）。
func TestTargetDownEverywhereTriesOneExitPerConnection(t *testing.T) {
	resetFXPEndpointRegistry()
	targetPort := startEchoTCPTarget(t)
	key := "x8-key"
	ports := startRoadmapExits(t, 3, 181, 182, key, targetPort)
	var mu sync.Mutex
	dials := map[int]int{}
	var targetUp atomic.Bool
	setExitTargetDialHook(func(listenPort int, hello helloFrame) error {
		if hello.TargetProbe {
			if targetUp.Load() {
				return nil
			}
			return errors.New("simulated: target down")
		}
		mu.Lock()
		dials[listenPort]++
		mu.Unlock()
		if targetUp.Load() {
			return nil
		}
		return errors.New("simulated: target down")
	})
	defer setExitTargetDialHook(nil)
	entryPort := freeTCPUDPPort(t)
	done := make(chan struct{})
	defer close(done)
	exits := make([]exitEndpoint, 3)
	for i, port := range ports {
		exits[i] = exitEndpoint{Host: "127.0.0.1", Port: port, Key: key, TargetStatus: true}
	}
	go func() {
		_ = runEntry(done, config{
			Role: "entry", TunnelID: 181, RuleID: 182, ListenPort: entryPort, Protocol: "tcp",
			ExitHost: "127.0.0.1", ExitPort: ports[0], ExitStrategy: "fallback", Exits: exits,
			TargetIP: "127.0.0.1", TargetPort: targetPort, Key: key,
		})
	}()
	waitForTCP(t, entryPort)
	// 头两条连接把三台都判成「连不上目标」（各失败两次）。
	for i := 0; i < 2; i++ {
		if _, err := roadmapEcho(t, entryPort, "", "warm", 5*time.Second); err == nil {
			t.Fatal("目标挂着，不该有回声")
		}
	}
	mu.Lock()
	dials = map[int]int{}
	mu.Unlock()
	for i := 0; i < 3; i++ {
		if _, err := roadmapEcho(t, entryPort, "", "x8", 5*time.Second); err == nil {
			t.Fatal("目标挂着，不该有回声")
		}
	}
	mu.Lock()
	total, used := 0, len(dials)
	for _, n := range dials {
		total += n
	}
	mu.Unlock()
	if total != 3 || used != 3 {
		t.Fatalf("目标全挂时 3 条连接应该各试一台、轮着来（3 次拨号、3 台各一次），实际 %v", dials)
	}
	// 目标回来了：那一次尝试直接成功，用户马上能用。
	targetUp.Store(true)
	if _, err := roadmapEcho(t, entryPort, "", "x8-back", 5*time.Second); err != nil {
		t.Fatalf("目标回来后第一条连接就该通：%v", err)
	}
}

/* ───────────────────────── X9 抖动计数 ───────────────────────── */

// simulateTargetOutage 按选择器自己的探测节奏（targetProbeInterval）喂样本：from 到 to 之间目标不通。
// 返回目标回来之后多久这台出口算恢复（-1 = 观察期内没恢复）。
func simulateTargetOutage(h *targetHealth, d balanceDetect, start, from, to, until time.Time) time.Duration {
	recovered := time.Duration(-1)
	for at := start; at.Before(until); at = at.Add(targetProbeInterval(h, d)) {
		up := at.Before(from) || !at.Before(to)
		wasDown := h.down
		h.observe(up, 40, at, d)
		if wasDown && !h.down && recovered < 0 {
			recovered = at.Sub(to)
		}
	}
	return recovered
}

// 一次 20 秒的中断以前被数成 4 次翻转（坏、好、不稳、稳），直接进「抖动放慢」；恢复后窗口里那几次失败
// 还让它「不稳」一分多钟。一次中断 = 一对翻转，目标回来 15 秒内这台出口就完全能用。
func TestOneOutageIsOneFlipPairAndRecoversQuickly(t *testing.T) {
	d := resolveBalanceDetect(nil)
	h := &targetHealth{}
	start := time.Now()
	for round := 0; round < 2; round++ {
		// 先正常跑 2 分钟，中断 20 秒，再观察 5 分钟（第二轮 = 5 分钟后的第二次中断）。
		from := start.Add(2 * time.Minute)
		to := from.Add(20 * time.Second)
		until := to.Add(5 * time.Minute)
		recovered := simulateTargetOutage(h, d, start, from, to, to.Add(16*time.Second))
		if recovered < 0 || recovered > 15*time.Second {
			t.Fatalf("第 %d 次中断：目标回来后应该 15 秒内恢复，实际 %v", round+1, recovered)
		}
		if h.unstable || h.flapping(time.Now()) {
			t.Fatalf("第 %d 次中断刚恢复：unstable=%v flapping=%v（中断 %d 次）", round+1, h.unstable, h.flapping(time.Now()), len(h.outages))
		}
		// 接着探 5 分钟：不能被窗口里的旧失败拖进「不稳」。
		for at := to.Add(16 * time.Second); at.Before(until); at = at.Add(targetProbeInterval(h, d)) {
			h.observe(true, 40, at, d)
			if h.unstable || h.down {
				t.Fatalf("第 %d 次中断恢复后 %v 又被判成 unstable=%v down=%v", round+1, at.Sub(to).Round(time.Second), h.unstable, h.down)
			}
		}
		if h.flapping(time.Now()) {
			t.Fatalf("第 %d 次中断后不该算抖动（中断 %d 次）", round+1, len(h.outages))
		}
		start = until
	}
}

/* ───────────────────────── X10 入口到出口的延迟 ───────────────────────── */

// 一次 1100ms 的慢握手：以前延迟只涨不怎么落，而且探测被池子补连接顶掉（补连接不量延迟、却把
// 「多久没确认」的计时清掉），「延迟优先 / 自动」下这台出口可以很久分不到连接。
func TestOneSlowHandshakeDoesNotStarveAnExit(t *testing.T) {
	if testing.Short() {
		t.Skip("要等真实时间")
	}
	resetFXPEndpointRegistry()
	key := "x10-key"
	ports := startRoadmapExits(t, 2, 201, 202, key, 9)
	// 两台用不同的环回地址：负载按主机记，各记各的。
	selector := newExitEndpointSelector(
		[]exitEndpoint{{Host: "127.0.0.2", Port: ports[1], Key: key}},
		exitEndpoint{Host: "127.0.0.1", Port: ports[0], Key: key},
		"latency",
	)
	cfg := config{Role: "relay", TunnelID: 201, Key: key}
	release := selector.activate(cfg)
	defer release()
	now := time.Now()
	selector.loads[0].observeLatency(2*time.Millisecond, now)
	selector.loads[1].observeLatency(2*time.Millisecond, now)
	selector.loads[1].observeLatency(1100*time.Millisecond, now)
	// 目标探测一直在从池里取连接（池子不停补）。
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		ticker := time.NewTicker(300 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				for _, state := range selector.states {
					if conn, _, ok := state.take(cfg); ok {
						_ = conn.Close()
					}
				}
			}
		}
	}()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		for i := 0; i < 20; i++ {
			if _, index, _ := selector.pick(nil); index == 1 {
				t.Logf("慢了一次的出口 %v 后回到轮转", time.Since(now).Round(100*time.Millisecond))
				return
			}
		}
		time.Sleep(250 * time.Millisecond)
	}
	t.Fatalf("一次 1100ms 的握手让这台出口 20 秒都没分到连接（现在记的延迟 %.0fms）", selector.loads[1].snapshot(time.Now()).latency)
}

/* ───────────────────────── X11 状态帧等待 ───────────────────────── */

// 出口握手正常、却一直不回「连上目标没有」（出口卡住、回程黑洞）：以前入口无限期等下去。
func TestTargetStatusWaitHasADeadline(t *testing.T) {
	resetFXPEndpointRegistry()
	targetPort := startEchoTCPTarget(t)
	key := "x11-key"
	ports := startRoadmapExits(t, 2, 211, 212, key, targetPort)
	release := make(chan struct{})
	defer close(release)
	setExitTargetDialHook(func(listenPort int, hello helloFrame) error {
		if listenPort == ports[0] && !hello.TargetProbe {
			select {
			case <-release:
			case <-time.After(25 * time.Second):
			}
		}
		return nil
	})
	defer setExitTargetDialHook(nil)
	entryPort := freeTCPUDPPort(t)
	done := make(chan struct{})
	defer close(done)
	go func() {
		_ = runEntry(done, config{
			Role: "entry", TunnelID: 211, RuleID: 212, ListenPort: entryPort, Protocol: "tcp",
			ExitHost: "127.0.0.1", ExitPort: ports[0], ExitStrategy: "fallback",
			Exits: []exitEndpoint{
				{Host: "127.0.0.1", Port: ports[0], Key: key, TargetStatus: true},
				{Host: "127.0.0.1", Port: ports[1], Key: key, TargetStatus: true},
			},
			TargetIP: "127.0.0.1", TargetPort: targetPort, Key: key,
		})
	}()
	waitForTCP(t, entryPort)
	elapsed, err := roadmapEcho(t, entryPort, "", "hello-x11", 15*time.Second)
	if err != nil {
		t.Fatalf("第一台不回结果，应该超时后换第二台重放：%v（%v）", err, elapsed.Round(time.Millisecond))
	}
	if elapsed > 9*time.Second {
		t.Fatalf("等结果等了 %v，应该有截止时间", elapsed.Round(time.Millisecond))
	}
	// 等不到结果记在出口头上的是一次「可疑」，不是当场判坏（F2，见 TestOneMissingTargetStatusIsOnlyASuspect）；
	// 这台出口握手照常通，后台探测会把可疑清掉，这里不看它的健康。
}
