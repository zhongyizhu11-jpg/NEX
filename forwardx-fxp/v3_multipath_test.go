package main

import (
	"bytes"
	"crypto/rand"
	"fmt"
	"sync"
	"testing"
	"time"
)

/*
多路径（中转叠加 / 热备 / 单连接多路并发）走 NEX V3：入口、中转、出口都是 V3，而且都开着
多路复用 —— 腿照样是各自的物理连接（入口和中转都用 v3LegConfig 关掉腿上的复用，出口按第一个
字节分辨），叠加起来的带宽和 V1 一样是几条 TCP 的和。
*/

type v3MultipathLegSpec struct {
	relay   int  // 0 直连出口；n > 0 走第 n 台中转（几条腿可以共用一台）
	standby bool // 热备腿
	dead    bool // 这条腿指向一个没人听的端口（从一开始就是坏的）
}

type v3MultipathOptions struct {
	// throttle 大于 0 时按单条 TCP 连接限速（字节 / 秒）。afterRelay 为真时限速放在中转 → 出口
	// 那一跳，否则放在入口 → 第一跳。
	throttle   int
	afterRelay bool
}

// startV3MultipathTopology 起一个出口、若干中转和一个多路径入口，所有节点都用 base 里的 V3 选项。
// 返回入口的明文端口。
func startV3MultipathTopology(t *testing.T, base config, tunnelID int, specs []v3MultipathLegSpec, opts v3MultipathOptions) int {
	t.Helper()
	resetFXPEndpointRegistry()
	targetPort, stopTarget := startEchoTarget(t)
	t.Cleanup(stopTarget)
	exitKey := fmt.Sprintf("v3-multipath-exit-%d", tunnelID)
	exitPort := freeTCPPort(t)
	exitCfg := base
	exitCfg.Role, exitCfg.TunnelID, exitCfg.ListenPort, exitCfg.Protocol, exitCfg.Key = "exit", tunnelID, exitPort, "tcp", exitKey
	exitCfg.TargetIP, exitCfg.TargetPort = "127.0.0.1", targetPort
	exitDone := make(chan struct{})
	t.Cleanup(func() { close(exitDone) })
	go func() { _ = runExit(exitDone, exitCfg) }()
	waitForTCPPort(t, exitPort)

	type relayInfo struct {
		port int
		key  string
	}
	relays := map[int]relayInfo{}
	relayFor := func(n int) relayInfo {
		if info, ok := relays[n]; ok {
			return info
		}
		downstream := exitPort
		if opts.throttle > 0 && opts.afterRelay {
			downstream = startPerConnThrottle(t, exitPort, opts.throttle)
		}
		info := relayInfo{port: freeTCPPort(t), key: fmt.Sprintf("v3-multipath-relay-%d-%d", tunnelID, n)}
		relayCfg := base
		relayCfg.Role, relayCfg.TunnelID, relayCfg.ListenPort, relayCfg.Protocol, relayCfg.Key = "relay", tunnelID, info.port, "tcp", info.key
		relayCfg.RelayExitHost, relayCfg.RelayExitPort, relayCfg.RelayKey = "127.0.0.1", downstream, exitKey
		relayDone := make(chan struct{})
		t.Cleanup(func() { close(relayDone) })
		go func() { _ = runRelay(relayDone, relayCfg) }()
		waitForTCPPort(t, info.port)
		relays[n] = info
		return info
	}

	var legs []multipathLeg
	for i, spec := range specs {
		leg := multipathLeg{Host: "127.0.0.1", Port: exitPort, Key: exitKey, Via: fmt.Sprintf("direct-%d", i), Standby: spec.standby}
		if spec.relay > 0 {
			info := relayFor(spec.relay)
			leg.Port, leg.Key, leg.Via = info.port, info.key, fmt.Sprintf("relay-%d", spec.relay)
		}
		switch {
		case spec.dead:
			leg.Port = freeTCPPort(t)
		case opts.throttle > 0 && !opts.afterRelay:
			leg.Port = startPerConnThrottle(t, leg.Port, opts.throttle)
		}
		legs = append(legs, leg)
	}
	entryCfg := base
	entryCfg.Role, entryCfg.TunnelID, entryCfg.RuleID, entryCfg.ListenPort, entryCfg.Protocol = "entry", tunnelID, tunnelID+1, freeTCPPort(t), "tcp"
	entryCfg.ExitHost, entryCfg.ExitPort, entryCfg.Key = "127.0.0.1", legs[0].Port, legs[0].Key
	entryCfg.TargetIP, entryCfg.TargetPort = "127.0.0.1", targetPort
	if len(legs) >= 2 {
		entryCfg.MultipathEnabled = true
		entryCfg.MultipathLegs = legs
	}
	entryDone := make(chan struct{})
	t.Cleanup(func() { close(entryDone) })
	go func() { _ = runEntry(entryDone, entryCfg) }()
	waitForTCPPort(t, entryCfg.ListenPort)
	return entryCfg.ListenPort
}

func TestV3MultipathAggregateOverRelays(t *testing.T) {
	payload := make([]byte, 3<<20)
	_, _ = rand.Read(payload)
	for i, mode := range []string{"tls", "ws", "http"} {
		t.Run(mode, func(t *testing.T) {
			// 一条直连出口、两条各经一台中转，三个节点都开着多路复用。
			entryPort := startV3MultipathTopology(t, v3TestConfig(mode, true), 9500+10*i,
				[]v3MultipathLegSpec{{}, {relay: 1}, {relay: 2}}, v3MultipathOptions{})
			if got := echoThroughEntry(t, entryPort, payload); !bytes.Equal(got, payload) {
				t.Fatal("payload corrupted across V3 multipath legs")
			}
			var wg sync.WaitGroup
			errs := make(chan error, 8)
			for s := 0; s < 8; s++ {
				wg.Add(1)
				go func(s int) {
					defer wg.Done()
					if err := v3EchoThrough(t, entryPort, bytes.Repeat([]byte{byte(s)}, 256<<10+s)); err != nil {
						errs <- err
					}
				}(s)
			}
			wg.Wait()
			close(errs)
			for err := range errs {
				t.Fatal(err)
			}
			drain := time.Now().Add(5 * time.Second)
			for exitMultipathSessions.pendingCount() > 0 && time.Now().Before(drain) {
				time.Sleep(20 * time.Millisecond)
			}
			if n := exitMultipathSessions.pendingCount(); n != 0 {
				t.Fatalf("exit kept %d multipath sessions", n)
			}
		})
	}
}

// 热备：主腿（直连）从一开始就是坏的，热备腿（经中转）接管。
func TestV3MultipathHotStandbyTakesOver(t *testing.T) {
	entryPort := startV3MultipathTopology(t, v3TestConfig("tls", true), 9600,
		[]v3MultipathLegSpec{{dead: true}, {relay: 1, standby: true}}, v3MultipathOptions{})
	payload := make([]byte, 1<<20)
	_, _ = rand.Read(payload)
	for round := 0; round < 2; round++ {
		if got := echoThroughEntry(t, entryPort, payload); !bytes.Equal(got, payload) {
			t.Fatalf("round %d: standby leg did not carry the session", round)
		}
	}
}

// 单连接多路并发：4 条腿、链路按单条 TCP 限速。腿要是被并进同一个复用会话，4 条腿和 1 条
// 一样快；各自一条物理连接时带宽叠起来。两种放法：限速在入口 → 出口（入口没有并腿），
// 和 4 条腿共用一台中转、限速在中转 → 出口（中转也没有并腿）。
func TestV3ParallelLegsAggregatePerConnectionThrottledBandwidth(t *testing.T) {
	if testing.Short() {
		t.Skip("timing test")
	}
	const perConn = 1 << 20
	payload := make([]byte, 3<<20)
	_, _ = rand.Read(payload)
	for i, viaRelay := range []bool{false, true} {
		t.Run(fmt.Sprintf("viaRelay=%v", viaRelay), func(t *testing.T) {
			measure := func(tunnelID, legs int) time.Duration {
				specs := make([]v3MultipathLegSpec, legs)
				if viaRelay {
					for j := range specs {
						specs[j].relay = 1
					}
				}
				entryPort := startV3MultipathTopology(t, v3TestConfig("tls", true), tunnelID, specs,
					v3MultipathOptions{throttle: perConn, afterRelay: viaRelay})
				start := time.Now()
				if got := echoThroughEntry(t, entryPort, payload); !bytes.Equal(got, payload) {
					t.Fatalf("legs=%d: payload corrupted", legs)
				}
				return time.Since(start)
			}
			single := measure(9700+100*i, 1)
			parallel := measure(9710+100*i, 4)
			t.Logf("3 MiB echo over a 1 MiB/s-per-connection link on V3: single=%v, 4 parallel legs=%v", single, parallel)
			if parallel*2 > single {
				t.Fatalf("4 parallel V3 legs should be well over twice as fast as one: single=%v parallel=%v", single, parallel)
			}
		})
	}
}
