package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

/*
装着的 gost 运行时（/usr/local/bin/forwardx-runtime）是哪一版、能做什么，以及升级坏了怎么退回去。

为什么要问：Shadowsocks 出口的 UDP 和 SS2022 只有 NEX 自编运行时 3.2.6-nex3 起才和 sing-box 互通
（gost-runtime/nex-ssu.patch、nex-shadowsocks2.patch）。运行时和 Agent 是两个文件、由安装脚本分别装：
Agent 升了，运行时可能因为下载失败、面板只有官方版、或者升级后起不来被退回，仍是旧的。所以 Agent
不按自己的版本号猜，而是每次换了文件就跑一次 `forwardx-runtime -V`，解析出 "3.2.6-nexN"，随心跳报给
面板（runtimeVersion），并按实测结果报能力（agentCapabilities）：
  - ssEgressUdp / ssEgress2022：Agent ≥ 2.2.227、运行时构建号 ≥ nex3、这个文件不是回滚下来的。
面板只把 UDP / SS2022 出口发给报了能力的机器，没报的机器上这类规则按停用下发（shared/ssEgress.ts）。
只问版本号，不在每次启动时做网络测试；`-V` 本身就是「这个二进制在这台机器上跑得起来」的自检。

回滚：安装脚本换运行时之前把旧文件留成 forwardx-runtime.prev，换完写一个待确认标记
（runtime-upgrade.json）。Agent 启动后和之后每次心跳都看一眼这个标记：
  - 新文件 `-V` 都跑不起来，或者有规则要它跑、服务却在宽限期（90 秒）后仍没起来 → 拿 .prev 换回去、
    重启服务、记下回滚（runtime-rollback.json），这个文件对应的能力一律报 false；
  - 服务正常跑满 60 秒（或者这台机器上没有 gost 规则、`-V` 正常）→ 确认升级，删掉标记。
安装脚本自己重启服务后也会马上查一次，起不来当场退回（server/agentInstallScripts.ts）。
*/

const (
	gostRuntimeBinaryPath          = "/usr/local/bin/forwardx-runtime"
	gostRuntimePreviousSuffix      = ".prev"
	gostRuntimeUpgradeMarkerPath   = "/var/lib/forwardx-agent/runtime-upgrade.json"
	gostRuntimeRollbackStatePath   = "/var/lib/forwardx-agent/runtime-rollback.json"
	gostRuntimeVersionProbeTimeout = 5 * time.Second
	// 升级后服务要在这个时间内起来，否则回滚；正常跑满 commit 时间就确认。
	gostRuntimeUpgradeStartGrace  = 90 * time.Second
	gostRuntimeUpgradeCommitAfter = 60 * time.Second
	// 标记太旧（例如 Agent 停了很久）就不再据此回滚，只确认 / 清掉。
	gostRuntimeUpgradeMarkerMaxAge = 24 * time.Hour

	// 和 shared/ssEgress.ts 保持一致（scripts/check-versions.mjs 会查）。
	ssEgressCapabilityAgentVersion = "2.2.227"
	ssEgressRuntimeMinNexBuild     = 3
	agentCapabilitySsEgressUDP     = "ssEgressUdp"
	agentCapabilitySsEgress2022    = "ssEgress2022"

	gostRuntimeVersionMissing = "missing"
	gostRuntimeVersionUnknown = "unknown"
)

var gostRuntimeVersionPattern = regexp.MustCompile(`(?i)\bgost\s+v?(\d+\.\d+\.\d+)(?:-nex(\d+))?\b`)

type gostRuntimeVersionInfo struct {
	// Version 是上报给面板的版本：3.2.6-nex3、3.2.6（官方版）、missing、unknown。
	Version  string
	Base     string
	NexBuild int
	OK       bool
}

// parseGostRuntimeVersion 解析 `gost -V` 的输出，例如 "gost 3.2.6-nex3 (go1.25.4 linux/amd64)"。
func parseGostRuntimeVersion(output string) gostRuntimeVersionInfo {
	match := gostRuntimeVersionPattern.FindStringSubmatch(output)
	if match == nil {
		return gostRuntimeVersionInfo{Version: gostRuntimeVersionUnknown}
	}
	info := gostRuntimeVersionInfo{Base: match[1], Version: match[1], OK: true}
	if match[2] != "" {
		info.NexBuild, _ = strconv.Atoi(match[2])
		info.Version = fmt.Sprintf("%s-nex%d", match[1], info.NexBuild)
	}
	return info
}

type gostRuntimeFingerprint struct {
	Size    int64  `json:"size"`
	ModTime int64  `json:"modTime"`
	Inode   uint64 `json:"inode"`
}

func statGostRuntimeFingerprint(path string) (gostRuntimeFingerprint, bool) {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return gostRuntimeFingerprint{}, false
	}
	fp := gostRuntimeFingerprint{Size: info.Size(), ModTime: info.ModTime().UnixNano()}
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		fp.Inode = uint64(st.Ino)
	}
	return fp, true
}

// sameGostRuntimeFile 比较两个指纹是不是同一个文件。修改时间只比到秒：安装脚本用 stat 写的回滚记录
// 只有秒（见 server/agentInstallScripts.ts rollback_runtime_binary）。
func sameGostRuntimeFile(a, b gostRuntimeFingerprint) bool {
	return a.Size == b.Size && a.Inode == b.Inode && a.ModTime/int64(time.Second) == b.ModTime/int64(time.Second)
}

var gostRuntimeVersionCache = struct {
	sync.Mutex
	path  string
	fp    gostRuntimeFingerprint
	info  gostRuntimeVersionInfo
	valid bool
}{}

// probeGostRuntimeBinary 跑 `<bin> -V`。definitive=false 表示这次问不出结论（超时），不缓存。
var probeGostRuntimeBinary = func(path string) (gostRuntimeVersionInfo, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), gostRuntimeVersionProbeTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, "-V")
	cmd.WaitDelay = time.Second
	output, _ := cmd.CombinedOutput()
	if ctx.Err() != nil {
		return gostRuntimeVersionInfo{Version: gostRuntimeVersionUnknown}, false
	}
	// 跑不起来（架构不对、文件坏了）解析不出版本，就是 unknown 且确定。
	return parseGostRuntimeVersion(string(output)), true
}

// installedGostRuntimeVersion 返回装着的运行时版本，按文件指纹缓存，换了文件才重新问。
func installedGostRuntimeVersion(path string) (gostRuntimeVersionInfo, gostRuntimeFingerprint) {
	fp, ok := statGostRuntimeFingerprint(path)
	if !ok {
		return gostRuntimeVersionInfo{Version: gostRuntimeVersionMissing}, gostRuntimeFingerprint{}
	}
	gostRuntimeVersionCache.Lock()
	if gostRuntimeVersionCache.valid && gostRuntimeVersionCache.path == path && gostRuntimeVersionCache.fp == fp {
		info := gostRuntimeVersionCache.info
		gostRuntimeVersionCache.Unlock()
		return info, fp
	}
	gostRuntimeVersionCache.Unlock()
	info, definitive := probeGostRuntimeBinary(path)
	if definitive {
		gostRuntimeVersionCache.Lock()
		gostRuntimeVersionCache.path = path
		gostRuntimeVersionCache.fp = fp
		gostRuntimeVersionCache.info = info
		gostRuntimeVersionCache.valid = true
		gostRuntimeVersionCache.Unlock()
	}
	return info, fp
}

func resetGostRuntimeVersionCache() {
	gostRuntimeVersionCache.Lock()
	gostRuntimeVersionCache.valid = false
	gostRuntimeVersionCache.Unlock()
}

// gostRuntimeRollbackState 是 Agent 回滚运行时后留下的记录。RestoredFingerprint 是退回去的那个文件：
// 只要装着的还是它，UDP / SS2022 的能力就报 false（哪怕退回去的也是 nex3：它刚证明过在这台机器上起不来）。
type gostRuntimeRollbackState struct {
	FailedVersion       string                 `json:"failedVersion"`
	RestoredVersion     string                 `json:"restoredVersion"`
	Reason              string                 `json:"reason"`
	At                  int64                  `json:"at"`
	RestoredFingerprint gostRuntimeFingerprint `json:"restoredFingerprint"`
}

func readGostRuntimeRollbackState(path string) (gostRuntimeRollbackState, bool) {
	raw, err := os.ReadFile(path)
	if err != nil || len(raw) == 0 {
		return gostRuntimeRollbackState{}, false
	}
	var state gostRuntimeRollbackState
	if json.Unmarshal(raw, &state) != nil {
		return gostRuntimeRollbackState{}, false
	}
	return state, true
}

func writeJSONFileAtomic(path string, value any) error {
	raw, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-"+filepath.Base(path)+"-*")
	if err != nil {
		return err
	}
	if _, err := tmp.Write(append(raw, '\n')); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// agentVersionAtLeast 比较 x.y.z。
func agentVersionAtLeast(version, target string) bool {
	return compareFXPVersions(strings.TrimPrefix(strings.TrimSpace(version), "v"), target) >= 0
}

// gostRuntimeCapabilities 是按实测结果算出来的能力（纯函数，测试直接调）。
func gostRuntimeCapabilities(agentVersion string, info gostRuntimeVersionInfo, fp gostRuntimeFingerprint, rollback *gostRuntimeRollbackState) []string {
	if !agentVersionAtLeast(agentVersion, ssEgressCapabilityAgentVersion) {
		return []string{}
	}
	if !info.OK || info.NexBuild < ssEgressRuntimeMinNexBuild {
		return []string{}
	}
	if rollback != nil && sameGostRuntimeFile(rollback.RestoredFingerprint, fp) {
		return []string{}
	}
	caps := []string{agentCapabilitySsEgressUDP, agentCapabilitySsEgress2022}
	sort.Strings(caps)
	return caps
}

// reportedGostRuntime 是心跳里带的两项：运行时版本和能力。
func reportedGostRuntime() (string, []string) {
	info, fp := installedGostRuntimeVersion(gostRuntimeBinaryPath)
	var rollback *gostRuntimeRollbackState
	if state, ok := readGostRuntimeRollbackState(gostRuntimeRollbackStatePath); ok {
		rollback = &state
	}
	return info.Version, gostRuntimeCapabilities(Version, info, fp, rollback)
}

// addGostRuntimeReport 往心跳里加 runtimeVersion / agentCapabilities（每次都带，面板以最新一次为准）。
// 顺手看一眼待确认的运行时升级（没有标记文件时只是一次 stat）。
func addGostRuntimeReport(payload map[string]any) {
	// 确认 / 回滚可能要重启服务，不能卡住心跳；结果下一次心跳就能报上去。
	go checkGostRuntimeUpgradeIfDue()
	version, caps := reportedGostRuntime()
	payload["runtimeVersion"] = version
	payload["agentCapabilities"] = caps
}

/* ── 升级确认 / 回滚 ─────────────────────────────────────────────────── */

// gostRuntimeUpgradeMarker 由安装脚本在换掉运行时之后写下。
type gostRuntimeUpgradeMarker struct {
	PreviousPath    string `json:"previousPath"`
	PreviousVersion string `json:"previousVersion"`
	NewVersion      string `json:"newVersion"`
	StartedAt       int64  `json:"startedAt"`
}

// gostRuntimeUpgradeEnv 把文件系统和服务操作抽出来，测试里换成假的。
type gostRuntimeUpgradeEnv struct {
	binaryPath     string
	markerPath     string
	rollbackPath   string
	now            func() time.Time
	version        func(path string) (gostRuntimeVersionInfo, gostRuntimeFingerprint)
	serviceNeeded  func() bool
	serviceActive  func() bool
	restartService func()
}

func defaultGostRuntimeUpgradeEnv() gostRuntimeUpgradeEnv {
	return gostRuntimeUpgradeEnv{
		binaryPath:   gostRuntimeBinaryPath,
		markerPath:   gostRuntimeUpgradeMarkerPath,
		rollbackPath: gostRuntimeRollbackStatePath,
		now:          time.Now,
		version: func(path string) (gostRuntimeVersionInfo, gostRuntimeFingerprint) {
			if path == gostRuntimeBinaryPath {
				return installedGostRuntimeVersion(path)
			}
			fp, _ := statGostRuntimeFingerprint(path)
			info, _ := probeGostRuntimeBinary(path)
			return info, fp
		},
		// forwardx-runtime 和 forwardx-tunnel-runtime 跑的是同一个二进制：哪个有规则就看哪个。
		serviceNeeded: func() bool { return len(requiredGostRuntimeServicesFromLocalConfig()) > 0 },
		serviceActive: func() bool {
			for _, name := range requiredGostRuntimeServicesFromLocalConfig() {
				if !managedServiceActive(name) {
					return false
				}
			}
			return true
		},
		restartService: func() {
			for _, name := range requiredGostRuntimeServicesFromLocalConfig() {
				restartManagedService(name)
			}
		},
	}
}

const (
	gostRuntimeUpgradeNone       = "none"
	gostRuntimeUpgradePending    = "pending"
	gostRuntimeUpgradeCommitted  = "committed"
	gostRuntimeUpgradeRolledBack = "rolled-back"
	gostRuntimeUpgradeStuck      = "rollback-failed"
)

var gostRuntimeUpgradeMu sync.Mutex

// reconcileGostRuntimeUpgrade 看一眼待确认的运行时升级：确认、回滚，或者继续等。返回做了什么。
func reconcileGostRuntimeUpgrade(env gostRuntimeUpgradeEnv) (string, error) {
	gostRuntimeUpgradeMu.Lock()
	defer gostRuntimeUpgradeMu.Unlock()
	raw, err := os.ReadFile(env.markerPath)
	if err != nil || len(raw) == 0 {
		return gostRuntimeUpgradeNone, nil
	}
	var marker gostRuntimeUpgradeMarker
	if err := json.Unmarshal(raw, &marker); err != nil {
		os.Remove(env.markerPath)
		return gostRuntimeUpgradeNone, fmt.Errorf("invalid runtime upgrade marker: %w", err)
	}
	if marker.PreviousPath == "" {
		marker.PreviousPath = env.binaryPath + gostRuntimePreviousSuffix
	}
	now := env.now()
	started := time.Unix(marker.StartedAt, 0)
	elapsed := now.Sub(started)
	current, _ := env.version(env.binaryPath)

	commit := func() (string, error) {
		os.Remove(env.markerPath)
		// 新文件确认能用：之前的回滚记录作废（它记的是别的文件）。
		os.Remove(env.rollbackPath)
		return gostRuntimeUpgradeCommitted, nil
	}

	if marker.StartedAt <= 0 || elapsed > gostRuntimeUpgradeMarkerMaxAge {
		// 太旧的标记不再据此回滚：能问出版本就确认，问不出也只清掉标记、交给下次安装脚本处理。
		os.Remove(env.markerPath)
		if current.OK {
			os.Remove(env.rollbackPath)
			return gostRuntimeUpgradeCommitted, nil
		}
		return gostRuntimeUpgradeNone, nil
	}

	reason := ""
	switch {
	case !current.OK:
		reason = fmt.Sprintf("new runtime %s failed its self-check (-V)", emptyDash(marker.NewVersion))
	case !env.serviceNeeded():
		// 这台机器上没有要 gost 跑的规则：-V 正常就算能用。
		return commit()
	case env.serviceActive():
		if elapsed >= gostRuntimeUpgradeCommitAfter {
			return commit()
		}
		return gostRuntimeUpgradePending, nil
	case elapsed >= gostRuntimeUpgradeStartGrace:
		reason = fmt.Sprintf("gost runtime service not active %s after upgrading to %s", elapsed.Round(time.Second), current.Version)
	default:
		return gostRuntimeUpgradePending, nil
	}
	return rollbackGostRuntime(env, marker, current, reason)
}

func rollbackGostRuntime(env gostRuntimeUpgradeEnv, marker gostRuntimeUpgradeMarker, current gostRuntimeVersionInfo, reason string) (string, error) {
	previous, _ := env.version(marker.PreviousPath)
	if !previous.OK {
		// 没有能用的旧文件可退：留着新文件（至少不比没有强），能力照常按实测报。
		os.Remove(env.markerPath)
		return gostRuntimeUpgradeStuck, fmt.Errorf("%s; previous runtime %s unusable, cannot roll back", reason, marker.PreviousPath)
	}
	if err := copyFileAtomic(marker.PreviousPath, env.binaryPath, 0o755); err != nil {
		return gostRuntimeUpgradeStuck, fmt.Errorf("%s; rollback copy failed: %w", reason, err)
	}
	resetGostRuntimeVersionCache()
	restored, fp := env.version(env.binaryPath)
	state := gostRuntimeRollbackState{
		FailedVersion:       firstNonEmpty(current.Version, marker.NewVersion),
		RestoredVersion:     restored.Version,
		Reason:              reason,
		At:                  env.now().Unix(),
		RestoredFingerprint: fp,
	}
	if err := writeJSONFileAtomic(env.rollbackPath, state); err != nil {
		logf("runtime rollback state write failed: %v", err)
	}
	os.Remove(env.markerPath)
	if env.serviceNeeded() {
		env.restartService()
	}
	return gostRuntimeUpgradeRolledBack, errors.New(reason)
}

func copyFileAtomic(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp, err := os.CreateTemp(filepath.Dir(dst), "."+filepath.Base(dst)+".rollback-*")
	if err != nil {
		return err
	}
	if _, err := io.Copy(tmp, in); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	return os.Rename(tmp.Name(), dst)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

var lastGostRuntimeUpgradeCheck struct {
	sync.Mutex
	at time.Time
}

// checkGostRuntimeUpgradeIfDue 由心跳调用：只有标记文件在的时候才真的检查，最多每 10 秒一次。
func checkGostRuntimeUpgradeIfDue() {
	if _, err := os.Stat(gostRuntimeUpgradeMarkerPath); err != nil {
		return
	}
	lastGostRuntimeUpgradeCheck.Lock()
	if time.Since(lastGostRuntimeUpgradeCheck.at) < 10*time.Second {
		lastGostRuntimeUpgradeCheck.Unlock()
		return
	}
	lastGostRuntimeUpgradeCheck.at = time.Now()
	lastGostRuntimeUpgradeCheck.Unlock()
	result, err := reconcileGostRuntimeUpgrade(defaultGostRuntimeUpgradeEnv())
	switch result {
	case gostRuntimeUpgradeCommitted:
		version, _ := reportedGostRuntime()
		logf("gost runtime upgrade confirmed version=%s", version)
	case gostRuntimeUpgradeRolledBack:
		version, _ := reportedGostRuntime()
		logf("gost runtime upgrade rolled back to %s: %v", version, err)
	case gostRuntimeUpgradeStuck:
		logf("gost runtime upgrade check: %v", err)
	}
}

// gostRuntimeStartupSelfCheck 在 Agent 启动时问一次运行时版本、处理待确认的升级。只跑 -V，不做网络测试。
func gostRuntimeStartupSelfCheck() {
	checkGostRuntimeUpgradeIfDue()
	version, caps := reportedGostRuntime()
	rollbackNote := ""
	if state, ok := readGostRuntimeRollbackState(gostRuntimeRollbackStatePath); ok {
		rollbackNote = fmt.Sprintf(" rollback=%s->%s reason=%q", state.FailedVersion, state.RestoredVersion, state.Reason)
	}
	logf("gost runtime self-check path=%s version=%s capabilities=%s%s", gostRuntimeBinaryPath, version, strings.Join(caps, ","), rollbackNote)
}
