package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

/*
  面板下发的「安装 / 修复 mimic」任务（Agent 2.2.223 起）。

  以前 mimic 只在装 Agent 时那个默认为 N 的可选提示里装，curl | bash 没有终端还会直接跳过，
  结果就是面板一句「请手动安装 mimic/mimic-dkms」。现在管理员在主机详情 / 隧道编辑里点一下，
  面板在心跳里把任务（连安装脚本正文一起）发过来，这里写成临时文件用 bash 跑，输出每几秒
  回传一次尾巴，跑完报结果并把 mimic 环境重新检测一遍。

  同一时刻只跑一个安装：和下面的 DKMS 自愈共用 mimicMaintenanceSlot。
*/

type mimicInstallTask struct {
	TaskID             string `json:"taskId"`
	Mode               string `json:"mode"` // install | repair
	Version            string `json:"version"`
	InstallerURL       string `json:"installerUrl"`
	Script             string `json:"script,omitempty"`
	AcceleratorEnabled bool   `json:"acceleratorEnabled"`
	AcceleratorURL     string `json:"acceleratorUrl"`
	Mirrors            string `json:"mirrors"`
	TimeoutSeconds     int    `json:"timeoutSeconds"`
}

type mimicInstallResult struct {
	TaskID      string                  `json:"taskId"`
	Status      string                  `json:"status"` // running | success | error | timeout
	Output      string                  `json:"output"`
	ExitCode    *int                    `json:"exitCode,omitempty"`
	Error       string                  `json:"error,omitempty"`
	StartedAt   string                  `json:"startedAt"`
	FinishedAt  string                  `json:"finishedAt,omitempty"`
	DurationMs  int                     `json:"durationMs,omitempty"`
	Environment *mimicEnvironmentReport `json:"mimicEnvironment,omitempty"`
}

const (
	mimicInstallOutputLimit    = 64 * 1024
	mimicInstallDefaultTimeout = 25 * time.Minute
	mimicInstallMaxTimeout     = 60 * time.Minute
	mimicInstallProgressEvery  = 5 * time.Second
	mimicInstallReportAttempts = 5
	mimicModuleRepairTimeout   = 10 * time.Minute
	mimicModuleRepairInterval  = time.Hour
)

// 安装任务和 DKMS 自愈同一时刻只能跑一个
var mimicMaintenanceSlot = make(chan struct{}, 1)

// tailBuffer 只留最后 limit 字节（按行切），安装脚本的输出可能很长，面板只要尾巴。
type tailBuffer struct {
	mu    sync.Mutex
	buf   bytes.Buffer
	limit int
}

func (b *tailBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.buf.Write(p)
	if b.limit > 0 && b.buf.Len() > b.limit {
		data := b.buf.Bytes()
		cut := len(data) - b.limit
		if nl := bytes.IndexByte(data[cut:], '\n'); nl >= 0 {
			cut += nl + 1
		}
		trimmed := append([]byte(nil), data[cut:]...)
		b.buf.Reset()
		b.buf.Write(trimmed)
	}
	return len(p), nil
}

func (b *tailBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func mimicInstallTimeout(task mimicInstallTask) time.Duration {
	timeout := time.Duration(task.TimeoutSeconds) * time.Second
	if timeout <= 0 {
		return mimicInstallDefaultTimeout
	}
	if timeout > mimicInstallMaxTimeout {
		return mimicInstallMaxTimeout
	}
	return timeout
}

// mimicInstallerCandidates 脚本正文没随任务来时从哪里下：加速器、镜像、GitHub 原址，按顺序。
func mimicInstallerCandidates(task mimicInstallTask) []string {
	raw := strings.TrimSpace(task.InstallerURL)
	if raw == "" {
		return nil
	}
	seen := map[string]bool{}
	var urls []string
	add := func(u string) {
		u = strings.TrimSpace(u)
		if u == "" || seen[u] {
			return
		}
		seen[u] = true
		urls = append(urls, u)
	}
	if task.AcceleratorEnabled && (strings.HasPrefix(task.AcceleratorURL, "http://") || strings.HasPrefix(task.AcceleratorURL, "https://")) {
		add(strings.TrimRight(task.AcceleratorURL, "/") + "/" + raw)
	}
	for _, mirror := range strings.Split(task.Mirrors, ",") {
		mirror = strings.TrimSpace(mirror)
		if mirror == "" {
			continue
		}
		add(strings.TrimRight(mirror, "/") + "/" + raw)
	}
	add(raw)
	return urls
}

func fetchMimicInstaller(ctx context.Context, task mimicInstallTask) (string, error) {
	if script := strings.TrimSpace(task.Script); script != "" {
		return task.Script, nil
	}
	candidates := mimicInstallerCandidates(task)
	if len(candidates) == 0 {
		return "", errors.New("installer script and URL are both empty")
	}
	client := &http.Client{Timeout: 2 * time.Minute}
	var lastErr error
	for _, url := range candidates {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			lastErr = err
			continue
		}
		resp, err := client.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, 2*1024*1024))
		resp.Body.Close()
		if readErr != nil || resp.StatusCode != http.StatusOK || len(bytes.TrimSpace(body)) == 0 {
			lastErr = fmt.Errorf("download %s: status=%d err=%v", url, resp.StatusCode, readErr)
			continue
		}
		return string(body), nil
	}
	return "", lastErr
}

func mimicInstallEnv(task mimicInstallTask) []string {
	mode := "install"
	if task.Mode == "repair" {
		mode = "repair"
	}
	env := append(os.Environ(),
		"FORWARDX_INSTALL_MIMIC=yes",
		"FORWARDX_MIMIC_MODE="+mode,
		"DEBIAN_FRONTEND=noninteractive",
		"NEEDRESTART_MODE=a",
	)
	if v := strings.TrimPrefix(strings.TrimSpace(task.Version), "v"); v != "" {
		env = append(env, "FORWARDX_MIMIC_VERSION="+v)
	}
	if task.AcceleratorEnabled && task.AcceleratorURL != "" {
		env = append(env, "GITHUB_ACCELERATOR_ENABLED=true", "GITHUB_ACCELERATOR_URL="+task.AcceleratorURL)
	}
	if m := strings.TrimSpace(task.Mirrors); m != "" {
		env = append(env, "FORWARDX_GITHUB_MIRRORS="+m)
	}
	return env
}

func handleMimicInstallTask(cfg Config, task mimicInstallTask) {
	select {
	case mimicMaintenanceSlot <- struct{}{}:
	default:
		reportMimicInstallResult(cfg, mimicInstallResult{
			TaskID:    task.TaskID,
			Status:    "error",
			Error:     "上一次 mimic 安装 / 修复还在进行，请稍后再试",
			StartedAt: time.Now().Format(time.RFC3339Nano),
		})
		return
	}
	defer func() { <-mimicMaintenanceSlot }()

	startedAt := time.Now()
	result := mimicInstallResult{TaskID: task.TaskID, Status: "running", StartedAt: startedAt.Format(time.RFC3339Nano)}
	output := &tailBuffer{limit: mimicInstallOutputLimit}
	finish := func(status string, exitCode *int, errText string) {
		result.Status = status
		result.ExitCode = exitCode
		result.Error = errText
		result.Output = output.String()
		result.FinishedAt = time.Now().Format(time.RFC3339Nano)
		result.DurationMs = int(time.Since(startedAt).Milliseconds())
		invalidateMimicEnvironmentCache()
		env := mimicEnvironment(true)
		result.Environment = &env
		reportMimicInstallResult(cfg, result)
		wakeHeartbeat()
	}

	ctx, cancel := context.WithTimeout(context.Background(), mimicInstallTimeout(task))
	defer cancel()

	fmt.Fprintf(output, "[NEX agent] mimic %s task=%s version=%s\n", task.Mode, task.TaskID, task.Version)
	script, err := fetchMimicInstaller(ctx, task)
	if err != nil {
		fmt.Fprintf(output, "[NEX agent] installer download failed: %v\n", err)
		finish("error", nil, "安装脚本下载失败："+err.Error())
		return
	}
	file, err := os.CreateTemp("", "forwardx-mimic-install-*.sh")
	if err != nil {
		finish("error", nil, "无法写入临时文件："+err.Error())
		return
	}
	path := file.Name()
	defer os.Remove(path)
	if _, err := file.WriteString(script); err != nil {
		file.Close()
		finish("error", nil, "无法写入安装脚本："+err.Error())
		return
	}
	file.Close()
	if err := os.Chmod(path, 0o700); err != nil {
		finish("error", nil, "无法设置脚本权限："+err.Error())
		return
	}

	cmd := exec.CommandContext(ctx, "bash", path)
	configureShellProcessGroup(cmd)
	cmd.Env = mimicInstallEnv(task)
	cmd.Stdout = output
	cmd.Stderr = output
	cmd.Stdin = nil

	// 跑的时候每几秒把输出尾巴报给面板，页面上能看到进度
	progressDone := make(chan struct{})
	go func() {
		ticker := time.NewTicker(mimicInstallProgressEvery)
		defer ticker.Stop()
		for {
			select {
			case <-progressDone:
				return
			case <-ticker.C:
				snapshot := result
				snapshot.Output = output.String()
				_ = post(cfg, "/api/agent/mimic-install-result", map[string]any{"result": snapshot}, &map[string]any{})
			}
		}
	}()

	logf("mimic %s started task=%s version=%s", task.Mode, task.TaskID, task.Version)
	runErr := cmd.Run()
	close(progressDone)
	timedOut := ctx.Err() == context.DeadlineExceeded
	exitCode := 0
	var exitErr *exec.ExitError
	if errors.As(runErr, &exitErr) {
		exitCode = exitErr.ExitCode()
	} else if runErr != nil {
		exitCode = -1
	}
	switch {
	case timedOut:
		fmt.Fprintf(output, "[NEX agent] installer timed out after %s\n", mimicInstallTimeout(task))
		logf("mimic %s timed out task=%s", task.Mode, task.TaskID)
		finish("timeout", &exitCode, "安装超时（"+mimicInstallTimeout(task).String()+"）")
	case runErr != nil:
		logf("mimic %s failed task=%s exit=%d", task.Mode, task.TaskID, exitCode)
		finish("error", &exitCode, mimicInstallFailureSummary(output.String(), exitCode))
	default:
		logf("mimic %s finished task=%s", task.Mode, task.TaskID)
		finish("success", &exitCode, "")
	}
}

// mimicInstallFailureSummary 从脚本输出里挑最后一句 ERROR 当作错误摘要；没有就报退出码。
func mimicInstallFailureSummary(output string, exitCode int) string {
	lines := strings.Split(strings.TrimSpace(output), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if strings.Contains(line, "ERROR:") || strings.Contains(line, "RESULT: failed") {
			return line
		}
	}
	return fmt.Sprintf("安装脚本退出码 %d", exitCode)
}

func reportMimicInstallResult(cfg Config, result mimicInstallResult) bool {
	delay := time.Second
	for attempt := 1; attempt <= mimicInstallReportAttempts; attempt++ {
		err := post(cfg, "/api/agent/mimic-install-result", map[string]any{"result": result}, &map[string]any{})
		if err == nil {
			return true
		}
		if !isTransientAgentCommError(err) || attempt == mimicInstallReportAttempts {
			logf("mimic install result report failed task=%s attempt=%d/%d: %v", result.TaskID, attempt, mimicInstallReportAttempts, err)
			return false
		}
		time.Sleep(delay)
		if delay < 16*time.Second {
			delay *= 2
		}
	}
	return false
}

/*
DKMS 自愈：mimic 命令在、内核模块不在（典型是内核升级后 DKMS 没给新内核重编）时，
自己跑一次 dkms autoinstall。只在有 dkms 的机器上做，同一个内核一小时最多试一次，
成功了下一次心跳就报 ready，不用人管；失败（多半是缺头文件）留给面板上的「修复」按钮。
*/
var (
	mimicRepairMu       sync.Mutex
	mimicRepairLastKern string
	mimicRepairLastAt   time.Time
	mimicRepairInFlight bool
)

func shouldAutoRepairMimicModule(report mimicEnvironmentReport, hasDkms bool, kernel, lastKernel string, lastAt, now time.Time, inFlight bool) bool {
	if inFlight || !hasDkms || report.Status != "kernel-module-missing" || !report.CommandReady {
		return false
	}
	if kernel != "" && kernel == lastKernel && !lastAt.IsZero() && now.Sub(lastAt) < mimicModuleRepairInterval {
		return false
	}
	return true
}

func currentKernelRelease() string {
	output, err := runMimicEnvironmentCommand("uname", "-r")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(output)
}

func maybeAutoRepairMimicModule(report mimicEnvironmentReport) {
	if report.Status != "kernel-module-missing" {
		return
	}
	kernel := currentKernelRelease()
	mimicRepairMu.Lock()
	ok := shouldAutoRepairMimicModule(report, commandExists("dkms"), kernel, mimicRepairLastKern, mimicRepairLastAt, time.Now(), mimicRepairInFlight)
	if ok {
		mimicRepairInFlight = true
		mimicRepairLastKern = kernel
		mimicRepairLastAt = time.Now()
	}
	mimicRepairMu.Unlock()
	if !ok {
		return
	}
	go func() {
		defer func() {
			mimicRepairMu.Lock()
			mimicRepairInFlight = false
			mimicRepairMu.Unlock()
		}()
		select {
		case mimicMaintenanceSlot <- struct{}{}:
		default:
			return
		}
		defer func() { <-mimicMaintenanceSlot }()
		ctx, cancel := context.WithTimeout(context.Background(), mimicModuleRepairTimeout)
		defer cancel()
		logf("mimic kernel module missing for %s; trying dkms autoinstall", kernel)
		cmd := exec.CommandContext(ctx, "dkms", "autoinstall", "-k", kernel)
		configureShellProcessGroup(cmd)
		output, err := cmd.CombinedOutput()
		if err != nil {
			logf("mimic dkms autoinstall failed kernel=%s: %v %s", kernel, err, compactMimicEnvironmentOutput(string(output), 300))
			return
		}
		if _, err := runMimicEnvironmentCommand("modprobe", "mimic"); err != nil {
			logf("mimic dkms autoinstall finished but modprobe still fails kernel=%s", kernel)
		} else {
			logf("mimic kernel module rebuilt by dkms autoinstall kernel=%s", kernel)
		}
		invalidateMimicEnvironmentCache()
		wakeHeartbeat()
	}()
}
