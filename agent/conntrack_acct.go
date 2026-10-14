package main

import (
	"errors"
	"sort"
	"strconv"
	"sync"
)

/*
基于 conntrack 的流量计数（主机「内核快速转发」开着时用，2.2.221 起）。

flowtable 把建立好的连接挪到 ingress 上的快速路径，之后的包不再经过 PREROUTING / FORWARD /
POSTROUTING，iptables 和 nft 规则里的计数器只看得到每条连接最开始和最后几个包。flowtable 开了
counter 以后，快速路径上的包仍然记在 conntrack 自己的字节计数上（nf_conntrack_acct），所以这些
端口改从 conntrack 计：

  - 每轮流量采集 dump 一次 conntrack，按连接（CTA_ID + zone）记下上次看到的字节数，差值加进
    该连接原始方向目的端口的累计值；
  - 另开一个订阅 conntrack DESTROY 事件的 netlink socket，连接结束时把最后一段差值补上
    （不然两次采集之间建立又结束的短连接、连接最后那一截都会漏掉）；
  - 只看做了 DNAT 的连接（iptables / nftables 规则、内核直通都是 DNAT），本机进程自己收发的
    同端口流量不算进来。

方向和 iptables 计数一致：原始方向（客户端 → 目标）算入站 in，回复方向算出站 out；字节数都是
IP 层长度，和 iptables 计数器的口径一样。

累计值第一次用到某个端口时从该端口持久化的基线起步（和 conntrackTotalsByPort 一个办法），所以
从 iptables 计数切过来、Agent 重启后重新开始，这一轮的增量都是 0，不会把已经报过的再报一遍；
代价是重启空档里的流量不计。DESTROY 事件在机器极忙、socket 缓冲塞满时可能丢（ENOBUFS），丢的
是那些连接最后一段，只会少记不会多记。
*/

// conntrackFlow 是 conntrack 表里一条连接里计数要用到的部分。
type conntrackFlow struct {
	ID          uint32
	Zone        uint16
	Proto       uint8
	OrigDstPort uint16
	Status      uint32
	InBytes     uint64
	OutBytes    uint64
	HasCounters bool
}

const (
	conntrackStatusDstNAT  = 1 << 5
	conntrackStatusOffload = 1 << 14
	conntrackProtoTCP      = 6
	conntrackProtoUDP      = 17
)

type conntrackFlowKey struct {
	id   uint32
	zone uint16
}

type conntrackFlowBytes struct {
	in  uint64
	out uint64
}

func (f conntrackFlow) key() conntrackFlowKey { return conntrackFlowKey{id: f.ID, zone: f.Zone} }

func (f conntrackFlow) protocolName() string {
	switch f.Proto {
	case conntrackProtoTCP:
		return "tcp"
	case conntrackProtoUDP:
		return "udp"
	default:
		return ""
	}
}

// accountable：只算做了 DNAT、带字节计数的 TCP / UDP 连接。
func (f conntrackFlow) accountable() bool {
	return f.HasCounters && f.Status&conntrackStatusDstNAT != 0 && f.protocolName() != "" && f.OrigDstPort != 0
}

// conntrackSource 是 conntrack 的读法：一次完整 dump，加一路 DESTROY 事件。Linux 上是 netlink，
// 测试里换成假的。
type conntrackSource interface {
	dump() ([]conntrackFlow, error)
	// subscribe 开始把 DESTROY 事件交给 onDestroy，返回关掉订阅的函数。overflow 在事件丢失时调用。
	subscribe(onDestroy func(conntrackFlow), overflow func()) (func(), error)
}

// conntrackAccountant 维护每个端口按 conntrack 算出来的累计字节数。
type conntrackAccountant struct {
	source conntrackSource

	mu        sync.Mutex
	running   bool
	seeding   bool
	stop      func()
	live      map[conntrackFlowKey]conntrackFlowBytes
	tombs     map[conntrackFlowKey]uint64
	gen       uint64
	totals    map[string]*trafficCounters
	watched   map[int]map[string]bool
	overflows uint64
	offloaded int
	lastErr   string
}

func newConntrackAccountant(source conntrackSource) *conntrackAccountant {
	return &conntrackAccountant{
		source:  source,
		live:    map[conntrackFlowKey]conntrackFlowBytes{},
		tombs:   map[conntrackFlowKey]uint64{},
		totals:  map[string]*trafficCounters{},
		watched: map[int]map[string]bool{},
	}
}

// start 先订阅 DESTROY 事件再做一次 dump 记下现有连接的字节数（不计入任何端口），之后看到的
// 增量才算。已经在跑就什么都不做。
func (a *conntrackAccountant) start() error {
	a.mu.Lock()
	if a.running {
		a.mu.Unlock()
		return nil
	}
	a.seeding = true
	a.mu.Unlock()
	stop, err := a.source.subscribe(a.onDestroy, a.onOverflow)
	if err != nil {
		a.mu.Lock()
		a.seeding = false
		a.lastErr = err.Error()
		a.mu.Unlock()
		return err
	}
	flows, err := a.source.dump()
	if err != nil {
		stop()
		a.mu.Lock()
		a.seeding = false
		a.lastErr = err.Error()
		a.mu.Unlock()
		return err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.live = make(map[conntrackFlowKey]conntrackFlowBytes, len(flows))
	for _, flow := range flows {
		if !flow.accountable() {
			continue
		}
		if _, dead := a.tombs[flow.key()]; dead {
			continue
		}
		a.live[flow.key()] = conntrackFlowBytes{in: flow.InBytes, out: flow.OutBytes}
	}
	a.stop = stop
	a.running = true
	a.seeding = false
	a.lastErr = ""
	return nil
}

// close 停掉事件订阅，清掉全部状态；下次 start 重新从基线起步。
func (a *conntrackAccountant) close() {
	a.mu.Lock()
	stop := a.stop
	a.stop = nil
	a.running = false
	a.seeding = false
	a.live = map[conntrackFlowKey]conntrackFlowBytes{}
	a.tombs = map[conntrackFlowKey]uint64{}
	a.totals = map[string]*trafficCounters{}
	a.watched = map[int]map[string]bool{}
	a.offloaded = 0
	a.mu.Unlock()
	if stop != nil {
		stop()
	}
}

func (a *conntrackAccountant) isRunning() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.running
}

func (a *conntrackAccountant) onOverflow() {
	a.mu.Lock()
	a.overflows++
	a.mu.Unlock()
}

func (a *conntrackAccountant) onDestroy(flow conntrackFlow) {
	if !flow.accountable() {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	key := flow.key()
	a.tombs[key] = a.gen
	last, known := a.live[key]
	delete(a.live, key)
	if !known {
		// 启动时 dump 还没做完：这是之前就有的连接，它的字节已经由别的计数报过了。
		if a.seeding || !a.running {
			return
		}
		// 上次采集之后才建立、已经结束的连接：整条都算。
		last = conntrackFlowBytes{}
	}
	a.addLocked(flow, last)
}

// addLocked 把 flow 相对 last 的增量加到它端口的累计值上（端口在观察列表里才加）。
func (a *conntrackAccountant) addLocked(flow conntrackFlow, last conntrackFlowBytes) {
	protocols := a.watched[int(flow.OrigDstPort)]
	if !protocols[flow.protocolName()] {
		return
	}
	total := a.totals[strconv.Itoa(int(flow.OrigDstPort))]
	if total == nil {
		return
	}
	// 同一个 id 被新连接复用时字节数会比上次小：当作新连接，整条算。
	if flow.InBytes >= last.in {
		total.In += flow.InBytes - last.in
	} else {
		total.In += flow.InBytes
	}
	if flow.OutBytes >= last.out {
		total.Out += flow.OutBytes - last.out
	} else {
		total.Out += flow.OutBytes
	}
}

// sample dump 一次 conntrack，把增量记进观察中的端口，返回这些端口当前的累计值。
// watched 是端口 → 协议；baseline 给第一次出现的端口提供起点（持久化的流量基线）。
func (a *conntrackAccountant) sample(watched map[int]map[string]bool, baseline func(port string) (uint64, uint64)) (map[string]trafficCounters, error) {
	if !a.isRunning() {
		return nil, errors.New("conntrack accounting is not running")
	}
	flows, err := a.source.dump()
	if err != nil {
		a.mu.Lock()
		a.lastErr = err.Error()
		a.mu.Unlock()
		return nil, err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.lastErr = ""
	a.setWatchedLocked(watched, baseline)
	next := make(map[conntrackFlowKey]conntrackFlowBytes, len(a.live))
	offloaded := 0
	for _, flow := range flows {
		if !flow.accountable() {
			continue
		}
		key := flow.key()
		if _, dead := a.tombs[key]; dead {
			// dump 里还带着已经收到 DESTROY 的连接（dump 和事件交错）：事件那边已经算完了。
			continue
		}
		if flow.Status&conntrackStatusOffload != 0 {
			offloaded++
		}
		last := a.live[key]
		a.addLocked(flow, last)
		next[key] = conntrackFlowBytes{in: flow.InBytes, out: flow.OutBytes}
	}
	a.live = next
	a.offloaded = offloaded
	a.gen++
	for key, gen := range a.tombs {
		if a.gen-gen > 2 {
			delete(a.tombs, key)
		}
	}
	out := make(map[string]trafficCounters, len(a.totals))
	for port, total := range a.totals {
		out[port] = *total
	}
	return out, nil
}

// setWatchedLocked 换观察列表：新端口从基线起步，不再观察的端口扔掉累计值。
func (a *conntrackAccountant) setWatchedLocked(watched map[int]map[string]bool, baseline func(port string) (uint64, uint64)) {
	copied := make(map[int]map[string]bool, len(watched))
	for port, protocols := range watched {
		if port <= 0 || len(protocols) == 0 {
			continue
		}
		set := map[string]bool{}
		for protocol, ok := range protocols {
			if ok {
				set[protocol] = true
			}
		}
		copied[port] = set
		key := strconv.Itoa(port)
		if a.totals[key] == nil {
			in, out := uint64(0), uint64(0)
			if baseline != nil {
				in, out = baseline(key)
			}
			a.totals[key] = &trafficCounters{In: in, Out: out}
		}
	}
	for key := range a.totals {
		port, _ := strconv.Atoi(key)
		if _, ok := copied[port]; !ok {
			delete(a.totals, key)
		}
	}
	a.watched = copied
}

type conntrackAccountingStatus struct {
	Running   bool   `json:"running"`
	Flows     int    `json:"flows"`
	Offloaded int    `json:"offloaded"`
	Overflows uint64 `json:"overflows,omitempty"`
	Ports     []int  `json:"ports,omitempty"`
	Error     string `json:"error,omitempty"`
}

func (a *conntrackAccountant) status() conntrackAccountingStatus {
	a.mu.Lock()
	defer a.mu.Unlock()
	ports := make([]int, 0, len(a.watched))
	for port := range a.watched {
		ports = append(ports, port)
	}
	sort.Ints(ports)
	return conntrackAccountingStatus{
		Running: a.running, Flows: len(a.live), Offloaded: a.offloaded,
		Overflows: a.overflows, Ports: ports, Error: a.lastErr,
	}
}
