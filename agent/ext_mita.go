package main

// 扩展模块 mita：Mieru 落地的服务端（面板那头 server/ops/mitaAgent.ts）。
//
// 指令 = 这台机器该跑的 mita 配置 + 钉死版本的二进制从哪拿、哈希多少（mita_config.go 的 mitaDirective）。
// 上报 = 跑没跑起来、每个端口听没听上、上次应用的版本，以及每个用户的累计流量（mita_metrics.go）。
//
// Apply 只记下指令、叫醒后台那个 goroutine：装二进制可能要下几十秒，不能堵在扩展通道那一轮里
// （同一轮还有别的模块等着）。后台每分钟也自己跑一轮：服务挂了拉起来，端口状态刷新。

import (
	"context"
	"encoding/json"
	"os"
	"runtime"
	"sync"
	"time"
)

const mitaReconcileInterval = 60 * time.Second

var mitaManagedMarkerPath = agentStatePath("mita.managed")

type mitaExtModule struct {
	manager *mitaManager
	wake    chan struct{}
	once    sync.Once
}

var sharedMitaExtModule = &mitaExtModule{
	manager: newMitaManager(&linuxMitaSystem{}),
	wake:    make(chan struct{}, 1),
}

func init() {
	registerExtModule(sharedMitaExtModule)
}

func (m *mitaExtModule) Name() string { return "mita" }

func (m *mitaExtModule) Report(cfg Config) any {
	return m.manager.report()
}

func (m *mitaExtModule) Apply(cfg Config, raw json.RawMessage) {
	var directive mitaDirective
	if err := json.Unmarshal(raw, &directive); err != nil {
		if shouldLogAgentReport("mita-directive-decode", agentReportLogInterval) {
			logf("mita directive decode failed: %v", err)
		}
		return
	}
	sharedMitaPanelURL.set(cfg.PanelURL)
	changed := m.manager.setDesired(&directive)
	m.once.Do(func() { go m.loop() })
	if changed {
		select {
		case m.wake <- struct{}{}:
		default:
		}
	}
}

func (m *mitaExtModule) loop() {
	ticker := time.NewTicker(mitaReconcileInterval)
	defer ticker.Stop()
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		m.manager.reconcile(ctx)
		cancel()
		select {
		case <-ticker.C:
		case <-m.wake:
		}
	}
}

// 面板地址：面板转发的二进制按它拼。扩展通道每一轮都带着最新的 cfg，记下最后一次的。
type mitaPanelURLHolder struct {
	mu  sync.Mutex
	url string
}

func (h *mitaPanelURLHolder) set(url string) {
	h.mu.Lock()
	h.url = url
	h.mu.Unlock()
}

func (h *mitaPanelURLHolder) get() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.url
}

var sharedMitaPanelURL = &mitaPanelURLHolder{}

// linuxMitaSystem 是 mitaSystem 的真实现：服务管理走 managed_service.go 那一套（systemd / OpenRC /
// procd / SysV 都认），端口就绪走 runtime_listen.go。
type linuxMitaSystem struct {
	shaMu      sync.Mutex
	shaSize    int64
	shaModTime time.Time
	shaValue   string
}

func (s *linuxMitaSystem) arch() string { return runtime.GOARCH }

func (s *linuxMitaSystem) managed() bool {
	_, err := os.Stat(mitaManagedMarkerPath)
	return err == nil
}

func (s *linuxMitaSystem) markManaged() error {
	if s.managed() {
		return nil
	}
	return writeStateFile(mitaManagedMarkerPath, []byte("forwardx-mita is installed and managed by NEX agent\n"))
}

func (s *linuxMitaSystem) clearManaged() {
	_ = os.Remove(mitaManagedMarkerPath)
}

// binarySHA256 按（大小、修改时间）缓存：二进制十几 MB，每分钟重算一遍不值当。
func (s *linuxMitaSystem) binarySHA256() string {
	info, err := os.Stat(mitaBinaryPath)
	if err != nil || !info.Mode().IsRegular() {
		return ""
	}
	s.shaMu.Lock()
	defer s.shaMu.Unlock()
	if s.shaValue != "" && s.shaSize == info.Size() && s.shaModTime.Equal(info.ModTime()) {
		return s.shaValue
	}
	s.shaValue = fileSHA256(mitaBinaryPath)
	s.shaSize = info.Size()
	s.shaModTime = info.ModTime()
	return s.shaValue
}

func (s *linuxMitaSystem) installBinary(ctx context.Context, source mitaBinarySource) error {
	binary, err := fetchVerifiedMitaBinary(ctx, mitaDownloadHTTPClient, sharedMitaPanelURL.get(), source)
	if err != nil {
		return err
	}
	return installMitaBinaryAt(mitaBinaryPath, binary)
}

func (s *linuxMitaSystem) readConfig() []byte {
	data, err := os.ReadFile(mitaConfigPath)
	if err != nil {
		return nil
	}
	return data
}

func (s *linuxMitaSystem) writeConfig(data []byte) error {
	if err := os.MkdirAll(mitaConfigDir, 0700); err != nil {
		return err
	}
	// 0600：里面是每个用户的明文密码。
	return writeFileAtomicDurable(mitaConfigPath, data, 0600)
}

func (s *linuxMitaSystem) removeConfig() {
	_ = os.Remove(mitaConfigPath)
}

func (s *linuxMitaSystem) serviceActive() bool { return managedServiceActive(mitaServiceName) }

func (s *linuxMitaSystem) appliedSignature() string {
	raw, err := os.ReadFile(managedServiceSignaturePath(mitaServiceName))
	if err != nil {
		return ""
	}
	return string(trimNewline(raw))
}

func (s *linuxMitaSystem) applyService(unit string, signature string) bool {
	return writeUnitAndRestart(mitaServiceName, unit, signature)
}

// retireService 只动 forwardx-mita：单元、开机项、签名、日志。二进制留着 —— 用户很可能马上又建一个，
// 重下十几 MB 不值当（sing-box 那边也是这么做的）。
func (s *linuxMitaSystem) retireService() {
	cleanupManagedService(mitaServiceName)
	_ = os.RemoveAll(mitaRunDir)
}

func (s *linuxMitaSystem) listenReady(targets []mitaListenTarget) []bool {
	// 同一个快照查全部端口：端口段展开能有上百个，一个端口跑一次 ss 太重。
	snapshot := newRuntimeListenSnapshot()
	ready := make([]bool, len(targets))
	for index, target := range targets {
		protocol := "tcp"
		if target.Protocol == "UDP" {
			protocol = "udp"
		}
		ready[index] = runtimeListenPortReady(snapshot, target.Port, protocol, []string{mitaServiceName})
	}
	return ready
}

func (s *linuxMitaSystem) listenOwner(port int) string { return listenPortOwnerSummary(port) }

func (s *linuxMitaSystem) queryMetrics() ([]byte, error) { return queryMitaMetrics() }

func (s *linuxMitaSystem) processInstance() string {
	return mitaProcessInstance("/proc", mitaBinaryPath)
}

func trimNewline(raw []byte) []byte {
	for len(raw) > 0 && (raw[len(raw)-1] == '\n' || raw[len(raw)-1] == '\r' || raw[len(raw)-1] == ' ') {
		raw = raw[:len(raw)-1]
	}
	return raw
}
