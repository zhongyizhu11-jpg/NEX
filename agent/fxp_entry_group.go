package main

import (
	"os"
	"os/exec"
	"strconv"
	"strings"
)

type fxpProcess struct {
	signature             string
	cmd                   *exec.Cmd
	configPath            string
	spec                  fxpSpec
	wireGuardRefID        string
	runtimeExecutable     os.FileInfo
	panelCredentialDigest string
}

const fxpEntryGroupRole = "entry-group"

func normalizeFXPTransportVersion(version string) string {
	if strings.EqualFold(strings.TrimSpace(version), forwardXWireGuardVersion) {
		return forwardXWireGuardVersion
	}
	return "v1"
}

func isSharedFXPEntry(spec fxpSpec) bool {
	version := normalizeFXPTransportVersion(spec.TransportVersion)
	return strings.EqualFold(strings.TrimSpace(spec.Role), "entry") &&
		(version == "v1" || version == forwardXWireGuardVersion) &&
		spec.TunnelID > 0 && spec.RuleID > 0 && spec.ListenPort > 0
}

func isFXPEntryGroup(spec fxpSpec) bool {
	version := normalizeFXPTransportVersion(spec.TransportVersion)
	return strings.EqualFold(strings.TrimSpace(spec.Role), fxpEntryGroupRole) &&
		(version == "v1" || version == forwardXWireGuardVersion) &&
		spec.TunnelID > 0
}

func fxpEntryGroupKey(transportVersion string, tunnelID int) string {
	return normalizeFXPTransportVersion(transportVersion) + ":" + strconv.Itoa(tunnelID)
}

func fxpEntryGroupServerID(transportVersion string, tunnelID int) string {
	return fxpEntryGroupRole + ":" + fxpEntryGroupKey(transportVersion, tunnelID)
}

func fxpEntryIdentity(spec fxpSpec) string {
	spec = normalizeFXPSpec(spec)
	return strconv.Itoa(spec.RuleID) + ":" + strconv.Itoa(spec.ListenPort) + ":" + spec.Protocol
}

func fxpEntryMatches(left fxpSpec, right fxpSpec) bool {
	left = normalizeFXPSpec(left)
	right = normalizeFXPSpec(right)
	return isSharedFXPEntry(left) && isSharedFXPEntry(right) &&
		left.TransportVersion == right.TransportVersion &&
		left.TunnelID == right.TunnelID &&
		fxpServerSignature(left) == fxpServerSignature(right)
}

func fxpEntryGroupContains(group fxpSpec, entry fxpSpec) bool {
	group = normalizeFXPSpec(group)
	entry = normalizeFXPSpec(entry)
	if !isFXPEntryGroup(group) || !isSharedFXPEntry(entry) || group.TransportVersion != entry.TransportVersion || group.TunnelID != entry.TunnelID {
		return false
	}
	for _, candidate := range group.Entries {
		if fxpEntryMatches(candidate, entry) {
			return true
		}
	}
	return false
}

func fxpRemovalMatchesEntry(request fxpSpec, entry fxpSpec) bool {
	requestedProtocol := strings.TrimSpace(request.Protocol)
	requestedTransportVersion := strings.TrimSpace(request.TransportVersion)
	entry = normalizeFXPSpec(entry)
	if !isSharedFXPEntry(entry) {
		return false
	}
	if role := strings.TrimSpace(request.Role); role != "" && !strings.EqualFold(role, entry.Role) {
		return false
	}
	if request.TunnelID > 0 && request.TunnelID != entry.TunnelID {
		return false
	}
	if requestedTransportVersion != "" && normalizeFXPTransportVersion(requestedTransportVersion) != entry.TransportVersion {
		return false
	}
	if request.RuleID > 0 && request.RuleID != entry.RuleID {
		return false
	}
	if request.ListenPort > 0 && request.ListenPort != entry.ListenPort {
		return false
	}
	return requestedProtocol == "" || runtimeProtocolsOverlap(entry.Protocol, request.Protocol)
}

func buildSharedFXPEntryGroup(entries []fxpSpec, tunnelID int, transportVersion string) (fxpSpec, bool) {
	transportVersion = normalizeFXPTransportVersion(transportVersion)
	compatible := make([]fxpSpec, 0, len(entries))
	for _, entry := range entries {
		entry = normalizeFXPSpec(entry)
		if entry.TunnelID == tunnelID && entry.TransportVersion == transportVersion && isSharedFXPEntry(entry) {
			compatible = append(compatible, entry)
		}
	}
	group := fxpSpec{
		Role:             fxpEntryGroupRole,
		TransportVersion: transportVersion,
		TunnelID:         tunnelID,
		Entries:          compatible,
	}
	group = normalizeFXPSpec(group)
	return group, tunnelID > 0 && len(group.Entries) > 0
}

func desiredSharedFXPEntryGroup(current *fxpSpec, removal *fxpSpec) (fxpSpec, bool) {
	tunnelID := 0
	transportVersion := ""
	if current != nil {
		tunnelID = current.TunnelID
		transportVersion = normalizeFXPTransportVersion(current.TransportVersion)
	}
	if tunnelID <= 0 && removal != nil {
		tunnelID = removal.TunnelID
	}
	if removal != nil && strings.TrimSpace(removal.TransportVersion) != "" {
		transportVersion = normalizeFXPTransportVersion(removal.TransportVersion)
	}
	if removal != nil && (tunnelID <= 0 || transportVersion == "") {
		for _, persisted := range loadPersistedFXPSpecs() {
			if fxpRemovalMatchesEntry(*removal, persisted) {
				tunnelID = persisted.TunnelID
				transportVersion = persisted.TransportVersion
				break
			}
		}
	}
	if transportVersion == "" {
		transportVersion = "v1"
	}
	entries := make([]fxpSpec, 0)
	for _, persisted := range loadPersistedFXPSpecs() {
		if !isSharedFXPEntry(persisted) {
			continue
		}
		if tunnelID > 0 && persisted.TunnelID != tunnelID {
			continue
		}
		if persisted.TransportVersion != transportVersion {
			continue
		}
		if removal != nil && fxpRemovalMatchesEntry(*removal, persisted) {
			if tunnelID <= 0 {
				tunnelID = persisted.TunnelID
			}
			continue
		}
		if current != nil && (persisted.RuleID == current.RuleID || fxpSpecsListenConflict(persisted, *current)) {
			continue
		}
		entries = append(entries, persisted)
	}
	if current != nil {
		entries = append(entries, *current)
	}
	return buildSharedFXPEntryGroup(entries, tunnelID, transportVersion)
}

type sharedFXPEntryEndpoint struct {
	protocol string
	port     int
}

type sharedFXPEntrySlot struct {
	entry  fxpSpec
	active bool
}

type mutableSharedFXPEntryGroup struct {
	tunnelID         int
	transportVersion string
	slots            []sharedFXPEntrySlot
	active           map[int]struct{}
	byRule           map[int][]int
	byListenPort     map[int][]int
	byEndpoint       map[sharedFXPEntryEndpoint][]int
}

func newMutableSharedFXPEntryGroup(tunnelID int, transportVersion string) *mutableSharedFXPEntryGroup {
	return &mutableSharedFXPEntryGroup{
		tunnelID:         tunnelID,
		transportVersion: normalizeFXPTransportVersion(transportVersion),
		active:           map[int]struct{}{},
		byRule:           map[int][]int{},
		byListenPort:     map[int][]int{},
		byEndpoint:       map[sharedFXPEntryEndpoint][]int{},
	}
}

func sharedFXPEntryEndpoints(spec fxpSpec) ([2]sharedFXPEntryEndpoint, int) {
	var endpoints [2]sharedFXPEntryEndpoint
	count := 0
	switch normalizeRuntimeProtocol(spec.Protocol) {
	case "udp":
		if spec.UDPListenPort > 0 {
			endpoints[count] = sharedFXPEntryEndpoint{protocol: "udp", port: spec.UDPListenPort}
			count++
		}
	case "both":
		if spec.ListenPort > 0 {
			endpoints[count] = sharedFXPEntryEndpoint{protocol: "tcp", port: spec.ListenPort}
			count++
		}
		if spec.UDPListenPort > 0 {
			endpoints[count] = sharedFXPEntryEndpoint{protocol: "udp", port: spec.UDPListenPort}
			count++
		}
	default:
		if spec.ListenPort > 0 {
			endpoints[count] = sharedFXPEntryEndpoint{protocol: "tcp", port: spec.ListenPort}
			count++
		}
	}
	return endpoints, count
}

func (group *mutableSharedFXPEntryGroup) add(entry fxpSpec) {
	entry = normalizeFXPSpec(entry)
	if !isSharedFXPEntry(entry) || entry.TunnelID != group.tunnelID || entry.TransportVersion != group.transportVersion {
		return
	}
	endpoints, endpointCount := sharedFXPEntryEndpoints(entry)
	index := len(group.slots)
	group.slots = append(group.slots, sharedFXPEntrySlot{
		entry:  entry,
		active: true,
	})
	group.active[index] = struct{}{}
	group.byRule[entry.RuleID] = append(group.byRule[entry.RuleID], index)
	group.byListenPort[entry.ListenPort] = append(group.byListenPort[entry.ListenPort], index)
	for endpointIndex := 0; endpointIndex < endpointCount; endpointIndex++ {
		endpoint := endpoints[endpointIndex]
		group.byEndpoint[endpoint] = append(group.byEndpoint[endpoint], index)
	}
}

func (group *mutableSharedFXPEntryGroup) removeSlot(index int) {
	if index < 0 || index >= len(group.slots) || !group.slots[index].active {
		return
	}
	group.slots[index].active = false
	delete(group.active, index)
}

func (group *mutableSharedFXPEntryGroup) removeMatching(request fxpSpec) {
	var candidates []int
	selectedByRule := request.RuleID > 0
	selectedByListenPort := !selectedByRule && request.ListenPort > 0
	switch {
	case selectedByRule:
		candidates = group.byRule[request.RuleID]
	case selectedByListenPort:
		candidates = group.byListenPort[request.ListenPort]
	default:
		for index := range group.active {
			if fxpRemovalMatchesEntry(request, group.slots[index].entry) {
				group.removeSlot(index)
			}
		}
		return
	}

	remaining := candidates[:0]
	for _, index := range candidates {
		if !group.slots[index].active {
			continue
		}
		if fxpRemovalMatchesEntry(request, group.slots[index].entry) {
			group.removeSlot(index)
			continue
		}
		remaining = append(remaining, index)
	}
	if selectedByRule {
		if len(remaining) == 0 {
			delete(group.byRule, request.RuleID)
		} else {
			group.byRule[request.RuleID] = remaining
		}
		return
	}
	if len(remaining) == 0 {
		delete(group.byListenPort, request.ListenPort)
	} else {
		group.byListenPort[request.ListenPort] = remaining
	}
}

func (group *mutableSharedFXPEntryGroup) removeRule(ruleID int) {
	for _, index := range group.byRule[ruleID] {
		group.removeSlot(index)
	}
	delete(group.byRule, ruleID)
}

func (group *mutableSharedFXPEntryGroup) removeListenConflicts(entry fxpSpec) {
	endpoints, endpointCount := sharedFXPEntryEndpoints(entry)
	for endpointIndex := 0; endpointIndex < endpointCount; endpointIndex++ {
		endpoint := endpoints[endpointIndex]
		for _, index := range group.byEndpoint[endpoint] {
			group.removeSlot(index)
		}
		delete(group.byEndpoint, endpoint)
	}
}

func (group *mutableSharedFXPEntryGroup) snapshot() fxpSpec {
	entries := make([]fxpSpec, 0, len(group.active))
	for index := range group.slots {
		if group.slots[index].active {
			entries = append(entries, group.slots[index].entry)
		}
	}
	snapshot, _ := buildSharedFXPEntryGroup(entries, group.tunnelID, group.transportVersion)
	return snapshot
}

type sharedFXPEntryGroupMutation struct {
	actionIndex      int
	key              string
	spec             fxpSpec
	appendEntry      bool
	replaceConflicts bool
}

func sharedFXPEntryGroupMutationForAction(actionIndex int, item action) (sharedFXPEntryGroupMutation, bool) {
	if item.Fxp == nil {
		return sharedFXPEntryGroupMutation{}, false
	}

	op := strings.TrimSpace(item.Op)
	raw := *item.Fxp
	if op == "remove" {
		role := strings.TrimSpace(raw.Role)
		if raw.TunnelID <= 0 || (role != "" && !strings.EqualFold(role, "entry")) {
			return sharedFXPEntryGroupMutation{}, false
		}
		transportVersion := normalizeFXPTransportVersion(raw.TransportVersion)
		return sharedFXPEntryGroupMutation{
			actionIndex: actionIndex,
			key:         fxpEntryGroupKey(transportVersion, raw.TunnelID),
			spec:        raw,
		}, true
	}

	spec := normalizeFXPSpec(raw)
	if !isSharedFXPEntry(spec) {
		return sharedFXPEntryGroupMutation{}, false
	}
	return sharedFXPEntryGroupMutation{
		actionIndex:      actionIndex,
		key:              fxpEntryGroupKey(spec.TransportVersion, spec.TunnelID),
		spec:             spec,
		appendEntry:      op == "apply",
		replaceConflicts: item.Op == "apply",
	}, true
}

func attachDesiredSharedFXPEntryGroups(actions []action) {
	mutations := make([]sharedFXPEntryGroupMutation, 0, len(actions))
	groups := map[string]*mutableSharedFXPEntryGroup{}
	for index, item := range actions {
		mutation, ok := sharedFXPEntryGroupMutationForAction(index, item)
		if !ok {
			continue
		}
		mutations = append(mutations, mutation)
		if groups[mutation.key] != nil {
			continue
		}
		transportVersion := normalizeFXPTransportVersion(mutation.spec.TransportVersion)
		groups[mutation.key] = newMutableSharedFXPEntryGroup(mutation.spec.TunnelID, transportVersion)
	}
	if len(mutations) == 0 {
		return
	}

	for _, persisted := range loadPersistedFXPSpecs() {
		if !isSharedFXPEntry(persisted) {
			continue
		}
		if group := groups[fxpEntryGroupKey(persisted.TransportVersion, persisted.TunnelID)]; group != nil {
			group.add(persisted)
		}
	}
	// A desired non-FXP apply supersedes any persisted NEX member with the
	// same rule identity. Remove it before attaching the final group to sibling
	// NEX actions so those siblings rebuild immediately in this batch.
	for _, item := range actions {
		if strings.TrimSpace(item.Op) != "apply" || item.Fxp != nil || item.RuleID <= 0 {
			continue
		}
		removal := fxpSpec{Role: "entry", RuleID: item.RuleID, TunnelID: item.TunnelID}
		for _, group := range groups {
			group.removeMatching(removal)
		}
	}
	for _, mutation := range mutations {
		group := groups[mutation.key]
		group.removeMatching(mutation.spec)
		if mutation.replaceConflicts {
			group.removeRule(mutation.spec.RuleID)
			group.removeListenConflicts(mutation.spec)
		}
		if mutation.appendEntry {
			group.add(mutation.spec)
		}
	}

	staged := map[string]fxpSpec{}
	for key, group := range groups {
		staged[key] = group.snapshot()
	}
	for _, mutation := range mutations {
		group := staged[mutation.key]
		groupCopy := group
		actions[mutation.actionIndex].FXPEntryGroup = &groupCopy
	}
}
