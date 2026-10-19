package main

import (
	"sync"
	"sync/atomic"
	"time"
)

/*
单连接叠加里一路断了，把它补回来。

以前一条叠加连接里某一路断了（中转重启、线路抖一下），剩下几路照样跑，可断的那一路再也不回来：
这条连接接下来一直少一截带宽，直到它结束。看视频、下大文件这种长连接，一抖就慢到底。

现在入口给每个会话配一个重拨器：
  - 一路断了（或者开局就没拨通、在冷却里没去拨），等 1 秒再去拨，用一个新的线上编号报到
    （出口按编号记每一路收了多少字节，旧编号会被拒）。出口一直接受中途加入的路，老出口也一样。
  - 拨之前先问进程里那份腿健康记录（multipath_health.go）：这台中转最近坏过、还在冷却，就先不拨，
    每秒看一次。冷却到期时只放一个会话去试，试通了大家一起补上 —— 中转挂着的时候，不会每个会话
    都去撞它。
  - 会话结束、对端已经把流发完，就不补了。一个会话最多 16 路（死掉的也占位），补满为止。

序号和确认都是按会话算的，不是按路：新补上来的一路只是多一个能领分片的通道，重复到达的分片
按序号丢掉，所以补拨不会弄乱数据。
*/

const (
	multipathRedialDelay = time.Second
	multipathRedialPoll  = time.Second
)

// multipathRedialsTotal / multipathRedialedTotal：整个进程里排了几次补拨、补上了几路（测试和统计用）。
var (
	multipathRedialsTotal  atomic.Int64
	multipathRedialedTotal atomic.Int64
)

type multipathRedialer struct {
	cfg       config
	hello     helloFrame
	sessionID string
	session   *multipathSession

	// nextIndex 是下一条补上来的路用的线上编号，从配置的路数往上数。
	nextIndex atomic.Int64

	mu      sync.Mutex
	pending map[int]bool
	// redials / redialed 给测试和日志：排了几次、补上几路。
	redials  atomic.Int64
	redialed atomic.Int64
}

// multipathMissingLegs 是配置里有、但这一次开局没去拨的那几路（冷却里被跳过的）。
func multipathMissingLegs(cfg config, candidates []int) []int {
	dialed := make(map[int]bool, len(candidates))
	for _, index := range candidates {
		dialed[index] = true
	}
	missing := make([]int, 0, len(cfg.MultipathLegs))
	for index := range cfg.MultipathLegs {
		if !dialed[index] {
			missing = append(missing, index)
		}
	}
	return missing
}

func startMultipathRedialer(cfg config, hello helloFrame, sessionID string, session *multipathSession) *multipathRedialer {
	redialer := &multipathRedialer{cfg: cfg, hello: hello, sessionID: sessionID, session: session, pending: map[int]bool{}}
	redialer.nextIndex.Store(int64(len(cfg.MultipathLegs)))
	session.redialer.Store(redialer)
	return redialer
}

// schedule 安排把配置里第 cfgIndex 路补回来。同一路已经在补就不重复排。
func (r *multipathRedialer) schedule(cfgIndex int) {
	if r == nil || cfgIndex < 0 || cfgIndex >= len(r.cfg.MultipathLegs) {
		return
	}
	r.mu.Lock()
	if r.pending[cfgIndex] {
		r.mu.Unlock()
		return
	}
	r.pending[cfgIndex] = true
	r.mu.Unlock()
	r.redials.Add(1)
	multipathRedialsTotal.Add(1)
	go r.run(cfgIndex)
}

func (r *multipathRedialer) done(cfgIndex int) {
	r.mu.Lock()
	delete(r.pending, cfgIndex)
	r.mu.Unlock()
}

// over 是这个会话不需要再补了：已经结束，或者对端把流发完了。
func (r *multipathRedialer) over() bool {
	select {
	case <-r.session.closed:
		return true
	default:
	}
	return r.session.reorder.finished()
}

func (r *multipathRedialer) wait(d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-r.session.closed:
		return false
	case <-timer.C:
		return !r.over()
	}
}

func (r *multipathRedialer) run(cfgIndex int) {
	defer r.done(cfgIndex)
	key := multipathLegHealthKey(r.cfg.MultipathLegs[cfgIndex])
	if !r.wait(multipathRedialDelay) {
		return
	}
	for {
		if r.session.legCount() >= multipathMaxLegs {
			return
		}
		// 还在冷却里（别的会话刚撞过它、或者正有一个会话在试）：先不拨，过一秒再问。
		if !multipathLegHealthMemory.allow(key) {
			if !r.wait(multipathRedialPoll) {
				return
			}
			continue
		}
		wireIndex := int(r.nextIndex.Add(1) - 1)
		if wireIndex > multipathMaxLegIndex {
			return
		}
		result := dialMultipathLeg(r.cfg, r.hello, r.sessionID, cfgIndex, wireIndex)
		if result.err != nil {
			multipathLegHealthMemory.failed(key)
			fxpVerbosef("multipath leg redial failed session=%s: %v", r.sessionID, result.err)
			if !r.wait(multipathRedialPoll) {
				return
			}
			continue
		}
		multipathLegHealthMemory.dialed(key)
		if r.over() || !r.session.addLeg(result.leg) {
			closeMultipathLegs([]*multipathLegConn{result.leg})
			return
		}
		r.redialed.Add(1)
		multipathRedialedTotal.Add(1)
		fxpVerbosef("multipath leg %d (%s) redialed as %d, %d live", cfgIndex, result.leg.label, wireIndex, r.session.aliveLegCount())
		return
	}
}
