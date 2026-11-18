package main

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// 负载均衡整治路线图（docs/dev/load-balancing-roadmap.md）里线路组那几条的回归测试，按编号。

// A1：两条都健康、一条 300ms 一条 30ms，开着「择优」和「恢复后切回」—— 切到快的那条一次，之后一小时不再动。
// 以前择优切过去、下一轮「首选恢复，切回」又拽回来，来回切到被抖动抑制钉住。
func TestFailoverPreferFastestDoesNotFightAutoFailback(t *testing.T) {
	drainFailoverEvents()
	proxy := routeTestProxy(failoverSpec{Strategy: "fallback", AutoFailback: true, PreferFastest: true, Targets: routeTargets(2), ScoreMargin: 10, ScoreHoldSeconds: 60})
	proxy.mu.Lock()
	defer proxy.mu.Unlock()
	start := time.Now()
	switches := 0
	last := proxy.activeIndex
	for elapsed := time.Duration(0); elapsed <= time.Hour; elapsed += 5 * time.Second {
		now := start.Add(elapsed)
		proxy.statsLocked(0).recordProbe(true, 300, now)
		proxy.statsLocked(1).recordProbe(true, 30, now)
		proxy.lastLatencyMs[0], proxy.lastLatencyMs[1] = 300, 30
		proxy.updateFallbackActiveAtLocked(now, "health check")
		if proxy.activeIndex != last {
			switches++
			last = proxy.activeIndex
		}
	}
	if switches != 1 || proxy.activeIndex != 1 {
		t.Fatalf("应当只切一次、停在快的那条上：切了 %d 次，现在走第 %d 条", switches, proxy.activeIndex)
	}
}

// A1 的另一半：按顺序切回该留的都还在 —— 没开择优、分层规格里当前这条在更差的一层。
func TestFailoverOrderFailbackStillWorksWhereItShould(t *testing.T) {
	now := time.Now()
	plain := routeTestProxy(failoverSpec{Strategy: "fallback", AutoFailback: true, Targets: routeTargets(2)})
	plain.mu.Lock()
	plain.activeIndex = 1
	plain.updateFallbackActiveAtLocked(now, "health check")
	if plain.activeIndex != 0 {
		t.Fatalf("没开择优：首选健康就该切回，现在走第 %d 条", plain.activeIndex)
	}
	plain.mu.Unlock()

	tiered := routeTestProxy(failoverSpec{Strategy: "fallback", AutoFailback: true, PreferFastest: true, Targets: tieredTargets(0, 0, 1)})
	tiered.mu.Lock()
	tiered.activeIndex = 2
	tiered.updateFallbackActiveAtLocked(now, "health check")
	if tiered.activeIndex != 0 {
		t.Fatalf("分层：走着备用组而主组健康，应当回主组，现在走第 %d 条", tiered.activeIndex)
	}
	// 同一层的两条之间不按顺序切回：谁该走由评分说。
	tiered.activeIndex = 1
	tiered.updateFallbackActiveAtLocked(now.Add(time.Hour), "health check")
	if tiered.activeIndex != 1 {
		t.Fatalf("同一层里不该按数组顺序切回，现在走第 %d 条", tiered.activeIndex)
	}
	tiered.mu.Unlock()
}

// A2：探测目标已经死了、拨号地址（第一跳）照样接得住连接 —— 以前每条业务连接拨通都把探测攒的失败清零，
// 这条线路永远判不坏。
func TestFailoverDialSuccessDoesNotMaskProbeFailures(t *testing.T) {
	closed := failoverTestPort(t) // 没人监听：探测一直不通
	proxy := routeTestProxy(failoverSpec{Strategy: "fallback", AutoFailback: true, FailoverSeconds: 1, FailureThreshold: 3, Targets: []failoverTarget{
		{TargetIP: "127.0.0.1", TargetPort: 9, ProbeIP: "127.0.0.1", ProbePort: closed},
		{TargetIP: "127.0.0.1", TargetPort: 10, ProbeIP: "127.0.0.1", ProbePort: closed},
	}})
	deadline := time.Now().Add(6 * time.Second)
	for time.Now().Before(deadline) {
		proxy.checkHealth()
		// 探测之间真实连接一直在拨通
		proxy.markDialSuccess(0, 5*time.Millisecond)
		proxy.mu.RLock()
		down := !proxy.targetHealth[0]
		proxy.mu.RUnlock()
		if down {
			return
		}
		time.Sleep(400 * time.Millisecond)
	}
	t.Fatal("探测连着失败、也过了「异常多久切」，可拨号成功一直把失败清零，线路没被判坏")
}

// A2：两本账各清各的。
func TestFailoverProbeAndDialFailuresAreCountedSeparately(t *testing.T) {
	proxy := routeTestProxy(failoverSpec{Strategy: "fallback", Targets: routeTargets(2), FailureThreshold: 5})
	now := time.Now()
	proxy.mu.Lock()
	stats := proxy.statsLocked(0)
	stats.recordProbe(false, 0, now)
	stats.recordProbe(false, 0, now)
	proxy.mu.Unlock()
	proxy.markTargetFailure(0, "dial failed")
	proxy.markDialSuccess(0, 5*time.Millisecond)
	if stats.probeFailures != 2 || stats.dialFailures != 0 {
		t.Fatalf("拨通只清拨号那本：probe=%d dial=%d", stats.probeFailures, stats.dialFailures)
	}
	proxy.markTargetFailure(0, "dial failed")
	proxy.mu.Lock()
	stats.recordProbe(true, 10, now)
	proxy.mu.Unlock()
	if stats.probeFailures != 0 || stats.dialFailures != 1 {
		t.Fatalf("探通只清探测那本：probe=%d dial=%d", stats.probeFailures, stats.dialFailures)
	}
}

// A4：同一瞬间一起失败的一串拨号算一次；之后各自独立的失败照样凑够门槛当场判坏。
func TestFailoverConcurrentDialFailuresCountOnce(t *testing.T) {
	drainFailoverEvents()
	proxy := routeTestProxy(failoverSpec{Strategy: "fallback", AutoFailback: true, Targets: routeTargets(2), FailureThreshold: 3})
	started := time.Now().Add(-50 * time.Millisecond) // 50 条连接差不多同时发起
	refused := &net.OpError{Op: "dial", Err: os.NewSyscallError("connect", syscall.ECONNREFUSED)}
	for i := 0; i < 50; i++ {
		proxy.markDialFailure(0, "dial failed", started, refused)
	}
	proxy.mu.RLock()
	healthy, failures := proxy.targetHealth[0], proxy.stats[0].dialFailures
	proxy.mu.RUnlock()
	if !healthy || failures != 1 {
		t.Fatalf("一串并发失败应当只算 1 次：healthy=%v failures=%d", healthy, failures)
	}
	// 真断了：之后发起的连接接着失败，第 3 次当场判坏（不等探测）。
	for i := 0; i < 2; i++ {
		proxy.markDialFailure(0, "dial failed", time.Now(), refused)
	}
	proxy.mu.RLock()
	healthy, active := proxy.targetHealth[0], proxy.activeIndex
	proxy.mu.RUnlock()
	if healthy || active != 1 {
		t.Fatalf("连着 3 次独立的失败应当判坏并切走：healthy=%v active=%d", healthy, active)
	}
}

// A4：本机的错误（fd、临时端口、内存用完，我们自己取消的拨号）不算线路的账。
func TestFailoverLocalDialErrorsAreNotPathFailures(t *testing.T) {
	proxy := routeTestProxy(failoverSpec{Strategy: "fallback", Targets: routeTargets(2), FailureThreshold: 1})
	local := []error{
		&net.OpError{Op: "dial", Err: os.NewSyscallError("socket", syscall.EMFILE)},
		&net.OpError{Op: "dial", Err: os.NewSyscallError("socket", syscall.ENFILE)},
		&net.OpError{Op: "dial", Err: os.NewSyscallError("connect", syscall.EADDRNOTAVAIL)},
		&net.OpError{Op: "dial", Err: os.NewSyscallError("socket", syscall.ENOBUFS)},
		&net.OpError{Op: "dial", Err: os.NewSyscallError("socket", syscall.ENOMEM)},
		&net.OpError{Op: "dial", Err: context.Canceled},
	}
	for _, err := range local {
		if !failoverLocalDialError(err) {
			t.Fatalf("%v 应当认成本机错误", err)
		}
		proxy.markDialFailure(0, "dial failed", time.Now(), err)
	}
	proxy.mu.RLock()
	healthy, failures, dials := proxy.targetHealth[0], proxy.stats[0].dialFailures, len(proxy.stats[0].dials)
	proxy.mu.RUnlock()
	if !healthy || failures != 0 || dials != 0 {
		t.Fatalf("本机错误不该记到线路头上：healthy=%v failures=%d dials=%d", healthy, failures, dials)
	}
	for _, err := range []error{nil, errors.New("refused"), &net.OpError{Op: "dial", Err: os.NewSyscallError("connect", syscall.ECONNREFUSED)}, context.DeadlineExceeded} {
		if failoverLocalDialError(err) {
			t.Fatalf("%v 是线路的问题，不是本机的", err)
		}
	}
	proxy.markDialFailure(0, "dial failed", time.Now(), errors.New("refused"))
	proxy.mu.RLock()
	healthy = proxy.targetHealth[0]
	proxy.mu.RUnlock()
	if healthy {
		t.Fatal("线路的错误照旧：阈值 1，一次就判坏")
	}
}

// A5：全挂兜底不走被暂停 / 维护的路径；中转断了、主机离线这些健康类的提示照旧可以兜底；全被排除就没有。
func TestFailoverLastResortNeverUsesAdminExcludedPaths(t *testing.T) {
	for _, strategy := range []string{"fallback", "weighted", "least_load", "auto", "round_robin", "random", "ip_hash"} {
		targets := routeTargets(4)
		targets[0].Down, targets[0].DownReason = true, "paused"
		targets[1].Down, targets[1].DownReason = true, "maintenance: HK2"
		targets[2].Down, targets[2].DownReason = true, "relay down: HK1 → 10.0.0.9:443"
		targets[3].Down, targets[3].DownReason = true, "node offline: JP1"
		proxy := routeTestProxy(failoverSpec{Strategy: strategy, Targets: targets})
		seen := map[int]bool{}
		for i := 0; i < 200; i++ {
			_, index := proxy.pickTargetForKey("198.51.100."+strconv.Itoa(i), nil)
			seen[index] = true
		}
		if seen[0] || seen[1] || seen[-1] || len(seen) == 0 {
			t.Fatalf("%s：兜底只该落在中转断 / 离线的那两条上，拿到 %v", strategy, seen)
		}
		// UDP 会话也一样
		if _, index := proxy.pickTargetForKeyProto("198.51.100.1:5000", nil, true); index != 2 && index != 3 {
			t.Fatalf("%s：UDP 兜底落在了第 %d 条", strategy, index)
		}
		// 剩下两条也被管理上排除：没有路径可走
		proxy.mu.Lock()
		next := append([]failoverTarget(nil), proxy.spec.Targets...)
		next[2].DownReason, next[3].DownReason = "quota: HK1", "maintenance: JP1"
		proxy.applyRelayHintsLocked(next)
		proxy.mu.Unlock()
		if _, index := proxy.pickTargetForKey("198.51.100.1", nil); index != -1 {
			t.Fatalf("%s：全是暂停 / 维护 / 停机时不该有路径，拿到第 %d 条", strategy, index)
		}
	}
	for reason, admin := range map[string]bool{"paused": true, "maintenance: HK2": true, "quota: x": true, "Maintenance": true, "relay down": false, "node offline: a": false, "breaker: a": false, "drill": false, "": false, "出口连不上目标": false, "pausedx": false} {
		if failoverAdminDownReason(reason) != admin {
			t.Fatalf("原因 %q 的归类不对", reason)
		}
	}
}

// A6：非主备策略下路径判坏：UDP 会话一律关；TCP 连接 fast / force 关、smooth 不动。
func TestRouteGroupSpreadPathDownClosesPinnedTraffic(t *testing.T) {
	sink, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer sink.Close()
	for _, tc := range []struct {
		mode     string
		closeTCP bool
	}{{"smooth", false}, {"fast", true}, {"force", true}} {
		proxy := routeTestProxy(failoverSpec{Strategy: "round_robin", Protocol: "udp", SwitchMode: tc.mode, Targets: routeTargets(2)})
		// 这里把一条 TCP 连接也记在路径名下：规格是只转 UDP 的，主健康坏了算 UDP 坏；TCP 那一刀用 both 再测。
		udpConn, err := net.DialUDP("udp", nil, sink.LocalAddr().(*net.UDPAddr))
		if err != nil {
			t.Fatal(err)
		}
		other, err := net.DialUDP("udp", nil, sink.LocalAddr().(*net.UDPAddr))
		if err != nil {
			t.Fatal(err)
		}
		proxy.trackConn(0, udpConn)
		proxy.trackConn(1, other)
		proxy.markTargetFailure(0, "dial failed")
		if _, err := udpConn.Write([]byte("x")); !errors.Is(err, net.ErrClosed) {
			t.Fatalf("%s：坏路径上的 UDP 会话应当被关掉（下一个包重挑），写的结果 %v", tc.mode, err)
		}
		if _, err := other.Write([]byte("x")); err != nil {
			t.Fatalf("%s：别的路径上的会话不该动：%v", tc.mode, err)
		}
		_ = other.Close()

		tcpProxy := routeTestProxy(failoverSpec{Strategy: "least_load", Protocol: "tcp", SwitchMode: tc.mode, Targets: routeTargets(2)})
		client, server := net.Pipe()
		defer server.Close()
		tcpProxy.trackConn(0, client)
		tcpProxy.markTargetFailure(0, "dial failed")
		_ = server.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
		_, readErr := server.Read(make([]byte, 1))
		closed := readErr != nil && !errors.Is(readErr, os.ErrDeadlineExceeded)
		if closed != tc.closeTCP {
			t.Fatalf("%s：坏路径上的 TCP 连接 closed=%v，应当 %v（%v）", tc.mode, closed, tc.closeTCP, readErr)
		}
		_ = client.Close()
	}
}

// A6：UDP 黑洞流 —— 发了够多、够久、一个没回，而且这条路径 UDP 那一侧是坏的、别的路径能用，才重挑。
func TestRouteGroupUDPBlackholedSessionRepicksOnlyWhenPathIsDown(t *testing.T) {
	sink, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer sink.Close()
	proxy := routeTestProxy(failoverSpec{Strategy: "round_robin", Protocol: "udp", Targets: routeTargets(2)})
	newSession := func() *failoverUDPSession {
		upstream, err := net.DialUDP("udp", nil, sink.LocalAddr().(*net.UDPAddr))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = upstream.Close() })
		return &failoverUDPSession{upstream: upstream, index: 0}
	}
	start := time.Now()
	session := newSession()
	// 路径健康：单向协议发多少、发多久都不重挑
	for i := 0; i < 100; i++ {
		if proxy.repickBlackholedUDP(session, 1, start.Add(time.Duration(i)*time.Second)) {
			t.Fatal("路径健康时不能因为没回包就重挑（单向的 UDP 协议本来就不回）")
		}
	}
	// 路径坏了但别的也都坏：没处可去，不动
	proxy.mu.Lock()
	proxy.targetHealth[0], proxy.targetHealth[1] = false, false
	proxy.mu.Unlock()
	if proxy.repickBlackholedUDP(session, 1, start.Add(200*time.Second)) {
		t.Fatal("别的路径都不能用时重挑没有意义")
	}
	// 另一条能用：重挑
	proxy.mu.Lock()
	proxy.targetHealth[1] = true
	proxy.mu.Unlock()
	if !proxy.repickBlackholedUDP(session, 1, start.Add(300*time.Second)) {
		t.Fatal("路径坏了、别的能用、发了一百多个包一个没回：应当重挑")
	}
	// 有回包就不是黑洞：计数清零，哪怕路径被判坏也要重新攒够
	fresh := newSession()
	fresh.noteSent(50, start)
	fresh.noteReply()
	if proxy.repickBlackholedUDP(fresh, 1, start.Add(time.Minute)) || proxy.repickBlackholedUDP(fresh, 1, start.Add(time.Minute+time.Second)) {
		t.Fatal("刚回过包的会话不算黑洞")
	}
	// 没攒够数量 / 时间也不动
	few := newSession()
	few.noteSent(1, start)
	if proxy.repickBlackholedUDP(few, 1, start.Add(time.Hour)) {
		t.Fatal("只发了两个包不算")
	}
	quick := newSession()
	quick.noteSent(1, start)
	if proxy.repickBlackholedUDP(quick, 500, start.Add(2*time.Second)) {
		t.Fatal("两秒里发得再多也不算（还没等够）")
	}
}

// A7：域名解析缓存过期时先用旧地址、后台刷新；只有从来没解析出来过才算「解析中」。
func TestFailoverUDPResolveServesStaleWhileRefreshing(t *testing.T) {
	oldLookup, oldNow := failoverUDPLookup, failoverUDPResolveNow
	failoverUDPResolveMu.Lock()
	oldCache := failoverUDPResolveCache
	failoverUDPResolveCache = map[string]failoverUDPResolveEntry{}
	failoverUDPResolveMu.Unlock()
	var clockMu sync.Mutex
	clock := time.Unix(1_800_000_000, 0)
	advance := func(d time.Duration) {
		clockMu.Lock()
		clock = clock.Add(d)
		clockMu.Unlock()
	}
	failoverUDPResolveNow = func() time.Time {
		clockMu.Lock()
		defer clockMu.Unlock()
		return clock
	}
	var lookups atomic.Int32
	answers := make(chan any, 8) // net.IP 或 error
	failoverUDPLookup = func(ctx context.Context, host string) ([]net.IPAddr, error) {
		lookups.Add(1)
		switch answer := (<-answers).(type) {
		case net.IP:
			return []net.IPAddr{{IP: answer}}, nil
		case error:
			return nil, answer
		}
		return nil, errors.New("no answer")
	}
	inflightDone := func() {
		t.Helper()
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) {
			failoverUDPResolveMu.Lock()
			busy := len(failoverUDPResolveInflight) > 0
			failoverUDPResolveMu.Unlock()
			if !busy {
				return
			}
			time.Sleep(5 * time.Millisecond)
		}
		t.Fatal("后台解析没结束")
	}
	t.Cleanup(func() {
		close(answers)
		inflightDone()
		failoverUDPLookup, failoverUDPResolveNow = oldLookup, oldNow
		failoverUDPResolveMu.Lock()
		failoverUDPResolveCache = oldCache
		failoverUDPResolveMu.Unlock()
	})
	const host = "stale.example.test"

	if _, pending, _ := failoverUDPResolve(host, 53); !pending {
		t.Fatal("从没解析过：这一次是解析中")
	}
	answers <- net.IPv4(192, 0, 2, 1)
	inflightDone()
	addr, pending, err := failoverUDPResolve(host, 53)
	if pending || err != nil || addr == nil || !addr.IP.Equal(net.IPv4(192, 0, 2, 1)) {
		t.Fatalf("解析好了应当直接给地址：%v pending=%v err=%v", addr, pending, err)
	}

	// 过了 TTL：旧地址照用（不是解析中），同时后台去刷新
	advance(failoverUDPResolveTTL + time.Second)
	addr, pending, err = failoverUDPResolve(host, 53)
	if pending || err != nil || addr == nil || !addr.IP.Equal(net.IPv4(192, 0, 2, 1)) {
		t.Fatalf("缓存过期时应当先用旧地址：%v pending=%v err=%v", addr, pending, err)
	}
	for deadline := time.Now().Add(2 * time.Second); lookups.Load() < 2 && time.Now().Before(deadline); {
		time.Sleep(5 * time.Millisecond)
	}
	if lookups.Load() != 2 {
		t.Fatalf("过期应当触发一次后台刷新：%d", lookups.Load())
	}
	answers <- net.IPv4(192, 0, 2, 2)
	inflightDone()
	if addr, _, _ = failoverUDPResolve(host, 53); addr == nil || !addr.IP.Equal(net.IPv4(192, 0, 2, 2)) {
		t.Fatalf("刷新完用新地址：%v", addr)
	}

	// 刷新失败：旧地址留着接着用
	advance(failoverUDPResolveTTL + time.Second)
	_, _, _ = failoverUDPResolve(host, 53)
	answers <- errors.New("servfail")
	inflightDone()
	addr, pending, err = failoverUDPResolve(host, 53)
	if pending || err != nil || addr == nil || !addr.IP.Equal(net.IPv4(192, 0, 2, 2)) {
		t.Fatalf("刷新失败不该丢掉还能用的旧地址：%v pending=%v err=%v", addr, pending, err)
	}

	// 旧到超过上限（5 分钟）还刷新不出来：不再用
	advance(failoverUDPResolveMaxStale)
	addr, pending, _ = failoverUDPResolve(host, 53)
	if addr != nil {
		t.Fatalf("旧地址最多用 %v：%v pending=%v", failoverUDPResolveMaxStale, addr, pending)
	}
	answers <- errors.New("servfail")
	inflightDone()
}

// A8：一下子进来 50 条连接（挑的时候谁都还没拨通），「按负载」「自动」要分开，不能全压一条。
func TestRouteGroupBalanceBurstSpreadsByInFlightPicks(t *testing.T) {
	for _, strategy := range []string{"least_load", "auto"} {
		equal := routeTestProxy(failoverSpec{Strategy: strategy, Targets: routeTargets(2)})
		counts := map[int]int{}
		reservations := []failoverReservation{}
		for i := 0; i < 50; i++ {
			_, index, reservation := equal.pickReserved("", nil, false)
			counts[index]++
			reservations = append(reservations, reservation)
		}
		if counts[0] < 24 || counts[0] > 26 || counts[0]+counts[1] != 50 {
			t.Fatalf("%s：两条一样的路径 50 条突发应当 25/25（±1），拿到 %v", strategy, counts)
		}
		// 拨失败 / 竞速输了：退掉，负载回到 0
		for _, reservation := range reservations {
			equal.releaseReservation(reservation)
		}
		equal.mu.Lock()
		if equal.loadLocked(0) != 0 || equal.loadLocked(1) != 0 {
			t.Fatalf("%s：在途退完应当是 0：%d %d", strategy, equal.loadLocked(0), equal.loadLocked(1))
		}
		equal.mu.Unlock()

		targets := routeTargets(2)
		targets[0].Weight, targets[1].Weight = 50, 100
		weighted := routeTestProxy(failoverSpec{Strategy: strategy, Targets: targets})
		counts = map[int]int{}
		for i := 0; i < 60; i++ {
			_, index, _ := weighted.pickReserved("", nil, false)
			counts[index]++
		}
		if counts[0] < 18 || counts[0] > 22 {
			t.Fatalf("%s：权重 50/100 的 60 条突发应当约 20/40，拿到 %v", strategy, counts)
		}
	}
	// 拨通：在途转成连接，不多算也不少算；报给面板的连接数只是挂着的。
	proxy := routeTestProxy(failoverSpec{Strategy: "least_load", Targets: routeTargets(2)})
	_, index, reservation := proxy.pickReserved("", nil, false)
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	proxy.mu.Lock()
	if proxy.connectionsLocked(index) != 0 || proxy.loadLocked(index) != 1 {
		t.Fatalf("挑中还没拨通：连接 0、负载 1，拿到 %d %d", proxy.connectionsLocked(index), proxy.loadLocked(index))
	}
	proxy.mu.Unlock()
	proxy.trackConnReserved(index, client, reservation)
	proxy.mu.Lock()
	if proxy.connectionsLocked(index) != 1 || proxy.loadLocked(index) != 1 {
		t.Fatalf("拨通以后：连接 1、负载 1，拿到 %d %d", proxy.connectionsLocked(index), proxy.loadLocked(index))
	}
	// 换规格以后旧的在途作废，不会把新下标减成负数或者减到别的路径上
	_, _, stale := func() (failoverTarget, int, failoverReservation) {
		proxy.mu.Unlock()
		defer proxy.mu.Lock()
		return proxy.pickReserved("", nil, false)
	}()
	next := proxy.spec
	next.Targets = append([]failoverTarget{{TargetIP: "10.0.9.9", TargetPort: 80}}, proxy.spec.Targets...)
	proxy.rebuildForSpecLocked(normalizeFailoverSpec(next), time.Now())
	fresh := proxy.reserveLocked(stale.index)
	proxy.releaseReservationLocked(stale)
	if proxy.inflight[stale.index] != 1 {
		t.Fatalf("旧一代的在途不该退到新下标上：%v", proxy.inflight)
	}
	proxy.releaseReservationLocked(fresh)
	proxy.mu.Unlock()
}

// A8 端到端：60 条连接同时连进来，权重 50 / 100 的两条路径按 1:2 分。以前拨通之后才记数，挑的时候两条都是
// 0 个连接，60 条全压到权重大的那条上（权重一样时靠平手轮转碰巧分得开，所以这里用不一样的权重）。
func TestRouteGroupBalanceBurstOfRealConnectionsSpreads(t *testing.T) {
	oldDir := persistentFailoverDir
	persistentFailoverDir = filepath.Join(t.TempDir(), "failover")
	t.Cleanup(func() { persistentFailoverDir = oldDir })
	portA, portB := failoverEchoBackend(t), failoverEchoBackend(t)
	var dialsA, dialsB atomic.Int32
	hook := failoverDialFunc(func(ctx context.Context, network, address string) (net.Conn, error) {
		_, port, _ := net.SplitHostPort(address)
		switch port {
		case strconv.Itoa(portA):
			dialsA.Add(1)
		case strconv.Itoa(portB):
			dialsB.Add(1)
		}
		// 握手要一会儿：这段时间里 50 条连接都已经挑完路径了
		select {
		case <-time.After(150 * time.Millisecond):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		var dialer net.Dialer
		return dialer.DialContext(ctx, network, address)
	})
	failoverTCPDialHook.Store(&hook)
	t.Cleanup(func() { failoverTCPDialHook.Store(nil) })

	const ruleID, sourcePort = 972001, 62001
	listenPort := failoverTestPort(t)
	spec := failoverTestSpec(listenPort)
	spec.Strategy = "least_load"
	spec.Targets = []failoverTarget{{TargetIP: "127.0.0.1", TargetPort: portA, Weight: 50}, {TargetIP: "127.0.0.1", TargetPort: portB, Weight: 100}}
	t.Cleanup(func() { stopFailoverProxy(ruleID, sourcePort) })
	if !startFailoverProxy(ruleID, sourcePort, spec, nil) {
		t.Fatal("proxy did not start")
	}
	// 等起代理时的那一轮探测过去（它也走拨号钩子），再清零计数
	time.Sleep(400 * time.Millisecond)
	dialsA.Store(0)
	dialsB.Store(0)
	var wg sync.WaitGroup
	for i := 0; i < 60; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			conn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(listenPort)), 2*time.Second)
			if err != nil {
				return
			}
			defer conn.Close()
			_, _ = conn.Write([]byte("ping"))
			_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
			_, _ = conn.Read(make([]byte, 4))
		}()
	}
	wg.Wait()
	a, b := int(dialsA.Load()), int(dialsB.Load())
	if a+b < 60 || a < 15 || a > 25 {
		t.Fatalf("60 条同时进来的连接应当按权重约 20 / 40 分，实际拨了 %d / %d", a, b)
	}
}

// A11：面板提示撤掉、UDP 那一侧恢复也慢启动；换规格时慢启动和加权轮询的状态跟着路径走。
func TestRouteGroupSlowStartOnHintAndUDPRecoveryAndRemap(t *testing.T) {
	proxy := routeTestProxy(failoverSpec{Strategy: "weighted", Protocol: "both", RecoverSeconds: 1, FailoverSeconds: 1, Targets: routeTargets(3)})
	proxy.mu.Lock()
	defer proxy.mu.Unlock()
	now := time.Now()
	down := append([]failoverTarget(nil), proxy.spec.Targets...)
	down[1].Down, down[1].DownReason = true, "relay down: x"
	proxy.applyRelayHintsLocked(down)
	if proxy.slowStartLocked(1, now) != 1 {
		t.Fatal("还没恢复不该有慢启动")
	}
	up := append([]failoverTarget(nil), proxy.spec.Targets...)
	up[1].Down, up[1].DownReason = false, ""
	proxy.applyRelayHintsLocked(up)
	if got := proxy.slowStartLocked(1, time.Now()); got > 0.2 {
		t.Fatalf("面板提示刚撤掉应当从一成起慢慢加量，系数 %.2f", got)
	}
	proxy.pickingUDP = true
	if got := proxy.slowStartLocked(1, time.Now()); got > 0.2 {
		t.Fatalf("面板提示撤掉，UDP 会话也慢启动，系数 %.2f", got)
	}
	proxy.pickingUDP = false

	// UDP 那一侧自己断了又好了：只有 UDP 会话慢启动，TCP 的份额不动
	fail, ok := []bool{true, true, false}, []bool{true, true, true}
	latency := []int{5, 5, 5}
	proxy.applyUDPProbeLocked(fail, latency, now)
	proxy.applyUDPProbeLocked(fail, latency, now.Add(2*time.Second))
	if proxy.udpSide.health[2] {
		t.Fatal("UDP 那一侧应当判坏了")
	}
	proxy.applyUDPProbeLocked(ok, latency, now.Add(3*time.Second))
	proxy.applyUDPProbeLocked(ok, latency, now.Add(5*time.Second))
	if !proxy.udpSide.health[2] {
		t.Fatal("UDP 那一侧应当恢复了")
	}
	recovered := now.Add(5 * time.Second)
	if got := proxy.slowStartLocked(2, recovered.Add(time.Second)); got != 1 {
		t.Fatalf("UDP 恢复不该压 TCP 的份额，系数 %.2f", got)
	}
	proxy.pickingUDP = true
	if got := proxy.slowStartLocked(2, recovered.Add(time.Second)); got > 0.2 {
		t.Fatalf("UDP 那一侧刚恢复，UDP 会话应当慢启动，系数 %.2f", got)
	}
	proxy.pickingUDP = false

	// 换规格：前面插一条。慢启动、加权轮询的计数跟着原来那条路径到新下标上。
	proxy.weightedPickLocked([]int{0, 1, 2})
	wrr := append([]int(nil), proxy.wrrCurrent...)
	mark := proxy.slowStartAt[1]
	udpMark := proxy.udpSide.slowStartAt[2]
	next := proxy.spec
	next.Targets = append([]failoverTarget{{TargetIP: "10.0.9.9", TargetPort: 80}}, proxy.spec.Targets...)
	proxy.rebuildForSpecLocked(normalizeFailoverSpec(next), time.Now())
	if !proxy.slowStartAt[2].Equal(mark) || !proxy.slowStartAt[0].IsZero() || !proxy.slowStartAt[1].IsZero() {
		t.Fatalf("慢启动的时刻应当跟着路径挪到下标 2：%v", proxy.slowStartAt)
	}
	if !proxy.udpSide.slowStartAt[3].Equal(udpMark) {
		t.Fatalf("UDP 那一侧的慢启动也要跟着挪：%v", proxy.udpSide.slowStartAt)
	}
	if len(proxy.wrrCurrent) != 4 || proxy.wrrCurrent[0] != 0 || proxy.wrrCurrent[1] != wrr[0] || proxy.wrrCurrent[2] != wrr[1] || proxy.wrrCurrent[3] != wrr[2] {
		t.Fatalf("加权轮询的计数应当跟着路径挪：原来 %v 现在 %v", wrr, proxy.wrrCurrent)
	}
}

// A12：出站条数变了以后，只拿读锁的路径（竞速拨号里的 healthyLocked）不能再去重配切片。用 -race 跑。
func TestRouteGroupRebuildThenConcurrentDialsHasNoRace(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			_ = conn.Close()
		}
	}()
	port := listener.Addr().(*net.TCPAddr).Port
	targets := func(count int) []failoverTarget {
		out := make([]failoverTarget, count)
		for i := range out {
			out[i] = failoverTarget{TargetIP: "127.0.0.1", TargetPort: port, ProbeIP: "127.0.0.1", ProbePort: port + i + 1, Weight: 50}
		}
		return out
	}
	// 手搭的代理（没调过 ensure），再换成条数不同的规格 —— 换完那一刻所有切片必须已经配齐。
	proxy := &failoverProxy{ruleID: 96, sourcePort: 21006, spec: normalizeFailoverSpec(failoverSpec{Enabled: true, ListenPort: 64101, Strategy: "weighted", Targets: targets(2)})}
	for round, count := range []int{5, 3, 7} {
		proxy.mu.Lock()
		next := proxy.spec
		next.Targets = targets(count)
		proxy.rebuildForSpecLocked(normalizeFailoverSpec(next), time.Now())
		for _, slice := range []int{len(proxy.targetHealth), len(proxy.relayDown), len(proxy.drillEndedAt), len(proxy.slowStartAt), len(proxy.inflight), len(proxy.conns), len(proxy.stats), len(proxy.udpSide.health)} {
			if slice != count {
				proxy.mu.Unlock()
				t.Fatalf("第 %d 次换规格后切片没配齐：%d != %d", round, slice, count)
			}
		}
		proxy.mu.Unlock()
		var wg sync.WaitGroup
		for worker := 0; worker < 16; worker++ {
			wg.Add(1)
			go func(worker int) {
				defer wg.Done()
				for i := 0; i < 20; i++ {
					proxy.mu.RLock()
					_ = proxy.healthyLocked((worker + i) % count)
					_ = proxy.udpUsableLocked((worker + i) % count)
					_ = proxy.raceAllowedLocked()
					_ = proxy.raceDelayLocked((worker + i) % count)
					proxy.mu.RUnlock()
					if i%5 == 0 {
						target, index, reservation := proxy.pickReserved("", nil, false)
						conn, _, _, reservation, err := proxy.dialFailoverPathReserved("", target, index, reservation, map[int]bool{}, time.Second)
						proxy.releaseReservation(reservation)
						if err == nil {
							_ = conn.Close()
						}
					}
				}
			}(worker)
		}
		wg.Wait()
	}
}

// A13：规格没变就不重写、不 fsync；变了、或者文件没了才写。
func TestFailoverSpecPersistSkipsUnchangedWrites(t *testing.T) {
	oldDir := persistentFailoverDir
	persistentFailoverDir = filepath.Join(t.TempDir(), "failover")
	t.Cleanup(func() { persistentFailoverDir = oldDir })
	spec := failoverTestSpec(65031)
	before := persistentJSONWrites.Load()
	for i := 0; i < 20; i++ {
		// 面板每次心跳带来的提示在变：不落盘，所以不算变化
		spec.Targets[0].LoadPct = i
		spec.Targets[1].Down = i%2 == 0
		if err := persistFailoverSpec(7, 30007, spec); err != nil {
			t.Fatal(err)
		}
	}
	if writes := persistentJSONWrites.Load() - before; writes != 1 {
		t.Fatalf("同一份规格同步 20 次应当只写 1 次盘，写了 %d 次", writes)
	}
	spec.MinHoldSeconds = 30
	if err := persistFailoverSpec(7, 30007, spec); err != nil {
		t.Fatal(err)
	}
	if writes := persistentJSONWrites.Load() - before; writes != 2 {
		t.Fatalf("规格变了要写：%d", writes)
	}
	if err := os.Remove(persistentFailoverPath(7, 30007)); err != nil {
		t.Fatal(err)
	}
	if err := persistFailoverSpec(7, 30007, spec); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(persistentFailoverPath(7, 30007)); err != nil {
		t.Fatalf("文件没了要重写：%v", err)
	}
	removePersistedFailoverSpec(7, 30007)
	if err := persistFailoverSpec(7, 30007, spec); err != nil {
		t.Fatal(err)
	}
	if loaded := loadPersistedFailovers(); len(loaded) != 1 || loaded[0].Spec.MinHoldSeconds != 30 {
		t.Fatalf("删掉之后再存要真的写下去：%+v", loaded)
	}
}

// A13：探测间隔的抖动在 ±10% 以内，而且真的在抖。
func TestFailoverProbeIntervalJitterStaysWithinTenPercent(t *testing.T) {
	base := 5 * time.Second
	seen := map[time.Duration]bool{}
	for i := 0; i < 500; i++ {
		got := jitterDuration(base)
		if got < base*9/10 || got > base*11/10 {
			t.Fatalf("抖动超出 ±10%%：%v", got)
		}
		seen[got] = true
	}
	if len(seen) < 100 {
		t.Fatalf("间隔没有抖：500 次只有 %d 个不同的值", len(seen))
	}
	if jitterDuration(0) != 0 {
		t.Fatal("0 还是 0")
	}
}

// A13：每条连接拨通都要看探测延迟 —— 样本没变时不重算（以前每次都在写锁里排一遍序），拨号记录也不再每次整段复制。
func TestRouteGroupDialBookkeepingStaysCheapAndBounded(t *testing.T) {
	stats := &routeTargetStats{}
	now := time.Now()
	for i := 0; i < routeSampleWindow; i++ {
		stats.recordProbe(true, 20+i%7, now)
	}
	first := stats.summary()
	if allocs := testing.AllocsPerRun(100, func() { _ = stats.summary() }); allocs != 0 {
		t.Fatalf("样本没变时 summary 不该再分配、排序：%.0f 次分配", allocs)
	}
	stats.recordProbe(false, 0, now)
	if second := stats.summary(); second.lossPct == first.lossPct {
		t.Fatal("来了新样本要重算")
	}
	for i := 0; i < 5000; i++ {
		stats.recordDial(true, 5, now.Add(time.Duration(i)*time.Millisecond), 20)
	}
	if len(stats.dials) > 2*routeDialMaxSamples {
		t.Fatalf("拨号记录要有上限：%d", len(stats.dials))
	}
	if summary := stats.dialSummary(now.Add(5 * time.Second)); summary.ok != routeDialMaxSamples {
		t.Fatalf("汇总只看最近 %d 次：%d", routeDialMaxSamples, summary.ok)
	}
	if summary := stats.dialSummary(now.Add(routeDialWindow + time.Minute)); summary.ok != 0 {
		t.Fatalf("超过 10 分钟的不算：%d", summary.ok)
	}
}
