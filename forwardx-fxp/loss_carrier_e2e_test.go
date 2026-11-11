package main

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// 端到端：真的运行时（runEntry / runRelay / runExit）、真的握手和帧加密，入口到下一跳的
// 承载换成抗丢包传输，中间垫进程内的有损网络。

// lcEchoThroughTunnel 经 addr 打一条连接，写 size 字节，同时读回声，返回两边的校验和。
func lcEchoThroughTunnel(addr string, size int, seed int64) error {
	conn, err := net.DialTimeout("tcp", addr, 5*time.Second)
	if err != nil {
		return err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(2 * time.Minute))
	payload := lcTestPayload(size, seed)
	writeErr := make(chan error, 1)
	go func() {
		for offset := 0; offset < len(payload); offset += 64 << 10 {
			end := offset + 64<<10
			if end > len(payload) {
				end = len(payload)
			}
			if _, err := conn.Write(payload[offset:end]); err != nil {
				writeErr <- err
				return
			}
		}
		writeErr <- nil
	}()
	got := make([]byte, size)
	if _, err := io.ReadFull(conn, got); err != nil {
		return fmt.Errorf("read echo: %w", err)
	}
	if err := <-writeErr; err != nil {
		return fmt.Errorf("write: %w", err)
	}
	if sha256.Sum256(got) != sha256.Sum256(payload) {
		return errors.New("echo checksum mismatch")
	}
	return nil
}

func lcStartRelay(tb testing.TB, nextPort int, mutate func(*config)) int {
	tb.Helper()
	port := dpFreePort(tb)
	cfg := config{Role: "relay", TunnelID: 17, ListenPort: port, Protocol: "tcp", Key: dpKey,
		RelayExitHost: "127.0.0.1", RelayExitPort: nextPort, RelayKey: dpKey}
	if mutate != nil {
		mutate(&cfg)
	}
	done := make(chan struct{})
	tb.Cleanup(func() { close(done) })
	go func() { _ = runRelay(done, cfg) }()
	dpWaitTCPPort(tb, port)
	return port
}

func TestLossTolerantTunnelCarriesTrafficEndToEndUnderLoss(t *testing.T) {
	for _, loss := range []float64{0.05, 0.15} {
		t.Run(fmt.Sprintf("loss=%.0f%%", loss*100), func(t *testing.T) {
			resetFXPEndpointRegistry()
			t.Cleanup(resetFXPEndpointRegistry)
			stats := useLossyNetwork(t, lossyNetConfig{loss: loss, delay: 10 * time.Millisecond, jitter: 4 * time.Millisecond, reorder: 0.03, reorderExtra: 15 * time.Millisecond, seed: int64(loss * 1000)})
			target := dpTCPTarget(t, true)
			addr := dpStartFXPTCP(t, target, func(c *config) { c.LossTolerant = true })
			// 几条并发连接各传 3 MB 回声：校验和一致、连接不断。
			var wg sync.WaitGroup
			errs := make(chan error, 3)
			for i := 0; i < 3; i++ {
				wg.Add(1)
				go func(i int) {
					defer wg.Done()
					errs <- lcEchoThroughTunnel(addr, 3<<20, int64(i+1))
				}(i)
			}
			wg.Wait()
			close(errs)
			for err := range errs {
				if err != nil {
					t.Fatalf("丢包 %.0f%% 时隧道里的连接出错: %v", loss*100, err)
				}
			}
			if stats.sent.Load() == 0 {
				t.Fatal("流量没有走抗丢包承载（有损网络一个包都没见到）")
			}
			dropped := stats.sent.Load() - stats.sentOK.Load() + stats.recv.Load() - stats.recvOK.Load()
			t.Logf("丢包 %.0f%%：经过有损网络的包 %d，丢掉 %d", loss*100, stats.sent.Load()+stats.recv.Load(), dropped)
		})
	}
}

func TestLossTolerantTunnelWorksThroughRelay(t *testing.T) {
	resetFXPEndpointRegistry()
	t.Cleanup(resetFXPEndpointRegistry)
	stats := useLossyNetwork(t, lossyNetConfig{loss: 0.05, delay: 5 * time.Millisecond, seed: 9})
	target := dpTCPTarget(t, true)
	exitPort := dpFreePort(t)
	exitCfg := config{Role: "exit", TunnelID: 17, ListenPort: exitPort, Protocol: "both", Key: dpKey,
		StreamTargets: loopbackStreamTargets(5, target.Port), LossTolerant: true}
	exitDone := make(chan struct{})
	t.Cleanup(func() { close(exitDone) })
	go func() { _ = runExit(exitDone, exitCfg) }()
	dpWaitTCPPort(t, exitPort)
	relayPort := lcStartRelay(t, exitPort, func(c *config) { c.LossTolerant = true })
	entryPort := dpFreePort(t)
	entryCfg := config{Role: "entry", TunnelID: 17, RuleID: 5, ListenPort: entryPort, Protocol: "tcp",
		ExitHost: "127.0.0.1", ExitPort: relayPort, TargetIP: "127.0.0.1", TargetPort: target.Port, Key: dpKey, LossTolerant: true}
	entryDone := make(chan struct{})
	t.Cleanup(func() { close(entryDone) })
	go func() { _ = runEntry(entryDone, entryCfg) }()
	dpWaitTCPPort(t, entryPort)
	// 出口是 both：抗丢包承载和 UDP 直连共用同一个 UDP 端口。
	if err := lcEchoThroughTunnel(net.JoinHostPort("127.0.0.1", strconv.Itoa(entryPort)), 2<<20, 3); err != nil {
		t.Fatalf("入口 → 中转 → 出口都开抗丢包时应该能通: %v", err)
	}
	if stats.sent.Load() == 0 {
		t.Fatal("没有走抗丢包承载")
	}
}

func TestLossTolerantEntryDoesNotFallBackToTCP(t *testing.T) {
	resetFXPEndpointRegistry()
	t.Cleanup(resetFXPEndpointRegistry)
	target := dpTCPTarget(t, true)
	// 出口没开抗丢包（或者是旧版本）：它的 TCP 端口好好的，但入口不能悄悄改走 TCP。
	exitPort := dpFreePort(t)
	exitCfg := config{Role: "exit", TunnelID: 17, ListenPort: exitPort, Protocol: "tcp", Key: dpKey,
		StreamTargets: loopbackStreamTargets(5, target.Port)}
	exitDone := make(chan struct{})
	t.Cleanup(func() { close(exitDone) })
	go func() { _ = runExit(exitDone, exitCfg) }()
	dpWaitTCPPort(t, exitPort)
	entryPort := dpFreePort(t)
	entryCfg := config{Role: "entry", TunnelID: 17, RuleID: 5, ListenPort: entryPort, Protocol: "tcp",
		ExitHost: "127.0.0.1", ExitPort: exitPort, TargetIP: "127.0.0.1", TargetPort: target.Port, Key: dpKey, LossTolerant: true}
	entryDone := make(chan struct{})
	t.Cleanup(func() { close(entryDone) })
	go func() { _ = runEntry(entryDone, entryCfg) }()
	dpWaitTCPPort(t, entryPort)
	if err := lcEchoThroughTunnel(net.JoinHostPort("127.0.0.1", strconv.Itoa(entryPort)), 4096, 1); err == nil {
		t.Fatal("出口没开抗丢包时，入口不应该退回 TCP 把数据送过去")
	}
	// 失败原因要能看出来：直接拨一次，看错误文字。
	_, _, err := dialSecureTCPFresh("127.0.0.1", exitPort, entryCfg)
	if err == nil || !strings.Contains(err.Error(), "loss-tolerant") {
		t.Fatalf("拨号错误要写明是抗丢包传输没连上，实际: %v", err)
	}
}

func TestLossTolerantExitRefusesTCPUpstream(t *testing.T) {
	resetFXPEndpointRegistry()
	t.Cleanup(resetFXPEndpointRegistry)
	target := dpTCPTarget(t, true)
	exitPort := dpFreePort(t)
	exitCfg := config{Role: "exit", TunnelID: 17, ListenPort: exitPort, Protocol: "tcp", Key: dpKey,
		StreamTargets: loopbackStreamTargets(5, target.Port), LossTolerant: true}
	exitDone := make(chan struct{})
	t.Cleanup(func() { close(exitDone) })
	go func() { _ = runExit(exitDone, exitCfg) }()
	dpWaitTCPPort(t, exitPort)
	// 入口是旧版本 / 还没拿到新配置，从 TCP 连进来：出口不接，免得「开了其实没开」。
	entryPort := dpFreePort(t)
	entryCfg := config{Role: "entry", TunnelID: 17, RuleID: 5, ListenPort: entryPort, Protocol: "tcp",
		ExitHost: "127.0.0.1", ExitPort: exitPort, TargetIP: "127.0.0.1", TargetPort: target.Port, Key: dpKey}
	entryDone := make(chan struct{})
	t.Cleanup(func() { close(entryDone) })
	go func() { _ = runEntry(entryDone, entryCfg) }()
	dpWaitTCPPort(t, entryPort)
	if err := lcEchoThroughTunnel(net.JoinHostPort("127.0.0.1", strconv.Itoa(entryPort)), 4096, 1); err == nil {
		t.Fatal("开了抗丢包的出口不应该接从 TCP 进来的会话")
	}
}

func TestLossTolerantSwitchOffKeepsTCPConfigByteIdentical(t *testing.T) {
	// 没开抗丢包的配置：线上 JSON 里没有这个字段，监听计划里也不多出 UDP 监听。
	cfg := config{Role: "exit", TunnelID: 1, ListenPort: 20001, Protocol: "tcp", Key: "k"}
	tcpPlans, udpPlans, err := buildFXPRuntimePlans(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if len(udpPlans) != 0 || tcpPlans[0].lossTolerant {
		t.Fatalf("没开抗丢包时不该多出 UDP 监听: %+v", udpPlans)
	}
	if strings.Contains(fxpComponentSignature(cfg, nil), "lossTolerant") {
		t.Fatal("关着时配置指纹里不该出现这个字段（升级不会让监听重启）")
	}
	cfg.LossTolerant = true
	_, udpPlans, err = buildFXPRuntimePlans(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if len(udpPlans) != 1 || udpPlans[0].port != 20001 {
		t.Fatalf("开了抗丢包、没有 UDP 直连时应该在同号 UDP 端口单独收包: %+v", udpPlans)
	}
	// 跑 UDP 直连、端口同号时共用 UDP 直连的读循环，不再多开。
	cfg.Protocol = "both"
	_, udpPlans, _ = buildFXPRuntimePlans(cfg)
	if len(udpPlans) != 1 || udpPlans[0].sig == "loss-tolerant" {
		t.Fatalf("和 UDP 直连同端口时应该共用它的读循环: %+v", udpPlans)
	}
	// 开关抗丢包不该让 UDP 直连监听重启（上面的 UDP 会话会断）。
	off := cfg
	off.LossTolerant = false
	if fxpComponentSignature(cfg, stripTCPOnlyFields) != fxpComponentSignature(off, stripTCPOnlyFields) {
		t.Fatal("开关抗丢包改变了 UDP 直连的指纹")
	}
	v2 := cfg
	v2.TransportVersion = "v2"
	if err := validateConfig(v2); err == nil {
		t.Fatal("V2 隧道不支持抗丢包传输，配置应该被拒")
	}
}

func TestLossTolerantReloadTogglesCarrierListener(t *testing.T) {
	resetFXPEndpointRegistry()
	t.Cleanup(resetFXPEndpointRegistry)
	target := dpTCPTarget(t, true)
	exitPort := dpFreePort(t)
	exitCfg := config{Role: "exit", TunnelID: 17, ListenPort: exitPort, Protocol: "tcp", Key: dpKey,
		StreamTargets: loopbackStreamTargets(5, target.Port)}
	manager := newFXPRuntimeManager("exit")
	if err := manager.apply(exitCfg); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(manager.shutdown)
	probe := exitCfg
	probe.LossTolerant = true
	if _, err := dialLossCarrier("127.0.0.1", exitPort, 600*time.Millisecond, probe); err == nil {
		t.Fatal("还没开抗丢包时不应该有 UDP 承载监听")
	}
	exitCfg.LossTolerant = true
	if err := manager.apply(exitCfg); err != nil {
		t.Fatal(err)
	}
	conn, err := dialLossCarrier("127.0.0.1", exitPort, 2*time.Second, probe)
	if err != nil {
		t.Fatalf("热更新打开后应该能连上: %v", err)
	}
	_ = conn.Close()
	exitCfg.LossTolerant = false
	if err := manager.apply(exitCfg); err != nil {
		t.Fatal(err)
	}
	if _, err := dialLossCarrier("127.0.0.1", exitPort, 600*time.Millisecond, probe); err == nil {
		t.Fatal("热更新关掉后不应该还能连上")
	}
}
