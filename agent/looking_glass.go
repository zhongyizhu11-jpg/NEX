package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

func handleLookingGlassTask(ctx context.Context, cfg Config, task lookingGlassTask) {
	reportLookingGlassFinal(cfg, task, runLookingGlassTask(ctx, cfg, task))
}

func reportLookingGlassFinal(cfg Config, task lookingGlassTask, result lookingGlassResult) {
	if err := post(cfg, "/api/agent/looking-glass-result", map[string]any{"result": result}, &map[string]any{}); err != nil {
		if isTransientAgentCommError(err) {
			logAgentCommError("looking-glass-result", err)
		} else {
			logf("looking glass result report failed task=%s method=%s target=%s: %v", task.TaskID, task.Method, task.ResolvedAddress, err)
		}
	}
}

func reportLookingGlassProgress(cfg Config, result lookingGlassResult) {
	if err := post(cfg, "/api/agent/looking-glass-progress", map[string]any{"result": result}, &map[string]any{}); err != nil {
		if isTransientAgentCommError(err) {
			logAgentCommError("looking-glass-progress", err)
		} else {
			logf("looking glass progress report failed task=%s method=%s target=%s: %v", result.TaskID, result.Method, result.ResolvedAddress, err)
		}
	}
}

func handleIperf3Task(ctx context.Context, cfg Config, task iperf3Task) {
	var result iperf3Result
	if err := ctx.Err(); err != nil {
		result = iperf3RejectedResult(task, interactiveTaskQueueTimeoutMessage)
	} else {
		result = runIperf3Task(cfg, task)
	}
	if err := post(cfg, "/api/agent/iperf3-result", map[string]any{"result": result}, &map[string]any{}); err != nil {
		if isTransientAgentCommError(err) {
			logAgentCommError("iperf3-result", err)
		} else {
			logf("iperf3 result report failed task=%s op=%s port=%d: %v", task.TaskID, task.Op, task.Port, err)
		}
	}
}

func reportIperf3Result(cfg Config, result iperf3Result) {
	if result.UpdatedAt == "" {
		result.UpdatedAt = time.Now().Format(time.RFC3339Nano)
	}
	if err := post(cfg, "/api/agent/iperf3-result", map[string]any{"result": result}, &map[string]any{}); err != nil {
		if isTransientAgentCommError(err) {
			logAgentCommError("iperf3-status", err)
		} else {
			logf("iperf3 status report failed task=%s op=%s port=%d: %v", result.TaskID, result.Op, result.Port, err)
		}
	}
}

func runIperf3Task(cfg Config, task iperf3Task) iperf3Result {
	port := task.Port
	if port < 0 || port > 65535 {
		return iperf3Result{
			TaskID:    task.TaskID,
			Op:        task.Op,
			Port:      port,
			Status:    "error",
			Output:    "iperf3 端口必须在 1-65535 之间",
			Error:     "invalid iperf3 port",
			UpdatedAt: time.Now().Format(time.RFC3339Nano),
		}
	}
	if task.Op == "stop" {
		output := stopIperf3Server("用户从面板停止 iperf3 服务端")
		return iperf3Result{
			TaskID:    task.TaskID,
			Op:        task.Op,
			Port:      port,
			Status:    "stopped",
			Output:    output,
			UpdatedAt: time.Now().Format(time.RFC3339Nano),
		}
	}
	if port == 0 {
		selectedPort, err := pickAvailableIperf3Port()
		if err != nil {
			message := fmt.Sprintf("Agent 无法自动分配 iperf3 监听端口：%v", err)
			return iperf3Result{
				TaskID:    task.TaskID,
				Op:        task.Op,
				Port:      port,
				Status:    "error",
				Output:    message,
				Error:     message,
				UpdatedAt: time.Now().Format(time.RFC3339Nano),
			}
		}
		port = selectedPort
	}
	if _, err := exec.LookPath("iperf3"); err != nil {
		message := missingNetworkToolMessage("iperf3")
		return iperf3Result{
			TaskID:    task.TaskID,
			Op:        task.Op,
			Port:      port,
			Status:    "error",
			Output:    message,
			Error:     message,
			UpdatedAt: time.Now().Format(time.RFC3339Nano),
		}
	}
	if _, err := exec.LookPath("iperf3"); err != nil {
		message := "Agent 未安装 iperf3，请重新运行安装脚本或手动安装 iperf3"
		return iperf3Result{
			TaskID:    task.TaskID,
			Op:        task.Op,
			Port:      port,
			Status:    "error",
			Output:    message,
			Error:     message,
			UpdatedAt: time.Now().Format(time.RFC3339Nano),
		}
	}
	return startIperf3Server(cfg, task, port)
}

func startIperf3Server(cfg Config, task iperf3Task, port int) iperf3Result {
	iperf3Mu.Lock()
	if iperf3Server != nil {
		iperf3Server.stopLocked("启动新的 iperf3 服务端，已停止旧实例")
	}
	if err := checkIperf3PortAvailable(port); err != nil {
		iperf3Mu.Unlock()
		message := formatIperf3PortError(port, err)
		return iperf3Result{
			TaskID:    task.TaskID,
			Op:        task.Op,
			Port:      port,
			Status:    "error",
			Output:    message,
			Error:     message,
			UpdatedAt: time.Now().Format(time.RFC3339Nano),
		}
	}
	cmd := exec.Command("iperf3", "-s", "-p", strconv.Itoa(port))
	bindChildToAgent(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		iperf3Mu.Unlock()
		return iperf3StartError(task, port, err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		iperf3Mu.Unlock()
		return iperf3StartError(task, port, err)
	}
	if err := cmd.Start(); err != nil {
		iperf3Mu.Unlock()
		return iperf3StartError(task, port, err)
	}
	startedAt := time.Now()
	process := &iperf3Process{
		taskID:    task.TaskID,
		port:      port,
		cfg:       cfg,
		cmd:       cmd,
		startedAt: startedAt,
		output:    "iperf3 服务端已启动，等待客户端连接...",
		done:      make(chan struct{}),
	}
	process.lastActivity.Store(startedAt.UnixNano())
	iperf3Server = process
	iperf3Mu.Unlock()

	var wg sync.WaitGroup
	wg.Add(2)
	go process.readPipe(stdout, &wg)
	go process.readPipe(stderr, &wg)
	go process.watchIdleTimeout()
	go func() {
		err := cmd.Wait()
		wg.Wait()
		process.markExited(err)
	}()

	return iperf3Result{
		TaskID:    task.TaskID,
		Op:        "start",
		Port:      port,
		Status:    "running",
		Output:    process.currentOutput(),
		PID:       cmd.Process.Pid,
		StartedAt: startedAt.Format(time.RFC3339Nano),
		UpdatedAt: time.Now().Format(time.RFC3339Nano),
	}
}

func iperf3StartError(task iperf3Task, port int, err error) iperf3Result {
	if errors.Is(err, exec.ErrNotFound) {
		message := missingNetworkToolMessage("iperf3")
		return iperf3Result{
			TaskID:    task.TaskID,
			Op:        task.Op,
			Port:      port,
			Status:    "error",
			Output:    message,
			Error:     message,
			UpdatedAt: time.Now().Format(time.RFC3339Nano),
		}
	}
	message := fmt.Sprintf("iperf3 服务端启动失败：%v", err)
	return iperf3Result{
		TaskID:    task.TaskID,
		Op:        task.Op,
		Port:      port,
		Status:    "error",
		Output:    message,
		Error:     message,
		UpdatedAt: time.Now().Format(time.RFC3339Nano),
	}
}

func checkIperf3PortAvailable(port int) error {
	ln, err := net.Listen("tcp", net.JoinHostPort("", strconv.Itoa(port)))
	if err != nil {
		return err
	}
	return ln.Close()
}

func pickAvailableIperf3Port() (int, error) {
	ln, err := net.Listen("tcp", ":0")
	if err != nil {
		return 0, err
	}
	defer ln.Close()
	addr, ok := ln.Addr().(*net.TCPAddr)
	if !ok || addr.Port <= 0 {
		return 0, fmt.Errorf("无法读取自动分配的端口")
	}
	return addr.Port, nil
}

func formatIperf3PortError(port int, err error) string {
	message := strings.ToLower(err.Error())
	if strings.Contains(message, "address already in use") || strings.Contains(message, "only one usage of each socket address") {
		return fmt.Sprintf("iperf3 监听端口 %d 已被占用，请换一个端口，或在服务器上停止占用该端口的进程后重试。", port)
	}
	return fmt.Sprintf("iperf3 监听端口 %d 不可用：%v", port, err)
}

func stopIperf3Server(reason string) string {
	iperf3Mu.Lock()
	defer iperf3Mu.Unlock()
	if iperf3Server == nil {
		return "iperf3 服务端未在运行"
	}
	output := iperf3Server.stopLocked(reason)
	iperf3Server = nil
	return output
}

func runLookingGlassTask(ctx context.Context, cfg Config, task lookingGlassTask) lookingGlassResult {
	started := time.Now()
	result := lookingGlassResult{
		TaskID:            task.TaskID,
		Method:            task.Method,
		Target:            task.Target,
		ResolvedAddress:   task.ResolvedAddress,
		ResolvedAddresses: task.ResolvedAddresses,
		StartedAt:         started.Format(time.RFC3339Nano),
	}
	result.Output = fmt.Sprintf("Agent 已开始执行 %s 测试\n目标: %s", task.Method, task.ResolvedAddress)
	reportLookingGlassProgress(cfg, result)
	if task.Method == "tcp" {
		port := task.Port
		if port <= 0 {
			port = 443
		}
		result.Port = port
		result.Output = fmt.Sprintf("正在测试 TCP %s ...", net.JoinHostPort(task.ResolvedAddress, strconv.Itoa(port)))
		result.DurationMs = int(time.Since(started).Milliseconds())
		reportLookingGlassProgress(cfg, result)
		latency, ok := tcpLatency(task.ResolvedAddress, port, 10*time.Second)
		result.DurationMs = int(time.Since(started).Milliseconds())
		if ok {
			code := 0
			result.ExitCode = &code
			result.Output = fmt.Sprintf("TCP %s 连接成功\n耗时: %d ms", net.JoinHostPort(task.ResolvedAddress, strconv.Itoa(port)), latency)
		} else {
			code := 1
			result.ExitCode = &code
			result.Output = fmt.Sprintf("TCP %s 连接失败或超时\n耗时: %d ms", net.JoinHostPort(task.ResolvedAddress, strconv.Itoa(port)), result.DurationMs)
		}
		result.FinishedAt = time.Now().Format(time.RFC3339Nano)
		return result
	}

	timeout := 30 * time.Second
	if task.Method == "iperf3-client" {
		// 跑满 -t 秒才出汇总，再给建连和收尾留一点。
		timeout = time.Duration(iperf3ClientSeconds(task))*time.Second + 20*time.Second
		result.Port = iperf3ClientPort(task)
	}
	command, args, err := lookingGlassCommand(task.Method, task.ResolvedAddress)
	if task.Method == "iperf3-client" {
		command, args, err = iperf3ClientCommand(task)
	}
	if err != nil {
		code := 1
		result.ExitCode = &code
		result.Error = err.Error()
		result.Output = err.Error()
		result.DurationMs = int(time.Since(started).Milliseconds())
		result.FinishedAt = time.Now().Format(time.RFC3339Nano)
		return result
	}
	if _, err := exec.LookPath(command); err != nil {
		code := 1
		message := missingNetworkToolMessage(command)
		result.ExitCode = &code
		result.Error = message
		result.Output = message
		result.DurationMs = int(time.Since(started).Milliseconds())
		result.FinishedAt = time.Now().Format(time.RFC3339Nano)
		return result
	}
	progress := func(output string, durationMs int) {
		result.Output = output
		result.DurationMs = durationMs
		reportLookingGlassProgress(cfg, result)
	}
	output, exitCode, timedOut := runLookingGlassCommandContext(ctx, command, args, timeout, progress)
	result.Output = output
	if strings.TrimSpace(result.Output) == "" {
		result.Output = "命令没有返回输出"
	}
	result.ExitCode = exitCode
	result.TimedOut = timedOut
	result.DurationMs = int(time.Since(started).Milliseconds())
	result.FinishedAt = time.Now().Format(time.RFC3339Nano)
	return result
}

func lookingGlassCommand(method string, host string) (string, []string, error) {
	ipv6 := strings.HasSuffix(method, "6")
	switch method {
	case "ping", "ping6":
		return "ping", []string{mapBool(ipv6, "-6", "-4"), "-c", "4", "-W", "3", host}, nil
	case "traceroute", "traceroute6":
		return "traceroute", []string{mapBool(ipv6, "-6", "-4"), "-n", "-m", "20", "-w", "2", host}, nil
	case "mtr", "mtr6":
		return "mtr", []string{mapBool(ipv6, "-6", "-4"), "--report", "--report-cycles", "10", "--no-dns", host}, nil
	default:
		return "", nil, fmt.Errorf("不支持的网络测试方法: %s", method)
	}
}

/*
iperf3 客户端：从这台 Agent 往目标上的 iperf3 服务端跑一次带宽测试，面板里另一台
主机一键开的服务端就是典型的对端。面板给的参数在这里再收一次边界，免得旧面板或
手改的任务把 -P 开到几百。

--forceflush 让 iperf3 在 stdout 不是终端时也逐秒刷出中间行，面板上才看得到实时
速率；iperf 3.1 起就有这个参数。-f m 固定用 Mbits/sec 显示，各机器输出一致。
*/
const (
	iperf3ClientDefaultPort    = 5201
	iperf3ClientDefaultStreams = 4
	iperf3ClientMaxStreams     = 16
	iperf3ClientDefaultSeconds = 10
	iperf3ClientMinSeconds     = 5
	iperf3ClientMaxSeconds     = 30
)

func iperf3ClientPort(task lookingGlassTask) int {
	if task.Port <= 0 || task.Port > 65535 {
		return iperf3ClientDefaultPort
	}
	return task.Port
}

func iperf3ClientStreams(task lookingGlassTask) int {
	if task.Streams <= 0 {
		return iperf3ClientDefaultStreams
	}
	if task.Streams > iperf3ClientMaxStreams {
		return iperf3ClientMaxStreams
	}
	return task.Streams
}

func iperf3ClientSeconds(task lookingGlassTask) int {
	if task.Seconds <= 0 {
		return iperf3ClientDefaultSeconds
	}
	if task.Seconds < iperf3ClientMinSeconds {
		return iperf3ClientMinSeconds
	}
	if task.Seconds > iperf3ClientMaxSeconds {
		return iperf3ClientMaxSeconds
	}
	return task.Seconds
}

func iperf3ClientCommand(task lookingGlassTask) (string, []string, error) {
	host := strings.TrimSpace(task.ResolvedAddress)
	if host == "" {
		return "", nil, fmt.Errorf("iperf3 客户端测试缺少目标地址")
	}
	args := []string{
		"-c", host,
		"-p", strconv.Itoa(iperf3ClientPort(task)),
		"-P", strconv.Itoa(iperf3ClientStreams(task)),
		"-t", strconv.Itoa(iperf3ClientSeconds(task)),
		"-i", "1",
		"-f", "m",
		"--forceflush",
	}
	if task.Family == 6 || strings.Contains(host, ":") {
		args = append(args, "-6")
	} else if task.Family == 4 {
		args = append(args, "-4")
	}
	if task.Reverse {
		args = append(args, "-R")
	}
	if task.UDP {
		// UDP 的 -b 默认只有 1 Mbit/s，必须显式给；0 表示不限速（iperf3 自己的约定）。
		args = append(args, "-u", "-b", strconv.Itoa(iperf3ClientUDPMbps(task))+"M")
	}
	return "iperf3", args, nil
}

// iperf3ClientUDPMbps 是 UDP 模式每条流的发送速率（Mbit/s），0 = 不限；上限 100 Gbit/s。
func iperf3ClientUDPMbps(task lookingGlassTask) int {
	if task.UDPMbps <= 0 {
		return 0
	}
	if task.UDPMbps > 100000 {
		return 100000
	}
	return task.UDPMbps
}

func missingNetworkToolMessage(tool string) string {
	switch tool {
	case "ping":
		return "Agent 主机缺少 ping 工具，无法执行 Ping 测试。\n请在该 Agent 主机安装后重试：Debian/Ubuntu: apt install iputils-ping；RHEL/CentOS: yum install iputils；Alpine: apk add iputils。"
	case "traceroute":
		return "Agent 主机缺少 traceroute 工具，无法执行 Traceroute 测试。\n请在该 Agent 主机安装后重试：Debian/Ubuntu: apt install traceroute；RHEL/CentOS: yum install traceroute；Alpine: apk add traceroute。"
	case "mtr":
		return "Agent 主机缺少 mtr 工具，无法执行 MTR 测试。\n请在该 Agent 主机安装后重试：Debian/Ubuntu: apt install mtr-tiny；RHEL/CentOS: yum install mtr；Alpine: apk add mtr。"
	case "iperf3":
		return "Agent 主机缺少 iperf3，无法启动 iperf3 服务端测试。\n请在该 Agent 主机安装后重试：Debian/Ubuntu: apt install iperf3；RHEL/CentOS: yum install iperf3；Alpine: apk add iperf3。"
	default:
		return fmt.Sprintf("Agent 主机缺少 %s 工具，无法执行该网络测试。请在该 Agent 主机安装 %s 后重试。", tool, tool)
	}
}

// lookingGlassProgressInterval 是输出行触发的进度回报的最小间隔。
const lookingGlassProgressInterval = time.Second

func runLookingGlassCommand(name string, args []string, timeout time.Duration, onProgress func(string, int)) (string, *int, bool) {
	return runLookingGlassCommandContext(context.Background(), name, args, timeout, onProgress)
}

// runLookingGlassCommandContext 同上，parent 到期（交互任务总时限）时也结束命令。
func runLookingGlassCommandContext(parent context.Context, name string, args []string, timeout time.Duration, onProgress func(string, int)) (string, *int, bool) {
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	started := time.Now()
	cmd := exec.CommandContext(ctx, name, args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		code := 1
		return err.Error(), &code, false
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		code := 1
		return err.Error(), &code, false
	}

	var mu sync.Mutex
	var output strings.Builder
	appendLine := func(line string) {
		mu.Lock()
		defer mu.Unlock()
		if output.Len() >= 32000 {
			return
		}
		if output.Len() > 0 {
			output.WriteByte('\n')
		}
		output.WriteString(line)
		if output.Len() > 32000 {
			text := output.String()
			output.Reset()
			output.WriteString(text[:32000])
			output.WriteString("\n... 输出已截断")
		}
	}
	currentOutput := func() string {
		mu.Lock()
		defer mu.Unlock()
		return strings.TrimSpace(output.String())
	}
	// 每次进度回报都是一次同步的 HTTP POST。ping / mtr 一共没几行无所谓，iperf3
	// 开 16 条流、--forceflush 之后每秒十几行：逐行回报会让读管道的协程排在网络
	// 往返后面，iperf3 早跑完了这边还在一条条发，面板也白白多收几百个快照。所以
	// 输出行触发的回报每秒最多一次（下面的定时器本来就每秒报一次），最后一次
	// 完整输出随结果一起发，不会漏。
	var lastProgressAt atomic.Int64
	report := func(fallback string) {
		text := currentOutput()
		if text == "" {
			text = fallback
		}
		lastProgressAt.Store(time.Now().UnixNano())
		onProgress(text, int(time.Since(started).Milliseconds()))
	}
	reportThrottled := func(fallback string) {
		now := time.Now().UnixNano()
		last := lastProgressAt.Load()
		if now-last < int64(lookingGlassProgressInterval) {
			return
		}
		if !lastProgressAt.CompareAndSwap(last, now) {
			return // 另一条管道的协程刚报过
		}
		text := currentOutput()
		if text == "" {
			text = fallback
		}
		onProgress(text, int(time.Since(started).Milliseconds()))
	}

	if err := cmd.Start(); err != nil {
		code := 1
		if errors.Is(err, exec.ErrNotFound) {
			return missingNetworkToolMessage(name), &code, false
		}
		return fmt.Sprintf("网络测试工具 %s 启动失败：%v", name, err), &code, false
	}

	var wg sync.WaitGroup
	readPipe := func(r io.Reader) {
		defer wg.Done()
		scanner := bufio.NewScanner(r)
		scanner.Buffer(make([]byte, 0, 4096), 1024*1024)
		for scanner.Scan() {
			appendLine(scanner.Text())
			reportThrottled("命令正在执行，等待输出...")
		}
	}
	wg.Add(2)
	go readPipe(stdout)
	go readPipe(stderr)

	ticker := time.NewTicker(time.Second)
	readDone := make(chan struct{})
	go func() {
		wg.Wait()
		close(readDone)
	}()

	running := true
	for running {
		select {
		case <-ticker.C:
			report(fmt.Sprintf("命令正在执行，已运行 %ds...", int(time.Since(started).Seconds())))
		case <-readDone:
			running = false
		}
	}
	ticker.Stop()
	waitErr := cmd.Wait()

	outputText := currentOutput()
	timedOut := ctx.Err() == context.DeadlineExceeded
	code := 0
	if waitErr != nil {
		code = 1
		if exitErr, ok := waitErr.(*exec.ExitError); ok {
			code = exitErr.ExitCode()
		}
		if strings.TrimSpace(outputText) == "" {
			outputText = waitErr.Error()
		}
	}
	if timedOut && !strings.Contains(outputText, "超时") {
		if outputText != "" {
			outputText += "\n"
		}
		outputText += "命令执行超时"
	}
	report(outputText)
	return strings.TrimSpace(outputText), &code, timedOut
}

func mapBool(ok bool, yes string, no string) string {
	if ok {
		return yes
	}
	return no
}

type lookingGlassTask struct {
	TaskID            string   `json:"taskId"`
	Method            string   `json:"method"`
	Target            string   `json:"target"`
	ResolvedAddress   string   `json:"resolvedAddress"`
	ResolvedAddresses []string `json:"resolvedAddresses"`
	Family            int      `json:"family"`
	Port              int      `json:"port"`
	// iperf3 客户端（method = iperf3-client）：-R、-P、-t；UDP 模式（-u -b）用来测
	// 链路的限速点，UDPMbps 是每条流的发送速率（0 = 不限）。
	Reverse   bool   `json:"reverse,omitempty"`
	Streams   int    `json:"streams,omitempty"`
	Seconds   int    `json:"seconds,omitempty"`
	UDP       bool   `json:"udp,omitempty"`
	UDPMbps   int    `json:"udpMbps,omitempty"`
	CreatedAt string `json:"createdAt"`
}

type lookingGlassResult struct {
	TaskID            string   `json:"taskId"`
	Method            string   `json:"method"`
	Target            string   `json:"target"`
	Port              int      `json:"port,omitempty"`
	ResolvedAddress   string   `json:"resolvedAddress"`
	ResolvedAddresses []string `json:"resolvedAddresses"`
	Output            string   `json:"output"`
	ExitCode          *int     `json:"exitCode"`
	TimedOut          bool     `json:"timedOut"`
	DurationMs        int      `json:"durationMs"`
	StartedAt         string   `json:"startedAt"`
	FinishedAt        string   `json:"finishedAt"`
	Error             string   `json:"error,omitempty"`
}

type iperf3Task struct {
	TaskID    string `json:"taskId"`
	Op        string `json:"op"`
	Port      int    `json:"port"`
	CreatedAt string `json:"createdAt"`
}

type iperf3Result struct {
	TaskID    string `json:"taskId"`
	Op        string `json:"op"`
	Port      int    `json:"port"`
	Status    string `json:"status"`
	Output    string `json:"output"`
	PID       int    `json:"pid,omitempty"`
	StartedAt string `json:"startedAt,omitempty"`
	UpdatedAt string `json:"updatedAt,omitempty"`
	Error     string `json:"error,omitempty"`
}

type iperf3Process struct {
	taskID       string
	port         int
	cfg          Config
	cmd          *exec.Cmd
	startedAt    time.Time
	outputMu     sync.Mutex
	output       string
	done         chan struct{}
	doneOnce     sync.Once
	lastActivity atomic.Int64
}

func (p *iperf3Process) appendLine(line string) {
	line = strings.TrimSpace(line)
	if line == "" {
		return
	}
	p.lastActivity.Store(time.Now().UnixNano())
	p.outputMu.Lock()
	defer p.outputMu.Unlock()
	if p.output == "" {
		p.output = line
		return
	}
	if len(p.output) > 32000 {
		p.output = p.output[len(p.output)-24000:]
		p.output = "... 输出已截断\n" + p.output
	}
	p.output += "\n" + line
}

func (p *iperf3Process) currentOutput() string {
	p.outputMu.Lock()
	defer p.outputMu.Unlock()
	return strings.TrimSpace(p.output)
}

func (p *iperf3Process) readPipe(r io.Reader, wg *sync.WaitGroup) {
	defer wg.Done()
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 4096), 1024*1024)
	for scanner.Scan() {
		p.appendLine(scanner.Text())
	}
	if err := scanner.Err(); err != nil {
		message := strings.ToLower(err.Error())
		if strings.Contains(message, "file already closed") || strings.Contains(message, "closed pipe") {
			return
		}
		p.appendLine(fmt.Sprintf("读取 iperf3 输出失败：%v", err))
	}
}

func (p *iperf3Process) watchIdleTimeout() {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			last := time.Unix(0, p.lastActivity.Load())
			if time.Since(last) < iperf3IdleTimeout {
				continue
			}
			var result *iperf3Result
			iperf3Mu.Lock()
			if iperf3Server == p {
				p.stopLocked("3 分钟无客户端测试，已自动停止 iperf3 服务端")
				iperf3Server = nil
				result = &iperf3Result{
					TaskID:    p.taskID,
					Op:        "stop",
					Port:      p.port,
					Status:    "stopped",
					Output:    p.currentOutput(),
					StartedAt: p.startedAt.Format(time.RFC3339Nano),
				}
			}
			iperf3Mu.Unlock()
			if result != nil {
				reportIperf3Result(p.cfg, *result)
			}
			return
		case <-p.done:
			return
		}
	}
}

func (p *iperf3Process) stopLocked(reason string) string {
	p.appendLine(reason)
	if p.cmd != nil && p.cmd.Process != nil {
		_ = p.cmd.Process.Kill()
	}
	p.doneOnce.Do(func() { close(p.done) })
	return p.currentOutput()
}

func (p *iperf3Process) markExited(err error) {
	status := "stopped"
	errText := ""
	if err != nil && !strings.Contains(err.Error(), "killed") {
		status = "error"
		errText = fmt.Sprintf("iperf3 服务端异常退出：%v", err)
		p.appendLine(errText)
	} else {
		p.appendLine("iperf3 服务端已停止")
	}
	p.doneOnce.Do(func() { close(p.done) })
	var result *iperf3Result
	iperf3Mu.Lock()
	if iperf3Server == p {
		iperf3Server = nil
		result = &iperf3Result{
			TaskID:    p.taskID,
			Op:        "stop",
			Port:      p.port,
			Status:    status,
			Output:    p.currentOutput(),
			StartedAt: p.startedAt.Format(time.RFC3339Nano),
			Error:     errText,
		}
	}
	iperf3Mu.Unlock()
	if result != nil {
		reportIperf3Result(p.cfg, *result)
	}
}
