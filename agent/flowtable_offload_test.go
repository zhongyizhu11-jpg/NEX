package main

import (
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
)

type fakeConntrackSource struct {
	mu         sync.Mutex
	flows      []conntrackFlow
	dumpErr    error
	subErr     error
	onDestroy  func(conntrackFlow)
	stopped    int
	duringDump func()
}

func (s *fakeConntrackSource) dump() ([]conntrackFlow, error) {
	s.mu.Lock()
	hook := s.duringDump
	s.duringDump = nil
	flows := append([]conntrackFlow(nil), s.flows...)
	err := s.dumpErr
	s.mu.Unlock()
	if hook != nil {
		hook()
	}
	return flows, err
}

func (s *fakeConntrackSource) subscribe(onDestroy func(conntrackFlow), overflow func()) (func(), error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.subErr != nil {
		return nil, s.subErr
	}
	s.onDestroy = onDestroy
	return func() {
		s.mu.Lock()
		s.stopped++
		s.mu.Unlock()
	}, nil
}

func (s *fakeConntrackSource) set(flows ...conntrackFlow) {
	s.mu.Lock()
	s.flows = flows
	s.mu.Unlock()
}

func (s *fakeConntrackSource) destroy(flow conntrackFlow) {
	s.mu.Lock()
	fn := s.onDestroy
	s.mu.Unlock()
	fn(flow)
}

func dnatFlow(id uint32, port uint16, in, out uint64) conntrackFlow {
	return conntrackFlow{ID: id, Proto: conntrackProtoTCP, OrigDstPort: port, Status: conntrackStatusDstNAT, InBytes: in, OutBytes: out, HasCounters: true}
}

func zeroBaseline(string) (uint64, uint64) { return 0, 0 }

func TestConntrackAccountantCountsOnlyNewBytes(t *testing.T) {
	source := &fakeConntrackSource{}
	// 启动时已经有的连接：它之前的字节由 iptables 报过了，不能再算。
	source.set(dnatFlow(1, 8080, 5000, 7000))
	accountant := newConntrackAccountant(source)
	if err := accountant.start(); err != nil {
		t.Fatal(err)
	}
	watched := map[int]map[string]bool{8080: {"tcp": true}}
	totals, err := accountant.sample(watched, func(port string) (uint64, uint64) { return 100, 200 })
	if err != nil {
		t.Fatal(err)
	}
	if got := totals["8080"]; got.In != 100 || got.Out != 200 {
		t.Fatalf("first sample = %+v, want the persisted baseline 100/200", got)
	}
	// 老连接又传了 1000/2000；来了一条新连接 300/400；一条别的端口、一条没做 DNAT 的、一条 UDP 不在观察里。
	source.set(
		dnatFlow(1, 8080, 6000, 9000),
		dnatFlow(2, 8080, 300, 400),
		dnatFlow(3, 9090, 1, 1),
		conntrackFlow{ID: 4, Proto: conntrackProtoTCP, OrigDstPort: 8080, InBytes: 50, OutBytes: 50, HasCounters: true},
		conntrackFlow{ID: 5, Proto: conntrackProtoUDP, OrigDstPort: 8080, Status: conntrackStatusDstNAT, InBytes: 9, OutBytes: 9, HasCounters: true},
	)
	totals, err = accountant.sample(watched, zeroBaseline)
	if err != nil {
		t.Fatal(err)
	}
	if got := totals["8080"]; got.In != 100+1000+300 || got.Out != 200+2000+400 {
		t.Fatalf("second sample = %+v", got)
	}
	// 连接 2 结束前又传了 10/20：DESTROY 事件补上；之后建立又结束的连接 6 整条算。
	source.destroy(dnatFlow(2, 8080, 310, 420))
	source.destroy(dnatFlow(6, 8080, 70, 80))
	// 启动 dump 之前就有、已经在 live 里的连接 1 不受影响；没做 DNAT 的事件忽略。
	source.destroy(conntrackFlow{ID: 4, Proto: conntrackProtoTCP, OrigDstPort: 8080, InBytes: 99, OutBytes: 99, HasCounters: true})
	// dump 和事件交错：dump 里还带着连接 2 的旧字节数，不能被当成新连接再算一遍。
	source.set(dnatFlow(1, 8080, 6000, 9000), dnatFlow(2, 8080, 310, 420))
	totals, err = accountant.sample(watched, zeroBaseline)
	if err != nil {
		t.Fatal(err)
	}
	if got := totals["8080"]; got.In != 1400+10+70 || got.Out != 2600+20+80 {
		t.Fatalf("after destroy = %+v", got)
	}
	if status := accountant.status(); status.Flows != 1 || len(status.Ports) != 1 {
		t.Fatalf("status = %+v", status)
	}
}

func TestConntrackAccountantIgnoresDestroysWhileSeeding(t *testing.T) {
	source := &fakeConntrackSource{}
	source.set(dnatFlow(1, 8080, 100, 100))
	accountant := newConntrackAccountant(source)
	// 启动 dump 进行中时有一条老连接结束：它的字节不属于这次计数。
	source.duringDump = func() { source.destroy(dnatFlow(9, 8080, 5000, 5000)) }
	if err := accountant.start(); err != nil {
		t.Fatal(err)
	}
	watched := map[int]map[string]bool{8080: {"tcp": true}}
	totals, _ := accountant.sample(watched, zeroBaseline)
	if got := totals["8080"]; got.In != 0 || got.Out != 0 {
		t.Fatalf("totals = %+v, want 0", got)
	}
}

func TestConntrackAccountantDropsUnwatchedPortsAndReseeds(t *testing.T) {
	source := &fakeConntrackSource{}
	accountant := newConntrackAccountant(source)
	if err := accountant.start(); err != nil {
		t.Fatal(err)
	}
	watched := map[int]map[string]bool{8080: {"tcp": true}}
	source.set(dnatFlow(1, 8080, 10, 10))
	totals, _ := accountant.sample(watched, func(string) (uint64, uint64) { return 1000, 1000 })
	if totals["8080"].In != 1010 {
		t.Fatalf("totals = %+v", totals)
	}
	// 端口不再观察：累计值扔掉；再回来时重新从基线起步。
	totals, _ = accountant.sample(map[int]map[string]bool{}, zeroBaseline)
	if _, ok := totals["8080"]; ok {
		t.Fatalf("unwatched port kept: %+v", totals)
	}
	source.set(dnatFlow(1, 8080, 30, 30))
	totals, _ = accountant.sample(watched, func(string) (uint64, uint64) { return 5000, 5000 })
	if totals["8080"].In != 5020 {
		t.Fatalf("reseeded totals = %+v, want 5000 + 20", totals)
	}
}

func TestConntrackAccountantStartFailures(t *testing.T) {
	accountant := newConntrackAccountant(&fakeConntrackSource{subErr: errors.New("EPERM")})
	if err := accountant.start(); err == nil || accountant.isRunning() {
		t.Fatalf("start with subscribe error: err=%v running=%v", err, accountant.isRunning())
	}
	source := &fakeConntrackSource{dumpErr: errors.New("boom")}
	accountant = newConntrackAccountant(source)
	if err := accountant.start(); err == nil || accountant.isRunning() || source.stopped != 1 {
		t.Fatalf("start with dump error: err=%v running=%v stopped=%d", err, accountant.isRunning(), source.stopped)
	}
	if _, err := accountant.sample(nil, zeroBaseline); err == nil {
		t.Fatal("sample on a stopped accountant succeeded")
	}
}

func TestBuildFlowOffloadScript(t *testing.T) {
	script := buildFlowOffloadScript(flowOffloadPlan{Devices: []string{"eth0", "nexwg3"}, TCPPorts: []int{80, 443}})
	for _, want := range []string{
		"table inet nex_offload {}\ndelete table inet nex_offload\n",
		`devices = { "eth0", "nexwg3" }`,
		"    counter\n",
		"set tcp_ports { type inet_service; elements = { 80, 443 } }",
		"set udp_ports { type inet_service; }",
		"type filter hook forward priority 50; policy accept;",
		"ct status dnat meta l4proto tcp ct original proto-dst @tcp_ports flow add @ft",
		"ct status dnat meta l4proto udp ct original proto-dst @udp_ports flow add @ft",
	} {
		if !strings.Contains(script, want) {
			t.Fatalf("script missing %q:\n%s", want, script)
		}
	}
}

func TestFlowOffloadPortsAndDevices(t *testing.T) {
	states := []localRuleState{
		{Port: "1001", RuleID: 1, ForwardType: "iptables", Protocol: "tcp", TargetIP: "10.0.0.2", TargetPort: 80},
		{Port: "1002", RuleID: 2, ForwardType: "nftables", Protocol: "both", TargetIP: "10.0.0.3", TargetPort: 80},
		{Port: "1003", RuleID: 3, ForwardType: "gost", Protocol: "tcp"},
		{Port: "1004", RuleID: 4, ForwardType: "forwardx", Protocol: "tcp"},
		{Port: "1005", RuleID: 0, ForwardType: "iptables", Protocol: "tcp"},
	}
	ports, tcp, udp := flowOffloadPorts(states, map[int]map[string]bool{2001: {"udp": true}})
	if strings.Join(intsToStrings(tcp), ",") != "1001,1002" || strings.Join(intsToStrings(udp), ",") != "1002,2001" {
		t.Fatalf("tcp=%v udp=%v", tcp, udp)
	}
	if len(ports) != 3 {
		t.Fatalf("ports = %v", ports)
	}
	if accounting := flowOffloadAccountingPorts(states); len(accounting) != 2 || accounting[2001] != nil {
		t.Fatalf("accounting ports = %v (passthrough exit ports are not counted here)", accounting)
	}
	if targets := flowOffloadTargets(states); strings.Join(targets, ",") != "10.0.0.2,10.0.0.3" {
		t.Fatalf("targets = %v", targets)
	}
	devices := parseRouteDevices("default via 1.2.3.1 dev eth0 proto dhcp\n10.0.0.2 via 10.0.0.1 dev ens5 src 10.0.0.9 uid 0\n")
	links := parseLinkNames("1: lo: <LOOPBACK> mtu 65536\n2: eth0: <UP>\n7: nexwg3: <POINTOPOINT>\n9: veth1@if8: <UP>\n")
	got := normalizeFlowOffloadDevices(append(devices, filterWireGuardLinks(links)...))
	if strings.Join(got, ",") != "eth0,ens5,nexwg3" && strings.Join(got, ",") != "ens5,eth0,nexwg3" {
		t.Fatalf("devices = %v", got)
	}
	if bad := normalizeFlowOffloadDevices([]string{"lo", "eth0\"; drop", "a-very-long-interface-name"}); len(bad) != 0 {
		t.Fatalf("unsafe device names kept: %v", bad)
	}
}

func TestKernelReleaseAtLeast(t *testing.T) {
	for release, want := range map[string]bool{
		"6.1.0-26-amd64": true, "6.8.0-45-generic": true, "5.15.0-119-generic": false,
		"5.4.0": false, "7.0": true, "6.0.12": false, "garbage": false,
	} {
		if got := kernelReleaseAtLeast(release, "6.1"); got != want {
			t.Fatalf("%s: got %v want %v", release, got, want)
		}
	}
}

type fakeFlowOffloadSystem struct {
	release  string
	nft      bool
	acctErr  error
	applyErr error
	table    bool
	scripts  []string
	devices  []string
	links    []string
}

func (s *fakeFlowOffloadSystem) kernelRelease() (string, error) { return s.release, nil }
func (s *fakeFlowOffloadSystem) hasNft() bool                   { return s.nft }
func (s *fakeFlowOffloadSystem) applyNft(script string) error {
	s.scripts = append(s.scripts, script)
	if s.applyErr != nil {
		return s.applyErr
	}
	s.table = strings.Contains(script, "flowtable ft")
	return nil
}
func (s *fakeFlowOffloadSystem) tableExists() bool              { return s.table }
func (s *fakeFlowOffloadSystem) enableConntrackAcct() error     { return s.acctErr }
func (s *fakeFlowOffloadSystem) routeDevices([]string) []string { return s.devices }
func (s *fakeFlowOffloadSystem) linkNames() []string            { return s.links }

func TestFlowOffloadManagerEnableSyncDisable(t *testing.T) {
	system := &fakeFlowOffloadSystem{release: "6.8.0", nft: true, devices: []string{"eth0"}, links: []string{"nexwg2", "docker0"}}
	source := &fakeConntrackSource{}
	manager := newFlowOffloadManager(system, newConntrackAccountant(source))
	states := []localRuleState{{Port: "1001", RuleID: 1, ForwardType: "iptables", Protocol: "tcp", TargetIP: "10.0.0.2", TargetPort: 80}}

	manager.sync(states, nil)
	if len(system.scripts) != 0 || manager.accountingActive() {
		t.Fatalf("disabled manager touched nft: %v", system.scripts)
	}
	manager.setEnabled(true)
	manager.sync(states, nil)
	status := manager.status()
	if !status.Active || status.Error != "" || !status.Accounting.Running || strings.Join(status.Devices, ",") != "eth0,nexwg2" || status.TCPPorts != 1 {
		t.Fatalf("status after enable = %+v", status)
	}
	// 没变化：不重写 nft。
	manager.sync(states, nil)
	if len(system.scripts) != 1 {
		t.Fatalf("unchanged plan rewrote nft %d times", len(system.scripts))
	}
	// 规则变了：重写一次。
	manager.sync(append(states, localRuleState{Port: "1002", RuleID: 2, ForwardType: "iptables", Protocol: "udp"}), nil)
	if len(system.scripts) != 2 || !strings.Contains(system.scripts[1], "set udp_ports { type inet_service; elements = { 1002 } }") {
		t.Fatalf("scripts = %v", system.scripts)
	}
	manager.setEnabled(false)
	manager.sync(states, nil)
	if manager.accountingActive() || system.table || source.stopped != 1 || !strings.Contains(system.scripts[len(system.scripts)-1], "delete table inet nex_offload") {
		t.Fatalf("after disable: active=%v table=%v stopped=%d", manager.accountingActive(), system.table, source.stopped)
	}
}

func TestFlowOffloadManagerRefusesWithoutPrerequisites(t *testing.T) {
	for name, system := range map[string]*fakeFlowOffloadSystem{
		"old kernel":           {release: "5.15.0-119-generic", nft: true, devices: []string{"eth0"}},
		"no nft":               {release: "6.8.0", devices: []string{"eth0"}},
		"no acct":              {release: "6.8.0", nft: true, devices: []string{"eth0"}, acctErr: errors.New("read-only")},
		"no nic":               {release: "6.8.0", nft: true},
		"no flowtable support": {release: "6.8.0", nft: true, devices: []string{"eth0"}, applyErr: errors.New("No such file or directory")},
	} {
		source := &fakeConntrackSource{}
		manager := newFlowOffloadManager(system, newConntrackAccountant(source))
		manager.setEnabled(true)
		manager.sync([]localRuleState{{Port: "1001", RuleID: 1, ForwardType: "iptables", Protocol: "tcp"}}, nil)
		status := manager.status()
		if status.Active || status.Error == "" || status.Accounting.Running {
			t.Fatalf("%s: status = %+v", name, status)
		}
	}
	// 订阅不上 conntrack 事件：不建表。
	system := &fakeFlowOffloadSystem{release: "6.8.0", nft: true, devices: []string{"eth0"}}
	manager := newFlowOffloadManager(system, newConntrackAccountant(&fakeConntrackSource{subErr: errors.New("EPERM")}))
	manager.setEnabled(true)
	manager.sync(nil, nil)
	if system.table || manager.accountingActive() {
		t.Fatal("flowtable installed without conntrack accounting")
	}
}

func TestFlowOffloadManagerAdoptsLeftoverTable(t *testing.T) {
	system := &fakeFlowOffloadSystem{release: "6.8.0", nft: true, table: true}
	manager := newFlowOffloadManager(system, newConntrackAccountant(&fakeConntrackSource{}))
	manager.adoptExisting()
	if !manager.accountingActive() {
		t.Fatal("leftover table not adopted")
	}
	// 接不上计数：删表。
	system = &fakeFlowOffloadSystem{release: "6.8.0", nft: true, table: true}
	manager = newFlowOffloadManager(system, newConntrackAccountant(&fakeConntrackSource{subErr: errors.New("EPERM")}))
	manager.adoptExisting()
	if manager.accountingActive() || system.table {
		t.Fatalf("leftover table kept without accounting: active=%v table=%v", manager.accountingActive(), system.table)
	}
}

func TestTrafficBytesBaselineRestartsWhenSourceChanges(t *testing.T) {
	previous := trafficPrevState{ruleID: 1, in: 1000, out: 2000}
	counters := trafficCounters{In: 1500, Out: 2600}
	if in, out := trafficBytesBaseline(previous, counters, "", false); in != 1000 || out != 2000 {
		t.Fatalf("same source: %d/%d", in, out)
	}
	if in, out := trafficBytesBaseline(previous, counters, trafficByteSourceConntrack, false); in != 1500 || out != 2600 {
		t.Fatalf("iptables -> conntrack: %d/%d", in, out)
	}
	previous.byteSource = trafficByteSourceConntrack
	if in, out := trafficBytesBaseline(previous, counters, "", false); in != 1500 || out != 2600 {
		t.Fatalf("conntrack -> iptables: %d/%d", in, out)
	}
	if in, _ := trafficBytesBaseline(previous, counters, trafficByteSourceConntrack, false); in != 1000 {
		t.Fatalf("conntrack -> conntrack: %d", in)
	}
}

func TestTrafficPrevStatePersistsByteSource(t *testing.T) {
	previousDir := trafficStateDir
	trafficStateDir = t.TempDir()
	trafficPrevMu.Lock()
	previousCache := trafficPrevCache
	trafficPrevCache = map[string]trafficPrevState{}
	trafficPrevMu.Unlock()
	t.Cleanup(func() {
		trafficStateDir = previousDir
		trafficPrevMu.Lock()
		trafficPrevCache = previousCache
		trafficPrevMu.Unlock()
	})
	want := trafficPrevState{ruleID: 7, in: 11, out: 22, conns: 3, connSource: trafficConnectionSourceConntrack, byteSource: trafficByteSourceConntrack}
	if err := writePrevState("4242", want); err != nil {
		t.Fatal(err)
	}
	trafficPrevMu.Lock()
	trafficPrevCache = map[string]trafficPrevState{}
	trafficPrevMu.Unlock()
	if got := readPrevState("4242"); got != want {
		t.Fatalf("round trip = %+v, want %+v", got, want)
	}
	// 普通来源不写第 6 行，文件和以前一模一样。
	plain := want
	plain.byteSource = ""
	if err := writePrevState("4243", plain); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(trafficStateDir + "/traffic_4243.prev")
	if strings.Count(string(raw), "\n") != 5 {
		t.Fatalf("plain baseline file = %q", raw)
	}
	updates := pendingTrafficBaselineUpdates(persistedTrafficBaselines([]trafficBaselineUpdate{{port: "4242", state: want}}))
	if len(updates) != 1 || updates[0].state != want {
		t.Fatalf("pending round trip = %+v", updates)
	}
}
