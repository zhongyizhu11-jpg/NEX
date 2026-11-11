package main

import (
	"errors"
	"fmt"
	"net"
	"os"
	"syscall"
	"testing"
	"time"
)

func TestClassifyIPv6ListenProbe(t *testing.T) {
	afErr := &net.OpError{Op: "listen", Net: "tcp6", Err: os.NewSyscallError("socket", syscall.EAFNOSUPPORT)}
	cases := []struct {
		name   string
		err    error
		procOK bool
		want   bool
	}{
		{"bind ok", nil, true, true},
		{"bind ok without proc file", nil, false, true},
		{"kernel ipv6.disable=1", afErr, false, false},
		{"EAFNOSUPPORT even if proc file exists", afErr, true, false},
		{"EPROTONOSUPPORT", fmt.Errorf("wrap: %w", syscall.EPROTONOSUPPORT), true, false},
		{"transient EMFILE keeps default", os.NewSyscallError("socket", syscall.EMFILE), true, true},
		{"unknown error and no proc file", errors.New("boom"), false, false},
	}
	for _, tc := range cases {
		if got := classifyIPv6ListenProbe(tc.err, tc.procOK); got != tc.want {
			t.Errorf("%s: got %v want %v", tc.name, got, tc.want)
		}
	}
}

func TestIPv6ListenAvailableCachesProbe(t *testing.T) {
	oldProbe, oldProc, oldNow := ipv6ListenProbe, ipv6ProcExists, ipv6ListenNow
	t.Cleanup(func() {
		ipv6ListenProbe, ipv6ProcExists, ipv6ListenNow = oldProbe, oldProc, oldNow
		resetIPv6ListenCacheForTest()
	})
	resetIPv6ListenCacheForTest()
	now := time.Unix(1_800_000_000, 0)
	calls := 0
	probeErr := error(os.NewSyscallError("socket", syscall.EAFNOSUPPORT))
	ipv6ListenProbe = func() error { calls++; return probeErr }
	ipv6ProcExists = func() bool { return false }
	ipv6ListenNow = func() time.Time { return now }

	if ipv6ListenAvailable() {
		t.Fatal("EAFNOSUPPORT must report ipv6 unavailable")
	}
	now = now.Add(time.Minute)
	probeErr = nil
	if ipv6ListenAvailable() || calls != 1 {
		t.Fatalf("result should be cached within the recheck interval (calls=%d)", calls)
	}
	now = now.Add(ipv6ListenRecheckInterval)
	if !ipv6ListenAvailable() || calls != 2 {
		t.Fatalf("expected re-probe after interval to see ipv6 again (calls=%d)", calls)
	}
}

// 真探测：在这台机器上跑一次，结果要和「能不能开 AF_INET6 套接字」一致。
func TestProbeIPv6ListenMatchesSocketSupport(t *testing.T) {
	fd, err := syscall.Socket(syscall.AF_INET6, syscall.SOCK_STREAM, 0)
	socketOK := err == nil
	if socketOK {
		syscall.Close(fd)
	}
	probeErr := probeIPv6Listen()
	got := classifyIPv6ListenProbe(probeErr, true)
	t.Logf("AF_INET6 socket ok=%v probe err=%v -> ipv6Listen=%v", socketOK, probeErr, got)
	if !socketOK && got {
		t.Fatalf("AF_INET6 socket fails here (%v) but probe reported ipv6 available", err)
	}
	if socketOK && !got {
		t.Fatalf("AF_INET6 socket works here but probe reported ipv6 unavailable")
	}
}
