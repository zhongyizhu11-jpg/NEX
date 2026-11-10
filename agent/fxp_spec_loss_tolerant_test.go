package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// 抗丢包传输开关要原样进 FXP 配置、打开时进签名；关着时配置和签名都和以前一模一样。
func TestFXPSpecCarriesLossTolerantSwitch(t *testing.T) {
	var spec fxpSpec
	if err := json.Unmarshal([]byte(`{"role":"exit","tunnelId":9,"listenPort":23001,"protocol":"both","udpListenPort":24001,"lossTolerant":true}`), &spec); err != nil {
		t.Fatal(err)
	}
	if !spec.LossTolerant {
		t.Fatalf("lossTolerant not parsed: %+v", spec)
	}
	off := spec
	off.LossTolerant = false
	if fxpServerSignature(off) == fxpServerSignature(spec) {
		t.Fatal("开关抗丢包传输必须改变签名")
	}
	if strings.Contains(fxpServerSignature(off), "loss-tolerant") {
		t.Fatal("关着时签名里不该有这一项（升级不重启 FXP）")
	}
	out, _ := json.Marshal(normalizeFXPSpec(spec))
	if !containsKey(out, "lossTolerant") {
		t.Fatalf("fxp config lost lossTolerant: %s", out)
	}
	zero, _ := json.Marshal(fxpSpec{Role: "exit", TunnelID: 9})
	if containsKey(zero, "lossTolerant") {
		t.Fatalf("lossTolerant must be omitted when off: %s", zero)
	}
	// UDP 直连在 mimic 端口上时，承载用的同号 UDP 端口也算这个运行时的监听。
	endpoints := fxpListenEndpoints(spec)
	if endpoints["udp:23001"] != 23001 || endpoints["udp"] != 24001 || endpoints["tcp"] != 23001 {
		t.Fatalf("监听端点不对: %+v", endpoints)
	}
	if got := fxpListenEndpoints(off); len(got) != 2 {
		t.Fatalf("关着时不该多出端点: %+v", got)
	}
	// UDP 直连就在同号端口上时不重复记。
	shared := spec
	shared.UDPListenPort = 0
	if got := fxpListenEndpoints(shared); len(got) != 2 {
		t.Fatalf("同号端口不该重复记: %+v", got)
	}
	// 入口只拨不收，不多记。
	entry := spec
	entry.Role = "entry"
	if _, ok := fxpListenEndpoints(entry)["udp:23001"]; ok {
		t.Fatal("入口不该多记 UDP 端点")
	}
}
