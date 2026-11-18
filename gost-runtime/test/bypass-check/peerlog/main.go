// peerlog：bypass-check/run.sh 用的小工具。
//
//	peerlog serve -listen 127.0.0.1:端口 -log 文件
//	    同一个端口上同时起 TCP、UDP 回声，每收到一条 TCP 连接 / 一个 UDP 包，就往文件里追加一行
//	    「tcp 对端IP」或「udp 对端IP」。run.sh 靠对端 IP 分辨这条连接是谁拨过来的（入口、中转还是出口）。
//	peerlog probe -proto tcp|udp -dial 地址 [-timeout 5s]
//	    连上去发一行、等回声。回声对上退出码 0，否则 1（连不上、被断开、超时）。
package main

import (
	"bytes"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"sync"
	"time"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: peerlog serve|probe ...")
		os.Exit(2)
	}
	switch os.Args[1] {
	case "serve":
		serve(os.Args[2:])
	case "probe":
		probe(os.Args[2:])
	default:
		fmt.Fprintln(os.Stderr, "usage: peerlog serve|probe ...")
		os.Exit(2)
	}
}

func serve(args []string) {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	listen := fs.String("listen", "127.0.0.1:0", "监听地址（TCP 和 UDP 同一个端口）")
	logPath := fs.String("log", "", "对端记录文件")
	fs.Parse(args)

	f, err := os.OpenFile(*logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		fmt.Fprintln(os.Stderr, "open log:", err)
		os.Exit(1)
	}
	var mu sync.Mutex
	record := func(network string, addr net.Addr) {
		host, _, _ := net.SplitHostPort(addr.String())
		mu.Lock()
		fmt.Fprintf(f, "%s %s\n", network, host)
		mu.Unlock()
	}

	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		fmt.Fprintln(os.Stderr, "listen tcp:", err)
		os.Exit(1)
	}
	pc, err := net.ListenPacket("udp", *listen)
	if err != nil {
		fmt.Fprintln(os.Stderr, "listen udp:", err)
		os.Exit(1)
	}
	fmt.Printf("peerlog listening on %s\n", ln.Addr())

	go func() {
		buf := make([]byte, 64*1024)
		for {
			n, addr, err := pc.ReadFrom(buf)
			if err != nil {
				return
			}
			record("udp", addr)
			pc.WriteTo(buf[:n], addr)
		}
	}()
	for {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		record("tcp", conn.RemoteAddr())
		go func() {
			defer conn.Close()
			io.Copy(conn, conn)
		}()
	}
}

func probe(args []string) {
	fs := flag.NewFlagSet("probe", flag.ExitOnError)
	proto := fs.String("proto", "tcp", "tcp 或 udp")
	dial := fs.String("dial", "", "要连的地址")
	timeout := fs.Duration("timeout", 5*time.Second, "整体超时")
	fs.Parse(args)

	conn, err := net.DialTimeout(*proto, *dial, *timeout)
	if err != nil {
		fmt.Println("probe: dial:", err)
		os.Exit(1)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(*timeout))
	msg := []byte(fmt.Sprintf("nex-bypass-check %d\n", time.Now().UnixNano()))
	if _, err := conn.Write(msg); err != nil {
		fmt.Println("probe: write:", err)
		os.Exit(1)
	}
	got := make([]byte, len(msg))
	if *proto == "udp" {
		n, err := conn.Read(got)
		if err != nil || !bytes.Equal(got[:n], msg) {
			fmt.Println("probe: no echo:", err)
			os.Exit(1)
		}
	} else if _, err := io.ReadFull(conn, got); err != nil || !bytes.Equal(got, msg) {
		fmt.Println("probe: no echo:", err)
		os.Exit(1)
	}
	fmt.Println("probe: ok")
}
