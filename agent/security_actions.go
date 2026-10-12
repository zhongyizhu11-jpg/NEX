package main

// 安全巡检的处置动作：停止进程、隔离文件、撤销隔离。
//
// 只在面板上有人点了确认之后才会收到；执行前再核对一遍发现是否仍然成立（pid 还是那个程序、
// 文件哈希没变），对不上就不动手，把原因报回去。账号、SSH 钥匙、系统目录里的文件一律不碰。

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type securityActionRequest struct {
	ID           int    `json:"id"`
	Action       string `json:"action"` // kill | quarantine | restore
	Fingerprint  string `json:"fingerprint,omitempty"`
	PID          int    `json:"pid,omitempty"`
	Exe          string `json:"exe,omitempty"`
	Path         string `json:"path,omitempty"`
	SHA256       string `json:"sha256,omitempty"`
	QuarantineID string `json:"quarantineId,omitempty"`
}

type securityActionResult struct {
	ID           int    `json:"id"`
	OK           bool   `json:"ok"`
	Message      string `json:"message"`
	QuarantineID string `json:"quarantineId,omitempty"`
	At           int64  `json:"at"`
}

type quarantineMeta struct {
	OriginalPath string `json:"originalPath"`
	Mode         uint32 `json:"mode"`
	UID          int    `json:"uid"`
	GID          int    `json:"gid"`
	SHA256       string `json:"sha256"`
	Size         int64  `json:"size"`
	At           int64  `json:"at"`
	ActionID     int    `json:"actionId"`
}

var quarantineIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// 这些目录里的文件不自动隔离：误伤一个系统程序比漏掉一个木马更难收拾。
var protectedQuarantinePrefixes = []string{
	"/bin/", "/sbin/", "/usr/bin/", "/usr/sbin/", "/lib/", "/lib64/", "/usr/lib/", "/usr/lib64/", "/usr/libexec/",
	"/boot/", "/etc/", "/proc/", "/sys/", "/dev/", "/var/lib/forwardx-agent/",
}

func executeSecurityAction(req securityActionRequest) securityActionResult {
	result := securityActionResult{ID: req.ID, At: time.Now().Unix()}
	var err error
	switch req.Action {
	case "kill":
		result.Message, err = securityKillProcess(req)
	case "quarantine":
		result.QuarantineID, result.Message, err = securityQuarantineFile(req, securityQuarantineDir)
	case "restore":
		result.Message, err = securityRestoreFile(req, securityQuarantineDir)
	default:
		err = fmt.Errorf("不认识的动作 %q", req.Action)
	}
	if err != nil {
		result.OK = false
		result.Message = err.Error()
		return result
	}
	result.OK = true
	return result
}

func processExe(pid int) (string, bool) {
	exe, err := os.Readlink("/proc/" + strconv.Itoa(pid) + "/exe")
	if err != nil {
		return "", false
	}
	return strings.TrimSuffix(exe, " (deleted)"), true
}

func securityKillProcess(req securityActionRequest) (string, error) {
	pid := req.PID
	if pid <= 1 || pid == os.Getpid() || pid == os.Getppid() {
		return "", errors.New("这个进程不能由巡检停止")
	}
	want := strings.TrimSuffix(strings.TrimSpace(req.Exe), " (deleted)")
	if want == "" {
		return "", errors.New("发现里没有记下程序路径，无法核对，没有动它")
	}
	exe, alive := processExe(pid)
	if !alive {
		return "", errors.New("进程已经不在了")
	}
	if exe != want {
		return "", fmt.Errorf("pid %d 现在跑的是 %s，不是发现里的 %s，没有动它", pid, exe, want)
	}
	stillSame := func() bool {
		cur, ok := processExe(pid)
		return ok && cur == want
	}
	if err := syscall.Kill(pid, syscall.SIGTERM); err != nil {
		return "", fmt.Errorf("发送停止信号失败：%v", err)
	}
	if waitProcessGone(pid, stillSame, 5*time.Second) {
		return fmt.Sprintf("已停止进程 %d", pid), nil
	}
	if err := syscall.Kill(pid, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
		return "", fmt.Errorf("强制停止失败：%v", err)
	}
	if waitProcessGone(pid, stillSame, 3*time.Second) {
		return fmt.Sprintf("进程 %d 没有响应停止信号，已强制结束", pid), nil
	}
	return "", fmt.Errorf("进程 %d 仍在运行（可能被别的进程拉起或处于不可中断状态）", pid)
}

func waitProcessGone(pid int, stillSame func() bool, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if !stillSame() {
			return true
		}
		time.Sleep(200 * time.Millisecond)
	}
	return !stillSame()
}

func quarantineAllowedPath(p string) error {
	if p == "" || !filepath.IsAbs(p) || filepath.Clean(p) != p {
		return errors.New("文件路径不对")
	}
	for _, prefix := range protectedQuarantinePrefixes {
		if strings.HasPrefix(p, prefix) {
			return errors.New("系统目录里的文件不自动隔离，请登录主机确认后手动处理")
		}
	}
	if self, err := os.Executable(); err == nil && filepath.Clean(self) == p {
		return errors.New("不能隔离 Agent 自己")
	}
	return nil
}

func securityQuarantineFile(req securityActionRequest, root string) (string, string, error) {
	p := strings.TrimSuffix(strings.TrimSpace(req.Path), " (deleted)")
	if err := quarantineAllowedPath(p); err != nil {
		return "", "", err
	}
	info, err := os.Lstat(p)
	if err != nil {
		return "", "", errors.New("文件已经不在原处")
	}
	if !info.Mode().IsRegular() {
		return "", "", errors.New("这不是普通文件，没有动它")
	}
	if info.Size() > securityHashFileMax {
		return "", "", errors.New("文件太大，没有隔离")
	}
	sum, err := sha256File(p, securityHashFileMax)
	if err != nil {
		return "", "", fmt.Errorf("读不了文件：%v", err)
	}
	if req.SHA256 != "" && !strings.EqualFold(req.SHA256, sum) {
		return "", "", errors.New("文件内容和发现时不一样了，没有动它")
	}
	qid := "q" + strconv.Itoa(req.ID) + "-" + shortHash(p)
	dir := filepath.Join(root, qid)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", "", fmt.Errorf("建隔离目录失败：%v", err)
	}
	meta := quarantineMeta{OriginalPath: p, Mode: uint32(info.Mode().Perm()), SHA256: sum, Size: info.Size(), At: time.Now().Unix(), ActionID: req.ID, UID: -1, GID: -1}
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		meta.UID, meta.GID = int(st.Uid), int(st.Gid)
	}
	raw, _ := json.Marshal(meta)
	if err := os.WriteFile(filepath.Join(dir, "meta.json"), raw, 0600); err != nil {
		return "", "", fmt.Errorf("写隔离记录失败：%v", err)
	}
	dst := filepath.Join(dir, "file")
	if err := moveFile(p, dst); err != nil {
		_ = os.RemoveAll(dir)
		return "", "", fmt.Errorf("移动文件失败：%v", err)
	}
	_ = os.Chmod(dst, 0)
	return qid, "已把 " + p + " 移到隔离区并去掉了所有权限", nil
}

func securityRestoreFile(req securityActionRequest, root string) (string, error) {
	qid := strings.TrimSpace(req.QuarantineID)
	if !quarantineIDPattern.MatchString(qid) {
		return "", errors.New("隔离记录编号不对")
	}
	dir := filepath.Join(root, qid)
	raw, err := os.ReadFile(filepath.Join(dir, "meta.json"))
	if err != nil {
		return "", errors.New("隔离区里找不到这个文件")
	}
	var meta quarantineMeta
	if err := json.Unmarshal(raw, &meta); err != nil || meta.OriginalPath == "" {
		return "", errors.New("隔离记录损坏")
	}
	if err := quarantineAllowedPath(meta.OriginalPath); err != nil {
		return "", err
	}
	if _, err := os.Lstat(meta.OriginalPath); err == nil {
		return "", errors.New("原位置已经有一个同名文件，没有覆盖")
	}
	if err := os.MkdirAll(filepath.Dir(meta.OriginalPath), 0755); err != nil {
		return "", fmt.Errorf("原目录不可用：%v", err)
	}
	src := filepath.Join(dir, "file")
	_ = os.Chmod(src, 0600)
	if err := moveFile(src, meta.OriginalPath); err != nil {
		_ = os.Chmod(src, 0)
		return "", fmt.Errorf("放回原处失败：%v", err)
	}
	_ = os.Chmod(meta.OriginalPath, os.FileMode(meta.Mode))
	if meta.UID >= 0 && meta.GID >= 0 {
		_ = os.Lchown(meta.OriginalPath, meta.UID, meta.GID)
	}
	_ = os.RemoveAll(dir)
	return "已把文件放回 " + meta.OriginalPath, nil
}

// moveFile：同一文件系统直接改名；/tmp 常是 tmpfs，跨文件系统就复制再删。
func moveFile(src, dst string) error {
	if err := os.Rename(src, dst); err == nil {
		return nil
	} else if !errors.Is(err, syscall.EXDEV) {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(dst)
		return err
	}
	if err := out.Sync(); err != nil {
		out.Close()
		os.Remove(dst)
		return err
	}
	if err := out.Close(); err != nil {
		os.Remove(dst)
		return err
	}
	return os.Remove(src)
}
