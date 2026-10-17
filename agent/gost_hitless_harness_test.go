package main

import (
	"bytes"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

/*
「增删改规则不断连接」压测（gost-runtime/test/hitless-sync/run.sh 调用；要 root、nex5 运行时、sing-box）：

一个真 gost 运行时上挂几条「不动的规则」，整个过程一直有流量：
  U1  普通 TCP 转发：≥32 条长连接，双向不停地写 16KB 随机块、读回来逐字节比对
  U2  普通 UDP 转发：≥64 个并发流，每个流带序号一问一答
  U3  限速 TCP 转发（服务级限速器）：一条流全速灌，按 2 秒窗口量吞吐，必须一直被限在限速附近
  U4  Shadowsocks 出口（aes-256-gcm，落地是真 sing-box）：TCP 长连接 + UDP 流
同时通过 Agent 真正的同步路径（applyManagedConfigs + gostAPISync，和心跳下发走同一段代码）
反复增、改、删「别的规则」：加 TCP / UDP 规则、改目标、改限速器、TCP 改 UDP、删规则。
断言：
  - 不动的规则上：TCP 0 断开、0 数据错；UDP 0 丢包；限速一直有效；gost PID 始终不变；
  - 被改 / 被删的规则上：只有它们自己的连接被关掉；
  - 流量计数（Agent 给进程转发装的 nft 计数）：不清零、不重复计，增量和压测实际发出的字节对得上。
*/

type hitlessCounters struct {
	tcpBytes      atomic.Int64
	tcpRounds     atomic.Int64
	tcpDisconnect atomic.Int64
	tcpCorrupt    atomic.Int64
	udpSent       atomic.Int64
	udpRecv       atomic.Int64
	udpLost       atomic.Int64
	udpWrong      atomic.Int64
}

func (c *hitlessCounters) String() string {
	return fmt.Sprintf("tcp_bytes=%d tcp_rounds=%d tcp_disconnects=%d tcp_corrupt=%d udp_sent=%d udp_recv=%d udp_lost=%d udp_wrong=%d",
		c.tcpBytes.Load(), c.tcpRounds.Load(), c.tcpDisconnect.Load(), c.tcpCorrupt.Load(),
		c.udpSent.Load(), c.udpRecv.Load(), c.udpLost.Load(), c.udpWrong.Load())
}

// tcpStream：一条长连接，写一块随机数据、读回同样长度、逐字节比对，直到 stop。
func runTCPStream(addr string, chunk int, stop <-chan struct{}, stats *hitlessCounters, errs chan<- string, label string) {
	conn, err := net.DialTimeout("tcp", addr, 3*time.Second)
	if err != nil {
		stats.tcpDisconnect.Add(1)
		errs <- fmt.Sprintf("%s dial: %v", label, err)
		return
	}
	defer conn.Close()
	out := make([]byte, chunk)
	in := make([]byte, chunk)
	for {
		select {
		case <-stop:
			return
		default:
		}
		_, _ = rand.Read(out)
		_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
		if _, err := conn.Write(out); err != nil {
			stats.tcpDisconnect.Add(1)
			errs <- fmt.Sprintf("%s write: %v", label, err)
			return
		}
		if _, err := io.ReadFull(conn, in); err != nil {
			stats.tcpDisconnect.Add(1)
			errs <- fmt.Sprintf("%s read: %v", label, err)
			return
		}
		if !bytes.Equal(in, out) {
			stats.tcpCorrupt.Add(1)
			errs <- label + " corrupt echo"
			return
		}
		stats.tcpBytes.Add(int64(chunk))
		stats.tcpRounds.Add(1)
	}
}

// udpFlow：一个本地端口一个流，带序号一问一答；1 秒收不到算丢。
func runUDPFlow(addr string, interval time.Duration, stop <-chan struct{}, stats *hitlessCounters, errs chan<- string, label string) {
	conn, err := net.Dial("udp", addr)
	if err != nil {
		errs <- fmt.Sprintf("%s dial: %v", label, err)
		stats.udpLost.Add(1)
		return
	}
	defer conn.Close()
	payload := make([]byte, 512)
	buf := make([]byte, 2048)
	var seq uint64
	for {
		select {
		case <-stop:
			return
		default:
		}
		seq++
		binary.BigEndian.PutUint64(payload, seq)
		_, _ = rand.Read(payload[8:])
		stats.udpSent.Add(1)
		if _, err := conn.Write(payload); err != nil {
			stats.udpLost.Add(1)
			errs <- fmt.Sprintf("%s write: %v", label, err)
			time.Sleep(interval)
			continue
		}
		_ = conn.SetReadDeadline(time.Now().Add(time.Second))
		got := false
		for !got {
			n, err := conn.Read(buf)
			if err != nil {
				stats.udpLost.Add(1)
				errs <- fmt.Sprintf("%s seq=%d lost: %v", label, seq, err)
				break
			}
			if n == len(payload) && bytes.Equal(buf[:n], payload) {
				stats.udpRecv.Add(1)
				got = true
			} else if n >= 8 && binary.BigEndian.Uint64(buf[:8]) < seq {
				continue // 迟到的旧回包：不算错，接着等这一个
			} else {
				stats.udpWrong.Add(1)
				errs <- fmt.Sprintf("%s seq=%d wrong reply", label, seq)
				break
			}
		}
		time.Sleep(interval)
	}
}

// startUDPEchoAt / startTCPEchoAt 和 gost_api_sync_runtime_test.go 里的一样，只是并发更高。
func startBulkTCPEcho(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go func() { defer c.Close(); _, _ = io.Copy(c, c) }()
		}
	}()
	return l.Addr().String()
}

func startSingBoxLanding(t *testing.T, bin, dir, password string) int {
	t.Helper()
	port := freeTCPPort(t)
	config := map[string]any{
		"log":       map[string]any{"level": "warn"},
		"inbounds":  []any{map[string]any{"type": "shadowsocks", "tag": "ss-in", "listen": "127.0.0.1", "listen_port": port, "method": "aes-256-gcm", "password": password}},
		"outbounds": []any{map[string]any{"type": "direct", "tag": "direct"}},
	}
	raw, _ := json.Marshal(config)
	path := filepath.Join(dir, "sing-box.json")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(bin, "run", "-c", path)
	logFile, _ := os.Create(filepath.Join(dir, "sing-box.log"))
	cmd.Stdout, cmd.Stderr = logFile, logFile
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait(); logFile.Close() })
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if c, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", port)); err == nil {
			c.Close()
			return port
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("sing-box landing never came up")
	return 0
}

func hitlessEnvInt(name string, def int) int {
	if v, err := strconv.Atoi(os.Getenv(name)); err == nil && v > 0 {
		return v
	}
	return def
}

func TestGostHitlessSyncHarness(t *testing.T) {
	bin := os.Getenv("NEX_GOST_RUNTIME_BIN")
	singBox := os.Getenv("SING_BOX")
	if bin == "" || singBox == "" {
		t.Skip("set NEX_GOST_RUNTIME_BIN (nex5 runtime) and SING_BOX (gost-runtime/test/hitless-sync/run.sh does)")
	}
	if os.Geteuid() != 0 {
		t.Skip("needs root (API socket directory, nft counters)")
	}
	version, _ := exec.Command(bin, "-V").CombinedOutput()
	if parseGostRuntimeVersion(string(version)).NexBuild < gostServiceCloseMinNexBuild {
		t.Skipf("runtime %s cannot close a service's connections; TCP edits/deletes restart there", strings.TrimSpace(string(version)))
	}
	oldCloses := gostRuntimeClosesConns
	gostRuntimeClosesConns = func(gostAPISyncTarget) bool { return true }
	defer func() { gostRuntimeClosesConns = oldCloses }()

	duration := time.Duration(hitlessEnvInt("HITLESS_SECONDS", 120)) * time.Second
	tcpStreams := hitlessEnvInt("HITLESS_TCP_STREAMS", 32)
	udpFlows := hitlessEnvInt("HITLESS_UDP_FLOWS", 64)
	const limitBytesPerSec = 2_000_000

	dir, err := os.MkdirTemp("", "nex-hitless-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "gost.json")
	socket := filepath.Join(dir, "gost-api", "nex-hitless.sock")
	rt := &realGostRuntime{t: t, bin: bin, dir: dir, socket: socket}
	defer rt.stop()

	tcpEcho, udpEcho := startBulkTCPEcho(t), startUDPEcho(t)
	_, udpEchoPortStr, _ := net.SplitHostPort(udpEcho)
	_, tcpEchoPortStr, _ := net.SplitHostPort(tcpEcho)
	ssPassword := "hitless-sync-password"
	landing := startSingBoxLanding(t, singBox, dir, ssPassword)

	tcpSvc := func(name string, port int, target string) map[string]any {
		return map[string]any{
			"name": name, "addr": fmt.Sprintf("127.0.0.1:%d", port),
			"handler": map[string]any{"type": "tcp"}, "listener": map[string]any{"type": "tcp"},
			"forwarder": map[string]any{"nodes": []any{map[string]any{"name": "target-" + name, "addr": target,
				"connector": map[string]any{"type": "tcp"}, "dialer": map[string]any{"type": "tcp"}}}},
		}
	}
	udpSvc := func(name string, port int, target string) map[string]any {
		return map[string]any{
			"name": name, "addr": fmt.Sprintf("127.0.0.1:%d", port),
			"handler":  map[string]any{"type": "udp"},
			"listener": map[string]any{"type": "udp", "metadata": map[string]any{"keepalive": true, "ttl": "30s", "readBufferSize": "8192", "readQueueSize": "256", "backlog": "128"}},
			"forwarder": map[string]any{"nodes": []any{map[string]any{"name": "target-" + name, "addr": target,
				"connector": map[string]any{"type": "udp"}, "dialer": map[string]any{"type": "udp"}}}},
		}
	}
	egressChain := func(name, connector, dialer string) map[string]any {
		return map[string]any{"name": name, "hops": []any{map[string]any{"name": "hop-" + name, "nodes": []any{map[string]any{
			"name": "node-" + name, "addr": fmt.Sprintf("127.0.0.1:%d", landing),
			"connector": map[string]any{"type": connector, "auth": map[string]any{"username": "aes-256-gcm", "password": ssPassword}},
			"dialer":    map[string]any{"type": dialer},
		}}}}}
	}

	// ── 不动的规则 ───────────────────────────────────────────────────────
	u1Port, u2Port, u3Port, u4tPort, u4uPort := freeTCPPort(t), freeUDPPort(t), freeTCPPort(t), freeTCPPort(t), freeUDPPort(t)
	u3 := tcpSvc("fwx-103-tcp", u3Port, tcpEcho)
	u3["limiter"] = "fwx-limit-103"
	u4t := tcpSvc("fwx-104-tcp", u4tPort, tcpEcho)
	u4t["handler"] = map[string]any{"type": "tcp", "chain": "chain-egress-104-tcp"}
	u4u := udpSvc("fwx-104-udp", u4uPort, udpEcho)
	u4u["handler"] = map[string]any{"type": "udp", "chain": "chain-egress-104-udp"}
	stable := []any{tcpSvc("fwx-101-tcp", u1Port, tcpEcho), udpSvc("fwx-102-udp", u2Port, udpEcho), u3, u4t, u4u}
	stableChains := []any{egressChain("chain-egress-104-tcp", "ss", "tcp"), egressChain("chain-egress-104-udp", "ssu", "udp")}
	limitSpec := fmt.Sprintf("$ %dB %dB", limitBytesPerSec, limitBytesPerSec)
	stableLimiters := []any{map[string]any{"name": "fwx-limit-103", "limits": []any{limitSpec}}}
	api := map[string]any{"addr": "unix://" + socket}

	// ── 会被增删改的规则（churn）────────────────────────────────────────
	type churnRule struct {
		name    string
		proto   string // tcp / udp
		port    int
		target  string
		limiter string
	}
	churn := map[string]*churnRule{}
	churnLimiterValue := 500_000
	buildConfig := func() map[string]any {
		services := append([]any{}, stable...)
		limiters := append([]any{}, stableLimiters...)
		limiters = append(limiters, map[string]any{"name": "fwx-limit-churn", "limits": []any{fmt.Sprintf("$ %dB %dB", churnLimiterValue, churnLimiterValue)}})
		names := make([]string, 0, len(churn))
		for name := range churn {
			names = append(names, name)
		}
		// 顺序打乱一下（按名字倒序）：文件顺序和 API 追加顺序不同，比较要按名字。
		for i := len(names) - 1; i >= 0; i-- {
			for j := 0; j < i; j++ {
				if names[j] < names[j+1] {
					names[j], names[j+1] = names[j+1], names[j]
				}
			}
		}
		for _, name := range names {
			r := churn[name]
			var svc map[string]any
			if r.proto == "tcp" {
				svc = tcpSvc(r.name, r.port, r.target)
			} else {
				svc = udpSvc(r.name, r.port, r.target)
			}
			if r.limiter != "" {
				svc["limiter"] = r.limiter
			}
			services = append(services, svc)
		}
		return cloneGostConfig(t, map[string]any{"services": services, "chains": stableChains, "limiters": limiters, "api": api})
	}

	_, raw := writeRealGostConfig(t, path, buildConfig())
	if err := os.WriteFile(path+".sha256", []byte(gostShellHash(raw)), 0o644); err != nil {
		t.Fatal(err)
	}
	rt.start(path)
	pid := rt.cmd.Process.Pid
	oldActive := gostAPISyncServiceActive
	gostAPISyncServiceActive = func(string) bool { return rt.alive() }
	defer func() { gostAPISyncServiceActive = oldActive }()
	target := gostAPISyncTarget{service: "nex-test-runtime", path: path, socket: socket, binary: bin}

	// ── 流量计数：Agent 给进程转发（gost）装的 nft 计数，装在 U1 / U2 的监听端口上 ────
	counting := []runningRule{
		{RuleID: 9101, SourcePort: u1Port, TargetIP: "127.0.0.1", TargetPort: mustAtoi(t, tcpEchoPortStr), Protocol: "tcp", ForwardType: "gost"},
		{RuleID: 9102, SourcePort: u2Port, TargetIP: "127.0.0.1", TargetPort: mustAtoi(t, udpEchoPortStr), Protocol: "udp", ForwardType: "gost"},
	}
	for _, rule := range counting {
		if ok, out := runShellBatchWithOutput(countingRuleInstallCmds(rule)); !ok {
			t.Fatalf("install counting for port %d: %s", rule.SourcePort, out)
		}
		port := rule.SourcePort
		defer runShellBatch(countingRuleCleanupCmds(port))
	}
	counterBytes := func() (uint64, uint64) {
		// 进程转发（gost）的计数按监听端口记在 Agent 自己的 nft 表里，和 Agent 上报流量读的是同一份。
		snap, _ := nftProcessCounterSnapshotWithDiagnostics()
		u1, u2 := snap[strconv.Itoa(u1Port)], snap[strconv.Itoa(u2Port)]
		return u1.In + u1.Out, u2.In + u2.Out
	}
	c1Start, c2Start := counterBytes()

	// ── 压测流量 ─────────────────────────────────────────────────────────
	stop := make(chan struct{})
	errs := make(chan string, 4096)
	var wg sync.WaitGroup
	plain, egress := &hitlessCounters{}, &hitlessCounters{}
	plainUDP := &hitlessCounters{}
	for i := 0; i < tcpStreams; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			runTCPStream(fmt.Sprintf("127.0.0.1:%d", u1Port), 16*1024, stop, plain, errs, fmt.Sprintf("U1-tcp-%d", i))
		}(i)
	}
	for i := 0; i < udpFlows; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			runUDPFlow(fmt.Sprintf("127.0.0.1:%d", u2Port), 10*time.Millisecond, stop, plainUDP, errs, fmt.Sprintf("U2-udp-%d", i))
		}(i)
	}
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			runTCPStream(fmt.Sprintf("127.0.0.1:%d", u4tPort), 16*1024, stop, egress, errs, fmt.Sprintf("U4-ss-tcp-%d", i))
		}(i)
	}
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			runUDPFlow(fmt.Sprintf("127.0.0.1:%d", u4uPort), 20*time.Millisecond, stop, egress, errs, fmt.Sprintf("U4-ss-udp-%d", i))
		}(i)
	}
	// 限速流：全速灌，单独统计吞吐。
	limited := &hitlessCounters{}
	wg.Add(1)
	go func() {
		defer wg.Done()
		runTCPStream(fmt.Sprintf("127.0.0.1:%d", u3Port), 64*1024, stop, limited, errs, "U3-limited")
	}()
	var rateMu sync.Mutex
	var rates []float64
	wg.Add(1)
	go func() {
		defer wg.Done()
		last := limited.tcpBytes.Load()
		tick := time.NewTicker(2 * time.Second)
		defer tick.Stop()
		for {
			select {
			case <-stop:
				return
			case <-tick.C:
				now := limited.tcpBytes.Load()
				rateMu.Lock()
				rates = append(rates, float64(now-last)/2)
				rateMu.Unlock()
				last = now
			}
		}
	}()
	time.Sleep(3 * time.Second) // 让流量先跑起来

	// ── 增删改别的规则 ─────────────────────────────────────────────────
	type opResult struct {
		op       string
		duration time.Duration
	}
	var ops []opResult
	var victimsClosed, victimsTotal int
	doSync := func(op string) {
		t.Helper()
		tx, _ := writeRealGostConfig(t, path, buildConfig())
		started := time.Now()
		handled, reason := gostAPISync(target, tx)
		if !handled {
			log, _ := os.ReadFile(filepath.Join(dir, "gost.log"))
			t.Fatalf("%s fell back to restart: %s\n%s", op, reason, tailLines(string(log), 40))
		}
		tx.commit()
		ops = append(ops, opResult{op, time.Since(started)})
		if !rt.alive() || rt.cmd.Process.Pid != pid {
			t.Fatalf("%s restarted the runtime", op)
		}
	}
	// 被改 / 被删的规则上开一条连接：这条（只有这条）应该被关掉。
	expectClosed := func(conn net.Conn, label string) {
		victimsTotal++
		_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
		buf := make([]byte, 1)
		if _, err := conn.Read(buf); err != nil && !isTimeout(err) {
			victimsClosed++
		} else {
			t.Errorf("%s: connection on the changed rule stayed open", label)
		}
		conn.Close()
	}
	openVictim := func(port int) net.Conn {
		c, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 3*time.Second)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := c.Write([]byte("x")); err != nil {
			t.Fatal(err)
		}
		_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
		if _, err := io.ReadFull(c, make([]byte, 1)); err != nil {
			t.Fatal(err)
		}
		return c
	}
	altTarget := startBulkTCPEcho(t)

	deadline := time.Now().Add(duration)
	round := 0
	for time.Now().Before(deadline) {
		round++
		a := fmt.Sprintf("fwx-%d-tcp", 2000+round)
		b := fmt.Sprintf("fwx-%d-udp", 2000+round)
		// 1. 加一条 TCP、一条 UDP
		churn[a] = &churnRule{name: a, proto: "tcp", port: freeTCPPort(t), target: tcpEcho, limiter: "fwx-limit-churn"}
		churn[b] = &churnRule{name: b, proto: "udp", port: freeUDPPort(t), target: udpEcho}
		doSync("add")
		// 2. 改目标（上面开着的连接被关、新连接走新目标）
		victim := openVictim(churn[a].port)
		churn[a].target = altTarget
		doSync("edit-target")
		expectClosed(victim, a+" edit")
		openVictim(churn[a].port).Close()
		// 3. 改限速器的值
		churnLimiterValue += 1000
		doSync("edit-limiter")
		// 4. TCP 改 UDP（同端口：删 TCP 服务、加 UDP 服务）
		victim = openVictim(churn[a].port)
		churn[a].proto, churn[a].target, churn[a].limiter = "udp", udpEcho, ""
		churn[a].name = fmt.Sprintf("fwx-%d-udp", 3000+round)
		churn[churn[a].name] = churn[a]
		delete(churn, a)
		doSync("tcp-to-udp")
		expectClosed(victim, a+" protocol change")
		// 5. 删掉这一轮加的规则
		for name := range churn {
			delete(churn, name)
		}
		doSync("delete")
		time.Sleep(500 * time.Millisecond)
	}

	time.Sleep(2 * time.Second)
	close(stop)
	wg.Wait()
	close(errs)
	var errList []string
	for e := range errs {
		errList = append(errList, e)
	}

	c1End, c2End := counterBytes()
	byOp := map[string][]time.Duration{}
	for _, o := range ops {
		byOp[o.op] = append(byOp[o.op], o.duration)
	}
	var opSummary []string
	for _, name := range []string{"add", "edit-target", "edit-limiter", "tcp-to-udp", "delete"} {
		ds := byOp[name]
		var max time.Duration
		for _, d := range ds {
			if d > max {
				max = d
			}
		}
		opSummary = append(opSummary, fmt.Sprintf("%s=%dx(max %s)", name, len(ds), max.Round(time.Millisecond)))
	}
	rateMu.Lock()
	var minRate, maxRate float64
	steady := rates
	if len(steady) > 2 {
		steady = steady[1 : len(steady)-1] // 第一、最后一个窗口不完整
	}
	for i, r := range steady {
		if i == 0 || r < minRate {
			minRate = r
		}
		if r > maxRate {
			maxRate = r
		}
	}
	rateMu.Unlock()

	// 计数：一次 TCP 往返，监听端口上进来 chunk、出去 chunk；再加包头。UDP 同理 512B 一来一回。
	tcpPayload := float64(2 * plain.tcpBytes.Load())
	udpPayload := float64(2 * 512 * plainUDP.udpRecv.Load())
	c1Ratio := float64(c1End-c1Start) / tcpPayload
	c2Ratio := float64(c2End-c2Start) / udpPayload

	t.Logf("RESULT hitless-sync runtime=%q duration=%s rounds=%d pid_before=%d pid_after=%d", strings.TrimSpace(string(version)), duration, round, pid, rt.cmd.Process.Pid)
	t.Logf("RESULT hitless-ops %s", strings.Join(opSummary, " "))
	t.Logf("RESULT untouched-plain-tcp streams=%d %s", tcpStreams, plain)
	t.Logf("RESULT untouched-plain-udp flows=%d %s", udpFlows, plainUDP)
	t.Logf("RESULT untouched-ss-egress tcp_streams=4 udp_flows=8 %s", egress)
	t.Logf("RESULT untouched-rate-limit limit_Bps=%d windows=%d min_Bps=%.0f max_Bps=%.0f %s", limitBytesPerSec, len(steady), minRate, maxRate, limited)
	t.Logf("RESULT victims closed=%d/%d", victimsClosed, victimsTotal)
	t.Logf("RESULT counters tcp_counter_delta=%d tcp_payload=%.0f ratio=%.3f udp_counter_delta=%d udp_payload=%.0f ratio=%.3f", c1End-c1Start, tcpPayload, c1Ratio, c2End-c2Start, udpPayload, c2Ratio)

	if len(errList) > 0 {
		max := len(errList)
		if max > 20 {
			max = 20
		}
		t.Errorf("%d traffic errors on untouched rules, first: %s", len(errList), strings.Join(errList[:max], "; "))
	}
	for _, c := range []*hitlessCounters{plain, plainUDP, egress, limited} {
		if c.tcpDisconnect.Load() != 0 || c.tcpCorrupt.Load() != 0 || c.udpLost.Load() != 0 || c.udpWrong.Load() != 0 {
			t.Errorf("untouched rule saw disruption: %s", c)
		}
	}
	if plain.tcpRounds.Load() == 0 || plainUDP.udpRecv.Load() == 0 || egress.tcpRounds.Load() == 0 || egress.udpRecv.Load() == 0 {
		t.Error("some untouched traffic never flowed")
	}
	if len(steady) == 0 || maxRate > 1.3*limitBytesPerSec || minRate < 0.5*limitBytesPerSec {
		t.Errorf("rate limit not held during syncs: min=%.0f max=%.0f limit=%d", minRate, maxRate, limitBytesPerSec)
	}
	if victimsClosed != victimsTotal {
		t.Errorf("only %d/%d connections on changed rules were closed", victimsClosed, victimsTotal)
	}
	if rt.cmd.Process.Pid != pid {
		t.Error("runtime PID changed")
	}
	// 计数不清零、不重复计：增量和实际字节（含包头）在 [1.0, 1.25] 之间。
	if c1End < c1Start || c2End < c2Start {
		t.Errorf("traffic counters went backwards: tcp %d->%d udp %d->%d", c1Start, c1End, c2Start, c2End)
	}
	if c1Ratio < 1.0 || c1Ratio > 1.25 || c2Ratio < 1.0 || c2Ratio > 1.25 {
		t.Errorf("traffic counters do not match the bytes sent: tcp ratio %.3f udp ratio %.3f", c1Ratio, c2Ratio)
	}
}

func mustAtoi(t *testing.T, s string) int {
	n, err := strconv.Atoi(s)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func tailLines(s string, n int) string {
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}
