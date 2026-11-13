package main

import (
	"context"
	"fmt"
	"io"
	"math/rand"
	"net"
	"net/netip"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/header"
	"gvisor.dev/gvisor/pkg/tcpip/transport/tcp"
)

// 这里的测试把两个 wireGuardNetTUN（和 V2 数据面同一套 gVisor 协议栈、同一套调参）
// 背靠背接起来，中间不走 WireGuard，只按给定规则丢包，用来复现「V2 的 TCP 大流量传到
// 一半彻底停住」：tuneWireGuardNetstack 以前把拥塞控制设成 cubic，这一版 gVisor 的
// cubic 会把 SndCwnd 降到 0，发送端从此不再发包（见 wireguard_netstack_tuning.go）。

// pumpNetTUN 从 from 的出站队列取包交给 to，drop 返回 true 的包丢掉。from 关闭后返回。
func pumpNetTUN(from, to *wireGuardNetTUN, drop func([]byte) bool) {
	bufs := make([][]byte, from.BatchSize())
	sizes := make([]int, len(bufs))
	for i := range bufs {
		bufs[i] = make([]byte, 65535)
	}
	out := make([][]byte, 0, len(bufs))
	for {
		n, err := from.Read(bufs, sizes, 0)
		if err != nil {
			return
		}
		out = out[:0]
		for i := 0; i < n; i++ {
			packet := bufs[i][:sizes[i]]
			if drop != nil && drop(packet) {
				continue
			}
			out = append(out, append([]byte(nil), packet...))
		}
		if len(out) > 0 {
			_, _ = to.Write(out, 0)
		}
	}
}

// tcpPayloadLen 返回 IPv4/TCP 包的载荷字节数；不是 TCP 返回 -1。
func tcpPayloadLen(packet []byte) int {
	if len(packet) < header.IPv4MinimumSize || packet[0]>>4 != 4 {
		return -1
	}
	ip := header.IPv4(packet)
	if ip.TransportProtocol() != header.TCPProtocolNumber {
		return -1
	}
	payload := ip.Payload()
	if len(payload) < header.TCPMinimumSize {
		return -1
	}
	return len(payload) - int(header.TCP(payload).DataOffset())
}

// randomDataLoss 按固定种子、以 rate 的概率丢带数据的 TCP 段（纯 ACK、SYN、FIN 不丢）。
func randomDataLoss(seed int64, rate float64) func([]byte) bool {
	var mu sync.Mutex
	rng := rand.New(rand.NewSource(seed))
	return func(packet []byte) bool {
		if tcpPayloadLen(packet) <= 0 {
			return false
		}
		mu.Lock()
		defer mu.Unlock()
		return rng.Float64() < rate
	}
}

type netstackBulkResult struct {
	received int64
	err      error
	// 卡住时发送端的拥塞状态（没卡住时为零）。
	cwnd, ssthresh uint32
}

// runNetstackBulk 从 sender 往 receiver 灌 total 字节（sender→receiver 方向按 dropData 丢包），
// 收端连续 stallAfter 没收到任何新数据就判为卡住，返回发送端当时的拥塞窗口。
func runNetstackBulk(t *testing.T, total int64, stallAfter time.Duration, dropData func([]byte) bool) netstackBulkResult {
	t.Helper()
	receiverAddr := netip.MustParseAddr("100.104.0.1")
	senderAddr := netip.MustParseAddr("100.104.0.2")
	receiver, err := newWireGuardNetTUN(receiverAddr, 1380)
	if err != nil {
		t.Fatal(err)
	}
	defer receiver.Close()
	sender, err := newWireGuardNetTUN(senderAddr, 1380)
	if err != nil {
		t.Fatal(err)
	}
	defer sender.Close()
	for _, dev := range []*wireGuardNetTUN{receiver, sender} {
		if err := tuneWireGuardNetstack(dev.stack); err != nil {
			t.Fatal(err)
		}
	}
	go pumpNetTUN(sender, receiver, dropData)
	go pumpNetTUN(receiver, sender, nil)

	const port = 40100
	listener, err := receiver.ListenTCP(&net.TCPAddr{IP: net.IP(receiverAddr.AsSlice()), Port: port})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	accepted := make(chan net.Conn, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			close(accepted)
			return
		}
		accepted <- conn
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client, err := sender.DialContextTCP(ctx, &net.TCPAddr{IP: net.IP(receiverAddr.AsSlice()), Port: port})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	server, ok := <-accepted
	if !ok {
		t.Fatal("accept failed")
	}
	defer server.Close()

	var received atomic.Int64
	readDone := make(chan error, 1)
	go func() {
		buf := make([]byte, 64<<10)
		for {
			n, err := server.Read(buf)
			received.Add(int64(n))
			if err == io.EOF {
				readDone <- nil
				return
			}
			if err != nil {
				readDone <- err
				return
			}
		}
	}()
	go func() {
		chunk := make([]byte, 64<<10)
		for left := total; left > 0; {
			n := int64(len(chunk))
			if n > left {
				n = left
			}
			if _, err := client.Write(chunk[:n]); err != nil {
				return
			}
			left -= n
		}
		_ = client.CloseWrite()
	}()

	last, lastChange := int64(-1), time.Now()
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case err := <-readDone:
			if err == nil && received.Load() != total {
				err = fmt.Errorf("received %d bytes, want %d", received.Load(), total)
			}
			return netstackBulkResult{received: received.Load(), err: err}
		case <-ticker.C:
		}
		if got := received.Load(); got != last {
			last, lastChange = got, time.Now()
			continue
		}
		if time.Since(lastChange) < stallAfter {
			continue
		}
		result := netstackBulkResult{received: last, err: fmt.Errorf("no progress for %v", stallAfter)}
		for _, registered := range sender.stack.RegisteredEndpoints() {
			ep, ok := registered.(*tcp.Endpoint)
			if !ok || tcp.EndpointState(ep.State()) != tcp.StateEstablished {
				continue
			}
			var info tcpip.TCPInfoOption
			if err := ep.GetSockOpt(&info); err == nil {
				result.cwnd, result.ssthresh = info.SndCwnd, info.SndSsthresh
			}
		}
		return result
	}
}

// 修复前（cubic）：1% 随机丢包下每一轮都在 1~3MB 处停住，发送端 SndCwnd=0、Ssthresh=2，
// 之后再也不发包。修复后（reno）：16MB 不到一秒传完。
func TestWireGuardNetstackBulkSurvivesPacketLoss(t *testing.T) {
	const total = 16 << 20
	for _, tc := range []struct {
		seed int64
		loss float64
	}{
		{seed: 1, loss: 0.01},
		{seed: 2, loss: 0.01},
		{seed: 3, loss: 0.03},
	} {
		t.Run(fmt.Sprintf("seed%d-loss%.0fpct", tc.seed, tc.loss*100), func(t *testing.T) {
			result := runNetstackBulk(t, total, 5*time.Second, randomDataLoss(tc.seed, tc.loss))
			if result.err != nil {
				t.Fatalf("bulk transfer over V2 netstack stalled at %d/%d bytes: %v (sender cwnd=%d ssthresh=%d)",
					result.received, int64(total), result.err, result.cwnd, result.ssthresh)
			}
		})
	}
}
