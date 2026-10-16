package main

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

const procNetTCPFixture = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:01BB 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1001 1 0000000000000000 100 0 0 10 0
   1: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1002 1 0000000000000000 100 0 0 10 0
   2: 0F02000A:01BB 0100A8C0:D431 01 00000000:00000000 02:000A7B6B 00000000     0        0 1003 4 0000000000000000 20 4 30 10 -1
`

const procNetTCP6Fixture = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000000000000:01BB 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2001 1 0000000000000000 100 0 0 10 0
   1: 0000000000000000FFFF00000100007F:2710 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2002 1 0000000000000000 100 0 0 10 0
`

const procNetUDPFixture = `   sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops
  100: 00000000:01BB 00000000:0000 07 00000000:00000000 00:00000000 00000000     0        0 3001 2 0000000000000000 0
  101: 0F02000A:A1B2 08080808:0035 01 00000000:00000000 00:00000000 00000000     0        0 3002 2 0000000000000000 0
`

func TestDecodeProcNetAddress(t *testing.T) {
	ip, port, err := decodeProcNetAddress("0100007F:1F90")
	if err != nil || ip.String() != "127.0.0.1" || port != 8080 {
		t.Fatalf("ipv4 decode = %v %d %v", ip, port, err)
	}
	ip, port, err = decodeProcNetAddress("0000000000000000FFFF00000100007F:2710")
	if err != nil || ip.String() != "127.0.0.1" || port != 10000 {
		t.Fatalf("v4-mapped decode = %v %d %v", ip, port, err)
	}
	ip, _, err = decodeProcNetAddress("B80D0120000000000000000001000000:0050")
	if err != nil || ip.String() != "2001:db8::1" {
		t.Fatalf("ipv6 decode = %v %v", ip, err)
	}
	if _, _, err := decodeProcNetAddress("zz:01"); err == nil {
		t.Fatal("bad hex should fail")
	}
}

func TestParseProcNetListeners(t *testing.T) {
	tcp := parseProcNetListeners(procNetTCPFixture, "tcp")
	if len(tcp) != 2 {
		t.Fatalf("want 2 tcp listeners (established one skipped), got %v", tcp)
	}
	if tcp[0].String() != "0.0.0.0:443/tcp" || tcp[1].String() != "127.0.0.1:8080/tcp" {
		t.Fatalf("unexpected tcp listeners %v", tcp)
	}
	tcp6 := parseProcNetListeners(procNetTCP6Fixture, "tcp")
	if len(tcp6) != 2 || tcp6[0].String() != "[::]:443/tcp" {
		t.Fatalf("unexpected tcp6 listeners %v", tcp6)
	}
	udp := parseProcNetListeners(procNetUDPFixture, "udp")
	if len(udp) != 1 || udp[0].String() != "0.0.0.0:443/udp" {
		t.Fatalf("connected udp socket must be skipped, got %v", udp)
	}
}

type fakeConn struct{ net.Conn }

func (fakeConn) Close() error { return nil }

func fakeDiagnosticsEnv() diagnosticsEnv {
	files := map[string]string{
		"/proc/net/tcp":    procNetTCPFixture,
		"/proc/net/tcp6":   procNetTCP6Fixture,
		"/proc/net/udp":    procNetUDPFixture,
		"/etc/resolv.conf": "nameserver 1.1.1.1\n",
	}
	var clockMu sync.Mutex
	clock := time.Unix(1_700_000_000, 0)
	return diagnosticsEnv{
		readFile: func(path string) ([]byte, error) {
			if value, ok := files[path]; ok {
				return []byte(value), nil
			}
			return nil, errors.New("missing")
		},
		dial: func(ctx context.Context, network, address string) (net.Conn, error) {
			switch {
			case strings.HasPrefix(address, "127.0.0.1:"), strings.HasPrefix(address, "1.1.1.1:"), strings.HasPrefix(address, "example.com:"):
				clockMu.Lock()
				clock = clock.Add(12 * time.Millisecond)
				clockMu.Unlock()
				return fakeConn{}, nil
			case strings.HasPrefix(address, "203.0.113.9:"):
				return nil, &net.OpError{Op: "dial", Err: syscall.ECONNREFUSED}
			}
			return nil, context.DeadlineExceeded
		},
		lookupIP: func(ctx context.Context, network, host string) ([]net.IP, error) {
			if host != "example.com" {
				return nil, &net.DNSError{Err: "no such host", Name: host, IsNotFound: true}
			}
			if network == "ip4" {
				return []net.IP{net.ParseIP("93.184.216.34")}, nil
			}
			return nil, &net.DNSError{Err: "no such host", Name: host}
		},
		run: func(ctx context.Context, name string, args ...string) (string, error) {
			switch name {
			case "ufw":
				return "Status: active\n\nTo                         Action      From\n--                         ------      ----\n22/tcp                     ALLOW       Anywhere\n10000:20000/tcp            ALLOW       Anywhere\n", nil
			case "iptables":
				return "-P INPUT ACCEPT\n", nil
			case "nft":
				return "table ip forwardx {\n chain prerouting {\n  tcp dport 9000 dnat to 1.1.1.1:80\n }\n}\n", nil
			}
			return "", errors.New("not found")
		},
		hasCommand: func(name string) bool { return name == "ufw" || name == "iptables" || name == "nft" },
		serviceActive: func(name string) (bool, bool) {
			return name == "forwardx-realm-tcp-443" || name == "forwardx-runtime", true
		},
		fxpAlive:      func(int) (bool, string) { return false, "没有进程" },
		firewallGuard: func() (bool, string) { return true, "nft" },
		now: func() time.Time {
			clockMu.Lock()
			defer clockMu.Unlock()
			return clock
		},
	}
}

func TestRunDiagnosticsTaskResultShape(t *testing.T) {
	task := diagnosticsTask{TaskID: "t-1", TimeoutMs: 5000, Checks: []diagnosticsCheck{
		{ID: "c1", Kind: "listen", Port: 443, Protocol: "both"},
		{ID: "c2", Kind: "listen", Port: 8443, Protocol: "tcp"},
		{ID: "c3", Kind: "firewall", Port: 443, Protocol: "tcp"},
		{ID: "c4", Kind: "firewall", Port: 15000, Protocol: "tcp"},
		{ID: "c5", Kind: "loopback", Port: 8080, PublicIP: "203.0.113.9"},
		{ID: "c6", Kind: "dns", Host: "example.com"},
		{ID: "c7", Kind: "dns", Host: "nope.invalid"},
		{ID: "c8", Kind: "dial", Host: "1.1.1.1", Port: 443, Protocol: "tcp"},
		{ID: "c9", Kind: "dial", Host: "203.0.113.9", Port: 443, Protocol: "tcp"},
		{ID: "c10", Kind: "process", ForwardType: "realm", Port: 443, Protocol: "tcp"},
		{ID: "c11", Kind: "process", ForwardType: "fxp", TunnelID: 7},
		{ID: "c12", Kind: "nat", Port: 9000},
		{ID: "c13", Kind: "nat", Port: 9001},
		{ID: "c14", Kind: "mystery"},
	}}
	result := runDiagnosticsTask(fakeDiagnosticsEnv(), task)
	if result.TaskID != "t-1" || len(result.Results) != len(task.Checks) {
		t.Fatalf("result shape wrong: %+v", result)
	}
	want := map[string]string{
		"c1": "pass", "c2": "fail", "c3": "warn", "c4": "pass", "c5": "warn", "c6": "pass", "c7": "fail",
		"c8": "pass", "c9": "fail", "c10": "pass", "c11": "fail", "c12": "pass", "c13": "fail", "c14": "skip",
	}
	for index, entry := range result.Results {
		if entry.ID != task.Checks[index].ID || entry.Kind != task.Checks[index].Kind {
			t.Fatalf("result %d out of order: %+v", index, entry)
		}
		if entry.Status != want[entry.ID] {
			t.Errorf("%s (%s): status %s, want %s — %s", entry.ID, entry.Kind, entry.Status, want[entry.ID], entry.Summary)
		}
		if strings.TrimSpace(entry.Summary) == "" {
			t.Errorf("%s has empty summary", entry.ID)
		}
	}
	if !strings.Contains(result.Results[2].Summary, "ufw") {
		t.Errorf("firewall warn should name ufw: %s", result.Results[2].Summary)
	}
	if !strings.Contains(result.Results[2].Detail, "地区规则") {
		t.Errorf("firewall detail should mention the panel guard: %s", result.Results[2].Detail)
	}
	if result.Results[7].LatencyMs == nil || *result.Results[7].LatencyMs < 12 {
		t.Errorf("dial latency = %v", result.Results[7].LatencyMs)
	}
	if !strings.Contains(result.Results[8].Summary, "拒绝连接") {
		t.Errorf("refused dial should say so: %s", result.Results[8].Summary)
	}
	raw, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{`"taskId"`, `"results"`, `"status"`, `"summary"`, `"durationMs"`, `"startedAt"`, `"finishedAt"`} {
		if !strings.Contains(string(raw), key) {
			t.Errorf("json missing %s: %s", key, raw)
		}
	}
}

func TestRunDiagnosticsTaskTimesOutSlowChecks(t *testing.T) {
	env := fakeDiagnosticsEnv()
	env.now = time.Now
	env.lookupIP = func(ctx context.Context, network, host string) ([]net.IP, error) {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	started := time.Now()
	result := runDiagnosticsTask(env, diagnosticsTask{TaskID: "slow", TimeoutMs: 200, Checks: []diagnosticsCheck{{ID: "a", Kind: "dns", Host: "slow.example"}}})
	if time.Since(started) > 3*time.Second {
		t.Fatalf("task must respect its deadline, took %s", time.Since(started))
	}
	if len(result.Results) != 1 || result.Results[0].ID != "a" || (result.Results[0].Status != "warn" && result.Results[0].Status != "fail") {
		t.Fatalf("slow check should be reported as timeout/failed: %+v", result.Results)
	}
}

func TestDiagnosticsTaskTimeoutIsCapped(t *testing.T) {
	if got := diagnosticsTaskTimeout(diagnosticsTask{TimeoutMs: 600_000}); got != diagnosticsMaxTaskDuration {
		t.Fatalf("timeout should cap at 30s, got %s", got)
	}
	if got := diagnosticsTaskTimeout(diagnosticsTask{}); got != diagnosticsDefaultTimeout {
		t.Fatalf("default timeout = %s", got)
	}
}

func TestFirewallParsers(t *testing.T) {
	if ufwVerdict("Status: inactive\n", 443, "tcp") != "" {
		t.Fatal("inactive ufw must not complain")
	}
	if ufwVerdict("Status: active\n443/tcp DENY Anywhere\n", 443, "tcp") != "deny" {
		t.Fatal("explicit deny")
	}
	if ufwVerdict("Status: active\n443 (v6) ALLOW Anywhere (v6)\n", 443, "tcp") != "allow" {
		t.Fatal("protocol-less allow covers tcp")
	}
	if !firewalldAllows("80/tcp 8000-9000/udp", 8500, "udp") || firewalldAllows("80/tcp 8000-9000/udp", 8500, "tcp") {
		t.Fatal("firewalld range parsing")
	}
	if iptablesChainVerdict("-P INPUT DROP\n-A INPUT -p tcp -m tcp --dport 22 -j ACCEPT\n", "INPUT", 443) != "blocked-policy" {
		t.Fatal("drop policy without accept")
	}
	if iptablesChainVerdict("-P INPUT DROP\n-A INPUT -p tcp -m multiport --dports 80,443 -j ACCEPT\n", "INPUT", 443) != "" {
		t.Fatal("multiport accept should pass")
	}
	if iptablesChainVerdict("-P INPUT ACCEPT\n-A INPUT -p tcp --dport 443 -j DROP\n", "INPUT", 443) != "blocked-rule" {
		t.Fatal("explicit drop rule")
	}
	ruleset := "table inet forwardx_guard {\n chain pre { type filter hook input priority -150; policy drop;\n }\n}\ntable inet filter {\n chain input { type filter hook input priority 0; policy accept;\n }\n}\n"
	if nftDropPolicy(ruleset, "input", 443) {
		t.Fatal("panel's own guard table must be ignored")
	}
	if !nftDropPolicy("table inet filter {\n chain input { type filter hook input priority 0; policy drop;\n tcp dport 22 accept\n }\n}\n", "input", 443) {
		t.Fatal("foreign drop policy without the port")
	}
}

func TestDiagnosticsDportPattern(t *testing.T) {
	pattern := diagnosticsDportPattern(443)
	for _, line := range []string{"tcp dport 443 dnat to 1.2.3.4", "tcp dport { 80, 443 } accept", "-A PREROUTING -p tcp --dport 443 -j DNAT"} {
		if !pattern.MatchString(line) {
			t.Errorf("should match %q", line)
		}
	}
	for _, line := range []string{"tcp dport 4430 dnat", "tcp dport 1443 accept"} {
		if pattern.MatchString(line) {
			t.Errorf("should not match %q", line)
		}
	}
}
