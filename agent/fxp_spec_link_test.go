package main

import (
	"encoding/json"
	"testing"
)

// 面板下发的链路带宽上限要原样写进 FXP 配置：少了这两个字段，整形就静默失效。
func TestFXPSpecCarriesLinkShapingFields(t *testing.T) {
	var spec fxpSpec
	if err := json.Unmarshal([]byte(`{"role":"exit","tunnelId":9,"linkUpMbps":1500,"linkDownMbps":1560}`), &spec); err != nil {
		t.Fatal(err)
	}
	if spec.LinkUpMbps != 1500 || spec.LinkDownMbps != 1560 {
		t.Fatalf("parsed link fields = %d/%d", spec.LinkUpMbps, spec.LinkDownMbps)
	}
	out, err := json.Marshal(normalizeFXPSpec(spec))
	if err != nil {
		t.Fatal(err)
	}
	var back map[string]any
	if err := json.Unmarshal(out, &back); err != nil {
		t.Fatal(err)
	}
	if back["linkUpMbps"] != float64(1500) || back["linkDownMbps"] != float64(1560) {
		t.Fatalf("fxp config lost the link fields: %s", out)
	}
	zero, _ := json.Marshal(fxpSpec{Role: "exit", TunnelID: 9})
	if string(zero) == "" || json.Valid(zero) && (containsKey(zero, "linkUpMbps") || containsKey(zero, "linkDownMbps")) {
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
