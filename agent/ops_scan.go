package main

/*
导入现有配置（第五套主题 #16）：找出这台机器上「不是面板配的」端口转发。

很多人装面板之前已经在机器上手搓过 realm / gost / socat / iptables 转发。扫描把它们
列出来，面板那边勾选后建成（先停用的）规则，再一条条「停掉原服务并启用规则」。

扫哪里：
  - systemd 单元（/etc/systemd/system、/lib/systemd/system、/usr/lib/systemd/system）的
    ExecStart：realm（-l/-r 或 -c 配置文件）、gost（-L/-F 或 -C 配置文件）、socat；
  - 没有单元引用、但放在常见位置的 realm / gost 配置文件（只能导入，停不了）；
  - iptables-save / ip6tables-save 的 nat 表里的 DNAT；
  - nft -j list ruleset 里的 dnat；
  - x-ui / 3x-ui / sing-box / Xray：只报「检测到」，不能导入。
不扫面板自己的东西：forwardx-* 单元、/etc/forwardx 下的配置、forwardx* 的 nft 表、
Agent 记着属于某条规则的端口（/var/lib/forwardx-agent/port_<端口>.rule）上的 DNAT。

解析全部是纯函数（给测试用夹具文件），读系统的那层在 opsScanSystem 里。
*/

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

type opsFirewallRef struct {
	Kind   string `json:"kind"` // iptables / ip6tables / nft
	Line   string `json:"line,omitempty"`
	Family string `json:"family,omitempty"`
	Table  string `json:"table,omitempty"`
	Chain  string `json:"chain,omitempty"`
	Handle int    `json:"handle,omitempty"`
}

type opsScanItem struct {
	Key        string `json:"key"`
	Tool       string `json:"tool"`
	Protocol   string `json:"protocol,omitempty"`
	ListenAddr string `json:"listenAddr,omitempty"`
	ListenPort int    `json:"listenPort,omitempty"`
	Target     string `json:"target,omitempty"`
	Source     string `json:"source"`
	Unit       string `json:"unit,omitempty"`
	UnitActive bool   `json:"unitActive,omitempty"`
	Importable bool   `json:"importable"`
	Reason     string `json:"reason,omitempty"`

	// 停掉原配置要用的东西，只在 Agent 本地用，不上报。
	refs []opsFirewallRef
}

// opsForwardSpec 是各个解析器的共同产出，再由调用方补上 tool / source / unit。
type opsForwardSpec struct {
	Protocol   string
	ListenAddr string
	ListenPort int
	Target     string
	Importable bool
	Reason     string
	refs       []opsFirewallRef
}

func opsProtocol(tcp, udp bool) string {
	switch {
	case tcp && udp:
		return "both"
	case udp:
		return "udp"
	default:
		return "tcp"
	}
}

// opsParseListen 解析 "0.0.0.0:80" / ":80" / "[::]:80" / "80"。
func opsParseListen(raw string) (string, int, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", 0, false
	}
	if n, err := strconv.Atoi(raw); err == nil {
		return "", n, n > 0 && n <= 65535
	}
	host, port, err := net.SplitHostPort(raw)
	if err != nil {
		return "", 0, false
	}
	n, err := strconv.Atoi(port)
	if err != nil || n <= 0 || n > 65535 {
		return "", 0, false
	}
	return host, n, true
}

// opsParseTarget 解析 "host:port"，返回规范化的 host:port（IPv6 带方括号）。
func opsParseTarget(raw string) (string, bool) {
	raw = strings.TrimSpace(raw)
	host, port, err := net.SplitHostPort(raw)
	if err != nil || strings.TrimSpace(host) == "" {
		return "", false
	}
	n, err := strconv.Atoi(port)
	if err != nil || n <= 0 || n > 65535 {
		return "", false
	}
	return net.JoinHostPort(host, port), true
}

func opsNewSpec(protocol, listen, target string) opsForwardSpec {
	spec := opsForwardSpec{Protocol: protocol, Importable: true}
	addr, port, ok := opsParseListen(listen)
	if !ok {
		spec.Importable = false
		spec.Reason = "看不懂监听地址 " + listen
		return spec
	}
	spec.ListenAddr, spec.ListenPort = addr, port
	normalized, ok := opsParseTarget(target)
	if !ok {
		spec.Importable = false
		spec.Reason = "看不懂目标地址 " + target
		spec.Target = target
		return spec
	}
	spec.Target = normalized
	return spec
}

// ---------------------------------------------------------------- 命令行

// opsSplitCommandLine 按 shell 的规则（引号、反斜杠）把一行命令拆成参数。
func opsSplitCommandLine(line string) []string {
	var args []string
	var current strings.Builder
	inSingle, inDouble, escaped, has := false, false, false, false
	for _, r := range line {
		switch {
		case escaped:
			current.WriteRune(r)
			escaped = false
			has = true
		case r == '\\' && !inSingle:
			escaped = true
		case r == '\'' && !inDouble:
			inSingle = !inSingle
			has = true
		case r == '"' && !inSingle:
			inDouble = !inDouble
			has = true
		case (r == ' ' || r == '\t' || r == '\n') && !inSingle && !inDouble:
			if has {
				args = append(args, current.String())
				current.Reset()
				has = false
			}
		default:
			current.WriteRune(r)
			has = true
		}
	}
	if has {
		args = append(args, current.String())
	}
	return args
}

// opsUnitExecStarts 取 systemd 单元里所有 ExecStart（续行拼好、去掉 -@+! 前缀），
// `sh -c "…"` 的取里面那条命令。
func opsUnitExecStarts(unit string) [][]string {
	unit = strings.ReplaceAll(unit, "\r\n", "\n")
	unit = strings.ReplaceAll(unit, "\\\n", " ")
	var result [][]string
	for _, line := range strings.Split(unit, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "ExecStart=") {
			continue
		}
		value := strings.TrimSpace(strings.TrimPrefix(line, "ExecStart="))
		value = strings.TrimLeft(value, "-@+!:")
		args := opsSplitCommandLine(value)
		if len(args) == 0 {
			continue
		}
		base := filepath.Base(args[0])
		if (base == "sh" || base == "bash" || base == "dash") && len(args) >= 3 && args[1] == "-c" {
			args = opsSplitCommandLine(args[2])
			if len(args) > 0 && args[0] == "exec" {
				args = args[1:]
			}
		}
		if len(args) > 0 {
			result = append(result, args)
		}
	}
	return result
}

// opsToolFromExec 按程序名认工具。
func opsToolFromExec(arg0 string) string {
	base := strings.ToLower(filepath.Base(arg0))
	switch {
	case base == "realm" || strings.HasPrefix(base, "realm-") || strings.HasPrefix(base, "realm_"):
		return "realm"
	case base == "gost" || strings.HasPrefix(base, "gost-") || strings.HasPrefix(base, "gost_") || base == "gost3":
		return "gost"
	case base == "socat":
		return "socat"
	}
	return ""
}

// opsFlagValue 取 "-x v" / "--xx v" / "-x=v" / "--xx=v" 形式的值；names 是不带等号的名字。
func opsFlagValues(args []string, names ...string) []string {
	var values []string
	for i := 0; i < len(args); i++ {
		arg := args[i]
		for _, name := range names {
			if arg == name && i+1 < len(args) {
				values = append(values, args[i+1])
				i++
				break
			}
			if strings.HasPrefix(arg, name+"=") {
				values = append(values, strings.TrimPrefix(arg, name+"="))
				break
			}
		}
	}
	return values
}

func opsHasFlag(args []string, names ...string) bool {
	for _, arg := range args {
		for _, name := range names {
			if arg == name {
				return true
			}
		}
	}
	return false
}

// ---------------------------------------------------------------- realm

func opsBool(v any) bool {
	switch value := v.(type) {
	case bool:
		return value
	case string:
		return strings.EqualFold(strings.TrimSpace(value), "true")
	}
	return false
}

func opsString(v any) string {
	switch value := v.(type) {
	case string:
		return strings.TrimSpace(value)
	case float64:
		return strconv.FormatFloat(value, 'f', -1, 64)
	case int:
		return strconv.Itoa(value)
	}
	return ""
}

// realmEndpointsFromMap 是 realm 的 JSON / TOML 共用的那一半：{network, endpoints: [...]}。
func realmEndpointsFromMap(doc map[string]any) []opsForwardSpec {
	global, _ := doc["network"].(map[string]any)
	tcp, udp := !opsBool(global["no_tcp"]), opsBool(global["use_udp"])
	endpoints, _ := doc["endpoints"].([]any)
	var specs []opsForwardSpec
	for _, raw := range endpoints {
		ep, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		epTCP, epUDP := tcp, udp
		if network, ok := ep["network"].(map[string]any); ok {
			if v, ok := network["no_tcp"]; ok {
				epTCP = !opsBool(v)
			}
			if v, ok := network["use_udp"]; ok {
				epUDP = opsBool(v)
			}
		}
		spec := opsNewSpec(opsProtocol(epTCP, epUDP), opsString(ep["listen"]), opsString(ep["remote"]))
		if spec.Importable {
			if extra, ok := ep["extra_remotes"].([]any); ok && len(extra) > 0 {
				spec.Importable, spec.Reason = false, "有多个目标（extra_remotes），请手动建"
			} else if opsString(ep["listen_transport"]) != "" || opsString(ep["remote_transport"]) != "" {
				spec.Importable, spec.Reason = false, "带了 ws / tls 传输层，面板的 realm 规则不支持"
			} else if !epTCP && !epUDP {
				spec.Importable, spec.Reason = false, "TCP 和 UDP 都关着"
			}
		}
		specs = append(specs, spec)
	}
	return specs
}

func parseRealmJSON(content []byte) ([]opsForwardSpec, error) {
	var doc map[string]any
	if err := json.Unmarshal(content, &doc); err != nil {
		return nil, err
	}
	return realmEndpointsFromMap(doc), nil
}

// tomlValue 解析 TOML 里这几种值：字符串、布尔、数字、字符串数组、简单的内联表。
func tomlValue(raw string) any {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	if strings.HasPrefix(raw, "{") && strings.HasSuffix(raw, "}") {
		table := map[string]any{}
		for _, part := range strings.Split(raw[1:len(raw)-1], ",") {
			if key, value, ok := strings.Cut(part, "="); ok {
				table[strings.Trim(strings.TrimSpace(key), `"`)] = tomlValue(value)
			}
		}
		return table
	}
	if strings.HasPrefix(raw, "[") && strings.HasSuffix(raw, "]") {
		list := []any{}
		for _, part := range strings.Split(raw[1:len(raw)-1], ",") {
			if part = strings.TrimSpace(part); part != "" {
				list = append(list, tomlValue(part))
			}
		}
		return list
	}
	if raw == "true" || raw == "false" {
		return raw == "true"
	}
	return yamlScalar(raw)
}

// parseRealmTOML 只认 realm 用得到的那点 TOML：[network]、[[endpoints]]、[endpoints.network]。
func parseRealmTOML(content []byte) ([]opsForwardSpec, error) {
	doc := map[string]any{}
	var endpoints []any
	var current map[string]any
	for _, line := range strings.Split(strings.ReplaceAll(string(content), "\r\n", "\n"), "\n") {
		line = strings.TrimSpace(yamlStripComment(line))
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "[[") && strings.HasSuffix(line, "]]") {
			name := strings.TrimSpace(line[2 : len(line)-2])
			if name == "endpoints" {
				ep := map[string]any{}
				endpoints = append(endpoints, ep)
				current = ep
			} else {
				current = map[string]any{}
			}
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			name := strings.TrimSpace(line[1 : len(line)-1])
			switch {
			case name == "network" || name == "network.":
				table := map[string]any{}
				doc["network"] = table
				current = table
			case name == "endpoints.network" && len(endpoints) > 0:
				table := map[string]any{}
				endpoints[len(endpoints)-1].(map[string]any)["network"] = table
				current = table
			default:
				current = map[string]any{}
			}
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			return nil, fmt.Errorf("toml: cannot parse line %q", line)
		}
		if current == nil {
			current = doc
		}
		current[strings.Trim(strings.TrimSpace(key), `"`)] = tomlValue(value)
	}
	doc["endpoints"] = endpoints
	return realmEndpointsFromMap(doc), nil
}

func parseRealmConfig(path string, content []byte) ([]opsForwardSpec, error) {
	trimmed := strings.TrimSpace(string(content))
	if strings.HasSuffix(strings.ToLower(path), ".json") || strings.HasPrefix(trimmed, "{") {
		return parseRealmJSON(content)
	}
	return parseRealmTOML(content)
}

// parseRealmArgs 读 realm 的命令行：-c 配置文件，或者 -l/-r 单条。
func parseRealmArgs(args []string) (configPath string, specs []opsForwardSpec) {
	if values := opsFlagValues(args, "-c", "--config"); len(values) > 0 {
		return values[0], nil
	}
	listens := opsFlagValues(args, "-l", "--listen")
	remotes := opsFlagValues(args, "-r", "--remote")
	if len(listens) == 0 || len(remotes) == 0 {
		return "", nil
	}
	tcp := !opsHasFlag(args, "--no-tcp")
	udp := opsHasFlag(args, "-u", "--udp", "--use-udp")
	spec := opsNewSpec(opsProtocol(tcp, udp), listens[0], remotes[0])
	if spec.Importable && (len(remotes) > 1 || len(opsFlagValues(args, "--extra-remotes")) > 0) {
		spec.Importable, spec.Reason = false, "有多个目标，请手动建"
	}
	return "", []opsForwardSpec{spec}
}

// ---------------------------------------------------------------- gost

// parseGostServeNode 解析一条 -L：tcp://[:addr]:port/target:port[?参数]。
func parseGostServeNode(node string, hasChain bool) (opsForwardSpec, bool) {
	node = strings.TrimSpace(node)
	scheme, rest, ok := strings.Cut(node, "://")
	if !ok {
		return opsForwardSpec{}, false
	}
	scheme = strings.ToLower(scheme)
	if before, _, found := strings.Cut(rest, "?"); found {
		rest = before
	}
	// 只取 +号前的协议名（tcp+tls 这种是 gost 的传输层组合，不是普通转发）。
	listen, target, hasTarget := strings.Cut(rest, "/")
	switch scheme {
	case "tcp", "udp":
	case "rtcp", "rudp":
		spec := opsNewSpec(scheme[1:], listen, target)
		spec.Importable, spec.Reason = false, "是远程端口转发（"+scheme+"），面板没有对应的规则"
		return spec, true
	default:
		addr, port, ok := opsParseListen(listen)
		if !ok {
			return opsForwardSpec{}, false
		}
		return opsForwardSpec{Protocol: "tcp", ListenAddr: addr, ListenPort: port, Reason: "是代理服务（" + scheme + "），不是端口转发"}, true
	}
	if !hasTarget || strings.TrimSpace(target) == "" {
		addr, port, _ := opsParseListen(listen)
		return opsForwardSpec{Protocol: scheme, ListenAddr: addr, ListenPort: port, Reason: "没有转发目标"}, true
	}
	targets := strings.Split(target, ",")
	spec := opsNewSpec(scheme, listen, targets[0])
	if spec.Importable && len(targets) > 1 {
		spec.Importable, spec.Reason = false, "有多个目标，请手动建"
	}
	if spec.Importable && hasChain {
		spec.Importable, spec.Reason = false, "经过上游转发链（-F），请手动建"
	}
	return spec, true
}

func parseGostArgs(args []string) (configPath string, specs []opsForwardSpec) {
	if values := opsFlagValues(args, "-C"); len(values) > 0 {
		return values[0], nil
	}
	hasChain := len(opsFlagValues(args, "-F")) > 0
	for _, node := range opsFlagValues(args, "-L") {
		if spec, ok := parseGostServeNode(node, hasChain); ok {
			specs = append(specs, spec)
		}
	}
	return "", specs
}

func opsAnyList(v any) []any {
	list, _ := v.([]any)
	return list
}

// gostSpecsFromDoc 同时认 gost v2（ServeNodes/ChainNodes/Routes）和 v3（services）。
func gostSpecsFromDoc(doc map[string]any) []opsForwardSpec {
	var specs []opsForwardSpec
	v2Routes := []map[string]any{doc}
	for _, raw := range opsAnyList(doc["Routes"]) {
		if route, ok := raw.(map[string]any); ok {
			v2Routes = append(v2Routes, route)
		}
	}
	for _, route := range v2Routes {
		hasChain := len(opsAnyList(route["ChainNodes"])) > 0
		for _, node := range opsAnyList(route["ServeNodes"]) {
			if spec, ok := parseGostServeNode(opsString(node), hasChain); ok {
				specs = append(specs, spec)
			}
		}
	}
	for _, raw := range opsAnyList(doc["services"]) {
		service, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		handler, _ := service["handler"].(map[string]any)
		handlerType := strings.ToLower(opsString(handler["type"]))
		listen := opsString(service["addr"])
		var targets []string
		if forwarder, ok := service["forwarder"].(map[string]any); ok {
			for _, rawNode := range opsAnyList(forwarder["nodes"]) {
				if node, ok := rawNode.(map[string]any); ok {
					if addr := opsString(node["addr"]); addr != "" {
						targets = append(targets, addr)
					}
				}
			}
		}
		switch handlerType {
		case "tcp", "udp":
			if len(targets) == 0 {
				addr, port, _ := opsParseListen(listen)
				specs = append(specs, opsForwardSpec{Protocol: handlerType, ListenAddr: addr, ListenPort: port, Reason: "没有转发目标"})
				continue
			}
			spec := opsNewSpec(handlerType, listen, targets[0])
			if spec.Importable && len(targets) > 1 {
				spec.Importable, spec.Reason = false, "有多个目标，请手动建"
			}
			if spec.Importable && (opsString(handler["chain"]) != "" || opsString(service["chain"]) != "") {
				spec.Importable, spec.Reason = false, "经过上游转发链，请手动建"
			}
			if listener, ok := service["listener"].(map[string]any); ok && spec.Importable {
				if lt := strings.ToLower(opsString(listener["type"])); lt != "" && lt != "tcp" && lt != "udp" {
					spec.Importable, spec.Reason = false, "监听用了 "+lt+" 传输层，请手动建"
				}
			}
			specs = append(specs, spec)
		case "rtcp", "rudp":
			spec := opsNewSpec(handlerType[1:], listen, firstOr(targets, ""))
			spec.Importable, spec.Reason = false, "是远程端口转发（"+handlerType+"），面板没有对应的规则"
			specs = append(specs, spec)
		default:
			addr, port, ok := opsParseListen(listen)
			if ok {
				specs = append(specs, opsForwardSpec{Protocol: "tcp", ListenAddr: addr, ListenPort: port, Reason: "是代理服务（" + firstOr([]string{handlerType}, "未知") + "），不是端口转发"})
			}
		}
	}
	return specs
}

func firstOr(list []string, fallback string) string {
	if len(list) > 0 && list[0] != "" {
		return list[0]
	}
	return fallback
}

func parseGostConfig(path string, content []byte) ([]opsForwardSpec, error) {
	trimmed := strings.TrimSpace(string(content))
	var doc map[string]any
	if strings.HasSuffix(strings.ToLower(path), ".json") || strings.HasPrefix(trimmed, "{") {
		if err := json.Unmarshal(content, &doc); err != nil {
			return nil, err
		}
	} else {
		parsed, err := parseMiniYAML(string(content))
		if err != nil {
			return nil, err
		}
		var ok bool
		if doc, ok = parsed.(map[string]any); !ok {
			return nil, fmt.Errorf("gost config is not a map")
		}
	}
	return gostSpecsFromDoc(doc), nil
}

// ---------------------------------------------------------------- socat

// opsSocatArgTakingOptions 是 socat 里带一个参数的全局选项。
var opsSocatArgTakingOptions = map[string]bool{"-T": true, "-t": true, "-b": true, "-lf": true, "-L": true, "-W": true, "-lp": true}

func parseSocatArgs(args []string) []opsForwardSpec {
	var addresses []string
	for i := 1; i < len(args); i++ {
		arg := args[i]
		if strings.HasPrefix(arg, "-") && len(arg) > 1 {
			if opsSocatArgTakingOptions[arg] {
				i++
			}
			continue
		}
		addresses = append(addresses, arg)
	}
	if len(addresses) < 2 {
		return nil
	}
	listenType, listenRest, _ := strings.Cut(addresses[0], ":")
	listenType = strings.ToUpper(listenType)
	var protocol string
	switch {
	case strings.HasPrefix(listenType, "TCP") && strings.HasSuffix(listenType, "-LISTEN"), listenType == "TCP-L", listenType == "TCP4-L", listenType == "TCP6-L":
		protocol = "tcp"
	case strings.HasPrefix(listenType, "UDP") && (strings.HasSuffix(listenType, "-LISTEN") || strings.HasSuffix(listenType, "-RECVFROM") || strings.HasSuffix(listenType, "-L")):
		protocol = "udp"
	default:
		return nil
	}
	portText, options, _ := strings.Cut(listenRest, ",")
	listenAddr := ""
	for _, option := range strings.Split(options, ",") {
		if value, ok := strings.CutPrefix(option, "bind="); ok {
			listenAddr = value
		}
	}
	listen := portText
	if listenAddr != "" {
		listen = net.JoinHostPort(strings.Trim(listenAddr, "[]"), portText)
	}
	targetType, targetRest, _ := strings.Cut(addresses[1], ":")
	targetType = strings.ToUpper(targetType)
	targetAddr, _, _ := strings.Cut(targetRest, ",")
	spec := opsNewSpec(protocol, listen, targetAddr)
	targetProto := ""
	switch {
	case strings.HasPrefix(targetType, "TCP"):
		targetProto = "tcp"
	case strings.HasPrefix(targetType, "UDP"):
		targetProto = "udp"
	}
	if targetProto == "" {
		spec.Importable, spec.Reason = false, "目标不是 TCP / UDP 地址（"+targetType+"）"
	} else if targetProto != protocol && spec.Importable {
		spec.Importable, spec.Reason = false, "监听和目标的协议不一样，请手动建"
	}
	return []opsForwardSpec{spec}
}

// ---------------------------------------------------------------- iptables / nft

// parseIptablesSaveNAT 读 iptables-save -t nat 的输出，找出按端口 DNAT 的规则。kind 是
// iptables 或 ip6tables（删除时用哪个命令）。
func parseIptablesSaveNAT(content, kind string) []opsForwardSpec {
	var specs []opsForwardSpec
	inNAT := false
	for _, line := range strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "*") {
			inNAT = line == "*nat"
			continue
		}
		if !inNAT || !strings.HasPrefix(line, "-A ") || !strings.Contains(line, " DNAT") {
			continue
		}
		args := opsSplitCommandLine(line)
		chain, proto, dport, dest, toDest := "", "", "", "", ""
		isDNAT := false
		for i := 0; i < len(args); i++ {
			next := func() string {
				if i+1 < len(args) {
					i++
					return args[i]
				}
				return ""
			}
			switch args[i] {
			case "-A":
				chain = next()
			case "-p", "--protocol":
				proto = strings.ToLower(next())
			case "--dport", "--destination-port":
				dport = next()
			case "-d", "--destination":
				dest = next()
			case "-j", "--jump":
				isDNAT = next() == "DNAT"
			case "--to-destination":
				toDest = next()
			}
		}
		if !isDNAT || chain == "" {
			continue
		}
		ref := opsFirewallRef{Kind: kind, Line: line}
		if (proto != "tcp" && proto != "udp") || dport == "" {
			continue
		}
		listen := dport
		if dest != "" {
			listen = net.JoinHostPort(strings.SplitN(dest, "/", 2)[0], dport)
		}
		if strings.ContainsAny(dport, ":,") {
			addr, _, _ := strings.Cut(dest, "/")
			first, _, _ := strings.Cut(dport, ":")
			n, _ := strconv.Atoi(first)
			specs = append(specs, opsForwardSpec{Protocol: proto, ListenAddr: addr, ListenPort: n, Target: toDest, Reason: "是端口段 " + dport + "，请手动建", refs: []opsFirewallRef{ref}})
			continue
		}
		target := toDest
		if host, port, err := net.SplitHostPort(toDest); err == nil {
			if strings.Contains(port, "-") {
				spec := opsNewSpec(proto, listen, net.JoinHostPort(host, strings.SplitN(port, "-", 2)[0]))
				spec.Importable, spec.Reason = false, "目标是端口段 "+port+"，请手动建"
				spec.refs = []opsFirewallRef{ref}
				specs = append(specs, spec)
				continue
			}
		} else {
			// --to-destination 只给了 IP：端口不变。
			target = net.JoinHostPort(strings.Trim(toDest, "[]"), dport)
		}
		spec := opsNewSpec(proto, listen, target)
		spec.refs = []opsFirewallRef{ref}
		if spec.Importable && chain != "PREROUTING" {
			spec.Reason = "在自定义链 " + chain + " 里"
		}
		specs = append(specs, spec)
	}
	return specs
}

func opsNumber(v any) (int, bool) {
	switch value := v.(type) {
	case float64:
		return int(value), value == float64(int(value))
	case json.Number:
		n, err := strconv.Atoi(value.String())
		return n, err == nil
	}
	return 0, false
}

// parseNftDNAT 读 `nft -j list ruleset`，找出 `tcp/udp dport N dnat to X` 这种规则。
// 名字以 forwardx 开头的表是面板自己的，跳过。
func parseNftDNAT(content []byte) ([]opsForwardSpec, error) {
	var doc struct {
		Nftables []map[string]json.RawMessage `json:"nftables"`
	}
	if err := json.Unmarshal(content, &doc); err != nil {
		return nil, err
	}
	var specs []opsForwardSpec
	for _, entry := range doc.Nftables {
		rawRule, ok := entry["rule"]
		if !ok {
			continue
		}
		var rule struct {
			Family string           `json:"family"`
			Table  string           `json:"table"`
			Chain  string           `json:"chain"`
			Handle int              `json:"handle"`
			Expr   []map[string]any `json:"expr"`
		}
		if json.Unmarshal(rawRule, &rule) != nil {
			continue
		}
		if strings.HasPrefix(strings.ToLower(rule.Table), "forwardx") {
			continue
		}
		proto, dport, daddr := "", 0, ""
		var dnat map[string]any
		for _, expr := range rule.Expr {
			if match, ok := expr["match"].(map[string]any); ok {
				left, _ := match["left"].(map[string]any)
				if payload, ok := left["payload"].(map[string]any); ok {
					field := opsString(payload["field"])
					protocol := opsString(payload["protocol"])
					if field == "dport" && (protocol == "tcp" || protocol == "udp") {
						if n, ok := opsNumber(match["right"]); ok {
							proto, dport = protocol, n
						}
					}
					if field == "daddr" && (protocol == "ip" || protocol == "ip6") {
						daddr = opsString(match["right"])
					}
				}
				if meta, ok := left["meta"].(map[string]any); ok && opsString(meta["key"]) == "l4proto" && proto == "" {
					proto = opsString(match["right"])
				}
			}
			if value, ok := expr["dnat"].(map[string]any); ok {
				dnat = value
			}
		}
		if dnat == nil || dport <= 0 || (proto != "tcp" && proto != "udp") {
			continue
		}
		addr := opsString(dnat["addr"])
		if addr == "" {
			continue
		}
		targetPort := dport
		if n, ok := opsNumber(dnat["port"]); ok && n > 0 {
			targetPort = n
		}
		listen := strconv.Itoa(dport)
		if daddr != "" {
			listen = net.JoinHostPort(daddr, listen)
		}
		spec := opsNewSpec(proto, listen, net.JoinHostPort(addr, strconv.Itoa(targetPort)))
		if _, isRange := dnat["port"].(map[string]any); isRange {
			spec.Importable, spec.Reason = false, "目标是端口段，请手动建"
		}
		spec.refs = []opsFirewallRef{{Kind: "nft", Family: rule.Family, Table: rule.Table, Chain: rule.Chain, Handle: rule.Handle}}
		specs = append(specs, spec)
	}
	return specs, nil
}

// ---------------------------------------------------------------- 汇总

func opsScanItemKey(item opsScanItem) string {
	sum := sha256.Sum256([]byte(strings.Join([]string{
		item.Tool, item.Source, item.Unit, item.ListenAddr, strconv.Itoa(item.ListenPort), item.Protocol, item.Target,
	}, "|")))
	return hex.EncodeToString(sum[:8])
}

func opsItemsFromSpecs(tool, source, unit string, specs []opsForwardSpec) []opsScanItem {
	items := make([]opsScanItem, 0, len(specs))
	for _, spec := range specs {
		items = append(items, opsScanItem{
			Tool: tool, Protocol: spec.Protocol, ListenAddr: spec.ListenAddr, ListenPort: spec.ListenPort,
			Target: spec.Target, Source: source, Unit: unit, Importable: spec.Importable, Reason: spec.Reason, refs: spec.refs,
		})
	}
	return items
}

// opsFinalizeScanItems 去掉面板自己的、合并 TCP+UDP、去重（iptables-nft 下同一条规则会在
// iptables-save 和 nft 里各出现一次），补 key，排好序。
func opsFinalizeScanItems(items []opsScanItem, managedPorts map[int]bool) []opsScanItem {
	kept := make([]opsScanItem, 0, len(items))
	for _, item := range items {
		if (item.Tool == "iptables" || item.Tool == "nftables") && managedPorts[item.ListenPort] {
			continue
		}
		kept = append(kept, item)
	}
	// 合并同一来源、同一监听、同一目标的 tcp + udp。
	merged := make([]opsScanItem, 0, len(kept))
	index := map[string]int{}
	for _, item := range kept {
		if item.ListenPort <= 0 || item.Target == "" {
			merged = append(merged, item)
			continue
		}
		key := strings.Join([]string{item.Tool, item.Source, item.Unit, item.ListenAddr, strconv.Itoa(item.ListenPort), item.Target}, "|")
		if at, ok := index[key]; ok {
			prev := &merged[at]
			if prev.Protocol != item.Protocol && prev.Importable == item.Importable {
				prev.Protocol = "both"
				prev.refs = append(prev.refs, item.refs...)
				continue
			}
		}
		index[key] = len(merged)
		merged = append(merged, item)
	}
	// nft 里和 iptables 一模一样的那条去掉。
	iptablesSeen := map[string]bool{}
	for _, item := range merged {
		if item.Tool == "iptables" {
			iptablesSeen[item.Protocol+"|"+strconv.Itoa(item.ListenPort)+"|"+item.Target] = true
		}
	}
	result := make([]opsScanItem, 0, len(merged))
	for _, item := range merged {
		if item.Tool == "nftables" && iptablesSeen[item.Protocol+"|"+strconv.Itoa(item.ListenPort)+"|"+item.Target] {
			continue
		}
		item.Key = opsScanItemKey(item)
		result = append(result, item)
	}
	sort.SliceStable(result, func(i, j int) bool {
		if result[i].Importable != result[j].Importable {
			return result[i].Importable
		}
		if result[i].ListenPort != result[j].ListenPort {
			return result[i].ListenPort < result[j].ListenPort
		}
		return result[i].Key < result[j].Key
	})
	return result
}

// ---------------------------------------------------------------- 读系统

var opsUnitDirs = []string{"/etc/systemd/system", "/lib/systemd/system", "/usr/lib/systemd/system"}

var opsRealmConfigGlobs = []string{"/etc/realm/*.toml", "/etc/realm/*.json", "/usr/local/etc/realm/*.toml", "/usr/local/etc/realm/*.json", "/root/realm.toml", "/root/realm.json", "/root/realm/*.toml", "/root/realm/*.json", "/opt/realm/*.toml", "/opt/realm/*.json"}

var opsGostConfigGlobs = []string{"/etc/gost/*.yml", "/etc/gost/*.yaml", "/etc/gost/*.json", "/usr/local/etc/gost/*.yml", "/usr/local/etc/gost/*.yaml", "/usr/local/etc/gost/*.json", "/root/gost.yml", "/root/gost.yaml", "/root/gost.json", "/opt/gost/*.yml", "/opt/gost/*.yaml", "/opt/gost/*.json"}

// opsInfoProbes：检测到但不能导入的那几种面板 / 代理程序。
var opsInfoProbes = []struct {
	tool  string
	paths []string
}{
	{"x-ui", []string{"/usr/local/x-ui", "/etc/systemd/system/x-ui.service"}},
	{"3x-ui", []string{"/usr/local/x-ui/bin/config.json", "/etc/x-ui/x-ui.db"}},
	{"sing-box", []string{"/etc/sing-box", "/usr/local/bin/sing-box", "/usr/bin/sing-box", "/etc/systemd/system/sing-box.service", "/lib/systemd/system/sing-box.service"}},
	{"Xray", []string{"/usr/local/etc/xray", "/usr/local/bin/xray", "/etc/systemd/system/xray.service"}},
}

func opsIsPanelManagedPath(path string) bool {
	clean := filepath.Clean(path)
	return strings.HasPrefix(clean, "/etc/forwardx/") || strings.HasPrefix(clean, "/etc/forwardx-") || strings.HasPrefix(clean, "/var/lib/forwardx") || strings.HasPrefix(clean, "/run/forwardx")
}

func opsPanelManagedPorts() map[int]bool {
	ports := map[int]bool{}
	matches, _ := filepath.Glob("/var/lib/forwardx-agent/port_*.rule")
	for _, path := range matches {
		name := strings.TrimSuffix(strings.TrimPrefix(filepath.Base(path), "port_"), ".rule")
		if n, err := strconv.Atoi(name); err == nil && n > 0 {
			ports[n] = true
		}
	}
	return ports
}

// opsScanSystemHooks 让测试替换读系统的几步。
var opsReadFile = os.ReadFile

var opsCommandOutput = func(name string, args ...string) ([]byte, error) {
	if !commandExists(name) {
		return nil, os.ErrNotExist
	}
	return commandCombinedOutputWithTimeout(20*time.Second, name, args...)
}

func opsReadUnitFiles() map[string]string {
	units := map[string]string{}
	for _, dir := range opsUnitDirs {
		matches, _ := filepath.Glob(filepath.Join(dir, "*.service"))
		for _, path := range matches {
			name := strings.TrimSuffix(filepath.Base(path), ".service")
			if _, seen := units[name]; seen || strings.HasPrefix(name, "forwardx") {
				continue
			}
			if target, err := os.Readlink(path); err == nil && target == "/dev/null" {
				units[name] = "" // 被 mask 了
				continue
			}
			raw, err := opsReadFile(path)
			if err != nil || len(raw) > 256*1024 {
				continue
			}
			units[name] = string(raw)
		}
	}
	return units
}

func opsResolveConfigPath(path string, args []string) string {
	if path == "" || filepath.IsAbs(path) {
		return path
	}
	// 相对路径按程序所在目录算（很多一键脚本把配置和程序放在一起）。
	if len(args) > 0 && filepath.IsAbs(args[0]) {
		return filepath.Join(filepath.Dir(args[0]), path)
	}
	return path
}

func opsParseConfigFile(tool, path string) []opsScanItem {
	raw, err := opsReadFile(path)
	if err != nil {
		return []opsScanItem{{Tool: tool, Source: path, Reason: "读不了配置文件：" + err.Error()}}
	}
	var specs []opsForwardSpec
	if tool == "realm" {
		specs, err = parseRealmConfig(path, raw)
	} else {
		specs, err = parseGostConfig(path, raw)
	}
	if err != nil {
		return []opsScanItem{{Tool: tool, Source: path, Reason: "看不懂这份配置：" + err.Error()}}
	}
	return opsItemsFromSpecs(tool, path, "", specs)
}

// opsScanSystem 扫一遍这台机器。
func opsScanSystem() []opsScanItem {
	var items []opsScanItem
	parsedConfigs := map[string]bool{}
	for name, unit := range opsReadUnitFiles() {
		if unit == "" {
			continue
		}
		for _, args := range opsUnitExecStarts(unit) {
			tool := opsToolFromExec(args[0])
			if tool == "" {
				continue
			}
			var unitItems []opsScanItem
			switch tool {
			case "realm":
				configPath, specs := parseRealmArgs(args)
				if configPath != "" {
					configPath = opsResolveConfigPath(configPath, args)
					if opsIsPanelManagedPath(configPath) {
						continue
					}
					parsedConfigs[filepath.Clean(configPath)] = true
					unitItems = opsParseConfigFile(tool, configPath)
				} else {
					unitItems = opsItemsFromSpecs(tool, name+".service", "", specs)
				}
			case "gost":
				configPath, specs := parseGostArgs(args)
				if configPath != "" {
					configPath = opsResolveConfigPath(configPath, args)
					if opsIsPanelManagedPath(configPath) {
						continue
					}
					parsedConfigs[filepath.Clean(configPath)] = true
					unitItems = opsParseConfigFile(tool, configPath)
				} else {
					unitItems = opsItemsFromSpecs(tool, name+".service", "", specs)
				}
			case "socat":
				unitItems = opsItemsFromSpecs(tool, name+".service", "", parseSocatArgs(args))
			}
			active := managedServiceActiveUncached(name)
			for i := range unitItems {
				unitItems[i].Unit = name
				unitItems[i].UnitActive = active
			}
			items = append(items, unitItems...)
		}
	}
	for tool, globs := range map[string][]string{"realm": opsRealmConfigGlobs, "gost": opsGostConfigGlobs} {
		for _, pattern := range globs {
			matches, _ := filepath.Glob(pattern)
			for _, path := range matches {
				if parsedConfigs[filepath.Clean(path)] || opsIsPanelManagedPath(path) {
					continue
				}
				parsedConfigs[filepath.Clean(path)] = true
				for _, item := range opsParseConfigFile(tool, path) {
					if item.Importable || item.ListenPort > 0 {
						if item.Reason == "" {
							item.Reason = "没找到启动它的服务，导入后需要自己停掉原来的进程"
						}
						items = append(items, item)
					}
				}
			}
		}
	}
	for _, family := range []struct{ cmd, kind string }{{"iptables-save", "iptables"}, {"ip6tables-save", "ip6tables"}} {
		if out, err := opsCommandOutput(family.cmd, "-t", "nat"); err == nil {
			items = append(items, opsItemsFromSpecs("iptables", family.cmd, "", parseIptablesSaveNAT(string(out), family.kind))...)
		}
	}
	if out, err := opsCommandOutput("nft", "-j", "list", "ruleset"); err == nil {
		if specs, err := parseNftDNAT(out); err == nil {
			items = append(items, opsItemsFromSpecs("nftables", "nft ruleset", "", specs)...)
		}
	}
	for _, probe := range opsInfoProbes {
		for _, path := range probe.paths {
			if _, err := os.Stat(path); err == nil {
				items = append(items, opsScanItem{Tool: probe.tool, Source: path, Reason: "检测到但不能导入"})
				break
			}
		}
	}
	return opsFinalizeScanItems(items, opsPanelManagedPorts())
}

// managedServiceActiveUncached 查单元是否在跑（不进 Agent 的服务状态缓存，那份缓存只给面板管的服务用）。
func managedServiceActiveUncached(name string) bool {
	name = sanitizeServiceName(name)
	if name == "" || !isSystemdHost() {
		return false
	}
	_, err := commandCombinedOutputWithTimeout(5*time.Second, "systemctl", "is-active", "--quiet", name+".service")
	return err == nil
}
