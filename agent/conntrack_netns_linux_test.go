//go:build linux

package main

import (
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestConntrackAccountingMatchesIptablesInNetns 用真内核核对 conntrack 计数：在一个准备好的网络
// 命名空间里（客户端 c → 本机 DNAT 8080 → 服务端 s:9000，mangle FORWARD 上挂着 fwx-stat-8080 计数
// 规则），让一条连接跑完、一条连接还开着，比较 conntrack 算出来的 in / out 和 iptables 计数器。
//
// 只在 NEX_CT_NETNS_TEST=1 时跑（CI 和普通机器上没有这套命名空间），准备脚本见 PR 说明。
func TestConntrackAccountingMatchesIptablesInNetns(t *testing.T) {
	if os.Getenv("NEX_CT_NETNS_TEST") != "1" {
		t.Skip("needs the prepared netns topology (NEX_CT_NETNS_TEST=1)")
	}
	accountant := newConntrackAccountant(newSystemConntrackSource())
	if err := accountant.start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer accountant.close()
	watched := map[int]map[string]bool{8080: {"tcp": true}}
	if _, err := accountant.sample(watched, func(string) (uint64, uint64) { return 0, 0 }); err != nil {
		t.Fatalf("first sample: %v", err)
	}
	baseIn, baseOut := iptablesStatCounters(t)

	// 一条跑完就关的连接（只能靠 DESTROY 事件补全），一条采样时还开着的连接（靠 dump）。
	runClient(t, "import socket,time\ns=socket.create_connection(('10.1.0.1',8080))\ns.sendall(b'x'*1000000)\ns.shutdown(1)\nn=0\nwhile True:\n  d=s.recv(65536)\n  if not d: break\n  n+=len(d)\nprint(n)\n")
	long := exec.Command("ip", "netns", "exec", "c", "python3", "-c", "import socket,time\ns=socket.create_connection(('10.1.0.1',8080))\ns.sendall(b'y'*300000)\ntime.sleep(6)\n")
	if err := long.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = long.Process.Kill(); _, _ = long.Process.Wait() }()
	time.Sleep(2 * time.Second)
	// 第一条连接 TIME_WAIT 之后才 DESTROY；conntrack -D 让它立刻结束，走事件那条路。
	_ = exec.Command("conntrack", "-D", "-p", "tcp", "--orig-port-dst", "8080", "--state", "TIME_WAIT").Run()
	time.Sleep(500 * time.Millisecond)

	totals, err := accountant.sample(watched, func(string) (uint64, uint64) { return 0, 0 })
	if err != nil {
		t.Fatalf("sample: %v", err)
	}
	gotIn, gotOut := totals["8080"].In, totals["8080"].Out
	iptIn, iptOut := iptablesStatCounters(t)
	wantIn, wantOut := iptIn-baseIn, iptOut-baseOut
	t.Logf("conntrack in=%d out=%d, iptables in=%d out=%d, status=%+v", gotIn, gotOut, wantIn, wantOut, accountant.status())
	if wantIn < 1300000 {
		t.Fatalf("iptables saw only %d bytes in; topology not forwarding?", wantIn)
	}
	// conntrack 还多算了 SYN 和被 FORWARD 匹配之外的少量包；两边差不超过 1%。
	for _, pair := range [][2]uint64{{gotIn, wantIn}, {gotOut, wantOut}} {
		diff := int64(pair[0]) - int64(pair[1])
		if diff < 0 {
			diff = -diff
		}
		if float64(diff) > float64(pair[1])*0.01+2000 {
			t.Fatalf("conntrack %d vs iptables %d differ too much", pair[0], pair[1])
		}
	}
}

func runClient(t *testing.T, script string) {
	t.Helper()
	out, err := exec.Command("ip", "netns", "exec", "c", "python3", "-c", script).CombinedOutput()
	if err != nil {
		t.Fatalf("client: %v %s", err, out)
	}
}

var iptablesStatLine = regexp.MustCompile(`^\s*(\d+)\s+(\d+)\s.*fwx-stat-8080:(in|out)`)

func iptablesStatCounters(t *testing.T) (uint64, uint64) {
	t.Helper()
	out, err := exec.Command("iptables", "-t", "mangle", "-L", "FORWARD", "-v", "-x", "-n").CombinedOutput()
	if err != nil {
		t.Fatalf("iptables: %v %s", err, out)
	}
	var in, outBytes uint64
	for _, line := range strings.Split(string(out), "\n") {
		m := iptablesStatLine.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		value, _ := strconv.ParseUint(m[2], 10, 64)
		if m[3] == "in" {
			in = value
		} else {
			outBytes = value
		}
	}
	return in, outBytes
}
