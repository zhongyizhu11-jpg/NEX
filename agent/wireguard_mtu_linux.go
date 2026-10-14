//go:build linux

package main

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

// V2 隧道 MTU 探测。
//
// 面板给每条 V2 隧道的 MTU 一律是 1380，这是按「路径上可能有 PPPoE / 云厂商隧道再包一层」
// 留出的保守值；绝大多数中转机之间其实是干净的 1500 以太网路径，内层能放到 1420
// （1420 + 32 WireGuard 头尾 + 8 UDP + 20 IPv4 = 1480，IPv6 外层 40 字节正好 1500）。
// 这里在建数据面之前朝对端公网端点发一个和满载 WireGuard 包一样大、打了 DF 位的 UDP
// 探测包，路径放得下就把 MTU 抬到 1420，放不下就维持面板下发的值。
//
// 探测包内容对 WireGuard 对端无害：首字节 0 不是任何合法的消息类型，对端静默丢弃。
//
// 这是尽力而为的探测，不是可靠结论：对端不会回应，能看到的只有 (a) 本机发送是否因
// EMSGSIZE 失败（本机出口 MTU 或已缓存的路径 MTU 装不下）和 (b) 发出去等 300ms 后内核
// 为这条流缓存的路径 MTU（IP_MTU，中间路由器回的 ICMP Fragmentation-Needed 会更新它）。
// 路径上把 ICMP 黑洞掉的话，内核看不到任何反馈，探测会乐观地选 1420；真正保底的是内核
// 已经打开的 tcp_mtu_probing。所以：
//   - 环境变量 NEX_WG_MTU_PROBE=0 可以整个关掉探测，直接用面板下发的值；
//   - 面板已经给 ≥1420、端点为空、探测套接字建不起来、发送失败、上下文取消、读不到 IP_MTU，
//     任何一步不顺都原样返回面板下发的值，绝不往下调。
const (
	wireGuardMTUProbeEnv  = "NEX_WG_MTU_PROBE"
	wireGuardMTUProbeMax  = 1420
	wireGuardMTUProbeWait = 300 * time.Millisecond
	// WireGuard 数据包头尾：4 类型 + 4 接收者索引 + 8 计数器 + 16 Poly1305 标签。
	wireGuardPacketOverhead = 32
	wireGuardIPv4Overhead   = 20 + 8 + wireGuardPacketOverhead
	wireGuardIPv6Overhead   = 40 + 8 + wireGuardPacketOverhead
)

func wireGuardMTUProbeEnabledByEnv() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(wireGuardMTUProbeEnv))) {
	case "0", "off", "false", "no", "disable", "disabled":
		return false
	}
	return true
}

// wireGuardOuterOverhead 是内层包变成外层 IP 包要加的字节数。
func wireGuardOuterOverhead(ipv6 bool) int {
	if ipv6 {
		return wireGuardIPv6Overhead
	}
	return wireGuardIPv4Overhead
}

// chooseWireGuardMTU 根据内核缓存的路径 MTU 决定用哪个值：路径装得下满载的 1420 就用
// 1420；装不下就把路径 MTU 减掉外层开销、向下取整到 4 的倍数（WireGuard 内层按 4 字节对齐
// 填充），封顶 1420，但永远不低于面板下发的值。
func chooseWireGuardMTU(configured, cachedPMTU int, ipv6 bool) int {
	if configured >= wireGuardMTUProbeMax {
		return configured
	}
	overhead := wireGuardOuterOverhead(ipv6)
	if cachedPMTU >= wireGuardMTUProbeMax+overhead {
		return wireGuardMTUProbeMax
	}
	candidate := cachedPMTU - overhead
	if candidate > wireGuardMTUProbeMax {
		candidate = wireGuardMTUProbeMax
	}
	candidate -= candidate % 4
	if candidate < configured {
		return configured
	}
	return candidate
}

// probeWireGuardMTU 返回这条隧道该用的 MTU：探测确认路径放得下就是 1420（或路径 MTU 允许
// 的更小值），否则就是 configured。任何一步失败都返回 configured。
func probeWireGuardMTU(ctx context.Context, endpointHost string, endpointPort int, configured int) int {
	endpointHost = strings.TrimSpace(endpointHost)
	if !wireGuardMTUProbeEnabledByEnv() || configured >= wireGuardMTUProbeMax || endpointHost == "" {
		return configured
	}
	if endpointPort <= 0 || endpointPort > 65535 || ctx.Err() != nil {
		return configured
	}
	addr, err := resolveWireGuardMTUProbeHost(ctx, endpointHost)
	if err != nil {
		return configured
	}
	pmtu, err := probeWireGuardPathMTU(ctx, addr, endpointPort)
	if err != nil {
		return configured
	}
	chosen := chooseWireGuardMTU(configured, pmtu, addr.Is6())
	if chosen != configured {
		logf("wireguard mtu probe endpoint=%s path_mtu=%d: mtu %d -> %d", net.JoinHostPort(addr.String(), strconv.Itoa(endpointPort)), pmtu, configured, chosen)
	}
	return chosen
}

func resolveWireGuardMTUProbeHost(ctx context.Context, host string) (netip.Addr, error) {
	if addr, err := netip.ParseAddr(host); err == nil {
		return addr.Unmap(), nil
	}
	addrs, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	if err != nil {
		return netip.Addr{}, err
	}
	// 和内核数据面解析端点一样，有 IPv4 就优先 IPv4，探测走的才是隧道真正走的路径。
	for _, addr := range addrs {
		if addr.Unmap().Is4() {
			return addr.Unmap(), nil
		}
	}
	for _, addr := range addrs {
		return addr, nil
	}
	return netip.Addr{}, errors.New("no address")
}

// probeWireGuardPathMTU 发一个 DF 探测包，等一小会儿让可能的 ICMP 回来，再读内核为这条
// 流缓存的路径 MTU。发送失败（EMSGSIZE 等）按探测不可用处理。
func probeWireGuardPathMTU(ctx context.Context, addr netip.Addr, port int) (int, error) {
	family := unix.AF_INET
	var sockaddr unix.Sockaddr = &unix.SockaddrInet4{Port: port, Addr: addr.As4()}
	if addr.Is6() {
		family = unix.AF_INET6
		sockaddr = &unix.SockaddrInet6{Port: port, Addr: addr.As16(), ZoneId: wireGuardZoneID(addr)}
	}
	fd, err := unix.Socket(family, unix.SOCK_DGRAM|unix.SOCK_CLOEXEC, unix.IPPROTO_UDP)
	if err != nil {
		return 0, os.NewSyscallError("socket", err)
	}
	defer unix.Close(fd)
	// DF：内核不许分片，装不下直接报 EMSGSIZE；路由器装不下回 ICMP，内核缓存到这条流的路径 MTU 上。
	if addr.Is6() {
		err = unix.SetsockoptInt(fd, unix.IPPROTO_IPV6, unix.IPV6_MTU_DISCOVER, unix.IPV6_PMTUDISC_DO)
	} else {
		err = unix.SetsockoptInt(fd, unix.IPPROTO_IP, unix.IP_MTU_DISCOVER, unix.IP_PMTUDISC_DO)
	}
	if err != nil {
		return 0, os.NewSyscallError("setsockopt", err)
	}
	if err := unix.Connect(fd, sockaddr); err != nil {
		return 0, os.NewSyscallError("connect", err)
	}
	// 满载内层包经 WireGuard 封装后的 UDP 载荷；首字节 0 不是合法消息类型，对端静默丢弃。
	payload := make([]byte, wireGuardMTUProbeMax+wireGuardPacketOverhead)
	if _, err := unix.Write(fd, payload); err != nil {
		return 0, os.NewSyscallError("send", err)
	}
	timer := time.NewTimer(wireGuardMTUProbeWait)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return 0, ctx.Err()
	case <-timer.C:
	}
	var pmtu int
	if addr.Is6() {
		pmtu, err = unix.GetsockoptInt(fd, unix.IPPROTO_IPV6, unix.IPV6_MTU)
	} else {
		pmtu, err = unix.GetsockoptInt(fd, unix.IPPROTO_IP, unix.IP_MTU)
	}
	if err != nil {
		return 0, os.NewSyscallError("getsockopt", err)
	}
	if pmtu <= 0 {
		return 0, errors.New("kernel reported no path mtu")
	}
	return pmtu, nil
}

func wireGuardZoneID(addr netip.Addr) uint32 {
	zone := addr.Zone()
	if zone == "" {
		return 0
	}
	iface, err := net.InterfaceByName(zone)
	if err != nil {
		return 0
	}
	return uint32(iface.Index)
}
