package main

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 面板 server/ssEgress.ts 的 buildGostEgressChain 生成的就是这个形状：一条链、一跳、一个 ss / ssu 节点。
func egressChainConfig(t *testing.T, connector string, dialer string, method string, password string, addr string) []byte {
	t.Helper()
	node := map[string]any{
		"name": "egress-7-" + dialer,
		"addr": addr,
		"connector": map[string]any{
			"type": connector,
			"auth": map[string]any{"username": method, "password": password},
		},
		"dialer": map[string]any{"type": dialer},
	}
	if connector == "ss" {
		node["connector"].(map[string]any)["metadata"] = map[string]any{"nodelay": true}
	}
	cfg := map[string]any{
		"services": []any{map[string]any{
			"name":     "fwx-7-" + dialer,
			"addr":     ":20007",
			"handler":  map[string]any{"type": dialer, "chain": "chain-egress-7-" + dialer},
			"listener": map[string]any{"type": dialer},
			"forwarder": map[string]any{"nodes": []any{map[string]any{
				"name": "target-7", "addr": "198.51.100.7:443",
				"connector": map[string]any{"type": dialer}, "dialer": map[string]any{"type": dialer},
			}}},
		}},
		"chains": []any{map[string]any{
			"name": "chain-egress-7-" + dialer,
			"hops": []any{map[string]any{"name": "hop-egress-7-" + dialer, "nodes": []any{node}}},
		}},
		"limiters": []any{},
	}
	data, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func key(n int) string {
	return base64.StdEncoding.EncodeToString([]byte(strings.Repeat("k", n)))
}

func TestGostShadowsocksEgressAcceptsGeneratedChains(t *testing.T) {
	cases := []struct {
		name, connector, dialer, method, password string
	}{
		{"tcp classic aes-256-gcm", "ss", "tcp", "aes-256-gcm", "s3cret-pass"},
		{"tcp classic aes-128-gcm", "ss", "tcp", "aes-128-gcm", "s3cret-pass"},
		{"tcp classic chacha20", "ss", "tcp", "chacha20-ietf-poly1305", "p:a:s:s"},
		{"tcp ss2022 aes-128", "ss", "tcp", "2022-blake3-aes-128-gcm", key(16)},
		{"tcp ss2022 aes-256", "ss", "tcp", "2022-blake3-aes-256-gcm", key(32)},
		{"udp classic aes-256-gcm", "ssu", "udp", "aes-256-gcm", "s3cret-pass"},
		{"udp ss2022 aes-128", "ssu", "udp", "2022-blake3-aes-128-gcm", key(16)},
		{"uppercase method", "ss", "tcp", "AES-256-GCM", "s3cret-pass"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			data := egressChainConfig(t, tc.connector, tc.dialer, tc.method, tc.password, "203.0.113.9:28388")
			if err := validateGostShadowsocksNodes(data); err != nil {
				t.Fatalf("expected valid config, got %v", err)
			}
		})
	}
	// IPv6 落地地址带方括号。
	if err := validateGostShadowsocksNodes(egressChainConfig(t, "ss", "tcp", "aes-256-gcm", "x", "[2001:db8::9]:443")); err != nil {
		t.Fatalf("ipv6 server rejected: %v", err)
	}
}

func TestGostShadowsocksEgressRejectsConfigsThatWouldCrashRuntime(t *testing.T) {
	cases := []struct {
		name, connector, dialer, method, password, addr, want string
	}{
		{"unknown method", "ss", "tcp", "rc4-md5", "x", "203.0.113.9:1", "unsupported shadowsocks method"},
		{"ss2022 chacha not in runtime", "ss", "tcp", "2022-blake3-chacha20-poly1305", key(32), "203.0.113.9:1", "unsupported shadowsocks method"},
		{"ss2022 wrong key length", "ss", "tcp", "2022-blake3-aes-128-gcm", key(32), "203.0.113.9:1", "must be 16 bytes"},
		{"ss2022 not base64", "ss", "tcp", "2022-blake3-aes-256-gcm", "not base64!!", "203.0.113.9:1", "must be 32 bytes"},
		// gost 只用标准 base64（要补齐）解密钥，不补齐的同样会留下空 client。
		{"ss2022 unpadded key", "ssu", "udp", "2022-blake3-aes-128-gcm", strings.TrimRight(key(16), "="), "203.0.113.9:1", "must be 16 bytes"},
		{"ss2022 multi-user", "ss", "tcp", "2022-blake3-aes-128-gcm", key(16) + ":" + key(16), "203.0.113.9:1", "multi-user"},
		{"empty password", "ss", "tcp", "aes-256-gcm", "", "203.0.113.9:1", "empty password"},
		{"ssu over tcp", "ssu", "tcp", "aes-256-gcm", "x", "203.0.113.9:1", "requires udp dialer"},
		{"ss over udp", "ss", "udp", "aes-256-gcm", "x", "203.0.113.9:1", "requires tcp dialer"},
		{"bad addr", "ss", "tcp", "aes-256-gcm", "x", "203.0.113.9", "invalid shadowsocks server address"},
		{"bad port", "ss", "tcp", "aes-256-gcm", "x", "203.0.113.9:70000", "invalid shadowsocks server port"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateGostShadowsocksNodes(egressChainConfig(t, tc.connector, tc.dialer, tc.method, tc.password, tc.addr))
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("expected error containing %q, got %v", tc.want, err)
			}
			if tc.password != "" && len(tc.password) > 3 && strings.Contains(err.Error(), tc.password) {
				t.Fatalf("error leaks the password: %v", err)
			}
		})
	}
}

func TestGostShadowsocksEgressIgnoresOtherConfigs(t *testing.T) {
	tunnel := []byte(`{"services":[],"chains":[{"name":"chain-tunnel-2","hops":[{"name":"hop","nodes":[{"name":"exit-2","addr":"203.0.113.2:30001","connector":{"type":"relay","auth":{"username":"u","password":"p"}},"dialer":{"type":"tls"}}]}]}],"limiters":[]}`)
	if err := validateGostShadowsocksNodes(tunnel); err != nil {
		t.Fatalf("tunnel chain rejected: %v", err)
	}
	if err := validateGostShadowsocksNodes([]byte(`{"inbounds":[{"type":"shadowsocks","method":"whatever"}]}`)); err != nil {
		t.Fatalf("non-gost JSON rejected: %v", err)
	}
	if err := validateGostShadowsocksNodes([]byte(`{"chains":"not-a-list"}`)); err != nil {
		t.Fatalf("odd JSON should be left to the generic validator: %v", err)
	}
}

func TestManagedGostConfigWithBrokenShadowsocksNodeIsRejectedBeforeWrite(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "gost.json")
	spec := managedConfigSpec{Path: path, Format: "json"}
	good := egressChainConfig(t, "ss", "tcp", "aes-256-gcm", "s3cret-pass", "203.0.113.9:28388")
	if err := validateManagedConfigSpec(spec, good, path); err != nil {
		t.Fatalf("valid egress config rejected: %v", err)
	}
	bad := egressChainConfig(t, "ss", "tcp", "2022-blake3-chacha20-poly1305", key(32), "203.0.113.9:28388")
	err := validateManagedConfigSpec(spec, bad, path)
	if err == nil || !strings.Contains(err.Error(), "unsupported shadowsocks method") {
		t.Fatalf("expected managed config validation to reject the node, got %v", err)
	}
	if _, statErr := os.Stat(path); !os.IsNotExist(statErr) {
		t.Fatalf("validation must not write the file")
	}
}
