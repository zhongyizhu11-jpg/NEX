package main

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

type fakeFirewallRunner struct {
	have  map[string]bool
	calls []string
	fail  map[string]bool
}

func (f *fakeFirewallRunner) Has(binary string) bool { return f.have[binary] }

func (f *fakeFirewallRunner) Run(name string, args ...string) ([]byte, error) {
	call := name + " " + strings.Join(args, " ")
	f.calls = append(f.calls, call)
	for prefix := range f.fail {
		if strings.HasPrefix(call, prefix) {
			return []byte("fail"), os.ErrNotExist
		}
	}
	if strings.HasPrefix(call, "nft list counter") {
		return []byte("table inet forwardx_guard {\n\tcounter cnt_block {\n\t\tpackets 7 bytes 420\n\t}\n}\n"), nil
	}
	return nil, nil
}

func (f *fakeFirewallRunner) RunStdin(stdin string, name string, args ...string) ([]byte, error) {
	f.calls = append(f.calls, "STDIN "+name+" "+strings.Join(args, " "))
	return nil, nil
}

func (f *fakeFirewallRunner) count(prefix string) int {
	n := 0
	for _, c := range f.calls {
		if strings.HasPrefix(c, prefix) {
			n++
		}
	}
	return n
}

func newTestFirewallModule(runner *fakeFirewallRunner) *firewallModule {
	m := newFirewallModule(runner)
	m.readSSHD = func() []int { return []int{22, 2222} }
	return m
}

func TestFirewallPlanDropsSSHAndInvalid(t *testing.T) {
	d := firewallDirective{
		Enabled: true, Mode: "block",
		TCP:    []int{443, 22, 2222, 443, 0, 70000, 80},
		UDP:    []int{22, 443},
		Block4: []string{"1.2.3.4", "1.2.3.0/24", "bad", "10.0.0.0/8", "2001:db8::1"},
		Block6: []string{"2001:db8::/32", "2001:db8:1::/48", "1.2.3.4"},
	}
	plan, warn := buildFirewallPlan(d, []string{"5.6.0.0/16", "5.6.7.0/24"}, nil, []int{2222})
	if warn != "" {
		t.Fatalf("unexpected warn %q", warn)
	}
	if !reflect.DeepEqual(plan.TCP, []int{80, 443}) {
		t.Fatalf("tcp ports = %v", plan.TCP)
	}
	if !reflect.DeepEqual(plan.UDP, []int{22, 443}) {
		t.Fatalf("udp ports = %v (sshd is tcp only)", plan.UDP)
	}
	if !reflect.DeepEqual(plan.Block4, []string{"1.2.3.0/24", "10.0.0.0/8"}) {
		t.Fatalf("block4 = %v", plan.Block4)
	}
	if !reflect.DeepEqual(plan.Block6, []string{"2001:db8::/32"}) {
		t.Fatalf("block6 = %v", plan.Block6)
	}
	if !reflect.DeepEqual(plan.Geo4, []string{"5.6.0.0/16"}) {
		t.Fatalf("geo4 = %v", plan.Geo4)
	}
}

func TestFirewallPlanAllowWithoutGeoFallsBackToOff(t *testing.T) {
	plan, warn := buildFirewallPlan(firewallDirective{Enabled: true, Mode: "allow", TCP: []int{443}}, nil, nil, nil)
	if plan.Mode != "off" || warn == "" {
		t.Fatalf("allow without geo must not lock everyone out: mode=%s warn=%q", plan.Mode, warn)
	}
}

func TestBuildNftGuardScript(t *testing.T) {
	plan, _ := buildFirewallPlan(firewallDirective{
		Enabled: true, Mode: "allow", TCP: []int{443, 8443}, UDP: []int{443},
		Block4: []string{"9.9.9.9"}, Allow4: []string{"203.0.113.5"},
	}, []string{"1.0.1.0/24"}, []string{"2400:3200::/32"}, nil)
	script := buildNftGuardScript(plan)
	for _, want := range []string{
		"table inet forwardx_guard\ndelete table inet forwardx_guard\ntable inet forwardx_guard {",
		"type filter hook prerouting priority -150; policy accept;",
		"ct state != new return",
		"iifname \"lo\" return",
		"elements = { 443, 8443 }",
		"tcp dport @tcp_ports jump guard",
		"udp dport @udp_ports jump guard",
		"ip saddr @skip4 return",
		"ip saddr @allow4 return",
		"ip saddr @block4 counter name cnt_block drop",
		"ip saddr != @geo4 counter name cnt_country drop",
		"ip6 saddr != @geo6 counter name cnt_country drop",
		"elements = { 9.9.9.9/32 }",
	} {
		if !strings.Contains(script, want) {
			t.Fatalf("nft script missing %q:\n%s", want, script)
		}
	}
	// 拦截模式
	plan.Mode = "block"
	if s := buildNftGuardScript(plan); !strings.Contains(s, "ip saddr @geo4 counter name cnt_country drop") || strings.Contains(s, "saddr !=") {
		t.Fatalf("block mode script wrong:\n%s", s)
	}
	// 只封 IP、地区关闭：不定义国家集合
	plan.Mode = "off"
	if s := buildNftGuardScript(plan); strings.Contains(s, "geo4") || strings.Contains(s, "cnt_country drop") {
		t.Fatalf("off mode must not reference geo sets:\n%s", s)
	}
	// 没有 udp 端口时不引用 udp 集合的规则
	plan.UDP = nil
	if s := buildNftGuardScript(plan); strings.Contains(s, "udp dport") {
		t.Fatalf("no udp ports but udp rule emitted:\n%s", s)
	}
}

func TestBuildIptablesFallback(t *testing.T) {
	plan, _ := buildFirewallPlan(firewallDirective{
		Enabled: true, Mode: "block", TCP: []int{443}, UDP: []int{53000},
		Block4: []string{"9.9.9.9", "8.8.0.0/16"},
	}, []string{"1.0.1.0/24"}, nil, nil)
	ipset := buildIpsetRestoreScript(plan)
	for _, want := range []string{
		"create fwx_g_tcp bitmap:port range 0-65535",
		"create fwx_g_block4 hash:net family inet",
		"create fwx_g_block6 hash:net family inet6",
		"add fwx_g_block4_t 9.9.9.9\n",
		"add fwx_g_block4_t 8.8.0.0/16\n",
		"swap fwx_g_block4_t fwx_g_block4",
		"destroy fwx_g_block4_t",
		"add fwx_g_tcp_t 443",
	} {
		if !strings.Contains(ipset, want) {
			t.Fatalf("ipset script missing %q:\n%s", want, ipset)
		}
	}
	v4 := buildIptablesRestoreInput(plan, false)
	for _, want := range []string{
		"*mangle\n:FWX_GUARD - [0:0]\n:FWX_GUARD_CHK - [0:0]\n",
		"-A FWX_GUARD -m conntrack ! --ctstate NEW -j RETURN",
		"-A FWX_GUARD -p tcp -m set --match-set fwx_g_tcp dst -j FWX_GUARD_CHK",
		"-A FWX_GUARD -p udp -m set --match-set fwx_g_udp dst -j FWX_GUARD_CHK",
		"-A FWX_GUARD_CHK -m set --match-set fwx_g_skip4 src -j RETURN",
		"--match-set fwx_g_block4 src -m comment --comment fwx-guard-block -j DROP",
		"--match-set fwx_g_geo4 src -m comment --comment fwx-guard-country -j DROP",
		"COMMIT\n",
	} {
		if !strings.Contains(v4, want) {
			t.Fatalf("iptables input missing %q:\n%s", want, v4)
		}
	}
	plan.Mode = "allow"
	v6 := buildIptablesRestoreInput(plan, true)
	if !strings.Contains(v6, "-m set ! --match-set fwx_g_geo6 src") || !strings.Contains(v6, "fwx_g_skip6") {
		t.Fatalf("ip6tables allow input wrong:\n%s", v6)
	}
}

func TestFirewallApplyIdempotentByHash(t *testing.T) {
	runner := &fakeFirewallRunner{have: map[string]bool{"nft": true}}
	m := newTestFirewallModule(runner)
	d := firewallDirective{Enabled: true, Hash: "h1", Mode: "block", TCP: []int{443}, CountryHash: "c1", GeoIncluded: true, Geo4: []string{"1.0.1.0/24"}}
	raw, _ := json.Marshal(d)
	m.Apply(Config{}, raw)
	if got := runner.count("STDIN nft -f -"); got != 1 {
		t.Fatalf("first apply nft runs = %d, want 1", got)
	}
	// 同一个哈希、这一轮省掉了国家段：什么也不做
	d.GeoIncluded, d.Geo4 = false, nil
	raw, _ = json.Marshal(d)
	m.Apply(Config{}, raw)
	m.Apply(Config{}, raw)
	if got := runner.count("STDIN nft -f -"); got != 1 {
		t.Fatalf("same hash re-applied: nft runs = %d", got)
	}
	report := m.Report(Config{}).(firewallReport)
	if report.Hash != "h1" || report.CountryHash != "c1" || report.Backend != "nft" || !report.Active {
		t.Fatalf("report = %+v", report)
	}
	if report.Block != 7 {
		t.Fatalf("block counter = %d, want 7", report.Block)
	}
	// 哈希变了（例如多封了一个 IP），国家段沿用缓存
	d.Hash = "h2"
	d.Block4 = []string{"9.9.9.9"}
	raw, _ = json.Marshal(d)
	m.Apply(Config{}, raw)
	if got := runner.count("STDIN nft -f -"); got != 2 {
		t.Fatalf("hash change must re-apply: nft runs = %d", got)
	}
	// 重新写表前的计数并进 base，上报一直单调
	if r := m.Report(Config{}).(firewallReport); r.Block != 14 {
		t.Fatalf("block counter after re-apply = %d, want 14", r.Block)
	}
	// 国家段的哈希变了但这一轮没带列表：保持原样，等下一轮
	d.Hash, d.CountryHash = "h3", "c2"
	raw, _ = json.Marshal(d)
	m.Apply(Config{}, raw)
	if got := runner.count("STDIN nft -f -"); got != 2 || m.appliedHash != "h2" {
		t.Fatalf("missing geo must not apply: runs=%d applied=%s", got, m.appliedHash)
	}
	// 关掉：清理一次，之后再收到关掉不再动
	raw, _ = json.Marshal(firewallDirective{Enabled: false, Hash: "off"})
	m.Apply(Config{}, raw)
	m.Apply(Config{}, raw)
	if got := runner.count("nft delete table inet forwardx_guard"); got != 1 {
		t.Fatalf("cleanup runs = %d, want 1", got)
	}
	if m.active {
		t.Fatal("still active after disable")
	}
}

func TestFirewallVerifyReappliesWhenTableGone(t *testing.T) {
	runner := &fakeFirewallRunner{have: map[string]bool{"nft": true}, fail: map[string]bool{}}
	m := newTestFirewallModule(runner)
	now := time.Unix(1_700_000_000, 0)
	m.now = func() time.Time { return now }
	raw, _ := json.Marshal(firewallDirective{Enabled: true, Hash: "h1", Mode: "off", TCP: []int{443}, Block4: []string{"9.9.9.9"}})
	m.Apply(Config{}, raw)
	runner.fail["nft list chain"] = true
	now = now.Add(time.Minute)
	m.Apply(Config{}, raw)
	if got := runner.count("STDIN nft -f -"); got != 1 {
		t.Fatalf("verify ran too early: %d", got)
	}
	now = now.Add(firewallVerifyEvery)
	m.Apply(Config{}, raw)
	if got := runner.count("STDIN nft -f -"); got != 2 {
		t.Fatalf("table gone but not re-applied: %d", got)
	}
}

func TestFirewallIptablesFallbackNeedsIpset(t *testing.T) {
	runner := &fakeFirewallRunner{have: map[string]bool{"iptables": true, "iptables-restore": true}}
	m := newTestFirewallModule(runner)
	raw, _ := json.Marshal(firewallDirective{Enabled: true, Hash: "h1", Mode: "off", TCP: []int{443}, Block4: []string{"9.9.9.9"}})
	m.Apply(Config{}, raw)
	if m.active || !strings.Contains(m.lastError, "ipset") {
		t.Fatalf("expected ipset error, active=%v err=%q", m.active, m.lastError)
	}
	runner.have["ipset"] = true
	runner.fail = map[string]bool{"iptables -t mangle -C": true}
	// 让 iptablesWaitArgs 不去探测真实系统
	iptablesWaitProbe.mu.Lock()
	iptablesWaitProbe.resolved, iptablesWaitProbe.value = true, ""
	iptablesWaitProbe.mu.Unlock()
	m.Apply(Config{}, raw)
	if !m.active || m.backend != "iptables" {
		t.Fatalf("iptables fallback not active: %+v err=%q", m.backend, m.lastError)
	}
	if runner.count("STDIN ipset -exist restore") != 1 || runner.count("STDIN iptables-restore --noflush") != 1 {
		t.Fatalf("calls = %v", runner.calls)
	}
	if runner.count("iptables -t mangle -I PREROUTING 1 -j FWX_GUARD") != 1 {
		t.Fatalf("jump not inserted: %v", runner.calls)
	}
}

func TestParseFirewallCounters(t *testing.T) {
	if got := parseNftCounterPackets("counter cnt_block {\n packets 123 bytes 4567\n}"); got != 123 {
		t.Fatalf("nft packets = %d", got)
	}
	out := `Chain FWX_GUARD_CHK (1 references)
    pkts      bytes target     prot opt in     out     source               destination
       0        0 RETURN     all  --  *      *       0.0.0.0/0            0.0.0.0/0            match-set fwx_g_skip4 src
      12      720 DROP       all  --  *      *       0.0.0.0/0            0.0.0.0/0            match-set fwx_g_block4 src /* fwx-guard-block */
       5      300 DROP       all  --  *      *       0.0.0.0/0            0.0.0.0/0            match-set fwx_g_geo4 src /* fwx-guard-country */
`
	if got := parseIptablesCommentPackets(out, firewallBlockComment); got != 12 {
		t.Fatalf("iptables block = %d", got)
	}
	if got := parseIptablesCommentPackets(out, firewallGeoComment); got != 5 {
		t.Fatalf("iptables country = %d", got)
	}
}

func TestParseSSHDPorts(t *testing.T) {
	got := parseSSHDPorts("# Port 23\nPort 2222\n  port 22\nListenAddress 0.0.0.0:2200\nListenAddress [::]:2201\nPermitRootLogin no\n")
	if !reflect.DeepEqual(got, []int{22, 2200, 2201, 2222}) {
		t.Fatalf("ssh ports = %v", got)
	}
}
