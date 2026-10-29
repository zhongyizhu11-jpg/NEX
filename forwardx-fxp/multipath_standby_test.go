package main

// 热备腿（multipathLeg.Standby）：
//   · 主腿健康时热备腿一片都不送，只挂着；
//   · 主腿一声不响地停住（写得进去、送不到、也不报错），热备腿几百毫秒内接手，流不断；
//   · 一开始主腿就拨不通，热备腿当主腿用。

import (
	"bytes"
	"encoding/json"
	"net"
	"testing"
	"time"
)

// markStandby flags the legs at the given positions on both ends as standby.
func markStandby(client, server *multipathSession, indexes ...int) {
	for _, session := range []*multipathSession{client, server} {
		session.mu.Lock()
		for _, index := range indexes {
			session.legs[index].standby = true
		}
		session.mu.Unlock()
	}
}

func TestMultipathStandbyLegStaysIdleWhilePrimaryIsHealthy(t *testing.T) {
	client, server := newWrappedMultipathPair(t, 2, 256, nil)
	markStandby(client, server, 1)

	streamAndVerify(t, client, server, 600, 1024, -1, func() {})

	sent := client.legBytes()
	if sent[0] == 0 {
		t.Fatal("主腿一片都没送")
	}
	if sent[1] != 0 {
		t.Fatalf("主腿好好的，热备腿却送了 %d 字节", sent[1])
	}
}

func TestMultipathStandbyLegTakesOverWhenPrimaryGoesSilent(t *testing.T) {
	// 主腿变成黑洞：写成功、送不到、不报错 —— 这是线路在半路断掉时写入者看到的样子。
	// 热备腿要在 multipathStandbyTakeover 量级的时间里接手，整条流照样拼完。
	var hole *swallowConn
	client, server := newWrappedMultipathPair(t, 2, 256, func(index int, conn net.Conn) net.Conn {
		if index != 0 {
			return conn
		}
		hole = &swallowConn{Conn: conn}
		return hole
	})
	markStandby(client, server, 1)
	server.reorder.setStallTuning(multipathReorderStallGrace, multipathReorderOverdraftChunks, time.Minute)

	var armedAt time.Time
	streamAndVerify(t, client, server, 2000, 1024, 300, func() {
		armedAt = time.Now()
		hole.armed.Store(true)
	})
	took := time.Since(armedAt)

	if hole.swallowed.Load() == 0 {
		t.Fatal("主腿一片都没吞：用例没逼出要测的局面")
	}
	if client.legBytes()[1] == 0 {
		t.Fatal("主腿停了，热备腿却没接手")
	}
	// 接管门槛 300ms + 重发等待，再加上余下 1700 片在管道上走的时间；远小于 5 秒的腿静默超时，
	// 说明接手靠的是热备逻辑，不是等主腿被摘掉。
	if took > 3*time.Second {
		t.Fatalf("主腿停住后流又走了 %s 才结束，热备腿接手太慢", took)
	}
}

func TestMultipathStandbyLegCarriesEverythingWhenNoPrimaryIsAlive(t *testing.T) {
	client, server := newWrappedMultipathPair(t, 2, 256, nil)
	markStandby(client, server, 1)
	// 主腿一开始就断了：热备腿就是唯一能走的腿，必须当主腿用。
	client.legs[0].sec.conn.Close()
	server.legs[0].sec.conn.Close()

	payload := bytes.Repeat([]byte("only-standby;"), 64)
	received := make(chan []byte, 1)
	go func() {
		data, _ := drainStream(server)
		received <- data
	}()
	for i := 0; i < 50; i++ {
		if err := client.writeFrame(payload); err != nil {
			t.Fatalf("writeFrame %d: %v", i, err)
		}
	}
	if err := client.writeFrame(nil); err != nil {
		t.Fatalf("fin: %v", err)
	}
	select {
	case got := <-received:
		if !bytes.Equal(got, bytes.Repeat(payload, 50)) {
			t.Fatalf("stream corrupted: got %d bytes", len(got))
		}
	case <-time.After(15 * time.Second):
		t.Fatal("只剩热备腿时流没有走完")
	}
}

func TestMultipathHelloCarriesLegStandby(t *testing.T) {
	frame, _ := json.Marshal(helloFrame{MultipathSessionID: "s", MultipathLegIndex: 1, MultipathLegStandby: true})
	var got helloFrame
	if err := json.Unmarshal(frame, &got); err != nil || !got.MultipathLegStandby {
		t.Fatalf("hello 里的热备标记丢了：%s", frame)
	}
	frame, _ = json.Marshal(helloFrame{MultipathSessionID: "s"})
	var plain map[string]any
	_ = json.Unmarshal(frame, &plain)
	if _, ok := plain["multipathLegStandby"]; ok {
		t.Fatal("不是热备腿时不该出现这个字段（老出口照旧）")
	}
}

// startStandbyTopology 起一套入口 → {直连出口（主腿）, 经中转（热备腿）} → 出口 → 回显目标。
// primaryPort 为 0 时主腿直连出口；否则主腿拨这个端口（用来模拟主腿一开始就不通）。
func startStandbyTopology(t *testing.T, primaryPort int) int {
	t.Helper()
	targetPort, stopTarget := startEchoTarget(t)
	t.Cleanup(stopTarget)

	const tunnelID = 9300
	exitKey := "multipath-standby-exit-key"
	exitPort := freeTCPPort(t)
	exitDone := make(chan struct{})
	t.Cleanup(func() { close(exitDone) })
	go func() {
		_ = runExit(exitDone, config{
			Role:       "exit",
			TunnelID:   tunnelID,
			ListenPort: exitPort,
			Protocol:   "tcp",
			Key:        exitKey,
			TargetIP:   "127.0.0.1",
			TargetPort: targetPort,
		})
	}()
	waitForTCPPort(t, exitPort)

	relayKey := "multipath-standby-relay-key"
	relayPort := freeTCPPort(t)
	relayDone := make(chan struct{})
	t.Cleanup(func() { close(relayDone) })
	go func() {
		_ = runRelay(relayDone, config{
			Role:          "relay",
			TunnelID:      tunnelID,
			ListenPort:    relayPort,
			Protocol:      "tcp",
			Key:           relayKey,
			RelayExitHost: "127.0.0.1",
			RelayExitPort: exitPort,
			RelayKey:      exitKey,
		})
	}()
	waitForTCPPort(t, relayPort)

	if primaryPort == 0 {
		primaryPort = exitPort
	}
	entryPort := freeTCPPort(t)
	entryDone := make(chan struct{})
	t.Cleanup(func() { close(entryDone) })
	go func() {
		_ = runEntry(entryDone, config{
			Role:             "entry",
			TunnelID:         tunnelID,
			RuleID:           9301,
			ListenPort:       entryPort,
			Protocol:         "tcp",
			ExitHost:         "127.0.0.1",
			ExitPort:         exitPort,
			Key:              exitKey,
			TargetIP:         "127.0.0.1",
			TargetPort:       targetPort,
			MultipathEnabled: true,
			MultipathLegs: []multipathLeg{
				{Host: "127.0.0.1", Port: primaryPort, Key: exitKey, Via: "direct"},
				{Host: "127.0.0.1", Port: relayPort, Key: relayKey, Via: "relay-standby", Standby: true},
			},
		})
	}()
	waitForTCPPort(t, entryPort)
	return entryPort
}

func TestMultipathStandbyTopologyEchoesThroughPrimary(t *testing.T) {
	entryPort := startStandbyTopology(t, 0)
	payload := bytes.Repeat([]byte("primary-with-standby;"), 2048)
	if got := echoThroughEntry(t, entryPort, payload); !bytes.Equal(got, payload) {
		t.Fatalf("payload mismatch: got %d bytes", len(got))
	}
}

func TestMultipathStandbyTopologyEchoesWhenPrimaryIsDownFromTheStart(t *testing.T) {
	// 主腿拨不通：热备腿是唯一能走的，会话必须在它上面起来并把数据送到。
	entryPort := startStandbyTopology(t, freeTCPPort(t))
	payload := bytes.Repeat([]byte("standby-only;"), 2048)
	if got := echoThroughEntry(t, entryPort, payload); !bytes.Equal(got, payload) {
		t.Fatalf("payload mismatch: got %d bytes", len(got))
	}
}
