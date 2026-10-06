package main

import "testing"

func TestNormalizeConfigReadsTuningEnvFallbacks(t *testing.T) {
	t.Setenv("FORWARDX_FXP_TCP_CONGESTION", "Cubic")
	t.Setenv("FORWARDX_FXP_AEAD", "ChaCha20")
	cfg := normalizeConfig(config{Role: "entry"})
	if cfg.TCPCongestion != "cubic" {
		t.Fatalf("tcpCongestion = %q", cfg.TCPCongestion)
	}
	if cfg.AEAD != fxpAEADChaCha20 {
		t.Fatalf("aead = %q", cfg.AEAD)
	}
	// 配置文件里写了就不看环境变量。
	cfg = normalizeConfig(config{Role: "entry", TCPCongestion: "off", AEAD: "aes-gcm"})
	if cfg.TCPCongestion != "off" || cfg.AEAD != fxpAEADAESGCM {
		t.Fatalf("explicit config lost: %q %q", cfg.TCPCongestion, cfg.AEAD)
	}
}
