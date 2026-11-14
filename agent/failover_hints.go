package main

import (
	"encoding/json"
	"strings"
	"time"
)

/*
线路组目标上的运行时提示：面板每一轮都可能换的那几个值（中转异常、下游延迟、沿途负载、出口 IP）。

它们和「这条目标怎么走」的行为参数（地址、探测地址、权重、分层、落地怎么分、探测方式）不一样：
  - 不进代理的规格签名（failoverSignature），也不进动作签名、托管服务签名（failoverSpecSignatureJSON）：
    提示一变就重建代理、重新执行动作的话，探测样本和「现在走哪条」全部归零，realm / socat 跟着重启；
  - 不落盘（stripFailoverRelayHints）：Agent 重启后以面板下一次心跳给的为准；
  - 同一份规格再下发时原地换上（applyRelayHintsLocked）。

都收在 failoverTargetHints 里、嵌进 failoverTarget：以后加一个提示，只在这里加一个字段，上面三件事自动跟着做
（要特殊处理的像 Down 那样在 applyRelayHintsLocked 里单写）。JSON 里它们和别的字段平级，面板发来的格式不变；
带着提示的规格这里从来不整份序列化出去（签名、落盘前都先去掉），所以字段挪了位置不影响任何字节。
*/
type failoverTargetHints struct {
	// 面板从中转机的探测得知这条路径的中转挂了：按不可用处理，直到面板把它清掉。
	Down       bool   `json:"down,omitempty"`
	DownReason string `json:"downReason,omitempty"`
	// 面板算好的、这条路径在下游各段中转上的延迟之和（毫秒）。评分和自动择优按
	// 「本机探测延迟 + 它」比整条链路；上报的 latencyMs 仍只是第一段。
	ExtraLatencyMs int `json:"extraLatencyMs,omitempty"`
	// 面板算好的、这条路径沿途主机（中转机、落地是 NEX 主机时的那台）里最忙那台的负载，0–100
	// （CPU 和带宽占用取大；2.2.251 起）。评分按它扣分（routeLoadPenalty：70% 以下不扣，
	// 95% 起扣满 15 分），「自动」分法按它压权重。0 = 不知道，不扣。
	LoadPct int `json:"loadPct,omitempty"`
	// 这条路径最后从哪个 IP 出去（2.2.251，面板 2.3.520「故障切换优先同出口 IP」）：落地是 NEX 主机时是那台的
	// 出口地址（面板看到的心跳来源，没有就是登记的 IPv4 / IPv6），落地是手填地址时就是那个地址。当前这条挂了
	// 要换的时候，在同样够格的候选里优先挑出口 IP 和它一样的（failover_exit_ip.go）—— 对端看到的来源不变，
	// 登录态、IP 绑定不丢。只是平手时的取舍，不压过分层、人工指定和时段表。
	ExitIP string `json:"exitIp,omitempty"`
}

// normalized：规格规整（normalizeFailoverSpec）时这几个值的规矩 —— 原因去掉首尾空白、没断就不留原因，
// 下游延迟夹在 0–failoverMaxExtraLatencyMs，出口 IP 去掉首尾空白。负载原样（面板给的就是 0–100 的整数）。
func (h failoverTargetHints) normalized() failoverTargetHints {
	h.DownReason = strings.TrimSpace(h.DownReason)
	if !h.Down {
		h.DownReason = ""
	}
	if h.ExtraLatencyMs < 0 {
		h.ExtraLatencyMs = 0
	}
	if h.ExtraLatencyMs > failoverMaxExtraLatencyMs {
		h.ExtraLatencyMs = failoverMaxExtraLatencyMs
	}
	h.ExitIP = strings.TrimSpace(h.ExitIP)
	return h
}

// 面板下发的中转提示是运行时状态，不进落盘快照：Agent 重启后以面板下一次心跳给的为准。
func stripFailoverRelayHints(spec failoverSpec) failoverSpec {
	targets := make([]failoverTarget, len(spec.Targets))
	copy(targets, spec.Targets)
	for i := range targets {
		targets[i].failoverTargetHints = failoverTargetHints{}
	}
	spec.Targets = targets
	return spec
}

/*
failoverSpecSignatureJSON 动作签名（actionCommandSignature）和托管服务签名（managedServiceActionSignature）
里的线路组规格：先去掉运行时提示再序列化。

提示（中转异常、下游延迟、沿途负载、出口 IP）面板每一轮都可能换。算进这两个签名的话，提示一变 Agent 就当成
动作变了重新执行一遍，realm / socat 这类托管服务跟着重启，正在走的连接全断。去掉之后提示照样送得到：
runningRules 每次心跳都同步一遍（syncRunningRuleState → startFailoverProxyLocked），代理的规格签名没变就只
原地换上提示（applyRelayHintsLocked）。

没带提示的规格序列化出来和直接 json.Marshal 逐字节相同（Targets 为 nil 时保持 nil，不变成 []），
升级后这类规格的签名不变，不会因此重做一遍。
*/
func failoverSpecSignatureJSON(spec *failoverSpec) (string, bool) {
	if spec == nil {
		return "", false
	}
	stripped := *spec
	if spec.Targets != nil {
		stripped = stripFailoverRelayHints(*spec)
	}
	raw, err := json.Marshal(stripped)
	if err != nil {
		return "", false
	}
	return string(raw), true
}

/*
面板下发的提示变了：不重建代理，只改这几条的可用性，再重新选路。

提示不进签名（见 failoverSignature），所以同一份规格反复下发只会走到这里。变化才记事件：
面板每次心跳都会重发同样的提示。
*/
// 面板「切换演练」下发的提示原因（server/routeDrill.ts 的 ROUTE_DRILL_HINT_REASON）。
const failoverDrillReason = "drill"

// 演练撤掉之后多久以内切回它还算「演练的切回」：恢复观察时间再加两分钟（探测、最短驻留都要时间）。
const failoverDrillFailbackSlack = 2 * time.Minute

/*
这一次切换是不是切换演练引起的：从正在被演练（面板让它当成挂了）的那条切走，或者演练刚撤掉、切回那一条。

演练是人故意做的，和人工指定一样不算进抖动抑制的次数 —— 不然一小时里演练两回，再碰上一次真故障，
恢复后的切回就要多等 5 分钟起（flapHoldLocked），演练反而把线路弄得不灵了。
*/
func (p *failoverProxy) drillSwitchLocked(from, to int, at time.Time) bool {
	if from >= 0 && from < len(p.relayDown) && p.relayDown[from] && p.relayDownReason[from] == failoverDrillReason {
		return true
	}
	if to >= 0 && to < len(p.drillEndedAt) && !p.drillEndedAt[to].IsZero() {
		window := time.Duration(p.spec.RecoverSeconds)*time.Second + failoverDrillFailbackSlack
		if at.Sub(p.drillEndedAt[to]) <= window {
			// 一次演练只免一次切回
			p.drillEndedAt[to] = time.Time{}
			return true
		}
	}
	return false
}

func (p *failoverProxy) applyRelayHintsLocked(targets []failoverTarget) {
	p.ensureHealthStateLocked()
	reason := ""
	changed := false
	for i, target := range targets {
		if i >= len(p.spec.Targets) {
			break
		}
		// 中转异常（Down / DownReason）下面单独处理：翻转要记事件、重新选路。别的提示（下游延迟、沿途负载只影响
		// 评分和「自动」的权重，出口 IP 只在下一次换路时当平手取舍用）直接换上，下一轮探测按新值评估，不记事件、
		// 不重新选路。出口 IP 去掉首尾空白，其余原样。
		next := target.failoverTargetHints
		next.ExitIP = strings.TrimSpace(next.ExitIP)
		next.Down = p.spec.Targets[i].Down
		next.DownReason = p.spec.Targets[i].DownReason
		p.spec.Targets[i].failoverTargetHints = next
		down := target.Down
		downReason := strings.TrimSpace(target.DownReason)
		if !down {
			downReason = ""
		}
		if down == p.relayDown[i] && downReason == p.relayDownReason[i] {
			continue
		}
		flipped := down != p.relayDown[i]
		// 演练的提示撤掉了（或者换成了别的原因）：记下时刻，接下来切回它的那一次不算进抖动抑制。
		if p.relayDown[i] && p.relayDownReason[i] == failoverDrillReason && (!down || downReason != failoverDrillReason) {
			p.drillEndedAt[i] = time.Now()
		}
		p.relayDown[i] = down
		p.relayDownReason[i] = downReason
		p.spec.Targets[i].Down = down
		p.spec.Targets[i].DownReason = downReason
		if !flipped {
			continue
		}
		changed = true
		if down {
			text := "relay down"
			if downReason != "" {
				text = "relay down: " + downReason
			}
			logf("failover target relay down rule=%d source=%d index=%d target=%s reason=%s", p.ruleID, p.sourcePort, i, failoverTargetLabel(p.spec.Targets[i]), downReason)
			p.recordTargetEventLocked(i, "unhealthy", text)
			if i == p.activeIndex || reason == "" {
				reason = text
			}
		} else {
			logf("failover target relay recovered rule=%d source=%d index=%d target=%s", p.ruleID, p.sourcePort, i, failoverTargetLabel(p.spec.Targets[i]))
			p.recordTargetEventLocked(i, "recovered", "relay recovered")
			if reason == "" {
				reason = "relay recovered"
			}
		}
	}
	if changed {
		p.updateFallbackActiveLocked(reason)
	}
}

// activeRelayDownLocked 正走的那条此刻是不是被面板标成「中转断了」。
func (p *failoverProxy) activeRelayDownLocked() bool {
	return p.activeIndex >= 0 && p.activeIndex < len(p.relayDown) && p.relayDown[p.activeIndex]
}
