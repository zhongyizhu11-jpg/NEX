package main

import (
	"bytes"
	"crypto/rand"
	"errors"
	"io"
	"testing"
)

// chunkedReader 每次最多交 chunk 个字节，用来控制读缓冲每次系统调用能拿到多少。
type chunkedReader struct {
	data  []byte
	chunk int
}

func (r *chunkedReader) Read(p []byte) (int, error) {
	if len(r.data) == 0 {
		return 0, io.EOF
	}
	n := len(p)
	if n > r.chunk {
		n = r.chunk
	}
	n = copy(p[:n], r.data)
	r.data = r.data[n:]
	return n, nil
}

func sequenceBytes(n int) []byte {
	out := make([]byte, n)
	for i := range out {
		out[i] = byte(i * 7)
	}
	return out
}

func TestFXPFrameReaderPeekMatchesReadFullErrors(t *testing.T) {
	empty := newFXPFrameReader(&chunkedReader{chunk: 100})
	if _, err := empty.peek(4); !errors.Is(err, io.EOF) {
		t.Fatalf("empty source: err=%v want io.EOF", err)
	}
	short := newFXPFrameReader(&chunkedReader{data: sequenceBytes(10), chunk: 100})
	head, err := short.peek(4)
	if err != nil || !bytes.Equal(head, sequenceBytes(10)[:4]) {
		t.Fatalf("peek(4) = %v, %v", head, err)
	}
	short.discard(4)
	if got := short.peekBuffered(6); !bytes.Equal(got, sequenceBytes(10)[4:]) {
		t.Fatalf("peekBuffered = %v", got)
	}
	if got := short.peekBuffered(7); got != nil {
		t.Fatalf("peekBuffered beyond buffered = %v, want nil", got)
	}
	if _, err := short.peek(10); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("partial frame: err=%v want io.ErrUnexpectedEOF", err)
	}
	// 读出错的连接不会再读了，缓冲已经还回池里。
	if short.buf != nil || short.buffered() != 0 {
		t.Fatal("buffer should be returned to the pool after a read error")
	}
}

func TestFXPFrameReaderStartsSmallAndUpgradesForLargeFrames(t *testing.T) {
	data := sequenceBytes(fxpFrameReadBufferSize + 4096)
	reader := newFXPFrameReader(&chunkedReader{data: data, chunk: 1000})
	if _, err := reader.peek(500); err != nil {
		t.Fatal(err)
	}
	// 从空闲醒来借的是小缓冲。
	if cap(reader.buf) != fxpFrameReaderIdleSize {
		t.Fatalf("idle buffer cap=%d want %d", cap(reader.buf), fxpFrameReaderIdleSize)
	}
	reader.discard(500)
	// 小缓冲里还剩 500 字节，这一帧装不下：换成大缓冲，剩下的字节搬到开头。
	want := fxpFrameReadBufferSize - 100
	got, err := reader.peek(want)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, data[500:500+want]) {
		t.Fatal("bytes after the buffer upgrade do not match the source")
	}
	if reader.r != 0 || cap(reader.buf) != fxpFrameReadBufferSize {
		t.Fatalf("expected the unread bytes moved to the front of the big buffer, r=%d cap=%d", reader.r, cap(reader.buf))
	}
	reader.discard(want)
	rest, err := reader.peek(len(data) - 500 - want)
	if err != nil || !bytes.Equal(rest, data[500+want:]) {
		t.Fatalf("tail: %v %v", err, rest)
	}
	reader.discard(len(rest))
	reader.release()
	if reader.buf != nil {
		t.Fatal("release should return an empty buffer to the pool")
	}
	// 读到头了：再 peek 是 EOF，也不会留下缓冲。
	if _, err := reader.peek(1); !errors.Is(err, io.EOF) || reader.buf != nil {
		t.Fatalf("after EOF: err=%v buf=%v", err, reader.buf != nil)
	}
}

func TestFXPFrameReaderCompactsOnlyWhenFrameDoesNotFitAtTail(t *testing.T) {
	data := sequenceBytes(3000)
	reader := newFXPFrameReader(&chunkedReader{data: data, chunk: 1000})
	if _, err := reader.peek(50); err != nil {
		t.Fatal(err)
	}
	reader.discard(10)
	// 缓冲里还有 990 字节，要 100：不用读也不用挪。
	if got, err := reader.peek(100); err != nil || !bytes.Equal(got, data[10:110]) || reader.r != 10 {
		t.Fatalf("a frame that fits in the buffered bytes must not move: err=%v r=%d", err, reader.r)
	}
	reader.discard(reader.buffered())
	// 空了就从头开始。
	if got, err := reader.peek(50); err != nil || !bytes.Equal(got, data[1000:1050]) || reader.r != 0 {
		t.Fatalf("an empty buffer should restart at the front: err=%v r=%d", err, reader.r)
	}
	// 未读的字节贴着缓冲尾部，下一帧放不进去：挪到开头再读。
	reader.discard(reader.buffered())
	reader.r, reader.w = len(reader.buf)-10, len(reader.buf)
	copy(reader.buf[reader.r:], data[2000:2010])
	reader.src = &chunkedReader{data: data[2010:], chunk: 1000}
	got, err := reader.peek(500)
	if err != nil || !bytes.Equal(got, data[2000:2500]) || reader.r != 0 {
		t.Fatalf("a frame beyond the tail should be compacted to the front: err=%v r=%d", err, reader.r)
	}
	reader.drop()
}

func TestFXPFrameReaderRejectsRequestsLargerThanBuffer(t *testing.T) {
	reader := newFXPFrameReader(&chunkedReader{data: sequenceBytes(10), chunk: 10})
	if _, err := reader.peek(fxpFrameReadBufferSize + 1); !errors.Is(err, errFXPFrameReaderOverflow) {
		t.Fatalf("err=%v want overflow", err)
	}
	reader.drop()
}

func TestFXPFrameReaderReadFullDrainsBufferThenSource(t *testing.T) {
	data := sequenceBytes(300)
	reader := newFXPFrameReader(&chunkedReader{data: data, chunk: 100})
	if _, err := reader.peek(50); err != nil {
		t.Fatal(err)
	}
	// 缓冲里有 100 字节，要 250：先搬走缓冲里的，再从源头读 150。
	dst := make([]byte, 250)
	if err := reader.readFull(dst); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(dst, data[:250]) {
		t.Fatal("readFull bytes do not match")
	}
	if reader.buffered() != 0 {
		t.Fatalf("buffered=%d want 0", reader.buffered())
	}
	tail := make([]byte, 60)
	if err := reader.readFull(tail); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("short readFull err=%v want io.ErrUnexpectedEOF", err)
	}
	// 没借过缓冲的读器也能 readFull。
	fresh := newFXPFrameReader(&chunkedReader{data: data, chunk: 100})
	whole := make([]byte, len(data))
	if err := fresh.readFull(whole); err != nil || !bytes.Equal(whole, data) {
		t.Fatalf("fresh readFull: %v", err)
	}
	reader.release()
	if reader.buf != nil {
		t.Fatal("release should return an empty buffer to the pool")
	}
}

// securePair 是一对共用密钥、各自绑在 conn 上的连接：writer 写的帧 reader 能读。
func securePair(tb testing.TB, conn *bufferConn) (*secureConn, *secureConn) {
	tb.Helper()
	salt := make([]byte, fxpSaltSize)
	writer, err := newSessionSecureConn(conn, "batch-key", salt, true)
	if err != nil {
		tb.Fatal(err)
	}
	reader, err := newSessionSecureConn(conn, "batch-key", salt, false)
	if err != nil {
		tb.Fatal(err)
	}
	return writer, reader
}

func TestSecureConnReadFramesReturnsEveryFrameAlreadyBuffered(t *testing.T) {
	conn := &bufferConn{}
	writer, reader := securePair(t, conn)
	var frames [][]byte
	for i, size := range []int{1, 100, 4096, fxpCopyChunkSize, 7} {
		frame := make([]byte, size)
		_, _ = rand.Read(frame)
		frame[0] = byte(i)
		frames = append(frames, frame)
	}
	if err := writer.writeFrames(frames...); err != nil {
		t.Fatal(err)
	}
	// 从空闲醒来用的是 4 KiB 的小缓冲：前两帧装得下，第三帧装不下就停在这里。
	got, err := reader.readFrames(nil, fxpFrameBatchMax)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || !bytes.Equal(got[0], frames[0]) || !bytes.Equal(got[1], frames[1]) {
		t.Fatalf("first batch from the idle buffer: %d frames", len(got))
	}
	// 第三帧让读缓冲换成大的，剩下三帧一批交出。
	got, err = reader.readFrames(nil, fxpFrameBatchMax)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 {
		t.Fatalf("got %d frames after the upgrade, want 3", len(got))
	}
	for i := range got {
		if !bytes.Equal(got[i], frames[2+i]) {
			t.Fatalf("frame %d differs", 2+i)
		}
	}
	// 大缓冲在手，一次写出的五帧一批全交出。
	if err := writer.writeFrames(frames...); err != nil {
		t.Fatal(err)
	}
	got, err = reader.readFrames(nil, fxpFrameBatchMax)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != len(frames) {
		t.Fatalf("got %d frames in one batch, want %d", len(got), len(frames))
	}
	for i := range frames {
		if !bytes.Equal(got[i], frames[i]) {
			t.Fatalf("frame %d differs", i)
		}
	}
	// 上限管用：再写五帧，最多交两帧，其余留在缓冲里下一次再交。
	if err := writer.writeFrames(frames...); err != nil {
		t.Fatal(err)
	}
	got, err = reader.readFrames(nil, 2)
	if err != nil || len(got) != 2 {
		t.Fatalf("limited batch: %d frames, err=%v", len(got), err)
	}
	got, err = reader.readFrames(nil, fxpFrameBatchMax)
	if err != nil || len(got) != 3 {
		t.Fatalf("remaining batch: %d frames, err=%v", len(got), err)
	}
	if !bytes.Equal(got[2], frames[4]) {
		t.Fatal("last frame differs")
	}
	// 读空了是帧边界上的 EOF。
	if _, err := reader.readFrames(nil, fxpFrameBatchMax); !errors.Is(err, io.EOF) {
		t.Fatalf("drained: err=%v want io.EOF", err)
	}
}

func TestSecureConnReadFramesStopsAtEndOfStreamFrame(t *testing.T) {
	conn := &bufferConn{}
	writer, reader := securePair(t, conn)
	if err := writer.writeFrames([]byte("a"), []byte("b"), nil, []byte("after")); err != nil {
		t.Fatal(err)
	}
	got, err := reader.readFrames(nil, fxpFrameBatchMax)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 || string(got[0]) != "a" || string(got[1]) != "b" || len(got[2]) != 0 || got[2] == nil {
		t.Fatalf("batch = %q", got)
	}
	got, err = reader.readFrames(nil, fxpFrameBatchMax)
	if err != nil || len(got) != 1 || string(got[0]) != "after" {
		t.Fatalf("after end marker: %q %v", got, err)
	}
}

func TestSecureConnReadsFramesLargerThanTheReadBuffer(t *testing.T) {
	conn := &bufferConn{}
	writer, reader := securePair(t, conn)
	big := make([]byte, fxpFrameReadBufferSize+1000)
	_, _ = rand.Read(big)
	small := []byte("small")
	if err := writer.writeFrames(small, big, small); err != nil {
		t.Fatal(err)
	}
	got, err := reader.readFrames(nil, fxpFrameBatchMax)
	if err != nil {
		t.Fatal(err)
	}
	// 大帧装不进读缓冲：小帧先交，大帧留到下一次阻塞读。
	if len(got) != 1 || !bytes.Equal(got[0], small) {
		t.Fatalf("first batch = %d frames", len(got))
	}
	got, err = reader.readFrames(nil, fxpFrameBatchMax)
	if err != nil || len(got) != 1 || !bytes.Equal(got[0], big) {
		t.Fatalf("big frame batch: %d frames err=%v", len(got), err)
	}
	if reader.readBuf == nil {
		t.Fatal("big frame should be held in its own pooled buffer until the next read")
	}
	got, err = reader.readFrames(nil, fxpFrameBatchMax)
	if err != nil || len(got) != 1 || !bytes.Equal(got[0], small) {
		t.Fatalf("trailing batch: %d frames err=%v", len(got), err)
	}
	if reader.readBuf != nil {
		t.Fatal("big frame buffer should be released on the next read")
	}
}

func TestSecureConnTruncatedFrameIsUnexpectedEOF(t *testing.T) {
	conn := &bufferConn{}
	writer, _ := securePair(t, conn)
	if err := writer.writeFrame(bytes.Repeat([]byte("x"), 1000)); err != nil {
		t.Fatal(err)
	}
	wire := conn.buf.Bytes()
	for _, cut := range []int{len(wire) - 1, 4 + 16 + 10, 4 + 16, 3} {
		truncated := &bufferConn{}
		truncated.buf.Write(wire[:cut])
		_, reader := securePair(t, truncated)
		if _, err := reader.readFrame(); !errors.Is(err, io.ErrUnexpectedEOF) {
			t.Fatalf("cut at %d: err=%v want io.ErrUnexpectedEOF", cut, err)
		}
	}
	// 坏帧不能让读器认为帧已经消费：计数不动，再读还是同样的错。
	tampered := &bufferConn{}
	tampered.buf.Write(wire)
	tampered.buf.Bytes()[len(wire)-1] ^= 0x01
	_, reader := securePair(t, tampered)
	if _, err := reader.readFrame(); err == nil {
		t.Fatal("tampered frame should fail authentication")
	}
	if reader.readCounter != 0 {
		t.Fatalf("read counter advanced to %d on a bad frame", reader.readCounter)
	}
}

// 两帧合成一次写、一次读交两帧：量一下批量路径的单核吞吐。
func BenchmarkSecureFrameBatchAESGCM(b *testing.B) {
	conn := &bufferConn{}
	writer, reader := securePair(b, conn)
	chunk := make([]byte, fxpCopyReadSize)
	_, _ = rand.Read(chunk)
	frames := [][]byte{chunk[:fxpCopyChunkSize], chunk[fxpCopyChunkSize:]}
	var scratch [fxpFrameBatchMax][]byte
	b.SetBytes(int64(len(chunk)))
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if err := writer.writeFrames(frames...); err != nil {
			b.Fatal(err)
		}
		got, err := reader.readFrames(scratch[:0], fxpFrameBatchMax)
		if err != nil {
			b.Fatal(err)
		}
		if len(got) != 2 {
			b.Fatalf("got %d frames", len(got))
		}
	}
}
