package main

import (
	"fmt"
	"io"
	"net"
	"strings"
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
访客地址从 PROXY 头里读（readVisitor：规则带 PROXY 头、或面板让前面的转发工具专门加给调度器的都读）；
读不到时看到的全是 127.0.0.1，这时**不靠它判坏**（failoverVisitorKnown），只换路。
真正的「下一跳断了」由中转机的快速探测（route_hop_probe.go）报，几秒内就到。
*/

const (
	failoverEarlyGuardWindow   = 8 * time.Second
	failoverEarlyReplayLimit   = 64 * 1024
	failoverEarlyMaxRetries    = 3
	failoverEarlyReadChunkSize = 32 * 1024
	// 「回之前就关」最多记几个不同的访客：判坏只要两个，多记几个只为日志里看得出是不是很多人。
	failoverEarlyMaxVisitors = 16
)

type failoverEarlyChunk struct {
	data []byte
	err  error
}

type failoverEarlyCloseState struct {
	count    int
	visitors map[string]bool
}

// 保护期的结局。
type failoverGuardOutcome int

const (
	// 这条连接没救了（已经关掉上游，调用方关客户端）。
	failoverGuardFailed failoverGuardOutcome = iota
	// 交给平常的双向转发：返回的连接和下标就是最终在用的。
	failoverGuardRelay
	// 上游回了东西以后自己断了：回的东西已经原样交给客户端、收了尾，调用方只管关客户端（返回的下标是交付的那条）。
	failoverGuardDelivered
)

const (
	// 写上游失败时，等那次还挂着的读（上游可能已经回了东西）最多这么久。写都失败了，读会立刻返回，这只是兜底。
	failoverEarlyPendingReadWait = time.Second
	// 回复交给客户端以后，再读它还在上传的数据最多这么久再关：不读完就关，内核会给客户端发 RST，
	// 有的系统上 RST 会把客户端还没读走的回复一起冲掉。
	failoverEarlyDrainLinger = 2 * time.Second
)

/*
guardedStart 接管 upstream：写 prefix、进保护期、必要时换路。

换路重发只有一种情况是安全的：上游**一个字节都没回**就断了（EOF / RST / 写不进去）。只要从上游读到过任何
东西，这条连接就再也不换路 —— 读到的原样交给客户端，然后正常收尾（E1）。

以前有个口子：客户端还在上传（POST 大请求体）、上游已经回了「HTTP/1.1 401…」并关了连接，这时再往上游写会
失败，旧代码在写失败的分支里把那次挂着的读**直接扔掉**、当成「回之前就关」，把请求重发给下一条路径 ——
客户端收不到 401，落地却多收到一遍请求（非幂等的请求被执行两次）。300 次里能撞上近 200 次。
*/
func (p *failoverProxy) guardedStart(client net.Conn, upstream net.Conn, index int, visitor string, attempted map[int]bool, prefix []byte) (net.Conn, int, failoverGuardOutcome) {
	if attempted == nil {
		attempted = map[int]bool{}
	}
	replay := append([]byte(nil), prefix...)
	replayOK := len(replay) <= failoverEarlyReplayLimit
	// 先挂上读上游的那一次，再写 prefix：prefix 写失败时同样要先看上游是不是已经回了东西。
	upstreamFirst := p.readUpstreamFirst(upstream)

	clientChunks := make(chan failoverEarlyChunk, 8)
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
	// 读客户端的那个 goroutine 退了没有（读到 EOF / 出错，或者被 stopClientReader 停掉）。
	clientDone := false
	// 停掉读客户端的 goroutine；它已经读到的数据交给 sink（返回 false 之后的不再给）。之后 client 可以直接读。
	stopClientReader := func(sink func(data []byte) bool) {
		if clientDone {
			return
		}
		_ = client.SetReadDeadline(time.Now())
		keep := true
		for chunk := range clientChunks {
			if len(chunk.data) > 0 && keep && sink != nil {
				keep = sink(chunk.data)
			}
			if chunk.err != nil {
				break
			}
		}
		_ = client.SetReadDeadline(time.Time{})
		clientDone = true
	}
	// 上游回了东西以后断了（或者写不进去了）：first 交给客户端，上游剩下的也读完交过去，然后收尾。
	deliver := func(first []byte) (net.Conn, int, failoverGuardOutcome) {
		p.markEarlyReply(index)
		stopClientReader(nil)
		return nil, index, failoverDeliverAndClose(client, upstream, first)
	}
	// 写上游失败：取回那次挂着的读。读到了东西就不能换路。
	pendingReply := func() []byte {
		if upstreamFirst == nil {
			return nil
		}
		_ = upstream.SetReadDeadline(time.Now().Add(failoverEarlyPendingReadWait))
		result := <-upstreamFirst
		upstreamFirst = nil
		return result.data
	}
	retries := 0
	// 上游一个字节没回就断了：换路。成功以后重新挂上读。
	reroute := func() bool {
		next, nextIndex, ok := p.earlyReroute(client, upstream, index, visitor, attempted, replay, replayOK, retries)
		if !ok {
			return false
		}
		retries++
		upstream, index = next, nextIndex
		upstreamFirst = p.readUpstreamFirst(upstream)
		return true
	}

	if len(prefix) > 0 {
		if _, err := upstream.Write(prefix); err != nil {
			if data := pendingReply(); len(data) > 0 {
				return deliver(data)
			}
			if !reroute() {
				stopClientReader(nil)
				return nil, -1, failoverGuardFailed
			}
		}
	}

	deadline := time.NewTimer(failoverEarlyGuardWindow)
	defer deadline.Stop()

	handoff := func() (net.Conn, int, failoverGuardOutcome) {
		// 停掉读客户端的那个 goroutine：读到的都转给上游。
		writeFailed := false
		stopClientReader(func(data []byte) bool {
			if _, err := upstream.Write(data); err != nil {
				writeFailed = true
				return false
			}
			return true
		})
		// 还在等上游第一个字节的那次读：让它立刻返回，读到的补给客户端。
		var first []byte
		replied := upstreamFirst == nil
		if upstreamFirst != nil {
			if writeFailed {
				first = pendingReply()
			} else {
				_ = upstream.SetReadDeadline(time.Now())
				result := <-upstreamFirst
				upstreamFirst = nil
				first = result.data
			}
			_ = upstream.SetReadDeadline(time.Time{})
			replied = len(first) > 0
		}
		if writeFailed {
			if replied {
				// 上游回过东西、现在写不进去了：把它回的交完就收尾，不换路、也不让客户端看到一个 RST。
				return deliver(first)
			}
			_ = upstream.Close()
			return nil, -1, failoverGuardFailed
		}
		if len(first) > 0 {
			p.markEarlyReply(index)
			if _, err := client.Write(first); err != nil {
				_ = upstream.Close()
				return nil, -1, failoverGuardFailed
			}
		}
		return upstream, index, failoverGuardRelay
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
					// 写不进去：上游已经断了。先看它断之前回没回东西 —— 回了就交给客户端、收尾，绝不重发；
					// 一个字节没回才按「回之前就关」换路。
					if data := pendingReply(); len(data) > 0 {
						return deliver(data)
					}
					if !reroute() {
						stopClientReader(nil)
						return nil, -1, failoverGuardFailed
					}
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
					stopClientReader(nil)
					return nil, -1, failoverGuardFailed
				}
				return handoff()
			}
			// 回任何东西之前上游就关了：这一条当场换路，留着的数据重发过去。
			if !reroute() {
				stopClientReader(nil)
				return nil, -1, failoverGuardFailed
			}
		case <-deadline.C:
			return handoff()
		}
	}
}

/*
failoverDeliverAndClose 上游回了东西以后断了：把它回的（first 和之后还读得到的）交给客户端，然后体面地收尾 ——
先半关闭写方向（客户端读到 EOF，知道回复完了），再把客户端还在发的数据读掉一小会儿，最后才关。
客户端还在上传时直接关，内核会回 RST；客户端要是还没把回复读走，有的系统会连回复一起丢。
调用前读客户端的 goroutine 必须已经停了（这里直接读 client）。上游在这里关掉；客户端由调用方关。
*/
func failoverDeliverAndClose(client net.Conn, upstream net.Conn, first []byte) failoverGuardOutcome {
	defer upstream.Close()
	drained := make(chan struct{})
	go func() {
		defer close(drained)
		_, _ = io.Copy(io.Discard, client)
	}()
	finish := func(outcome failoverGuardOutcome) failoverGuardOutcome {
		closeTCPWrite(client)
		_ = client.SetReadDeadline(time.Now().Add(failoverEarlyDrainLinger))
		<-drained
		_ = client.SetReadDeadline(time.Time{})
		return outcome
	}
	if len(first) > 0 {
		if _, err := client.Write(first); err != nil {
			return finish(failoverGuardFailed)
		}
	}
	// 上游可能还有没读完的回复（一次 Read 没读全）：读到它结束为止，中间闲太久就算完。
	buf := make([]byte, failoverEarlyReadChunkSize)
	for {
		_ = upstream.SetReadDeadline(time.Now().Add(tcpRelayHalfCloseLinger))
		n, err := upstream.Read(buf)
		if n > 0 {
			if _, werr := client.Write(buf[:n]); werr != nil {
				return finish(failoverGuardFailed)
			}
		}
		if err != nil {
			break
		}
	}
	return finish(failoverGuardDelivered)
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

/*
earlyReroute 关掉回之前就断了的上游，记一笔，换下一条路径并重发留着的数据。拨新路径和建连接时一样记在途
（dialNextPathReserved），拨通后这条客户端连接当场记到新路径名下（以前要等保护期结束才挪，最长 8 秒里还算在
旧路径头上；拨的时候也不记在途，一批一起换路的连接互相看不见）。
*/
func (p *failoverProxy) earlyReroute(client net.Conn, upstream net.Conn, index int, visitor string, attempted map[int]bool, replay []byte, replayOK bool, retries int) (net.Conn, int, bool) {
	_ = upstream.Close()
	p.markEarlyClose(index, visitor)
	attempted[index] = true
	if !replayOK || retries >= failoverEarlyMaxRetries {
		return nil, -1, false
	}
	next, nextIndex, reservation, err := p.dialNextPathReserved(visitor, attempted, func(conn net.Conn) error {
		if len(replay) == 0 {
			return nil
		}
		_, err := conn.Write(replay)
		return err
	})
	if err != nil {
		return nil, -1, false
	}
	p.moveConnReserved(client, nextIndex, reservation)
	logf("failover early close rerouted rule=%d source=%d from=%d to=%d replay=%dB", p.ruleID, p.sourcePort, index, nextIndex, len(replay))
	return next, nextIndex, true
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
	// 访客地址不知道（没带 PROXY 头，看到的只是前面那个转发工具的 127.0.0.1）时不记：所有人都是同一个
	// 「访客」，凑不出两个不同的，也就永远不会靠这个判坏 —— 宁可不判，也不假装知道是两个人。
	if failoverVisitorKnown(visitor) && len(state.visitors) < failoverEarlyMaxVisitors {
		state.visitors[visitor] = true
	}
	// 出口组：不靠「两个不同访客」，经这台出口再探一次，又被关才判坏（failover_exit_group.go）。
	if p.exitGroupLocked() {
		p.startExitConfirmLocked(index)
		return
	}
	count, distinct := state.count, len(state.visitors)
	threshold := p.spec.FailureThreshold
	if threshold < 1 {
		threshold = 1
	}
	if !p.targetHealth[index] || count < threshold || distinct < 2 {
		return
	}
	reason := "upstream closed before reply"
	p.markUnhealthyLocked(index, reason, fmt.Sprintf(" closes=%d visitors=%d", count, distinct))
	p.updateFallbackActiveLocked(reason)
}

// failoverVisitorKnown 这个访客地址是不是真的访客（不是空的、不是本机）。调度器只监听 127.0.0.1，
// 没从 PROXY 头里读到访客时拿到的就是本机地址。
func failoverVisitorKnown(visitor string) bool {
	ip := net.ParseIP(strings.Trim(strings.TrimSpace(visitor), "[]"))
	return ip != nil && !ip.IsLoopback() && !ip.IsUnspecified()
}

// markEarlyReply 上游正常回了：「回之前就关」的计数清零。出口组里经出口判坏过的出口（真实连接试探它，见
// exitCanaryIndexLocked）回了东西就是走得通：当场放回。
func (p *failoverProxy) markEarlyReply(index int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if index < 0 || index >= len(p.stats) || p.stats[index] == nil {
		return
	}
	p.stats[index].earlyClose = failoverEarlyCloseState{}
	p.exitCanaryRepliedLocked(index)
}
