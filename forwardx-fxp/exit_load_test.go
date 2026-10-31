package main

import (
	"fmt"
	"testing"
	"time"
)

func leastLoadSelector(exits []exitEndpoint, fallback exitEndpoint) *exitEndpointSelector {
	resetFXPEndpointRegistry()
	return newExitEndpointSelector(exits, fallback, "least_load")
}

// setBusy 让这台看起来正在跑这么多流量（字节/秒）。sampledAt 一起设：包里前面的测试起的维护循环
// 还在每秒 sample 一次所有主机，没采过样的那一下会把 rate 清零（当成第一次采样），这台就忽然「闲」了，
// 测试偶尔挑中它（2.3.497 发版时 TestLeastLoadPowerOfTwoChoices 就这么红过一次）。
func setBusy(load *fxpHostLoad, bytesPerSecond float64) {
	load.mu.Lock()
	load.rate = bytesPerSecond
	load.sampledAt = time.Now()
	load.mu.Unlock()
}

// 按负载：都没量的时候，新连接按线路带宽分（500M / 300M ≈ 5:3），而不是平均分。
func TestLeastLoadSplitsNewConnectionsByCapacity(t *testing.T) {
	selector := leastLoadSelector(
		[]exitEndpoint{{Host: "10.0.0.2", Port: 2, CapacityMbps: 300}},
		exitEndpoint{Host: "10.0.0.1", Port: 1, CapacityMbps: 500},
	)
	counts := map[int]int{}
	for i := 0; i < 80; i++ {
		_, index, ok := selector.pick(nil)
		if !ok {
			t.Fatal("挑不出端点")
		}
		counts[index]++
		selector.loads[index].open(time.Now())
	}
	if counts[0] < 48 || counts[0] > 52 {
		t.Fatalf("应该大约 5:3：%v", counts)
	}
}

// 按负载：一台正在跑满流量，新连接给另一台。
func TestLeastLoadAvoidsBusyExit(t *testing.T) {
	selector := leastLoadSelector(
		[]exitEndpoint{{Host: "10.0.0.2", Port: 2, CapacityMbps: 500}},
		exitEndpoint{Host: "10.0.0.1", Port: 1, CapacityMbps: 500},
	)
	setBusy(selector.loads[0], 50*1024*1024)
	for i := 0; i < 5; i++ {
		if _, index, _ := selector.pick(nil); index != 1 {
			t.Fatalf("第 %d 次挑到了正忙的那台", i)
		}
	}
}

// 按负载：握手慢很多的出口往后放；差得不多（50ms 内）就当一样快。
func TestLeastLoadPenalizesSlowExit(t *testing.T) {
	selector := leastLoadSelector(
		[]exitEndpoint{{Host: "10.0.0.2", Port: 2, CapacityMbps: 500}},
		exitEndpoint{Host: "10.0.0.1", Port: 1, CapacityMbps: 500},
	)
	now := time.Now()
	selector.loads[0].observeLatency(400*time.Millisecond, now)
	selector.loads[1].observeLatency(60*time.Millisecond, now)
	if _, index, _ := selector.pick(nil); index != 1 {
		t.Fatal("应该先给握手快的那台")
	}
	resetFXPHostLoads()
	selector = leastLoadSelector(
		[]exitEndpoint{{Host: "10.0.0.2", Port: 2, CapacityMbps: 500}},
		exitEndpoint{Host: "10.0.0.1", Port: 1, CapacityMbps: 500},
	)
	selector.loads[0].observeLatency(80*time.Millisecond, now)
	selector.loads[1].observeLatency(60*time.Millisecond, now)
	counts := map[int]int{}
	for i := 0; i < 20; i++ {
		_, index, _ := selector.pick(nil)
		counts[index]++
		selector.loads[index].open(time.Now())
	}
	if counts[0] != 10 || counts[1] != 10 {
		t.Fatalf("只差 20ms 应该当一样快：%v", counts)
	}
}

// 慢启动：刚恢复的出口先只给一小份，60 秒里慢慢加到满份。
func TestLeastLoadSlowStartAfterRecovery(t *testing.T) {
	selector := leastLoadSelector(
		[]exitEndpoint{{Host: "10.0.0.2", Port: 2, CapacityMbps: 500}},
		exitEndpoint{Host: "10.0.0.1", Port: 1, CapacityMbps: 500},
	)
	selector.markFailure(1, errTestEndpointDown)
	selector.markHealthy(1)
	counts := map[int]int{}
	for i := 0; i < 22; i++ {
		_, index, _ := selector.pick(nil)
		counts[index]++
		selector.loads[index].open(time.Now())
	}
	if counts[1] > 3 {
		t.Fatalf("刚恢复的出口一下子分到了 %d 条：%v", counts[1], counts)
	}
	snap := selector.loads[1].snapshot(time.Now().Add(fxpSlowStartWindow))
	if snap.slowStart != 1 {
		t.Fatalf("慢启动窗口过了应该满份：%v", snap.slowStart)
	}
}

// 活动连接：会话开始算一条，结束减掉，换端点时挪过去。
func TestHostLoadActiveAccounting(t *testing.T) {
	resetFXPEndpointRegistry()
	load := fxpHostLoadFor("10.0.0.9")
	load.open(time.Now())
	load.open(time.Now())
	load.close()
	if got := load.active.Load(); got != 1 {
		t.Fatalf("活动连接应该是 1：%d", got)
	}
	load.close()
	load.close()
	if got := load.active.Load(); got != 0 {
		t.Fatalf("多关一次不能变负数：%d", got)
	}
	load.addBytes(10 * 1024 * 1024)
	start := time.Now()
	load.sample(start)
	load.addBytes(10 * 1024 * 1024)
	load.sample(start.Add(time.Second))
	if snap := load.snapshot(start.Add(time.Second)); snap.rate <= 0 {
		t.Fatal("有流量 rate 应该大于 0")
	}
}

// 按访客固定：一台出口挂了，只有原来落在它上面的访客换出口，其余人不动。
func TestIPHashRendezvousOnlyMovesFailedExitVisitors(t *testing.T) {
	resetFXPEndpointRegistry()
	selector := newExitEndpointSelector(
		[]exitEndpoint{{Host: "10.0.0.2", Port: 2}, {Host: "10.0.0.3", Port: 3}},
		exitEndpoint{Host: "10.0.0.1", Port: 1},
		"ip_hash",
	)
	before := map[string]int{}
	counts := map[int]int{}
	for i := 0; i < 300; i++ {
		key := fmt.Sprintf("198.51.100.%d", i)
		_, index, _ := selector.pick(nil, key)
		before[key] = index
		counts[index]++
	}
	for index := 0; index < 3; index++ {
		if counts[index] < 70 {
			t.Fatalf("三台应该大致平均：%v", counts)
		}
	}
	selector.markFailure(2, errTestEndpointDown)
	moved := 0
	for key, old := range before {
		_, index, _ := selector.pick(nil, key)
		if old != 2 && index != old {
			moved++
		}
		if index == 2 {
			t.Fatal("挂掉的出口还在接访客")
		}
	}
	if moved != 0 {
		t.Fatalf("没挂的出口上有 %d 个访客被换走了", moved)
	}
}

// 按访客固定：同一个访客反复来还是同一台；一台已经比它该分的多太多就往下一台放。
func TestIPHashBoundedLoad(t *testing.T) {
	resetFXPEndpointRegistry()
	selector := newExitEndpointSelector(
		[]exitEndpoint{{Host: "10.0.0.2", Port: 2}},
		exitEndpoint{Host: "10.0.0.1", Port: 1},
		"ip_hash",
	)
	_, first, _ := selector.pick(nil, "203.0.113.7")
	for i := 0; i < 3; i++ {
		if _, index, _ := selector.pick(nil, "203.0.113.7"); index != first {
			t.Fatal("同一个访客换了出口")
		}
	}
	for i := 0; i < 10; i++ {
		selector.loads[first].open(time.Now())
	}
	if _, index, _ := selector.pick(nil, "203.0.113.7"); index == first {
		t.Fatal("一台已经压了 10 条、另一台空着，还往满的那台放")
	}
}

func TestLeastLoadStrategyIsKept(t *testing.T) {
	if normalizeExitStrategy("least_load") != "least_load" {
		t.Fatal("least_load 被规整成了别的策略")
	}
}

// 候选多（> 3）时随机挑两个比：正在跑满的那台永远不会赢。
func TestLeastLoadPowerOfTwoChoices(t *testing.T) {
	selector := leastLoadSelector(
		[]exitEndpoint{
			{Host: "10.0.0.2", Port: 2, CapacityMbps: 500},
			{Host: "10.0.0.3", Port: 3, CapacityMbps: 500},
			{Host: "10.0.0.4", Port: 4, CapacityMbps: 500},
		},
		exitEndpoint{Host: "10.0.0.1", Port: 1, CapacityMbps: 500},
	)
	setBusy(selector.loads[2], 80*1024*1024)
	counts := map[int]int{}
	for i := 0; i < 400; i++ {
		_, index, _ := selector.pick(nil)
		counts[index]++
	}
	if counts[2] != 0 {
		t.Fatalf("跑满的那台被挑中 %d 次", counts[2])
	}
	for _, index := range []int{0, 1, 3} {
		if counts[index] < 80 {
			t.Fatalf("其余三台应该都分到：%v", counts)
		}
	}
}
