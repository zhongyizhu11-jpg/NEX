package main

import (
	"encoding/json"
	"sync"
	"testing"
	"time"
)

// 四个协程一起写，合计速率要贴着整形速率：400 Mbit/s 起步 96% = 48 MB/s，
// 20 MiB 约 0.44 秒。太快说明没整形，太慢说明定时器精度拖了后腿。
func TestLinkShaperHoldsAggregateRate(t *testing.T) {
	s := newLinkShaper("test-up")
	s.configure(400)
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
	s.configure(0)
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
	s := newLinkShaper("test-small")
	s.configure(800) // 96 MB/s：64 KiB 约 0.68ms
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

func TestLinkShaperTuneStepsDownOnLossAndClimbsBelowCeiling(t *testing.T) {
	s := newLinkShaper("test-tune")
	s.configure(1000)
	max := s.max.Load()
	mbps := func() int { return int(s.rate.Load() / linkShaperBytesPerMbps) }
	if got := mbps(); got != 960 {
		t.Fatalf("start rate = %d, want 960", got)
	}
	now := time.Now()
	// 不忙：有重传也不动（整形没在起作用，重传不是它的锅）。
	s.tuneLocked(now, false, 0.05)
	if got := mbps(); got != 960 {
		t.Fatalf("idle tick changed rate to %d", got)
	}
	// 忙且丢包：降 3%，记住丢包点 960。
	s.tuneLocked(now, true, 0.01)
	if got := mbps(); got != 931 {
		t.Fatalf("after loss rate = %d, want 931", got)
	}
	if s.ceiling != int64(960*linkShaperBytesPerMbps) {
		t.Fatalf("ceiling = %d, want 960Mbit/s", s.ceiling/linkShaperBytesPerMbps)
	}
	// 连续十秒干净且忙：升 1%，但停在丢包点之下 1.5%（945.6）。
	for i := 0; i < linkShaperCleanRounds; i++ {
		s.tuneLocked(now.Add(time.Duration(i)*time.Second), true, 0)
	}
	if got := mbps(); got != 940 {
		t.Fatalf("after clean rounds rate = %d, want 940", got)
	}
	for round := 0; round < 3; round++ {
		for i := 0; i < linkShaperCleanRounds; i++ {
			s.tuneLocked(now, true, 0)
		}
	}
	if got := mbps(); got != 945 {
		t.Fatalf("rate should stop under the loss ceiling, got %d", got)
	}
	// 丢包点过期后可以探到配置上限。
	s.ceilingAt = now.Add(-linkShaperCeilingTTL - time.Second)
	for round := 0; round < 12; round++ {
		for i := 0; i < linkShaperCleanRounds; i++ {
			s.tuneLocked(now, true, 0)
		}
	}
	if s.rate.Load() != max {
		t.Fatalf("rate = %d, want the configured max %d", s.rate.Load(), max)
	}
	// 一直丢包也不低于 60%。
	for i := 0; i < 100; i++ {
		s.tuneLocked(now, true, 0.02)
	}
	if got := mbps(); got != 600 {
		t.Fatalf("floor = %d, want 600", got)
	}
	// 中间一点点重传（0.1%）既不降也不算干净。
	before := s.rate.Load()
	for i := 0; i < 30; i++ {
		s.tuneLocked(now, true, 0.001)
	}
	if s.rate.Load() != before {
		t.Fatalf("marginal loss moved the rate from %d to %d", before, s.rate.Load())
	}
}

func TestLinkShaperConfigAndDirections(t *testing.T) {
	var cfg config
	if err := json.Unmarshal([]byte(`{"role":"exit","tunnelId":77,"linkUpMbps":1500,"linkDownMbps":1560}`), &cfg); err != nil {
		t.Fatal(err)
	}
	if cfg.LinkUpMbps != 1500 || cfg.LinkDownMbps != 1560 {
		t.Fatalf("parsed link fields = %d/%d", cfg.LinkUpMbps, cfg.LinkDownMbps)
	}
	up := linkShaperFor("up", cfg)
	down := linkShaperFor("down", cfg)
	if up == nil || down == nil || up == down {
		t.Fatal("each direction needs its own shaper")
	}
	if up.max.Load() != 1500*linkShaperBytesPerMbps || down.max.Load() != 1560*linkShaperBytesPerMbps {
		t.Fatalf("max up=%d down=%d", up.max.Load(), down.max.Load())
	}
	// 热更新关掉：同一个整形器速率归零，已有连接立刻不再整形。
	cfg.LinkUpMbps = 0
	linkShapersApply(cfg)
	if up.rate.Load() != 0 || up.max.Load() != 0 {
		t.Fatalf("reload to 0 left up shaper at %d", up.rate.Load())
	}
	if linkShaperFor("up", config{TunnelID: 0, LinkUpMbps: 100}) != nil {
		t.Fatal("tunnel 0 must not be shaped")
	}
	bad := config{Role: "exit", Key: "k", ListenPort: 1000, TunnelID: 1, LinkUpMbps: linkShaperMaxMbps + 1}
	if err := validateConfig(bad); err == nil {
		t.Fatal("out-of-range linkUpMbps must be rejected")
	}
}
