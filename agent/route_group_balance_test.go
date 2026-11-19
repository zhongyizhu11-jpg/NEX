package main

import (
	mathrand "math/rand"
	"net"
	"strconv"
	"testing"
	"time"

	"github.com/zhongyizhu11-jpg/NEX/lbcore"
)

func balanceTestProxy(strategy string, weights ...int) *failoverProxy {
	targets := make([]failoverTarget, len(weights))
	for i, weight := range weights {
		targets[i] = failoverTarget{TargetIP: "127.0.0." + strconv.Itoa(i+1), TargetPort: 1000 + i, Weight: weight}
	}
	p := &failoverProxy{spec: failoverSpec{Strategy: strategy, Targets: targets}, conns: make([]map[net.Conn]struct{}, len(weights))}
	for i := range p.conns {
		p.conns[i] = map[net.Conn]struct{}{}
	}
	return p
}

// 按权重：平滑加权轮询，5:3 准确分、交错排（以前是按权重随机）。
func TestRouteWeightedIsSmooth(t *testing.T) {
	p := balanceTestProxy("weighted", 5, 3)
	counts := map[int]int{}
	run, last, maxRun := 0, -1, 0
	for i := 0; i < 80; i++ {
		_, index := p.pickTargetForKey("", nil)
		counts[index]++
		if index == last {
			run++
		} else {
			run, last = 1, index
		}
		if run > maxRun {
			maxRun = run
		}
	}
	if counts[0] != 50 || counts[1] != 30 || maxRun > 2 {
		t.Fatalf("应该 50:30 交错：%v maxRun=%d", counts, maxRun)
	}
}

// 权重 0 的路径不分新连接。
func TestRouteWeightedSkipsZeroWeight(t *testing.T) {
	p := balanceTestProxy("weighted", 3, 0)
	for i := 0; i < 10; i++ {
		if _, index := p.pickTargetForKey("", nil); index != 0 {
			t.Fatal("权重 0 的路径分到了新连接")
		}
	}
}

// 按负载：给活动连接最少（按权重折算）的那条。
func TestRouteLeastLoadPicksFewestConnections(t *testing.T) {
	p := balanceTestProxy("least_load", 1, 1)
	for i := 0; i < 4; i++ {
		a, b := net.Pipe()
		defer a.Close()
		defer b.Close()
		p.conns[0][a] = struct{}{}
	}
	for i := 0; i < 3; i++ {
		_, index := p.pickTargetForKey("", nil)
		if index != 1 {
			t.Fatalf("第 %d 次没给连接少的那条", i)
		}
		a, b := net.Pipe()
		defer a.Close()
		defer b.Close()
		p.conns[index][a] = struct{}{}
	}
	// 2:1 的权重：A 有 2 条、B 有 1 条时，(2+1)/2 < (1+1)/1，给 A。
	p = balanceTestProxy("least_load", 2, 1)
	for i, n := range []int{2, 1} {
		for j := 0; j < n; j++ {
			a, b := net.Pipe()
			defer a.Close()
			defer b.Close()
			p.conns[i][a] = struct{}{}
		}
	}
	if _, index := p.pickTargetForKey("", nil); index != 0 {
		t.Fatal("应该按权重折算连接数")
	}
}

// 按访客固定：一条路挂了，只有原来在它上面的访客换路。
func TestRouteIPHashOnlyMovesFailedPathVisitors(t *testing.T) {
	p := balanceTestProxy("ip_hash", 1, 1, 1)
	before := map[string]int{}
	counts := map[int]int{}
	for i := 0; i < 300; i++ {
		key := "198.51.100." + strconv.Itoa(i)
		_, index := p.pickTargetForKey(key, nil)
		before[key] = index
		counts[index]++
	}
	for i := 0; i < 3; i++ {
		if counts[i] < 70 {
			t.Fatalf("三条应该大致平均：%v", counts)
		}
	}
	p.targetHealth[2] = false
	for key, old := range before {
		_, index := p.pickTargetForKey(key, nil)
		if index == 2 {
			t.Fatal("挂掉的路径还在接访客")
		}
		if old != 2 && index != old {
			t.Fatalf("访客 %s 没在挂掉的路径上却被换走了", key)
		}
	}
}

// 慢启动：刚恢复的路径先只分一小份。
func TestRouteSlowStartAfterRecovery(t *testing.T) {
	p := balanceTestProxy("weighted", 1, 1)
	p.ensureHealthStateLocked()
	p.markSlowStartLocked(1, time.Now())
	counts := map[int]int{}
	for i := 0; i < 22; i++ {
		_, index := p.pickTargetForKey("", nil)
		counts[index]++
	}
	if counts[1] > 3 {
		t.Fatalf("刚恢复的路径分到了 %d 条：%v", counts[1], counts)
	}
	if p.slowStartLocked(1, time.Now().Add(routeSlowStartWindow)) != 1 {
		t.Fatal("窗口过了应该满份")
	}
}

// 别的测试文件里直接按某一种分法挑一条用的（产品代码都从 spreadPickLocked 进）。调用方持有 p.mu。
func (p *failoverProxy) weightedPickLocked(candidates []int) int {
	return p.spreadPickLocked(lbcore.StrategyWeighted, candidates, "")
}

func (p *failoverProxy) rendezvousPickLocked(candidates []int, key string) int {
	return p.spreadPickLocked(lbcore.StrategyIPHash, candidates, key)
}

// 按访客固定带有界负载（和出口组同一个实现）：一个访客自己占了大头时，超过「该分的 × 1.25」的连接落到别的路径上；
// 头两条连接总在同一条上。
func TestRouteIPHashBoundedLoad(t *testing.T) {
	p := balanceTestProxy("ip_hash", 1, 1)
	p.ensureHealthStateLocked()
	_, home := p.pickTargetForKey("203.0.113.7", nil)
	autoHoldConn(t, p, home)
	if _, second := p.pickTargetForKey("203.0.113.7", nil); second != home {
		t.Fatal("同一个访客的第二条连接换了路径")
	}
	for i := 0; i < 9; i++ {
		autoHoldConn(t, p, home)
	}
	if _, index := p.pickTargetForKey("203.0.113.7", nil); index == home {
		t.Fatal("一条已经压了 10 条、另一条空着，还往满的那条放")
	}
	// 不知道访客是谁：轮流，不把所有人钉在同一条上。
	q := balanceTestProxy("ip_hash", 1, 1)
	q.ensureHealthStateLocked()
	_, first := q.pickTargetForKey("", nil)
	if _, second := q.pickTargetForKey("", nil); second == first {
		t.Fatal("没有访客地址时应该轮流")
	}
}

// 延迟优先（和出口组同一个实现）：只在和最快的差不到 50ms 的几条里分。
func TestRouteLatencyStrategyUsesTheNearSet(t *testing.T) {
	spec := normalizeFailoverSpec(failoverSpec{Strategy: "latency", Targets: []failoverTarget{
		{TargetIP: "127.0.0.1", TargetPort: 1, Weight: 1}, {TargetIP: "127.0.0.2", TargetPort: 2, Weight: 1}, {TargetIP: "127.0.0.3", TargetPort: 3, Weight: 1},
	}})
	if spec.Strategy != "latency" {
		t.Fatalf("latency 被规整成了 %q", spec.Strategy)
	}
	p := &failoverProxy{spec: spec}
	p.ensureHealthStateLocked()
	at := time.Now()
	for i, ms := range []int{20, 50, 300} {
		p.stats[i].recordProbe(true, ms, at)
	}
	counts := map[int]int{}
	for i := 0; i < 60; i++ {
		_, index, _ := p.pickReserved("", nil, false)
		counts[index]++
	}
	if counts[2] != 0 || counts[0] == 0 || counts[1] == 0 {
		t.Fatalf("慢出门槛的那条不分，另外两条都分：%v", counts)
	}
}

// 起步位置随机（路线图 X4）：不同的线路组，按权重的第一条连接不都落在同一条路径上；份额不变。
func TestRouteWeightedStartsAtARandomPhase(t *testing.T) {
	firsts := map[int]bool{}
	for seed := int64(1); seed <= 40; seed++ {
		p := balanceTestProxy("weighted", 5, 3)
		p.rng = mathrand.New(mathrand.NewSource(seed))
		counts := map[int]int{}
		for i := 0; i < 80; i++ {
			_, index := p.pickTargetForKey("", nil)
			if i == 0 {
				firsts[index] = true
			}
			counts[index]++
		}
		if counts[0] != 50 || counts[1] != 30 {
			t.Fatalf("起步位置不该改变份额：%v", counts)
		}
	}
	if len(firsts) < 2 {
		t.Fatal("40 个线路组的第一条连接全落在同一条路径上")
	}
	if a, b := randomSpreadStart(1, 2), randomSpreadStart(1, 2); a < 0 || b < 0 {
		t.Fatal("轮转的随机初值不能是负数")
	}
}

func TestRouteLeastLoadSpecIsKept(t *testing.T) {
	spec := normalizeFailoverSpec(failoverSpec{Strategy: "least_load", Targets: []failoverTarget{{TargetIP: "127.0.0.1", TargetPort: 1}}})
	if spec.Strategy != "least_load" {
		t.Fatalf("least_load 被规整成了 %q", spec.Strategy)
	}
}
