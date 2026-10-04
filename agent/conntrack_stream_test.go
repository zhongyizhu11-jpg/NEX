package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// legacyConntrackOriginalTuple / legacyParseConntrackFlowSnapshot 是改成流式解析之前的
// 实现，原样保留在测试里当对照：新实现对同一份输入必须给出完全相同的结果。
func legacyConntrackOriginalTuple(line string) (protocol, sourceIP, targetIP, sourcePort, targetPort string, ok bool) {
	for _, field := range strings.Fields(line) {
		if protocol == "" && (field == "tcp" || field == "udp") {
			protocol = field
			continue
		}
		if sourceIP == "" && strings.HasPrefix(field, "src=") {
			sourceIP = strings.TrimPrefix(field, "src=")
			continue
		}
		if sourceIP != "" && targetIP == "" && strings.HasPrefix(field, "dst=") {
			targetIP = strings.TrimPrefix(field, "dst=")
			continue
		}
		if targetIP != "" && sourcePort == "" && strings.HasPrefix(field, "sport=") {
			sourcePort = strings.TrimPrefix(field, "sport=")
			continue
		}
		if sourcePort != "" && strings.HasPrefix(field, "dport=") {
			targetPort = strings.TrimPrefix(field, "dport=")
			break
		}
	}
	ok = protocol != "" && sourceIP != "" && targetIP != "" && sourcePort != "" && targetPort != ""
	return
}

func legacyParseConntrackFlowSnapshot(raw string, protocolsByPort map[string]map[string]bool) map[string]map[string]struct{} {
	out := make(map[string]map[string]struct{}, len(protocolsByPort))
	for port := range protocolsByPort {
		out[port] = map[string]struct{}{}
	}
	for _, line := range strings.Split(raw, "\n") {
		protocol, sourceIP, targetIP, sourcePort, targetPort, ok := legacyConntrackOriginalTuple(line)
		if !ok || !protocolsByPort[targetPort][protocol] {
			continue
		}
		flow := strings.Join([]string{protocol, sourceIP, targetIP, sourcePort, targetPort}, "|")
		out[targetPort][flow] = struct{}{}
	}
	return out
}

func conntrackFixture() string {
	lines := []string{
		// 普通 NAT 条目：只认原始方向的元组。
		"ipv4     2 tcp      6 431999 ESTABLISHED src=198.51.100.10 dst=192.0.2.20 sport=51000 dport=22022 src=203.0.113.30 dst=198.51.100.10 sport=443 dport=51000 [ASSURED] mark=0 zone=0 use=2",
		"ipv4     2 udp      17 29 src=198.51.100.11 dst=192.0.2.20 sport=52000 dport=22022 [UNREPLIED] src=203.0.113.30 dst=198.51.100.11 sport=443 dport=52000 mark=0 zone=0 use=2",
		"ipv6     10 tcp      6 117 TIME_WAIT src=2001:db8::1 dst=2001:db8::2 sport=40000 dport=443 src=2001:db8::2 dst=2001:db8::1 sport=443 dport=40000 [ASSURED] mark=0 use=1",
		// 同一个流重复出现（去重）。
		"ipv4     2 tcp      6 431999 ESTABLISHED src=198.51.100.10 dst=192.0.2.20 sport=51000 dport=22022 src=203.0.113.30 dst=198.51.100.10 sport=443 dport=51000 [ASSURED] mark=0 zone=0 use=2",
		// 不关心的协议和端口。
		"ipv4     2 icmp     1 29 src=198.51.100.12 dst=192.0.2.20 type=8 code=0 id=1 src=192.0.2.20 dst=198.51.100.12 type=0 code=0 id=1 mark=0 use=1",
		"ipv4     2 tcp      6 60 SYN_SENT src=198.51.100.13 dst=192.0.2.21 sport=53000 dport=8080 [UNREPLIED] src=192.0.2.21 dst=198.51.100.13 sport=8080 dport=53000 mark=0 use=1",
		// 空值字段、残缺行、制表符和行尾回车。
		"ipv4 2 tcp 6 30 ESTABLISHED src= dst=192.0.2.20 sport=1 dport=22022 src=10.0.0.1 dst=10.0.0.2 sport=2 dport=22022",
		"ipv4 2 tcp 6 30 ESTABLISHED src=10.0.0.9 dst=192.0.2.20 sport=9 dport=",
		"ipv4\t2\ttcp\t6\t30\tESTABLISHED\tsrc=10.0.0.3\tdst=192.0.2.20\tsport=3\tdport=443\r",
		"tcp src=10.0.0.4",
		"",
		"   ",
		"ipv4 2 udp 17 30 src=10.0.0.5 dst=192.0.2.20 dport=22022 sport=5 dport=22022",
	}
	// 再加一批大表里常见的条目，确认缓冲区复用没有串行。
	for i := 0; i < 2000; i++ {
		lines = append(lines, fmt.Sprintf("ipv4     2 tcp      6 %d ESTABLISHED src=198.51.%d.%d dst=192.0.2.20 sport=%d dport=%s src=192.0.2.20 dst=198.51.%d.%d sport=22022 dport=%d [ASSURED] mark=0 use=1",
			i, i/250, i%250, 10000+i, []string{"22022", "443", "8080"}[i%3], i/250, i%250, 10000+i))
	}
	return strings.Join(lines, "\n")
}

func TestConntrackStreamingParseMatchesLegacy(t *testing.T) {
	raw := conntrackFixture()
	for _, protocolsByPort := range []map[string]map[string]bool{
		{"22022": {"tcp": true, "udp": true}, "443": {"tcp": true}},
		{"22022": {"udp": true}},
		{"8080": {"tcp": true}, "9999": {"tcp": true}},
		{},
	} {
		want := legacyParseConntrackFlowSnapshot(raw, protocolsByPort)
		got := parseConntrackFlowSnapshot(raw, protocolsByPort)
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("streaming parse differs for %v:\n got  %v\n want %v", protocolsByPort, summarizeFlows(got), summarizeFlows(want))
		}
		path := filepath.Join(t.TempDir(), "nf_conntrack")
		if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
			t.Fatal(err)
		}
		fromFile, err := readConntrackFlowSnapshot(path, protocolsByPort)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(fromFile, want) {
			t.Fatalf("file parse differs for %v", protocolsByPort)
		}
	}
	for _, line := range strings.Split(raw, "\n") {
		lp, ls, lt, lsp, ltp, lok := legacyConntrackOriginalTuple(line)
		np, ns, nt, nsp, ntp, nok := conntrackOriginalTupleBytes([]byte(line))
		if lok != nok || (lok && (lp != string(np) || ls != string(ns) || lt != string(nt) || lsp != string(nsp) || ltp != string(ntp))) {
			t.Fatalf("tuple mismatch for %q: legacy=%v %q %q %q %q %q new=%v %q %q %q %q %q", line, lok, lp, ls, lt, lsp, ltp, nok, np, ns, nt, nsp, ntp)
		}
	}
}

func summarizeFlows(flows map[string]map[string]struct{}) map[string]int {
	out := map[string]int{}
	for port, set := range flows {
		out[port] = len(set)
	}
	return out
}

type failingConntrackReader struct {
	data io.Reader
}

func (r *failingConntrackReader) Read(p []byte) (int, error) {
	n, err := r.data.Read(p)
	if err == io.EOF {
		return n, errors.New("read interrupted")
	}
	return n, err
}

// 读到一半出错必须报错（调用方按读不到处理），不能把半份快照当完整的用。
func TestConntrackStreamingParseReportsReadErrors(t *testing.T) {
	reader := &failingConntrackReader{data: strings.NewReader(conntrackFixture())}
	if _, err := parseConntrackFlowSnapshotReader(reader, map[string]map[string]bool{"22022": {"tcp": true}}); err == nil {
		t.Fatal("partial conntrack read was accepted as a complete snapshot")
	}
	if _, err := readConntrackFlowSnapshot(filepath.Join(t.TempDir(), "missing"), nil); err == nil {
		t.Fatal("missing conntrack file did not report an error")
	}
}

func BenchmarkConntrackParse(b *testing.B) {
	raw := conntrackFixture()
	protocolsByPort := map[string]map[string]bool{"22022": {"tcp": true}}
	b.Run("legacy", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			legacyParseConntrackFlowSnapshot(raw, protocolsByPort)
		}
	})
	b.Run("streaming", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			_, _ = parseConntrackFlowSnapshotReader(strings.NewReader(raw), protocolsByPort)
		}
	})
}
