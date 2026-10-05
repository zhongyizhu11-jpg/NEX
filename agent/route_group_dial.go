package main

import (
	"context"
	"net"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

/*
线路组 TCP 的拨号和探测提速。

  - 健康探测并行：以前一轮探测逐条串行，每条最多 2 秒；所有路径都拨不通时客户端连接会同步
    等一轮探测（checkHealthShared），N 条路径就是 N×2 秒。现在有界并行，一轮最坏约 2 秒。
  - 域名目标复用 UDP 那边的解析缓存：以前每条 TCP 连接都在 net.DialTimeout 里同步查一次 DNS。
    命中缓存就直接拨缓存的地址；没命中、缓存的是解析失败、或者缓存地址拨不通，都退回原来
    按域名拨（会尝试域名的全部地址），所以缓存只会让成功的情况变快，不会让原来能通的变不通。
  - 竞速拨号（happy eyeballs 风格）：只用于权重 / 轮流 / 随机这几种本来就允许把连接分到别的
    路径上的策略。选中的路径过了竞速延迟还没连上、又有另一条健康路径时，同时拨那条，谁先连上
    用谁，输的关掉。主备（含指定 / 计划 / 择优）和按访客固定不竞速，行为不变。
*/

// failoverProbeParallelism 一轮健康探测同时探几条路径。路径数一般是个位数；上限只是防止
// 规格里路径特别多时一下子开太多探测连接 / ping。
const failoverProbeParallelism = 8

// failoverRaceDelayMin 竞速前至少等这么久（RFC 8305 建议 250 ms 左右）。路径本身往返就慢
// （跨洲线路握手几百毫秒很正常）时按它最近一次探测耗时的两倍等，免得把健康但远的路径上
// 的连接系统性地抢到近的路径上，打乱权重分配。
const failoverRaceDelayMin = 300 * time.Millisecond

type failoverDialFunc func(ctx context.Context, network, address string) (net.Conn, error)

// failoverTCPDialHook 测试里替换，用来模拟握手很慢的路径。用原子指针是因为连接协程不会
// 随代理停止而被等待，测试恢复钩子时普通变量会和还没结束的连接协程构成数据竞争。
var failoverTCPDialHook atomic.Pointer[failoverDialFunc]

func failoverTCPDialContext(ctx context.Context, network, address string) (net.Conn, error) {
	if hook := failoverTCPDialHook.Load(); hook != nil {
		return (*hook)(ctx, network, address)
	}
	var dialer net.Dialer
	return dialer.DialContext(ctx, network, address)
}

// probeFailoverTargets 有界并行地探测所有路径，结果按路径下标返回。
func probeFailoverTargets(protocol string, targets []failoverTarget) ([]int, []bool) {
	latencies := make([]int, len(targets))
	results := make([]bool, len(targets))
	sem := make(chan struct{}, failoverProbeParallelism)
	var wg sync.WaitGroup
	for i, target := range targets {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, target failoverTarget) {
			defer wg.Done()
			defer func() { <-sem }()
			latencies[i], results[i] = failoverProbeTarget(protocol, target)
		}(i, target)
	}
	wg.Wait()
	return latencies, results
}

// failoverCachedTargetIP 返回域名目标在解析缓存里的地址；IP 目标、没命中、缓存的是失败都返回
// nil（没命中时顺便在后台发起解析，下一条连接就能用上）。
func failoverCachedTargetIP(host string, port int) net.IP {
	clean := strings.Trim(strings.TrimSpace(host), "[]")
	if clean == "" || net.ParseIP(clean) != nil {
		return nil
	}
	addr, pending, err := failoverUDPResolve(clean, port)
	if pending || err != nil || addr == nil {
		return nil
	}
	return addr.IP
}

// failoverDialTCP 拨一条路径。timeout 和原来 net.DialTimeout 的语义一样，覆盖整个拨号过程。
func failoverDialTCP(ctx context.Context, target failoverTarget, timeout time.Duration) (net.Conn, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	port := strconv.Itoa(target.TargetPort)
	if ip := failoverCachedTargetIP(target.TargetIP, target.TargetPort); ip != nil {
		// 缓存里只存了一个地址（优先 IPv4）。只给它一半的时间：域名可能有多个地址，
		// 缓存的那个被黑洞时，剩下的一半按域名拨，让系统解析器把所有地址都试一遍 ——
		// 否则缓存地址吃满超时，每次刷新缓存又选回同一个，能用的目标会一直连不上。
		cachedCtx, cancelCached := context.WithTimeout(ctx, timeout/2)
		conn, err := failoverTCPDialContext(cachedCtx, "tcp", net.JoinHostPort(ip.String(), port))
		cancelCached()
		if err == nil || ctx.Err() != nil {
			return conn, err
		}
	}
	return failoverTCPDialContext(ctx, "tcp", net.JoinHostPort(target.TargetIP, port))
}

// raceAllowedLocked 只有本来就会把连接分到不同路径上的策略才竞速。
func (p *failoverProxy) raceAllowedLocked() bool {
	switch p.spec.Strategy {
	case "weighted", "round_robin", "random":
		return len(p.spec.Targets) > 1
	}
	return false
}

func (p *failoverProxy) raceDelayLocked(index int) time.Duration {
	delay := failoverRaceDelayMin
	if latency := p.latencyMsLocked(index); latency > 0 {
		if adaptive := 2 * time.Duration(latency) * time.Millisecond; adaptive > delay {
			delay = adaptive
		}
	}
	return delay
}

type failoverDialResult struct {
	conn   net.Conn
	target failoverTarget
	index  int
	err    error
}

// dialFailoverPath 拨已经挑好的路径；允许竞速时按上面的规则再拨一条备选。拨失败的路径记一次
// 失败并加进 attempted（和原来一样）；被取消的输家不算失败。返回实际连上的那条。
func (p *failoverProxy) dialFailoverPath(visitor string, target failoverTarget, index int, attempted map[int]bool, timeout time.Duration) (net.Conn, failoverTarget, int, error) {
	p.mu.RLock()
	race := p.raceAllowedLocked()
	delay := p.raceDelayLocked(index)
	p.mu.RUnlock()
	if !race {
		conn, err := failoverDialTCP(context.Background(), target, timeout)
		if err != nil {
			attempted[index] = true
			p.markTargetFailure(index, "dial failed")
		}
		return conn, target, index, err
	}

	ctx, cancel := context.WithCancel(context.Background())
	results := make(chan failoverDialResult, 2)
	dial := func(target failoverTarget, index int) {
		conn, err := failoverDialTCP(ctx, target, timeout)
		results <- failoverDialResult{conn: conn, target: target, index: index, err: err}
	}
	go dial(target, index)
	pending := 1
	timer := time.NewTimer(delay)
	defer timer.Stop()
	var last failoverDialResult
	for pending > 0 {
		select {
		case <-timer.C:
			if pending != 1 || attempted[index] {
				continue
			}
			exclude := make(map[int]bool, len(attempted)+1)
			for i := range attempted {
				exclude[i] = true
			}
			exclude[index] = true
			second, secondIndex := p.pickTargetForKey(visitor, exclude)
			p.mu.RLock()
			healthy := secondIndex >= 0 && p.healthyLocked(secondIndex)
			p.mu.RUnlock()
			if healthy {
				go dial(second, secondIndex)
				pending++
			}
		case result := <-results:
			pending--
			if result.err == nil {
				cancel()
				// 输家可能在取消前刚好连上：收下来关掉，别漏连接。
				for ; pending > 0; pending-- {
					go func() {
						if loser := <-results; loser.conn != nil {
							_ = loser.conn.Close()
						}
					}()
				}
				return result.conn, result.target, result.index, nil
			}
			attempted[result.index] = true
			p.markTargetFailure(result.index, "dial failed")
			last = result
		}
	}
	cancel()
	return nil, last.target, last.index, last.err
}
