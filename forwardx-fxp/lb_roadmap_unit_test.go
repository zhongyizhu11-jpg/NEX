package main

import (
	"bytes"
	"errors"
	"log"
	"net"
	"regexp"
	"runtime"
	"strconv"
	"sync/atomic"
	"testing"
	"time"
)

/*
路线图各条里要用到新接口的单元测试（改之前编译不过，所以没法先跑红；对应的行为另有先跑红过的测试，
见 lb_roadmap_test.go / lb_roadmap_udp_test.go）。
*/

// X2：负载记在哪一份上。
func TestEndpointLoadKey(t *testing.T) {
	cases := []struct {
		endpoint exitEndpoint
		want     string
	}{
		{exitEndpoint{Host: "exit-a.example.com", Port: 443}, "exit-a.example.com"},
		{exitEndpoint{Host: "203.0.113.5", Port: 1000}, "203.0.113.5"},
		{exitEndpoint{Host: "127.0.0.1", Port: 41001}, "127.0.0.1:41001"},
		{exitEndpoint{Host: "::1", Port: 41002}, "[::1]:41002"},
		{exitEndpoint{Host: "localhost", Port: 41003}, "localhost:41003"},
		{exitEndpoint{Host: "127.0.0.1", Port: 41001, LoadKey: "host-7"}, "host-7"},
		{exitEndpoint{Host: "203.0.113.5", Port: 1000, LoadKey: "host-7"}, "host-7"},
	}
	for _, item := range cases {
		if got := endpointLoadKey(item.endpoint); got != item.want {
			t.Fatalf("%+v：负载的键应该是 %q，得到 %q", item.endpoint, item.want, got)
		}
	}
	// 配置里写了一样的 loadKey：两个环回端点算一台机器，共用一份负载。
	resetFXPEndpointRegistry()
	selector := newExitEndpointSelector(
		[]exitEndpoint{{Host: "127.0.0.1", Port: 41012, LoadKey: "same-box"}},
		exitEndpoint{Host: "127.0.0.1", Port: 41011, LoadKey: "same-box"},
		"least_load",
	)
	if selector.loads[0] != selector.loads[1] {
		t.Fatal("loadKey 一样的两个端点应该共用一份负载")
	}
	// 面板把首选出口在 exits 里再列一遍、loadKey 只写在那一份上：也要认。
	selector = newExitEndpointSelector(
		[]exitEndpoint{{Host: "127.0.0.1", Port: 41021, LoadKey: "box-1"}, {Host: "127.0.0.1", Port: 41022, LoadKey: "box-2"}},
		exitEndpoint{Host: "127.0.0.1", Port: 41021},
		"least_load",
	)
	if selector.loads[0].host != "box-1" || selector.loads[1].host != "box-2" {
		t.Fatalf("exits 里写的 loadKey 没生效：%q %q", selector.loads[0].host, selector.loads[1].host)
	}
}

// X5：挑中了没拨通要退回去，不然连不上的出口越记越「忙」，恢复后迟迟分不到连接。
func TestUnpickReturnsTheReservation(t *testing.T) {
	selector := leastLoadSelector(
		[]exitEndpoint{{Host: "10.0.7.2", Port: 2}},
		exitEndpoint{Host: "10.0.7.1", Port: 1},
	)
	for i := 0; i < 10; i++ {
		_, index, _ := selector.pick(nil)
		selector.unpick(index)
	}
	now := time.Now()
	if a, b := selector.loads[0].snapshot(now).recent, selector.loads[1].snapshot(now).recent; a > 0.01 || b > 0.01 {
		t.Fatalf("挑中又退回之后不该留下「刚开的连接」：%.2f / %.2f", a, b)
	}
}

// X7：解析造成的失败，解析成功能清掉。
func TestResolvingClearsOnlyAResolveFailure(t *testing.T) {
	resetFXPEndpointRegistry()
	selector := newExitEndpointSelector(
		[]exitEndpoint{{Host: "127.0.0.1", Port: 30042}},
		exitEndpoint{Host: "127.0.0.1", Port: 30041},
		"fallback",
	)
	selector.markResolveFailure(0, errors.New("no such host"))
	if selector.states[0].isHealthy() {
		t.Fatal("解析不出地址应该记一次失败")
	}
	selector.markResolved(0)
	if !selector.states[0].isHealthy() {
		t.Fatal("解析造成的失败，解析成功后应该清掉")
	}
	// 解析失败之后又握手失败：后者不归解析管。
	selector.markResolveFailure(0, errors.New("no such host"))
	selector.markFailure(0, errTestEndpointDown)
	selector.markResolved(0)
	if selector.states[0].isHealthy() {
		t.Fatal("握手失败不能被「解析成功」清掉")
	}
}

// X8：「目标全挂」的结论要新鲜；有一台没坏、或者有老出口（不回报）就不算。
func TestTargetDownEverywhereNeedsFreshResultsFromEveryExit(t *testing.T) {
	selector := targetAwareSelector("round_robin", nil)
	if selector.targetDownEverywhere() {
		t.Fatal("没有样本不能说目标挂了")
	}
	for index := 0; index < 2; index++ {
		selector.observeTarget(index, false, 0)
		selector.observeTarget(index, false, 0)
	}
	if selector.targetDownEverywhere() {
		t.Fatal("还有一台没坏")
	}
	selector.observeTarget(2, false, 0)
	selector.observeTarget(2, false, 0)
	if !selector.targetDownEverywhere() {
		t.Fatal("三台都刚测过不通：目标挂了")
	}
	// 出口本身连不上的不算在内：剩下能用的都不通，照样是目标挂了。
	selector.markFailure(0, errTestEndpointDown)
	if !selector.targetDownEverywhere() {
		t.Fatal("能用的两台都不通：目标挂了")
	}
	selector.mu.Lock()
	selector.target.health[1].lastSampleAt = time.Now().Add(-5 * time.Minute)
	selector.mu.Unlock()
	if selector.targetDownEverywhere() {
		t.Fatal("5 分钟前的结论不新鲜，不能拿来拦用户的连接")
	}
}

// X10：延迟按时间加权往新样本靠，涨和落一个式子；被排到后面的出口量得勤。
func TestEntryLatencyDecaysTowardFreshSamples(t *testing.T) {
	load := &fxpHostLoad{}
	start := time.Now()
	load.observeLatency(30*time.Millisecond, start)
	// 隔了很久来一个 1100ms 的样本：最多占六成，不是整个换掉。
	load.observeLatency(1100*time.Millisecond, start.Add(30*time.Second))
	if got := load.snapshot(start).latency; got < 600 || got > 700 {
		t.Fatalf("一个 1100ms 的样本之后应该约 670ms，得到 %.0f", got)
	}
	// 之后每 3 秒一个 30ms：四个样本（12 秒）以内回到和最快的差不到 50ms。
	for i := 1; i <= 4; i++ {
		load.observeLatency(30*time.Millisecond, start.Add(30*time.Second+time.Duration(i)*3*time.Second))
	}
	if got := load.snapshot(start).latency; got > 80 {
		t.Fatalf("12 秒后应该回到 80ms 以内，得到 %.0f", got)
	}
	// 连接很密（间隔几毫秒）时每个样本也占一成。
	busy := &fxpHostLoad{}
	busy.observeLatency(100*time.Millisecond, start)
	for i := 1; i <= 40; i++ {
		busy.observeLatency(20*time.Millisecond, start.Add(time.Duration(i)*time.Millisecond))
	}
	if got := busy.snapshot(start).latency; got > 25 {
		t.Fatalf("40 个 20ms 的样本之后应该接近 20ms，得到 %.0f", got)
	}

	probe := &fxpHostLoad{}
	if probe.latencyProbeDue(start) {
		t.Fatal("没有选择器在用延迟：不用专门量")
	}
	probe.noteLatencyUsed(start)
	probe.observeLatency(20*time.Millisecond, start)
	if probe.latencyProbeDue(start.Add(5 * time.Second)) {
		t.Fatal("样本才 5 秒：不用量")
	}
	if !probe.latencyProbeDue(start.Add(10 * time.Second)) {
		t.Fatal("样本 10 秒了：该量一次")
	}
	probe.noteLatencyStarved(start.Add(2 * time.Second))
	if !probe.latencyProbeDue(start.Add(3 * time.Second)) {
		t.Fatal("因为延迟被排到后面的出口：3 秒就该再量")
	}
}

// X11：隧道连接设了 TCP_USER_TIMEOUT（Linux）。
func TestTunnelConnectionsHaveAUserTimeout(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("TCP_USER_TIMEOUT 只在 Linux 上设")
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			defer c.Close()
		}
	}()
	conn, err := dialTCP("127.0.0.1", ln.Addr().(*net.TCPAddr).Port, time.Second, false)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if got := tcpUserTimeoutOf(conn); got != fxpTunnelUserTimeout {
		t.Fatalf("到下一跳的连接 TCP_USER_TIMEOUT 应该是 %v，得到 %v", fxpTunnelUserTimeout, got)
	}
}

// F13：「出口连不上 / 恢复」两行日志能被 Agent 的正则（agent/fxp_endpoint_events.go 的 fxpEndpointLogPattern）认出来；
// index= 是给人看的（这个端点在出口列表里排第几），正则有没有它都认。格式串抄在 agent/testdata/fxp_endpoint_log_sample.txt。
func TestEndpointHealthLogsCarryTheIndex(t *testing.T) {
	resetFXPEndpointRegistry()
	selector := newExitEndpointSelector(
		[]exitEndpoint{{Host: "198.51.100.7", Port: 30052}},
		exitEndpoint{Host: "198.51.100.6", Port: 30051},
		"fallback",
	)
	var captured bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&captured)
	selector.markFailure(1, errTestEndpointDown)
	selector.markHealthy(1)
	log.SetOutput(previous)
	// Agent 现行的正则（agent/fxp_endpoint_events.go）。
	pattern := regexp.MustCompile(`exit endpoint (unhealthy|recovered)(?: index=[0-9]+)? endpoint=([^[:space:]]+)(?: retryIn=[^[:space:]]+)?(?: reason=(.*))?`)
	matches := pattern.FindAllStringSubmatch(captured.String(), -1)
	if len(matches) != 2 || matches[0][1] != "unhealthy" || matches[1][1] != "recovered" || matches[0][2] != "198.51.100.7:30052" {
		t.Fatalf("两行日志应该都能被 Agent 的正则认出来：%q", captured.String())
	}
	if !bytes.Contains(captured.Bytes(), []byte("index=1 endpoint=198.51.100.7:30052")) {
		t.Fatalf("index 应该是它在出口列表里的位置（1）：%q", captured.String())
	}
}

// 从没回过 UDP 探活包的出口（版本过旧，或者 UDP 一直不通）：没有信号，不判它坏；问过两轮就标成「没验证过」
// 报给面板，UDP 新会话优先给验证过的出口。不再悄悄退回去探它的 TCP 端口（阶段 2：这一版要求各台都升级）。
func TestExitThatNeverAnswersUDPPingsIsFlaggedNotJudgedDead(t *testing.T) {
	resetFXPEndpointRegistry()
	setFXPUDPPingHook(func(string, int, config) error { return errors.New("no reply") })
	defer setFXPUDPPingHook(nil)
	closedPort := freeTCPUDPPort(t)
	selector := newExitEndpointSelector(
		[]exitEndpoint{{Host: "127.0.0.1", Port: freeTCPUDPPort(t)}},
		exitEndpoint{Host: "127.0.0.1", Port: closedPort},
		"round_robin",
	)
	release := selector.activateUDP(config{Role: "entry", TunnelID: 351, Key: "k"})
	defer release()
	state := selector.states[0]
	rounds := func() int {
		state.mu.Lock()
		defer state.mu.Unlock()
		return state.udpRounds
	}
	// 把「上一次问」拨到 ago 之前，再让维护循环看一眼。
	tick := func(ago time.Duration) {
		state.mu.Lock()
		state.udpProbedAt = time.Now().Add(-ago)
		state.mu.Unlock()
		state.maintain(time.Now())
		time.Sleep(30 * time.Millisecond)
	}
	state.maintain(time.Now()) // 第一轮：马上问
	time.Sleep(30 * time.Millisecond)
	tick(3 * time.Second) // 头两轮按平常的间隔问
	if got := rounds(); got < 2 {
		t.Fatalf("头两轮应该照常问：%d", got)
	}
	if ok, _ := state.reachable(true, time.Now()); !ok || !state.isHealthy() {
		t.Fatal("没有任何信号的出口被判成了连不上")
	}
	if !state.udpUnverifiedNow() || state.udpReportState() != "unverified" {
		t.Fatalf("问过两轮都没回，应该标成没验证过：%q", state.udpReportState())
	}
	// 一直不回的隔 30 秒才再问一次，不是每秒都问。
	before := rounds()
	tick(10 * time.Second)
	if rounds() != before {
		t.Fatal("一直不回的不该 10 秒就再问")
	}
	tick(31 * time.Second)
	if rounds() != before+1 {
		t.Fatal("隔了 30 秒应该再问一次（它升级了、UDP 放行了才发现得了）")
	}
	// 另一台回过探活包：UDP 新会话都给验证过的那台（没验证过的算软信号，两台里摘掉一台）。
	other := selector.states[1]
	other.udpProbeResult(nil)
	for i := 0; i < 10; i++ {
		_, index, ok := selector.pickUDP(nil)
		if !ok || index != 1 {
			t.Fatalf("UDP 新会话应该给验证过的出口：index=%d ok=%v", index, ok)
		}
		selector.unpick(index)
	}
	// TCP 连接不看这个。
	seen := map[int]bool{}
	for i := 0; i < 10; i++ {
		_, index, _ := selector.pick(nil)
		seen[index] = true
		selector.unpick(index)
	}
	if len(seen) != 2 {
		t.Fatalf("TCP 连接两台都该分到：%v", seen)
	}
	// 上报里写明。
	selector.mu.Lock()
	exits := selector.balanceSnapshotLocked(time.Now())
	selector.mu.Unlock()
	if !exits[0].PeerOutdated || exits[0].UDPState != "unverified" || exits[1].PeerOutdated || exits[1].UDPState != "ok" {
		t.Fatalf("上报应该标出没回过探活包的那台：%+v", exits)
	}
	// 它后来回了（升级了）：标记撤掉。
	state.udpProbeResult(nil)
	if state.udpUnverifiedNow() || state.udpReportState() != "ok" {
		t.Fatal("回过探活包之后不该还标着没验证过")
	}
}

// UDP 那一侧和 TCP 各判各的（阶段 2）：回过探活包的出口，连着两轮不回判成 UDP 不通 —— TCP 照常用，UDP 新会话不给它；
// 连着三轮回了才恢复。只有 UDP 被拦的出口以前发现不了（同一条规则 TCP+UDP 都开时只跑 TCP 探测）。
func TestUDPReachabilityIsTrackedSeparatelyFromTCP(t *testing.T) {
	resetFXPEndpointRegistry()
	selector := newExitEndpointSelector(
		[]exitEndpoint{{Host: "127.0.0.1", Port: 30072}},
		exitEndpoint{Host: "127.0.0.1", Port: 30071},
		"fallback",
	)
	state, now := selector.states[0], time.Now()
	state.udpProbeResult(nil)
	selector.states[1].udpProbeResult(nil)
	noReply := errors.New("no reply")
	if again, _ := state.udpProbeResult(noReply); !again {
		t.Fatal("第一轮没回：应该紧接着再探一轮，不等下一个节拍")
	}
	if ok, _ := state.reachable(true, now); !ok {
		t.Fatal("一轮不回不算挂")
	}
	if again, _ := state.udpProbeResult(noReply); again {
		t.Fatal("已经判坏了，不用紧接着再探")
	}
	if ok, _ := state.reachable(true, time.Now()); ok {
		t.Fatal("回过探活包的出口连着两轮不回，UDP 应该判成不通")
	}
	if ok, _ := state.reachable(false, time.Now()); !ok || !state.isHealthy() {
		t.Fatal("UDP 不通不该连累 TCP 那一侧")
	}
	// 挑出口：TCP 还是主出口，UDP 换到备用。
	if _, index, _ := selector.pick(nil); index != 0 {
		t.Fatalf("TCP 新连接应该还走主出口：%d", index)
	}
	if _, index, _ := selector.pickUDP(nil); index != 1 {
		t.Fatalf("UDP 新会话应该换到备用：%d", index)
	}
	state.mu.Lock()
	state.udpWatchers = 1 // 有 UDP 规则在用它才报 UDP 那一侧
	state.mu.Unlock()
	if state.udpReportState() != "down" {
		t.Fatalf("上报：%q", state.udpReportState())
	}
	// 反过来：TCP 那一侧被判坏，UDP 探活在回 —— UDP 会话照常用它。
	other := selector.states[1]
	other.markFailure(errTestEndpointDown)
	if ok, _ := other.reachable(true, time.Now()); !ok {
		t.Fatal("TCP 不通不该连累回着探活的 UDP 那一侧")
	}
	// 恢复：连着三轮回了才算。
	for i := 0; i < fxpRecoverProbes-1; i++ {
		state.udpProbeResult(nil)
		if ok, _ := state.reachable(true, time.Now()); ok {
			t.Fatal("恢复要连着三轮都回")
		}
	}
	state.udpProbeResult(nil)
	if ok, _ := state.reachable(true, time.Now()); !ok {
		t.Fatal("连着三轮回了应该恢复")
	}
	if snap := state.hostLoad().snapshot(time.Now()); snap.slowStart > 0.2 {
		t.Fatalf("刚恢复的出口应该慢慢加量：%v", snap.slowStart)
	}
}

// 挂着 UDP 会话的出口每秒探一轮，闲着的 5 秒一轮。
func TestUDPPingCadenceFollowsActiveSessions(t *testing.T) {
	resetFXPEndpointRegistry()
	var pings atomic.Int64
	setFXPUDPPingHook(func(string, int, config) error { pings.Add(1); return nil })
	defer setFXPUDPPingHook(nil)
	selector := newExitEndpointSelector(
		[]exitEndpoint{{Host: "127.0.0.1", Port: 30082}},
		exitEndpoint{Host: "127.0.0.1", Port: 30081},
		"fallback",
	)
	release := selector.activateUDP(config{Role: "entry", TunnelID: 352, Key: "k"})
	defer release()
	state := selector.states[0]
	run := func(seconds int) int64 {
		before := pings.Load()
		for i := 0; i < seconds; i++ {
			state.mu.Lock()
			state.udpProbedAt = state.udpProbedAt.Add(-time.Second)
			state.mu.Unlock()
			state.maintain(time.Now())
			time.Sleep(5 * time.Millisecond)
		}
		return pings.Load() - before
	}
	run(1) // 第一轮：马上问
	if idle := run(20); idle < 3 || idle > 5 {
		t.Fatalf("闲着的出口 20 秒应该探 4 轮上下，实际 %d", idle)
	}
	state.udpSessionOpened()
	if active := run(20); active < 18 {
		t.Fatalf("挂着会话的出口应该每秒探一轮，20 秒探了 %d 轮", active)
	}
	state.udpSessionClosed()
	if idle := run(20); idle > 5 {
		t.Fatalf("会话没了应该回到 5 秒一轮，20 秒探了 %d 轮", idle)
	}
}

// 会回探活包的出口上，一条会话中途没了回包：这期间探活回过 → 出口好好的，是应用协议单向，再久也不换；
// 这期间有一轮探活没回、一次应答都没收到 → 发了 4 个包、过了 2 秒就换（不等两轮探活判坏）。
func TestUDPSessionSilenceNeedsAMissedPingToMove(t *testing.T) {
	resetFXPEndpointRegistry()
	selector := newExitEndpointSelector(
		[]exitEndpoint{{Host: "127.0.0.1", Port: 30092}},
		exitEndpoint{Host: "127.0.0.1", Port: 30091},
		"fallback",
	)
	state := selector.states[0]
	state.udpProbeResult(nil)
	selector.states[1].udpProbeResult(nil)
	start := time.Now()
	session := &udpDirectEntrySession{selector: selector, endpointIndex: 0, createdAt: start.Add(-time.Minute).UnixNano()}
	// 有来有回的一条会话。
	session.noteClientDatagram(start.Add(-30 * time.Second).UnixNano())
	session.noteReply()
	// 从 start 起访客连着发、没有回包。
	for i := 0; i < 6; i++ {
		session.noteClientDatagram(start.Add(time.Duration(i) * 400 * time.Millisecond).UnixNano())
	}
	setPing := func(confirmed, missed time.Duration) {
		state.mu.Lock()
		state.udpConfirmedAt, state.udpMissAt = start.Add(confirmed), start.Add(missed)
		state.mu.Unlock()
	}
	check := func(at time.Duration) string {
		session.healthCheckedAt = 0
		return session.repickReason(start.Add(at).UnixNano())
	}
	setPing(-500*time.Millisecond, -time.Hour)
	if reason := check(2500 * time.Millisecond); reason != "" {
		t.Fatalf("还没有哪一轮探活没回：不换，得到 %q", reason)
	}
	setPing(time.Second, -time.Hour)
	if reason := check(30 * time.Second); reason != "" {
		t.Fatalf("没回包之后探活回过：出口好好的，单向协议不换，得到 %q", reason)
	}
	setPing(-500*time.Millisecond, 1500*time.Millisecond)
	if reason := check(1900 * time.Millisecond); reason != "" {
		t.Fatalf("还不到 2 秒：%q", reason)
	}
	if reason := check(2100 * time.Millisecond); reason != "no replies" {
		t.Fatalf("发了 6 个包、2 秒没回、这期间探活也没回：应该换，得到 %q", reason)
	}
	// 收到回包就清零。
	session.noteReply()
	if reason := check(3 * time.Second); reason != "" {
		t.Fatalf("有回包了：%q", reason)
	}
	// 没有别的连得上的出口：不折腾。
	for i := 0; i < 6; i++ {
		session.noteClientDatagram(start.Add(4*time.Second + time.Duration(i)*400*time.Millisecond).UnixNano())
	}
	setPing(-500*time.Millisecond, 5*time.Second)
	selector.states[1].udpProbeResult(errors.New("no reply"))
	selector.states[1].udpProbeResult(errors.New("no reply"))
	if reason := check(7 * time.Second); reason != "" {
		t.Fatalf("没有别的出口可换：%q", reason)
	}
}

// X3(c)：真的发一轮探活 —— 新出口回应答；不认识探活包的（老版本，这里用一个什么都不回的套接字代替）不回。
func TestUDPPingIsAnsweredByNewPeersAndIgnoredByOldOnes(t *testing.T) {
	const tunnelID, key = 361, "x3-ping-key"
	port, _ := startUDPDirectExit(t, "127.0.0.1", tunnelID, 362, key, 9)
	cfg := config{TunnelID: tunnelID, Key: key}
	if err := fxpUDPPing("127.0.0.1", port, cfg); err != nil {
		t.Fatalf("新出口应该回探活：%v", err)
	}
	if err := fxpUDPPing("127.0.0.1", port, config{TunnelID: tunnelID, Key: "wrong-key"}); err == nil {
		t.Fatal("密钥不对不该有应答")
	}
	silent, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer silent.Close()
	if err := fxpUDPPing("127.0.0.1", silent.LocalAddr().(*net.UDPAddr).Port, cfg); err == nil {
		t.Fatal("不回的对端应该报没回")
	}
}

// X3(d)：应用协议本来就单向（只发不回）时，出口被确认活着就不换；不知道出口还在不在才换，而且只换一次。
func TestUDPSessionIsNotMovedJustBecauseTheProtocolIsOneWay(t *testing.T) {
	resetFXPEndpointRegistry()
	selector := newExitEndpointSelector(
		[]exitEndpoint{{Host: "127.0.0.1", Port: 30062}},
		exitEndpoint{Host: "127.0.0.1", Port: 30061},
		"fallback",
	)
	start := time.Now()
	session := &udpDirectEntrySession{selector: selector, endpointIndex: 0, createdAt: start.UnixNano()}
	at := func(d time.Duration) int64 { return start.Add(d).UnixNano() }
	session.clientDatagrams = 100
	if reason := session.repickReason(at(time.Second)); reason != "" {
		t.Fatalf("才 1 秒：%q", reason)
	}
	// 出口刚被探测确认过：一直不回包也不换。
	selector.states[0].probeSucceeded()
	if reason := session.repickReason(at(10 * time.Second)); reason != "" {
		t.Fatalf("出口确认活着，单向协议不该换出口：%q", reason)
	}
	// 很久没有任何东西确认它活着：换。
	selector.states[0].mu.Lock()
	selector.states[0].confirmedAt = start.Add(-time.Hour)
	selector.states[0].mu.Unlock()
	if reason := session.repickReason(at(11 * time.Second)); reason != "no replies" {
		t.Fatalf("发了 100 个包、11 秒没回、出口没人确认：应该换，得到 %q", reason)
	}
	// 有过回包的会话不按这一条换。
	session.replyDatagrams = 1
	if reason := session.repickReason(at(12 * time.Second)); reason != "" {
		t.Fatalf("有过回包：%q", reason)
	}
	// 「没回包」换来的会话不再因为没回包换第二次。
	session.replyDatagrams, session.repicked = 0, true
	if reason := session.repickReason(at(13 * time.Second)); reason != "" {
		t.Fatalf("已经换过一次：%q", reason)
	}
	// 出口被判成连不上：换（哪怕换过）。
	selector.markFailure(0, errTestEndpointDown)
	if reason := session.repickReason(at(14 * time.Second)); reason != "exit unhealthy" {
		t.Fatalf("出口连不上：应该换，得到 %q", reason)
	}
	// 别的出口也都连不上：换了也是它，不折腾。
	selector.markFailure(1, errTestEndpointDown)
	if reason := session.repickReason(at(15 * time.Second)); reason != "" {
		t.Fatalf("没有健康的出口可换：%q", reason)
	}
}

// X3(e)：中转记访客地址 —— 取一次就没了，过期的不认，认证不过的不收。
func TestRelayClientHints(t *testing.T) {
	const tunnelID, ruleID, key = 371, 372, "x3e-hint-key"
	cfg := config{Role: "relay", TunnelID: tunnelID, Key: key}
	seal := func(sealKey string, sessionID uint64, ip net.IP) []byte {
		wire, err := sealFXPUDPPacket(fxpUDPPacket{packetType: fxpUDPTypeClient, tunnelID: tunnelID, ruleID: ruleID, sessionID: sessionID, sequence: 1, payload: ip}, sealKey)
		if err != nil {
			t.Fatal(err)
		}
		return wire
	}
	hints := &udpClientHints{}
	now := time.Now()
	hints.accept(seal(key, 7, net.ParseIP("203.0.113.9").To4()), cfg, now)
	hints.accept(seal("other-key", 8, net.ParseIP("203.0.113.10").To4()), cfg, now)
	hints.accept(seal(key, 9, net.ParseIP("2001:db8::1")), cfg, now)
	if got := hints.take(udpRuleSessionKey{ruleID: ruleID, sessionID: 7}, now); got != "203.0.113.9" {
		t.Fatalf("访客地址：%q", got)
	}
	if got := hints.take(udpRuleSessionKey{ruleID: ruleID, sessionID: 7}, now); got != "" {
		t.Fatalf("取过一次就没了：%q", got)
	}
	if got := hints.take(udpRuleSessionKey{ruleID: ruleID, sessionID: 8}, now); got != "" {
		t.Fatalf("密钥不对的不收：%q", got)
	}
	if got := hints.take(udpRuleSessionKey{ruleID: ruleID, sessionID: 9}, now.Add(time.Minute)); got != "" {
		t.Fatalf("过期的不认：%q", got)
	}
	// 老版本的包头解析不认识这三种包类型以外的东西；新版本认 1~5，别的照旧拒收。
	for packetType := byte(0); packetType < 8; packetType++ {
		want := packetType >= 1 && packetType <= 5
		if got := validFXPUDPPacketType(packetType); got != want {
			t.Fatalf("包类型 %s：valid=%v", strconv.Itoa(int(packetType)), got)
		}
	}
}
