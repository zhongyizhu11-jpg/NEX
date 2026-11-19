package main

import (
	"errors"
	"fmt"
	"net"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// 负载均衡整治路线图里 H1 / H2（下一跳快速探测）的回归测试。

// H1(a)：96 个黑洞下一跳 + 1 个好的。好的那个不被拖慢，96 个都在「失败次数 × 间隔 + 超时」之内判坏。
func TestRouteHopProbeBlackholesDoNotStarveHealthyHop(t *testing.T) {
	if testing.Short() {
		t.Skip("跑 8 秒")
	}
	runner := newRouteHopProbeRunner()
	runner.scanner = nil
	runner.jitter = jitterDuration
	const healthy = "198.51.100.200:443"
	var healthyDials atomic.Int32
	runner.dial = func(network, address string, timeout time.Duration) (net.Conn, error) {
		if address == healthy {
			healthyDials.Add(1)
			client, server := net.Pipe()
			_ = server.Close()
			return client, nil
		}
		time.Sleep(timeout) // 黑洞：等满超时
		return nil, errors.New("i/o timeout")
	}
	spec := &routeHopProbeSpec{IntervalMs: 1500, TimeoutMs: 2000, FailThreshold: 2, RecoverOks: 3}
	probes := []ruleLatencyProbe{{RuleID: 1000, TargetIP: "198.51.100.200", TargetPort: 443, RouteHop: spec}}
	for i := 0; i < 96; i++ {
		probes = append(probes, ruleLatencyProbe{RuleID: i + 1, TargetIP: "203.0.113." + strconv.Itoa(i+1), TargetPort: 443, RouteHop: spec})
	}
	var mu sync.Mutex
	downAt := map[int]time.Duration{}
	started := time.Now()
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		runner.run(stop, func() []ruleLatencyProbe { return probes }, func(results []map[string]any) error {
			mu.Lock()
			defer mu.Unlock()
			for _, result := range results {
				if result["down"] == true {
					if _, seen := downAt[result["ruleId"].(int)]; !seen {
						downAt[result["ruleId"].(int)] = time.Since(started)
					}
				}
			}
			return nil
		})
	}()
	time.Sleep(8 * time.Second)
	close(stop)
	<-done

	// 8 秒里按 1.5 秒一轮该探 5 轮多（一轮成功连 2 次）；至少要有八成。
	expectedRounds := float64(8*time.Second) / float64(1500*time.Millisecond)
	rounds := float64(healthyDials.Load()) / 2
	if rounds < 0.8*expectedRounds {
		t.Fatalf("好的下一跳被黑洞目标拖慢了：8 秒探了 %.1f 轮，应当不少于 %.1f 轮", rounds, 0.8*expectedRounds)
	}
	limit := time.Duration(spec.FailThreshold)*time.Duration(spec.IntervalMs)*time.Millisecond + time.Duration(spec.TimeoutMs)*time.Millisecond
	mu.Lock()
	defer mu.Unlock()
	if len(downAt) != 96 {
		t.Fatalf("96 个黑洞目标应当都判坏并报上去，报了 %d 个", len(downAt))
	}
	for ruleID, at := range downAt {
		if at > limit+2*routeHopProbeTick {
			t.Fatalf("规则 %d 的下一跳 %v 才判坏，上限 %v", ruleID, at, limit)
		}
	}
	if _, wrong := downAt[1000]; wrong {
		t.Fatal("好的那个被判坏了")
	}
}

// H1(b)：翻转报面板失败了不丢，下一拍重报，直到面板收下。
func TestRouteHopProbeKeepsFlipsUntilReportSucceeds(t *testing.T) {
	clock := time.Unix(1_800_000_000, 0)
	reachable := true
	runner := routeHopTestRunner(&clock, &reachable)
	spec := &routeHopProbeSpec{IntervalMs: 1500, TimeoutMs: 1000, FailThreshold: 1, RecoverOks: 1}
	runner.sync([]ruleLatencyProbe{{RuleID: 41, TargetIP: "203.0.113.9", TargetPort: 443, RouteHop: spec}})
	routeHopRound(runner, &clock, 1500*time.Millisecond) // 第一次通：报掉
	reachable = false
	for _, state := range runner.due() {
		runner.probe(state)
	}
	first := runner.pendingReport()
	if first == nil || len(first.results) != 1 || first.results[0]["down"] != true {
		t.Fatalf("翻转应当立刻要报：%#v", first)
	}
	if again := runner.pendingReport(); again != nil {
		t.Fatalf("上一份还在路上，不重复发：%#v", again)
	}
	runner.ack(first, false) // 面板没收下
	clock = clock.Add(routeHopProbeTick)
	retry := runner.pendingReport()
	if retry == nil || len(retry.results) != 1 || retry.results[0]["ruleId"] != 41 || retry.results[0]["down"] != true {
		t.Fatalf("报失败的翻转下一拍要重报（以前要等 30 秒后的全量）：%#v", retry)
	}
	// 重报的途中又翻回来了：这一份成功也不能把新的翻转清掉
	reachable = true
	clock = clock.Add(1500 * time.Millisecond)
	for _, state := range runner.due() {
		runner.probe(state)
	}
	runner.ack(retry, true)
	latest := runner.pendingReport()
	if latest == nil || latest.results[0]["down"] != false {
		t.Fatalf("途中发生的翻转要接着报：%#v", latest)
	}
	runner.ack(latest, true)
	clock = clock.Add(routeHopProbeTick)
	if rest := runner.pendingReport(); rest != nil {
		t.Fatalf("都收下了就没有要报的：%#v", rest.results)
	}
	// 连着失败要退避，不会每一拍都打面板
	reachable = false
	clock = clock.Add(1500 * time.Millisecond)
	for _, state := range runner.due() {
		runner.probe(state)
	}
	attempts := 0
	for tick := 0; tick < 40; tick++ { // 10 秒
		if pending := runner.pendingReport(); pending != nil {
			attempts++
			runner.ack(pending, false)
		}
		clock = clock.Add(routeHopProbeTick)
	}
	if attempts < 3 || attempts > 8 {
		t.Fatalf("面板一直不通时 10 秒里重报 %d 次（应当退避到几秒一次，又不能不报）", attempts)
	}
}

// H1(c)：几条规则探同一个下一跳（地址、参数都一样）只探一份，结果按规则各报各的。
func TestRouteHopProbeSharesOneProbeAcrossRules(t *testing.T) {
	clock := time.Unix(1_800_000_000, 0)
	reachable := true
	runner := routeHopTestRunner(&clock, &reachable)
	dials := 0
	runner.dial = func(network, address string, timeout time.Duration) (net.Conn, error) {
		dials++
		if !reachable {
			return nil, errors.New("refused")
		}
		client, server := net.Pipe()
		_ = server.Close()
		return client, nil
	}
	spec := func() *routeHopProbeSpec {
		return &routeHopProbeSpec{IntervalMs: 1500, TimeoutMs: 1000, FailThreshold: 1, RecoverOks: 1}
	}
	slower := &routeHopProbeSpec{IntervalMs: 3000, TimeoutMs: 1000, FailThreshold: 1, RecoverOks: 1}
	probes := []ruleLatencyProbe{
		{RuleID: 1, TargetIP: "203.0.113.9", TargetPort: 443, RouteHop: spec()},
		{RuleID: 2, TargetIP: "203.0.113.9", TargetPort: 443, RouteHop: spec()},
		{RuleID: 3, TargetIP: "203.0.113.9", TargetPort: 443, RouteHop: spec()},
		{RuleID: 4, TargetIP: "203.0.113.9", TargetPort: 443, RouteHop: slower}, // 参数不一样：各探各的
		{RuleID: 5, TargetIP: "203.0.113.10", TargetPort: 443, RouteHop: spec()},
	}
	runner.sync(probes)
	if len(runner.states) != 3 {
		t.Fatalf("同地址同参数的三条规则共用一份探测：应当 3 份，实际 %d 份", len(runner.states))
	}
	first := routeHopRound(runner, &clock, 1500*time.Millisecond)
	if dials != 6 { // 3 份 × 每轮连 2 次
		t.Fatalf("一轮应当连 6 次（3 份探测），连了 %d 次", dials)
	}
	if len(first) != 5 {
		t.Fatalf("五条规则各报一条：%#v", first)
	}
	for i, result := range first {
		if result["ruleId"] != i+1 || result["down"] != false {
			t.Fatalf("按规则号各报各的：%#v", first)
		}
	}
	reachable = false
	down := routeHopRound(runner, &clock, 1500*time.Millisecond)
	ids := []int{}
	for _, result := range down {
		if result["down"] != true {
			t.Fatalf("翻转了应当报断：%#v", down)
		}
		ids = append(ids, result["ruleId"].(int))
	}
	if fmt.Sprint(ids) != "[1 2 3 5]" { // 规则 4 的间隔是 3 秒，这一轮还没到
		t.Fatalf("共用一份的三条规则一起报翻转：%v", ids)
	}
	// 后来的规则搭上一份已经有结论的探测：立刻替它报一次；走掉的规则不再报
	runner.sync(append(probes[1:], ruleLatencyProbe{RuleID: 9, TargetIP: "203.0.113.9", TargetPort: 443, RouteHop: spec()}))
	joined := runner.report()
	if len(joined) != 1 || joined[0]["ruleId"] != 9 || joined[0]["down"] != true {
		t.Fatalf("新搭上的规则应当马上拿到现成的结论：%#v", joined)
	}
	clock = clock.Add(routeHopProbeSnapshotEvery)
	for _, result := range runner.report() {
		if result["ruleId"] == 1 {
			t.Fatalf("规则 1 已经不在清单里：%#v", result)
		}
	}
}

// H2：真实流量的重传率要过期 —— 流量停了以后主动探测全是通的，丢包率一分钟内回到 0。以前一直停在流量停下那一刻。
func TestRouteHopPassiveLossDecaysAfterTrafficStops(t *testing.T) {
	clock := time.Unix(1_800_000_000, 0)
	reachable := true
	runner := routeHopTestRunner(&clock, &reachable)
	runner.scanner = nil
	spec := &routeHopProbeSpec{IntervalMs: 2000, Passive: true}
	runner.sync([]ruleLatencyProbe{{RuleID: 7, TargetIP: "160.79.104.10", TargetPort: 443, RouteHop: spec}})
	loss := func() float64 {
		clock = clock.Add(routeHopProbeSnapshotEvery) // 逼一次全量
		results := runner.report()
		if len(results) != 1 {
			t.Fatalf("report: %#v", results)
		}
		return results[0]["lossPct"].(float64)
	}
	round := func() {
		for _, state := range runner.due() {
			if !runner.usePassive(state) {
				runner.probe(state)
			}
		}
		clock = clock.Add(2 * time.Second)
	}
	// 一阵 40% 的重传
	for i := 0; i < 20; i++ {
		runner.mu.Lock()
		runner.passive["160.79.104.10:443"] = passiveTargetStats{conns: 2, srttMs: 12, varMs: 1, minMs: 10, segsDelta: 200, retransDelta: 80, at: clock}
		runner.mu.Unlock()
		round()
	}
	// 流量停了：再也读不到到这个目标的连接，只剩主动探测，全是通的
	runner.mu.Lock()
	runner.passive = map[string]passiveTargetStats{}
	runner.mu.Unlock()
	round()
	runner.mu.Lock()
	var state *routeHopProbeState
	for _, s := range runner.states {
		state = s
	}
	before := state.statsAt(clock).loss
	runner.mu.Unlock()
	if before < 0.3 {
		t.Fatalf("流量刚停时重传率还应当在：%.2f", before)
	}
	for i := 0; i < 14; i++ { // 28 秒：还没过期
		round()
	}
	for i := 0; i < 15; i++ { // 再 30 秒
		round()
	}
	if got := loss(); got > 0.5 {
		t.Fatalf("流量停了 60 秒、主动探测全通，丢包率应当回到 0 附近，还报 %.1f%%", got)
	}

	// 流量还在但已经干净：靠平滑自己掉下来，也在一分钟内
	runner2 := routeHopTestRunner(&clock, &reachable)
	runner2.scanner = nil
	runner2.sync([]ruleLatencyProbe{{RuleID: 8, TargetIP: "160.79.104.10", TargetPort: 443, RouteHop: spec}})
	feed := func(retrans uint64) {
		runner2.mu.Lock()
		runner2.passive["160.79.104.10:443"] = passiveTargetStats{conns: 2, srttMs: 12, varMs: 1, minMs: 10, segsDelta: 200, retransDelta: retrans, at: clock}
		runner2.mu.Unlock()
		for _, state := range runner2.due() {
			runner2.usePassive(state)
		}
		clock = clock.Add(2 * time.Second)
	}
	for i := 0; i < 20; i++ {
		feed(80)
	}
	for i := 0; i < 30; i++ {
		feed(0)
	}
	results := runner2.report()
	if len(results) != 1 || results[0]["lossPct"].(float64) > 0.5 {
		t.Fatalf("干净的流量跑了 60 秒，丢包率应当回到 0 附近：%#v", results)
	}
}
