package main

import (
	"context"
	"fmt"
	"net"
	"sort"
	"strings"
	"sync"
	"testing"
)

// fakeDirectWireGuardPlane 假装是内核数据面：只记录放行 / 收回了哪些端口。
type fakeDirectWireGuardPlane struct {
	mu      sync.Mutex
	allowed []string
	revoked []string
	failTCP bool
}

func (plane *fakeDirectWireGuardPlane) kind() string { return wireGuardPlaneKernel }
func (plane *fakeDirectWireGuardPlane) configure(wireGuardSpec, bool, []string) error {
	return nil
}
func (plane *fakeDirectWireGuardPlane) dialTCP(context.Context, *net.TCPAddr) (net.Conn, error) {
	return nil, net.ErrClosed
}
func (plane *fakeDirectWireGuardPlane) dialUDP(*net.UDPAddr) (net.Conn, error) {
	return nil, net.ErrClosed
}
func (plane *fakeDirectWireGuardPlane) listenTCP(*net.TCPAddr) (net.Listener, error) {
	return nil, net.ErrClosed
}
func (plane *fakeDirectWireGuardPlane) listenUDP(*net.UDPAddr) (net.PacketConn, error) {
	return nil, net.ErrClosed
}
func (plane *fakeDirectWireGuardPlane) close() {}
func (plane *fakeDirectWireGuardPlane) allowInbound(proto string, port int) error {
	plane.mu.Lock()
	defer plane.mu.Unlock()
	if plane.failTCP && proto == "tcp" {
		return fmt.Errorf("allow %s/%d failed", proto, port)
	}
	plane.allowed = append(plane.allowed, fmt.Sprintf("%s/%d", proto, port))
	return nil
}
func (plane *fakeDirectWireGuardPlane) revokeInbound(proto string, port int) {
	plane.mu.Lock()
	defer plane.mu.Unlock()
	plane.revoked = append(plane.revoked, fmt.Sprintf("%s/%d", proto, port))
}

func (plane *fakeDirectWireGuardPlane) snapshot() (allowed, revoked []string) {
	plane.mu.Lock()
	defer plane.mu.Unlock()
	allowed = append([]string(nil), plane.allowed...)
	revoked = append([]string(nil), plane.revoked...)
	sort.Strings(allowed)
	sort.Strings(revoked)
	return allowed, revoked
}

func newTestDirectWireGuardRuntime(tunnelID int, plane wireGuardDataplane) *wireGuardRuntime {
	runtime := newTestWireGuardRuntimeState(tunnelID)
	runtime.spec.Address = "100.110.0.1"
	runtime.plane = plane
	runtime.direct = true
	runtime.directInbound = map[string]*wireGuardDirectInbound{}
	runtime.directInboundRefs = map[string]int{}
	runtime.refDirectInbound = map[string]map[string]struct{}{}
	runtime.peers = map[string]wireGuardPeerSpec{
		"exit-a": {ID: "exit-a", Address: "100.110.0.2"},
	}
	return runtime
}

func TestWireGuardDirectEntryDialsPeerAddressWithoutProxies(t *testing.T) {
	const tunnelID = 98601
	plane := &fakeDirectWireGuardPlane{}
	runtime := newTestDirectWireGuardRuntime(tunnelID, plane)
	setTestWireGuardRuntime(t, tunnelID, runtime)
	t.Cleanup(runtime.close)

	entry := testV2EntrySpec(tunnelID, 4401, 46401, "exit-a")
	entry.ExitPort = 25001
	entry.UDPExitPort = 25002
	prepared, err := prepareFXPWireGuard(entry, "direct-entry-test")
	if err != nil {
		t.Fatal(err)
	}
	if prepared.ExitHost != "100.110.0.2" || prepared.ExitPort != 25001 || prepared.UDPExitPort != 25002 {
		t.Fatalf("direct entry endpoint=%s:%d/%d, want the peer WireGuard address with the original ports", prepared.ExitHost, prepared.ExitPort, prepared.UDPExitPort)
	}
	runtime.mu.RLock()
	proxies := len(runtime.outbound)
	runtime.mu.RUnlock()
	if proxies != 0 {
		t.Fatalf("direct mode still started %d loopback proxies", proxies)
	}
	if !wireGuardFXPProxiesMatchConfig(entry, prepared, "direct-entry-test") {
		t.Fatal("prepared direct entry is not reported ready")
	}
	stale := prepared
	stale.ExitHost = "127.0.0.1"
	if wireGuardFXPProxiesMatchConfig(entry, stale, "direct-entry-test") {
		t.Fatal("a loopback-proxy config was accepted as a direct entry")
	}
	if _, err := prepareFXPWireGuard(testV2EntrySpec(tunnelID, 4402, 46402, "missing-peer"), "direct-entry-missing"); err == nil {
		t.Fatal("entry towards an unknown peer was prepared")
	}
}

func TestWireGuardDirectExitListensOnInterfaceAddressAndRevokesOnRelease(t *testing.T) {
	const tunnelID = 98602
	plane := &fakeDirectWireGuardPlane{}
	runtime := newTestDirectWireGuardRuntime(tunnelID, plane)
	setTestWireGuardRuntime(t, tunnelID, runtime)
	t.Cleanup(runtime.close)

	exit := fxpSpec{Role: "exit", TransportVersion: forwardXWireGuardVersion, TunnelID: tunnelID, ListenPort: 24001, UDPListenPort: 24002, Protocol: "both", Key: "exit-key"}
	const firstRef = "direct-exit-test:first"
	prepared, err := prepareFXPWireGuard(exit, firstRef)
	if err != nil {
		t.Fatal(err)
	}
	if prepared.ListenHost != "100.110.0.1" {
		t.Fatalf("direct exit listen host=%q, want the WireGuard interface address", prepared.ListenHost)
	}
	allowed, revoked := plane.snapshot()
	if strings.Join(allowed, ",") != "tcp/24001,udp/24002" || len(revoked) != 0 {
		t.Fatalf("firewall allow=%v revoke=%v after prepare", allowed, revoked)
	}
	if !wireGuardFXPProxiesMatchConfig(exit, prepared, firstRef) {
		t.Fatal("prepared direct exit is not reported ready")
	}
	loopback := prepared
	loopback.ListenHost = "127.0.0.1"
	if wireGuardFXPProxiesMatchConfig(exit, loopback, firstRef) {
		t.Fatal("a loopback listener was accepted as a direct exit")
	}

	// 替换进程先拿到同一端口对的引用，老进程释放时规则必须留着。
	const replacementRef = "direct-exit-test:replacement"
	if _, err := prepareFXPWireGuard(exit, replacementRef); err != nil {
		t.Fatal(err)
	}
	releaseWireGuardRuntimeInstanceRef(runtime, tunnelID, firstRef)
	if _, revoked := plane.snapshot(); len(revoked) != 0 {
		t.Fatalf("releasing the old process revoked the shared port allow: %v", revoked)
	}
	if !wireGuardFXPProxiesMatchConfig(exit, prepared, replacementRef) {
		t.Fatal("replacement reference lost the direct exit readiness")
	}
	releaseWireGuardRuntimeInstanceRef(runtime, tunnelID, replacementRef)
	if _, revoked := plane.snapshot(); strings.Join(revoked, ",") != "tcp/24001,udp/24002" {
		t.Fatalf("last release did not revoke the port allow: %v", revoked)
	}
	runtime.mu.RLock()
	remaining := len(runtime.directInbound)
	runtime.mu.RUnlock()
	if remaining != 0 {
		t.Fatalf("direct inbound records left after release: %d", remaining)
	}
}

func TestWireGuardDirectExitFirewallFailureRollsBack(t *testing.T) {
	const tunnelID = 98603
	plane := &fakeDirectWireGuardPlane{failTCP: true}
	runtime := newTestDirectWireGuardRuntime(tunnelID, plane)
	setTestWireGuardRuntime(t, tunnelID, runtime)
	t.Cleanup(runtime.close)

	exit := fxpSpec{Role: "exit", TransportVersion: forwardXWireGuardVersion, TunnelID: tunnelID, ListenPort: 24011, Protocol: "both", Key: "exit-key"}
	if _, err := prepareFXPWireGuard(exit, "direct-exit-failure"); err == nil {
		t.Fatal("exit was prepared although the firewall allow failed")
	}
	runtime.mu.RLock()
	remaining := len(runtime.directInbound)
	refs := runtime.refs["direct-exit-failure"]
	runtime.mu.RUnlock()
	if remaining != 0 || refs != 0 {
		t.Fatalf("failed prepare left inbound=%d refs=%d", remaining, refs)
	}
}

func TestWireGuardDirectFXPSupportedRequiresKernelPlaneAndNewFXP(t *testing.T) {
	if wireGuardDirectFXPSupportedForVersion(&wireGuardNetstackPlane{}, "2.2.132") {
		t.Fatal("netstack plane reported as direct-capable")
	}
	t.Setenv(wireGuardDirectEnvName, "0")
	if wireGuardDirectFXPSupportedForVersion(&fakeDirectWireGuardPlane{}, "2.2.132") {
		t.Fatal("direct mode ignored the kill switch")
	}
	t.Setenv(wireGuardDirectEnvName, "")
	for version, want := range map[string]bool{"2.2.131": false, "2.2.132": true, "2.3.0": true, "legacy": false, "unknown": false, "missing": false} {
		if got := wireGuardDirectFXPSupportedForVersion(&fakeDirectWireGuardPlane{}, version); got != want {
			t.Fatalf("fxp %s direct=%v, want %v", version, got, want)
		}
	}
}
