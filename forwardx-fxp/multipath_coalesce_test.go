package main

import (
	"bytes"
	"errors"
	"net"
	"sync"
	"testing"
	"time"
)

// gatedConn holds every write until the gate opens, standing in for a leg whose
// kernel send buffer is full: the writer is parked in Write, and the chunks
// queued behind it have nobody to take them.
type gatedConn struct {
	net.Conn
	mu     sync.Mutex
	open   chan struct{}
	closed chan struct{}
	once   sync.Once
}

func newGatedConn(conn net.Conn) *gatedConn {
	return &gatedConn{Conn: conn, open: make(chan struct{}), closed: make(chan struct{})}
}

func (c *gatedConn) release() { c.once.Do(func() { close(c.open) }) }

func (c *gatedConn) Write(p []byte) (int, error) {
	select {
	case <-c.open:
	case <-c.closed:
		return 0, net.ErrClosed
	}
	return c.Conn.Write(p)
}

func (c *gatedConn) Close() error {
	c.mu.Lock()
	select {
	case <-c.closed:
	default:
		close(c.closed)
	}
	c.mu.Unlock()
	return c.Conn.Close()
}

func (s *multipathSession) queuedChunks() (chunks int, bytesQueued int, seq uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, out := range s.out {
		chunks++
		bytesQueued += len(out.data)
	}
	return chunks, bytesQueued, s.sendSeq
}

func TestMultipathWriterCoalescesSmallWritesWhileLegsAreBusy(t *testing.T) {
	var gates []*gatedConn
	client, server := newWrappedMultipathPair(t, 1, 256, func(_ int, conn net.Conn) net.Conn {
		gate := newGatedConn(conn)
		gates = append(gates, gate)
		return gate
	})
	received := make(chan []byte, 1)
	go func() {
		data, _ := drainStream(server)
		received <- data
	}()

	// 唯一那条腿的写入者先去送会话开头的回执，被闸门卡在 Write 里，谁也领不走
	// 分片。此时的小写都应并进队尾同一片，直到它满 64 KiB。
	const small = 1024
	var expected bytes.Buffer
	write := func(b byte) {
		chunk := bytes.Repeat([]byte{b}, small)
		expected.Write(chunk)
		if err := client.writeFrame(chunk); err != nil {
			t.Fatalf("writeFrame: %v", err)
		}
	}
	perChunk := multipathCoalesceTarget / small
	for i := 0; i < perChunk; i++ {
		write(byte(i))
	}
	chunks, queued, seq := client.queuedChunks()
	if chunks != 1 || seq != 1 {
		t.Fatalf("expected the %d small writes to share one queued chunk, got %d chunks (seq %d)", perChunk, chunks, seq)
	}
	if queued != small*perChunk {
		t.Fatalf("queued %d bytes, want %d", queued, small*perChunk)
	}
	// 这片满了，再写就开下一片。
	write(byte(perChunk))
	if chunks, _, seq := client.queuedChunks(); chunks != 2 || seq != 2 {
		t.Fatalf("a full chunk must not absorb more: got %d chunks (seq %d)", chunks, seq)
	}

	for _, gate := range gates {
		gate.release()
	}
	if err := client.writeFrame(nil); err != nil {
		t.Fatalf("fin: %v", err)
	}
	select {
	case got := <-received:
		if !bytes.Equal(got, expected.Bytes()) {
			t.Fatalf("stream corrupted by coalescing: got %d bytes, want %d", len(got), expected.Len())
		}
	case <-time.After(10 * time.Second):
		t.Fatal("stream did not complete")
	}
}

func TestMultipathWriterDoesNotCoalesceWhenALegIsIdle(t *testing.T) {
	// 腿空着的时候分片立刻被领走：小流量不该为了凑大片而多等。
	pair := newMultipathTestPair(t, 2, 64)
	go func() { _, _ = drainStream(pair.server) }()
	for i := 0; i < 8; i++ {
		if err := pair.client.writeFrame([]byte{byte(i)}); err != nil {
			t.Fatalf("writeFrame: %v", err)
		}
		// 每一片都要被某条腿领走，而不是攒在队尾。
		deadline := time.Now().Add(2 * time.Second)
		for {
			pair.client.mu.Lock()
			claimed := pair.client.nextFresh == pair.client.sendSeq
			pair.client.mu.Unlock()
			if claimed {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("chunk %d stayed queued although a leg was idle", i)
			}
			time.Sleep(time.Millisecond)
		}
	}
	if _, _, seq := pair.client.queuedChunks(); seq != 8 {
		t.Fatalf("every small write should have been its own chunk, got seq %d", seq)
	}
	if err := pair.client.writeFrame(nil); err != nil {
		t.Fatalf("fin: %v", err)
	}
}

func TestMultipathCoalescingStillSurfacesASilentFarSide(t *testing.T) {
	// 合并只是让小写少占序号；对端一声不吭时，队尾那片填满、窗口写完之后，
	// 发送端照样要带着原因放弃，而不是把数据无限攒在队列里。
	session, _ := rawAckPeer(t)
	session.sendStallTimeout.Store(int64(200 * time.Millisecond))
	var err error
	done := make(chan struct{})
	go func() {
		defer close(done)
		chunk := bytes.Repeat([]byte("y"), 1024)
		for i := 0; i < 4*multipathInitialWindow*(multipathCoalesceTarget/1024); i++ {
			if err = session.writeFrame(chunk); err != nil {
				return
			}
		}
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("对端一声不吭，发送端却一直挂着")
	}
	if !errors.Is(err, errMultipathSendStalled) {
		t.Fatalf("expected the sender to give up, got %v", err)
	}
}
