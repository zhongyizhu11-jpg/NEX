package main

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/zhongyizhu11-jpg/NEX/lbcore/lbtest"
)

/*
出口选择器跑 lbcore 的一致性用例（lbcore/testdata/conformance/*.json）：和线路组（agent/ 里同名的测试）、
lbcore 自己跑的是同一批，三边的结果必须一样。

这里走的是真实的入口 —— newExitEndpointSelector + selector.pick，健康摆在真实的端点状态和「出口到目标」的记账上，
负载记在真实的 fxpHostLoad 上；没有哪一步绕过选择器直接调 lbcore。
*/
type fxpConformanceDriver struct {
	selector *exitEndpointSelector
	excluded map[int]bool
	latency  [][]lbtest.LatencySample
}

func (d *fxpConformanceDriver) Name() string { return "fxp" }

func (d *fxpConformanceDriver) Start(c lbtest.Case) error {
	resetFXPEndpointRegistry()
	endpoints := make([]exitEndpoint, len(c.Members))
	for i, member := range c.Members {
		// 都写线路带宽：分量按它算，利用率（流量 ÷ 线路带宽）也有得算。权重没填的一样大。
		endpoints[i] = exitEndpoint{Host: fmt.Sprintf("10.9.%d.1", i), Port: 7000 + i, Weight: int(member.Weight), CapacityMbps: int(member.Weight), TargetStatus: true}
		if member.Weight <= 0 {
			endpoints[i].CapacityMbps = 100
		}
	}
	// 「不稳」按「切走」处理（用例里的 unstable 是软信号）；轮询 / 加权的相位清零，随机数固定种子。
	selector := newExitEndpointSelector(endpoints[1:], endpoints[0], c.Strategy, &balanceDetectConfig{JitterAction: "switch"})
	selector.random = seededExitRandom(20261119)
	selector.next = 0
	for i := range selector.current {
		selector.current[i] = 0
	}
	d.selector = selector
	d.excluded = map[int]bool{}
	d.latency = make([][]lbtest.LatencySample, len(c.Members))
	for i, member := range c.Members {
		if err := d.SetHealth(i, member.Health); err != nil {
			return err
		}
	}
	return nil
}

func (d *fxpConformanceDriver) SetHealth(index int, health string) error {
	s := d.selector
	delete(d.excluded, index)
	s.states[index].markHealthy()
	// markHealthy 会把「刚恢复」记到负载上（慢启动）；用例里的慢启动只由 recovered 给。
	s.loads[index].markRecovered(time.Time{})
	s.mu.Lock()
	target := s.target.health[index]
	target.down, target.unstable, target.upAt = false, false, time.Time{}
	target.lastSampleAt = time.Time{}
	s.mu.Unlock()
	switch health {
	case "", lbtest.HealthHealthy:
	case lbtest.HealthUnstable:
		s.mu.Lock()
		target.unstable = true
		s.mu.Unlock()
	case lbtest.HealthTargetDown:
		// 不带「刚测的」时间：全都到目标不通时走的是 lbcore 的恐慌（在连得上的里分），不是「目标挂了只试一台」那条。
		s.mu.Lock()
		target.down = true
		s.mu.Unlock()
	case lbtest.HealthDown:
		s.states[index].markFailure(errors.New("conformance: down"))
		setEndpointRetryAfter(s, index, time.Now().Add(-time.Second))
	case lbtest.HealthCooling:
		s.states[index].markFailure(errors.New("conformance: down"))
	case lbtest.HealthExcluded:
		// 出口组没有「管理上排除」的状态（面板不下发那台）；选择器里对应的是「这条连接不许用它」的排除表。
		d.excluded[index] = true
	default:
		return fmt.Errorf("不认识的健康 %q", health)
	}
	return nil
}

func (d *fxpConformanceDriver) SetRecovered(index int, seconds float64) error {
	d.selector.loads[index].markRecovered(time.Now().Add(-time.Duration(seconds * float64(time.Second))))
	return nil
}

func (d *fxpConformanceDriver) SetLatency(index int, samples []lbtest.LatencySample) error {
	load := d.selector.loads[index]
	load.mu.Lock()
	load.latency, load.latencyAt = 0, time.Time{}
	load.peak.Reset()
	load.mu.Unlock()
	now := time.Now()
	for _, sample := range samples {
		load.observeLatency(time.Duration(sample.Ms*float64(time.Millisecond)), now.Add(-time.Duration(sample.Ago*float64(time.Second))))
	}
	return nil
}

func (d *fxpConformanceDriver) SetQuality(index int, quality lbtest.QualitySpec) error {
	s := d.selector
	// 利用率 = 流量 ÷ 线路带宽。
	load := s.loads[index]
	load.mu.Lock()
	load.rate = quality.Utilisation * float64(s.endpoints[index].CapacityMbps) * 1e6 / 8
	load.sampledAt = time.Now()
	load.mu.Unlock()
	// 丢包：出口到目标最近 30 次里有这么多次不通（直接摆进样本窗口，不走 observe —— 那会顺带判坏 / 判不稳）。
	s.mu.Lock()
	defer s.mu.Unlock()
	target := s.target.health[index]
	*target = targetHealth{down: target.down, unstable: target.unstable}
	failures := int(quality.LossPct/100*fxpTargetWindow + 0.5)
	if failures == 0 {
		return nil
	}
	for i := 0; i < fxpTargetWindow; i++ {
		// 成功的样本延迟记 0：不改变这台的延迟，只带来丢包率。
		target.samples[i] = targetSample{ok: i >= failures}
	}
	target.count = fxpTargetWindow
	return nil
}

func (d *fxpConformanceDriver) Pick(key string, mode string) (int, error) {
	_, index, ok := d.selector.pick(d.excluded, key)
	if !ok {
		return -1, nil
	}
	switch mode {
	case lbtest.ModeBurst:
		// 挑中就记了一笔「刚挑中的」，留着。
	case lbtest.ModeHold:
		// 拨通了：转成一条挂着的会话（selectedTransport.useLocked 做的事），「刚挑中的」那一笔随时间自己衰减，
		// 这里直接退掉，免得同一条连接算两份。
		d.selector.loads[index].open(time.Now())
		d.selector.unpick(index)
	default:
		d.selector.unpick(index)
	}
	return index, nil
}

func (d *fxpConformanceDriver) MemberKeys() []string { return d.selector.hashAddrs }

func (d *fxpConformanceDriver) Close() { resetFXPEndpointRegistry() }

func TestLBCoreConformance(t *testing.T) {
	lbtest.Run(t, &fxpConformanceDriver{})
}
