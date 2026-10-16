package main

// 探测服务的地址族（2.2.226 起）：面板在 hostProbeServices 里带 family = ipv4 / ipv6 时，
// 目标是域名就只用这一族的地址去测；没有这一族的地址就记不通，而不是悄悄换另一族。
// 目标本身是 IP、或 family 为空 / auto 时完全照旧。面板那头见 shared/probeFamily.ts。

import (
	"net"
	"strings"
)

// 测试里替换
var resolveProbeFamilyTargets = func(host string) []string {
	return resolveNetworkTargetIPs(host, tcpingProbeTimeout)
}

func normalizeProbeFamily(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "ipv4", "4", "v4":
		return "ipv4"
	case "ipv6", "6", "v6":
		return "ipv6"
	default:
		return ""
	}
}

// resolveProbeTargetForFamily 返回实际要测的地址；第二个返回值 false 表示这个域名没有这一族的地址。
func resolveProbeTargetForFamily(target, family string) (string, bool) {
	family = normalizeProbeFamily(family)
	host := normalizeNetworkTargetHost(target)
	if family == "" || host == "" || net.ParseIP(host) != nil {
		return target, true
	}
	for _, candidate := range resolveProbeFamilyTargets(host) {
		ip := net.ParseIP(candidate)
		if ip == nil {
			continue
		}
		isV4 := ip.To4() != nil
		if (family == "ipv4" && isV4) || (family == "ipv6" && !isV4) {
			return ip.String(), true
		}
	}
	return "", false
}
