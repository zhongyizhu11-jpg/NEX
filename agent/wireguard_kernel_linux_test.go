//go:build linux

package main

import (
	"context"
	"errors"
	"net/netip"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"
)

func init() {
	// 运行时相关的测试一律走 netstack：CI 上没有 root，内核数据面本来就起不来，
	// 本机有模块时也不该在测试里真的建接口。内核数据面有自己的用例。
	wireGuardKernelPlaneDisabled = true
	// MTU 探测要往对端公网地址发包、解析域名，测试里直接用配置值。探测本身有自己的用例。
	wireGuardMTUProbeFunc = func(_ context.Context, _ string, _ int, configured int) int { return configured }
}

type fakeWireGuardKernelRunner struct {
	mu       sync.Mutex
	commands []string
	fail     map[string]error
}

func (runner *fakeWireGuardKernelRunner) run(args ...string) (string, error) {
	line := strings.Join(args, " ")
	runner.mu.Lock()
	runner.commands = append(runner.commands, line)
	runner.mu.Unlock()
	for prefix, err := range runner.fail {
		if strings.HasPrefix(line, prefix) {
			return "RTNETLINK answers: " + err.Error(), err
		}
	}
	return "", nil
}

func (runner *fakeWireGuardKernelRunner) lines() []string {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	return append([]string(nil), runner.commands...)
}

type fakeWireGuardKernelConfigurer struct {
	mu      sync.Mutex
	configs []wgtypes.Config
	names   []string
	closed  bool
	err     error
}

func (client *fakeWireGuardKernelConfigurer) ConfigureDevice(name string, cfg wgtypes.Config) error {
	client.mu.Lock()
	defer client.mu.Unlock()
	client.names = append(client.names, name)
	client.configs = append(client.configs, cfg)
	return client.err
}

func (client *fakeWireGuardKernelConfigurer) Close() error {
	client.mu.Lock()
	client.closed = true
	client.mu.Unlock()
	return nil
}

func testKernelWireGuardSpec(t *testing.T) wireGuardSpec {
	t.Helper()
	spec, err := normalizeWireGuardSpec(wireGuardSpec{
		TunnelID:   42,
		PrivateKey: strings.Repeat("11", 32),
		PublicKey:  strings.Repeat("22", 32),
		Address:    "10.77.0.1",
		ListenPort: 51820,
		MTU:        1380,
		Peers: []wireGuardPeerSpec{
			{ID: "exit", HostID: 2, PublicKey: strings.Repeat("33", 32), Address: "10.77.0.2", EndpointHost: "203.0.113.9", EndpointPort: 51821, PersistentKeepalive: 25},
			{ID: "relay", HostID: 3, PublicKey: strings.Repeat("44", 32), Address: "10.77.0.3"},
		},
	})
	if err != nil {
		t.Fatalf("normalize spec: %v", err)
	}
	return spec
}

func TestWireGuardKernelInterfaceNameFitsIFNAMSIZ(t *testing.T) {
	name := wireGuardKernelInterfaceName(2147483647)
	if len(name) > 15 {
		t.Fatalf("interface name %q exceeds IFNAMSIZ-1", name)
	}
	if wireGuardKernelInterfaceName(7) != "nexwg7" {
		t.Fatalf("unexpected name %q", wireGuardKernelInterfaceName(7))
	}
}

func TestWireGuardKernelConfigMirrorsDeviceConfig(t *testing.T) {
	spec := testKernelWireGuardSpec(t)
	cfg, err := wireGuardKernelConfig(spec, true, nil, nil)
	if err != nil {
		t.Fatalf("config: %v", err)
	}
	if cfg.PrivateKey == nil || cfg.PrivateKey.String() == "" {
		t.Fatal("private key missing")
	}
	if cfg.ListenPort == nil || *cfg.ListenPort != 51820 {
		t.Fatalf("listen port = %v", cfg.ListenPort)
	}
	if !cfg.ReplacePeers {
		t.Fatal("initial config must replace peers")
	}
	if len(cfg.Peers) != 2 {
		t.Fatalf("peers = %d", len(cfg.Peers))
	}
	exit := cfg.Peers[0]
	if exit.Remove || !exit.ReplaceAllowedIPs {
		t.Fatalf("exit peer flags = %+v", exit)
	}
	if len(exit.AllowedIPs) != 1 || exit.AllowedIPs[0].String() != "10.77.0.2/32" {
		t.Fatalf("exit allowed ips = %v", exit.AllowedIPs)
	}
	if exit.Endpoint == nil || exit.Endpoint.String() != "203.0.113.9:51821" {
		t.Fatalf("exit endpoint = %v", exit.Endpoint)
	}
	if exit.PersistentKeepaliveInterval == nil || *exit.PersistentKeepaliveInterval != 25*time.Second {
		t.Fatalf("exit keepalive = %v", exit.PersistentKeepaliveInterval)
	}
	relay := cfg.Peers[1]
	if relay.Endpoint != nil {
		t.Fatalf("relay must have no endpoint, got %v", relay.Endpoint)
	}
	if relay.PersistentKeepaliveInterval == nil || *relay.PersistentKeepaliveInterval != 0 {
		t.Fatalf("relay keepalive must be cleared, got %v", relay.PersistentKeepaliveInterval)
	}

	// 增量更新：删掉的对端先于保留的对端出现，带 Remove 标记。
	removed := []string{strings.Repeat("44", 32)}
	spec.Peers = spec.Peers[:1]
	update, err := wireGuardKernelConfig(spec, false, removed, nil)
	if err != nil {
		t.Fatalf("update config: %v", err)
	}
	if update.ReplacePeers {
		t.Fatal("update must not replace peers")
	}
	if len(update.Peers) != 2 || !update.Peers[0].Remove || update.Peers[0].PublicKey.String() != cfg.Peers[1].PublicKey.String() {
		t.Fatalf("update peers = %+v", update.Peers)
	}
}

func TestWireGuardKernelConfigResolvesHostnameEndpoints(t *testing.T) {
	spec := testKernelWireGuardSpec(t)
	spec.Peers[0].EndpointHost = "exit.example.test"
	resolved := ""
	cfg, err := wireGuardKernelConfig(spec, true, nil, func(host string) (netip.Addr, error) {
		resolved = host
		return netip.MustParseAddr("198.51.100.4"), nil
	})
	if err != nil {
		t.Fatalf("config: %v", err)
	}
	if resolved != "exit.example.test" {
		t.Fatalf("resolver got %q", resolved)
	}
	if cfg.Peers[0].Endpoint.String() != "198.51.100.4:51821" {
		t.Fatalf("endpoint = %v", cfg.Peers[0].Endpoint)
	}
	if _, err := wireGuardKernelConfig(spec, true, nil, nil); err == nil {
		t.Fatal("hostname endpoint without resolver must fail")
	}
}

func TestWireGuardKernelPlaneCreatesInterfaceRoutesAndUpdates(t *testing.T) {
	spec := testKernelWireGuardSpec(t)
	runner := &fakeWireGuardKernelRunner{}
	client := &fakeWireGuardKernelConfigurer{}
	plane, err := newWireGuardKernelPlaneWith(spec, runner.run, client)
	if err != nil {
		t.Fatalf("create plane: %v", err)
	}
	if plane.kind() != wireGuardPlaneKernel {
		t.Fatalf("kind = %q", plane.kind())
	}
	want := []string{
		"ip link del dev nexwg42",
		"ip link add dev nexwg42 type wireguard",
		"ip -4 address add 10.77.0.1/32 dev nexwg42",
		"ip link set dev nexwg42 mtu 1380 up",
		"ip -4 route replace 10.77.0.2/32 dev nexwg42",
		"ip -4 route replace 10.77.0.3/32 dev nexwg42",
	}
	got := runner.lines()
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("commands:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	if len(client.configs) != 1 || !client.configs[0].ReplacePeers || client.names[0] != "nexwg42" {
		t.Fatalf("initial configure = %+v names=%v", client.configs, client.names)
	}

	// 换对端：relay 走了，新来一个 backup；路由跟着删 / 加，对端配置带 Remove。
	next := spec
	next.Peers = []wireGuardPeerSpec{
		spec.Peers[0],
		{ID: "backup", HostID: 4, PublicKey: strings.Repeat("55", 32), Address: "10.77.0.4"},
	}
	next, err = normalizeWireGuardSpec(next)
	if err != nil {
		t.Fatalf("normalize next: %v", err)
	}
	_, _, _, removedKeys := wireGuardPeerUpdateSummary(spec, next)
	if err := wireGuardPlaneUpdate(plane, spec, next, removedKeys); err != nil {
		t.Fatalf("update: %v", err)
	}
	got = runner.lines()[len(want):]
	wantUpdate := []string{
		"ip -4 route del 10.77.0.3/32 dev nexwg42",
		"ip -4 route replace 10.77.0.4/32 dev nexwg42",
	}
	if strings.Join(got, "\n") != strings.Join(wantUpdate, "\n") {
		t.Fatalf("update commands:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(wantUpdate, "\n"))
	}
	if len(client.configs) != 2 || client.configs[1].ReplacePeers || len(client.configs[1].Peers) != 3 || !client.configs[1].Peers[0].Remove {
		t.Fatalf("update configure = %+v", client.configs[1])
	}

	plane.close()
	last := runner.lines()[len(runner.lines())-1]
	if last != "ip link del dev nexwg42" {
		t.Fatalf("close must delete the interface, last command %q", last)
	}
	if !client.closed {
		t.Fatal("close must release the wgctrl client")
	}
}

func TestWireGuardKernelPlaneRollsBackOnFailure(t *testing.T) {
	spec := testKernelWireGuardSpec(t)
	cases := map[string]struct {
		failPrefix string
		configErr  error
	}{
		"interface": {failPrefix: "ip link add"},
		"address":   {failPrefix: "ip -4 address add"},
		"up":        {failPrefix: "ip link set"},
		"route":     {failPrefix: "ip -4 route replace"},
		"configure": {configErr: errors.New("netlink: operation not supported")},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			runner := &fakeWireGuardKernelRunner{fail: map[string]error{}}
			if tc.failPrefix != "" {
				runner.fail[tc.failPrefix] = errors.New("Operation not supported")
			}
			client := &fakeWireGuardKernelConfigurer{err: tc.configErr}
			plane, err := newWireGuardKernelPlaneWith(spec, runner.run, client)
			if err == nil {
				plane.close()
				t.Fatal("expected failure")
			}
			lines := runner.lines()
			if name != "interface" && lines[len(lines)-1] != "ip link del dev nexwg42" {
				t.Fatalf("failure must delete the interface, commands:\n%s", strings.Join(lines, "\n"))
			}
			if name == "interface" && !strings.Contains(err.Error(), "no wireguard module") {
				t.Fatalf("unsupported link type should be reported as missing module, got %v", err)
			}
		})
	}
}

func TestNewWireGuardPlaneFallsBackToNetstack(t *testing.T) {
	previous := wireGuardKernelPlaneDisabled
	wireGuardKernelPlaneDisabled = false
	t.Setenv(wireGuardKernelEnvName, "")
	markWireGuardKernelAvailable()
	defer func() { wireGuardKernelPlaneDisabled = previous }()
	spec := testKernelWireGuardSpec(t)
	spec.ListenPort = 0
	plane, err := newWireGuardPlane(spec)
	if err != nil {
		t.Fatalf("plane: %v", err)
	}
	defer plane.close()
	switch plane.kind() {
	case wireGuardPlaneNetstack:
		wireGuardKernelStateMu.Lock()
		unavailable := !wireGuardKernelUnavailable.IsZero()
		wireGuardKernelStateMu.Unlock()
		if !unavailable {
			t.Fatal("falling back must remember that the kernel plane is unavailable")
		}
		if wireGuardKernelShouldTry() {
			t.Fatal("kernel plane must not be retried right after failing")
		}
	case wireGuardPlaneKernel:
		// 这台机器有 wireguard 模块而且是 root：真的建出了接口，测试结束会删掉。
	default:
		t.Fatalf("unexpected plane kind %q", plane.kind())
	}
}

func TestWireGuardKernelEnvSwitch(t *testing.T) {
	previous := wireGuardKernelPlaneDisabled
	wireGuardKernelPlaneDisabled = false
	defer func() { wireGuardKernelPlaneDisabled = previous }()
	markWireGuardKernelAvailable()
	t.Setenv(wireGuardKernelEnvName, "off")
	if wireGuardKernelShouldTry() {
		t.Fatal("env off must disable the kernel plane")
	}
	t.Setenv(wireGuardKernelEnvName, "")
	if !wireGuardKernelShouldTry() {
		t.Fatal("empty env must keep the kernel plane enabled")
	}
}

func TestNftRulesetFiltersInput(t *testing.T) {
	cases := []struct {
		name    string
		ruleset string
		want    bool
	}{
		{"empty", "", false},
		{"accept policy no drops", "table inet filter {\n\tchain input {\n\t\ttype filter hook input priority filter; policy accept;\n\t}\n\tchain forward {\n\t\ttype filter hook forward priority filter; policy drop;\n\t}\n}\n", false},
		{"drop policy", "table inet filter {\n\tchain input {\n\t\ttype filter hook input priority filter; policy drop;\n\t\tct state established,related accept\n\t\ttcp dport 22 accept\n\t}\n}\n", true},
		{"reject rule", "table inet filter {\n\tchain input {\n\t\ttype filter hook input priority 0; policy accept;\n\t\ttcp dport 1-65535 reject\n\t}\n}\n", true},
		{"drop only in output", "table inet filter {\n\tchain input {\n\t\ttype filter hook input priority 0; policy accept;\n\t}\n\tchain output {\n\t\ttype filter hook output priority 0; policy accept;\n\t\tudp dport 53 drop\n\t}\n}\n", false},
	}
	for _, tc := range cases {
		if got := nftRulesetFiltersInput(tc.ruleset); got != tc.want {
			t.Errorf("%s: got %v want %v", tc.name, got, tc.want)
		}
	}
}

func TestWireGuardKernelInboundBlockedOnlyWithoutIptables(t *testing.T) {
	origIptables, origNft := wireGuardKernelIptablesPresent, wireGuardKernelNftRuleset
	t.Cleanup(func() { wireGuardKernelIptablesPresent, wireGuardKernelNftRuleset = origIptables, origNft })
	dropping := "table inet filter {\n\tchain input {\n\t\ttype filter hook input priority 0; policy drop;\n\t}\n}\n"
	wireGuardKernelNftRuleset = func() (string, error) { return dropping, nil }

	wireGuardKernelIptablesPresent = func() bool { return true }
	if wireGuardKernelInboundBlocked() {
		t.Fatal("with iptables present the ports are allowed by rules, not blocked")
	}
	wireGuardKernelIptablesPresent = func() bool { return false }
	if !wireGuardKernelInboundBlocked() {
		t.Fatal("nftables-only host with a dropping input chain must fall back to the userspace plane")
	}
	wireGuardKernelNftRuleset = func() (string, error) { return "", errors.New("nft: not found") }
	if wireGuardKernelInboundBlocked() {
		t.Fatal("no nft and no iptables means nothing filters input")
	}
}
