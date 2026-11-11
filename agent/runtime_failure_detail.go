package main

import (
	"io"
	"os"
	"regexp"
	"strings"
	"time"
)

/*
  用户态转发（realm / socat / nginx / gost）装上之后监听没起来时，说清楚为什么（2.2.256 起）。

  以前面板只收到「managed runtime listener not ready after apply port=… protocol=… forwardType=…」：
  realm 绑 [::] 时报的 Address family not supported、socat 的 socket() 失败、二进制没装，全看不到。
  这里在那句后面补两段（都可以没有）：

    cause=ipv6-unavailable | runtime-missing | address-in-use | permission-denied
    log: 服务自己日志里最后一两行有用的话（去掉时间戳、控制字符，打码 password= / token= 这类）

  面板（server/ruleRuntimeFailureText.ts）按 cause 和日志换成中文原因。整句控制在面板截断的
  300 字以内，日志段最多 240 字。
*/

const (
	runtimeFailureLogMax      = 240
	runtimeFailureMessageMax  = 300
	runtimeFailureLogFreshFor = 3 * time.Minute
	runtimeFailureLogReadMax  = 16 * 1024
)

type runtimeFailureSource struct {
	service string
	logPath string
	binary  string
}

// runtimeFailureEnv 把系统交互抽出来，测试里换成假的。
type runtimeFailureEnv struct {
	systemd    func() bool
	journal    func(service string) string
	readLog    func(path string) string
	executable func(path string) bool
}

func defaultRuntimeFailureEnv() runtimeFailureEnv {
	return runtimeFailureEnv{
		systemd: isSystemdHost,
		journal: func(service string) string {
			out, err := commandCombinedOutputWithTimeout(3*time.Second, "journalctl", "-u", service+".service", "--since=-3min", "-n", "40", "--no-pager", "-o", "cat")
			if err != nil && len(out) == 0 {
				return ""
			}
			return string(out)
		},
		readLog: func(path string) string { return readRecentLogTail(path, time.Now()) },
		executable: func(path string) bool {
			st, err := os.Stat(path)
			return err == nil && !st.IsDir() && st.Mode()&0o111 != 0
		},
	}
}

// readRecentLogTail 读日志文件最后 16KB；文件几分钟没写过就当没有（里面是上次的事，不是这次的原因）。
func readRecentLogTail(path string, now time.Time) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.IsDir() || now.Sub(st.ModTime()) > runtimeFailureLogFreshFor {
		return ""
	}
	if size := st.Size(); size > runtimeFailureLogReadMax {
		if _, err := f.Seek(size-runtimeFailureLogReadMax, io.SeekStart); err != nil {
			return ""
		}
	}
	b, err := io.ReadAll(io.LimitReader(f, runtimeFailureLogReadMax))
	if err != nil {
		return ""
	}
	return string(b)
}

func managedLogPath(service string) string {
	return agentLogDir + "/" + service + ".log"
}

func unitExecBinary(unit string) string {
	fields := strings.Fields(systemdUnitExecStart(unit))
	if len(fields) == 0 {
		return ""
	}
	return strings.TrimLeft(fields[0], "-@:+!")
}

// runtimeFailureSourcesForAction：这条动作的进程是谁、日志在哪、二进制是哪个。
func runtimeFailureSourcesForAction(a action) []runtimeFailureSource {
	switch strings.TrimSpace(a.ForwardType) {
	case "nginx", "nginx-tunnel", "nginx-tunnel-exit":
		return []runtimeFailureSource{{
			service: nginxServiceName,
			logPath: agentLogDir + "/forwardx-nginx-error.log",
			binary:  "/usr/local/bin/forwardx-nginx",
		}}
	case "gost", "gost-tunnel", "gost-tunnel-exit", "gost-tunnel-hop":
		service := runtimeServiceName
		if desiredGostRuntimeScope(a.ForwardType) == desiredGostTunnelRuntimeScope {
			service = tunnelRuntimeServiceName
		}
		return []runtimeFailureSource{{service: service, logPath: managedLogPath(service), binary: gostRuntimeBinaryPath}}
	}
	sources := []runtimeFailureSource{}
	if a.ServiceName != "" {
		sources = append(sources, runtimeFailureSource{service: a.ServiceName, logPath: managedLogPath(a.ServiceName), binary: unitExecBinary(a.Unit)})
	}
	if a.ServiceNameExtra != "" {
		sources = append(sources, runtimeFailureSource{service: a.ServiceNameExtra, logPath: managedLogPath(a.ServiceNameExtra), binary: unitExecBinary(a.UnitExtra)})
	}
	if len(sources) == 0 {
		for _, name := range managedServiceNamesForAction(a) {
			sources = append(sources, runtimeFailureSource{service: name, logPath: managedLogPath(name)})
		}
	}
	return sources
}

var (
	runtimeLogANSIPattern      = regexp.MustCompile(`\x1b\[[0-9;?]*[A-Za-z]`)
	runtimeLogControlPattern   = regexp.MustCompile(`[\x00-\x08\x0b-\x1f\x7f]+`)
	runtimeLogTimestampPattern = regexp.MustCompile(`^(?:\[?\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?\]?\s*)+`)
	runtimeLogSecretPattern    = regexp.MustCompile(`(?i)\b(password|passwd|pass|pwd|token|secret|key|psk|auth|authorization|uuid)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)`)
	runtimeLogURLAuthPattern   = regexp.MustCompile(`://[^/\s:@]+:[^/\s@]+@`)
	runtimeLogUsefulPattern    = regexp.MustCompile(`(?i)fail|error|\berr\b|panic|not supported|in use|denied|no such file|not found|cannot|can't|unable|invalid|refused|unknown|bad |emerg|crit|\bE socket|\bE \w|203/EXEC|exited, code`)
	runtimeLogNoisePattern     = regexp.MustCompile(`(?i)^(?:stack backtrace:|note: |\s*\d+: |\s*at |fd: |log: level|dns: mode|inited: |started |stopped |scheduled restart job|\S+\.service: scheduled restart)`)
	runtimeLogPanicHeadPattern = regexp.MustCompile(`panicked at `)
)

func sanitizeRuntimeLogLine(line string) string {
	line = runtimeLogANSIPattern.ReplaceAllString(line, "")
	line = runtimeLogControlPattern.ReplaceAllString(line, " ")
	line = strings.TrimSpace(line)
	line = runtimeLogTimestampPattern.ReplaceAllString(line, "")
	line = runtimeLogURLAuthPattern.ReplaceAllString(line, "://***@")
	line = runtimeLogSecretPattern.ReplaceAllString(line, "$1$2***")
	return strings.Join(strings.Fields(line), " ")
}

// runtimeLogExcerpt 从一段日志里挑最后一两行说得出原因的话，拼起来不超过 max 字节（按字符截，不切半个汉字）。
func runtimeLogExcerpt(text string, max int) string {
	if max <= 0 {
		return ""
	}
	lines := []string{}
	for _, raw := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		line := sanitizeRuntimeLogLine(raw)
		if line == "" || runtimeLogNoisePattern.MatchString(line) {
			continue
		}
		lines = append(lines, line)
	}
	if len(lines) == 0 {
		return ""
	}
	useful := []string{}
	for _, line := range lines {
		if runtimeLogUsefulPattern.MatchString(line) {
			useful = append(useful, line)
		}
	}
	// 只有「thread 'x' panicked at file:line:」这种只说位置的行时才留它；有具体原因的行就不要它。
	if len(useful) > 1 {
		filtered := useful[:0:0]
		for _, line := range useful {
			if !runtimeLogPanicHeadPattern.MatchString(line) {
				filtered = append(filtered, line)
			}
		}
		if len(filtered) > 0 {
			useful = filtered
		}
	}
	picked := []string{}
	if len(useful) == 0 {
		picked = append(picked, lines[len(lines)-1])
	} else {
		for i := len(useful) - 1; i >= 0 && len(picked) < 2; i-- {
			if len(picked) > 0 && picked[0] == useful[i] {
				continue
			}
			picked = append([]string{useful[i]}, picked...)
		}
	}
	return truncateRuntimeText(strings.Join(picked, " | "), max)
}

func truncateRuntimeText(text string, max int) string {
	if len(text) <= max {
		return text
	}
	cut := max - len("…")
	if cut <= 0 {
		return ""
	}
	for cut > 0 && !isRuneStart(text[cut]) {
		cut--
	}
	return text[:cut] + "…"
}

func isRuneStart(b byte) bool { return b&0xC0 != 0x80 }

var (
	runtimeCauseIPv6Pattern    = regexp.MustCompile(`(?i)address family not supported|os error 97|EAFNOSUPPORT|socket\(10,`)
	runtimeCauseInUsePattern   = regexp.MustCompile(`(?i)address already in use|os error 98|EADDRINUSE`)
	runtimeCausePermPattern    = regexp.MustCompile(`(?i)permission denied|os error 13|EACCES|operation not permitted`)
	runtimeCauseMissingPattern = regexp.MustCompile(`(?i)203/EXEC|failed to (?:locate|execute)|exec: .*not found|: not found|command not found|no such file or directory`)
)

// classifyRuntimeLogCause：从日志里认出最常见的几种原因；认不出返回空串。
func classifyRuntimeLogCause(text string) string {
	switch {
	case runtimeCauseIPv6Pattern.MatchString(text):
		return "ipv6-unavailable"
	case runtimeCauseInUsePattern.MatchString(text):
		return "address-in-use"
	case runtimeCausePermPattern.MatchString(text):
		return "permission-denied"
	case runtimeCauseMissingPattern.MatchString(text):
		return "runtime-missing"
	default:
		return ""
	}
}

// managedRuntimeFailureDetail 返回接在失败原因后面的「cause=…; log: …」，budget 是还剩下的字节数。
func managedRuntimeFailureDetail(a action, env runtimeFailureEnv, budget int) string {
	if budget <= 0 {
		return ""
	}
	sources := runtimeFailureSourcesForAction(a)
	for _, source := range sources {
		if source.binary != "" && env.executable != nil && !env.executable(source.binary) {
			return truncateRuntimeText("cause=runtime-missing binary="+source.binary, budget)
		}
	}
	systemd := env.systemd != nil && env.systemd()
	for _, source := range sources {
		text := ""
		if systemd && env.journal != nil && source.service != "" {
			text = env.journal(source.service)
		}
		if strings.TrimSpace(text) == "" && env.readLog != nil && source.logPath != "" {
			text = env.readLog(source.logPath)
		}
		if strings.TrimSpace(text) == "" {
			continue
		}
		cause := classifyRuntimeLogCause(text)
		prefix := ""
		if cause != "" {
			prefix = "cause=" + cause + "; "
		}
		logBudget := budget - len(prefix) - len("log: ")
		if logBudget > runtimeFailureLogMax {
			logBudget = runtimeFailureLogMax
		}
		excerpt := runtimeLogExcerpt(text, logBudget)
		if excerpt == "" {
			if cause == "" {
				continue
			}
			return strings.TrimSuffix(prefix, "; ")
		}
		return prefix + "log: " + excerpt
	}
	return ""
}

// appendManagedRuntimeFailureDetail 把细节接到已有的失败原因后面，整句不超过 runtimeFailureMessageMax。
func appendManagedRuntimeFailureDetail(message string, a action, env runtimeFailureEnv) string {
	budget := runtimeFailureMessageMax - len(message) - len("; ")
	if detail := managedRuntimeFailureDetail(a, env, budget); detail != "" {
		return message + "; " + detail
	}
	return message
}
