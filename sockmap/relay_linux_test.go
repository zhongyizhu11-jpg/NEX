//go:build linux

package sockmap

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"io"
	"net"
	"sync"
	"testing"
	"time"
)

func requireSockmapRelay(t *testing.T) *sockmapRelay {
	t.Helper()
	relay := sockmapRelayGet()
	if relay == nil {
		t.Skipf("sockmap relay unavailable here: %s", sockmapRelayReason)
	}
	return relay
}

func TestSockmapRelayEnabledOnThisKernel(t *testing.T) {
	relay := requireSockmapRelay(t)
	if sockmapRelayStatus() != "enabled" || relay.verdictFD < 0 {
		t.Fatalf("status = %q", sockmapRelayStatus())
	}
}

func TestParseKernelRelease(t *testing.T) {
	cases := map[string][3]int{
		"5.10.0-28-amd64":     {5, 10, 1},
		"6.18.44-fc-v114":     {6, 18, 1},
		"5.4.0-150-generic":   {5, 4, 1},
		"4.19.0-26-cloud":     {4, 19, 1},
		"6.1.0+":              {6, 1, 1},
		"5.15.0-1047-oracle":  {5, 15, 1},
		"linux":               {0, 0, 0},
		"5":                   {0, 0, 0},
		"6.8.0-rc3-00012-gab": {6, 8, 1},
	}
	for release, want := range cases {
		major, minor, ok := parseKernelRelease(release)
		if ok != (want[2] == 1) || major != want[0] || minor != want[1] {
			t.Fatalf("%q: got %d.%d ok=%v want %d.%d ok=%v", release, major, minor, ok, want[0], want[1], want[2] == 1)
		}
	}
}

// sockmapTestPair 在回环上搭一对连接：client → (accepted | dialed) → server，中间
// 由 sockmap 对接。beforeSplice 在两端都建好、对接之前跑，用来模拟先说话的一方。
type sockmapTestPair struct {
	client   net.Conn
	server   net.Conn
	accepted *net.TCPConn
	dialed   *net.TCPConn
	done     chan struct{}
}

func newSockmapTestPair(t *testing.T, relay *sockmapRelay, linger time.Duration, beforeSplice func(client, server net.Conn)) *sockmapTestPair {
	t.Helper()
	listenA, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listenA.Close()
	listenB, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listenB.Close()
	client, err := net.Dial("tcp", listenA.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	accepted, err := listenA.Accept()
	if err != nil {
		t.Fatal(err)
	}
	dialed, err := net.Dial("tcp", listenB.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	server, err := listenB.Accept()
	if err != nil {
		t.Fatal(err)
	}
	if beforeSplice != nil {
		beforeSplice(client, server)
	}
	pair, err := relay.splice(accepted.(*net.TCPConn), dialed.(*net.TCPConn))
	if err != nil {
		t.Fatalf("splice: %v", err)
	}
	env := &sockmapTestPair{client: client, server: server, accepted: accepted.(*net.TCPConn), dialed: dialed.(*net.TCPConn), done: make(chan struct{})}
	go func() {
		pair.run(linger)
		close(env.done)
	}()
	t.Cleanup(func() {
		_ = client.Close()
		_ = server.Close()
		select {
		case <-env.done:
		case <-time.After(5 * time.Second):
			t.Errorf("relay did not finish after both ends closed")
		}
	})
	return env
}

func (env *sockmapTestPair) waitDone(t *testing.T, timeout time.Duration) {
	t.Helper()
	select {
	case <-env.done:
	case <-time.After(timeout):
		t.Fatal("relay did not finish in time")
	}
}

func patternPayload(size int, seed byte) []byte {
	payload := make([]byte, size)
	for i := range payload {
		payload[i] = byte(i*13+int(seed)) ^ byte(i>>9)
	}
	return payload
}

func TestSockmapServerSpeaksFirst(t *testing.T) {
	relay := requireSockmapRelay(t)
	env := newSockmapTestPair(t, relay, time.Second, func(client, server net.Conn) {
		if _, err := server.Write([]byte("220 banner\r\n")); err != nil {
			t.Fatal(err)
		}
		if _, err := client.Write([]byte("EHLO")); err != nil {
			t.Fatal(err)
		}
		time.Sleep(10 * time.Millisecond)
	})
	_ = env.client.SetDeadline(time.Now().Add(3 * time.Second))
	_ = env.server.SetDeadline(time.Now().Add(3 * time.Second))
	got := make([]byte, len("220 banner\r\n"))
	if _, err := io.ReadFull(env.client, got); err != nil || string(got) != "220 banner\r\n" {
		t.Fatalf("client banner = %q err=%v", got, err)
	}
	got = make([]byte, 4)
	if _, err := io.ReadFull(env.server, got); err != nil || string(got) != "EHLO" {
		t.Fatalf("server hello = %q err=%v", got, err)
	}
}

func TestSockmapSlowReaderBackpressureKeepsOrder(t *testing.T) {
	relay := requireSockmapRelay(t)
	env := newSockmapTestPair(t, relay, time.Second, nil)
	const size = 48 << 20
	payload := patternPayload(size, 3)
	relay.maxBacklog.Store(0)
	writeErr := make(chan error, 1)
	go func() {
		_, err := env.client.Write(payload)
		writeErr <- err
	}()
	_ = env.server.SetDeadline(time.Now().Add(30 * time.Second))
	hash := sha256.New()
	buf := make([]byte, 256<<10)
	total := 0
	for total < size {
		n, err := env.server.Read(buf)
		if err != nil {
			t.Fatalf("server read after %d bytes: %v", total, err)
		}
		hash.Write(buf[:n])
		total += n
		// 读得比回环慢得多，积压一定会攒起来，靠源端窗口收拢把发送方压住。
		time.Sleep(500 * time.Microsecond)
	}
	if err := <-writeErr; err != nil {
		t.Fatalf("client write: %v", err)
	}
	if !bytes.Equal(hash.Sum(nil), sha256sum(payload)) {
		t.Fatal("payload corrupted through slow reader")
	}
	// 回环上往返只有几微秒，最小窗口也压不住发送方，积压最后由硬上限兜住：
	// 不管走哪一级，数据都得完整（上面已经核对过）。
	t.Logf("max backlog %d bytes, throttles %d, handoffs %d", relay.maxBacklog.Load(), relay.throttles.Load(), relay.handoffs.Load())
	if relay.maxBacklog.Load() < sockmapBacklogHigh {
		t.Fatal("expected a backlog to build up behind the slow reader")
	}
}

func sha256sum(data []byte) []byte {
	sum := sha256.Sum256(data)
	return sum[:]
}

func TestSockmapHalfCloseAfterBulkKeepsTail(t *testing.T) {
	relay := requireSockmapRelay(t)
	env := newSockmapTestPair(t, relay, time.Second, nil)
	const size = 16 << 20
	payload := patternPayload(size, 9)
	go func() {
		_, _ = env.client.Write(payload)
		_, _ = env.client.Write([]byte("TAIL"))
		closeWrite(env.client)
	}()
	time.Sleep(50 * time.Millisecond)
	_ = env.server.SetDeadline(time.Now().Add(30 * time.Second))
	got, err := io.ReadAll(env.server)
	if err != nil {
		t.Fatalf("server read: %v", err)
	}
	if len(got) != size+4 || !bytes.Equal(got[:size], payload) || string(got[size:]) != "TAIL" {
		t.Fatalf("server got %d bytes, tail=%q", len(got), got[max(0, len(got)-4):])
	}
	// 半关闭之后反方向还能用。
	if _, err := env.server.Write([]byte("reply")); err != nil {
		t.Fatal(err)
	}
	_ = env.client.SetDeadline(time.Now().Add(3 * time.Second))
	reply := make([]byte, 5)
	if _, err := io.ReadFull(env.client, reply); err != nil || string(reply) != "reply" {
		t.Fatalf("client reply = %q err=%v", reply, err)
	}
	_ = env.server.Close()
	if n, err := env.client.Read(make([]byte, 1)); err == nil || n != 0 {
		t.Fatalf("client expected EOF, got n=%d err=%v", n, err)
	}
	env.waitDone(t, 5*time.Second)
}

func TestSockmapResetClosesBothSides(t *testing.T) {
	relay := requireSockmapRelay(t)
	env := newSockmapTestPair(t, relay, 10*time.Second, nil)
	if _, err := env.client.Write([]byte("hello")); err != nil {
		t.Fatal(err)
	}
	_ = env.server.SetDeadline(time.Now().Add(3 * time.Second))
	got := make([]byte, 5)
	if _, err := io.ReadFull(env.server, got); err != nil {
		t.Fatal(err)
	}
	_ = env.client.(*net.TCPConn).SetLinger(0)
	_ = env.client.Close()
	_, err := env.server.Read(make([]byte, 1))
	if err == nil {
		t.Fatal("server should see the connection end after the client reset")
	}
	env.waitDone(t, 5*time.Second)
}

func TestSockmapExternalCloseStopsRelay(t *testing.T) {
	relay := requireSockmapRelay(t)
	env := newSockmapTestPair(t, relay, 10*time.Second, nil)
	// 快速故障转移会直接 Close 被跟踪的客户端连接：中继必须立刻结束。
	_ = env.accepted.Close()
	env.waitDone(t, 5*time.Second)
	_ = env.server.SetDeadline(time.Now().Add(3 * time.Second))
	if _, err := env.server.Read(make([]byte, 1)); err == nil {
		t.Fatal("server side should be closed too")
	}
}

func TestSockmapLingerEndsIdleDirectionAfterHalfClose(t *testing.T) {
	relay := requireSockmapRelay(t)
	env := newSockmapTestPair(t, relay, 300*time.Millisecond, nil)
	closeWrite(env.client)
	_ = env.server.SetDeadline(time.Now().Add(3 * time.Second))
	if n, err := env.server.Read(make([]byte, 1)); err == nil || n != 0 {
		t.Fatalf("server expected EOF, got n=%d err=%v", n, err)
	}
	// 服务端既不说话也不关：linger 到期中继自己收尾。
	env.waitDone(t, 5*time.Second)
}

func TestSockmapConcurrentPairs(t *testing.T) {
	relay := requireSockmapRelay(t)
	const pairs = 24
	const size = 2 << 20
	var wg sync.WaitGroup
	errs := make(chan error, pairs*2)
	for i := 0; i < pairs; i++ {
		env := newSockmapTestPair(t, relay, time.Second, nil)
		up := patternPayload(size, byte(i))
		down := patternPayload(size, byte(i+100))
		wg.Add(2)
		go func() {
			defer wg.Done()
			_ = env.client.SetDeadline(time.Now().Add(30 * time.Second))
			go func() { _, _ = env.client.Write(up) }()
			got := make([]byte, size)
			if _, err := io.ReadFull(env.client, got); err != nil {
				errs <- err
				return
			}
			if !bytes.Equal(got, down) {
				errs <- errors.New("downstream payload corrupted")
			}
		}()
		go func() {
			defer wg.Done()
			_ = env.server.SetDeadline(time.Now().Add(30 * time.Second))
			go func() { _, _ = env.server.Write(down) }()
			got := make([]byte, size)
			if _, err := io.ReadFull(env.server, got); err != nil {
				errs <- err
				return
			}
			if !bytes.Equal(got, up) {
				errs <- errors.New("upstream payload corrupted")
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
}

func TestRelayRefusesWrappedConns(t *testing.T) {
	left, right := net.Pipe()
	defer left.Close()
	defer right.Close()
	if _, ok := Relay(left, right, time.Second); ok {
		t.Fatal("net.Pipe conns must not be taken over")
	}
}

func newLoopbackConns(t *testing.T) (client, accepted, dialed, server net.Conn) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	conns := make([]net.Conn, 0, 4)
	for i := 0; i < 2; i++ {
		c, err := net.Dial("tcp", listener.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		a, err := listener.Accept()
		if err != nil {
			t.Fatal(err)
		}
		conns = append(conns, c, a)
	}
	t.Cleanup(func() {
		for _, c := range conns {
			_ = c.Close()
		}
	})
	// client → accepted 是一对，dialed → server 是另一对。
	return conns[0], conns[1], conns[2], conns[3]
}

func TestRelayForceOff(t *testing.T) {
	SetForceOff(true)
	defer SetForceOff(false)
	_, accepted, dialed, _ := newLoopbackConns(t)
	if _, ok := Relay(accepted, dialed, time.Second); ok {
		t.Fatal("forced off must not take the sockmap path")
	}
	if Status() != "off" {
		t.Fatalf("status = %q", Status())
	}
}

func TestRelayReportsBytes(t *testing.T) {
	requireSockmapRelay(t)
	client, accepted, dialed, server := newLoopbackConns(t)
	type outcome struct {
		result Result
		ok     bool
	}
	done := make(chan outcome, 1)
	go func() {
		result, ok := Relay(accepted, dialed, time.Second)
		done <- outcome{result, ok}
	}()
	_ = client.SetDeadline(time.Now().Add(5 * time.Second))
	_ = server.SetDeadline(time.Now().Add(5 * time.Second))
	up := patternPayload(3<<20, 1)
	go func() {
		_, _ = client.Write(up)
		closeWrite(client)
	}()
	got, err := io.ReadAll(server)
	if err != nil || !bytes.Equal(got, up) {
		t.Fatalf("server got %d bytes err=%v", len(got), err)
	}
	if _, err := server.Write([]byte("bye")); err != nil {
		t.Fatal(err)
	}
	_ = server.Close()
	reply, err := io.ReadAll(client)
	if err != nil || string(reply) != "bye" {
		t.Fatalf("client got %q err=%v", reply, err)
	}
	select {
	case out := <-done:
		if !out.ok {
			t.Fatal("relay was not taken over on a capable kernel")
		}
		if out.result.AcceptedToDialed != uint64(len(up)) || out.result.DialedToAccepted != 3 {
			t.Fatalf("result = %+v", out.result)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("relay did not finish")
	}
}

func TestSockmapOffUnlessEnabled(t *testing.T) {
	cases := map[string]bool{"": false, "0": false, "off": false, "garbage": false, "1": true, "on": true, " TRUE ": true, "enabled": true}
	for value, want := range cases {
		t.Setenv(sockmapEnvName, value)
		if got := sockmapEnabledByEnv(); got != want {
			t.Errorf("NEX_SOCKMAP=%q: enabled=%v want %v", value, got, want)
		}
	}
}
