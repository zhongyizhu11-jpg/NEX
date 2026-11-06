//go:build unix

package main

import (
	"syscall"
	"time"
)

// dpProcessCPUTime 返回本进程到现在为止用掉的 CPU 时间（用户态 + 内核态）。
func dpProcessCPUTime() time.Duration {
	var usage syscall.Rusage
	if err := syscall.Getrusage(syscall.RUSAGE_SELF, &usage); err != nil {
		return 0
	}
	return time.Duration(usage.Utime.Nano() + usage.Stime.Nano())
}
