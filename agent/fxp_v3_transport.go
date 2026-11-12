package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
)

/*
NEX V3 传输（见 forwardx-fxp/v3_transport.go）在 Agent 这边只做三件事：

  - 面板下发的 v3Transport / v3Host / v3Path / v3UserAgent / v3ServerName / v3Multiplex
    原样写进 FXP 配置（fxpSpec 本身就是 FXP 配置）；
  - 传输版本 v3 不能被归一成 v1 —— 那会让 V3 隧道悄悄按 V1 跑，和对端谁也连不上谁；
  - 起进程之前先校验：选项只许出现在 v3 上，装着的 FXP 要认识 v3（老 FXP 不认识 v3 会把它
    当 V1 跑，同样是悄悄失效）。

V3 不走 WireGuard，所有「== v2」的分支对它都不成立，和 V1 一样由 Agent 直接起 FXP。
*/

// fxpV3MinVersion 是第一个认识 transportVersion=v3 的 FXP。和 shared/forwardXV3.ts 的
// FORWARDX_V3_MIN_FXP_VERSION 保持一致。
const fxpV3MinVersion = "2.2.141"

const forwardXV3Version = "v3"

func copyFXPV3Options(dst *fxpSpec, src fxpSpec) {
	dst.V3Transport = src.V3Transport
	dst.V3Host = src.V3Host
	dst.V3Path = src.V3Path
	dst.V3UserAgent = src.V3UserAgent
	dst.V3ServerName = src.V3ServerName
	// 配置快照里不留调用方手里那个可变的 *bool。
	dst.V3Multiplex = nil
	if src.V3Multiplex != nil {
		value := *src.V3Multiplex
		dst.V3Multiplex = &value
	}
}

func clearFXPV3Options(spec *fxpSpec) {
	copyFXPV3Options(spec, fxpSpec{})
}

func normalizeFXPV3Options(spec *fxpSpec) {
	spec.V3Transport = strings.ToLower(strings.TrimSpace(spec.V3Transport))
	spec.V3Host = strings.TrimSpace(spec.V3Host)
	spec.V3Path = strings.TrimSpace(spec.V3Path)
	spec.V3UserAgent = strings.TrimSpace(spec.V3UserAgent)
	spec.V3ServerName = strings.TrimSpace(spec.V3ServerName)
}

func fxpSpecHasV3Options(spec fxpSpec) bool {
	return spec.V3Transport != "" || spec.V3Host != "" || spec.V3Path != "" || spec.V3UserAgent != "" || spec.V3ServerName != "" || spec.V3Multiplex != nil
}

// fxpV3OptionsSignature 进 fxpServerSignature：外层选项变了 FXP 要拿到新配置。只给 v3 用，
// V1 / V2 的签名和以前一字不差，升级 Agent 不会因此重启它们的 FXP。
func fxpV3OptionsSignature(spec fxpSpec) string {
	multiplex := spec.V3Multiplex == nil || *spec.V3Multiplex
	encoded, _ := json.Marshal([]any{spec.V3Transport, spec.V3Host, spec.V3Path, spec.V3UserAgent, spec.V3ServerName, multiplex})
	digest := sha256.Sum256(encoded)
	return "v3-options:" + hex.EncodeToString(digest[:])
}

// validateFXPTransport 在动正在跑的进程、写持久化配置之前调用。
func validateFXPTransport(spec fxpSpec) error {
	switch spec.TransportVersion {
	case "v1", forwardXWireGuardVersion:
		if fxpSpecHasV3Options(spec) {
			return fmt.Errorf("V3 options require transportVersion v3")
		}
	case forwardXV3Version:
		switch spec.V3Transport {
		case "http", "ws":
			if strings.ContainsAny(spec.V3Host, "\r\n\x00\t ") || strings.ContainsAny(spec.V3Path, "\r\n\x00\t ") || strings.ContainsAny(spec.V3UserAgent, "\r\n\x00") || len(spec.V3Host)+len(spec.V3Path)+len(spec.V3UserAgent) > 32*1024-256 {
				return fmt.Errorf("invalid V3 HTTP host/path/user agent")
			}
		case "tls":
			if len(spec.V3ServerName) > 253 || strings.ContainsAny(spec.V3ServerName, "\x00\r\n\t /\\") {
				return fmt.Errorf("invalid V3 TLS server name")
			}
		default:
			return fmt.Errorf("V3 requires http, ws, or tls transport")
		}
	default:
		return fmt.Errorf("unsupported FXP transport version %q", spec.TransportVersion)
	}
	if spec.Role == fxpEntryGroupRole {
		for _, entry := range spec.Entries {
			if err := validateFXPTransport(entry); err != nil {
				return fmt.Errorf("entry rule=%d: %w", entry.RuleID, err)
			}
			if spec.TransportVersion == forwardXV3Version && fxpV3OptionsSignature(spec) != fxpV3OptionsSignature(entry) {
				return fmt.Errorf("entry rule=%d has inconsistent V3 transport options", entry.RuleID)
			}
		}
	}
	return nil
}

// fxpV3RuntimeError：装着的 FXP 不认识 v3 时给出原因。版本问不出来（unknown）、开发版
// 这类不是 x.y.z 的不拦，由 FXP 自己的配置校验兜底；不认识 -version 的老二进制（legacy）
// 肯定早于 V3。
func fxpV3RuntimeError(spec fxpSpec) error {
	if spec.TransportVersion != forwardXV3Version {
		return nil
	}
	version := installedFXPVersion()
	old := version == fxpVersionLegacy || version == fxpVersionLegacyV2 ||
		(fxpSemverPattern.MatchString(version) && compareFXPVersions(version, fxpV3MinVersion) < 0)
	if old {
		return fmt.Errorf("forwardx-fxp 版本过旧（%s），NEX V3 隧道至少要 FXP %s；请在面板上升级这台 Agent（会重新安装 FXP）", version, fxpV3MinVersion)
	}
	return nil
}
