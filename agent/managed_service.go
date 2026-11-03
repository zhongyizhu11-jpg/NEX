package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

func waitForActionListenPortFree(a action, timeout time.Duration) bool {
	spec := a.Fxp
	if spec == nil && a.SourcePort > 0 {
		spec = &fxpSpec{ListenPort: a.SourcePort, Protocol: a.Protocol}
	}
	return waitForFXPListenPortFree(spec, a.SourcePort, timeout)
}

func runPostCommands(commands []string, actionMessage *actionMessage) {
	if len(commands) == 0 {
		return
	}
	if !runShellBatch(commands) {
		if actionMessage != nil {
			actionMessage.remember("non-critical post apply commands failed; forwarding service may still be running")
		}
		logf("post apply commands completed with failures total=%d", len(commands))
	}
}

func writeUnitAndRestart(name, unit string, signature string) bool {
	name = sanitizeServiceName(name)
	if name == "" {
		logf("write service: empty service name")
		return false
	}
	unit = hardenManagedSystemdUnit(unit)
	execStart := systemdUnitExecStart(unit)
	if execStart == "" {
		logf("write service %s: missing ExecStart", name)
		return false
	}
	if isSystemdHost() {
		path := "/etc/systemd/system/" + name + ".service"
		changed, err := writeFileIfChanged(path, []byte(unit), 0644)
		if err != nil {
			logf("write systemd unit %s: %v", name, err)
			return false
		}
		signatureMatches := !changed && managedServiceSignatureMatches(name, signature)
		ok := systemdManagedServiceBatcher.submit(name, changed, signatureMatches)
		cacheManagedServiceActivity(name, ok)
		if ok {
			writeManagedServiceSignature(name, signature)
		}
		return ok
	}
	// OpenWrt / iStoreOS：procd 的 rc.common 脚本，enable 进 /etc/rc.d 开机自启，崩了 procd 拉起来。
	// 要排在下面的 SysV 之前：OpenWrt 也有 /etc/init.d，但不认 update-rc.d，busybox 也没有 nohup。
	if isOpenWrtHost() {
		path := "/etc/init.d/" + name
		changed, err := writeFileIfChanged(path, []byte(procdServiceScript(name, execStart, systemdUnitLimitNOFILE(unit))), 0755)
		if err != nil {
			logf("write procd service %s: %v", name, err)
			return false
		}
		if !changed && managedServiceSignatureMatches(name, signature) && managedServiceActive(name) {
			logVerbosef("service %s unchanged and active; skip restart", name)
			return true
		}
		_ = runManagedServiceCommand(path, "enable")
		ok := runManagedServiceCommand(path, "restart")
		cacheManagedServiceActivity(name, ok)
		if ok {
			writeManagedServiceSignature(name, signature)
		}
		return ok
	}
	if commandExists("rc-service") && commandExists("rc-update") {
		path := "/etc/init.d/" + name
		changed, err := writeFileIfChanged(path, []byte(openRCServiceScript(name, execStart, systemdUnitLimitNOFILE(unit))), 0755)
		if err != nil {
			logf("write openrc service %s: %v", name, err)
			return false
		}
		if !changed && managedServiceSignatureMatches(name, signature) && managedServiceActive(name) {
			logVerbosef("service %s unchanged and active; skip restart", name)
			return true
		}
		_ = runManagedServiceCommand("rc-update", "add", name, "default")
		ok := runManagedServiceCommand("rc-service", name, "restart")
		cacheManagedServiceActivity(name, ok)
		if ok {
			writeManagedServiceSignature(name, signature)
		}
		return ok
	}
	if _, err := os.Stat("/etc/init.d"); err == nil {
		path := "/etc/init.d/" + name
		changed, err := writeFileIfChanged(path, []byte(sysVServiceScript(name, execStart, systemdUnitLimitNOFILE(unit))), 0755)
		if err != nil {
			logf("write sysv service %s: %v", name, err)
			return false
		}
		if !changed && managedServiceSignatureMatches(name, signature) && managedServiceActive(name) {
			logVerbosef("service %s unchanged and active; skip restart", name)
			return true
		}
		if commandExists("update-rc.d") {
			_ = runManagedServiceCommand("update-rc.d", name, "defaults")
		}
		if commandExists("chkconfig") {
			_ = runManagedServiceCommand("chkconfig", name, "on")
		}
		ok := runManagedServiceCommand("/etc/init.d/"+name, "restart")
		cacheManagedServiceActivity(name, ok)
		if ok {
			writeManagedServiceSignature(name, signature)
		}
		return ok
	}
	logf("write service %s: unsupported init system", name)
	return false
}

func writeFileIfChanged(path string, data []byte, perm os.FileMode) (bool, error) {
	if existing, err := os.ReadFile(path); err == nil && bytes.Equal(existing, data) {
		_ = os.Chmod(path, perm)
		return false, nil
	}
	// 服务单元/启动脚本：掉电后留下空文件或半截文件，开机时服务就起不来，
	// 要等 Agent 连上面板重新下发才恢复。只在内容变化时写，原子 + 落盘的开销可以接受。
	if err := writeFileAtomicDurable(path, data, perm); err != nil {
		return false, err
	}
	return true, nil
}

func managedServiceActionSignature(a action, serviceName string, unit string) string {
	h := sha256.New()
	write := func(value string) {
		_, _ = h.Write([]byte(value))
		_, _ = h.Write([]byte{0})
	}
	write(strings.TrimSpace(serviceName))
	write(unit)
	write(a.Op)
	write(a.StatusType)
	write(a.ForwardType)
	write(strconv.Itoa(a.RuleID))
	write(strconv.Itoa(a.TunnelID))
	write(strconv.Itoa(a.SourcePort))
	write(strings.TrimSpace(a.TargetIP))
	write(strconv.Itoa(a.TargetPort))
	write(normalizeRuntimeProtocol(a.Protocol))
	for _, cmd := range a.PreCommands {
		write(cmd)
	}
	for _, cmd := range a.Commands {
		write(cmd)
	}
	for _, cmd := range a.PostCommands {
		write(cmd)
	}
	if a.Failover != nil {
		if raw, err := json.Marshal(a.Failover); err == nil {
			write(string(raw))
		}
	}
	return "sha256:" + hex.EncodeToString(h.Sum(nil))
}

func managedServiceSignaturePath(name string) string {
	return agentStatePath("service_" + name + ".signature")
}

func managedServiceSignatureMatches(name string, signature string) bool {
	signature = strings.TrimSpace(signature)
	if signature == "" {
		return false
	}
	raw, err := os.ReadFile(managedServiceSignaturePath(name))
	return err == nil && strings.TrimSpace(string(raw)) == signature
}

func writeManagedServiceSignature(name string, signature string) {
	signature = strings.TrimSpace(signature)
	if signature == "" {
		return
	}
	_ = writeStateFile(managedServiceSignaturePath(name), []byte(signature+"\n"))
}

func managedServiceActive(name string) bool {
	name = sanitizeServiceName(name)
	if name == "" {
		return false
	}
	if active, ok := cachedManagedServiceActivity(name); ok {
		return active
	}
	active := false
	if isSystemdHost() {
		_, err := commandCombinedOutputWithTimeout(10*time.Second, "systemctl", "is-active", "--quiet", name+".service")
		active = err == nil
	} else if commandExists("rc-service") {
		_, err := commandCombinedOutputWithTimeout(10*time.Second, "rc-service", name, "status")
		active = err == nil
	} else if _, err := os.Stat("/etc/init.d/" + name); err == nil {
		_, err = commandCombinedOutputWithTimeout(10*time.Second, "/etc/init.d/"+name, "status")
		active = err == nil
	}
	cacheManagedServiceActivity(name, active)
	return active
}

func managedServiceNamesForAction(a action) []string {
	port := a.SourcePort
	if port <= 0 {
		return nil
	}
	if a.ServiceName != "" || a.ServiceNameExtra != "" {
		names := []string{}
		if a.ServiceName != "" {
			names = append(names, a.ServiceName)
		}
		if a.ServiceNameExtra != "" {
			names = append(names, a.ServiceNameExtra)
		}
		return names
	}
	switch a.ForwardType {
	case "realm":
		return []string{"forwardx-realm-" + strconv.Itoa(port)}
	case "socat":
		if normalizeRuntimeProtocol(a.Protocol) == "both" {
			return []string{"forwardx-socat-tcp-" + strconv.Itoa(port), "forwardx-socat-udp-" + strconv.Itoa(port)}
		}
		return []string{"forwardx-socat-" + strconv.Itoa(port)}
	default:
		return nil
	}
}

func managedRuleProtocolServiceNames(forwardType string, port int, protocol string) []string {
	groups := localRuleManagedServiceGroups(forwardType, port, protocol)
	seen := map[string]bool{}
	names := make([]string, 0, 4)
	for _, group := range groups {
		for _, name := range group {
			name = sanitizeServiceName(name)
			if name == "" || seen[name] {
				continue
			}
			seen[name] = true
			names = append(names, name)
		}
	}
	return names
}

func cleanupManagedRuleProtocol(forwardType string, port int, protocol string) bool {
	forwardType = strings.TrimSpace(forwardType)
	if forwardType != "realm" && forwardType != "socat" {
		return false
	}
	names := managedRuleProtocolServiceNames(forwardType, port, protocol)
	for _, name := range names {
		cleanupManagedService(name)
		if forwardType == "realm" {
			_ = runShell("rm -f /etc/forwardx/realm/" + name + ".toml /etc/forwardx/realm/" + name + ".toml.sha256 2>/dev/null || true")
		}
	}
	for _, cmd := range managedListenerCleanupCmdsForProtocol(strconv.Itoa(port), protocol) {
		_ = runShell(cmd)
	}
	return len(names) > 0
}

func cleanupLocalManagedRuleServices(a action) {
	if a.RuleID <= 0 || a.SourcePort <= 0 {
		return
	}
	port := strconv.Itoa(a.SourcePort)
	if readRuleIDByPort(port) != a.RuleID {
		return
	}
	forwardType := readForwardTypeByPort(port)
	_, _, protocol, ok := readTargetInfo(port)
	if !ok {
		protocol = a.Protocol
	}
	cleanupManagedRuleProtocol(forwardType, a.SourcePort, protocol)
}

func cleanupManagedService(name string) {
	name = sanitizeServiceName(name)
	if name == "" {
		return
	}
	_ = runShell(managedServiceCleanupShell(name))
	cacheManagedServiceActivity(name, false)
}

var stopManagedServiceProcessForHandoff = stopManagedServiceProcess

var restartManagedServiceProcessForHandoff = restartManagedService

func stopManagedServiceProcess(name string) bool {
	name = sanitizeServiceName(name)
	if name == "" {
		return false
	}
	ok := runShell(managedServiceStopShell(name))
	if ok {
		cacheManagedServiceActivity(name, false)
	}
	return ok
}

func managedServiceStopShell(name string) string {
	name = sanitizeServiceName(name)
	if name == "" {
		return "true"
	}
	q := shellQuote(name)
	return "if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then systemctl stop " + q + ".service 2>/dev/null || true; " +
		"elif command -v rc-service >/dev/null 2>&1; then rc-service " + q + " stop 2>/dev/null || true; " +
		"elif [ -x /etc/init.d/" + name + " ]; then /etc/init.d/" + name + " stop 2>/dev/null || true; fi"
}

func unknownManagedListenerCleanupNeeded(port int, protocol string) bool {
	if !validActionPort(port) {
		return false
	}
	for _, proto := range runtimeProtocols(protocol) {
		if listenPortBusy(proto, port) {
			return true
		}
	}
	for _, name := range managedListenerServiceNamesForProtocol(port, protocol) {
		paths := []string{
			"/etc/systemd/system/" + name + ".service",
			"/etc/init.d/" + name,
			managedServiceSignaturePath(name),
			"/etc/forwardx/realm/" + name + ".toml",
		}
		for _, path := range paths {
			if _, err := os.Stat(path); err == nil {
				return true
			}
		}
	}
	configs, _ := filepath.Glob(fmt.Sprintf("/run/forwardx-agent/fxp-*-%d.json", port))
	if len(configs) > 0 {
		return true
	}
	groupConfigs, _ := filepath.Glob("/run/forwardx-agent/fxp-entry-group-*-*.json")
	for _, path := range groupConfigs {
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var group fxpSpec
		if json.Unmarshal(raw, &group) != nil {
			continue
		}
		for _, entry := range normalizeFXPSpec(group).Entries {
			if entry.ListenPort == port || entry.UDPListenPort == port {
				return true
			}
		}
	}
	return false
}

func restartManagedService(name string) {
	name = sanitizeServiceName(name)
	if name == "" {
		return
	}
	q := shellQuote(name)
	ok := runShell("if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then systemctl reset-failed " + q + ".service 2>/dev/null || true; systemctl restart " + q + ".service; elif command -v rc-service >/dev/null 2>&1; then rc-service " + q + " restart; elif [ -x /etc/init.d/" + name + " ]; then /etc/init.d/" + name + " restart; else exit 1; fi")
	cacheManagedServiceActivity(name, ok)
}

func sanitizeServiceName(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return ""
	}
	for _, r := range name {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.' || r == '@' {
			continue
		}
		return ""
	}
	return name
}

func commandExists(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

func isSystemdHost() bool {
	if !commandExists("systemctl") {
		return false
	}
	if st, err := os.Stat("/run/systemd/system"); err == nil && st.IsDir() {
		return true
	}
	return false
}

func systemdUnitExecStart(unit string) string {
	for _, line := range strings.Split(unit, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "ExecStart=") {
			return strings.TrimSpace(strings.TrimPrefix(line, "ExecStart="))
		}
	}
	return ""
}

// managedServiceDefaultNOFILE 是单元没写 LimitNOFILE（或写了 infinity / 看不懂的值）时
// OpenRC / SysV 脚本里设的文件描述符上限。和内核默认的 fs.nr_open 一样大；转发程序每条
// 连接占两个描述符，发行版默认的 1024 撑不了几百个并发。
const managedServiceDefaultNOFILE = "1048576"

// systemdUnitLimitNOFILE 取单元 [Service] 里的 LimitNOFILE，原样返回（"65535" 或
// "软:硬"）；没有就返回空串。
func systemdUnitLimitNOFILE(unit string) string {
	value := ""
	inService := false
	for _, line := range strings.Split(strings.ReplaceAll(unit, "\r\n", "\n"), "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]") {
			inService = strings.EqualFold(trimmed, "[Service]")
			continue
		}
		if !inService {
			continue
		}
		if key, raw, ok := strings.Cut(trimmed, "="); ok && strings.EqualFold(strings.TrimSpace(key), "LimitNOFILE") {
			// systemd 以最后一次出现的为准。
			value = strings.TrimSpace(raw)
		}
	}
	return value
}

// managedServiceNOFILEShell 把 LimitNOFILE 换成 sh 的 ulimit。转成 OpenRC / SysV 脚本以后
// systemd 的 Limit* 不再生效，以前这些服务只能用发行版默认的 1024 个描述符，并发一多就
// 报 too many open files。只接受纯数字（防止单元里的值被当成命令拼进脚本），其余情况用
// 默认值；硬上限不允许时静默保持原样，不影响服务启动。
func managedServiceNOFILEShell(limit string) string {
	isNumber := func(value string) bool {
		if value == "" || len(value) > 10 {
			return false
		}
		for _, c := range value {
			if c < '0' || c > '9' {
				return false
			}
		}
		return value != "0"
	}
	limit = strings.TrimSpace(limit)
	if soft, hard, ok := strings.Cut(limit, ":"); ok {
		soft, hard = strings.TrimSpace(soft), strings.TrimSpace(hard)
		if isNumber(soft) && isNumber(hard) {
			return "ulimit -Hn " + hard + " 2>/dev/null || true; ulimit -Sn " + soft + " 2>/dev/null || true; "
		}
		limit = ""
	}
	if !isNumber(limit) {
		limit = managedServiceDefaultNOFILE
	}
	return "ulimit -n " + limit + " 2>/dev/null || true; "
}

func hardenManagedSystemdUnit(unit string) string {
	lines := strings.Split(strings.ReplaceAll(unit, "\r\n", "\n"), "\n")
	serviceIndex := -1
	existing := map[string]bool{}
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.EqualFold(trimmed, "[Service]") {
			serviceIndex = i
			continue
		}
		if serviceIndex < 0 || (strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]")) {
			if serviceIndex >= 0 && i > serviceIndex {
				break
			}
			continue
		}
		if key, _, ok := strings.Cut(trimmed, "="); ok {
			existing[strings.ToLower(strings.TrimSpace(key))] = true
		}
	}
	if serviceIndex < 0 {
		return unit
	}
	directives := []string{
		"LimitCORE=0",
		"LogRateLimitIntervalSec=30s",
		"LogRateLimitBurst=200",
	}
	insert := make([]string, 0, len(directives))
	for _, directive := range directives {
		key, _, _ := strings.Cut(directive, "=")
		if !existing[strings.ToLower(key)] {
			insert = append(insert, directive)
		}
	}
	if len(insert) == 0 {
		return strings.Join(lines, "\n")
	}
	result := make([]string, 0, len(lines)+len(insert))
	result = append(result, lines[:serviceIndex+1]...)
	result = append(result, insert...)
	result = append(result, lines[serviceIndex+1:]...)
	return strings.Join(result, "\n")
}

// isOpenWrtHost 是 OpenWrt 系（含 iStoreOS、ImmortalWrt）：procd 管服务，/etc/init.d 下是 rc.common 脚本。
func isOpenWrtHost() bool {
	if _, err := os.Stat("/etc/openwrt_release"); err != nil {
		return false
	}
	_, err := os.Stat("/etc/rc.common")
	return err == nil
}

// procdServiceScript 是 OpenWrt 的服务脚本：procd 起进程、崩了按 respawn 拉起；输出照旧写到 Agent 的日志目录
// （OpenWrt 的 /var 在内存里，重启就清空）。
func procdServiceScript(name, execStart, limitNOFILE string) string {
	cmd := managedServiceNOFILEShell(limitNOFILE) + "ulimit -c 0 2>/dev/null || true; exec " + execStart + " >> /var/log/forwardx-agent/" + name + ".log 2>&1"
	return strings.Join([]string{
		"#!/bin/sh /etc/rc.common",
		"# ForwardX managed service " + name,
		"USE_PROCD=1",
		"START=95",
		"STOP=10",
		"start_service() {",
		"  mkdir -p /var/log/forwardx-agent",
		"  procd_open_instance",
		"  procd_set_param command /bin/sh -c " + shellQuote(cmd),
		"  procd_set_param respawn 3600 5 0",
		"  procd_close_instance",
		"}",
		"",
	}, "\n")
}

func openRCServiceScript(name, execStart, limitNOFILE string) string {
	return strings.Join([]string{
		"#!/sbin/openrc-run",
		"name=\"" + name + "\"",
		"description=\"ForwardX managed service " + name + "\"",
		"command=\"/bin/sh\"",
		"command_args=\"-lc " + shellQuote(managedServiceNOFILEShell(limitNOFILE)+"ulimit -c 0 2>/dev/null || true; exec "+execStart) + "\"",
		"command_background=true",
		"pidfile=\"/run/${RC_SVCNAME}.pid\"",
		"output_log=\"/var/log/forwardx-agent/${RC_SVCNAME}.log\"",
		"error_log=\"/var/log/forwardx-agent/${RC_SVCNAME}.log\"",
		"depend() {",
		"  need net",
		"}",
		"",
	}, "\n")
}

func sysVServiceScript(name, execStart, limitNOFILE string) string {
	quotedCmd := shellQuote(managedServiceNOFILEShell(limitNOFILE) + "ulimit -c 0 2>/dev/null || true; exec " + execStart)
	return strings.Join([]string{
		"#!/bin/sh",
		"### BEGIN INIT INFO",
		"# Provides:          " + name,
		"# Required-Start:    $network",
		"# Required-Stop:     $network",
		"# Default-Start:     2 3 4 5",
		"# Default-Stop:      0 1 6",
		"# Short-Description: ForwardX managed service " + name,
		"### END INIT INFO",
		"PIDFILE=/run/" + name + ".pid",
		"LOGFILE=/var/log/forwardx-agent/" + name + ".log",
		"CMD=" + quotedCmd,
		"start() {",
		"  mkdir -p /run /var/log/forwardx-agent",
		"  if [ -s \"$PIDFILE\" ] && kill -0 \"$(cat \"$PIDFILE\")\" 2>/dev/null; then return 0; fi",
		"  nohup sh -lc \"$CMD\" >> \"$LOGFILE\" 2>&1 &",
		"  echo $! > \"$PIDFILE\"",
		"}",
		"stop() {",
		"  if [ -s \"$PIDFILE\" ]; then kill \"$(cat \"$PIDFILE\")\" 2>/dev/null || true; rm -f \"$PIDFILE\"; fi",
		"}",
		"case \"$1\" in",
		"  start) start ;;",
		"  stop) stop ;;",
		"  restart) stop; sleep 1; start ;;",
		"  status) [ -s \"$PIDFILE\" ] && kill -0 \"$(cat \"$PIDFILE\")\" 2>/dev/null ;;",
		"  *) echo \"Usage: $0 {start|stop|restart|status}\"; exit 1 ;;",
		"esac",
		"",
	}, "\n")
}

func managedServiceCleanupShell(name string) string {
	q := shellQuote(name)
	return "if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then systemctl stop " + q + ".service 2>/dev/null || true; systemctl disable " + q + ".service 2>/dev/null || true; systemd_unit=/etc/systemd/system/" + name + ".service; systemd_removed=0; if [ -e \"$systemd_unit\" ]; then rm -f \"$systemd_unit\"; systemd_removed=1; fi; if [ \"$systemd_removed\" = \"1\" ]; then systemctl daemon-reload 2>/dev/null || true; fi; systemctl reset-failed " + q + ".service 2>/dev/null || true; fi; " +
		"if command -v rc-service >/dev/null 2>&1; then rc-service " + q + " stop 2>/dev/null || true; fi; " +
		"if command -v rc-update >/dev/null 2>&1; then rc-update del " + q + " default 2>/dev/null || true; fi; " +
		"if [ -x /etc/init.d/" + name + " ]; then /etc/init.d/" + name + " stop 2>/dev/null || true; fi; " +
		// OpenWrt：去掉 /etc/rc.d 里的开机链接，不然删了脚本还留着悬空链接。
		"if [ -f /etc/openwrt_release ] && [ -x /etc/init.d/" + name + " ]; then /etc/init.d/" + name + " disable >/dev/null 2>&1 || true; fi; " +
		"if command -v update-rc.d >/dev/null 2>&1; then update-rc.d -f " + q + " remove >/dev/null 2>&1 || true; fi; " +
		"if command -v chkconfig >/dev/null 2>&1; then chkconfig " + q + " off >/dev/null 2>&1 || true; fi; " +
		"rm -f /etc/init.d/" + name + " /var/lib/forwardx-agent/service_" + name + ".signature /var/log/forwardx-agent/" + name + ".log"
}
