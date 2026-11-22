package main

import (
	"bytes"
	"io"
	"net"
	"testing"
	"time"
)

// 写出协程用完的读缓冲要留给这条连接自己下一次交接用（不经过进程池）：
// 第二次交接拿到的缓冲就是第一次交出去的那一块。
func TestSealPipelineReusesHandoffBuffers(t *testing.T) {
	withPipelineCores(t)
	dst := &recordingFrameConn{}
	p := newFXPSealPipeline(dst, nil, nil)
	first := getFXPByteBuffer(fxpCopyReadSize)
	for i := range first {
		first[i] = byte(i)
	}
	second, err := p.write(first, len(first))
	if err != nil {
		t.Fatal(err)
	}
	if len(second) != fxpCopyReadSize {
		t.Fatalf("handoff returned a %d-byte read buffer, want %d", len(second), fxpCopyReadSize)
	}
	if &second[0] == &first[0] {
		t.Fatal("handoff returned the buffer that was just handed to the writer")
	}
	deadline := time.Now().Add(2 * time.Second)
	for p.inFlight.Load() != 0 {
		if time.Now().After(deadline) {
			t.Fatal("writer did not finish the first chunk")
		}
		time.Sleep(time.Millisecond)
	}
	third, err := p.write(second, len(second))
	if err != nil {
		t.Fatal(err)
	}
	if &third[0] != &first[0] {
		t.Fatal("second handoff did not reuse the buffer the writer had finished with")
	}
	if err := p.finish(); err != nil {
		t.Fatal(err)
	}
	// 退出后 spare 里的缓冲都还回了进程池。
	if n := len(p.spare); n != 0 {
		t.Fatalf("%d spare buffers left after finish", n)
	}
	dst.mu.Lock()
	defer dst.mu.Unlock()
	var got []byte
	for _, frame := range dst.frames {
		got = append(got, frame...)
	}
	want := append(append([]byte(nil), first...), second...)
	if !bytes.Equal(got, want) {
		t.Fatalf("tunnel carried %d bytes, want %d in order", len(got), len(want))
	}
}

// 隧道里先来几帧交给了写出协程、再来一帧大到装不进交接缓冲（多路径的大帧）：就地写之前要等
// 写出协程清空（drain），顺序不能乱；drain 靠写出协程点 idle 醒，不是靠定时器。
func TestPlainPipelineDrainsBeforeOversizedFrame(t *testing.T) {
	withPipelineCores(t)
	plain, peer := net.Pipe()
	var frames [][]byte
	var want bytes.Buffer
	for i := 0; i < 6; i++ {
		frame := bytes.Repeat([]byte{byte(i + 1)}, 64<<10)
		frames = append(frames, frame)
		want.Write(frame)
	}
	big := bytes.Repeat([]byte{9}, fxpFrameReadBufferSize+4096)
	frames = append(frames, big)
	want.Write(big)
	tail := bytes.Repeat([]byte{7}, 100)
	frames = append(frames, tail, []byte{})
	want.Write(tail)
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

// 过期判断先看钟、再问队列：没过期的包不碰队列的锁。
func TestSupersededInOnlyAsksQueueWhenExpired(t *testing.T) {
	q := newFXPUDPQueue(4, 1<<20)
	queuedAt := time.Unix(1000, 0)
	packet := fxpUDPQueuedPacket{queuedAt: queuedAt}
	if packet.supersededIn(queuedAt.Add(fxpUDPMaxQueueDelay-time.Nanosecond), q) {
		t.Fatal("fresh packet must not be superseded")
	}
	if packet.supersededIn(queuedAt.Add(fxpUDPMaxQueueDelay), q) {
		t.Fatal("expired packet with nothing newer queued must not be superseded")
	}
	q.enqueue([]byte{1})
	if !packet.supersededIn(queuedAt.Add(fxpUDPMaxQueueDelay), q) {
		t.Fatal("expired packet with a newer one queued must be superseded")
	}
	if packet.supersededIn(queuedAt.Add(fxpUDPMaxQueueDelay-time.Nanosecond), q) {
		t.Fatal("fresh packet must not be superseded even with newer ones queued")
	}
}
