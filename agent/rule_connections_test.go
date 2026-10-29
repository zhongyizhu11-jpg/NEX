package main

import (
	"strings"
	"testing"
)

func TestParseProcNetTCPRowsPicksEstablishedOnPort(t *testing.T) {
	// /proc/net/tcp 的地址是小端字：0100000A = 10.0.0.1，0100007F = 127.0.0.1，2711 = 10001
	text := strings.Join([]string{
		"  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
		"   0: 00000000:2711 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1 0",
		"   1: 0100000A:2711 0200000A:D431 01 00000000:00000000 00:00000000 00000000     0        0 2 0",
		"   2: 0100000A:2711 0100007F:0401 01 00000000:00000000 00:00000000 00000000     0        0 3 0",
		"   3: 0100000A:2712 0300000A:D432 01 00000000:00000000 00:00000000 00000000     0        0 4 0",
		"   4: 0100000A:2711 0400000A:D433 06 00000000:00000000 00:00000000 00000000     0        0 5 0",
	}, "\n")
	rows := parseProcNetTCPRows(strings.NewReader(text), 10001)
	if len(rows) != 1 {
		t.Fatalf("只有一条在端口上、ESTABLISHED、非回环的：%+v", rows)
	}
	if rows[0].Peer != "10.0.0.2:54321" || rows[0].Local != "10.0.0.1:10001" || rows[0].State != "ESTABLISHED" {
		t.Fatalf("行不对：%+v", rows[0])
	}
}

func TestParseSSByteCounters(t *testing.T) {
	text := "0      0      10.0.0.1:10001   10.0.0.2:54321\n\t cubic wscale:7,7 rto:204 bytes_sent:12345 bytes_received:678 segs_out:10\n" +
		"0      0      [::ffff:10.0.0.1]:10001   [::ffff:10.0.0.9]:1111\n\t cubic bytes_sent:1 bytes_received:2\n"
	counters := parseSSByteCounters(text)
	a := counters["10.0.0.2:54321"]
	if a.in == nil || a.out == nil || *a.in != 678 || *a.out != 12345 {
		t.Fatalf("第一条的字节数不对：%+v", a)
	}
	b := counters["10.0.0.9:1111"]
	if b.in == nil || *b.in != 2 {
		t.Fatalf("v4-mapped 地址要归一成 v4：%+v", counters)
	}
}

func TestParseConntrackRowsFiltersPortProtocolAndState(t *testing.T) {
	text := strings.Join([]string{
		"ipv4     2 tcp      6 431999 ESTABLISHED src=203.0.113.5 dst=10.0.0.1 sport=40000 dport=10001 packets=10 bytes=1500 src=10.0.0.1 dst=203.0.113.5 sport=10001 dport=40000 packets=8 bytes=9000 [ASSURED] mark=0 use=1",
		"ipv4     2 tcp      6 100 SYN_SENT src=203.0.113.6 dst=10.0.0.1 sport=40001 dport=10001 packets=1 bytes=60 [UNREPLIED] src=10.0.0.1 dst=203.0.113.6 sport=10001 dport=40001 packets=0 bytes=0 mark=0 use=1",
		"ipv4     2 udp      17 29 src=203.0.113.7 dst=10.0.0.1 sport=5000 dport=10001 packets=3 bytes=300 src=10.0.0.1 dst=203.0.113.7 sport=10001 dport=5000 packets=2 bytes=200 mark=0 use=1",
		"ipv4     2 tcp      6 431999 ESTABLISHED src=203.0.113.8 dst=10.0.0.1 sport=40002 dport=10002 packets=10 bytes=1500 src=10.0.0.1 dst=203.0.113.8 sport=10002 dport=40002 packets=8 bytes=9000 [ASSURED] mark=0 use=1",
	}, "\n")
	rows := parseConntrackRows(strings.NewReader(text), 10001, map[string]bool{"tcp": true, "udp": true})
	if len(rows) != 2 {
		t.Fatalf("要 ESTABLISHED 的 tcp 和那条 udp：%+v", rows)
	}
	if rows[0].Peer != "203.0.113.5:40000" || rows[0].BytesIn == nil || *rows[0].BytesIn != 1500 || *rows[0].BytesOut != 9000 {
		t.Fatalf("tcp 行不对：%+v", rows[0])
	}
	if rows[1].Protocol != "udp" || rows[1].State != "" || *rows[1].BytesIn != 300 {
		t.Fatalf("udp 行不对：%+v", rows[1])
	}
	only := parseConntrackRows(strings.NewReader(text), 10001, map[string]bool{"udp": true})
	if len(only) != 1 || only[0].Protocol != "udp" {
		t.Fatalf("只要 udp 时不该带 tcp：%+v", only)
	}
}

func TestRunRuleConnectionsTaskCapsRows(t *testing.T) {
	result := runRuleConnectionsTask(ruleConnectionsTask{TaskID: "t", Port: 0})
	if result.Error == "" {
		t.Fatal("端口 0 要报错")
	}
}
