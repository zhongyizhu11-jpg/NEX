package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

/*
运行时管理：让「改一条规则」不再断掉整条隧道。

以前 Agent 发现配置变了就停掉整个进程再起一个新的：一个入口组里几十条规则，
改其中一条，所有规则上正在跑的连接全部断开；DNS 变了、面板重启了也一样。

现在进程收到 SIGHUP 就重新读配置，按监听地址逐个比对：

  - TCP 监听端口跨重载一直开着。每条新连接进来时读取「当前处理器」，配置变了
    只原子地换掉处理器 —— 旧连接用旧配置跑完，端口一刻都不中断。
  - UDP 服务只有它自己的配置真的变了才重启（UDP 会话跟着监听 socket 走，
    重启只影响这一条规则）。
  - 配置里没有了的监听：关掉，并断开它上面的连接（规则被删、被停用、超额）。
  - 新加的监听先绑好再提交；绑不上就整批回滚，旧配置照常运行。

只有 DNSGeneration 变化时什么都不用重建：它只是让下一跳域名重新解析，
重载时直接清掉解析缓存就够了。
*/

type tcpHandler struct {
	sig string
	// cfg 是这个处理器对应的配置。出口/中转收到 hello 时按当前处理器的 cfg
	// 重新核对（见 fxpInbound.currentConfig），不再用接受连接那一刻的旧配置。
	cfg     config
	serve   func(conn net.Conn, tracked *trackedConn)
	release func()
}

// trackedConn 是监听上登记的一条连接。出口读到 hello 就记下来（见
// fxpInbound.recordHello），重载时拿新的目标表再核一遍，不再放行的会话直接断开。
type trackedConn struct {
	slot  *tcpListenerSlot
	hello atomic.Pointer[helloFrame]
}

// fxpInbound 是出口/中转处理一条入站连接时用到的监听侧状态：连接闸的租约、
// 进程退出信号、监听上的登记。方法对 nil 安全，直接调 handleExitSession 的
// 测试不需要这些。
type fxpInbound struct {
	role      string
	admission *listenerAdmission
	stopping  <-chan struct{}
	tracked   *trackedConn
}

func (in *fxpInbound) stop() <-chan struct{} {
	if in == nil {
		return nil
	}
	return in.stopping
}

// authenticated：握手通过，把握手闸换成 pending + active。
func (in *fxpInbound) authenticated(cfg config) bool {
	if in == nil {
		return true
	}
	ok, reason := in.admission.authenticated()
	if !ok {
		in.admission.logRejection(in.role, cfg, reason)
	}
	return ok
}

func (in *fxpInbound) helloReceived() {
	if in != nil {
		in.admission.helloReceived()
	}
}

// currentConfig 返回监听当前处理器的配置。握手用的密钥已经被重载换掉（连接在
// 换之前就被接受了，或者是上一跳池子里空等了一阵的连接），这条连接就不再认。
func (in *fxpInbound) currentConfig(handshakeCfg config) (config, error) {
	if in == nil || in.tracked == nil || in.tracked.slot == nil {
		return handshakeCfg, nil
	}
	handler := in.tracked.slot.handler.Load()
	if handler == nil {
		return handshakeCfg, errors.New("fxp listener closed")
	}
	if handler.cfg.Key != handshakeCfg.Key {
		return handshakeCfg, errors.New("fxp tunnel key changed by reload")
	}
	return handler.cfg, nil
}

// recordHello 在核对目标之前记下 hello：先记、后读当前配置，重载要么被这里
// 读到，要么重载那边扫登记时能看到这个 hello，不会两头都漏掉。
func (in *fxpInbound) recordHello(hello helloFrame) {
	if in != nil && in.tracked != nil {
		in.tracked.hello.Store(&hello)
	}
}

type tcpListenerSlot struct {
	key      string
	label    string
	host     string
	port     int
	ln       net.Listener
	handler  atomic.Pointer[tcpHandler]
	connsMu  sync.Mutex
	conns    map[net.Conn]*trackedConn
	loopDone chan struct{}
}

type udpServerSlot struct {
	key     string
	sig     string
	label   string
	plan    udpServePlan
	mu      sync.Mutex
	conn    *net.UDPConn
	stopped bool
	done    chan struct{}
}

type tcpListenPlan struct {
	key      string
	label    string
	role     string
	host     string
	port     int
	fastOpen bool
	sig      string
	cfg      config
	handler  func(m *fxpRuntimeManager) *tcpHandler
}

type udpServePlan struct {
	key         string
	label       string
	role        string
	host        string
	port        int
	sig         string
	cfg         config
	serve       func(conn *net.UDPConn) error
	releaseFunc func()
}

type fxpRuntimeManager struct {
	role     string
	mu       sync.Mutex
	tcp      map[string]*tcpListenerSlot
	udp      map[string]*udpServerSlot
	stopping chan struct{}
	stopOnce sync.Once
	sessions sync.WaitGroup
	logCfg   config
}

func newFXPRuntimeManager(role string) *fxpRuntimeManager {
	return &fxpRuntimeManager{
		role:     role,
		tcp:      map[string]*tcpListenerSlot{},
		udp:      map[string]*udpServerSlot{},
		stopping: make(chan struct{}),
	}
}

// fxpComponentSignature 是一段配置「会不会改变行为」的指纹。DNSGeneration 和
// 重载序号不算：前者靠清解析缓存生效，后者只用来确认重载。
func fxpComponentSignature(cfg config, strip func(*config)) string {
	cfg.DNSGeneration = 0
	cfg.ReloadNonce = ""
	if strip != nil {
		strip(&cfg)
	}
	raw, _ := json.Marshal(cfg)
	return string(raw)
}

func stripUDPOnlyFields(cfg *config) {
	cfg.UDPTargets = nil
	cfg.UDPListenPort = 0
	cfg.UDPExitPort = 0
	cfg.UDPRelayExitPort = 0
}

func stripTCPOnlyFields(cfg *config) {
	cfg.TCPFastOpen = false
	// UDP 直连只看 udpTargets；TCP 目标表变了不该把 UDP 监听连同会话一起重启。
	cfg.StreamTargets = nil
}

func listenSlotKey(network, host string, port int) string {
	return network + "|" + strings.TrimSpace(host) + "|" + strconv.Itoa(port)
}

// ---- 计划：配置 → 每个监听该是什么样 ----

type entryResources struct {
	cfg        config
	gate       *connGate
	selector   *exitEndpointSelector
	inLimiter  *limiter
	outLimiter *limiter
}

func buildFXPRuntimePlans(cfg config) ([]tcpListenPlan, []udpServePlan, error) {
	switch strings.ToLower(cfg.Role) {
	case "entry":
		return buildEntryPlans([]config{cfg}, false)
	case "entry-group":
		return buildEntryPlans(cfg.Entries, true)
	case "exit":
		return buildExitPlans(cfg)
	case "relay":
		return buildRelayPlans(cfg)
	default:
		return nil, nil, fmt.Errorf("unknown role %q", cfg.Role)
	}
}

func buildEntryPlans(entries []config, grouped bool) ([]tcpListenPlan, []udpServePlan, error) {
	var tcpPlans []tcpListenPlan
	var udpPlans []udpServePlan
	for index, entry := range entries {
		entry := entry
		label := "entry"
		if grouped {
			label = fmt.Sprintf("entry-group entry %d rule=%d listen=%d", index, entry.RuleID, entry.ListenPort)
		}
		res := &entryResources{
			cfg:        entry,
			gate:       newConnGate(entry.MaxConnections, entry.MaxIPs),
			selector:   newExitEndpointSelector(entry.Exits, exitEndpoint{Host: entry.ExitHost, Port: entry.ExitPort, UDPPort: entry.UDPExitPort, Key: entry.Key}, entry.ExitStrategy),
			inLimiter:  newLimiter(entry.LimitIn),
			outLimiter: newLimiter(entry.LimitOut),
		}
		if protocolHas(entry, "tcp") {
			tcpPlans = append(tcpPlans, tcpListenPlan{
				key:      listenSlotKey("tcp", entry.ListenHost, entry.ListenPort),
				label:    label,
				role:     "entry",
				host:     entry.ListenHost,
				port:     entry.ListenPort,
				fastOpen: entry.TCPFastOpen,
				sig:      fxpComponentSignature(entry, nil),
				cfg:      entry,
				handler: func(m *fxpRuntimeManager) *tcpHandler {
					release := func() {}
					if !multipathEnabled(entry) {
						release = res.selector.activate(entry)
					}
					if res.selector.count() > 1 {
						log.Printf("entry exit selector rule=%d exits=%s strategy=%s", entry.RuleID, formatEndpointList(res.selector), normalizeExitStrategy(entry.ExitStrategy))
					}
					return &tcpHandler{
						sig:     fxpComponentSignature(entry, nil),
						cfg:     entry,
						serve:   func(conn net.Conn, _ *trackedConn) { serveEntryConn(conn, res) },
						release: release,
					}
				},
			})
		}
		if protocolHas(entry, "udp") {
			udpPlans = append(udpPlans, udpServePlan{
				key:   listenSlotKey("udp", entry.ListenHost, udpListenPort(entry)),
				label: label,
				role:  "entry",
				host:  entry.ListenHost,
				port:  udpListenPort(entry),
				sig:   fxpComponentSignature(entry, stripTCPOnlyFields),
				cfg:   entry,
				serve: func(conn *net.UDPConn) error {
					return serveEntryUDPDirect(conn, entry, res.selector, res.inLimiter, res.outLimiter)
				},
			})
		}
	}
	return tcpPlans, udpPlans, nil
}

func serveEntryConn(client net.Conn, res *entryResources) {
	cfg := res.cfg
	release, ok, reason := res.gate.acquire(client.RemoteAddr())
	if !ok {
		active, ips, connectionsForIP := res.gate.statsFor(client.RemoteAddr())
		log.Printf("entry tcp rejected by connection gate tunnel=%d rule=%d client=%s reason=%s active=%d maxConnections=%d distinctIPs=%d connectionsForIP=%d maxIPs=%d", cfg.TunnelID, cfg.RuleID, client.RemoteAddr(), reason, active, cfg.MaxConnections, ips, connectionsForIP, cfg.MaxIPs)
		_ = client.Close()
		return
	}
	defer release()
	err := catchPanic("entry tcp session", func() error {
		return handleEntryTCP(client, cfg, res.selector, res.inLimiter, res.outLimiter)
	})
	if err != nil && !isClosedErr(err) {
		log.Printf("entry tcp session error: %v", err)
	}
}

// stripExitTCPFields：出口 TCP 监听的指纹。走 TCP 流的 UDP 会话按 udpTargets
// 核对目标，所以 udpTargets 变了也要换处理器，重载时据此重新核对已有会话。
func stripExitTCPFields(cfg *config) {
	targets := cfg.UDPTargets
	stripUDPOnlyFields(cfg)
	cfg.UDPTargets = targets
}

func buildExitPlans(cfg config) ([]tcpListenPlan, []udpServePlan, error) {
	var tcpPlans []tcpListenPlan
	var udpPlans []udpServePlan
	if protocolHas(cfg, "tcp") {
		tcpPlans = append(tcpPlans, tcpListenPlan{
			key:      listenSlotKey("tcp", cfg.ListenHost, cfg.ListenPort),
			label:    "exit",
			role:     "exit",
			host:     cfg.ListenHost,
			port:     cfg.ListenPort,
			fastOpen: cfg.TCPFastOpen,
			sig:      fxpComponentSignature(cfg, stripExitTCPFields),
			cfg:      cfg,
			handler: func(m *fxpRuntimeManager) *tcpHandler {
				gates := newListenerConnGates(cfg)
				return &tcpHandler{
					sig: fxpComponentSignature(cfg, stripExitTCPFields),
					cfg: cfg,
					serve: func(conn net.Conn, tracked *trackedConn) {
						admission, ok, reason := gates.admitConn(conn)
						if !ok {
							logListenerConnGateRejection("exit", cfg, conn.RemoteAddr(), gates, reason)
							_ = conn.Close()
							return
						}
						defer admission.release()
						in := &fxpInbound{role: "exit", admission: admission, stopping: m.stopping, tracked: tracked}
						err := catchPanic("exit session", func() error {
							return handleExitSessionWithStartup(conn, cfg, in)
						})
						if err != nil && !isClosedErr(err) {
							log.Printf("exit session error: %v", err)
						}
					},
				}
			},
		})
	}
	if protocolHas(cfg, "udp") {
		udpPlans = append(udpPlans, udpServePlan{
			key:   listenSlotKey("udp", cfg.ListenHost, udpListenPort(cfg)),
			label: "exit",
			role:  "exit",
			host:  cfg.ListenHost,
			port:  udpListenPort(cfg),
			sig:   fxpComponentSignature(cfg, stripTCPOnlyFields),
			cfg:   cfg,
			serve: func(conn *net.UDPConn) error { return serveExitUDPDirect(conn, cfg) },
		})
	}
	return tcpPlans, udpPlans, nil
}

func buildRelayPlans(cfg config) ([]tcpListenPlan, []udpServePlan, error) {
	if cfg.RelayExitHost == "" || cfg.RelayExitPort <= 0 || cfg.RelayKey == "" {
		return nil, nil, fmt.Errorf("relay requires relayExitHost, relayExitPort, and relayKey")
	}
	var tcpPlans []tcpListenPlan
	var udpPlans []udpServePlan
	newSelector := func() *exitEndpointSelector {
		return newExitEndpointSelector(cfg.Exits, exitEndpoint{Host: cfg.RelayExitHost, Port: cfg.RelayExitPort, UDPPort: cfg.UDPRelayExitPort, Key: cfg.RelayKey}, cfg.ExitStrategy)
	}
	if protocolHas(cfg, "tcp") {
		tcpPlans = append(tcpPlans, tcpListenPlan{
			key:      listenSlotKey("tcp", cfg.ListenHost, cfg.ListenPort),
			label:    "relay",
			role:     "relay",
			host:     cfg.ListenHost,
			port:     cfg.ListenPort,
			fastOpen: cfg.TCPFastOpen,
			sig:      fxpComponentSignature(cfg, stripUDPOnlyFields),
			cfg:      cfg,
			handler: func(m *fxpRuntimeManager) *tcpHandler {
				selector := newSelector()
				downCfg := cfg
				downCfg.Key = cfg.RelayKey
				release := selector.activate(downCfg)
				if selector.count() > 1 {
					log.Printf("relay exit selector exits=%s strategy=%s", formatEndpointList(selector), normalizeExitStrategy(cfg.ExitStrategy))
				}
				gates := newListenerConnGates(cfg)
				return &tcpHandler{
					sig: fxpComponentSignature(cfg, stripUDPOnlyFields),
					cfg: cfg,
					serve: func(conn net.Conn, tracked *trackedConn) {
						admission, ok, reason := gates.admitConn(conn)
						if !ok {
							logListenerConnGateRejection("relay", cfg, conn.RemoteAddr(), gates, reason)
							_ = conn.Close()
							return
						}
						defer admission.release()
						in := &fxpInbound{role: "relay", admission: admission, stopping: m.stopping, tracked: tracked}
						err := catchPanic("relay session", func() error {
							return handleRelaySessionWithStartup(conn, cfg, selector, in)
						})
						if err != nil && !isClosedErr(err) {
							log.Printf("relay session error: %v", err)
						}
					},
					release: release,
				}
			},
		})
	}
	if protocolHas(cfg, "udp") {
		selector := newSelector()
		udpPlans = append(udpPlans, udpServePlan{
			key:   listenSlotKey("udp", cfg.ListenHost, udpListenPort(cfg)),
			label: "relay",
			role:  "relay",
			host:  cfg.ListenHost,
			port:  udpListenPort(cfg),
			sig:   fxpComponentSignature(cfg, stripTCPOnlyFields),
			cfg:   cfg,
			serve: func(conn *net.UDPConn) error { return serveRelayUDPDirect(conn, cfg, selector) },
		})
	}
	return tcpPlans, udpPlans, nil
}

// ---- 应用 ----

// apply 把运行时切到 cfg 描述的样子。失败时已经在跑的一切保持原样。
func (m *fxpRuntimeManager) apply(cfg config) error {
	tcpPlans, udpPlans, err := buildFXPRuntimePlans(cfg)
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.logCfg = cfg
	linkShapersApply(cfg)
	// 新配置里所有会被占用的端口。旧配置里要删掉、又和它们撞端口的监听得先关，
	// 否则新监听绑不上（比如 0.0.0.0:80 换成 1.2.3.4:80）。
	wantedTCP := map[string]tcpListenPlan{}
	wantedUDP := map[string]udpServePlan{}
	tcpPorts := map[int]bool{}
	udpPorts := map[int]bool{}
	for _, plan := range tcpPlans {
		wantedTCP[plan.key] = plan
		tcpPorts[plan.port] = true
	}
	for _, plan := range udpPlans {
		wantedUDP[plan.key] = plan
		udpPorts[plan.port] = true
	}
	for key, slot := range m.tcp {
		if _, keep := wantedTCP[key]; !keep && tcpPorts[slot.port] {
			slot.close(true)
			delete(m.tcp, key)
		}
	}
	for key, slot := range m.udp {
		if _, keep := wantedUDP[key]; !keep && udpPorts[slot.plan.port] {
			slot.stop()
			delete(m.udp, key)
		}
	}

	// 1. 先把新增的 TCP 端口绑上。
	opened := map[string]net.Listener{}
	rollback := func() {
		for _, ln := range opened {
			_ = ln.Close()
		}
	}
	for _, plan := range tcpPlans {
		if m.tcp[plan.key] != nil {
			continue
		}
		ln, err := listenTCP(plan.host, plan.port, plan.fastOpen)
		if err != nil {
			rollback()
			return fmt.Errorf("%s: %s tcp listen :%d: %w", plan.label, plan.role, plan.port, err)
		}
		opened[plan.key] = ln
	}

	// 2. UDP：新增的直接绑；配置变了的先停旧的再绑新的（同一个端口没法并存）。
	startedUDP := map[string]*udpServerSlot{}
	replacedUDP := map[string]*udpServerSlot{}
	rollbackUDP := func() {
		for _, slot := range startedUDP {
			slot.stop()
		}
		for key, old := range replacedUDP {
			if restarted, err := startUDPServerSlot(old.plan); err == nil {
				m.udp[key] = restarted
			} else {
				delete(m.udp, key)
				log.Printf("%s udp listener could not be restored after a failed reload: %v", old.label, err)
			}
		}
	}
	for _, plan := range udpPlans {
		existing := m.udp[plan.key]
		if existing != nil && existing.sig == plan.sig {
			continue
		}
		if existing != nil {
			existing.stop()
			replacedUDP[plan.key] = existing
		}
		slot, err := startUDPServerSlot(plan)
		if err != nil {
			rollbackUDP()
			rollback()
			return fmt.Errorf("%s: %s udp listen :%d: %w", plan.label, plan.role, plan.port, err)
		}
		startedUDP[plan.key] = slot
	}

	// 3. 提交：新 TCP 监听开始 accept；已有的按需换处理器；UDP 登记。
	for _, plan := range tcpPlans {
		if ln, ok := opened[plan.key]; ok {
			slot := &tcpListenerSlot{key: plan.key, label: plan.label, host: plan.host, port: plan.port, ln: ln, conns: map[net.Conn]*trackedConn{}, loopDone: make(chan struct{})}
			slot.handler.Store(plan.handler(m))
			m.tcp[plan.key] = slot
			log.Printf("%s tcp listening on :%d tunnel=%d rule=%d", plan.role, plan.port, plan.cfg.TunnelID, plan.cfg.RuleID)
			go slot.acceptLoop(m, plan.role, plan.cfg)
			continue
		}
		slot := m.tcp[plan.key]
		current := slot.handler.Load()
		if current != nil && current.sig == plan.sig {
			continue
		}
		replacement := plan.handler(m)
		previous := slot.handler.Swap(replacement)
		if previous != nil && previous.release != nil {
			previous.release()
		}
		revoked := slot.revokeAfterReload(plan.role, previous, replacement)
		log.Printf("%s tcp handler reloaded on :%d tunnel=%d rule=%d (existing connections keep running, revoked=%d)", plan.role, plan.port, plan.cfg.TunnelID, plan.cfg.RuleID, revoked)
	}
	for key, slot := range startedUDP {
		m.udp[key] = slot
		log.Printf("%s udp listening on :%d tunnel=%d rule=%d", slot.plan.role, slot.plan.port, slot.plan.cfg.TunnelID, slot.plan.cfg.RuleID)
	}

	// 4. 配置里没有了的：关掉并断开连接。
	for key, slot := range m.tcp {
		if _, keep := wantedTCP[key]; !keep {
			slot.close(true)
			delete(m.tcp, key)
			log.Printf("%s tcp listener on :%d removed", slot.label, slot.port)
		}
	}
	for key, slot := range m.udp {
		if _, keep := wantedUDP[key]; !keep {
			slot.stop()
			delete(m.udp, key)
			log.Printf("%s udp listener on :%d removed", slot.label, slot.plan.port)
		}
	}
	return nil
}

// shutdown 停止所有监听，等已有连接在限定时间内收尾。
func (m *fxpRuntimeManager) shutdown() {
	m.stopOnce.Do(func() { close(m.stopping) })
	m.mu.Lock()
	for key, slot := range m.tcp {
		slot.close(false)
		delete(m.tcp, key)
	}
	for key, slot := range m.udp {
		slot.stop()
		delete(m.udp, key)
	}
	cfg := m.logCfg
	m.mu.Unlock()
	waitForFXPSessionDrain(m.role, cfg, &m.sessions)
}

// ---- TCP 监听 ----

func (s *tcpListenerSlot) acceptLoop(m *fxpRuntimeManager, role string, cfg config) {
	defer close(s.loopDone)
	for {
		conn, err := acceptWithRetry(s.ln, role, cfg)
		if err != nil {
			return
		}
		enableTCPKeepAlive(conn)
		handler := s.handler.Load()
		if handler == nil {
			_ = conn.Close()
			continue
		}
		tracked := s.track(conn)
		m.sessions.Add(1)
		go func() {
			defer m.sessions.Done()
			defer s.untrack(conn)
			handler.serve(conn, tracked)
		}()
	}
}

func (s *tcpListenerSlot) track(conn net.Conn) *trackedConn {
	tracked := &trackedConn{slot: s}
	s.connsMu.Lock()
	s.conns[conn] = tracked
	s.connsMu.Unlock()
	return tracked
}

// revokeAfterReload 在出口/中转换处理器之后收回旧配置放行的连接：
//   - 隧道密钥变了：这个监听上的连接全是用旧密钥握的手（包括上一跳池子里等
//     hello 的），全部断开；
//   - 出口的目标表变了：已经在跑的会话按新表再核一遍 (规则, 目标)，不再放行
//     的断开。
//
// 入口不在这里处理：用户侧连接不涉及隧道密钥，出口那边会按自己的新配置收回。
func (s *tcpListenerSlot) revokeAfterReload(role string, previous, current *tcpHandler) int {
	if previous == nil || current == nil || (role != "exit" && role != "relay") {
		return 0
	}
	keyChanged := previous.cfg.Key != current.cfg.Key
	var victims []net.Conn
	s.connsMu.Lock()
	for conn, tracked := range s.conns {
		if keyChanged {
			victims = append(victims, conn)
			continue
		}
		if role != "exit" || tracked == nil {
			continue
		}
		hello := tracked.hello.Load()
		if hello == nil {
			continue
		}
		check := *hello
		if authorizeExitTarget(current.cfg, &check) != nil {
			victims = append(victims, conn)
		}
	}
	s.connsMu.Unlock()
	for _, conn := range victims {
		_ = conn.Close()
	}
	return len(victims)
}

func (s *tcpListenerSlot) untrack(conn net.Conn) {
	s.connsMu.Lock()
	delete(s.conns, conn)
	s.connsMu.Unlock()
}

func (s *tcpListenerSlot) close(kill bool) {
	_ = s.ln.Close()
	<-s.loopDone
	if handler := s.handler.Swap(nil); handler != nil && handler.release != nil {
		handler.release()
	}
	if !kill {
		return
	}
	s.connsMu.Lock()
	conns := make([]net.Conn, 0, len(s.conns))
	for conn := range s.conns {
		conns = append(conns, conn)
	}
	s.connsMu.Unlock()
	for _, conn := range conns {
		_ = conn.Close()
	}
}

// ---- UDP 服务 ----

func startUDPServerSlot(plan udpServePlan) (*udpServerSlot, error) {
	conn, err := listenUDPForPlan(plan)
	if err != nil {
		return nil, err
	}
	slot := &udpServerSlot{key: plan.key, sig: plan.sig, label: plan.label, plan: plan, conn: conn, done: make(chan struct{})}
	go slot.run(conn)
	return slot, nil
}

func listenUDPForPlan(plan udpServePlan) (*net.UDPConn, error) {
	addr, err := net.ResolveUDPAddr("udp", listenAddress(plan.host, plan.port))
	if err != nil {
		return nil, err
	}
	conn, err := net.ListenUDP("udp", addr)
	if err != nil {
		return nil, err
	}
	tuneUDPConn(conn, plan.role, fxpUDPListenBufferBytes)
	return conn, nil
}

// run 跑 UDP 服务；服务自己意外退出（不是被 stop 关掉的）就隔一秒重新绑上，
// 不再让一个 UDP 读错误带走整个进程。
func (s *udpServerSlot) run(conn *net.UDPConn) {
	defer close(s.done)
	for {
		err := catchPanic(s.label+" udp server", func() error { return s.plan.serve(conn) })
		s.mu.Lock()
		stopped := s.stopped
		s.mu.Unlock()
		if stopped {
			return
		}
		log.Printf("%s udp server on :%d stopped unexpectedly, restarting: %v", s.label, s.plan.port, err)
		_ = conn.Close()
		for {
			time.Sleep(time.Second)
			s.mu.Lock()
			if s.stopped {
				s.mu.Unlock()
				return
			}
			next, listenErr := listenUDPForPlan(s.plan)
			if listenErr == nil {
				s.conn = next
				conn = next
				s.mu.Unlock()
				break
			}
			s.mu.Unlock()
			log.Printf("%s udp rebind :%d failed: %v", s.label, s.plan.port, listenErr)
		}
	}
}

func (s *udpServerSlot) stop() {
	s.mu.Lock()
	s.stopped = true
	conn := s.conn
	s.mu.Unlock()
	if conn != nil {
		_ = conn.Close()
	}
	select {
	case <-s.done:
	case <-time.After(fxpShutdownDrain):
		log.Printf("%s udp server on :%d did not stop within %s", s.label, s.plan.port, fxpShutdownDrain)
	}
}

// ---- 进程入口 ----

type fxpReloadRequest struct {
	cfg    config
	result chan error
}

// runManaged 启动运行时并一直跑到 done；reloads 送来的新配置原地生效。
func runManaged(done <-chan struct{}, cfg config, reloads <-chan fxpReloadRequest) error {
	applyTCPCongestionConfig(cfg)
	manager := newFXPRuntimeManager(strings.ToLower(cfg.Role))
	if err := manager.apply(cfg); err != nil {
		manager.shutdown()
		return err
	}
	for {
		select {
		case <-done:
			manager.shutdown()
			return nil
		case request, ok := <-reloads:
			if !ok {
				reloads = nil
				continue
			}
			var err error
			if !strings.EqualFold(request.cfg.Role, cfg.Role) {
				err = fmt.Errorf("reload cannot change role %s -> %s", cfg.Role, request.cfg.Role)
			} else {
				invalidateHopResolverCache()
				err = manager.apply(request.cfg)
			}
			if err == nil {
				cfg = request.cfg
				applyTCPCongestionConfig(cfg)
				log.Printf("fxp config reloaded role=%s tunnel=%d", cfg.Role, cfg.TunnelID)
			} else {
				log.Printf("fxp config reload rejected, previous config keeps running: %v", err)
			}
			if request.result != nil {
				request.result <- err
			}
		}
	}
}
