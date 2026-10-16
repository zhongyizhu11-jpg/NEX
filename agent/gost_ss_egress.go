package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"strconv"
	"strings"
)

/*
转发规则的 Shadowsocks 出口（面板 shared/ssEgress.ts、server/ssEgress.ts）。

面板把出口写成 gost 运行时配置（/etc/forwardx/runtime/gost.json）里的一条链：规则的服务
handler.chain 指向 chain-egress-<规则>-<协议>，链上一跳一个节点，连接器是 ss（TCP）或 ssu（UDP），
auth 的 username 是加密方式、password 是密码。gost 拨的是落地的 SS 服务器，请它代连目标；
监听、计数、限速都还在入口这一侧，和普通 gost 规则一样。

这里只做一件事：写入配置之前，把配置里所有 ss / ssu 节点查一遍。原因是 gost 运行时（go-gost/x
0.8.1）的 ss 连接器碰到不认识的加密方式时 Init 不报错、直接返回，留下一个空的 client，第一条连接
进来就空指针 panic —— 整个 forwardx-runtime 进程跟着崩，这台机器上所有 gost 规则一起断。ssu 配
tcp 拨号器（UDP over TCP）那条路的 client 根本没初始化，同样一连就崩。所以这些配置宁可整份拒收
（事务回滚到旧配置，动作报失败），也不能写下去。

认得的加密方式和 go-gost/go-shadowsocks2 v0.1.1 的 SupportedMethods 一致（2022-blake3-chacha20-poly1305
在那份表里是注释掉的）。校验管的是「不会把运行时弄崩」；互通是面板和运行时版本的事：UDP（ssu）和 SS2022
只有运行时 3.2.6-nex3 起才和 sing-box 互通，面板只发给报了能力的 Agent（见 gost_runtime_version.go）。
*/

var gostShadowsocksMethods = map[string]int{
	"aes-128-gcm":             0,
	"aes-256-gcm":             0,
	"chacha20-ietf-poly1305":  0,
	"2022-blake3-aes-128-gcm": 16,
	"2022-blake3-aes-256-gcm": 32,
}

type gostEgressAuth struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type gostEgressNode struct {
	Name      string `json:"name"`
	Addr      string `json:"addr"`
	Connector *struct {
		Type string          `json:"type"`
		Auth *gostEgressAuth `json:"auth"`
	} `json:"connector"`
	Dialer *struct {
		Type string `json:"type"`
	} `json:"dialer"`
}

type gostEgressConfig struct {
	Chains []struct {
		Name string `json:"name"`
		Hops []struct {
			Name  string           `json:"name"`
			Nodes []gostEgressNode `json:"nodes"`
		} `json:"hops"`
	} `json:"chains"`
}

// validateGostShadowsocksNodes 检查一份 gost 运行时配置里的 Shadowsocks 节点。不是 gost 配置（没有 chains）或者
// 没有 ss / ssu 节点时直接通过。返回的错误会作为动作失败原因报给面板，不含密码。
func validateGostShadowsocksNodes(data []byte) error {
	if !strings.Contains(string(data), "\"chains\"") {
		return nil
	}
	var cfg gostEgressConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		// 结构对不上（例如 chains 不是数组）就不是我们写的 gost 配置，交给原来的 JSON 校验。
		return nil
	}
	for _, chain := range cfg.Chains {
		for _, hop := range chain.Hops {
			for _, node := range hop.Nodes {
				if err := validateGostShadowsocksNode(node); err != nil {
					return fmt.Errorf("gost chain %s node %s: %w", emptyDash(chain.Name), emptyDash(node.Name), err)
				}
			}
		}
	}
	return nil
}

func validateGostShadowsocksNode(node gostEgressNode) error {
	if node.Connector == nil {
		return nil
	}
	connectorType := strings.ToLower(strings.TrimSpace(node.Connector.Type))
	if connectorType != "ss" && connectorType != "ssu" {
		return nil
	}
	dialerType := ""
	if node.Dialer != nil {
		dialerType = strings.ToLower(strings.TrimSpace(node.Dialer.Type))
	}
	if dialerType == "" {
		dialerType = "tcp"
	}
	switch connectorType {
	case "ss":
		if dialerType != "tcp" {
			return fmt.Errorf("shadowsocks connector requires tcp dialer, got %s", dialerType)
		}
	case "ssu":
		// ssu + tcp 拨号器是 UDP over TCP，gost 0.8.1 那条路的 tcpClient 没初始化，一连就崩。
		if dialerType != "udp" {
			return fmt.Errorf("shadowsocks udp connector requires udp dialer, got %s", dialerType)
		}
	}
	host, port, err := net.SplitHostPort(strings.TrimSpace(node.Addr))
	if err != nil || strings.TrimSpace(host) == "" {
		return fmt.Errorf("invalid shadowsocks server address %q", node.Addr)
	}
	if value, err := strconv.Atoi(port); err != nil || value < 1 || value > 65535 {
		return fmt.Errorf("invalid shadowsocks server port %q", port)
	}
	if node.Connector.Auth == nil {
		return fmt.Errorf("shadowsocks node has no method/password")
	}
	method := strings.ToLower(strings.TrimSpace(node.Connector.Auth.Username))
	keyBytes, ok := gostShadowsocksMethods[method]
	if !ok {
		return fmt.Errorf("unsupported shadowsocks method %q", method)
	}
	password := node.Connector.Auth.Password
	if password == "" {
		return fmt.Errorf("shadowsocks node has empty password")
	}
	if keyBytes > 0 {
		// SS2022 的密码是 base64 编码的定长密钥；长度不对 gost 拒绝初始化，同样会留下空 client。
		if strings.Contains(password, ":") {
			return fmt.Errorf("shadowsocks 2022 multi-user keys are not supported")
		}
		// gost 只用 StdEncoding 解（要「=」补齐）；不补齐的密钥同样会让 gost 留下空 client，这里一样拒掉。
		key, err := base64.StdEncoding.DecodeString(password)
		if err != nil || len(key) != keyBytes {
			return fmt.Errorf("shadowsocks 2022 key for %s must be %d bytes base64", method, keyBytes)
		}
	}
	return nil
}
