package main

import (
	"runtime"
	"sync"
	"testing"
	"time"
)

type recordedTrafficDelta struct {
	in, out, connections uint64
}

type trafficDeltaRecorder struct {
	mu     sync.Mutex
	deltas []recordedTrafficDelta
}

func (r *trafficDeltaRecorder) report(in, out, connections uint64) {
	r.mu.Lock()
	r.deltas = append(r.deltas, recordedTrafficDelta{in, out, connections})
	r.mu.Unlock()
}

func (r *trafficDeltaRecorder) totals() (recordedTrafficDelta, int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var total recordedTrafficDelta
	for _, delta := range r.deltas {
		total.in += delta.in
		total.out += delta.out
		total.connections += delta.connections
	}
	return total, len(r.deltas)
}

// 共用的节拍交的是增量，停的时候补最后一次，停了之后再也不交：加起来和每个
// 上报器自己开定时器时一模一样。
func TestSharedTrafficReporterReportsDeltasAndStopsAfterFinal(t *testing.T) {
	counter := &trafficCounter{}
	recorder := &trafficDeltaRecorder{}
	stop := startTrafficReporterWith(counter, recorder.report)

	counter.connections.Store(1)
	counter.in.Add(100)
	counter.out.Add(7)
	tickTrafficReporters()
	if total, reports := recorder.totals(); reports != 1 || total != (recordedTrafficDelta{100, 7, 1}) {
		t.Fatalf("第一拍交了 %+v（%d 次），want {100 7 1}", total, reports)
	}
	// 没有新流量就不交。
	tickTrafficReporters()
	if _, reports := recorder.totals(); reports != 1 {
		t.Fatalf("没有增量也交了：%d 次", reports)
	}
	counter.in.Add(50)
	stop()
	stop()
	if total, reports := recorder.totals(); reports != 2 || total != (recordedTrafficDelta{150, 7, 1}) {
		t.Fatalf("停的时候交的总数 %+v（%d 次），want {150 7 1}", total, reports)
	}
	// 停了之后的计数不再交，即便共用节拍又走了一拍。
	counter.in.Add(1000)
	tickTrafficReporters()
	if total, _ := recorder.totals(); total.in != 150 {
		t.Fatalf("停了之后还在交：in=%d", total.in)
	}
	trafficReporters.Lock()
	registered := 0
	for r := range trafficReporters.active {
		if r.counter == counter {
			registered++
		}
	}
	trafficReporters.Unlock()
	if registered != 0 {
		t.Fatalf("停了之后上报器还登记着：%d", registered)
	}
}

// 以前每个上报器一个协程加一个定时器，几千条连接就是几千个协程。
func TestTrafficReportersShareOneGoroutine(t *testing.T) {
	const reporters = 500
	before := runtime.NumGoroutine()
	stops := make([]func(), 0, reporters)
	for i := 0; i < reporters; i++ {
		stops = append(stops, startTrafficReporterWith(&trafficCounter{}, func(uint64, uint64, uint64) {}))
	}
	after := runtime.NumGoroutine()
	for _, stop := range stops {
		stop()
	}
	// 共用协程最多新起一个；留一点余量给别的测试残留的协程。
	if grown := after - before; grown > 5 {
		t.Fatalf("%d 个上报器多出了 %d 个协程", reporters, grown)
	}
}

// 共用节拍和停止并发时，每个上报器交出去的总数仍然恰好是停之前的计数。
func TestSharedTrafficReporterConcurrentTickAndStop(t *testing.T) {
	const reporters = 64
	counters := make([]*trafficCounter, reporters)
	recorders := make([]*trafficDeltaRecorder, reporters)
	stops := make([]func(), reporters)
	for i := range counters {
		counters[i] = &trafficCounter{}
		recorders[i] = &trafficDeltaRecorder{}
		stops[i] = startTrafficReporterWith(counters[i], recorders[i].report)
	}
	done := make(chan struct{})
	var ticker sync.WaitGroup
	ticker.Add(1)
	go func() {
		defer ticker.Done()
		for {
			select {
			case <-done:
				return
			default:
				tickTrafficReporters()
				time.Sleep(time.Microsecond)
			}
		}
	}()
	var workers sync.WaitGroup
	for i := range counters {
		workers.Add(1)
		go func(i int) {
			defer workers.Done()
			for n := 0; n < 200; n++ {
				counters[i].in.Add(1)
			}
			stops[i]()
		}(i)
	}
	workers.Wait()
	close(done)
	ticker.Wait()
	for i, recorder := range recorders {
		if total, _ := recorder.totals(); total.in != 200 {
			t.Fatalf("上报器 %d 交了 in=%d，want 200", i, total.in)
		}
	}
}
