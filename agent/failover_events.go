package main

import (
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

/*
主备切换的事件队列。

setActiveLocked 早就把切换写进 Agent 自己的日志了，但那份日志留在机器上 —— 面板
不知道这条规则什么时候切过、为什么切。而主备恰恰是「平时看不出来、出事才知道有没有
用」的东西：切了没人知道，没切更没人知道。

所以把切换和健康翻转攒起来，随心跳带回面板。攒的是**发生过的事**，不是当前状态，
所以用追加队列而不是按键覆盖的映射 —— 一小时里切了三次和切了一次，是完全不同的
两件事。

心跳发失败的话这一批会丢（取快照即出队，和 fxpEndpointEvents 一样）。机器本地的
日志仍然有，所以丢的是「面板上少一条记录」，不是「查不出来」。
*/
const failoverEventQueueMax = 128

var failoverEventMu sync.Mutex

var failoverEventQueue []failoverProxyEvent

type failoverProxyEvent struct {
	RuleID     int `json:"ruleId"`
	SourcePort int `json:"sourcePort"`
	// switch / unhealthy / recovered / prewarm / precheck_failed / unpinned / flap_hold
	Kind       string `json:"kind"`
	FromTarget string `json:"fromTarget,omitempty"`
	ToTarget   string `json:"toTarget"`
	Reason     string `json:"reason,omitempty"`
	// 这条出站最近一次探测的往返耗时（毫秒）；探不通是 0。
	LatencyMs int `json:"latencyMs,omitempty"`
	// 出站在清单里的序号：面板按它对回路径，不用再拿地址去猜。没有是 -1。
	FromIndex int `json:"fromIndex"`
	ToIndex   int `json:"toIndex"`
	// 目标出站当时的评分（routeScore）；没法打分是 -1。
	Score int `json:"score"`
	// 切换时新旧两条整条链的延迟（入口探的这一段 + 后面几段，毫秒）；没探出来是 0。
	// 面板据此写「比 备 1 快 3 ms」（2.2.243 起）。
	FromChainMs int `json:"fromChainMs,omitempty"`
	ToChainMs   int `json:"toChainMs,omitempty"`
	// 整链最优切过去的：新的这条已经连续领先了多久（秒）。
	HeldSeconds int   `json:"heldSeconds,omitempty"`
	OccurredAt  int64 `json:"occurredAt"`
}

func recordFailoverProxyEvent(event failoverProxyEvent) {
	event.OccurredAt = time.Now().UnixMilli()
	failoverEventMu.Lock()
	defer failoverEventMu.Unlock()
	// 队列满了丢最老的：面板更关心刚刚发生了什么，而不是一小时前的第一条。
	if len(failoverEventQueue) >= failoverEventQueueMax {
		failoverEventQueue = failoverEventQueue[len(failoverEventQueue)-failoverEventQueueMax+1:]
	}
	failoverEventQueue = append(failoverEventQueue, event)
}

func failoverProxyEventsSnapshot() []failoverProxyEvent {
	failoverEventMu.Lock()
	defer failoverEventMu.Unlock()
	if len(failoverEventQueue) == 0 {
		return []failoverProxyEvent{}
	}
	drained := failoverEventQueue
	failoverEventQueue = nil
	return drained
}

/*
每台主备代理此刻走的是哪条出站，每次心跳原样报一遍。

切换事件只在「换了」的那一刻报一次，而代理还会不报事件就回到第 0 条：换规格时
（面板上改了主备设置）、Agent 重启之后。只靠事件的话，面板会一直写着最后一次报上
来的那条 —— 机器早就回到主出站了，面板还说「走 备用 1」。赶上心跳请求失败，那一批
事件也就永远丢了。所以把「现在」本身报上去，面板拿它当准，事件只当记录。

只报主备（fallback）：轮询、随机、哈希本来就没有「现在走哪条」。
*/
type failoverActiveReport struct {
	RuleID     int    `json:"ruleId"`
	SourcePort int    `json:"sourcePort"`
	Target     string `json:"target"`
	// 从什么时候开始走这条（Unix 毫秒）。
	Since int64 `json:"since"`
}

func failoverActiveSnapshot() []failoverActiveReport {
	// 先把代理拷出来再逐个加读锁，不在持有 failoverMu 的时候去拿代理自己的锁。
	failoverMu.Lock()
	proxies := make([]*failoverProxy, 0, len(failoverProxies))
	for _, proxy := range failoverProxies {
		proxies = append(proxies, proxy)
	}
	failoverMu.Unlock()
	reports := make([]failoverActiveReport, 0, len(proxies))
	for _, proxy := range proxies {
		proxy.mu.RLock()
		if proxy.spec.Strategy == "fallback" && proxy.activeIndex >= 0 && proxy.activeIndex < len(proxy.spec.Targets) && !proxy.activeSince.IsZero() {
			reports = append(reports, failoverActiveReport{
				RuleID:     proxy.ruleID,
				SourcePort: proxy.sourcePort,
				Target:     failoverTargetLabel(proxy.spec.Targets[proxy.activeIndex]),
				Since:      proxy.activeSince.UnixMilli(),
			})
		}
		proxy.mu.RUnlock()
	}
	sort.Slice(reports, func(i, j int) bool {
		if reports[i].RuleID != reports[j].RuleID {
			return reports[i].RuleID < reports[j].RuleID
		}
		return reports[i].SourcePort < reports[j].SourcePort
	})
	return reports
}

func failoverTargetLabel(target failoverTarget) string {
	host := target.TargetIP
	if strings.Contains(host, ":") && !strings.HasPrefix(host, "[") {
		host = "[" + host + "]"
	}
	return host + ":" + strconv.Itoa(target.TargetPort)
}
