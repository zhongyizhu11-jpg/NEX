package main

import (
	"errors"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// iptables 的 xtables 锁：另一个进程（firewalld、docker、面板下发的其它动作）正持有锁时，
// 不带 -w 的 iptables 会立刻以退出码 4 失败。`-C || -A` 这种“确保存在”的写法会把
// “锁忙”当成“规则不存在”而重复追加，计数规则因此被数两遍；删除循环则会提前退出留下残留。
//
// 面板下发的命令与 Agent 自己拼的命令统一写成 `iptables $FWX_IPT_WAIT ...`，
// 由 Agent 在执行 shell 时注入这个环境变量：
//   - iptables >= 1.6（含所有 iptables-nft）：`-w 5`，最多等 5 秒；
//   - 1.4.20 ~ 1.5.x（如 CentOS 7 的 1.4.21）：只认不带秒数的 `-w`，写成 `-w 5` 会把 5
//     当成多余参数直接报错，所以只给 `-w`（外层 shell 有超时兜底）；
//   - 更老或探测失败：留空，行为与旧版一致。
//
// 旧 Agent 不注入这个变量，展开为空，新面板配旧 Agent 也保持旧行为。
const iptablesWaitEnvName = "FWX_IPT_WAIT"

// iptablesWaitShellArg 是拼进 shell 命令里的占位，由 shellCommandEnv 注入真实值。
const iptablesWaitShellArg = "$" + iptablesWaitEnvName

const iptablesWaitProbeRetryInterval = time.Minute

var iptablesVersionPattern = regexp.MustCompile(`v([0-9]+)\.([0-9]+)(?:\.([0-9]+))?`)

var iptablesWaitProbe struct {
	mu          sync.Mutex
	value       string
	resolved    bool
	lastAttempt time.Time
}

// iptablesExecMu 串行化 Agent 自己发起的 iptables 调用（快照、计数修复、残留清理）。
// 进程内并发的 iptables 调用只会互相抢 xtables 锁，串行化后 -w 基本不需要真的等待。
// 只在叶子调用处持有，调用期间不得再去拿同一把锁。
var iptablesExecMu sync.Mutex

func iptablesWaitFlagForVersion(output string) string {
	text := strings.ToLower(output)
	if strings.Contains(text, "nf_tables") {
		return "-w 5"
	}
	match := iptablesVersionPattern.FindStringSubmatch(text)
	if len(match) < 3 {
		return ""
	}
	major, _ := strconv.Atoi(match[1])
	minor, _ := strconv.Atoi(match[2])
	patch := 0
	if len(match) >= 4 && match[3] != "" {
		patch, _ = strconv.Atoi(match[3])
	}
	version := major*1_000_000 + minor*1_000 + patch
	switch {
	case version >= 1_006_000:
		return "-w 5"
	case version >= 1_004_020:
		return "-w"
	default:
		return ""
	}
}

// iptablesWaitFlag 返回当前主机 iptables 支持的锁等待参数。探测成功后缓存；
// 还没装 iptables 时每分钟最多重探一次，装上之后自动生效。
func iptablesWaitFlag() string {
	iptablesWaitProbe.mu.Lock()
	defer iptablesWaitProbe.mu.Unlock()
	if iptablesWaitProbe.resolved {
		return iptablesWaitProbe.value
	}
	now := time.Now()
	if !iptablesWaitProbe.lastAttempt.IsZero() && now.Sub(iptablesWaitProbe.lastAttempt) < iptablesWaitProbeRetryInterval {
		return iptablesWaitProbe.value
	}
	iptablesWaitProbe.lastAttempt = now
	for _, binary := range iptablesAgentBinaries() {
		if _, err := exec.LookPath(binary); err != nil {
			continue
		}
		out, err := commandCombinedOutputWithTimeout(3*time.Second, binary, "--version")
		if err != nil {
			continue
		}
		iptablesWaitProbe.value = iptablesWaitFlagForVersion(string(out))
		iptablesWaitProbe.resolved = true
		break
	}
	return iptablesWaitProbe.value
}

func iptablesWaitArgs() []string {
	return strings.Fields(iptablesWaitFlag())
}

// iptablesDirectCommandTimeout 给直接 exec 的 iptables 调用留出 -w 5 的等待时间。
const iptablesDirectCommandTimeout = 10 * time.Second

// iptablesCommandOutput 直接执行一条 iptables/ip6tables（不经 shell），带锁等待参数并串行化。
func iptablesCommandOutput(binary string, args ...string) ([]byte, error) {
	full := append(iptablesWaitArgs(), args...)
	iptablesExecMu.Lock()
	defer iptablesExecMu.Unlock()
	return commandOutputWithTimeout(iptablesDirectCommandTimeout, binary, full...)
}

// iptablesBinaryMissing 区分“没装这个二进制”（按空结果处理）与“执行失败”（结果不可信）。
func iptablesBinaryMissing(err error) bool {
	return err != nil && errors.Is(err, exec.ErrNotFound)
}

// runIptablesShellBatch / runIptablesShellQuiet 用于 Agent 自己拼出来的 iptables 命令，
// 与直接 exec 的调用共用同一把进程内锁。
func runIptablesShellBatch(commands []string) bool {
	iptablesExecMu.Lock()
	defer iptablesExecMu.Unlock()
	return runShellBatch(commands)
}

func runIptablesShellQuiet(command string) bool {
	iptablesExecMu.Lock()
	defer iptablesExecMu.Unlock()
	return runShellQuiet(command)
}
