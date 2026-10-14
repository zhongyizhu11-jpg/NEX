package main

import (
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

// 请求行前面垫空行、方法写成小写、多打几个空格，都不能绕过 BlockHTTP。
func TestDetectHTTPProtocolResistsCommonEvasions(t *testing.T) {
	for _, sample := range []string{
		"\r\nGET / HTTP/1.1\r\nHost: example.com\r\n",
		"\r\n\r\n\n\rGET / HTTP/1.1\r\n",
		"get / HTTP/1.1\r\n",
		"Post /submit HTTP/1.0\r\n",
		"GET  /  HTTP/1.1\r\n",
		"\r\nPRI * HTTP/2.0\r\n\r\nSM\r\n\r\n",
	} {
		if !detectHTTPProtocol([]byte(sample)) {
			t.Fatalf("expected HTTP detection for %q", sample)
		}
	}
	for _, sample := range []string{
		"\r\n\r\n",
		"hello / HTTP/1.1\r\n",
		"GET\t/\tHTTP/1.1\r\n",
	} {
		if detectHTTPProtocol([]byte(sample)) {
			t.Fatalf("unexpected HTTP detection for %q", sample)
		}
	}
}

type recordingFrameConn struct {
	mu     sync.Mutex
	frames [][]byte
}

func (c *recordingFrameConn) writeFrame(plain []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.frames = append(c.frames, append([]byte(nil), plain...))
	return nil
}
func (c *recordingFrameConn) writeFrames(frames ...[]byte) error {
	for _, frame := range frames {
		if err := c.writeFrame(frame); err != nil {
			return err
		}
	}
	return nil
}
func (c *recordingFrameConn) readFrame() ([]byte, error)                 { select {} }
func (c *recordingFrameConn) readFrames([][]byte, int) ([][]byte, error) { select {} }
func (c *recordingFrameConn) closeTransport()                            {}

// 先发一大段 CRLF 把采样撑满，再发请求行：以前采样满了就不再检查。
func TestBlockHTTPIsNotBypassedByLeadingBlankLines(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	dst := &recordingFrameConn{}
	result := make(chan error, 1)
	go func() {
		result <- copyPlainToSecureWithPolicy(dst, server, newLimiter(0), nil, protocolPolicy{BlockHTTP: true}, nil, []byte("\r\n\r\n"))
	}()
	_ = client.SetWriteDeadline(time.Now().Add(2 * time.Second))
	if _, err := client.Write([]byte(strings.Repeat("\r\n", fxpProtocolSampleMax))); err != nil {
		t.Fatal(err)
	}
	_, _ = client.Write([]byte("GET / HTTP/1.1\r\nHost: example.com\r\n\r\n"))
	select {
	case err := <-result:
		if err == nil || !strings.Contains(err.Error(), "protocol blocked: http") {
			t.Fatalf("expected http block, got %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("HTTP request behind leading blank lines was not blocked")
	}
}
