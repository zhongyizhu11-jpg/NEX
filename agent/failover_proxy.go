package main

import (
	"context"
	mathrand "math/rand"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"time"
)

type failoverProxy struct {
	ruleID         int
	sourcePort     int
	spec           failoverSpec
	signature      string
	activeIndex    int
	roundRobinNext int
	// wrrCurrent 是「按权重」的平滑加权轮询计数；slowStartAt 是每条路径从挂掉恢复的时刻，
	// 之后 routeSlowStartWindow 内按比例慢慢加量（route_group_balance.go）。
	wrrCurrent     []int
	slowStartAt    []time.Time
	targetHealth   []bool
	failureSince   []time.Time
	recoveredSince []time.Time
	// 每条出站最近一次探测的往返耗时（毫秒）。原来 tcpLatency 的返回值是直接
	// 丢掉的 —— 数据一直在采，白扔了，而它正是「哪条线路更快」唯一的现成原料。
	lastLatencyMs []int
	// 每条出站的探测样本窗口：评分、丢包、抖动、可用率、连续失败都从它算（route_group.go）。
	stats []*routeTargetStats
	// 面板从中转机的探测得知这条路径的中转挂了（failoverTarget.Down）。不是本机探出来的，
	// 单独记着，本机的探测结果盖不掉它，规格重下发也不会把它清掉。
	relayDown       []bool
	relayDownReason []string
	// 走各条出站的客户端连接：「快速故障转移 / 强制切换」要断旧连接时用。
	conns []map[net.Conn]struct{}
	rng   *mathrand.Rand
	// 上一次切换的时刻，最短驻留时间从这儿算。
	lastSwitchAt time.Time
	// 现在这条是从什么时候开始走的。和 lastSwitchAt 不同，起代理、换规格（活跃
	// 线路会被重置回第 0 条）也要重新计时 —— 这两种情况不算「切换」，不该拿去
	// 卡最短驻留，但面板要知道「从什么时候起走的这条」。
	activeSince time.Time
	// 自动择优的候选，以及它从什么时候开始一直是候选。
	fastestCandidate int
	fastestSince     time.Time
	// 最近一小时里自动切换（不含人工指定）的时刻：切得太勤就把驻留拉长（flapHoldLocked）。
	autoSwitchTimes []time.Time
	// 这一轮驻留里「抖动抑制」事件报过了没有（每次切换之后重新算）。
	flapHoldReported bool
	// 计划切换：正在预热的那条、预检没过的那条（-1 = 没有）。
	prewarmIndex        int
	precheckFailedIndex int
	// 上一轮评估时人工指定的是哪条（-1 = 没有）：从「有」变成「没有」要报一条「指定到期」。
	pinnedLast int
	// 上面三个 -1 才是「没有」，而 Go 的零值是 0（一个合法的出站序号），所以第一次用之前
	// 要显式初始化一遍；见 ensureHealthStateLocked。
	stateInitialized bool
	// TCP 和 UDP 各一个监听，按规格的 protocol 开：tcp 只有 ln，udp 只有 udp，both 两个都有。
	ln         net.Listener
	udp        net.PacketConn
	done       chan struct{}
	retireOnce sync.Once
	mu         sync.RWMutex
	// UDP 会话：按来源地址记，一个会话一直走它挑中的那条路径，空闲够久回收（route_group_udp.go）。
	// 每个包都要查会话表，查表只拿读锁；增删会话才拿写锁。
	udpMu       sync.RWMutex
	udpSessions map[netip.AddrPort]*failoverUDPSession
	// 回声探测报的回包限速（udp_probe.go）。
	udpEcho udpEchoLimiter
	// TCP+UDP 规格下 UDP 那一侧单独的健康（route_group_udp_health.go）；别的协议不用。
	udpSide failoverUDPSide
	// 进行中的一轮健康检查：所有目标都拨不通时，每个新连接都会要求立即检查一次，
	// 同一时刻只跑一轮，其余连接等它的结果（见 checkHealthShared）。
	healthFlightMu sync.Mutex
	healthFlight   chan struct{}
	// 客户端连进来以后有没有拨通一条路径（最近 10 分钟，按分钟一格）：线路详情「入站」那一段。
	inbound routeInboundWindow
}

func failoverID(ruleID int, sourcePort int) string {
	return strconv.Itoa(ruleID) + ":" + strconv.Itoa(sourcePort)
}

func newFailoverRand(ruleID int, sourcePort int) *mathrand.Rand {
	return mathrand.New(mathrand.NewSource(time.Now().UnixNano() + int64(ruleID*100000+sourcePort)))
}

func failoverSignature(spec failoverSpec) string {
	parts := []string{
		strconv.Itoa(spec.ListenPort),
		spec.BindAddress,
		failoverProtocol(spec),
		spec.Strategy,
		strconv.Itoa(spec.FailoverSeconds),
		strconv.Itoa(spec.RecoverSeconds),
		strconv.FormatBool(spec.AutoFailback),
		strconv.Itoa(spec.MinHoldSeconds),
		func() string {
			if spec.PinnedIndex == nil {
				return "-"
			}
			return strconv.Itoa(*spec.PinnedIndex)
		}(),
		strconv.FormatInt(spec.PinnedUntil, 10),
		strconv.FormatBool(spec.PreferFastest),
		failoverScheduleSignature(spec.Schedule),
		strconv.Itoa(spec.FailureThreshold),
		strconv.Itoa(spec.ScoreMargin),
		strconv.Itoa(spec.ScoreHoldSeconds),
		strconv.Itoa(spec.PrewarmSeconds),
		func() string {
			// Delivery 为空时签名和加这个字段之前逐字相同。
			if spec.Delivery == "" {
				return spec.SwitchMode
			}
			return spec.SwitchMode + "/" + spec.Delivery
		}(),
		strconv.FormatBool(spec.ProxyProtocolReceive),
		strconv.FormatBool(spec.ProxyProtocolStrip),
	}
	for _, target := range spec.Targets {
		// Down / DownReason / ExtraLatencyMs / LoadPct / ExitIP 是面板随时会变的运行时提示，故意不进签名：进了的话
		// 每次提示变化都会重建代理，探测样本和「现在走哪条」全部归零。它们走 applyRelayHintsLocked。
		weight := strconv.Itoa(target.Weight)
		if target.Tier != nil {
			// 不带 Tier 时签名和加这个字段之前逐字相同。
			weight += "t" + strconv.Itoa(*target.Tier)
		}
		if target.Line != nil && target.Spread != "" {
			// 同上：没有「落地怎么分」时签名不变。
			weight += "l" + strconv.Itoa(*target.Line) + "/" + target.Landing + "/" + target.Spread
		}
		if target.ProbeUdpEcho {
			// 同上：不带时签名不变。探法变了得进签名，在跑的代理才会原地换上新规格（样本照旧带过去）。
			weight += "e"
		}
		parts = append(parts, target.TargetIP, strconv.Itoa(target.TargetPort), target.ProbeIP, strconv.Itoa(target.ProbePort), weight)
	}
	return strings.Join(parts, "|")
}

func normalizeFailoverSpec(spec failoverSpec) failoverSpec {
	if spec.BindAddress == "" {
		spec.BindAddress = "127.0.0.1"
	}
	spec.Protocol = failoverProtocol(spec)
	switch strings.TrimSpace(spec.Strategy) {
	case "round_robin", "random", "ip_hash", "weighted", "least_load", "auto", "fallback":
		spec.Strategy = strings.TrimSpace(spec.Strategy)
	default:
		spec.Strategy = "fallback"
	}
	if spec.FailoverSeconds <= 0 {
		spec.FailoverSeconds = 60
	}
	if spec.RecoverSeconds <= 0 {
		spec.RecoverSeconds = 120
	}
	if spec.MinHoldSeconds < 0 {
		spec.MinHoldSeconds = 0
	}
	// 没带这几个字段的规格（老面板、老快照）按上一版的行为走：失败一次就算、评分门槛按
	// 原来写死的常数、不预热。
	if spec.FailureThreshold < 1 {
		spec.FailureThreshold = 1
	}
	if spec.FailureThreshold > 20 {
		spec.FailureThreshold = 20
	}
	if spec.ScoreMargin <= 0 {
		spec.ScoreMargin = 10
	}
	if spec.ScoreHoldSeconds <= 0 {
		spec.ScoreHoldSeconds = failoverFastestHoldSeconds
	}
	if spec.PrewarmSeconds < 0 {
		spec.PrewarmSeconds = 0
	}
	switch strings.TrimSpace(spec.SwitchMode) {
	case "fast", "force":
		spec.SwitchMode = strings.TrimSpace(spec.SwitchMode)
	default:
		spec.SwitchMode = "smooth"
	}
	switch strings.TrimSpace(spec.Delivery) {
	case "cold", "hot", "aggregate", "replicate":
		spec.Delivery = strings.TrimSpace(spec.Delivery)
	default:
		spec.Delivery = ""
	}
	if spec.PinnedIndex != nil && (*spec.PinnedIndex < 0 || *spec.PinnedIndex >= len(spec.Targets)) {
		spec.PinnedIndex = nil
		spec.PinnedUntil = 0
	}
	if spec.PinnedIndex == nil {
		spec.PinnedUntil = 0
	}
	spec.Schedule = normalizeFailoverSchedule(spec.Schedule)
	cleaned := make([]failoverTarget, 0, len(spec.Targets))
	for _, target := range spec.Targets {
		target.TargetIP = strings.TrimSpace(target.TargetIP)
		if target.TargetIP == "" || target.TargetPort <= 0 || target.TargetPort > 65535 {
			continue
		}
		// 探测目标填得不合法时退回「探出站地址本身」，也就是老行为 —— 不能因为
		// 一个填错的探测地址就让这条出站永远探不通、被当成挂了。
		target.ProbeIP = strings.TrimSpace(target.ProbeIP)
		if target.ProbeIP == "" || target.ProbePort <= 0 || target.ProbePort > 65535 {
			target.ProbeIP = ""
			target.ProbePort = 0
		}
		if target.Weight < 0 {
			target.Weight = 0
		}
		if target.Weight > 100 {
			target.Weight = 100
		}
		target.DownReason = strings.TrimSpace(target.DownReason)
		if !target.Down {
			target.DownReason = ""
		}
		if target.Tier != nil {
			// 复制一份：别和调用方的规格共用同一个指针。
			tier := *target.Tier
			if tier < 0 {
				tier = 0
			}
			target.Tier = &tier
		}
		if target.ExtraLatencyMs < 0 {
			target.ExtraLatencyMs = 0
		}
		if target.ExtraLatencyMs > failoverMaxExtraLatencyMs {
			target.ExtraLatencyMs = failoverMaxExtraLatencyMs
		}
		target.ExitIP = strings.TrimSpace(target.ExitIP)
		// 「落地怎么分」三个字段一起才算数：缺线路号、分法不认识，就当没带（挑一个，老行为）。
		target.Spread = strings.TrimSpace(target.Spread)
		target.Landing = strings.TrimSpace(target.Landing)
		if target.Line == nil || *target.Line < 0 || !validLineSpread(target.Spread) {
			target.Line = nil
			target.Landing = ""
			target.Spread = ""
		} else {
			line := *target.Line
			target.Line = &line
		}
		cleaned = append(cleaned, target)
		if len(cleaned) >= 11 {
			break
		}
	}
	spec.Targets = cleaned
	return spec
}

func startFailoverProxy(ruleID int, sourcePort int, spec failoverSpec, actionMessage *actionMessage) bool {
	failoverControlMu.Lock()
	defer failoverControlMu.Unlock()
	return startFailoverProxyLocked(ruleID, sourcePort, spec, actionMessage)
}

func startFailoverProxyLocked(ruleID int, sourcePort int, spec failoverSpec, actionMessage *actionMessage) bool {
	spec = normalizeFailoverSpec(spec)
	if !spec.Enabled || spec.ListenPort <= 0 || len(spec.Targets) < 2 {
		removePersistedFailoverSpec(ruleID, sourcePort)
		return true
	}
	id := failoverID(ruleID, sourcePort)
	signature := failoverSignature(spec)
	failoverMu.Lock()
	existing := failoverProxies[id]
	if existing != nil && existing.signature == signature {
		failoverMu.Unlock()
		// 规格没变，变的只可能是面板附带的中转提示。
		existing.mu.Lock()
		existing.applyRelayHintsLocked(spec.Targets)
		existing.mu.Unlock()
		if err := persistFailoverSpec(ruleID, sourcePort, spec); err != nil {
			logf("failover persistent snapshot write failed rule=%d port=%d: %v", ruleID, sourcePort, err)
		}
		return true
	}
	if existing != nil {
		existing.mu.Lock()
		sameAddress := existing.spec.ListenPort == spec.ListenPort && existing.spec.BindAddress == spec.BindAddress
		sameProtocol := failoverProtocol(existing.spec) == failoverProtocol(spec)
		sameEndpoint := sameAddress && sameProtocol
		if !sameEndpoint {
			existing.mu.Unlock()
			if sameAddress {
				/*
					同一个地址换了协议（tcp → both 之类）：新监听要绑的端口旧的还占着，先起新的再收
					旧的那一套在这里行不通。先收旧的 —— 换协议是用户改了规则，前面的转发工具本来
					也要重启，这一下中断躲不掉。
				*/
				delete(failoverProxies, id)
				failoverMu.Unlock()
				existing.retire()
			} else {
				failoverMu.Unlock()
			}
		} else {
			pinChanged := !sameFailoverPin(existing.spec, spec)
			targetsChanged := existing.rebuildForSpecLocked(spec, time.Now())
			/*
				人工指定改了（指定、取消指定）：面板一改就照做，不等下一轮探测（以前最多晚 5 秒）。别的改动
				（时段表、阈值、出站）照旧不在这里重新选路 —— 正走着备线时改个设置不该把流量拽回主线，
				下一轮探测按新规格评估（见 rebuildForSpecLocked）。
			*/
			if pinChanged {
				existing.updateFallbackActiveLocked("panel pin")
			}
			existing.mu.Unlock()
			existing.signature = signature
			failoverMu.Unlock()
			if targetsChanged {
				// 出站换了：新出站的健康和延迟别等 5 秒后的定时探测。
				go existing.probeNowAndReport()
			}
			if err := persistFailoverSpec(ruleID, sourcePort, spec); err != nil {
				logf("failover persistent snapshot write failed rule=%d port=%d: %v", ruleID, sourcePort, err)
			}
			logf("failover proxy updated rule=%d source=%d listen=%s:%d strategy=%s targets=%d", ruleID, sourcePort, spec.BindAddress, spec.ListenPort, spec.Strategy, len(spec.Targets))
			return true
		}
	} else {
		failoverMu.Unlock()
	}

	addr := net.JoinHostPort(spec.BindAddress, strconv.Itoa(spec.ListenPort))
	protocol := failoverProtocol(spec)
	var ln net.Listener
	var udpConn net.PacketConn
	var err error
	if protocol != "udp" {
		ln, err = listenTCPForRelay(addr)
	}
	if err == nil && protocol != "tcp" {
		udpConn, err = net.ListenPacket("udp", addr)
		if err != nil && ln != nil {
			_ = ln.Close()
			ln = nil
		}
	}
	if err != nil {
		if actionMessage != nil {
			actionMessage.set("failover proxy listen failed rule=%d addr=%s protocol=%s: %v", ruleID, addr, protocol, err)
		} else {
			logf("failover proxy listen failed rule=%d addr=%s protocol=%s: %v", ruleID, addr, protocol, err)
		}
		return false
	}
	p := &failoverProxy{
		ruleID:      ruleID,
		sourcePort:  sourcePort,
		spec:        spec,
		signature:   signature,
		activeSince: time.Now(),
		rng:         newFailoverRand(ruleID, sourcePort),
		ln:          ln,
		udp:         udpConn,
		done:        make(chan struct{}),
	}
	p.ensureHealthStateLocked()
	failoverMu.Lock()
	previous := failoverProxies[id]
	failoverProxies[id] = p
	failoverMu.Unlock()
	// The new socket is already listening before the old one is retired. This
	// keeps a failed bind from tearing down the working proxy and makes dynamic
	// internal-port handoffs continuous once the backend action completes.
	go p.healthLoop()
	// 第一轮探测不等定时器（5 秒后）：立刻探一轮，面板几秒内就能看到延迟和评分。
	go p.probeNowAndReport()
	if p.ln != nil {
		go p.acceptLoop()
	}
	if p.udp != nil {
		go p.serveUDP()
	}
	if previous != nil {
		previous.retire()
	}
	if err := persistFailoverSpec(ruleID, sourcePort, spec); err != nil {
		logf("failover persistent snapshot write failed rule=%d port=%d: %v", ruleID, sourcePort, err)
	}
	logf("failover proxy started rule=%d source=%d listen=%s protocol=%s strategy=%s targets=%d", ruleID, sourcePort, addr, protocol, spec.Strategy, len(spec.Targets))
	return true
}

func stopFailoverProxy(ruleID int, sourcePort int) {
	failoverControlMu.Lock()
	defer failoverControlMu.Unlock()
	stopFailoverProxyLocked(ruleID, sourcePort)
}

func stopFailoverProxyLocked(ruleID int, sourcePort int) {
	stopFailoverProxyRuntime(ruleID, sourcePort)
	removePersistedFailoverSpec(ruleID, sourcePort)
}

func stopFailoverProxyRuntime(ruleID int, sourcePort int) {
	if ruleID <= 0 || sourcePort <= 0 {
		return
	}
	id := failoverID(ruleID, sourcePort)
	failoverMu.Lock()
	p := failoverProxies[id]
	if p != nil {
		delete(failoverProxies, id)
	}
	failoverMu.Unlock()
	if p == nil {
		return
	}
	p.retire()
}

func (p *failoverProxy) ensureHealthStateLocked() {
	n := len(p.spec.Targets)
	if !p.stateInitialized {
		p.stateInitialized = true
		p.fastestCandidate = -1
		p.prewarmIndex = -1
		p.precheckFailedIndex = -1
		p.pinnedLast = -1
	}
	if len(p.lastLatencyMs) != n {
		p.lastLatencyMs = make([]int, n)
	}
	if len(p.targetHealth) != n {
		p.targetHealth = make([]bool, n)
		for i := range p.targetHealth {
			p.targetHealth[i] = true
		}
	}
	if len(p.failureSince) != n {
		p.failureSince = make([]time.Time, n)
	}
	if len(p.recoveredSince) != n {
		p.recoveredSince = make([]time.Time, n)
	}
	if len(p.stats) != n {
		p.stats = make([]*routeTargetStats, n)
	}
	for i := range p.stats {
		if p.stats[i] == nil {
			p.stats[i] = &routeTargetStats{}
		}
	}
	if len(p.relayDown) != n {
		p.relayDown = make([]bool, n)
		p.relayDownReason = make([]string, n)
		for i, target := range p.spec.Targets {
			p.relayDown[i] = target.Down
			if target.Down {
				p.relayDownReason[i] = strings.TrimSpace(target.DownReason)
			}
		}
	}
	if len(p.conns) != n {
		p.conns = make([]map[net.Conn]struct{}, n)
	}
	for i := range p.conns {
		if p.conns[i] == nil {
			p.conns[i] = map[net.Conn]struct{}{}
		}
	}
	p.udpSide.ensure(n)
	if p.activeIndex < 0 || p.activeIndex >= n {
		p.activeIndex = 0
	}
}

func failoverRemoteIP(conn net.Conn) string {
	if conn == nil || conn.RemoteAddr() == nil {
		return ""
	}
	host, _, err := net.SplitHostPort(conn.RemoteAddr().String())
	if err == nil {
		return host
	}
	return conn.RemoteAddr().String()
}

/*
候选路径。healthyOnly 时只要健康的；分层规格（failoverSpecTiered）下再只留「还有健康
出站的最优一层」—— 权重 / 最少连接只在主线路组里分，整个主组都挂了才轮到备用组。
healthyOnly=false（全挂时的兜底）不分层，和以前一样。
*/
func (p *failoverProxy) candidateIndicesLocked(exclude map[int]bool, healthyOnly bool) []int {
	return p.candidateIndicesForLocked(exclude, healthyOnly, false)
}

// udp 为 true 时「健康」按 UDP 那一侧算（udpUsableLocked）：TCP+UDP 规格的 UDP 会话用。
func (p *failoverProxy) candidateIndicesForLocked(exclude map[int]bool, healthyOnly bool, udp bool) []int {
	indices := make([]int, 0, len(p.spec.Targets))
	for i := range p.spec.Targets {
		if exclude != nil && exclude[i] {
			continue
		}
		if healthyOnly && !p.usableLocked(i, udp) {
			continue
		}
		indices = append(indices, i)
	}
	if !healthyOnly || len(indices) < 2 || !failoverSpecTiered(p.spec) {
		return indices
	}
	best := p.lowestTierLocked(indices)
	filtered := indices[:0]
	for _, i := range indices {
		if *p.spec.Targets[i].Tier == best {
			filtered = append(filtered, i)
		}
	}
	return filtered
}

// indices 里最优（数字最小）的一层。调用方保证规格是分层的、indices 非空。
func (p *failoverProxy) lowestTierLocked(indices []int) int {
	best := *p.spec.Targets[indices[0]].Tier
	for _, i := range indices[1:] {
		if tier := *p.spec.Targets[i].Tier; tier < best {
			best = tier
		}
	}
	return best
}

func (p *failoverProxy) pickTarget(client net.Conn, exclude map[int]bool) (failoverTarget, int) {
	return p.pickTargetForKey(failoverRemoteIP(client), exclude)
}

// 挑一条路径。hashKey 只有「按访客固定」用：TCP 是访客 IP（带 PROXY 头时从头里读），
// UDP 是会话的来源地址。
func (p *failoverProxy) pickTargetForKey(hashKey string, exclude map[int]bool) (failoverTarget, int) {
	return p.pickTargetForKeyProto(hashKey, exclude, false)
}

// udp 为 true 是给 UDP 会话挑：TCP+UDP 规格下只在 UDP 通的路径里挑（route_group_udp_health.go），
// 别的规格和 TCP 完全一样。
func (p *failoverProxy) pickTargetForKeyProto(hashKey string, exclude map[int]bool, udp bool) (failoverTarget, int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.ensureHealthStateLocked()
	if len(p.spec.Targets) == 0 {
		return failoverTarget{}, -1
	}
	candidates := p.candidateIndicesForLocked(exclude, true, udp)
	if len(candidates) == 0 {
		candidates = p.candidateIndicesForLocked(exclude, false, udp)
	}
	if len(candidates) == 0 {
		return failoverTarget{}, -1
	}
	index := candidates[0]
	switch p.spec.Strategy {
	case "weighted":
		index = p.weightedPickLocked(candidates)
	case "least_load":
		index = p.leastLoadPickLocked(candidates)
	case "auto":
		index = p.autoPickLocked(candidates)
	case "round_robin":
		index = candidates[p.roundRobinNext%len(candidates)]
		p.roundRobinNext = (p.roundRobinNext + 1) % 1000000
	case "random":
		if p.rng == nil {
			p.rng = newFailoverRand(p.ruleID, p.sourcePort)
		}
		index = candidates[p.rng.Intn(len(candidates))]
	case "ip_hash":
		key := hashKey
		if key == "" {
			key = strconv.Itoa(p.sourcePort)
		}
		index = p.rendezvousPickLocked(candidates, key)
	default:
		if udp && p.udpSeparateLocked() {
			index = p.udpFallbackIndexLocked(candidates, exclude)
		} else if !p.healthyLocked(p.activeIndex) || (exclude != nil && exclude[p.activeIndex]) {
			// 当前这条用不了（挂了、或这条连接刚在它上面拨失败）：在候选里优先挑出口 IP 一样的（2.2.251），
			// 没有就还是第一条，和以前一样。全都不健康时候选是兜底的全部，挑不出健康的，照旧第一条。
			index = candidates[0]
			if pick, _ := p.escapePickLocked(candidates, p.activeIndex, -1, udp); pick >= 0 {
				index = pick
			}
		} else {
			index = p.activeIndex
		}
		// 挑出来的这条所在线路选了「一起分」：在这条线路的几个落地之间分（2.2.245）。
		index = p.spreadWithinLineLocked(index, hashKey, exclude, udp)
	}
	return p.spec.Targets[index], index
}

func (p *failoverProxy) setActiveLocked(index int, reason string) {
	if index < 0 || index >= len(p.spec.Targets) || p.activeIndex == index {
		return
	}
	old := p.activeIndex
	closeOld := p.shouldCloseOldConnsLocked(old)
	// 切之前把两条整条链的延迟和「领先了多久」记下来，事件里给人看。
	fromChainMs, toChainMs, heldSeconds := 0, 0, 0
	if old >= 0 && old < len(p.spec.Targets) {
		if summary := p.chainScoreInputLocked(old); summary.hasLatency {
			fromChainMs = int(summary.latencyMs)
		}
	}
	if summary := p.chainScoreInputLocked(index); summary.hasLatency {
		toChainMs = int(summary.latencyMs)
	}
	if reason == "score" && !p.fastestSince.IsZero() && p.fastestCandidate == index {
		heldSeconds = int(time.Since(p.fastestSince).Seconds())
	}
	p.activeIndex = index
	p.lastSwitchAt = time.Now()
	p.activeSince = p.lastSwitchAt
	p.precheckFailedIndex = -1
	p.flapHoldReported = false
	if reason != "pin" {
		p.noteAutoSwitchLocked(p.lastSwitchAt)
	}
	next := p.spec.Targets[index]
	logf("failover switch rule=%d source=%d %d->%d target=%s:%d reason=%s", p.ruleID, p.sourcePort, old, index, next.TargetIP, next.TargetPort, reason)
	from := ""
	if old >= 0 && old < len(p.spec.Targets) {
		from = failoverTargetLabel(p.spec.Targets[old])
	}
	recordFailoverProxyEvent(failoverProxyEvent{
		RuleID: p.ruleID, SourcePort: p.sourcePort, Kind: "switch",
		FromTarget: from, ToTarget: failoverTargetLabel(next),
		FromIndex: old, ToIndex: index,
		Reason: reason, LatencyMs: p.latencyMsLocked(index), Score: p.scoreValueLocked(index),
		FromChainMs: fromChainMs, ToChainMs: toChainMs, HeldSeconds: heldSeconds,
	})
	if closeOld {
		if closed := p.closeConnsLocked(old); closed > 0 {
			logf("failover closed %d connection(s) on old target rule=%d source=%d index=%d mode=%s", closed, p.ruleID, p.sourcePort, old, p.spec.SwitchMode)
		}
	}
	// 旧线路是几个落地一起分的：它别的落地上的连接按同一个切换方式处理（见 closeOldLineConnsLocked）。
	if closed := p.closeOldLineConnsLocked(old, index); closed > 0 {
		logf("failover closed %d connection(s) on the old line's other landings rule=%d source=%d index=%d mode=%s", closed, p.ruleID, p.sourcePort, old, p.spec.SwitchMode)
	}
}

// 调用方必须已经持有 p.mu。
func (p *failoverProxy) recordTargetEventLocked(index int, kind string, reason string) {
	if index < 0 || index >= len(p.spec.Targets) {
		return
	}
	recordFailoverProxyEvent(failoverProxyEvent{
		RuleID: p.ruleID, SourcePort: p.sourcePort, Kind: kind,
		ToTarget:  failoverTargetLabel(p.spec.Targets[index]),
		FromIndex: -1, ToIndex: index,
		Reason: reason, LatencyMs: p.latencyMsLocked(index), Score: p.scoreValueLocked(index),
	})
}

func (p *failoverProxy) latencyMsLocked(index int) int {
	if index < 0 || index >= len(p.lastLatencyMs) || p.lastLatencyMs[index] <= 0 {
		return 0
	}
	return p.lastLatencyMs[index]
}

/*
出站的优先次序。

没有时段表时就是数组顺序（也就是这个功能加进来之前的行为）。时段表命中时，把它
指定的那一条提到最前，其余保持原来的相对次序 —— 时段表只改「谁是首选」，不重排
剩下的兜底顺序。
*/
// 人工钉住的那条还算不算数。
func (p *failoverProxy) pinnedIndexAt(now time.Time) int {
	if p.spec.PinnedIndex == nil {
		return -1
	}
	index := *p.spec.PinnedIndex
	if index < 0 || index >= len(p.spec.Targets) {
		return -1
	}
	if p.spec.PinnedUntil > 0 && now.UnixMilli() >= p.spec.PinnedUntil {
		return -1
	}
	return index
}

// 此刻的首选是哪条、是谁定的：人工 > 时段表 > 自动择优 > 数组顺序（-1, ""）。
//
// 人工钉住是运维拿来压过自动判断的，压不过就没有意义；时段表是人**事先**排好
// 的意图，也该压过机器自己算出来的择优。
func (p *failoverProxy) preferredLocked(now time.Time) (int, string) {
	count := len(p.spec.Targets)
	if index := p.pinnedIndexAt(now); index >= 0 && index < count {
		return index, "pin"
	}
	if index := failoverScheduleTargetIndexAt(p.spec.Schedule, now); index >= 0 && index < count {
		return index, "schedule"
	}
	if index := p.fastestIndexLocked(now); index >= 0 && index < count {
		return index, "score"
	}
	return -1, ""
}

func (p *failoverProxy) orderFromPreferredLocked(preferred int) []int {
	count := len(p.spec.Targets)
	order := make([]int, 0, count)
	if preferred >= 0 && preferred < count {
		order = append(order, preferred)
	}
	for index := 0; index < count; index++ {
		if len(order) > 0 && order[0] == index {
			continue
		}
		order = append(order, index)
	}
	return order
}

func (p *failoverProxy) priorityOrderLocked(now time.Time) []int {
	preferred, _ := p.preferredLocked(now)
	return p.orderFromPreferredLocked(preferred)
}

func (p *failoverProxy) acceptLoop() {
	var backoff serveLoopBackoff
	for {
		client, err := p.ln.Accept()
		if err != nil {
			// 以前临时错误（如 EMFILE）会在这里零间隔空转并每次刷一条日志。
			exit, fatal := serveLoopHandleError(p.done, &backoff, err, func(err error, suppressed int) {
				logf("failover accept failed rule=%d source=%d suppressed=%d: %v", p.ruleID, p.sourcePort, suppressed, err)
			})
			if fatal {
				p.abandonAfterServeFailure("tcp accept", err)
			}
			if exit {
				return
			}
			continue
		}
		backoff.success()
		go p.handleConn(client)
	}
}

// abandonAfterServeFailure 监听意外失效时把代理从运行表里摘掉并收尾，
// 下一轮对账看到它不在了就会重建；不摘掉的话规格签名没变，对账会一直认为它还在跑。
func (p *failoverProxy) abandonAfterServeFailure(what string, err error) {
	id := failoverID(p.ruleID, p.sourcePort)
	failoverMu.Lock()
	current := failoverProxies[id] == p
	if current {
		delete(failoverProxies, id)
	}
	failoverMu.Unlock()
	p.retire()
	if current {
		logf("failover proxy %s stopped unexpectedly rule=%d source=%d; it will be rebuilt: %v", what, p.ruleID, p.sourcePort, err)
		wakeHeartbeat()
	}
}

func (p *failoverProxy) handleConn(client net.Conn) {
	defer client.Close()
	visitor, prefix := p.readVisitor(client)
	var upstream net.Conn
	var target failoverTarget
	var index int
	var err error
	attempted := map[int]bool{}
	for {
		target, index = p.pickTargetForKey(visitor, attempted)
		if index < 0 {
			logf("failover no target available rule=%d source=%d", p.ruleID, p.sourcePort)
			p.inbound.record(false, time.Now())
			return
		}
		// 拨失败的路径在里面记失败、加进 attempted；允许竞速的策略可能实际连上的是另一条。
		upstream, target, index, err = p.dialFailoverPath(visitor, target, index, attempted, failoverProxyDialTimeout)
		if err == nil {
			break
		}
		p.mu.RLock()
		exhausted := len(attempted) >= len(p.spec.Targets)
		p.mu.RUnlock()
		if exhausted {
			break
		}
	}
	if err != nil {
		// 每条都拨失败了：重新探一遍再挑一次。这里不能再带 attempted —— 里面已经是全部路径，
		// 带着它永远挑不出来，这一步等于没有（以前就是这样）。
		p.checkHealthShared()
		target, index = p.pickTargetForKey(visitor, nil)
		if index >= 0 {
			started := time.Now()
			upstream, err = failoverDialTCP(context.Background(), target, failoverProxyDialTimeout)
			if err == nil {
				p.markDialSuccess(index, time.Since(started))
			}
		} else {
			logf("failover dial failed rule=%d no target available after trying %d targets: %v", p.ruleID, len(attempted), err)
			p.inbound.record(false, time.Now())
			return
		}
		if err != nil {
			logf("failover dial failed rule=%d target=%s:%d: %v", p.ruleID, target.TargetIP, target.TargetPort, err)
			p.inbound.record(false, time.Now())
			return
		}
	}
	p.inbound.record(true, time.Now())
	defer upstream.Close()
	// 读 PROXY 头时多读到的字节（以及透传模式下的头本身）要先补给路径，再接着原样拷。
	if len(prefix) > 0 {
		if _, err := upstream.Write(prefix); err != nil {
			return
		}
	}
	p.trackConn(index, client)
	defer p.untrackConn(index, client)
	// 等两个方向都结束（带半关闭 linger），客户端半关闭后仍能收完响应。
	relayTCPBidirectional(client, upstream, tcpRelayHalfCloseLinger)
}
