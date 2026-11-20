//go:build balancee2e

package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

/*
GOST 出口组由入口机本机代理挑：端到端（gost-runtime/test/balance-proxy/run.sh 起它）。

全是真的：面板的心跳路由生成的入口 gost.json、出口的隧道配置、交给 Agent 的代理规格（gen-configs.mjs 从真实
心跳里取出来的 bundle.json）；真实的 gost 运行时进程（3 台出口 + 入口）；本进程里跑真实的 failoverProxy
（startFailoverProxy，和 Agent 里同一条路）。目标是本进程里的一个 TCP + UDP 服务，记下每条连接 / 每个包是谁拨来的：

	访客（127.0.0.101…）→ 入口 gost 公网端口 → 本机代理 → 每出口的本机 gost 端口 → 出口 gost（各自绑
	127.0.0.11 / .12 / .13 往外拨）→ 目标

目标看到 127.0.0.1 就是入口机自己直连了目标（绕过隧道），任何场景都不许出现。

环境变量：BALANCE_E2E_DIR（gen-configs.mjs 的输出目录）、BALANCE_E2E_GOST（运行时二进制）、
BALANCE_E2E_IPTABLES=1（有 root 和 iptables：跑黑洞、「单台出口到目标不通」这两类场景）。
*/

type e2eExit struct {
	HostID int    `json:"hostId"`
	IP     string `json:"ip"`
	Port   int    `json:"port"`
}

type e2eBundle struct {
	Scenario   string    `json:"scenario"`
	RuleID     int       `json:"ruleId"`
	TunnelID   int       `json:"tunnelId"`
	Protocol   string    `json:"protocol"`
	EntryPort  int       `json:"entryPort"`
	TargetPort int       `json:"targetPort"`
	Exits      []e2eExit `json:"exits"`
	EntryGost  json.RawMessage
	Failover   *struct {
		SourcePort int          `json:"sourcePort"`
		Spec       failoverSpec `json:"spec"`
	} `json:"failover"`
	ExitGost map[string]json.RawMessage `json:"exitGost"`
	// 多跳场景：入口和出口之间的中转
	Relay     *e2eExit        `json:"relay"`
	RelayGost json.RawMessage `json:"relayGost"`
}

// ---- 目标 ----

type e2eTarget struct {
	mu    sync.Mutex
	peers map[string]int // "tcp 127.0.0.11" → 次数
	tcp   net.Listener
	udp   net.PacketConn
	// 高防的脾气：这些来源（出口）的连接「连上不说话」超过这么久就关（别的来源不限）。
	silentClose map[string]time.Duration
}

func (target *e2eTarget) closeSilentFrom(host string, after time.Duration) {
	target.mu.Lock()
	if target.silentClose == nil {
		target.silentClose = map[string]time.Duration{}
	}
	target.silentClose[host] = after
	target.mu.Unlock()
}

func startE2ETarget(t *testing.T, port int) *e2eTarget {
	t.Helper()
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		t.Fatalf("目标 TCP 没起来: %v", err)
	}
	pc, err := net.ListenPacket("udp", addr)
	if err != nil {
		t.Fatalf("目标 UDP 没起来: %v", err)
	}
	target := &e2eTarget{peers: map[string]int{}, tcp: ln, udp: pc}
	t.Cleanup(func() { _ = ln.Close(); _ = pc.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go target.serveTCP(conn)
		}
	}()
	go func() {
		buf := make([]byte, 65535)
		for {
			n, from, err := pc.ReadFrom(buf)
			if err != nil {
				return
			}
			host, _, _ := net.SplitHostPort(from.String())
			target.note("udp", host)
			_, _ = pc.WriteTo([]byte(host+" "+string(buf[:n])), from)
		}
	}()
	return target
}

func (target *e2eTarget) note(network string, host string) {
	target.mu.Lock()
	target.peers[network+" "+host]++
	target.mu.Unlock()
}

// 每一行回「拨来的地址 PROXY头里的来源（没有是 -） 原文」。连接开头有 PROXY 头（v1 / v2）就先读掉。
func (target *e2eTarget) serveTCP(conn net.Conn) {
	defer conn.Close()
	host, _, _ := net.SplitHostPort(conn.RemoteAddr().String())
	target.note("tcp", host)
	target.mu.Lock()
	silent := target.silentClose[host]
	target.mu.Unlock()
	if silent > 0 {
		_ = conn.SetReadDeadline(time.Now().Add(silent))
	}
	reader := bufio.NewReader(conn)
	proxySource := "-"
	// 只看前 6 个字节（访客最短就发 6 个字节，多等会卡住）：v1 是 "PROXY "，v2 是固定签名的开头
	if head, err := reader.Peek(6); err == nil {
		switch {
		case bytes.Equal(head, proxyV2Signature[:6]):
			header := make([]byte, 16)
			if _, err := reader.Read(header); err != nil {
				return
			}
			rest := make([]byte, int(header[14])<<8|int(header[15]))
			if _, err := readFull(reader, rest); err != nil {
				return
			}
			if header[13]>>4 == 1 && len(rest) >= 12 {
				proxySource = net.IP(rest[0:4]).String()
			}
		case bytes.HasPrefix(head, []byte("PROXY ")):
			line, err := reader.ReadString('\n')
			if err != nil {
				return
			}
			if fields := strings.Fields(line); len(fields) >= 3 {
				proxySource = fields[2]
			}
		}
	}
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return
		}
		_ = conn.SetReadDeadline(time.Time{})
		if _, err := fmt.Fprintf(conn, "%s %s %s", host, proxySource, line); err != nil {
			return
		}
	}
}

func readFull(reader *bufio.Reader, buf []byte) (int, error) {
	total := 0
	for total < len(buf) {
		n, err := reader.Read(buf[total:])
		total += n
		if err != nil {
			return total, err
		}
	}
	return total, nil
}

func (target *e2eTarget) snapshot() map[string]int {
	target.mu.Lock()
	defer target.mu.Unlock()
	out := map[string]int{}
	for key, count := range target.peers {
		out[key] = count
	}
	return out
}

// ---- 实验台 ----

type e2eLab struct {
	t       *testing.T
	bundle  e2eBundle
	target  *e2eTarget
	gostBin string
	work    string
	procs   map[string]*exec.Cmd
	configs map[string]string
}

func e2eEnv(t *testing.T) (string, string) {
	t.Helper()
	dir, gost := os.Getenv("BALANCE_E2E_DIR"), os.Getenv("BALANCE_E2E_GOST")
	if dir == "" || gost == "" {
		t.Skip("要 BALANCE_E2E_DIR 和 BALANCE_E2E_GOST（由 gost-runtime/test/balance-proxy/run.sh 给）")
	}
	return dir, gost
}

func e2eIptables() bool { return os.Getenv("BALANCE_E2E_IPTABLES") == "1" }

func newE2ELab(t *testing.T, scenario string) *e2eLab {
	t.Helper()
	dir, gost := e2eEnv(t)
	raw, err := os.ReadFile(filepath.Join(dir, scenario, "bundle.json"))
	if err != nil {
		t.Fatalf("读不到场景 %s: %v", scenario, err)
	}
	var bundle e2eBundle
	if err := json.Unmarshal(raw, &bundle); err != nil {
		t.Fatalf("场景 %s 解析失败: %v", scenario, err)
	}
	var envelope struct {
		EntryGost json.RawMessage `json:"entryGost"`
	}
	_ = json.Unmarshal(raw, &envelope)
	bundle.EntryGost = envelope.EntryGost
	if bundle.Failover == nil || bundle.Failover.Spec.BalanceReport == nil {
		t.Fatalf("场景 %s 面板没有下发本机代理的规格", scenario)
	}
	lab := &e2eLab{t: t, bundle: bundle, gostBin: gost, work: t.TempDir(), procs: map[string]*exec.Cmd{}, configs: map[string]string{}}
	oldPersistentDir := persistentFailoverDir
	persistentFailoverDir = filepath.Join(lab.work, "failover")
	t.Cleanup(func() { persistentFailoverDir = oldPersistentDir })
	lab.target = startE2ETarget(t, bundle.TargetPort)
	for _, exit := range bundle.Exits {
		lab.writeExitConfig(exit, bundle.ExitGost[fmt.Sprint(exit.HostID)])
		lab.startGost(lab.exitName(exit))
	}
	if bundle.Relay != nil {
		// 中转也绑自己的地址往外拨：目标看到它就是中转绕过出口直连了
		lab.writeExitConfig(e2eExit{HostID: bundle.Relay.HostID, IP: bundle.Relay.IP, Port: bundle.Relay.Port}, bundle.RelayGost)
		lab.startGost(lab.exitName(*bundle.Relay))
	}
	lab.configs["entry"] = lab.writeConfig("entry", bundle.EntryGost)
	lab.startGost("entry")
	t.Cleanup(func() {
		stopFailoverProxy(bundle.RuleID, bundle.Failover.SourcePort)
		for name := range lab.procs {
			lab.stopGost(name)
		}
	})
	if !startFailoverProxy(bundle.RuleID, bundle.Failover.SourcePort, bundle.Failover.Spec, nil) {
		t.Fatal("本机代理没起来")
	}
	// 第一轮探测（起代理时立刻探）落定
	lab.waitFor("三台出口都探通", 5*time.Second, func() bool {
		for i := range bundle.Exits {
			if !lab.healthy(i) || lab.proxyLatency(i) <= 0 {
				return false
			}
		}
		return true
	})
	return lab
}

func (lab *e2eLab) exitName(exit e2eExit) string { return fmt.Sprintf("exit-%d", exit.HostID) }

func (lab *e2eLab) writeConfig(name string, raw json.RawMessage) string {
	path := filepath.Join(lab.work, name+".json")
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		lab.t.Fatal(err)
	}
	return path
}

// 出口的配置原样用面板生成的，只加一项：往外拨时绑自己的地址（目标靠它认是哪台出口）。
func (lab *e2eLab) writeExitConfig(exit e2eExit, raw json.RawMessage) {
	var config map[string]any
	if err := json.Unmarshal(raw, &config); err != nil || config == nil {
		lab.t.Fatalf("出口 %d 的隧道配置没取到: %v", exit.HostID, err)
	}
	services, _ := config["services"].([]any)
	if len(services) == 0 {
		lab.t.Fatalf("出口 %d 的隧道配置里没有服务", exit.HostID)
	}
	for _, item := range services {
		service, _ := item.(map[string]any)
		metadata, _ := service["metadata"].(map[string]any)
		if metadata == nil {
			metadata = map[string]any{}
		}
		metadata["interface"] = exit.IP
		service["metadata"] = metadata
	}
	patched, _ := json.Marshal(config)
	lab.configs[lab.exitName(exit)] = lab.writeConfig(lab.exitName(exit), patched)
}

func (lab *e2eLab) startGost(name string) {
	lab.t.Helper()
	logPath := filepath.Join(lab.work, name+".log")
	logFile, err := os.Create(logPath)
	if err != nil {
		lab.t.Fatal(err)
	}
	cmd := exec.Command(lab.gostBin, "-C", lab.configs[name])
	cmd.Stdout, cmd.Stderr = logFile, logFile
	if err := cmd.Start(); err != nil {
		lab.t.Fatalf("gost %s 没起来: %v", name, err)
	}
	_ = logFile.Close()
	lab.procs[name] = cmd
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		if content, _ := os.ReadFile(logPath); bytes.Contains(content, []byte("listening on")) {
			// 入口有好几个服务：再等一下让它们都听上
			time.Sleep(300 * time.Millisecond)
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	content, _ := os.ReadFile(logPath)
	lab.t.Fatalf("gost %s 没开始监听:\n%s", name, content)
}

func (lab *e2eLab) stopGost(name string) {
	cmd := lab.procs[name]
	if cmd == nil || cmd.Process == nil {
		return
	}
	_ = cmd.Process.Kill()
	_, _ = cmd.Process.Wait()
	delete(lab.procs, name)
}

func (lab *e2eLab) proxy() *failoverProxy {
	return currentFailoverProxy(lab.bundle.RuleID, lab.bundle.Failover.SourcePort)
}

func (lab *e2eLab) healthy(index int) bool {
	p := lab.proxy()
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.healthyLocked(index)
}

func (lab *e2eLab) proxyLatency(index int) int {
	p := lab.proxy()
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.latencyMsLocked(index)
}

/*
setExtraLatency 面板给这台出口的「出口 → 目标」延迟提示（ExtraLatencyMs，server/exitTargetHealth.ts 从出口机探目标
的结果算的）：和心跳里 runningRules 同步规格一样再调一次 startFailoverProxy，规格签名不变，提示原地换上
（applyRelayHintsLocked）。「延迟优先 / 自动」的整链延迟 = 本机探到的入口 → 出口 + 它。本机的三台出口都在回环上，
入口 → 出口那一段一样快；要让一台「慢」，只能从这一段加（这台机器上没有 netem）。
*/
func (lab *e2eLab) setExtraLatency(index int, ms int) {
	lab.t.Helper()
	spec := lab.bundle.Failover.Spec
	spec.Targets = append([]failoverTarget(nil), spec.Targets...)
	spec.Targets[index].ExtraLatencyMs = ms
	if !startFailoverProxy(lab.bundle.RuleID, lab.bundle.Failover.SourcePort, spec, nil) {
		lab.t.Fatal("换提示时本机代理没起来")
	}
	p := lab.proxy()
	p.mu.RLock()
	got := p.spec.Targets[index].ExtraLatencyMs
	p.mu.RUnlock()
	if got != ms {
		lab.t.Fatalf("提示没换上：出口 %d 的下游延迟是 %d，应当是 %d", index, got, ms)
	}
}

func (lab *e2eLab) waitFor(what string, limit time.Duration, check func() bool) time.Duration {
	lab.t.Helper()
	started := time.Now()
	for time.Since(started) < limit {
		if check() {
			return time.Since(started)
		}
		time.Sleep(20 * time.Millisecond)
	}
	lab.t.Fatalf("等了 %s 还没有：%s", limit, what)
	return 0
}

func (lab *e2eLab) exitIndexByIP(ip string) int {
	for i, exit := range lab.bundle.Exits {
		if exit.IP == ip {
			return i
		}
	}
	return -1
}

// 目标只许看到出口的地址：看到入口机（127.0.0.1）或中转的地址，就是有人绕过出口直连了目标。
func (lab *e2eLab) noDirect() {
	lab.t.Helper()
	for peer, count := range lab.target.snapshot() {
		fields := strings.Fields(peer)
		if len(fields) != 2 || lab.exitIndexByIP(fields[1]) < 0 {
			lab.t.Fatalf("目标收到了不是出口拨来的 %d 条（%s，绕过了隧道）：%v", count, peer, lab.target.snapshot())
		}
	}
}

// ---- 访客 ----

type e2eReply struct {
	exitIP      string
	proxySource string
	elapsed     time.Duration
}

// 一条 TCP 连接：从 visitor 这个地址连入口的公网端口，发一行、等回话。prefix 是先发的字节（PROXY 头）。
func (lab *e2eLab) tcpOnce(visitor string, prefix string, timeout time.Duration) (e2eReply, error) {
	conn, reply, err := lab.tcpOpen(visitor, prefix, timeout)
	if conn != nil {
		_ = conn.Close()
	}
	return reply, err
}

func (lab *e2eLab) tcpOpen(visitor string, prefix string, timeout time.Duration) (net.Conn, e2eReply, error) {
	return lab.tcpOpenAfter(visitor, prefix, timeout, 0)
}

// tcpOpenAfter：连上以后先等 delay 再说话（高防目标会把「连上不说话」的连接关掉）。
func (lab *e2eLab) tcpOpenAfter(visitor string, prefix string, timeout time.Duration, delay time.Duration) (net.Conn, e2eReply, error) {
	started := time.Now()
	dialer := net.Dialer{Timeout: timeout, LocalAddr: &net.TCPAddr{IP: net.ParseIP(visitor)}}
	conn, err := dialer.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", lab.bundle.EntryPort))
	if err != nil {
		return nil, e2eReply{}, err
	}
	if delay > 0 {
		time.Sleep(delay)
	}
	_ = conn.SetDeadline(time.Now().Add(timeout))
	if _, err := conn.Write([]byte(prefix + "hello\n")); err != nil {
		return conn, e2eReply{}, err
	}
	line, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil {
		return conn, e2eReply{}, fmt.Errorf("没等到回话（%s 后）: %w", time.Since(started).Round(time.Millisecond), err)
	}
	_ = conn.SetDeadline(time.Time{})
	fields := strings.Fields(line)
	if len(fields) < 3 {
		return conn, e2eReply{}, fmt.Errorf("回话不对: %q", line)
	}
	return conn, e2eReply{exitIP: fields[0], proxySource: fields[1], elapsed: time.Since(started)}, nil
}

type e2eUDPSession struct {
	conn *net.UDPConn
}

func (lab *e2eLab) udpOpen(visitor string) *e2eUDPSession {
	lab.t.Helper()
	conn, err := net.DialUDP("udp", &net.UDPAddr{IP: net.ParseIP(visitor)}, &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: lab.bundle.EntryPort})
	if err != nil {
		lab.t.Fatal(err)
	}
	return &e2eUDPSession{conn: conn}
}

// 发一个包、等回包，回「是哪台出口拨到目标的」。
func (session *e2eUDPSession) ask(timeout time.Duration) (string, error) {
	payload := fmt.Sprintf("ping-%d", time.Now().UnixNano())
	if _, err := session.conn.Write([]byte(payload)); err != nil {
		return "", err
	}
	_ = session.conn.SetReadDeadline(time.Now().Add(timeout))
	buf := make([]byte, 2048)
	for {
		n, err := session.conn.Read(buf)
		if err != nil {
			return "", err
		}
		fields := strings.Fields(string(buf[:n]))
		// 晚到的旧回包不算
		if len(fields) == 2 && fields[1] == payload {
			return fields[0], nil
		}
	}
}

func e2eVisitor(index int) string { return fmt.Sprintf("127.0.0.%d", 101+index%100) }

func e2eCounts(counts map[string]int, exits []e2eExit) string {
	parts := make([]string, 0, len(exits))
	for _, exit := range exits {
		parts = append(parts, fmt.Sprintf("%s=%d", exit.IP, counts[exit.IP]))
	}
	extra := []string{}
	for ip := range counts {
		known := false
		for _, exit := range exits {
			if exit.IP == ip {
				known = true
			}
		}
		if !known {
			extra = append(extra, fmt.Sprintf("%s=%d(!)", ip, counts[ip]))
		}
	}
	sort.Strings(extra)
	return strings.Join(append(parts, extra...), " ")
}

// n 条依次建立、马上关的 TCP 连接（访客轮着换），每台出口收到几条。
func (lab *e2eLab) tcpSpread(n int, visitors int) map[string]int {
	lab.t.Helper()
	counts := map[string]int{}
	for i := 0; i < n; i++ {
		reply, err := lab.tcpOnce(e2eVisitor(i%visitors), "", 6*time.Second)
		if err != nil {
			lab.t.Fatalf("第 %d 条 TCP 失败: %v", i+1, err)
		}
		counts[reply.exitIP]++
	}
	return counts
}

// n 条同时挂着的 TCP 连接（按负载 / 自动要看「现在挂着几条」）。
func (lab *e2eLab) tcpHeldSpread(n int, visitors int) map[string]int {
	lab.t.Helper()
	counts := map[string]int{}
	held := []net.Conn{}
	defer func() {
		for _, conn := range held {
			_ = conn.Close()
		}
	}()
	for i := 0; i < n; i++ {
		conn, reply, err := lab.tcpOpen(e2eVisitor(i%visitors), "", 6*time.Second)
		if conn != nil {
			held = append(held, conn)
		}
		if err != nil {
			lab.t.Fatalf("第 %d 条 TCP 失败: %v", i+1, err)
		}
		counts[reply.exitIP]++
	}
	return counts
}

// n 个 UDP 会话（每个访客一个套接字），每台出口收到几个。
func (lab *e2eLab) udpSpread(n int) (map[string]int, map[string]string) {
	lab.t.Helper()
	counts := map[string]int{}
	byVisitor := map[string]string{}
	for i := 0; i < n; i++ {
		session := lab.udpOpen(e2eVisitor(i))
		exitIP, err := session.ask(4 * time.Second)
		_ = session.conn.Close()
		if err != nil {
			lab.t.Fatalf("第 %d 个 UDP 会话没回包: %v", i+1, err)
		}
		counts[exitIP]++
		byVisitor[e2eVisitor(i)] = exitIP
	}
	return counts, byVisitor
}

func e2eRun(t *testing.T, name string, args ...string) {
	t.Helper()
	if out, err := exec.Command(name, args...).CombinedOutput(); err != nil {
		t.Fatalf("%s %s: %v\n%s", name, strings.Join(args, " "), err, out)
	}
}

// 黑洞一台出口：发往它隧道端口的 TCP 包全丢（不回 RST，和机器断电 / 线路中断一样）。返回撤掉的函数。
func (lab *e2eLab) blackhole(exit e2eExit) func() {
	args := []string{"INPUT", "-i", "lo", "-p", "tcp", "-d", exit.IP, "--dport", fmt.Sprint(exit.Port), "-m", "comment", "--comment", "fwx-balance-e2e", "-j", "DROP"}
	e2eRun(lab.t, "iptables", append([]string{"-I"}, args...)...)
	undone := false
	undo := func() {
		if !undone {
			undone = true
			_ = exec.Command("iptables", append([]string{"-D"}, args...)...).Run()
		}
	}
	lab.t.Cleanup(undo)
	return undo
}

// 这台出口拨不到目标：它（绑的地址）发往目标端口的 TCP 被拒。返回撤掉的函数。
func (lab *e2eLab) rejectTarget(exit e2eExit) func() {
	args := []string{"INPUT", "-i", "lo", "-p", "tcp", "-s", exit.IP, "--dport", fmt.Sprint(lab.bundle.TargetPort), "-m", "comment", "--comment", "fwx-balance-e2e", "-j", "REJECT", "--reject-with", "tcp-reset"}
	e2eRun(lab.t, "iptables", append([]string{"-I"}, args...)...)
	undone := false
	undo := func() {
		if !undone {
			undone = true
			_ = exec.Command("iptables", append([]string{"-D"}, args...)...).Run()
		}
	}
	lab.t.Cleanup(undo)
	return undo
}

// ---- 场景 ----

func TestBalanceProxyE2E(t *testing.T) {
	e2eEnv(t)

	t.Run("分配方式", func(t *testing.T) {
		for _, scenario := range []string{"round_robin", "random", "weighted", "least_load", "auto", "fallback", "latency", "ip_hash"} {
			t.Run(scenario, func(t *testing.T) {
				lab := newE2ELab(t, scenario)
				exits := lab.bundle.Exits
				spec := lab.bundle.Failover.Spec
				weights := make([]int, len(exits))
				for i, target := range spec.Targets {
					weights[i] = target.Weight
				}
				// 延迟优先：本机三台出口一样快；面板说第三台到目标比别的慢出门槛一大截（见下面的断言）
				slowExit, slowExtraMs := 2, int(spec.LatencyMarginMs)+150
				if scenario == "latency" {
					lab.setExtraLatency(slowExit, slowExtraMs)
				}
				var tcp map[string]int
				switch scenario {
				case "least_load", "auto", "latency":
					tcp = lab.tcpHeldSpread(64, 16)
				default:
					tcp = lab.tcpSpread(64, 16)
				}
				udp, udpByVisitor := lab.udpSpread(32)
				t.Logf("%-11s 代理策略=%s 择优=%v 份数=%v | TCP 64 条：%s | UDP 32 个会话：%s", scenario, spec.Strategy, spec.PreferFastest, weights, e2eCounts(tcp, exits), e2eCounts(udp, exits))
				lab.noDirect()
				used := func(counts map[string]int) int {
					n := 0
					for _, exit := range exits {
						if counts[exit.IP] > 0 {
							n++
						}
					}
					return n
				}
				switch scenario {
				case "round_robin":
					for _, exit := range exits {
						if tcp[exit.IP] < 20 || tcp[exit.IP] > 23 || udp[exit.IP] < 9 || udp[exit.IP] > 12 {
							t.Fatalf("轮流应当三台均分")
						}
					}
				case "random":
					if used(tcp) != 3 || used(udp) != 3 {
						t.Fatalf("随机应当三台都分到")
					}
				case "weighted":
					// 份数 8 : 5 : 3，64 条正好 32 / 20 / 12；UDP 32 个是 16 / 10 / 6
					for i, exit := range exits {
						if want := 64 * weights[i] / 16; tcp[exit.IP] < want-1 || tcp[exit.IP] > want+1 {
							t.Fatalf("按权重 TCP %s 应当约 %d 条，实际 %d", exit.IP, want, tcp[exit.IP])
						}
						if want := 32 * weights[i] / 16; udp[exit.IP] < want-1 || udp[exit.IP] > want+1 {
							t.Fatalf("按权重 UDP %s 应当约 %d 个，实际 %d", exit.IP, want, udp[exit.IP])
						}
					}
				case "least_load":
					// 挂着的连接数 ÷ 份数 拉平：64 条挂着时约 32 / 20 / 12
					for i, exit := range exits {
						if want := 64 * weights[i] / 16; tcp[exit.IP] < want-3 || tcp[exit.IP] > want+3 {
							t.Fatalf("按负载 %s 应当约 %d 条，实际 %d", exit.IP, want, tcp[exit.IP])
						}
					}
				case "auto":
					if used(tcp) != 3 {
						t.Fatalf("自动应当三台都分到")
					}
					if tcp[exits[0].IP] <= tcp[exits[2].IP] {
						t.Fatalf("自动：份数大的那台应当分得更多")
					}
				case "fallback":
					// 主备：全走第一台
					if tcp[exits[0].IP] != 64 || udp[exits[0].IP] != 32 {
						t.Fatalf("%s 应当全走第一台", scenario)
					}
				case "latency":
					/*
						延迟优先（统一调度以后是 lbcore 的 NearSet + 自动，不再是「主备 + 择优」）：和最快的差不到门槛
						（spec.LatencyMarginMs）的几台算「一样快」，在这几台里按自动的成本分（挂着的连接 ÷ 份数）；
						慢出门槛的一条都分不到。以前这里断言「全走第一台」，那是旧实现（fallback + preferFastest：
						三台一样快就留在现在这台上）的行为，统一调度时有意改掉了。
					*/
					for _, i := range []int{0, 1} {
						if tcp[exits[i].IP] == 0 || udp[exits[i].IP] == 0 {
							t.Fatalf("延迟优先：%s 和最快的一样快，应当一起分（TCP %d、UDP %d）", exits[i].IP, tcp[exits[i].IP], udp[exits[i].IP])
						}
					}
					if tcp[exits[slowExit].IP] != 0 || udp[exits[slowExit].IP] != 0 {
						t.Fatalf("延迟优先：%s 比最快的慢 %dms（门槛 %vms），不该分到（TCP %d、UDP %d）", exits[slowExit].IP, slowExtraMs, spec.LatencyMarginMs, tcp[exits[slowExit].IP], udp[exits[slowExit].IP])
					}
					t.Logf("延迟优先：%s 慢 %dms（门槛 %vms）一条没分到，另外两台一起分", exits[slowExit].IP, slowExtraMs, spec.LatencyMarginMs)
				case "ip_hash":
					if used(tcp) < 2 {
						t.Fatalf("按访客固定：16 个访客应当散到不止一台")
					}
					// 每个访客再连 4 次都落在同一台；它的 UDP 也是那一台
					sticky := map[string]string{}
					for visitor := 0; visitor < 16; visitor++ {
						for round := 0; round < 4; round++ {
							reply, err := lab.tcpOnce(e2eVisitor(visitor), "", 6*time.Second)
							if err != nil {
								t.Fatal(err)
							}
							if previous, ok := sticky[e2eVisitor(visitor)]; ok && previous != reply.exitIP {
								t.Fatalf("访客 %s 一会儿走 %s 一会儿走 %s", e2eVisitor(visitor), previous, reply.exitIP)
							}
							sticky[e2eVisitor(visitor)] = reply.exitIP
						}
						if udpExit := udpByVisitor[e2eVisitor(visitor)]; udpExit != sticky[e2eVisitor(visitor)] {
							t.Fatalf("访客 %s 的 TCP 走 %s、UDP 走 %s，应当是同一台", e2eVisitor(visitor), sticky[e2eVisitor(visitor)], udpExit)
						}
					}
					t.Logf("按访客固定：16 个访客各连 4 次都没换出口，UDP 和 TCP 同一台")
				}
				// 报给面板的：picks 是累计分到的条数，share 是最近一分钟的比例
				rules, _ := collectAgentBalanceReports(time.Now(), true)
				for _, rule := range rules {
					if rule.RuleID != lab.bundle.RuleID {
						continue
					}
					total := 0
					line := []string{}
					for i, exit := range rule.Exits {
						total += exit.Picks
						line = append(line, fmt.Sprintf("%s %s picks=%d share=%.3f", exits[i].IP, exit.State, exit.Picks, exit.Share))
						if scenario != "ip_hash" && exit.Picks != tcp[exits[i].IP]+udp[exits[i].IP] {
							t.Fatalf("上报的 picks 应当是累计分到的条数：%s 报 %d，实际 %d", exits[i].IP, exit.Picks, tcp[exits[i].IP]+udp[exits[i].IP])
						}
					}
					t.Logf("上报：%s", strings.Join(line, " | "))
					if total == 0 {
						t.Fatal("上报里没有 picks")
					}
					// 代理刚起来不到一分钟：最近一分钟的比例就是累计的比例
					for i, exit := range rule.Exits {
						if want := float64(exit.Picks) / float64(total); exit.Share < want-0.002 || exit.Share > want+0.002 {
							t.Fatalf("上报的 share 应当是最近分到的比例：%s 报 %.3f，实际 %.3f", exits[i].IP, exit.Share, want)
						}
					}
				}
			})
		}
	})

	// 出口死掉：多久摘掉、期间连接有没有失败、回来多久放回。how：kill（进程没了，连接被拒）/ blackhole（包全丢）。
	failure := func(t *testing.T, scenario string, how string, excludeLimit time.Duration) {
		lab := newE2ELab(t, scenario)
		exits := lab.bundle.Exits
		victim := 1
		var restore func()
		died := time.Now()
		if how == "kill" {
			lab.stopGost(lab.exitName(exits[victim]))
			restore = func() { lab.startGost(lab.exitName(exits[victim])) }
		} else {
			restore = lab.blackhole(exits[victim])
		}
		// 一边不停地开新连接（每 100ms 一条，访客轮着换），一边等代理把它判坏
		type sample struct {
			at      time.Duration
			reply   e2eReply
			err     error
			started time.Duration
		}
		var mu sync.Mutex
		samples := []sample{}
		stop := make(chan struct{})
		var wg sync.WaitGroup
		go func() {
			for i := 0; ; i++ {
				select {
				case <-stop:
					return
				default:
				}
				wg.Add(1)
				go func(i int) {
					defer wg.Done()
					started := time.Since(died)
					reply, err := lab.tcpOnce(e2eVisitor(i), "", 12*time.Second)
					mu.Lock()
					samples = append(samples, sample{at: time.Since(died), reply: reply, err: err, started: started})
					mu.Unlock()
				}(i)
				time.Sleep(100 * time.Millisecond)
			}
		}()
		excluded := lab.waitFor("坏出口被摘掉", 15*time.Second, func() bool { return !lab.healthy(victim) })
		excludedAt := time.Since(died)
		time.Sleep(1500 * time.Millisecond)
		close(stop)
		wg.Wait()
		failed, slow, onVictimAfter := 0, 0, 0
		var slowest time.Duration
		for _, item := range samples {
			if item.err != nil {
				failed++
				t.Logf("  失败的连接（出口死后 %s 发起）: %v", item.started.Round(time.Millisecond), item.err)
				continue
			}
			if item.reply.elapsed > time.Second {
				slow++
			}
			if item.reply.elapsed > slowest {
				slowest = item.reply.elapsed
			}
			if item.started > excludedAt && item.reply.exitIP == exits[victim].IP {
				onVictimAfter++
			}
		}
		t.Logf("%s / %s：出口死后 %s 被摘掉（直接探测 %ds 一轮、%d 次判坏）；期间开了 %d 条新连接，失败 %d 条，等了 1 秒以上才通的 %d 条（最慢 %s，被换路重发的），摘掉以后还落在它上面的 %d 条",
			scenario, how, excluded.Round(10*time.Millisecond), lab.bundle.Failover.Spec.ProbeIntervalSeconds, lab.bundle.Failover.Spec.FailureThreshold, len(samples), failed, slow, slowest.Round(10*time.Millisecond), onVictimAfter)
		if excluded > excludeLimit {
			t.Fatalf("摘掉用了 %s，超过 %s", excluded, excludeLimit)
		}
		if failed != 0 {
			t.Fatalf("出口死掉期间有 %d 条新连接失败（应当全部被换到别的出口）", failed)
		}
		if onVictimAfter != 0 {
			t.Fatalf("摘掉以后还有连接落在坏出口上")
		}
		after := lab.tcpSpread(30, 10)
		if after[exits[victim].IP] != 0 {
			t.Fatalf("摘掉以后 30 条里还有 %d 条走坏出口", after[exits[victim].IP])
		}
		lab.noDirect()

		restored := time.Now()
		restore()
		recovered := lab.waitFor("出口恢复", 20*time.Second, func() bool { return lab.healthy(victim) })
		serving := lab.waitFor("恢复的出口重新接到连接", 20*time.Second, func() bool {
			reply, err := lab.tcpOnce(e2eVisitor(int(time.Since(restored)/time.Millisecond)), "", 6*time.Second)
			return err == nil && reply.exitIP == exits[victim].IP
		})
		t.Logf("%s / %s：出口回来后 %s 判为恢复，再过 %s 接到第一条新连接", scenario, how, recovered.Round(10*time.Millisecond), serving.Round(10*time.Millisecond))
		if recovered > 10*time.Second {
			t.Fatalf("恢复用了 %s，超过 10 秒", recovered)
		}
		lab.noDirect()
	}
	t.Run("出口进程死掉（拒绝连接）", func(t *testing.T) { failure(t, "round_robin", "kill", 6*time.Second) })
	t.Run("出口被黑洞", func(t *testing.T) {
		if !e2eIptables() {
			t.Skip("要 root 和 iptables")
		}
		failure(t, "round_robin", "blackhole", 6*time.Second)
	})
	t.Run("出口被黑洞（灵敏档：1 秒一轮）", func(t *testing.T) {
		if !e2eIptables() {
			t.Skip("要 root 和 iptables")
		}
		failure(t, "sensitive", "blackhole", 4*time.Second)
	})

	t.Run("UDP 会话所在的出口被黑洞：会话自己换出口", func(t *testing.T) {
		if !e2eIptables() {
			t.Skip("要 root 和 iptables")
		}
		lab := newE2ELab(t, "round_robin")
		exits := lab.bundle.Exits
		session := lab.udpOpen(e2eVisitor(7))
		defer session.conn.Close()
		first, err := session.ask(4 * time.Second)
		if err != nil {
			t.Fatal(err)
		}
		victim := lab.exitIndexByIP(first)
		died := time.Now()
		lab.blackhole(exits[victim])
		var moved string
		resumed := lab.waitFor("UDP 会话换到别的出口并恢复回包", 15*time.Second, func() bool {
			exitIP, err := session.ask(300 * time.Millisecond)
			if err == nil && exitIP != first {
				moved = exitIP
				return true
			}
			return false
		})
		t.Logf("UDP：会话原来走 %s，它被黑洞后 %s 换到 %s 并恢复回包（同一个套接字一直在发，没有重连）；代理 %s 时把它判坏", first, resumed.Round(10*time.Millisecond), moved, time.Since(died).Round(10*time.Millisecond))
		if resumed > 7*time.Second {
			t.Fatalf("UDP 会话 %s 才换出口", resumed)
		}
		lab.noDirect()
	})

	t.Run("单台出口到目标不通：真实连接被关 → 经出口复核 → 判坏", func(t *testing.T) {
		if !e2eIptables() {
			t.Skip("要 root 和 iptables")
		}
		lab := newE2ELab(t, "round_robin")
		exits := lab.bundle.Exits
		victim := 2
		undo := lab.rejectTarget(exits[victim])
		broke := time.Now()
		// 出口机本身好好的（直接探得通），只有真实连接撞上去才知道
		time.Sleep(2500 * time.Millisecond)
		if !lab.healthy(victim) {
			t.Fatalf("没有流量时不该判坏：出口机本身是通的")
		}
		firstHit := time.Now()
		counts := lab.tcpSpread(12, 6)
		lab.waitFor("经出口复核后判坏", 5*time.Second, func() bool { return !lab.healthy(victim) })
		downAfter := time.Since(firstHit)
		p := lab.proxy()
		p.mu.RLock()
		through := p.exitThroughFailed[victim]
		p.mu.RUnlock()
		t.Logf("出口 %s 到目标被拒（出口机本身通）：%s 没有流量时照常算好的；第一批 12 条连接全部成功（%s，撞上它的被无感换走），第一条连接后 %s 判坏（经出口复核=%v）",
			exits[victim].IP, firstHit.Sub(broke).Round(100*time.Millisecond), e2eCounts(counts, exits), downAfter.Round(10*time.Millisecond), through)
		if counts[exits[victim].IP] != 0 {
			t.Fatalf("到目标不通的出口不该送到过连接")
		}
		if !through {
			t.Fatalf("应当是经出口复核判的坏")
		}
		// 直接探出口机一直是通的，可它不该被放回来
		time.Sleep(7 * time.Second)
		if lab.healthy(victim) {
			t.Fatalf("到目标还不通，出口却被放回来了（直接探通不等于走得通）")
		}
		undo()
		recovered := lab.waitFor("到目标恢复后放回", 15*time.Second, func() bool { return lab.healthy(victim) })
		t.Logf("到目标恢复后 %s 放回（经出口连着探通 %d 次、每次等 %s）", recovered.Round(10*time.Millisecond), exitThroughRecoverOKs, exitConfirmWindow)
		/*
			上限 12 秒（以前是 10 秒）：F2 起判坏过的出口要经出口连着探通 exitThroughRecoverOKs（2）次、每次等满
			exitConfirmWindow（4 秒，gost 拨死出口要 3 秒才关，等得短了死出口每次都像「探通」）才放回，这是有意的。
			最坏：恢复后最多一轮探测（2 秒 + 抖动）才发起第一次，再 2 × 4 秒 —— 约 10 秒，留 2 秒余量。
		*/
		if recovered > 12*time.Second {
			t.Fatalf("恢复用了 %s，超过 12 秒", recovered)
		}
		lab.noDirect()
	})

	t.Run("高防目标只把一台出口「连上不说话」的连接提前关掉：误判后靠真实连接放回", func(t *testing.T) {
		/*
			用户实测（2026-11-20）：三台出口机都正常，目标是高防，把 Jinx 那台出口「连上不说话」的连接 1 秒就关 —— 经出口
			复核把它判成「到目标不行」，之后不说话的恢复探测同样被关，11 分钟没放回；可说话的真实连接走它根本没问题。
			现在判坏过、出口机本身探得通的出口，每隔 exitCanaryGap 让一条真实连接先试它，回了东西就当场放回。
		*/
		lab := newE2ELab(t, "round_robin")
		exits := lab.bundle.Exits
		victim := 1
		lab.target.closeSilentFrom(exits[victim].IP, time.Second)
		// 几条连上以后 1.5 秒才说话的连接：经 victim 的被目标关掉、无感换走，复核时经 victim 的不说话探测又被关而别的开着 → 判坏
		for i := 0; i < 6; i++ {
			conn, _, err := lab.tcpOpenAfter(e2eVisitor(i), "", 6*time.Second, 1500*time.Millisecond)
			if conn != nil {
				_ = conn.Close()
			}
			if err != nil {
				t.Fatalf("第 %d 条晚说话的连接失败了（被关了就该无感换走）: %v", i+1, err)
			}
		}
		lab.waitFor("经出口复核判坏", 6*time.Second, func() bool { return !lab.healthy(victim) })
		judged := time.Now()
		p := lab.proxy()
		p.mu.RLock()
		through := p.exitThroughFailed[victim]
		p.mu.RUnlock()
		if !through {
			t.Fatal("应当是经出口复核判的坏")
		}
		// 正常（马上说话）的流量继续：到点的那条连接先试 victim，目标回了话 → 放回
		recovered := time.Duration(0)
		counts := map[string]int{}
		for i := 0; i < 40 && recovered == 0; i++ {
			reply, err := lab.tcpOnce(e2eVisitor(i), "", 6*time.Second)
			if err != nil {
				t.Fatalf("正常连接失败: %v", err)
			}
			counts[reply.exitIP]++
			if lab.healthy(victim) {
				recovered = time.Since(judged)
			}
			time.Sleep(300 * time.Millisecond)
		}
		if recovered == 0 {
			t.Fatalf("有正常流量，判错的出口却一直没放回：%s", e2eCounts(counts, exits))
		}
		t.Logf("高防把 %s 不说话的连接 1 秒就关：判坏后 %s 由一条真实连接放回（%s）", exits[victim].IP, recovered.Round(10*time.Millisecond), e2eCounts(counts, exits))
		if recovered > 8*time.Second {
			t.Fatalf("放回用了 %s，超过 8 秒（exitCanaryGap 4 秒 + 一条连接）", recovered)
		}
		// 放回以后照常分到它（刚放回的 60 秒里从一成份量慢慢加，所以多开几批、给它一点时间）
		after := map[string]int{}
		lab.waitFor("放回以后又分到它", 20*time.Second, func() bool {
			for ip, count := range lab.tcpSpread(6, 6) {
				after[ip] += count
			}
			return after[exits[victim].IP] > 0
		})
		t.Logf("放回以后：%s", e2eCounts(after, exits))
		lab.noDirect()
	})

	t.Run("手动指定出口", func(t *testing.T) {
		lab := newE2ELab(t, "pin")
		exits := lab.bundle.Exits
		pinned := 1
		if spec := lab.bundle.Failover.Spec; spec.PinnedIndex == nil || *spec.PinnedIndex != pinned {
			t.Fatalf("规格里没带手动指定: %+v", spec.PinnedIndex)
		}
		tcp := lab.tcpSpread(30, 10)
		udp, _ := lab.udpSpread(12)
		t.Logf("指定 %s（分配方式是轮流）：TCP %s | UDP %s", exits[pinned].IP, e2eCounts(tcp, exits), e2eCounts(udp, exits))
		if tcp[exits[pinned].IP] != 30 || udp[exits[pinned].IP] != 12 {
			t.Fatalf("指定以后应当只走那一台")
		}
		// 指定的那台死了：不黑洞，照常分给别的
		lab.stopGost(lab.exitName(exits[pinned]))
		died := time.Now()
		failed := 0
		during := map[string]int{}
		for time.Since(died) < 7*time.Second {
			reply, err := lab.tcpOnce(e2eVisitor(int(time.Since(died)/(100*time.Millisecond))), "", 8*time.Second)
			if err != nil {
				failed++
			} else {
				during[reply.exitIP]++
			}
			time.Sleep(100 * time.Millisecond)
		}
		t.Logf("指定的那台死掉后的 7 秒里：失败 %d 条，成功的分布 %s（代理当场不理这个指定）", failed, e2eCounts(during, exits))
		if failed != 0 || during[exits[pinned].IP] != 0 || during[exits[0].IP] == 0 || during[exits[2].IP] == 0 {
			t.Fatalf("指定的出口死了应当照常分给另外两台，一条都不失败")
		}
		lab.startGost(lab.exitName(exits[pinned]))
		lab.waitFor("指定的出口恢复", 15*time.Second, func() bool { return lab.healthy(pinned) })
		back := lab.tcpSpread(20, 10)
		t.Logf("指定的那台回来以后：%s", e2eCounts(back, exits))
		if back[exits[pinned].IP] != 20 {
			t.Fatalf("指定的出口回来以后应当又只走它")
		}
		lab.noDirect()
	})

	t.Run("PROXY protocol", func(t *testing.T) {
		t.Run("入口发送：目标收到带访客地址的头，照样分", func(t *testing.T) {
			lab := newE2ELab(t, "proxy-send")
			exits := lab.bundle.Exits
			counts := map[string]int{}
			for i := 0; i < 30; i++ {
				reply, err := lab.tcpOnce(e2eVisitor(i%10), "", 6*time.Second)
				if err != nil {
					t.Fatal(err)
				}
				if reply.proxySource != e2eVisitor(i%10) {
					t.Fatalf("目标从 PROXY 头里读到的访客是 %q，应当是 %s", reply.proxySource, e2eVisitor(i%10))
				}
				counts[reply.exitIP]++
			}
			t.Logf("入口发送 PROXY v2：30 条连接目标都读到了真实访客地址；分布 %s", e2eCounts(counts, exits))
			for _, exit := range exits {
				if counts[exit.IP] != 10 {
					t.Fatalf("轮流应当均分")
				}
			}
			lab.noDirect()
		})
		t.Run("入口接收：按头里的访客固定，目标不收到头", func(t *testing.T) {
			lab := newE2ELab(t, "proxy-receive")
			exits := lab.bundle.Exits
			byClaimed := map[string]string{}
			used := map[string]int{}
			for i := 0; i < 48; i++ {
				claimed := fmt.Sprintf("203.0.113.%d", 1+i%12)
				// 真正连过来的地址每次都不一样；头里的访客才算数
				reply, err := lab.tcpOnce(e2eVisitor(i), fmt.Sprintf("PROXY TCP4 %s 198.51.100.1 4000 443\r\n", claimed), 6*time.Second)
				if err != nil {
					t.Fatal(err)
				}
				if reply.proxySource != "-" {
					t.Fatalf("规则没开「入口发送」，目标不该收到 PROXY 头（读到 %q）", reply.proxySource)
				}
				if previous, ok := byClaimed[claimed]; ok && previous != reply.exitIP {
					t.Fatalf("头里的访客 %s 一会儿走 %s 一会儿走 %s", claimed, previous, reply.exitIP)
				}
				byClaimed[claimed] = reply.exitIP
				used[reply.exitIP]++
			}
			t.Logf("入口接收 PROXY v1 + 按访客固定：12 个头里的访客各 4 条（真实来源每次不同）都没换出口；分布 %s", e2eCounts(used, exits))
			if len(used) < 2 {
				t.Fatalf("12 个访客应当散到不止一台")
			}
			lab.noDirect()
		})
	})

	t.Run("多跳（入口 → 中转 → 三台出口）", func(t *testing.T) {
		lab := newE2ELab(t, "multihop")
		exits := lab.bundle.Exits
		for i, target := range lab.bundle.Failover.Spec.Targets {
			if !target.ViaRelay {
				t.Fatalf("多跳的第 %d 条目标应当带 viaRelay（入口机探不到出口）", i)
			}
		}
		tcp := lab.tcpSpread(30, 10)
		udp, _ := lab.udpSpread(30)
		t.Logf("多跳 轮流：TCP %s | UDP %s", e2eCounts(tcp, exits), e2eCounts(udp, exits))
		for _, exit := range exits {
			if tcp[exit.IP] != 10 || udp[exit.IP] != 10 {
				t.Fatalf("轮流应当均分")
			}
		}
		lab.noDirect()
		if !e2eIptables() {
			return
		}
		// 出口在中转后面：入口机探不到它。黑洞以后靠真实连接「被关 → 换走 → 经出口复核」发现
		victim := 2
		undo := lab.blackhole(exits[victim])
		time.Sleep(3 * time.Second)
		if !lab.healthy(victim) {
			t.Fatalf("没有流量时入口机不会知道中转后面的出口坏了")
		}
		firstHit := time.Now()
		// 判坏的那一刻另外盯着记（循环一批要等最慢的那条，最多 3 秒，量出来的会比判坏晚一批）
		var downAt time.Duration
		watchDone := make(chan struct{})
		go func() {
			defer close(watchDone)
			for time.Since(firstHit) < 20*time.Second {
				if !lab.healthy(victim) {
					downAt = time.Since(firstHit)
					return
				}
				time.Sleep(10 * time.Millisecond)
			}
		}()
		failed, slowest := 0, time.Duration(0)
		during := map[string]int{}
		for !(!lab.healthy(victim) && time.Since(firstHit) > 2*time.Second) && time.Since(firstHit) < 20*time.Second {
			var wg sync.WaitGroup
			var mu sync.Mutex
			for i := 0; i < 3; i++ {
				wg.Add(1)
				go func(i int) {
					defer wg.Done()
					reply, err := lab.tcpOnce(e2eVisitor(i), "", 12*time.Second)
					mu.Lock()
					defer mu.Unlock()
					if err != nil {
						failed++
						return
					}
					during[reply.exitIP]++
					if reply.elapsed > slowest {
						slowest = reply.elapsed
					}
				}(i)
			}
			wg.Wait()
		}
		<-watchDone
		t.Logf("多跳 黑洞一台出口：没有流量的 3 秒里照常算好的；有流量后失败 %d 条，最慢一条 %s（撞上它的约 3 秒后被中转关掉、换走），分布 %s；第一条连接后 %s 判坏",
			failed, slowest.Round(10*time.Millisecond), e2eCounts(during, exits), downAt.Round(10*time.Millisecond))
		if failed != 0 || during[exits[victim].IP] != 0 {
			t.Fatalf("多跳：出口黑洞期间连接应当全部被换到别的出口")
		}
		if lab.healthy(victim) || downAt == 0 {
			t.Fatalf("多跳：坏出口没有被判坏")
		}
		/*
			第一条撞上它的真实连接约 3 秒后被关（中转拨出口的超时）、换走；同时经它复核（gost 又要 3 秒才关），拿别的出口
			比的那几条和它同时开、它被关后再开着 exitCompareGrace 就判：约 3 + 3 + 1 = 7 秒。留 2 秒余量。
		*/
		if downAt > 9*time.Second {
			t.Fatalf("多跳：判坏用了 %s（应当约 7 秒）", downAt)
		}
		undo()
		recovered := lab.waitFor("多跳：出口恢复", 20*time.Second, func() bool { return lab.healthy(victim) })
		t.Logf("多跳：出口回来后 %s 放回（经出口连着探通 %d 次，每次等 %s）", recovered.Round(10*time.Millisecond), exitThroughRecoverOKs, exitConfirmWindow)
		if recovered > 12*time.Second {
			t.Fatalf("多跳：恢复用了 %s，超过 12 秒", recovered)
		}
		// 放回以后真的又接连接
		lab.waitFor("多跳：放回的出口接到连接", 10*time.Second, func() bool {
			reply, err := lab.tcpOnce(e2eVisitor(int(time.Now().UnixNano()%100)), "", 6*time.Second)
			return err == nil && reply.exitIP == exits[victim].IP
		})
		lab.noDirect()
	})

	t.Run("只有 TCP / 只有 UDP 的规则", func(t *testing.T) {
		t.Run("tcp", func(t *testing.T) {
			lab := newE2ELab(t, "tcp-only")
			counts := lab.tcpSpread(30, 10)
			t.Logf("只转 TCP：%s", e2eCounts(counts, lab.bundle.Exits))
			for _, exit := range lab.bundle.Exits {
				if counts[exit.IP] != 10 {
					t.Fatalf("轮流应当均分")
				}
			}
			lab.noDirect()
		})
		t.Run("udp", func(t *testing.T) {
			lab := newE2ELab(t, "udp-only")
			counts, _ := lab.udpSpread(30)
			t.Logf("只转 UDP：%s", e2eCounts(counts, lab.bundle.Exits))
			for _, exit := range lab.bundle.Exits {
				if counts[exit.IP] != 10 {
					t.Fatalf("轮流应当均分")
				}
			}
			// 只转 UDP 的规则照样靠直接探出口机（隧道监听是 TCP 的）判坏
			victim := 0
			lab.stopGost(lab.exitName(lab.bundle.Exits[victim]))
			excluded := lab.waitFor("坏出口被摘掉", 10*time.Second, func() bool { return !lab.healthy(victim) })
			after, _ := lab.udpSpread(20)
			t.Logf("只转 UDP：出口死后 %s 摘掉，之后 20 个会话 %s", excluded.Round(10*time.Millisecond), e2eCounts(after, lab.bundle.Exits))
			if after[lab.bundle.Exits[victim].IP] != 0 {
				t.Fatalf("摘掉以后还有 UDP 会话落在坏出口上")
			}
			lab.noDirect()
		})
	})
}
