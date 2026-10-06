//go:build linux

package main

import (
	"net"
	"os"
	"strings"
	"syscall"
	"testing"
	"unsafe"
)

// getTCPCongestion 读回一条连接当前的拥塞控制算法名。标准库的 syscall 没有
// GetsockoptString，这里直接走 getsockopt。
func getTCPCongestion(conn *net.TCPConn) (string, error) {
	raw, err := conn.SyscallConn()
	if err != nil {
		return "", err
	}
	var name string
	var getErr error
	if err := raw.Control(func(fd uintptr) {
		buf := make([]byte, 16)
		size := uint32(len(buf))
		_, _, errno := syscall.Syscall6(
			syscall.SYS_GETSOCKOPT, fd, syscall.IPPROTO_TCP, syscall.TCP_CONGESTION,
			uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size)), 0,
		)
		if errno != 0 {
			getErr = errno
			return
		}
		name = strings.TrimRight(string(buf[:size]), "\x00")
	}); err != nil {
		return "", err
	}
	return name, getErr
}

func readSysctl(path string) (string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(raw)), nil
}

func TestSetTCPCongestionAppliesToTheSocket(t *testing.T) {
	available, _ := readSysctl("/proc/sys/net/ipv4/tcp_available_congestion_control")
	for _, name := range []string{"bbr", "cubic", "reno"} {
		if !strings.Contains(" "+available+" ", " "+name+" ") {
			continue
		}
		client, _ := loopbackTCPPair(t)
		if err := setTCPCongestion(client, name); err != nil {
			t.Skipf("cannot set %s here: %v", name, err)
		}
		got, err := getTCPCongestion(client)
		if err != nil {
			t.Fatal(err)
		}
		if got != name {
			t.Fatalf("socket reports %q after setting %q", got, name)
		}
	}
}

func TestTuneTCPCongestionGivesUpAfterTheFirstFailure(t *testing.T) {
	t.Cleanup(func() { applyTCPCongestionConfig(config{TCPCongestion: "off"}) })
	bogus := "no-such-cc-algorithm"
	fxpTCPCongestion.mu.Lock()
	fxpTCPCongestion.name.Store(&bogus)
	fxpTCPCongestion.disabled.Store(false)
	fxpTCPCongestion.logged.Store(false)
	fxpTCPCongestion.mu.Unlock()
	client, _ := loopbackTCPPair(t)
	tuneTCPCongestion(client)
	if !fxpTCPCongestion.disabled.Load() {
		t.Fatal("an algorithm the kernel does not have must disable further attempts")
	}
	// 重新按配置算过之后再试。
	applyTCPCongestionConfig(config{TCPCongestion: "off"})
	if fxpTCPCongestion.disabled.Load() {
		t.Fatal("re-applying the config must reset the disabled flag")
	}
}
