package main

import (
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"
)

func testShaper(t *testing.T, key string) *linkShaper {
	t.Helper()
	linkShaperStateDir = t.TempDir()
	return newLinkShaper(key, strings.SplitN(key, ":", 2)[0], 77)
}

// busyWindow 是「整形在起作用」的一秒：发出量贴着速率、样本够、有积压。
func busyWindow(s *linkShaper, loss float64) linkWindow {
	rate := s.rate.Load()
	return linkWindow{elapsed: time.Second, sent: uint64(rate), delivered: float64(rate), loss: loss, segs: 5000, pathBusy: true}
}

// 四个协程一起写，合计速率要贴着整形速率：400 Mbit/s 起步 96% = 48 MB/s，
// 20 MiB 约 0.44 秒。太快说明没整形，太慢说明定时器精度拖了后腿。
func TestLinkShaperHoldsAggregateRate(t *testing.T) {
	s := testShaper(t, "up:rate")
	s.configure(linkShapingManual, 400, 0)
	const chunk = 64 * 1024
	var wg sync.WaitGroup
	start := time.Now()
	for g := 0; g < 4; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 80; i++ {
				s.wait(chunk)
			}
		}()
	}
	wg.Wait()
	elapsed := time.Since(start)
	if elapsed < 380*time.Millisecond || elapsed > 900*time.Millisecond {
		t.Fatalf("20 MiB at 48 MB/s took %s, want about 0.44s", elapsed)
	}
	s.configure(linkShapingOff, 0, 0)
	start = time.Now()
	for i := 0; i < 320; i++ {
		s.wait(chunk)
	}
	if elapsed := time.Since(start); elapsed > 50*time.Millisecond {
		t.Fatalf("disabled shaper still waited %s", elapsed)
	}
}

// 小帧在队列不深（虚拟时钟领先不到 50ms）时直接放行；队列深了也得排。
func TestLinkShaperSmallFramesSkipShallowQueue(t *testing.T) {
	s := testShaper(t, "up:small")
	s.configure(linkShapingManual, 800, 0) // 96 MB/s：64 KiB 约 0.68ms
	claim := func(chunks int) *sync.WaitGroup {
		var wg sync.WaitGroup
		for i := 0; i < chunks; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				s.wait(64 * 1024)
			}()
		}
		return &wg
	}
	shallow := claim(40) // 约 27ms 的队列
	time.Sleep(2 * time.Millisecond)
	start := time.Now()
	s.wait(512)
	if elapsed := time.Since(start); elapsed > 20*time.Millisecond {
		t.Fatalf("small frame waited %s behind a shallow queue", elapsed)
	}
	shallow.Wait()

	deep := claim(120) // 约 82ms 的队列
	time.Sleep(2 * time.Millisecond)
	start = time.Now()
	s.wait(512)
	if elapsed := time.Since(start); elapsed < 20*time.Millisecond {
		t.Fatalf("small frame skipped a deep queue after only %s", elapsed)
	}
	deep.Wait()
}

func TestLinkShaperManualTuneStepsDownOnLossAndClimbsBelowCeiling(t *testing.T) {
	s := testShaper(t, "up:manual")
	s.configure(linkShapingManual, 1000, 0)
	mbps := func() int { return int(s.rate.Load() / linkShaperBytesPerMbps) }
	if got := mbps(); got != 960 {
		t.Fatalf("start rate = %d, want 960", got)
	}
	now := time.Now()
	// 不忙：有重传也不动（整形没在起作用，重传不是它的锅）。
	idle := busyWindow(s, 0.05)
	idle.sent = 0
	s.stepLocked(now, idle)
	if got := mbps(); got != 960 {
		t.Fatalf("idle tick changed rate to %d", got)
	}
	// 忙且丢包：降 3%，记住丢包点 960。
	s.stepLocked(now, busyWindow(s, 0.01))
	if got := mbps(); got != 931 {
		t.Fatalf("after loss rate = %d, want 931", got)
	}
	if s.ceiling != int64(960*linkShaperBytesPerMbps) {
		t.Fatalf("ceiling = %d, want 960Mbit/s", s.ceiling/linkShaperBytesPerMbps)
	}
	// 连续十秒干净且忙：升 1%，但停在丢包点之下 1.5%（945.6）。
	for i := 0; i < linkShaperCleanRounds; i++ {
		s.stepLocked(now.Add(time.Duration(i)*time.Second), busyWindow(s, 0))
	}
	if got := mbps(); got != 940 {
		t.Fatalf("after clean rounds rate = %d, want 940", got)
	}
	for round := 0; round < 3; round++ {
		for i := 0; i < linkShaperCleanRounds; i++ {
			s.stepLocked(now, busyWindow(s, 0))
		}
	}
	if got := mbps(); got != 945 {
		t.Fatalf("rate should stop under the loss ceiling, got %d", got)
	}
	// 丢包点过期后可以探到配置上限。
	s.ceilingAt = now.Add(-linkShaperCeilingTTL - time.Second)
	for round := 0; round < 12; round++ {
		for i := 0; i < linkShaperCleanRounds; i++ {
			s.stepLocked(now, busyWindow(s, 0))
		}
	}
	if s.rate.Load() != s.max.Load() {
		t.Fatalf("rate = %d, want the configured max %d", s.rate.Load(), s.max.Load())
	}
	// 一直丢包也不低于 60%。
	for i := 0; i < 100; i++ {
		s.stepLocked(now, busyWindow(s, 0.02))
	}
	if got := mbps(); got != 600 {
		t.Fatalf("floor = %d, want 600", got)
	}
	// 中间一点点重传（0.1%）既不降也不算干净。
	before := s.rate.Load()
	for i := 0; i < 30; i++ {
		s.stepLocked(now, busyWindow(s, 0.001))
	}
	if s.rate.Load() != before {
		t.Fatalf("marginal loss moved the rate from %d to %d", before, s.rate.Load())
	}
}

// 自动模式：平时不整形；撞上限速器（积压 + 重传）就按看到的送达速率起步往下找，
// 找到不丢包的点记下来，之后可以慢慢往上探；降了一大截还丢就放弃。
func TestLinkShaperAutoLearnsTheRateLimiter(t *testing.T) {
	s := testShaper(t, "down:auto")
	s.configure(linkShapingAuto, 0, 0)
	if s.rate.Load() != 0 || s.snapshot().State != "watching" {
		t.Fatalf("auto mode must start by watching, got rate=%d state=%s", s.rate.Load(), s.snapshot().State)
	}
	now := time.Now()
	mb := func(mbps int) float64 { return float64(mbps) * linkShaperBytesPerMbps }
	// 没有积压的丢包（应用自己发得慢）：不动。
	s.stepLocked(now, linkWindow{elapsed: time.Second, delivered: mb(900), loss: 0.02, segs: 5000, pathBusy: false})
	if s.rate.Load() != 0 {
		t.Fatal("loss without backlog must not start shaping")
	}
	// 8 流撞限速器的样子：逐秒抖，最高 2078，有积压，重传 8%。
	for _, delivered := range []int{491, 2078, 1727} {
		s.stepLocked(now, linkWindow{elapsed: time.Second, delivered: mb(delivered), loss: 0.08, segs: 50000, pathBusy: true})
	}
	start := s.rate.Load()
	if want := int64(mb(2078) * linkShaperAutoStartMargin); start != want {
		t.Fatalf("shaping should start at the recent peak × 1.05 = %dMbit/s, got %dMbit/s", want/linkShaperBytesPerMbps, start/linkShaperBytesPerMbps)
	}
	if s.snapshot().State != "shaping" {
		t.Fatalf("state = %s, want shaping", s.snapshot().State)
	}
	// 还在限速点之上：每秒降 3%，直到 1500 以下不再丢。
	steps := 0
	for s.rate.Load() > int64(mb(1500)) {
		s.stepLocked(now, busyWindow(s, 0.03))
		steps++
		if steps > 40 {
			t.Fatal("descent did not reach the limiter")
		}
	}
	if steps < 8 || steps > 14 {
		t.Fatalf("took %d steps to descend from %d to under 1500Mbit/s", steps, start/linkShaperBytesPerMbps)
	}
	// 干净十秒：学到限速点，写文件。
	for i := 0; i < linkShaperCleanRounds; i++ {
		s.stepLocked(now.Add(time.Duration(i)*time.Second), busyWindow(s, 0))
	}
	learned := s.learned.Load()
	if learned <= 0 || learned > int64(mb(1500)) || learned < int64(mb(1300)) {
		t.Fatalf("learned = %dMbit/s, want just under 1500", learned/linkShaperBytesPerMbps)
	}
	// 文件里按整数 Mbit/s 记。
	if stored := loadLinkShaperLearned(s.key); stored/linkShaperBytesPerMbps != learned/linkShaperBytesPerMbps {
		t.Fatalf("learned value was not persisted: file=%d learned=%d", stored, learned)
	}
	status := s.snapshot()
	if status.Mode != "auto" || status.State != "shaping" || status.LearnedMbps != int(learned/linkShaperBytesPerMbps) {
		t.Fatalf("snapshot = %+v", status)
	}
	// 之后可以往上探（丢包点过期后），上限不是学到的值。
	s.ceilingAt = now.Add(-linkShaperCeilingTTL - time.Second)
	before := s.rate.Load()
	for i := 0; i < linkShaperCleanRounds; i++ {
		s.stepLocked(now, busyWindow(s, 0))
	}
	if s.rate.Load() <= before {
		t.Fatal("auto mode must keep probing upward after the ceiling expires")
	}
	// 链路彻底变了：降到学到值的 60% 以下还在丢 → 放弃十分钟，回到观察。
	for i := 0; i < 60 && s.rate.Load() > 0; i++ {
		s.stepLocked(now, busyWindow(s, 0.05))
	}
	if s.rate.Load() != 0 || s.learned.Load() != 0 || s.snapshot().State != "paused" {
		t.Fatalf("persistent loss must pause shaping: rate=%d learned=%d state=%s", s.rate.Load(), s.learned.Load(), s.snapshot().State)
	}
	for i := 0; i < 3; i++ {
		s.stepLocked(now, linkWindow{elapsed: time.Second, delivered: mb(1800), loss: 0.08, segs: 50000, pathBusy: true})
	}
	if s.rate.Load() != 0 {
		t.Fatal("paused shaper must not start again before the pause ends")
	}
	for i := 0; i < linkShaperAutoTriggerRuns; i++ {
		s.stepLocked(now.Add(linkShaperAutoPause+time.Second), linkWindow{elapsed: time.Second, delivered: mb(1800), loss: 0.08, segs: 50000, pathBusy: true})
	}
	if s.rate.Load() == 0 {
		t.Fatal("after the pause the detector must run again")
	}
}

// 起点偏低（几条流互相打得只剩上限的三分之一时开始的）：没碰到丢包之前每秒升 10%，
// 碰到丢包再细调，学到的值就在第一次丢包点之下。升到起点四倍还不丢就当限速器没了。
func TestLinkShaperAutoSearchesUpwardFromALowStart(t *testing.T) {
	s := testShaper(t, "down:search")
	s.configure(linkShapingAuto, 0, 0)
	now := time.Now()
	mb := func(mbps int) float64 { return float64(mbps) * linkShaperBytesPerMbps }
	for i := 0; i < linkShaperAutoTriggerRuns; i++ {
		s.stepLocked(now, linkWindow{elapsed: time.Second, delivered: mb(500), loss: 0.05, segs: 50000, pathBusy: true})
	}
	if got := s.rate.Load() / linkShaperBytesPerMbps; got != 525 {
		t.Fatalf("start = %dMbit/s, want 525", got)
	}
	climbs := 0
	for s.rate.Load() < int64(mb(1500)) {
		s.stepLocked(now, busyWindow(s, 0))
		climbs++
		if climbs > 30 {
			t.Fatal("search climb stalled")
		}
	}
	if climbs > 13 {
		t.Fatalf("search took %d clean seconds to reach 1500Mbit/s from 525", climbs)
	}
	lossPoint := s.rate.Load()
	s.stepLocked(now, busyWindow(s, 0.02))
	if s.ceiling != lossPoint || s.rate.Load() >= lossPoint {
		t.Fatalf("first loss must set the ceiling and step down: ceiling=%d rate=%d", s.ceiling, s.rate.Load())
	}
	for i := 0; i < linkShaperCleanRounds; i++ {
		s.stepLocked(now, busyWindow(s, 0))
	}
	learned := s.learned.Load()
	if learned <= 0 || learned >= lossPoint || float64(learned) < float64(lossPoint)*0.95 {
		t.Fatalf("learned = %d, want just under the loss point %d", learned, lossPoint)
	}

	gone := testShaper(t, "up:gone")
	gone.configure(linkShapingAuto, 0, 0)
	for i := 0; i < linkShaperAutoTriggerRuns; i++ {
		gone.stepLocked(now, linkWindow{elapsed: time.Second, delivered: mb(500), loss: 0.05, segs: 50000, pathBusy: true})
	}
	for i := 0; i < 40 && gone.rate.Load() > 0; i++ {
		gone.stepLocked(now, busyWindow(gone, 0))
	}
	if gone.rate.Load() != 0 || gone.snapshot().State != "watching" {
		t.Fatalf("no loss up to 4x the start must return to watching: rate=%d state=%s", gone.rate.Load(), gone.snapshot().State)
	}
}

// 自动模式从起点降到一半还在丢：不是限速器，放弃。
func TestLinkShaperAutoGivesUpOnRandomLoss(t *testing.T) {
	s := testShaper(t, "up:random")
	s.configure(linkShapingAuto, 0, 0)
	now := time.Now()
	for i := 0; i < linkShaperAutoTriggerRuns; i++ {
		s.stepLocked(now, linkWindow{elapsed: time.Second, delivered: 100 * linkShaperBytesPerMbps, loss: 0.02, segs: 5000, pathBusy: true})
	}
	if s.rate.Load() == 0 {
		t.Fatal("expected shaping to start")
	}
	for i := 0; i < 60 && s.rate.Load() > 0; i++ {
		s.stepLocked(now, busyWindow(s, 0.02))
	}
	if s.rate.Load() != 0 || s.snapshot().State != "paused" {
		t.Fatalf("random loss must end in a pause, rate=%d state=%s", s.rate.Load(), s.snapshot().State)
	}
}

// 记住的限速点：本机文件优先，其次面板给的提示值；都按 98% 起步。
func TestLinkShaperAutoResumesFromStoredOrHintedValue(t *testing.T) {
	s := testShaper(t, "down:resume")
	if !saveLinkShaperLearned(s.key, 1400*linkShaperBytesPerMbps) {
		t.Fatal("save failed")
	}
	s.configure(linkShapingAuto, 0, 900)
	if got := s.rate.Load() / linkShaperBytesPerMbps; got != 1372 {
		t.Fatalf("resume rate = %dMbit/s, want 1372 (98%% of the stored 1400)", got)
	}
	hinted := testShaper(t, "up:hinted")
	hinted.configure(linkShapingAuto, 0, 900)
	if got := hinted.rate.Load() / linkShaperBytesPerMbps; got != 882 {
		t.Fatalf("hinted rate = %dMbit/s, want 882", got)
	}
	// 自动 → 手动 → 关 的切换各自生效。
	hinted.configure(linkShapingManual, 500, 0)
	if hinted.rate.Load() != int64(500*linkShaperBytesPerMbps*linkShaperHeadroom) || hinted.currentMode() != linkShapingManual {
		t.Fatalf("manual switch failed: rate=%d mode=%s", hinted.rate.Load(), hinted.currentMode())
	}
	hinted.configure(linkShapingOff, 0, 0)
	if hinted.rate.Load() != 0 || hinted.snapshot().State != "off" {
		t.Fatalf("off switch failed: rate=%d state=%s", hinted.rate.Load(), hinted.snapshot().State)
	}
}

func TestLinkShaperConfigModesAndDirections(t *testing.T) {
	linkShaperStateDir = t.TempDir()
	var cfg config
	if err := json.Unmarshal([]byte(`{"role":"exit","tunnelId":78,"linkShaping":"manual","linkUpMbps":1500,"linkDownMbps":1560,"linkUpHintMbps":10}`), &cfg); err != nil {
		t.Fatal(err)
	}
	if mode, mbps, _ := linkShapingSettings("up", cfg); mode != linkShapingManual || mbps != 1500 {
		t.Fatalf("manual up = %s/%d", mode, mbps)
	}
	if mode, mbps, _ := linkShapingSettings("down", cfg); mode != linkShapingManual || mbps != 1560 {
		t.Fatalf("manual down = %s/%d", mode, mbps)
	}
	cfg.LinkShaping = "auto"
	if mode, mbps, hint := linkShapingSettings("up", cfg); mode != linkShapingAuto || mbps != 0 || hint != 10 {
		t.Fatalf("auto up = %s/%d hint=%d", mode, mbps, hint)
	}
	cfg.LinkShaping = "off"
	if mode, _, _ := linkShapingSettings("up", cfg); mode != linkShapingOff {
		t.Fatalf("off = %s", mode)
	}
	// 旧面板不写档位：填了上限就是手动，没填就是关。
	cfg.LinkShaping = ""
	if mode, _, _ := linkShapingSettings("up", cfg); mode != linkShapingManual {
		t.Fatalf("legacy with limit = %s, want manual", mode)
	}
	cfg.LinkUpMbps = 0
	if mode, _, _ := linkShapingSettings("up", cfg); mode != linkShapingOff {
		t.Fatalf("legacy without limit = %s, want off", mode)
	}
	cfg.LinkShaping = "manual"
	if mode, _, _ := linkShapingSettings("up", cfg); mode != linkShapingOff {
		t.Fatalf("manual without a limit = %s, want off", mode)
	}

	up := linkShaperFor("up", config{Role: "entry", TunnelID: 78, LinkShaping: "auto"})
	down := linkShaperFor("down", config{Role: "exit", TunnelID: 78, LinkShaping: "manual", LinkDownMbps: 1560})
	if up == nil || down == nil || up == down {
		t.Fatal("each direction needs its own shaper")
	}
	if up.currentMode() != linkShapingAuto || down.max.Load() != 1560*linkShaperBytesPerMbps {
		t.Fatalf("modes: up=%s down max=%d", up.currentMode(), down.max.Load())
	}
	// 热更新关掉：同一个整形器速率归零，已有连接立刻不再整形。
	linkShapersApply(config{Role: "exit", TunnelID: 78, LinkShaping: "off"})
	if down.rate.Load() != 0 || up.currentMode() != linkShapingOff {
		t.Fatalf("reload to off left down=%d up=%s", down.rate.Load(), up.currentMode())
	}
	if linkShaperFor("up", config{TunnelID: 0, LinkShaping: "auto"}) != nil {
		t.Fatal("tunnel 0 must not be shaped")
	}
	// 关着也给一个稳定的句柄（速率 0）：之后热更新打开，拿着它的旧连接立刻受限。
	idle := linkShaperFor("up", config{Role: "entry", TunnelID: 79, LinkShaping: "off"})
	if idle == nil || idle.rate.Load() != 0 || idle.currentMode() != linkShapingOff {
		t.Fatal("off must still hand out an inactive shaper")
	}
	linkShapersApply(config{Role: "entry", TunnelID: 79, LinkShaping: "manual", LinkUpMbps: 300})
	if idle.rate.Load() != int64(300*linkShaperBytesPerMbps*linkShaperHeadroom) {
		t.Fatalf("enabling via reload must take effect on the existing handle, rate=%d", idle.rate.Load())
	}
	for _, bad := range []config{
		{Role: "exit", Key: "k", ListenPort: 1000, TunnelID: 1, LinkUpMbps: linkShaperMaxMbps + 1},
		{Role: "exit", Key: "k", ListenPort: 1000, TunnelID: 1, LinkShaping: "sometimes"},
		{Role: "exit", Key: "k", ListenPort: 1000, TunnelID: 1, LinkDownHintMbps: -1},
	} {
		if err := validateConfig(bad); err == nil {
			t.Fatalf("config %+v must be rejected", bad)
		}
	}
}
