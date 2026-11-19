package main

import (
	"math"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/zhongyizhu11-jpg/NEX/lbcore"
)

/*
「自动」分法（动态权重，2.2.251）和评分里的主机负载（failoverTarget.LoadPct）。

算法在 lbcore（P2C + peak EWMA）：成本 = 延迟 × 丢包系数 × (连接 + 在途 + 1) ÷ (权重 × 慢启动 × 余量)，挑最低的
（候选多于 3 条时随机抽两条比）。连接不断开的话分到的连接数会按「权重 × 余量 ÷ 延迟」的比例涨 ——
下面的用例每挑一次就在那条上挂一条连接，看长期的比例。
*/

func autoHoldConn(t *testing.T, p *failoverProxy, index int) {
	t.Helper()
	a, b := net.Pipe()
	t.Cleanup(func() { _ = a.Close(); _ = b.Close() })
	p.conns[index][a] = struct{}{}
}

// 挑 times 次，每次挑中的那条挂一条连接（模拟长连接）。
func autoPickHolding(t *testing.T, p *failoverProxy, times int) map[int]int {
	t.Helper()
	counts := map[int]int{}
	for i := 0; i < times; i++ {
		_, index := p.pickTargetForKey("", nil)
		counts[index]++
		autoHoldConn(t, p, index)
	}
	return counts
}

func ratioWithin(got, want, tolerance float64) bool {
	return math.Abs(got-want) <= tolerance
}

// 探测延迟的指数平均：第一次探通的那个数起头，之后新样本占三成；探不通不动它。
func TestRouteLatencyEwma(t *testing.T) {
	stats := &routeTargetStats{}
	at := time.Now()
	stats.recordProbe(false, 0, at)
	if stats.latencyEwmaMs != 0 {
		t.Fatalf("探不通不该起头：%v", stats.latencyEwmaMs)
	}
	stats.recordProbe(true, 100, at.Add(time.Second))
	if stats.latencyEwmaMs != 100 {
		t.Fatalf("第一个样本直接作数：%v", stats.latencyEwmaMs)
	}
	stats.recordProbe(true, 200, at.Add(2*time.Second))
	if math.Abs(stats.latencyEwmaMs-130) > 1e-9 {
		t.Fatalf("100×0.7 + 200×0.3 = 130，拿到 %v", stats.latencyEwmaMs)
	}
	stats.recordProbe(false, 0, at.Add(3*time.Second))
	if math.Abs(stats.latencyEwmaMs-130) > 1e-9 {
		t.Fatalf("探不通不该改平均：%v", stats.latencyEwmaMs)
	}
	// 同机房 0ms 的路径按 1ms 起头：0 只表示「还没探通过」，不然它会被当成不知道延迟、加不上下游那几段。
	local := &routeTargetStats{}
	local.recordProbe(true, 0, at)
	if local.latencyEwmaMs != 1 {
		t.Fatalf("0ms 应按 1ms 起头：%v", local.latencyEwmaMs)
	}
}

// 自动：延迟、负载一样时，长期分到的连接按静态权重 3:1。
func TestRouteAutoFollowsStaticWeights(t *testing.T) {
	p := balanceTestProxy("auto", 3, 1)
	p.ensureHealthStateLocked()
	counts := autoPickHolding(t, p, 400)
	share := float64(counts[0]) / 400
	if !ratioWithin(share, 0.75, 0.06) {
		t.Fatalf("应该大致 3:1：%v", counts)
	}
}

// 自动：一条路上的主机忙到 90%（负载系数 0.1）就只分到一成左右；慢三倍的那条（延迟系数 1/3）分到四分之一。
func TestRouteAutoPenalizesLoadedAndSlowPaths(t *testing.T) {
	loaded := balanceTestProxy("auto", 1, 1)
	loaded.ensureHealthStateLocked()
	loaded.spec.Targets[1].LoadPct = 90
	counts := autoPickHolding(t, loaded, 440)
	if !ratioWithin(float64(counts[1])/440, 1.0/11, 0.05) {
		t.Fatalf("忙的那条应该只分到约一成：%v", counts)
	}

	slow := balanceTestProxy("auto", 1, 1)
	slow.ensureHealthStateLocked()
	at := time.Now()
	for i := 0; i < 3; i++ {
		slow.stats[0].recordProbe(true, 50, at.Add(time.Duration(i)*time.Second))
		slow.stats[1].recordProbe(true, 150, at.Add(time.Duration(i)*time.Second))
	}
	counts = autoPickHolding(t, slow, 400)
	if !ratioWithin(float64(counts[1])/400, 0.25, 0.06) {
		t.Fatalf("慢三倍的那条应该分到约四分之一：%v", counts)
	}

	// 面板给的下游延迟也算进去：本机探到一样快，下游多 100ms 的那条就是慢的。
	downstream := balanceTestProxy("auto", 1, 1)
	downstream.ensureHealthStateLocked()
	for i := 0; i < 3; i++ {
		downstream.stats[0].recordProbe(true, 50, at.Add(time.Duration(i)*time.Second))
		downstream.stats[1].recordProbe(true, 50, at.Add(time.Duration(i)*time.Second))
	}
	downstream.spec.Targets[1].ExtraLatencyMs = 100
	counts = autoPickHolding(t, downstream, 400)
	if counts[1] >= counts[0] {
		t.Fatalf("下游慢的那条不该分到更多：%v", counts)
	}
}

// 自动：再忙也留 5% 的余量（利用率最多按 95% 算），不会彻底饿死；还不知道延迟的那条按最快的算，不罚。
func TestRouteAutoCostIsBoundedAndNeutralForUnknowns(t *testing.T) {
	p := balanceTestProxy("auto", 1, 1, 1)
	p.ensureHealthStateLocked()
	at := time.Now()
	p.stats[0].recordProbe(true, 10, at)
	p.stats[1].recordProbe(true, 5000, at)
	p.spec.Targets[1].LoadPct = 100
	all := []int{0, 1, 2}
	members := p.membersLocked(all, lbcore.StrategyAuto, at, p.pathLoadLocked)
	fast, _ := lbcore.Cost(members, all, 0, false)
	slow, _ := lbcore.Cost(members, all, 1, false)
	unknown, _ := lbcore.Cost(members, all, 2, false)
	if math.Abs(slow/fast-500*20) > 1 {
		t.Fatalf("慢 500 倍、满负载（余量 5%%）：成本应该是 500 × 20 倍，拿到 %v 倍", slow/fast)
	}
	if math.Abs(unknown-fast) > 1e-9 {
		t.Fatalf("还没探出延迟的不罚：%v 对 %v", unknown, fast)
	}
}

// 自动的延迟是 peak EWMA：一次慢探测立刻把读数抬上去，之后按时间落回来；真实拨号只在比读数慢时才算。
func TestRoutePeakLatencyFollowsSlowSamples(t *testing.T) {
	p := balanceTestProxy("auto", 1, 1)
	p.ensureHealthStateLocked()
	at := time.Now().Add(-30 * time.Second)
	for i := 0; i < 3; i++ {
		p.stats[0].recordProbe(true, 20, at.Add(time.Duration(i)*5*time.Second))
	}
	steady := at.Add(10 * time.Second)
	if got := p.peakLatencyLocked(0, steady); math.Abs(got-20) > 0.01 {
		t.Fatalf("平稳时就是那个延迟：%v", got)
	}
	// 一次 900ms 的探测：立刻跳上去；10 秒后没有新样本，落到 1/e。
	p.stats[0].recordProbe(true, 900, at.Add(15*time.Second))
	if got := p.peakLatencyLocked(0, at.Add(15*time.Second)); got != 900 {
		t.Fatalf("慢样本应该立刻跳上去：%v", got)
	}
	if got := p.peakLatencyLocked(0, at.Add(25*time.Second)); math.Abs(got-900/math.E) > 1 {
		t.Fatalf("10 秒后应该落到 1/e：%v", got)
	}
	// 真实拨号：比读数慢的算（这条路此刻真的慢），比读数快的不算（拨号只到第一跳，说明不了整条路快）。
	q := balanceTestProxy("auto", 1, 1)
	q.ensureHealthStateLocked()
	q.stats[0].recordProbe(true, 40, at)
	q.stats[0].dials = append(q.stats[0].dials, routeDialSample{at: at.Add(time.Second), ok: true, ms: 5})
	if got := q.peakLatencyLocked(0, at.Add(time.Second)); got < 36 {
		t.Fatalf("快的拨号不该把读数拉下来：%v", got)
	}
	q.stats[0].dials = append(q.stats[0].dials, routeDialSample{at: at.Add(2 * time.Second), ok: true, ms: 700})
	if got := q.peakLatencyLocked(0, at.Add(2*time.Second)); got != 700 {
		t.Fatalf("慢的拨号应该立刻算进去：%v", got)
	}
	if q.peakLatencyLocked(1, at) != 0 {
		t.Fatal("没探通过的是 0")
	}
}

// 质量和线路评分用的是同一批探测结果：丢包、抖动来自探测窗口，利用率是面板给的沿途主机负载，拨通率来自真实拨号。
func TestRouteQualityInputs(t *testing.T) {
	p := balanceTestProxy("auto", 1, 1)
	p.ensureHealthStateLocked()
	at := time.Now()
	for i := 0; i < 18; i++ {
		p.stats[0].recordProbe(true, 30+10*(i%2), at.Add(time.Duration(i)*time.Second))
	}
	p.stats[0].recordProbe(false, 0, at.Add(18*time.Second))
	p.stats[0].recordProbe(false, 0, at.Add(19*time.Second))
	p.spec.Targets[0].LoadPct = 40
	p.spec.Targets[0].ExtraLatencyMs = 15
	for i := 0; i < 8; i++ {
		p.stats[0].dials = append(p.stats[0].dials, routeDialSample{at: at, ok: i < 6, ms: 1})
	}
	quality := p.qualityLocked(0, at.Add(19*time.Second), false)
	summary := p.scoreInputLocked(0)
	if math.Abs(quality.Loss-summary.lossPct/100) > 1e-9 || math.Abs(quality.Loss-0.1) > 1e-9 {
		t.Fatalf("丢包应该是探测窗口的 10%%（和评分用的同一个数）：%v", quality.Loss)
	}
	// 抖动：比最低延迟高出多少的 90 分位。30 / 40 交替 → 10ms。一次 2 秒的尖峰不改变它（评分里那个平均差会被带飞）。
	if quality.Jitter != 10 {
		t.Fatalf("抖动应该是 10ms：%v", quality.Jitter)
	}
	p.stats[0].recordProbe(true, 2000, at.Add(20*time.Second))
	if got := p.qualityLocked(0, at.Add(20*time.Second), false).Jitter; got != 10 {
		t.Fatalf("一次尖峰不该改变抖动：%v", got)
	}
	if routeProbeJitter(p.stats[0].samples[:5]) != 0 {
		t.Fatal("样本不够不算抖动")
	}
	if quality.Utilisation != 0.4 || math.Abs(quality.Success-0.75) > 1e-9 {
		t.Fatalf("利用率 40%%、拨通率 6/8：%+v", quality)
	}
	quality = p.qualityLocked(0, at.Add(20*time.Second), false)
	if want := p.stats[0].latencyEwmaMs + 15; math.Abs(quality.Latency-want) > 1e-9 {
		t.Fatalf("延迟 = 指数平均 + 下游延迟：%v 对 %v", quality.Latency, want)
	}
	// 什么都没量到的那条：全是 0（不知道），拨号不到 5 次不算拨通率。
	p.stats[1].dials = append(p.stats[1].dials, routeDialSample{at: at, ok: false})
	if got := p.qualityLocked(1, at, true); got != (lbcore.Quality{}) {
		t.Fatalf("没量到的应该全是不知道：%+v", got)
	}
}

// 自动：只有一条能用就是它；两条里一条挂了也只剩一条。
func TestRouteAutoSingleCandidate(t *testing.T) {
	p := balanceTestProxy("auto", 1, 1)
	p.ensureHealthStateLocked()
	p.targetHealth[1] = false
	for i := 0; i < 20; i++ {
		if _, index := p.pickTargetForKey("", nil); index != 0 {
			t.Fatalf("挂掉的那条分到了连接（第 %d 次）", i)
		}
	}
	single := balanceTestProxy("auto", 5)
	single.ensureHealthStateLocked()
	if _, index := single.pickTargetForKey("", nil); index != 0 {
		t.Fatal("只有一条时应该挑它")
	}
}

// 自动：权重 0 的路径不分新连接，和按权重一样。
func TestRouteAutoSkipsZeroWeight(t *testing.T) {
	p := balanceTestProxy("auto", 3, 0)
	p.ensureHealthStateLocked()
	for i := 0; i < 20; i++ {
		if _, index := p.pickTargetForKey("", nil); index != 0 {
			t.Fatal("权重 0 的路径分到了新连接")
		}
	}
}

// UDP 的新会话也按「自动」挑（和 TCP 同一个 pickTargetForKey）：排在前面的 A 沿途忙到 90%，有效权重只有 B 的一成，
// 两条都会被挑中来比，B 的 (会话 + 1) ÷ 1 要到第 10 个会话才比得过 A 的 1 ÷ 0.1 —— 头三个会话都该落在 B 上。主备、
// 按权重、按负载、轮流挑第一个会话时都会给排在前面的 A，所以这条用例只有「自动」过得了。
func TestFailoverUDPAutoSpreadsSessionsByLoad(t *testing.T) {
	failoverUDPTestSetup(t)
	portA := failoverUDPEcho(t, "A")
	portB := failoverUDPEcho(t, "B")
	spec := failoverTestSpec(failoverTestDualPort(t))
	spec.Protocol = "udp"
	spec.Strategy = "auto"
	spec.Targets = []failoverTarget{{TargetIP: "127.0.0.1", TargetPort: portA, failoverTargetHints: failoverTargetHints{LoadPct: 90}}, {TargetIP: "127.0.0.1", TargetPort: portB}}
	_, addr := startUDPFailoverForTest(t, 950047, 65047, spec)
	for i := 0; i < 3; i++ {
		client, err := net.Dial("udp", addr)
		if err != nil {
			t.Fatalf("dial: %v", err)
		}
		defer client.Close()
		if reply := failoverUDPExchange(t, client, "x"); strings.SplitN(reply, ":", 2)[0] != "B" {
			t.Fatalf("第 %d 个会话该走不忙的 B：%q", i+1, reply)
		}
	}
}

// 规格里的 auto 保得住（老 Agent 规整成 fallback 的那条路这里不走）；不认识的仍然退成主备。
func TestRouteAutoSpecIsKept(t *testing.T) {
	spec := normalizeFailoverSpec(failoverSpec{Strategy: "auto", Targets: []failoverTarget{{TargetIP: "127.0.0.1", TargetPort: 1}}})
	if spec.Strategy != "auto" {
		t.Fatalf("auto 被规整成了 %q", spec.Strategy)
	}
	if normalizeFailoverSpec(failoverSpec{Strategy: "magic"}).Strategy != "fallback" {
		t.Fatal("不认识的分法应当退成主备")
	}
}

// 线路里几个落地选了「自动」：同一个落地的连接合着算，忙的落地少分。
func TestLineSpreadAutoPrefersIdleLanding(t *testing.T) {
	spec := failoverSpec{Strategy: "fallback", Targets: lineSpreadTargets("auto")}
	proxy := routeTestProxy(spec)
	proxy.spec.Targets[1].LoadPct = 95
	counts := map[int]int{}
	for i := 0; i < 300; i++ {
		_, index := proxy.pickTargetForKey("", nil)
		counts[index]++
		autoHoldConn(t, proxy, index)
	}
	if counts[3] != 0 {
		t.Fatalf("线路 1 的落地不该参与：%v", counts)
	}
	if counts[1] >= counts[0] || counts[1] >= counts[2] {
		t.Fatalf("忙到 95%% 的落地应该分到最少：%v", counts)
	}
	if counts[0] == 0 || counts[2] == 0 {
		t.Fatalf("另外两个落地都该分到：%v", counts)
	}
}

// 负载扣分：70% 以下不扣，95% 起扣满 15 分，中间线性；扣不到负数。
func TestRouteLoadPenalty(t *testing.T) {
	cases := map[float64]float64{0: 0, 69.9: 0, 70: 0, 82.5: 7.5, 95: 15, 100: 15, -5: 0, math.NaN(): 0}
	for load, want := range cases {
		if got := routeLoadPenalty(load); math.Abs(got-want) > 1e-9 {
			t.Errorf("负载 %v 应扣 %v 分，拿到 %v", load, want, got)
		}
	}
	if score, ok := routeScore(650, true, 9.5, 240, 0, true, 99); !ok || score != 0 {
		t.Fatalf("本来就 0 分的扣完还是 0：%d %v", score, ok)
	}
}

// 面板给的负载是运行时提示：不进签名、不落盘，applyRelayHintsLocked 换上就生效，评分跟着扣，快照回显。
func TestRouteLoadHintIsRuntimeOnly(t *testing.T) {
	spec := failoverSpec{Strategy: "fallback", Targets: routeTargets(2), PreferFastest: true}
	proxy := routeTestProxy(spec)
	at := time.Now()
	for i := 0; i < 3; i++ {
		proxy.stats[0].recordProbe(true, 30, at.Add(time.Duration(i)*time.Second))
		proxy.stats[1].recordProbe(true, 30, at.Add(time.Duration(i)*time.Second))
	}
	before, _ := proxy.scoreLocked(1)
	hinted := append([]failoverTarget(nil), proxy.spec.Targets...)
	hinted[1].LoadPct = 95
	if failoverSignature(failoverSpec{Strategy: "fallback", Targets: hinted}) != failoverSignature(failoverSpec{Strategy: "fallback", Targets: proxy.spec.Targets}) {
		t.Fatal("负载提示不该进签名")
	}
	proxy.applyRelayHintsLocked(hinted)
	after, _ := proxy.scoreLocked(1)
	if after != before-15 {
		t.Fatalf("95%% 负载应扣 15 分：%d → %d", before, after)
	}
	if other, _ := proxy.scoreLocked(0); other != before {
		t.Fatalf("没给负载的那条不该变：%d → %d", before, other)
	}
	report := proxy.statsReportLocked()
	if report.Targets[1].LoadPct != 95 || report.Targets[0].LoadPct != 0 {
		t.Fatalf("快照该回显负载：%+v", report.Targets)
	}
	if stripped := stripFailoverRelayHints(proxy.spec); stripped.Targets[1].LoadPct != 0 {
		t.Fatal("落盘前该把负载提示去掉")
	}
}
