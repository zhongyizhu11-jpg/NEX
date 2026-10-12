package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func opsFixture(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "opsscan", name))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// specLine 把一条结果压成一行，方便整体比较。
func specLine(s opsForwardSpec) string {
	mark := "ok"
	if !s.Importable {
		mark = "no"
	}
	return fmt.Sprintf("%s %s|%d -> %s %s", s.Protocol, s.ListenAddr, s.ListenPort, s.Target, mark)
}

func expectSpecs(t *testing.T, got []opsForwardSpec, want ...string) {
	t.Helper()
	lines := make([]string, len(got))
	for i, s := range got {
		lines[i] = specLine(s)
	}
	if strings.Join(lines, "\n") != strings.Join(want, "\n") {
		t.Fatalf("specs mismatch\n got:\n%s\nwant:\n%s", strings.Join(lines, "\n"), strings.Join(want, "\n"))
	}
}

func TestOpsScanParseRealmTOML(t *testing.T) {
	specs, err := parseRealmTOML(opsFixture(t, "realm.toml"))
	if err != nil {
		t.Fatal(err)
	}
	expectSpecs(t, specs,
		"both 0.0.0.0|10001 -> 203.0.113.10:443 ok",
		"tcp ::|10002 -> example.net:8443 ok",
		"both 0.0.0.0|10003 -> 203.0.113.11:80 no",
		"both 0.0.0.0|10004 -> 203.0.113.13:443 no",
	)
	if !strings.Contains(specs[2].Reason, "多个目标") || !strings.Contains(specs[3].Reason, "传输层") {
		t.Fatalf("unexpected reasons: %q / %q", specs[2].Reason, specs[3].Reason)
	}
}

func TestOpsScanParseRealmJSONAndArgs(t *testing.T) {
	specs, err := parseRealmConfig("/etc/realm/config.json", opsFixture(t, "realm.json"))
	if err != nil {
		t.Fatal(err)
	}
	expectSpecs(t, specs,
		"tcp 0.0.0.0|20001 -> 198.51.100.1:22 ok",
		"udp 0.0.0.0|20002 -> [2001:db8::5]:53 ok",
	)

	execs := opsUnitExecStarts(string(opsFixture(t, "realm-cli.service")))
	if len(execs) != 1 || opsToolFromExec(execs[0][0]) != "realm" {
		t.Fatalf("realm cli unit not recognised: %v", execs)
	}
	configPath, cliSpecs := parseRealmArgs(execs[0])
	if configPath != "" {
		t.Fatalf("unexpected config path %q", configPath)
	}
	expectSpecs(t, cliSpecs, "both 0.0.0.0|40001 -> 203.0.113.60:443 ok")

	execs = opsUnitExecStarts(string(opsFixture(t, "realm-config.service")))
	if configPath, _ := parseRealmArgs(execs[0]); configPath != "/etc/realm/config.toml" {
		t.Fatalf("config path = %q", configPath)
	}
}

func TestOpsScanParseGostYAMLAndJSON(t *testing.T) {
	specs, err := parseGostConfig("/etc/gost/gost.yml", opsFixture(t, "gost.yml"))
	if err != nil {
		t.Fatal(err)
	}
	expectSpecs(t, specs,
		"tcp |30001 -> 192.0.2.1:80 ok",
		"udp |30002 -> 192.0.2.2:53 ok",
		"tcp |30003 ->  no",
		"tcp |30004 -> 192.0.2.3:80 no",
	)
	if !strings.Contains(specs[2].Reason, "代理服务") {
		t.Fatalf("socks5 service should be described as a proxy, got %q", specs[2].Reason)
	}

	specs, err = parseGostConfig("/etc/gost/config.json", opsFixture(t, "gost.json"))
	if err != nil {
		t.Fatal(err)
	}
	expectSpecs(t, specs,
		"tcp |31001 -> 192.0.2.10:443 ok",
		"udp |31002 -> 192.0.2.11:53 ok",
		"tcp |31003 -> 192.0.2.12:80 no",
	)
}

func TestOpsScanParseGostArgs(t *testing.T) {
	execs := opsUnitExecStarts(string(opsFixture(t, "gost.service")))
	if len(execs) != 1 || opsToolFromExec(execs[0][0]) != "gost" {
		t.Fatalf("gost unit not recognised: %v", execs)
	}
	configPath, specs := parseGostArgs(execs[0])
	if configPath != "" {
		t.Fatalf("unexpected config path %q", configPath)
	}
	expectSpecs(t, specs,
		"tcp |32001 -> 192.0.2.20:22 ok",
		"udp |32002 -> 192.0.2.21:53 ok",
		"tcp |32003 -> 127.0.0.1:22 no",
	)
	_, chained := parseGostArgs([]string{"gost", "-L", "tcp://:9000/192.0.2.30:80", "-F", "relay+tls://203.0.113.9:443"})
	expectSpecs(t, chained, "tcp |9000 -> 192.0.2.30:80 no")
	if path, _ := parseGostArgs([]string{"gost", "-C", "/etc/gost/gost.yml"}); path != "/etc/gost/gost.yml" {
		t.Fatalf("config path = %q", path)
	}
}

func TestOpsScanParseSocatExecStart(t *testing.T) {
	execs := opsUnitExecStarts(string(opsFixture(t, "socat.service")))
	if len(execs) != 1 || opsToolFromExec(execs[0][0]) != "socat" {
		t.Fatalf("socat unit not recognised: %v", execs)
	}
	expectSpecs(t, parseSocatArgs(execs[0]), "tcp 10.0.0.5|8443 -> 203.0.113.50:443 ok")

	execs = opsUnitExecStarts(string(opsFixture(t, "socat-udp.service")))
	if len(execs) != 1 || opsToolFromExec(execs[0][0]) != "socat" {
		t.Fatalf("sh -c socat unit not recognised: %v", execs)
	}
	expectSpecs(t, parseSocatArgs(execs[0]), "udp |5353 -> [2001:db8::53]:53 ok")

	expectSpecs(t, parseSocatArgs([]string{"socat", "TCP-LISTEN:7000,fork", "UDP:192.0.2.9:7000"}), "tcp |7000 -> 192.0.2.9:7000 no")
	if specs := parseSocatArgs([]string{"socat", "STDIO", "TCP:192.0.2.9:80"}); len(specs) != 0 {
		t.Fatalf("non-listening socat must be ignored: %v", specs)
	}
}

func TestOpsScanParseIptablesSave(t *testing.T) {
	specs := parseIptablesSaveNAT(string(opsFixture(t, "iptables-save.txt")), "iptables")
	expectSpecs(t, specs,
		"tcp |50001 -> 198.51.100.20:443 ok",
		"udp |50001 -> 198.51.100.20:443 ok",
		"tcp 10.0.0.5|50002 -> 198.51.100.21:50002 ok",
		"tcp |50003 -> 198.51.100.22 no",
		"tcp |50020 -> 198.51.100.30:443 ok",
		"tcp |51000 -> 198.51.100.99:80 ok",
		"tcp |50030 -> 198.51.100.31:8080 ok",
	)
	if specs[0].refs[0].Line != "-A PREROUTING -p tcp -m tcp --dport 50001 -j DNAT --to-destination 198.51.100.20:443" {
		t.Fatalf("ref line = %q", specs[0].refs[0].Line)
	}
	commands, err := opsStopCommands(opsScanItem{refs: specs[2].refs})
	if err != nil {
		t.Fatal(err)
	}
	want := "iptables $FWX_IPT_WAIT -t nat '-D' 'PREROUTING' '-d' '10.0.0.5/32' '-p' 'tcp' '-m' 'tcp' '--dport' '50002' '-m' 'comment' '--comment' 'my old rule' '-j' 'DNAT' '--to-destination' '198.51.100.21'"
	if len(commands) != 1 || commands[0] != want {
		t.Fatalf("delete command:\n got %q\nwant %q", commands, want)
	}
}

func TestOpsScanParseNftJSON(t *testing.T) {
	specs, err := parseNftDNAT(opsFixture(t, "nft.json"))
	if err != nil {
		t.Fatal(err)
	}
	expectSpecs(t, specs,
		"tcp |60001 -> 192.0.2.100:8443 ok",
		"udp |60002 -> 192.0.2.101:60002 ok",
		"tcp |50020 -> 198.51.100.30:443 ok",
	)
	commands, err := opsStopCommands(opsScanItem{refs: specs[0].refs})
	if err != nil || len(commands) != 1 || commands[0] != "nft delete rule 'ip' 'mynat' 'prerouting' handle 4" {
		t.Fatalf("nft delete command = %q %v", commands, err)
	}
}

// 汇总：面板自己的端口去掉、tcp+udp 合并、和 iptables 重复的 nft 去掉、key 稳定。
func TestOpsScanFinalizeItems(t *testing.T) {
	ipt := opsItemsFromSpecs("iptables", "iptables-save", "", parseIptablesSaveNAT(string(opsFixture(t, "iptables-save.txt")), "iptables"))
	nftSpecs, _ := parseNftDNAT(opsFixture(t, "nft.json"))
	nft := opsItemsFromSpecs("nftables", "nft ruleset", "", nftSpecs)
	items := opsFinalizeScanItems(append(ipt, nft...), map[int]bool{51000: true})
	byPort := map[int][]opsScanItem{}
	for _, item := range items {
		byPort[item.ListenPort] = append(byPort[item.ListenPort], item)
		if item.Key == "" {
			t.Fatalf("item without key: %+v", item)
		}
	}
	if len(byPort[51000]) != 0 {
		t.Fatal("panel-managed port must be excluded")
	}
	if len(byPort[50001]) != 1 || byPort[50001][0].Protocol != "both" || len(byPort[50001][0].refs) != 2 {
		t.Fatalf("tcp+udp should merge into one item with both rules: %+v", byPort[50001])
	}
	if len(byPort[50020]) != 1 || byPort[50020][0].Tool != "iptables" {
		t.Fatalf("nft duplicate of an iptables rule should be dropped: %+v", byPort[50020])
	}
	if len(byPort[60001]) != 1 {
		t.Fatalf("nft-only rule should stay: %+v", byPort[60001])
	}
	again := opsFinalizeScanItems(append(
		opsItemsFromSpecs("iptables", "iptables-save", "", parseIptablesSaveNAT(string(opsFixture(t, "iptables-save.txt")), "iptables")),
		opsItemsFromSpecs("nftables", "nft ruleset", "", nftSpecs)...,
	), map[int]bool{51000: true})
	for i := range items {
		if items[i].Key != again[i].Key {
			t.Fatal("keys must be stable across scans")
		}
	}
	// refs 只在本地用，不能出现在上报里。
	raw, _ := json.Marshal(items[0])
	if strings.Contains(string(raw), "refs") || strings.Contains(string(raw), "-A PREROUTING") {
		t.Fatalf("refs leaked into the report: %s", raw)
	}
}

func TestOpsStopCommandsForUnits(t *testing.T) {
	commands, err := opsStopCommands(opsScanItem{Unit: "realm"})
	if err != nil || len(commands) != 2 || commands[0] != "systemctl stop 'realm.service'" {
		t.Fatalf("unit stop commands = %q %v", commands, err)
	}
	if _, err := opsStopCommands(opsScanItem{Unit: "forwardx-realm-1000"}); err == nil {
		t.Fatal("panel units must never be stopped from an import")
	}
	if _, err := opsStopCommands(opsScanItem{Unit: "bad;name"}); err == nil {
		t.Fatal("invalid unit names must be refused")
	}
	if _, err := opsStopCommands(opsScanItem{}); err == nil {
		t.Fatal("an item without unit or rules cannot be stopped")
	}
}

func TestOpsMiniYAML(t *testing.T) {
	parsed, err := parseMiniYAML("a: 1\nb:\n  - x\n  - 'y # not a comment'\nc:\n- k: v\n  n: [1, 2]\nd: {}\n")
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(parsed)
	want := `{"a":"1","b":["x","y # not a comment"],"c":[{"k":"v","n":["1","2"]}],"d":{}}`
	if string(raw) != want {
		t.Fatalf("yaml = %s, want %s", raw, want)
	}
}
