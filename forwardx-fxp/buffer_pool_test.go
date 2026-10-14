package main

import "testing"

func TestFXPByteBufferPoolUsesSmallestTier(t *testing.T) {
	buffer := getFXPByteBuffer(33 * 1024)
	if len(buffer) != 33*1024 || cap(buffer) != 64*1024 {
		t.Fatalf("unexpected pooled buffer len=%d cap=%d", len(buffer), cap(buffer))
	}
	putFXPByteBuffer(buffer)
	// 一个满帧连头带标签落在 65 KiB 那档，两帧的读缓冲落在两帧那档。
	frame := getFXPByteBuffer(fxpCopyChunkSize + fxpFrameOverhead)
	if cap(frame) != 65*1024 {
		t.Fatalf("one frame: cap=%d want %d", cap(frame), 65*1024)
	}
	putFXPByteBuffer(frame)
	pair := getFXPByteBuffer(fxpFrameReadBufferSize)
	if cap(pair) != fxpFrameReadBufferSize {
		t.Fatalf("two frames: cap=%d want %d", cap(pair), fxpFrameReadBufferSize)
	}
	putFXPByteBuffer(pair)
}

// 借和还都不该分配：池是有界 channel，放进去的是切片头的拷贝，不是指针。
func TestFXPByteBufferPoolGetPutDoNotAllocate(t *testing.T) {
	for _, size := range []int{1024, fxpCopyChunkSize, fxpFrameReadBufferSize} {
		buffer := getFXPByteBuffer(size)
		putFXPByteBuffer(buffer)
		allocs := testing.AllocsPerRun(200, func() {
			b := getFXPByteBuffer(size)
			putFXPByteBuffer(b)
		})
		if allocs != 0 {
			t.Fatalf("size %d: %v allocs per get+put, want 0", size, allocs)
		}
	}
}

func TestFXPByteBufferPoolDoesNotRetainOversizedFrames(t *testing.T) {
	const size = fxpFrameReadBufferSize + 1
	buffer := getFXPByteBuffer(size)
	if len(buffer) != size || cap(buffer) != size {
		t.Fatalf("unexpected oversized buffer len=%d cap=%d", len(buffer), cap(buffer))
	}
	putFXPByteBuffer(buffer)
}

func TestFXPByteBufferPoolHasBoundedRetainedSlots(t *testing.T) {
	pool := newFXPBytePool(1024)
	for i := 0; i < fxpBytePoolSlots*2; i++ {
		select {
		case pool.pool <- make([]byte, pool.size):
		default:
		}
	}
	if got := len(pool.pool); got != fxpBytePoolSlots {
		t.Fatalf("retained buffers = %d, want bounded capacity %d", got, fxpBytePoolSlots)
	}
}
