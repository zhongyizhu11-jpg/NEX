package main

import (
	"net"
	"net/netip"
	"sync/atomic"
	"testing"
	"time"
)

// 会话键换成 netip.AddrPort 以后，「按访客固定」哈希用的字符串必须和以前
// (*net.UDPAddr).String() 一模一样，否则升级后同一来源会换路径。
func TestFailoverUDPSessionKeyMatchesLegacyString(t *testing.T) {
	cases := []*net.UDPAddr{
		{IP: net.IPv4(127, 0, 0, 1), Port: 40000},
		{IP: net.ParseIP("::ffff:198.51.100.7"), Port: 53},
		{IP: net.ParseIP("2001:db8::1"), Port: 443},
		{IP: net.ParseIP("fe80::1"), Port: 5353, Zone: "eth0"},
	}
	for _, legacy := range cases {
		key := failoverUDPSessionKey(legacy.AddrPort())
		if got, want := key.String(), legacy.String(); got != want {
			t.Fatalf("session key %q, legacy key %q", got, want)
		}
	}
	mapped := netip.MustParseAddrPort("[::ffff:10.0.0.1]:9")
	plain := netip.MustParseAddrPort("10.0.0.1:9")
	if failoverUDPSessionKey(mapped) != failoverUDPSessionKey(plain) {
		t.Fatal("IPv4-mapped and plain IPv4 sources must share one session")
	}
}

type deadlineCountingConn struct {
	net.Conn
	readDeadlines atomic.Int64
}

func (c *deadlineCountingConn) SetReadDeadline(t time.Time) error {
	c.readDeadlines.Add(1)
	return c.Conn.SetReadDeadline(t)
}

// 回包路径不再每个包都重设读超时：空闲窗口还剩一半以上时一次都不调。
func TestFailoverUDPReplyPathDoesNotRearmDeadlinePerPacket(t *testing.T) {
	failoverUDPTestSetup(t)
	echoPort := failoverUDPEcho(t, "E")
	spec := failoverTestSpec(failoverTestDualPort(t))
	spec.Protocol = "udp"
	spec.Targets = []failoverTarget{{TargetIP: "127.0.0.1", TargetPort: echoPort}, {TargetIP: "127.0.0.1", TargetPort: failoverUDPEcho(t, "F")}}
	proxy, _ := startUDPFailoverForTest(t, 950101, 65101, spec)

	client, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	raw, err := net.DialUDP("udp", nil, &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: echoPort})
	if err != nil {
		t.Fatal(err)
	}
	upstream := &deadlineCountingConn{Conn: raw}
	key := failoverUDPSessionKey(client.LocalAddr().(*net.UDPAddr).AddrPort())
	session := &failoverUDPSession{key: key, client: net.UDPAddrFromAddrPort(key), upstream: upstream, index: 0}
	session.touch(time.Now())
	done := make(chan struct{})
	go func() {
		proxy.copyUDPToClient(session)
		close(done)
	}()

	const packets = 50
	buf := make([]byte, 128)
	for i := 0; i < packets; i++ {
		if _, err := upstream.Write([]byte{byte(i)}); err != nil {
			t.Fatal(err)
		}
		_ = client.SetReadDeadline(time.Now().Add(2 * time.Second))
		n, err := client.Read(buf)
		if err != nil {
			t.Fatalf("reply %d: %v", i, err)
		}
		if string(buf[:n]) != "E:"+string([]byte{byte(i)}) {
			t.Fatalf("reply %d = %q", i, buf[:n])
		}
	}
	if calls := upstream.readDeadlines.Load(); calls > 1 {
		t.Fatalf("reply path re-armed the read deadline %d times for %d packets", calls, packets)
	}
	_ = raw.Close()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("reply goroutine did not exit after the upstream closed")
	}
}
