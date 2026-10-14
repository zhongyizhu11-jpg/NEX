//go:build unix

package main

import (
	"syscall"
	"time"
)

// processCPUTime 返回本进程到现在为止用掉的 CPU 时间（用户态 + 内核态）。基准测试里用它算
// 每个数据报花了多少 CPU：机器被夹具跑满时墙钟吞吐看不出中继省了多少，CPU 看得出。
func processCPUTime() time.Duration {
	var usage syscall.Rusage
	if err := syscall.Getrusage(syscall.RUSAGE_SELF, &usage); err != nil {
		return 0
	}
	return time.Duration(usage.Utime.Nano() + usage.Stime.Nano())
}
