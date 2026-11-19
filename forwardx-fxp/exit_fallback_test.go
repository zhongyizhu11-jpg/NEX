package main

import (
	"errors"
	"io"
	"net"
	"strconv"
	"testing"
	"time"
)

// 主用出口「端口开着但进程不响应」：TCP 连得上，握手没有任何回音。
// 这是最常见的半死形态 —— 进程卡住、LB 把连接收下但后端已经没了、
// 中间设备静默丢包。问题是：切到备用要等多久？
func TestEntryFallsBackQuicklyWhenThePrimaryExitBlackHoles(t *testing.T) {
	resetFXPEndpointRegistry()
	// 回声目标
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

	// 黑洞主用：只 accept，什么都不回
	hole, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer hole.Close()
	holePort := hole.Addr().(*net.TCPAddr).Port
	// 握着不放，一个字节都不回。用带缓冲的通道存着，既不让它们被回收关掉，
	// 也不引入跨协程共享的切片。
	held := make(chan net.Conn, 64)
	go func() {
		for {
			c, e := hole.Accept()
			if e != nil {
				return
			}
			select {
			case held <- c:
			default:
				_ = c.Close()
			}
		}
	}()

	key := "blackhole-exit-key"
	backupPort := freeTCPUDPPort(t)
	entryPort := freeTCPUDPPort(t)
	exitDone := make(chan struct{})
	entryDone := make(chan struct{})
	defer close(exitDone)
	defer close(entryDone)
	go func() {
		_ = runExit(exitDone, config{
			Role: "exit", TunnelID: 81, ListenPort: backupPort, Protocol: "tcp", Key: key, StreamTargets: loopbackStreamTargets(82, targetPort),
		})
	}()
	waitForTCP(t, backupPort)
	go func() {
		_ = runEntry(entryDone, config{
			Role: "entry", TunnelID: 81, RuleID: 82,
			ListenPort: entryPort, Protocol: "tcp",
			ExitHost: "127.0.0.1", ExitPort: holePort,
			ExitStrategy: "fallback",
			Exits:        []exitEndpoint{{Host: "127.0.0.1", Port: backupPort, Key: key}},
			TargetIP:     "127.0.0.1", TargetPort: targetPort,
			Key: key,
		})
	}()
	waitForTCP(t, entryPort)

	roundTrip := func(label string) time.Duration {
		start := time.Now()
		c, dialErr := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(entryPort)), 60*time.Second)
		if dialErr != nil {
			t.Fatalf("%s dial: %v", label, dialErr)
		}
		defer c.Close()
		_ = c.SetDeadline(time.Now().Add(60 * time.Second))
		if _, e := c.Write([]byte("ping")); e != nil {
			t.Fatalf("%s write: %v", label, e)
		}
		reply := make([]byte, 4)
		if _, e := io.ReadFull(c, reply); e != nil {
			t.Fatalf("%s read: %v", label, e)
		}
		if string(reply) != "ping" {
			t.Fatalf("%s reply %q", label, reply)
		}
		return time.Since(start)
	}

	first := roundTrip("第一条")
	second := roundTrip("第二条")
	t.Logf("主用是黑洞时：第一条连接 %v，紧接着第二条 %v", first.Round(time.Millisecond), second.Round(time.Millisecond))

	// 第一条必然要付一次握手超时 —— 主用是配置里的首选，总得先发现它死了。
	// 但只该付**一次**：以前会换个兼容上下文再等满一遍，硬生生翻倍。
	if first > fxpHandshakeTimeout+5*time.Second {
		t.Fatalf("切备用花了 %v，超过一次握手超时(%v)太多 —— 多半是又拿兼容上下文重等了一遍",
			first.Round(time.Millisecond), fxpHandshakeTimeout)
	}
	if second > time.Second {
		t.Fatalf("主用已经标记不健康了，第二条还花了 %v", second.Round(time.Millisecond))
	}

	// 过了重试窗口再来一条。以前这里会重新拿用户的连接去探那个死节点，
	// 于是又是满满一次 20 秒 —— 稳定流量下等于每隔几秒就有人卡二十秒。
	time.Sleep(fxpRecoverProbeGap + 500*time.Millisecond)
	third := roundTrip("窗口过后")
	t.Logf("健康重试窗口(%v)过后再来一条：%v", fxpRecoverProbeGap, third.Round(time.Millisecond))
	if third > time.Second {
		t.Fatalf("重试窗口过后那条连接花了 %v —— 探测又跑回用户路径上了", third.Round(time.Millisecond))
	}
}

// 连不上的出口每隔 recoverGap 探一次，不再越探越慢（阶段 2）：以前退避最长 2 分钟，出口恢复之后要等退避到期
// 才探第一下。探测在后台协程里，等多久都不占用户连接的时间。
func TestDownEndpointIsReprobedAtAFixedShortInterval(t *testing.T) {
	resetFXPEndpointRegistry()
	state := fxpEndpointStateFor(exitEndpoint{Host: "127.0.0.1", Port: 39001})
	for round := 0; round < 8; round++ {
		before := time.Now()
		state.markFailure(errTestEndpointDown)
		state.mu.Lock()
		wait := state.retryAfter.Sub(before)
		state.mu.Unlock()
		if wait < fxpRecoverProbeGap-50*time.Millisecond || wait > fxpRecoverProbeGap+time.Second {
			t.Fatalf("第 %d 次失败后应该 %v 后再探，实际 %v", round+1, fxpRecoverProbeGap, wait)
		}
	}
	// 规则带了「检测与切换」时按规则的来：几次不通算坏、恢复要连续通几次、多久探一次。
	release := state.watch(config{BalanceDetect: &balanceDetectConfig{IntervalSeconds: 1, FailThreshold: 4, RecoverThreshold: 5}})
	defer release()
	state.mu.Lock()
	tuning := state.tuning
	state.mu.Unlock()
	if tuning.fail != 4 || tuning.recover != 5 || tuning.recoverGap != time.Second {
		t.Fatalf("探测参数应该跟着规则的检测设置：%+v", tuning)
	}
	if got := fxpProbeTuningFor(config{}); got != defaultFXPProbeTuning() {
		t.Fatalf("没带检测设置用默认：%+v", got)
	}
}

// 出口恢复：连着 3 次探通（间隔 2 秒）就放回来 —— 黑洞结束后几秒内重新接新连接；一小时里来回断了 4 次起，
// 要从断开算起坏满 30 秒才放回来（抖动抑制），每多断一次翻倍。
func TestEndpointReadmissionIsQuickUnlessItFlaps(t *testing.T) {
	resetFXPEndpointRegistry()
	state := fxpEndpointStateFor(exitEndpoint{Host: "127.0.0.1", Port: 39002})
	state.markFailure(errTestEndpointDown)
	for i := 0; i < fxpRecoverProbes-1; i++ {
		state.probeSucceeded()
		if state.isHealthy() {
			t.Fatal("恢复要连着三次都通")
		}
	}
	state.probeSucceeded()
	if !state.isHealthy() {
		t.Fatal("连着三次探通应该恢复")
	}
	// 再断三次（一共四次）：进入抖动抑制，刚断的不会三次探通就放回来。
	for i := 0; i < 3; i++ {
		state.markFailure(errTestEndpointDown)
		if i < 2 {
			state.markHealthy()
		}
	}
	for i := 0; i < fxpRecoverProbes+2; i++ {
		state.probeSucceeded()
	}
	if state.isHealthy() {
		t.Fatal("一小时里断了四次的出口，刚断就连着探通也不该马上放回来")
	}
	// 坏满了抖动抑制要求的时长：放回来。
	state.mu.Lock()
	state.downAt = time.Now().Add(-fxpEndpointFlapPolicy.Base - time.Second)
	state.mu.Unlock()
	state.probeSucceeded()
	if !state.isHealthy() {
		t.Fatal("坏满 30 秒之后探通应该恢复")
	}
	// 用户流量走通了（markHealthy）不受抖动抑制限制：那是真凭实据。
	state.markFailure(errTestEndpointDown)
	state.markHealthy()
	if !state.isHealthy() {
		t.Fatal("真实连接走通了应该立刻算健康")
	}
}

func TestExitSelectorKeepsAFailedEndpointOffTheUserPath(t *testing.T) {
	resetFXPEndpointRegistry()
	selector := newExitEndpointSelector(
		[]exitEndpoint{{Host: "127.0.0.1", Port: 2}},
		exitEndpoint{Host: "127.0.0.1", Port: 1},
		"fallback",
	)
	selector.markFailure(0, errTestEndpointDown)

	// 「到点了」不等于「可以用了」：还有健康的可用时，坏节点不该再被派给用户。
	setEndpointRetryAfter(selector, 0, time.Now().Add(-time.Hour))
	if _, index, ok := selector.pick(nil); !ok || index != 1 {
		t.Fatalf("坏节点又被派给用户连接了：index=%d ok=%v", index, ok)
	}

	// 但它必须能被后台探测认领，而且一次只认领一个。
	endpoint, index, ok := selector.claimProbe(time.Now())
	if !ok || index != 0 || endpoint.Port != 1 {
		t.Fatalf("后台探测没认领到那个坏节点：index=%d ok=%v", index, ok)
	}
	if _, _, again := selector.claimProbe(time.Now()); again {
		t.Fatal("同一个坏节点被认领了两次 —— 一堆连接会一起往死节点上撞")
	}
	selector.releaseProbe(index)

	// 探通了就该回到用户路径上；fallback 策略会重新优先用它。
	selector.markHealthy(0)
	if _, back, ok := selector.pick(nil); !ok || back != 0 {
		t.Fatalf("探通之后没有回到首选：index=%d ok=%v", back, ok)
	}
	selector.states[0].mu.Lock()
	failures := selector.states[0].failures
	selector.states[0].mu.Unlock()
	if failures != 0 {
		t.Fatalf("恢复健康之后失败计数没清零：%d", failures)
	}
}

func TestExitSelectorStillUsesADownEndpointWhenNothingElseIsLeft(t *testing.T) {
	resetFXPEndpointRegistry()
	// 全都挂了的时候不能挑不出来 —— 那就等于直接拒绝服务。
	selector := newExitEndpointSelector(
		[]exitEndpoint{{Host: "127.0.0.1", Port: 2}},
		exitEndpoint{Host: "127.0.0.1", Port: 1},
		"fallback",
	)
	selector.markFailure(0, errTestEndpointDown)
	selector.markFailure(1, errTestEndpointDown)
	if _, _, ok := selector.pick(nil); !ok {
		t.Fatal("所有出口都不健康时挑不出端点，等于直接断服")
	}
}

var errTestEndpointDown = errors.New("endpoint down")

func TestExitSelectorStillRecoversWhereNothingProbes(t *testing.T) {
	resetFXPEndpointRegistry()
	/*
	   不是每条路都有后台探测可用。

	   UDP 直连那条路根本不拨号 —— 它只做一次地址解析就发包，没有「握手」这回事，
	   也就没有探测可言。所以「挂过、但冷却已经到期」这一档不能干脆去掉：真去掉了，
	   一次 DNS 抖动就能把那条规则的出口**永久**停用，而且日志上只会看到一次很久
	   以前的失败。

	   这条钉的就是这一档确实还在：两个出口都不健康，只有一个冷却到期，那就必须
	   挑到期的那个，而不是靠「全都不健康就随便选一个」的兜底撞上去。
	*/
	selector := newExitEndpointSelector(
		[]exitEndpoint{{Host: "127.0.0.1", Port: 2}},
		exitEndpoint{Host: "127.0.0.1", Port: 1},
		"fallback",
	)
	selector.markFailure(0, errTestEndpointDown)
	selector.markFailure(1, errTestEndpointDown)
	setEndpointRetryAfter(selector, 0, time.Now().Add(time.Hour))  // 首选还在冷却里
	setEndpointRetryAfter(selector, 1, time.Now().Add(-time.Hour)) // 备用冷却到期了

	if _, index, ok := selector.pick(nil); !ok || index != 1 {
		t.Fatalf("冷却到期的那个没被挑中：index=%d ok=%v —— 没有探测的路子就再也回不来了", index, ok)
	}
}

func TestRelayFallsBackToItsBackupDownstream(t *testing.T) {
	resetFXPEndpointRegistry()
	/*
	   中转这一跳和入口走的是同一个择优拨号函数，所以超时那套行为已经由上面
	   那条钉住了，这里不重复付一次十秒。

	   但「中转有没有真的接上择优」是独立的一件事 —— 它完全可以被人改成自己
	   拨号而测试不红。所以这条用最便宜的方式验一下接线：下一跳直接拒绝连接，
	   切备用应该是瞬间的。

	   端口 1 上不会有人监听，connect 立刻被拒，不像「先占一个再放掉」那样
	   存在被别的测试进程抢走的窗口。
	*/
	targetLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer targetLn.Close()
	go func() {
		for {
			c, e := targetLn.Accept()
			if e != nil {
				return
			}
			go func() { defer c.Close(); _, _ = io.Copy(c, c) }()
		}
	}()
	targetPort := targetLn.Addr().(*net.TCPAddr).Port

	upstreamKey := "relay-fallback-up"
	downstreamKey := "relay-fallback-down"
	exitPort := freeTCPPort(t)
	relayPort := freeTCPPort(t)
	entryPort := freeTCPPort(t)
	exitDone, relayDone, entryDone := make(chan struct{}), make(chan struct{}), make(chan struct{})
	defer close(exitDone)
	defer close(relayDone)
	defer close(entryDone)

	go func() {
		_ = runExit(exitDone, config{
			Role: "exit", TunnelID: 3, ListenPort: exitPort, Protocol: "tcp", Key: downstreamKey, StreamTargets: loopbackStreamTargets(4, targetPort),
		})
	}()
	waitForTCP(t, exitPort)
	go func() {
		_ = runRelay(relayDone, config{
			Role: "relay", TunnelID: 3, ListenPort: relayPort, Protocol: "tcp", Key: upstreamKey,
			RelayExitHost: "127.0.0.1", RelayExitPort: 1, RelayKey: downstreamKey,
			ExitStrategy: "fallback",
			Exits:        []exitEndpoint{{Host: "127.0.0.1", Port: exitPort, Key: downstreamKey}},
		})
	}()
	waitForTCP(t, relayPort)
	go func() {
		_ = runEntry(entryDone, config{
			Role: "entry", TunnelID: 3, RuleID: 4, ListenPort: entryPort, Protocol: "tcp",
			ExitHost: "127.0.0.1", ExitPort: relayPort, Key: upstreamKey,
			TargetIP: "127.0.0.1", TargetPort: targetPort,
		})
	}()
	waitForTCP(t, entryPort)

	start := time.Now()
	c, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(entryPort)), 20*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(20 * time.Second))
	if _, err := c.Write([]byte("relay")); err != nil {
		t.Fatal(err)
	}
	reply := make([]byte, 5)
	if _, err := io.ReadFull(c, reply); err != nil {
		t.Fatalf("中转没有切到备用落地：%v", err)
	}
	if string(reply) != "relay" {
		t.Fatalf("unexpected reply %q", reply)
	}
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("下一跳是直接拒绝连接，切备用却花了 %v", elapsed.Round(time.Millisecond))
	}
}
