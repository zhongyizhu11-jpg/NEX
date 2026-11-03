package main

import (
	"encoding/json"
	"fmt"
	"hash/fnv"
	"os"
	"sort"
	"strconv"
	"strings"
)

type localRuntimeStatePayload struct {
	Rules    []localRuntimeRuleState    `json:"rules,omitempty"`
	Tunnels  []localRuntimeTunnelState  `json:"tunnels,omitempty"`
	Services []localRuntimeServiceState `json:"services,omitempty"`
	// WireGuardPlanes 是每条跑着的 V2 隧道的数据面，入口机上也报（见 localRuntimeWireGuardPlaneState）。
	WireGuardPlanes []localRuntimeWireGuardPlaneState `json:"wireGuardPlanes,omitempty"`
}

type localRuntimeRuleState struct {
	Port             int    `json:"port"`
	RuleID           int    `json:"ruleId"`
	TunnelID         int    `json:"tunnelId,omitempty"`
	ForwardType      string `json:"forwardType"`
	TargetIP         string `json:"targetIp,omitempty"`
	TargetPort       int    `json:"targetPort,omitempty"`
	Protocol         string `json:"protocol,omitempty"`
	TransportVersion string `json:"transportVersion,omitempty"`
	Ready            bool   `json:"ready"`
}

// localRuntimeWireGuardPlaneState 是一条跑着的 V2 隧道的数据面（Agent 2.2.220 起单独上报：
// 入口机上没有隧道监听端口，以前只有出口能通过 tunnels 报出数据面）。
type localRuntimeWireGuardPlaneState struct {
	TunnelID int    `json:"tunnelId"`
	Plane    string `json:"plane"`
}

type localRuntimeTunnelState struct {
	Port             int    `json:"port"`
	TunnelID         int    `json:"tunnelId"`
	ForwardType      string `json:"forwardType"`
	TransportVersion string `json:"transportVersion,omitempty"`
	// WireGuardPlane 是 V2 隧道当前的数据面：kernel（内核 WireGuard）或 netstack
	// （wireguard-go 用户态协议栈）。V1 和没起来的隧道为空。
	WireGuardPlane string `json:"wireGuardPlane,omitempty"`
	Ready          bool   `json:"ready"`
}

type localRuntimeServiceState struct {
	Name            string `json:"name"`
	Active          bool   `json:"active"`
	HasWork         bool   `json:"hasWork"`
	Status          string `json:"status,omitempty"`
	Message         string `json:"message,omitempty"`
	HooksReady      *bool  `json:"hooksReady,omitempty"`
	ConnectionState string `json:"connectionState,omitempty"`
}

func readLocalRuntimeStatePayload() localRuntimeStatePayload {
	readiness := readLocalRuntimeReadinessCached()
	ruleStates := readLocalRuntimeRuleStates()
	ruleStates = mergeDesiredDisjointRuleStates(ruleStates, desiredRunningRuleStatesSnapshot())
	activeFXPSpecs := activeFXPSpecsSnapshot()
	activeFXPEntries := activeFXPEntrySpecsSnapshot()
	var persistedFXPEntries []fxpSpec
	persistedFXPLoaded := false
	rules := make([]localRuntimeRuleState, 0, len(ruleStates))
	for _, state := range ruleStates {
		port := atoi(state.Port)
		if port <= 0 {
			continue
		}
		transportVersion := fxpTransportVersionForLocalRule(state, activeFXPEntries)
		if transportVersion == "" && strings.EqualFold(strings.TrimSpace(state.ForwardType), "forwardx") {
			if !persistedFXPLoaded {
				persistedFXPEntries = loadPersistedFXPSpecs()
				persistedFXPLoaded = true
			}
			transportVersion = fxpTransportVersionForLocalRule(state, persistedFXPEntries)
		}
		rules = append(rules, localRuntimeRuleState{
			Port:             port,
			RuleID:           state.RuleID,
			TunnelID:         state.TunnelID,
			ForwardType:      strings.TrimSpace(state.ForwardType),
			TargetIP:         strings.TrimSpace(state.TargetIP),
			TargetPort:       state.TargetPort,
			Protocol:         strings.TrimSpace(state.Protocol),
			TransportVersion: transportVersion,
			Ready:            localRuleStateReady(state, &readiness),
		})
	}
	tunnels := []localRuntimeTunnelState{}
	files, err := os.ReadDir(agentStateDir)
	if err == nil {
		for _, f := range files {
			name := f.Name()
			if !strings.HasPrefix(name, "tunnel_") || !strings.HasSuffix(name, ".id") {
				continue
			}
			port := strings.TrimSuffix(strings.TrimPrefix(name, "tunnel_"), ".id")
			portValue := atoi(port)
			if portValue <= 0 {
				continue
			}
			tunnelID := readTunnelIDByPort(port)
			if tunnelID <= 0 {
				continue
			}
			forwardType := strings.TrimSpace(readTunnelForwardTypeByPort(port))
			transportVersion := fxpTransportVersionForLocalTunnel(tunnelID, portValue, activeFXPSpecs)
			if transportVersion == "" {
				if !persistedFXPLoaded {
					persistedFXPEntries = loadPersistedFXPSpecs()
					persistedFXPLoaded = true
				}
				transportVersion = fxpTransportVersionForLocalTunnel(tunnelID, portValue, persistedFXPEntries)
			}
			wireGuardPlane := ""
			if transportVersion == forwardXWireGuardVersion {
				wireGuardPlane = wireGuardRuntimePlaneKind(tunnelID)
			}
			tunnels = append(tunnels, localRuntimeTunnelState{
				Port:             portValue,
				TunnelID:         tunnelID,
				ForwardType:      forwardType,
				TransportVersion: transportVersion,
				WireGuardPlane:   wireGuardPlane,
				Ready:            localTunnelStateReady(tunnelID, portValue, forwardType, &readiness),
			})
		}
	}
	sort.Slice(rules, func(i, j int) bool {
		if rules[i].Port == rules[j].Port {
			return rules[i].RuleID < rules[j].RuleID
		}
		return rules[i].Port < rules[j].Port
	})
	sort.Slice(tunnels, func(i, j int) bool {
		if tunnels[i].Port == tunnels[j].Port {
			return tunnels[i].TunnelID < tunnels[j].TunnelID
		}
		return tunnels[i].Port < tunnels[j].Port
	})
	return localRuntimeStatePayload{Rules: rules, Tunnels: tunnels, Services: readiness.serviceStates, WireGuardPlanes: wireGuardRuntimePlaneKinds()}
}

func activeFXPEntrySpecsSnapshot() []fxpSpec {
	return flattenFXPEntrySpecs(activeFXPSpecsSnapshot())
}

func activeFXPSpecsSnapshot() []fxpSpec {
	fxpMu.Lock()
	specs := make([]fxpSpec, 0, len(fxpServers))
	for _, process := range fxpServers {
		if process != nil {
			specs = append(specs, normalizeFXPSpec(process.spec))
		}
	}
	fxpMu.Unlock()
	return specs
}

func flattenFXPEntrySpecs(specs []fxpSpec) []fxpSpec {
	entries := make([]fxpSpec, 0, len(specs))
	for _, spec := range specs {
		spec = normalizeFXPSpec(spec)
		if isFXPEntryGroup(spec) {
			entries = append(entries, spec.Entries...)
			continue
		}
		if isSharedFXPEntry(spec) {
			entries = append(entries, spec)
		}
	}
	return entries
}

func fxpTransportVersionForLocalRule(state localRuleState, entries []fxpSpec) string {
	if !strings.EqualFold(strings.TrimSpace(state.ForwardType), "forwardx") || state.RuleID <= 0 || atoi(state.Port) <= 0 {
		return ""
	}
	version := ""
	for _, entry := range flattenFXPEntrySpecs(entries) {
		entry = normalizeFXPSpec(entry)
		if entry.RuleID != state.RuleID || entry.ListenPort != atoi(state.Port) {
			continue
		}
		if state.TunnelID > 0 && entry.TunnelID != state.TunnelID {
			continue
		}
		if strings.TrimSpace(state.Protocol) != "" && !runtimeProtocolsOverlap(entry.Protocol, state.Protocol) {
			continue
		}
		if version != "" && version != entry.TransportVersion {
			return ""
		}
		version = entry.TransportVersion
	}
	return version
}

func fxpTransportVersionForLocalTunnel(tunnelID int, port int, specs []fxpSpec) string {
	if tunnelID <= 0 || port <= 0 {
		return ""
	}
	version := ""
	for _, raw := range specs {
		raw = normalizeFXPSpec(raw)
		candidates := []fxpSpec{raw}
		if isFXPEntryGroup(raw) {
			candidates = raw.Entries
		}
		for _, candidate := range candidates {
			candidate = normalizeFXPSpec(candidate)
			if candidate.TunnelID != tunnelID || candidate.Role != "relay" && candidate.Role != "exit" {
				continue
			}
			if !fxpSpecUsesListenEndpoint(candidate, port, "both") {
				continue
			}
			if version != "" && version != candidate.TransportVersion {
				return ""
			}
			version = candidate.TransportVersion
		}
	}
	return version
}

func mergeDesiredDisjointRuleStates(ruleStates []localRuleState, desiredStates []localRuleState) []localRuleState {
	seenRuleStates := map[string]bool{}
	reportedProtocolsByPort := map[string][]string{}
	for _, state := range ruleStates {
		key := fmt.Sprintf("%d:%s:%s", state.RuleID, state.Port, normalizeRuntimeProtocol(state.Protocol))
		seenRuleStates[key] = true
		reportedProtocolsByPort[state.Port] = append(reportedProtocolsByPort[state.Port], state.Protocol)
	}
	// The legacy on-disk marker is keyed only by port. Merge the desired rule
	// snapshot only when another disjoint protocol is already recorded on that
	// port, so a completely missing listener cannot be mistaken for desired state.
	for _, state := range desiredStates {
		key := fmt.Sprintf("%d:%s:%s", state.RuleID, state.Port, normalizeRuntimeProtocol(state.Protocol))
		if seenRuleStates[key] {
			continue
		}
		hasDisjointReportedProtocol := false
		for _, reportedProtocol := range reportedProtocolsByPort[state.Port] {
			if !runtimeProtocolsOverlap(reportedProtocol, state.Protocol) {
				hasDisjointReportedProtocol = true
				break
			}
		}
		if !hasDisjointReportedProtocol {
			continue
		}
		seenRuleStates[key] = true
		ruleStates = append(ruleStates, state)
	}
	return ruleStates
}

func localRuntimeStateSignature(state localRuntimeStatePayload) string {
	raw, err := json.Marshal(state)
	if err != nil {
		return ""
	}
	h := fnv.New64a()
	_, _ = h.Write(raw)
	return strconv.FormatUint(h.Sum64(), 16)
}

func localRuntimeStateForHeartbeat() (string, *localRuntimeStatePayload) {
	state := readLocalRuntimeStatePayload()
	signature := localRuntimeStateSignature(state)
	localRuntimeStateMu.Lock()
	sendFull := forceSendLocalRuntimeState || signature != lastLocalRuntimeStateSignature
	if sendFull {
		lastLocalRuntimeStateSignature = signature
		forceSendLocalRuntimeState = false
	}
	localRuntimeStateMu.Unlock()
	if sendFull {
		return signature, &state
	}
	return signature, nil
}

func requestLocalRuntimeStateUpload() {
	localRuntimeStateMu.Lock()
	forceSendLocalRuntimeState = true
	localRuntimeStateMu.Unlock()
	// 运行时状态有变化，丢弃 readiness 缓存以便下次心跳重新采集。
	invalidateLocalRuntimeReadinessCache()
}
