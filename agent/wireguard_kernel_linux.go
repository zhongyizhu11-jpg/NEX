//go:build linux

package main

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.zx2c4.com/wireguard/wgctrl"
	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"
)

// 内核 WireGuard 数据面。
//
// 接口叫 nexwg<隧道 ID>，由 ip(8) 创建、配地址、设 MTU、拉起；私钥 / 端口 / 对端
// 通过 wgctrl（genetlink，不依赖 wg(8) 工具）下发；每个对端一条 /32 路由指向接口，
// 这样 Agent 用本机 WireGuard 地址做源地址拨号时内核会把包送进接口。
//
// 入站代理监听的端口会补一条 `-i nexwgN -p tcp/udp --dport P -j ACCEPT`：用户态
// 协议栈时对端的包根本不经过本机防火墙，换成内核接口以后 INPUT 链默认 DROP
// （ufw 之类）的主机会把它拦下来。只放行代理真正监听的端口，和以前暴露面一致。
//
// 创建任何一步失败都整体回滚（删接口）并返回错误，调用方退回 wireguard-go。

const (
	wireGuardKernelIfacePrefix = "nexwg"
	wireGuardKernelCommandWait = 10 * time.Second
	wireGuardKernelDNSTimeout  = 5 * time.Second
)

// wireGuardKernelConfigurer 是 wgctrl 客户端里本文件用到的那一小部分，测试用假的替换。
type wireGuardKernelConfigurer interface {
	ConfigureDevice(name string, cfg wgtypes.Config) error
	Close() error
}

// wireGuardKernelCommandRunner 跑一条 ip / iptables 命令，返回合并后的输出。
type wireGuardKernelCommandRunner func(args ...string) (string, error)

type wireGuardKernelPlane struct {
	tunnelID int
	name     string
	address  netip.Addr
	mtu      int
	run      wireGuardKernelCommandRunner
	client   wireGuardKernelConfigurer

	mu     sync.Mutex
	routes map[string]string // peer public key -> /32 address with a route
	closed bool
}

func wireGuardKernelInterfaceName(tunnelID int) string {
	// IFNAMSIZ 是 16，含结尾 0：前缀 5 位 + 最多 10 位数字。
	return wireGuardKernelIfacePrefix + strconv.Itoa(tunnelID)
}

func runWireGuardKernelCommand(args ...string) (string, error) {
	if len(args) == 0 {
		return "", errors.New("empty command")
	}
	ctx, cancel := context.WithTimeout(context.Background(), wireGuardKernelCommandWait)
	defer cancel()
	out, err := exec.CommandContext(ctx, args[0], args[1:]...).CombinedOutput()
	text := strings.TrimSpace(string(out))
	if err != nil {
		if text != "" {
			return text, fmt.Errorf("%s: %s", strings.Join(args, " "), text)
		}
		return text, fmt.Errorf("%s: %w", strings.Join(args, " "), err)
	}
	return text, nil
}

func newWireGuardKernelPlane(spec wireGuardSpec) (*wireGuardKernelPlane, error) {
	if wireGuardKernelInboundBlocked() {
		return nil, errors.New("nftables input chain filters traffic and iptables is unavailable to allow the tunnel ports")
	}
	client, err := wgctrl.New()
	if err != nil {
		return nil, fmt.Errorf("open wireguard control: %w", err)
	}
	plane, err := newWireGuardKernelPlaneWith(spec, runWireGuardKernelCommand, client)
	if err != nil {
		_ = client.Close()
		return nil, err
	}
	return plane, nil
}

func newWireGuardKernelPlaneWith(spec wireGuardSpec, run wireGuardKernelCommandRunner, client wireGuardKernelConfigurer) (*wireGuardKernelPlane, error) {
	address, err := netip.ParseAddr(spec.Address)
	if err != nil || !address.Is4() {
		return nil, fmt.Errorf("wireguard address %q is invalid", spec.Address)
	}
	plane := &wireGuardKernelPlane{
		tunnelID: spec.TunnelID,
		name:     wireGuardKernelInterfaceName(spec.TunnelID),
		address:  address,
		mtu:      spec.MTU,
		run:      run,
		client:   client,
		routes:   map[string]string{},
	}
	// 上一次 Agent 没来得及清理的同名接口先删掉，不然 add 会报 File exists。
	_, _ = run("ip", "link", "del", "dev", plane.name)
	if out, err := run("ip", "link", "add", "dev", plane.name, "type", "wireguard"); err != nil {
		return nil, fmt.Errorf("create kernel wireguard interface: %w", wireGuardKernelCommandError(err, out))
	}
	if err := plane.configure(spec, true, nil); err != nil {
		plane.teardown()
		return nil, err
	}
	if _, err := run("ip", "-4", "address", "add", address.String()+"/32", "dev", plane.name); err != nil {
		plane.teardown()
		return nil, fmt.Errorf("assign wireguard address: %w", err)
	}
	if _, err := run("ip", "link", "set", "dev", plane.name, "mtu", strconv.Itoa(spec.MTU), "up"); err != nil {
		plane.teardown()
		return nil, fmt.Errorf("bring up wireguard interface: %w", err)
	}
	if err := plane.syncRoutes(spec); err != nil {
		plane.teardown()
		return nil, err
	}
	return plane, nil
}

func wireGuardKernelCommandError(err error, output string) error {
	lower := strings.ToLower(output)
	if strings.Contains(lower, "not supported") || strings.Contains(lower, "unknown") {
		return fmt.Errorf("kernel has no wireguard module: %w", err)
	}
	return err
}

func (plane *wireGuardKernelPlane) kind() string { return wireGuardPlaneKernel }

// wireGuardKernelConfig 把隧道规格翻译成 wgctrl 的配置；和 wireGuardDeviceConfig
// 给 wireguard-go 的 UAPI 文本一一对应。
func wireGuardKernelConfig(spec wireGuardSpec, replacePeers bool, removedKeys []string, resolve func(host string) (netip.Addr, error)) (wgtypes.Config, error) {
	privateKey, err := wireGuardKernelKey(spec.PrivateKey)
	if err != nil {
		return wgtypes.Config{}, fmt.Errorf("wireguard private key: %w", err)
	}
	listenPort := spec.ListenPort
	cfg := wgtypes.Config{
		PrivateKey:   &privateKey,
		ListenPort:   &listenPort,
		ReplacePeers: replacePeers,
	}
	if !replacePeers {
		for _, publicKey := range removedKeys {
			key, err := wireGuardKernelKey(publicKey)
			if err != nil {
				return wgtypes.Config{}, fmt.Errorf("wireguard removed peer key: %w", err)
			}
			cfg.Peers = append(cfg.Peers, wgtypes.PeerConfig{PublicKey: key, Remove: true})
		}
	}
	for _, peer := range spec.Peers {
		key, err := wireGuardKernelKey(peer.PublicKey)
		if err != nil {
			return wgtypes.Config{}, fmt.Errorf("wireguard peer %s public key: %w", peer.ID, err)
		}
		peerAddress, err := netip.ParseAddr(peer.Address)
		if err != nil {
			return wgtypes.Config{}, fmt.Errorf("wireguard peer %s address %q is invalid", peer.ID, peer.Address)
		}
		keepalive := time.Duration(peer.PersistentKeepalive) * time.Second
		peerConfig := wgtypes.PeerConfig{
			PublicKey:                   key,
			ReplaceAllowedIPs:           true,
			AllowedIPs:                  []net.IPNet{{IP: peerAddress.AsSlice(), Mask: net.CIDRMask(32, 32)}},
			PersistentKeepaliveInterval: &keepalive,
		}
		if peer.EndpointHost != "" && peer.EndpointPort > 0 {
			endpoint, err := netip.ParseAddr(strings.Trim(peer.EndpointHost, "[]"))
			if err != nil {
				if resolve == nil {
					return wgtypes.Config{}, fmt.Errorf("wireguard peer %s endpoint %q is not an ip", peer.ID, peer.EndpointHost)
				}
				endpoint, err = resolve(peer.EndpointHost)
				if err != nil {
					return wgtypes.Config{}, fmt.Errorf("wireguard peer %s endpoint %q: %w", peer.ID, peer.EndpointHost, err)
				}
			}
			peerConfig.Endpoint = net.UDPAddrFromAddrPort(netip.AddrPortFrom(endpoint.Unmap(), uint16(peer.EndpointPort)))
		}
		cfg.Peers = append(cfg.Peers, peerConfig)
	}
	return cfg, nil
}

func wireGuardKernelKey(value string) (wgtypes.Key, error) {
	raw, err := hex.DecodeString(strings.TrimSpace(value))
	if err != nil || len(raw) != wgtypes.KeyLen {
		return wgtypes.Key{}, errors.New("expected 32-byte hex key")
	}
	return wgtypes.NewKey(raw)
}

func resolveWireGuardEndpointHost(host string) (netip.Addr, error) {
	ctx, cancel := context.WithTimeout(context.Background(), wireGuardKernelDNSTimeout)
	defer cancel()
	addrs, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	if err != nil {
		return netip.Addr{}, err
	}
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

func (plane *wireGuardKernelPlane) configure(spec wireGuardSpec, replacePeers bool, removedKeys []string) error {
	cfg, err := wireGuardKernelConfig(spec, replacePeers, removedKeys, resolveWireGuardEndpointHost)
	if err != nil {
		return err
	}
	if err := plane.client.ConfigureDevice(plane.name, cfg); err != nil {
		return fmt.Errorf("configure kernel wireguard %s: %w", plane.name, err)
	}
	if replacePeers {
		return nil
	}
	return plane.syncRoutes(spec)
}

// syncRoutes 让「每个对端一条 /32 路由」和当前对端表一致。
func (plane *wireGuardKernelPlane) syncRoutes(spec wireGuardSpec) error {
	wanted := map[string]string{}
	for _, peer := range spec.Peers {
		wanted[peer.PublicKey] = peer.Address
	}
	plane.mu.Lock()
	defer plane.mu.Unlock()
	if plane.closed {
		return net.ErrClosed
	}
	stale := make([]string, 0)
	for publicKey, address := range plane.routes {
		if wanted[publicKey] != address {
			stale = append(stale, publicKey)
		}
	}
	sort.Strings(stale)
	for _, publicKey := range stale {
		_, _ = plane.run("ip", "-4", "route", "del", plane.routes[publicKey]+"/32", "dev", plane.name)
		delete(plane.routes, publicKey)
	}
	keys := make([]string, 0, len(wanted))
	for publicKey := range wanted {
		keys = append(keys, publicKey)
	}
	sort.Strings(keys)
	for _, publicKey := range keys {
		address := wanted[publicKey]
		if plane.routes[publicKey] == address {
			continue
		}
		if _, err := plane.run("ip", "-4", "route", "replace", address+"/32", "dev", plane.name); err != nil {
			return fmt.Errorf("add wireguard peer route: %w", err)
		}
		plane.routes[publicKey] = address
	}
	return nil
}

func (plane *wireGuardKernelPlane) localTCPAddr() *net.TCPAddr {
	return &net.TCPAddr{IP: plane.address.AsSlice()}
}

func (plane *wireGuardKernelPlane) dialTCP(ctx context.Context, addr *net.TCPAddr) (net.Conn, error) {
	dialer := net.Dialer{LocalAddr: plane.localTCPAddr()}
	return dialer.DialContext(ctx, "tcp4", addr.String())
}

func (plane *wireGuardKernelPlane) dialUDP(addr *net.UDPAddr) (net.Conn, error) {
	return net.DialUDP("udp4", &net.UDPAddr{IP: plane.address.AsSlice()}, addr)
}

var wireGuardKernelIptablesPresent = func() bool {
	_, err := exec.LookPath("iptables")
	return err == nil
}

var wireGuardKernelNftRuleset = func() (string, error) {
	return runWireGuardKernelCommand("nft", "list", "ruleset")
}

// wireGuardKernelInboundBlocked 判断内核数据面的入站代理端口会不会被防火墙挡住而又没法放行：
// 有 iptables 就由 allowInbound 插放行规则；没有 iptables 时只能看 nftables 的 input 链，
// 里面有 drop / reject 就不用内核数据面（wireguard-go 的包不过 INPUT，不受影响）。
func wireGuardKernelInboundBlocked() bool {
	if wireGuardKernelIptablesPresent() {
		return false
	}
	ruleset, err := wireGuardKernelNftRuleset()
	if err != nil {
		return false
	}
	return nftRulesetFiltersInput(ruleset)
}

// nftRulesetFiltersInput 在 `nft list ruleset` 的输出里找 hook input 的链，
// 链策略是 drop 或者链里有 drop / reject 规则就算会拦包。
func nftRulesetFiltersInput(ruleset string) bool {
	inInput := false
	for _, raw := range strings.Split(ruleset, "\n") {
		line := strings.TrimSpace(raw)
		if strings.Contains(line, "hook input") {
			inInput = true
		}
		if !inInput {
			continue
		}
		if line == "}" {
			inInput = false
			continue
		}
		for _, field := range strings.FieldsFunc(line, func(r rune) bool { return r == ' ' || r == ';' || r == '\t' }) {
			if field == "drop" || field == "reject" {
				return true
			}
		}
	}
	return false
}

// wireGuardKernelFirewallRule 是放行入站代理端口的 iptables 规则（不含表 / 动作前缀）。
func wireGuardKernelFirewallRule(name string, proto string, port int) string {
	return "INPUT -i " + name + " -p " + proto + " --dport " + strconv.Itoa(port) + " -m comment --comment nex-wg-" + name + " -j ACCEPT"
}

func (plane *wireGuardKernelPlane) allowInbound(proto string, port int) error {
	if !wireGuardKernelIptablesPresent() {
		// 纯 nftables 主机：建接口前已确认 input 链不拦包（见 wireGuardKernelInboundBlocked）。
		return nil
	}
	rule := wireGuardKernelFirewallRule(plane.name, proto, port)
	bin := iptablesAgentBin("iptables")
	if !runIptablesShellQuiet(bin + " -C " + rule + " 2>/dev/null || " + bin + " -I " + rule) {
		return fmt.Errorf("allow %s/%d on %s in iptables INPUT failed", proto, port, plane.name)
	}
	return nil
}

func (plane *wireGuardKernelPlane) revokeInbound(proto string, port int) {
	rule := wireGuardKernelFirewallRule(plane.name, proto, port)
	bin := iptablesAgentBin("iptables")
	_ = runIptablesShellQuiet("command -v iptables >/dev/null 2>&1 || exit 0; while " + bin + " -C " + rule + " 2>/dev/null; do " + bin + " -D " + rule + " || break; done")
}

type wireGuardKernelListener struct {
	net.Listener
	release func()
	once    sync.Once
}

func (listener *wireGuardKernelListener) Close() error {
	err := listener.Listener.Close()
	listener.once.Do(listener.release)
	return err
}

type wireGuardKernelPacketConn struct {
	net.PacketConn
	release func()
	once    sync.Once
}

func (conn *wireGuardKernelPacketConn) Close() error {
	err := conn.PacketConn.Close()
	conn.once.Do(conn.release)
	return err
}

func (plane *wireGuardKernelPlane) listenTCP(addr *net.TCPAddr) (net.Listener, error) {
	listener, err := net.ListenTCP("tcp4", addr)
	if err != nil {
		return nil, err
	}
	port := listener.Addr().(*net.TCPAddr).Port
	if err := plane.allowInbound("tcp", port); err != nil {
		_ = listener.Close()
		return nil, err
	}
	return &wireGuardKernelListener{Listener: listener, release: func() { plane.revokeInbound("tcp", port) }}, nil
}

func (plane *wireGuardKernelPlane) listenUDP(addr *net.UDPAddr) (net.PacketConn, error) {
	conn, err := net.ListenUDP("udp4", addr)
	if err != nil {
		return nil, err
	}
	tuneWireGuardUDPConn(conn, wireGuardUDPProxyBufferBytes)
	port := conn.LocalAddr().(*net.UDPAddr).Port
	if err := plane.allowInbound("udp", port); err != nil {
		_ = conn.Close()
		return nil, err
	}
	return &wireGuardKernelPacketConn{PacketConn: conn, release: func() { plane.revokeInbound("udp", port) }}, nil
}

// teardown 删接口：地址、路由跟着接口一起消失。端口放行规则由各监听的 Close 收回；
// 接口没了以后残留的规则也匹配不到任何包。
func (plane *wireGuardKernelPlane) teardown() {
	plane.mu.Lock()
	plane.closed = true
	plane.routes = map[string]string{}
	plane.mu.Unlock()
	_, _ = plane.run("ip", "link", "del", "dev", plane.name)
	if plane.client != nil {
		_ = plane.client.Close()
	}
}

func (plane *wireGuardKernelPlane) close() {
	plane.teardown()
}
