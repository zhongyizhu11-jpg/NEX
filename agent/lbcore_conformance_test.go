package main

import (
	"fmt"
	mathrand "math/rand"
	"net"
	"testing"
	"time"

	"github.com/zhongyizhu11-jpg/NEX/lbcore/lbtest"
)

/*
线路组跑 lbcore 的一致性用例（lbcore/testdata/conformance/*.json）：和 NEX 隧道的出口选择器（forwardx-fxp/ 里同名的
测试）、lbcore 自己跑的是同一批，三边的结果必须一样。

这里走的是真实的入口 —— failoverProxy.pickTargetForKeyProto / pickReserved（候选 → 按策略挑 → 收尾三段都走），
健康摆在代理自己的 targetHealth / relayDown 上，负载是真的在途计数和挂着的连接，延迟是探测样本；
没有哪一步绕过代理直接调 lbcore。

线路组没有的信号：「不稳」（只在主备的用例里出现，这边当健康）、「下游不通」「冷却」（相应的用例标了不给这边跑）。
主备的用例看的是「在走的那条用不了时换哪条」；「现在走哪条」的状态机（切回、驻留）不在这批用例里。
*/
type agentConformanceDriver struct {
	t       *testing.T
	proxy   *failoverProxy
	latency [][]lbtest.LatencySample
	quality []lbtest.QualitySpec
}

func (d *agentConformanceDriver) Name() string { return "agent" }

func (d *agentConformanceDriver) Start(c lbtest.Case) error {
	// 线路组的权重最大 100（规格规整时截）：用例里更大的（500:300:200）按比例缩进来。
	scale := 1.0
	for _, member := range c.Members {
		if member.Weight*scale > 100 {
			scale = 100 / member.Weight
		}
	}
	targets := make([]failoverTarget, len(c.Members))
	for i, member := range c.Members {
		targets[i] = failoverTarget{TargetIP: fmt.Sprintf("10.8.%d.1", i), TargetPort: 7000 + i, Weight: int(member.Weight*scale + 0.5)}
	}
	spec := normalizeFailoverSpec(failoverSpec{Enabled: true, BindAddress: "127.0.0.1", ListenPort: 64200, Strategy: c.Strategy, Targets: targets})
	if spec.Strategy != c.Strategy {
		return fmt.Errorf("分配方式 %q 被规整成了 %q", c.Strategy, spec.Strategy)
	}
	proxy := &failoverProxy{ruleID: 96, sourcePort: 21006, spec: spec}
	proxy.ensureHealthStateLocked()
	// 相位清零：轮流从第一条起，按权重的计数先开好（不然第一次用时会空转随机步）；随机数固定种子。
	proxy.rng = mathrand.New(mathrand.NewSource(20261119))
	proxy.roundRobinNext = 0
	proxy.wrrCurrent = make([]int, len(targets))
	d.proxy = proxy
	d.latency = make([][]lbtest.LatencySample, len(targets))
	d.quality = make([]lbtest.QualitySpec, len(targets))
	for i, member := range c.Members {
		if err := d.SetHealth(i, member.Health); err != nil {
			return err
		}
	}
	return nil
}

func (d *agentConformanceDriver) SetHealth(index int, health string) error {
	p := d.proxy
	p.mu.Lock()
	defer p.mu.Unlock()
	p.targetHealth[index] = true
	p.relayDown[index], p.relayDownReason[index] = false, ""
	switch health {
	case "", lbtest.HealthHealthy, lbtest.HealthUnstable:
	case lbtest.HealthDown, lbtest.HealthCooling:
		p.targetHealth[index] = false
	case lbtest.HealthExcluded:
		// 面板按「暂停」标掉的路径。
		p.relayDown[index], p.relayDownReason[index] = true, "paused"
	default:
		return fmt.Errorf("线路组没有 %q 这种健康", health)
	}
	return nil
}

func (d *agentConformanceDriver) SetRecovered(index int, seconds float64) error {
	p := d.proxy
	p.mu.Lock()
	defer p.mu.Unlock()
	p.markSlowStartLocked(index, time.Now().Add(-time.Duration(seconds*float64(time.Second))))
	return nil
}

func (d *agentConformanceDriver) SetLatency(index int, samples []lbtest.LatencySample) error {
	d.latency[index] = samples
	d.rebuildStats(index)
	return nil
}

func (d *agentConformanceDriver) SetQuality(index int, quality lbtest.QualitySpec) error {
	d.quality[index] = quality
	d.rebuildStats(index)
	return nil
}

// rebuildStats 按用例给的延迟样本和丢包率重摆这条路径的探测窗口；利用率是面板给的沿途主机负载。
func (d *agentConformanceDriver) rebuildStats(index int) {
	p := d.proxy
	p.mu.Lock()
	defer p.mu.Unlock()
	now := time.Now()
	stats := &routeTargetStats{}
	p.stats[index] = stats
	p.lastLatencyMs[index] = 0
	p.spec.Targets[index].LoadPct = int(d.quality[index].Utilisation*100 + 0.5)
	samples := d.latency[index]
	// 丢包：20 个样本的窗口里有这么多次探不通，放在最前面（最早），后面是探通的那些。
	const window = 20
	failures := int(d.quality[index].LossPct/100*window + 0.5)
	if failures > 0 {
		oldest := 0.0
		if len(samples) > 0 {
			oldest = samples[0].Ago
		}
		for i := 0; i < failures; i++ {
			stats.recordProbe(false, 0, now.Add(-time.Duration((oldest+300)*float64(time.Second))))
		}
		// 探通的补到 window − failures 个：把最早那个样本的延迟往前多摆几个（离得远，不影响 peak EWMA 的读数）。
		for missing := window - failures - len(samples); missing > 0 && len(samples) > 0; missing-- {
			stats.recordProbe(true, int(samples[0].Ms), now.Add(-time.Duration((oldest+200)*float64(time.Second))))
		}
	}
	for _, sample := range samples {
		stats.recordProbe(true, int(sample.Ms), now.Add(-time.Duration(sample.Ago*float64(time.Second))))
	}
	stats.probeFailures = 0
}

func (d *agentConformanceDriver) Pick(key string, mode string) (int, error) {
	p := d.proxy
	switch mode {
	case lbtest.ModeBurst:
		// 真要去拨的入口：挑中就记一笔在途，不退。
		_, index, _ := p.pickReserved(key, nil, false)
		return index, nil
	case lbtest.ModeHold:
		_, index, reservation := p.pickReserved(key, nil, false)
		if index >= 0 {
			client, server := net.Pipe()
			d.t.Cleanup(func() { _ = client.Close(); _ = server.Close() })
			p.trackConnReserved(index, client, reservation)
		}
		return index, nil
	}
	_, index := p.pickTargetForKeyProto(key, nil, false)
	return index, nil
}

func (d *agentConformanceDriver) MemberKeys() []string {
	keys := make([]string, len(d.proxy.spec.Targets))
	for i, target := range d.proxy.spec.Targets {
		keys[i] = fmt.Sprintf("%s:%d#%d", target.TargetIP, target.TargetPort, i)
	}
	return keys
}

func (d *agentConformanceDriver) Close() {}

func TestLBCoreConformance(t *testing.T) {
	lbtest.Run(t, &agentConformanceDriver{t: t})
}
