package main

import (
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// 管理流量代理（上游 v2.3.284 移植）：config.json 里的 proxyUrl 只管 Agent 和面板之间的
// 管理流量 —— 注册、心跳、上报、事件流、实时指标、自升级时下载安装脚本 —— 以及安装 / 升级
// 脚本里的下载。业务转发、延迟探测、公网 IP 探测一律不走它。
//
// 这个版本起才认 proxyUrl（老 Agent 会忽略这个字段、照旧直连）。面板和 fwxm 用同一个版本号判断，
// 见 server/agentManagementProxy.ts。
const agentManagementProxyVersion = "2.2.229"

// parseAgentProxy 只接受 http(s)://host:port 和 socks5(h)://host:port，可以带 URL 编码的账号密码；
// 不能带路径、查询和片段。socks5 统一改成 socks5h：面板域名交给代理解析，不在本机泄露 DNS 查询。
func parseAgentProxy(raw string) (*url.URL, error) {
	value := strings.TrimSpace(raw)
	if value == "" || isDirectAgentProxy(value) {
		return nil, nil
	}
	u, err := url.Parse(value)
	if err != nil || u.Hostname() == "" || u.Port() == "" || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return nil, fmt.Errorf("proxyUrl must be http(s)://host:port or socks5(h)://host:port (optional URL-encoded credentials)")
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil || port < 1 || port > 65535 {
		return nil, fmt.Errorf("proxyUrl port must be between 1 and 65535")
	}
	switch u.Scheme {
	case "http", "https", "socks5", "socks5h":
	default:
		return nil, fmt.Errorf("unsupported proxyUrl scheme; use http, https, socks5 or socks5h")
	}
	if u.Scheme == "socks5" {
		u.Scheme = "socks5h"
	}
	u.Path = ""
	return u, nil
}

// redactedProxyEndpoint 是日志里写的样子：只有协议和 host:port，账号密码一律不出现。
func redactedProxyEndpoint(u *url.URL) string {
	if u == nil {
		return "direct"
	}
	return u.Scheme + "://" + u.Host
}

// isDirectAgentProxy：proxyUrl 写成 direct 是明确要求直连（fwxm proxy off / --no-proxy），
// 连进程环境变量里的代理也不用；字段不存在才是「跟随环境变量」。
func isDirectAgentProxy(raw string) bool {
	return strings.EqualFold(strings.TrimSpace(raw), "direct")
}

func agentManagementHTTPClients() []*http.Client {
	return []*http.Client{agentSyncHTTPClient, agentPresenceHTTPClient, agentEventHTTPClient}
}

// configureAgentManagementProxy 在启动时、任何通信协程开始之前调用一次。没配 proxyUrl 时保持
// 原来的行为（跟随进程环境变量里的代理设置），老部署升级上来不会突然换一条路。
func configureAgentManagementProxy(raw string) error {
	if isDirectAgentProxy(raw) {
		for _, client := range agentManagementHTTPClients() {
			if transport, ok := client.Transport.(*http.Transport); ok {
				transport.CloseIdleConnections()
				transport.Proxy = nil
			}
		}
		logf("management proxy disabled: direct (environment proxy variables ignored for panel traffic)")
		return nil
	}
	u, err := parseAgentProxy(raw)
	if err != nil {
		return err
	}
	if u == nil {
		return nil
	}
	for _, client := range agentManagementHTTPClients() {
		transport, ok := client.Transport.(*http.Transport)
		if !ok {
			continue
		}
		transport.CloseIdleConnections()
		transport.Proxy = http.ProxyURL(u)
	}
	logf("management proxy enabled endpoint=%s (panel traffic only; forwarding and probes stay direct)", redactedProxyEndpoint(u))
	return nil
}

// agentUpgradeProxySetup 是自升级命令最前面那一段 shell：systemd-run 起的升级任务不继承 Agent 的
// 环境变量，所以在任务里重新从（只有 root 能读的）配置文件读 proxyUrl —— 代理密码不进命令行、
// 不进进程列表。读不出来就取消升级，不悄悄改成直连。
func agentUpgradeProxySetup(path string) string {
	if strings.TrimSpace(path) == "" {
		path = defaultConfigPath
	}
	// 配置里根本没有 proxyUrl（老部署）就不用 jq：这样老机器没装 jq 也照样能升级。
	return fmt.Sprintf(`proxy=''; if grep -q '"proxyUrl"' %[1]s 2>/dev/null; then proxy=$(jq -er 'if type == "object" and (.proxyUrl == null or (.proxyUrl | type == "string")) then (.proxyUrl // "") else error("invalid proxy config") end' %[1]s) || { echo '[ERROR] Cannot read Agent proxy configuration; upgrade cancelled' >&2; upgrade_log proxy-config-invalid; exit 1; }; fi; if [ "$proxy" = direct ]; then unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY; export FORWARDX_AGENT_PROXY=direct; upgrade_log proxy-direct; elif [ -n "$proxy" ]; then unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY no_proxy NO_PROXY; case "$proxy" in socks5://*) proxy="socks5h://${proxy#socks5://}";; esac; export FORWARDX_AGENT_PROXY="$proxy" http_proxy="$proxy" https_proxy="$proxy" all_proxy="$proxy" HTTP_PROXY="$proxy" HTTPS_PROXY="$proxy" ALL_PROXY="$proxy" no_proxy='' NO_PROXY=''; upgrade_log proxy-enabled; fi; `, shellQuote(path))
}
