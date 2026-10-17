package main

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// 普通端口转发的单 IP 接入限制（每个来源 IP 的 TCP 并发连接数；面板 server/portAccessLimits.ts，Agent 2.2.229 起）。
//
// 面板按「这台入口机 + 用户」下发一份完整快照（空快照 = 撤销全部限制），这里在 mangle 表
// 上对齐：
//   - 每个用户一条计数链 FWX_PC_<hash(用户, 阈值)>，规则增删只改分发链 FWX_PD_<hash(快照)>，
//     已经在计的连接不会被清零；只有阈值本身变了才换一条新的计数链；
//   - 钩子只看新建的 SYN（--ctstate NEW --ctdir ORIGINAL --dst-type LOCAL），不碰已建立
//     的连接，也不重启任何转发进程；
//   - mangle 在 DNAT 之前，内核转发（iptables / nftables）和进程转发（realm / gost ……）
//     看到的都是同一个原始入口端口；OUTPUT 顺带覆盖本机发起的连接，PREROUTING 排除 lo，
//     免得本机的一个 SYN 先过 OUTPUT 再过 lo 的 PREROUTING 被数两次。
//
// 准备失败时保留之前的钩子和计数链：限制宁可暂时是旧的，也不能把转发弄断。
type portAccessLimitSpec struct {
	UserID int   `json:"userId"`
	MaxIPs int   `json:"maxIPs"`
	Ports  []int `json:"ports"`
}

const portAccessLimitForwardType = "port-access-limit-sync"

type portLimitFirewall interface {
	Available(string) bool
	IPv6Enabled() bool
	Run(string, ...string) (string, error)
}

type systemPortLimitFirewall struct{}

var portLimitHealth struct {
	sync.Mutex
	signature string
	checkedAt time.Time
}

func isPortAccessLimitAction(a action) bool {
	return strings.TrimSpace(a.ForwardType) == portAccessLimitForwardType
}

func rememberPortLimitHealth(a action, ok bool) {
	portLimitHealth.Lock()
	defer portLimitHealth.Unlock()
	portLimitHealth.signature = actionCommandSignature(a)
	portLimitHealth.checkedAt = time.Time{}
	if ok {
		portLimitHealth.checkedAt = time.Now()
	}
}

// portAccessLimitsReady 是期望状态的健康检查：最近对齐成功过就直接信；否则只读核对一遍。
func portAccessLimitsReady(a action) bool {
	portLimitHealth.Lock()
	recent := portLimitHealth.signature == actionCommandSignature(a) && !portLimitHealth.checkedAt.IsZero() && time.Since(portLimitHealth.checkedAt) < accessLimitMaintenanceInterval
	portLimitHealth.Unlock()
	if recent {
		return true
	}
	ok := syncPortAccessLimits(systemPortLimitFirewall{}, a.PortAccessLimits, true) == nil
	rememberPortLimitHealth(a, ok)
	return ok
}

// applyPortAccessLimitAction 是动作队列里真正执行的那一步。
func applyPortAccessLimitAction(cfg Config, a action, msg *actionMessage) bool {
	err := syncPortAccessLimits(systemPortLimitFirewall{}, a.PortAccessLimits, false)
	ok := err == nil
	rememberPortLimitHealth(a, ok)
	rememberRuntimeActionResult(a, ok)
	if err != nil {
		msg.set("%v", err)
		if shouldLogAgentReport("port-access-limit-sync", agentReportLogInterval) {
			logf("%v", err)
		}
	} else {
		msg.set("TCP port access limits synchronized users=%d; existing forwarding connections preserved", len(a.PortAccessLimits))
	}
	if a.ReportStatus != nil && *a.ReportStatus {
		reportActionStatus(cfg, a, ok, msg.get())
	}
	return ok
}

func (systemPortLimitFirewall) Available(binary string) bool { return commandExists(binary) }

func (systemPortLimitFirewall) IPv6Enabled() bool {
	data, err := os.ReadFile("/proc/sys/net/ipv6/conf/all/disable_ipv6")
	return err == nil && strings.TrimSpace(string(data)) != "1"
}

func (systemPortLimitFirewall) Run(binary string, args ...string) (string, error) {
	out, err := iptablesCommandOutput(binary, append([]string{"-t", "mangle"}, args...)...)
	if err != nil {
		return string(out), fmt.Errorf("%s: %s", binary, compactShellFailureOutput(out, err, false))
	}
	return string(out), nil
}

func portLimitChain(prefix string, value any) string {
	raw, _ := json.Marshal(value)
	hash := sha256.Sum256(raw)
	return fmt.Sprintf("%s%x", prefix, hash[:10])
}

func normalizedPortLimits(specs []portAccessLimitSpec) ([]portAccessLimitSpec, error) {
	out := make([]portAccessLimitSpec, 0, len(specs))
	users, ports := map[int]bool{}, map[int]bool{}
	for _, spec := range specs {
		if spec.UserID <= 0 || spec.MaxIPs < 0 || users[spec.UserID] {
			return nil, fmt.Errorf("invalid or duplicate port access limit user=%d", spec.UserID)
		}
		users[spec.UserID] = true
		if spec.MaxIPs == 0 {
			continue
		}
		seen := map[int]bool{}
		copySpec := spec
		copySpec.Ports = nil
		for _, port := range spec.Ports {
			if port < 1 || port > 65535 || (ports[port] && !seen[port]) {
				return nil, fmt.Errorf("invalid or overlapping port access limit port=%d", port)
			}
			if !seen[port] {
				copySpec.Ports = append(copySpec.Ports, port)
			}
			seen[port], ports[port] = true, true
		}
		sort.Ints(copySpec.Ports)
		if len(copySpec.Ports) > 0 {
			out = append(out, copySpec)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UserID < out[j].UserID })
	return out, nil
}

// portLimitCounterChain 只由用户和阈值决定，与端口无关：加减端口不会换计数链、不清零计数。
func portLimitCounterChain(spec portAccessLimitSpec) string {
	return portLimitChain("FWX_PC_", []int{spec.UserID, spec.MaxIPs})
}

func portLimitRules(specs []portAccessLimitSpec, ipv6 bool) (string, map[string][][]string) {
	rules := map[string][][]string{}
	if len(specs) == 0 {
		return "", rules
	}
	dispatch := portLimitChain("FWX_PD_", specs)
	mask := "32"
	if ipv6 {
		mask = "128"
	}
	for _, spec := range specs {
		counter := portLimitCounterChain(spec)
		// 每个来源地址的并发 TCP 连接超过上限就丢新 SYN。
		rules[counter] = append(rules[counter], []string{"-p", "tcp", "-m", "connlimit", "--connlimit-above", strconv.Itoa(spec.MaxIPs), "--connlimit-mask", mask, "--connlimit-saddr", "-j", "DROP"})
		rules[counter] = append(rules[counter], []string{"-j", "RETURN"})
		for start := 0; start < len(spec.Ports); start += 15 {
			end := start + 15
			if end > len(spec.Ports) {
				end = len(spec.Ports)
			}
			ports := make([]string, 0, end-start)
			for _, port := range spec.Ports[start:end] {
				ports = append(ports, strconv.Itoa(port))
			}
			rules[dispatch] = append(rules[dispatch], []string{"-p", "tcp", "-m", "multiport", "--dports", strings.Join(ports, ","), "-j", counter})
		}
	}
	rules[dispatch] = append(rules[dispatch], []string{"-j", "RETURN"})
	return dispatch, rules
}

func portLimitHook(dispatch, base string) []string {
	args := []string{"-p", "tcp", "-m", "tcp", "--syn", "-m", "conntrack", "--ctstate", "NEW", "--ctdir", "ORIGINAL", "-m", "addrtype", "--dst-type", "LOCAL"}
	if base == "PREROUTING" {
		args = append(args, "!", "-i", "lo")
	}
	return append(args, "-j", dispatch)
}

func managedPortLimitChain(name string) bool {
	if !strings.HasPrefix(name, "FWX_PD_") && !strings.HasPrefix(name, "FWX_PC_") {
		return false
	}
	if len(name) != 27 {
		return false
	}
	for _, char := range name[7:] {
		if !strings.ContainsRune("0123456789abcdef", char) {
			return false
		}
	}
	return true
}

// reconcilePortLimitFamily 从不清空正在用的计数链、nat 表或任何转发运行时。checkOnly 只读。
func reconcilePortLimitFamily(fw portLimitFirewall, binary string, specs []portAccessLimitSpec, checkOnly bool) error {
	dispatch, desired := portLimitRules(specs, binary == "ip6tables")
	snapshot, err := fw.Run(binary, "-S")
	if err != nil {
		return err
	}
	existing := map[string]bool{}
	var obsoleteHooks [][]string
	for _, line := range strings.Split(snapshot, "\n") {
		args := strings.Fields(line)
		if len(args) == 2 && args[0] == "-N" && managedPortLimitChain(args[1]) {
			existing[args[1]] = true
		}
		if len(args) >= 4 && args[0] == "-A" && (args[1] == "PREROUTING" || args[1] == "OUTPUT") && args[len(args)-2] == "-j" && managedPortLimitChain(args[len(args)-1]) && args[len(args)-1] != dispatch {
			obsoleteHooks = append(obsoleteHooks, args)
		}
	}
	// 先建计数链、再建分发链，规则全部就位之后才挂钩子。
	names := make([]string, 0, len(desired))
	for name := range desired {
		if name != dispatch {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	if dispatch != "" {
		names = append(names, dispatch)
	}
	for _, name := range names {
		if !existing[name] {
			if checkOnly {
				return fmt.Errorf("%s limit chain missing", binary)
			}
			if _, err := fw.Run(binary, "-N", name); err != nil {
				return err
			}
		}
		for _, rule := range desired[name] {
			if _, err := fw.Run(binary, append([]string{"-C", name}, rule...)...); err == nil {
				continue
			}
			if checkOnly {
				return fmt.Errorf("%s limit rule missing", binary)
			}
			// 缺的规则插到 RETURN 前面（顺带修好上次装了一半的链）。
			operation := []string{"-I", name, "1"}
			if len(rule) == 2 && rule[0] == "-j" && rule[1] == "RETURN" {
				operation = []string{"-A", name}
			}
			if _, err := fw.Run(binary, append(operation, rule...)...); err != nil {
				return err
			}
		}
	}
	if dispatch != "" {
		for _, base := range []string{"PREROUTING", "OUTPUT"} {
			args := portLimitHook(dispatch, base)
			if _, err := fw.Run(binary, append([]string{"-C", base}, args...)...); err == nil {
				continue
			}
			if checkOnly {
				return fmt.Errorf("%s limit hook missing", binary)
			}
			if _, err := fw.Run(binary, append([]string{"-I", base, "1"}, args...)...); err != nil {
				return err
			}
		}
	}
	if checkOnly {
		if len(obsoleteHooks) > 0 {
			return fmt.Errorf("%s stale limit hooks", binary)
		}
		for name := range existing {
			if desired[name] == nil {
				return fmt.Errorf("%s stale limit chain", binary)
			}
		}
		return nil
	}
	for _, hook := range obsoleteHooks {
		hook[0] = "-D"
		if _, err := fw.Run(binary, hook...); err != nil {
			return err
		}
	}
	// 先删用不上的分发链，再删已经没人引用的计数链。
	for _, prefix := range []string{"FWX_PD_", "FWX_PC_"} {
		stale := make([]string, 0)
		for name := range existing {
			if strings.HasPrefix(name, prefix) && desired[name] == nil {
				stale = append(stale, name)
			}
		}
		sort.Strings(stale)
		for _, name := range stale {
			if _, err := fw.Run(binary, "-F", name); err != nil {
				return err
			}
			if _, err := fw.Run(binary, "-X", name); err != nil {
				return err
			}
		}
	}
	return nil
}

func syncPortAccessLimits(fw portLimitFirewall, specs []portAccessLimitSpec, checkOnly bool) error {
	normalized, err := normalizedPortLimits(specs)
	if err != nil {
		return err
	}
	var failures []string
	for _, binary := range []string{"iptables", "ip6tables"} {
		required := binary == "iptables" || fw.IPv6Enabled()
		if !fw.Available(binary) {
			if required && len(normalized) > 0 {
				failures = append(failures, binary+" missing")
			}
			continue
		}
		if !required {
			continue
		}
		if err := reconcilePortLimitFamily(fw, binary, normalized, checkOnly); err != nil {
			failures = append(failures, err.Error())
		}
	}
	if len(failures) > 0 {
		return fmt.Errorf("TCP port access limits not fully applied: %s; forwarding remains active", strings.Join(failures, "; "))
	}
	return nil
}
