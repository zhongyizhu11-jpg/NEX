// Package sockmap 把两条已建立的 TCP 连接交给 Linux 内核直接对接（sockmap +
// sk_skb 判决程序），数据不再经过进程的 read/write。NEX Agent 的自有中继和 NEX
// 自编的 gost 运行时共用这一份实现。内核不支持、没有权限、自检失败时 Relay 返回
// false，调用方照旧走用户态中继。
package sockmap

import (
	"net"
	"sync/atomic"
	"time"
)

// DefaultLinger 和 Agent 的用户态中继一致：一个方向正常结束后，另一个方向最多再
// 空闲这么久就收尾。
const DefaultLinger = 30 * time.Second

// Logf 是日志出口，默认丢弃；Agent / gost 在启动时换成自己的。
var Logf = func(format string, args ...any) {}

// Result 是一对连接两个方向各送出的字节数。
type Result struct {
	AcceptedToDialed uint64
	DialedToAccepted uint64
}

// Stats 是进程内的累计计数。
type Stats struct {
	Active    int64
	Spliced   uint64
	Fallbacks uint64
	// Throttles 是因为积压过高压住源端窗口的次数。
	Throttles uint64
	// Handoffs 是因为积压超过硬上限、把一个方向交回用户态的次数。
	Handoffs uint64
	// MaxBacklog 是观察到的单方向最大积压（字节）。
	MaxBacklog int64
}

// SetForceOff 置位后一律不接管（测试和本机诊断用）。
func SetForceOff(off bool) { forceOff.Store(off) }

var forceOff atomic.Bool

func closeWrite(conn net.Conn) {
	if c, ok := conn.(interface{ CloseWrite() error }); ok {
		_ = c.CloseWrite()
	}
}

// rateLimitedLog 让同一类日志每分钟最多一条。
type rateLimitedLog struct {
	last atomic.Int64
}

func (l *rateLimitedLog) allow() bool {
	now := time.Now().UnixNano()
	last := l.last.Load()
	if now-last < int64(time.Minute) {
		return false
	}
	return l.last.CompareAndSwap(last, now)
}

var spliceFailLog rateLimitedLog
