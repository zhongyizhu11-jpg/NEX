package main

import (
	"net"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

type kernelForwardSnapshot struct {
	nftLoaded               bool
	nftTable                string
	iptablesLoaded          map[string]bool
	iptablesNatRule         map[string]string
	iptablesMangleLoaded    bool
	iptablesForwardxMarkers map[int]bool
}

func newKernelForwardSnapshot() *kernelForwardSnapshot {
	return &kernelForwardSnapshot{
		iptablesLoaded:          map[string]bool{},
		iptablesNatRule:         map[string]string{},
		iptablesForwardxMarkers: map[int]bool{},
	}
}

func actionRequiresKernelForwardConsistency(a action) bool {
	if a.SourcePort <= 0 || strings.TrimSpace(a.StatusType) == "runtime" || strings.TrimSpace(a.StatusType) == "tunnel" {
		return false
	}
	switch strings.TrimSpace(a.ForwardType) {
	case "iptables", "nftables":
		return true
	default:
		return false
	}
}

func (s *kernelForwardSnapshot) desiredActionConsistent(a action) bool {
	if !actionRequiresKernelForwardConsistency(a) {
		return true
	}
	switch strings.TrimSpace(a.Op) {
	case "apply":
		return s.actionApplyReady(a)
	case "remove":
		return s.actionRemoveDone(a)
	default:
		return true
	}
}

func (s *kernelForwardSnapshot) actionApplyReady(a action) bool {
	return s.kernelRuleApplyPresent(a.ForwardType, a.RuleID, a.SourcePort, a.TargetIP, a.TargetPort, a.Protocol)
}

func (s *kernelForwardSnapshot) actionRemoveDone(a action) bool {
	return !s.kernelRuleResiduePresent(a.ForwardType, a.RuleID, a.SourcePort, a.Protocol)
}

func (s *kernelForwardSnapshot) localRuleStateReady(state localRuleState) bool {
	return s.kernelRuleApplyPresent(state.ForwardType, state.RuleID, atoi(state.Port), state.TargetIP, state.TargetPort, state.Protocol)
}

func readLocalRuntimeRuleStates() []localRuleState {
	states := readLocalRuleStates()
	return appendKernelForwardResidueStates(states)
}

type kernelForwardResidueState struct {
	state localRuleState
	tcp   bool
	udp   bool
}

func appendKernelForwardResidueStates(states []localRuleState) []localRuleState {
	existingPorts := map[string]bool{}
	for _, state := range states {
		if strings.TrimSpace(state.Port) != "" {
			existingPorts[state.Port] = true
		}
	}
	residue := newKernelForwardSnapshot().localResidueStates(existingPorts)
	if len(residue) == 0 {
		return states
	}
	return append(states, residue...)
}

func (s *kernelForwardSnapshot) localResidueStates(existingPorts map[string]bool) []localRuleState {
	byPort := map[string]*kernelForwardResidueState{}
	add := func(forwardType string, ruleID int, port int, proto string, targetIP string, targetPort int) {
		if port <= 0 {
			return
		}
		portText := strconv.Itoa(port)
		if existingPorts != nil && existingPorts[portText] {
			return
		}
		item := byPort[portText]
		if item == nil {
			item = &kernelForwardResidueState{
				state: localRuleState{
					Port:        portText,
					RuleID:      ruleID,
					ForwardType: forwardType,
					TargetIP:    targetIP,
					TargetPort:  targetPort,
				},
			}
			byPort[portText] = item
		}
		if item.state.RuleID <= 0 && ruleID > 0 {
			item.state.RuleID = ruleID
		}
		if item.state.TargetIP == "" && targetIP != "" {
			item.state.TargetIP = targetIP
		}
		if item.state.TargetPort <= 0 && targetPort > 0 {
			item.state.TargetPort = targetPort
		}
		switch proto {
		case "udp":
			item.udp = true
		default:
			item.tcp = true
		}
	}
	for _, rawLine := range strings.Split(s.nftTableText(), "\n") {
		line := kernelNormalizeLine(rawLine)
		if line == "" || !strings.Contains(line, "dnat") {
			continue
		}
		proto, port, ok := kernelLineDport(line)
		if !ok {
			continue
		}
		ruleID := kernelLineRuleID(line)
		targetIP, targetPort, _ := kernelLineDnatTarget(line)
		add("nftables", ruleID, port, proto, targetIP, targetPort)
	}
	for _, binary := range iptablesAgentBinaries() {
		for _, rawLine := range strings.Split(s.iptablesNatPreroutingText(binary), "\n") {
			line := kernelNormalizeLine(rawLine)
			if line == "" || !strings.Contains(line, "-j DNAT") {
				continue
			}
			proto, port, ok := kernelLineDport(line)
			if !ok || !s.iptablesForwardxMarkerSeenForPort(port) {
				continue
			}
			targetIP, targetPort, _ := kernelLineDnatTarget(line)
			add("iptables", 0, port, proto, targetIP, targetPort)
		}
	}
	if len(byPort) == 0 {
		return nil
	}
	ports := make([]string, 0, len(byPort))
	for port := range byPort {
		ports = append(ports, port)
	}
	sort.Slice(ports, func(i, j int) bool { return atoi(ports[i]) < atoi(ports[j]) })
	out := make([]localRuleState, 0, len(ports))
	for _, port := range ports {
		item := byPort[port]
		if item.tcp && item.udp {
			item.state.Protocol = "both"
		} else if item.udp {
			item.state.Protocol = "udp"
		} else {
			item.state.Protocol = "tcp"
		}
		out = append(out, item.state)
	}
	return out
}

func (s *kernelForwardSnapshot) kernelRuleApplyPresent(forwardType string, ruleID int, sourcePort int, targetIP string, targetPort int, protocol string) bool {
	if sourcePort <= 0 {
		return false
	}
	switch strings.TrimSpace(forwardType) {
	case "nftables":
		return s.nftForwardRulePresent(ruleID, sourcePort, targetIP, targetPort, protocol)
	case "iptables":
		return s.iptablesForwardRulePresent(sourcePort, targetIP, targetPort, protocol)
	default:
		return true
	}
}

func (s *kernelForwardSnapshot) kernelRuleResiduePresent(forwardType string, ruleID int, sourcePort int, protocol string) bool {
	if sourcePort <= 0 {
		return false
	}
	switch strings.TrimSpace(forwardType) {
	case "nftables":
		return s.nftForwardRuleResiduePresent(ruleID, sourcePort, protocol)
	case "iptables":
		return s.iptablesForwardRuleResiduePresent(sourcePort, protocol)
	default:
		return false
	}
}

func (s *kernelForwardSnapshot) nftTableText() string {
	if s == nil {
		return ""
	}
	if s.nftLoaded {
		return s.nftTable
	}
	s.nftLoaded = true
	if !commandExists("nft") {
		return ""
	}
	raw, err := commandOutputWithTimeout(5*time.Second, "nft", "-a", "list", "table", "inet", "forwardx")
	if err != nil {
		return ""
	}
	s.nftTable = string(raw)
	return s.nftTable
}

func (s *kernelForwardSnapshot) iptablesNatPreroutingText(binary string) string {
	return s.iptablesChainText(binary, "nat", "PREROUTING")
}

// iptablesChainText 读取并缓存一个表/链的 `-S` 输出；读取失败返回空串（按“未就绪”处理）。
func (s *kernelForwardSnapshot) iptablesChainText(binary string, table string, chain string) string {
	if s == nil || strings.TrimSpace(binary) == "" {
		return ""
	}
	if s.iptablesLoaded == nil {
		s.iptablesLoaded = map[string]bool{}
	}
	if s.iptablesNatRule == nil {
		s.iptablesNatRule = map[string]string{}
	}
	key := binary + "|" + table + "|" + chain
	if s.iptablesLoaded[key] {
		return s.iptablesNatRule[key]
	}
	s.iptablesLoaded[key] = true
	if binary == "ip6tables" && !commandExists("ip6tables") {
		return ""
	}
	args := []string{"-S", chain}
	if table != "" {
		args = append([]string{"-t", table}, args...)
	}
	raw, err := iptablesCommandOutput(binary, args...)
	if err != nil {
		return ""
	}
	s.iptablesNatRule[key] = string(raw)
	return s.iptablesNatRule[key]
}

func (s *kernelForwardSnapshot) nftForwardRulePresent(ruleID int, sourcePort int, targetIP string, targetPort int, protocol string) bool {
	text := s.nftTableText()
	if text == "" {
		return false
	}
	for _, proto := range runtimeProtocols(protocol) {
		if !nftDnatLinePresent(text, ruleID, proto, sourcePort, targetIP, targetPort) {
			return false
		}
	}
	return true
}

func (s *kernelForwardSnapshot) nftForwardRuleResiduePresent(ruleID int, sourcePort int, protocol string) bool {
	text := s.nftTableText()
	if text == "" {
		return false
	}
	marker := ""
	if ruleID > 0 {
		marker = "fwx-rule-" + strconv.Itoa(ruleID)
	}
	for _, rawLine := range strings.Split(text, "\n") {
		line := kernelNormalizeLine(rawLine)
		if line == "" {
			continue
		}
		if marker != "" && strings.Contains(line, marker) {
			return true
		}
		if strings.Contains(line, "dnat") {
			for _, proto := range runtimeProtocols(protocol) {
				if kernelLineHasProtoDport(line, proto, sourcePort) {
					return true
				}
			}
		}
	}
	return false
}

func nftDnatLinePresent(text string, ruleID int, proto string, sourcePort int, targetIP string, targetPort int) bool {
	marker := ""
	if ruleID > 0 {
		marker = "fwx-rule-" + strconv.Itoa(ruleID)
	}
	for _, rawLine := range strings.Split(text, "\n") {
		line := kernelNormalizeLine(rawLine)
		if line == "" || !strings.Contains(line, "dnat") || !kernelLineHasProtoDport(line, proto, sourcePort) {
			continue
		}
		if marker != "" && !strings.Contains(line, marker) && !kernelLineDnatTargetMatches(line, targetIP, targetPort) {
			continue
		}
		if !kernelLineDnatTargetMatches(line, targetIP, targetPort) {
			continue
		}
		return true
	}
	return false
}

func (s *kernelForwardSnapshot) iptablesForwardRulePresent(sourcePort int, targetIP string, targetPort int, protocol string) bool {
	target := kernelCleanAddress(targetIP)
	binary := iptablesAgentBinaryForTarget(target)
	for _, proto := range runtimeProtocols(protocol) {
		if !iptablesDnatLinePresent(s.iptablesNatPreroutingText(binary), proto, sourcePort, target, targetPort) {
			return false
		}
		// 只有 DNAT 没有 MASQUERADE / FORWARD 放行时流量同样不通：共享目标的规则被删、
		// 或用户防火墙脚本清掉了这两段，都要让就绪检查失败以触发重下发。
		// 目标不是 IP（尚未解析）时无法按目标匹配，保持只看 DNAT 的旧行为。
		if net.ParseIP(target) == nil || targetPort <= 0 {
			continue
		}
		if !iptablesTargetRuleLinePresent(s.iptablesChainText(binary, "nat", "POSTROUTING"), "POSTROUTING", "MASQUERADE", proto, target, targetPort) {
			return false
		}
		if !iptablesTargetRuleLinePresent(s.iptablesChainText(binary, "", "FORWARD"), "FORWARD", "ACCEPT", proto, target, targetPort) {
			return false
		}
	}
	return true
}

// iptablesTargetRuleLinePresent 在 `-S` 输出里找 `-A <chain> -d <target> -p <proto> --dport <port> ... -j <jump>`，
// 带不带 fwx-rule-<id> 注释都算（兼容旧 Agent/面板留下的无标记规则）。
func iptablesTargetRuleLinePresent(text string, chain string, jump string, proto string, targetIP string, targetPort int) bool {
	want := net.ParseIP(kernelCleanAddress(targetIP))
	if want == nil || targetPort <= 0 {
		return false
	}
	for _, rawLine := range strings.Split(text, "\n") {
		fields := strings.Fields(rawLine)
		if len(fields) < 2 || fields[0] != "-A" || fields[1] != chain {
			continue
		}
		var dest net.IP
		protoOK, portOK, jumpOK := false, false, false
		for i := 2; i+1 < len(fields); i++ {
			switch fields[i] {
			case "-d":
				addr := fields[i+1]
				if slash := strings.IndexByte(addr, '/'); slash >= 0 {
					if mask := addr[slash+1:]; mask != "32" && mask != "128" {
						continue
					}
					addr = addr[:slash]
				}
				dest = net.ParseIP(kernelCleanAddress(addr))
			case "-p":
				protoOK = strings.EqualFold(fields[i+1], proto)
			case "--dport":
				portOK = fields[i+1] == strconv.Itoa(targetPort)
			case "-j":
				jumpOK = fields[i+1] == jump
			}
		}
		if dest != nil && dest.Equal(want) && protoOK && portOK && jumpOK {
			return true
		}
	}
	return false
}

func (s *kernelForwardSnapshot) iptablesForwardRuleResiduePresent(sourcePort int, protocol string) bool {
	for _, binary := range iptablesAgentBinaries() {
		text := s.iptablesNatPreroutingText(binary)
		for _, rawLine := range strings.Split(text, "\n") {
			line := kernelNormalizeLine(rawLine)
			if line == "" || !strings.Contains(line, "-j DNAT") {
				continue
			}
			for _, proto := range runtimeProtocols(protocol) {
				if kernelLineHasProtoDport(line, proto, sourcePort) {
					return true
				}
			}
		}
	}
	return false
}

func iptablesDnatLinePresent(text string, proto string, sourcePort int, targetIP string, targetPort int) bool {
	for _, rawLine := range strings.Split(text, "\n") {
		line := kernelNormalizeLine(rawLine)
		if line == "" || !strings.Contains(line, "-j DNAT") || !kernelLineHasProtoDport(line, proto, sourcePort) {
			continue
		}
		if kernelLineDnatTargetMatches(line, targetIP, targetPort) {
			return true
		}
	}
	return false
}

func kernelNormalizeLine(line string) string {
	return strings.Join(strings.Fields(line), " ")
}

func kernelCleanAddress(value string) string {
	return strings.ToLower(strings.Trim(strings.TrimSpace(value), "[]"))
}

func kernelLineHasProtoDport(line string, proto string, port int) bool {
	if port <= 0 {
		return false
	}
	lineProto, linePort, ok := kernelLineDport(line)
	return ok && lineProto == strings.TrimSpace(proto) && linePort == port
}

func kernelLineDnatTargetMatches(line string, targetIP string, targetPort int) bool {
	target := kernelCleanAddress(targetIP)
	if target == "" || targetPort <= 0 || net.ParseIP(target) == nil {
		return true
	}
	lineTarget, linePort, ok := kernelLineDnatTarget(strings.ToLower(line))
	if ok == false {
		return false
	}
	return kernelCleanAddress(lineTarget) == target && linePort == targetPort
}

func kernelLineDport(line string) (string, int, bool) {
	for _, proto := range []string{"tcp", "udp"} {
		prefixes := []string{"--dport ", proto + " dport "}
		if !strings.Contains(line, "-p "+proto+" ") && !strings.Contains(line, "meta l4proto "+proto) && !strings.Contains(line, proto+" dport ") {
			continue
		}
		for _, prefix := range prefixes {
			idx := strings.Index(line, prefix)
			if idx < 0 {
				continue
			}
			rest := strings.TrimSpace(line[idx+len(prefix):])
			if rest == "" {
				continue
			}
			fields := strings.Fields(rest)
			if len(fields) == 0 {
				continue
			}
			portText := strings.Trim(fields[0], "[];,")
			port, err := strconv.Atoi(portText)
			if err == nil && port > 0 && port <= 65535 {
				return proto, port, true
			}
		}
	}
	return "", 0, false
}

func kernelLineRuleID(line string) int {
	match := regexp.MustCompile(`fwx-rule-([0-9]+)`).FindStringSubmatch(line)
	if len(match) < 2 {
		return 0
	}
	id, _ := strconv.Atoi(match[1])
	return id
}

func kernelLineDnatTarget(line string) (string, int, bool) {
	tail := line
	if idx := strings.Index(tail, "--to-destination "); idx >= 0 {
		tail = tail[idx+len("--to-destination "):]
	} else if idx := strings.Index(tail, " to "); idx >= 0 {
		tail = tail[idx+len(" to "):]
	} else {
		return "", 0, false
	}
	fields := strings.Fields(tail)
	if len(fields) == 0 {
		return "", 0, false
	}
	token := strings.Trim(fields[0], "\"'`;")
	if strings.HasPrefix(token, "[") {
		if end := strings.Index(token, "]"); end > 0 && len(token) > end+2 && token[end+1] == ':' {
			port, err := strconv.Atoi(strings.Trim(token[end+2:], "[];,"))
			if err == nil && port > 0 {
				return strings.Trim(token[1:end], "[]"), port, true
			}
		}
	}
	idx := strings.LastIndex(token, ":")
	if idx <= 0 || idx >= len(token)-1 {
		return strings.Trim(token, "[]"), 0, false
	}
	port, err := strconv.Atoi(strings.Trim(token[idx+1:], "[];,"))
	if err != nil || port <= 0 {
		return strings.Trim(token, "[]"), 0, false
	}
	return strings.Trim(token[:idx], "[]"), port, true
}

func (s *kernelForwardSnapshot) iptablesForwardxMarkerSeenForPort(port int) bool {
	if s == nil || port <= 0 {
		return false
	}
	if !s.iptablesMangleLoaded {
		s.iptablesMangleLoaded = true
		markerPattern := regexp.MustCompile(`fwx-stat-([0-9]+):`)
		for _, binary := range iptablesAgentBinaries() {
			if binary == "ip6tables" && !commandExists("ip6tables") {
				continue
			}
			raw, err := iptablesCommandOutput(binary, "-t", "mangle", "-S")
			if err != nil {
				continue
			}
			for _, match := range markerPattern.FindAllStringSubmatch(string(raw), -1) {
				if len(match) < 2 {
					continue
				}
				markerPort, err := strconv.Atoi(match[1])
				if err == nil && markerPort > 0 {
					s.iptablesForwardxMarkers[markerPort] = true
				}
			}
		}
	}
	return s.iptablesForwardxMarkers[port]
}
