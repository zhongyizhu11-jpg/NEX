//go:build linux

package main

import (
	"errors"
	"net"
	"net/netip"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"
)

/*
UDP 中继的批量收发（Linux 的 recvmmsg / sendmmsg）。

线路组调度器和协议守护的 UDP 中继以前每个数据报都是「一次 recvfrom + 一次 write」再「一次
read + 一次 sendto」，高包率时内核态切换占了大头。这里一次系统调用最多收 64 个数据报，收到
几个就转几个：同一会话连着的几个包一次 sendmmsg 写到上游；回包方向每个会话一次最多也收
64 个，再一次 sendmmsg 原路写回。没有定时器、不攒包：套接字里只有一个包就只收这一个马上
转出去，单包的延迟和逐包路径一样。

来源地址直接从 sockaddr 解析成 netip.AddrPort，目的地址直接填进 sockaddr，每个包都不再分配
*net.UDPAddr。没有用 golang.org/x/net 的 ReadBatch / WriteBatch，就是因为它们每条消息都要分配
net.Addr。

缓冲：一批 64 个数据报、每个要容得下最大的 UDP 载荷（65535 字节），一批就是 4 MiB。不能每个
会话常驻一份（4096 个会话就是 16 GiB），所以做成全局的空闲链表：读协程只在「套接字可读」的
那一刻借一批，转发完就还。借的那块用 mmap 匿名映射而不是 Go 堆：只有真写到的页才占内存
（典型 1500 字节的包每格只碰一页，一批常驻 256 KiB 而不是 4 MiB），也不会被 GC 的零填充和
回收搅出一轮轮 4 MiB 的分配。链表有上限，借不到时退到一次只收一个包（65535 字节的小缓冲从
agentBytePools 拿），不等、不阻塞。空闲会话什么缓冲都不占（以前每个会话常驻 64 KiB）。
*/

const (
	udpBatchSize   = 64
	udpBatchStride = 65536
	// 同时借出的大批次上限。只有正在收发的协程才占着（借 → 转发 → 还，中间不等别人），实际
	// 并发量和 CPU 数一个量级；到上限时退化成单包读，不丢包。64 批最多 256 MiB 虚拟地址，
	// 常驻按真写到的页算。
	udpBatchPoolLimit = 64
)

// 测试里关掉它对比逐包路径（也就是非 Linux 的路径）。
var udpBatchEnabled = true

// udpMmsghdr 就是内核的 struct mmsghdr：一个 msghdr 加上这条消息实际的字节数，Go 会把它
// 补齐到 msghdr 的对齐（64 位 64 字节、32 位 32 字节），和 C 的布局一致（有测试盯着）。
type udpMmsghdr struct {
	hdr unix.Msghdr
	len uint32
}

// udpBatchConn 是一个 UDP 套接字的批量收发句柄。收发都走 syscall.RawConn，等可读 / 可写、
// 读超时、Close 唤醒都由 Go 的网络轮询器照常处理，和普通的 Read / Write 行为一样。
type udpBatchConn struct {
	raw syscall.RawConn
	// 套接字是 AF_INET6（含双栈）：发给 IPv4 地址要写成 ::ffff:a.b.c.d。
	v6 bool
}

// newUDPBatchConn 给 *net.UDPConn 做批量句柄；不是 UDPConn（测试替身）或者关了批量就返回
// nil，调用方走逐包路径。
func newUDPBatchConn(conn any) *udpBatchConn {
	if !udpBatchEnabled {
		return nil
	}
	udpConn, ok := conn.(*net.UDPConn)
	if !ok || udpConn == nil {
		return nil
	}
	raw, err := udpConn.SyscallConn()
	if err != nil {
		return nil
	}
	family := -1
	if err := raw.Control(func(fd uintptr) {
		family, _ = unix.GetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_DOMAIN)
	}); err != nil {
		return nil
	}
	switch family {
	case unix.AF_INET, unix.AF_INET6:
		return &udpBatchConn{raw: raw, v6: family == unix.AF_INET6}
	}
	return nil
}

// udpBatch 是一批数据报的收发缓冲：hdrs / iovs / names 是交给内核的数组，slab 按 udpBatchStride
// 一格一个数据报，addrs 是 recv 解析好的来源地址。
type udpBatch struct {
	hdrs  []udpMmsghdr
	iovs  []unix.Iovec
	names []unix.RawSockaddrInet6
	addrs []netip.AddrPort
	slab  []byte
	// dst 是 sendTo 填的目的地址，整批消息都指着它。
	dst unix.RawSockaddrInet6
	// mapped 为 true 时 slab 是 mmap 出来的大批次，归还到空闲链表；否则是单包批次，slab 来自
	// agentBytePools。
	mapped bool
}

func newUDPBatch(count int, slab []byte, mapped bool) *udpBatch {
	b := &udpBatch{
		hdrs:   make([]udpMmsghdr, count),
		iovs:   make([]unix.Iovec, count),
		names:  make([]unix.RawSockaddrInet6, count),
		addrs:  make([]netip.AddrPort, count),
		slab:   slab,
		mapped: mapped,
	}
	for i := range b.hdrs {
		b.iovs[i].Base = &slab[i*udpBatchStride]
		b.hdrs[i].hdr.Iov = &b.iovs[i]
		b.hdrs[i].hdr.SetIovlen(1)
	}
	return b
}

// packet 返回第 i 个数据报的内容（recv 之后有效，到 put 之前）。
func (b *udpBatch) packet(i int) []byte {
	start := i * udpBatchStride
	return b.slab[start : start+int(b.hdrs[i].len)]
}

// addr 返回第 i 个数据报的来源地址。
func (b *udpBatch) addr(i int) netip.AddrPort {
	return b.addrs[i]
}

var (
	udpBatchMu   sync.Mutex
	udpBatchFree []*udpBatch
	// 已经建出来的大批次数（含借出的）。
	udpBatchCount  int
	udpBatchSingle = sync.Pool{New: func() any {
		return newUDPBatch(1, getAgentByteBuffer(udpBatchStride), false)
	}}
)

// getUDPBatch 借一批：优先空闲链表里的大批次，链表空且没到上限就新建一个，否则给一个单包批次。
func getUDPBatch() *udpBatch {
	udpBatchMu.Lock()
	if n := len(udpBatchFree); n > 0 {
		b := udpBatchFree[n-1]
		udpBatchFree = udpBatchFree[:n-1]
		udpBatchMu.Unlock()
		return b
	}
	if udpBatchCount < udpBatchPoolLimit {
		udpBatchCount++
		udpBatchMu.Unlock()
		slab, err := unix.Mmap(-1, 0, udpBatchSize*udpBatchStride, unix.PROT_READ|unix.PROT_WRITE, unix.MAP_ANON|unix.MAP_PRIVATE)
		if err == nil {
			return newUDPBatch(udpBatchSize, slab, true)
		}
		udpBatchMu.Lock()
		udpBatchCount--
	}
	udpBatchMu.Unlock()
	return udpBatchSingle.Get().(*udpBatch)
}

func putUDPBatch(b *udpBatch) {
	if b == nil {
		return
	}
	if !b.mapped {
		udpBatchSingle.Put(b)
		return
	}
	udpBatchMu.Lock()
	udpBatchFree = append(udpBatchFree, b)
	udpBatchMu.Unlock()
}

// prepareRecv 把内核会改写的字段复位：msg_namelen、msg_flags、iov_len（上一次发送可能把它改成了
// 包长）、msg_name（上一次发送可能指到别处）。
func (b *udpBatch) prepareRecv() {
	for i := range b.hdrs {
		h := &b.hdrs[i]
		h.hdr.Name = (*byte)(unsafe.Pointer(&b.names[i]))
		h.hdr.Namelen = unix.SizeofSockaddrInet6
		h.hdr.Flags = 0
		h.len = 0
		b.iovs[i].SetLen(udpBatchStride - 1)
	}
}

/*
recv 收一批。返回借来的批次和收到的个数（≥ 1），用完要 putUDPBatch。err 和普通 Read 一样：
超时是 net.Error 且 Timeout() 为真，套接字关了是 net.ErrClosed，内核报的错（ICMP 不可达之类）
原样返回。等可读期间不占批次。
*/
func (c *udpBatchConn) recv() (*udpBatch, int, error) {
	var b *udpBatch
	var n int
	var errno unix.Errno
	err := c.raw.Read(func(fd uintptr) bool {
		b = getUDPBatch()
		b.prepareRecv()
		for {
			r, _, e := unix.Syscall6(unix.SYS_RECVMMSG, fd, uintptr(unsafe.Pointer(&b.hdrs[0])), uintptr(len(b.hdrs)), 0, 0, 0)
			if e == unix.EINTR {
				continue
			}
			if e == unix.EAGAIN {
				putUDPBatch(b)
				b = nil
				return false
			}
			n, errno = int(r), e
			return true
		}
	})
	if err == nil && errno != 0 {
		err = errno
	}
	if err == nil && n <= 0 {
		err = errUDPBatchEmpty
	}
	if err != nil {
		putUDPBatch(b)
		return nil, 0, err
	}
	kept := 0
	for i := 0; i < n; i++ {
		h := &b.hdrs[i]
		// 比最大载荷还长的包（理论上不存在）被截断了，丢掉；空数据报和逐包路径一样不转。
		if h.hdr.Flags&unix.MSG_TRUNC != 0 || h.len == 0 {
			continue
		}
		addr, ok := udpSockaddrToAddrPort(&b.names[i], h.hdr.Namelen)
		if !ok {
			continue
		}
		if kept != i {
			b.hdrs[kept].len = h.len
			copy(b.slab[kept*udpBatchStride:], b.slab[i*udpBatchStride:i*udpBatchStride+int(h.len)])
		}
		b.addrs[kept] = addr
		kept++
	}
	if kept == 0 {
		putUDPBatch(b)
		return nil, 0, errUDPBatchEmpty
	}
	udpBatchRecvCalls.Add(1)
	udpBatchRecvPackets.Add(int64(kept))
	return b, kept, nil
}

// errUDPBatchEmpty：recvmmsg 回来一个能用的包都没有。当临时错误处理，调用方退避后重读。
var errUDPBatchEmpty = errors.New("udp batch: no datagram")

// 每批记一次（不是每包）：recv 调了几次、一共收了几个包，测试里核对批量路径确实在用、
// 高包率时一次确实收到了不止一个。
var (
	udpBatchRecvCalls   atomic.Int64
	udpBatchRecvPackets atomic.Int64
)

// sendTo 把批次里前 count 个包发给同一个目的地址（回包方向）。
func (c *udpBatchConn) sendTo(b *udpBatch, count int, dst netip.AddrPort) error {
	nameLen, ok := udpAddrPortToSockaddr(&b.dst, c.v6, dst)
	if !ok {
		return errUDPBatchAddress
	}
	for i := 0; i < count; i++ {
		h := &b.hdrs[i]
		h.hdr.Name = (*byte)(unsafe.Pointer(&b.dst))
		h.hdr.Namelen = nameLen
		b.iovs[i].SetLen(int(h.len))
	}
	return c.sendmmsg(b.hdrs[:count])
}

var errUDPBatchAddress = errors.New("udp batch: address family mismatch")

// send 把批次里 [from, to) 的包写到已连接的套接字上（上游方向）。
func (c *udpBatchConn) send(b *udpBatch, from int, to int) error {
	for i := from; i < to; i++ {
		h := &b.hdrs[i]
		h.hdr.Name = nil
		h.hdr.Namelen = 0
		b.iovs[i].SetLen(int(h.len))
	}
	return c.sendmmsg(b.hdrs[from:to])
}

// sendmmsg 把这些消息全部发出去：内核可能只发一部分（返回发了几个），剩下的接着发；套接字
// 发送缓冲满（EAGAIN）就交给轮询器等可写。
func (c *udpBatchConn) sendmmsg(hs []udpMmsghdr) error {
	for len(hs) > 0 {
		var n int
		var errno unix.Errno
		err := c.raw.Write(func(fd uintptr) bool {
			for {
				r, _, e := unix.Syscall6(unix.SYS_SENDMMSG, fd, uintptr(unsafe.Pointer(&hs[0])), uintptr(len(hs)), 0, 0, 0)
				if e == unix.EINTR {
					continue
				}
				if e == unix.EAGAIN {
					return false
				}
				n, errno = int(r), e
				return true
			}
		})
		if err != nil {
			return err
		}
		if errno != 0 {
			return errno
		}
		if n <= 0 {
			return errUDPBatchStalled
		}
		hs = hs[n:]
	}
	return nil
}

var errUDPBatchStalled = errors.New("udp batch: sendmmsg sent nothing")

// ---- sockaddr 和 netip.AddrPort 互转（不分配） ----

func udpSockaddrToAddrPort(name *unix.RawSockaddrInet6, length uint32) (netip.AddrPort, bool) {
	switch name.Family {
	case unix.AF_INET:
		if length < unix.SizeofSockaddrInet4 {
			return netip.AddrPort{}, false
		}
		sa := (*unix.RawSockaddrInet4)(unsafe.Pointer(name))
		return netip.AddrPortFrom(netip.AddrFrom4(sa.Addr), udpSockaddrPort(sa.Port)), true
	case unix.AF_INET6:
		if length < unix.SizeofSockaddrInet6 {
			return netip.AddrPort{}, false
		}
		addr := netip.AddrFrom16(name.Addr)
		if name.Scope_id != 0 {
			addr = addr.WithZone(udpZoneName(name.Scope_id))
		}
		return netip.AddrPortFrom(addr, udpSockaddrPort(name.Port)), true
	}
	return netip.AddrPort{}, false
}

// sockaddr 里的端口是网络字节序，原样存在 uint16 里。
func udpSockaddrPort(raw uint16) uint16 {
	p := (*[2]byte)(unsafe.Pointer(&raw))
	return uint16(p[0])<<8 | uint16(p[1])
}

func udpAddrPortToSockaddr(name *unix.RawSockaddrInet6, v6 bool, ap netip.AddrPort) (uint32, bool) {
	addr := ap.Addr()
	if v6 {
		// 和 net 包一样：双栈套接字发给 IPv4 地址用 ::ffff:a.b.c.d。
		*name = unix.RawSockaddrInet6{Family: unix.AF_INET6, Addr: addr.As16()}
		if zone := addr.Zone(); zone != "" {
			name.Scope_id = udpZoneIndex(zone)
		}
		p := (*[2]byte)(unsafe.Pointer(&name.Port))
		p[0], p[1] = byte(ap.Port()>>8), byte(ap.Port())
		return unix.SizeofSockaddrInet6, true
	}
	addr = addr.Unmap()
	if !addr.Is4() {
		return 0, false
	}
	sa := (*unix.RawSockaddrInet4)(unsafe.Pointer(name))
	*sa = unix.RawSockaddrInet4{Family: unix.AF_INET, Addr: addr.As4()}
	p := (*[2]byte)(unsafe.Pointer(&sa.Port))
	p[0], p[1] = byte(ap.Port()>>8), byte(ap.Port())
	return unix.SizeofSockaddrInet4, true
}

// ---- IPv6 链路本地地址的 zone：接口编号和名字互查（只有带 scope 的地址才走到这里） ----

var udpZoneCache struct {
	mu      sync.Mutex
	at      time.Time
	byIndex map[uint32]string
	byName  map[string]uint32
}

const udpZoneCacheTTL = time.Minute

func udpZoneRefreshLocked(now time.Time) {
	if !udpZoneCache.at.IsZero() && now.Sub(udpZoneCache.at) < udpZoneCacheTTL {
		return
	}
	udpZoneCache.at = now
	byIndex := map[uint32]string{}
	byName := map[string]uint32{}
	if ifaces, err := net.Interfaces(); err == nil {
		for _, iface := range ifaces {
			byIndex[uint32(iface.Index)] = iface.Name
			byName[iface.Name] = uint32(iface.Index)
		}
	}
	udpZoneCache.byIndex = byIndex
	udpZoneCache.byName = byName
}

// udpZoneName 和 net 包一样把 scope id 换成接口名；查不到就用数字（Go 也是这样）。
func udpZoneName(index uint32) string {
	udpZoneCache.mu.Lock()
	defer udpZoneCache.mu.Unlock()
	udpZoneRefreshLocked(time.Now())
	if name, ok := udpZoneCache.byIndex[index]; ok {
		return name
	}
	return strconv.FormatUint(uint64(index), 10)
}

func udpZoneIndex(zone string) uint32 {
	if index, err := strconv.ParseUint(zone, 10, 32); err == nil {
		return uint32(index)
	}
	udpZoneCache.mu.Lock()
	defer udpZoneCache.mu.Unlock()
	udpZoneRefreshLocked(time.Now())
	if index, ok := udpZoneCache.byName[zone]; ok {
		return index
	}
	// 可能是刚起来的接口：刷一次再查。
	udpZoneCache.at = time.Time{}
	udpZoneRefreshLocked(time.Now())
	return udpZoneCache.byName[zone]
}
