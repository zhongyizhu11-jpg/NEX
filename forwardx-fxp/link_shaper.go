package main

import (
	"log"
	"net"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

/*
链路整形：把本进程往对端发的所有隧道帧合起来压在链路带宽上限之下。

为什么要在发送端整形：云联网、公网带宽上限这类限速器是令牌桶，超额的包直接丢，
不排队。一条 BBR 流会一直探到上限之上，用 4% 左右的重传换来接近上限的速率；
几条流一起探，各自都被丢、各自回退，合计反而只有上限的六成，而且逐秒抖
（广州↔香港 CCN 上的 iperf3：单流 1.56G 平稳，8 流合计 0.93G、逐秒在 0.1G 到
2G 之间跳）。隧道里每条用户连接就是一条 TCP 流，Speedtest、浏览器下载又都是
多连接，所以用户看到的就是「跑不满、不稳定」。

发送端整形之后：发出去的总量永远略低于上限 → 限速器不丢包 → 没有重传、没有
回退，多少条连接合计都贴着上限跑，而且稳；排队发生在本进程里（等额度的协程），
TCP 的在途量保持在 BDP 附近，加载时的延迟也不会涨。

三件事：
  1. 整形：一个方向一个虚拟时钟令牌桶，所有 secureConn 写帧前先领额度。
     小帧（≤ linkShaperSmallFrame，交互流量）在队列不深时直接放行，不排在大块后面；
     它们的额度由后面的大块补上，长期平均仍不超过速率。
  2. 自动微调：每秒读所有成员 TCP 连接的 TCP_INFO，用重传率判断有没有碰到限速器：
     忙且有重传就降 3% 并记住这个「丢包点」，连续十秒忙且干净就升 1%，但停在丢包点
     之下 1.5%（丢包点十分钟后作废，允许再探）。速率在 [60%, 100%] 配置值之间。
     所以配置值不用填得很准：iperf3 测的、购买的带宽都行。
  3. 每条 TCP 连接设 SO_MAX_PACING_RATE = 配置值：内核按这个速率发包，单条连接
     也不会一下子冲出一大串。

方向：主动拨出去的连接（入口→出口、中转→下一跳）用 linkUpMbps；接进来的连接
（出口→入口、中转→上一跳）用 linkDownMbps。一个进程就是一条隧道在这台机器上的
一端，所以注册表的键只有方向 + 隧道号。UDP 直连通道（udp_direct.go）不走这里。
*/

const (
	// linkShaperHeadroom 是起步速率相对配置值的比例：载荷之上还有 TCP/IP 头
	// （约 3.5%），限速器按线上字节数算。
	linkShaperHeadroom = 0.96
	// linkShaperFloor 是自动微调的下限（相对配置值）。
	linkShaperFloor = 0.60
	// linkShaperSmallFrame 以内的帧算交互流量，队列不深时优先放行。
	linkShaperSmallFrame = 4 * 1024
	// linkShaperBurst 是空闲之后允许一次性发出的额度（按时间算）。
	linkShaperBurst = 2 * time.Millisecond
	// linkShaperSmallOverdraft：队列（虚拟时钟领先实际时间的量）不超过这么多时，
	// 小帧不等。
	linkShaperSmallOverdraft = 50 * time.Millisecond
	linkShaperTuneInterval   = time.Second
	// 这一秒发出的量达到速率的 85% 才算「忙」：整形真的在起作用，重传率才说明问题。
	linkShaperBusyRatio = 0.85
	// 样本太少（一秒不到 1000 段，约 1.4 MB）不下结论。
	linkShaperMinSegments = 1000
	linkShaperLossDown    = 0.003  // 重传率超过 0.3% 就降
	linkShaperLossClean   = 0.0005 // 低于 0.05% 算干净
	linkShaperDownStep    = 0.97
	linkShaperUpStep      = 1.01
	linkShaperCleanRounds = 10
	// 升到丢包点之下这个比例就停，免得每隔几十秒就撞一次限速器。
	linkShaperCeilingMargin = 0.985
	linkShaperCeilingTTL    = 10 * time.Minute
	linkShaperBytesPerMbps  = 125000
)

type linkShaperMember struct {
	conn    *net.TCPConn
	retrans uint32
	segsOut uint32
	primed  bool
}

type linkShaper struct {
	key string
	// max 是配置上限（字节/秒），0 = 关；rate 是当前整形速率（字节/秒）。
	max  atomic.Int64
	rate atomic.Int64

	mu   sync.Mutex
	next time.Time // 虚拟时钟：下一字节允许发出的时刻
	sent uint64    // 这一轮领走的字节，判忙用

	tuneMu    sync.Mutex
	members   map[*net.TCPConn]*linkShaperMember
	ceiling   int64 // 上次观察到丢包时的速率，0 = 没有
	ceilingAt time.Time
	cleanRuns int
	lastTick  time.Time
}

func newLinkShaper(key string) *linkShaper {
	return &linkShaper{key: key, members: map[*net.TCPConn]*linkShaperMember{}}
}

// configure 设置配置上限（Mbit/s）。值变了才重置：起步速率 = 上限 × 0.96，
// 丢包点清零。
func (s *linkShaper) configure(mbps int) {
	if s == nil {
		return
	}
	var max int64
	if mbps > 0 {
		max = int64(mbps) * linkShaperBytesPerMbps
	}
	if s.max.Load() == max {
		return
	}
	s.max.Store(max)
	s.tuneMu.Lock()
	s.ceiling, s.ceilingAt, s.cleanRuns = 0, time.Time{}, 0
	if max > 0 {
		s.rate.Store(int64(float64(max) * linkShaperHeadroom))
		for _, member := range s.members {
			setTCPMaxPacingRate(member.conn, max)
		}
	} else {
		s.rate.Store(0)
	}
	s.tuneMu.Unlock()
	if max > 0 {
		log.Printf("fxp link shaper %s enabled max=%dMbit/s start=%dMbit/s", s.key, mbps, s.rate.Load()/linkShaperBytesPerMbps)
	} else {
		log.Printf("fxp link shaper %s disabled", s.key)
	}
}

// wait 为 n 字节领额度，必要时阻塞到允许发出的时刻。关着时立刻返回。
func (s *linkShaper) wait(n int) {
	if s == nil || n <= 0 {
		return
	}
	rate := s.rate.Load()
	if rate <= 0 {
		return
	}
	s.mu.Lock()
	now := time.Now()
	if credit := now.Add(-linkShaperBurst); s.next.Before(credit) {
		s.next = credit
	}
	at := s.next
	s.next = s.next.Add(time.Duration(float64(n) * float64(time.Second) / float64(rate)))
	s.sent += uint64(n)
	s.mu.Unlock()
	delay := at.Sub(now)
	if delay <= 0 {
		return
	}
	if n <= linkShaperSmallFrame && delay <= linkShaperSmallOverdraft {
		return
	}
	time.Sleep(delay)
}

// attach 把一条 TCP 连接登记为成员：读它的重传计数，并给它设内核的发包速率上限。
func (s *linkShaper) attach(conn net.Conn) {
	if s == nil {
		return
	}
	tcp, ok := conn.(*net.TCPConn)
	if !ok || tcp == nil {
		return
	}
	if max := s.max.Load(); max > 0 {
		setTCPMaxPacingRate(tcp, max)
	}
	s.tuneMu.Lock()
	s.members[tcp] = &linkShaperMember{conn: tcp}
	s.tuneMu.Unlock()
}

// tick 每秒一次：汇总成员的重传，决定升降。关掉的连接在这里顺手清掉。
func (s *linkShaper) tick(now time.Time) {
	s.mu.Lock()
	sent := s.sent
	s.sent = 0
	s.mu.Unlock()

	s.tuneMu.Lock()
	defer s.tuneMu.Unlock()
	elapsed := now.Sub(s.lastTick)
	s.lastTick = now
	var retransDelta, segsDelta uint64
	for tcp, member := range s.members {
		retrans, segsOut, ok := tcpConnRetransStats(tcp)
		if !ok {
			delete(s.members, tcp)
			continue
		}
		if member.primed {
			retransDelta += uint64(retrans - member.retrans)
			segsDelta += uint64(segsOut - member.segsOut)
		}
		member.retrans, member.segsOut, member.primed = retrans, segsOut, true
	}
	rate := s.rate.Load()
	if s.max.Load() <= 0 || rate <= 0 || elapsed <= 0 || elapsed > 5*linkShaperTuneInterval {
		return
	}
	busy := segsDelta >= linkShaperMinSegments && float64(sent) >= float64(rate)*elapsed.Seconds()*linkShaperBusyRatio
	loss := 0.0
	if segsDelta > 0 {
		loss = float64(retransDelta) / float64(segsDelta)
	}
	s.tuneLocked(now, busy, loss)
}

// tuneLocked 是微调本身：忙且有重传就降并记住丢包点，连续干净就升到丢包点之下。
// 调用方持有 tuneMu。
func (s *linkShaper) tuneLocked(now time.Time, busy bool, loss float64) {
	max, rate := s.max.Load(), s.rate.Load()
	if max <= 0 || rate <= 0 {
		return
	}
	if !busy {
		s.cleanRuns = 0
		return
	}
	floor := int64(float64(max) * linkShaperFloor)
	if loss > linkShaperLossDown {
		s.ceiling, s.ceilingAt = rate, now
		s.cleanRuns = 0
		next := int64(float64(rate) * linkShaperDownStep)
		if next < floor {
			next = floor
		}
		if next != rate {
			s.rate.Store(next)
			log.Printf("fxp link shaper %s loss=%.2f%% at %dMbit/s, rate down to %dMbit/s", s.key, loss*100, rate/linkShaperBytesPerMbps, next/linkShaperBytesPerMbps)
		}
		return
	}
	if loss > linkShaperLossClean {
		s.cleanRuns = 0
		return
	}
	s.cleanRuns++
	if s.cleanRuns < linkShaperCleanRounds {
		return
	}
	s.cleanRuns = 0
	limit := max
	if s.ceiling > 0 && now.Sub(s.ceilingAt) < linkShaperCeilingTTL {
		limit = int64(float64(s.ceiling) * linkShaperCeilingMargin)
	}
	next := int64(float64(rate) * linkShaperUpStep)
	if next > limit {
		next = limit
	}
	if next > rate {
		s.rate.Store(next)
		log.Printf("fxp link shaper %s clean at %dMbit/s, rate up to %dMbit/s (limit %dMbit/s)", s.key, rate/linkShaperBytesPerMbps, next/linkShaperBytesPerMbps, limit/linkShaperBytesPerMbps)
	}
}

func (s *linkShaper) run() {
	ticker := time.NewTicker(linkShaperTuneInterval)
	defer ticker.Stop()
	for now := range ticker.C {
		s.tick(now)
	}
}

// currentMbps 是当前整形速率（Mbit/s），0 = 关。日志和状态用。
func (s *linkShaper) currentMbps() int {
	if s == nil {
		return 0
	}
	return int(s.rate.Load() / linkShaperBytesPerMbps)
}

var linkShapers = struct {
	mu    sync.Mutex
	byKey map[string]*linkShaper
}{byKey: map[string]*linkShaper{}}

// linkShaperFor 按方向（up：往出口方向；down：往入口方向）和隧道号取整形器，
// 并把这份配置里的上限应用上去。隧道号为 0（测试直接拼的配置）不整形。
func linkShaperFor(direction string, cfg config) *linkShaper {
	if cfg.TunnelID <= 0 {
		return nil
	}
	mbps := cfg.LinkUpMbps
	if direction == "down" {
		mbps = cfg.LinkDownMbps
	}
	key := direction + ":" + strconv.Itoa(cfg.TunnelID)
	linkShapers.mu.Lock()
	s := linkShapers.byKey[key]
	if s == nil {
		if mbps <= 0 {
			linkShapers.mu.Unlock()
			return nil
		}
		s = newLinkShaper(key)
		linkShapers.byKey[key] = s
		go s.run()
	}
	linkShapers.mu.Unlock()
	s.configure(mbps)
	return s
}

// linkShapersApply 在配置生效（启动、热更新）时把两个方向的上限应用上去，这样
// 改了上限不用等新连接，已有连接也立刻按新速率走；关掉也立刻停。
func linkShapersApply(cfg config) {
	configs := append([]config{cfg}, cfg.Entries...)
	for _, item := range configs {
		if item.TunnelID <= 0 {
			continue
		}
		linkShaperFor("up", item)
		linkShaperFor("down", item)
	}
}
