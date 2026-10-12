package main

import (
	"errors"
	"io"
	"net"
	"sync/atomic"
	"time"
)

// tcpRelayHalfCloseLinger 和 FXP 数据面的 fxpHalfCloseLinger 保持一致：一个方向
// 正常读到 EOF（对端半关闭）以后，另一个方向最多再空闲这么久就强制收尾。
const tcpRelayHalfCloseLinger = 30 * time.Second

type tcpRelayResult struct {
	dst net.Conn
	err error
}

// relayTCPBidirectional 在 client 和 upstream 之间双向转发，直到两个方向都结束。
//
// 一个方向读到 EOF 时只对另一端做 CloseWrite（把半关闭传下去），另一个方向继续
// 转发 —— 客户端 shutdown(SHUT_WR) 后再等响应（curl / HTTP/1.0 / nc -N）不会被截断。
// 为了防止对端永远不关导致 goroutine 被钉住，剩下的方向进入 linger：读空闲超过
// linger 就结束；期间只要还有数据在走就续期，所以半关闭后的大响应不会被掐断。
// （第一次超时时 io.Copy 的计数包含 linger 之前的字节，所以完全空闲的对端最多
// 被多留一个 linger 周期，即上界约 2*linger。）只设读超时：读超时不会丢数据，
// 续期后接着 Copy 是安全的；写超时可能丢掉已读未写的字节，不能续期。
// 第一个结束的方向如果是出错（不是 EOF），两边立刻关闭。
//
// 返回前两端都会被 Close。
func relayTCPBidirectional(client net.Conn, upstream net.Conn, linger time.Duration) {
	defer client.Close()
	defer upstream.Close()
	if linger <= 0 {
		linger = tcpRelayHalfCloseLinger
	}
	var lingering atomic.Bool
	results := make(chan tcpRelayResult, 2)
	pipe := func(dst net.Conn, src net.Conn) {
		var err error
		for {
			var n int64
			n, err = io.Copy(dst, src)
			// linger 期间的超时：这一段里有数据走过就续期，完全空闲才算结束。
			if err != nil && n > 0 && lingering.Load() && isNetTimeout(err) {
				armTCPRelayLinger(src, linger)
				continue
			}
			break
		}
		if err == nil {
			closeTCPWrite(dst)
		}
		results <- tcpRelayResult{dst: dst, err: err}
	}
	go pipe(upstream, client)
	go pipe(client, upstream)

	first := <-results
	if first.err != nil {
		// 出错（RST、写失败等）不是半关闭，没必要再等另一个方向。
		return
	}
	lingering.Store(true)
	// 剩下的方向从 first.dst 读。
	armTCPRelayLinger(first.dst, linger)
	<-results
}

func armTCPRelayLinger(src net.Conn, linger time.Duration) {
	_ = src.SetReadDeadline(time.Now().Add(linger))
}

func closeTCPWrite(conn net.Conn) {
	if c, ok := conn.(interface{ CloseWrite() error }); ok {
		_ = c.CloseWrite()
	}
}

func isNetTimeout(err error) bool {
	var netErr net.Error
	return errors.As(err, &netErr) && netErr.Timeout()
}
