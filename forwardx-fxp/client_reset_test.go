package main

import (
	"io"
	"net"
	"testing"
	"time"
)

// drainUntilQuiet 把 ch 里已有的信号都排掉，直到连续 quiet 这么久没有新的。
func drainUntilQuiet(ch <-chan struct{}, quiet time.Duration) {
	for {
		select {
		case <-ch:
		case <-time.After(quiet):
			return
		}
	}
}

// resetAwareTarget：每收到一字节回两字节（多出来的那个字节客户端不读，留在它的接收缓冲里，这样客户端
// SetLinger(0) 关闭时内核发的是 RST 而不是 FIN），读到 EOF / 出错时连接结束，往 closed 里报一声。
func resetAwareTarget(t *testing.T) (*net.TCPAddr, <-chan struct{}) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	closed := make(chan struct{}, 16)
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				buf := make([]byte, 1)
				for {
					n, err := conn.Read(buf)
					if n > 0 {
						if _, werr := conn.Write([]byte{buf[0], buf[0]}); werr != nil {
							break
						}
					}
					if err != nil {
						break
					}
				}
				closed <- struct{}{}
			}()
		}
	}()
	return ln.Addr().(*net.TCPAddr), closed
}

/*
客户端复位（RST —— 手机断网、浏览器中断、SetLinger(0) 关闭都是这样）以后，入口到出口、出口到目标的连接要马上关掉。
以前入口在客户端这一侧的读错误上等 30 秒 linger（期待另一个方向把剩下的帧送完），出口没有新数据时这条会话的
四个套接字白占 30 秒：连接风暴下句柄按「每秒连接数 × 30」积累，撑满 fd 以后新连接全部拨不出去。
*/
func TestClientResetTearsDownSessionImmediately(t *testing.T) {
	resetFXPEndpointRegistry()
	target, targetClosed := resetAwareTarget(t)
	entryAddr := dpStartFXPTCP(t, target, func(c *config) { c.AEAD = "aes" })
	// 夹具探端口时那条空连接也会在目标上走一遍开 / 关，先把它的那一声排掉。
	drainUntilQuiet(targetClosed, 300*time.Millisecond)
	conn, err := net.DialTimeout("tcp", entryAddr, 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
	if _, err := conn.Write([]byte("x")); err != nil {
		t.Fatal(err)
	}
	reply := make([]byte, 1)
	if _, err := io.ReadFull(conn, reply); err != nil || reply[0] != 'x' {
		t.Fatalf("echo: %q %v", reply, err)
	}
	// 第二个回显字节故意不读：接收缓冲里有没读的数据时，linger 0 的 Close 发 RST。
	time.Sleep(50 * time.Millisecond)
	_ = conn.(*net.TCPConn).SetLinger(0)
	_ = conn.Close()
	select {
	case <-targetClosed:
	case <-time.After(3 * time.Second):
		t.Fatal("客户端复位 3 秒后，出口到目标的连接还挂着（以前要等满 30 秒 linger）")
	}
}

// 反过来：目标复位以后，入口要马上把客户端这一侧也关掉，而不是让客户端等 30 秒。
func TestTargetResetTearsDownSessionImmediately(t *testing.T) {
	resetFXPEndpointRegistry()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				one := make([]byte, 1)
				if _, err := io.ReadFull(conn, one); err == nil {
					_, _ = conn.Write(one)
				}
				_ = conn.(*net.TCPConn).SetLinger(0)
				_ = conn.Close()
			}()
		}
	}()
	entryAddr := dpStartFXPTCP(t, ln.Addr().(*net.TCPAddr), func(c *config) { c.AEAD = "aes" })
	conn, err := net.DialTimeout("tcp", entryAddr, 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := conn.Write([]byte("y")); err != nil {
		t.Fatal(err)
	}
	reply := make([]byte, 1)
	if _, err := io.ReadFull(conn, reply); err != nil || reply[0] != 'y' {
		t.Fatalf("echo: %q %v", reply, err)
	}
	started := time.Now()
	if _, err := conn.Read(reply); err == nil {
		t.Fatal("目标复位后客户端还读到了数据")
	}
	if waited := time.Since(started); waited > 3*time.Second {
		t.Fatalf("目标复位后客户端等了 %v 才被关掉", waited)
	}
}
