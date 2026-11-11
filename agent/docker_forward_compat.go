package main

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// 内核转发（iptables / nftables）在装了 Docker 的入口机上的就绪核实与本地清理。
//
// Docker 把 FORWARD 默认策略改成 DROP，只跳进它自己的链。nftables 模式下 `inet forwardx` 表里的
// ACCEPT 盖不过同一 hook 上另一个基础链的 DROP；iptables 模式下 Agent 调的 `iptables` 和 Docker
// 用的未必是同一个前端（legacy / nft 规则互不相通，内核两套都求值）。面板因此在 DOCKER-USER 里给
// 每条 IPv4 规则装放行（server/dockerForwardCompat.ts），这里按同一份契约把内核状态读回来：
//
//	注释 fwx-docker-<规则>-<入口端口>-<协议>-<in|out>-<目标摘要>，
//	目标摘要 = sha1("<目标地址>:<目标端口>") 的前 8 位十六进制。
//
// 只认「FORWARD 默认 DROP 且跳转 DOCKER-USER」这一种结构；ufw、自定义防火墙、Docker 的 nftables
// 原生后端不判断、不修改。以前就绪检查只看 DNAT，DNAT 在、规则显示运行，外面连进来却全部超时。

const (
	dockerCompatChain      = "DOCKER-USER"
	kernelIPv4ForwardPath  = "/proc/sys/net/ipv4/ip_forward"
	kernelLegacyTablesPath = "/proc/net/ip_tables_names"
	// 比 iptables 自己的 -w 5 长：锁忙时看到的是 iptables 的报错，而不是被杀掉的进程（那看起来像链不存在）。
	dockerCompatCommandWait = 8 * time.Second
)

// kernelForwardEnv 替换快照对主机的读取；nil 读真主机，测试里注入一台描述出来的主机。
type kernelForwardEnv struct {
	readFile    func(path string) ([]byte, error)
	hasCommand  func(name string) bool
	runIptables func(binary string, args ...string) ([]byte, error)
	runRestore  func(binary string, input string) error
}

type dockerCompatFrontState struct {
	active       bool
	rules        []string
	rulesErr     error
	rulesMissing bool // 列不出来是因为链不存在
}

func (s *kernelForwardSnapshot) readHostFile(path string) ([]byte, error) {
	if s != nil && s.env != nil && s.env.readFile != nil {
		return s.env.readFile(path)
	}
	return os.ReadFile(path)
}

func (s *kernelForwardSnapshot) hasHostCommand(name string) bool {
	if s != nil && s.env != nil && s.env.hasCommand != nil {
		return s.env.hasCommand(name)
	}
	return commandExists(name)
}

// runHostIptables 跑一个指定前端（iptables-nft / iptables-legacy / iptables）的只读命令，带锁等待参数。
func (s *kernelForwardSnapshot) runHostIptables(binary string, args ...string) ([]byte, error) {
	if s != nil && s.env != nil && s.env.runIptables != nil {
		return s.env.runIptables(binary, args...)
	}
	full := append(iptablesWaitArgs(), args...)
	iptablesExecMu.Lock()
	defer iptablesExecMu.Unlock()
	return commandOutputWithTimeout(dockerCompatCommandWait, binary, full...)
}

// runHostRestore 用对应前端的 -restore 跑一个 `*filter ... COMMIT` 事务。按规则内容删、一次提交，
// Docker 或管理员同时改链也删不到别人的规则；按行号删就会。
func (s *kernelForwardSnapshot) runHostRestore(binary string, input string) error {
	if s != nil && s.env != nil && s.env.runRestore != nil {
		return s.env.runRestore(binary, input)
	}
	ctx, cancel := context.WithTimeout(context.Background(), dockerCompatCommandWait)
	defer cancel()
	iptablesExecMu.Lock()
	defer iptablesExecMu.Unlock()
	// iptables-restore 1.6.2 起才认 --wait，老版本退回不带等待的写法。
	var failure error
	for _, args := range [][]string{{"--noflush", "--wait", "5"}, {"--noflush"}} {
		command := exec.CommandContext(ctx, binary+"-restore", args...)
		command.Stdin = strings.NewReader(input)
		output, err := command.CombinedOutput()
		if err == nil {
			return nil
		}
		failure = fmt.Errorf("%s-restore: %w: %s", binary, err, strings.TrimSpace(string(output)))
	}
	return failure
}

// dockerCompatFrontEnds 列出内核在求值的 iptables 前端（和面板命令里的 fwx_dc_bins 同一个口径）：
// legacy 表只在已经加载时读（在纯 nft 的机器上列它会把内核模块拉起来）；连 FORWARD 都列不出来的
// 前端（OpenVZ / LXC 里没有 nf_tables 之类）不可能装着规则，跳过。
func (s *kernelForwardSnapshot) dockerCompatFrontEnds() []string {
	if s.dockerFrontEndsLoaded {
		return s.dockerFrontEnds
	}
	s.dockerFrontEndsLoaded = true
	if s.dockerFronts == nil {
		s.dockerFronts = map[string]*dockerCompatFrontState{}
	}
	fronts := []string{}
	for _, candidate := range []string{"iptables-nft", "iptables-legacy"} {
		if !s.hasHostCommand(candidate) {
			continue
		}
		if candidate == "iptables-legacy" && !s.legacyFilterTableLoaded() {
			continue
		}
		if s.loadDockerCompatFront(candidate) {
			fronts = append(fronts, candidate)
		}
	}
	if len(fronts) == 0 && s.hasHostCommand("iptables") && s.loadDockerCompatFront("iptables") {
		fronts = append(fronts, "iptables")
	}
	s.dockerFrontEnds = fronts
	return fronts
}

func (s *kernelForwardSnapshot) legacyFilterTableLoaded() bool {
	raw, err := s.readHostFile(kernelLegacyTablesPath)
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if strings.TrimSpace(line) == "filter" {
			return true
		}
	}
	return false
}

// loadDockerCompatFront 读一个前端的 FORWARD：列不出来返回 false（这个前端不算）。
// 「FORWARD 默认 DROP 且跳转 DOCKER-USER」才是放行要管的结构，顺带把 DOCKER-USER 列出来。
func (s *kernelForwardSnapshot) loadDockerCompatFront(binary string) bool {
	forward, err := s.runHostIptables(binary, "-S", "FORWARD")
	if err != nil {
		return false
	}
	state := &dockerCompatFrontState{}
	s.dockerFronts[binary] = state
	dropsByDefault, jumpsToDocker := false, false
	for _, rawLine := range strings.Split(string(forward), "\n") {
		line := kernelNormalizeLine(rawLine)
		if line == "-P FORWARD DROP" {
			dropsByDefault = true
		}
		if strings.HasPrefix(line, "-A FORWARD ") && strings.HasSuffix(line, " -j "+dockerCompatChain) {
			jumpsToDocker = true
		}
	}
	if dropsByDefault && jumpsToDocker {
		state.active = true
		state.rules, state.rulesMissing, state.rulesErr = s.dockerCompatListing(binary)
	}
	return true
}

func (s *kernelForwardSnapshot) dockerCompatFront(binary string) *dockerCompatFrontState {
	s.dockerCompatFrontEnds()
	if state := s.dockerFronts[binary]; state != nil {
		return state
	}
	return &dockerCompatFrontState{}
}

// dockerCompatListing 列一个前端的 DOCKER-USER。missing 为 true 表示链不存在；其他错误表示读不出来。
func (s *kernelForwardSnapshot) dockerCompatListing(binary string) (lines []string, missing bool, err error) {
	raw, err := s.runHostIptables(binary, "-S", dockerCompatChain)
	if err != nil {
		// 各版本对「链不存在」的措辞不一样，所以问整张表：列得出来且没有这条链才算真没有；
		// xtables 锁忙之类的失败不是「没有」。
		table, tableErr := s.runHostIptables(binary, "-S")
		if tableErr != nil {
			return nil, false, err
		}
		for _, line := range strings.Split(string(table), "\n") {
			if kernelNormalizeLine(line) == "-N "+dockerCompatChain {
				return nil, false, err
			}
		}
		return nil, true, err
	}
	for _, rawLine := range strings.Split(string(raw), "\n") {
		if line := kernelNormalizeLine(rawLine); strings.HasPrefix(line, "-A "+dockerCompatChain+" ") {
			lines = append(lines, line)
		}
	}
	return lines, false, nil
}

type dockerCompatSpec struct {
	proto      string
	direction  string
	comment    string
	targetIP   string
	targetPort int
	sourcePort int
}

func dockerCompatTargetTag(targetIP string, targetPort int) string {
	digest := sha1.Sum([]byte(fmt.Sprintf("%s:%d", targetIP, targetPort)))
	return hex.EncodeToString(digest[:])[:8]
}

func dockerCompatSpecsFor(ruleID int, sourcePort int, targetIP string, targetPort int, protocol string) []dockerCompatSpec {
	target := net.ParseIP(kernelCleanAddress(targetIP))
	if target == nil || target.To4() == nil || targetPort <= 0 || targetPort > 65535 || sourcePort <= 0 || sourcePort > 65535 {
		return nil
	}
	specs := []dockerCompatSpec{}
	tag := dockerCompatTargetTag(target.String(), targetPort)
	for _, proto := range runtimeProtocols(protocol) {
		for _, direction := range []string{"in", "out"} {
			specs = append(specs, dockerCompatSpec{
				proto:      proto,
				direction:  direction,
				comment:    fmt.Sprintf("fwx-docker-%d-%d-%s-%s-%s", ruleID, sourcePort, proto, direction, tag),
				targetIP:   target.String(),
				targetPort: targetPort,
				sourcePort: sourcePort,
			})
		}
	}
	return specs
}

// matches 拿 iptables 打印回来的那一行和要求比：别的目标 / 端口的旧放行、同名但动作不同的规则都不算。
func (spec dockerCompatSpec) matches(line string) bool {
	fields := strings.Fields(line)
	if len(fields) < 3 || fields[0] != "-A" || fields[1] != dockerCompatChain {
		return false
	}
	has := func(flag string, values ...string) bool {
		for index := 0; index+1 < len(fields); index++ {
			if fields[index] != flag {
				continue
			}
			for _, value := range values {
				if fields[index+1] == value {
					return true
				}
			}
		}
		return false
	}
	address := func(flag string) bool { return has(flag, spec.targetIP, spec.targetIP+"/32") }
	if !has("--comment", spec.comment, `"`+spec.comment+`"`) || !has("-j", "ACCEPT") || !has("-p", spec.proto) ||
		!has("--ctorigdstport", strconv.Itoa(spec.sourcePort)) {
		return false
	}
	if spec.direction == "in" {
		return address("-d") && has("--dport", strconv.Itoa(spec.targetPort))
	}
	if !address("-s") || !has("--sport", strconv.Itoa(spec.targetPort)) || !has("--ctdir", "REPLY") {
		return false
	}
	for index := 0; index+1 < len(fields); index++ {
		if fields[index] == "--ctstate" {
			states := strings.Split(fields[index+1], ",")
			return dockerCompatContains(states, "ESTABLISHED") && dockerCompatContains(states, "RELATED")
		}
	}
	return false
}

func dockerCompatContains(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

// dockerCompatMissingReason 说明缺了哪条必需的放行；需要放行的前端都齐了返回 ""。
func (s *kernelForwardSnapshot) dockerCompatMissingReason(ruleID int, sourcePort int, targetIP string, targetPort int, protocol string) string {
	specs := dockerCompatSpecsFor(ruleID, sourcePort, targetIP, targetPort, protocol)
	if len(specs) == 0 {
		return ""
	}
	for _, binary := range s.dockerCompatFrontEnds() {
		state := s.dockerCompatFront(binary)
		if !state.active {
			continue
		}
		if state.rulesErr != nil {
			return fmt.Sprintf("%s: cannot read %s: %v", binary, dockerCompatChain, state.rulesErr)
		}
		for _, spec := range specs {
			found := false
			for _, line := range state.rules {
				if spec.matches(line) {
					found = true
					break
				}
			}
			if !found {
				return fmt.Sprintf("%s: %s allowance missing for %d/%s (%s); Docker's default-DROP FORWARD drops this traffic", binary, dockerCompatChain, sourcePort, spec.proto, spec.direction)
			}
		}
	}
	return ""
}

// dockerCompatStaleReason 报出当前规格不再需要的放行：这条规则给别的目标 / 端口 / 协议留下的，
// 或者别的规则在这条规则现在占用的端口 + 协议上留下的。它们让一条已经退役的路径还开着，算没收敛。
func (s *kernelForwardSnapshot) dockerCompatStaleReason(ruleID int, sourcePort int, targetIP string, targetPort int, protocol string) string {
	wanted := dockerCompatSpecsFor(ruleID, sourcePort, targetIP, targetPort, protocol)
	protocols := runtimeProtocols(protocol)
	for _, binary := range s.dockerCompatFrontEnds() {
		state := s.dockerCompatFront(binary)
		if !state.active || state.rulesErr != nil {
			continue
		}
		for _, line := range state.rules {
			commentRule, commentPort, commentProto, ok := dockerCompatLineOwner(line)
			if !ok {
				continue
			}
			ownedByRule := ruleID > 0 && commentRule == ruleID
			conflictingOwner := sourcePort > 0 && commentPort == sourcePort && commentRule != ruleID && dockerCompatContains(protocols, commentProto)
			if !ownedByRule && !conflictingOwner {
				continue
			}
			matched := false
			for _, spec := range wanted {
				if spec.matches(line) {
					matched = true
					break
				}
			}
			if !matched {
				return fmt.Sprintf("%s: a stale %s allowance remains: %s", binary, dockerCompatChain, line)
			}
		}
	}
	return ""
}

// dockerCompatResidue：删除还没完成 —— 某个前端里还有这条规则或这个端口名下的放行，
// 或者一个把流量送进 DOCKER-USER 的前端读不出这条链（删没删掉确认不了）。
func (s *kernelForwardSnapshot) dockerCompatResidue(ruleID int, sourcePort int, protocol string) bool {
	protocols := runtimeProtocols(protocol)
	for _, binary := range s.dockerCompatFrontEnds() {
		var lines []string
		var err error
		if state := s.dockerCompatFront(binary); state.active {
			lines, err = state.rules, state.rulesErr
			if err != nil && !state.rulesMissing {
				return true
			}
		} else if lines, _, err = s.dockerCompatListing(binary); err != nil {
			continue
		}
		for _, line := range lines {
			if dockerCompatLineOwnedBy(line, ruleID, sourcePort, protocols) {
				return true
			}
		}
	}
	return false
}

// dockerCompatLineOwner 从 ForwardX 装的放行的注释里取出规则、端口、协议；DOCKER-USER 里别的规则没有这种注释。
func dockerCompatLineOwner(line string) (ruleID int, sourcePort int, proto string, ok bool) {
	if !strings.HasPrefix(line, "-A "+dockerCompatChain+" ") {
		return 0, 0, "", false
	}
	for _, field := range strings.Fields(line) {
		comment := strings.Trim(field, `"`)
		if !strings.HasPrefix(comment, "fwx-docker-") {
			continue
		}
		parts := strings.Split(strings.TrimPrefix(comment, "fwx-docker-"), "-")
		if len(parts) != 5 || (parts[2] != "tcp" && parts[2] != "udp") {
			continue
		}
		ruleID, ruleErr := strconv.Atoi(parts[0])
		sourcePort, portErr := strconv.Atoi(parts[1])
		if ruleErr == nil && portErr == nil {
			return ruleID, sourcePort, parts[2], true
		}
	}
	return 0, 0, "", false
}

func dockerCompatLineOwnedBy(line string, ruleID int, sourcePort int, protocols []string) bool {
	commentRule, commentPort, commentProto, ok := dockerCompatLineOwner(line)
	if !ok {
		return false
	}
	return (ruleID > 0 && commentRule == ruleID) ||
		(sourcePort > 0 && commentPort == sourcePort && dockerCompatContains(protocols, commentProto))
}

// cleanupDockerCompatAllowances 删掉一个规则编号（它用过的所有端口和协议）以及一个端口（按给的协议）
// 名下的 DOCKER-USER 放行。面板的清理命令在 shell 里做同样的事；这里给 Agent 自己发起、没有面板命令的
// 本地清理用（例如收掉面板已经不列的本地规则）。有放行删不掉或链读不出来时返回 false。
func cleanupDockerCompatAllowances(ruleID int, sourcePort int, protocols []string) bool {
	return newKernelForwardSnapshot().cleanupDockerCompatAllowances(ruleID, sourcePort, protocols)
}

func (s *kernelForwardSnapshot) cleanupDockerCompatAllowances(ruleID int, sourcePort int, protocols []string) bool {
	if ruleID <= 0 && sourcePort <= 0 {
		return true
	}
	ok := true
	for _, binary := range s.dockerCompatFrontEnds() {
		for round := 0; ; round++ {
			lines, missing, err := s.dockerCompatListing(binary)
			if err != nil {
				if !missing {
					logf("docker-compat: cannot read %s via %s, removal of rule=%d port=%d is unconfirmed: %v", dockerCompatChain, binary, ruleID, sourcePort, err)
					ok = false
				}
				break
			}
			deletions := []string{}
			for _, line := range lines {
				if dockerCompatLineOwnedBy(line, ruleID, sourcePort, protocols) {
					deletions = append(deletions, "-D "+strings.TrimPrefix(line, "-A "))
				}
			}
			if len(deletions) == 0 {
				break
			}
			if round >= 5 {
				logf("docker-compat: could not remove %d allowance(s) of rule=%d port=%d from %s via %s", len(deletions), ruleID, sourcePort, dockerCompatChain, binary)
				ok = false
				break
			}
			if err := s.runHostRestore(binary, "*filter\n"+strings.Join(deletions, "\n")+"\nCOMMIT\n"); err != nil {
				logf("docker-compat: removal transaction failed via %s: %v", binary, err)
			}
		}
	}
	return ok
}

// nftChainLines 取 `nft -a list table` 里某条链的规则行。
func nftChainLines(text string, chain string) []string {
	lines := []string{}
	inChain := false
	for _, rawLine := range strings.Split(text, "\n") {
		line := kernelNormalizeLine(rawLine)
		switch {
		case strings.HasPrefix(line, "chain "+chain+" {"):
			inChain = true
		case inChain && line == "}":
			return lines
		case inChain && line != "" && !strings.HasPrefix(line, "type "):
			lines = append(lines, line)
		}
	}
	return lines
}

// nftLineOwnedByRule：这一行带不带这条规则的注释（fwx-rule-<id>、fwx-rule-<id>-in|out、兜底的 fwx-rule-<id>:…）。
func nftLineOwnedByRule(line string, ruleID int) bool {
	if ruleID <= 0 {
		return false
	}
	for _, suffix := range []string{`"`, `-`, `:`} {
		if strings.Contains(line, fmt.Sprintf(`comment "fwx-rule-%d%s`, ruleID, suffix)) {
			return true
		}
	}
	return false
}

// nftStaleProtocolReason：这条规则已经不要的那种协议还留着 ForwardX 的规则（改过协议没收干净）。
func nftStaleProtocolReason(text string, ruleID int, protocol string) string {
	if ruleID <= 0 {
		return ""
	}
	for _, proto := range []string{"tcp", "udp"} {
		if dockerCompatContains(runtimeProtocols(protocol), proto) {
			continue
		}
		for _, chain := range []string{"prerouting", "forward"} {
			for _, line := range nftChainLines(text, chain) {
				if nftLineOwnedByRule(line, ruleID) && (strings.Contains(line, " "+proto+" dport ") || strings.Contains(line, " "+proto+" sport ")) {
					return fmt.Sprintf("a stale %s rule of rule %d remains in the %s chain", proto, ruleID, chain)
				}
			}
		}
	}
	return ""
}

func (s *kernelForwardSnapshot) ipv4ForwardingEnabled() bool {
	raw, err := s.readHostFile(kernelIPv4ForwardPath)
	return err == nil && strings.TrimSpace(string(raw)) == "1"
}

func nftMasqueradePresent(text string, ruleID int, targetIP string, targetPort int, protocol string) bool {
	lines := nftChainLines(text, "postrouting")
	for _, line := range lines {
		if strings.Contains(line, "masquerade") && strings.Contains(line, "ct status dnat") {
			return true
		}
	}
	for _, proto := range runtimeProtocols(protocol) {
		found := false
		for _, line := range lines {
			if !strings.Contains(line, "masquerade") {
				continue
			}
			if (ruleID > 0 && strings.Contains(line, fmt.Sprintf("fwx-rule-%d-masquerade-%s", ruleID, proto))) ||
				(strings.Contains(line, "ip daddr "+targetIP+" ") && strings.Contains(line, fmt.Sprintf("%s dport %d ", proto, targetPort))) {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

func nftForwardAcceptPresent(text string, addressKey string, portKey string, proto string, targetIP string, targetPort int) bool {
	for _, line := range nftChainLines(text, "forward") {
		fields := strings.Fields(line)
		accepts, addressMatches, portMatches := false, false, false
		for index, field := range fields {
			switch {
			case field == "accept":
				accepts = true
			case field == "ip" && index+2 < len(fields) && fields[index+1] == addressKey && fields[index+2] == targetIP:
				addressMatches = true
			case field == proto && index+2 < len(fields) && fields[index+1] == portKey && fields[index+2] == strconv.Itoa(targetPort):
				// 端口要整词相等："443" 不能匹配到 "4430"。
				portMatches = true
			}
		}
		if accepts && addressMatches && portMatches {
			return true
		}
	}
	return false
}

// nftForwardRuleNotReadyReason 说明一条 nftables 规则现在为什么转发不了；本机能核实的条件都满足时返回 ""。
// 只看本机配置：目标挂了、外面网络不通都不会让一台配置正确的入口变成「没就绪」。
func (s *kernelForwardSnapshot) nftForwardRuleNotReadyReason(ruleID int, sourcePort int, targetIP string, targetPort int, protocol string) string {
	text := s.nftTableText()
	if text == "" {
		return "the forwardx nftables table is missing"
	}
	for _, proto := range runtimeProtocols(protocol) {
		if !nftDnatLinePresent(text, ruleID, proto, sourcePort, targetIP, targetPort) {
			return fmt.Sprintf("the %s DNAT rule for port %d is missing", proto, sourcePort)
		}
	}
	target := net.ParseIP(kernelCleanAddress(targetIP))
	if target == nil || target.To4() == nil {
		// IPv6 和还没解析的目标保持原来「只看 DNAT」的含义。
		return ""
	}
	if !s.ipv4ForwardingEnabled() {
		return "net.ipv4.ip_forward is not enabled"
	}
	if !nftMasqueradePresent(text, ruleID, target.String(), targetPort, protocol) {
		return "the source address translation (masquerade) rule is missing"
	}
	for _, proto := range runtimeProtocols(protocol) {
		if !nftForwardAcceptPresent(text, "daddr", "dport", proto, target.String(), targetPort) {
			return fmt.Sprintf("the %s forward accept for %s:%d is missing", proto, target.String(), targetPort)
		}
		if !nftForwardAcceptPresent(text, "saddr", "sport", proto, target.String(), targetPort) {
			return fmt.Sprintf("the %s return accept for %s:%d is missing", proto, target.String(), targetPort)
		}
	}
	if reason := nftStaleProtocolReason(text, ruleID, protocol); reason != "" {
		return reason
	}
	if reason := s.dockerCompatMissingReason(ruleID, sourcePort, target.String(), targetPort, protocol); reason != "" {
		return reason
	}
	return s.dockerCompatStaleReason(ruleID, sourcePort, target.String(), targetPort, protocol)
}

// iptablesForwardRuleNotReadyReason：iptables 规则的同一套核实。以前已经看 DNAT + MASQUERADE + 去程放行，
// 这里补上回程放行、IPv4 转发开关和 Docker 放行。
func (s *kernelForwardSnapshot) iptablesForwardRuleNotReadyReason(ruleID int, sourcePort int, targetIP string, targetPort int, protocol string) string {
	target := kernelCleanAddress(targetIP)
	binary := iptablesAgentBinaryForTarget(target)
	parsed := net.ParseIP(target)
	for _, proto := range runtimeProtocols(protocol) {
		if !iptablesDnatLinePresent(s.iptablesNatPreroutingText(binary), proto, sourcePort, target, targetPort) {
			return fmt.Sprintf("the %s DNAT rule for port %d is missing", proto, sourcePort)
		}
		// 只有 DNAT 没有 MASQUERADE / FORWARD 放行时流量同样不通：共享目标的规则被删、
		// 或用户防火墙脚本清掉了这几段，都要让就绪检查失败以触发重下发。
		// 目标不是 IP（尚未解析）时无法按目标匹配，保持只看 DNAT 的旧行为。
		if parsed == nil || targetPort <= 0 {
			continue
		}
		if !iptablesTargetRuleLinePresent(s.iptablesChainText(binary, "nat", "POSTROUTING"), "POSTROUTING", "MASQUERADE", proto, target, targetPort) {
			return "the source address translation (MASQUERADE) rule is missing"
		}
		forward := s.iptablesChainText(binary, "", "FORWARD")
		if !iptablesTargetRuleLinePresent(forward, "FORWARD", "ACCEPT", proto, target, targetPort) {
			return fmt.Sprintf("the %s FORWARD accept for %s:%d is missing", proto, target, targetPort)
		}
		if !iptablesTargetReturnLinePresent(forward, proto, target, targetPort) {
			return fmt.Sprintf("the %s FORWARD return accept for %s:%d is missing", proto, target, targetPort)
		}
	}
	if parsed == nil || parsed.To4() == nil || targetPort <= 0 {
		return ""
	}
	if !s.ipv4ForwardingEnabled() {
		return "net.ipv4.ip_forward is not enabled"
	}
	if reason := s.dockerCompatMissingReason(ruleID, sourcePort, parsed.String(), targetPort, protocol); reason != "" {
		return reason
	}
	return s.dockerCompatStaleReason(ruleID, sourcePort, parsed.String(), targetPort, protocol)
}

// kernelForwardFailureDetail 从内核转发动作的 shell 输出里挑出给人看的那一句：有 [docker-compat] 就从它开始，
// 不然用整段输出的尾巴（runShellBatchWithOutput 已经截短过）。
func kernelForwardFailureDetail(output string) string {
	output = strings.TrimSpace(output)
	if index := strings.Index(output, "[docker-compat]"); index >= 0 {
		output = output[index:]
	}
	const maxRunes = 240
	if runes := []rune(output); len(runes) > maxRunes {
		output = string(runes[:maxRunes-3]) + "..."
	}
	return output
}
