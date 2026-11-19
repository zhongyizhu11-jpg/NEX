package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/netip"
	"path/filepath"
	"testing"
	"time"
)

/*
出口组（failover_exit_group.go）不用真 gost 就能测的部分。真实 gost 上的端到端在带 balancee2e 标签的
balance_proxy_e2e_test.go（gost-runtime/test/balance-proxy/run.sh 起它）。
*/

// 和面板 server/gostBalancePlan.ts 生成的规格同一个形状：每条目标是一台出口的本机端口，探测地址是出口机。
func exitGroupSpec(strategy string, count int) failoverSpec {
	spec := failoverSpec{
		Enabled: true, BindAddress: "127.0.0.1", ListenPort: 64200, Protocol: "tcp", Strategy: strategy,
		FailoverSeconds: 2, RecoverSeconds: 4, FailureThreshold: 2, AutoFailback: true, MinHoldSeconds: 60,
		ProbeIntervalSeconds: 2, ProbeTimeoutMs: 1000,
		ProxyProtocolReceive: true, ProxyProtocolStrip: true,
		BalanceReport: &failoverBalanceReport{TunnelID: 7},
	}
	for i := 0; i < count; i++ {
		spec.Targets = append(spec.Targets, failoverTarget{TargetIP: "127.0.0.1", TargetPort: 47000 + i, ProbeIP: fmt.Sprintf("198.51.100.%d", i+1), ProbePort: 23000 + i})
		spec.BalanceReport.HostIDs = append(spec.BalanceReport.HostIDs, 100+i)
	}
	return spec
}

func TestExitGroupKeepsTwentyTargetsWithAlignedHostIDs(t *testing.T) {
	spec := exitGroupSpec("round_robin", 23)
	// 中间一条地址不合法：它被清掉，后面的主机号要跟着各自的目标走，不能错位
	spec.Targets[3].TargetPort = 0
	clean := normalizeFailoverSpec(spec)
	if len(clean.Targets) != failoverMaxTargets || failoverMaxTargets != 20 {
		t.Fatalf("目标上限应当是 20，留下了 %d 条", len(clean.Targets))
	}
	if clean.BalanceReport == nil || len(clean.BalanceReport.HostIDs) != len(clean.Targets) {
		t.Fatalf("主机号和目标对不上：%+v", clean.BalanceReport)
	}
	for i, target := range clean.Targets {
		if want := 100 + (target.TargetPort - 47000); clean.BalanceReport.HostIDs[i] != want {
			t.Fatalf("第 %d 条目标（端口 %d）的主机号应当是 %d，拿到 %d", i, target.TargetPort, want, clean.BalanceReport.HostIDs[i])
		}
	}
	if len(spec.BalanceReport.HostIDs) != 23 {
		t.Fatal("不能改调用方的规格")
	}
	// 面板给的两边长度就对不上：主机号整个不要（不拿错位的数据报），但它还是出口组（F8）——
	// 以前连 BalanceReport 一起扔掉，出口组悄悄变成了线路组（拨本机端口永远成功，健康就不会判了）。
	broken := exitGroupSpec("round_robin", 3)
	broken.BalanceReport.HostIDs = broken.BalanceReport.HostIDs[:2]
	if report := normalizeFailoverSpec(broken).BalanceReport; report == nil || report.TunnelID != 7 || report.HostIDs != nil {
		t.Fatalf("主机号数量对不上时还是出口组、只是不带主机号：%+v", report)
	}
	// 手动指定指到被截掉的那一条：当没指定
	pinned := exitGroupSpec("round_robin", 23)
	index := 21
	pinned.PinnedIndex = &index
	if normalizeFailoverSpec(pinned).PinnedIndex != nil {
		t.Fatal("指定的下标超出留下的目标时应当清掉")
	}
}

// F8：清掉不合法的目标时，手动指定跟着它指的那一条走（以前下标不动，指到了别的出口上，或者被当成越界清掉）。
func TestNormalizeFailoverSpecRemapsPinWhenDroppingTargets(t *testing.T) {
	spec := exitGroupSpec("round_robin", 4)
	spec.Targets[0].TargetIP = ""
	pin := 2
	spec.PinnedIndex = &pin
	spec.PinnedUntil = 1234
	clean := normalizeFailoverSpec(spec)
	if clean.PinnedIndex == nil || *clean.PinnedIndex != 1 || clean.Targets[1].TargetPort != 47002 || clean.PinnedUntil != 1234 {
		t.Fatalf("指定的是端口 47002 那台：前面清掉一条以后应当指到下标 1，拿到 %v", clean.PinnedIndex)
	}
	if *spec.PinnedIndex != 2 {
		t.Fatal("不能改调用方的规格")
	}
	// 指定的那一条自己被清掉了：当没指定。
	pin = 0
	spec.PinnedIndex = &pin
	if clean := normalizeFailoverSpec(spec); clean.PinnedIndex != nil || clean.PinnedUntil != 0 {
		t.Fatalf("指定的那一条不合法、被清掉了：应当当没指定，拿到 %v", clean.PinnedIndex)
	}
}

func TestExitGroupSignatureCoversProbeCadenceAndRelayFlag(t *testing.T) {
	base := normalizeFailoverSpec(exitGroupSpec("round_robin", 3))
	faster := base
	faster.ProbeIntervalSeconds = 1
	if failoverSignature(base) == failoverSignature(faster) {
		t.Fatal("探测间隔变了签名要变（在跑的代理才会换上新规格）")
	}
	relayed := exitGroupSpec("round_robin", 3)
	relayed.Targets[0].ViaRelay = true
	if failoverSignature(base) == failoverSignature(normalizeFailoverSpec(relayed)) {
		t.Fatal("viaRelay 变了签名要变")
	}
	// 不带这些字段的老规格签名不变
	old := failoverSpec{Enabled: true, ListenPort: 1, Strategy: "fallback", Targets: routeTargets(2)}
	withZero := old
	withZero.ProbeIntervalSeconds, withZero.ProbeTimeoutMs = 0, 0
	if failoverSignature(normalizeFailoverSpec(old)) != failoverSignature(normalizeFailoverSpec(withZero)) {
		t.Fatal("没带探测节奏的规格签名不该变")
	}
}

// 延迟优先在出口组里和 NEX 出口组同一个意思（lbcore 的 NearSet + 自动）：整链比最快的慢不到门槛的几台一起分，
// 慢出门槛的不分；门槛是面板「检测与切换」里的那个数（规格的 LatencyMarginMs）。
func TestExitGroupLatencySpreadsOverTheEquallyFast(t *testing.T) {
	build := func(extra ...int) *failoverProxy {
		spec := exitGroupSpec("latency", len(extra))
		spec.LatencyMarginMs = 30
		proxy := routeTestProxy(spec)
		now := time.Now()
		for i := range proxy.spec.Targets {
			proxy.spec.Targets[i].ExtraLatencyMs = extra[i]
			proxy.stats[i].recordProbe(true, 10, now)
			proxy.lastLatencyMs[i] = 10
		}
		return proxy
	}
	count := func(proxy *failoverProxy, n int) []int {
		counts := make([]int, len(proxy.spec.Targets))
		for i := 0; i < n; i++ {
			// 挑中了就占着（在途），自动的成本里算得到负载
			_, index, _ := proxy.pickReserved("", nil, false)
			counts[index]++
		}
		return counts
	}
	// 整链 200 / 20 / 200：只有第 2 台算快
	if counts := count(build(190, 10, 190), 60); counts[1] != 60 {
		t.Fatalf("慢出门槛的不该分到：%v", counts)
	}
	// 整链 20 / 35 / 200：差 15ms 在 30ms 的门槛内，前两台一起分，第 3 台不分
	counts := count(build(10, 25, 190), 60)
	if counts[0] == 0 || counts[1] == 0 || counts[2] != 0 {
		t.Fatalf("一样快的两台都该分到、慢的不分：%v", counts)
	}
}

func TestExitGroupPinAppliesToEveryStrategyAndYieldsWhenDown(t *testing.T) {
	for _, strategy := range []string{"round_robin", "random", "weighted", "least_load", "auto", "ip_hash", "fallback"} {
		spec := exitGroupSpec(strategy, 3)
		pinned := 2
		spec.PinnedIndex = &pinned
		proxy := routeTestProxy(spec)
		for i := 0; i < 20; i++ {
			if _, index := proxy.pickTargetForKey(fmt.Sprintf("203.0.113.%d", i), nil); index != 2 {
				t.Fatalf("%s：指定了第 3 台，第 %d 次却挑了第 %d 台", strategy, i, index+1)
			}
			if _, index := proxy.pickTargetForKeyProto(fmt.Sprintf("203.0.113.%d", i), nil, true); index != 2 {
				t.Fatalf("%s：UDP 会话也该走指定的那台", strategy)
			}
		}
		// 指定的那台坏了：当没指定，照常在另外两台里分，不黑洞
		proxy.targetHealth[2] = false
		seen := map[int]bool{}
		for i := 0; i < 40; i++ {
			_, index := proxy.pickTargetForKey(fmt.Sprintf("203.0.113.%d", i), nil)
			if index == 2 || index < 0 {
				t.Fatalf("%s：指定的出口坏了还在往它上面分（%d）", strategy, index)
			}
			seen[index] = true
		}
		if strategy != "fallback" && strategy != "least_load" && len(seen) != 2 {
			t.Fatalf("%s：指定的出口坏了以后应当在另外两台里分，只用了 %v", strategy, seen)
		}
		// 这条连接刚在指定的那台上被关过（exclude）：也不再挑它
		proxy.targetHealth[2] = true
		if _, index := proxy.pickTargetForKey("203.0.113.1", map[int]bool{2: true}); index == 2 {
			t.Fatalf("%s：排除了指定的那台还挑它", strategy)
		}
	}
	// 线路组（不是出口组）的人工指定照旧只管主备：别的分法不受影响
	route := failoverSpec{Strategy: "round_robin", Targets: routeTargets(3)}
	pinned := 2
	route.PinnedIndex = &pinned
	proxy := routeTestProxy(route)
	seen := map[int]bool{}
	for i := 0; i < 6; i++ {
		_, index := proxy.pickTargetForKey("", nil)
		seen[index] = true
	}
	if len(seen) != 3 {
		t.Fatalf("线路组的轮流不该被人工指定拦下：%v", seen)
	}
}

// 按访客固定：出口组几条目标的名字只差末尾两个字符，线路组那个哈希在上面几乎全压到份数最大的一台。
func TestExitGroupIPHashSpreadsByWeightAndSticks(t *testing.T) {
	spec := exitGroupSpec("ip_hash", 3)
	for i, weight := range []int{8, 5, 3} {
		spec.Targets[i].Weight = weight
	}
	proxy := routeTestProxy(spec)
	counts := make([]int, 3)
	first := map[string]int{}
	for a := 0; a < 40; a++ {
		for b := 1; b <= 250; b++ {
			visitor := fmt.Sprintf("203.%d.113.%d", a, b)
			_, index := proxy.pickTargetForKey(visitor, nil)
			counts[index]++
			first[visitor] = index
		}
	}
	// 一万个访客按 8 : 5 : 3 应当约 5000 / 3125 / 1875
	for i, want := range []int{5000, 3125, 1875} {
		if counts[i] < want-300 || counts[i] > want+300 {
			t.Fatalf("按访客固定的分布不对：%v（应当约 5000 / 3125 / 1875）", counts)
		}
	}
	// 同一个访客再来还是那一台；UDP 会话用同一个键也是那一台
	for visitor, index := range first {
		if _, again := proxy.pickTargetForKey(visitor, nil); again != index {
			t.Fatalf("访客 %s 换了出口", visitor)
		}
		if _, udp := proxy.pickTargetForKeyProto(visitor, nil, true); udp != index {
			t.Fatalf("访客 %s 的 UDP 和 TCP 不是同一台", visitor)
		}
		break
	}
	// 一台坏了：只有原来落在它上面的访客换出口
	proxy.targetHealth[1] = false
	moved := 0
	for visitor, index := range first {
		_, now := proxy.pickTargetForKey(visitor, nil)
		if index != 1 && now != index {
			t.Fatalf("访客 %s 原来在第 %d 台，第 2 台坏了却被挪走", visitor, index+1)
		}
		if index == 1 {
			moved++
		}
	}
	if moved == 0 {
		t.Fatal("没有访客落在第 2 台上，测不出东西")
	}
	// 键按出口主机号算：目标换个顺序、本机端口重新分，访客还跟着那台机器
	proxy.targetHealth[1] = true
	swapped := exitGroupSpec("ip_hash", 3)
	swapped.Targets[0], swapped.Targets[2] = swapped.Targets[2], swapped.Targets[0]
	swapped.BalanceReport.HostIDs[0], swapped.BalanceReport.HostIDs[2] = swapped.BalanceReport.HostIDs[2], swapped.BalanceReport.HostIDs[0]
	for i, weight := range []int{3, 5, 8} {
		swapped.Targets[i].Weight = weight
	}
	other := routeTestProxy(swapped)
	for visitor, index := range first {
		_, now := other.pickTargetForKey(visitor, nil)
		if proxy.spec.BalanceReport.HostIDs[index] != other.spec.BalanceReport.HostIDs[now] {
			t.Fatalf("出口换了顺序，访客 %s 就换了机器", visitor)
		}
	}
}

// 一条真实连接「出口没回就被关」：经出口复核，又被关才判坏；判坏以后直接探通不够，要经出口探通才放回。
func TestExitGroupEarlyCloseIsConfirmedThroughTheExit(t *testing.T) {
	oldProbe := failoverThroughProbe
	t.Cleanup(func() { failoverThroughProbe = oldProbe })
	verdicts := make(chan exitThroughVerdict, 8)
	failoverThroughProbe = func(target failoverTarget, window time.Duration) (exitThroughVerdict, int) {
		return <-verdicts, 0
	}
	waitConfirm := func(proxy *failoverProxy, index int) {
		t.Helper()
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) {
			proxy.mu.RLock()
			running := proxy.exitConfirming[index]
			proxy.mu.RUnlock()
			if !running {
				return
			}
			time.Sleep(5 * time.Millisecond)
		}
		t.Fatal("复核没有结束")
	}
	proxy := routeTestProxy(exitGroupSpec("round_robin", 3))
	proxy.done = make(chan struct{})

	// 复核时连接一直开着：是那条连接自己的事，不动这台出口（只有一个访客也一样）
	verdicts <- exitThroughOK
	proxy.markEarlyClose(1, "203.0.113.9")
	waitConfirm(proxy, 1)
	if !proxy.healthyLocked(1) {
		t.Fatal("复核通过了不该判坏")
	}
	// 复核又被关：当场判坏，不用凑两个访客、也不用等够次数
	verdicts <- exitThroughClosed
	proxy.markEarlyClose(1, "203.0.113.9")
	waitConfirm(proxy, 1)
	proxy.mu.RLock()
	down, through := !proxy.healthyLocked(1), proxy.exitThroughFailed[1]
	proxy.mu.RUnlock()
	if !down || !through {
		t.Fatalf("复核又被关应当判坏并记下是经出口判的：down=%v through=%v", down, through)
	}
	// 本机端口连不上（前面的 gost 在重载）：说不准，不判
	verdicts <- exitThroughUnknown
	proxy.markEarlyClose(2, "203.0.113.9")
	waitConfirm(proxy, 2)
	if !proxy.healthyLocked(2) {
		t.Fatal("本机端口连不上不该算出口的账")
	}
	// 线路组（不是出口组）照旧：一个访客凑不出判坏
	route := routeTestProxy(failoverSpec{Strategy: "round_robin", Targets: routeTargets(2), FailureThreshold: 1})
	route.markEarlyClose(0, "203.0.113.9")
	route.markEarlyClose(0, "203.0.113.9")
	if !route.healthyLocked(0) {
		t.Fatal("线路组里同一个访客的「回之前就关」不该判坏")
	}
}

func TestExitGroupProbeRoundUsesDirectProbeAndThroughGate(t *testing.T) {
	oldProbe := failoverThroughProbe
	t.Cleanup(func() { failoverThroughProbe = oldProbe })
	through := map[int]exitThroughVerdict{}
	calls := map[int]int{}
	failoverThroughProbe = func(target failoverTarget, window time.Duration) (exitThroughVerdict, int) {
		calls[target.TargetPort]++
		return through[target.TargetPort], 0
	}
	// 出口机的「隧道监听」：两台在听，一台没有
	listen := func() (net.Listener, int) {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = ln.Close() })
		return ln, ln.Addr().(*net.TCPAddr).Port
	}
	_, portA := listen()
	_, portB := listen()
	deadLn, portDead := listen()
	_ = deadLn.Close()
	targets := []failoverTarget{
		{TargetIP: "127.0.0.1", TargetPort: 47000, ProbeIP: "127.0.0.1", ProbePort: portA},
		{TargetIP: "127.0.0.1", TargetPort: 47001, ProbeIP: "127.0.0.1", ProbePort: portB},
		{TargetIP: "127.0.0.1", TargetPort: 47002, ProbeIP: "127.0.0.1", ProbePort: portDead},
		// 在中转后面的出口：不探，算通
		{TargetIP: "127.0.0.1", TargetPort: 47003, ProbeIP: "198.51.100.9", ProbePort: 1, ViaRelay: true},
	}
	through[47001] = exitThroughClosed
	_, results := probeExitGroupTargets("tcp", targets, time.Second, []bool{false, true, true, false})
	if !results[0] || results[1] || results[2] || !results[3] {
		t.Fatalf("结果应当是 通 / 经出口不通 / 出口机不通 / 中转后面算通，拿到 %v", results)
	}
	if calls[47000] != 0 || calls[47001] != 1 || calls[47002] != 0 || calls[47003] != 0 {
		t.Fatalf("只有经出口判坏过、而且出口机本身探得通的才经出口探：%v", calls)
	}
	// 经出口探通了才算通
	through[47001] = exitThroughOK
	if _, results := probeExitGroupTargets("tcp", targets, time.Second, []bool{false, true, false, false}); !results[1] {
		t.Fatal("经出口探通了应当算通")
	}
}

// 固定节拍下「持续够久」留 15% 的余量：间隔抖到 0.9 倍时「2 秒一轮、2 次判坏」不该多等一整轮。
func TestExitGroupFixedTickGateToleratesJitter(t *testing.T) {
	oldPersistentDir := persistentFailoverDir
	persistentFailoverDir = filepath.Join(t.TempDir(), "failover")
	t.Cleanup(func() { persistentFailoverDir = oldPersistentDir })
	spec := exitGroupSpec("round_robin", 2)
	// 两台出口机都探不通（端口没人听）
	for i := range spec.Targets {
		spec.Targets[i].ProbeIP, spec.Targets[i].ProbePort = "127.0.0.1", failoverTestPort(t)
	}
	proxy := routeTestProxy(spec)
	proxy.done = make(chan struct{})
	proxy.checkHealth()
	if !proxy.healthyLocked(0) {
		t.Fatal("一次不通不该判坏")
	}
	// 第二轮比 2 秒早一点点（0.9 倍的抖动）：把第一轮记的时刻往前拨 1.8 秒
	proxy.mu.Lock()
	proxy.failureSince[0] = time.Now().Add(-1800 * time.Millisecond)
	proxy.failureSince[1] = time.Now().Add(-1800 * time.Millisecond)
	proxy.mu.Unlock()
	proxy.checkHealth()
	if proxy.healthyLocked(0) || proxy.healthyLocked(1) {
		t.Fatal("连着两轮不通应当判坏，不该因为间隔抖到 1.8 秒再多等一轮")
	}
}

func TestExitGroupUDPVisitorHeader(t *testing.T) {
	// 真实 gost 3.2.6 给一个新 UDP 会话先发的包（访客 127.0.0.2 → 127.0.0.1）
	header := []byte{0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a, 0x21, 0x12, 0x00, 0x0c, 0x7f, 0x00, 0x00, 0x02, 0x7f, 0x00, 0x00, 0x01, 0x88, 0x69, 0x70, 0x81}
	if visitor, ok := parseUDPProxyV2Header(header); !ok || visitor != "127.0.0.2" {
		t.Fatalf("没认出 gost 的 PROXY v2 头：%q %v", visitor, ok)
	}
	v6 := append(append([]byte{}, proxyV2Signature...), 0x21, 0x22, 0x00, 0x24)
	v6 = append(v6, net.ParseIP("2001:db8::7").To16()...)
	v6 = append(v6, net.ParseIP("2001:db8::1").To16()...)
	v6 = append(v6, 0x12, 0x34, 0x01, 0xbb)
	if visitor, ok := parseUDPProxyV2Header(v6); !ok || visitor != "2001:db8::7" {
		t.Fatalf("没认出 IPv6 的头：%q %v", visitor, ok)
	}
	// 头后面还跟着数据、长度对不上、LOCAL 命令、普通数据：都不是
	for name, packet := range map[string][]byte{
		"带数据":   append(append([]byte{}, header...), 'x'),
		"截断":    header[:20],
		"LOCAL": append(append([]byte{}, proxyV2Signature...), 0x20, 0x00, 0x00, 0x00),
		"普通数据":  []byte("hello world, this is payload"),
	} {
		if _, ok := parseUDPProxyV2Header(packet); ok {
			t.Fatalf("%s 不该被当成访客头", name)
		}
	}
	source := netip.MustParseAddrPort("127.0.0.1:40001")
	proxy := routeTestProxy(func() failoverSpec { s := exitGroupSpec("ip_hash", 3); s.Protocol = "both"; return s }())
	if !proxy.consumeUDPVisitorHeader(source, header) {
		t.Fatal("出口组应当吃掉访客头")
	}
	if key := proxy.udpHashKey(source); key != "127.0.0.2" {
		t.Fatalf("建会话的哈希键应当是访客地址，拿到 %q", key)
	}
	if key := proxy.udpHashKey(netip.MustParseAddrPort("127.0.0.1:40002")); key != "127.0.0.1:40002" {
		t.Fatalf("没收到过头的来源照旧按来源地址，拿到 %q", key)
	}
	if proxy.consumeUDPVisitorHeader(source, []byte("payload")) {
		t.Fatal("普通数据包不该被吃掉")
	}
	// 规则往目标发 PROXY 头（TCP 的头不剥）时，UDP 的头照样是给调度器的
	forward := exitGroupSpec("round_robin", 3)
	forward.ProxyProtocolStrip = false
	if !routeTestProxy(forward).consumeUDPVisitorHeader(source, header) {
		t.Fatal("出口组的 UDP 头永远是给调度器的")
	}
	// 线路组没让前面加头：长得像头的包也原样转发
	if routeTestProxy(failoverSpec{Strategy: "ip_hash", Protocol: "udp", Targets: routeTargets(2)}).consumeUDPVisitorHeader(source, header) {
		t.Fatal("没要求剥头的线路组不该吃包")
	}
}

func TestExitGroupReportsCumulativePicksAndRecentShare(t *testing.T) {
	spec := exitGroupSpec("round_robin", 3)
	proxy := routeTestProxy(spec)
	for i, n := range []int{6, 3, 1} {
		for j := 0; j < n; j++ {
			proxy.notePick(i)
		}
	}
	// 挂着的连接数不算数（以前报的就是它）
	conn, peer := net.Pipe()
	defer conn.Close()
	defer peer.Close()
	proxy.trackConn(2, conn)
	tunnelID, strategy, exits, ok := proxy.balanceSnapshot()
	if !ok || tunnelID != 7 || strategy != "round_robin" {
		t.Fatalf("快照不对：%v %d %s", ok, tunnelID, strategy)
	}
	for i, want := range []int{6, 3, 1} {
		if exits[i].Picks != want || exits[i].HostID != 100+i || exits[i].State != "active" || exits[i].Host != fmt.Sprintf("198.51.100.%d", i+1) {
			t.Fatalf("第 %d 台：%+v", i+1, exits[i])
		}
	}
	state := &agentBalanceRuleState{}
	now := time.Now()
	shares := state.recentShares(now, []int{6, 3, 1})
	if shares == nil || shares[0] != 0.6 || shares[1] != 0.3 || shares[2] != 0.1 {
		t.Fatalf("代理刚起来：到现在为止分出去的都算最近，拿到 %v", shares)
	}
	// 一分钟以后：只算这一分钟里新分的
	shares = state.recentShares(now.Add(30*time.Second), []int{6, 3, 1})
	shares = state.recentShares(now.Add(61*time.Second), []int{6, 3, 11})
	if shares == nil || shares[0] != 0 || shares[2] != 1 {
		t.Fatalf("一分钟前分的不该再算进比例：%v", shares)
	}
	// 这一分钟没有新连接
	if shares = state.recentShares(now.Add(200*time.Second), []int{6, 3, 11}); shares != nil {
		t.Fatalf("没有新连接时没有比例：%v", shares)
	}
	// 代理重建，计数从 0 起：不能拿重建前的累计数当基准
	shares = state.recentShares(now.Add(201*time.Second), []int{1, 1, 0})
	if shares == nil || shares[0] != 0.5 || shares[1] != 0.5 {
		t.Fatalf("重建以后比例应当从头算：%v", shares)
	}
	// 状态：经出口复核判坏的算「到目标不通」，直接探不通的算「出口机连不上」；手动指定时只有那台在用
	proxy.mu.Lock()
	proxy.targetHealth[0], proxy.exitThroughFailed[0] = false, true
	proxy.targetHealth[1] = false
	proxy.mu.Unlock()
	_, _, exits, _ = proxy.balanceSnapshot()
	if exits[0].State != "down" || exits[0].Reason != "target" || exits[1].State != "down" || exits[1].Reason != "exit" || exits[2].State != "active" {
		t.Fatalf("状态不对：%+v", exits)
	}
	pinnedSpec := exitGroupSpec("round_robin", 3)
	pinned := 1
	pinnedSpec.PinnedIndex = &pinned
	_, _, exits, _ = routeTestProxy(pinnedSpec).balanceSnapshot()
	if exits[0].State != "standby" || exits[1].State != "active" || exits[2].State != "standby" {
		t.Fatalf("手动指定时只有那台在用：%+v", exits)
	}
	// 不是出口组的代理不报
	if _, _, _, ok := routeTestProxy(failoverSpec{Strategy: "fallback", Targets: routeTargets(2)}).balanceSnapshot(); ok {
		t.Fatal("线路组不该出现在出口组的上报里")
	}
}

// 面板下发的规格（server/gostBalancePlan.ts 的字段名）Agent 都认得。
func TestExitGroupSpecJSONFields(t *testing.T) {
	raw := `{"enabled":true,"listenPort":41001,"bindAddress":"127.0.0.1","protocol":"both","strategy":"latency","latencyMarginMs":30,
	"targets":[{"targetIp":"127.0.0.1","targetPort":47004,"probeIp":"198.51.100.21","probePort":23001,"weight":8,"viaRelay":true,"down":true,"downReason":"出口连不上目标","extraLatencyMs":12},
	{"targetIp":"127.0.0.1","targetPort":47005,"probeIp":"198.51.100.22","probePort":23002,"weight":5}],
	"failoverSeconds":2,"recoverSeconds":4,"failureThreshold":2,"probeIntervalSeconds":2,"probeTimeoutMs":1000,"autoFailback":true,"minHoldSeconds":60,
	"noSlowStart":true,"pinnedIndex":1,"pinnedUntil":0,"proxyProtocolReceive":true,"proxyProtocolStrip":true,"proxyProtocolSend":false,
	"proxyProtocolVersion":1,"balanceReport":{"tunnelId":1,"hostIds":[21,22]}}`
	var spec failoverSpec
	if err := json.Unmarshal([]byte(raw), &spec); err != nil {
		t.Fatal(err)
	}
	spec = normalizeFailoverSpec(spec)
	if spec.ProbeIntervalSeconds != 2 || spec.ProbeTimeoutMs != 1000 || !spec.NoSlowStart || spec.Strategy != "latency" || spec.LatencyMarginMs != 30 {
		t.Fatalf("探测节奏 / 慢启动 / 延迟优先门槛没读到：%+v", spec)
	}
	if !spec.Targets[0].ViaRelay || !spec.Targets[0].Down || spec.Targets[0].ExtraLatencyMs != 12 || spec.Targets[0].Weight != 8 {
		t.Fatalf("目标字段没读到：%+v", spec.Targets[0])
	}
	if spec.PinnedIndex == nil || *spec.PinnedIndex != 1 || spec.BalanceReport == nil || spec.BalanceReport.HostIDs[1] != 22 {
		t.Fatalf("指定 / 主机号没读到：%+v %+v", spec.PinnedIndex, spec.BalanceReport)
	}
	if !spec.ProxyProtocolReceive || !spec.ProxyProtocolStrip {
		t.Fatal("PROXY 头的两个开关没读到")
	}
}

// 不加密的 tcp / mtcp 出口：进程卡死时内核照样接连接，光连一下判不出来。ProbeRelay 的探测发一个坏请求、等 gost 断开：
// 活着的（读完就关）算通，卡死的（不读、不关；或者连 accept 都没有，连接停在内核的队列里）算不通。
func TestExitGroupRelayProbeCatchesFrozenExit(t *testing.T) {
	listen := func() net.Listener {
		l, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { l.Close() })
		return l
	}
	alive := listen()
	go func() {
		for {
			conn, err := alive.Accept()
			if err != nil {
				return
			}
			go func() {
				// 像 gost 的 relay：读满 4 字节的头，版本不对就断开
				buf := make([]byte, 4)
				_, _ = io.ReadFull(conn, buf)
				conn.Close()
			}()
		}
	}()
	// 卡死：监听着，但从不 accept —— 连接由内核完成握手、停在队列里
	frozen := listen()
	// 卡在读之前：accept 了但不读
	stuck := listen()
	held := make(chan net.Conn, 8)
	go func() {
		for {
			conn, err := stuck.Accept()
			if err != nil {
				return
			}
			held <- conn
		}
	}()
	t.Cleanup(func() {
		for {
			select {
			case conn := <-held:
				conn.Close()
			default:
				return
			}
		}
	})
	port := func(l net.Listener) int { return l.Addr().(*net.TCPAddr).Port }
	targets := []failoverTarget{
		{TargetIP: "127.0.0.1", TargetPort: 47100, ProbeIP: "127.0.0.1", ProbePort: port(alive), ProbeRelay: true},
		{TargetIP: "127.0.0.1", TargetPort: 47101, ProbeIP: "127.0.0.1", ProbePort: port(frozen), ProbeRelay: true},
		{TargetIP: "127.0.0.1", TargetPort: 47102, ProbeIP: "127.0.0.1", ProbePort: port(stuck), ProbeRelay: true},
		// 不带 ProbeRelay 的照旧只看连不连得上：卡死的也算通（tls / wss 靠真实连接的握手超时）
		{TargetIP: "127.0.0.1", TargetPort: 47103, ProbeIP: "127.0.0.1", ProbePort: port(frozen)},
	}
	started := time.Now()
	_, results := probeExitGroupTargets("tcp", targets, 300*time.Millisecond, nil)
	if !results[0] || results[1] || results[2] || !results[3] {
		t.Fatalf("活着的通、卡死的不通、不带 ProbeRelay 的照旧：%v", results)
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("一轮探测要在两个超时以内结束：%s", elapsed)
	}
}
