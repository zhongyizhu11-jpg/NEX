package main

import (
	"context"
	"fmt"
	"net"
	"net/netip"
	"os"
	"strings"
	"sync"
	"time"

	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun"
)

// wireGuardDataplane 是 V2 隧道的数据面：WireGuard 设备本身加上在它的地址上拨号 /
// 监听的能力。有两种实现：
//
//   - wireGuardKernelPlane（wireguard_kernel_linux.go）：内核 WireGuard 接口。加解密、
//     TCP 栈、拥塞控制全在内核里，BBR 和安装脚本调的缓冲都生效，Agent 进程不再
//     逐包搬运。
//   - wireGuardNetstackPlane（本文件）：wireguard-go + gVisor 用户态协议栈，也就是
//     2.3.425 以前唯一的实现。内核没有 wireguard 模块、不是 root、容器里拿不到
//     NET_ADMIN 时自动退回这条。
//
// 运行时（wireguard_runtime.go）只认这个接口，两条数据面对上层的行为一致。
type wireGuardDataplane interface {
	// kind 是面板上展示的数据面种类："kernel" 或 "netstack"。
	kind() string
	// configure 下发私钥 / 监听端口 / 对端列表。replacePeers 为 true 时整表替换
	// （首次创建），否则按 removedKeys 删对端、其余对端增量更新。
	configure(spec wireGuardSpec, replacePeers bool, removedKeys []string) error
	dialTCP(ctx context.Context, addr *net.TCPAddr) (net.Conn, error)
	dialUDP(addr *net.UDPAddr) (net.Conn, error)
	listenTCP(addr *net.TCPAddr) (net.Listener, error)
	listenUDP(addr *net.UDPAddr) (net.PacketConn, error)
	close()
}

const (
	wireGuardPlaneKernel   = "kernel"
	wireGuardPlaneNetstack = "netstack"
	// wireGuardKernelEnvName 置为 0 / off / false 时不再尝试内核 WireGuard，一律走
	// wireguard-go。给内核模块有问题的主机留的开关。
	wireGuardKernelEnvName = "NEX_WIREGUARD_KERNEL"
	// wireGuardKernelRetryAfter 是内核数据面创建失败后多久再试一次。失败多半是
	// 模块不存在或权限不够，不会很快变，没必要每次起隧道都 exec 一遍 ip。
	wireGuardKernelRetryAfter = 10 * time.Minute
)

var (
	// wireGuardKernelPlaneDisabled 置位后 newWireGuardPlane 直接用 netstack，测试
	// 用它保证确定性（非 root 的 CI 上 ip link add 本来也会失败）。
	wireGuardKernelPlaneDisabled bool

	wireGuardKernelStateMu     sync.Mutex
	wireGuardKernelUnavailable time.Time
	wireGuardKernelLastReason  string
)

func wireGuardKernelEnabledByEnv() bool {
	value := strings.ToLower(strings.TrimSpace(os.Getenv(wireGuardKernelEnvName)))
	switch value {
	case "0", "off", "false", "no", "disable", "disabled":
		return false
	}
	return true
}

// wireGuardKernelShouldTry 判断这次创建要不要先试内核数据面。
func wireGuardKernelShouldTry() bool {
	if wireGuardKernelPlaneDisabled || !wireGuardKernelEnabledByEnv() {
		return false
	}
	wireGuardKernelStateMu.Lock()
	defer wireGuardKernelStateMu.Unlock()
	if wireGuardKernelUnavailable.IsZero() {
		return true
	}
	return time.Since(wireGuardKernelUnavailable) >= wireGuardKernelRetryAfter
}

func markWireGuardKernelUnavailable(reason string) {
	wireGuardKernelStateMu.Lock()
	wireGuardKernelUnavailable = time.Now()
	wireGuardKernelLastReason = reason
	wireGuardKernelStateMu.Unlock()
}

func markWireGuardKernelAvailable() {
	wireGuardKernelStateMu.Lock()
	wireGuardKernelUnavailable = time.Time{}
	wireGuardKernelLastReason = ""
	wireGuardKernelStateMu.Unlock()
}

// newWireGuardPlane 先试内核 WireGuard，不行就退回 wireguard-go。返回的数据面已经
// 配好对端并处于 up 状态。
func newWireGuardPlane(spec wireGuardSpec) (wireGuardDataplane, error) {
	if wireGuardKernelShouldTry() {
		plane, err := newWireGuardKernelPlane(spec)
		if err == nil {
			markWireGuardKernelAvailable()
			return plane, nil
		}
		markWireGuardKernelUnavailable(err.Error())
		logf("wireguard tunnel=%d kernel dataplane unavailable, falling back to userspace: %v", spec.TunnelID, err)
	}
	plane, err := newWireGuardNetstackPlane(spec)
	if err != nil {
		return nil, err
	}
	return plane, nil
}

// wireGuardNetstackPlane 是 wireguard-go + gVisor 用户态协议栈的数据面。
type wireGuardNetstackPlane struct {
	tunDevice tun.Device
	netstack  *wireGuardNetTUN
	device    *device.Device
}

func newWireGuardNetstackPlane(spec wireGuardSpec) (*wireGuardNetstackPlane, error) {
	address := netip.MustParseAddr(spec.Address)
	tnet, err := newWireGuardNetTUN(address, spec.MTU)
	if err != nil {
		return nil, fmt.Errorf("create wireguard netstack: %w", err)
	}
	var tunDevice tun.Device = tnet
	if err := tuneWireGuardNetstack(tnet.stack); err != nil {
		logf("wireguard tunnel=%d netstack tuning skipped: %v", spec.TunnelID, err)
	}
	logger := &device.Logger{
		Verbosef: device.DiscardLogf,
		Errorf: func(format string, args ...any) {
			logf("wireguard tunnel=%d "+format, append([]any{spec.TunnelID}, args...)...)
		},
	}
	dev := device.NewDevice(tunDevice, conn.NewDefaultBind(), logger)
	if err := dev.IpcSet(wireGuardDeviceConfig(spec, true, nil)); err != nil {
		dev.Close()
		return nil, fmt.Errorf("configure wireguard: %w", err)
	}
	if err := dev.Up(); err != nil {
		dev.Close()
		return nil, fmt.Errorf("start wireguard: %w", err)
	}
	return &wireGuardNetstackPlane{tunDevice: tunDevice, netstack: tnet, device: dev}, nil
}

func (plane *wireGuardNetstackPlane) kind() string { return wireGuardPlaneNetstack }

func (plane *wireGuardNetstackPlane) configure(spec wireGuardSpec, replacePeers bool, removedKeys []string) error {
	if replacePeers {
		return plane.device.IpcSet(wireGuardDeviceConfig(spec, true, nil))
	}
	return plane.device.IpcSet(wireGuardDeviceConfig(spec, false, removedKeys))
}

// configureUpdate 和 wireGuardDeviceUpdateConfig 一样：监听端口变了要一起下发。
func (plane *wireGuardNetstackPlane) configureUpdate(previous, next wireGuardSpec, removedKeys []string) error {
	return plane.device.IpcSet(wireGuardDeviceUpdateConfig(previous, next, removedKeys))
}

func (plane *wireGuardNetstackPlane) dialTCP(ctx context.Context, addr *net.TCPAddr) (net.Conn, error) {
	return plane.netstack.DialContextTCP(ctx, addr)
}

func (plane *wireGuardNetstackPlane) dialUDP(addr *net.UDPAddr) (net.Conn, error) {
	return plane.netstack.DialUDP(nil, addr)
}

func (plane *wireGuardNetstackPlane) listenTCP(addr *net.TCPAddr) (net.Listener, error) {
	return plane.netstack.ListenTCP(addr)
}

func (plane *wireGuardNetstackPlane) listenUDP(addr *net.UDPAddr) (net.PacketConn, error) {
	return plane.netstack.ListenUDP(addr)
}

func (plane *wireGuardNetstackPlane) close() {
	if plane.device != nil {
		plane.device.Close()
	} else if plane.tunDevice != nil {
		_ = plane.tunDevice.Close()
	}
}

// wireGuardPlaneUpdate 把一次对端更新下发到数据面。netstack 数据面要知道上一份
// 规格（监听端口变化走 UAPI 的 listen_port），内核数据面每次都整体下发端口，不需要。
func wireGuardPlaneUpdate(plane wireGuardDataplane, previous, next wireGuardSpec, removedKeys []string) error {
	if netstackPlane, ok := plane.(*wireGuardNetstackPlane); ok {
		return netstackPlane.configureUpdate(previous, next, removedKeys)
	}
	return plane.configure(next, false, removedKeys)
}
