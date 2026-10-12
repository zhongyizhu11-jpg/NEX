package main

/*
扩展模块 "ops"：全部重启（#15）和导入现有配置（#16）在 Agent 这头的活。

指令（每轮重发，直到面板收到对应的结果）：
  restartAll {requestId}        把这台机器上面板管的转发进程各重启一次；
  scan       {scanId}           扫一遍机器上「不是面板配的」转发（见 ops_scan.go）；
  stops      [{actionId, key}]  停掉扫描结果里 key 对应的那一项原配置（停用并禁用 systemd 单元，
                                或删掉那一条 DNAT）。key 是按内容算的，Agent 停之前重新扫一遍、
                                按 key 找回那一项，找不到就不动 —— 绝不碰没被选中的东西。
上报：各请求的结果（running / done）。结果在内存里留 15 分钟，每轮都报，面板自己去重。

全部重启按 requestId 只做一次：做过的 requestId 记在 /var/lib/forwardx-agent/ops-restart-all.json，
Agent 重启后面板重发同一条指令也不会再重启一遍。重启用的是 Agent 已有的那几个函数：
restartManagedService（realm / socat / gost / nginx / sing-box 的服务）和 FXP 的本地重启。
Agent 进程内的转发（tcp_relay、线路组调度）不在其列 —— 重启它们等于重启 Agent。
*/

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const opsResultTTL = 15 * time.Minute

var opsRestartAllStatePath = "/var/lib/forwardx-agent/ops-restart-all.json"

type opsDirective struct {
	RestartAll *struct {
		RequestID string `json:"requestId"`
	} `json:"restartAll"`
	Scan *struct {
		ScanID string `json:"scanId"`
	} `json:"scan"`
	Stops []struct {
		ActionID string `json:"actionId"`
		Key      string `json:"key"`
	} `json:"stops"`
}

type opsRestartFailure struct {
	Name  string `json:"name"`
	Error string `json:"error"`
}

type opsRestartResult struct {
	RequestID  string              `json:"requestId"`
	Status     string              `json:"status"`
	Restarted  []string            `json:"restarted"`
	Failed     []opsRestartFailure `json:"failed"`
	StartedAt  int64               `json:"startedAt"`
	FinishedAt int64               `json:"finishedAt,omitempty"`
	Repeated   bool                `json:"repeated,omitempty"`
}

type opsScanResult struct {
	ScanID     string        `json:"scanId"`
	Status     string        `json:"status"`
	Items      []opsScanItem `json:"items"`
	Error      string        `json:"error,omitempty"`
	FinishedAt int64         `json:"finishedAt,omitempty"`
}

type opsStopResult struct {
	ActionID   string `json:"actionId"`
	Key        string `json:"key"`
	Status     string `json:"status"`
	OK         bool   `json:"ok"`
	Message    string `json:"message,omitempty"`
	Error      string `json:"error,omitempty"`
	FinishedAt int64  `json:"finishedAt,omitempty"`
}

type opsReport struct {
	RestartAll []opsRestartResult `json:"restartAll,omitempty"`
	Scans      []opsScanResult    `json:"scans,omitempty"`
	Stops      []opsStopResult    `json:"stops,omitempty"`
}

type opsExtModule struct {
	mu       sync.Mutex
	restarts map[string]*opsRestartResult
	scans    map[string]*opsScanResult
	stops    map[string]*opsStopResult
	loaded   bool
	// handled：做过的 restartAll requestId → 完成时间（落盘，见文件头）。
	handled map[string]int64
}

func newOpsExtModule() *opsExtModule {
	return &opsExtModule{
		restarts: map[string]*opsRestartResult{},
		scans:    map[string]*opsScanResult{},
		stops:    map[string]*opsStopResult{},
		handled:  map[string]int64{},
	}
}

func (m *opsExtModule) Name() string { return "ops" }

func opsValidID(id string) bool {
	if id == "" || len(id) > 64 {
		return false
	}
	for _, r := range id {
		if !(r == '-' || r == '_' || (r >= '0' && r <= '9') || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z')) {
			return false
		}
	}
	return true
}

func (m *opsExtModule) loadHandledLocked() {
	if m.loaded {
		return
	}
	m.loaded = true
	raw, err := os.ReadFile(opsRestartAllStatePath)
	if err != nil {
		return
	}
	var saved map[string]int64
	if json.Unmarshal(raw, &saved) == nil {
		for id, at := range saved {
			m.handled[id] = at
		}
	}
}

func (m *opsExtModule) persistHandledLocked() {
	// 只留最近 20 个，免得越攒越多。
	type entry struct {
		id string
		at int64
	}
	entries := make([]entry, 0, len(m.handled))
	for id, at := range m.handled {
		entries = append(entries, entry{id, at})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].at > entries[j].at })
	if len(entries) > 20 {
		for _, e := range entries[20:] {
			delete(m.handled, e.id)
		}
	}
	raw, _ := json.Marshal(m.handled)
	_ = os.MkdirAll(filepath.Dir(opsRestartAllStatePath), 0755)
	if err := writeFileAtomicDurable(opsRestartAllStatePath, raw, 0600); err != nil {
		logf("ops restart-all state write failed: %v", err)
	}
}

func (m *opsExtModule) Report(cfg Config) any {
	m.mu.Lock()
	defer m.mu.Unlock()
	cutoff := time.Now().Add(-opsResultTTL).Unix()
	report := opsReport{}
	for id, r := range m.restarts {
		if r.FinishedAt > 0 && r.FinishedAt < cutoff {
			delete(m.restarts, id)
			continue
		}
		report.RestartAll = append(report.RestartAll, *r)
	}
	for id, r := range m.scans {
		if r.FinishedAt > 0 && r.FinishedAt < cutoff {
			delete(m.scans, id)
			continue
		}
		report.Scans = append(report.Scans, *r)
	}
	for id, r := range m.stops {
		if r.FinishedAt > 0 && r.FinishedAt < cutoff {
			delete(m.stops, id)
			continue
		}
		report.Stops = append(report.Stops, *r)
	}
	if len(report.RestartAll) == 0 && len(report.Scans) == 0 && len(report.Stops) == 0 {
		return nil
	}
	return report
}

func (m *opsExtModule) Apply(cfg Config, directive json.RawMessage) {
	var d opsDirective
	if err := json.Unmarshal(directive, &d); err != nil {
		logf("ops directive invalid: %v", err)
		return
	}
	if d.RestartAll != nil && opsValidID(d.RestartAll.RequestID) {
		m.startRestartAll(d.RestartAll.RequestID)
	}
	if d.Scan != nil && opsValidID(d.Scan.ScanID) {
		m.startScan(d.Scan.ScanID)
	}
	for _, stop := range d.Stops {
		if opsValidID(stop.ActionID) && opsValidID(stop.Key) {
			m.startStop(stop.ActionID, stop.Key)
		}
	}
}

// ---------------------------------------------------------------- 全部重启

func (m *opsExtModule) startRestartAll(requestID string) {
	m.mu.Lock()
	m.loadHandledLocked()
	if _, running := m.restarts[requestID]; running {
		m.mu.Unlock()
		return
	}
	if at, done := m.handled[requestID]; done {
		// 做过了（Agent 重启前做的）：只回一句「做过了」，不再重启一遍。
		m.restarts[requestID] = &opsRestartResult{RequestID: requestID, Status: "done", StartedAt: at, FinishedAt: time.Now().Unix(), Repeated: true}
		m.mu.Unlock()
		return
	}
	result := &opsRestartResult{RequestID: requestID, Status: "running", StartedAt: time.Now().Unix()}
	m.restarts[requestID] = result
	m.handled[requestID] = result.StartedAt
	m.persistHandledLocked()
	m.mu.Unlock()
	go func() {
		logf("ops restart-all request=%s started", requestID)
		restarted, failed := opsRestartManagedRuntimes()
		m.mu.Lock()
		result.Restarted = restarted
		result.Failed = failed
		result.Status = "done"
		result.FinishedAt = time.Now().Unix()
		m.handled[requestID] = result.FinishedAt
		m.persistHandledLocked()
		m.mu.Unlock()
		logf("ops restart-all request=%s done restarted=%d failed=%d", requestID, len(restarted), len(failed))
		wakeAgentExt()
	}()
}

// opsRestartableServicePrefixes：只重启这些前缀的服务 —— 都是面板生成的转发进程。
// forwardx-agent 自己、升级用的临时单元等一律不碰。
var opsRestartableServicePrefixes = []string{"forwardx-realm-", "forwardx-socat-", "forwardx-runtime", "forwardx-tunnel-runtime", "forwardx-nginx", "forwardx-singbox", "forwardx-gost", "forwardx-tunnels"}

func opsServiceRestartable(name string) bool {
	if sanitizeServiceName(name) == "" || strings.HasPrefix(name, "forwardx-agent") {
		return false
	}
	for _, prefix := range opsRestartableServicePrefixes {
		if name == strings.TrimSuffix(prefix, "-") || strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}

// opsManagedServiceCandidates：固定的几个运行时服务 + Agent 写过签名文件的那些（每个由
// writeUnitAndRestart 建的服务都有一份 service_<名字>.signature）。
func opsManagedServiceCandidates() []string {
	seen := map[string]bool{}
	var names []string
	add := func(name string) {
		if !seen[name] && opsServiceRestartable(name) {
			seen[name] = true
			names = append(names, name)
		}
	}
	for _, item := range managedRuntimeConfigs() {
		add(item.service)
	}
	add("forwardx-singbox")
	matches, _ := filepath.Glob(managedServiceSignaturePath("*"))
	for _, path := range matches {
		base := filepath.Base(path)
		add(strings.TrimSuffix(strings.TrimPrefix(base, "service_"), ".signature"))
	}
	sort.Strings(names)
	return names
}

// 测试替换用。
var (
	opsServiceActive  = managedServiceActive
	opsServiceRestart = func(name string) bool {
		restartManagedService(name)
		return managedServiceActive(name)
	}
	opsRestartFXPAll = opsRestartFXPRuntimes
)

func opsRestartManagedRuntimes() ([]string, []opsRestartFailure) {
	restarted := []string{}
	failed := []opsRestartFailure{}
	for _, name := range opsManagedServiceCandidates() {
		// 本来就没在跑的不去拉起：那是面板自己停掉的，或者另有原因，不该借「重启」改变它。
		if !opsServiceActive(name) {
			continue
		}
		if opsServiceRestart(name) {
			restarted = append(restarted, name)
		} else {
			failed = append(failed, opsRestartFailure{Name: name, Error: "重启后没有在运行"})
		}
	}
	fxpRestarted, fxpFailed := opsRestartFXPAll()
	restarted = append(restarted, fxpRestarted...)
	failed = append(failed, fxpFailed...)
	return restarted, failed
}

// opsRestartFXPRuntimes 把正在跑的 FXP 进程逐个停掉、等它退出，再按持久化的期望配置拉起来
// （和 FXP 意外退出后本地重启是同一条路，见 fxp_supervisor.go）。
func opsRestartFXPRuntimes() ([]string, []opsRestartFailure) {
	fxpMu.Lock()
	ids := make([]string, 0, len(fxpServers))
	for id := range fxpServers {
		ids = append(ids, id)
	}
	fxpMu.Unlock()
	sort.Strings(ids)
	restarted := []string{}
	failed := []opsRestartFailure{}
	for _, id := range ids {
		fxpControlMu.Lock()
		fxpMu.Lock()
		process := fxpServers[id]
		fxpMu.Unlock()
		if process == nil {
			fxpControlMu.Unlock()
			continue
		}
		spec := process.spec
		configPath := process.configPath
		var osProcess *os.Process
		if process.cmd != nil {
			osProcess = process.cmd.Process
		}
		stopFXPRuntime(spec)
		fxpControlMu.Unlock()
		deadline := time.Now().Add(8 * time.Second)
		for time.Now().Before(deadline) {
			alive := false
			if osProcess != nil {
				alive = osProcess.Signal(syscall.Signal(0)) == nil
			} else if configPath != "" {
				alive = len(fxpRuntimePIDs(configPath)) > 0
			}
			if !alive {
				break
			}
			time.Sleep(200 * time.Millisecond)
		}
		restartFXPLocally(id)
		fxpMu.Lock()
		_, running := fxpServers[id]
		fxpMu.Unlock()
		label := "fxp:" + id
		if running {
			restarted = append(restarted, label)
		} else {
			// restartFXPLocally 失败时已经交给本地看护按退避继续重试。
			failed = append(failed, opsRestartFailure{Name: label, Error: "没能马上拉起来，Agent 会继续重试"})
		}
	}
	return restarted, failed
}

// ---------------------------------------------------------------- 扫描

var opsScanFn = opsScanSystem

func (m *opsExtModule) startScan(scanID string) {
	m.mu.Lock()
	if _, exists := m.scans[scanID]; exists {
		m.mu.Unlock()
		return
	}
	result := &opsScanResult{ScanID: scanID, Status: "running"}
	m.scans[scanID] = result
	m.mu.Unlock()
	go func() {
		items := func() (items []opsScanItem) {
			defer func() {
				if r := recover(); r != nil {
					logf("ops scan panic: %v", r)
					items = nil
				}
			}()
			return opsScanFn()
		}()
		m.mu.Lock()
		result.Items = items
		if result.Items == nil {
			result.Items = []opsScanItem{}
		}
		result.Status = "done"
		result.FinishedAt = time.Now().Unix()
		m.mu.Unlock()
		wakeAgentExt()
	}()
}

// ---------------------------------------------------------------- 停掉原配置

var opsStopFn = opsStopOriginal

func (m *opsExtModule) startStop(actionID, key string) {
	m.mu.Lock()
	if _, exists := m.stops[actionID]; exists {
		m.mu.Unlock()
		return
	}
	result := &opsStopResult{ActionID: actionID, Key: key, Status: "running"}
	m.stops[actionID] = result
	m.mu.Unlock()
	go func() {
		message, err := opsStopFn(key)
		m.mu.Lock()
		result.Status = "done"
		result.OK = err == nil
		result.Message = message
		if err != nil {
			result.Error = err.Error()
		}
		result.FinishedAt = time.Now().Unix()
		m.mu.Unlock()
		logf("ops stop original key=%s ok=%v %s", key, err == nil, message)
		wakeAgentExt()
	}()
}

func opsFindScanItem(items []opsScanItem, key string) (opsScanItem, bool) {
	for _, item := range items {
		if item.Key == key {
			return item, true
		}
	}
	return opsScanItem{}, false
}

var opsRunShell = runShell

// opsStopCommands 算出停掉这一项要执行的命令（纯函数，测试看它）。
func opsStopCommands(item opsScanItem) ([]string, error) {
	if item.Unit != "" {
		name := sanitizeServiceName(item.Unit)
		if name == "" || strings.HasPrefix(name, "forwardx") {
			return nil, errors.New("这个服务不能停：" + item.Unit)
		}
		q := shellQuote(name + ".service")
		return []string{"systemctl stop " + q, "systemctl disable " + q + " >/dev/null 2>&1 || true"}, nil
	}
	if len(item.refs) == 0 {
		return nil, errors.New("没找到启动它的服务，请到机器上手动停掉原来的进程")
	}
	var commands []string
	for _, ref := range item.refs {
		switch ref.Kind {
		case "iptables", "ip6tables":
			args := opsSplitCommandLine(ref.Line)
			if len(args) < 3 || args[0] != "-A" {
				return nil, errors.New("看不懂这条规则：" + ref.Line)
			}
			args[0] = "-D"
			quoted := make([]string, len(args))
			for i, arg := range args {
				quoted[i] = shellQuote(arg)
			}
			commands = append(commands, ref.Kind+" "+iptablesWaitShellArg+" -t nat "+strings.Join(quoted, " "))
		case "nft":
			if ref.Handle <= 0 || sanitizeServiceName(ref.Table) == "" || sanitizeServiceName(ref.Chain) == "" || sanitizeServiceName(ref.Family) == "" {
				return nil, errors.New("这条 nft 规则信息不全")
			}
			commands = append(commands, "nft delete rule "+shellQuote(ref.Family)+" "+shellQuote(ref.Table)+" "+shellQuote(ref.Chain)+" handle "+strconv.Itoa(ref.Handle))
		default:
			return nil, errors.New("不认识的规则类型 " + ref.Kind)
		}
	}
	return commands, nil
}

func opsStopOriginal(key string) (string, error) {
	item, ok := opsFindScanItem(opsScanFn(), key)
	if !ok {
		return "", errors.New("这一项已经不在了（可能已经停掉或改过），请重新扫描")
	}
	if item.Unit != "" && !isSystemdHost() {
		return "", errors.New("这台机器不是 systemd，请手动停掉 " + item.Unit)
	}
	commands, err := opsStopCommands(item)
	if err != nil {
		return "", err
	}
	for _, command := range commands {
		if !opsRunShell(command) && !strings.HasSuffix(command, "|| true") {
			return "", errors.New("执行失败：" + command)
		}
	}
	if item.Unit != "" {
		return "已停掉并禁用 " + item.Unit, nil
	}
	return "已删除 " + strconv.Itoa(len(commands)) + " 条转发规则", nil
}

func init() {
	registerExtModule(newOpsExtModule())
}
