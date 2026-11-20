package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strconv"
	"sync"
	"time"
)

/*
出口组：GOST 隧道的几台出口，由入口机的这个代理挑（Agent 2.2.264 起真正启用，面板 shared/loadBalance.ts 的
UNIFIED_BALANCE_AGENT_VERSION；2.2.262 加的那一版面板侧从没下发过）。没有老路可退：gost 自己的节点选择器那条路
面板已经删掉，入口机的 Agent 更老时面板只下发主出口一台。

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
    本机端口、什么都不发，最多等 exitConfirmWindow，看会不会又被关；拿别的出口比的那几条同时开，exitConfirmFault）：
    - 又被关，而别的能用的出口经出口照样开着：不是那个客户端的问题，是这台出口到目标走不通 —— 当场判坏
    （不用凑两个不同访客）。之后每轮探测除了直接探出口机，还要经出口连着探通 exitThroughRecoverOKs 次才算恢复
    （exitThroughFailed）；不然出口机本身是通的，下一轮就被放回来、再坏一次，来回翻。
    - 别的能用的出口经出口也全被关：是目标自己会很快关掉不说话的连接（经哪台都一样），谁都不判，exitSilentCloseBackoff
    里不再拿这个信号判（F7）。探测这一头分不出「目标拒绝」和「目标连上以后自己关」：relay 的应答（出口拨目标成没成）
    由入口的 gost 读掉（connector 带 nodelay，读到失败就关本机这条连接），探测看到的都只是「连接被关了」，
    所以只能拿别的出口比。没有别的出口可比时也不判 —— 不拿这个信号摘掉最后一台。
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
复核那条又要约 3 秒才被关、别的出口再开着 1 秒（exitCompareGrace）就判坏：第一条连接后约 7 秒；恢复同样要经
出口等满 exitConfirmWindow（gost 拨死出口要 3 秒才关，等得短了死出口每次都像「探通」，F2）。没有 TCP 流量（空闲、只转 UDP 的规则）时要等面板的提示。以前 gost 选择器那条路同样只在
连接失败时才发现，这一点没有变差；想在多跳上也做到「几秒内本地摘掉」，得让出口机上有一个可以穿过隧道去问的
探测端口，现在没有。

出口进程卡死、内核还在接连接：链路是不加密的 tcp / mtcp 时 TCP 握手不需要对端进程参与，光连一下判不出来。
这种出口的规格带 ProbeRelay，第 1 条的探测连上以后再发 8 个 0 字节、等 gost 当场断开（failoverProbeRelay）：
活着的 gost 读到版本不对（relay 头第一个字节、mux 帧头第一个字节都必须是 1）立刻关，卡死的不读也不关 ——
探测超时算不通，和黑洞一样摘掉。不碰目标、不建 relay 会话；gost 那边每次记一条错误日志，和以前光连一下就断
（它记 EOF）一样多。tls / wss 的握手本来就要对端进程回话，真实连接 3 秒握手超时后就是第 2 条。
*/

const (
	/*
		经出口探一次等多久（复核和判坏以后的恢复都是它）：每出口的本机 gost 端口拨出口最多 3 秒（面板写的
		dialTimeout），再留 1 秒。恢复不能等得更短：出口在中转后面（直接探不到）、或者出口到目标是 SYN 黑洞时，
		gost 要拨满 3 秒才关本机这条连接 —— 以前恢复只等 1.5 秒，死出口每次都「探通」，判坏后约 6 秒就被放回来、
		再让真实连接卡 3 秒，周而复始（F2）。
	*/
	exitConfirmWindow = 4 * time.Second
	// 判坏以后要经出口连着探通几次才放回（还要过 RecoverSeconds 那道门槛）。
	exitThroughRecoverOKs = 2
	// 别的出口经出口也全被关（目标自己会关不说话的连接）：这么久里不再拿「经出口被关」判出口（F7）。
	exitSilentCloseBackoff = 5 * time.Minute
	// 拿别的出口比过、有一台照样开着：这么久里同一个结论接着用，判坏的出口每轮恢复复核不再去碰别的出口
	// （每比一次就是往目标多开几条不说话的连接）。
	exitCompareReuse = time.Minute
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
协议会回数据）—— 除非目标自己很快关掉不说话的连接，那和「拨不通」在这里看起来一样（relay 的应答被入口的 gost
读掉了），所以「window 内被关」要再拿别的出口比过才算这台的账（exitConfirmFault / exitCloseIsOwnFault）。
「还开着 / 有数据」= 走得通。ctx 提前结束（拿它比的那台已经有结论了）时还开着的也算 exitThroughOK —— 意思是
「看着的这段时间里一直开着」。第二个返回值是收到第一个字节花了多久（毫秒；没收到数据是 0）。测试里换掉。
*/
var failoverThroughProbe = func(ctx context.Context, target failoverTarget, window time.Duration) (exitThroughVerdict, int) {
	started := time.Now()
	conn, err := failoverDialTCP(ctx, target, failoverProbeDefaultTimeout)
	if err != nil {
		return exitThroughUnknown, 0
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { _ = conn.SetReadDeadline(time.Now()) })
	defer stop()
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
startExitConfirmLocked 出口组里一条真实连接「出口没回就被关」：经这台出口再探一次，又被关（而且是这台的问题，
见 exitCloseIsOwnFault）才判坏。

同一台出口同一时刻只有一个经出口的探测（exitConfirming）；已经判坏的不用再复核；刚发现目标会关不说话的连接时
不复核（exitSilentCloseUntil）。调用方持有 p.mu（复核在自己的协程里跑，不占锁）。
*/
func (p *failoverProxy) startExitConfirmLocked(index int) {
	p.ensureHealthStateLocked()
	if index < 0 || index >= len(p.spec.Targets) || p.exitConfirming[index] || !p.targetHealth[index] || time.Now().Before(p.exitSilentCloseUntil) {
		return
	}
	p.exitConfirming[index] = true
	go p.confirmExitEarlyClose(p.spec.Targets[index])
}

/*
confirmExitEarlyClose 复核一次「出口没回就被关」，是这台的账就判坏。

复核的同时直接探一次出口机（多跳的探不到，不探）：出口机本身也连不上（进程死掉时 gost 拨它被拒，真实连接 1 毫秒
就被关，复核比每轮的直接探测先判坏），就是机器的问题，和直接探测判坏的出口一样靠直接探测恢复，不记 exitThroughFailed
—— 不然进程重启后还要经出口连着探通 2 × exitConfirmWindow 才放回（真实 gost：9 秒，本来 4 秒）。出口机通、经它却
被关，才是「出口到目标走不通」，要经出口恢复。
*/
func (p *failoverProxy) confirmExitEarlyClose(target failoverTarget) {
	machine := make(chan bool, 1)
	if target.ViaRelay {
		machine <- true
	} else {
		p.mu.RLock()
		protocol, timeout := failoverProtocol(p.spec), p.probeTimeoutLocked()
		p.mu.RUnlock()
		probe := failoverExitMachineProbe
		go func() { machine <- probe(protocol, target, timeout) }()
	}
	fault := p.exitConfirmFault(target)
	machineUp := <-machine
	p.mu.Lock()
	defer p.mu.Unlock()
	index := p.indexOfTargetLocked(target)
	if index < 0 || index >= len(p.exitConfirming) {
		return
	}
	p.exitConfirming[index] = false
	if !fault || p.retired() || !p.exitGroupLocked() || !p.targetHealth[index] {
		return
	}
	reason := "exit closed before reply (confirmed through the exit)"
	if machineUp {
		p.exitThroughFailed[index] = true
		p.exitThroughOKs[index] = 0
	} else {
		reason = "exit closed before reply (the exit machine is unreachable too)"
	}
	p.markUnhealthyLocked(index, reason, "")
	p.updateFallbackActiveLocked(reason)
}

// failoverExitMachineProbe 直接探一次出口机（和每轮探测同一个探法）。测试里换掉。
var failoverExitMachineProbe = func(protocol string, target failoverTarget, timeout time.Duration) bool {
	_, results := probeExitGroupTargets(protocol, []failoverTarget{target}, timeout)
	return results[0]
}

// exitCompareGrace：复核时拿别的出口比，那台被关以后别的出口还要再开着这么久才算「照样开着」。
// 目标自己关不说话的连接时，同一刻开的几条差不多同时被关，差不出这么多。
const exitCompareGrace = time.Second

/*
exitConfirmFault 复核（第一次判坏，要快）：经 target 探一次，被关了算不算它的账。

拿别的出口比的那几条和经 target 的这条**同时**开（exitCloseIsOwnFault 是先探完这台再比，多跳上那就是 gost 拨死出口
的 3 秒 + 别的出口等满 exitConfirmWindow 的 4 秒，真实连接撞上以后 7 秒才判坏，再加上撞上的那 3 秒就是 10 秒）。
经 target 的这条在 c 时刻被关：别的出口那时已经回了数据 / 到 c + exitCompareGrace 还开着 → 是这台的问题；别的
到那时全被关了 → 是目标的脾气（exitSilentCloseUntil）；经 target 的一直开着 / 说不准 → 不判，别的那几条当场收掉。
exitCompareReuse 里比出过「别的照样开着」就只探这一台；没有别的能用的出口可比时不判（也不去探）。
代价：经 target 的这条最后没被关时，别的出口也白开了一条不说话的连接 —— 复核只在真实连接「没回就被关」时才有，
每台同一时刻一个。调用方不能持有 p.mu。
*/
func (p *failoverProxy) exitConfirmFault(target failoverTarget) bool {
	others, known := p.exitCompareOthers(target)
	if known {
		verdict, _ := failoverThroughProbe(context.Background(), target, exitConfirmWindow)
		return verdict == exitThroughClosed
	}
	if len(others) == 0 {
		return false
	}
	probe := failoverThroughProbe
	// 返回前收掉还开着的那几条，等它们退出（cancel 先跑：defer 后进先出）。
	var wg sync.WaitGroup
	defer wg.Wait()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	verdicts := make(chan exitThroughVerdict, len(others))
	sem := make(chan struct{}, failoverProbeParallelism)
	for _, other := range others {
		wg.Add(1)
		go func(other failoverTarget) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			if ctx.Err() != nil {
				verdicts <- exitThroughUnknown
				return
			}
			verdict, _ := probe(ctx, other, exitConfirmWindow)
			verdicts <- verdict
		}(other)
	}
	if verdict, _ := probe(ctx, target, exitConfirmWindow); verdict != exitThroughClosed {
		return false
	}
	grace := time.NewTimer(exitCompareGrace)
	defer grace.Stop()
	closed := false
	for pending := len(others); pending > 0; {
		select {
		case verdict := <-verdicts:
			pending--
			if verdict == exitThroughOK {
				p.noteExitOthersOpen()
				return true
			}
			closed = closed || verdict == exitThroughClosed
		case <-grace.C:
			// 这台被关以后又过了 exitCompareGrace，别的还开着。
			p.noteExitOthersOpen()
			return true
		}
	}
	if closed {
		p.noteExitSilentClose()
	}
	return false
}

// exitCompareOthers 拿来比的别的出口（此刻能用的）；known：exitCompareReuse 里已经比出过「别的照样开着」，不用再比。
func (p *failoverProxy) exitCompareOthers(target failoverTarget) (others []failoverTarget, known bool) {
	key := targetStateKey(target)
	p.mu.RLock()
	defer p.mu.RUnlock()
	if !p.exitOthersOpenAt.IsZero() && time.Since(p.exitOthersOpenAt) < exitCompareReuse {
		return nil, true
	}
	for i, other := range p.spec.Targets {
		if targetStateKey(other) != key && p.healthyLocked(i) {
			others = append(others, other)
		}
	}
	return others, false
}

func (p *failoverProxy) noteExitOthersOpen() {
	p.mu.Lock()
	p.exitOthersOpenAt = time.Now()
	p.mu.Unlock()
}

func (p *failoverProxy) noteExitSilentClose() {
	p.mu.Lock()
	p.exitSilentCloseUntil = time.Now().Add(exitSilentCloseBackoff)
	p.mu.Unlock()
	if shouldLogAgentReport(fmt.Sprintf("failover-exit-silent-close:%d:%d", p.ruleID, p.sourcePort), time.Hour) {
		logf("failover exit group: the target closes silent connections through every exit; not blaming exits for it rule=%d source=%d", p.ruleID, p.sourcePort)
	}
}

/*
exitCloseIsOwnFault 经 target 这台出口已经被关了（恢复复核时）：算不算它的账。拿别的此刻能用的出口各经出口探一次比
（有界并行）：有一台照样开着 → 是这台的问题；全被关 → 是目标的脾气（很快关掉不说话的连接），记下 exitSilentCloseUntil；
没有别的可比、或者别的都说不准 → 不算（不拿这个信号摘掉最后一台）。exitCompareReuse 里比出过「别的照样开着」
就直接用那个结论。恢复不赶时间，先探完这台、被关了才比（不白开连接）；第一次判坏用 exitConfirmFault（同时比）。
调用方不能持有 p.mu。
*/
func (p *failoverProxy) exitCloseIsOwnFault(target failoverTarget) bool {
	others, known := p.exitCompareOthers(target)
	if known {
		return true
	}
	if len(others) == 0 {
		return false
	}
	_, verdicts := probeFailoverTargetsWith(others, func(other failoverTarget) (int, exitThroughVerdict) {
		verdict, _ := failoverThroughProbe(context.Background(), other, exitConfirmWindow)
		return 0, verdict
	})
	closed := false
	for _, verdict := range verdicts {
		if verdict == exitThroughOK {
			p.noteExitOthersOpen()
			return true
		}
		closed = closed || verdict == exitThroughClosed
	}
	if closed {
		p.noteExitSilentClose()
	}
	return false
}

/*
gateExitThroughLocked 一轮探测之后：经出口复核判坏过的出口（exitThroughFailed），直接探通不够 —— 还要经出口探通。
经出口的探测要等满 exitConfirmWindow，比一轮探测的超时长，所以另起协程跑（每台同一时刻一个，recheckExitThrough），
这一轮用的是它攒下的「连着通了几次」：至少一次才算这一轮通，够 exitThroughRecoverOKs 次（还要过 RecoverSeconds
那道门槛）才放回。直接探都不通的清零，正在跑的那次作废（exitThroughGen）。调用方持有 p.mu。
*/
func (p *failoverProxy) gateExitThroughLocked(results []bool) {
	for i := range results {
		if i < len(p.exitMachineUp) {
			p.exitMachineUp[i] = results[i]
		}
		if i >= len(p.exitThroughFailed) || !p.exitThroughFailed[i] {
			continue
		}
		if !results[i] {
			p.exitThroughOKs[i] = 0
			p.exitThroughGen[i]++
			continue
		}
		if !p.exitConfirming[i] && p.exitThroughOKs[i] < exitThroughRecoverOKs {
			p.exitConfirming[i] = true
			go p.recheckExitThrough(p.spec.Targets[i], p.exitThroughGen[i])
		}
		results[i] = p.exitThroughOKs[i] > 0
	}
}

/*
真实连接试探恢复（2.2.265 起，用户实测：三台出口机都正常、高防目标把其中一台出口「连上不说话」的连接 1 秒就关，
这台被经出口复核判成「到目标不行」后 11 分钟没放回）。

经出口的恢复探测是一条不说话的连接（上面的 recheckExitThrough），目标要是对这台出口的来源 IP 关得特别快（高防按
IP 限制、或者就是按 IP 区别对待），它永远「探不通」—— 可真实连接是说话的，照样走得通。所以判坏过（exitThroughFailed）、
出口机本身探得通（exitMachineUp）的出口，每隔 exitCanaryGap 让**一条真实 TCP 连接**先试它（pickReserved 里，只在新连接
的第一次挑）：
  - 上游回了东西（markEarlyReply → exitCanaryRepliedLocked）：走得通，当场放回，不等恢复门槛 —— 这是比探测硬的证据；
  - 一个字节没回就被关：保护期照常把这条连接换到别的出口重发（failover_early_close.go），客户端无感，这台继续判坏，
    下一次到点再试。出口到目标真不通时，每 exitCanaryGap 只有一条连接多付一次拨号的时间（被拒 1 毫秒、黑洞 3 秒）。

不说话的恢复探测照旧跑着（没有 TCP 流量、只转 UDP 的规则靠它）。手动指定了别的出口时不试（只走指定的那台）。
*/
const exitCanaryGap = exitConfirmWindow

// exitCanaryIndexLocked 此刻该拿这条新连接试哪台判坏的出口；没有返回 -1。调用方持有 p.mu。
func (p *failoverProxy) exitCanaryIndexLocked(now time.Time) int {
	if !p.exitGroupLocked() || p.done == nil || p.retired() {
		return -1
	}
	p.ensureHealthStateLocked()
	if pinned := p.pinnedIndexAt(now); pinned >= 0 && p.usableLocked(pinned, false) {
		return -1
	}
	gap := exitCanaryGap
	if interval := time.Duration(p.spec.ProbeIntervalSeconds) * time.Second; interval > gap {
		gap = interval
	}
	for i := range p.spec.Targets {
		if !p.exitThroughFailed[i] || p.targetHealth[i] || !p.exitMachineUp[i] || p.relayDown[i] {
			continue
		}
		if !p.exitCanaryAt[i].IsZero() && now.Sub(p.exitCanaryAt[i]) < gap {
			continue
		}
		p.exitCanaryAt[i] = now
		return i
	}
	return -1
}

// exitCanaryRepliedLocked 经出口判坏的出口上一条真实连接收到了上游的回复：放回。调用方持有 p.mu。
func (p *failoverProxy) exitCanaryRepliedLocked(index int) {
	if !p.exitGroupLocked() || index >= len(p.exitThroughFailed) || !p.exitThroughFailed[index] || p.targetHealth[index] {
		return
	}
	p.exitThroughGen[index]++ // 正在跑的不说话探测作废
	p.readmitForLocked(index, time.Now(), "a real connection got a reply through the exit")
	p.updateFallbackActiveLocked("canary reply")
}

// exitThroughRecoveredLocked 这台出口经出口那一关过了没有（没经出口判坏过的不用过）。调用方持有 p.mu。
func (p *failoverProxy) exitThroughRecoveredLocked(index int) bool {
	return index >= len(p.exitThroughFailed) || !p.exitThroughFailed[index] || p.exitThroughOKs[index] >= exitThroughRecoverOKs
}

/*
recheckExitThrough 判坏过的出口经出口探一次（恢复）。gen 是发起时的 exitThroughGen：中间直接探失败过（清零了）
这次的结果作废。

探通了不等下一轮探测：
  - 恢复从这次探测开始时算起（recoveredSince）—— 它开着的这 exitConfirmWindow 里路一直是通的，中间直接探也没失败；
    以前要等下一轮探测才开始计时，第二次经出口探又要等再下一轮才发起，到目标恢复后 13 秒才放回；
  - 还不够 exitThroughRecoverOKs 次就接着探下一次；
  - 够了、恢复门槛也过了，当场放回（readmitLocked），不等下一轮。

这样到目标恢复以后最多「一轮探测的间隔 + 2 × exitConfirmWindow」放回（默认约 10 秒）。
*/
func (p *failoverProxy) recheckExitThrough(target failoverTarget, gen uint64) {
	started := time.Now()
	verdict, _ := failoverThroughProbe(context.Background(), target, exitConfirmWindow)
	if verdict == exitThroughClosed && !p.exitCloseIsOwnFault(target) {
		// 别的出口也被关（目标的脾气），或者没有别的可比：不拿它把这台一直扣着。
		verdict = exitThroughOK
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	index := p.indexOfTargetLocked(target)
	if index < 0 || index >= len(p.exitConfirming) {
		return
	}
	p.exitConfirming[index] = false
	if !p.exitThroughFailed[index] || p.exitThroughGen[index] != gen || p.retired() {
		return
	}
	switch verdict {
	case exitThroughOK:
		p.exitThroughOKs[index]++
	case exitThroughClosed:
		p.exitThroughOKs[index] = 0
		return
	default:
		return
	}
	if p.targetHealth[index] {
		return
	}
	if p.recoveredSince[index].IsZero() {
		p.recoveredSince[index] = started
	}
	if p.exitThroughOKs[index] < exitThroughRecoverOKs {
		p.exitConfirming[index] = true
		go p.recheckExitThrough(target, gen)
		return
	}
	now := time.Now()
	if p.recoverGateReachedLocked(now.Sub(p.recoveredSince[index])) {
		p.readmitLocked(index, now)
		p.updateFallbackActiveLocked("health check")
	}
}

/*
probeExitGroupTargets 出口组的一轮探测：每台直接探出口机（timeout），有界并行，结果按下标返回。延迟是直接探出口机的
往返（入口→出口这一段）。经出口复核判坏过的还要经出口探通，那一关在 gateExitThroughLocked。
*/
func probeExitGroupTargets(protocol string, targets []failoverTarget, timeout time.Duration) ([]int, []bool) {
	return probeFailoverTargetsWith(targets, func(target failoverTarget) (int, bool) {
		switch {
		case target.ViaRelay:
			// 在中转后面的出口探不到：算通。延迟记 1 毫秒占位 —— 「延迟优先 / 自动」比的是它加上面板给的
			// 出口→目标延迟；入口→中转→出口那一段几台出口基本共用，不知道也不影响谁排前面。
			return 1, true
		case target.ProbeRelay:
			return failoverProbeRelay(target, timeout)
		default:
			return failoverProbeTargetWithin(protocol, target, timeout)
		}
	})
}

// exitRelayProbeRequest：发给出口机隧道监听的坏请求。relay 头（VER CMD FLEN）和 mux 帧头（VER CMD LEN SID）
// 的第一个字节都是版本号、都必须是 1；8 个字节够两种头读满，gost 读完就断开，不会再等。
var exitRelayProbeRequest = make([]byte, 8)

/*
failoverProbeRelay 直接探一台 tcp / mtcp 出口：连上出口机的隧道监听（延迟记这一段，连接本身也限 timeout），
发 exitRelayProbeRequest，再等一个 timeout 看对端断开（或者回了什么）—— 都说明 gost 进程在读。连不上、超时都算不通。
*/
var failoverProbeRelay = func(target failoverTarget, timeout time.Duration) (int, bool) {
	host, port := target.probeEndpoint()
	started := time.Now()
	conn, err := net.DialTimeout("tcp", net.JoinHostPort(host, strconv.Itoa(port)), timeout)
	if err != nil {
		return 0, false
	}
	defer conn.Close()
	latency := int(time.Since(started) / time.Millisecond)
	if latency < 1 {
		latency = 1
	}
	// 回话要再一个往返：从连上起再等一个 timeout（远的出口不会因为多了这一个往返被误判）。
	_ = conn.SetDeadline(time.Now().Add(timeout))
	if _, err := conn.Write(exitRelayProbeRequest); err != nil {
		return latency, false
	}
	buf := make([]byte, 16)
	for {
		n, err := conn.Read(buf)
		if n > 0 {
			return latency, true
		}
		if err != nil {
			// 对端关了（EOF / RST）就是活着；超时是卡死。
			return latency, !isNetTimeout(err)
		}
	}
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
