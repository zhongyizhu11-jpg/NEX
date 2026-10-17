package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"time"
)

// 面板用本机 token 对 install.sh 做的 HMAC 签名。脚本会以 root 执行，http 面板上
// 不验签的话，路径上的任何人都能把脚本（连同里面的校验和）一起换掉。
const agentInstallScriptSignatureHeader = "X-ForwardX-Script-Signature"
const agentInstallScriptSignatureSalt = "forwardx-install-script-signature"
const agentInstallScriptMaxBytes = 8 << 20

func agentInstallScriptSignature(token string, script []byte) string {
	key := sha256.Sum256([]byte(token + "|" + agentInstallScriptSignatureSalt))
	mac := hmac.New(sha256.New, key[:])
	_, _ = mac.Write(script)
	return "v1." + hex.EncodeToString(mac.Sum(nil))
}

// verifyAgentInstallScript 决定能不能执行下载到的脚本：
//   - 有签名：必须用本机 token 验证通过，否则拒绝（不论 http/https）；
//   - 没签名：https 面板视为旧版面板，靠 TLS 保证来源，继续；http 面板一律拒绝。
func verifyAgentInstallScript(panelURL, token string, script []byte, signature string) error {
	signature = strings.TrimSpace(signature)
	if signature != "" {
		expected := agentInstallScriptSignature(token, script)
		if !hmac.Equal([]byte(signature), []byte(expected)) {
			return errors.New("install script signature mismatch")
		}
		return nil
	}
	parsed, err := url.Parse(strings.TrimSpace(panelURL))
	if err != nil {
		return fmt.Errorf("invalid panel URL: %w", err)
	}
	if strings.EqualFold(parsed.Scheme, "https") {
		return nil
	}
	return errors.New("install script is unsigned and the panel is not HTTPS; upgrade the panel first")
}

// downloadVerifiedInstallScript 带 Agent 认证头下载 install.sh，验签后写到只有 root
// 可读写的临时文件里，返回文件路径；调用方负责在执行完后删除。
func downloadVerifiedInstallScript(ctx context.Context, client *http.Client, panelURL, token string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, panelURL+"/api/agent/install.sh", nil)
	if err != nil {
		return "", err
	}
	auth, err := newAgentRequestAuth(ctx, client, panelURL, token, req.Method, req.URL.Path, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+auth.proof)
	res, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("download install script: %s", res.Status)
	}
	script, err := io.ReadAll(io.LimitReader(res.Body, agentInstallScriptMaxBytes+1))
	if err != nil {
		return "", err
	}
	if len(script) > agentInstallScriptMaxBytes {
		return "", errors.New("install script is too large")
	}
	if err := verifyAgentInstallScript(panelURL, token, script, res.Header.Get(agentInstallScriptSignatureHeader)); err != nil {
		return "", err
	}
	// CreateTemp 建的文件是 0600，其他用户读不到也改不了。
	file, err := os.CreateTemp("", "forwardx-agent-upgrade.*.sh")
	if err != nil {
		return "", err
	}
	path := file.Name()
	if _, err := file.Write(script); err != nil {
		file.Close()
		os.Remove(path)
		return "", err
	}
	if err := file.Close(); err != nil {
		os.Remove(path)
		return "", err
	}
	return path, nil
}

func selfUpgrade(cfg Config, up *agentUpgrade) {
	if isLegacyPanelMigrationUpgrade(up) {
		handleLegacyPanelMigrationUpgrade(cfg, up)
		return
	}
	now := time.Now()
	if !atomic.CompareAndSwapInt32(&upgradeStarted, 0, 1) {
		startedAt := time.Unix(atomic.LoadInt64(&upgradeStartedAt), 0)
		if startedAt.IsZero() || now.Sub(startedAt) < selfUpgradeLockTimeout {
			logf("self-upgrade already started at %s, ignoring duplicate request", startedAt.Format(time.RFC3339))
			return
		}
		logf("self-upgrade lock expired after %s, allowing retry", now.Sub(startedAt).Round(time.Second))
		atomic.StoreInt64(&upgradeStartedAt, now.Unix())
	} else {
		atomic.StoreInt64(&upgradeStartedAt, now.Unix())
	}
	panel := strings.TrimRight(up.PanelURL, "/")
	if panel == "" {
		panel = currentPanelURL(cfg)
	}
	releaseVersion := strings.TrimSpace(up.ReleaseVersion)
	installEnv := fmt.Sprintf("PANEL_URL=%s", shellQuote(panel))
	if releaseVersion != "" {
		installEnv += fmt.Sprintf(" FORWARDX_AGENT_RELEASE_VERSION=%s", shellQuote(releaseVersion))
	}
	// Download and verify the installer in-process before execution: the panel
	// signs it with this Agent's token, so a MITM on an http:// panel cannot
	// swap it. The installer reads the existing token from config.json, so it
	// never needs to appear in argv or shell history. A filesystem lock also
	// covers duplicate upgrade requests delivered to separate agent processes.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	scriptPath, err := downloadVerifiedInstallScript(ctx, agentSyncHTTPClient, panel, cfg.Token)
	cancel()
	if err != nil {
		// 验签失败时保留升级锁，等锁超时后再重试，避免每次心跳都重新下载。
		logf("self-upgrade refused: install script not verified panel=%s target=%s release=%s error=%v", panel, up.TargetVersion, releaseVersion, err)
		return
	}
	installScript := shellQuote(scriptPath)
	// The installer runs asynchronously after the launcher exits. Keep a small
	// stage record in the normal Agent log and the installer output in a
	// separate file, so failures remain diagnosable even when systemd-run is
	// used (its journal is not normally included in Agent support bundles).
	upgradeTarget := shellQuote(strings.TrimSpace(up.TargetVersion))
	upgradeRelease := shellQuote(releaseVersion)
	upgradeLogPath := shellQuote(agentLogDir + "/agent-upgrade.log")
	upgradeCmd := fmt.Sprintf(`sleep 1; tmp=%s; upgrade_log(){ stage="$1"; shift; printf '%%s self-upgrade stage=%%s target=%%s release=%%s %%s\n' "$(date -u +%%Y-%%m-%%dT%%H:%%M:%%SZ)" "$stage" %s %s "$*" >> %s 2>/dev/null || true; }; lock=/var/lock/forwardx-agent-upgrade; if ! mkdir -p /var/lock || ! mkdir "$lock" 2>/dev/null; then upgrade_log lock-skipped; rm -f "$tmp"; exit 0; fi; upgrade_log lock-acquired; cleanup(){ rm -f "$tmp"; rmdir "$lock" 2>/dev/null || true; }; trap cleanup EXIT; upgrade_log download-verified; if ! bash -n "$tmp"; then upgrade_log syntax-check-failed; exit 1; fi; upgrade_log syntax-check-ok; env %s bash "$tmp" upgrade >> %s 2>&1; status=$?; upgrade_log installer-finished exit=$status; exit $status`, installScript, upgradeTarget, upgradeRelease, upgradeLogPath, installEnv, upgradeLogPath)
	// 管理代理：升级脚本里的下载（Agent 二进制、运行时、FXP）和这台 Agent 用同一个代理（management_proxy.go）。
	// 放在拿到升级锁、挂好清理之后：读配置失败退出时临时脚本和锁一起清掉。
	upgradeCmd = strings.Replace(upgradeCmd, "trap cleanup EXIT; ", "trap cleanup EXIT; "+agentUpgradeProxySetup(activeConfigPath), 1)
	cmd := fmt.Sprintf(`if command -v systemd-run >/dev/null 2>&1; then systemd-run --unit=forwardx-agent-upgrade --collect /bin/sh -lc %s; else nohup sh -lc %s >/var/log/forwardx-agent/agent-upgrade.log 2>&1 < /dev/null & fi`, shellQuote(upgradeCmd), shellQuote(upgradeCmd))
	logf("self-upgrade requested target=%s release=%s", up.TargetVersion, releaseVersion)
	if !runShell(cmd) {
		_ = os.Remove(scriptPath)
		logf("self-upgrade launcher failed; clearing upgrade lock target=%s release=%s", up.TargetVersion, releaseVersion)
		atomic.StoreInt32(&upgradeStarted, 0)
		atomic.StoreInt64(&upgradeStartedAt, 0)
	}
}

func isLegacyPanelMigrationUpgrade(up *agentUpgrade) bool {
	return up != nil && strings.TrimSpace(up.TargetVersion) == "9999.0.0" && normalizePanelURL(up.PanelURL) != ""
}

func handleLegacyPanelMigrationUpgrade(cfg Config, up *agentUpgrade) bool {
	if !isLegacyPanelMigrationUpgrade(up) {
		return false
	}
	target := normalizePanelURL(up.PanelURL)
	return handlePanelMigrationDirective(cfg, &panelMigrationDirective{
		ID:               "legacy-panel-switch:" + target,
		State:            "preparing",
		TargetPanelURL:   target,
		FallbackPanelURL: currentPanelURL(cfg),
		StartedAt:        time.Now().Unix(),
	})
}
