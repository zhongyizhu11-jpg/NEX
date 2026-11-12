package main

import (
	"fmt"
	"testing"
	"time"

	v3 "github.com/zhongyizhu11-jpg/NEX/forwardx-fxp/internal/v3"
)

/*
NEX 修订的接入层行为：TLS 外层时内层直通（模式 4）、HTTP / WS 外层时内层 AEAD（模式 3）；
出口按第一个字节分辨复用 / 不复用；复用时规则一起来就预热好一条会话。
*/

// 真起一个 V3 出口，拨一条物理连接，看握手协商出的内层模式。
func TestV3InnerModeFollowsOuterTransport(t *testing.T) {
	for _, tc := range []struct {
		mode      string
		forceAEAD bool
		wantPlain bool
	}{
		{"tls", false, true},
		{"tls", true, false},
		{"ws", false, false},
		{"http", false, false},
	} {
		t.Run(fmt.Sprintf("%s/forceAEAD=%v", tc.mode, tc.forceAEAD), func(t *testing.T) {
			old := v3TLSInnerAEAD.Load()
			v3TLSInnerAEAD.Store(tc.forceAEAD)
			t.Cleanup(func() { v3TLSInnerAEAD.Store(old) })
			resetFXPEndpointRegistry()
			route := startV3Route(t, v3TestConfig(tc.mode, false), 3700, 37000, "mode-key", "mode-key")
			raw, inner, err := dialV3Inner("127.0.0.1", route.exitPort, route.cfg)
			if err != nil {
				t.Fatal(err)
			}
			defer raw.Close()
			if inner.Plain() != tc.wantPlain {
				t.Fatalf("plain=%v want %v (mode byte %d)", inner.Plain(), tc.wantPlain, inner.Mode())
			}
			// 两种模式都要真能跑业务。
			if err := v3EchoThrough(t, route.entryPort, make([]byte, 1<<20)); err != nil {
				t.Fatal(err)
			}
		})
	}
}

// 两端复用的设置不一样（比如面板改了配置、一端先重载），出口照第一个字节走，照样连得通。
func TestV3ExitFollowsClientMultiplexChoice(t *testing.T) {
	for i, tc := range []struct{ entryMux, exitMux bool }{{true, false}, {false, true}} {
		t.Run(fmt.Sprintf("entry=%v/exit=%v", tc.entryMux, tc.exitMux), func(t *testing.T) {
			resetFXPEndpointRegistry()
			targetPort := startTCPEchoTarget(t)
			exitPort, entryPort := freeTCPUDPPort(t), freeTCPUDPPort(t)
			exitDone, entryDone := make(chan struct{}), make(chan struct{})
			t.Cleanup(func() { close(entryDone); close(exitDone) })
			exitCfg := v3TestConfig("ws", tc.exitMux)
			exitCfg.Role, exitCfg.TunnelID, exitCfg.ListenPort, exitCfg.Protocol, exitCfg.Key = "exit", 3800+i, exitPort, "tcp", "mux-key"
			exitCfg.StreamTargets = loopbackStreamTargets(38000+i, targetPort)
			go func() { _ = runExit(exitDone, exitCfg) }()
			waitForTCP(t, exitPort)
			entryCfg := v3TestConfig("ws", tc.entryMux)
			entryCfg.Role, entryCfg.TunnelID, entryCfg.RuleID, entryCfg.ListenPort, entryCfg.Protocol = "entry", 3800+i, 38000+i, entryPort, "tcp"
			entryCfg.ExitHost, entryCfg.ExitPort, entryCfg.TargetIP, entryCfg.TargetPort, entryCfg.Key = "127.0.0.1", exitPort, "127.0.0.1", targetPort, "mux-key"
			go func() { _ = runEntry(entryDone, entryCfg) }()
			waitForTCP(t, entryPort)
			for round := 0; round < 3; round++ {
				if err := v3EchoThrough(t, entryPort, make([]byte, 300_000+round)); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}

// 复用的隧道：规则一起来、还没有用户连接，会话池里就有一条认证好的会话。
func TestV3MultiplexPrewarmsASession(t *testing.T) {
	resetFXPEndpointRegistry()
	targetPort := startTCPEchoTarget(t)
	exitPort, entryPort := freeTCPUDPPort(t), freeTCPUDPPort(t)
	exitDone, entryDone := make(chan struct{}), make(chan struct{})
	t.Cleanup(func() { close(entryDone); close(exitDone) })
	exitCfg := v3TestConfig("tls", true)
	exitCfg.Role, exitCfg.TunnelID, exitCfg.ListenPort, exitCfg.Protocol, exitCfg.Key = "exit", 3900, exitPort, "tcp", "warm-key"
	exitCfg.StreamTargets = loopbackStreamTargets(39000, targetPort)
	go func() { _ = runExit(exitDone, exitCfg) }()
	waitForTCP(t, exitPort)
	entryCfg := v3TestConfig("tls", true)
	entryCfg.Role, entryCfg.TunnelID, entryCfg.RuleID, entryCfg.ListenPort, entryCfg.Protocol = "entry", 3900, 39000, entryPort, "tcp"
	entryCfg.ExitHost, entryCfg.ExitPort, entryCfg.TargetIP, entryCfg.TargetPort, entryCfg.Key = "127.0.0.1", exitPort, "127.0.0.1", targetPort, "warm-key"
	go func() { _ = runEntry(entryDone, entryCfg) }()
	// 不连入口（连一下就会让它去拨出口），直接看会话池。
	key := v3PoolKey("127.0.0.1", exitPort, entryCfg)
	deadline := time.Now().Add(5 * time.Second)
	for {
		v3Outbound.mu.Lock()
		var sessions []*v3.Session
		if bucket := v3Outbound.buckets[key]; bucket != nil {
			sessions = append(sessions, bucket.sessions...)
		}
		v3Outbound.mu.Unlock()
		if len(sessions) > 0 && sessions[0].Alive(v3SessionStaleAge) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("复用的 V3 隧道没有预热会话")
		}
		time.Sleep(20 * time.Millisecond)
	}
	waitForTCP(t, entryPort)
	if err := v3EchoThrough(t, entryPort, []byte("over the warm session")); err != nil {
		t.Fatal(err)
	}
}
