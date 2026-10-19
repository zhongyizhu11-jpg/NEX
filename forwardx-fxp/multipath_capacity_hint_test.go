package main

import (
	"encoding/json"
	"testing"
	"time"
)

// 线路带宽给了初值：还没量出往返之前，大的那一路就能多拿，也先被挑中。
func TestMultipathCapacityHintSeedsLegs(t *testing.T) {
	var big, small, none legPacing
	big.seedCapacity(500)
	small.seedCapacity(100)
	none.seedCapacity(0)
	if none.capacity() != multipathLegInitialInflight {
		t.Fatalf("没给带宽应该照旧从 1 MiB 起步：%d", none.capacity())
	}
	if !(big.capacity() > small.capacity() && small.capacity() > 0) {
		t.Fatalf("带宽大的一路初始份额应该更大：%d vs %d", big.capacity(), small.capacity())
	}
	if big.capacity() > multipathLegMaxInflight {
		t.Fatalf("初始份额超过上限：%d", big.capacity())
	}
	now := time.Now()
	big.onWritten(4<<20, now)
	small.onWritten(4<<20, now)
	if !(big.expectedDelay(now) > 0 && big.expectedDelay(now) < small.expectedDelay(now)) {
		t.Fatalf("同样压着 4 MiB，带宽大的一路应该估得更快：%v vs %v", big.expectedDelay(now), small.expectedDelay(now))
	}
	if none.expectedDelay(now) != 0 {
		t.Fatal("没给带宽、没量过的一路应该还是「不知道」")
	}
}

// 实测比给的带宽低：一两秒内就跟下来，不会一直按给的值压。
func TestMultipathCapacityHintYieldsToMeasurement(t *testing.T) {
	var p legPacing
	p.seedCapacity(1000)
	start := time.Now()
	p.onWritten(1<<20, start)
	p.onAcked(1, start.Add(30*time.Millisecond))
	acked := uint64(1)
	// 实际只有 10 Mbps（1.25 MB/s）：每 100ms 回 125 KB。
	for i := 1; i <= 30; i++ {
		acked += 125000
		p.onAcked(acked, start.Add(30*time.Millisecond+time.Duration(i)*100*time.Millisecond))
	}
	if p.rate > 2*1250000 {
		t.Fatalf("3 秒后速率估计还停在给的带宽附近：%.0f B/s", p.rate)
	}
}

// hello 带上这一路的带宽，出口（管回程）才知道按什么分。
func TestMultipathHelloCarriesLegCapacity(t *testing.T) {
	frame, _ := json.Marshal(helloFrame{MultipathSessionID: "s", MultipathLegIndex: 1, MultipathLegCapacityMbps: 300})
	var got helloFrame
	if err := json.Unmarshal(frame, &got); err != nil || got.MultipathLegCapacityMbps != 300 {
		t.Fatalf("hello 里的带宽丢了：%s", frame)
	}
	frame, _ = json.Marshal(helloFrame{MultipathSessionID: "s"})
	if string(frame) == "" || json.Valid(frame) == false {
		t.Fatal("bad frame")
	}
	var plain map[string]any
	_ = json.Unmarshal(frame, &plain)
	if _, ok := plain["multipathLegCapacityMbps"]; ok {
		t.Fatal("没写带宽时不该出现这个字段（老出口照旧）")
	}
}
