package main

import (
	"net"
	"sync"
	"time"
)

/*
新连接的「无感换路」（2.2.258 起）。

拨得通不等于走得通：路径经过 gost 中转时，落地挂了中转照样接住入口的连接，然后拨落地失败、把连接关掉 ——
客户端看到的是「连上了又被断开」。以前这一条连接就这么失败了，要等探测把路径判断掉，后面的连接才换。

现在每条新连接在收到上游第一个字节之前处于「保护期」：客户端发来的头一段数据（最多 64KB）照常立刻转给上游，
同时留一份。上游在回任何东西之前就关了（EOF / RST）→ 这一条当场换下一条路径，把留着的数据重发过去，
客户端那边什么都感觉不到（多一个来回的时间）。上游回了第一个字节、或者保护期过了、或者客户端先收了，
就交给平常的双向转发，之后和以前完全一样。

判路径故障要更谨慎：一个密码填错的客户端也会被落地直接关掉，不能让它把好好的路径判死。所以「回之前就关」
要连续满「失败几次算断」次、而且来自至少两个不同的访客，才把这条路径标成异常；中间只要有一次正常回了就清零。
真正的「下一跳断了」由中转机的快速探测（route_hop_probe.go）报，几秒内就到。
*/

const (
	failoverEarlyGuardWindow   = 8 * time.Second
	failoverEarlyReplayLimit   = 64 * 1024
	failoverEarlyMaxRetries    = 3
	failoverEarlyReadChunkSize = 32 * 1024
)

type failoverEarlyChunk struct {
	data []byte
	err  error
}

type failoverEarlyCloseState struct {
	count    int
	visitors map[string]bool
}

// guardedStart 接管 upstream：写 prefix、进保护期、必要时换路。成功返回最终在用的连接和它的下标；
// 失败返回 ok=false（已经关掉上游，调用方关客户端）。
func (p *failoverProxy) guardedStart(client net.Conn, upstream net.Conn, index int, visitor string, attempted map[int]bool, prefix []byte) (net.Conn, int, bool) {
	if attempted == nil {
		attempted = map[int]bool{}
	}
	replay := append([]byte(nil), prefix...)
	replayOK := len(replay) <= failoverEarlyReplayLimit
	if len(prefix) > 0 {
		if _, err := upstream.Write(prefix); err != nil {
			next, nextIndex, ok := p.earlyReroute(upstream, index, visitor, attempted, replay, replayOK, 0)
			if !ok {
				return nil, -1, false
			}
			upstream, index = next, nextIndex
		}
	}

	clientChunks := make(chan failoverEarlyChunk, 8)
	var stopClient sync.Once
	go func() {
		for {
			buf := make([]byte, failoverEarlyReadChunkSize)
			n, err := client.Read(buf)
			if n > 0 {
				clientChunks <- failoverEarlyChunk{data: buf[:n]}
			}
			if err != nil {
				clientChunks <- failoverEarlyChunk{err: err}
				return
			}
		}
	}()
	upstreamFirst := p.readUpstreamFirst(upstream)
	deadline := time.NewTimer(failoverEarlyGuardWindow)
	defer deadline.Stop()
	retries := 0
	clientDone := false

	handoff := func() (net.Conn, int, bool) {
		// 停掉读客户端的那个 goroutine：读到的都转给上游，直到它因为截止时间退出。
		if !clientDone {
			stopClient.Do(func() { _ = client.SetReadDeadline(time.Now()) })
			for chunk := range clientChunks {
				if len(chunk.data) > 0 {
					if _, err := upstream.Write(chunk.data); err != nil {
						_ = upstream.Close()
						return nil, -1, false
					}
				}
				if chunk.err != nil {
					break
				}
			}
			_ = client.SetReadDeadline(time.Time{})
		}
		// 还在等上游第一个字节的那次读：让它立刻返回，读到的补给客户端。
		if upstreamFirst != nil {
			_ = upstream.SetReadDeadline(time.Now())
			result := <-upstreamFirst
			_ = upstream.SetReadDeadline(time.Time{})
			if len(result.data) > 0 {
				if _, err := client.Write(result.data); err != nil {
					_ = upstream.Close()
					return nil, -1, false
				}
			}
		}
		return upstream, index, true
	}

	for {
		select {
		case chunk := <-clientChunks:
			if len(chunk.data) > 0 {
				if replayOK {
					if len(replay)+len(chunk.data) > failoverEarlyReplayLimit {
						replayOK = false
						replay = nil
					} else {
						replay = append(replay, chunk.data...)
					}
				}
				if _, err := upstream.Write(chunk.data); err != nil {
					// 写不进去：上游已经断了，按「回之前就关」处理
					_ = upstream.SetReadDeadline(time.Now())
					<-upstreamFirst
					next, nextIndex, ok := p.earlyReroute(upstream, index, visitor, attempted, replay, replayOK, retries)
					if !ok {
						return nil, -1, false
					}
					retries++
					upstream, index = next, nextIndex
					upstreamFirst = p.readUpstreamFirst(upstream)
				}
			}
			if chunk.err != nil {
				// 客户端先收了（或者出错了）：不再保护，交给平常的转发把半关闭传下去。
				clientDone = true
				return handoff()
			}
		case result := <-upstreamFirst:
			upstreamFirst = nil
			if len(result.data) > 0 {
				p.markEarlyReply(index)
				if _, err := client.Write(result.data); err != nil {
					_ = upstream.Close()
					return nil, -1, false
				}
				return handoff()
			}
			// 回任何东西之前上游就关了：这一条当场换路，留着的数据重发过去。
			next, nextIndex, ok := p.earlyReroute(upstream, index, visitor, attempted, replay, replayOK, retries)
			if !ok {
				return nil, -1, false
			}
			retries++
			upstream, index = next, nextIndex
			upstreamFirst = p.readUpstreamFirst(upstream)
		case <-deadline.C:
			return handoff()
		}
	}
}

// readUpstreamFirst 读上游的第一段（一次 Read），结果从返回的 channel 拿。
func (p *failoverProxy) readUpstreamFirst(upstream net.Conn) chan failoverEarlyChunk {
	out := make(chan failoverEarlyChunk, 1)
	go func() {
		buf := make([]byte, failoverEarlyReadChunkSize)
		n, err := upstream.Read(buf)
		if n > 0 {
			out <- failoverEarlyChunk{data: buf[:n]}
			return
		}
		out <- failoverEarlyChunk{err: err}
	}()
	return out
}

// earlyReroute 关掉回之前就断了的上游，记一笔，换下一条路径并重发留着的数据。
func (p *failoverProxy) earlyReroute(upstream net.Conn, index int, visitor string, attempted map[int]bool, replay []byte, replayOK bool, retries int) (net.Conn, int, bool) {
	_ = upstream.Close()
	p.markEarlyClose(index, visitor)
	attempted[index] = true
	if !replayOK || retries >= failoverEarlyMaxRetries {
		return nil, -1, false
	}
	for {
		target, nextIndex := p.pickTargetForKey(visitor, attempted)
		if nextIndex < 0 {
			return nil, -1, false
		}
		next, _, dialedIndex, err := p.dialFailoverPath(visitor, target, nextIndex, attempted, failoverProxyDialTimeout)
		if err != nil {
			p.mu.RLock()
			exhausted := len(attempted) >= len(p.spec.Targets)
			p.mu.RUnlock()
			if exhausted {
				return nil, -1, false
			}
			continue
		}
		if len(replay) > 0 {
			if _, err := next.Write(replay); err != nil {
				_ = next.Close()
				attempted[dialedIndex] = true
				continue
			}
		}
		logf("failover early close rerouted rule=%d source=%d from=%d to=%d replay=%dB", p.ruleID, p.sourcePort, index, dialedIndex, len(replay))
		return next, dialedIndex, true
	}
}

// markEarlyClose 记一次「回之前就关」；连续满次数、而且至少两个不同访客，才把路径标成异常。
func (p *failoverProxy) markEarlyClose(index int, visitor string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.ensureHealthStateLocked()
	if index < 0 || index >= len(p.spec.Targets) {
		return
	}
	stats := p.statsLocked(index)
	state := &stats.earlyClose
	if state.visitors == nil {
		state.visitors = map[string]bool{}
	}
	state.count++
	if len(state.visitors) < 16 {
		state.visitors[visitor] = true
	}
	count, distinct := state.count, len(state.visitors)
	threshold := p.spec.FailureThreshold
	if threshold < 1 {
		threshold = 1
	}
	if !p.targetHealth[index] || count < threshold || distinct < 2 {
		return
	}
	target := p.spec.Targets[index]
	reason := "upstream closed before reply"
	p.targetHealth[index] = false
	p.failureSince[index] = time.Now()
	p.recoveredSince[index] = time.Time{}
	logf("failover target unhealthy rule=%d source=%d index=%d target=%s:%d reason=%s closes=%d visitors=%d", p.ruleID, p.sourcePort, index, target.TargetIP, target.TargetPort, reason, count, distinct)
	p.recordTargetEventLocked(index, "unhealthy", reason)
	p.updateFallbackActiveLocked(reason)
}

// markEarlyReply 上游正常回了：「回之前就关」的计数清零。
func (p *failoverProxy) markEarlyReply(index int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if index < 0 || index >= len(p.stats) || p.stats[index] == nil {
		return
	}
	p.stats[index].earlyClose = failoverEarlyCloseState{}
}
