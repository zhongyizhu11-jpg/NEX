//go:build unix

package main

import (
	"os"
	"strconv"
	"strings"
	"syscall"
)

// processOpenFileLimit 是这个进程的文件句柄软上限；读不到返回 0。
func processOpenFileLimit() uint64 {
	var limit syscall.Rlimit
	if err := syscall.Getrlimit(syscall.RLIMIT_NOFILE, &limit); err != nil {
		return 0
	}
	return uint64(limit.Cur)
}

// processRSSBytes 是这个进程的常驻内存（/proc/self/statm 第二列 × 页大小）；读不到返回 0。
func processRSSBytes() uint64 {
	raw, err := os.ReadFile("/proc/self/statm")
	if err != nil {
		return 0
	}
	fields := strings.Fields(string(raw))
	if len(fields) < 2 {
		return 0
	}
	pages, err := strconv.ParseUint(fields[1], 10, 64)
	if err != nil {
		return 0
	}
	return pages * uint64(os.Getpagesize())
}
