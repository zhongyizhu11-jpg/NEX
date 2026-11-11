package main

// 扩展模块 "traffic_shutdown"：流量阈值关机（默认关，面板那头见 server/ops/trafficShutdownAgent.ts、
// server/hostTrafficShutdown.ts，规则见 shared/hostTrafficShutdown.ts）。
//
// 主机本周期流量用到管理员设定的比例时，面板认领这个周期唯一的一次名额、先发通知，再在扩展通道
// 回包里下发 {shutdown: true, mark}。这里：
//
//   - 关机命令只在本地挑固定的几个（systemctl poweroff / shutdown -h now / poweroff），绝不执行面板给的命令；
//   - 执行前先把 mark 原子写进本地标记文件并落盘，写不进去就不关（保证不了「每周期一次」宁可不关）；
//   - 同一个 mark 第二次出现（面板重发、机器开回来后又收到）直接忽略 —— 面板那边也记着，两边都持久化；
//   - 只支持以 root 运行的 Linux；Report 里如实报 supported，面板据此决定要不要认领。
//
// 关机会中断整台机器上的所有服务，不等故障转移、不等 DDNS；面板界面上开这个开关时有醒目的警告。

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

const trafficShutdownExecuteDelay = 5 * time.Second

type trafficShutdownDirective struct {
	Shutdown         bool   `json:"shutdown"`
	Mark             string `json:"mark"`
	ThresholdPercent int    `json:"thresholdPercent"`
}

type trafficShutdownLatch struct {
	Mark string `json:"mark"`
	At   int64  `json:"at"`
}

type trafficShutdownExtModule struct {
	mu        sync.Mutex
	inFlight  bool
	lastError string
	// 测试里替换
	latchPath func() string
	supported func() bool
	command   func() ([]string, error)
	run       func(args []string) error
	delay     time.Duration
	now       func() time.Time
}

func newTrafficShutdownExtModule() *trafficShutdownExtModule {
	return &trafficShutdownExtModule{
		latchPath: func() string { return filepath.Join(trafficStateDir, "traffic-shutdown.json") },
		supported: trafficShutdownSupported,
		command:   trafficShutdownCommand,
		run:       runTrafficShutdownCommand,
		delay:     trafficShutdownExecuteDelay,
		now:       time.Now,
	}
}

func init() {
	registerExtModule(newTrafficShutdownExtModule())
}

func (m *trafficShutdownExtModule) Name() string { return "traffic_shutdown" }

func trafficShutdownSupported() bool {
	if runtime.GOOS != "linux" || os.Geteuid() != 0 {
		return false
	}
	_, err := trafficShutdownCommand()
	return err == nil
}

// trafficShutdownCommand 只在本地挑固定的关机命令。
func trafficShutdownCommand() ([]string, error) {
	if runtime.GOOS != "linux" || os.Geteuid() != 0 {
		return nil, fmt.Errorf("traffic shutdown requires a root Linux Agent")
	}
	if info, err := os.Stat("/run/systemd/system"); err == nil && info.IsDir() {
		if path, err := exec.LookPath("systemctl"); err == nil {
			return []string{path, "poweroff"}, nil
		}
	}
	if path, err := exec.LookPath("shutdown"); err == nil {
		return []string{path, "-h", "now"}, nil
	}
	if path, err := exec.LookPath("poweroff"); err == nil {
		return []string{path}, nil
	}
	return nil, fmt.Errorf("no supported shutdown command found")
}

func runTrafficShutdownCommand(args []string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, args[0], args[1:]...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("shutdown command failed: %w (%s)", err, strings.TrimSpace(string(output)))
	}
	return nil
}

func (m *trafficShutdownExtModule) readLatch() trafficShutdownLatch {
	var latch trafficShutdownLatch
	raw, err := os.ReadFile(m.latchPath())
	if err == nil {
		_ = json.Unmarshal(raw, &latch)
	}
	return latch
}

func (m *trafficShutdownExtModule) Report(cfg Config) any {
	m.mu.Lock()
	defer m.mu.Unlock()
	return map[string]any{
		"supported": m.supported(),
		"lastMark":  m.readLatch().Mark,
		"lastError": m.lastError,
	}
}

func (m *trafficShutdownExtModule) Apply(cfg Config, directive json.RawMessage) {
	var d trafficShutdownDirective
	if err := json.Unmarshal(directive, &d); err != nil || !d.Shutdown {
		return
	}
	m.execute(strings.TrimSpace(d.Mark), d.ThresholdPercent)
}

// execute 返回是否真的安排了关机（测试用）。
func (m *trafficShutdownExtModule) execute(mark string, thresholdPercent int) bool {
	if mark == "" || len(mark) > 64 {
		return false
	}
	m.mu.Lock()
	if m.inFlight {
		m.mu.Unlock()
		return false
	}
	if m.readLatch().Mark == mark {
		m.mu.Unlock()
		logf("[HostTrafficShutdown] shutdown for cycle %s already executed; ignoring repeated directive", mark)
		return false
	}
	if !m.supported() {
		m.lastError = "traffic shutdown requires a root Linux Agent"
		m.mu.Unlock()
		logf("[HostTrafficShutdown] %s; not shutting down", m.lastError)
		return false
	}
	args, err := m.command()
	if err != nil || len(args) == 0 {
		if err == nil {
			err = fmt.Errorf("empty shutdown command")
		}
		m.lastError = err.Error()
		m.mu.Unlock()
		logf("[HostTrafficShutdown] %v; not shutting down", err)
		return false
	}
	// 先落盘再关：机器开回来以后同一周期的指令认得出来，不会一开机又关。
	raw, _ := json.Marshal(trafficShutdownLatch{Mark: mark, At: m.now().Unix()})
	latchPath := m.latchPath()
	err = os.MkdirAll(filepath.Dir(latchPath), 0700)
	if err == nil {
		err = writeFileAtomicDurable(latchPath, append(raw, '\n'), 0600)
	}
	if err != nil {
		m.lastError = "persist shutdown latch: " + err.Error()
		m.mu.Unlock()
		logf("[HostTrafficShutdown] %s; not shutting down (cannot guarantee once per cycle)", m.lastError)
		return false
	}
	m.inFlight = true
	m.lastError = ""
	delay := m.delay
	m.mu.Unlock()
	logf("[HostTrafficShutdown] traffic threshold %d%% reached (cycle %s); powering off this machine in %s", thresholdPercent, mark, delay)
	go func() {
		if delay > 0 {
			time.Sleep(delay)
		}
		err := m.run(args)
		m.mu.Lock()
		m.inFlight = false
		if err != nil {
			m.lastError = err.Error()
		}
		m.mu.Unlock()
		if err != nil {
			// 不重试：面板这个周期已经不会再授权，本地标记也写了；排除问题后在面板上关掉开关再打开才会重新布防。
			logf("[HostTrafficShutdown] %v; check permissions, then disable and re-enable the switch in the panel to rearm", err)
		}
	}()
	return true
}
