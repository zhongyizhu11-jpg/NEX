package main

import (
	"context"
	"errors"
	"hash/fnv"
	"math"
	"net"
	"strconv"
	"sync"
	"time"
)

/*
出口组：GOST 隧道的几台出口，由入口机的这个代理挑（Agent 2.2.264 起真正启用，面板 shared/loadBalance.ts 的
GOST_BALANCE_PROXY_AGENT_VERSION；2.2.262 加的那一版面板侧从没下发过）。

数据怎么走：

	公网端口（gost 听：计数、限速、连接数限制都还在它上面）
	  → 127.0.0.1:调度端口（本代理；gost 给每条连接 / 每个 UDP 会话先发一个 PROXY 头，带着访客地址）
	  → 127.0.0.1:每台出口一个本机 gost 端口（只挂一条单节点的链，拨那台出口；没有节点选择器，也就没有
	    「节点全被摘掉时由入口机直连目标」那条路）
	  → 出口机的 relay → 规则的目标

规格里每条目标就是一台出口：TargetIP:TargetPort 是它的本机 gost 端口，ProbeIP:ProbePort 是出口机的隧道监听，
BalanceReport.HostIDs 是对应的主机号。带 BalanceReport 的规格就是出口组（exitGroupLocked）。

健康怎么判 —— 拨本机端口永远成功，所以「拨通了」在这里什么都说明不了：

 1. 直接探出口机（本机，主信号）：每轮拨一次出口的隧道监听（tls / wss / tcp… 都是 TCP 监听）。连续
    FailureThreshold 轮不通判坏，之后要连着通够 RecoverSeconds 才算恢复。节奏由规格给（ProbeIntervalSeconds /
    ProbeTimeoutMs，固定节拍，见 failover_health.go）：默认每 2 秒一轮、超时 1 秒、2 次判坏 —— 出口被黑洞最坏
    5 秒摘掉；恢复要连着通 3 次，约 6 秒回来。全在入口机本地完成，面板连不上也照常。

 2. 被动信号 + 经出口复核：一条真实连接「拨通本机端口、出口一个字节没回就被关」—— gost 在后面拨出口 / 出口拨
    目标失败时就是这个样子（真实 gost 实测：目标拒绝 3ms、出口拒绝 1ms、出口黑洞 3s 后被关）。这条连接当场换
    下一台出口重发（failover_early_close.go，客户端无感），同时**经这台出口再探一次**（failoverThroughProbe：连
    本机端口、什么都不发，看会不会又被关）：
    - 又被关：不是那个客户端的问题，是这台出口到目标走不通 —— 当场判坏（不用凑两个不同访客）。之后每轮探测
    除了直接探出口机，还要经出口探通才算恢复（exitThroughFailed）；不然出口机本身是通的，下一轮就被放回来、
    再坏一次，来回翻。
    - 一直开着 / 收到了数据：是那条连接自己的事（比如落地拒绝了那个客户端），不动这台出口。
    平时不经出口周期性地探：每探一次就是往规则的目标开一条不说话的连接，SSH / MySQL 这类目标会记日志、甚至
    把出口的 IP 拉黑；出口机自己已经在按同样的节奏探目标并报给面板（第 3 条）。所以「出口到目标不通」在没有
    流量、面板又连不上时不会提前发现 —— 第一条撞上去的连接被无感换走，同时触发复核。

 3. 面板提示（附加信号）：出口机探规则目标的结果（server/exitTargetHealth.ts）作为 Down / ExtraLatencyMs 下发。
    「出口到目标不通」没有流量时靠它提前摘；「延迟优先 / 自动」的整链延迟 = 本机探到的入口→出口 + 它给的
    出口→目标。面板连不上时这一项停在最后一次的值上，1、2 照常。

手动指定出口（PinnedIndex）：指定的那台能用就只走它（所有分法都一样，exitPinPickLocked）；它判坏了就当没指定、
照常分。以前是面板下发时只留那一台，那台掉线到面板发现之间（最长约 5 分钟）流量全进黑洞。

UDP：一个访客一个会话，建会话时挑出口；出口判坏的那一刻它上面的 UDP 会话全部关掉，下一个包重新挑
（route_group_path_down.go）。UDP 在 gost 里装在到出口的那条 TCP 连接里走，所以出口通不通看的也是第 1 条；
经出口复核只有 TCP 有（UDP 没有「被关」这个信号）。访客地址从 gost 给每个新会话先发的 PROXY v2 头里读
（route_group_udp_visitor.go）。

多跳链路（出口在中转后面，目标带 ViaRelay）：入口机连不到出口机，第 1 条做不了 —— 每台出口的本机 gost 端口挂的
是「中转 → 这台出口」的链，健康只靠第 2、3 条：出口死了以后第一条撞上去的 TCP 连接约 3 秒后被关、无感换走，
再约 3 秒复核完判坏；没有 TCP 流量（空闲、只转 UDP 的规则）时要等面板的提示。以前 gost 选择器那条路同样只在
连接失败时才发现，这一点没有变差；想在多跳上也做到「几秒内本地摘掉」，得让出口机上有一个可以穿过隧道去问的
探测端口，现在没有。

判不出来的情况：出口进程卡死、内核还在接连接，而链路是不加密的 tcp / mtcp（握手不需要对端进程参与）——
本机端口和出口机都「连得上」，连接挂着不回。tls / wss 的握手要对端进程回话，3 秒握手超时后就是第 2 条。
*/

const (
	// 复核等多久：每出口的本机 gost 端口拨出口最多 3 秒（面板写的 dialTimeout），再留 1 秒。
	exitConfirmWindow = 4 * time.Second
	// 判坏以后每轮经出口探等多久：让目标判坏的那几种失败（目标拒绝、relay 被拒）都是毫秒级就被关，
	// 出口机黑洞那种慢的由直接探出口机先拦下（不通就不经出口探了）。
	exitRecoverWindow = 1500 * time.Millisecond
	// 探测默认等多久（规格没带 ProbeTimeoutMs）。
	failoverProbeDefaultTimeout = 2 * time.Second
)

// exitGroupLocked 这个代理是不是在替隧道入口挑出口（规格带 BalanceReport）。
func (p *failoverProxy) exitGroupLocked() bool {
	return p.spec.BalanceReport != nil
}

// notePick 一条新连接 / 新 UDP 会话落在了这条目标上。
func (p *failoverProxy) notePick(index int) {
	p.mu.Lock()
	if index >= 0 && index < len(p.pickCounts) {
		p.pickCounts[index]++
	}
	p.mu.Unlock()
}

type exitThroughVerdict int

const (
	// 说不准：本机端口连不上（前面的 gost 没起来 / 在重载），不算出口的账。
	exitThroughUnknown exitThroughVerdict = iota
	// 连接一直开着，或者收到了数据。
	exitThroughOK
	// 一个字节没回就被关了。
	exitThroughClosed
)

/*
failoverThroughProbe 经出口探一次：连这台出口的本机 gost 端口，什么都不发，等 window。

gost 收下本机连接就去拨出口、让出口拨目标，哪一步失败都会把本机这条连接关掉；都成功就一直开着（目标先说话的
协议会回数据）。所以「window 内被关」= 这台出口到目标走不通，「还开着 / 有数据」= 走得通。第二个返回值是收到
第一个字节花了多久（毫秒；没收到数据是 0）。测试里换掉。
*/
var failoverThroughProbe = func(target failoverTarget, window time.Duration) (exitThroughVerdict, int) {
	started := time.Now()
	conn, err := failoverDialTCP(context.Background(), target, failoverProbeDefaultTimeout)
	if err != nil {
		return exitThroughUnknown, 0
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(window))
	buf := make([]byte, 1)
	n, err := conn.Read(buf)
	if n > 0 {
		return exitThroughOK, int(time.Since(started) / time.Millisecond)
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return exitThroughOK, 0
	}
	return exitThroughClosed, 0
}

// indexOfTargetLocked 按「拨的地址 + 探测地址」找这条目标现在的下标（换过规格以后下标可能变了）；没有是 -1。
func (p *failoverProxy) indexOfTargetLocked(target failoverTarget) int {
	key := targetStateKey(target)
	for i := range p.spec.Targets {
		if targetStateKey(p.spec.Targets[i]) == key {
			return i
		}
	}
	return -1
}

/*
startExitConfirmLocked 出口组里一条真实连接「出口没回就被关」：经这台出口再探一次，又被关才判坏。

同一台出口同一时刻只复核一次；已经判坏的不用再复核。调用方持有 p.mu（复核在自己的协程里跑，不占锁）。
*/
func (p *failoverProxy) startExitConfirmLocked(index int) {
	p.ensureHealthStateLocked()
	if index < 0 || index >= len(p.spec.Targets) || p.exitConfirming[index] || !p.targetHealth[index] {
		return
	}
	p.exitConfirming[index] = true
	target := p.spec.Targets[index]
	go p.confirmExitEarlyClose(target)
}

func (p *failoverProxy) confirmExitEarlyClose(target failoverTarget) {
	verdict, _ := failoverThroughProbe(target, exitConfirmWindow)
	p.mu.Lock()
	defer p.mu.Unlock()
	index := p.indexOfTargetLocked(target)
	if index < 0 || index >= len(p.exitConfirming) {
		return
	}
	p.exitConfirming[index] = false
	if verdict != exitThroughClosed || p.retired() || !p.exitGroupLocked() || !p.targetHealth[index] {
		return
	}
	reason := "exit closed before reply (confirmed through the exit)"
	now := time.Now()
	p.targetHealth[index] = false
	p.exitThroughFailed[index] = true
	p.failureSince[index] = now
	p.recoveredSince[index] = time.Time{}
	logf("failover target unhealthy rule=%d source=%d index=%d target=%s:%d reason=%s", p.ruleID, p.sourcePort, index, target.TargetIP, target.TargetPort, reason)
	p.recordTargetEventLocked(index, "unhealthy", reason)
	p.onTargetDownLocked(index, true, false)
	p.updateFallbackActiveLocked(reason)
}

/*
probeExitGroupTargets 出口组的一轮探测：每台直接探出口机（timeout）；经出口复核判坏过的（throughFailed）还要经
出口探通才算通。有界并行，结果按下标返回。延迟是直接探出口机的往返（入口→出口这一段）。
*/
func probeExitGroupTargets(protocol string, targets []failoverTarget, timeout time.Duration, throughFailed []bool) ([]int, []bool) {
	latencies := make([]int, len(targets))
	results := make([]bool, len(targets))
	sem := make(chan struct{}, failoverProbeParallelism)
	var wg sync.WaitGroup
	for i, target := range targets {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, target failoverTarget) {
			defer wg.Done()
			defer func() { <-sem }()
			var latency int
			var ok bool
			if target.ViaRelay {
				// 在中转后面的出口探不到：算通。延迟记 1 毫秒占位 —— 「延迟优先 / 自动」比的是它加上面板给的
				// 出口→目标延迟；入口→中转→出口那一段几台出口基本共用，不知道也不影响谁排前面。
				latency, ok = 1, true
			} else {
				latency, ok = failoverProbeTargetWithin(protocol, target, timeout)
			}
			if ok && i < len(throughFailed) && throughFailed[i] {
				verdict, _ := failoverThroughProbe(target, exitRecoverWindow)
				ok = verdict == exitThroughOK
			}
			latencies[i], results[i] = latency, ok
		}(i, target)
	}
	wg.Wait()
	return latencies, results
}

/*
exitPinPickLocked 出口组的手动指定：指定的那台在候选里、此刻能用，就是它；否则 -1（照常按分法挑）。

线路组的人工指定只在主备里起作用（把它排到最前，updateFallbackActiveLocked）；出口组不管什么分法，「手动指定」
的意思都是「现在只走这台」，所以在挑之前就拦下。udp 为 true 按 UDP 那一侧的健康看。
*/
func (p *failoverProxy) exitPinPickLocked(candidates []int, udp bool) int {
	if !p.exitGroupLocked() {
		return -1
	}
	pinned := p.pinnedIndexAt(time.Now())
	if pinned < 0 || !p.usableLocked(pinned, udp) {
		return -1
	}
	for _, candidate := range candidates {
		if candidate == pinned {
			return pinned
		}
	}
	return -1
}

// mix64 把 64 位哈希再搅一遍（splitmix64 的终混）：输入只差一位，输出每一位都有一半的机会变。
func mix64(x uint64) uint64 {
	x ^= x >> 30
	x *= 0xbf58476d1ce4e5b9
	x ^= x >> 27
	x *= 0x94d049bb133111eb
	x ^= x >> 31
	return x
}

/*
exitRendezvousPickLocked 出口组的「按访客固定」：加权 rendezvous 哈希，每台出口按「访客 + 出口主机号」算一个分，
分最高的拿走。一台出口坏了只有原来落在它上面的访客换出口；份数不乘慢启动（恢复那一分钟里访客不被来回挪）。

不用线路组那一个（route_group_balance.go 的 rendezvousPickLocked）有两个原因：
  - 它拿 FNV-1a 的结果直接取高 53 位当随机数。FNV 的高位只被靠前的字节搅到，而出口组几条目标的名字只有末尾
    两个字符不一样（127.0.0.1:47004#0 / :47005#1 / :47006#2）—— 同一个访客对三台出口算出来的随机数几乎相等，
    于是份数最大的那台几乎通吃。真实 gost 上实测 8 : 5 : 3 的三台，12 个访客全落在第一台；一万个访客是
    9094 / 399 / 507。份数一样时也歪（2688 / 2462 / 4850）。这里在 FNV 后面加一道终混（mix64），同样的输入是
    4945 / 3143 / 1912 和 3295 / 3387 / 3318。
  - 它的键里有目标的下标和本机端口，出口换个顺序、面板重新分一次本机端口，所有访客都换出口。这里用出口的
    主机号，访客跟着「那台机器」走。

没有访客地址时按监听端口算（所有连接落在同一台上，和线路组一样）。candidates 非空，调用方持有 p.mu。
*/
func (p *failoverProxy) exitRendezvousPickLocked(candidates []int, key string) int {
	if key == "" {
		key = strconv.Itoa(p.sourcePort)
	}
	weights := p.spreadWeightsLocked(candidates, time.Now(), false)
	best, bestScore := -1, 0.0
	for i, index := range candidates {
		if weights[i] <= 0 {
			continue
		}
		node := strconv.Itoa(index)
		if report := p.spec.BalanceReport; report != nil && index < len(report.HostIDs) {
			node = strconv.Itoa(report.HostIDs[index])
		}
		hash := fnv.New64a()
		_, _ = hash.Write([]byte(key))
		_, _ = hash.Write([]byte{0})
		_, _ = hash.Write([]byte("exit-host-" + node))
		u := (float64(mix64(hash.Sum64())>>11) + 0.5) / float64(uint64(1)<<53)
		score := -weights[i] / math.Log(u)
		if best < 0 || score > bestScore {
			best, bestScore = index, score
		}
	}
	if best < 0 {
		return candidates[0]
	}
	return best
}
