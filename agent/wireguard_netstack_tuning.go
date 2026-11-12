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
// 单连接只能到两百兆左右。
//
// 这里把上限抬到和安装脚本给内核设的一样（16MB）。默认值保持 1MB 不变：缓冲由收发
// 两端按实际 RTT 自动增长，不会让空闲连接平白占内存。
//
// 拥塞控制必须留在 reno，不能换 cubic。这一版 gVisor（go.mod 里那个）的 cubic 有两个
// 毛病，合起来会让 V2 的 TCP 连接中途彻底卡死：
//
//  1. 拥塞避免阶段 getCwnd 会把窗口往 W_cubic(t+RTT) “拉回去”，而不是只增不减。
//     窗口在 1 的时候又判了一次丢包（超时重传之后很常见），WMax 就成了 1，
//     W_cubic 在 K≈0.9 秒以内都小于 1，int() 一截断 SndCwnd 就是 0。此时没有在途数据，
//     重传定时器、TLP 都不会再起，对端也不会再发 ACK —— 发送端永远不再发包，
//     发送缓冲（16MB）塞满，上游写不进来，整条链路停住，直到上层超时。
//     实测：两个 netstack 之间随机丢 1% 的包，6/6 次在 1~3MB 处卡死，卡住时
//     SndCwnd=0、Ssthresh=2、Outstanding=0（wireguard_netstack_stall_test.go）。
//  2. cubic 的时间起点 T 在建连时设好，HyStart 退出慢启动时不重置。FXP 预热池里的
//     连接建好后要空闲几秒到 25 秒才被取用，一开始传数据 getCwnd 就按“距上次拥塞已经
//     过去十几秒”算，TCP 友好区直接给出几千个包的窗口（实测 Ssthresh=36 时
//     SndCwnd=4058）。几千个包一次冲进 TUN 出站队列（2048 个包）和对端，大批丢包、
//     超时重传，正好把连接送进上面第 1 条的死路。线路本身不丢包也会自己丢出来：
//     联调环境里每 10 秒下一次 30MB，六十次卡五次；不经过 FXP 预热池、每次现拨的
//     连接同样的循环六十次一次不卡。
//
// 上游后来按 RFC 9438 重写了 cubic（窗口只增不减、空闲后重启曲线），但那一版要求
// Go 1.27 以上；升级 gVisor 之前别再把这里改回 cubic。reno 没有这两个问题：拥塞避免
// 只加不减，丢包时 ssthresh 至少是 2、超时时窗口是 1，永远不会是 0。
const (
	wireGuardNetstackBufferMax         = 16 << 20
	wireGuardNetstackCongestionControl = "reno"
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
