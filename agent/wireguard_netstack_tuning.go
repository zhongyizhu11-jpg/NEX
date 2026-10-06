package main

import (
	"fmt"

	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/stack"
	"gvisor.dev/gvisor/pkg/tcpip/transport/tcp"
)

// NEX V2 的流量跑在 Agent 进程里的 gVisor 用户态 TCP 栈上，内核里装的 BBR 和
// 16MB 缓冲对它不起作用。newWireGuardNetTUN 只打开了 SACK，其余都是
// gVisor 的默认值：拥塞控制 reno、收发缓冲上限 4MB。4MB 窗口在 150ms 往返的线路上
// 单连接只能到两百兆左右，reno 遇到跨境丢包还会再砍半。
//
// 这里把上限抬到和安装脚本给内核设的一样（16MB），拥塞控制换成 gVisor 里能选的
// cubic（gVisor 没有 BBR）。默认值保持 1MB 不变：缓冲由收发两端按实际 RTT 自动
// 增长，不会让空闲连接平白占内存。
const (
	wireGuardNetstackBufferMax         = 16 << 20
	wireGuardNetstackCongestionControl = "cubic"
)

func tuneWireGuardNetstack(s *stack.Stack) error {
	if s == nil {
		return fmt.Errorf("netstack stack not reachable")
	}
	var current tcpip.TCPReceiveBufferSizeRangeOption
	if err := s.TransportProtocolOption(tcp.ProtocolNumber, &current); err != nil {
		return fmt.Errorf("read tcp receive buffer range: %v", err)
	}
	if current.Max < wireGuardNetstackBufferMax {
		recv := tcpip.TCPReceiveBufferSizeRangeOption{Min: current.Min, Default: current.Default, Max: wireGuardNetstackBufferMax}
		if err := s.SetTransportProtocolOption(tcp.ProtocolNumber, &recv); err != nil {
			return fmt.Errorf("set tcp receive buffer range: %v", err)
		}
	}
	var currentSend tcpip.TCPSendBufferSizeRangeOption
	if err := s.TransportProtocolOption(tcp.ProtocolNumber, &currentSend); err != nil {
		return fmt.Errorf("read tcp send buffer range: %v", err)
	}
	if currentSend.Max < wireGuardNetstackBufferMax {
		send := tcpip.TCPSendBufferSizeRangeOption{Min: currentSend.Min, Default: currentSend.Default, Max: wireGuardNetstackBufferMax}
		if err := s.SetTransportProtocolOption(tcp.ProtocolNumber, &send); err != nil {
			return fmt.Errorf("set tcp send buffer range: %v", err)
		}
	}
	moderate := tcpip.TCPModerateReceiveBufferOption(true)
	if err := s.SetTransportProtocolOption(tcp.ProtocolNumber, &moderate); err != nil {
		return fmt.Errorf("enable receive buffer moderation: %v", err)
	}
	cc := tcpip.CongestionControlOption(wireGuardNetstackCongestionControl)
	if err := s.SetTransportProtocolOption(tcp.ProtocolNumber, &cc); err != nil {
		return fmt.Errorf("set congestion control %s: %v", wireGuardNetstackCongestionControl, err)
	}
	return nil
}
