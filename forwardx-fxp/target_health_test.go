package main

import (
	"errors"
	"io"
	"net"
	"strconv"
	"testing"
	"time"
)

// 用户遇到的情况：三台出口里一台到落地丢包、连不上，负载均衡却一直往它那儿分。
// 现在出口连完目标先回话，入口收到「连不上」就当场换下一台出口，把发出去的内容重放过去。
func TestEntryMovesAConnectionToAnotherExitWhenTheTargetIsUnreachable(t *testing.T) {
	resetFXPEndpointRegistry()
	target, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer target.Close()
	go func() {
		for {
			c, e := target.Accept()
			if e != nil {
				return
			}
			go func() { defer c.Close(); _, _ = io.Copy(c, c) }()
		}
	}()
	targetPort := target.Addr().(*net.TCPAddr).Port

	key := "target-aware-key"
	brokenPort := freeTCPUDPPort(t)
	goodPort := freeTCPUDPPort(t)
	entryPort := freeTCPUDPPort(t)
	setExitTargetDialHook(func(listenPort int, _ helloFrame) error {
		if listenPort == brokenPort {
			return errors.New("simulated: no route to target")
		}
		return nil
	})
	defer setExitTargetDialHook(nil)

	done := make(chan struct{})
	defer close(done)
	for _, port := range []int{brokenPort, goodPort} {
		port := port
		go func() {
			_ = runExit(done, config{Role: "exit", TunnelID: 91, ListenPort: port, Protocol: "tcp", Key: key, StreamTargets: loopbackStreamTargets(92, targetPort)})
		}()
		waitForTCP(t, port)
	}
	go func() {
		_ = runEntry(done, config{
			Role: "entry", TunnelID: 91, RuleID: 92,
			ListenPort: entryPort, Protocol: "tcp",
			ExitHost: "127.0.0.1", ExitPort: brokenPort,
			ExitStrategy: "round_robin",
			Exits: []exitEndpoint{
				{Host: "127.0.0.1", Port: brokenPort, Key: key, TargetStatus: true},
				{Host: "127.0.0.1", Port: goodPort, Key: key, TargetStatus: true},
			},
			TargetIP: "127.0.0.1", TargetPort: targetPort,
			Key: key,
		})
	}()
	waitForTCP(t, entryPort)

	for i := 0; i < 8; i++ {
		started := time.Now()
		c, dialErr := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(entryPort)), 10*time.Second)
		if dialErr != nil {
			t.Fatalf("第 %d 条连接拨不通：%v", i+1, dialErr)
		}
		_ = c.SetDeadline(time.Now().Add(15 * time.Second))
		payload := []byte("hello-" + strconv.Itoa(i))
		if _, e := c.Write(payload); e != nil {
			t.Fatalf("第 %d 条写失败：%v", i+1, e)
		}
		reply := make([]byte, len(payload))
		if _, e := io.ReadFull(c, reply); e != nil {
			t.Fatalf("第 %d 条没收到回声（应该换到好的出口重放）：%v", i+1, e)
		}
		if string(reply) != string(payload) {
			t.Fatalf("第 %d 条回声不对：%q", i+1, reply)
		}
		_ = c.Close()
		if elapsed := time.Since(started); elapsed > 3*time.Second {
			t.Fatalf("第 %d 条花了 %v：连不上目标时应该当场换出口，不是等超时", i+1, elapsed.Round(time.Millisecond))
		}
	}
}

func TestTargetHealthDownAfterFailuresAndRecoversAfterSuccesses(t *testing.T) {
	d := resolveBalanceDetect(nil)
	h := &targetHealth{}
	now := time.Now()
	if change := h.observe(false, 0, now, d); change != "" || h.down {
		t.Fatalf("一次不通不该判坏：change=%q down=%v", change, h.down)
	}
	if change := h.observe(false, 0, now.Add(2*time.Second), d); change != "down" || !h.down {
		t.Fatalf("连续 %d 次不通应该判坏：change=%q", d.fail, change)
	}
	h.observe(true, 40, now.Add(4*time.Second), d)
	h.observe(true, 40, now.Add(6*time.Second), d)
	if !h.down {
		t.Fatal("通两次还不够恢复（要连续通 3 次）")
	}
	if change := h.observe(true, 40, now.Add(8*time.Second), d); change != "recovered" || h.down {
		t.Fatalf("连续通 3 次应该恢复：change=%q", change)
	}
}

// 抖动：1 秒左右的建连（第一个包丢了重发）夹在 40ms 里，持续够「持续多久」才算不稳，算了就少分。
func TestTargetHealthMarksJitteryExitUnstableOnlyAfterTheHoldTime(t *testing.T) {
	d := resolveBalanceDetect(&balanceDetectConfig{JitterMs: 30, JitterHoldSeconds: 30})
	h := &targetHealth{}
	start := time.Now()
	for i := 0; i < 10; i++ {
		ms := 40.0
		if i%2 == 1 {
			ms = 140
		}
		h.observe(true, ms, start.Add(time.Duration(i)*2*time.Second), d)
	}
	if h.unstable {
		t.Fatal("才 18 秒，不该判不稳（持续 30 秒才处理）")
	}
	for i := 10; i < 20; i++ {
		ms := 40.0
		if i%2 == 1 {
			ms = 140
		}
		h.observe(true, ms, start.Add(time.Duration(i)*2*time.Second), d)
	}
	if !h.unstable {
		t.Fatal("抖动持续 38 秒，应该判不稳")
	}
	if h.down {
		t.Fatal("一直连得上，只是抖：不该判坏")
	}
}

func TestTargetHealthRetransmittedDialIsLossNotLatency(t *testing.T) {
	d := resolveBalanceDetect(nil)
	h := &targetHealth{}
	start := time.Now()
	for i := 0; i < 20; i++ {
		ms := 10.0
		if i == 10 {
			ms = 1010 // 握手包丢了，系统 1 秒后重发才连上
		}
		h.observe(true, ms, start.Add(time.Duration(i)*2*time.Second), d)
	}
	stats := h.stats()
	if stats.median != 10 || stats.jitter != 0 {
		t.Fatalf("一次重发不再变成 1 秒延迟、把抖动拉高：%+v", stats)
	}
	if stats.loss != 0.05 {
		t.Fatalf("它记成一次丢包：%+v", stats)
	}
	if h.down {
		t.Fatal("毕竟连上了：不算连不上目标")
	}
}

func targetAwareSelector(strategy string, detect *balanceDetectConfig) *exitEndpointSelector {
	resetFXPEndpointRegistry()
	return newExitEndpointSelector(
		[]exitEndpoint{
			{Host: "127.0.0.1", Port: 21001, TargetStatus: true},
			{Host: "127.0.0.1", Port: 21002, TargetStatus: true},
			{Host: "127.0.0.1", Port: 21003, TargetStatus: true},
		},
		exitEndpoint{Host: "127.0.0.1", Port: 21001},
		strategy,
		detect,
	)
}

func TestSelectorSkipsAnExitThatCannotReachTheTarget(t *testing.T) {
	for _, strategy := range []string{"round_robin", "random", "weighted", "least_load", "auto", "latency", "fallback"} {
		selector := targetAwareSelector(strategy, nil)
		selector.observeTarget(0, false, 0)
		selector.observeTarget(0, false, 0)
		for i := 0; i < 30; i++ {
			if _, index, ok := selector.pick(nil, "203.0.113.7"); !ok || index == 0 {
				t.Fatalf("%s：连不上目标的出口又被选中了（index=%d ok=%v）", strategy, index, ok)
			}
		}
	}
}

func TestSelectorKeepsServingWhenEveryExitFailsTheTarget(t *testing.T) {
	selector := targetAwareSelector("round_robin", nil)
	for index := 0; index < 3; index++ {
		selector.observeTarget(index, false, 0)
		selector.observeTarget(index, false, 0)
	}
	// 三台都连不上：那是目标本身的问题，换哪台都一样，照原来的办法挑，不能直接断服。
	if _, _, ok := selector.pick(nil); !ok {
		t.Fatal("三台都连不上目标时不该一台都不给")
	}
}

func TestReducedShareForJitteryExit(t *testing.T) {
	selector := targetAwareSelector("random", &balanceDetectConfig{JitterAction: "reduce"})
	selector.mu.Lock()
	selector.target.health[0].unstable = true
	selector.mu.Unlock()
	counts := map[int]int{}
	for i := 0; i < 3000; i++ {
		_, index, _ := selector.pick(nil)
		counts[index]++
	}
	// 正常的两台各约 1/(1+1+0.25) ≈ 44%，抖的那台约 11%
	if share := float64(counts[0]) / 3000; share < 0.05 || share > 0.2 {
		t.Fatalf("抖的出口应该少分到约 1/4 份，实际 %.1f%%（%v）", share*100, counts)
	}
}

func TestSwitchActionMovesTrafficOffAJitteryExit(t *testing.T) {
	selector := targetAwareSelector("round_robin", &balanceDetectConfig{JitterAction: "switch"})
	selector.mu.Lock()
	selector.target.health[1].unstable = true
	selector.mu.Unlock()
	for i := 0; i < 30; i++ {
		if _, index, _ := selector.pick(nil); index == 1 {
			t.Fatal("抖动设成「切走」，不稳的出口还在分连接")
		}
	}
}

func TestFallbackStaysOnBackupUntilThePrimaryIsStableForFiveMinutes(t *testing.T) {
	selector := targetAwareSelector("fallback", nil)
	selector.observeTarget(0, false, 0)
	selector.observeTarget(0, false, 0)
	if _, index, _ := selector.pick(nil); index != 1 {
		t.Fatalf("主用到目标不通，应该用第二台，得到 %d", index)
	}
	for i := 0; i < 3; i++ {
		selector.observeTarget(0, true, 30*time.Millisecond)
	}
	if _, index, _ := selector.pick(nil); index != 1 {
		t.Fatalf("主用刚恢复，没稳够 5 分钟不该切回去，得到 %d", index)
	}
	selector.mu.Lock()
	selector.target.health[0].upAt = time.Now().Add(-6 * time.Minute)
	selector.mu.Unlock()
	if _, index, _ := selector.pick(nil); index != 0 {
		t.Fatalf("主用稳了 5 分钟以上应该切回去，得到 %d", index)
	}
}

func TestLegacyExitsWithoutTargetStatusKeepTheOldBehaviour(t *testing.T) {
	resetFXPEndpointRegistry()
	selector := newExitEndpointSelector(
		[]exitEndpoint{{Host: "127.0.0.1", Port: 21011}, {Host: "127.0.0.1", Port: 21012}},
		exitEndpoint{Host: "127.0.0.1", Port: 21011},
		"round_robin",
	)
	if selector.targetAware() {
		t.Fatal("没有一台出口会回报时不该开「按出口 + 目标」记账")
	}
	selector.observeTarget(0, false, 0)
	selector.observeTarget(0, false, 0)
	seen := map[int]bool{}
	for i := 0; i < 4; i++ {
		_, index, _ := selector.pick(nil)
		seen[index] = true
	}
	if !seen[0] || !seen[1] {
		t.Fatalf("老出口照旧轮流：%v", seen)
	}
}

func TestTargetProbeReportsReachability(t *testing.T) {
	resetFXPEndpointRegistry()
	target, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer target.Close()
	go func() {
		for {
			c, e := target.Accept()
			if e != nil {
				return
			}
			_ = c.Close()
		}
	}()
	targetPort := target.Addr().(*net.TCPAddr).Port
	key := "target-probe-key"
	exitPort := freeTCPUDPPort(t)
	done := make(chan struct{})
	defer close(done)
	go func() {
		_ = runExit(done, config{Role: "exit", TunnelID: 93, ListenPort: exitPort, Protocol: "tcp", Key: key, StreamTargets: loopbackStreamTargets(94, targetPort)})
	}()
	waitForTCP(t, exitPort)
	endpoint := exitEndpoint{Host: "127.0.0.1", Port: exitPort, Key: key, TargetStatus: true}
	cfg := config{Role: "entry", TunnelID: 93, RuleID: 94, TargetIP: "127.0.0.1", TargetPort: targetPort, Key: key}
	status, err := probeEndpointTarget(fxpEndpointStateFor(endpoint), endpoint, cfg)
	if err != nil || !status.OK {
		t.Fatalf("目标开着，探测应该说通：status=%+v err=%v", status, err)
	}
	setExitTargetDialHook(func(int, helloFrame) error { return errors.New("simulated: refused") })
	defer setExitTargetDialHook(nil)
	status, err = probeEndpointTarget(fxpEndpointStateFor(endpoint), endpoint, cfg)
	if err != nil || status.OK {
		t.Fatalf("出口连不上目标，探测应该说不通：status=%+v err=%v", status, err)
	}
}

func TestTargetStatusFrameRoundTrip(t *testing.T) {
	frame := encodeTargetStatus(false, 1234*time.Millisecond, errors.New("i/o timeout"))
	status, ok := decodeTargetStatus(frame)
	if !ok || status.OK || status.Ms != 1234 || status.Error != "i/o timeout" {
		t.Fatalf("结果帧解出来不对：%+v ok=%v", status, ok)
	}
	if _, ok := decodeTargetStatus([]byte("SSH-2.0-OpenSSH")); ok {
		t.Fatal("普通数据不该被当成结果帧")
	}
}

func TestTargetProbeBacksOffForADownExit(t *testing.T) {
	d := resolveBalanceDetect(nil) // 2 秒一次、2 次不通算坏
	h := &targetHealth{}
	if got := targetProbeInterval(h, d); got != 2*time.Second {
		t.Fatalf("healthy exit keeps the configured pace: %v", got)
	}
	start := time.Now()
	got := []time.Duration{}
	for i := 0; i < 8; i++ {
		h.observe(false, 0, start.Add(time.Duration(i)*time.Second), d)
		got = append(got, targetProbeInterval(h, d))
	}
	want := []time.Duration{2 * time.Second, 4 * time.Second, 8 * time.Second, 16 * time.Second, 32 * time.Second, 60 * time.Second, 60 * time.Second, 60 * time.Second}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("一直连不上，探测越来越慢，最长 60 秒：got %v want %v", got, want)
		}
	}
	// 通了一次：回到平常的间隔确认（要连续 3 次通才算恢复），不再等 60 秒。
	// 以前是 4 秒（间隔的两倍）：一次 20 秒的中断，目标回来后要十几秒才恢复（路线图 X9）。
	h.observe(true, 10, start.Add(10*time.Second), d)
	if !h.down || targetProbeInterval(h, d) != 2*time.Second {
		t.Fatalf("通了一次就快一点确认恢复：down=%v interval=%v", h.down, targetProbeInterval(h, d))
	}
}
