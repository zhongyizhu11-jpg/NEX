package main

import (
	"errors"
	"fmt"
	"net"
	"os"
	"strings"
)

/*
V2 隧道上 FXP 直接走 WireGuard 接口。

2.3.426 把 V2 的数据面换成内核 WireGuard 以后，FXP 和接口之间还隔着 Agent 的两段回环代理：
出口上是 nexwg 地址:端口 → Agent → 127.0.0.1:端口 → FXP，入口上是 FXP → 127.0.0.1:随机端口 →
Agent → 对端 nexwg 地址:端口。这两段是给 wireguard-go + gVisor 用户态协议栈留的（那种数据面
没有内核 socket，只能由 Agent 代为拨号 / 监听），内核接口上它们纯属多余：每条连接多两个 socket、
两个 goroutine、一次拷贝，而且 FXP 按 socket 设的 BBR、pacing、重传采样全落在回环 socket 上，
真正走公网的那条 TCP 反而没调。

所以内核数据面上改成「直连」：出口 FXP 直接监听在本机 WireGuard 地址上，入口 FXP 直接拨对端的
WireGuard 地址。内核按 /32 路由把包送进 nexwg，源地址自然就是接口地址，不用再绑。Agent 只剩一件
事：像以前给代理放行那样，在 INPUT 链给 FXP 监听的端口补一条 `-i nexwgN` 的 ACCEPT。

用户态数据面（内核没有 wireguard 模块、不是 root）还是老路子。FXP 的监听地址以前只许回环，
2.2.132 起才接受接口地址，所以装着更旧的 FXP 时也走老路子，升级完 FXP 自动换过来。
NEX_WIREGUARD_DIRECT=0 可以强制回到回环代理。
*/

const (
	// minDirectWireGuardFXPVersion 是第一个接受非回环监听地址的 FXP 版本。
	minDirectWireGuardFXPVersion = "2.2.132"
	wireGuardDirectEnvName       = "NEX_WIREGUARD_DIRECT"
)

// wireGuardInboundAllower 是数据面里「给端口放行防火墙」的那一小部分；内核数据面实现它。
type wireGuardInboundAllower interface {
	allowInbound(proto string, port int) error
	revokeInbound(proto string, port int)
}

// wireGuardDirectInbound 记录一个 FXP 直接监听在 WireGuard 地址上的端口对，以及为它放行的规则。
type wireGuardDirectInbound struct {
	key     string
	tcpPort int
	udpPort int
}

func (inbound *wireGuardDirectInbound) revoke(plane wireGuardDataplane) {
	allower, ok := plane.(wireGuardInboundAllower)
	if !ok || inbound == nil {
		return
	}
	allower.revokeInbound("tcp", inbound.tcpPort)
	allower.revokeInbound("udp", inbound.udpPort)
}

func wireGuardDirectEnabledByEnv() bool {
	value := strings.ToLower(strings.TrimSpace(os.Getenv(wireGuardDirectEnvName)))
	switch value {
	case "0", "off", "false", "no", "disable", "disabled":
		return false
	}
	return true
}

// wireGuardDirectFXPSupported 判断这条隧道能不能让 FXP 直接用 WireGuard 接口：
// 内核数据面、没被环境变量关掉、装着的 FXP 认得接口地址。
func wireGuardDirectFXPSupported(plane wireGuardDataplane) bool {
	if plane == nil || plane.kind() != wireGuardPlaneKernel || !wireGuardDirectEnabledByEnv() {
		return false
	}
	return wireGuardDirectFXPSupportedForVersion(plane, installedFXPVersion())
}

func wireGuardDirectFXPSupportedForVersion(plane wireGuardDataplane, fxpVersion string) bool {
	if plane == nil || plane.kind() != wireGuardPlaneKernel || !wireGuardDirectEnabledByEnv() {
		return false
	}
	if _, ok := plane.(wireGuardInboundAllower); !ok {
		return false
	}
	if !fxpSemverPattern.MatchString(fxpVersion) {
		return false
	}
	return compareFXPVersions(fxpVersion, minDirectWireGuardFXPVersion) >= 0
}

func (runtime *wireGuardRuntime) directFXP() bool {
	runtime.mu.RLock()
	defer runtime.mu.RUnlock()
	return runtime.direct && !runtime.closed
}

// directPeerEndpoint 返回入口 FXP 该直接拨的对端地址：对端的 WireGuard 地址，端口原样。
func (runtime *wireGuardRuntime) directPeerEndpoint(peerID string, tcpPort, udpPort int) (string, int, int, error) {
	peerID = strings.TrimSpace(peerID)
	if peerID == "" || tcpPort <= 0 || tcpPort > 65535 || udpPort <= 0 || udpPort > 65535 {
		return "", 0, 0, errors.New("wireguard direct endpoint target is invalid")
	}
	address, err := runtime.peerAddress(peerID)
	if err != nil {
		return "", 0, 0, err
	}
	return address.String(), tcpPort, udpPort, nil
}

// ensureDirectInbound 给出口 / 中转 FXP 监听的端口放行 nexwg 上的入站，按引用计数记着，
// 最后一个引用释放时收回规则。和 ensureInboundProxy 的记账方式一致。
func (runtime *wireGuardRuntime) ensureDirectInbound(refID string, tcpPort, udpPort int) error {
	refID = strings.TrimSpace(refID)
	if udpPort <= 0 {
		udpPort = tcpPort
	}
	if tcpPort <= 0 || tcpPort > 65535 || udpPort <= 0 || udpPort > 65535 {
		return errors.New("wireguard direct inbound port is invalid")
	}
	if refID == "" {
		return errors.New("wireguard direct inbound reference is required")
	}
	key := fmt.Sprintf("%d:%d", tcpPort, udpPort)
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.closed {
		return net.ErrClosed
	}
	if runtime.refs[refID] <= 0 {
		return fmt.Errorf("wireguard runtime reference %q is not registered", refID)
	}
	if runtime.directInbound == nil {
		runtime.directInbound = map[string]*wireGuardDirectInbound{}
	}
	if runtime.directInboundRefs == nil {
		runtime.directInboundRefs = map[string]int{}
	}
	if runtime.refDirectInbound == nil {
		runtime.refDirectInbound = map[string]map[string]struct{}{}
	}
	if runtime.directInbound[key] == nil {
		if allower, ok := runtime.plane.(wireGuardInboundAllower); ok {
			if err := allower.allowInbound("tcp", tcpPort); err != nil {
				return err
			}
			if err := allower.allowInbound("udp", udpPort); err != nil {
				allower.revokeInbound("tcp", tcpPort)
				return err
			}
		}
		runtime.directInbound[key] = &wireGuardDirectInbound{key: key, tcpPort: tcpPort, udpPort: udpPort}
		logf("wireguard direct inbound allowed tunnel=%d address=%s tcp=%d udp=%d", runtime.spec.TunnelID, runtime.spec.Address, tcpPort, udpPort)
	}
	keys := runtime.refDirectInbound[refID]
	if keys == nil {
		keys = map[string]struct{}{}
		runtime.refDirectInbound[refID] = keys
	}
	if _, exists := keys[key]; !exists {
		keys[key] = struct{}{}
		runtime.directInboundRefs[key]++
	}
	return nil
}

// releaseDirectInboundLocked 在引用 id 消失时减计数，返回已经没人用、要收回放行规则的端口对。
// 调用方持有 runtime.mu。
func (runtime *wireGuardRuntime) releaseDirectInboundLocked(id string) []*wireGuardDirectInbound {
	var revoke []*wireGuardDirectInbound
	for key := range runtime.refDirectInbound[id] {
		if runtime.directInboundRefs[key] <= 1 {
			delete(runtime.directInboundRefs, key)
			if inbound := runtime.directInbound[key]; inbound != nil {
				delete(runtime.directInbound, key)
				revoke = append(revoke, inbound)
			}
		} else {
			runtime.directInboundRefs[key]--
		}
	}
	delete(runtime.refDirectInbound, id)
	return revoke
}
