package main

import (
	"strings"
	"testing"
)

func TestOnlineDecodeProcNetAddr(t *testing.T) {
	ip, port, ok := decodeProcNetAddr("0100007F:1F90")
	if !ok || ip.String() != "127.0.0.1" || port != 8080 {
		t.Fatalf("v4 decode = %v %d %v", ip, port, ok)
	}
	// 203.0.113.9 小端 = 09 71 00 CB
	ip, port, ok = decodeProcNetAddr("097100CB:01BB")
	if !ok || ip.String() != "203.0.113.9" || port != 443 {
		t.Fatalf("v4 decode = %v %d %v", ip, port, ok)
	}
	// ::ffff:203.0.113.9 在 tcp6 里：0000000000000000FFFF0000097100CB
	ip, _, ok = decodeProcNetAddr("0000000000000000FFFF0000097100CB:01BB")
	if !ok || ip.String() != "203.0.113.9" {
		t.Fatalf("mapped decode = %v %v", ip, ok)
	}
	// 2001:db8::1 —— 每 4 字节一组小端：B80D0120 00000000 00000000 01000000
	ip, _, ok = decodeProcNetAddr("B80D0120000000000000000001000000:0016")
	if !ok || ip.String() != "2001:db8::1" {
		t.Fatalf("v6 decode = %v %v", ip, ok)
	}
	if _, _, ok := decodeProcNetAddr("zz:1"); ok {
		t.Fatal("bad hex accepted")
	}
}

func TestOnlineParseProcNetEstablished(t *testing.T) {
	fixture := strings.Join([]string{
		"  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
		"   0: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 100 1",
		"   1: 0200000A:1F90 097100CB:D431 01 00000000:00000000 00:00000000 00000000     0        0 101 1",
		"   2: 0200000A:1F90 097100CB:D432 01 00000000:00000000 00:00000000 00000000     0        0 102 1",
		"   3: 0200000A:1F90 0A7100CB:D433 06 00000000:00000000 00:00000000 00000000     0        0 103 1",
		"   4: 0200000A:1F90 0100007F:D434 01 00000000:00000000 00:00000000 00000000     0        0 104 1",
		"   5: 0200000A:0050 0B7100CB:D435 01 00000000:00000000 00:00000000 00000000     0        0 105 1",
	}, "\n")
	counts := map[string]int{}
	parseProcNetEstablished(strings.NewReader(fixture), map[int]bool{8080: true}, func(port int, ip string) {
		counts[ip]++
		if port != 8080 {
			t.Fatalf("unexpected port %d", port)
		}
	})
	if len(counts) != 1 || counts["203.0.113.9"] != 2 {
		t.Fatalf("counts = %v", counts)
	}
}

func TestOnlineParseConntrack(t *testing.T) {
	fixture := strings.Join([]string{
		"ipv4     2 tcp      6 431999 ESTABLISHED src=198.51.100.7 dst=10.0.0.2 sport=50000 dport=8443 src=192.0.2.1 dst=10.0.0.2 sport=443 dport=50000 [ASSURED] mark=0 zone=0 use=2",
		"ipv4     2 tcp      6 119 SYN_SENT src=198.51.100.8 dst=10.0.0.2 sport=50001 dport=8443 [UNREPLIED] src=192.0.2.1 dst=10.0.0.2 sport=443 dport=50001 mark=0 zone=0 use=2",
		"ipv4     2 udp      17 29 src=198.51.100.9 dst=10.0.0.2 sport=40000 dport=8443 src=192.0.2.1 dst=10.0.0.2 sport=443 dport=40000 mark=0 zone=0 use=2",
		"ipv4     2 udp      17 29 src=198.51.100.10 dst=10.0.0.2 sport=40000 dport=9000 src=192.0.2.1 dst=10.0.0.2 sport=443 dport=40000 mark=0 zone=0 use=2",
		"ipv6     10 udp      17 29 src=2001:db8::5 dst=2001:db8::1 sport=40000 dport=8443 src=2001:db8::9 dst=2001:db8::1 sport=443 dport=40000 mark=0 zone=0 use=2",
	}, "\n")
	got := map[string]int{}
	parseConntrackOnline(strings.NewReader(fixture), map[int]map[string]bool{8443: {"tcp": true, "udp": true}}, 0, func(port int, ip string) {
		got[ip]++
	})
	if len(got) != 3 || got["198.51.100.7"] != 1 || got["198.51.100.9"] != 1 || got["2001:db8::5"] != 1 {
		t.Fatalf("conntrack = %v", got)
	}
	// 只选 udp 时，TCP 条目不算。
	got = map[string]int{}
	parseConntrackOnline(strings.NewReader(fixture), map[int]map[string]bool{8443: {"udp": true}}, 0, func(port int, ip string) { got[ip]++ })
	if len(got) != 2 || got["198.51.100.7"] != 0 {
		t.Fatalf("udp only = %v", got)
	}
	// 行数上限。
	got = map[string]int{}
	parseConntrackOnline(strings.NewReader(fixture), map[int]map[string]bool{8443: {"tcp": true, "udp": true}}, 1, func(port int, ip string) { got[ip]++ })
	if len(got) != 1 {
		t.Fatalf("maxLines = %v", got)
	}
}

func TestOnlinePortSelectionAndReport(t *testing.T) {
	ports := []onlineWatchPort{
		{Port: 1000, Proto: "both", RuleID: 1},
		{Port: 2000, Proto: "tcp", RuleID: 2, DNAT: true},
		{Port: 3000, Proto: "udp", InboundID: 3},
	}
	sel := buildOnlinePortSelection(ports)
	if !sel.procTCP[1000] || sel.procTCP[2000] || sel.procTCP[3000] {
		t.Fatalf("procTCP = %v", sel.procTCP)
	}
	if !sel.conntrack[1000]["udp"] || sel.conntrack[1000]["tcp"] || !sel.conntrack[2000]["tcp"] || !sel.conntrack[3000]["udp"] {
		t.Fatalf("conntrack = %v", sel.conntrack)
	}

	firstSeen := map[string]int64{"1000|9.9.9.9": 50, "1000|8.8.8.8": 10}
	counts := map[int]map[string]int{1000: {"9.9.9.9": 2, "1.1.1.1": 5}}
	report := buildOnlineReport(ports, counts, firstSeen, 100)
	if len(report.Ports) != 3 {
		t.Fatalf("ports = %d", len(report.Ports))
	}
	first := report.Ports[0]
	if first.RuleID != 1 || len(first.IPs) != 2 || first.IPs[0].IP != "1.1.1.1" || first.IPs[0].Since != 100 || first.IPs[1].Since != 50 {
		t.Fatalf("first port = %+v", first)
	}
	if _, ok := firstSeen["1000|8.8.8.8"]; ok {
		t.Fatal("gone IP kept its first-seen time")
	}
	if report.Ports[2].InboundID != 3 || report.Ports[2].IPs == nil {
		t.Fatalf("empty port should report an empty list: %+v", report.Ports[2])
	}
}
