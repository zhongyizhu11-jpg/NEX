package main

// forwardx-mita 的生命周期：要不要装二进制、写配置、重启服务、收尾。
//
// 判断（planMitaLifecycle）是纯函数，执行靠 mitaSystem 接口 —— 测试里换成假的，不需要真的 mita。
// 三条规矩：
//   - 只在配置或二进制真的变了时才重启：mita 一重启，这台机器上所有 Mieru 连接一起断；
//   - 新配置校验不过、二进制下不下来，都不动正在跑的那一版；
//   - 只收尾自己装的（有 NEX 的标记文件）：机器上别人装的 mita 和它的服务、配置一概不碰。

import (
	"bytes"
	"context"
	"fmt"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

type mitaObserved struct {
	// Managed：标记文件在，说明 forwardx-mita 是 NEX 装的、归 NEX 管。
	Managed       bool
	BinarySHA256  string
	ConfigOnDisk  []byte
	ServiceActive bool
	// AppliedSignature：上次成功启动时的签名（配置 + 二进制）。
	AppliedSignature string
}

type mitaLifecyclePlan struct {
	InstallBinary bool
	WriteConfig   bool
	ApplyService  bool
	Retire        bool
	// Reason 给日志看：为什么要动（或者为什么不动）。
	Reason string
}

func (p mitaLifecyclePlan) noop() bool {
	return !p.InstallBinary && !p.WriteConfig && !p.ApplyService && !p.Retire
}

// planMitaLifecycle 决定这一轮要做什么。rendered / wantSHA256 是这一版应有的配置和二进制哈希
// （enabled 为 false 时不看）。
func planMitaLifecycle(enabled bool, rendered []byte, wantSHA256 string, observed mitaObserved) mitaLifecyclePlan {
	if !enabled {
		if !observed.Managed {
			return mitaLifecyclePlan{Reason: "not managed by NEX"}
		}
		return mitaLifecyclePlan{Retire: true, Reason: "no mieru inbound"}
	}
	plan := mitaLifecyclePlan{}
	reasons := []string{}
	if observed.BinarySHA256 != wantSHA256 {
		plan.InstallBinary = true
		reasons = append(reasons, "binary")
	}
	if !bytes.Equal(observed.ConfigOnDisk, rendered) {
		plan.WriteConfig = true
		reasons = append(reasons, "config")
	}
	signature := mitaSignature(rendered, wantSHA256)
	switch {
	case plan.InstallBinary || plan.WriteConfig:
		plan.ApplyService = true
	case !observed.ServiceActive:
		plan.ApplyService = true
		reasons = append(reasons, "service inactive")
	case observed.AppliedSignature != signature:
		plan.ApplyService = true
		reasons = append(reasons, "signature")
	}
	plan.Reason = strings.Join(reasons, ",")
	return plan
}

// mitaSystem 是 mita 管理器对这台机器的全部依赖。
type mitaSystem interface {
	arch() string
	managed() bool
	markManaged() error
	clearManaged()
	binarySHA256() string
	installBinary(ctx context.Context, source mitaBinarySource) error
	readConfig() []byte
	writeConfig(data []byte) error
	removeConfig()
	serviceActive() bool
	appliedSignature() string
	// applyService 写服务单元并按签名决定是否重启（writeUnitAndRestart 那一套）。
	applyService(unit string, signature string) bool
	retireService()
	// listenReady 一次查完全部端口（一次 ss），返回和 targets 一一对应的结果。
	listenReady(targets []mitaListenTarget) []bool
	listenOwner(port int) string
	queryMetrics() ([]byte, error)
	processInstance() string
}

type mitaUserCounter struct {
	Name string `json:"name"`
	Up   uint64 `json:"up"`
	Down uint64 `json:"down"`
}

type mitaListenerStatus struct {
	Port     int    `json:"port"`
	Protocol string `json:"protocol"`
	Ready    bool   `json:"ready"`
}

type mitaStatus struct {
	State     string               `json:"state"`
	Error     string               `json:"error"`
	Revision  string               `json:"revision"`
	Version   string               `json:"version"`
	Active    bool                 `json:"active"`
	Listeners []mitaListenerStatus `json:"listeners"`
}

type mitaManager struct {
	sys mitaSystem

	mu       sync.Mutex
	desired  *mitaDirective
	status   mitaStatus
	lastPlan string
	// readyWait / readyPoll：重启后等端口听上的时间。测试里调小。
	readyWait time.Duration
	readyPoll time.Duration
}

func newMitaManager(sys mitaSystem) *mitaManager {
	return &mitaManager{sys: sys, readyWait: 15 * time.Second, readyPoll: 500 * time.Millisecond}
}

func (m *mitaManager) setDesired(d *mitaDirective) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.desired != nil && d != nil && m.desired.Revision == d.Revision && m.desired.Enabled == d.Enabled {
		return false
	}
	m.desired = d
	return true
}

func (m *mitaManager) desiredDirective() *mitaDirective {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.desired
}

func (m *mitaManager) setStatus(status mitaStatus) {
	m.mu.Lock()
	m.status = status
	m.mu.Unlock()
}

func (m *mitaManager) currentStatus() mitaStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	status := m.status
	status.Listeners = append([]mitaListenerStatus(nil), m.status.Listeners...)
	return status
}

// reconcile 按当前指令跑一轮。没收到过指令时什么都不做：Agent 刚起来、还没和面板说上话，
// 机器上那个 mita 照旧跑着（systemd 会拉起它），不该因为「还不知道」就停掉。
func (m *mitaManager) reconcile(ctx context.Context) {
	directive := m.desiredDirective()
	if directive == nil {
		return
	}
	source, err := validateMitaDirective(directive, m.sys.arch())
	if err != nil {
		m.fail(directive, "指令不合法："+err.Error())
		return
	}
	if !directive.Enabled {
		plan := planMitaLifecycle(false, nil, "", mitaObserved{Managed: m.sys.managed()})
		if plan.Retire {
			m.sys.retireService()
			m.sys.removeConfig()
			m.sys.clearManaged()
			logf("mita retired: %s", plan.Reason)
		}
		m.setStatus(mitaStatus{State: "disabled", Revision: directive.Revision})
		return
	}
	rendered, err := renderMitaServerConfig(directive.Config)
	if err != nil {
		// 不写、不重启：正在跑的旧配置接着服务别的入站。
		m.fail(directive, "mita 配置校验失败："+err.Error())
		return
	}
	observed := mitaObserved{
		Managed:          m.sys.managed(),
		BinarySHA256:     m.sys.binarySHA256(),
		ConfigOnDisk:     m.sys.readConfig(),
		ServiceActive:    m.sys.serviceActive(),
		AppliedSignature: m.sys.appliedSignature(),
	}
	plan := planMitaLifecycle(true, rendered, source.SHA256, observed)
	targets := mitaListenTargets(directive.Config)
	if plan.noop() {
		m.setStatus(m.runningStatus(directive, targets, ""))
		return
	}
	if err := m.sys.markManaged(); err != nil {
		m.fail(directive, "写 NEX 标记失败："+err.Error())
		return
	}
	if plan.InstallBinary {
		m.setStatus(mitaStatus{State: "installing", Revision: m.currentStatus().Revision, Version: directive.Version})
		if err := m.sys.installBinary(ctx, source); err != nil {
			m.fail(directive, "安装 mita "+directive.Version+" 失败："+err.Error())
			return
		}
	}
	if plan.WriteConfig {
		if err := m.sys.writeConfig(rendered); err != nil {
			m.fail(directive, "写 mita 配置失败："+err.Error())
			return
		}
	}
	signature := mitaSignature(rendered, source.SHA256)
	if !m.sys.applyService(mitaServiceUnit(), signature) {
		m.fail(directive, "forwardx-mita 服务启动失败")
		return
	}
	if plan.Reason != m.lastPlan {
		logf("mita applied revision=%s reason=%s listeners=%d", directive.Revision, plan.Reason, len(targets))
		m.lastPlan = plan.Reason
	}
	m.setStatus(m.waitReady(ctx, directive, targets))
}

func (m *mitaManager) fail(directive *mitaDirective, message string) {
	previous := m.currentStatus()
	if shouldLogAgentReport("mita-error:"+message, agentReportLogInterval) {
		logf("mita: %s", message)
	}
	m.setStatus(mitaStatus{
		State:     "error",
		Error:     message,
		Revision:  previous.Revision,
		Version:   directive.Version,
		Active:    m.sys.serviceActive(),
		Listeners: previous.Listeners,
	})
}

// waitReady 重启之后等端口真的听上：服务 active 只说明进程在，不说明 bind 成功了。
func (m *mitaManager) waitReady(ctx context.Context, directive *mitaDirective, targets []mitaListenTarget) mitaStatus {
	deadline := time.Now().Add(m.readyWait)
	for {
		status := m.runningStatus(directive, targets, "")
		if status.State == "running" || time.Now().After(deadline) {
			return status
		}
		select {
		case <-ctx.Done():
			return status
		case <-time.After(m.readyPoll):
		}
	}
}

// runningStatus 是「这一版已经应用了」之后的状态：服务在不在、每个端口听没听上。
func (m *mitaManager) runningStatus(directive *mitaDirective, targets []mitaListenTarget, message string) mitaStatus {
	status := mitaStatus{
		State:    "running",
		Error:    message,
		Revision: directive.Revision,
		Version:  directive.Version,
		Active:   m.sys.serviceActive(),
	}
	notReady := []string{}
	readiness := []bool{}
	if status.Active {
		readiness = m.sys.listenReady(targets)
	}
	for index, target := range targets {
		ready := index < len(readiness) && readiness[index]
		status.Listeners = append(status.Listeners, mitaListenerStatus{Port: target.Port, Protocol: target.Protocol, Ready: ready})
		if !ready {
			notReady = append(notReady, fmt.Sprintf("%s %d", target.Protocol, target.Port))
		}
	}
	switch {
	case !status.Active:
		status.State = "error"
		status.Error = "forwardx-mita 服务没在运行"
	case len(notReady) > 0:
		status.State = "error"
		sort.Strings(notReady)
		sample := notReady
		if len(sample) > 3 {
			sample = sample[:3]
		}
		status.Error = "端口没有听上：" + strings.Join(sample, "、")
		// 端口被别的进程占着（比如机器上另装的 mita）：说出来是谁，但不去动它。
		if owner := m.sys.listenOwner(targets[0].Port); owner != "" && !strings.Contains(owner, mitaServiceName) {
			status.Error += "（" + compactLogOutput(owner) + "）"
		}
	}
	return status
}

// trafficReport 读 mita 的按用户累计计数。服务没在跑时不读（读了也是报错）。
func (m *mitaManager) trafficReport() map[string]any {
	if !m.sys.managed() || !m.sys.serviceActive() {
		return nil
	}
	instance := m.sys.processInstance()
	if instance == "" {
		return nil
	}
	raw, err := m.sys.queryMetrics()
	if err != nil {
		if shouldLogAgentReport("mita-metrics", agentReportLogInterval) {
			logf("mita metrics failed: %v", err)
		}
		return nil
	}
	counters, err := parseMitaUserMetrics(raw)
	if err != nil {
		if shouldLogAgentReport("mita-metrics-parse", agentReportLogInterval) {
			logf("mita metrics parse failed: %v", err)
		}
		return nil
	}
	// 读数前后进程换了：这份计数说不清属于哪个进程，这一轮不报，下一轮再说。
	if after := m.sys.processInstance(); after != instance {
		return nil
	}
	return map[string]any{"instance": instance, "users": counters}
}

func (m *mitaManager) report() any {
	directive := m.desiredDirective()
	if directive == nil && !m.sys.managed() {
		return nil
	}
	status := m.currentStatus()
	out := map[string]any{
		"state":     status.State,
		"error":     status.Error,
		"revision":  status.Revision,
		"version":   status.Version,
		"active":    status.Active,
		"listeners": status.Listeners,
		"arch":      runtime.GOARCH,
	}
	if traffic := m.trafficReport(); traffic != nil {
		out["traffic"] = traffic
	}
	return out
}
