package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
)

/*
转发规则的 VLESS Reality 出口（2.2.253 起；面板 shared/vlessEgress.ts、server/vlessEgress.ts）。

随 Agent 下发的 gost 运行时没有 vless 连接器，所以入口机上另起一个 sing-box（forwardx-singbox-egress 服务，
配置 /etc/forwardx/singbox/egress.json）：每条规则一个只听 127.0.0.1 的 socks 入站（带凭据）→ 一个 vless +
REALITY + Vision 出站，gost 的出口链上就是一个 socks5 节点。监听、计数、限速仍在 gost 那一侧。

这里只做一件事：写入这份配置之前逐项查一遍，sing-box check 查不出来的「能跑但不安全」这里拦：
  - 入站只能是 socks、只能听回环地址、必须带用户名密码 —— 听了公网地址就成了谁都能用的开放代理；
  - 出站只能是 vless + REALITY + xtls-rprx-vision，公钥 / short-id 格式要对 —— 不许有 direct 之类的出站：
    sing-box 没配 final 时拿第一个出站兜底，一条对不上的连接要是从入口机自己出去，规则就成了
    「显示在走落地，其实直连」，这是出口最不能出的错；
  - 每个入站都要有一条路由规则指到存在的出站。
UDP 规则不另开入站：gost 经同一个 socks 入站做标准 UDP ASSOCIATE（sing-box 在 127.0.0.1 的
随机端口上收数据报），出站带 packet_encoding=xudp。所以入站类型仍然只许 socks；出站的 packet_encoding 只许不写
（只 TCP 的规则）或 xudp —— 端到端验过的只有 xudp（scripts/verify-vless-egress.mjs），packetaddr 这类 Xray 服务端
不认的封装写进来只会换来「UDP 显示在走出口、其实一个包都回不来」。
不合格就整份拒收（事务回滚到旧配置，动作报失败），返回的错误不含 UUID、密码。
*/

const singboxEgressBridgeConfigPath = "/etc/forwardx/singbox/egress.json"

const singboxEgressVisionFlow = "xtls-rprx-vision"

// UDP 规则的出站封装（面板 shared/vlessEgress.ts 的 VLESS_EGRESS_UDP_PACKET_ENCODING）。
const singboxEgressUDPPacketEncoding = "xudp"

var (
	singboxEgressUUIDPattern    = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
	singboxEgressShortIDPattern = regexp.MustCompile(`^(?:[0-9a-fA-F]{2}){0,8}$`)
)

type singboxEgressBridgeConfig struct {
	Inbounds []struct {
		Type       string `json:"type"`
		Tag        string `json:"tag"`
		Listen     string `json:"listen"`
		ListenPort int    `json:"listen_port"`
		Users      []struct {
			Username string `json:"username"`
			Password string `json:"password"`
		} `json:"users"`
	} `json:"inbounds"`
	Outbounds []struct {
		Type           string `json:"type"`
		Tag            string `json:"tag"`
		Server         string `json:"server"`
		ServerPort     int    `json:"server_port"`
		UUID           string `json:"uuid"`
		Flow           string `json:"flow"`
		PacketEncoding string `json:"packet_encoding"`
		TLS            *struct {
			Enabled    bool   `json:"enabled"`
			ServerName string `json:"server_name"`
			Reality    *struct {
				Enabled   bool   `json:"enabled"`
				PublicKey string `json:"public_key"`
				ShortID   string `json:"short_id"`
			} `json:"reality"`
		} `json:"tls"`
	} `json:"outbounds"`
	Route *struct {
		Final string `json:"final"`
		Rules []struct {
			Inbound  []string `json:"inbound"`
			Outbound string   `json:"outbound"`
		} `json:"rules"`
	} `json:"route"`
}

func isSingboxEgressBridgeConfigPath(path string) bool {
	return filepath.Clean(strings.TrimSpace(path)) == singboxEgressBridgeConfigPath
}

// validateSingboxEgressBridgeConfig 检查 VLESS 出口桥接的 sing-box 配置。不是这个路径的配置直接通过。
func validateSingboxEgressBridgeConfig(path string, data []byte) error {
	if !isSingboxEgressBridgeConfigPath(path) {
		return nil
	}
	var cfg singboxEgressBridgeConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return fmt.Errorf("egress bridge config is not a sing-box config: %w", err)
	}
	if len(cfg.Inbounds) == 0 || len(cfg.Outbounds) == 0 {
		return fmt.Errorf("egress bridge config has no inbound/outbound")
	}
	inboundTags := map[string]bool{}
	for _, inbound := range cfg.Inbounds {
		tag := strings.TrimSpace(inbound.Tag)
		if tag == "" || inboundTags[tag] {
			return fmt.Errorf("egress bridge inbound tag %q missing or duplicated", tag)
		}
		inboundTags[tag] = true
		if inbound.Type != "socks" {
			return fmt.Errorf("egress bridge inbound %s must be socks, got %q", tag, inbound.Type)
		}
		listen := strings.TrimSpace(inbound.Listen)
		if listen != "127.0.0.1" && listen != "::1" {
			return fmt.Errorf("egress bridge inbound %s must listen on loopback, got %q", tag, listen)
		}
		if inbound.ListenPort < 1 || inbound.ListenPort > 65535 {
			return fmt.Errorf("egress bridge inbound %s has invalid port %d", tag, inbound.ListenPort)
		}
		if len(inbound.Users) == 0 {
			return fmt.Errorf("egress bridge inbound %s has no credentials", tag)
		}
		for _, user := range inbound.Users {
			if strings.TrimSpace(user.Username) == "" || strings.TrimSpace(user.Password) == "" {
				return fmt.Errorf("egress bridge inbound %s has empty credentials", tag)
			}
		}
	}
	outboundTags := map[string]bool{}
	for _, outbound := range cfg.Outbounds {
		tag := strings.TrimSpace(outbound.Tag)
		if tag == "" || outboundTags[tag] {
			return fmt.Errorf("egress bridge outbound tag %q missing or duplicated", tag)
		}
		outboundTags[tag] = true
		if err := validateSingboxEgressVlessOutbound(outbound.Type, outbound.Server, outbound.ServerPort, outbound.UUID, outbound.Flow); err != nil {
			return fmt.Errorf("egress bridge outbound %s: %w", tag, err)
		}
		if encoding := outbound.PacketEncoding; encoding != "" && encoding != singboxEgressUDPPacketEncoding {
			return fmt.Errorf("egress bridge outbound %s: packet_encoding must be %s, got %q", tag, singboxEgressUDPPacketEncoding, encoding)
		}
		if outbound.TLS == nil || !outbound.TLS.Enabled || outbound.TLS.Reality == nil || !outbound.TLS.Reality.Enabled {
			return fmt.Errorf("egress bridge outbound %s must use REALITY", tag)
		}
		if strings.TrimSpace(outbound.TLS.ServerName) == "" {
			return fmt.Errorf("egress bridge outbound %s has no REALITY server name", tag)
		}
		if !validRealityPublicKey(outbound.TLS.Reality.PublicKey) {
			return fmt.Errorf("egress bridge outbound %s has invalid REALITY public key", tag)
		}
		if !singboxEgressShortIDPattern.MatchString(strings.TrimSpace(outbound.TLS.Reality.ShortID)) {
			return fmt.Errorf("egress bridge outbound %s has invalid REALITY short id", tag)
		}
	}
	if cfg.Route == nil || len(cfg.Route.Rules) == 0 {
		return fmt.Errorf("egress bridge config has no route rules")
	}
	if final := strings.TrimSpace(cfg.Route.Final); final != "" && !outboundTags[final] {
		return fmt.Errorf("egress bridge route final %q is not a VLESS outbound", final)
	}
	routed := map[string]bool{}
	for _, rule := range cfg.Route.Rules {
		if len(rule.Inbound) == 0 {
			return fmt.Errorf("egress bridge route rule without inbound")
		}
		if !outboundTags[strings.TrimSpace(rule.Outbound)] {
			return fmt.Errorf("egress bridge route rule points to unknown outbound %q", rule.Outbound)
		}
		for _, tag := range rule.Inbound {
			if !inboundTags[strings.TrimSpace(tag)] {
				return fmt.Errorf("egress bridge route rule references unknown inbound %q", tag)
			}
			routed[strings.TrimSpace(tag)] = true
		}
	}
	for tag := range inboundTags {
		if !routed[tag] {
			return fmt.Errorf("egress bridge inbound %s has no route rule", tag)
		}
	}
	return nil
}

func validateSingboxEgressVlessOutbound(outboundType, server string, port int, uuid, flow string) error {
	if outboundType != "vless" {
		return fmt.Errorf("only vless outbounds are allowed, got %q", outboundType)
	}
	server = strings.TrimSpace(server)
	if server == "" || server == "localhost" || strings.HasPrefix(server, "127.") || server == "::1" {
		return fmt.Errorf("invalid server address")
	}
	if port < 1 || port > 65535 {
		return fmt.Errorf("invalid server port %d", port)
	}
	if !singboxEgressUUIDPattern.MatchString(strings.TrimSpace(uuid)) {
		return fmt.Errorf("invalid uuid")
	}
	if flow != singboxEgressVisionFlow {
		return fmt.Errorf("flow must be %s", singboxEgressVisionFlow)
	}
	return nil
}

// validRealityPublicKey：x25519 公钥，base64url 不带补齐，正好 32 字节（sing-box 也是这么解的）。
func validRealityPublicKey(value string) bool {
	key, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(value))
	return err == nil && len(key) == 32
}
