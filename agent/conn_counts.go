package main

import (
	"bufio"
	"os"
	"strings"
)

// connectionCounts 数这台机器此刻的 TCP / UDP 连接数，给心跳带回面板。
//
// 读的是 /proc/net/tcp{,6} 和 /proc/net/udp{,6}，不走 netlink —— 两种结果一样，
// 前者在任何内核上都有，也不需要额外权限。
//
// TCP 只数「正在用」的：LISTEN（0A）是在等别人连，TIME_WAIT（06）是已经断了
// 还没回收的壳，两样都不是一条连接。一台中转机上 TIME_WAIT 动辄几千，混进去
// 这个数就看不出真实负载了。UDP 没有连接状态，每个 socket 算一个。
//
// 读不到就是 0，不报错：少一个数比整条心跳失败好。
func connectionCounts() (tcp int, udp int) {
	for _, path := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		tcp += countProcNetSockets(path, tcpConnectionState)
	}
	for _, path := range []string{"/proc/net/udp", "/proc/net/udp6"} {
		udp += countProcNetSockets(path, func(string) bool { return true })
	}
	return tcp, udp
}

func tcpConnectionState(state string) bool {
	switch state {
	case "0A", "06":
		return false
	}
	return true
}

func countProcNetSockets(path string, keep func(state string) bool) int {
	f, err := os.Open(path)
	if err != nil {
		return 0
	}
	defer f.Close()
	return countProcNetSocketLines(bufio.NewReader(f), keep)
}

// 第一行是表头；之后每行第 4 列（下标 3）是十六进制的状态码。
func countProcNetSocketLines(r *bufio.Reader, keep func(state string) bool) int {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	count := 0
	first := true
	for scanner.Scan() {
		if first {
			first = false
			continue
		}
		fields := strings.Fields(scanner.Text())
		if len(fields) < 4 {
			continue
		}
		if keep(fields[3]) {
			count++
		}
	}
	return count
}
