package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

// 出口组「延迟优先 · 只走最快的一台」：整链（入口到出口 1ms + 出口到目标）是 chains 里的毫秒数。
func fastestTestProxy(chains ...int) *failoverProxy {
	spec := exitGroupSpec("latency", len(chains))
	spec.FastestOnly = true
	spec.LatencyMarginMs = 50
	proxy := routeTestProxy(spec)
	now := time.Now()
	for i, chain := range chains {
		proxy.spec.Targets[i].ExtraLatencyMs = chain - 1
		proxy.stats[i].recordProbe(true, 1, now)
		proxy.lastLatencyMs[i] = 1
	}
	return proxy
}

func fastestPickCounts(proxy *failoverProxy, n int, udp bool) []int {
	counts := make([]int, len(proxy.spec.Targets))
	for i := 0; i < n; i++ {
		_, index, _ := proxy.pickReserved(fmt.Sprintf("203.0.113.%d", i), nil, udp)
		counts[index]++
	}
	return counts
}

func TestExitGroupFastestOnlyPicksOnlyTheFastest(t *testing.T) {
	proxy := fastestTestProxy(3, 4, 60, 90)
	if counts := fastestPickCounts(proxy, 60, false); counts[0] != 60 {
		t.Fatalf("整链 3/4/60/90ms：只该走最快的第 1 台，实际 %v", counts)
	}
	if counts := fastestPickCounts(proxy, 20, true); counts[0] != 20 {
		t.Fatalf("UDP 新会话也只走同一台，实际 %v", counts)
	}
	// 不开时 3ms 和 4ms 一样快，两台一起分
	plain := fastestTestProxy(3, 4, 60, 90)
	plain.spec.FastestOnly = false
	if counts := fastestPickCounts(plain, 60, false); counts[0] == 0 || counts[1] == 0 || counts[2] != 0 || counts[3] != 0 {
		t.Fatalf("没开只走最快的一台：一样快的两台都该分到，实际 %v", counts)
	}
}

func TestExitGroupFastestOnlySlightlyFasterChallengerDoesNotTakeOver(t *testing.T) {
	proxy := fastestTestProxy(3, 4, 60)
	start := time.Now()
	proxy.mu.Lock()
	if index := proxy.evaluateFastestLocked(start, "test"); index != 0 {
		proxy.mu.Unlock()
		t.Fatalf("起步应当是最快的第 1 台，得到 %d", index)
	}
	// 第 2 台变成 2ms（快 1ms）：十分钟里都不换
	proxy.spec.Targets[1].ExtraLatencyMs = 1
	for minute := 0; minute <= 10; minute++ {
		if index := proxy.evaluateFastestLocked(start.Add(time.Duration(minute)*time.Minute), "test"); index != 0 {
			proxy.mu.Unlock()
			t.Fatalf("快 1ms 不该换过去（第 %d 分钟换到了 %d）", minute, index)
		}
	}
	proxy.mu.Unlock()
	if counts := fastestPickCounts(proxy, 20, false); counts[0] != 20 {
		t.Fatalf("新连接还该走第 1 台，实际 %v", counts)
	}
}

func TestExitGroupFastestOnlyMuchFasterChallengerTakesOverAfterTheHold(t *testing.T) {
	proxy := fastestTestProxy(100, 120, 200)
	start := time.Now()
	proxy.mu.Lock()
	defer proxy.mu.Unlock()
	if index := proxy.evaluateFastestLocked(start, "test"); index != 0 {
		t.Fatalf("起步应当是最快的第 1 台，得到 %d", index)
	}
	// 第 3 台变成 40ms：快出 60ms、快六成，照样要稳住 60 秒
	proxy.spec.Targets[2].ExtraLatencyMs = 39
	for _, after := range []time.Duration{time.Second, 10 * time.Second, 30 * time.Second, 59 * time.Second} {
		if index := proxy.evaluateFastestLocked(start.Add(after), "test"); index != 0 {
			t.Fatalf("%s：还没稳住 60 秒就换到了 %d", after, index)
		}
	}
	if index := proxy.evaluateFastestLocked(start.Add(61*time.Second), "test"); index != 2 {
		t.Fatalf("稳住 60 秒后该换到第 3 台，得到 %d", index)
	}
	_, index := proxy.pickLocked("", nil, false)
	if index != 2 {
		t.Fatalf("换过去以后新连接该走第 3 台，得到 %d", index)
	}
}

func TestExitGroupFastestOnlyCurrentDownTakesTheNextFastestAtOnce(t *testing.T) {
	proxy := fastestTestProxy(3, 4, 60)
	if counts := fastestPickCounts(proxy, 5, false); counts[0] != 5 {
		t.Fatalf("起步该走第 1 台：%v", counts)
	}
	proxy.mu.Lock()
	proxy.targetHealth[0] = false
	proxy.updateFallbackActiveLocked("health check")
	current, _ := proxy.lbFastest.Current()
	proxy.mu.Unlock()
	if current != 1 {
		t.Fatalf("在用的坏了，探测一轮后该当场换到次快的第 2 台，得到 %d", current)
	}
	if counts := fastestPickCounts(proxy, 10, false); counts[1] != 10 {
		t.Fatalf("新连接该全走第 2 台：%v", counts)
	}
	// 第 1 台恢复了、只快 1ms：留在第 2 台
	proxy.mu.Lock()
	proxy.targetHealth[0] = true
	proxy.mu.Unlock()
	if counts := fastestPickCounts(proxy, 10, false); counts[1] != 10 {
		t.Fatalf("恢复的那台只快 1ms，不该切回：%v", counts)
	}
}

func TestExitGroupFastestOnlyRetryWithExcludeDoesNotMoveTheActiveExit(t *testing.T) {
	proxy := fastestTestProxy(3, 4, 60)
	fastestPickCounts(proxy, 1, false)
	if _, index := proxy.pickTargetForKey("", map[int]bool{0: true}); index != 1 {
		t.Fatalf("这条连接拨第 1 台失败、换路重拨：该给次快的第 2 台，得到 %d", index)
	}
	proxy.mu.Lock()
	current, _ := proxy.lbFastest.Current()
	proxy.mu.Unlock()
	if current != 0 {
		t.Fatalf("换路重拨不该挪「在用的」，得到 %d", current)
	}
}

func TestExitGroupFastestOnlyPinStillWins(t *testing.T) {
	proxy := fastestTestProxy(3, 4, 60)
	pinned := 2
	proxy.spec.PinnedIndex = &pinned
	if counts := fastestPickCounts(proxy, 10, false); counts[2] != 10 {
		t.Fatalf("手动指定了第 3 台：%v", counts)
	}
}

func TestExitGroupFastestOnlyReportsOneActiveExit(t *testing.T) {
	proxy := fastestTestProxy(60, 3, 4)
	_, strategy, exits, ok := proxy.balanceSnapshot()
	if !ok || strategy != "latency" {
		t.Fatalf("应当报延迟优先：ok=%v strategy=%q", ok, strategy)
	}
	states := []string{exits[0].State, exits[1].State, exits[2].State}
	if strings.Join(states, ",") != "standby,active,standby" {
		t.Fatalf("只有最快的那台在用，别的候补：%v", states)
	}
	// 不开时能用的都是 active（和以前一样）
	proxy.spec.FastestOnly = false
	_, _, exits, _ = proxy.balanceSnapshot()
	for i, exit := range exits {
		if exit.State != "active" {
			t.Fatalf("没开只走最快的一台：第 %d 台应当是 active，得到 %s", i+1, exit.State)
		}
	}
}

func TestExitGroupFastestOnlyIsInTheSignatureOnlyWhenOn(t *testing.T) {
	spec := normalizeFailoverSpec(exitGroupSpec("latency", 3))
	off := failoverSignature(spec)
	spec.FastestOnly = true
	if failoverSignature(spec) == off {
		t.Fatal("开了只走最快的一台，签名该变（规格要换上去）")
	}
	var decoded failoverSpec
	if err := json.Unmarshal([]byte(`{"strategy":"latency","fastestOnly":true}`), &decoded); err != nil || !decoded.FastestOnly {
		t.Fatalf("规格里的 fastestOnly 读不出来：%v %+v", err, decoded)
	}
}

// 面板的检测参数原样转给 FXP：fastestOnly、targetProbeSeconds 都不能在 Agent 这一道被丢掉。
func TestFXPBalanceDetectPassesFastestOnlyAndTargetProbe(t *testing.T) {
	var detect fxpBalanceDetect
	if err := json.Unmarshal([]byte(`{"intervalSeconds":2,"targetProbeSeconds":10,"latencyMarginMs":50,"fastestOnly":true}`), &detect); err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(detect)
	for _, want := range []string{`"targetProbeSeconds":10`, `"fastestOnly":true`} {
		if !strings.Contains(string(encoded), want) {
			t.Fatalf("转给 FXP 的检测参数里少了 %s：%s", want, encoded)
		}
	}
	plain := fxpBalanceDetect{IntervalSeconds: 2, LatencyMarginMs: 50}
	if sig := plain.signature(); strings.Contains(sig, "fastest") || strings.Contains(sig, "target=") {
		t.Fatalf("没带的两项不进签名：%s", sig)
	}
	if sig := detect.signature(); !strings.Contains(sig, "fastest") || !strings.Contains(sig, "target=10") {
		t.Fatalf("带了的进签名：%s", sig)
	}
}
