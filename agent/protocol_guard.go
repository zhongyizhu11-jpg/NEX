package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type protocolGuardServer struct {
	rule      guardRule
	tcpLn     net.Listener
	udpConn   net.PacketConn
	done      chan struct{}
	doneOnce  sync.Once
	ctx       context.Context
	cancel    context.CancelFunc
	rateMu    sync.RWMutex
	rateScope string
	rateIn    *protocolGuardSharedRateLimiter
	rateOut   *protocolGuardSharedRateLimiter
	// rateExtra：多级限速里第一级之外的那些（第一级仍放在 rateScope / rateIn / rateOut）。
	rateExtra   []protocolGuardRateHandle
	rateChanged chan struct{}
	closed      bool
	// halfCloseLinger 为 0 时用 tcpRelayHalfCloseLinger；测试里调短。
	halfCloseLinger time.Duration
	// 回声探测报的回包限速（udp_probe.go）：别的 Agent 探这条 UDP 规则通不通。
	udpEcho udpEchoLimiter
}

func newProtocolGuardServer(rule guardRule) *protocolGuardServer {
	ctx, cancel := context.WithCancel(context.Background())
	server := &protocolGuardServer{
		rule:   rule,
		done:   make(chan struct{}),
		ctx:    ctx,
		cancel: cancel,
	}
	server.updateRateLimits(rule)
	return server
}

type protocolGuardInspection struct {
	mu                   sync.Mutex
	policy               protocolPolicy
	clientSample         []byte
	serverSample         []byte
	socksVersion         byte
	socks5Methods        map[byte]bool
	socksCandidate       atomic.Bool
	clientInspectionDone bool
	blocked              bool
}

func newProtocolGuardInspection(policy protocolPolicy) *protocolGuardInspection {
	return &protocolGuardInspection{policy: policy}
}

func (i *protocolGuardInspection) inspectClient(chunk []byte) (string, bool) {
	if i == nil || len(chunk) == 0 || !i.policy.enabled() {
		return "", false
	}
	i.mu.Lock()
	defer i.mu.Unlock()
	if i.blocked || i.clientInspectionDone {
		return "", false
	}
	if len(i.clientSample) == 0 {
		// 请求行前面的空行不占采样额度：HTTP 服务端会跳过它们（RFC 9112 2.2），
		// 不跳的话先发几百字节 CRLF 就能把采样撑满、绕过拦截。
		chunk = trimLeadingHTTPBlankLines(chunk)
		if len(chunk) == 0 {
			return "", false
		}
	}
	if len(i.clientSample) < protocolGuardSampleMaxBytes {
		remaining := protocolGuardSampleMaxBytes - len(i.clientSample)
		if remaining > len(chunk) {
			remaining = len(chunk)
		}
		i.clientSample = append(i.clientSample, chunk[:remaining]...)
	}
	if i.policy.BlockHTTP && detectHTTPProtocol(i.clientSample) {
		i.blocked = true
		i.clientInspectionDone = true
		i.socksCandidate.Store(false)
		return "http", true
	}
	if i.policy.BlockTLS && detectTLSProtocol(i.clientSample) {
		i.blocked = true
		i.clientInspectionDone = true
		i.socksCandidate.Store(false)
		return "tls", true
	}
	if !i.policy.BlockSocks {
		i.clientInspectionDone = len(i.clientSample) >= protocolGuardSampleMaxBytes
		return "", false
	}
	version, methods, ok := detectSocksClientHandshake(i.clientSample)
	if !ok {
		i.socksVersion = 0
		i.socks5Methods = nil
		i.serverSample = nil
		i.socksCandidate.Store(false)
		i.clientInspectionDone = len(i.clientSample) >= protocolGuardSampleMaxBytes
		return "", false
	}
	i.socksVersion = version
	i.socks5Methods = methods
	i.serverSample = nil
	i.socksCandidate.Store(true)
	return "", false
}

// clientFinished 表示客户端方向不再需要逐块检测：没开协议拦截，或者样本已经
// 收满且不是待确认的 SOCKS 握手。clientInspectionDone 一旦置位就不会再被清掉
// （inspectClient 之后直接返回），所以这个结论是终态，可以放心切到 splice。
func (i *protocolGuardInspection) clientFinished() bool {
	if i == nil || !i.policy.enabled() {
		return true
	}
	i.mu.Lock()
	defer i.mu.Unlock()
	return i.clientInspectionDone && !i.blocked && !i.socksCandidate.Load()
}

// serverFinished 表示服务端方向不再需要逐块检测。服务端数据只用来确认 SOCKS
// 握手，没开 SOCKS 拦截时从一开始就不用看；开了的话要等客户端检测结束，否则
// 后面的客户端数据还可能让连接变成待确认的 SOCKS 候选。
func (i *protocolGuardInspection) serverFinished() bool {
	if i == nil || !i.policy.enabled() || !i.policy.BlockSocks {
		return true
	}
	return i.clientFinished()
}

func (i *protocolGuardInspection) inspectServer(chunk []byte) (string, bool) {
	if i == nil || len(chunk) == 0 || !i.socksCandidate.Load() {
		return "", false
	}
	i.mu.Lock()
	defer i.mu.Unlock()
	if i.blocked || i.socksVersion == 0 {
		return "", false
	}
	if len(i.serverSample) < 16 {
		remaining := 16 - len(i.serverSample)
		if remaining > len(chunk) {
			remaining = len(chunk)
		}
		i.serverSample = append(i.serverSample, chunk[:remaining]...)
	}
	switch i.socksVersion {
	case 0x05:
		if len(i.serverSample) < 2 {
			return "", false
		}
		method := i.serverSample[1]
		if i.serverSample[0] == 0x05 && (method == 0xff || i.socks5Methods[method]) {
			i.blocked = true
			i.clientInspectionDone = true
			i.socksCandidate.Store(false)
			return "socks", true
		}
	case 0x04:
		if len(i.serverSample) < 8 {
			return "", false
		}
		status := i.serverSample[1]
		if (i.serverSample[0] == 0x00 || i.serverSample[0] == 0x04) && status >= 0x5a && status <= 0x5d {
			i.blocked = true
			i.clientInspectionDone = true
			i.socksCandidate.Store(false)
			return "socks", true
		}
	}
	i.socksVersion = 0
	i.socks5Methods = nil
	i.serverSample = nil
	i.socksCandidate.Store(false)
	return "", false
}

func guardID(rule guardRule) string {
	return strconv.Itoa(rule.RuleID) + ":" + strconv.Itoa(rule.ListenPort)
}

func guardRoutingSignature(rule guardRule) string {
	return strings.Join([]string{
		strconv.Itoa(rule.RuleID),
		strconv.Itoa(rule.TunnelID),
		strconv.Itoa(rule.ListenPort),
		protocolGuardBindAddress(rule),
		rule.TargetIP,
		strconv.Itoa(rule.TargetPort),
		strconv.Itoa(rule.BackendPort),
		strings.TrimSpace(rule.BackendForwardType),
		normalizeRuntimeProtocol(rule.Protocol),
		strconv.FormatBool(rule.Policy.BlockHTTP),
		strconv.FormatBool(rule.Policy.BlockSocks),
		strconv.FormatBool(rule.Policy.BlockTLS),
		strconv.FormatBool(rule.ProxyProtocolReceive),
		strconv.FormatBool(rule.ProxyProtocolSend),
		strconv.Itoa(normalizeProxyProtocolVersion(rule.ProxyProtocolVersion)),
	}, "|")
}

func protocolGuardBindAddress(rule guardRule) string {
	return strings.Trim(strings.TrimSpace(rule.BindAddress), "[]")
}

func protocolGuardListenAddress(rule guardRule) string {
	return net.JoinHostPort(protocolGuardBindAddress(rule), strconv.Itoa(rule.ListenPort))
}

func protocolGuardBackendReady(rule guardRule, readiness *localRuntimeReadiness) bool {
	if rule.BackendPort <= 0 {
		return true
	}
	if readiness == nil {
		return false
	}
	backendType := strings.TrimSpace(rule.BackendForwardType)
	switch backendType {
	case "nginx", "nginx-tunnel", "nginx-tunnel-exit":
		return readiness.nginxReadyForPort(rule.BackendPort, rule.Protocol)
	case "gost", "gost-tunnel", "gost-tunnel-exit", "gost-tunnel-hop":
		return readiness.gostReadyForPortInScope(
			rule.BackendPort,
			gostRuntimeListenProtocol(backendType, rule.Protocol),
			desiredGostRuntimeScope(backendType),
		)
	case "realm", "socat":
		return runtimeListenPortReady(readiness.listenSnapshot, rule.BackendPort, rule.Protocol, managedRuleListenProcessNeedles(backendType))
	default:
		return runtimeListenPortReady(readiness.listenSnapshot, rule.BackendPort, rule.Protocol, nil)
	}
}

func protocolGuardRuleStateReady(state localRuleState, readiness *localRuntimeReadiness) bool {
	port := atoi(state.Port)
	if state.RuleID <= 0 || port <= 0 {
		return false
	}
	id := guardID(guardRule{RuleID: state.RuleID, ListenPort: port})
	protocolGuardMu.Lock()
	server := protocolGuards[id]
	protocolGuardMu.Unlock()
	if server == nil {
		return false
	}
	select {
	case <-server.done:
		return false
	default:
	}
	expected := guardRule{Protocol: state.Protocol}
	if guardTCPEnabled(expected) && server.tcpLn == nil {
		return false
	}
	if guardUDPEnabled(expected) && server.udpConn == nil {
		return false
	}
	return protocolGuardBackendReady(server.rule, readiness)
}

func guardTCPEnabled(rule guardRule) bool {
	return normalizeRuntimeProtocol(rule.Protocol) != "udp"
}

func guardUDPEnabled(rule guardRule) bool {
	return normalizeRuntimeProtocol(rule.Protocol) != "tcp"
}

func protocolGuardTargetsOwnListener(rule guardRule) bool {
	if rule.ListenPort <= 0 || rule.TargetPort != rule.ListenPort {
		return false
	}
	host := strings.Trim(strings.TrimSpace(rule.TargetIP), "[]")
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && (ip.IsLoopback() || ip.IsUnspecified())
}

type protocolGuardSyncWaiter struct {
	cancel  chan struct{}
	started chan struct{}
	done    chan struct{}
}

func newProtocolGuardSyncWaiter() *protocolGuardSyncWaiter {
	return &protocolGuardSyncWaiter{
		cancel:  make(chan struct{}),
		started: make(chan struct{}),
		done:    make(chan struct{}),
	}
}

var protocolGuardSyncWaiterCurrent = newProtocolGuardSyncWaiter()

// Every reconciliation owns one waiter lifecycle. Replacing it closes the
// previous cancellation channel, so an obsolete generation exits even when
// its action never completes.
func advanceProtocolGuardSyncWaiter() *protocolGuardSyncWaiter {
	next := newProtocolGuardSyncWaiter()
	protocolGuardSyncWaitMu.Lock()
	previous := protocolGuardSyncWaiterCurrent
	protocolGuardSyncWaiterCurrent = next
	protocolGuardSyncWaitMu.Unlock()
	if previous != nil {
		close(previous.cancel)
	}
	return next
}

func syncProtocolGuards(cfg Config, rules []guardRule) {
	protocolGuardSyncGeneration.Add(1)
	waiter := advanceProtocolGuardSyncWaiter()
	close(waiter.started)
	defer close(waiter.done)
	protocolGuardSyncMu.Lock()
	defer protocolGuardSyncMu.Unlock()
	syncProtocolGuardsLocked(cfg, rules)
}

func syncProtocolGuardsAfterActions(cfg Config, rules []guardRule, completed []<-chan struct{}) *protocolGuardSyncWaiter {
	generation := protocolGuardSyncGeneration.Add(1)
	waiter := advanceProtocolGuardSyncWaiter()
	rules = append([]guardRule(nil), rules...)
	if len(completed) == 0 {
		syncProtocolGuardsForGeneration(cfg, rules, generation)
		close(waiter.started)
		close(waiter.done)
		return waiter
	}
	waits := append([]<-chan struct{}(nil), completed...)
	go func() {
		close(waiter.started)
		defer close(waiter.done)
		for _, done := range waits {
			if done == nil {
				continue
			}
			select {
			case <-done:
			case <-waiter.cancel:
				return
			}
		}
		select {
		case <-waiter.cancel:
			return
		default:
		}
		// Keep the existing route until its backend action completes. The final
		// sync also verifies the new backend listener before switching the Guard.
		syncProtocolGuardsForGeneration(cfg, rules, generation)
	}()
	return waiter
}

func syncProtocolGuardsForGeneration(cfg Config, rules []guardRule, generation uint64) {
	protocolGuardSyncMu.Lock()
	defer protocolGuardSyncMu.Unlock()
	if protocolGuardSyncGeneration.Load() != generation {
		return
	}
	syncProtocolGuardsLocked(cfg, rules)
}

func syncProtocolGuardsLocked(cfg Config, rules []guardRule) {
	wanted := map[string]string{}
	readiness := readLocalRuntimeReadinessCached()
	for _, rule := range rules {
		if rule.RuleID <= 0 || rule.ListenPort <= 0 || rule.TargetIP == "" || rule.TargetPort <= 0 {
			continue
		}
		if protocolGuardTargetsOwnListener(rule) {
			if shouldLogAgentReport(fmt.Sprintf("protocol-guard-self-target:%d:%d", rule.RuleID, rule.ListenPort), agentReportLogInterval) {
				logf("protocol guard rejected self target rule=%d listen=:%d target=%s:%d", rule.RuleID, rule.ListenPort, rule.TargetIP, rule.TargetPort)
			}
			continue
		}
		id := guardID(rule)
		sig := guardRoutingSignature(rule)
		wanted[id] = sig
		protocolGuardMu.Lock()
		existing := protocolGuards[id]
		protocolGuardMu.Unlock()
		if existing != nil && guardRoutingSignature(existing.rule) == sig {
			// Rate values and scope are deliberately outside the routing
			// signature. Update the token buckets in place so active listeners
			// and connections do not flap when a user changes a limit.
			existing.updateRateLimits(rule)
			continue
		}
		if !protocolGuardBackendReady(rule, &readiness) {
			if existing != nil && !protocolGuardBackendReady(existing.rule, &readiness) {
				stopProtocolGuard(id)
			}
			if shouldLogAgentReport(fmt.Sprintf("protocol-guard-backend-not-ready:%d:%d", rule.RuleID, rule.ListenPort), agentReportLogInterval) {
				logf("protocol guard backend not ready rule=%d listen=%d backend=%s:%d protocol=%s", rule.RuleID, rule.ListenPort, rule.BackendForwardType, rule.BackendPort, normalizeRuntimeProtocol(rule.Protocol))
			}
			continue
		}
		stopProtocolGuard(id)
		startProtocolGuard(cfg, rule)
	}

	protocolGuardMu.Lock()
	ids := make([]string, 0, len(protocolGuards))
	for id := range protocolGuards {
		if _, ok := wanted[id]; !ok {
			ids = append(ids, id)
		}
	}
	protocolGuardMu.Unlock()
	for _, id := range ids {
		stopProtocolGuard(id)
	}
}

func startProtocolGuard(cfg Config, rule guardRule) {
	prepareProtocolGuardPort(rule)
	server := newProtocolGuardServer(rule)
	listenAddress := protocolGuardListenAddress(rule)
	if guardTCPEnabled(rule) {
		ln, err := listenTCPForRelay(listenAddress)
		if err != nil {
			server.close()
			logf("protocol guard tcp listen failed rule=%d port=%d: %v", rule.RuleID, rule.ListenPort, err)
			return
		}
		server.tcpLn = ln
	}
	if guardUDPEnabled(rule) {
		conn, err := net.ListenPacket("udp", listenAddress)
		if err != nil {
			server.close()
			logf("protocol guard udp listen failed rule=%d port=%d: %v", rule.RuleID, rule.ListenPort, err)
			return
		}
		if udpConn, ok := conn.(*net.UDPConn); ok {
			_ = udpConn.SetReadBuffer(protocolGuardUDPReadBuffer)
		}
		server.udpConn = conn
	}
	if server.tcpLn == nil && server.udpConn == nil {
		server.close()
		logf("protocol guard no protocol enabled rule=%d port=%d protocol=%s", rule.RuleID, rule.ListenPort, rule.Protocol)
		return
	}
	protocolGuardMu.Lock()
	protocolGuards[guardID(rule)] = server
	protocolGuardMu.Unlock()
	if server.tcpLn != nil {
		go server.serveTCP(cfg)
	}
	if server.udpConn != nil {
		go server.serveUDP()
	}
	logf("protocol guard started rule=%d tunnel=%d listen=%s protocol=%s target=%s:%d proxyReceive=%v proxySend=%v proxyVersion=%d", rule.RuleID, rule.TunnelID, listenAddress, normalizeRuntimeProtocol(rule.Protocol), rule.TargetIP, rule.TargetPort, rule.ProxyProtocolReceive, rule.ProxyProtocolSend, normalizeProxyProtocolVersion(rule.ProxyProtocolVersion))
}

func prepareProtocolGuardPort(rule guardRule) {
	if rule.ListenPort <= 0 {
		return
	}
	port := strconv.Itoa(rule.ListenPort)
	stopFXPByListenEndpoint(rule.ListenPort, rule.Protocol)
	backendPort := rule.BackendPort
	if backendPort <= 0 {
		backendPort = rule.TargetPort
	}
	if backendPort != rule.ListenPort {
		cleanupGostRuntimeIfPortBusy(rule.ListenPort, rule.Protocol)
	}
	for _, cmd := range managedListenerCleanupCmds(port) {
		_ = runShell(cmd)
	}
	backendType := strings.TrimSpace(rule.BackendForwardType)
	if backendType == "" || backendPort == rule.ListenPort {
		for _, name := range []string{
			"forwardx-socat-" + port,
			"forwardx-socat-tcp-" + port,
			"forwardx-socat-udp-" + port,
			"forwardx-realm-" + port,
			"forwardx-realm-tcp-" + port,
			"forwardx-realm-udp-" + port,
			"forwardx-realm-both-" + port,
		} {
			_ = runShell(managedServiceCleanupShell(name))
		}
		_ = runShell("rm -f /etc/forwardx/realm/forwardx-realm-" + port + ".toml /etc/forwardx/realm/forwardx-realm-" + port + ".toml.sha256 /etc/forwardx/realm/forwardx-realm-tcp-" + port + ".toml /etc/forwardx/realm/forwardx-realm-tcp-" + port + ".toml.sha256 /etc/forwardx/realm/forwardx-realm-udp-" + port + ".toml /etc/forwardx/realm/forwardx-realm-udp-" + port + ".toml.sha256 /etc/forwardx/realm/forwardx-realm-both-" + port + ".toml /etc/forwardx/realm/forwardx-realm-both-" + port + ".toml.sha256 2>/dev/null || true")
	}
	if backendType != "nginx" || backendPort == rule.ListenPort {
		_ = runShell(managedNginxCleanupShell(port))
	}
	_ = runShell(nftPortCleanupCmd(port, "both"))
	for _, binary := range iptablesAgentBinaries() {
		_ = runShell(iptablesAgentDeleteDnatRulesForPort(binary, port, "both"))
	}
}

func stopProtocolGuard(id string) {
	protocolGuardMu.Lock()
	server := protocolGuards[id]
	if server != nil {
		delete(protocolGuards, id)
	}
	protocolGuardMu.Unlock()
	if server == nil {
		return
	}
	server.close()
	logf("protocol guard stopped rule=%d port=%d", server.rule.RuleID, server.rule.ListenPort)
}

func (s *protocolGuardServer) close() {
	s.doneOnce.Do(func() {
		if s.done != nil {
			close(s.done)
		}
		if s.cancel != nil {
			s.cancel()
		}
		if s.tcpLn != nil {
			_ = s.tcpLn.Close()
		}
		if s.udpConn != nil {
			_ = s.udpConn.Close()
		}
		s.rateMu.Lock()
		scope, in, out := s.rateScope, s.rateIn, s.rateOut
		extra := s.rateExtra
		rateChanged := s.rateChanged
		s.closed = true
		s.rateScope, s.rateIn, s.rateOut = "", nil, nil
		s.rateExtra = nil
		s.rateChanged = nil
		s.rateMu.Unlock()
		if rateChanged != nil {
			close(rateChanged)
		}
		releaseProtocolGuardRateLimiter(scope, protocolGuardRateIn, in)
		releaseProtocolGuardRateLimiter(scope, protocolGuardRateOut, out)
		for _, handle := range extra {
			handle.release()
		}
	})
}

func (s *protocolGuardServer) serveTCP(cfg Config) {
	var backoff serveLoopBackoff
	for {
		conn, err := s.tcpLn.Accept()
		if err != nil {
			// 以前第一次出错就悄悄退出，而 done 没关，就绪检查一直报“就绪”，端口却没人接。
			exit, fatal := serveLoopHandleError(s.done, &backoff, err, func(err error, suppressed int) {
				logf("protocol guard accept rule=%d suppressed=%d: %v", s.rule.RuleID, suppressed, err)
			})
			if fatal {
				s.abandonAfterServeFailure("tcp accept", err)
			}
			if exit {
				return
			}
			continue
		}
		backoff.success()
		go s.handleConn(cfg, conn)
	}
}

// abandonAfterServeFailure 监听意外失效时摘掉并关闭这个守护，done 关闭后就绪检查随即失败，
// 下一轮对账（签名相同但已不在表里）会重新启动它。
func (s *protocolGuardServer) abandonAfterServeFailure(what string, err error) {
	id := guardID(s.rule)
	protocolGuardMu.Lock()
	current := protocolGuards[id] == s
	if current {
		delete(protocolGuards, id)
	}
	protocolGuardMu.Unlock()
	s.close()
	if current {
		logf("protocol guard %s stopped unexpectedly rule=%d port=%d; it will be rebuilt: %v", what, s.rule.RuleID, s.rule.ListenPort, err)
		wakeHeartbeat()
	}
}

func (s *protocolGuardServer) handleConn(cfg Config, client net.Conn) {
	baseCtx := s.ctx
	if baseCtx == nil {
		baseCtx = context.Background()
	}
	connCtx, cancelConn := context.WithCancel(baseCtx)
	defer cancelConn()
	defer client.Close()
	stopClientClose := context.AfterFunc(connCtx, func() { _ = client.Close() })
	defer stopClientClose()
	proxyInfo := proxyProtocolInfoFromConn(client)
	first := []byte(nil)
	if s.rule.ProxyProtocolReceive {
		_ = client.SetReadDeadline(time.Now().Add(5 * time.Second))
		buf := make([]byte, 4096)
		n, err := client.Read(buf)
		_ = client.SetReadDeadline(time.Time{})
		if err != nil {
			return
		}
		if n > 0 {
			first = append(first, buf[:n]...)
		}
		parsed, remaining, ok, err := consumeProxyProtocolFromConn(client, first, 5*time.Second)
		if err != nil {
			logf("protocol guard proxy receive failed rule=%d: %v", s.rule.RuleID, err)
			return
		}
		if ok {
			proxyInfo = parsed
			first = remaining
		}
	}
	dialer := net.Dialer{Timeout: 10 * time.Second}
	target, err := dialer.DialContext(connCtx, "tcp", net.JoinHostPort(s.rule.TargetIP, strconv.Itoa(s.rule.TargetPort)))
	if err != nil {
		if connCtx.Err() == nil {
			logf("protocol guard dial target rule=%d: %v", s.rule.RuleID, err)
		}
		return
	}
	defer target.Close()
	stopTargetClose := context.AfterFunc(connCtx, func() { _ = target.Close() })
	defer stopTargetClose()
	if s.rule.ProxyProtocolSend {
		header := buildProxyProtocol(s.rule.ProxyProtocolVersion, proxyInfo, client.RemoteAddr(), target.LocalAddr(), target.RemoteAddr())
		if len(header) > 0 {
			if _, err := target.Write(header); err != nil {
				return
			}
		}
	}
	inspection := newProtocolGuardInspection(s.rule.Policy)
	type copyResult struct {
		toTarget bool
		err      error
	}
	var progress atomic.Int64
	toTarget := &protocolGuardTCPPipe{src: client, dst: target, direction: protocolGuardRateIn, progress: &progress}
	toClient := &protocolGuardTCPPipe{src: target, dst: client, direction: protocolGuardRateOut, progress: &progress}
	results := make(chan copyResult, 2)
	go func() {
		results <- copyResult{toTarget: true, err: s.copyTCPToTargetWithGuard(connCtx, cfg, toTarget, first, inspection)}
	}()
	go func() {
		results <- copyResult{toTarget: false, err: s.copyTCPToClientWithGuard(connCtx, cfg, toClient, inspection)}
	}()
	closeAll := func() {
		// Cancel rate reservations and close both sockets so the other copy
		// goroutine cannot remain blocked in WaitN or network I/O.
		cancelConn()
		_ = client.Close()
		_ = target.Close()
	}
	firstResult := <-results
	source, destination, remaining := client, target, toClient
	if !firstResult.toTarget {
		source, destination, remaining = target, client, toTarget
	}
	_, sourceHalfCloses := source.(*net.TCPConn)
	destinationTCP, destinationHalfCloses := destination.(*net.TCPConn)
	if (firstResult.err != nil && !errors.Is(firstResult.err, io.EOF)) || !sourceHalfCloses || !destinationHalfCloses {
		// 出错、被策略拦截，或者连接本身没有半关闭（EOF 就是对端彻底走了）：
		// 整条连接一起结束。
		closeAll()
		<-results
		return
	}
	// 一个方向干净地读到 EOF 是半关闭（比如客户端发完请求 shutdown 写端再等响应）：
	// 把半关闭传给另一端，另一个方向接着跑；它有数据在走就一直等，空闲超过
	// linger 才收掉，免得一个永远不关的对端把协程钉住。
	_ = destinationTCP.CloseWrite()
	// 剩下的方向如果正在 splice，先把它踢回逐块循环：下面按字节计数判断空闲，
	// splice 一次搬一大块、中途不更新计数，而且写端卡住时也没有机会返回。
	remaining.leaveSplice()
	linger := s.halfCloseLinger
	if linger <= 0 {
		linger = tcpRelayHalfCloseLinger
	}
	ticker := time.NewTicker(linger)
	defer ticker.Stop()
	last := progress.Load()
	for {
		select {
		case <-results:
			closeAll()
			return
		case <-ticker.C:
			current := progress.Load()
			if current == last {
				closeAll()
				<-results
				return
			}
			last = current
		}
	}
}

// protocolGuardSpliceChunk 是零拷贝阶段每次 io.Copy 搬运的上限。每搬完一块就重新
// 看一眼这个方向有没有被热更新挂上限速：限速加上以后最多再放过这么多字节不受限
// （和 protocolGuardRateBurstMax 一样大，相当于多给一次突发），换来的是不用为每条
// 连接再起一个监听协程去打断 splice。
const protocolGuardSpliceChunk = 4 * 1024 * 1024

// protocolGuardTCPPipe 是协议防护 TCP 连接里的一个转发方向。
type protocolGuardTCPPipe struct {
	src       net.Conn
	dst       net.Conn
	direction protocolGuardRateDirection
	// progress 两个方向共用，半关闭以后 handleConn 靠它判断剩下的方向是否空闲。
	progress *atomic.Int64
	// halfClosed 置位以后这个方向不再进入 splice。
	halfClosed atomic.Bool
	// rateKick 表示读超时是限速热更新踢出来的（见 spliceTCPWithGuard），不是错误。
	rateKick atomic.Bool
	// spliced 记录这个方向是否进入过零拷贝阶段（测试用，读写都很便宜）。
	spliced atomic.Bool
}

func (p *protocolGuardTCPPipe) addProgress(n int64) {
	if p.progress != nil && n > 0 {
		p.progress.Add(n)
	}
}

// leaveSplice 在另一个方向半关闭后调用：读超时设成现在，把可能阻塞在 splice 里的
// io.Copy 踢出来（读超时不会丢数据：splice 是先等可读再搬）。逐块循环里的 Read 被
// 踢到也只是返回超时，清掉超时接着读。
func (p *protocolGuardTCPPipe) leaveSplice() {
	p.halfClosed.Store(true)
	_ = p.src.SetReadDeadline(time.Now())
}

// resumeAfterKick 判断一个读错误是不是 leaveSplice 踢出来的；是的话清掉读超时，
// 调用方接着用逐块循环转发。
func (p *protocolGuardTCPPipe) resumeAfterKick(err error) bool {
	if !isNetTimeout(err) {
		return false
	}
	// 先看限速踢（一次性），再看半关闭踢（之后一直有效）。
	if !p.rateKick.Swap(false) && !p.halfClosed.Load() {
		return false
	}
	_ = p.src.SetReadDeadline(time.Time{})
	return true
}

// spliceCapable 只有两端都是原生 *net.TCPConn 时 io.Copy 才会走 splice；
// 其他连接类型（测试里的 net.Pipe 等）继续用逐块循环，行为不变。
func (p *protocolGuardTCPPipe) spliceCapable() bool {
	_, srcTCP := p.src.(*net.TCPConn)
	_, dstTCP := p.dst.(*net.TCPConn)
	return srcTCP && dstTCP
}

// spliceTCPWithGuard 在协议检测已经结束、这个方向又没有限速时把剩下的数据交给
// 内核搬（*net.TCPConn 之间的 io.Copy 在 Linux 上走 splice），省掉每个字节两次
// 用户态拷贝。按方向各自切换而不是整条连接交给 relayTCPBidirectional：两个方向
// 的检测结束时间不同（服务端方向只有 SOCKS 检测需要看），限速可以热更新到已有
// 连接上，半关闭以后的空闲判断也要沿用原来按字节计数的办法，所以切走以后必须
// 还能回到逐块循环。
// switchBack=true 表示要回到逐块循环（中途挂上了限速，或者另一个方向半关闭了）；
// 此时已经读出来的数据都已完整写出，不会丢也不会乱序。
func (s *protocolGuardServer) spliceTCPWithGuard(p *protocolGuardTCPPipe) (switchBack bool, err error) {
	p.spliced.Store(true)
	for {
		limiter, rateChanged := s.rateWaitState(p.direction)
		if p.halfClosed.Load() || limiter != nil {
			return true, nil
		}
		// 限速热更新时把阻塞在 splice 里的读踢出来，回到循环开头重新判断：不然一条
		// 安静的长连接（SSH、长轮询）要等到再搬满一块才会受新限速约束。
		stopWatch := make(chan struct{})
		if rateChanged != nil {
			go func() {
				select {
				case <-rateChanged:
					p.rateKick.Store(true)
					_ = p.src.SetReadDeadline(time.Now())
				case <-stopWatch:
				}
			}()
		}
		reader := &io.LimitedReader{R: p.src, N: protocolGuardSpliceChunk}
		n, copyErr := io.Copy(p.dst, reader)
		close(stopWatch)
		p.addProgress(n)
		if copyErr != nil {
			if p.resumeAfterKick(copyErr) {
				continue
			}
			return false, copyErr
		}
		if reader.N > 0 {
			// 没搬满一块、也没有错误：源端读到了 EOF（对端半关闭或关闭）。
			return false, io.EOF
		}
	}
}

func (s *protocolGuardServer) canSpliceTCP(p *protocolGuardTCPPipe, inspectionFinished bool) bool {
	return inspectionFinished && !p.halfClosed.Load() && s.rateLimiter(p.direction) == nil
}

func (s *protocolGuardServer) copyTCPToTargetWithGuard(ctx context.Context, cfg Config, p *protocolGuardTCPPipe, initial []byte, inspection *protocolGuardInspection) error {
	writeChunk := func(chunk []byte) error {
		if len(chunk) == 0 {
			return nil
		}
		if proto, blocked := inspection.inspectClient(chunk); blocked {
			enqueueProtocolBlockReport(cfg, s.rule, proto)
			return fmt.Errorf("protocol blocked: %s", proto)
		}
		if err := s.waitRate(ctx, protocolGuardRateIn, len(chunk)); err != nil {
			return err
		}
		_, err := p.dst.Write(chunk)
		p.addProgress(int64(len(chunk)))
		return err
	}
	// 解析 PROXY 协议时多读出来的字节必须先写出去，之后才可能切到 splice。
	if err := writeChunk(initial); err != nil {
		return err
	}
	spliceCapable := p.spliceCapable()
	buf := getAgentByteBuffer(32 * 1024)
	defer putAgentByteBuffer(buf)
	for {
		if spliceCapable && s.canSpliceTCP(p, inspection.clientFinished()) {
			switchBack, err := s.spliceTCPWithGuard(p)
			if !switchBack {
				return err
			}
		}
		n, err := p.src.Read(buf)
		if n > 0 {
			if writeErr := writeChunk(buf[:n]); writeErr != nil {
				return writeErr
			}
		}
		if err != nil {
			if p.resumeAfterKick(err) {
				continue
			}
			return err
		}
	}
}

func (s *protocolGuardServer) copyTCPToClientWithGuard(ctx context.Context, cfg Config, p *protocolGuardTCPPipe, inspection *protocolGuardInspection) error {
	spliceCapable := p.spliceCapable()
	buf := getAgentByteBuffer(32 * 1024)
	defer putAgentByteBuffer(buf)
	for {
		if spliceCapable && s.canSpliceTCP(p, inspection.serverFinished()) {
			switchBack, err := s.spliceTCPWithGuard(p)
			if !switchBack {
				return err
			}
		}
		n, err := p.src.Read(buf)
		if n > 0 {
			chunk := buf[:n]
			if proto, blocked := inspection.inspectServer(chunk); blocked {
				enqueueProtocolBlockReport(cfg, s.rule, proto)
				return fmt.Errorf("protocol blocked: %s", proto)
			}
			if err := s.waitRate(ctx, protocolGuardRateOut, len(chunk)); err != nil {
				return err
			}
			if _, writeErr := p.dst.Write(chunk); writeErr != nil {
				return writeErr
			}
			p.addProgress(int64(n))
		}
		if err != nil {
			if p.resumeAfterKick(err) {
				continue
			}
			return err
		}
	}
}
