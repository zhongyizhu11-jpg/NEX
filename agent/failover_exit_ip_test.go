package main

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"
	"time"
)

/*
故障切换优先同出口 IP（ExitIP，2.2.251）。

不带 ExitIP 的规格必须和以前逐字一样：签名不变、挂了换顺序里第一条健康的。带了也只是平手时的取舍：
分层不越级、整链最优分差太大不算平手、人工指定和时段表说了算。
*/

// 三条路径：0 和 2 从同一个出口 IP 出去，1 从另一个。
func exitIPTargets(count int, exits ...string) []failoverTarget {
	targets := routeTargets(count)
	for i, exit := range exits {
		if i < len(targets) {
			targets[i].ExitIP = exit
		}
	}
	return targets
}

func TestExitIPIsARuntimeHint(t *testing.T) {
	plain := failoverSpec{Strategy: "fallback", Targets: routeTargets(3), ListenPort: 65030, BindAddress: "127.0.0.1", Enabled: true}
	plainSig := failoverSignature(normalizeFailoverSpec(plain))
	hinted := plain
	hinted.Targets = exitIPTargets(3, " 203.0.113.9 ", "203.0.113.10", "203.0.113.9")
	normalized := normalizeFailoverSpec(hinted)
	if failoverSignature(normalized) != plainSig {
		t.Fatal("ExitIP 是运行时提示，不该进签名")
	}
	if normalized.Targets[0].ExitIP != "203.0.113.9" {
		t.Fatalf("ExitIP 应当去掉首尾空白后保留：%q", normalized.Targets[0].ExitIP)
	}
	if stripped := stripFailoverRelayHints(normalized); stripped.Targets[0].ExitIP != "" || normalized.Targets[0].ExitIP == "" {
		t.Fatalf("落盘应当去掉 ExitIP、且不改原规格：%+v / %+v", stripped.Targets[0], normalized.Targets[0])
	}

	// 同一份规格带着新的出口 IP 再下发：不重建，直接换上。
	proxy := routeTestProxy(plain)
	proxy.mu.Lock()
	proxy.applyRelayHintsLocked(normalized.Targets)
	got := proxy.exitIPLocked(2)
	proxy.mu.Unlock()
	if got != "203.0.113.9" {
		t.Fatalf("applyRelayHintsLocked 没把 ExitIP 换上：%q", got)
	}
}

func TestEscapePrefersSameExitIPOnlyAsATieBreak(t *testing.T) {
	// 不带出口 IP：挂了换顺序里第一条健康的（老行为）。
	legacy := routeTestProxy(failoverSpec{Strategy: "fallback", Targets: routeTargets(3)})
	legacy.mu.Lock()
	legacy.targetHealth[0] = false
	drainFailoverEvents()
	legacy.updateFallbackActiveAtLocked(time.Now(), "health check")
	if legacy.activeIndex != 1 {
		t.Fatalf("不带出口 IP 应当换到第 1 条：active=%d", legacy.activeIndex)
	}
	legacy.mu.Unlock()
	if switched := routeEventsOfKind(drainFailoverEvents(), "switch"); len(switched) != 1 || switched[0].Reason != "health check" {
		t.Fatalf("不带出口 IP 的事件原因不该变：%+v", switched)
	}

	// 带出口 IP：0 挂了，1、2 都健康，2 和 0 同出口 → 换到 2，事件原因带上说明。
	proxy := routeTestProxy(failoverSpec{Strategy: "fallback", Targets: exitIPTargets(3, "203.0.113.9", "203.0.113.10", "203.0.113.9")})
	proxy.mu.Lock()
	proxy.targetHealth[0] = false
	proxy.updateFallbackActiveAtLocked(time.Now(), "health check")
	if proxy.activeIndex != 2 {
		t.Fatalf("应当换到同出口 IP 的第 2 条：active=%d", proxy.activeIndex)
	}
	proxy.mu.Unlock()
	switched := routeEventsOfKind(drainFailoverEvents(), "switch")
	if len(switched) != 1 || switched[0].Reason != "health check"+failoverSameExitReasonSuffix {
		t.Fatalf("事件原因应当带上「同出口 IP」：%+v", switched)
	}

	// 同出口的那条也挂了：照旧换到第 1 条，原因不带说明。
	both := routeTestProxy(failoverSpec{Strategy: "fallback", Targets: exitIPTargets(3, "203.0.113.9", "203.0.113.10", "203.0.113.9")})
	both.mu.Lock()
	both.targetHealth[0] = false
	both.targetHealth[2] = false
	both.updateFallbackActiveAtLocked(time.Now(), "dial failed")
	if both.activeIndex != 1 {
		t.Fatalf("同出口的也挂了就换第 1 条：active=%d", both.activeIndex)
	}
	both.mu.Unlock()
	if switched := routeEventsOfKind(drainFailoverEvents(), "switch"); len(switched) != 1 || strings.Contains(switched[0].Reason, "same exit") {
		t.Fatalf("没挑到同出口的，原因不该写同出口：%+v", switched)
	}

	// 新连接挑路径：当前这条刚拨失败（排除）时同样优先同出口。
	pick := routeTestProxy(failoverSpec{Strategy: "fallback", Targets: exitIPTargets(3, "203.0.113.9", "203.0.113.10", "203.0.113.9")})
	if _, index := pick.pickTargetForKey("198.51.100.1", map[int]bool{0: true}); index != 2 {
		t.Fatalf("排除当前这条之后应当挑同出口的第 2 条：%d", index)
	}
}

func TestEscapeSameExitIPNeverCrossesTiers(t *testing.T) {
	// 0、1 是主组，2 是备用组；0 和 2 同出口。0 挂了只能在主组里换 → 1。
	targets := exitIPTargets(3, "203.0.113.9", "203.0.113.10", "203.0.113.9")
	for i, tier := range []int{0, 0, 1} {
		targets[i].Tier = tierPtr(tier)
	}
	proxy := routeTestProxy(failoverSpec{Strategy: "fallback", Targets: targets})
	proxy.mu.Lock()
	defer proxy.mu.Unlock()
	proxy.targetHealth[0] = false
	drainFailoverEvents()
	proxy.updateFallbackActiveAtLocked(time.Now(), "health check")
	if proxy.activeIndex != 1 {
		t.Fatalf("同出口的在备用组，不该越级：active=%d", proxy.activeIndex)
	}
	// 主组全挂：备用组里只有一条，走它。
	proxy.targetHealth[1] = false
	proxy.updateFallbackActiveAtLocked(time.Now(), "health check")
	if proxy.activeIndex != 2 {
		t.Fatalf("主组全挂应当到备用组：active=%d", proxy.activeIndex)
	}
}

func TestEscapeSameExitIPRespectsScoreMargin(t *testing.T) {
	// 开不开整链最优都一样：分都在算，平手按分差判断。
	for _, preferFastest := range []bool{false, true} {
		build := func(sameExitLossOf100 int) *failoverProxy {
			proxy := routeTestProxy(failoverSpec{
				Strategy: "fallback", AutoFailback: true, PreferFastest: preferFastest, ScoreMargin: 10, ScoreHoldSeconds: 180,
				Targets: exitIPTargets(3, "203.0.113.9", "203.0.113.10", "203.0.113.9"),
			})
			at := time.Now().Add(-10 * time.Minute)
			for i := 0; i < 100; i++ {
				proxy.statsLocked(1).recordProbe(true, 60, at.Add(time.Duration(i)*5*time.Second))
				proxy.statsLocked(2).recordProbe(i >= sameExitLossOf100, 60, at.Add(time.Duration(i)*5*time.Second))
			}
			proxy.mu.Lock()
			proxy.targetHealth[0] = false
			proxy.mu.Unlock()
			return proxy
		}

		// 同出口的那条丢包 6%：分差远超 10 分，不算平手 → 换到顺序里的 1（和以前一样）。
		far := build(6)
		far.mu.Lock()
		far.updateFallbackActiveAtLocked(time.Now(), "health check")
		if far.activeIndex != 1 {
			t.Fatalf("preferFastest=%v：同出口的分差太大就不算平手：active=%d", preferFastest, far.activeIndex)
		}
		far.mu.Unlock()

		// 同出口的那条丢包 1%：分差在门槛内 → 换到同出口的 2。
		near := build(1)
		near.mu.Lock()
		near.updateFallbackActiveAtLocked(time.Now(), "health check")
		if near.activeIndex != 2 {
			t.Fatalf("preferFastest=%v：分差在门槛内应当优先同出口：active=%d", preferFastest, near.activeIndex)
		}
		near.mu.Unlock()

		// 一条都没打出分（刚起来）：都算平手，照样优先同出口。
		unscored := routeTestProxy(failoverSpec{Strategy: "fallback", PreferFastest: preferFastest, Targets: exitIPTargets(3, "203.0.113.9", "203.0.113.10", "203.0.113.9")})
		unscored.mu.Lock()
		unscored.targetHealth[0] = false
		unscored.updateFallbackActiveAtLocked(time.Now(), "health check")
		if unscored.activeIndex != 2 {
			t.Fatalf("preferFastest=%v：没评分时都算平手，应当优先同出口：active=%d", preferFastest, unscored.activeIndex)
		}
		unscored.mu.Unlock()

		// 只有不同出口的那条打出了分：没分的同出口那条不算平手（没探过不等于一样好）。
		partly := routeTestProxy(failoverSpec{Strategy: "fallback", PreferFastest: preferFastest, Targets: exitIPTargets(3, "203.0.113.9", "203.0.113.10", "203.0.113.9")})
		at := time.Now().Add(-10 * time.Minute)
		for i := 0; i < 20; i++ {
			partly.statsLocked(1).recordProbe(true, 60, at.Add(time.Duration(i)*5*time.Second))
		}
		partly.mu.Lock()
		partly.targetHealth[0] = false
		partly.updateFallbackActiveAtLocked(time.Now(), "health check")
		if partly.activeIndex != 1 {
			t.Fatalf("preferFastest=%v：没评分的同出口那条不该被当成平手：active=%d", preferFastest, partly.activeIndex)
		}
		partly.mu.Unlock()
	}
}

// 全都挂了的时候候选是兜底的全部（不健康的也算）：挑不出健康的，照旧第一条，不能因为挑不出就出错。
func TestEscapePickWithEveryPathDownKeepsTheOldFallback(t *testing.T) {
	for _, targets := range [][]failoverTarget{routeTargets(3), exitIPTargets(3, "203.0.113.9", "203.0.113.10", "203.0.113.9")} {
		proxy := routeTestProxy(failoverSpec{Strategy: "fallback", Targets: targets})
		proxy.mu.Lock()
		for i := range proxy.targetHealth {
			proxy.targetHealth[i] = false
		}
		proxy.mu.Unlock()
		if _, index := proxy.pickTargetForKey("198.51.100.1", nil); index != 0 {
			t.Fatalf("全挂时应当照旧拿第一条：%d（%+v）", index, targets[0])
		}
		if _, index := proxy.pickTargetForKey("198.51.100.1", map[int]bool{0: true}); index != 1 {
			t.Fatalf("全挂、排除第 0 条时应当照旧拿第 1 条：%d", index)
		}
		proxy.mu.Lock()
		proxy.updateFallbackActiveAtLocked(time.Now(), "health check")
		if proxy.activeIndex != 0 {
			t.Fatalf("全挂时不该切：active=%d", proxy.activeIndex)
		}
		proxy.mu.Unlock()
	}
}

func TestEscapeSameExitIPNeverOverridesPinOrSchedule(t *testing.T) {
	pinned := 1
	proxy := routeTestProxy(failoverSpec{
		Strategy: "fallback", Targets: exitIPTargets(3, "203.0.113.9", "203.0.113.10", "203.0.113.9"),
		PinnedIndex: &pinned,
	})
	proxy.mu.Lock()
	// 钉住的是 1，但代理当前走着 0（比如刚起来）；0 挂了：人说走 1 就走 1。
	proxy.targetHealth[0] = false
	proxy.updateFallbackActiveAtLocked(time.Now(), "health check")
	if proxy.activeIndex != 1 {
		t.Fatalf("人工指定健康就该走它：active=%d", proxy.activeIndex)
	}
	proxy.mu.Unlock()

	// 时段表：UTC 全天都首选 1。
	schedule := &failoverSchedule{Timezone: "UTC", Windows: []failoverScheduleWindow{
		{Days: nil, From: "00:00", To: "12:00", TargetIndex: 1},
		{Days: nil, From: "12:00", To: "23:59", TargetIndex: 1},
	}}
	timed := routeTestProxy(failoverSpec{
		Strategy: "fallback", Targets: exitIPTargets(3, "203.0.113.9", "203.0.113.10", "203.0.113.9"),
		Schedule: schedule,
	})
	timed.mu.Lock()
	defer timed.mu.Unlock()
	at := time.Date(2026, 11, 7, 10, 30, 0, 0, time.UTC)
	if got := failoverScheduleTargetIndexAt(timed.spec.Schedule, at); got != 1 {
		t.Fatalf("前提不成立：时段表这会儿应当首选 1，拿到 %d", got)
	}
	timed.targetHealth[0] = false
	timed.updateFallbackActiveAtLocked(at, "health check")
	if timed.activeIndex != 1 {
		t.Fatalf("时段表定的首选健康就该走它：active=%d", timed.activeIndex)
	}
}

// 线路 0 上落地 A、B、C；A 和 C 同出口 IP。
func exitIPLineTargets(spread string) []failoverTarget {
	targets := lineSpreadTargets(spread)
	targets[0].ExitIP = "203.0.113.9"
	targets[1].ExitIP = "203.0.113.10"
	targets[2].ExitIP = "203.0.113.9"
	return targets
}

func TestLineSpreadIPHashMovesToSameExitLanding(t *testing.T) {
	proxy := routeTestProxy(failoverSpec{Strategy: "fallback", Targets: exitIPLineTargets("ip_hash")})
	visitors := make([]string, 0, 40)
	for i := 1; i <= 40; i++ {
		visitors = append(visitors, "198.51.100."+strconv.Itoa(i))
	}
	first := map[string]int{}
	for _, visitor := range visitors {
		_, index := proxy.pickTargetForKey(visitor, nil)
		first[visitor] = index
	}
	// 落地 A 挂了：原来在 A 上的访客换到同出口的 C，不在 A 上的不动。
	proxy.mu.Lock()
	proxy.targetHealth[0] = false
	proxy.mu.Unlock()
	moved := 0
	for _, visitor := range visitors {
		_, index := proxy.pickTargetForKey(visitor, nil)
		if first[visitor] != 0 {
			if index != first[visitor] {
				t.Fatalf("不在 A 上的访客 %s 不该换：%d → %d", visitor, first[visitor], index)
			}
			continue
		}
		moved++
		if index != 2 {
			t.Fatalf("A 挂了，原来在 A 上的访客 %s 应当换到同出口的 C：拿到 %d", visitor, index)
		}
	}
	if moved == 0 {
		t.Fatal("前提不成立：没有一个访客落在 A 上")
	}
	// 同出口的 C 也挂了：照旧按哈希落到剩下的 B。
	proxy.mu.Lock()
	proxy.targetHealth[2] = false
	proxy.mu.Unlock()
	for _, visitor := range visitors {
		if _, index := proxy.pickTargetForKey(visitor, nil); index != 1 {
			t.Fatalf("只剩 B 了，访客 %s 拿到 %d", visitor, index)
		}
	}
}

func TestLineSpreadLeastLoadTieBreaksBySameExit(t *testing.T) {
	proxy := routeTestProxy(failoverSpec{Strategy: "fallback", Targets: exitIPLineTargets("least_load")})
	// A 挂了，B、C 都没有连接（负载平手）：优先同出口的 C，不管轮到谁。
	proxy.mu.Lock()
	proxy.targetHealth[0] = false
	proxy.mu.Unlock()
	for i := 0; i < 6; i++ {
		if _, index := proxy.pickTargetForKey("198.51.100.1", nil); index != 2 {
			t.Fatalf("负载平手应当优先同出口的 C：第 %d 次拿到 %d", i, index)
		}
	}
	// C 上连接多了：按负载分，不再是平手。
	proxy.mu.Lock()
	for i := 0; i < 3; i++ {
		proxy.conns[2][&fakeConn{}] = struct{}{}
	}
	proxy.mu.Unlock()
	if _, index := proxy.pickTargetForKey("198.51.100.1", nil); index != 1 {
		t.Fatalf("C 负载高了应当给 B：拿到 %d", index)
	}
}

// 隧道出口组：面板给每个出口带的出口 IP 原样写进 FXP 的配置，但不进签名 —— 它变了不能重载 / 重启 FXP。
func TestFXPExitIPIsCarriedButStaysOutOfTheSignature(t *testing.T) {
	exits := func(ips ...string) []fxpExitEndpoint {
		list := []fxpExitEndpoint{{Host: "10.0.0.9", Port: 5000}, {Host: "10.0.0.10", Port: 5000}}
		for i, ip := range ips {
			list[i].ExitIP = ip
		}
		return list
	}
	spec := func(list []fxpExitEndpoint) fxpSpec {
		return fxpSpec{Role: "entry", TunnelID: 5, RuleID: 6, ListenPort: 1000, Key: "k", ExitHost: "10.0.0.9", ExitPort: 5000, ExitStrategy: "fallback", Exits: list}
	}
	base := spec(exits())
	hinted := spec(exits(" 203.0.113.9 ", "203.0.113.10"))
	if fxpServerSignature(base) != fxpServerSignature(hinted) {
		t.Fatal("出口 IP 不该进 FXP 的签名")
	}
	if fxpServerSignature(spec(exits("203.0.113.9", "203.0.113.10"))) != fxpServerSignature(spec(exits("203.0.113.44", ""))) {
		t.Fatal("出口 IP 变了不该改 FXP 的签名")
	}
	normalized := normalizeFXPSpec(spec(exits(" 203.0.113.9 ", "203.0.113.10")))
	if normalized.Exits[0].ExitIP != "203.0.113.9" {
		t.Fatalf("出口 IP 应当去掉首尾空白：%q", normalized.Exits[0].ExitIP)
	}
	raw, err := json.Marshal(normalized)
	if err != nil || !strings.Contains(string(raw), `"exitIp":"203.0.113.9"`) {
		t.Fatalf("出口 IP 应当原样写进 FXP 的配置：%s %v", raw, err)
	}
	if raw, _ := json.Marshal(normalizeFXPSpec(spec(exits()))); strings.Contains(string(raw), "exitIp") {
		t.Fatalf("没带出口 IP 的规格写出来要和以前一样：%s", raw)
	}
}
