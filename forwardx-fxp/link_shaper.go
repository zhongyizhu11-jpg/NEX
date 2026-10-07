package main

import (
	"log"
	"net"
	"strconv"
	"strings"
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

三档：
  - 自动（auto）：平时不整形，只看成员连接的 TCP_INFO。一旦出现「发送端有积压 +
    重传超过 0.3%」，就是撞上限速器了：立刻按这几秒观察到的送达速率开始整形，
    然后每秒看重传：有就降 3%，没有就保持；连续十秒干净就升 1%。降到不再丢包
    的那个速率就是限速点，记下来（本机文件 + 报给面板），重启后直接从它起步。
    如果降了一大截重传还在，那不是限速器而是随机丢包，放弃整形十分钟再看。
  - 手动（manual）：按填的上限整形，起步 96%，自动微调范围 [60%, 100%]。
  - 关（off）。

方向：主动拨出去的连接（入口→出口、中转→下一跳）是 up；接进来的连接
（出口→入口、中转→上一跳）是 down。一个进程就是一条隧道在这台机器上的一端，
所以注册表的键只有方向 + 隧道号。UDP 直连通道（udp_direct.go）不走这里。

整形本身：一个方向一个虚拟时钟令牌桶，所有 secureConn 写帧前先领额度；小帧
（≤ linkShaperSmallFrame，交互流量）在队列不深时直接放行，不排在大块后面，它们的
额度由后面的大块补上。每条 TCP 连接另设 SO_MAX_PACING_RATE，内核层面也不冲大串。
*/

type linkShapingMode int32

const (
	linkShapingOff linkShapingMode = iota
	linkShapingManual
	linkShapingAuto
)

func (m linkShapingMode) String() string {
	switch m {
	case linkShapingManual:
		return "manual"
	case linkShapingAuto:
		return "auto"
	default:
		return "off"
	}
}

const (
	// linkShaperHeadroom 是手动模式的起步速率相对配置值的比例：载荷之上还有 TCP/IP 头
	// （约 3.5%），限速器按线上字节数算。
	linkShaperHeadroom = 0.96
	// linkShaperResumeHeadroom 是自动模式按记住的限速点起步时的比例。
	linkShaperResumeHeadroom = 0.98
	// linkShaperFloor 是手动模式自动微调的下限（相对配置值）。
	linkShaperFloor = 0.60
	// linkShaperSmallFrame 以内的帧算交互流量，队列不深时优先放行。
	linkShaperSmallFrame = 4 * 1024
	// linkShaperBurst 是空闲之后允许一次性发出的额度（按时间算）。
	linkShaperBurst = 2 * time.Millisecond
	// linkShaperSmallOverdraft：队列（虚拟时钟领先实际时间的量）不超过这么多时，小帧不等。
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
	linkShaperCeilingTTL    = 15 * time.Minute
	linkShaperBytesPerMbps  = 125000
	// 自动模式：连续两秒「积压 + 重传」才认定撞上了限速器（一秒的抖动不算），
	// 起点是最近几秒观察到的最高送达速率再放宽一点（限速器的桶会放出一小段突发，
	// 起点偏高没关系，往下降就是了）。
	linkShaperAutoStartMargin = 1.05
	linkShaperAutoWindows     = 3
	linkShaperAutoTriggerRuns = 2
	// 起点也可能偏低（几条流互相打得只剩上限的三分之一时开始的）：还没碰到过
	// 丢包之前每个干净的秒升 10%，碰到丢包再换成每十秒 1% 的细调。升到起点的
	// 四倍还没丢，说明限速器没了，回到观察。
	linkShaperSearchStep       = 1.10
	linkShaperSearchGiveUpMult = 4.0
	// 自动模式：送达速率低于这个数（1 MB/s）的丢包不当回事。
	linkShaperAutoMinDelivered = 1 << 20
	// 自动模式的「不是限速器」判定：从起点降到这个比例以下、重传还在 → 随机丢包，放弃。
	linkShaperAutoGiveUpRatio = 0.50
	// 已经学到限速点之后，降到它的这个比例以下重传还在 → 链路变了或是随机丢包，重新来。
	linkShaperAutoRelearnRatio = 0.60
	linkShaperAutoPause        = 10 * time.Minute
	// 学到的值变化不到 2% 不重写文件。
	linkShaperLearnedDelta = 0.02
	// 自动模式的爬升没有配置上限：给个物理上限（100 Gbit/s）就行。
	linkShaperAutoLimit = int64(100000) * linkShaperBytesPerMbps
)

// linkWindow 是一秒钟的观察结果。
type linkWindow struct {
	elapsed time.Duration
	// sent 是这一秒整形器放出去的字节；delivered 是成员连接送达（被确认）的速率，字节/秒。
	sent      uint64
	delivered float64
	loss      float64
	segs      uint64
	// pathBusy：有成员连接堆着没发出去的数据（被拥塞窗口 / pacing / 对端卡住），
	// 说明需求超过了链路能送的量，这时的重传才是限速器的信号。
	pathBusy bool
}

type linkShaperMember struct {
	conn   *net.TCPConn
	last   tcpLinkStats
	primed bool
}

type linkShaper struct {
	key       string
	direction string
	tunnelID  int
	role      string

	mode atomic.Int32
	// max 是手动模式的配置上限（字节/秒）；rate 是当前整形速率（字节/秒），0 = 不整形。
	max  atomic.Int64
	rate atomic.Int64
	// learned 是自动模式学到的限速点（字节/秒），0 = 还没有。
	learned atomic.Int64

	mu   sync.Mutex
	next time.Time // 虚拟时钟：下一字节允许发出的时刻
	sent uint64    // 这一轮领走的字节，判忙用

	tuneMu       sync.Mutex
	members      map[*net.TCPConn]*linkShaperMember
	windows      []linkWindow
	ceiling      int64 // 上次观察到丢包时的速率，0 = 没有
	ceilingAt    time.Time
	cleanRuns    int
	lastTick     time.Time
	descentStart int64 // 自动模式这一轮整形的起点
	triggerRuns  int   // 自动模式：连续几秒看到「积压 + 重传」
	pausedUntil  time.Time
	lastLoss     float64
	state        string // off / watching / shaping / paused，报给面板

	// 报给面板用的凭据（有就报）。
	panelURL, token string
	// 学到的值的持久化节流。
	savedLearned int64
	savedAt      time.Time
	// changed 让上报协程尽快报一次。
	changed atomic.Bool
}

func newLinkShaper(key, direction string, tunnelID int) *linkShaper {
	return &linkShaper{key: key, direction: direction, tunnelID: tunnelID, members: map[*net.TCPConn]*linkShaperMember{}, state: "off"}
}

func (s *linkShaper) currentMode() linkShapingMode { return linkShapingMode(s.mode.Load()) }

// configure 应用一份配置：模式、手动上限、自动模式的提示值（面板记住的限速点）。
// 只有变了的部分才重置，所以每条新连接都调一次也没关系。
func (s *linkShaper) configure(mode linkShapingMode, mbps int, hintMbps int) {
	if s == nil {
		return
	}
	s.tuneMu.Lock()
	defer s.tuneMu.Unlock()
	previous := s.currentMode()
	switch mode {
	case linkShapingManual:
		max := int64(mbps) * linkShaperBytesPerMbps
		if mbps <= 0 {
			s.disableLocked("manual mode without a limit")
			return
		}
		if previous == linkShapingManual && s.max.Load() == max {
			return
		}
		s.mode.Store(int32(linkShapingManual))
		s.max.Store(max)
		s.rate.Store(int64(float64(max) * linkShaperHeadroom))
		s.ceiling, s.ceilingAt, s.cleanRuns = 0, time.Time{}, 0
		s.pausedUntil = time.Time{}
		s.state = "shaping"
		s.applyPacingLocked(max)
		log.Printf("fxp link shaper %s manual max=%dMbit/s start=%dMbit/s", s.key, mbps, s.rate.Load()/linkShaperBytesPerMbps)
		s.changed.Store(true)
	case linkShapingAuto:
		if previous == linkShapingAuto {
			return
		}
		s.mode.Store(int32(linkShapingAuto))
		s.max.Store(0)
		s.ceiling, s.ceilingAt, s.cleanRuns = 0, time.Time{}, 0
		s.pausedUntil = time.Time{}
		learned := s.learned.Load()
		if learned <= 0 {
			if stored := loadLinkShaperLearned(s.key); stored > 0 {
				learned = stored
			} else if hintMbps > 0 {
				learned = int64(hintMbps) * linkShaperBytesPerMbps
			}
		}
		if learned > 0 {
			s.learned.Store(learned)
			s.rate.Store(int64(float64(learned) * linkShaperResumeHeadroom))
			s.state = "shaping"
			s.applyPacingLocked(learned)
			log.Printf("fxp link shaper %s auto: resuming at %dMbit/s (learned %dMbit/s)", s.key, s.rate.Load()/linkShaperBytesPerMbps, learned/linkShaperBytesPerMbps)
		} else {
			s.rate.Store(0)
			s.state = "watching"
			s.applyPacingLocked(0)
			log.Printf("fxp link shaper %s auto: watching for a rate limiter", s.key)
		}
		s.changed.Store(true)
	default:
		if previous == linkShapingOff {
			return
		}
		s.disableLocked("off")
	}
}

func (s *linkShaper) disableLocked(reason string) {
	s.mode.Store(int32(linkShapingOff))
	s.max.Store(0)
	s.rate.Store(0)
	s.learned.Store(0)
	s.ceiling, s.ceilingAt, s.cleanRuns = 0, time.Time{}, 0
	s.descentStart = 0
	s.state = "off"
	s.applyPacingLocked(0)
	log.Printf("fxp link shaper %s disabled (%s)", s.key, reason)
	s.changed.Store(true)
}

// applyPacingLocked 给所有成员连接设内核发包上限；0 = 清掉（恢复不限）。
func (s *linkShaper) applyPacingLocked(bytesPerSec int64) {
	for _, member := range s.members {
		if bytesPerSec > 0 {
			setTCPMaxPacingRate(member.conn, bytesPerSec)
		} else {
			clearTCPMaxPacingRate(member.conn)
		}
	}
}

// pacingCap 是给内核的每连接发包上限：手动是配置值，自动是学到的值。
func (s *linkShaper) pacingCap() int64 {
	if max := s.max.Load(); max > 0 {
		return max
	}
	return s.learned.Load()
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

// attach 把一条 TCP 连接登记为成员：读它的 TCP_INFO，并给它设内核的发包速率上限。
func (s *linkShaper) attach(conn net.Conn) {
	if s == nil {
		return
	}
	tcp, ok := conn.(*net.TCPConn)
	if !ok || tcp == nil {
		return
	}
	if cap := s.pacingCap(); cap > 0 {
		setTCPMaxPacingRate(tcp, cap)
	}
	s.tuneMu.Lock()
	s.members[tcp] = &linkShaperMember{conn: tcp}
	s.tuneMu.Unlock()
}

// tick 每秒一次：汇总成员的 TCP_INFO，交给 stepLocked 决定升降。关掉的连接在这里顺手清掉。
func (s *linkShaper) tick(now time.Time) {
	s.mu.Lock()
	sent := s.sent
	s.sent = 0
	s.mu.Unlock()

	s.tuneMu.Lock()
	defer s.tuneMu.Unlock()
	elapsed := now.Sub(s.lastTick)
	s.lastTick = now
	var retransDelta, segsDelta, ackedDelta uint64
	pathBusy := false
	for tcp, member := range s.members {
		stats, ok := tcpConnLinkStats(tcp)
		if !ok {
			delete(s.members, tcp)
			continue
		}
		if member.primed {
			retransDelta += uint64(stats.retrans - member.last.retrans)
			segsDelta += uint64(stats.segsOut - member.last.segsOut)
			ackedDelta += stats.bytesAcked - member.last.bytesAcked
			if stats.notsentBytes > 0 || stats.sndbufLimited-member.last.sndbufLimited >= uint64(elapsed.Microseconds()/10) {
				pathBusy = true
			}
		}
		member.last, member.primed = stats, true
	}
	if s.currentMode() == linkShapingOff || elapsed <= 0 || elapsed > 5*linkShaperTuneInterval {
		return
	}
	window := linkWindow{elapsed: elapsed, sent: sent, segs: segsDelta, pathBusy: pathBusy}
	window.delivered = float64(ackedDelta) / elapsed.Seconds()
	if segsDelta > 0 {
		window.loss = float64(retransDelta) / float64(segsDelta)
	}
	s.lastLoss = window.loss
	s.stepLocked(now, window)
}

// stepLocked 是每秒的决策。调用方持有 tuneMu。
func (s *linkShaper) stepLocked(now time.Time, w linkWindow) {
	s.windows = append(s.windows, w)
	if len(s.windows) > linkShaperAutoWindows {
		s.windows = s.windows[len(s.windows)-linkShaperAutoWindows:]
	}
	mode := s.currentMode()
	rate := s.rate.Load()
	if mode == linkShapingOff {
		return
	}
	if rate <= 0 {
		if mode != linkShapingAuto || now.Before(s.pausedUntil) {
			return
		}
		if w.segs < linkShaperMinSegments || !w.pathBusy || w.loss <= linkShaperLossDown || w.delivered < linkShaperAutoMinDelivered {
			s.triggerRuns = 0
			return
		}
		s.triggerRuns++
		if s.triggerRuns < linkShaperAutoTriggerRuns {
			return
		}
		s.triggerRuns = 0
		// 撞上限速器了：按最近几秒的最高送达速率起步，往下找不丢包的点。
		peak := 0.0
		for _, item := range s.windows {
			if item.delivered > peak {
				peak = item.delivered
			}
		}
		start := int64(peak * linkShaperAutoStartMargin)
		s.descentStart = start
		s.rate.Store(start)
		s.ceiling, s.ceilingAt, s.cleanRuns = 0, time.Time{}, 0
		s.state = "shaping"
		s.applyPacingLocked(start)
		log.Printf("fxp link shaper %s auto: loss=%.2f%% with backlog at %dMbit/s delivered, shaping from %dMbit/s", s.key, w.loss*100, int64(w.delivered)/linkShaperBytesPerMbps, start/linkShaperBytesPerMbps)
		s.changed.Store(true)
		return
	}
	busy := w.segs >= linkShaperMinSegments && float64(w.sent) >= float64(rate)*w.elapsed.Seconds()*linkShaperBusyRatio
	if !busy {
		s.cleanRuns = 0
		return
	}
	if w.loss > linkShaperLossDown {
		next := int64(float64(rate) * linkShaperDownStep)
		if mode == linkShapingManual {
			if floor := int64(float64(s.max.Load()) * linkShaperFloor); next < floor {
				next = floor
			}
		} else {
			learned := s.learned.Load()
			giveUp := (learned > 0 && float64(next) < float64(learned)*linkShaperAutoRelearnRatio) ||
				(learned <= 0 && s.descentStart > 0 && float64(next) < float64(s.descentStart)*linkShaperAutoGiveUpRatio)
			if giveUp {
				s.pauseLocked(now, rate, w.loss)
				return
			}
		}
		s.ceiling, s.ceilingAt = rate, now
		s.cleanRuns = 0
		if next != rate {
			s.rate.Store(next)
			log.Printf("fxp link shaper %s loss=%.2f%% at %dMbit/s, rate down to %dMbit/s", s.key, w.loss*100, rate/linkShaperBytesPerMbps, next/linkShaperBytesPerMbps)
		}
		return
	}
	if w.loss > linkShaperLossClean {
		s.cleanRuns = 0
		return
	}
	if mode == linkShapingAuto && s.learned.Load() <= 0 && s.ceiling <= 0 {
		// 起点之后还没碰到过丢包：起点偏低了，快升。
		next := int64(float64(rate) * linkShaperSearchStep)
		if s.descentStart > 0 && float64(next) > float64(s.descentStart)*linkShaperSearchGiveUpMult {
			log.Printf("fxp link shaper %s auto: no loss up to %dMbit/s, the rate limiter is gone; watching again", s.key, rate/linkShaperBytesPerMbps)
			s.rate.Store(0)
			s.descentStart = 0
			s.state = "watching"
			s.applyPacingLocked(0)
			s.changed.Store(true)
			return
		}
		s.rate.Store(next)
		return
	}
	s.cleanRuns++
	if s.cleanRuns < linkShaperCleanRounds {
		return
	}
	s.cleanRuns = 0
	if mode == linkShapingAuto {
		s.rememberLocked(now, rate)
	}
	limit := linkShaperAutoLimit
	if mode == linkShapingManual {
		limit = s.max.Load()
	}
	if s.ceiling > 0 && now.Sub(s.ceilingAt) < linkShaperCeilingTTL {
		if capped := int64(float64(s.ceiling) * linkShaperCeilingMargin); capped < limit {
			limit = capped
		}
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

// rememberLocked：自动模式连续十秒干净的速率就是限速点，记下来（变化超过 2% 才写）。
func (s *linkShaper) rememberLocked(now time.Time, rate int64) {
	learned := s.learned.Load()
	if learned > 0 && abs64(rate-learned) < int64(float64(learned)*linkShaperLearnedDelta) {
		return
	}
	s.learned.Store(rate)
	s.descentStart = 0
	s.applyPacingLocked(rate)
	if learned <= 0 {
		log.Printf("fxp link shaper %s auto: learned rate limit %dMbit/s", s.key, rate/linkShaperBytesPerMbps)
	} else {
		log.Printf("fxp link shaper %s auto: rate limit now %dMbit/s (was %dMbit/s)", s.key, rate/linkShaperBytesPerMbps, learned/linkShaperBytesPerMbps)
	}
	s.changed.Store(true)
	if abs64(rate-s.savedLearned) >= int64(float64(rate)*linkShaperLearnedDelta) && now.Sub(s.savedAt) >= time.Minute {
		if saveLinkShaperLearned(s.key, rate) {
			s.savedLearned, s.savedAt = rate, now
		}
	}
}

// pauseLocked：降了一大截重传还在，不是限速器。放弃整形一段时间，之后从头观察。
func (s *linkShaper) pauseLocked(now time.Time, rate int64, loss float64) {
	log.Printf("fxp link shaper %s auto: loss=%.2f%% persists down to %dMbit/s, not a rate limiter; pausing for %s", s.key, loss*100, rate/linkShaperBytesPerMbps, linkShaperAutoPause)
	s.rate.Store(0)
	s.learned.Store(0)
	s.descentStart = 0
	s.ceiling, s.ceilingAt, s.cleanRuns = 0, time.Time{}, 0
	s.pausedUntil = now.Add(linkShaperAutoPause)
	s.state = "paused"
	s.windows = s.windows[:0]
	s.applyPacingLocked(0)
	s.changed.Store(true)
}

func abs64(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}

func (s *linkShaper) run() {
	ticker := time.NewTicker(linkShaperTuneInterval)
	defer ticker.Stop()
	for now := range ticker.C {
		s.tick(now)
	}
}

// currentMbps 是当前整形速率（Mbit/s），0 = 不整形。
func (s *linkShaper) currentMbps() int {
	if s == nil {
		return 0
	}
	return int(s.rate.Load() / linkShaperBytesPerMbps)
}

// linkShaperStatus 是报给面板的一份状态。
type linkShaperStatus struct {
	Direction   string  `json:"direction"`
	Mode        string  `json:"mode"`
	State       string  `json:"state"`
	RateMbps    int     `json:"rateMbps"`
	LearnedMbps int     `json:"learnedMbps"`
	LossPct     float64 `json:"lossPct"`
}

func (s *linkShaper) snapshot() linkShaperStatus {
	s.tuneMu.Lock()
	defer s.tuneMu.Unlock()
	state := s.state
	if s.currentMode() == linkShapingAuto && s.rate.Load() <= 0 && state != "paused" {
		state = "watching"
		if time.Now().Before(s.pausedUntil) {
			state = "paused"
		}
	}
	return linkShaperStatus{
		Direction:   s.direction,
		Mode:        s.currentMode().String(),
		State:       state,
		RateMbps:    s.currentMbps(),
		LearnedMbps: int(s.learned.Load() / linkShaperBytesPerMbps),
		LossPct:     float64(int(s.lastLoss*10000)) / 100,
	}
}

var linkShapers = struct {
	mu    sync.Mutex
	byKey map[string]*linkShaper
}{byKey: map[string]*linkShaper{}}

// linkShapingSettings 从配置里取一个方向的档位：模式、手动上限、自动模式的提示值。
// 没写模式（旧面板）时：填了上限就是手动，否则关。
func linkShapingSettings(direction string, cfg config) (mode linkShapingMode, mbps int, hintMbps int) {
	mbps = cfg.LinkUpMbps
	hintMbps = cfg.LinkUpHintMbps
	if direction == "down" {
		mbps = cfg.LinkDownMbps
		hintMbps = cfg.LinkDownHintMbps
	}
	switch strings.ToLower(strings.TrimSpace(cfg.LinkShaping)) {
	case "auto":
		return linkShapingAuto, 0, hintMbps
	case "manual":
		if mbps > 0 {
			return linkShapingManual, mbps, 0
		}
		return linkShapingOff, 0, 0
	case "off":
		return linkShapingOff, 0, 0
	default:
		if mbps > 0 {
			return linkShapingManual, mbps, 0
		}
		return linkShapingOff, 0, 0
	}
}

// linkShaperFor 按方向（up：往出口方向；down：往入口方向）和隧道号取整形器，
// 并把这份配置应用上去。关着也返回同一个整形器（速率 0，写帧不等）：连接拿着
// 稳定的句柄，之后热更新打开，已有的长连接立刻跟着受限，不用等重连。
// 隧道号为 0（测试直接拼的配置）不整形。
func linkShaperFor(direction string, cfg config) *linkShaper {
	if cfg.TunnelID <= 0 {
		return nil
	}
	mode, mbps, hint := linkShapingSettings(direction, cfg)
	key := direction + ":" + strconv.Itoa(cfg.TunnelID)
	linkShapers.mu.Lock()
	s := linkShapers.byKey[key]
	if s == nil {
		s = newLinkShaper(key, direction, cfg.TunnelID)
		linkShapers.byKey[key] = s
		go s.run()
	}
	if role := strings.ToLower(strings.TrimSpace(cfg.Role)); role != "" && role != "entry-group" {
		s.role = role
	}
	if url, token := strings.TrimSpace(cfg.PanelURL), strings.TrimSpace(cfg.Token); url != "" && token != "" {
		s.panelURL, s.token = url, token
		startLinkShaperReporter()
	}
	linkShapers.mu.Unlock()
	s.configure(mode, mbps, hint)
	return s
}

// linkShapersApply 在配置生效（启动、热更新）时把两个方向的档位应用上去，这样
// 改了档位不用等新连接，已有连接也立刻按新速率走；关掉也立刻停。
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

func linkShapersSnapshot() []*linkShaper {
	linkShapers.mu.Lock()
	defer linkShapers.mu.Unlock()
	out := make([]*linkShaper, 0, len(linkShapers.byKey))
	for _, s := range linkShapers.byKey {
		out = append(out, s)
	}
	return out
}
