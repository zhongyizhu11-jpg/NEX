package main

/*
NEX V2 自己的用户态 TUN：gVisor 协议栈 + 通道型链路端点，和 wireguard-go 自带的
tun/netstack 是同一个结构，只是收发按批。

wireguard-go 自带的那个 BatchSize() 恒为 1：设备读协程每次只从协议栈取一个包，
加密后也只能一个包一次 sendmsg 发出去。可 wireguard-go 的 UDP 绑定早就支持
sendmmsg 和 UDP GSO / GRO —— 一批包只要一次系统调用、内核只做一次分段、对端
一次 recvmmsg 收一批 —— 前提是 TUN 一次交给它一批。所以这里 Read 先阻塞等第一
个包，再把协议栈里已经排好的包一并带走（最多 conn.IdealBatchSize = 128 个）。
千兆以上的 V2 隧道，CPU 大头正是每包一次的系统调用和加密调度，批处理能省掉其中
的大半；小流量时队列里只有一个包，行为和原来一样。

直接取协议栈的出站队列（ReadContext），不再像 wireguard-go 那样靠 WriteNotify
回调把每个包搬进一个无缓冲 channel —— 那条 channel 正是批凑不起来的原因。

*stack.Stack 也直接留在手上：调优不必再靠反射从 wireguard-go 的私有字段里掏。

改自 wireguard-go 的 tun/netstack/tun.go（MIT，Copyright (C) 2017-2025 WireGuard
LLC），见 THIRD_PARTY_NOTICES.md。
*/

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os"
	"sync"
	"syscall"

	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/tun"
	"gvisor.dev/gvisor/pkg/buffer"
	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/adapters/gonet"
	"gvisor.dev/gvisor/pkg/tcpip/header"
	"gvisor.dev/gvisor/pkg/tcpip/link/channel"
	"gvisor.dev/gvisor/pkg/tcpip/network/ipv4"
	"gvisor.dev/gvisor/pkg/tcpip/network/ipv6"
	"gvisor.dev/gvisor/pkg/tcpip/stack"
	"gvisor.dev/gvisor/pkg/tcpip/transport/icmp"
	"gvisor.dev/gvisor/pkg/tcpip/transport/tcp"
	"gvisor.dev/gvisor/pkg/tcpip/transport/udp"
)

const (
	// wireGuardNetTUNQueueSize 是协议栈到 TUN 之间排队的包数。满了协议栈会丢包
	// （TCP 自己会重传），所以给够：128 一批、一次读走，2048 够十几批的突发。
	wireGuardNetTUNQueueSize = 2048
	// wireGuardNetTUNBatchSize 跟 wireguard-go 的 UDP 绑定一致，再大它也装不下。
	wireGuardNetTUNBatchSize = conn.IdealBatchSize
	wireGuardNetTUNNIC       = tcpip.NICID(1)
)

type wireGuardNetTUN struct {
	ep        *channel.Endpoint
	stack     *stack.Stack
	events    chan tun.Event
	mtu       int
	batchSize int
	ctx       context.Context
	cancel    context.CancelFunc
	closeOnce sync.Once
	// dropped 记录因为 WireGuard 给的缓冲装不下而丢掉的包数（MTU 配错才会发生）。
	dropped uint64
	mu      sync.Mutex
}

var _ tun.Device = (*wireGuardNetTUN)(nil)

func newWireGuardNetTUN(address netip.Addr, mtu int) (*wireGuardNetTUN, error) {
	if mtu <= 0 {
		return nil, errors.New("wireguard netstack mtu must be positive")
	}
	opts := stack.Options{
		NetworkProtocols:   []stack.NetworkProtocolFactory{ipv4.NewProtocol, ipv6.NewProtocol},
		TransportProtocols: []stack.TransportProtocolFactory{tcp.NewProtocol, udp.NewProtocol, icmp.NewProtocol6, icmp.NewProtocol4},
		HandleLocal:        true,
	}
	ctx, cancel := context.WithCancel(context.Background())
	dev := &wireGuardNetTUN{
		ep:        channel.New(wireGuardNetTUNQueueSize, uint32(mtu), ""),
		stack:     stack.New(opts),
		events:    make(chan tun.Event, 10),
		mtu:       mtu,
		batchSize: wireGuardNetTUNBatchSize,
		ctx:       ctx,
		cancel:    cancel,
	}
	sackEnabledOpt := tcpip.TCPSACKEnabled(true) // gVisor 默认关着 SACK
	if err := dev.stack.SetTransportProtocolOption(tcp.ProtocolNumber, &sackEnabledOpt); err != nil {
		dev.Close()
		return nil, fmt.Errorf("could not enable TCP SACK: %v", err)
	}
	if err := dev.stack.CreateNIC(wireGuardNetTUNNIC, dev.ep); err != nil {
		dev.Close()
		return nil, fmt.Errorf("CreateNIC: %v", err)
	}
	var protoNumber tcpip.NetworkProtocolNumber
	if address.Is4() {
		protoNumber = ipv4.ProtocolNumber
	} else {
		protoNumber = ipv6.ProtocolNumber
	}
	protoAddr := tcpip.ProtocolAddress{
		Protocol:          protoNumber,
		AddressWithPrefix: tcpip.AddrFromSlice(address.AsSlice()).WithPrefix(),
	}
	if err := dev.stack.AddProtocolAddress(wireGuardNetTUNNIC, protoAddr, stack.AddressProperties{}); err != nil {
		dev.Close()
		return nil, fmt.Errorf("AddProtocolAddress(%v): %v", address, err)
	}
	if address.Is4() {
		dev.stack.AddRoute(tcpip.Route{Destination: header.IPv4EmptySubnet, NIC: wireGuardNetTUNNIC})
	} else {
		dev.stack.AddRoute(tcpip.Route{Destination: header.IPv6EmptySubnet, NIC: wireGuardNetTUNNIC})
	}
	dev.events <- tun.EventUp
	return dev, nil
}

func (t *wireGuardNetTUN) Name() (string, error) { return "go", nil }
func (t *wireGuardNetTUN) File() *os.File        { return nil }
func (t *wireGuardNetTUN) Events() <-chan tun.Event {
	return t.events
}
func (t *wireGuardNetTUN) MTU() (int, error) { return t.mtu, nil }
func (t *wireGuardNetTUN) BatchSize() int    { return t.batchSize }

// Read 等到协议栈有出站包，然后把此刻排着的包尽量一次都交给 WireGuard。
func (t *wireGuardNetTUN) Read(bufs [][]byte, sizes []int, offset int) (int, error) {
	if len(bufs) == 0 {
		return 0, nil
	}
	pkt := t.ep.ReadContext(t.ctx)
	if pkt == nil {
		return 0, os.ErrClosed
	}
	count := 0
	for {
		if n, ok := t.copyPacket(pkt, bufs[count][offset:]); ok {
			sizes[count] = n
			count++
		}
		if count >= len(bufs) {
			break
		}
		if pkt = t.ep.Read(); pkt == nil {
			break
		}
	}
	if count == 0 {
		// 唯一那个包装不下，被丢了：别把这当成设备读失败。
		return 0, nil
	}
	return count, nil
}

// copyPacket 把一个包拷进 WireGuard 的缓冲，归还协议栈的引用。装不下就丢。
func (t *wireGuardNetTUN) copyPacket(pkt *stack.PacketBuffer, dst []byte) (int, bool) {
	view := pkt.ToView()
	pkt.DecRef()
	defer view.Release()
	if view.Size() > len(dst) {
		t.mu.Lock()
		t.dropped++
		t.mu.Unlock()
		return 0, false
	}
	n, err := view.Read(dst)
	if err != nil {
		return 0, false
	}
	return n, true
}

// Write 把 WireGuard 解出来的包逐个注入协议栈。
func (t *wireGuardNetTUN) Write(bufs [][]byte, offset int) (int, error) {
	for _, buf := range bufs {
		packet := buf[offset:]
		if len(packet) == 0 {
			continue
		}
		pkb := stack.NewPacketBuffer(stack.PacketBufferOptions{Payload: buffer.MakeWithData(packet)})
		switch packet[0] >> 4 {
		case 4:
			t.ep.InjectInbound(header.IPv4ProtocolNumber, pkb)
		case 6:
			t.ep.InjectInbound(header.IPv6ProtocolNumber, pkb)
		default:
			pkb.DecRef()
			return 0, syscall.EAFNOSUPPORT
		}
	}
	return len(bufs), nil
}

func (t *wireGuardNetTUN) Close() error {
	t.closeOnce.Do(func() {
		t.cancel()
		t.stack.RemoveNIC(wireGuardNetTUNNIC)
		t.stack.Close()
		t.ep.Close()
		close(t.events)
	})
	return nil
}

// droppedPackets 是因为缓冲装不下而丢掉的包数（诊断用）。
func (t *wireGuardNetTUN) droppedPackets() uint64 {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.dropped
}

func wireGuardNetTUNFullAddr(endpoint netip.AddrPort) (tcpip.FullAddress, tcpip.NetworkProtocolNumber) {
	var protoNumber tcpip.NetworkProtocolNumber
	if endpoint.Addr().Is4() {
		protoNumber = ipv4.ProtocolNumber
	} else {
		protoNumber = ipv6.ProtocolNumber
	}
	return tcpip.FullAddress{
		NIC:  wireGuardNetTUNNIC,
		Addr: tcpip.AddrFromSlice(endpoint.Addr().AsSlice()),
		Port: endpoint.Port(),
	}, protoNumber
}

func wireGuardNetTUNAddrPort(ip net.IP, port int) netip.AddrPort {
	addr, _ := netip.AddrFromSlice(ip)
	return netip.AddrPortFrom(addr.Unmap(), uint16(port))
}

// DialContextTCP 从协议栈往对端拨一条 TCP。
func (t *wireGuardNetTUN) DialContextTCP(ctx context.Context, addr *net.TCPAddr) (*gonet.TCPConn, error) {
	if addr == nil {
		return nil, errors.New("wireguard netstack: nil tcp address")
	}
	fa, pn := wireGuardNetTUNFullAddr(wireGuardNetTUNAddrPort(addr.IP, addr.Port))
	return gonet.DialContextTCP(ctx, t.stack, fa, pn)
}

// ListenTCP 在协议栈里的本地地址上监听 TCP。
func (t *wireGuardNetTUN) ListenTCP(addr *net.TCPAddr) (*gonet.TCPListener, error) {
	if addr == nil {
		return nil, errors.New("wireguard netstack: nil tcp address")
	}
	fa, pn := wireGuardNetTUNFullAddr(wireGuardNetTUNAddrPort(addr.IP, addr.Port))
	return gonet.ListenTCP(t.stack, fa, pn)
}

// DialUDP 建一个 UDP 端点：laddr 为空就由协议栈分配，raddr 为空就是只监听。
func (t *wireGuardNetTUN) DialUDP(laddr, raddr *net.UDPAddr) (*gonet.UDPConn, error) {
	var lfa, rfa *tcpip.FullAddress
	var pn tcpip.NetworkProtocolNumber
	if laddr != nil {
		addr, proto := wireGuardNetTUNFullAddr(wireGuardNetTUNAddrPort(laddr.IP, laddr.Port))
		lfa, pn = &addr, proto
	}
	if raddr != nil {
		addr, proto := wireGuardNetTUNFullAddr(wireGuardNetTUNAddrPort(raddr.IP, raddr.Port))
		rfa, pn = &addr, proto
	}
	if lfa == nil && rfa == nil {
		return nil, errors.New("wireguard netstack: udp needs a local or remote address")
	}
	return gonet.DialUDP(t.stack, lfa, rfa, pn)
}

// ListenUDP 在协议栈里的本地地址上收 UDP。
func (t *wireGuardNetTUN) ListenUDP(laddr *net.UDPAddr) (*gonet.UDPConn, error) {
	return t.DialUDP(laddr, nil)
}
