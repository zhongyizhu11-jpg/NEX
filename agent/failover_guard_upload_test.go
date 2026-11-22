package main

import (
	"bytes"
	"crypto/sha256"
	"io"
	"net"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

/*
保护期（上游回第一个字节之前）里读客户端的缓冲现在在读协程和主循环之间循环使用：上游一直不回话的大上传
整段都走这条路，缓冲复用一旦出错就是数据错位。这里让上游只收不回，灌 3 MiB 随机数据，核对上游收到的
每一个字节；顺带确认保护期到点（8 秒）之前上传就已经全部到达 —— 复用不能把数据耽搁在手里。
*/
func TestFailoverGuardUploadIntegrityWithSilentUpstream(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	type received struct {
		sum [32]byte
		n   int64
	}
	got := make(chan received, 4)
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				h := sha256.New()
				n, _ := io.Copy(h, conn) // 只收不回，读到 EOF 为止
				if n == 0 {
					return // 健康探测的空连接
				}
				var sum [32]byte
				copy(sum[:], h.Sum(nil))
				got <- received{sum: sum, n: n}
			}()
		}
	}()
	targetPort := ln.Addr().(*net.TCPAddr).Port
	oldDir := persistentFailoverDir
	persistentFailoverDir = filepath.Join(t.TempDir(), "failover")
	t.Cleanup(func() { persistentFailoverDir = oldDir })
	listenPort := failoverTestPort(t)
	spec := failoverTestSpec(listenPort)
	// 代理至少要两条路径才会起；两条都指向同一个只收不回的上游。
	spec.Targets = []failoverTarget{{TargetIP: "127.0.0.1", TargetPort: targetPort}, {TargetIP: "127.0.0.1", TargetPort: targetPort}}
	const ruleID, sourcePort = 971777, 60777
	t.Cleanup(func() { stopFailoverProxy(ruleID, sourcePort) })
	if !startFailoverProxy(ruleID, sourcePort, spec, nil) {
		t.Fatal("proxy did not start")
	}
	addr := net.JoinHostPort("127.0.0.1", strconv.Itoa(listenPort))

	payload := make([]byte, 3<<20)
	seed := uint32(2463534242)
	for i := range payload {
		seed ^= seed << 13
		seed ^= seed >> 17
		seed ^= seed << 5
		payload[i] = byte(seed)
	}
	want := sha256.Sum256(payload)

	// 代理的监听是起来以后异步开的：等它可连。
	var client net.Conn
	for deadline := time.Now().Add(5 * time.Second); ; {
		client, err = net.DialTimeout("tcp", addr, time.Second)
		if err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal(err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	defer client.Close()
	_ = client.SetDeadline(time.Now().Add(10 * time.Second))
	started := time.Now()
	// 按不规则的块写，让读协程读到的块大小各不相同。
	for off := 0; off < len(payload); {
		size := 1000 + (off/1000)%50000
		if off+size > len(payload) {
			size = len(payload) - off
		}
		if _, err := client.Write(payload[off : off+size]); err != nil {
			t.Fatal(err)
		}
		off += size
	}
	if err := client.(*net.TCPConn).CloseWrite(); err != nil {
		t.Fatal(err)
	}
	select {
	case r := <-got:
		if r.n != int64(len(payload)) || !bytes.Equal(r.sum[:], want[:]) {
			t.Fatalf("upstream received %d bytes (want %d), digest match=%v", r.n, len(payload), bytes.Equal(r.sum[:], want[:]))
		}
	case <-time.After(10 * time.Second):
		t.Fatal("upstream did not receive the whole upload")
	}
	if elapsed := time.Since(started); elapsed > failoverEarlyGuardWindow {
		t.Fatalf("upload took %v, longer than the guard window itself", elapsed)
	}
}
