package main

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func singboxEgressBridgeSample() map[string]any {
	return map[string]any{
		"log": map[string]any{"level": "warn"},
		"inbounds": []any{map[string]any{
			"type": "socks", "tag": "bridge-7", "listen": "127.0.0.1", "listen_port": 36007,
			"users": []any{map[string]any{"username": "r7-abc", "password": "secret"}},
		}},
		"outbounds": []any{map[string]any{
			"type": "vless", "tag": "egress-7", "server": "203.0.113.9", "server_port": 443,
			"uuid": "0b9c2f7e-8a36-4a6e-9a51-3c2b1f2d4e5f", "flow": "xtls-rprx-vision",
			"tls": map[string]any{
				"enabled": true, "server_name": "www.example.com",
				"utls":    map[string]any{"enabled": true, "fingerprint": "chrome"},
				"reality": map[string]any{"enabled": true, "public_key": base64.RawURLEncoding.EncodeToString(make([]byte, 32)), "short_id": "a1b2"},
			},
		}},
		"route": map[string]any{"rules": []any{map[string]any{"inbound": []any{"bridge-7"}, "outbound": "egress-7"}}},
	}
}

func encodeBridge(t *testing.T, cfg map[string]any) []byte {
	t.Helper()
	data, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestSingboxEgressBridgeAcceptsPanelShape(t *testing.T) {
	if err := validateSingboxEgressBridgeConfig(singboxEgressBridgeConfigPath, encodeBridge(t, singboxEgressBridgeSample())); err != nil {
		t.Fatalf("expected valid bridge config, got %v", err)
	}
	// 别的路径（落地入站那份 config.json）不归这里管。
	if err := validateSingboxEgressBridgeConfig("/etc/forwardx/singbox/config.json", []byte(`{"inbounds":[{"type":"socks","listen":"::"}]}`)); err != nil {
		t.Fatalf("other paths must pass through, got %v", err)
	}
}

func TestSingboxEgressBridgeRejectsUnsafeConfigs(t *testing.T) {
	cases := map[string]func(cfg map[string]any){
		"public listen": func(cfg map[string]any) {
			cfg["inbounds"].([]any)[0].(map[string]any)["listen"] = "::"
		},
		"no credentials": func(cfg map[string]any) {
			cfg["inbounds"].([]any)[0].(map[string]any)["users"] = []any{}
		},
		"direct outbound": func(cfg map[string]any) {
			cfg["outbounds"] = append(cfg["outbounds"].([]any), map[string]any{"type": "direct", "tag": "direct"})
		},
		"no reality": func(cfg map[string]any) {
			tlsCfg := cfg["outbounds"].([]any)[0].(map[string]any)["tls"].(map[string]any)
			delete(tlsCfg, "reality")
		},
		"bad public key": func(cfg map[string]any) {
			tlsCfg := cfg["outbounds"].([]any)[0].(map[string]any)["tls"].(map[string]any)
			tlsCfg["reality"].(map[string]any)["public_key"] = "short"
		},
		"no vision": func(cfg map[string]any) {
			cfg["outbounds"].([]any)[0].(map[string]any)["flow"] = ""
		},
		"unrouted inbound": func(cfg map[string]any) {
			cfg["route"] = map[string]any{"rules": []any{}}
		},
		"final to unknown": func(cfg map[string]any) {
			cfg["route"].(map[string]any)["final"] = "direct"
		},
	}
	for name, mutate := range cases {
		cfg := singboxEgressBridgeSample()
		mutate(cfg)
		err := validateSingboxEgressBridgeConfig(singboxEgressBridgeConfigPath, encodeBridge(t, cfg))
		if err == nil {
			t.Fatalf("%s: expected rejection", name)
		}
		if strings.Contains(err.Error(), "secret") || strings.Contains(err.Error(), "0b9c2f7e") {
			t.Fatalf("%s: error must not leak credentials: %v", name, err)
		}
	}
}

func TestManagedConfigValidationRunsBridgeCheck(t *testing.T) {
	cfg := singboxEgressBridgeSample()
	cfg["inbounds"].([]any)[0].(map[string]any)["listen"] = "0.0.0.0"
	spec := managedConfigSpec{Path: singboxEgressBridgeConfigPath, Format: "json"}
	if err := validateManagedConfigSpec(spec, encodeBridge(t, cfg), ""); err == nil {
		t.Fatal("managed config validation must reject a bridge listening on a public address")
	}
}
