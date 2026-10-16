package main

// 共享 TLS 入站（SNI 分流）。
//
// 一个 TCP 端口（通常 443）上挂多条规则：读 TLS ClientHello 里的 SNI，把还没解密的连接
// 原样交给对应规则在本机回环上的守卫（127.0.0.1:<规则端口>，由面板分配，见
// server/tlsInbounds.ts）。读过的字节原样重放给守卫，TLS 从客户端一直到目标都是端到端的；
// 节点上不终止 TLS、不放证书、不看 HTTP Host。
//
// 计数、限速走规则自己的守卫（按回环端口装的计数器），这里只做分流。
//
// 分不出去的连接直接关掉，从不回 TLS alert：
//   - 没有 SNI：rejectEmptySni 时关；否则交给默认规则（没有默认规则也关）。
//   - SNI 不在入站白名单里：一律关。
//   - SNI 属于一条暂停 / 失效的规则：关，绝不落到默认规则（不然一个用户停掉的规则，流量会跑进别人的规则）。
//   - 没人认领的 SNI：按 unknownSniAction 关掉或交给默认规则。
//
// 路由表整份原子替换：改配置不影响已经建立的连接，换端口才会关掉旧监听（已建立的连接照旧跑完）。

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	sniMaxClientHelloBytes      = 128 * 1024
	sniMaxClientHelloRecords    = 128
	sniMaxTLSRecordPayload      = 16384 + 2048
	sniDefaultMaxHandshakes     = 128
	sniMaxHandshakesLimit       = 4096
	sniDefaultPerIPHandshakes   = 16
	sniDefaultHandshakeTimeout  = 5 * time.Second
	sniMaxHandshakeTimeout      = 30 * time.Second
	sniBackendDialTimeout       = 5 * time.Second
	sniTLSRecordTypeHandshake   = 0x16
	sniHandshakeTypeClientHello = 0x01
	sniExtensionServerName      = 0x0000
	sniServerNameTypeHostName   = 0x00
)

var (
	errSNINotTLS          = errors.New("not a TLS handshake")
	errSNIHelloTooLarge   = errors.New("client hello too large")
	errSNITooManyRecords  = errors.New("client hello spans too many records")
	errSNIMalformedHello  = errors.New("malformed client hello")
	errSNIDuplicateExt    = errors.New("duplicate tls extension")
	errSNIInvalidHostName = errors.New("invalid server name")
)

type sniRoute struct {
	Name                 string `json:"name"`
	RuleID               int    `json:"ruleId"`
	BackendPort          int    `json:"backendPort"`
	Active               bool   `json:"active"`
	ProxyProtocolVersion int    `json:"proxyProtocolVersion"`
}

type sniBackend struct {
	RuleID               int `json:"ruleId"`
	BackendPort          int `json:"backendPort"`
	ProxyProtocolVersion int `json:"proxyProtocolVersion"`
}

type sniInboundSpec struct {
	ID                      int         `json:"id"`
	Port                    int         `json:"port"`
	ProxyProtocol           string      `json:"proxyProtocol"`
	RejectEmptySNI          bool        `json:"rejectEmptySni"`
	UnknownSNIAction        string      `json:"unknownSniAction"`
	MaxHandshakes           int         `json:"maxHandshakes"`
	MaxHandshakesPerIP      int         `json:"maxHandshakesPerIp"`
	HandshakeTimeoutSeconds int         `json:"handshakeTimeoutSeconds"`
	AllowedSNI              []string    `json:"allowedSni"`
	DefaultBackend          *sniBackend `json:"defaultBackend"`
	Routes                  []sniRoute  `json:"routes"`
}

// ── ClientHello 解析 ─────────────────────────────────────────────

type sniClientHello struct {
	// Raw 是从连接上读到的全部字节（若干条完整的 TLS 记录），要原样重放给后端。
	Raw        []byte
	ServerName string
	HasSNI     bool
}

// readSNIClientHello 从 r 读 TLS 记录，直到拿到一条完整的 ClientHello。prefix 是已经从连接上
// 读出来、属于 TLS 流开头的字节（比如 PROXY 头后面多读的部分）。
// ClientHello 可以跨多条记录；总字节数不超过 128 KiB、记录数不超过 128 条。
func readSNIClientHello(prefix []byte, r io.Reader) (sniClientHello, error) {
	reader := io.MultiReader(bytes.NewReader(prefix), r)
	raw := make([]byte, 0, 1024)
	handshake := make([]byte, 0, 1024)
	records := 0
	need := -1
	for {
		if need >= 0 && len(handshake) >= need {
			break
		}
		if records >= sniMaxClientHelloRecords {
			return sniClientHello{Raw: raw}, errSNITooManyRecords
		}
		var header [5]byte
		if _, err := io.ReadFull(reader, header[:]); err != nil {
			if records == 0 && errors.Is(err, io.EOF) {
				return sniClientHello{Raw: raw}, err
			}
			return sniClientHello{Raw: raw}, errSNIMalformedHello
		}
		if header[0] != sniTLSRecordTypeHandshake || header[1] != 0x03 {
			if records == 0 {
				return sniClientHello{Raw: append(raw, header[:]...)}, errSNINotTLS
			}
			return sniClientHello{Raw: append(raw, header[:]...)}, errSNIMalformedHello
		}
		length := int(binary.BigEndian.Uint16(header[3:5]))
		if length == 0 || length > sniMaxTLSRecordPayload {
			return sniClientHello{Raw: append(raw, header[:]...)}, errSNIMalformedHello
		}
		if len(raw)+5+length > sniMaxClientHelloBytes {
			return sniClientHello{Raw: raw}, errSNIHelloTooLarge
		}
		start := len(raw)
		raw = append(raw, header[:]...)
		raw = append(raw, make([]byte, length)...)
		if _, err := io.ReadFull(reader, raw[start+5:]); err != nil {
			return sniClientHello{Raw: raw[:start]}, errSNIMalformedHello
		}
		records++
		handshake = append(handshake, raw[start+5:]...)
		if need < 0 && len(handshake) >= 4 {
			if handshake[0] != sniHandshakeTypeClientHello {
				return sniClientHello{Raw: raw}, errSNINotTLS
			}
			bodyLength := int(handshake[1])<<16 | int(handshake[2])<<8 | int(handshake[3])
			if bodyLength+4 > sniMaxClientHelloBytes {
				return sniClientHello{Raw: raw}, errSNIHelloTooLarge
			}
			need = bodyLength + 4
		}
	}
	name, hasSNI, err := parseSNIClientHelloBody(handshake[4:need])
	return sniClientHello{Raw: raw, ServerName: name, HasSNI: hasSNI}, err
}

type sniByteReader struct {
	data []byte
	err  bool
}

func (r *sniByteReader) take(n int) []byte {
	if r.err || n < 0 || len(r.data) < n {
		r.err = true
		return nil
	}
	out := r.data[:n]
	r.data = r.data[n:]
	return out
}

func (r *sniByteReader) u8() int {
	b := r.take(1)
	if b == nil {
		return 0
	}
	return int(b[0])
}

func (r *sniByteReader) u16() int {
	b := r.take(2)
	if b == nil {
		return 0
	}
	return int(binary.BigEndian.Uint16(b))
}

// parseSNIClientHelloBody 解析 ClientHello 的消息体（不含 4 字节的握手头），回 SNI 主机名。
func parseSNIClientHelloBody(body []byte) (string, bool, error) {
	r := &sniByteReader{data: body}
	r.take(2)  // legacy_version
	r.take(32) // random
	sessionIDLength := r.u8()
	if sessionIDLength > 32 {
		return "", false, errSNIMalformedHello
	}
	r.take(sessionIDLength)
	cipherSuitesLength := r.u16()
	if cipherSuitesLength < 2 || cipherSuitesLength%2 != 0 {
		return "", false, errSNIMalformedHello
	}
	r.take(cipherSuitesLength)
	compressionLength := r.u8()
	if compressionLength < 1 {
		return "", false, errSNIMalformedHello
	}
	r.take(compressionLength)
	if r.err {
		return "", false, errSNIMalformedHello
	}
	if len(r.data) == 0 {
		// 没有扩展块：合法但没有 SNI。
		return "", false, nil
	}
	extensionsLength := r.u16()
	extensions := r.take(extensionsLength)
	if r.err || len(r.data) != 0 {
		return "", false, errSNIMalformedHello
	}
	er := &sniByteReader{data: extensions}
	seen := map[int]bool{}
	serverName := ""
	hasSNI := false
	for len(er.data) > 0 {
		extType := er.u16()
		extLength := er.u16()
		extData := er.take(extLength)
		if er.err {
			return "", false, errSNIMalformedHello
		}
		if seen[extType] {
			return "", false, errSNIDuplicateExt
		}
		seen[extType] = true
		if extType != sniExtensionServerName {
			continue
		}
		name, err := parseSNIServerNameExtension(extData)
		if err != nil {
			return "", false, err
		}
		serverName = name
		hasSNI = name != ""
	}
	return serverName, hasSNI, nil
}

func parseSNIServerNameExtension(data []byte) (string, error) {
	if len(data) == 0 {
		// 服务端回的空 server_name 扩展长这样；客户端发来当作「没有名字」。
		return "", nil
	}
	r := &sniByteReader{data: data}
	listLength := r.u16()
	list := r.take(listLength)
	if r.err || len(r.data) != 0 {
		return "", errSNIMalformedHello
	}
	lr := &sniByteReader{data: list}
	name := ""
	for len(lr.data) > 0 {
		nameType := lr.u8()
		nameLength := lr.u16()
		value := lr.take(nameLength)
		if lr.err {
			return "", errSNIMalformedHello
		}
		if nameType != sniServerNameTypeHostName {
			continue
		}
		if name != "" {
			// RFC 6066：同一种类型只能有一个名字。
			return "", errSNIMalformedHello
		}
		normalized, ok := normalizeSNIHostName(string(value))
		if !ok {
			return "", errSNIInvalidHostName
		}
		name = normalized
	}
	return name, nil
}

// normalizeSNIHostName 小写、去掉末尾的点，只认 ASCII 主机名（中文域名在 SNI 里已经是 xn--）。
func normalizeSNIHostName(value string) (string, bool) {
	value = strings.ToLower(strings.TrimSuffix(value, "."))
	if value == "" || len(value) > 253 {
		return "", false
	}
	for _, label := range strings.Split(value, ".") {
		if label == "" || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return "", false
		}
		for i := 0; i < len(label); i++ {
			c := label[i]
			if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
				return "", false
			}
		}
	}
	return value, true
}

// ── 路由 ────────────────────────────────────────────────────────

type sniRoutingTable struct {
	inboundID        int
	routes           map[string]sniRoute
	allowed          []string
	rejectEmptySNI   bool
	defaultBackend   *sniBackend
	acceptProxy      bool
	maxHandshakes    int
	perIPHandshakes  int
	handshakeTimeout time.Duration
}

func newSNIRoutingTable(spec sniInboundSpec) *sniRoutingTable {
	table := &sniRoutingTable{
		inboundID:        spec.ID,
		routes:           make(map[string]sniRoute, len(spec.Routes)),
		rejectEmptySNI:   spec.RejectEmptySNI,
		acceptProxy:      strings.TrimSpace(spec.ProxyProtocol) == "auto",
		maxHandshakes:    spec.MaxHandshakes,
		perIPHandshakes:  spec.MaxHandshakesPerIP,
		handshakeTimeout: time.Duration(spec.HandshakeTimeoutSeconds) * time.Second,
	}
	if table.maxHandshakes <= 0 {
		table.maxHandshakes = sniDefaultMaxHandshakes
	}
	if table.maxHandshakes > sniMaxHandshakesLimit {
		table.maxHandshakes = sniMaxHandshakesLimit
	}
	if table.perIPHandshakes <= 0 {
		table.perIPHandshakes = sniDefaultPerIPHandshakes
	}
	if table.perIPHandshakes > table.maxHandshakes {
		table.perIPHandshakes = table.maxHandshakes
	}
	if table.handshakeTimeout <= 0 {
		table.handshakeTimeout = sniDefaultHandshakeTimeout
	}
	if table.handshakeTimeout > sniMaxHandshakeTimeout {
		table.handshakeTimeout = sniMaxHandshakeTimeout
	}
	for _, entry := range spec.AllowedSNI {
		entry = strings.ToLower(strings.TrimSpace(entry))
		if entry != "" {
			table.allowed = append(table.allowed, entry)
		}
	}
	for _, route := range spec.Routes {
		name, ok := normalizeSNIHostName(route.Name)
		if !ok || route.RuleID <= 0 {
			continue
		}
		if _, exists := table.routes[name]; exists {
			continue
		}
		route.Name = name
		table.routes[name] = route
	}
	if strings.TrimSpace(spec.UnknownSNIAction) == "default_rule" && spec.DefaultBackend != nil && spec.DefaultBackend.BackendPort > 0 {
		backend := *spec.DefaultBackend
		table.defaultBackend = &backend
	}
	return table
}

// sniNameAllowed：白名单为空全部放行；`example.com` 放行它和子域名，`.example.com` 只放子域名。
func sniNameAllowed(name string, allowed []string) bool {
	if len(allowed) == 0 {
		return true
	}
	for _, entry := range allowed {
		if strings.HasPrefix(entry, ".") {
			if len(name) > len(entry) && strings.HasSuffix(name, entry) {
				return true
			}
			continue
		}
		if name == entry || strings.HasSuffix(name, "."+entry) {
			return true
		}
	}
	return false
}

type sniDecision struct {
	backend sniBackend
	ok      bool
	reason  string
}

// decide 是全部分流规则；纯函数，好测。
func (t *sniRoutingTable) decide(serverName string, hasSNI bool) sniDecision {
	if !hasSNI || serverName == "" {
		if t.rejectEmptySNI {
			return sniDecision{reason: "empty-sni"}
		}
		if t.defaultBackend != nil {
			return sniDecision{backend: *t.defaultBackend, ok: true, reason: "empty-sni-default"}
		}
		return sniDecision{reason: "empty-sni-no-default"}
	}
	if !sniNameAllowed(serverName, t.allowed) {
		return sniDecision{reason: "not-allowed"}
	}
	if route, ok := t.routes[serverName]; ok {
		if !route.Active || route.BackendPort <= 0 {
			// 暂停 / 失效规则的名字：断开，绝不交给默认规则。
			return sniDecision{reason: "rule-inactive"}
		}
		return sniDecision{backend: sniBackend{RuleID: route.RuleID, BackendPort: route.BackendPort, ProxyProtocolVersion: route.ProxyProtocolVersion}, ok: true, reason: "matched"}
	}
	if t.defaultBackend != nil {
		return sniDecision{backend: *t.defaultBackend, ok: true, reason: "unknown-default"}
	}
	return sniDecision{reason: "unknown-sni"}
}

// ── 握手并发限制 ────────────────────────────────────────────────

type sniHandshakeLimiter struct {
	mu     sync.Mutex
	total  int
	perIP  map[string]int
	maxAll int
	maxIP  int
}

func newSNIHandshakeLimiter() *sniHandshakeLimiter {
	return &sniHandshakeLimiter{perIP: map[string]int{}}
}

func (l *sniHandshakeLimiter) setLimits(maxAll, maxIP int) {
	l.mu.Lock()
	l.maxAll = maxAll
	l.maxIP = maxIP
	l.mu.Unlock()
}

func (l *sniHandshakeLimiter) acquireTotal() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.maxAll > 0 && l.total >= l.maxAll {
		return false
	}
	l.total++
	return true
}

func (l *sniHandshakeLimiter) releaseTotal() {
	l.mu.Lock()
	if l.total > 0 {
		l.total--
	}
	l.mu.Unlock()
}

func (l *sniHandshakeLimiter) acquireIP(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.maxIP > 0 && l.perIP[ip] >= l.maxIP {
		return false
	}
	l.perIP[ip]++
	return true
}

func (l *sniHandshakeLimiter) releaseIP(ip string) {
	l.mu.Lock()
	if count := l.perIP[ip]; count <= 1 {
		delete(l.perIP, ip)
	} else {
		l.perIP[ip] = count - 1
	}
	l.mu.Unlock()
}

// ── 监听 ────────────────────────────────────────────────────────

type sniInboundServer struct {
	id       int
	port     int
	listener net.Listener
	table    atomic.Pointer[sniRoutingTable]
	limiter  *sniHandshakeLimiter
	done     chan struct{}
	once     sync.Once
}

type sniInboundStatus struct {
	ID        int    `json:"id"`
	Port      int    `json:"port"`
	Listening bool   `json:"listening"`
	Error     string `json:"error,omitempty"`
}

var (
	sniInboundMu      sync.Mutex
	sniInboundServers = map[int]*sniInboundServer{}
	sniInboundErrors  = map[int]sniInboundStatus{}
	sniListen         = func(port int) (net.Listener, error) {
		return net.Listen("tcp", ":"+strconv.Itoa(port))
	}
	sniDialBackend = func(port int) (net.Conn, error) {
		return net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), sniBackendDialTimeout)
	}
)

// syncSNIInbounds 让本机的共享入站和面板下发的一致。同一个入站端口没变时只换路由表。
func syncSNIInbounds(specs []sniInboundSpec) {
	sniInboundMu.Lock()
	defer sniInboundMu.Unlock()
	wanted := map[int]sniInboundSpec{}
	for _, spec := range specs {
		if spec.ID <= 0 || spec.Port <= 0 || spec.Port > 65535 {
			continue
		}
		wanted[spec.ID] = spec
	}
	for id, server := range sniInboundServers {
		spec, ok := wanted[id]
		if !ok || spec.Port != server.port {
			server.close()
			delete(sniInboundServers, id)
			logf("sni inbound stopped id=%d port=%d", id, server.port)
		}
	}
	for id := range sniInboundErrors {
		if _, ok := wanted[id]; !ok {
			delete(sniInboundErrors, id)
		}
	}
	ids := make([]int, 0, len(wanted))
	for id := range wanted {
		ids = append(ids, id)
	}
	sort.Ints(ids)
	for _, id := range ids {
		spec := wanted[id]
		table := newSNIRoutingTable(spec)
		if server := sniInboundServers[id]; server != nil {
			server.table.Store(table)
			server.limiter.setLimits(table.maxHandshakes, table.perIPHandshakes)
			continue
		}
		ln, err := sniListen(spec.Port)
		if err != nil {
			sniInboundErrors[id] = sniInboundStatus{ID: id, Port: spec.Port, Error: err.Error()}
			if shouldLogAgentReport(fmt.Sprintf("sni-inbound-listen:%d:%d", id, spec.Port), agentReportLogInterval) {
				logf("sni inbound listen failed id=%d port=%d: %v", id, spec.Port, err)
			}
			continue
		}
		delete(sniInboundErrors, id)
		server := &sniInboundServer{id: id, port: spec.Port, listener: ln, limiter: newSNIHandshakeLimiter(), done: make(chan struct{})}
		server.table.Store(table)
		server.limiter.setLimits(table.maxHandshakes, table.perIPHandshakes)
		sniInboundServers[id] = server
		go server.serve()
		logf("sni inbound started id=%d port=%d routes=%d", id, spec.Port, len(table.routes))
	}
}

// sniInboundStatusSnapshot 随心跳报给面板：哪个入站在听、哪个没听起来（端口被占之类）。
func sniInboundStatusSnapshot() []sniInboundStatus {
	sniInboundMu.Lock()
	defer sniInboundMu.Unlock()
	out := make([]sniInboundStatus, 0, len(sniInboundServers)+len(sniInboundErrors))
	for id, server := range sniInboundServers {
		out = append(out, sniInboundStatus{ID: id, Port: server.port, Listening: true})
	}
	for _, status := range sniInboundErrors {
		out = append(out, status)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// sniInboundOwnsPort：本机这个端口是不是共享入站自己在听（别的清理逻辑不该去动它）。
func sniInboundOwnsPort(port int) bool {
	sniInboundMu.Lock()
	defer sniInboundMu.Unlock()
	for _, server := range sniInboundServers {
		if server.port == port {
			return true
		}
	}
	return false
}

func (s *sniInboundServer) close() {
	s.once.Do(func() {
		close(s.done)
		_ = s.listener.Close()
	})
}

func (s *sniInboundServer) serve() {
	var backoff serveLoopBackoff
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			exit, fatal := serveLoopHandleError(s.done, &backoff, err, func(err error, suppressed int) {
				logf("sni inbound accept id=%d suppressed=%d: %v", s.id, suppressed, err)
			})
			if fatal {
				sniInboundMu.Lock()
				if sniInboundServers[s.id] == s {
					delete(sniInboundServers, s.id)
				}
				sniInboundMu.Unlock()
				s.close()
				wakeHeartbeat()
			}
			if exit {
				return
			}
			continue
		}
		backoff.success()
		if !s.limiter.acquireTotal() {
			_ = conn.Close()
			continue
		}
		go s.handleConn(conn)
	}
}

func sniRemoteIP(addr net.Addr) string {
	if tcp, ok := addr.(*net.TCPAddr); ok {
		return tcp.IP.String()
	}
	host, _, err := net.SplitHostPort(addr.String())
	if err != nil {
		return addr.String()
	}
	return host
}

// sniLooksLikeProxyHeader：首字节不是 TLS 握手记录时，看是不是 PROXY 头的开头。
func sniLooksLikeProxyHeader(first []byte) bool {
	if len(first) == 0 {
		return false
	}
	return bytes.HasPrefix([]byte("PROXY "), first[:1]) || bytes.HasPrefix(proxyProtocolV2Signature, first[:1])
}

func (s *sniInboundServer) handleConn(client net.Conn) {
	table := s.table.Load()
	totalHeld := true
	releaseTotal := func() {
		if totalHeld {
			totalHeld = false
			s.limiter.releaseTotal()
		}
	}
	defer releaseTotal()
	if table == nil {
		_ = client.Close()
		return
	}
	_ = client.SetReadDeadline(time.Now().Add(table.handshakeTimeout))
	info := proxyProtocolInfoFromConn(client)
	var prefix []byte
	if table.acceptProxy {
		first := make([]byte, 1)
		if _, err := io.ReadFull(client, first); err != nil {
			_ = client.Close()
			return
		}
		if first[0] != sniTLSRecordTypeHandshake && sniLooksLikeProxyHeader(first) {
			parsed, rest, ok, err := consumeProxyProtocolFromConn(client, first, table.handshakeTimeout)
			if err != nil || !ok {
				_ = client.Close()
				return
			}
			if strings.TrimSpace(parsed.SourceIP) != "" {
				info = parsed
			}
			prefix = rest
			_ = client.SetReadDeadline(time.Now().Add(table.handshakeTimeout))
		} else {
			prefix = first
		}
	}
	sourceIP := strings.TrimSpace(info.SourceIP)
	if sourceIP == "" {
		sourceIP = sniRemoteIP(client.RemoteAddr())
	}
	if !s.limiter.acquireIP(sourceIP) {
		_ = client.Close()
		return
	}
	hello, err := readSNIClientHello(prefix, client)
	s.limiter.releaseIP(sourceIP)
	if err != nil {
		_ = client.Close()
		return
	}
	// 读握手的这段时间里配置可能换过：按最新的表判断。
	if latest := s.table.Load(); latest != nil {
		table = latest
	}
	decision := table.decide(hello.ServerName, hello.HasSNI)
	if !decision.ok {
		if shouldLogAgentReport(fmt.Sprintf("sni-drop:%d:%s", s.id, decision.reason), agentReportLogInterval) {
			logf("sni inbound dropped id=%d port=%d sni=%q reason=%s", s.id, s.port, hello.ServerName, decision.reason)
		}
		_ = client.Close()
		return
	}
	_ = client.SetReadDeadline(time.Time{})
	releaseTotal()
	upstream, err := sniDialBackend(decision.backend.BackendPort)
	if err != nil {
		if shouldLogAgentReport(fmt.Sprintf("sni-backend:%d:%d", s.id, decision.backend.RuleID), agentReportLogInterval) {
			logf("sni inbound backend unavailable id=%d rule=%d port=%d: %v", s.id, decision.backend.RuleID, decision.backend.BackendPort, err)
		}
		_ = client.Close()
		return
	}
	payload := hello.Raw
	if decision.backend.ProxyProtocolVersion > 0 {
		header := buildProxyProtocol(decision.backend.ProxyProtocolVersion, info, client.RemoteAddr(), client.LocalAddr(), client.LocalAddr())
		payload = append(append(make([]byte, 0, len(header)+len(hello.Raw)), header...), hello.Raw...)
	}
	if _, err := upstream.Write(payload); err != nil {
		_ = upstream.Close()
		_ = client.Close()
		return
	}
	relayTCPBidirectional(client, upstream, tcpRelayHalfCloseLinger)
}
