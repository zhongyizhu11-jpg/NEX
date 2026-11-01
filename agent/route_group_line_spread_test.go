package main

import (
	"net"
	"testing"
)

/*
「落地怎么分」（Line / Landing / Spread，2.2.245）。

不带这几个字段的规格必须和以前逐字一样：签名不变，主备一次只走挑出来的那一条。
*/

// 线路 0 上三个落地 A、B、C（spread 由参数给），线路 1 一个落地 D（不分）。
func lineSpreadTargets(spread string) []failoverTarget {
	targets := routeTargets(4)
	landings := []string{"A", "B", "C"}
	for i, landing := range landings {
		targets[i].Line = tierPtr(0)
		targets[i].Landing = landing
		targets[i].Spread = spread
	}
	return targets
}

func pickMany(proxy *failoverProxy, visitor string, times int) map[int]int {
	seen := map[int]int{}
	for i := 0; i < times; i++ {
		_, index := proxy.pickTargetForKey(visitor, nil)
		seen[index]++
	}
	return seen
}

func TestLineSpreadFieldsNormalizeAndSign(t *testing.T) {
	legacy := failoverTestSpec(65031)
	legacySig := failoverSignature(normalizeFailoverSpec(legacy))

	// 分法不认识、没线路号：当没带，签名不变。
	bogus := legacy
	bogus.Targets = append([]failoverTarget(nil), legacy.Targets...)
	bogus.Targets[0].Line = tierPtr(0)
	bogus.Targets[0].Spread = "bogus"
	bogus.Targets[1].Spread = "least_load"
	got := normalizeFailoverSpec(bogus)
	if got.Targets[0].Line != nil || got.Targets[0].Spread != "" || got.Targets[1].Spread != "" {
		t.Fatalf("不完整的「落地怎么分」应当清掉：%+v", got.Targets[:2])
	}
	if failoverSignature(got) != legacySig {
		t.Fatal("清掉之后签名应当和老规格一样")
	}

	spread := legacy
	spread.Targets = append([]failoverTarget(nil), legacy.Targets...)
	caller := 0
	spread.Targets[0].Line = &caller
	spread.Targets[0].Landing = " A "
	spread.Targets[0].Spread = " round_robin "
	normalized := normalizeFailoverSpec(spread)
	if normalized.Targets[0].Spread != "round_robin" || normalized.Targets[0].Landing != "A" || *normalized.Targets[0].Line != 0 {
		t.Fatalf("「落地怎么分」没被接受：%+v", normalized.Targets[0])
	}
	if normalized.Targets[0].Line == &caller {
		t.Fatal("线路号应当复制一份，别和调用方共用指针")
	}
	sig := failoverSignature(normalized)
	if sig == legacySig {
		t.Fatal("「落地怎么分」是行为参数，应当进签名")
	}
	changed := spread
	changed.Targets = append([]failoverTarget(nil), spread.Targets...)
	changed.Targets[0].Spread = "ip_hash"
	if failoverSignature(normalizeFailoverSpec(changed)) == sig {
		t.Fatal("换了分法签名应当变")
	}
	if stripped := stripFailoverRelayHints(normalized); stripped.Targets[0].Spread != "round_robin" || stripped.Targets[0].Line == nil {
		t.Fatalf("落盘应当保留「落地怎么分」：%+v", stripped.Targets[0])
	}
}

func TestLineSpreadKeepsLegacyPickWithoutFields(t *testing.T) {
	proxy := routeTestProxy(failoverSpec{Strategy: "fallback", Targets: routeTargets(3)})
	if seen := pickMany(proxy, "198.51.100.1", 12); seen[0] != 12 {
		t.Fatalf("不带「落地怎么分」时主备一次只走挑出来的那条：%v", seen)
	}
}

func TestLineSpreadRoundRobinAndRandomStayOnActiveLine(t *testing.T) {
	for _, spread := range []string{"round_robin", "random"} {
		proxy := routeTestProxy(failoverSpec{Strategy: "fallback", Targets: lineSpreadTargets(spread)})
		seen := pickMany(proxy, "198.51.100.1", 90)
		if seen[3] != 0 || seen[0] == 0 || seen[1] == 0 || seen[2] == 0 {
			t.Fatalf("%s：应当在线路 0 的三个落地之间分、不碰线路 1：%v", spread, seen)
		}
		if spread == "round_robin" && (seen[0] != 30 || seen[1] != 30 || seen[2] != 30) {
			t.Fatalf("轮流应当均匀：%v", seen)
		}
		// 一个落地坏了：只在剩下两个之间分。
		proxy.mu.Lock()
		proxy.targetHealth[1] = false
		proxy.mu.Unlock()
		if seen := pickMany(proxy, "198.51.100.1", 60); seen[1] != 0 || seen[3] != 0 || seen[0] == 0 || seen[2] == 0 {
			t.Fatalf("%s：坏了的落地不该再分到：%v", spread, seen)
		}
		// 排除（拨失败过的）也不分。
		_, index := proxy.pickTargetForKey("198.51.100.1", map[int]bool{0: true})
		if index != 2 {
			t.Fatalf("%s：排除 0、1 坏了，只剩 2：拿到 %d", spread, index)
		}
	}
}

func TestLineSpreadLeastLoadCountsLandingAcrossRelays(t *testing.T) {
	// 0、1 是同一个落地 A（经两台中转），2 是落地 B。
	targets := routeTargets(3)
	for i, landing := range []string{"A", "A", "B"} {
		targets[i].Line = tierPtr(0)
		targets[i].Landing = landing
		targets[i].Spread = "least_load"
	}
	proxy := routeTestProxy(failoverSpec{Strategy: "fallback", Targets: targets})
	var conns []net.Conn
	track := func(index, count int) {
		for i := 0; i < count; i++ {
			client, server := net.Pipe()
			conns = append(conns, client, server)
			proxy.trackConn(index, server)
		}
	}
	defer func() {
		for _, conn := range conns {
			_ = conn.Close()
		}
	}()
	// A 上：经中转 1 的 1 条 + 经中转 2 的 2 条 = 3；B 上 1 条 → 新连接给 B。
	track(0, 1)
	track(1, 2)
	track(2, 1)
	if _, index := proxy.pickTargetForKey("198.51.100.1", nil); index != 2 {
		t.Fatalf("A 上合计 3 条、B 上 1 条，应当给 B（2）：拿到 %d", index)
	}
	track(2, 4)
	if _, index := proxy.pickTargetForKey("198.51.100.1", nil); index != 0 {
		t.Fatalf("B 上 5 条、A 上 3 条，应当给 A 的代表（0）：拿到 %d", index)
	}
	// A 的代表 0 坏了：A 由 1 代表。
	proxy.mu.Lock()
	proxy.targetHealth[0] = false
	proxy.mu.Unlock()
	if _, index := proxy.pickTargetForKey("198.51.100.1", nil); index != 1 {
		t.Fatalf("0 坏了，A 应当由 1 代表：拿到 %d", index)
	}
}

func TestLineSpreadIPHashSticksToLanding(t *testing.T) {
	proxy := routeTestProxy(failoverSpec{Strategy: "fallback", Targets: lineSpreadTargets("ip_hash")})
	visitors := []string{"198.51.100.1", "198.51.100.2", "198.51.100.3", "198.51.100.4", "198.51.100.5", "198.51.100.6", "198.51.100.7", "198.51.100.8"}
	first := map[string]int{}
	used := map[int]bool{}
	for _, visitor := range visitors {
		_, index := proxy.pickTargetForKey(visitor, nil)
		first[visitor] = index
		used[index] = true
		for i := 0; i < 5; i++ {
			if _, again := proxy.pickTargetForKey(visitor, nil); again != index {
				t.Fatalf("同一个访客应当一直走同一个落地：%s %d → %d", visitor, index, again)
			}
		}
	}
	if len(used) < 2 || used[3] {
		t.Fatalf("几个访客应当分到线路 0 的不同落地上：%v", used)
	}
	// 一个落地挂了：只有原来在它上面的访客换，别人不动。
	proxy.mu.Lock()
	proxy.targetHealth[1] = false
	proxy.mu.Unlock()
	for _, visitor := range visitors {
		_, index := proxy.pickTargetForKey(visitor, nil)
		if first[visitor] != 1 && index != first[visitor] {
			t.Fatalf("落地 B 挂了，不在 B 上的访客 %s 不该换：%d → %d", visitor, first[visitor], index)
		}
		if index == 1 {
			t.Fatalf("挂了的落地不该再分到：%s", visitor)
		}
	}
}

func TestLineSpreadFollowsTheActiveLine(t *testing.T) {
	proxy := routeTestProxy(failoverSpec{Strategy: "fallback", Targets: lineSpreadTargets("round_robin")})
	// 主备切到线路 1（D，不分）：新连接都走它。
	proxy.mu.Lock()
	proxy.activeIndex = 3
	proxy.mu.Unlock()
	if seen := pickMany(proxy, "198.51.100.1", 9); seen[3] != 9 {
		t.Fatalf("走线路 1 时不该分到线路 0：%v", seen)
	}
}

func TestLineSpreadSwitchClosesOldLineLandings(t *testing.T) {
	for _, mode := range []string{"force", "fast", "smooth"} {
		proxy := routeTestProxy(failoverSpec{Strategy: "fallback", SwitchMode: mode, Targets: lineSpreadTargets("round_robin")})
		var conns []net.Conn
		for _, index := range []int{0, 1, 2} {
			client, server := net.Pipe()
			conns = append(conns, client, server)
			proxy.trackConn(index, server)
		}
		proxy.mu.Lock()
		proxy.targetHealth[2] = false
		drainFailoverEvents()
		proxy.setActiveLocked(3, "health check")
		left := proxy.connectionsLocked(0) + proxy.connectionsLocked(1) + proxy.connectionsLocked(2)
		proxy.mu.Unlock()
		for _, conn := range conns {
			_ = conn.Close()
		}
		want := map[string]int{
			"force":  0, // 每次切换都断：线路 0 三个落地全断
			"fast":   2, // 只断坏了的落地 C；0 本身是好的、按原规矩不断
			"smooth": 3, // 平滑：都留着
		}[mode]
		if left != want {
			t.Fatalf("%s：切走后线路 0 上应当还剩 %d 条连接，剩 %d", mode, want, left)
		}
	}
}
