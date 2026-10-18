package main

import (
	"net"
	"strconv"
	"testing"
	"time"
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

func TestRouteLeastLoadSpecIsKept(t *testing.T) {
	spec := normalizeFailoverSpec(failoverSpec{Strategy: "least_load", Targets: []failoverTarget{{TargetIP: "127.0.0.1", TargetPort: 1}}})
	if spec.Strategy != "least_load" {
		t.Fatalf("least_load 被规整成了 %q", spec.Strategy)
	}
}
