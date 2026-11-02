package main

// 跑 shell 命令的几个入口（runShell 系列）和 shellQuote，从 main.go 原样搬过来，行为不变。
// 拼进命令的面板字段要先 shellQuote 或先校验（端口用 shellSafePort）。

import (
	"context"
	"fmt"
	"hash/fnv"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const actionShellTimeout = 90 * time.Second
const actionShellSlowThreshold = 5 * time.Second
const shellInlineMaxBytes = 8 * 1024

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'"
}

// shellSafePort 判断要直接拼进 shell 命令（iptables / nft / awk / pgrep 模式、文件名）的端口文本
// 是不是 1-65535 的纯数字。端口大多来自 strconv.Itoa，但也有从状态目录文件名、iptables 输出里
// 读回来的；这里是最后一道防线，不是数字就不拼命令。
func shellSafePort(port string) bool {
	if len(port) == 0 || len(port) > 5 {
		return false
	}
	value := 0
	for i := 0; i < len(port); i++ {
		c := port[i]
		if c < '0' || c > '9' {
			return false
		}
		value = value*10 + int(c-'0')
	}
	return value >= 1 && value <= 65535
}

// unsafeShellPortNoop 记一条日志并返回一条什么都不做的命令。
func unsafeShellPortNoop(where string, port string) string {
	if shouldLogAgentReport("unsafe-shell-port:"+where, agentReportLogInterval) {
		logf("refused to build shell command with invalid port where=%s port=%q", where, port)
	}
	return "true"
}

func runShell(cmd string) bool {
	ok, _ := runShellWithOutput(cmd)
	return ok
}

func runShellWithOutput(cmd string) (bool, string) {
	if len(cmd) > shellInlineMaxBytes {
		logVerbosef("exec: long shell command bytes=%d via temp script", len(cmd))
	} else {
		logVerbosef("exec: %s", cmd)
	}
	started := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), actionShellTimeout)
	defer cancel()
	c, cleanup, viaTemp, err := shellCommand(ctx, cmd)
	if err != nil {
		logf("exec failed before start err=%v %s", err, shellCommandLogSummary(cmd))
		return false, compactShellFailureOutput(nil, err, false)
	}
	out, err := c.CombinedOutput()
	cleanup()
	retriedViaTemp := false
	if isArgumentListTooLong(err) && !viaTemp && ctx.Err() != context.DeadlineExceeded {
		logf("exec retry via temp script after argument list too long bytes=%d", len(cmd))
		c, cleanup, _, err = shellCommandTempScript(ctx, cmd)
		if err != nil {
			logf("exec failed before temp retry err=%v %s", err, shellCommandLogSummary(cmd))
			return false, compactShellFailureOutput(nil, err, false)
		}
		retriedViaTemp = true
		viaTemp = true
		out, err = c.CombinedOutput()
		cleanup()
	}
	elapsed := time.Since(started)
	if len(out) > 0 && (err != nil || ctx.Err() == context.DeadlineExceeded || agentVerboseLogs) {
		logf("%s", strings.TrimSpace(string(out)))
	}
	if ctx.Err() == context.DeadlineExceeded {
		logf("exec timeout duration=%s temp=%v retriedTemp=%v outputBytes=%d %s", elapsed.Round(time.Millisecond), viaTemp, retriedViaTemp, len(out), shellCommandLogSummary(cmd))
		return false, compactShellFailureOutput(out, ctx.Err(), true)
	}
	if err != nil {
		logf("exec failed duration=%s temp=%v retriedTemp=%v outputBytes=%d err=%v %s", elapsed.Round(time.Millisecond), viaTemp, retriedViaTemp, len(out), err, shellCommandLogSummary(cmd))
		return false, compactShellFailureOutput(out, err, false)
	}
	if elapsed >= actionShellSlowThreshold {
		logf("exec slow duration=%s temp=%v retriedTemp=%v outputBytes=%d %s", elapsed.Round(time.Millisecond), viaTemp, retriedViaTemp, len(out), shellCommandLogSummary(cmd))
	}
	return true, ""
}

func runShellQuiet(cmd string) bool {
	if strings.TrimSpace(cmd) == "" {
		return true
	}
	started := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, cleanup, viaTemp, err := shellCommand(ctx, cmd)
	if err != nil {
		return false
	}
	err = c.Run()
	cleanup()
	retriedViaTemp := false
	if isArgumentListTooLong(err) && !viaTemp && ctx.Err() != context.DeadlineExceeded {
		c, cleanup, _, err = shellCommandTempScript(ctx, cmd)
		if err != nil {
			return false
		}
		retriedViaTemp = true
		viaTemp = true
		err = c.Run()
		cleanup()
	}
	elapsed := time.Since(started)
	ok := err == nil && ctx.Err() != context.DeadlineExceeded
	if ctx.Err() == context.DeadlineExceeded {
		logf("exec quiet timeout duration=%s temp=%v retriedTemp=%v %s", elapsed.Round(time.Millisecond), viaTemp, retriedViaTemp, shellCommandLogSummary(cmd))
	} else if elapsed >= actionShellSlowThreshold {
		logf("exec quiet slow ok=%v duration=%s temp=%v retriedTemp=%v %s", ok, elapsed.Round(time.Millisecond), viaTemp, retriedViaTemp, shellCommandLogSummary(cmd))
	}
	return ok
}

func runShellBatch(commands []string) bool {
	ok, _ := runShellBatchWithOutput(commands)
	return ok
}

func runShellBatchWithOutput(commands []string) (bool, string) {
	filtered := make([]string, 0, len(commands))
	for _, cmd := range commands {
		if strings.TrimSpace(cmd) != "" {
			filtered = append(filtered, cmd)
		}
	}
	if len(filtered) == 0 {
		return true, ""
	}
	if len(filtered) == 1 {
		return runShellWithOutput(filtered[0])
	}
	var script strings.Builder
	script.WriteString("set +e\n")
	script.WriteString("__forwardx_status=0\n")
	for _, cmd := range filtered {
		script.WriteString("(\n")
		script.WriteString(cmd)
		script.WriteString("\n) || __forwardx_status=1\n")
	}
	script.WriteString("exit $__forwardx_status\n")
	return runShellWithOutput(script.String())
}

func compactShellFailureOutput(out []byte, err error, timedOut bool) string {
	detail := strings.Join(strings.Fields(string(out)), " ")
	if detail == "" {
		switch {
		case timedOut:
			detail = "command timed out"
		case err != nil:
			detail = err.Error()
		}
	}
	const maxRunes = 240
	runes := []rune(detail)
	if len(runes) > maxRunes {
		return "..." + string(runes[len(runes)-(maxRunes-3):])
	}
	return detail
}

func isArgumentListTooLong(err error) bool {
	return err != nil && strings.Contains(strings.ToLower(err.Error()), "argument list too long")
}

func shellCommandLogSummary(cmd string) string {
	h := fnv.New64a()
	_, _ = h.Write([]byte(cmd))
	return fmt.Sprintf("cmdHash=%016x cmdBytes=%d", h.Sum64(), len(cmd))
}

func shellCommand(ctx context.Context, cmd string) (*exec.Cmd, func(), bool, error) {
	if len(cmd) <= shellInlineMaxBytes {
		c := exec.CommandContext(ctx, "sh", "-c", cmd)
		prepareShellCommand(c)
		return c, func() {}, false, nil
	}
	return shellCommandTempScript(ctx, cmd)
}

// shellCommandWaitDelay：sh 退出（或超时被杀）后，最多再等这么久让输出管道关闭。
// 命令里后台起的孙进程如果继承了 stdout/stderr，不设这个值 Wait 会一直阻塞，
// 进而让 actionPendingCount 永远降不下来、流量采集再也不跑。
var shellCommandWaitDelay = 5 * time.Second

// shellStandardPath 是 systemd 默认的 PATH。改用 `sh -c`（不再 `-l` 读 /etc/profile，
// 那里的脚本可能很慢甚至卡住）之后，用它补齐 Agent 进程 PATH 里缺的标准目录，
// 保证 iptables/nft/systemctl 以及装在 /usr/local/bin 下的转发程序都能找到。
const shellStandardPath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

func prepareShellCommand(c *exec.Cmd) {
	// 单独的进程组 + 超时时杀整个组：只杀 sh 会留下卡住的孙进程继续占着管道。
	configureShellProcessGroup(c)
	c.WaitDelay = shellCommandWaitDelay
	c.Env = shellCommandEnv(os.Environ())
}

func shellCommandEnv(base []string) []string {
	env := make([]string, 0, len(base)+2)
	pathValue := ""
	for _, item := range base {
		if strings.HasPrefix(item, "PATH=") {
			pathValue = strings.TrimPrefix(item, "PATH=")
			continue
		}
		if strings.HasPrefix(item, iptablesWaitEnvName+"=") {
			continue
		}
		env = append(env, item)
	}
	env = append(env, "PATH="+mergeShellPath(pathValue, shellStandardPath))
	env = append(env, iptablesWaitEnvName+"="+iptablesWaitFlag())
	return env
}

func mergeShellPath(current string, required string) string {
	parts := []string{}
	seen := map[string]bool{}
	for _, list := range []string{current, required} {
		for _, dir := range strings.Split(list, ":") {
			dir = strings.TrimSpace(dir)
			if dir == "" || seen[dir] {
				continue
			}
			seen[dir] = true
			parts = append(parts, dir)
		}
	}
	return strings.Join(parts, ":")
}

func shellCommandTempScript(ctx context.Context, cmd string) (*exec.Cmd, func(), bool, error) {
	dir := filepath.Join(os.TempDir(), "forwardx-agent")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, func() {}, true, err
	}
	file, err := os.CreateTemp(dir, "shell-*.sh")
	if err != nil {
		return nil, func() {}, true, err
	}
	path := file.Name()
	cleanup := func() {
		_ = os.Remove(path)
	}
	if _, err := file.WriteString("#!/bin/sh\n" + cmd + "\n"); err != nil {
		_ = file.Close()
		cleanup()
		return nil, func() {}, true, err
	}
	if err := file.Close(); err != nil {
		cleanup()
		return nil, func() {}, true, err
	}
	if err := os.Chmod(path, 0700); err != nil {
		cleanup()
		return nil, func() {}, true, err
	}
	c := exec.CommandContext(ctx, "sh", path)
	prepareShellCommand(c)
	return c, cleanup, true, nil
}
