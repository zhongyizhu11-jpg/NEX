package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func testV3EntrySpec(tunnelID, ruleID, port int) fxpSpec {
	spec := testV1EntrySpec(tunnelID, ruleID, port)
	spec.TransportVersion = "v3"
	spec.V3Transport = "ws"
	spec.V3Host = "outer.example"
	spec.V3Path = "/stream"
	return spec
}

// V3 不能被归一成 v1，外层选项要原样进 FXP 配置。
func TestFXPV3NormalizationAndSerializationPreserveTransport(t *testing.T) {
	no := false
	spec := testV3EntrySpec(301, 1, 23001)
	spec.TransportVersion = " V3 "
	spec.V3Transport = " WS "
	spec.V3Multiplex = &no
	normalized := normalizeFXPSpec(spec)
	if normalized.TransportVersion != "v3" || normalized.V3Transport != "ws" || validateFXPTransport(normalized) != nil {
		t.Fatalf("V3 被降级了: %#v", normalized)
	}
	raw, err := json.Marshal(normalized)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{`"transportVersion":"v3"`, `"v3Transport":"ws"`, `"v3Host":"outer.example"`, `"v3Path":"/stream"`, `"v3Multiplex":false`} {
		if !strings.Contains(string(raw), key) {
			t.Fatalf("FXP 配置里缺 %s: %s", key, raw)
		}
	}
	if fxpServerID(normalized) == fxpServerID(testV1EntrySpec(301, 1, 23001)) {
		t.Fatal("V3 和 V1 共用了运行时身份")
	}
	if fxpConfigPath(normalized) == fxpConfigPath(testV1EntrySpec(301, 1, 23001)) {
		t.Fatal("V3 和 V1 共用了配置文件")
	}
	// V1 的配置里不多出 V3 字段。
	legacy, _ := json.Marshal(normalizeFXPSpec(testV1EntrySpec(301, 1, 23001)))
	if strings.Contains(string(legacy), "v3") {
		t.Fatalf("V1 配置多出了 V3 字段: %s", legacy)
	}
}

func TestFXPV3EntryGroupsRestoreAndRemoval(t *testing.T) {
	first := testV3EntrySpec(302, 1, 23001)
	second := testV3EntrySpec(302, 2, 23002)
	group, ok := buildSharedFXPEntryGroup([]fxpSpec{first, second}, 302, "v3")
	if !ok {
		t.Fatal("V3 入口组没建出来")
	}
	if group.V3Transport != "ws" || group.V3Host != first.V3Host || group.V3Path != first.V3Path || validateFXPTransport(group) != nil {
		t.Fatalf("入口组丢了 V3 选项: %#v", group)
	}
	requireFXPEntryGroupMembers(t, group, first, second)
	plans := planPersistedFXPRestoreSpecs([]fxpSpec{first, second, testV1EntrySpec(302, 3, 23003)})
	if len(plans) != 2 {
		t.Fatalf("V3 和 V1 的入口混进了一个组: %d", len(plans))
	}
	if !fxpRemovalMatchesEntry(fxpSpec{TransportVersion: "v3", TunnelID: 302, RuleID: 1}, first) || fxpRemovalMatchesEntry(fxpSpec{TransportVersion: "v1", TunnelID: 302, RuleID: 1}, first) {
		t.Fatal("按传输版本删除没有隔离开")
	}
	// 一个组里的入口外层选项不一致：拒。
	mixed := group
	mixed.Entries = append([]fxpSpec(nil), group.Entries...)
	mixed.Entries[0].V3Host = "mismatched"
	if validateFXPTransport(mixed) == nil {
		t.Fatal("同一组里外层选项不一致却通过了")
	}
}

func TestFXPV3SignatureTracksAllOuterSettings(t *testing.T) {
	base := normalizeFXPSpec(testV3EntrySpec(303, 1, 23001))
	signature := fxpServerSignature(base)
	for name, change := range map[string]func(*fxpSpec){
		"transport": func(s *fxpSpec) { s.V3Transport = "http" },
		"host":      func(s *fxpSpec) { s.V3Host = "other" },
		"path":      func(s *fxpSpec) { s.V3Path = "/other" },
		"ua":        func(s *fxpSpec) { s.V3UserAgent = "curl/8" },
		"sni":       func(s *fxpSpec) { s.V3ServerName = "other" },
		"mux":       func(s *fxpSpec) { no := false; s.V3Multiplex = &no },
	} {
		other := base
		change(&other)
		if fxpServerSignature(other) == signature {
			t.Fatalf("改了 %s，签名没变", name)
		}
	}
	yes := true
	equivalent := base
	equivalent.V3Multiplex = &yes
	if fxpServerSignature(equivalent) != signature {
		t.Fatal("显式写 true 和没写（默认开）应该是同一个签名")
	}
}

func TestFXPV3InvalidOptionsFailBeforeTouchingRuntime(t *testing.T) {
	valid := testV3EntrySpec(304, 1, 23001)
	for name, change := range map[string]func(*fxpSpec){
		"unknown version": func(s *fxpSpec) { s.TransportVersion = "v4" },
		"bad transport":   func(s *fxpSpec) { s.V3Transport = "wss" },
		"no transport":    func(s *fxpSpec) { s.V3Transport = "" },
		"v1 with options": func(s *fxpSpec) { s.TransportVersion = "v1" },
		"path injection":  func(s *fxpSpec) { s.V3Path = "/bad\r\nX: y" },
		"ua injection":    func(s *fxpSpec) { s.V3UserAgent = "a\nb" },
		"bad sni":         func(s *fxpSpec) { s.V3Transport = "tls"; s.V3ServerName = "has space" },
	} {
		bad := valid
		change(&bad)
		message := &actionMessage{}
		if startFXPProcessLockedWithPersistence(Config{}, bad, message, false) {
			t.Fatalf("%s: 非法的 V3 配置被启动了", name)
		}
		if !strings.Contains(message.get(), "fxp invalid transport") {
			t.Fatalf("%s: 非法配置走到了运行时那一步: %s", name, message.get())
		}
	}
	if got := normalizeFXPTransportVersion(" V4 "); got != "v4" {
		t.Fatalf("不认识的版本被悄悄归成了 %s", got)
	}
	if got := normalizeFXPTransportVersion(""); got != "v1" {
		t.Fatalf("没写版本应该是 v1，得到 %s", got)
	}
}

func TestFXPV3LocalRuntimeReportsActualVersion(t *testing.T) {
	entry := testV3EntrySpec(305, 1, 23001)
	state := localRuleState{RuleID: 1, TunnelID: 305, Port: "23001", Protocol: "tcp", ForwardType: "forwardx"}
	if got := fxpTransportVersionForLocalRule(state, []fxpSpec{entry}); got != "v3" {
		t.Fatalf("本地规则报的传输版本不对: %q", got)
	}
	exit := entry
	exit.Role = "exit"
	exit.RuleID = 0
	if got := fxpTransportVersionForLocalTunnel(305, 23001, []fxpSpec{exit}); got != "v3" {
		t.Fatalf("本地隧道报的传输版本不对: %q", got)
	}
}

func TestFXPLegacySignaturesDoNotGainV3Fields(t *testing.T) {
	for _, version := range []string{"v1", "v2"} {
		spec := testV1EntrySpec(306, 1, 23001)
		spec.TransportVersion = version
		if strings.Contains(fxpServerSignature(spec), "v3-options:") {
			t.Fatal("V1 / V2 的签名因为支持 V3 变了")
		}
		if normalizeFXPSpec(spec).TransportVersion != version || validateFXPTransport(normalizeFXPSpec(spec)) != nil {
			t.Fatal("V1 / V2 的归一化变了")
		}
	}
}
