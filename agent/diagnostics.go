package main

// 一键链路诊断（2.2.225 起），面板那头见 server/diagnosticsAgentTasks.ts 和 server/linkDiagnostics.ts。
//
// 面板给涉及的每台主机排一个 diagnostics 任务，跟着心跳的 diagnosticsTasks 下来。任务里是这台
// 主机要做的几项检查，这里并发跑完（整包最多 30 秒），一次 POST /api/agent/diagnostics-result 回去。
//
// 每一项自己给出 pass / warn / fail / skip 和一句结论，原始细节放 detail。判不准的一律给 warn
// 而不是 fail（例如防火墙：看得到 DROP 策略，但规则可能在别的链上放行了），面板把 fail 当作
// 「最可能的原因」，冤枉一个没问题的环节比漏报更误导人。
//
// 所有对系统的调用都走 diagnosticsEnv，测试里换成假的（diagnostics_test.go）。

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	diagnosticsMaxTaskDuration  = 30 * time.Second
	diagnosticsDefaultTimeout   = 25 * time.Second
	diagnosticsCheckConcurrency = 8
	diagnosticsMaxConcurrent    = 3
	diagnosticsDialTimeout      = 3 * time.Second
	diagnosticsDNSTimeout       = 5 * time.Second
	diagnosticsCommandTimeout   = 5 * time.Second
	diagnosticsDetailMax        = 3500
)

type diagnosticsCheck struct {
	ID          string `json:"id"`
	Kind        string `json:"kind"`
	Port        int    `json:"port,omitempty"`
	Protocol    string `json:"protocol,omitempty"`
	Host        string `json:"host,omitempty"`
	PublicIP    string `json:"publicIp,omitempty"`
	ForwardType string `json:"forwardType,omitempty"`
	TunnelID    int    `json:"tunnelId,omitempty"`
}

type diagnosticsTask struct {
	TaskID    string             `json:"taskId"`
	Checks    []diagnosticsCheck `json:"checks"`
	TimeoutMs int                `json:"timeoutMs"`
	CreatedAt string             `json:"createdAt"`
}

type diagnosticsCheckResult struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	Status    string `json:"status"`
	Summary   string `json:"summary"`
	Detail    string `json:"detail,omitempty"`
	LatencyMs *int   `json:"latencyMs,omitempty"`
}

type diagnosticsResult struct {
	TaskID     string                   `json:"taskId"`
	Results    []diagnosticsCheckResult `json:"results"`
	DurationMs int                      `json:"durationMs"`
	StartedAt  string                   `json:"startedAt"`
	FinishedAt string                   `json:"finishedAt"`
	Error      string                   `json:"error,omitempty"`
}

// diagnosticsEnv 收拢对系统的调用。
type diagnosticsEnv struct {
	readFile      func(path string) ([]byte, error)
	dial          func(ctx context.Context, network, address string) (net.Conn, error)
	lookupIP      func(ctx context.Context, network, host string) ([]net.IP, error)
	run           func(ctx context.Context, name string, args ...string) (string, error)
	hasCommand    func(name string) bool
	serviceActive func(name string) (active bool, supported bool)
	fxpAlive      func(tunnelID int) (alive bool, detail string)
	firewallGuard func() (active bool, backend string)
	now           func() time.Time
}

func defaultDiagnosticsEnv() diagnosticsEnv {
	dialer := &net.Dialer{}
	return diagnosticsEnv{
		readFile: os.ReadFile,
		dial:     dialer.DialContext,
		lookupIP: net.DefaultResolver.LookupIP,
		run: func(ctx context.Context, name string, args ...string) (string, error) {
			timeout := diagnosticsCommandTimeout
			if deadline, ok := ctx.Deadline(); ok {
				if remaining := time.Until(deadline); remaining < timeout {
					timeout = remaining
				}
			}
			if timeout <= 0 {
				return "", context.DeadlineExceeded
			}
			out, err := commandCombinedOutputWithTimeout(timeout, name, args...)
			return string(out), err
		},
		hasCommand: commandExists,
		serviceActive: func(name string) (bool, bool) {
			name = sanitizeServiceName(name)
			if name == "" {
				return false, true
			}
			if isSystemdHost() {
				_, err := commandCombinedOutputWithTimeout(diagnosticsCommandTimeout, "systemctl", "is-active", "--quiet", name+".service")
				return err == nil, true
			}
			if commandExists("rc-service") {
				_, err := commandCombinedOutputWithTimeout(diagnosticsCommandTimeout, "rc-service", name, "status")
				return err == nil, true
			}
			return false, false
		},
		fxpAlive:      diagnosticsFXPAlive,
		firewallGuard: diagnosticsFirewallGuardState,
		now:           time.Now,
	}
}

var diagnosticsInFlightMu sync.Mutex
var diagnosticsInFlight = map[string]bool{}
var diagnosticsSlots = make(chan struct{}, diagnosticsMaxConcurrent)

func handleDiagnosticsTask(cfg Config, task diagnosticsTask) {
	if strings.TrimSpace(task.TaskID) == "" {
		return
	}
	diagnosticsInFlightMu.Lock()
	if diagnosticsInFlight[task.TaskID] {
		diagnosticsInFlightMu.Unlock()
		return
	}
	diagnosticsInFlight[task.TaskID] = true
	diagnosticsInFlightMu.Unlock()
	defer func() {
		diagnosticsInFlightMu.Lock()
		delete(diagnosticsInFlight, task.TaskID)
		diagnosticsInFlightMu.Unlock()
	}()
	diagnosticsSlots <- struct{}{}
	result := runDiagnosticsTask(defaultDiagnosticsEnv(), task)
	<-diagnosticsSlots
	if err := post(cfg, "/api/agent/diagnostics-result", map[string]any{"result": result}, &map[string]any{}); err != nil {
		if isTransientAgentCommError(err) {
			logAgentCommError("diagnostics-result", err)
		} else {
			logf("diagnostics result report failed task=%s: %v", task.TaskID, err)
		}
	}
}

func diagnosticsTaskTimeout(task diagnosticsTask) time.Duration {
	timeout := time.Duration(task.TimeoutMs) * time.Millisecond
	if timeout <= 0 {
		timeout = diagnosticsDefaultTimeout
	}
	if timeout > diagnosticsMaxTaskDuration {
		timeout = diagnosticsMaxTaskDuration
	}
	return timeout
}

// runDiagnosticsTask 并发跑完所有检查；到总时限还没跑完的那几项记成「超时」，不等它们。
func runDiagnosticsTask(env diagnosticsEnv, task diagnosticsTask) diagnosticsResult {
	started := env.now()
	ctx, cancel := context.WithTimeout(context.Background(), diagnosticsTaskTimeout(task))
	defer cancel()
	checks := task.Checks
	if len(checks) > 64 {
		checks = checks[:64]
	}
	var mu sync.Mutex
	results := make([]diagnosticsCheckResult, len(checks))
	filled := make([]bool, len(checks))
	var wg sync.WaitGroup
	slots := make(chan struct{}, diagnosticsCheckConcurrency)
	for index, check := range checks {
		wg.Add(1)
		go func(index int, check diagnosticsCheck) {
			defer wg.Done()
			select {
			case slots <- struct{}{}:
			case <-ctx.Done():
				return
			}
			defer func() { <-slots }()
			result := runDiagnosticsCheck(ctx, env, check)
			mu.Lock()
			if !filled[index] {
				results[index] = result
				filled[index] = true
			}
			mu.Unlock()
		}(index, check)
	}
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-ctx.Done():
	}
	mu.Lock()
	for index, check := range checks {
		if !filled[index] {
			results[index] = diagnosticsCheckResult{ID: check.ID, Kind: check.Kind, Status: "warn", Summary: "检查超时，没在时限内做完"}
			filled[index] = true
		}
	}
	out := append([]diagnosticsCheckResult(nil), results...)
	mu.Unlock()
	finished := env.now()
	return diagnosticsResult{
		TaskID:     task.TaskID,
		Results:    out,
		DurationMs: int(finished.Sub(started) / time.Millisecond),
		StartedAt:  started.UTC().Format(time.RFC3339Nano),
		FinishedAt: finished.UTC().Format(time.RFC3339Nano),
	}
}

func runDiagnosticsCheck(ctx context.Context, env diagnosticsEnv, check diagnosticsCheck) (result diagnosticsCheckResult) {
	defer func() {
		if r := recover(); r != nil {
			result = diagnosticsCheckResult{Status: "warn", Summary: fmt.Sprintf("检查出错：%v", r)}
		}
		result.ID = check.ID
		result.Kind = check.Kind
		if len(result.Detail) > diagnosticsDetailMax {
			result.Detail = result.Detail[:diagnosticsDetailMax] + "\n…（已截断）"
		}
	}()
	switch check.Kind {
	case "listen":
		return diagnosticsCheckListen(ctx, env, check)
	case "nat":
		return diagnosticsCheckNAT(ctx, env, check)
	case "firewall":
		return diagnosticsCheckFirewall(ctx, env, check)
	case "loopback":
		return diagnosticsCheckLoopback(ctx, env, check)
	case "dns":
		return diagnosticsCheckDNS(ctx, env, check)
	case "dial":
		return diagnosticsCheckDial(ctx, env, check)
	case "process":
		return diagnosticsCheckProcess(env, check)
	default:
		return diagnosticsCheckResult{Status: "skip", Summary: "这个版本的 Agent 不认识这项检查：" + check.Kind}
	}
}

/* ───────────────────────── /proc/net 解析 ───────────────────────── */

type procNetSocket struct {
	Proto string // tcp / udp
	IP    net.IP
	Port  int
}

func (s procNetSocket) String() string {
	return net.JoinHostPort(s.IP.String(), strconv.Itoa(s.Port)) + "/" + s.Proto
}

// decodeProcNetAddress 解析 /proc/net/{tcp,udp}[6] 里的「本地地址:端口」。地址按主机字节序
// 每 4 字节一组（x86/arm 都是小端），所以每组要倒过来读。
func decodeProcNetAddress(text string) (net.IP, int, error) {
	parts := strings.Split(strings.TrimSpace(text), ":")
	if len(parts) != 2 {
		return nil, 0, fmt.Errorf("bad address %q", text)
	}
	raw, err := hex.DecodeString(parts[0])
	if err != nil || (len(raw) != 4 && len(raw) != 16) {
		return nil, 0, fmt.Errorf("bad ip %q", parts[0])
	}
	ip := make(net.IP, len(raw))
	for word := 0; word < len(raw); word += 4 {
		for i := 0; i < 4; i++ {
			ip[word+i] = raw[word+3-i]
		}
	}
	port, err := strconv.ParseUint(parts[1], 16, 16)
	if err != nil {
		return nil, 0, fmt.Errorf("bad port %q", parts[1])
	}
	return ip, int(port), nil
}

// parseProcNetListeners 从 /proc/net/tcp(6) 取 LISTEN（0A）的套接字，从 udp(6) 取没 connect
// 的（对端是 0:0）—— UDP 服务端都是这种。
func parseProcNetListeners(content string, proto string) []procNetSocket {
	var out []procNetSocket
	for index, line := range strings.Split(content, "\n") {
		if index == 0 {
			continue // 表头
		}
		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}
		ip, port, err := decodeProcNetAddress(fields[1])
		if err != nil || port <= 0 {
			continue
		}
		state := strings.ToUpper(fields[3])
		if proto == "tcp" {
			if state != "0A" {
				continue
			}
		} else {
			_, remotePort, err := decodeProcNetAddress(fields[2])
			if err != nil || remotePort != 0 {
				continue
			}
		}
		out = append(out, procNetSocket{Proto: proto, IP: ip, Port: port})
	}
	return out
}

// diagnosticsListeners 读本机所有监听；ok=false 表示 /proc/net 一个都读不到（不是 Linux）。
func diagnosticsListeners(env diagnosticsEnv) ([]procNetSocket, bool) {
	var all []procNetSocket
	readAny := false
	for _, entry := range []struct{ path, proto string }{
		{"/proc/net/tcp", "tcp"}, {"/proc/net/tcp6", "tcp"}, {"/proc/net/udp", "udp"}, {"/proc/net/udp6", "udp"},
	} {
		raw, err := env.readFile(entry.path)
		if err != nil {
			continue
		}
		readAny = true
		all = append(all, parseProcNetListeners(string(raw), entry.proto)...)
	}
	return all, readAny
}

func listenersOnPort(all []procNetSocket, port int, proto string) []procNetSocket {
	var out []procNetSocket
	seen := map[string]bool{}
	for _, socket := range all {
		if socket.Port != port || (proto != "" && socket.Proto != proto) {
			continue
		}
		key := socket.String()
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, socket)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].String() < out[j].String() })
	return out
}

func socketListText(list []procNetSocket) string {
	parts := make([]string, 0, len(list))
	for _, socket := range list {
		parts = append(parts, socket.String())
	}
	return strings.Join(parts, ", ")
}

/* ───────────────────────── 各项检查 ───────────────────────── */

func diagnosticsCheckListen(ctx context.Context, env diagnosticsEnv, check diagnosticsCheck) diagnosticsCheckResult {
	if check.Port <= 0 {
		return diagnosticsCheckResult{Status: "skip", Summary: "没有端口"}
	}
	all, ok := diagnosticsListeners(env)
	if !ok {
		return diagnosticsCheckResult{Status: "skip", Summary: "读不到 /proc/net，没法检查监听"}
	}
	tcp := listenersOnPort(all, check.Port, "tcp")
	udp := listenersOnPort(all, check.Port, "udp")
	detail := diagnosticsSSDetail(ctx, env, check.Port)
	var missing []string
	protocol := strings.ToLower(strings.TrimSpace(check.Protocol))
	switch protocol {
	case "any":
		if len(tcp)+len(udp) == 0 {
			missing = append(missing, "tcp/udp")
		}
	case "udp":
		if len(udp) == 0 {
			missing = append(missing, "udp")
		}
	case "both":
		if len(tcp) == 0 {
			missing = append(missing, "tcp")
		}
		if len(udp) == 0 {
			missing = append(missing, "udp")
		}
	default:
		if len(tcp) == 0 {
			missing = append(missing, "tcp")
		}
	}
	found := append(append([]procNetSocket{}, tcp...), udp...)
	if len(missing) > 0 {
		summary := fmt.Sprintf("没有程序在听 %s 端口 %d", strings.Join(missing, "+"), check.Port)
		if len(found) > 0 {
			summary += "（只有 " + socketListText(found) + "）"
		}
		return diagnosticsCheckResult{Status: "fail", Summary: summary, Detail: detail}
	}
	return diagnosticsCheckResult{Status: "pass", Summary: "在听：" + socketListText(found), Detail: detail}
}

func diagnosticsSSDetail(ctx context.Context, env diagnosticsEnv, port int) string {
	if !env.hasCommand("ss") {
		return ""
	}
	out, err := env.run(ctx, "ss", "-H", "-ltnup", "sport = :"+strconv.Itoa(port))
	if err != nil && strings.TrimSpace(out) == "" {
		return ""
	}
	return strings.TrimSpace("ss -ltnup sport = :" + strconv.Itoa(port) + "\n" + strings.TrimSpace(out))
}

// diagnosticsDportPattern 匹配 nft 的「dport 443」「dport { 80, 443 }」和 iptables 的「--dport 443」。
func diagnosticsDportPattern(port int) *regexp.Regexp {
	p := strconv.Itoa(port)
	return regexp.MustCompile(`(?:--dports?|dport)\s+(?:` + p + `\b|\{[^}]*\b` + p + `\b[^}]*\}|[0-9,:]*\b` + p + `\b)`)
}

func matchingLines(text string, pattern *regexp.Regexp, limit int) []string {
	var out []string
	for _, line := range strings.Split(text, "\n") {
		if pattern.MatchString(line) {
			out = append(out, strings.TrimSpace(line))
			if len(out) >= limit {
				break
			}
		}
	}
	return out
}

func diagnosticsCheckNAT(ctx context.Context, env diagnosticsEnv, check diagnosticsCheck) diagnosticsCheckResult {
	if check.Port <= 0 {
		return diagnosticsCheckResult{Status: "skip", Summary: "没有端口"}
	}
	pattern := diagnosticsDportPattern(check.Port)
	ran := false
	var lines []string
	if env.hasCommand("nft") {
		if out, err := env.run(ctx, "nft", "list", "ruleset"); err == nil {
			ran = true
			lines = append(lines, matchingLines(out, pattern, 10)...)
		}
	}
	if env.hasCommand("iptables-save") {
		if out, err := env.run(ctx, "iptables-save", "-t", "nat"); err == nil {
			ran = true
			lines = append(lines, matchingLines(out, pattern, 10)...)
		}
	}
	if !ran {
		return diagnosticsCheckResult{Status: "skip", Summary: "主机上没有 nft / iptables-save，没法检查内核转发规则"}
	}
	if len(lines) == 0 {
		return diagnosticsCheckResult{Status: "fail", Summary: fmt.Sprintf("nftables / iptables 里没找到端口 %d 的转发规则", check.Port)}
	}
	return diagnosticsCheckResult{Status: "pass", Summary: fmt.Sprintf("找到 %d 条端口 %d 的规则", len(lines), check.Port), Detail: strings.Join(lines, "\n")}
}

// portInSpec 判断「443」「8000:9000」「8000-9000」「80,443」这类写法是否包含 port。
func portInSpec(spec string, port int) bool {
	for _, part := range strings.FieldsFunc(spec, func(r rune) bool { return r == ',' || r == ' ' }) {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		sep := strings.IndexAny(part, ":-")
		if sep > 0 {
			low, err1 := strconv.Atoi(part[:sep])
			high, err2 := strconv.Atoi(part[sep+1:])
			if err1 == nil && err2 == nil && port >= low && port <= high {
				return true
			}
			continue
		}
		if value, err := strconv.Atoi(part); err == nil && value == port {
			return true
		}
	}
	return false
}

var ufwRulePattern = regexp.MustCompile(`^\s*([0-9][0-9,:]*)(?:/(tcp|udp))?(?:\s+\(v6\))?\s+(ALLOW|DENY|REJECT|LIMIT)`)

// ufwVerdict 看 `ufw status` 的输出：没启用 → ""；有放行这个端口的规则 → "allow"；
// 明确拒绝 → "deny"；启用了但没提到这个端口 → "missing"。
func ufwVerdict(output string, port int, proto string) string {
	if !strings.Contains(output, "Status: active") {
		return ""
	}
	verdict := "missing"
	for _, line := range strings.Split(output, "\n") {
		match := ufwRulePattern.FindStringSubmatch(line)
		if match == nil || !portInSpec(match[1], port) {
			continue
		}
		if match[2] != "" && proto != "" && proto != "both" && match[2] != proto {
			continue
		}
		if match[3] == "ALLOW" || match[3] == "LIMIT" {
			return "allow"
		}
		verdict = "deny"
	}
	return verdict
}

// firewalldAllows 看 `firewall-cmd --list-ports` 的输出（「80/tcp 8000-9000/udp」）。
func firewalldAllows(output string, port int, proto string) bool {
	for _, field := range strings.Fields(output) {
		spec, p, _ := strings.Cut(field, "/")
		if p != "" && proto != "" && proto != "both" && p != proto {
			continue
		}
		if portInSpec(spec, port) {
			return true
		}
	}
	return false
}

// iptablesChainVerdict 看 `iptables -S <链>`：默认策略或末尾兜底是 DROP/REJECT，且没有提到这个
// 端口的 ACCEPT → "blocked-policy"；有针对这个端口的 DROP/REJECT → "blocked-rule"；否则 ""。
func iptablesChainVerdict(output string, chain string, port int) string {
	pattern := diagnosticsDportPattern(port)
	dropPolicy := false
	accepted := false
	for _, raw := range strings.Split(output, "\n") {
		line := strings.TrimSpace(raw)
		if line == "-P "+chain+" DROP" || line == "-P "+chain+" REJECT" {
			dropPolicy = true
			continue
		}
		if !strings.HasPrefix(line, "-A "+chain+" ") {
			continue
		}
		mentionsPort := pattern.MatchString(line)
		if mentionsPort && (strings.Contains(line, "-j DROP") || strings.Contains(line, "-j REJECT")) && !accepted {
			return "blocked-rule"
		}
		if mentionsPort && strings.Contains(line, "-j ACCEPT") {
			accepted = true
		}
		if !mentionsPort && (line == "-A "+chain+" -j DROP" || strings.HasPrefix(line, "-A "+chain+" -j REJECT")) {
			dropPolicy = true
		}
	}
	if dropPolicy && !accepted {
		return "blocked-policy"
	}
	return ""
}

var nftChainPolicyPattern = regexp.MustCompile(`hook\s+(input|forward)\s+priority[^;]*;\s*policy\s+drop`)

// nftDropPolicy 看 `nft list ruleset`：除了面板自己的 forwardx_guard 表，有没有 input（或 forward）
// 钩子默认丢包的链，且整个规则集里没提到这个端口。
func nftDropPolicy(output string, hook string, port int) bool {
	inOwnTable := false
	policyDrop := false
	for _, line := range strings.Split(output, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "table ") {
			inOwnTable = strings.Contains(trimmed, firewallNftTable)
			continue
		}
		if inOwnTable {
			continue
		}
		if match := nftChainPolicyPattern.FindStringSubmatch(trimmed); match != nil && match[1] == hook {
			policyDrop = true
		}
	}
	return policyDrop && !diagnosticsDportPattern(port).MatchString(output)
}

func diagnosticsCheckFirewall(ctx context.Context, env diagnosticsEnv, check diagnosticsCheck) diagnosticsCheckResult {
	if check.Port <= 0 {
		return diagnosticsCheckResult{Status: "skip", Summary: "没有端口"}
	}
	proto := strings.ToLower(strings.TrimSpace(check.Protocol))
	if proto == "any" {
		proto = ""
	}
	kernel := check.ForwardType == "iptables" || check.ForwardType == "nftables"
	chain, hook := "INPUT", "input"
	if kernel {
		// DNAT 转发的包不进 INPUT，走 FORWARD。
		chain, hook = "FORWARD", "forward"
	}
	var issues []string
	var details []string
	blocked := false
	if active, backend := env.firewallGuard(); active {
		details = append(details, fmt.Sprintf("面板的「地区规则 / IP 封禁」已在这台主机生效（%s）：被封禁或不在允许地区的来源连不进来", backend))
	}
	if env.hasCommand("ufw") {
		if out, err := env.run(ctx, "ufw", "status"); err == nil {
			switch ufwVerdict(out, check.Port, proto) {
			case "deny":
				blocked = true
				issues = append(issues, fmt.Sprintf("ufw 拒绝了端口 %d", check.Port))
			case "missing":
				issues = append(issues, fmt.Sprintf("ufw 已启用，但没有放行端口 %d 的规则", check.Port))
			}
			details = append(details, "ufw status\n"+strings.TrimSpace(out))
		}
	}
	if env.hasCommand("firewall-cmd") {
		if state, err := env.run(ctx, "firewall-cmd", "--state"); err == nil && strings.Contains(state, "running") {
			ports, _ := env.run(ctx, "firewall-cmd", "--list-ports")
			if !firewalldAllows(ports, check.Port, proto) {
				issues = append(issues, fmt.Sprintf("firewalld 在运行，开放端口里没有 %d（如果是靠服务放行的可以忽略）", check.Port))
			}
			details = append(details, "firewall-cmd --list-ports\n"+strings.TrimSpace(ports))
		}
	}
	if env.hasCommand("iptables") {
		if out, err := env.run(ctx, "iptables", "-S", chain); err == nil {
			switch iptablesChainVerdict(out, chain, check.Port) {
			case "blocked-rule":
				blocked = true
				issues = append(issues, fmt.Sprintf("iptables %s 链里有丢弃端口 %d 的规则", chain, check.Port))
			case "blocked-policy":
				issues = append(issues, fmt.Sprintf("iptables %s 链默认丢包，没看到放行端口 %d 的规则", chain, check.Port))
			}
			details = append(details, "iptables -S "+chain+"\n"+strings.TrimSpace(out))
		}
	}
	if env.hasCommand("nft") {
		if out, err := env.run(ctx, "nft", "list", "ruleset"); err == nil && nftDropPolicy(out, hook, check.Port) {
			issues = append(issues, fmt.Sprintf("nftables 有默认丢包的 %s 链，没看到放行端口 %d 的规则", hook, check.Port))
		}
	}
	detail := strings.Join(details, "\n\n")
	if blocked {
		return diagnosticsCheckResult{Status: "fail", Summary: strings.Join(issues, "；"), Detail: detail}
	}
	if len(issues) > 0 {
		return diagnosticsCheckResult{Status: "warn", Summary: strings.Join(issues, "；"), Detail: detail}
	}
	summary := "主机上没发现挡住这个端口的防火墙规则（云安全组看不到，需要另外确认）"
	return diagnosticsCheckResult{Status: "pass", Summary: summary, Detail: detail}
}

func diagnosticsDialOnce(ctx context.Context, env diagnosticsEnv, network, address string) (time.Duration, error) {
	dialCtx, cancel := context.WithTimeout(ctx, diagnosticsDialTimeout)
	defer cancel()
	started := env.now()
	conn, err := env.dial(dialCtx, network, address)
	if err != nil {
		return 0, err
	}
	elapsed := env.now().Sub(started)
	_ = conn.Close()
	return elapsed, nil
}

func diagnosticsDialError(err error) string {
	if err == nil {
		return ""
	}
	var netErr net.Error
	switch {
	case errors.Is(err, syscall.ECONNREFUSED):
		return "对方拒绝连接（端口没开 / 没有程序在听）"
	case errors.Is(err, syscall.EHOSTUNREACH) || errors.Is(err, syscall.ENETUNREACH):
		return "路由不通（no route to host）"
	case errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &netErr) && netErr.Timeout()):
		return "连接超时（多半是被防火墙丢包，或路由不通）"
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return "域名解析失败：" + dnsErr.Err
	}
	return err.Error()
}

func latencyPtr(d time.Duration) *int {
	ms := int(d / time.Millisecond)
	if ms < 0 {
		ms = 0
	}
	return &ms
}

func diagnosticsCheckLoopback(ctx context.Context, env diagnosticsEnv, check diagnosticsCheck) diagnosticsCheckResult {
	if check.Port <= 0 {
		return diagnosticsCheckResult{Status: "skip", Summary: "没有端口"}
	}
	// 监听在具体地址上（不是 0.0.0.0 / ::）时，回环要连那个地址。
	local := "127.0.0.1"
	if all, ok := diagnosticsListeners(env); ok {
		list := listenersOnPort(all, check.Port, "tcp")
		wildcard4, wildcard6, loop4 := false, false, false
		specific := ""
		for _, socket := range list {
			switch {
			case socket.IP.Equal(net.IPv4zero):
				wildcard4 = true
			case socket.IP.Equal(net.IPv6unspecified):
				wildcard6 = true
			case socket.IP.Equal(net.IPv4(127, 0, 0, 1)):
				loop4 = true
			case specific == "":
				specific = socket.IP.String()
			}
		}
		if !wildcard4 && !wildcard6 && !loop4 && specific != "" {
			local = specific
		} else if !wildcard4 && !loop4 && wildcard6 {
			local = "::1"
		}
	}
	localAddr := net.JoinHostPort(local, strconv.Itoa(check.Port))
	elapsed, err := diagnosticsDialOnce(ctx, env, "tcp", localAddr)
	if err != nil {
		return diagnosticsCheckResult{Status: "fail", Summary: fmt.Sprintf("连 %s 失败：%s", localAddr, diagnosticsDialError(err)), Detail: err.Error()}
	}
	lines := []string{fmt.Sprintf("%s 连通（%d ms）", localAddr, int(elapsed/time.Millisecond))}
	public := strings.Trim(strings.TrimSpace(check.PublicIP), "[]")
	if public != "" && net.ParseIP(public) != nil && public != local {
		publicAddr := net.JoinHostPort(public, strconv.Itoa(check.Port))
		if _, perr := diagnosticsDialOnce(ctx, env, "tcp", publicAddr); perr != nil {
			lines = append(lines, fmt.Sprintf("%s 失败：%s", publicAddr, diagnosticsDialError(perr)))
			return diagnosticsCheckResult{Status: "warn", Summary: fmt.Sprintf("本机 %s 通，连自己的公网 IP %s 不通", localAddr, publicAddr), Detail: strings.Join(lines, "\n"), LatencyMs: latencyPtr(elapsed)}
		}
		lines = append(lines, publicAddr+" 连通")
		return diagnosticsCheckResult{Status: "pass", Summary: fmt.Sprintf("%s 和公网 IP %s 都连得上", localAddr, publicAddr), Detail: strings.Join(lines, "\n"), LatencyMs: latencyPtr(elapsed)}
	}
	return diagnosticsCheckResult{Status: "pass", Summary: localAddr + " 连得上", Detail: strings.Join(lines, "\n"), LatencyMs: latencyPtr(elapsed)}
}

func diagnosticsCheckDNS(ctx context.Context, env diagnosticsEnv, check diagnosticsCheck) diagnosticsCheckResult {
	host := strings.Trim(strings.TrimSpace(check.Host), "[]")
	if host == "" {
		return diagnosticsCheckResult{Status: "skip", Summary: "没有目标"}
	}
	if net.ParseIP(host) != nil {
		return diagnosticsCheckResult{Status: "skip", Summary: "目标是 IP 地址，不用解析"}
	}
	type answer struct {
		ips []net.IP
		err error
	}
	results := map[string]answer{}
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, network := range []string{"ip4", "ip6"} {
		wg.Add(1)
		go func(network string) {
			defer wg.Done()
			lookupCtx, cancel := context.WithTimeout(ctx, diagnosticsDNSTimeout)
			defer cancel()
			ips, err := env.lookupIP(lookupCtx, network, host)
			mu.Lock()
			results[network] = answer{ips, err}
			mu.Unlock()
		}(network)
	}
	wg.Wait()
	var v4, v6 []string
	var lines []string
	for _, network := range []string{"ip4", "ip6"} {
		entry := results[network]
		label := "IPv4"
		if network == "ip6" {
			label = "IPv6"
		}
		if entry.err != nil {
			lines = append(lines, label+"："+entry.err.Error())
			continue
		}
		var list []string
		for _, ip := range entry.ips {
			list = append(list, ip.String())
		}
		if network == "ip4" {
			v4 = list
		} else {
			v6 = list
		}
		lines = append(lines, label+"："+strings.Join(list, ", "))
	}
	if raw, err := env.readFile("/etc/resolv.conf"); err == nil {
		for _, line := range strings.Split(string(raw), "\n") {
			if strings.HasPrefix(strings.TrimSpace(line), "nameserver") {
				lines = append(lines, strings.TrimSpace(line))
			}
		}
	}
	detail := strings.Join(lines, "\n")
	if len(v4) == 0 && len(v6) == 0 {
		return diagnosticsCheckResult{Status: "fail", Summary: "主机解析不出 " + host + " 的地址", Detail: detail}
	}
	parts := []string{}
	if len(v4) > 0 {
		parts = append(parts, "IPv4 "+strings.Join(limitStrings(v4, 3), ", "))
	}
	if len(v6) > 0 {
		parts = append(parts, "IPv6 "+strings.Join(limitStrings(v6, 2), ", "))
	}
	return diagnosticsCheckResult{Status: "pass", Summary: "解析到 " + strings.Join(parts, "；"), Detail: detail}
}

func limitStrings(list []string, limit int) []string {
	if len(list) <= limit {
		return list
	}
	return append(append([]string{}, list[:limit]...), "…")
}

func diagnosticsCheckDial(ctx context.Context, env diagnosticsEnv, check diagnosticsCheck) diagnosticsCheckResult {
	host := strings.Trim(strings.TrimSpace(check.Host), "[]")
	if host == "" || check.Port <= 0 {
		return diagnosticsCheckResult{Status: "skip", Summary: "没有目标"}
	}
	address := net.JoinHostPort(host, strconv.Itoa(check.Port))
	if normalizeRuntimeProtocol(check.Protocol) == "udp" {
		return diagnosticsCheckUDP(ctx, env, address)
	}
	const attempts = 3
	var best time.Duration = -1
	var lastErr error
	ok := 0
	var lines []string
	for i := 0; i < attempts; i++ {
		if ctx.Err() != nil {
			break
		}
		elapsed, err := diagnosticsDialOnce(ctx, env, "tcp", address)
		if err != nil {
			lastErr = err
			lines = append(lines, fmt.Sprintf("第 %d 次：%s", i+1, err.Error()))
			continue
		}
		ok++
		lines = append(lines, fmt.Sprintf("第 %d 次：%d ms", i+1, int(elapsed/time.Millisecond)))
		if best < 0 || elapsed < best {
			best = elapsed
		}
	}
	detail := strings.Join(lines, "\n")
	switch {
	case ok == 0:
		return diagnosticsCheckResult{Status: "fail", Summary: fmt.Sprintf("TCP 连 %s 失败：%s", address, diagnosticsDialError(lastErr)), Detail: detail}
	case ok < attempts:
		return diagnosticsCheckResult{Status: "warn", Summary: fmt.Sprintf("TCP 连 %s %d/%d 次成功，最快 %d ms", address, ok, attempts, int(best/time.Millisecond)), Detail: detail, LatencyMs: latencyPtr(best)}
	default:
		return diagnosticsCheckResult{Status: "pass", Summary: fmt.Sprintf("TCP 连得上 %s，%d ms", address, int(best/time.Millisecond)), Detail: detail, LatencyMs: latencyPtr(best)}
	}
}

// diagnosticsCheckUDP 只能尽力而为：发一个空包，收到回包算通，收到 ICMP 端口不可达（读的时候
// 报 connection refused）算不通，什么都没收到说明不了问题 —— 多数 UDP 服务不理空包。
func diagnosticsCheckUDP(ctx context.Context, env diagnosticsEnv, address string) diagnosticsCheckResult {
	dialCtx, cancel := context.WithTimeout(ctx, diagnosticsDialTimeout)
	defer cancel()
	conn, err := env.dial(dialCtx, "udp", address)
	if err != nil {
		return diagnosticsCheckResult{Status: "fail", Summary: "UDP 发不出去：" + diagnosticsDialError(err), Detail: err.Error()}
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(1500 * time.Millisecond))
	if _, err := conn.Write([]byte{0}); err != nil {
		return diagnosticsCheckResult{Status: "fail", Summary: "UDP 发不出去：" + diagnosticsDialError(err), Detail: err.Error()}
	}
	buf := make([]byte, 64)
	if _, err := conn.Read(buf); err != nil {
		if errors.Is(err, syscall.ECONNREFUSED) {
			return diagnosticsCheckResult{Status: "fail", Summary: "目标回了「端口不可达」：" + address + " 上没有 UDP 服务", Detail: err.Error()}
		}
		return diagnosticsCheckResult{Status: "skip", Summary: "UDP 没有回包，没法确认通不通（很多 UDP 服务不回空包，以实际使用为准）", Detail: err.Error()}
	}
	return diagnosticsCheckResult{Status: "pass", Summary: "UDP 收到了 " + address + " 的回包"}
}

func diagnosticsCheckProcess(env diagnosticsEnv, check diagnosticsCheck) diagnosticsCheckResult {
	forwardType := strings.ToLower(strings.TrimSpace(check.ForwardType))
	if forwardType == "fxp" {
		alive, detail := env.fxpAlive(check.TunnelID)
		if alive {
			return diagnosticsCheckResult{Status: "pass", Summary: "FXP 进程在运行", Detail: detail}
		}
		return diagnosticsCheckResult{Status: "fail", Summary: "这条隧道的 FXP 进程没在运行", Detail: detail}
	}
	var groups [][]string
	switch forwardType {
	case "realm", "socat":
		groups = localRuleManagedServiceGroups(forwardType, check.Port, check.Protocol)
	case "gost":
		groups = [][]string{{runtimeServiceName}}
	case "nginx":
		groups = [][]string{{nginxServiceName}}
	case "tunnel":
		groups = [][]string{{tunnelRuntimeServiceName, legacyTunnelServiceName, runtimeServiceName}}
	default:
		return diagnosticsCheckResult{Status: "skip", Summary: "这种转发方式没有单独的进程"}
	}
	var active, missing []string
	for _, alternatives := range groups {
		found := ""
		for _, name := range alternatives {
			ok, supported := env.serviceActive(name)
			if !supported {
				return diagnosticsCheckResult{Status: "skip", Summary: "主机没有 systemd / OpenRC，没法检查服务状态"}
			}
			if ok {
				found = name
				break
			}
		}
		if found != "" {
			active = append(active, found)
		} else if len(alternatives) > 0 {
			missing = append(missing, alternatives[0])
		}
	}
	if len(missing) > 0 {
		return diagnosticsCheckResult{Status: "fail", Summary: "服务没在运行：" + strings.Join(missing, "、"), Detail: "systemctl status " + strings.Join(missing, " ")}
	}
	return diagnosticsCheckResult{Status: "pass", Summary: "服务在运行：" + strings.Join(active, "、")}
}

/* ───────────────────────── 读运行时状态 ───────────────────────── */

func fxpSpecHasTunnel(spec fxpSpec, tunnelID int) bool {
	if spec.TunnelID == tunnelID {
		return true
	}
	for _, entry := range spec.Entries {
		if fxpSpecHasTunnel(entry, tunnelID) {
			return true
		}
	}
	return false
}

func diagnosticsFXPAlive(tunnelID int) (bool, string) {
	fxpMu.Lock()
	defer fxpMu.Unlock()
	var lines []string
	for key, process := range fxpServers {
		if process == nil || (tunnelID > 0 && !fxpSpecHasTunnel(process.spec, tunnelID)) {
			continue
		}
		if process.cmd == nil || process.cmd.Process == nil {
			lines = append(lines, key+"：没有进程")
			continue
		}
		if process.cmd.ProcessState != nil {
			lines = append(lines, fmt.Sprintf("%s：pid %d 已退出（%s）", key, process.cmd.Process.Pid, process.cmd.ProcessState.String()))
			continue
		}
		if err := process.cmd.Process.Signal(syscall.Signal(0)); err != nil {
			lines = append(lines, fmt.Sprintf("%s：pid %d 不在了（%v）", key, process.cmd.Process.Pid, err))
			continue
		}
		return true, fmt.Sprintf("%s：pid %d", key, process.cmd.Process.Pid)
	}
	if len(lines) == 0 {
		return false, "这台主机上没有这条隧道的 FXP 进程"
	}
	return false, strings.Join(lines, "\n")
}

func diagnosticsFirewallGuardState() (bool, string) {
	extModulesMu.RLock()
	module, ok := extModules["firewall"].(*firewallModule)
	extModulesMu.RUnlock()
	if !ok || module == nil {
		return false, ""
	}
	module.mu.Lock()
	defer module.mu.Unlock()
	return module.active, module.backend
}
