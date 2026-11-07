package main

import (
	"sync"
	"sync/atomic"
)

/*
进程内 UDP 中继（线路组 route_group_udp.go、协议守护 protocol_guard_udp.go）的会话总量。

每条规则自己有上限（线路组 failoverUDPMaxSessions、协议守护 protocolGuardUDPMaxSessions），
到了就回收这条规则里最久没动静的会话（LRU）。但规则一多，几十条规则各自顶满就是几十万个
上游套接字：先用光的是这个进程的文件句柄，然后 TCP 转发、心跳、一切都开不了新连接。
所以再加一道全进程的总上限，按文件句柄上限的一半算，最多 udpRelayGlobalSessionCeiling 个。

总量到顶时，要开新会话的那条规则回收它自己最久没动静的会话（规则各自的回收规矩不变：线路组
回收最老的那个，协议守护只回收空闲超过 protocolGuardUDPEvictMinIdle 的）；它自己没有可回收的
就拒掉这个新会话。不去动别的规则的会话：一条规则被扫描、伪造源地址冲爆，不该连累别的规则。

计数随心跳报给面板（agentRuntime.udp*），主机详情里看得到：现在多少个、上限多少、累计回收
多少（单条规则的上限和全局上限都算）、累计拒绝多少。

forwardx-fxp 的 UDP 会话在它自己的进程里，有自己的上限（forwardx-fxp/udp_tuning.go 的
fxpUDPMaxSessions 等），不算在这里。
*/

const (
	udpRelayGlobalSessionCeiling = 32768
	udpRelayGlobalSessionFloor   = 1024
)

var (
	udpRelaySessionsActive   atomic.Int64
	udpRelaySessionsEvicted  atomic.Uint64
	udpRelaySessionsRejected atomic.Uint64

	udpRelayGlobalCapOnce sync.Once
	udpRelayGlobalCap     atomic.Int64
)

// udpRelayGlobalSessionCap 是全进程的 UDP 中继会话上限：文件句柄软上限的一半（另一半留给
// TCP 转发、监听和别的），夹在 [udpRelayGlobalSessionFloor, udpRelayGlobalSessionCeiling]。
// 读不到句柄上限（非 Unix）就用上限值。
func udpRelayGlobalSessionCap() int64 {
	udpRelayGlobalCapOnce.Do(func() {
		if udpRelayGlobalCap.Load() > 0 {
			return
		}
		limit := int64(udpRelayGlobalSessionCeiling)
		if nofile := processOpenFileLimit(); nofile > 0 {
			limit = min(limit, int64(nofile/2))
		}
		udpRelayGlobalCap.Store(max(limit, udpRelayGlobalSessionFloor))
	})
	return udpRelayGlobalCap.Load()
}

// udpRelayGlobalFull：再开一个会话就会超过全进程上限。
func udpRelayGlobalFull() bool {
	return udpRelaySessionsActive.Load() >= udpRelayGlobalSessionCap()
}

// runUDPRelaySession 在一个新协程里跑会话的回包循环，并把它算进全进程的会话数：
// 回包循环返回（会话被关、被回收、空闲超时、中继退出）时减掉。
func runUDPRelaySession(loop func()) {
	udpRelaySessionsActive.Add(1)
	go func() {
		defer udpRelaySessionsActive.Add(-1)
		loop()
	}()
}

func noteUDPRelaySessionEvicted()  { udpRelaySessionsEvicted.Add(1) }
func noteUDPRelaySessionRejected() { udpRelaySessionsRejected.Add(1) }

type udpRelaySessionStats struct {
	Active   int64  `json:"active"`
	Cap      int64  `json:"cap"`
	Evicted  uint64 `json:"evicted"`
	Rejected uint64 `json:"rejected"`
}

func udpRelaySessionSnapshot() udpRelaySessionStats {
	return udpRelaySessionStats{
		Active:   max(udpRelaySessionsActive.Load(), 0),
		Cap:      udpRelayGlobalSessionCap(),
		Evicted:  udpRelaySessionsEvicted.Load(),
		Rejected: udpRelaySessionsRejected.Load(),
	}
}
