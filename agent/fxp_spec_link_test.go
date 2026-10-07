package main

import (
	"encoding/json"
	"testing"
)

// 面板下发的链路带宽上限要原样写进 FXP 配置：少了这两个字段，整形就静默失效。
func TestFXPSpecCarriesLinkShapingFields(t *testing.T) {
	var spec fxpSpec
	if err := json.Unmarshal([]byte(`{"role":"exit","tunnelId":9,"linkShaping":"auto","linkUpMbps":1500,"linkDownMbps":1560,"linkUpHintMbps":1480,"linkDownHintMbps":1520}`), &spec); err != nil {
		t.Fatal(err)
	}
	if spec.LinkShaping != "auto" || spec.LinkUpMbps != 1500 || spec.LinkDownMbps != 1560 || spec.LinkUpHintMbps != 1480 || spec.LinkDownHintMbps != 1520 {
		t.Fatalf("parsed link fields = %+v", spec)
	}
	// 档位和手动上限进签名（变了要热更新），提示值不进（只在 FXP 启动时用）。
	base := fxpServerSignature(spec)
	changed := spec
	changed.LinkShaping = "manual"
	if fxpServerSignature(changed) == base {
		t.Fatal("mode change must change the signature")
	}
	hinted := spec
	hinted.LinkUpHintMbps = 1
	if fxpServerSignature(hinted) != base {
		t.Fatal("hint change must not change the signature")
	}
	out, err := json.Marshal(normalizeFXPSpec(spec))
	if err != nil {
		t.Fatal(err)
	}
	var back map[string]any
	if err := json.Unmarshal(out, &back); err != nil {
		t.Fatal(err)
	}
	if back["linkShaping"] != "auto" || back["linkUpMbps"] != float64(1500) || back["linkDownMbps"] != float64(1560) || back["linkUpHintMbps"] != float64(1480) || back["linkDownHintMbps"] != float64(1520) {
		t.Fatalf("fxp config lost the link fields: %s", out)
	}
	zero, _ := json.Marshal(fxpSpec{Role: "exit", TunnelID: 9})
	if string(zero) == "" || json.Valid(zero) && (containsKey(zero, "linkShaping") || containsKey(zero, "linkUpMbps") || containsKey(zero, "linkDownMbps") || containsKey(zero, "linkUpHintMbps")) {
		t.Fatalf("unset link fields must be omitted so old FXP configs stay byte-identical: %s", zero)
	}
}

func containsKey(raw []byte, key string) bool {
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return false
	}
	_, ok := m[key]
	return ok
}

// 主机公网出口整形的三个字段也要原样进 FXP 配置：档位和手动上限进签名，提示值不进。
func TestFXPSpecCarriesEgressShapingFields(t *testing.T) {
	var spec fxpSpec
	if err := json.Unmarshal([]byte(`{"role":"entry","tunnelId":9,"ruleId":1,"listenPort":1000,"key":"k","egressShaping":"auto","egressMbps":500,"egressHintMbps":488}`), &spec); err != nil {
		t.Fatal(err)
	}
	if spec.EgressShaping != "auto" || spec.EgressMbps != 500 || spec.EgressHintMbps != 488 {
		t.Fatalf("parsed egress fields = %+v", spec)
	}
	base := fxpServerSignature(spec)
	changed := spec
	changed.EgressShaping = "off"
	if fxpServerSignature(changed) == base {
		t.Fatal("egress mode change must change the signature")
	}
	limit := spec
	limit.EgressMbps = 450
	if fxpServerSignature(limit) == base {
		t.Fatal("egress limit change must change the signature")
	}
	hinted := spec
	hinted.EgressHintMbps = 1
	if fxpServerSignature(hinted) != base {
		t.Fatal("egress hint change must not change the signature")
	}
	out, err := json.Marshal(normalizeFXPSpec(spec))
	if err != nil {
		t.Fatal(err)
	}
	var back map[string]any
	if err := json.Unmarshal(out, &back); err != nil {
		t.Fatal(err)
	}
	if back["egressShaping"] != "auto" || back["egressMbps"] != float64(500) || back["egressHintMbps"] != float64(488) {
		t.Fatalf("fxp config lost the egress fields: %s", out)
	}
	zero, _ := json.Marshal(fxpSpec{Role: "exit", TunnelID: 9})
	if containsKey(zero, "egressShaping") || containsKey(zero, "egressMbps") || containsKey(zero, "egressHintMbps") {
		t.Fatalf("unset egress fields must be omitted: %s", zero)
	}
}
