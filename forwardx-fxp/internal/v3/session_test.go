package v3

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"os"
	"sync"
	"testing"
	"time"
)

func sessionPair(t *testing.T, opts SessionOptions) (*Session, *Session) {
	t.Helper()
	a, b := net.Pipe()
	opts.Client = true
	client := NewSession(a, opts)
	opts.Client = false
	server := NewSession(b, opts)
	t.Cleanup(func() { client.Close(); server.Close(); client.Wait(); server.Wait() })
	return client, server
}

func waitSessionState(t *testing.T, ok func() bool) {
	t.Helper()
	end := time.Now().Add(3 * time.Second)
	for !ok() {
		if time.Now().After(end) {
			t.Fatal("session state did not converge")
		}
		time.Sleep(time.Millisecond)
	}
}

func TestSessionConcurrentStreamsAndResourceRelease(t *testing.T) {
	client, server := sessionPair(t, SessionOptions{})
	const count = 64
	var workers sync.WaitGroup
	for i := 0; i < count; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			st, err := server.Accept()
			if err != nil {
				t.Error(err)
				return
			}
			defer st.Close()
			st.SetDeadline(time.Now().Add(5 * time.Second))
			if _, err = io.Copy(st, st); err != nil && !errors.Is(err, net.ErrClosed) && !errors.Is(err, io.ErrClosedPipe) {
				t.Error(err)
			}
		}()
	}
	for i := 0; i < count; i++ {
		workers.Add(1)
		go func(i int) {
			defer workers.Done()
			st, err := client.Open()
			if err != nil {
				t.Error(err)
				return
			}
			defer st.Close()
			st.SetDeadline(time.Now().Add(5 * time.Second))
			payload := bytes.Repeat([]byte{byte(i), 0, 255}, 17000)
			if _, err = st.Write(payload); err != nil {
				t.Error(err)
				return
			}
			got := make([]byte, len(payload))
			if _, err = io.ReadFull(st, got); err != nil || !bytes.Equal(got, payload) {
				t.Errorf("stream %d corrupted: %v", i, err)
			}
		}(i)
	}
	workers.Wait()
	waitSessionState(t, func() bool {
		return client.ActiveStreams() == 0 && server.ActiveStreams() == 0 && client.BufferedBytes() == 0 && server.BufferedBytes() == 0
	})
}

func TestSessionRepeatedOpenCloseDoesNotRetainSlots(t *testing.T) {
	client, server := sessionPair(t, SessionOptions{MaxStreams: 1})
	for i := 0; i < 1000; i++ {
		a, err := client.Open()
		if err != nil {
			t.Fatal(i, err)
		}
		b, err := server.Accept()
		if err != nil {
			t.Fatal(err)
		}
		a.Close()
		b.Close()
	}
	if client.ActiveStreams() != 0 || server.ActiveStreams() != 0 {
		t.Fatal("stream slots retained")
	}
}

func TestSessionSlowConsumerBackpressureIsIsolated(t *testing.T) {
	client, server := sessionPair(t, SessionOptions{StreamBuffer: 32 * 1024})
	a, err := client.Open()
	if err != nil {
		t.Fatal(err)
	}
	b, err := server.Accept()
	if err != nil {
		t.Fatal(err)
	}
	stalledWrite := make(chan error, 1)
	go func() { _, err := a.Write(bytes.Repeat([]byte{1}, 128*1024)); stalledWrite <- err }()
	waitSessionState(t, func() bool { return server.BufferedBytes() == 32*1024 })
	select {
	case err := <-stalledWrite:
		t.Fatalf("slow consumer did not backpressure: %v", err)
	default:
	}
	sibling, err := client.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer sibling.Close()
	other, err := server.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	if _, err = sibling.Write([]byte("sibling")); err != nil {
		t.Fatal(err)
	}
	got := make([]byte, 7)
	other.SetReadDeadline(time.Now().Add(time.Second))
	if _, err = io.ReadFull(other, got); err != nil || string(got) != "sibling" {
		t.Fatalf("sibling interrupted: %q %v", got, err)
	}
	b.Close()
	select {
	case err := <-stalledWrite:
		if err == nil {
			t.Fatal("closed slow stream completed Write")
		}
	case <-time.After(time.Second):
		t.Fatal("slow writer was not released")
	}
	a.Close()
	if server.BufferedBytes() != 0 {
		t.Fatal("closed slow stream retained buffers")
	}
}

func TestSessionRemoteClosePreservesTailAndClearsOnEOF(t *testing.T) {
	client, server := sessionPair(t, SessionOptions{})
	a, err := client.Open()
	if err != nil {
		t.Fatal(err)
	}
	b, err := server.Accept()
	if err != nil {
		t.Fatal(err)
	}
	a.Write([]byte("tail"))
	a.Close()
	b.SetReadDeadline(time.Now().Add(time.Second))
	got, err := io.ReadAll(b)
	if err != nil || string(got) != "tail" {
		t.Fatalf("lost tail: %q %v", got, err)
	}
	if server.ActiveStreams() != 0 || server.BufferedBytes() != 0 {
		t.Fatal("EOF retained resources")
	}
}

func TestSessionDeadlineChangesWakeBlockedReads(t *testing.T) {
	client, server := sessionPair(t, SessionOptions{})
	a, err := client.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	b, err := server.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	result := make(chan error, 1)
	go func() { _, err := b.Read(make([]byte, 1)); result <- err }()
	b.SetReadDeadline(time.Now().Add(20 * time.Millisecond))
	select {
	case err := <-result:
		if !errors.Is(err, os.ErrDeadlineExceeded) {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("deadline did not wake Read")
	}
	b.SetReadDeadline(time.Time{})
	a.Write([]byte{7})
	p := make([]byte, 1)
	if _, err = b.Read(p); err != nil || p[0] != 7 {
		t.Fatal("read deadline was not reset", err)
	}
}

func TestSessionLimitDrainAndIdle(t *testing.T) {
	client, server := sessionPair(t, SessionOptions{MaxStreams: 1, IdleTimeout: 40 * time.Millisecond})
	a, err := client.Open()
	if err != nil {
		t.Fatal(err)
	}
	b, err := server.Accept()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = client.Open(); !errors.Is(err, ErrStreamLimit) {
		t.Fatal(err)
	}
	client.Drain()
	if _, err = client.Open(); !errors.Is(err, ErrDraining) {
		t.Fatal(err)
	}
	// Draining must not terminate active streams or discard their data.
	a.Write([]byte{9})
	p := make([]byte, 1)
	if _, err = b.Read(p); err != nil || p[0] != 9 {
		t.Fatal(err)
	}
	a.Close()
	b.Close()
	select {
	case <-client.Done():
	case <-time.After(time.Second):
		t.Fatal("drained session retained")
	}
	idle, _ := sessionPair(t, SessionOptions{IdleTimeout: 20 * time.Millisecond})
	select {
	case <-idle.Done():
	case <-time.After(time.Second):
		t.Fatal("idle session retained")
	}
}

func TestSessionCloseReleasesUnreadBuffers(t *testing.T) {
	client, server := sessionPair(t, SessionOptions{})
	a, err := client.Open()
	if err != nil {
		t.Fatal(err)
	}
	b, err := server.Accept()
	if err != nil {
		t.Fatal(err)
	}
	a.Write(bytes.Repeat([]byte{3}, 32*1024))
	waitSessionState(t, func() bool { return server.BufferedBytes() == 32*1024 })
	server.Close()
	if server.BufferedBytes() != 0 || server.ActiveStreams() != 0 {
		t.Fatal("closed session retained buffers/slots")
	}
	if _, err = b.Read(make([]byte, 1)); err == nil {
		t.Fatal("closed stream readable")
	}
}

func TestSessionStalledPeerHasBoundedWriterLifetime(t *testing.T) {
	a, b := net.Pipe()
	defer b.Close()
	s := NewSession(a, SessionOptions{Client: true, WriteTimeout: 30 * time.Millisecond})
	defer s.Close()
	// Open 不等 OPEN 帧写出去；写不出去由写超时拆掉会话，流上的写随之报错。
	st, err := s.Open()
	if err == nil {
		if _, err = st.Write([]byte("x")); err == nil {
			t.Fatal("unread peer unexpectedly accepted a write")
		}
	}
	select {
	case <-s.Done():
	case <-time.After(time.Second):
		t.Fatal("writer retained forever")
	}
	s.Wait()
	if s.ActiveStreams() != 0 || len(s.writes) > 32 {
		t.Fatal("unbounded stalled writer")
	}
}

func TestSessionRejectsUnverifiedType5(t *testing.T) {
	a, b := net.Pipe()
	defer b.Close()
	s := NewSession(a, SessionOptions{})
	defer s.Close()
	if err := WriteFrame(b, Frame{Type: FrameType5, StreamID: 1}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-s.Done():
	case <-time.After(time.Second):
		t.Fatal("unverified control accepted")
	}
	s.Wait()
}

func TestSessionCreditWindowTransfersBeyondBufferWithoutDropping(t *testing.T) {
	client, server := sessionPair(t, SessionOptions{StreamBuffer: 8 * 1024})
	a, err := client.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	b, err := server.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	a.SetDeadline(time.Now().Add(3 * time.Second))
	b.SetDeadline(time.Now().Add(3 * time.Second))
	payload := bytes.Repeat([]byte("flow-controlled"), 100000)
	result := make(chan error, 1)
	go func() { _, err := a.Write(payload); result <- err }()
	got := make([]byte, len(payload))
	if _, err = io.ReadFull(b, got); err != nil {
		t.Fatal(err)
	}
	if err = <-result; err != nil || !bytes.Equal(got, payload) {
		t.Fatal("flow control corrupted transfer", err)
	}
	if server.BufferedBytes() != 0 {
		t.Fatal("drained receive window retained data")
	}
}

func TestSessionWriteDeadlineUnblocksCreditWaitOnlyForThisStream(t *testing.T) {
	client, server := sessionPair(t, SessionOptions{StreamBuffer: 8 * 1024})
	a, err := client.Open()
	if err != nil {
		t.Fatal(err)
	}
	b, err := server.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	a.SetWriteDeadline(time.Now().Add(25 * time.Millisecond))
	n, err := a.Write(make([]byte, 32*1024))
	if !errors.Is(err, os.ErrDeadlineExceeded) || n != 8*1024 {
		t.Fatalf("credit wait did not honor deadline: n=%d err=%v", n, err)
	}
	if client.Err() != nil || server.Err() != nil {
		t.Fatal("stream timeout closed physical session")
	}
	a.Close()
	waitSessionState(t, func() bool { return client.ActiveStreams() == 0 })
	c, err := client.Open()
	if err != nil {
		t.Fatal(err)
	}
	c.Close()
}

func TestSessionForgedCreditOverrunResetsOnlyOffendingStream(t *testing.T) {
	client, server := sessionPair(t, SessionOptions{StreamBuffer: 8 * 1024})
	a, err := client.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	b, err := server.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	// 初始窗口是隐含的：开流就有额度。
	client.mu.Lock()
	credit := a.sendCredit
	client.mu.Unlock()
	if credit != 8*1024 {
		t.Fatalf("implicit initial window=%d", credit)
	}
	// 绕过 Stream.Write 的额度检查，模拟一个有密钥但行为不对的对端：一帧比窗口大。
	forged := make([]byte, HeaderSize+8*1024+2)
	forged[0] = FrameData
	binary.BigEndian.PutUint32(forged[1:5], a.id)
	binary.BigEndian.PutUint16(forged[5:7], 8*1024+2)
	client.controls <- forged
	waitSessionState(t, func() bool { server.mu.Lock(); defer server.mu.Unlock(); return errors.Is(b.err, ErrWindowExceeded) })
	if server.BufferedBytes() != 0 || server.Err() != nil {
		t.Fatal("window overrun retained data or killed siblings")
	}
	c, err := client.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	d, err := server.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	c.Write([]byte{9})
	p := make([]byte, 1)
	d.SetReadDeadline(time.Now().Add(time.Second))
	if _, err = d.Read(p); err != nil || p[0] != 9 {
		t.Fatal("window overrun interrupted sibling", err)
	}
}

func TestSessionAliveReflectsLastSuccessfulWrite(t *testing.T) {
	client, _ := sessionPair(t, SessionOptions{})
	// A fresh session counts as alive.
	if !client.Alive(time.Second) {
		t.Fatal("fresh session reported stale")
	}
	// Age the recorded write and confirm the session is now considered stale
	// even though it still advertises free slots. This is the half-open case:
	// nothing has failed yet, but the peer has not proven itself recently.
	client.mu.Lock()
	client.lastWrite = time.Now().Add(-time.Hour)
	client.mu.Unlock()
	if client.Alive(time.Second) {
		t.Fatal("aged session still reported alive")
	}
	if client.OpenSlots() == 0 {
		t.Fatal("test needs a session that still advertises slots")
	}
	// A failed session is never alive regardless of age.
	client.fail(errors.New("boom"))
	if client.Alive(time.Hour) {
		t.Fatal("failed session reported alive")
	}
}

// TestSessionWriteRefreshesLiveness checks that a completed physical write
// updates the timestamp the pool uses for health.
func TestSessionWriteRefreshesLiveness(t *testing.T) {
	client, server := sessionPair(t, SessionOptions{MaxStreams: 2})
	// Drain the server side so the client's frames complete.
	go func() {
		for {
			if _, err := server.Accept(); err != nil {
				return
			}
		}
	}()
	st, err := client.Open()
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer st.Close()
	before := client.LastWrite()
	time.Sleep(5 * time.Millisecond)
	client.control(FrameClose, 999)
	waitSessionState(t, func() bool { return client.LastWrite().After(before) })
}

// TestSessionControlBurstDoesNotKillSession is the regression test for the old
// behaviour where a full control queue failed the whole physical session.
func TestSessionControlBurstDoesNotKillSession(t *testing.T) {
	client, server := sessionPair(t, SessionOptions{MaxStreams: 4})
	// Queue far more control frames than the control channel can hold. The old
	// implementation failed the session on the first overflow.
	const burst = 512
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < burst; i++ {
			client.control(FrameClose, uint32(i+1))
		}
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("control producers were not drained")
	}
	if client.Err() != nil {
		t.Fatalf("control burst killed the session: %v", client.Err())
	}
	if server.Err() != nil {
		t.Fatalf("peer session failed: %v", server.Err())
	}
}

// TestSessionTryControlReportsFullQueue checks the non-blocking variant.
func TestSessionTryControlReportsFullQueue(t *testing.T) {
	a, b := net.Pipe()
	defer b.Close()
	s := NewSession(a, SessionOptions{})
	defer s.Close()
	queued, rejected := 0, 0
	for i := 0; i < 4096; i++ {
		if s.tryControl(FrameClose, uint32(i+1)) {
			queued++
		} else {
			rejected++
		}
	}
	if queued == 0 {
		t.Fatal("tryControl never queued anything")
	}
	if rejected == 0 {
		t.Skip("control queue drained fast enough that it never filled")
	}
	if s.Err() != nil {
		t.Fatalf("tryControl overflow failed the session: %v", s.Err())
	}
}

func TestSessionTinyWritesDoNotAccumulateBufferFragments(t *testing.T) {
	client, server := sessionPair(t, SessionOptions{})
	a, err := client.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	b, err := server.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	a.SetWriteDeadline(time.Now().Add(3 * time.Second))
	for i := 0; i < 1000; i++ {
		if _, err = a.Write([]byte{byte(i)}); err != nil {
			t.Fatal(err)
		}
	}
	waitSessionState(t, func() bool { return server.BufferedBytes() == 1000 })
	server.mu.Lock()
	chunks := len(b.chunks)
	server.mu.Unlock()
	if chunks != 1 {
		t.Fatalf("tiny writes retained %d buffer fragments", chunks)
	}
	a.Close()
	got, err := io.ReadAll(b)
	if err != nil || len(got) != 1000 {
		t.Fatal("tiny writes lost data", err)
	}
}

// 新流不用等对端的额度：开流之后马上就能写满初始窗口，对端一个额度帧都还没发。
func TestSessionImplicitInitialWindow(t *testing.T) {
	client, server := sessionPair(t, SessionOptions{StreamBuffer: 16 * 1024})
	a, err := client.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	a.SetWriteDeadline(time.Now().Add(time.Second))
	// 服务端还没 Accept、也就没人读：写满初始窗口不能卡住。
	if n, err := a.Write(make([]byte, 16*1024)); err != nil || n != 16*1024 {
		t.Fatalf("initial window not usable before any credit: n=%d err=%v", n, err)
	}
	b, err := server.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	waitSessionState(t, func() bool { return server.BufferedBytes() == 16*1024 })
}

// 读得快的流（卡住发送的是窗口）窗口会放大；流结束后放大的部分还给会话和进程。
func TestSessionWindowGrowsForFastConsumerAndIsReleased(t *testing.T) {
	client, server := sessionPair(t, SessionOptions{StreamBuffer: 16 * 1024, MaxStreamWindow: 1 << 20})
	a, err := client.Open()
	if err != nil {
		t.Fatal(err)
	}
	b, err := server.Accept()
	if err != nil {
		t.Fatal(err)
	}
	a.SetDeadline(time.Now().Add(5 * time.Second))
	b.SetDeadline(time.Now().Add(5 * time.Second))
	payload := bytes.Repeat([]byte("grow"), 1<<20)
	done := make(chan error, 1)
	go func() { _, err := a.Write(payload); done <- err }()
	got := make([]byte, len(payload))
	if _, err := io.ReadFull(b, got); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil || !bytes.Equal(got, payload) {
		t.Fatal("transfer corrupted", err)
	}
	server.mu.Lock()
	window := b.window
	server.mu.Unlock()
	if window <= 16*1024 || server.WindowGrowth() != window-16*1024 {
		t.Fatalf("window did not grow for a fast consumer: window=%d growth=%d", window, server.WindowGrowth())
	}
	if window > 1<<20 {
		t.Fatalf("window exceeded MaxStreamWindow: %d", window)
	}
	a.Close()
	b.Close()
	waitSessionState(t, func() bool { return server.WindowGrowth() == 0 && server.ActiveStreams() == 0 })
	if GlobalWindowGrowth() != 0 {
		t.Fatalf("process window budget not returned: %d", GlobalWindowGrowth())
	}
}

// 根本不读的流：发送端额度用完、报了 BLOCKED，但接收端缓冲是满的 —— 不放大，内存只占初始窗口。
func TestSessionWindowDoesNotGrowForStalledConsumer(t *testing.T) {
	client, server := sessionPair(t, SessionOptions{StreamBuffer: 16 * 1024})
	a, err := client.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	b, err := server.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	go func() { _, _ = a.Write(make([]byte, 1<<20)) }()
	waitSessionState(t, func() bool { server.mu.Lock(); defer server.mu.Unlock(); return b.blockedSeen })
	time.Sleep(50 * time.Millisecond)
	if server.BufferedBytes() != 16*1024 || server.WindowGrowth() != 0 {
		t.Fatalf("stalled consumer grew: buffered=%d growth=%d", server.BufferedBytes(), server.WindowGrowth())
	}
	// 慢慢读：每次读四分之一窗口（正好触发还额度），对端马上补满，缓冲回到满的，也不放大。
	for i := 0; i < 8; i++ {
		if _, err := io.ReadFull(b, make([]byte, 4*1024)); err != nil {
			t.Fatal(err)
		}
		waitSessionState(t, func() bool { return server.BufferedBytes() == 16*1024 })
	}
	if server.WindowGrowth() != 0 {
		t.Fatalf("slow consumer grew its window: %d", server.WindowGrowth())
	}
}

// 会话的放大预算用完了，再快的流也不再放大。
func TestSessionWindowGrowthRespectsSessionBudget(t *testing.T) {
	client, server := sessionPair(t, SessionOptions{StreamBuffer: 16 * 1024, MaxStreamWindow: 4 << 20, SessionBuffer: 64 * 1024})
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		a, err := client.Open()
		if err != nil {
			t.Fatal(err)
		}
		b, err := server.Accept()
		if err != nil {
			t.Fatal(err)
		}
		wg.Add(2)
		go func() {
			defer wg.Done()
			defer a.Close()
			a.SetDeadline(time.Now().Add(5 * time.Second))
			_, _ = a.Write(make([]byte, 2<<20))
		}()
		go func() {
			defer wg.Done()
			defer b.Close()
			b.SetDeadline(time.Now().Add(5 * time.Second))
			_, _ = io.ReadFull(b, make([]byte, 2<<20))
		}()
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if g := server.WindowGrowth(); g > 64*1024 {
			t.Fatalf("session growth %d exceeds budget", g)
		}
		time.Sleep(time.Millisecond)
		if server.ActiveStreams() == 0 {
			break
		}
	}
	wg.Wait()
}
