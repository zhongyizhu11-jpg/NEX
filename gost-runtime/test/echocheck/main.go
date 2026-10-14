// echocheck：splice-check.sh 用的字节级校验工具。一个进程里同时当「目标」和「客户端」：
// 目标端收什么回什么（可选先吃掉一行 PROXY v1 头），客户端往被测端口灌 size 字节随机数据、
// 同时把回声读回来，最后比三个 SHA-256（发出去的、目标收到的、客户端读回来的）。
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"fmt"
	"hash"
	"io"
	"math/rand"
	"net"
	"os"
	"strings"
	"sync"
	"time"
)

func main() {
	listen := flag.String("listen", "127.0.0.1:0", "目标端监听地址")
	dial := flag.String("dial", "", "客户端要连的被测端口")
	size := flag.Int64("size", 64<<20, "往每个方向灌多少字节")
	proxy := flag.Bool("proxy", false, "目标端先读一行 PROXY v1 头")
	timeout := flag.Duration("timeout", 2*time.Minute, "整体超时")
	flag.Parse()
	if *dial == "" {
		fmt.Fprintln(os.Stderr, "usage: echocheck -dial host:port [-listen host:port] [-size n] [-proxy]")
		os.Exit(2)
	}

	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		fail("listen: %v", err)
	}
	defer ln.Close()
	fmt.Printf("target listening on %s\n", ln.Addr())

	deadline := time.Now().Add(*timeout)
	serverSum := make(chan string, 1)
	serverErr := make(chan error, 1)
	go func() {
		sum, err := serve(ln, *proxy, deadline)
		serverSum <- sum
		serverErr <- err
	}()

	conn, err := net.Dial("tcp", *dial)
	if err != nil {
		fail("dial %s: %v", *dial, err)
	}
	conn.SetDeadline(deadline)
	tc := conn.(*net.TCPConn)

	var sentSum string
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		h := sha256.New()
		r := rand.New(rand.NewSource(time.Now().UnixNano()))
		buf := make([]byte, 256<<10)
		var left int64 = *size
		for left > 0 {
			n := int64(len(buf))
			if left < n {
				n = left
			}
			r.Read(buf[:n])
			h.Write(buf[:n])
			if _, err := tc.Write(buf[:n]); err != nil {
				fail("client write: %v", err)
			}
			left -= n
		}
		tc.CloseWrite()
		sentSum = hex.EncodeToString(h.Sum(nil))
	}()

	recvHash := sha256.New()
	received, err := io.Copy(recvHash, tc)
	if err != nil {
		fail("client read: %v", err)
	}
	wg.Wait()
	recvSum := hex.EncodeToString(recvHash.Sum(nil))
	if err := <-serverErr; err != nil {
		fail("target: %v", err)
	}
	srvSum := <-serverSum

	fmt.Printf("size=%d received=%d\nsent    sha256=%s\ntarget  sha256=%s\nechoed  sha256=%s\n", *size, received, sentSum, srvSum, recvSum)
	if received != *size || sentSum != srvSum || sentSum != recvSum {
		fmt.Println("RESULT: FAIL")
		os.Exit(1)
	}
	fmt.Println("RESULT: PASS")
}

// serve 接一条连接：按需先读 PROXY v1 头（逐字节读到 CRLF，不多吃一个字节），然后回声，
// 返回收到的正文的 SHA-256。
func serve(ln net.Listener, proxy bool, deadline time.Time) (string, error) {
	c, err := ln.Accept()
	if err != nil {
		return "", err
	}
	defer c.Close()
	c.SetDeadline(deadline)
	tc := c.(*net.TCPConn)

	if proxy {
		var line strings.Builder
		var b [1]byte
		for !strings.HasSuffix(line.String(), "\r\n") {
			if _, err := io.ReadFull(tc, b[:]); err != nil {
				return "", fmt.Errorf("read PROXY header: %v", err)
			}
			line.WriteByte(b[0])
			if line.Len() > 108 {
				return "", fmt.Errorf("PROXY header too long: %q", line.String())
			}
		}
		hdr := strings.TrimSuffix(line.String(), "\r\n")
		fmt.Printf("target got PROXY header: %q\n", hdr)
		if !strings.HasPrefix(hdr, "PROXY TCP4 ") && !strings.HasPrefix(hdr, "PROXY TCP6 ") {
			return "", fmt.Errorf("bad PROXY header: %q", hdr)
		}
	}

	var h hash.Hash = sha256.New()
	buf := make([]byte, 256<<10)
	for {
		n, err := tc.Read(buf)
		if n > 0 {
			h.Write(buf[:n])
			if _, werr := tc.Write(buf[:n]); werr != nil {
				return "", fmt.Errorf("echo write: %v", werr)
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", fmt.Errorf("echo read: %v", err)
		}
	}
	tc.CloseWrite()
	return hex.EncodeToString(h.Sum(nil)), nil
}

func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "echocheck: "+format+"\n", args...)
	fmt.Println("RESULT: FAIL")
	os.Exit(1)
}
