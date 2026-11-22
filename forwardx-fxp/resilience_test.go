package main

import (
	"errors"
	"net"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// flakyListener 前几次 Accept 返回一个临时错误，模拟文件描述符耗尽。
type flakyListener struct {
	net.Listener
	failures atomic.Int32
}

func (l *flakyListener) Accept() (net.Conn, error) {
	if l.failures.Add(-1) >= 0 {
		return nil, errors.New("accept: too many open files")
	}
	return l.Listener.Accept()
}

func TestAcceptWithRetrySurvivesTemporaryErrors(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	flaky := &flakyListener{Listener: ln}
	flaky.failures.Store(3)
	go func() {
		conn, err := net.Dial("tcp", ln.Addr().String())
		if err == nil {
			time.Sleep(200 * time.Millisecond)
			_ = conn.Close()
		}
	}()
	conn, err := acceptWithRetry(flaky, "test", config{})
	if err != nil {
		t.Fatalf("temporary accept errors must be retried, got %v", err)
	}
	_ = conn.Close()
}

func TestAcceptWithRetryReturnsWhenListenerClosed(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	_ = ln.Close()
	done := make(chan error, 1)
	go func() {
		_, err := acceptWithRetry(ln, "test", config{})
		done <- err
	}()
	select {
	case err := <-done:
		if !errors.Is(err, net.ErrClosed) {
			t.Fatalf("closed listener must end the accept loop, got %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("accept loop kept spinning on a closed listener")
	}
}

func TestCatchPanicTurnsPanicIntoError(t *testing.T) {
	err := catchPanic("unit", func() error {
		var m map[string]int
		m["boom"] = 1 //lint:ignore SA5000 故意写 nil map 触发 panic，验证 catchPanic 能把它变成错误
		return nil
	})
	if err == nil || !strings.Contains(err.Error(), "panic in unit") {
		t.Fatalf("panic must become an error, got %v", err)
	}
	if err := catchPanic("unit", func() error { return nil }); err != nil {
		t.Fatalf("no panic must pass through, got %v", err)
	}
}
