package main

import (
	"errors"
	"net"
	"syscall"
	"testing"
	"time"
)

type fakeTimeoutError struct{}

func (fakeTimeoutError) Error() string   { return "i/o timeout" }
func (fakeTimeoutError) Timeout() bool   { return true }
func (fakeTimeoutError) Temporary() bool { return true }

// 以前 DNS 解析失败、被拒、不可达、超时、句柄用完到面板全是「超时」；现在分开报。
func TestClassifyDialError(t *testing.T) {
	cases := []struct {
		err  error
		want string
	}{
		{nil, ""},
		{&net.OpError{Op: "dial", Err: syscall.ECONNREFUSED}, "refused"},
		{&net.OpError{Op: "dial", Err: syscall.EHOSTUNREACH}, "unreachable"},
		{&net.OpError{Op: "dial", Err: syscall.ENETUNREACH}, "unreachable"},
		{&net.OpError{Op: "dial", Err: syscall.EMFILE}, "resource"},
		{&net.OpError{Op: "dial", Err: fakeTimeoutError{}}, "timeout"},
		{&net.DNSError{Err: "no such host", Name: "x.invalid"}, "dns"},
		{errors.New("dial tcp: lookup x.invalid: no such host"), "dns"},
		{errors.New("something odd"), "error"},
	}
	for _, item := range cases {
		if got := classifyProbeDialError(item.err); got != item.want {
			t.Fatalf("%v：想要 %q，得到 %q", item.err, item.want, got)
		}
	}
}

func TestWorseProbeFailureRanks(t *testing.T) {
	if got := worseProbeFailure("timeout", "refused"); got != "refused" {
		t.Fatalf("被拒比超时更说明问题：%s", got)
	}
	if got := worseProbeFailure("dns", "timeout"); got != "dns" {
		t.Fatalf("解析失败不该被超时盖掉：%s", got)
	}
	if got := worseProbeFailure("", "error"); got != "error" {
		t.Fatalf("空的要让位：%s", got)
	}
}

// 连本机没开的端口：三次都被拒，报 refused 而不是 timeout。
func TestProbeMeasurementReportsRefused(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Skip("开不了本地端口")
	}
	port := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()
	measurement := tcpLatencyWithProbes("127.0.0.1", port, 500*time.Millisecond, 3)
	if measurement.Reachable {
		t.Fatal("关掉的端口不该通")
	}
	if measurement.Failure != "refused" {
		t.Fatalf("关掉的端口该报 refused，得到 %q", measurement.Failure)
	}
}

func TestProbeMeasurementReportsDNS(t *testing.T) {
	measurement := tcpLatencyWithProbes("nope.invalid", 443, 300*time.Millisecond, 1)
	if measurement.Reachable || measurement.Failure != "dns" {
		t.Fatalf("解析不了的域名该报 dns，得到 reachable=%v failure=%q", measurement.Reachable, measurement.Failure)
	}
}
