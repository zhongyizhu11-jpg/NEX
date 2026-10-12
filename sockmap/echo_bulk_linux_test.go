//go:build linux

package sockmap

import (
	"bytes"
	"io"
	"net"
	"testing"
	"time"
)

// 双向同时大流量：服务端原样回显，客户端边写边读。
func TestSockmapBulkEchoBothDirections(t *testing.T) {
	relay := requireSockmapRelay(t)
	env := newSockmapTestPair(t, relay, time.Second, nil)
	const size = 200 << 20
	payload := patternPayload(size, 5)
	echoed := make(chan int64, 1)
	go func() {
		n, _ := io.Copy(env.server, env.server)
		closeWrite(env.server)
		echoed <- n
	}()
	go func() {
		_, _ = env.client.Write(payload)
		closeWrite(env.client)
	}()
	_ = env.client.SetDeadline(time.Now().Add(60 * time.Second))
	got, err := io.ReadAll(env.client)
	if err != nil {
		t.Fatalf("client read: %v", err)
	}
	t.Logf("server echoed %d bytes", <-echoed)
	if len(got) != size || !bytes.Equal(got, payload) {
		first := -1
		for i := 0; i < len(got) && i < size; i++ {
			if got[i] != payload[i] {
				first = i
				break
			}
		}
		t.Fatalf("echo mismatch: got %d bytes, first diff at %d, throttles=%d", len(got), first, relay.throttles.Load())
	}
	_ = net.Conn(nil)
}
