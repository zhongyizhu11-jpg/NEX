package main

import (
	"bytes"
	"errors"
	"io"
	"net"
	"runtime"
	"sync"
	"testing"
	"time"
)

// 流水线只在 GOMAXPROCS > 1 时启用；测试里至少给两个核，免得 -cpu 1 时测成串行路径。
func withPipelineCores(t *testing.T) {
	t.Helper()
	if runtime.GOMAXPROCS(0) < 2 {
		old := runtime.GOMAXPROCS(2)
		t.Cleanup(func() { runtime.GOMAXPROCS(old) })
	}
}

type failingFrameConn struct {
	recordingFrameConn
	failAfter int
	writes    int
}

var errTestTunnelWrite = errors.New("tunnel write failed")

func (c *failingFrameConn) writeFrames(frames ...[]byte) error {
	c.mu.Lock()
	c.writes++
	fail := c.writes > c.failAfter
	c.mu.Unlock()
	if fail {
		return errTestTunnelWrite
	}
	return c.recordingFrameConn.writeFrames(frames...)
}

// 写隧道失败时，读协程可能正卡在明文侧的 Read 里（客户端发完一大块就不说话了）：要马上带着
// 写出错误返回，不能等客户端下一次发数据。
func TestSealPipelineWriteFailureWakesBlockedReader(t *testing.T) {
	withPipelineCores(t)
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	dst := &failingFrameConn{failAfter: 0}
	result := make(chan error, 1)
	go func() {
		result <- copyPlainToSecureWithPolicy(dst, server, newLimiter(0), nil, protocolPolicy{}, nil, nil)
	}()
	_ = client.SetWriteDeadline(time.Now().Add(2 * time.Second))
	if _, err := client.Write(bytes.Repeat([]byte{7}, 100<<10)); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if !errors.Is(err, errTestTunnelWrite) {
			t.Fatalf("copy returned %v, want the tunnel write error", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("copy did not return after the tunnel write failed")
	}
}

// 大块交给写出协程、小块就地写，先后交错：隧道里的字节顺序必须和读到的一样，最后是结束帧。
func TestSealPipelineKeepsOrderAcrossSmallAndLargeChunks(t *testing.T) {
	withPipelineCores(t)
	client, server := net.Pipe()
	dst := &recordingFrameConn{}
	result := make(chan error, 1)
	go func() {
		result <- copyPlainToSecureWithPolicy(dst, server, newLimiter(0), nil, protocolPolicy{}, nil, nil)
	}()
	var want bytes.Buffer
	for i := 0; i < 60; i++ {
		size := 100
		if i%3 != 0 {
			size = 70<<10 + i
		}
		chunk := bytes.Repeat([]byte{byte(i)}, size)
		want.Write(chunk)
		_ = client.SetWriteDeadline(time.Now().Add(5 * time.Second))
		if _, err := client.Write(chunk); err != nil {
			t.Fatal(err)
		}
	}
	_ = client.Close()
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("copy: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("copy did not finish")
	}
	dst.mu.Lock()
	defer dst.mu.Unlock()
	if n := len(dst.frames); n == 0 || len(dst.frames[n-1]) != 0 {
		t.Fatal("stream did not end with the end-of-stream frame")
	}
	got := bytes.Join(dst.frames, nil)
	if !bytes.Equal(got, want.Bytes()) {
		t.Fatalf("tunnel carried %d bytes out of order / corrupted, want %d", len(got), want.Len())
	}
}

// scriptedFrameSource 按顺序交出预先给的帧（每次 readFrames 一帧），给完了就一直等到
// closeTransport。
type scriptedFrameSource struct {
	mu        sync.Mutex
	frames    [][]byte
	closed    chan struct{}
	closeOnce sync.Once
}

func newScriptedFrameSource(frames ...[]byte) *scriptedFrameSource {
	return &scriptedFrameSource{frames: frames, closed: make(chan struct{})}
}

func (s *scriptedFrameSource) writeFrame([]byte) error     { return nil }
func (s *scriptedFrameSource) writeFrames(...[]byte) error { return nil }
func (s *scriptedFrameSource) readFrame() ([]byte, error)  { return nil, io.EOF }
func (s *scriptedFrameSource) closeTransport()             { s.closeOnce.Do(func() { close(s.closed) }) }
func (s *scriptedFrameSource) wasClosed() bool {
	select {
	case <-s.closed:
		return true
	default:
		return false
	}
}
func (s *scriptedFrameSource) readFrames(dst [][]byte, _ int) ([][]byte, error) {
	s.mu.Lock()
	if len(s.frames) > 0 {
		frame := s.frames[0]
		s.frames = s.frames[1:]
		s.mu.Unlock()
		return append(dst, frame), nil
	}
	s.mu.Unlock()
	<-s.closed
	return dst, net.ErrClosed
}

// 往明文侧写失败：写出协程关掉隧道这一头，卡在 readFrames 里的读协程马上返回写出错误。
func TestPlainPipelineWriteFailureClosesTunnel(t *testing.T) {
	withPipelineCores(t)
	plain, peer := net.Pipe()
	_ = peer.Close()
	src := newScriptedFrameSource(bytes.Repeat([]byte{1}, 64<<10))
	result := make(chan error, 1)
	go func() { result <- copySecureToPlain(plain, src, newLimiter(0), nil) }()
	select {
	case err := <-result:
		if !errors.Is(err, io.ErrClosedPipe) {
			t.Fatalf("copy returned %v, want the plain-side write error", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("copy did not return after the plain-side write failed")
	}
	if !src.wasClosed() {
		t.Fatal("tunnel was not closed after the plain-side write failed")
	}
}

// 隧道里大小帧交错、最后是结束帧：明文侧收到的字节顺序不变，读到结束帧时手里的活都写完了。
func TestPlainPipelineKeepsOrderAndFlushesBeforeEnd(t *testing.T) {
	withPipelineCores(t)
	plain, peer := net.Pipe()
	var frames [][]byte
	var want bytes.Buffer
	for i := 0; i < 40; i++ {
		size := 50
		if i%2 == 0 {
			size = 64<<10 - i
		}
		frame := bytes.Repeat([]byte{byte(i + 1)}, size)
		frames = append(frames, frame)
		want.Write(frame)
	}
	frames = append(frames, []byte{})
	src := newScriptedFrameSource(frames...)
	received := make(chan []byte, 1)
	go func() {
		data, _ := io.ReadAll(peer)
		received <- data
	}()
	result := make(chan error, 1)
	go func() { result <- copySecureToPlain(plain, src, newLimiter(0), nil) }()
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("copy: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("copy did not finish")
	}
	_ = plain.Close()
	got := <-received
	if !bytes.Equal(got, want.Bytes()) {
		t.Fatalf("plain side got %d bytes out of order / corrupted, want %d", len(got), want.Len())
	}
}
