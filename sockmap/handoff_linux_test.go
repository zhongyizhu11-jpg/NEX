//go:build linux

package sockmap

import (
	"bytes"
	"crypto/sha256"
	"io"
	"testing"
	"time"
)

// withHardCap 把交回用户态的门槛调小，让测试一定走到 handoff。
func withHardCap(t *testing.T, cap int64) {
	t.Helper()
	old := sockmapBacklogHardCap
	sockmapBacklogHardCap = cap
	t.Cleanup(func() { sockmapBacklogHardCap = old })
}

// 慢读者把积压顶过硬上限：这个方向交回用户态，数据一个字节都不能少、不能乱。
func TestSockmapHandoffSlowReaderKeepsEveryByte(t *testing.T) {
	relay := requireSockmapRelay(t)
	withHardCap(t, 256<<10)
	env := newSockmapTestPair(t, relay, time.Second, nil)
	const size = 96 << 20
	payload := patternPayload(size, 11)
	before := relay.handoffs.Load()
	// 分块慢慢写：中继在发送方还在送的时候就能看到积压。一口气写完再关的话，
	// 数据可能在两次检查之间就全进了内核，EOF 以后就只剩等它写完了。
	go func() {
		for off := 0; off < size; off += 1 << 20 {
			if _, err := env.client.Write(payload[off : off+1<<20]); err != nil {
				return
			}
			time.Sleep(time.Millisecond)
		}
		closeWrite(env.client)
	}()
	// 先不读，让积压一定顶过硬上限。
	time.Sleep(100 * time.Millisecond)
	_ = env.server.SetDeadline(time.Now().Add(60 * time.Second))
	hash := sha256.New()
	buf := make([]byte, 64<<10)
	total := 0
	for {
		n, err := env.server.Read(buf)
		hash.Write(buf[:n])
		total += n
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("server read after %d bytes: %v", total, err)
		}
		if total < 8<<20 {
			time.Sleep(time.Millisecond)
		}
	}
	if total != size || !bytes.Equal(hash.Sum(nil), sha256sum(payload)) {
		t.Fatalf("got %d of %d bytes or corrupted", total, size)
	}
	if relay.handoffs.Load() == before {
		t.Fatalf("expected the slow reader to push this direction back to userspace (max backlog %d, throttles %d)", relay.maxBacklog.Load(), relay.throttles.Load())
	}
}

// 双向同时大流量，两个方向都会被交回用户态：回显必须逐字节一致，EOF 在最后。
func TestSockmapHandoffBulkEchoBothDirections(t *testing.T) {
	relay := requireSockmapRelay(t)
	withHardCap(t, 512<<10)
	for round := 0; round < 3; round++ {
		env := newSockmapTestPair(t, relay, time.Second, nil)
		const size = 128 << 20
		payload := patternPayload(size, byte(round))
		go func() {
			_, _ = io.Copy(env.server, env.server)
			closeWrite(env.server)
		}()
		go func() {
			_, _ = env.client.Write(payload)
			closeWrite(env.client)
		}()
		_ = env.client.SetDeadline(time.Now().Add(60 * time.Second))
		got, err := io.ReadAll(env.client)
		if err != nil {
			t.Fatalf("round %d client read: %v", round, err)
		}
		if len(got) != size || !bytes.Equal(got, payload) {
			t.Fatalf("round %d: echo got %d of %d bytes or corrupted (handoffs=%d)", round, len(got), size, relay.handoffs.Load())
		}
		env.waitDone(t, 10*time.Second)
	}
}

// 交回用户态以后半关闭照常：最后一段数据先到，EOF 后到，另一个方向还能用。
func TestSockmapHandoffHalfCloseKeepsTail(t *testing.T) {
	relay := requireSockmapRelay(t)
	withHardCap(t, 128<<10)
	env := newSockmapTestPair(t, relay, 2*time.Second, nil)
	const size = 32 << 20
	payload := patternPayload(size, 21)
	go func() {
		_, _ = env.client.Write(payload)
		_, _ = env.client.Write([]byte("tail"))
		closeWrite(env.client)
	}()
	time.Sleep(50 * time.Millisecond)
	_ = env.server.SetDeadline(time.Now().Add(30 * time.Second))
	got, err := io.ReadAll(env.server)
	if err != nil {
		t.Fatalf("server read: %v", err)
	}
	want := append(append([]byte{}, payload...), "tail"...)
	if !bytes.Equal(got, want) {
		t.Fatalf("got %d of %d bytes or corrupted", len(got), len(want))
	}
	if _, err := env.server.Write([]byte("after-fin")); err != nil {
		t.Fatal(err)
	}
	_ = env.client.SetDeadline(time.Now().Add(5 * time.Second))
	reply := make([]byte, len("after-fin"))
	if _, err := io.ReadFull(env.client, reply); err != nil || string(reply) != "after-fin" {
		t.Fatalf("reply after half close = %q err=%v", reply, err)
	}
}
