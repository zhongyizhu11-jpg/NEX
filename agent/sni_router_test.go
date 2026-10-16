package main

import (
	"bytes"
	"crypto/tls"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

// captureClientHello 让标准库的 TLS 客户端发一条真的 ClientHello，原样截下来（几条完整记录）。
func captureClientHello(t *testing.T, serverName string) []byte {
	t.Helper()
	clientSide, serverSide := net.Pipe()
	defer clientSide.Close()
	defer serverSide.Close()
	go func() {
		conn := tls.Client(clientSide, &tls.Config{ServerName: serverName, InsecureSkipVerify: true, MinVersion: tls.VersionTLS12})
		_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
		_ = conn.Handshake()
	}()
	_ = serverSide.SetReadDeadline(time.Now().Add(2 * time.Second))
	hello, err := readSNIClientHello(nil, serverSide)
	if err != nil {
		t.Fatalf("read real client hello: %v", err)
	}
	return hello.Raw
}

// helloHandshakePayload 把若干条记录拼回握手层的字节流。
func helloHandshakePayload(t *testing.T, raw []byte) []byte {
	t.Helper()
	out := []byte{}
	for len(raw) > 0 {
		if len(raw) < 5 {
			t.Fatalf("truncated record")
		}
		length := int(binary.BigEndian.Uint16(raw[3:5]))
		out = append(out, raw[5:5+length]...)
		raw = raw[5+length:]
	}
	return out
}

// splitIntoRecords 把握手字节按 chunk 大小切成多条 TLS 记录。
func splitIntoRecords(payload []byte, chunk int) []byte {
	out := []byte{}
	for len(payload) > 0 {
		n := chunk
		if n > len(payload) {
			n = len(payload)
		}
		out = append(out, 0x16, 0x03, 0x01, byte(n>>8), byte(n))
		out = append(out, payload[:n]...)
		payload = payload[n:]
	}
	return out
}

type testExtension struct {
	typ  int
	data []byte
}

func sniExtensionData(names ...string) []byte {
	list := []byte{}
	for _, name := range names {
		list = append(list, 0x00, byte(len(name)>>8), byte(len(name)))
		list = append(list, name...)
	}
	return append([]byte{byte(len(list) >> 8), byte(len(list))}, list...)
}

// buildClientHello 手工拼一条 ClientHello（一条记录），用来测各种畸形情况。
func buildClientHello(extensions []testExtension, withExtensionsBlock bool) []byte {
	body := []byte{0x03, 0x03}
	body = append(body, bytes.Repeat([]byte{0x11}, 32)...)
	body = append(body, 0x00)                   // session id
	body = append(body, 0x00, 0x02, 0x13, 0x01) // cipher suites
	body = append(body, 0x01, 0x00)             // compression
	if withExtensionsBlock {
		ext := []byte{}
		for _, item := range extensions {
			ext = append(ext, byte(item.typ>>8), byte(item.typ), byte(len(item.data)>>8), byte(len(item.data)))
			ext = append(ext, item.data...)
		}
		body = append(body, byte(len(ext)>>8), byte(len(ext)))
		body = append(body, ext...)
	}
	handshake := append([]byte{0x01, byte(len(body) >> 16), byte(len(body) >> 8), byte(len(body))}, body...)
	return splitIntoRecords(handshake, 16384)
}

func TestSNIParserRealClientHello(t *testing.T) {
	raw := captureClientHello(t, "Shop.Example.COM")
	hello, err := readSNIClientHello(nil, bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if !hello.HasSNI || hello.ServerName != "shop.example.com" {
		t.Fatalf("server name = %q has=%v", hello.ServerName, hello.HasSNI)
	}
	if !bytes.Equal(hello.Raw, raw) {
		t.Fatalf("raw bytes must be replayed verbatim")
	}
}

func TestSNIParserHelloSplitAcrossRecords(t *testing.T) {
	raw := captureClientHello(t, "split.example.com")
	payload := helloHandshakePayload(t, raw)
	for _, chunk := range []int{1, 3, 7, 64, 200} {
		split := splitIntoRecords(payload, chunk)
		if len(payload)/chunk+1 > sniMaxClientHelloRecords {
			// 切得太碎会超过记录数上限：应当被拒绝而不是硬撑。
			if _, err := readSNIClientHello(nil, bytes.NewReader(split)); !errors.Is(err, errSNITooManyRecords) {
				t.Fatalf("chunk=%d expected too-many-records, got %v", chunk, err)
			}
			continue
		}
		hello, err := readSNIClientHello(nil, bytes.NewReader(split))
		if err != nil {
			t.Fatalf("chunk=%d parse: %v", chunk, err)
		}
		if hello.ServerName != "split.example.com" || !bytes.Equal(hello.Raw, split) {
			t.Fatalf("chunk=%d name=%q", chunk, hello.ServerName)
		}
	}
}

func TestSNIParserPrefixBytes(t *testing.T) {
	raw := captureClientHello(t, "prefix.example.com")
	hello, err := readSNIClientHello(raw[:3], bytes.NewReader(raw[3:]))
	if err != nil || hello.ServerName != "prefix.example.com" || !bytes.Equal(hello.Raw, raw) {
		t.Fatalf("prefix parse failed: %v %q", err, hello.ServerName)
	}
}

func TestSNIParserOversizedHello(t *testing.T) {
	handshake := []byte{0x01, 0x03, 0x00, 0x00} // 声称 192 KiB
	if _, err := readSNIClientHello(nil, bytes.NewReader(splitIntoRecords(append(handshake, make([]byte, 100)...), 16384))); !errors.Is(err, errSNIHelloTooLarge) {
		t.Fatalf("expected too large, got %v", err)
	}
	// 声称的长度没超，但切成 33 条记录后加上记录头就超过 128 KiB：读到那一条之前就要停。
	body := make([]byte, 131000)
	handshake = append([]byte{0x01, byte(len(body) >> 16), byte(len(body) >> 8), byte(len(body))}, body...)
	if _, err := readSNIClientHello(nil, bytes.NewReader(splitIntoRecords(handshake, 4000))); !errors.Is(err, errSNIHelloTooLarge) {
		t.Fatalf("expected too large for streamed hello, got %v", err)
	}
}

func TestSNIParserDuplicateExtension(t *testing.T) {
	raw := buildClientHello([]testExtension{
		{typ: 0x0000, data: sniExtensionData("a.example.com")},
		{typ: 0x000a, data: []byte{0x00, 0x02, 0x00, 0x1d}},
		{typ: 0x000a, data: []byte{0x00, 0x02, 0x00, 0x1d}},
	}, true)
	if _, err := readSNIClientHello(nil, bytes.NewReader(raw)); !errors.Is(err, errSNIDuplicateExt) {
		t.Fatalf("expected duplicate extension error, got %v", err)
	}
	raw = buildClientHello([]testExtension{
		{typ: 0x0000, data: sniExtensionData("a.example.com")},
		{typ: 0x0000, data: sniExtensionData("b.example.com")},
	}, true)
	if _, err := readSNIClientHello(nil, bytes.NewReader(raw)); !errors.Is(err, errSNIDuplicateExt) {
		t.Fatalf("expected duplicate SNI extension error, got %v", err)
	}
}

func TestSNIParserMissingSNI(t *testing.T) {
	for _, raw := range [][]byte{
		buildClientHello(nil, false),
		buildClientHello([]testExtension{{typ: 0x000a, data: []byte{0x00, 0x02, 0x00, 0x1d}}}, true),
		buildClientHello([]testExtension{{typ: 0x0000, data: nil}}, true),
	} {
		hello, err := readSNIClientHello(nil, bytes.NewReader(raw))
		if err != nil {
			t.Fatalf("missing SNI must parse: %v", err)
		}
		if hello.HasSNI || hello.ServerName != "" {
			t.Fatalf("expected no SNI, got %q", hello.ServerName)
		}
	}
}

func TestSNIParserRejectsMalformedInput(t *testing.T) {
	cases := map[string][]byte{
		"http":            []byte("GET / HTTP/1.1\r\nHost: a.example.com\r\n\r\n"),
		"ssh":             []byte("SSH-2.0-OpenSSH_9.6\r\n"),
		"server hello":    splitIntoRecords([]byte{0x02, 0x00, 0x00, 0x02, 0x03, 0x03}, 16384),
		"truncated":       buildClientHello([]testExtension{{typ: 0, data: sniExtensionData("a.example.com")}}, true)[:30],
		"two names":       buildClientHello([]testExtension{{typ: 0, data: sniExtensionData("a.example.com", "b.example.com")}}, true),
		"bad hostname":    buildClientHello([]testExtension{{typ: 0, data: sniExtensionData("bad host.example.com")}}, true),
		"empty":           {},
		"zero record":     {0x16, 0x03, 0x01, 0x00, 0x00},
		"alert mid-hello": append(splitIntoRecords([]byte{0x01, 0x00, 0x00, 0x40, 0x03}, 16384), 0x15, 0x03, 0x01, 0x00, 0x02, 0x02, 0x28),
	}
	for name, raw := range cases {
		if _, err := readSNIClientHello(nil, bytes.NewReader(raw)); err == nil {
			t.Fatalf("%s: expected error", name)
		}
	}
	if _, err := readSNIClientHello(nil, bytes.NewReader(cases["http"])); !errors.Is(err, errSNINotTLS) {
		t.Fatalf("http should be reported as not TLS, got %v", err)
	}
}

func testSNITable(mutate func(*sniInboundSpec)) *sniRoutingTable {
	spec := sniInboundSpec{
		ID:               1,
		Port:             443,
		RejectEmptySNI:   true,
		UnknownSNIAction: "reject",
		AllowedSNI:       []string{"example.com", ".tenant.net"},
		Routes: []sniRoute{
			{Name: "a.example.com", RuleID: 10, BackendPort: 45001, Active: true},
			{Name: "paused.example.com", RuleID: 11, BackendPort: 45002, Active: false},
			{Name: "app.tenant.net", RuleID: 12, BackendPort: 45003, Active: true, ProxyProtocolVersion: 2},
		},
	}
	if mutate != nil {
		mutate(&spec)
	}
	return newSNIRoutingTable(spec)
}

func TestSNIRoutingDecisions(t *testing.T) {
	table := testSNITable(nil)
	if d := table.decide("a.example.com", true); !d.ok || d.backend.RuleID != 10 || d.backend.BackendPort != 45001 {
		t.Fatalf("exact match: %+v", d)
	}
	if d := table.decide("app.tenant.net", true); !d.ok || d.backend.ProxyProtocolVersion != 2 {
		t.Fatalf("proxy version must follow route: %+v", d)
	}
	if d := table.decide("A.example.com", true); d.ok {
		t.Fatalf("decide expects normalized names; parser lowercases")
	}
	if d := table.decide("paused.example.com", true); d.ok || d.reason != "rule-inactive" {
		t.Fatalf("paused rule must drop: %+v", d)
	}
	if d := table.decide("other.example.com", true); d.ok || d.reason != "unknown-sni" {
		t.Fatalf("unknown must drop: %+v", d)
	}
	if d := table.decide("", false); d.ok || d.reason != "empty-sni" {
		t.Fatalf("empty must drop: %+v", d)
	}
	if d := table.decide("tenant.net", true); d.ok || d.reason != "not-allowed" {
		t.Fatalf(".tenant.net must not allow the apex: %+v", d)
	}
	if d := table.decide("evil.com", true); d.ok || d.reason != "not-allowed" {
		t.Fatalf("outside allowlist must drop: %+v", d)
	}
}

func TestSNIRoutingDefaultRule(t *testing.T) {
	table := testSNITable(func(spec *sniInboundSpec) {
		spec.UnknownSNIAction = "default_rule"
		spec.DefaultBackend = &sniBackend{RuleID: 99, BackendPort: 45099}
		spec.RejectEmptySNI = false
	})
	if d := table.decide("other.example.com", true); !d.ok || d.backend.RuleID != 99 {
		t.Fatalf("unknown should go to default: %+v", d)
	}
	if d := table.decide("", false); !d.ok || d.backend.RuleID != 99 {
		t.Fatalf("empty SNI with rejectEmptySni=false should go to default: %+v", d)
	}
	// 暂停规则的名字绝不落到默认规则（不能把一个用户的流量交给别人的规则）。
	if d := table.decide("paused.example.com", true); d.ok {
		t.Fatalf("paused name must never fall through to default: %+v", d)
	}
	// 白名单外的名字一律断开，默认规则也不接。
	if d := table.decide("evil.com", true); d.ok {
		t.Fatalf("outside allowlist must never go to default: %+v", d)
	}
	rejectEmpty := testSNITable(func(spec *sniInboundSpec) {
		spec.UnknownSNIAction = "default_rule"
		spec.DefaultBackend = &sniBackend{RuleID: 99, BackendPort: 45099}
	})
	if d := rejectEmpty.decide("", false); d.ok {
		t.Fatalf("rejectEmptySni must win over default: %+v", d)
	}
	// unknownSniAction=reject 时即使带了 defaultBackend 也不用。
	ignored := testSNITable(func(spec *sniInboundSpec) {
		spec.DefaultBackend = &sniBackend{RuleID: 99, BackendPort: 45099}
	})
	if d := ignored.decide("other.example.com", true); d.ok {
		t.Fatalf("reject action must ignore default backend: %+v", d)
	}
}

func TestSNIAllowlistEmptyAllowsAll(t *testing.T) {
	table := testSNITable(func(spec *sniInboundSpec) { spec.AllowedSNI = nil })
	if d := table.decide("a.example.com", true); !d.ok {
		t.Fatalf("empty allowlist allows everything: %+v", d)
	}
}

func TestSNIHandshakeLimiter(t *testing.T) {
	limiter := newSNIHandshakeLimiter()
	limiter.setLimits(2, 1)
	if !limiter.acquireTotal() || !limiter.acquireTotal() || limiter.acquireTotal() {
		t.Fatalf("total limit not enforced")
	}
	limiter.releaseTotal()
	if !limiter.acquireTotal() {
		t.Fatalf("release must free a slot")
	}
	if !limiter.acquireIP("1.1.1.1") || limiter.acquireIP("1.1.1.1") || !limiter.acquireIP("2.2.2.2") {
		t.Fatalf("per-ip limit not enforced")
	}
	limiter.releaseIP("1.1.1.1")
	if !limiter.acquireIP("1.1.1.1") {
		t.Fatalf("per-ip release must free a slot")
	}
}

// 端到端：真的 TLS 客户端 → 入站 → 回环后端，后端收到的字节和客户端发出的完全一样；
// 不认识的名字直接被关掉。
func TestSNIInboundEndToEnd(t *testing.T) {
	backend, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	backendPort := backend.Addr().(*net.TCPAddr).Port
	received := make(chan []byte, 1)
	go func() {
		conn, err := backend.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
		hello, _ := readSNIClientHello(nil, conn)
		received <- hello.Raw
	}()

	previousListen := sniListen
	sniListen = func(int) (net.Listener, error) { return net.Listen("tcp", "127.0.0.1:0") }
	defer func() { sniListen = previousListen }()
	syncSNIInbounds([]sniInboundSpec{{
		ID: 7, Port: 443, RejectEmptySNI: true, UnknownSNIAction: "reject",
		Routes: []sniRoute{{Name: "e2e.example.com", RuleID: 1, BackendPort: backendPort, Active: true}},
	}})
	defer syncSNIInbounds(nil)
	sniInboundMu.Lock()
	server := sniInboundServers[7]
	sniInboundMu.Unlock()
	if server == nil {
		t.Fatalf("inbound did not start")
	}
	addr := server.listener.Addr().String()

	dial := func(name string) (net.Conn, []byte) {
		conn, err := net.Dial("tcp", addr)
		if err != nil {
			t.Fatal(err)
		}
		recorder := &recordingConn{Conn: conn}
		client := tls.Client(recorder, &tls.Config{ServerName: name, InsecureSkipVerify: true})
		_ = client.SetDeadline(time.Now().Add(time.Second))
		_ = client.Handshake()
		return conn, recorder.written.Bytes()
	}

	conn, sent := dial("e2e.example.com")
	conn.Close()
	select {
	case got := <-received:
		if len(got) == 0 || !bytes.HasPrefix(sent, got) {
			t.Fatalf("backend must receive the client hello verbatim")
		}
	case <-time.After(3 * time.Second):
		t.Fatalf("backend did not receive the connection")
	}

	conn, _ = dial("unknown.example.com")
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 16)
	n, err := conn.Read(buf)
	conn.Close()
	if n != 0 || err == nil || isNetTimeout(err) {
		t.Fatalf("unknown SNI must be closed without any reply (n=%d err=%v)", n, err)
	}

	status := sniInboundStatusSnapshot()
	if len(status) != 1 || !status[0].Listening || status[0].ID != 7 {
		t.Fatalf("status snapshot: %+v", status)
	}
}

func TestSNIInboundListenFailureReported(t *testing.T) {
	previousListen := sniListen
	sniListen = func(int) (net.Listener, error) { return nil, errors.New("address already in use") }
	defer func() { sniListen = previousListen }()
	syncSNIInbounds([]sniInboundSpec{{ID: 3, Port: 443}})
	defer syncSNIInbounds(nil)
	status := sniInboundStatusSnapshot()
	if len(status) != 1 || status[0].Listening || !strings.Contains(status[0].Error, "in use") {
		t.Fatalf("listen failure must be reported: %+v", status)
	}
}

type recordingConn struct {
	net.Conn
	written bytes.Buffer
}

func (c *recordingConn) Write(p []byte) (int, error) {
	c.written.Write(p)
	return c.Conn.Write(p)
}

var _ io.Writer = (*recordingConn)(nil)
