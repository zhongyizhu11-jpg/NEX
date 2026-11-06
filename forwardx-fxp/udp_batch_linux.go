//go:build linux

package main

import (
	"errors"
	"log"
	"net"
	"net/netip"
	"sync"
	"sync/atomic"
	"syscall"
	"unsafe"

	"golang.org/x/sys/unix"
)

/*
UDP 直连隧道（udp_direct.go）的批量收发：recvmmsg / sendmmsg，加上 UDP GSO（UDP_SEGMENT）
和 GRO（UDP_GRO），都在运行时探测、失败就退回。

以前每个包都是一次 recvfrom、一次 sendto：本机回环上 50k 包/秒时一半的 CPU 在系统调用里，
发送协程一次只搬一个包，客户端一阵突发（几十个包）就把 64 个包的会话队列挤爆丢包。

  - 收：一次 recvmmsg 最多收 fxpUDPBatchSize 个包，读循环一个一个地拿（fxpUDPBatchReader 的
    ReadFromUDPAddrPort 和 *net.UDPConn 的同名方法用法一样），拿完了才再去读套接字。没有
    定时器、不攒包：套接字里只有一个包就只收这一个，单包的延迟和逐包路径一样。
  - 发：发送协程醒来一次把队列里现成的包都取出来（fxpUDPQueue.nextBatchTracked），封好以后
    一次 sendmmsg 发出去（fxpUDPBatchSender）。
  - GSO：发往同一个地址、长度相同、在内存里首尾相接的一串线上包（隧道这一跳，封在同一块
    缓冲里，见 fxpUDPWireBatch）合成一条消息，带上 UDP_SEGMENT，内核（或网卡）按段长切开。
    包在线上和逐个发完全一样，对端是新是旧、开没开 GRO 都收到同样的一个个数据报。
    内核不支持（4.18 以前）或者发的时候报 EIO / EINVAL（网卡不做校验和卸载之类）就在整个
    进程里关掉 GSO，没发出去的那部分逐个重发，不丢包。
  - GRO：收的套接字开 UDP_GRO，内核把同一条流上连着的等长数据报合成一个缓冲交上来，控制
    消息里带段长；这里按段长切回一个个数据报再交给读循环，读循环看到的和以前一模一样。
    开不了（老内核）就不开。读循环退出时把 UDP_GRO 关回去，同一个套接字之后交给别的读法也
    不会读到合在一起的包。

缓冲：收的一批是 fxpUDPBatchSize × 64 KiB（每格要容得下最大的数据报，GRO 合起来的也不超过
64 KiB），用 mmap 匿名映射，只有真写到的页才占内存；做成全局的空闲链表，读协程只在套接字
可读的那一刻借一批、包都交出去就还，空闲的会话不占。链表有上限，借不到就退到逐包读。
发的线上包封在每个会话自己的一小块缓冲里（fxpUDPWireBatch，64 × 1472 字节，第一次真要成批
发的时候才从 sync.Pool 借，会话结束还回去）；发往目标 / 客户端的包直接引用队列里的缓冲。
*/

const (
	fxpUDPBatchSize   = 64
	fxpUDPBatchStride = 65536
	// 同时借出的收包批次上限：只有正在收的协程才占着，实际并发量和 CPU 数一个量级。
	fxpUDPBatchPoolLimit = 64
	// 一条 GSO 消息最多多少段、多少字节（IPv4 的总长度上限 65535 减 IP + UDP 头，再留点余量）。
	fxpUDPGSOMaxSegments = 64
	fxpUDPGSOMaxBytes    = 65000
)

var (
	// 测试里关掉它们对比逐包路径。
	fxpUDPBatchEnabled = true
	fxpUDPGROEnabled   = true
	// fxpUDPGSOAvailable 在第一次 GSO 发送失败后置 false，整个进程不再试。
	fxpUDPGSOAvailable atomic.Bool

	fxpUDPBatchRecvCalls   atomic.Int64
	fxpUDPBatchRecvPackets atomic.Int64
	fxpUDPBatchSendCalls   atomic.Int64
	fxpUDPBatchSendPackets atomic.Int64
	fxpUDPGSOMessages      atomic.Int64
	fxpUDPGROMessages      atomic.Int64
	fxpUDPGSOFallbackOnce  sync.Once
)

func init() { fxpUDPGSOAvailable.Store(true) }

// fxpMmsghdr 就是内核的 struct mmsghdr：一个 msghdr 加上这条消息的字节数，Go 会把它补齐到
// msghdr 的对齐，和 C 的布局一致（有测试盯着）。
type fxpMmsghdr struct {
	hdr unix.Msghdr
	len uint32
}

// fxpUDPPacketReader 是读循环要的那一个方法；*net.UDPConn 和 *fxpUDPBatchReader 都有。
type fxpUDPPacketReader interface {
	ReadFromUDPAddrPort(b []byte) (int, netip.AddrPort, error)
}

// ---- 收 ----

type fxpUDPRecvBatch struct {
	hdrs  []fxpMmsghdr
	iovs  []unix.Iovec
	names []unix.RawSockaddrInet6
	ctrl  []byte
	slab  []byte
}

// 每条消息的控制消息缓冲：放得下一个 UDP_GRO（int）。
var fxpUDPGROCtrlSpace = unix.CmsgSpace(4)

var (
	fxpUDPRecvBatchMu    sync.Mutex
	fxpUDPRecvBatchFree  []*fxpUDPRecvBatch
	fxpUDPRecvBatchCount int
)

func getFXPUDPRecvBatch() *fxpUDPRecvBatch {
	fxpUDPRecvBatchMu.Lock()
	if n := len(fxpUDPRecvBatchFree); n > 0 {
		b := fxpUDPRecvBatchFree[n-1]
		fxpUDPRecvBatchFree = fxpUDPRecvBatchFree[:n-1]
		fxpUDPRecvBatchMu.Unlock()
		return b
	}
	if fxpUDPRecvBatchCount >= fxpUDPBatchPoolLimit {
		fxpUDPRecvBatchMu.Unlock()
		return nil
	}
	fxpUDPRecvBatchCount++
	fxpUDPRecvBatchMu.Unlock()
	b := newFXPUDPRecvBatch()
	if b == nil {
		fxpUDPRecvBatchMu.Lock()
		fxpUDPRecvBatchCount--
		fxpUDPRecvBatchMu.Unlock()
	}
	return b
}

// newFXPUDPRecvBatch 映射一批的缓冲。只有真写到的页才占内存。
func newFXPUDPRecvBatch() *fxpUDPRecvBatch {
	slab, err := unix.Mmap(-1, 0, fxpUDPBatchSize*fxpUDPBatchStride, unix.PROT_READ|unix.PROT_WRITE, unix.MAP_ANON|unix.MAP_PRIVATE)
	if err != nil {
		return nil
	}
	b := &fxpUDPRecvBatch{
		hdrs:  make([]fxpMmsghdr, fxpUDPBatchSize),
		iovs:  make([]unix.Iovec, fxpUDPBatchSize),
		names: make([]unix.RawSockaddrInet6, fxpUDPBatchSize),
		ctrl:  make([]byte, fxpUDPBatchSize*fxpUDPGROCtrlSpace),
		slab:  slab,
	}
	for i := range b.hdrs {
		b.iovs[i].Base = &slab[i*fxpUDPBatchStride]
		b.hdrs[i].hdr.Iov = &b.iovs[i]
		b.hdrs[i].hdr.SetIovlen(1)
	}
	return b
}

func putFXPUDPRecvBatch(b *fxpUDPRecvBatch) {
	if b == nil {
		return
	}
	fxpUDPRecvBatchMu.Lock()
	fxpUDPRecvBatchFree = append(fxpUDPRecvBatchFree, b)
	fxpUDPRecvBatchMu.Unlock()
}

// prepare 把前 count 条消息里内核会改写的字段复位。
func (b *fxpUDPRecvBatch) prepare(gro bool, count int) {
	for i := range b.hdrs[:count] {
		h := &b.hdrs[i]
		h.hdr.Name = (*byte)(unsafe.Pointer(&b.names[i]))
		h.hdr.Namelen = unix.SizeofSockaddrInet6
		h.hdr.Flags = 0
		h.len = 0
		if gro {
			h.hdr.Control = &b.ctrl[i*fxpUDPGROCtrlSpace]
			h.hdr.SetControllen(fxpUDPGROCtrlSpace)
		} else {
			h.hdr.Control = nil
			h.hdr.SetControllen(0)
		}
		b.iovs[i].SetLen(fxpUDPBatchStride - 1)
	}
}

// fxpUDPBatchReader 一次 recvmmsg 收一批，读循环一个一个地拿。只能给一个协程用。
//
// 一次收几条（vlen）随流量自适应：从 fxpUDPBatchMinVlen 起，一次收满就翻倍，收得很少就减半，
// 封顶 fxpUDPBatchSize。稀疏的一问一答（DNS、游戏心跳）每次只复位、只碰一两格，开销和逐包
// 读一样；突发时几次就涨到一次 64 个。
type fxpUDPBatchReader struct {
	conn *net.UDPConn
	raw  syscall.RawConn
	gro  bool
	// owned：监听的读循环自己长期拿着一批（不进全局链表，关的时候解除映射），免得每个包都去
	// 链表里借还一次、批次在几个核之间来回跳。会话的读协程是借的，读空就还。
	owned bool
	vlen  int
	// 手里这一批：count 个消息，下一个是 next；segData 是正在按 GRO 段长切的那条消息。
	batch   *fxpUDPRecvBatch
	count   int
	next    int
	segData []byte
	segSize int
	segFrom netip.AddrPort
}

const fxpUDPBatchMinVlen = 2

// newFXPUDPBatchReader 给 conn 做批量读；不支持（关了批量、拿不到 RawConn）时原样返回 conn。
// gro 为真时试着在套接字上开 UDP_GRO；owned 见 fxpUDPBatchReader。用完调 closeFXPUDPPacketReader。
func newFXPUDPBatchReader(conn *net.UDPConn, gro bool, owned bool) fxpUDPPacketReader {
	if !fxpUDPBatchEnabled || conn == nil {
		return conn
	}
	raw, err := conn.SyscallConn()
	if err != nil {
		return conn
	}
	r := &fxpUDPBatchReader{conn: conn, raw: raw, owned: owned, vlen: fxpUDPBatchMinVlen}
	if gro && fxpUDPGROEnabled {
		_ = raw.Control(func(fd uintptr) {
			r.gro = unix.SetsockoptInt(int(fd), unix.IPPROTO_UDP, unix.UDP_GRO, 1) == nil
		})
	}
	return r
}

// closeFXPUDPPacketReader 还掉（或解除映射）手里的那一批，把 UDP_GRO 关回去（套接字可能还会
// 交给别的读法）。
func closeFXPUDPPacketReader(reader fxpUDPPacketReader) {
	r, ok := reader.(*fxpUDPBatchReader)
	if !ok || r == nil {
		return
	}
	r.release()
	if r.batch != nil {
		_ = unix.Munmap(r.batch.slab)
		r.batch = nil
	}
	if r.gro {
		_ = r.raw.Control(func(fd uintptr) {
			_ = unix.SetsockoptInt(int(fd), unix.IPPROTO_UDP, unix.UDP_GRO, 0)
		})
		r.gro = false
	}
}

// release 交完了这一批：借来的还回去，自己的留着下次用。
func (r *fxpUDPBatchReader) release() {
	if r.batch != nil && !r.owned {
		putFXPUDPRecvBatch(r.batch)
		r.batch = nil
	}
	r.count, r.next = 0, 0
	r.segData = nil
}

// buffered：手里还有没交出去的包（读循环可以先不急着把攒下的发出去）。
func (r *fxpUDPBatchReader) buffered() bool {
	return len(r.segData) > 0 || r.next < r.count
}

// fxpUDPReaderBuffered 对 *net.UDPConn 恒为 false。
func fxpUDPReaderBuffered(reader fxpUDPPacketReader) bool {
	r, ok := reader.(*fxpUDPBatchReader)
	return ok && r != nil && r.buffered()
}

func (r *fxpUDPBatchReader) ReadFromUDPAddrPort(b []byte) (int, netip.AddrPort, error) {
	for {
		if len(r.segData) > 0 {
			seg := r.segData[:min(r.segSize, len(r.segData))]
			r.segData = r.segData[len(seg):]
			n := copy(b, seg)
			if len(r.segData) == 0 && r.next >= r.count {
				r.release()
			}
			return n, r.segFrom, nil
		}
		if r.batch != nil && r.next < r.count {
			i := r.next
			r.next++
			h := &r.batch.hdrs[i]
			if h.hdr.Flags&unix.MSG_TRUNC != 0 {
				continue
			}
			from, ok := fxpSockaddrToAddrPort(&r.batch.names[i], h.hdr.Namelen)
			if !ok {
				continue
			}
			data := r.batch.slab[i*fxpUDPBatchStride : i*fxpUDPBatchStride+int(h.len)]
			if r.gro {
				if size := fxpUDPGROSegmentSize(r.batch.ctrl[i*fxpUDPGROCtrlSpace:], int(h.hdr.Controllen)); size > 0 && size < len(data) {
					fxpUDPGROMessages.Add(1)
					r.segData, r.segSize, r.segFrom = data, size, from
					continue
				}
			}
			n := copy(b, data)
			if r.next >= r.count {
				r.release()
			}
			return n, from, nil
		}
		r.release()
		if err := r.fill(); err != nil {
			if errors.Is(err, errFXPUDPBatchUnavailable) {
				// 批次借光了：这一次逐包读，不等。
				return r.conn.ReadFromUDPAddrPort(b)
			}
			return 0, netip.AddrPort{}, err
		}
	}
}

var errFXPUDPBatchUnavailable = errors.New("udp batch: no receive batch available")

// fill 等套接字可读、借一批、收。超时、关闭和普通 Read 一样返回（超时是 net.Error 且
// Timeout() 为真，关闭是 net.ErrClosed）；等的时候不占批次。
func (r *fxpUDPBatchReader) fill() error {
	batch := r.batch
	var n int
	var errno unix.Errno
	unavailable := false
	vlen := max(fxpUDPBatchMinVlen, min(r.vlen, fxpUDPBatchSize))
	err := r.raw.Read(func(fd uintptr) bool {
		if batch == nil {
			if r.owned {
				batch = newFXPUDPRecvBatch()
			} else {
				batch = getFXPUDPRecvBatch()
			}
			if batch == nil {
				unavailable = true
				return true
			}
		}
		batch.prepare(r.gro, vlen)
		for {
			res, _, e := unix.Syscall6(unix.SYS_RECVMMSG, fd, uintptr(unsafe.Pointer(&batch.hdrs[0])), uintptr(vlen), 0, 0, 0)
			if e == unix.EINTR {
				continue
			}
			if e == unix.EAGAIN {
				// 等可读期间：借来的先还回去，自己的留着。
				if !r.owned {
					putFXPUDPRecvBatch(batch)
					batch = nil
				}
				return false
			}
			n, errno = int(res), e
			return true
		}
	})
	if r.owned {
		r.batch = batch
	}
	if unavailable {
		return errFXPUDPBatchUnavailable
	}
	if err == nil && errno != 0 {
		err = errno
	}
	if err == nil && n <= 0 {
		err = errFXPUDPBatchUnavailable
	}
	if err != nil {
		if !r.owned {
			putFXPUDPRecvBatch(batch)
		}
		return err
	}
	// 一次收满了说明还有积压，下次多收一倍；收得很少就减半。
	if n >= vlen {
		r.vlen = min(vlen*2, fxpUDPBatchSize)
	} else if n*4 <= vlen {
		r.vlen = max(vlen/2, fxpUDPBatchMinVlen)
	}
	fxpUDPBatchRecvCalls.Add(1)
	fxpUDPBatchRecvPackets.Add(int64(n))
	r.batch, r.count, r.next = batch, n, 0
	return nil
}

// fxpUDPGROSegmentSize 从一条消息的控制消息里找 UDP_GRO 的段长；没有返回 0。不分配。
func fxpUDPGROSegmentSize(ctrl []byte, length int) int {
	if length <= 0 || length > len(ctrl) {
		return 0
	}
	ctrl = ctrl[:length]
	headerLen := unix.CmsgLen(0)
	for len(ctrl) >= unix.SizeofCmsghdr {
		h := (*unix.Cmsghdr)(unsafe.Pointer(&ctrl[0]))
		msgLen := int(h.Len)
		if msgLen < headerLen || msgLen > len(ctrl) {
			return 0
		}
		if h.Level == unix.SOL_UDP && h.Type == unix.UDP_GRO && msgLen >= headerLen+4 {
			return int(*(*int32)(unsafe.Pointer(&ctrl[headerLen])))
		}
		next := fxpCmsgAlign(msgLen)
		if next >= len(ctrl) {
			return 0
		}
		ctrl = ctrl[next:]
	}
	return 0
}

func fxpCmsgAlign(n int) int {
	const align = int(unsafe.Sizeof(uintptr(0)))
	return (n + align - 1) &^ (align - 1)
}

// ---- 发 ----

// fxpUDPBatchSender 把攒下的包一次 sendmmsg 发出去，能合成 GSO 的合成 GSO。只能给一个协程用。
type fxpUDPBatchSender struct {
	raw  syscall.RawConn
	v6   bool
	gso  bool
	pkts [][]byte
	hdrs []fxpMmsghdr
	iovs []unix.Iovec
	runs []int
	ctrl []byte
	dst  unix.RawSockaddrInet6
}

var fxpUDPGSOCtrlSpace = unix.CmsgSpace(2)

// newFXPUDPBatchSender 给 conn 做批量发；不支持时返回 nil，调用方逐包发。
func newFXPUDPBatchSender(conn *net.UDPConn) *fxpUDPBatchSender {
	if !fxpUDPBatchEnabled || conn == nil {
		return nil
	}
	raw, err := conn.SyscallConn()
	if err != nil {
		return nil
	}
	family := -1
	gso := false
	if err := raw.Control(func(fd uintptr) {
		family, _ = unix.GetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_DOMAIN)
		if fxpUDPGSOAvailable.Load() {
			_, gsoErr := unix.GetsockoptInt(int(fd), unix.IPPROTO_UDP, unix.UDP_SEGMENT)
			gso = gsoErr == nil
		}
	}); err != nil {
		return nil
	}
	if family != unix.AF_INET && family != unix.AF_INET6 {
		return nil
	}
	return &fxpUDPBatchSender{
		raw:  raw,
		v6:   family == unix.AF_INET6,
		gso:  gso,
		pkts: make([][]byte, 0, fxpUDPBatchSize),
		hdrs: make([]fxpMmsghdr, fxpUDPBatchSize),
		iovs: make([]unix.Iovec, fxpUDPBatchSize),
		runs: make([]int, fxpUDPBatchSize),
		ctrl: make([]byte, fxpUDPBatchSize*fxpUDPGSOCtrlSpace),
	}
}

func (s *fxpUDPBatchSender) full() bool   { return len(s.pkts) >= fxpUDPBatchSize }
func (s *fxpUDPBatchSender) pending() int { return len(s.pkts) }

// add 攒一个包。p 在 flush 之前不能被改写或还回池里。
func (s *fxpUDPBatchSender) add(p []byte) { s.pkts = append(s.pkts, p) }

// flushTo 把攒下的包都发给 dst（没连接的套接字）。
func (s *fxpUDPBatchSender) flushTo(dst netip.AddrPort) error {
	defer s.reset()
	nameLen, ok := fxpAddrPortToSockaddr(&s.dst, s.v6, dst)
	if !ok {
		return errFXPUDPBatchAddress
	}
	return s.sendAll((*byte)(unsafe.Pointer(&s.dst)), nameLen)
}

// flushConnected 把攒下的包都写到已连接的套接字上。
func (s *fxpUDPBatchSender) flushConnected() error {
	defer s.reset()
	return s.sendAll(nil, 0)
}

func (s *fxpUDPBatchSender) reset() {
	clear(s.pkts)
	s.pkts = s.pkts[:0]
}

var errFXPUDPBatchAddress = errors.New("udp batch: address family mismatch")

// fxpUDPSendmmsg 是真正的系统调用；测试里换掉它模拟内核拒收 GSO。
var fxpUDPSendmmsg = func(fd uintptr, hdrs []fxpMmsghdr) (int, unix.Errno) {
	for {
		r, _, e := unix.Syscall6(unix.SYS_SENDMMSG, fd, uintptr(unsafe.Pointer(&hdrs[0])), uintptr(len(hdrs)), 0, 0, 0)
		if e == unix.EINTR {
			continue
		}
		return int(r), e
	}
}

func (s *fxpUDPBatchSender) sendAll(name *byte, nameLen uint32) error {
	sent := 0
	for sent < len(s.pkts) {
		count := s.build(s.pkts[sent:], name, nameLen)
		n, err := s.sendmmsg(s.hdrs[:count])
		for i := 0; i < n; i++ {
			sent += s.runs[i]
		}
		if err == nil {
			continue
		}
		var errno unix.Errno
		if errors.As(err, &errno) && s.gso && n < count && s.runs[n] > 1 && fxpUDPGSORejected(errno) {
			// 内核或网卡不收 GSO：整个进程关掉，剩下的逐个重发。
			s.gso = false
			fxpUDPGSOAvailable.Store(false)
			fxpUDPGSOFallbackOnce.Do(func() {
				log.Printf("fxp udp gso disabled after send error: %v; falling back to sendmmsg", errno)
			})
			continue
		}
		return err
	}
	fxpUDPBatchSendCalls.Add(1)
	fxpUDPBatchSendPackets.Add(int64(len(s.pkts)))
	return nil
}

func fxpUDPGSORejected(errno unix.Errno) bool {
	switch errno {
	case unix.EIO, unix.EINVAL, unix.EOPNOTSUPP, unix.ENOPROTOOPT, unix.EMSGSIZE:
		return true
	}
	return false
}

// build 把 pkts 排成消息：首尾相接、等长（最后一段可以短）的一串合成一条 GSO 消息，其余一个包
// 一条。返回消息数；runs[i] 是第 i 条消息装了几个包。
func (s *fxpUDPBatchSender) build(pkts [][]byte, name *byte, nameLen uint32) int {
	count := 0
	for i := 0; i < len(pkts) && count < len(s.hdrs); {
		p := pkts[i]
		run, total := 1, len(p)
		if s.gso && len(p) > 0 {
			last := p
			for i+run < len(pkts) && run < fxpUDPGSOMaxSegments {
				q := pkts[i+run]
				if len(q) == 0 || len(q) > len(p) || total+len(q) > fxpUDPGSOMaxBytes || !fxpUDPContiguous(last, q) {
					break
				}
				total += len(q)
				run++
				last = q
				if len(q) < len(p) {
					break
				}
			}
		}
		iov := &s.iovs[count]
		if len(p) > 0 {
			iov.Base = &p[0]
		} else {
			iov.Base = nil
		}
		iov.SetLen(total)
		h := &s.hdrs[count]
		h.hdr = unix.Msghdr{Name: name, Namelen: nameLen, Iov: iov}
		h.hdr.SetIovlen(1)
		h.len = 0
		if run > 1 {
			ctrl := s.ctrl[count*fxpUDPGSOCtrlSpace : (count+1)*fxpUDPGSOCtrlSpace]
			clear(ctrl)
			cmsg := (*unix.Cmsghdr)(unsafe.Pointer(&ctrl[0]))
			cmsg.Level = unix.SOL_UDP
			cmsg.Type = unix.UDP_SEGMENT
			cmsg.SetLen(unix.CmsgLen(2))
			*(*uint16)(unsafe.Pointer(&ctrl[unix.CmsgLen(0)])) = uint16(len(p))
			h.hdr.Control = &ctrl[0]
			h.hdr.SetControllen(fxpUDPGSOCtrlSpace)
			fxpUDPGSOMessages.Add(1)
		}
		s.runs[count] = run
		count++
		i += run
	}
	return count
}

// fxpUDPContiguous：b 紧跟在 a 后面（同一块缓冲里首尾相接）。
func fxpUDPContiguous(a, b []byte) bool {
	if len(a) == 0 || len(b) == 0 {
		return false
	}
	return unsafe.Pointer(&b[0]) == unsafe.Add(unsafe.Pointer(&a[0]), len(a))
}

// sendmmsg 发这些消息：返回发出去几条，没全发完时带上错误。发送缓冲满（EAGAIN）交给轮询器等可写。
func (s *fxpUDPBatchSender) sendmmsg(hs []fxpMmsghdr) (int, error) {
	done := 0
	for done < len(hs) {
		var n int
		var errno unix.Errno
		err := s.raw.Write(func(fd uintptr) bool {
			n, errno = fxpUDPSendmmsg(fd, hs[done:])
			return errno != unix.EAGAIN
		})
		if err != nil {
			return done, err
		}
		if errno != 0 {
			return done, errno
		}
		if n <= 0 {
			return done, errFXPUDPBatchStalled
		}
		done += n
	}
	return done, nil
}

var errFXPUDPBatchStalled = errors.New("udp batch: sendmmsg sent nothing")

// ---- sockaddr 和 netip.AddrPort 互转（不分配） ----

func fxpSockaddrToAddrPort(name *unix.RawSockaddrInet6, length uint32) (netip.AddrPort, bool) {
	switch name.Family {
	case unix.AF_INET:
		if length < unix.SizeofSockaddrInet4 {
			return netip.AddrPort{}, false
		}
		sa := (*unix.RawSockaddrInet4)(unsafe.Pointer(name))
		return netip.AddrPortFrom(netip.AddrFrom4(sa.Addr), fxpSockaddrPort(sa.Port)), true
	case unix.AF_INET6:
		if length < unix.SizeofSockaddrInet6 {
			return netip.AddrPort{}, false
		}
		addr := netip.AddrFrom16(name.Addr)
		if name.Scope_id != 0 {
			addr = addr.WithZone(fxpZoneName(name.Scope_id))
		}
		return netip.AddrPortFrom(addr, fxpSockaddrPort(name.Port)), true
	}
	return netip.AddrPort{}, false
}

func fxpSockaddrPort(raw uint16) uint16 {
	p := (*[2]byte)(unsafe.Pointer(&raw))
	return uint16(p[0])<<8 | uint16(p[1])
}

func fxpAddrPortToSockaddr(name *unix.RawSockaddrInet6, v6 bool, ap netip.AddrPort) (uint32, bool) {
	addr := ap.Addr()
	if v6 {
		*name = unix.RawSockaddrInet6{Family: unix.AF_INET6, Addr: addr.As16()}
		if zone := addr.Zone(); zone != "" {
			name.Scope_id = fxpZoneIndex(zone)
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

// IPv6 链路本地地址的 zone：和 net 包一样用接口名，查不到就用数字。很少走到，不缓存。
func fxpZoneName(index uint32) string {
	if iface, err := net.InterfaceByIndex(int(index)); err == nil {
		return iface.Name
	}
	return uitoa(uint64(index))
}

func fxpZoneIndex(zone string) uint32 {
	var n uint64
	numeric := zone != ""
	for _, c := range zone {
		if c < '0' || c > '9' {
			numeric = false
			break
		}
		n = n*10 + uint64(c-'0')
	}
	if numeric {
		return uint32(n)
	}
	if iface, err := net.InterfaceByName(zone); err == nil {
		return uint32(iface.Index)
	}
	return 0
}

func uitoa(v uint64) string {
	if v == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	return string(buf[i:])
}
