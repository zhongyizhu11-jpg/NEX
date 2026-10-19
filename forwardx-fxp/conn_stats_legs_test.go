package main

import (
	"bytes"
	"crypto/rand"
	"fmt"
	"io"
	"net"
	"testing"
	"time"
)

// 连接监控里的「每一路」：两路叠加跑完一条连接，入口报上来的 leg 行要分清是哪一路，
// 两个方向的字节数加起来等于实际传的（重复发送的也算，所以只会多不会少）。
func TestMultipathLegTrafficReachesConnStats(t *testing.T) {
	multipathLegHealthMemory.reset()
	defer multipathLegHealthMemory.reset()
	resetConnStatsForTest()
	defer resetConnStatsForTest()
	targetPort, stopTarget := startEchoTarget(t)
	defer stopTarget()

	const tunnelID = 9300
	exitKey := "multipath-legstats-exit-key"
	exitPort := freeTCPPort(t)
	exitDone := make(chan struct{})
	defer close(exitDone)
	go func() {
		_ = runExit(exitDone, config{Role: "exit", TunnelID: tunnelID, ListenPort: exitPort, Protocol: "tcp", Key: exitKey, TargetIP: "127.0.0.1", TargetPort: targetPort})
	}()
	waitForTCPPort(t, exitPort)
	startRelay := func(key string) int {
		port := freeTCPPort(t)
		done := make(chan struct{})
		t.Cleanup(func() { close(done) })
		go func() {
			_ = runRelay(done, config{Role: "relay", TunnelID: tunnelID, ListenPort: port, Protocol: "tcp", Key: key, RelayExitHost: "127.0.0.1", RelayExitPort: exitPort, RelayKey: exitKey})
		}()
		waitForTCPPort(t, port)
		return port
	}
	relayA := startRelay("multipath-legstats-relay-a")
	relayB := startRelay("multipath-legstats-relay-b")

	entryPort := freeTCPPort(t)
	entryDone := make(chan struct{})
	defer close(entryDone)
	go func() {
		_ = runEntry(entryDone, config{
			Role: "entry", TunnelID: tunnelID, RuleID: 9301, ListenPort: entryPort, Protocol: "tcp",
			PanelURL: "http://127.0.0.1:1", Token: "legstats-token",
			ExitHost: "127.0.0.1", ExitPort: exitPort, Key: exitKey, TargetIP: "127.0.0.1", TargetPort: targetPort,
			MultipathEnabled: true,
			MultipathLegs: []multipathLeg{
				{Host: "127.0.0.1", Port: relayA, Key: "multipath-legstats-relay-a", Via: "relay#2", CapacityMbps: 500},
				{Host: "127.0.0.1", Port: relayB, Key: "multipath-legstats-relay-b", Via: "relay#3", CapacityMbps: 300},
			},
		})
	}()
	waitForTCPPort(t, entryPort)

	client, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", entryPort))
	if err != nil {
		t.Fatal(err)
	}
	const size = 2 * 1024 * 1024
	payload := make([]byte, size)
	_, _ = rand.Read(payload)
	go func() { _, _ = client.Write(payload) }()
	got := make([]byte, size)
	_ = client.SetReadDeadline(time.Now().Add(15 * time.Second))
	if _, err := io.ReadFull(client, got); err != nil {
		t.Fatalf("读回失败：%v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatal("回来的数据不对")
	}
	_ = client.Close()

	// 会话收场、腿退下以后，最后一次增量也要报上来，报完从表里拿掉。
	var up, down uint64
	vias := map[string]connStatsValue{}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		time.Sleep(100 * time.Millisecond)
		for key, value := range takeConnStats() {
			if key.tunnelID != tunnelID || key.stage != "leg" {
				continue
			}
			if key.role != "entry" || key.ruleID != 9301 {
				t.Fatalf("leg 行的角色 / 规则不对：%+v", key)
			}
			current := vias[key.via]
			current.Attempts += value.Attempts
			current.Failures += value.Failures
			current.BytesUp += value.BytesUp
			current.BytesDown += value.BytesDown
			vias[key.via] = current
			up += value.BytesUp
			down += value.BytesDown
		}
		legTraffic.Lock()
		live := len(legTraffic.live)
		legTraffic.Unlock()
		if up >= size && down >= size && live == 0 {
			break
		}
	}
	if up < size || down < size {
		t.Fatalf("每一路的字节数加起来不够：上行 %d 下行 %d，应至少 %d", up, down, size)
	}
	for _, via := range []string{"relay#2", "relay#3"} {
		value, ok := vias[via]
		if !ok || value.Attempts < 1 || value.Failures != 0 {
			t.Fatalf("%s 没有拨号记录：%+v（全部 %+v）", via, value, vias)
		}
	}
	legTraffic.Lock()
	live := len(legTraffic.live)
	legTraffic.Unlock()
	if live != 0 {
		t.Fatalf("会话结束了还有 %d 路挂在流量表里", live)
	}
}

func TestMultipathLegTrafficNilIsInert(t *testing.T) {
	var traffic *multipathLegTraffic
	traffic.addUp(10)
	traffic.addDown(10)
	traffic.finish()
	if newMultipathLegTraffic(config{}, multipathLeg{Host: "127.0.0.1", Port: 1}) != nil {
		t.Fatal("没有面板地址时不该记")
	}
}
