package main

import (
	"net"
	"sort"
	"strconv"
	"strings"
)

func fxpServerID(spec fxpSpec) string {
	if isFXPEntryGroup(spec) {
		return fxpEntryGroupServerID(spec.TransportVersion, spec.TunnelID)
	}
	return normalizeFXPTransportVersion(spec.TransportVersion) + ":" + spec.Role + ":" + strconv.Itoa(spec.TunnelID) + ":" + strconv.Itoa(spec.RuleID) + ":" + strconv.Itoa(spec.ListenPort)
}

func normalizeFXPSpec(spec fxpSpec) fxpSpec {
	spec.Role = strings.ToLower(strings.TrimSpace(spec.Role))
	spec.TransportVersion = strings.ToLower(strings.TrimSpace(spec.TransportVersion))
	if spec.TransportVersion != forwardXWireGuardVersion {
		spec.TransportVersion = "v1"
	}
	if spec.Role == fxpEntryGroupRole {
		entries := make([]fxpSpec, 0, len(spec.Entries))
		byIdentity := map[string]int{}
		for _, entry := range spec.Entries {
			entry.Entries = nil
			entry.Role = "entry"
			entry.TransportVersion = spec.TransportVersion
			entry.TunnelID = spec.TunnelID
			entry = normalizeFXPSpec(entry)
			if !isSharedFXPEntry(entry) || entry.Key == "" {
				continue
			}
			identity := fxpEntryIdentity(entry)
			if index, exists := byIdentity[identity]; exists {
				entries[index] = entry
				continue
			}
			byIdentity[identity] = len(entries)
			entries = append(entries, entry)
		}
		sort.Slice(entries, func(i, j int) bool {
			if entries[i].RuleID != entries[j].RuleID {
				return entries[i].RuleID < entries[j].RuleID
			}
			if entries[i].ListenPort != entries[j].ListenPort {
				return entries[i].ListenPort < entries[j].ListenPort
			}
			return entries[i].Protocol < entries[j].Protocol
		})
		spec.Entries = entries
		spec.RuleID = 0
		spec.ListenPort = 0
		spec.UDPListenPort = 0
		spec.Protocol = ""
		spec.Key = ""
		return spec
	}
	spec.Entries = nil
	spec.Protocol = normalizeRuntimeProtocol(spec.Protocol)
	spec.ListenHost = strings.TrimSpace(spec.ListenHost)
	spec.ExitHost = strings.TrimSpace(spec.ExitHost)
	switch strings.ToLower(strings.TrimSpace(spec.ExitStrategy)) {
	case "fallback", "random", "ip_hash", "weighted", "least_load":
		spec.ExitStrategy = strings.ToLower(strings.TrimSpace(spec.ExitStrategy))
	default:
		spec.ExitStrategy = "round_robin"
	}
	spec.ExitPeerID = strings.TrimSpace(spec.ExitPeerID)
	spec.TargetIP = strings.TrimSpace(spec.TargetIP)
	spec.RelayExitHost = strings.TrimSpace(spec.RelayExitHost)
	spec.RelayPeerID = strings.TrimSpace(spec.RelayPeerID)
	if spec.UDPListenPort <= 0 {
		spec.UDPListenPort = spec.ListenPort
	}
	if spec.UDPExitPort <= 0 {
		spec.UDPExitPort = spec.ExitPort
	}
	if spec.UDPRelayExitPort <= 0 {
		spec.UDPRelayExitPort = spec.RelayExitPort
	}
	for i := range spec.Exits {
		spec.Exits[i].Host = strings.TrimSpace(spec.Exits[i].Host)
		spec.Exits[i].PeerID = strings.TrimSpace(spec.Exits[i].PeerID)
		// 出口 IP 只是提示，不进 fxpServerSignature（见 fxpExitEndpoint.ExitIP）。
		spec.Exits[i].ExitIP = strings.TrimSpace(spec.Exits[i].ExitIP)
		if spec.Exits[i].UDPPort <= 0 {
			spec.Exits[i].UDPPort = spec.Exits[i].Port
		}
		if spec.Exits[i].Key == "" {
			spec.Exits[i].Key = spec.Key
		}
	}
	targets := make([]fxpUDPTarget, 0, len(spec.UDPTargets))
	seenTargets := map[int]bool{}
	for _, target := range spec.UDPTargets {
		target.TargetIP = strings.TrimSpace(target.TargetIP)
		if target.RuleID <= 0 || target.TargetIP == "" || target.TargetPort <= 0 || target.TargetPort > 65535 || seenTargets[target.RuleID] {
			continue
		}
		seenTargets[target.RuleID] = true
		targets = append(targets, target)
	}
	sort.Slice(targets, func(i, j int) bool { return targets[i].RuleID < targets[j].RuleID })
	spec.UDPTargets = targets
	streamTargets := make([]fxpUDPTarget, 0, len(spec.StreamTargets))
	seenStreamTargets := map[fxpUDPTarget]bool{}
	for _, target := range spec.StreamTargets {
		target.TargetIP = strings.TrimSpace(target.TargetIP)
		if target.RuleID <= 0 || target.TargetIP == "" || target.TargetPort <= 0 || target.TargetPort > 65535 || seenStreamTargets[target] {
			continue
		}
		seenStreamTargets[target] = true
		streamTargets = append(streamTargets, target)
	}
	sort.SliceStable(streamTargets, func(i, j int) bool { return streamTargets[i].RuleID < streamTargets[j].RuleID })
	spec.StreamTargets = streamTargets
	spec = normalizeFXPMultipath(spec)
	return spec
}

// normalizeFXPMultipath cleans the multipath leg list and only leaves striping
// enabled when there are at least two usable legs, since one leg is just an
// ordinary single-path session.
func normalizeFXPMultipath(spec fxpSpec) fxpSpec {
	legs := make([]fxpMultipathLeg, 0, len(spec.MultipathLegs))
	seen := map[string]bool{}
	for _, leg := range spec.MultipathLegs {
		leg.Host = strings.TrimSpace(leg.Host)
		leg.Via = strings.TrimSpace(leg.Via)
		if leg.Host == "" || leg.Port <= 0 || leg.Port > 65535 {
			continue
		}
		if leg.CapacityMbps < 0 || leg.CapacityMbps > 1_000_000 {
			leg.CapacityMbps = 0
		}
		if strings.TrimSpace(leg.Key) == "" {
			leg.Key = spec.Key
		}
		// 同一地址 + 同一 via 才算重复：单连接多路并发（面板 2.3.452 起）会把同一个出口
		// 重复几条腿、各带 stream#N，入口对它各开一条连接。老 Agent 按地址去重，
		// 这几条会收成一条 —— 也就是退回普通单路，不会出错。
		endpoint := net.JoinHostPort(leg.Host, strconv.Itoa(leg.Port)) + "|" + leg.Via
		if seen[endpoint] {
			continue
		}
		seen[endpoint] = true
		legs = append(legs, leg)
	}
	if len(legs) < 2 {
		spec.MultipathEnabled = false
		spec.MultipathLegs = nil
		spec.MultipathReplicate = false
		return spec
	}
	spec.MultipathLegs = legs
	if spec.MultipathMaxPending < 0 {
		spec.MultipathMaxPending = 0
	}
	return spec
}

func fxpServerSignature(spec fxpSpec) string {
	spec = normalizeFXPSpec(spec)
	if isFXPEntryGroup(spec) {
		parts := []string{spec.Role, spec.TransportVersion, strconv.Itoa(spec.TunnelID)}
		for _, entry := range spec.Entries {
			parts = append(parts, fxpServerSignature(entry))
		}
		return strings.Join(parts, "||")
	}
	parts := []string{
		spec.Role,
		spec.TransportVersion,
		strconv.Itoa(spec.TunnelID),
		strconv.Itoa(spec.RuleID),
		strconv.Itoa(spec.ListenPort),
		strconv.Itoa(spec.UDPListenPort),
		spec.ListenHost,
		spec.Protocol,
		spec.ExitHost,
		strconv.Itoa(spec.ExitPort),
		strconv.Itoa(spec.UDPExitPort),
		spec.ExitPeerID,
		spec.ExitStrategy,
		spec.TargetIP,
		strconv.Itoa(spec.TargetPort),
		spec.Key,
		strconv.FormatInt(spec.LimitIn, 10),
		strconv.FormatInt(spec.LimitOut, 10),
		strconv.Itoa(spec.MaxConnections),
		strconv.Itoa(spec.MaxIPs),
		spec.AccessScope,
		strconv.FormatBool(spec.BlockHTTP),
		strconv.FormatBool(spec.BlockSocks),
		strconv.FormatBool(spec.BlockTLS),
		strconv.FormatBool(spec.ProxyProtocolReceive),
		strconv.FormatBool(spec.ProxyProtocolSend),
		strconv.FormatBool(spec.ProxyProtocolExitReceive),
		strconv.FormatBool(spec.ProxyProtocolExitSend),
		strconv.Itoa(normalizeProxyProtocolVersion(spec.ProxyProtocolVersion)),
		strconv.FormatBool(spec.TCPFastOpen),
		// 链路整形的档位和上限变了要让 FXP 重读配置（热更新就够，监听不动）；
		// 提示值只在 FXP 启动时用，不进签名。
		strings.ToLower(strings.TrimSpace(spec.LinkShaping)),
		strconv.Itoa(spec.LinkUpMbps),
		strconv.Itoa(spec.LinkDownMbps),
		strings.ToLower(strings.TrimSpace(spec.EgressShaping)),
		strconv.Itoa(spec.EgressMbps),
		// 抗丢包开关变了要重启 FXP 的 UDP 监听（FXP 热更新时按配置指纹自己判断）。
		strconv.FormatBool(spec.UDPFEC),
		spec.RelayExitHost,
		strconv.Itoa(spec.RelayExitPort),
		strconv.Itoa(spec.UDPRelayExitPort),
		spec.RelayPeerID,
		spec.RelayKey,
		strconv.Itoa(spec.DNSGeneration),
		// Multipath belongs in the signature: switching a tunnel between
		// failover and aggregate changes only these fields, and the runtime
		// must restart to pick the new mode up.
		strconv.FormatBool(spec.MultipathEnabled),
		strconv.Itoa(spec.MultipathMaxPending),
	}
	// 复制模式只在打开时进签名：没开复制的隧道签名和旧版一模一样，升级 Agent 不会因此重启 FXP。
	if spec.MultipathReplicate {
		parts = append(parts, "replicate")
	}
	// 抗丢包传输也只在打开时进签名：没开的隧道签名不变，升级不重启 FXP。开关它 FXP 热更新就够
	// （按配置指纹自己开关 UDP 承载监听）。
	if spec.LossTolerant {
		parts = append(parts, "loss-tolerant")
	}
	for _, leg := range spec.MultipathLegs {
		parts = append(parts, strings.TrimSpace(leg.Host), strconv.Itoa(leg.Port), strings.TrimSpace(leg.Key))
		// 带宽只在写了时进签名：没写的隧道签名和旧版一样，升级不重启 FXP。
		if leg.CapacityMbps > 0 {
			parts = append(parts, "c"+strconv.Itoa(leg.CapacityMbps))
		}
		// 热备只在打开时进签名：主腿 / 热备腿一换，FXP 要重启才会按新分工走。
		if leg.Standby {
			parts = append(parts, "standby")
		}
	}
	for _, exit := range spec.Exits {
		parts = append(parts, strings.TrimSpace(exit.Host), strconv.Itoa(exit.Port), strconv.Itoa(exit.UDPPort), strings.TrimSpace(exit.Key), strings.TrimSpace(exit.PeerID))
		// 权重只在写了时进签名：不用 weighted 的规则签名和旧版一样，升级不重启 FXP。
		if exit.Weight > 0 {
			parts = append(parts, "w"+strconv.Itoa(exit.Weight))
		}
		if exit.CapacityMbps > 0 {
			parts = append(parts, "c"+strconv.Itoa(exit.CapacityMbps))
		}
	}
	for _, target := range spec.UDPTargets {
		parts = append(parts, strconv.Itoa(target.RuleID), strings.TrimSpace(target.TargetIP), strconv.Itoa(target.TargetPort))
	}
	// TCP 目标表变了出口必须拿到新配置，否则新规则的连接会被出口拒掉。
	parts = append(parts, "stream")
	for _, target := range spec.StreamTargets {
		parts = append(parts, strconv.Itoa(target.RuleID), strings.TrimSpace(target.TargetIP), strconv.Itoa(target.TargetPort))
	}
	return strings.Join(parts, "|")
}
