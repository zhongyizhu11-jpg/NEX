package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

func loadConfigWithFallback(path string) (string, Config, error) {
	resolvedPath, cfg, migrated, err := loadConfigWithFallbackPaths(path, defaultConfigPath, legacyConfigPath)
	if migrated {
		logf("config migrated from %s to %s", legacyConfigPath, defaultConfigPath)
	}
	return resolvedPath, cfg, err
}

func loadConfigWithFallbackPaths(path string, canonicalPath string, legacyPath string) (string, Config, bool, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		path = canonicalPath
	}
	cfg, err := loadConfig(path)
	if err == nil {
		return path, cfg, false, nil
	}
	if path != canonicalPath {
		return path, Config{}, false, err
	}
	legacyCfg, legacyRaw, legacyErr := readConfigFile(legacyPath)
	if legacyErr != nil {
		return path, Config{}, false, err
	}
	if writeConfigFileAtomic(canonicalPath, legacyRaw) == nil {
		return canonicalPath, legacyCfg, true, nil
	}
	return legacyPath, legacyCfg, false, nil
}

func loadConfig(path string) (Config, error) {
	cfg, _, err := readConfigFile(path)
	return cfg, err
}

func readConfigFile(path string) (Config, []byte, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return Config{}, nil, err
	}
	var cfg Config
	if err := json.Unmarshal(b, &cfg); err != nil {
		return Config{}, nil, err
	}
	if cfg.PanelURL == "" || cfg.Token == "" {
		return Config{}, nil, fmt.Errorf("panelUrl/token required")
	}
	return cfg, b, nil
}

func writeConfigFileAtomic(path string, raw []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	return writeFileAtomicDurable(path, raw, 0600)
}

// writeFileAtomicDurable 用唯一的临时文件写入、fsync、rename，再 fsync 目录。
// 掉电或崩溃后文件要么是旧内容、要么是完整的新内容，不会是空文件或半截；
// 也不会像固定的 path+".tmp" 那样被两个并发写入者互相覆盖。
func writeFileAtomicDurable(path string, raw []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".forwardx-agent-write-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(perm); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(raw); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return err
	}
	// 目录项落盘是尽力而为：个别文件系统不支持对目录 fsync，此时 rename 本身已经完成。
	if directory, err := os.Open(dir); err == nil {
		_ = directory.Sync()
		_ = directory.Close()
	}
	return nil
}

func normalizePanelURL(raw string) string {
	value := strings.TrimSpace(raw)
	if value == "" {
		return ""
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return ""
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return ""
	}
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return strings.TrimRight(parsed.String(), "/")
}

func setRuntimePanelURL(panelURL string) {
	normalized := normalizePanelURL(panelURL)
	if normalized == "" {
		return
	}
	runtimePanelURL.Store(normalized)
}

func currentPanelURL(cfg Config) string {
	if value, ok := runtimePanelURL.Load().(string); ok && value != "" {
		return value
	}
	return strings.TrimRight(cfg.PanelURL, "/")
}

func persistPanelURL(panelURL string) error {
	normalized := normalizePanelURL(panelURL)
	if normalized == "" {
		return fmt.Errorf("invalid panelUrl")
	}
	path := strings.TrimSpace(activeConfigPath)
	if path == "" {
		return fmt.Errorf("config path is empty")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var data map[string]any
	if err := json.Unmarshal(raw, &data); err != nil {
		return err
	}
	if data == nil {
		data = map[string]any{}
	}
	if strings.TrimRight(fmt.Sprint(data["panelUrl"]), "/") == normalized {
		return nil
	}
	data["panelUrl"] = normalized
	next, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}
	next = append(next, '\n')
	// 配置文件里有 token，写坏了 Agent 下次启动就连不上面板：必须原子且落盘。
	return writeConfigFileAtomic(path, next)
}

// syncPanelURLFromResponse：面板在心跳回包里给了另一个地址（全局「面板公开地址」改了，或者这台主机
// 配了独立的 Agent 面板连接地址）。不再直接切：先在后台用本机 Token 验证新地址，通了才切换并落盘，
// 不通就继续用现在的地址（panel_url_switch.go）。
func syncPanelURLFromResponse(panelURL string) {
	normalized := normalizePanelURL(panelURL)
	if normalized == "" {
		return
	}
	current := currentPanelURL(Config{})
	if current == normalized {
		return
	}
	requestVerifiedPanelURLSwitch(current, normalized)
}

func register(cfg Config) error {
	ipv4, ipv6 := publicIPs()
	primaryIP := ipv4
	if primaryIP == "" {
		primaryIP = ipv6
	}
	if primaryIP == "" {
		primaryIP = "unknown"
	}
	payload := map[string]any{
		"token":        cfg.Token,
		"ip":           primaryIP,
		"ipv4":         ipv4,
		"ipv6":         ipv6,
		"privateIpv4":  localPrivateIPv4(),
		"osInfo":       osInfo(),
		"cpuInfo":      cpuInfo(),
		"memoryTotal":  memTotal(),
		"agentVersion": Version,
		"fxpVersion":   reportedFXPVersion(),
	}
	var out map[string]any
	return post(cfg, "/api/agent/register", payload, &out)
}
