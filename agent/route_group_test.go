package main

import (
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

/*
线路组在 Agent 这一侧的行为：评分、连续失败阈值、权重分配、中转提示、计划切换的预热
与预检、人工指定到期、换规格保留状态、断旧连接、统计快照。

时段表相关的用例照样把「现在几点」当参数传进去（见 updateFallbackActiveAtLocked 上的说明）。
*/

var routeTestZone = time.FixedZone("CST", 8*3600)

func routeTargets(count int) []failoverTarget {
	targets := make([]failoverTarget, 0, count)
	for i := 0; i < count; i++ {
		targets = append(targets, failoverTarget{TargetIP: "10.0.0." + strconv.Itoa(i+1), TargetPort: 80})
	}
	return targets
}

func routeTestProxy(spec failoverSpec) *failoverProxy {
	if spec.BindAddress == "" {
		spec.BindAddress = "127.0.0.1"
	}
	if spec.ListenPort == 0 {
		spec.ListenPort = 64100
	}
	spec.Enabled = true
	proxy := &failoverProxy{ruleID: 95, sourcePort: 21005, spec: normalizeFailoverSpec(spec)}
	proxy.ensureHealthStateLocked()
	return proxy
}

func routeEventsOfKind(events []failoverProxyEvent, kind string) []failoverProxyEvent {
	out := []failoverProxyEvent{}
	for _, event := range events {
		if event.Kind == kind {
			out = append(out, event)
		}
	}
	return out
}

// 评分公式和面板共用一张用例表：谁改出了偏差，谁那边红。
func TestRouteScoreSharedCases(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "shared", "routeScore.cases.json"))
	if err != nil {
		t.Fatalf("读共用用例表: %v", err)
	}
	var fixture struct {
		Cases []struct {
			Name            string   `json:"name"`
			LatencyMs       *float64 `json:"latencyMs"`
			LossPct         float64  `json:"lossPct"`
			JitterMs        float64  `json:"jitterMs"`
			AvailabilityPct float64  `json:"availabilityPct"`
			Healthy         bool     `json:"healthy"`
			LoadPct         float64  `json:"loadPct"`
			Expected        *int     `json:"expected"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("解析共用用例表: %v", err)
	}
	if len(fixture.Cases) < 8 {
		t.Fatalf("用例表只读到 %d 条，路径大概不对", len(fixture.Cases))
	}
	for _, testCase := range fixture.Cases {
		latency := 0.0
		if testCase.LatencyMs != nil {
			latency = *testCase.LatencyMs
		}
		actual, scored := routeScore(latency, testCase.LatencyMs != nil, testCase.LossPct, testCase.JitterMs, testCase.AvailabilityPct, testCase.Healthy, testCase.LoadPct)
		if testCase.Expected == nil {
			if scored {
				t.Errorf("%s：应当不打分，拿到 %d", testCase.Name, actual)
			}
			continue
		}
		if !scored || actual != *testCase.Expected {
			t.Errorf("%s：期望 %d，拿到 %d（scored=%v）", testCase.Name, *testCase.Expected, actual, scored)
		}
	}
}

func TestRouteStatsSummaryUsesMedianAndCountsLoss(t *testing.T) {
	stats := &routeTargetStats{}
	at := time.Now()
	for i, latency := range []int{50, 52, 900, 48, 51} {
		stats.recordProbe(true, latency, at.Add(time.Duration(i)*5*time.Second))
	}
	stats.recordProbe(false, 0, at.Add(30*time.Second))
	summary := stats.summary()
	if summary.latencyMs != 51 {
		t.Fatalf("一次 900ms 的尖峰不该把延迟拉走：中位数应当是 51，拿到 %d", summary.latencyMs)
	}
	if summary.samples != 6 || summary.lossPct < 16 || summary.lossPct > 17 {
		t.Fatalf("6 次里丢 1 次应当是 16.7%%，拿到 %.1f%%（样本 %d）", summary.lossPct, summary.samples)
	}
	if summary.jitterMs <= 0 {
		t.Fatal("有尖峰就该有抖动")
	}
	if stats.consecutiveFailures != 1 {
		t.Fatalf("连续失败应当是 1，拿到 %d", stats.consecutiveFailures)
	}
	stats.recordProbe(true, 50, at.Add(35*time.Second))
	if stats.consecutiveFailures != 0 {
		t.Fatal("探通一次就该清零")
	}
}

/*
「失败 1 次不切，连续失败 3 次标记异常」。

一次拨号失败在公网上太常见了；上一版拨不通一次就把那条出站标成坏的，等于把抖动放大成切换。
那条连接本身照样换下一条出站去拨，客户端不会因此失败 —— 变的只是「要不要因此换首选」。
*/
func TestFailureThresholdNeedsConsecutiveFailures(t *testing.T) {
	drainFailoverEvents()
	proxy := routeTestProxy(failoverSpec{Strategy: "fallback", AutoFailback: true, Targets: routeTargets(2), FailureThreshold: 3})

	proxy.markTargetFailure(0, "dial failed")
	proxy.markTargetFailure(0, "dial failed")
	proxy.mu.RLock()
	healthy, active := proxy.targetHealth[0], proxy.activeIndex
	proxy.mu.RUnlock()
	if !healthy || active != 0 {
		t.Fatalf("拨号失败 2 次就标记异常了：healthy=%v active=%d", healthy, active)
	}
	if events := drainFailoverEvents(); len(events) != 0 {
		t.Fatalf("没到阈值不该报事件：%+v", events)
	}

	proxy.markTargetFailure(0, "dial failed")
	proxy.mu.RLock()
	healthy, active = proxy.targetHealth[0], proxy.activeIndex
	proxy.mu.RUnlock()
	if healthy || active != 1 {
		t.Fatalf("连续失败 3 次应当标记异常并切走：healthy=%v active=%d", healthy, active)
	}
	events := drainFailoverEvents()
	if len(routeEventsOfKind(events, "unhealthy")) != 1 || len(routeEventsOfKind(events, "switch")) != 1 {
		t.Fatalf("应当正好一条异常、一条切换：%+v", events)
	}
	if switched := routeEventsOfKind(events, "switch")[0]; switched.Reason != "dial failed" || switched.FromIndex != 0 || switched.ToIndex != 1 {
		t.Fatalf("切换事件没带原因和序号：%+v", switched)
	}
}

// 探测那一侧同样要连续够次数：时间够了、次数不够也不算。
func TestHealthCheckThresholdCountsProbes(t *testing.T) {
	closedPort := refusingTestPort(t)
	openListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer openListener.Close()
	openPort := openListener.Addr().(*net.TCPAddr).Port
	proxy := routeTestProxy(failoverSpec{
		Strategy: "fallback", FailoverSeconds: 1, RecoverSeconds: 1, FailureThreshold: 3,
		Targets: []failoverTarget{{TargetIP: "127.0.0.1", TargetPort: closedPort}, {TargetIP: "127.0.0.1", TargetPort: openPort}},
	})

	proxy.checkHealth()
	time.Sleep(1100 * time.Millisecond)
	proxy.checkHealth()
	proxy.mu.RLock()
	healthy := proxy.targetHealth[0]
	proxy.mu.RUnlock()
	if !healthy {
		t.Fatal("时间够了但只失败 2 次，不该标记异常")
	}
	proxy.checkHealth()
	proxy.mu.RLock()
	healthy = proxy.targetHealth[0]
	proxy.mu.RUnlock()
	if healthy {
		t.Fatal("连续失败 3 次且持续够久，应当标记异常")
	}
}

// 权重负载：新连接按权重分，挂了的那条不分。
func TestWeightedPickFollowsWeights(t *testing.T) {
	targets := routeTargets(2)
	targets[0].Weight = 90
	targets[1].Weight = 10
	proxy := routeTestProxy(failoverSpec{Strategy: "weighted", Targets: targets})
	counts := [2]int{}
	for i := 0; i < 2000; i++ {
		_, index := proxy.pickTarget(nil, nil)
		counts[index]++
	}
	share := counts[0] * 100 / 2000
	if share < 82 || share > 97 {
		t.Fatalf("90/10 的权重分出来是 %d%%/%d%%", share, 100-share)
	}
	proxy.mu.Lock()
	proxy.targetHealth[0] = false
	proxy.mu.Unlock()
	for i := 0; i < 50; i++ {
		if _, index := proxy.pickTarget(nil, nil); index != 0 {
			continue
		}
		t.Fatal("挂了的出站还在分新连接")
	}
}

/*
面板从中转机的探测得知路径中段挂了，把这条出站标成 down 下发。

提示不能进签名：进了的话每次提示变化都会重建代理，探测样本和「现在走哪条」全部归零。
所以同一份规格带着不同的提示下发，代理必须是原来那个，只是这条出站按不可用处理。
*/
func TestRelayHintMarksTargetDownWithoutRebuild(t *testing.T) {
	oldPersistentDir := persistentFailoverDir
	persistentFailoverDir = filepath.Join(t.TempDir(), "failover")
	t.Cleanup(func() { persistentFailoverDir = oldPersistentDir })
	const ruleID = 930001
	const sourcePort = 63001
	t.Cleanup(func() { stopFailoverProxy(ruleID, sourcePort) })

	spec := failoverTestSpec(failoverTestPort(t))
	if !startFailoverProxy(ruleID, sourcePort, spec, nil) {
		t.Fatal("代理没起来")
	}
	before := currentFailoverProxy(ruleID, sourcePort)
	drainFailoverEvents()

	hinted := spec
	hinted.Targets = append([]failoverTarget(nil), spec.Targets...)
	hinted.Targets[0].Down = true
	hinted.Targets[0].DownReason = "JP relay"
	if failoverSignature(normalizeFailoverSpec(hinted)) != failoverSignature(normalizeFailoverSpec(spec)) {
		t.Fatal("中转提示进了签名，每次提示变化都会重建代理")
	}
	if !startFailoverProxy(ruleID, sourcePort, hinted, nil) {
		t.Fatal("带提示重新下发失败")
	}
	after := currentFailoverProxy(ruleID, sourcePort)
	if after != before {
		t.Fatal("带提示下发重建了代理")
	}
	after.mu.RLock()
	active, down := after.activeIndex, after.relayDown[0]
	after.mu.RUnlock()
	if !down || active != 1 {
		t.Fatalf("被面板标掉的出站没被绕开：down=%v active=%d", down, active)
	}
	events := drainFailoverEvents()
	unhealthy := routeEventsOfKind(events, "unhealthy")
	switched := routeEventsOfKind(events, "switch")
	if len(unhealthy) != 1 || unhealthy[0].Reason != "relay down: JP relay" {
		t.Fatalf("应当报一条带中转名字的异常：%+v", events)
	}
	if len(switched) != 1 || switched[0].Reason != "relay down: JP relay" {
		t.Fatalf("切换原因应当写明中转异常：%+v", events)
	}

	// 面板把提示清掉：出站恢复，首选回来。
	if !startFailoverProxy(ruleID, sourcePort, spec, nil) {
		t.Fatal("清掉提示重新下发失败")
	}
	after.mu.RLock()
	active, down = after.activeIndex, after.relayDown[0]
	after.mu.RUnlock()
	if down || active != 0 {
		t.Fatalf("提示清掉之后应当回到主出站：down=%v active=%d", down, active)
	}
	events = drainFailoverEvents()
	if recovered := routeEventsOfKind(events, "recovered"); len(recovered) != 1 || recovered[0].Reason != "relay recovered" {
		t.Fatalf("应当报一条中转恢复：%+v", events)
	}
	if switched := routeEventsOfKind(events, "switch"); len(switched) != 1 || switched[0].Reason != "failback" {
		t.Fatalf("切回主出站的原因应当是 failback：%+v", events)
	}
}

func precheckProxy(prewarmSeconds int) *failoverProxy {
	return routeTestProxy(failoverSpec{
		Strategy: "fallback", AutoFailback: true, Targets: routeTargets(2),
		Schedule: eveningSchedule(1), PrewarmSeconds: prewarmSeconds,
	})
}

/*
计划切换先预检：到点那一刻 B 探不通，就不切，记一条「计划切换未执行」，继续走 A；
B 好了再切，原因写「按时段表」。同一次计划只报一次，不能每 5 秒刷一条。
*/
func TestPrecheckHoldsPlannedSwitch(t *testing.T) {
	drainFailoverEvents()
	proxy := precheckProxy(300)
	evening := time.Date(2026, 9, 21, 19, 0, 0, 0, routeTestZone)
	proxy.mu.Lock()
	defer proxy.mu.Unlock()

	proxy.statsLocked(1).recordProbe(false, 0, evening.Add(-5*time.Second))
	proxy.updateFallbackActiveAtLocked(evening, "health check")
	if proxy.activeIndex != 0 {
		t.Fatalf("预检没过还是切了：active=%d", proxy.activeIndex)
	}
	events := drainFailoverEvents()
	held := routeEventsOfKind(events, "precheck_failed")
	if len(held) != 1 || held[0].ToIndex != 1 || held[0].Reason != "precheck: unreachable" {
		t.Fatalf("应当正好一条预检未通过：%+v", events)
	}
	proxy.updateFallbackActiveAtLocked(evening.Add(5*time.Second), "health check")
	if events := drainFailoverEvents(); len(events) != 0 {
		t.Fatalf("同一次计划不该重复报：%+v", events)
	}

	proxy.statsLocked(1).recordProbe(true, 40, evening.Add(10*time.Second))
	proxy.updateFallbackActiveAtLocked(evening.Add(10*time.Second), "health check")
	if proxy.activeIndex != 1 {
		t.Fatalf("B 探通之后应当切过去：active=%d", proxy.activeIndex)
	}
	switched := routeEventsOfKind(drainFailoverEvents(), "switch")
	if len(switched) != 1 || switched[0].Reason != "schedule" {
		t.Fatalf("切换原因应当是 schedule：%+v", switched)
	}
}

// 探得通但丢包 20%：计划切换照样不执行，原因写明丢包。
func TestPrecheckRejectsLossyPath(t *testing.T) {
	drainFailoverEvents()
	proxy := precheckProxy(300)
	evening := time.Date(2026, 9, 21, 19, 0, 0, 0, routeTestZone)
	proxy.mu.Lock()
	defer proxy.mu.Unlock()
	for i := 0; i < 10; i++ {
		proxy.statsLocked(1).recordProbe(i%5 != 0, 50, evening.Add(time.Duration(i-10)*5*time.Second))
	}
	if issue := proxy.precheckIssueLocked(1); issue != "loss 20%" {
		t.Fatalf("预检应当报丢包，拿到 %q", issue)
	}
	proxy.updateFallbackActiveAtLocked(evening, "health check")
	if proxy.activeIndex != 0 {
		t.Fatal("丢包 20% 的线路不该被计划切换选中")
	}
}

// 不预热（PrewarmSeconds=0）就是上一版的行为：到点直接切，不预检。
func TestNoPrewarmSwitchesWithoutPrecheck(t *testing.T) {
	proxy := precheckProxy(0)
	evening := time.Date(2026, 9, 21, 19, 0, 0, 0, routeTestZone)
	proxy.mu.Lock()
	defer proxy.mu.Unlock()
	proxy.statsLocked(1).recordProbe(false, 0, evening.Add(-5*time.Second))
	proxy.updateFallbackActiveAtLocked(evening, "health check")
	if proxy.activeIndex != 1 {
		t.Fatalf("不预检的规格到点就该切：active=%d", proxy.activeIndex)
	}
}

// 计划切换前 5 分钟报一条「预热」，只报一次；到点切了之后预热状态清掉。
func TestPrewarmReportsUpcomingSwitch(t *testing.T) {
	drainFailoverEvents()
	proxy := precheckProxy(300)
	day := time.Date(2026, 9, 21, 0, 0, 0, 0, routeTestZone)
	at := func(hour, minute int) time.Time {
		return day.Add(time.Duration(hour)*time.Hour + time.Duration(minute)*time.Minute)
	}
	proxy.mu.Lock()
	defer proxy.mu.Unlock()

	proxy.updateFallbackActiveAtLocked(at(17, 50), "health check")
	if events := drainFailoverEvents(); len(events) != 0 || proxy.prewarmIndex != -1 {
		t.Fatalf("离切换还有 10 分钟，不该预热：%+v prewarm=%d", events, proxy.prewarmIndex)
	}
	proxy.updateFallbackActiveAtLocked(at(17, 56), "health check")
	prewarm := routeEventsOfKind(drainFailoverEvents(), "prewarm")
	if len(prewarm) != 1 || prewarm[0].ToIndex != 1 || proxy.prewarmIndex != 1 {
		t.Fatalf("离切换 4 分钟应当预热 B：%+v prewarm=%d", prewarm, proxy.prewarmIndex)
	}
	proxy.updateFallbackActiveAtLocked(at(17, 57), "health check")
	if events := drainFailoverEvents(); len(events) != 0 {
		t.Fatalf("预热只报一次：%+v", events)
	}
	proxy.updateFallbackActiveAtLocked(at(18, 0), "health check")
	if proxy.activeIndex != 1 || proxy.prewarmIndex != -1 {
		t.Fatalf("到点应当切过去并清掉预热：active=%d prewarm=%d", proxy.activeIndex, proxy.prewarmIndex)
	}
}

// 人工指定到期：报一条「指定到期」，切回去的原因也写「指定到期」。
func TestPinExpiryReportsUnpinned(t *testing.T) {
	drainFailoverEvents()
	pinned := 1
	base := time.Date(2026, 9, 21, 12, 0, 0, 0, time.UTC)
	proxy := routeTestProxy(failoverSpec{
		Strategy: "fallback", AutoFailback: true, Targets: routeTargets(2),
		PinnedIndex: &pinned, PinnedUntil: base.Add(10 * time.Minute).UnixMilli(),
	})
	proxy.mu.Lock()
	defer proxy.mu.Unlock()
	proxy.updateFallbackActiveAtLocked(base, "health check")
	if proxy.activeIndex != 1 {
		t.Fatalf("指定了 B 却没走 B：active=%d", proxy.activeIndex)
	}
	if switched := routeEventsOfKind(drainFailoverEvents(), "switch"); len(switched) != 1 || switched[0].Reason != "pin" {
		t.Fatalf("按指定切换的原因应当是 pin：%+v", switched)
	}
	proxy.updateFallbackActiveAtLocked(base.Add(11*time.Minute), "health check")
	events := drainFailoverEvents()
	if unpinned := routeEventsOfKind(events, "unpinned"); len(unpinned) != 1 || unpinned[0].Reason != "pin expired" || unpinned[0].ToIndex != 1 {
		t.Fatalf("到期应当报一条 unpinned：%+v", events)
	}
	if switched := routeEventsOfKind(events, "switch"); len(switched) != 1 || switched[0].Reason != "pin expired" || proxy.activeIndex != 0 {
		t.Fatalf("到期应当切回主线路且原因写明到期：%+v active=%d", switched, proxy.activeIndex)
	}
}

// 人工指定不等最短驻留：人说了算。往回切照样要等。
func TestPinIsNotDelayedByMinHold(t *testing.T) {
	now := time.Now()
	pinned := 1
	proxy := routeTestProxy(failoverSpec{Strategy: "fallback", AutoFailback: true, Targets: routeTargets(2), MinHoldSeconds: 600, PinnedIndex: &pinned})
	proxy.mu.Lock()
	proxy.lastSwitchAt = now
	proxy.updateFallbackActiveAtLocked(now, "health check")
	active := proxy.activeIndex
	proxy.mu.Unlock()
	if active != 1 {
		t.Fatalf("人工指定被最短驻留拦住了：active=%d", active)
	}

	plain := routeTestProxy(failoverSpec{Strategy: "fallback", AutoFailback: true, Targets: routeTargets(2), MinHoldSeconds: 600})
	plain.mu.Lock()
	plain.activeIndex = 1
	plain.lastSwitchAt = now
	plain.updateFallbackActiveAtLocked(now, "health check")
	active = plain.activeIndex
	plain.mu.Unlock()
	if active != 1 {
		t.Fatalf("最短驻留没拦住往回切：active=%d", active)
	}
}

// 「首选恢复后切不切回」只管切回这件事，压不住时段表和人工指定。
func TestAutoFailbackOffStillHonoursSchedule(t *testing.T) {
	proxy := routeTestProxy(failoverSpec{Strategy: "fallback", AutoFailback: false, Targets: routeTargets(2), Schedule: eveningSchedule(1)})
	evening := time.Date(2026, 9, 21, 19, 0, 0, 0, routeTestZone)
	proxy.mu.Lock()
	defer proxy.mu.Unlock()
	proxy.updateFallbackActiveAtLocked(evening, "health check")
	if proxy.activeIndex != 1 {
		t.Fatalf("关了自动切回，时段表也该生效：active=%d", proxy.activeIndex)
	}
	proxy.activeIndex = 1
	proxy.updateFallbackActiveAtLocked(evening.Add(6*time.Hour), "health check")
	if proxy.activeIndex != 1 {
		t.Fatal("关了自动切回，时段结束就不该拽回主线路")
	}
}

/*
换规格原地换：没变的出站把健康、样本和「现在走哪条」带过去；活跃那条被拿掉了才回到第 0 条。
改一下时段表不该把正走着备线的流量拽回（可能正挂着的）主线。
*/
func TestRespecKeepsActiveLineAndSamples(t *testing.T) {
	proxy := routeTestProxy(failoverSpec{Strategy: "fallback", AutoFailback: true, Targets: routeTargets(3)})
	now := time.Now()
	proxy.mu.Lock()
	defer proxy.mu.Unlock()
	proxy.activeIndex = 1
	proxy.activeSince = now.Add(-time.Hour)
	proxy.statsLocked(1).recordProbe(true, 42, now)
	proxy.targetHealth[2] = false

	respec := proxy.spec
	respec.FailoverSeconds = 90
	respec.Targets = append(append([]failoverTarget(nil), proxy.spec.Targets...), failoverTarget{TargetIP: "10.0.0.9", TargetPort: 80})
	proxy.rebuildForSpecLocked(normalizeFailoverSpec(respec), now)
	if proxy.activeIndex != 1 || !proxy.activeSince.Equal(now.Add(-time.Hour)) {
		t.Fatalf("换规格把活跃线路重置了：active=%d since=%v", proxy.activeIndex, proxy.activeSince)
	}
	if len(proxy.targetHealth) != 4 || proxy.targetHealth[2] || !proxy.targetHealth[3] {
		t.Fatalf("健康状态没带过去：%v", proxy.targetHealth)
	}
	if proxy.statsLocked(1).summary().samples != 1 {
		t.Fatal("探测样本没带过去")
	}

	dropped := proxy.spec
	dropped.Targets = []failoverTarget{proxy.spec.Targets[0], proxy.spec.Targets[2]}
	proxy.rebuildForSpecLocked(normalizeFailoverSpec(dropped), now)
	if proxy.activeIndex != 0 || !proxy.activeSince.Equal(now) {
		t.Fatalf("活跃那条被拿掉了应当回到第 0 条并重新计时：active=%d", proxy.activeIndex)
	}
	if proxy.targetHealth[1] {
		t.Fatal("原来第 2 条（挂着）挪到第 1 位，健康状态应当跟着挪")
	}
}

/*
强制切换断旧连接：切换之后走旧线路的客户端连接被关掉，客户端读到 EOF 后重连就走新线路。
平滑切换（默认）什么都不动。
*/
func TestForceSwitchClosesOldConnections(t *testing.T) {
	oldPersistentDir := persistentFailoverDir
	persistentFailoverDir = filepath.Join(t.TempDir(), "failover")
	t.Cleanup(func() { persistentFailoverDir = oldPersistentDir })

	accept := func(t *testing.T) (net.Listener, int) {
		t.Helper()
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatalf("listen: %v", err)
		}
		go func() {
			for {
				conn, err := listener.Accept()
				if err != nil {
					return
				}
				go func(conn net.Conn) {
					buf := make([]byte, 1)
					_, _ = conn.Read(buf)
					_ = conn.Close()
				}(conn)
			}
		}()
		return listener, listener.Addr().(*net.TCPAddr).Port
	}
	for _, mode := range []string{"force", "smooth"} {
		t.Run(mode, func(t *testing.T) {
			listenerA, portA := accept(t)
			defer listenerA.Close()
			listenerB, portB := accept(t)
			defer listenerB.Close()
			ruleID := 940001
			sourcePort := 64001
			if mode == "smooth" {
				ruleID, sourcePort = 940002, 64002
			}
			t.Cleanup(func() { stopFailoverProxy(ruleID, sourcePort) })
			spec := failoverTestSpec(failoverTestPort(t))
			spec.SwitchMode = mode
			spec.Targets = []failoverTarget{{TargetIP: "127.0.0.1", TargetPort: portA}, {TargetIP: "127.0.0.1", TargetPort: portB}}
			if !startFailoverProxy(ruleID, sourcePort, spec, nil) {
				t.Fatal("代理没起来")
			}
			client, err := net.Dial("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(spec.ListenPort)))
			if err != nil {
				t.Fatalf("连代理: %v", err)
			}
			defer client.Close()
			proxy := currentFailoverProxy(ruleID, sourcePort)
			deadline := time.Now().Add(3 * time.Second)
			for {
				proxy.mu.RLock()
				tracked := proxy.connectionsLocked(0)
				proxy.mu.RUnlock()
				if tracked == 1 {
					break
				}
				if time.Now().After(deadline) {
					t.Fatalf("代理没把这条连接记到出站 0 名下（记了 %d 条）", tracked)
				}
				time.Sleep(10 * time.Millisecond)
			}
			proxy.mu.Lock()
			proxy.setActiveLocked(1, "test")
			proxy.mu.Unlock()

			_ = client.SetReadDeadline(time.Now().Add(1500 * time.Millisecond))
			_, err = client.Read(make([]byte, 1))
			if mode == "force" {
				if err == nil {
					t.Fatal("强制切换之后旧连接应当被关掉")
				}
				if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
					t.Fatal("强制切换之后旧连接还活着（读超时而不是断开）")
				}
			} else {
				netErr, ok := err.(net.Error)
				if !ok || !netErr.Timeout() {
					t.Fatalf("平滑切换不该动旧连接，拿到 %v", err)
				}
			}
		})
	}
}

// 智能择优：评分只差几分不切；分差够大还要等够持续时间。
func TestScoreMarginGatesSmartSwitch(t *testing.T) {
	build := func(candidateLossOf100 int) *failoverProxy {
		proxy := routeTestProxy(failoverSpec{Strategy: "fallback", AutoFailback: true, Targets: routeTargets(2), PreferFastest: true, ScoreMargin: 10, ScoreHoldSeconds: 180})
		at := time.Now().Add(-10 * time.Minute)
		for i := 0; i < 100; i++ {
			proxy.statsLocked(0).recordProbe(i >= 2, 60, at.Add(time.Duration(i)*5*time.Second))
			proxy.statsLocked(1).recordProbe(i >= candidateLossOf100, 60, at.Add(time.Duration(i)*5*time.Second))
		}
		return proxy
	}
	start := time.Now()

	close := build(1) // 当前 82 分（丢包 2%），候选 90 分（丢包 1%）：差 8 分，不切
	close.mu.Lock()
	if got := fastestAfterHold(close, start); got != -1 {
		close.mu.Unlock()
		t.Fatalf("分差不到门槛就切了：%d", got)
	}
	close.mu.Unlock()

	clear := build(0) // 候选 98 分：差 16 分，等够 180 秒才切
	clear.mu.Lock()
	defer clear.mu.Unlock()
	if score, _ := clear.scoreLocked(0); score != 82 {
		t.Fatalf("当前线路应当 82 分，拿到 %d", score)
	}
	if score, _ := clear.scoreLocked(1); score != 98 {
		t.Fatalf("候选应当 98 分，拿到 %d", score)
	}
	if got := clear.fastestIndexLocked(start); got != -1 {
		t.Fatalf("第一次看到就切：%d", got)
	}
	if got := clear.fastestIndexLocked(start.Add(179 * time.Second)); got != -1 {
		t.Fatalf("没等够就切：%d", got)
	}
	if got := clear.fastestIndexLocked(start.Add(181 * time.Second)); got != 1 {
		t.Fatalf("等够了应当选候选，拿到 %d", got)
	}
	drainFailoverEvents()
	clear.updateFallbackActiveAtLocked(start.Add(181*time.Second), "health check")
	if clear.activeIndex != 1 {
		t.Fatalf("择优之后应当切过去：active=%d", clear.activeIndex)
	}
	if switched := routeEventsOfKind(drainFailoverEvents(), "switch"); len(switched) != 1 || switched[0].Reason != "score" || switched[0].Score != 98 {
		t.Fatalf("择优切换应当带原因 score 和评分：%+v", switched)
	}
}

// 心跳快照：每条出站的评分和它背后的数。
func TestStatsSnapshotReportsScores(t *testing.T) {
	proxy := routeTestProxy(failoverSpec{Strategy: "fallback", AutoFailback: true, Targets: routeTargets(3)})
	proxy.ruleID, proxy.sourcePort = 950001, 65001
	failoverMu.Lock()
	failoverProxies[failoverID(proxy.ruleID, proxy.sourcePort)] = proxy
	failoverMu.Unlock()
	t.Cleanup(func() {
		failoverMu.Lock()
		delete(failoverProxies, failoverID(proxy.ruleID, proxy.sourcePort))
		failoverMu.Unlock()
	})
	now := time.Now()
	proxy.mu.Lock()
	for i := 0; i < 20; i++ {
		proxy.statsLocked(0).recordProbe(true, 40, now.Add(time.Duration(i-20)*5*time.Second))
	}
	proxy.targetHealth[1] = false
	proxy.relayDown[2] = true
	proxy.relayDownReason[2] = "SG relay"
	proxy.mu.Unlock()

	var report *failoverStatsReport
	for _, item := range failoverStatsSnapshot() {
		if item.RuleID == proxy.ruleID {
			found := item
			report = &found
		}
	}
	if report == nil {
		t.Fatal("快照里没有这台代理")
	}
	if len(report.Targets) != 3 || report.ActiveIndex != 0 || report.Strategy != "fallback" {
		t.Fatalf("快照头不对：%+v", report)
	}
	if first := report.Targets[0]; first.Score != 100 || !first.Healthy || first.LatencyMs != 40 || first.Samples != 20 || first.AvailabilityPct != 100 {
		t.Fatalf("主出站应当 100 分：%+v", first)
	}
	if second := report.Targets[1]; second.Score != 0 || second.Healthy {
		t.Fatalf("探不通的出站应当 0 分：%+v", second)
	}
	if third := report.Targets[2]; third.Score != 0 || third.Healthy || !third.Down || third.DownReason != "SG relay" {
		t.Fatalf("被面板标掉的出站应当 0 分并带原因：%+v", third)
	}
}

// 还没探出延迟的出站不打分（-1），而不是 0 分：「等评分」和「不可用」是两回事。
func TestUnprobedTargetHasNoScore(t *testing.T) {
	proxy := routeTestProxy(failoverSpec{Strategy: "fallback", Targets: routeTargets(2)})
	proxy.mu.Lock()
	defer proxy.mu.Unlock()
	if got := proxy.scoreValueLocked(1); got != -1 {
		t.Fatalf("没探过的出站应当是 -1，拿到 %d", got)
	}
	if report := proxy.statsReportLocked(); report.Targets[1].Score != -1 {
		t.Fatalf("快照里也应当是 -1：%+v", report.Targets[1])
	}
}

// 落盘快照不带中转提示：重启之后以面板下一次心跳给的为准。
func TestPersistedSpecDropsRelayHints(t *testing.T) {
	spec := failoverTestSpec(65010)
	spec.Targets[0].Down = true
	spec.Targets[0].DownReason = "JP relay"
	stripped := stripFailoverRelayHints(normalizeFailoverSpec(spec))
	if stripped.Targets[0].Down || stripped.Targets[0].DownReason != "" {
		t.Fatalf("提示没被去掉：%+v", stripped.Targets[0])
	}
	if !spec.Targets[0].Down {
		t.Fatal("去提示不该改到原来的规格")
	}
}
