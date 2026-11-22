package main

import (
	"errors"
	"io"
	"net"
	"testing"
	"time"
)

// 中转读的那一侧没说再见就断了：relayCopy 要把它标成 peerGone，让 relayBidir 立刻收掉两头。
func TestRelayCopyReadSideClosedIsPeerGone(t *testing.T) {
	src := newScriptedFrameSource([]byte("payload"))
	dst := &recordingFrameConn{}
	done := make(chan error, 1)
	go func() { done <- relayCopy(src, dst) }()
	time.Sleep(20 * time.Millisecond)
	src.closeTransport() // 之后 readFrames 返回 net.ErrClosed
	select {
	case err := <-done:
		if !isPeerGone(err) || !isClosedErr(err) {
			t.Fatalf("relayCopy returned %v, want a peer-gone closed error", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("relayCopy did not return")
	}
	dst.mu.Lock()
	defer dst.mu.Unlock()
	if len(dst.frames) != 1 || string(dst.frames[0]) != "payload" {
		t.Fatalf("frames before the reset were not relayed: %q", dst.frames)
	}
}

// 隧道那头复位（没有结束帧、也不是 EOF）：copySecureToPlain 同样标成 peerGone。
func TestSecureReadResetIsPeerGone(t *testing.T) {
	plain, peer := net.Pipe()
	defer plain.Close()
	defer peer.Close()
	go func() { _, _ = io.Copy(io.Discard, peer) }()
	src := newScriptedFrameSource([]byte("a"))
	done := make(chan error, 1)
	go func() { done <- copySecureToPlain(plain, src, newLimiter(0), nil) }()
	time.Sleep(20 * time.Millisecond)
	src.closeTransport()
	select {
	case err := <-done:
		if !isPeerGone(err) {
			t.Fatalf("copySecureToPlain returned %v, want peer-gone", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("copySecureToPlain did not return")
	}
}

// peerGone 作为第一个结果：不等 linger，立刻 closeAll。
func TestWaitBidirectionalPeerGoneClosesImmediately(t *testing.T) {
	errCh := make(chan error, 2)
	closed := make(chan struct{}, 1)
	done := make(chan error, 1)
	go func() {
		done <- waitBidirectionalWithLinger(errCh, func() { closed <- struct{}{} }, 2*time.Second)
	}()
	errCh <- peerGone(net.ErrClosed)
	select {
	case <-closed:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("closeAll was not called immediately for a peer-gone error")
	}
	if err := <-done; err != nil {
		t.Fatalf("unexpected error %v", err)
	}
}

// 隧道那头写侧的 closed 错误照旧走 linger（另一个方向可能还在交最后几帧），不受 peerGone 影响。
func TestWaitBidirectionalPlainClosedStillLingers(t *testing.T) {
	errCh := make(chan error, 2)
	closed := make(chan struct{}, 1)
	done := make(chan error, 1)
	go func() {
		done <- waitBidirectionalWithLinger(errCh, func() { closed <- struct{}{} }, 200*time.Millisecond)
	}()
	errCh <- net.ErrClosed
	select {
	case <-closed:
		t.Fatal("a plain closed error must linger for the other direction")
	case <-time.After(50 * time.Millisecond):
	}
	errCh <- nil
	if err := <-done; err != nil {
		t.Fatalf("unexpected error %v", err)
	}
}

// 干净的半关闭以后另一个方向最多再等 fxpHalfCloseMaxWait：到点收掉两头。
func TestWaitBidirectionalHalfCloseHasAnUpperBound(t *testing.T) {
	old := fxpHalfCloseMaxWait
	fxpHalfCloseMaxWait = 40 * time.Millisecond
	t.Cleanup(func() { fxpHalfCloseMaxWait = old })
	errCh := make(chan error, 2)
	closed := make(chan struct{}, 1)
	done := make(chan error, 1)
	go func() {
		done <- waitBidirectionalWithLinger(errCh, func() { closed <- struct{}{} }, time.Second)
	}()
	errCh <- nil
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("half-closed session was not reaped after the upper bound")
	}
	if err := <-done; err != nil {
		t.Fatalf("unexpected error %v", err)
	}
}

func TestHalfCloseMaxWaitFromEnv(t *testing.T) {
	cases := map[string]time.Duration{"": time.Hour, " 30m ": 30 * time.Minute, "garbage": time.Hour, "-5s": time.Hour, "0": 0, "2h": 2 * time.Hour}
	for raw, want := range cases {
		if got := halfCloseMaxWaitFromEnv(raw); got != want {
			t.Fatalf("%q → %v, want %v", raw, got, want)
		}
	}
	if !errors.Is(peerGone(io.EOF), io.EOF) {
		t.Fatal("peerGone must unwrap to the original error")
	}
}
