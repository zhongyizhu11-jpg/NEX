package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestParseGostRuntimeVersion(t *testing.T) {
	cases := []struct {
		out      string
		version  string
		nexBuild int
		ok       bool
	}{
		{"gost 3.2.6-nex3 (go1.25.4 linux/amd64)\n", "3.2.6-nex3", 3, true},
		{"gost 3.2.6-nex2 (go1.25.4 linux/arm64)", "3.2.6-nex2", 2, true},
		{"gost 3.2.6-nex12 (go1.25.4 linux/amd64)", "3.2.6-nex12", 12, true},
		{"gost 3.2.6 (go1.25.4 linux/amd64)", "3.2.6", 0, true},
		{"gost v3.3.0 (go1.26 linux/amd64)", "3.3.0", 0, true},
		{"exec format error", gostRuntimeVersionUnknown, 0, false},
		{"", gostRuntimeVersionUnknown, 0, false},
	}
	for _, c := range cases {
		got := parseGostRuntimeVersion(c.out)
		if got.Version != c.version || got.NexBuild != c.nexBuild || got.OK != c.ok {
			t.Fatalf("parse(%q) = %+v, want version=%s nex=%d ok=%v", c.out, got, c.version, c.nexBuild, c.ok)
		}
	}
}

func TestGostRuntimeCapabilities(t *testing.T) {
	nex3 := parseGostRuntimeVersion("gost 3.2.6-nex3 (go)")
	nex2 := parseGostRuntimeVersion("gost 3.2.6-nex2 (go)")
	upstream := parseGostRuntimeVersion("gost 3.2.6 (go)")
	fp := gostRuntimeFingerprint{Size: 10, ModTime: 20, Inode: 30}
	both := []string{agentCapabilitySsEgress2022, agentCapabilitySsEgressUDP}

	if got := gostRuntimeCapabilities("2.2.227", nex3, fp, nil); !reflect.DeepEqual(got, both) {
		t.Fatalf("nex3 on 2.2.227: %v", got)
	}
	if got := gostRuntimeCapabilities("2.3.0", parseGostRuntimeVersion("gost 3.2.6-nex4"), fp, nil); !reflect.DeepEqual(got, both) {
		t.Fatalf("newer build: %v", got)
	}
	for name, got := range map[string][]string{
		"old agent":      gostRuntimeCapabilities("2.2.226", nex3, fp, nil),
		"nex2 runtime":   gostRuntimeCapabilities("2.2.227", nex2, fp, nil),
		"upstream":       gostRuntimeCapabilities("2.2.227", upstream, fp, nil),
		"missing":        gostRuntimeCapabilities("2.2.227", gostRuntimeVersionInfo{Version: gostRuntimeVersionMissing}, fp, nil),
		"rolled back to": gostRuntimeCapabilities("2.2.227", nex3, fp, &gostRuntimeRollbackState{RestoredFingerprint: fp}),
	} {
		if len(got) != 0 {
			t.Fatalf("%s should report no capability, got %v", name, got)
		}
	}
	// 回滚记录记的是别的文件（之后又成功升级了）：照常报。
	other := gostRuntimeFingerprint{Size: 11, ModTime: 20, Inode: 30}
	if got := gostRuntimeCapabilities("2.2.227", nex3, fp, &gostRuntimeRollbackState{RestoredFingerprint: other}); !reflect.DeepEqual(got, both) {
		t.Fatalf("stale rollback record must not hide capability: %v", got)
	}
	if !agentVersionAtLeast(Version, ssEgressCapabilityAgentVersion) {
		t.Fatalf("this Agent (%s) must be at least %s", Version, ssEgressCapabilityAgentVersion)
	}
}

type fakeRuntimeUpgrade struct {
	dir       string
	env       gostRuntimeUpgradeEnv
	now       time.Time
	needed    bool
	active    bool
	restarts  int
	versionOf map[string]string // 文件内容 -> -V 输出
}

func newFakeRuntimeUpgrade(t *testing.T) *fakeRuntimeUpgrade {
	t.Helper()
	dir := t.TempDir()
	f := &fakeRuntimeUpgrade{dir: dir, now: time.Unix(1_800_000_000, 0), needed: true, versionOf: map[string]string{
		"NEW": "gost 3.2.6-nex3 (go1.25.4 linux/amd64)",
		"OLD": "gost 3.2.6-nex2 (go1.25.4 linux/amd64)",
		"BAD": "cannot execute binary file",
	}}
	f.env = gostRuntimeUpgradeEnv{
		binaryPath:   filepath.Join(dir, "forwardx-runtime"),
		markerPath:   filepath.Join(dir, "runtime-upgrade.json"),
		rollbackPath: filepath.Join(dir, "runtime-rollback.json"),
		now:          func() time.Time { return f.now },
		version: func(path string) (gostRuntimeVersionInfo, gostRuntimeFingerprint) {
			raw, err := os.ReadFile(path)
			if err != nil {
				return gostRuntimeVersionInfo{Version: gostRuntimeVersionMissing}, gostRuntimeFingerprint{}
			}
			fp, _ := statGostRuntimeFingerprint(path)
			if strings.TrimSpace(string(raw)) == "SLOW" {
				// -V 超时
				return gostRuntimeVersionInfo{Version: gostRuntimeVersionUnknown, TimedOut: true}, fp
			}
			return parseGostRuntimeVersion(f.versionOf[strings.TrimSpace(string(raw))]), fp
		},
		serviceNeeded:  func() bool { return f.needed },
		serviceActive:  func() bool { return f.active },
		restartService: func() { f.restarts++ },
	}
	return f
}

func (f *fakeRuntimeUpgrade) install(t *testing.T, current, previous string, startedAgo time.Duration) {
	t.Helper()
	if err := os.WriteFile(f.env.binaryPath, []byte(current), 0o755); err != nil {
		t.Fatal(err)
	}
	if previous != "" {
		if err := os.WriteFile(f.env.binaryPath+gostRuntimePreviousSuffix, []byte(previous), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	marker := gostRuntimeUpgradeMarker{
		PreviousPath:    f.env.binaryPath + gostRuntimePreviousSuffix,
		PreviousVersion: "3.2.6-nex2",
		NewVersion:      "3.2.6-nex3",
		StartedAt:       f.now.Add(-startedAgo).Unix(),
	}
	if err := writeJSONFileAtomic(f.env.markerPath, marker); err != nil {
		t.Fatal(err)
	}
}

func (f *fakeRuntimeUpgrade) binary(t *testing.T) string {
	t.Helper()
	raw, err := os.ReadFile(f.env.binaryPath)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func TestGostRuntimeUpgradeCommitsWhenServiceHealthy(t *testing.T) {
	f := newFakeRuntimeUpgrade(t)
	f.active = true
	f.install(t, "NEW", "OLD", 5*time.Second)
	if got, _ := reconcileGostRuntimeUpgrade(f.env); got != gostRuntimeUpgradePending {
		t.Fatalf("young upgrade with active service should wait, got %s", got)
	}
	f.now = f.now.Add(gostRuntimeUpgradeCommitAfter)
	if got, err := reconcileGostRuntimeUpgrade(f.env); got != gostRuntimeUpgradeCommitted || err != nil {
		t.Fatalf("got %s %v", got, err)
	}
	if exists(f.env.markerPath) || f.binary(t) != "NEW" || f.restarts != 0 {
		t.Fatalf("commit must keep the new binary and drop the marker")
	}
	if got, _ := reconcileGostRuntimeUpgrade(f.env); got != gostRuntimeUpgradeNone {
		t.Fatalf("no marker -> none, got %s", got)
	}
}

func TestGostRuntimeUpgradeCommitsIdleHost(t *testing.T) {
	f := newFakeRuntimeUpgrade(t)
	f.needed = false
	f.install(t, "NEW", "OLD", time.Second)
	// 一份旧的回滚记录：新文件确认能用之后要作废。
	writeJSONFileAtomic(f.env.rollbackPath, gostRuntimeRollbackState{Reason: "old"})
	if got, _ := reconcileGostRuntimeUpgrade(f.env); got != gostRuntimeUpgradeCommitted {
		t.Fatalf("idle host with working -V should commit, got %s", got)
	}
	if exists(f.env.rollbackPath) {
		t.Fatalf("stale rollback record should be removed on commit")
	}
}

func TestGostRuntimeUpgradeRollsBackWhenServiceNeverStarts(t *testing.T) {
	f := newFakeRuntimeUpgrade(t)
	f.active = false
	f.install(t, "NEW", "OLD", 30*time.Second)
	if got, _ := reconcileGostRuntimeUpgrade(f.env); got != gostRuntimeUpgradePending {
		t.Fatalf("inside start grace should wait, got %s", got)
	}
	f.now = f.now.Add(gostRuntimeUpgradeStartGrace)
	got, err := reconcileGostRuntimeUpgrade(f.env)
	if got != gostRuntimeUpgradeRolledBack || err == nil || !strings.Contains(err.Error(), "not active") {
		t.Fatalf("got %s %v", got, err)
	}
	if f.binary(t) != "OLD" || f.restarts != 1 || exists(f.env.markerPath) {
		t.Fatalf("rollback must restore .prev, restart once and drop the marker (binary=%s restarts=%d)", f.binary(t), f.restarts)
	}
	state, ok := readGostRuntimeRollbackState(f.env.rollbackPath)
	if !ok || state.FailedVersion != "3.2.6-nex3" || state.RestoredVersion != "3.2.6-nex2" {
		t.Fatalf("rollback state %+v", state)
	}
	info, fp := f.env.version(f.env.binaryPath)
	if caps := gostRuntimeCapabilities("2.2.227", info, fp, &state); len(caps) != 0 {
		t.Fatalf("after rollback capabilities must be false, got %v", caps)
	}
}

func TestGostRuntimeUpgradeRollbackToSameBuildStillHidesCapability(t *testing.T) {
	f := newFakeRuntimeUpgrade(t)
	f.versionOf["NEW2"] = "gost 3.2.6-nex3 (go)"
	f.install(t, "NEW", "NEW2", gostRuntimeUpgradeStartGrace+time.Second)
	if got, _ := reconcileGostRuntimeUpgrade(f.env); got != gostRuntimeUpgradeRolledBack {
		t.Fatalf("got %s", got)
	}
	state, _ := readGostRuntimeRollbackState(f.env.rollbackPath)
	info, fp := f.env.version(f.env.binaryPath)
	if !info.OK || info.NexBuild != 3 {
		t.Fatalf("restored %+v", info)
	}
	if caps := gostRuntimeCapabilities("2.2.227", info, fp, &state); len(caps) != 0 {
		t.Fatalf("a binary we just rolled back to must not claim the capability, got %v", caps)
	}
}

func TestGostRuntimeUpgradeRollsBackBrokenBinaryImmediately(t *testing.T) {
	f := newFakeRuntimeUpgrade(t)
	f.needed = false
	f.install(t, "BAD", "OLD", time.Second)
	got, err := reconcileGostRuntimeUpgrade(f.env)
	if got != gostRuntimeUpgradeRolledBack || err == nil || !strings.Contains(err.Error(), "self-check") {
		t.Fatalf("got %s %v", got, err)
	}
	if f.binary(t) != "OLD" || f.restarts != 0 {
		t.Fatalf("broken binary must be replaced; no restart when no service is needed")
	}
}

func TestGostRuntimeUpgradeWithoutUsablePreviousKeepsNewBinary(t *testing.T) {
	f := newFakeRuntimeUpgrade(t)
	f.install(t, "NEW", "", gostRuntimeUpgradeStartGrace+time.Second)
	got, err := reconcileGostRuntimeUpgrade(f.env)
	if got != gostRuntimeUpgradeStuck || err == nil {
		t.Fatalf("got %s %v", got, err)
	}
	if f.binary(t) != "NEW" || exists(f.env.markerPath) {
		t.Fatalf("without .prev the new binary stays and the marker is dropped")
	}
}

func TestGostRuntimeUpgradeIgnoresAncientMarker(t *testing.T) {
	f := newFakeRuntimeUpgrade(t)
	f.active = false
	f.install(t, "NEW", "OLD", gostRuntimeUpgradeMarkerMaxAge+time.Hour)
	if got, _ := reconcileGostRuntimeUpgrade(f.env); got != gostRuntimeUpgradeCommitted {
		t.Fatalf("ancient marker must not trigger a rollback, got %s", got)
	}
	if f.binary(t) != "NEW" {
		t.Fatalf("binary changed")
	}
}

func TestGostRuntimeUpgradeMarkerFormatMatchesInstallScript(t *testing.T) {
	// 安装脚本（server/agentInstallScripts.ts write_runtime_upgrade_marker）写的就是这几个键。
	raw := `{"previousPath":"/usr/local/bin/forwardx-runtime.prev","previousVersion":"3.2.6-nex2","newVersion":"3.2.6-nex3","startedAt":1800000000}`
	var marker gostRuntimeUpgradeMarker
	if err := json.Unmarshal([]byte(raw), &marker); err != nil {
		t.Fatal(err)
	}
	if marker.PreviousPath != gostRuntimeBinaryPath+gostRuntimePreviousSuffix || marker.NewVersion != "3.2.6-nex3" || marker.StartedAt != 1800000000 {
		t.Fatalf("%+v", marker)
	}
}

func TestGostRuntimeUpgradeVersionTimeoutIsNotABrokenBinary(t *testing.T) {
	f := newFakeRuntimeUpgrade(t)
	f.active = true
	f.install(t, "SLOW", "OLD", 5*time.Second)
	if got, _ := reconcileGostRuntimeUpgrade(f.env); got != gostRuntimeUpgradePending {
		t.Fatalf("-V timeout must not roll back, got %s", got)
	}
	// 服务一直在跑：过了宽限期也不回滚、不确认，标记留着等 -V 答得出来。
	f.now = f.now.Add(2 * gostRuntimeUpgradeStartGrace)
	if got, _ := reconcileGostRuntimeUpgrade(f.env); got != gostRuntimeUpgradePending {
		t.Fatalf("timeout with an active service must stay pending, got %s", got)
	}
	if f.binary(t) != "SLOW" || !exists(f.env.markerPath) || f.restarts != 0 {
		t.Fatalf("timeout must keep the new binary and the marker")
	}
	// 服务过了宽限期还没起来：按服务的实况回滚。
	f.active = false
	if got, err := reconcileGostRuntimeUpgrade(f.env); got != gostRuntimeUpgradeRolledBack || err == nil {
		t.Fatalf("service down after grace should roll back, got %s %v", got, err)
	}
	if f.binary(t) != "OLD" {
		t.Fatalf("rollback must restore .prev")
	}
}

func TestGostRuntimeUpgradePreviousTimeoutRetries(t *testing.T) {
	f := newFakeRuntimeUpgrade(t)
	f.install(t, "BAD", "SLOW", time.Second)
	if got, _ := reconcileGostRuntimeUpgrade(f.env); got != gostRuntimeUpgradePending {
		t.Fatalf("previous -V timeout should retry later, got %s", got)
	}
	if !exists(f.env.markerPath) || f.binary(t) != "BAD" {
		t.Fatalf("marker must stay for the retry")
	}
}

func TestGostRuntimeCapabilitiesHiddenWhileUpgradeDown(t *testing.T) {
	f := newFakeRuntimeUpgrade(t)
	f.active = false
	if gostRuntimeUpgradePendingAndDown(f.env) {
		t.Fatalf("no marker -> not pending")
	}
	f.install(t, "NEW", "OLD", time.Second)
	if !gostRuntimeUpgradePendingAndDown(f.env) {
		t.Fatalf("pending upgrade with the service down must hide capabilities")
	}
	f.active = true
	if gostRuntimeUpgradePendingAndDown(f.env) {
		t.Fatalf("pending upgrade with the service up keeps capabilities")
	}
	f.active, f.needed = false, false
	if gostRuntimeUpgradePendingAndDown(f.env) {
		t.Fatalf("no gost rules on the host -> nothing to be down")
	}
}

func TestGostRuntimeUpgradeCommitKeepsRollbackRecordWrittenDuringUpgrade(t *testing.T) {
	f := newFakeRuntimeUpgrade(t)
	f.needed = false
	f.install(t, "NEW", "OLD", time.Second)
	// 安装脚本在这次升级之后回滚了，记录比升级标记新：确认时不能删掉它。
	writeJSONFileAtomic(f.env.rollbackPath, gostRuntimeRollbackState{Reason: "restart failed", At: f.now.Unix()})
	if got, _ := reconcileGostRuntimeUpgrade(f.env); got != gostRuntimeUpgradeCommitted {
		t.Fatalf("got %s", got)
	}
	if !exists(f.env.rollbackPath) {
		t.Fatalf("a rollback record newer than the upgrade marker must survive the commit")
	}
	// 升级之前的旧记录照样作废。
	f.install(t, "NEW", "OLD", time.Second)
	writeJSONFileAtomic(f.env.rollbackPath, gostRuntimeRollbackState{Reason: "old", At: f.now.Add(-time.Hour).Unix()})
	if got, _ := reconcileGostRuntimeUpgrade(f.env); got != gostRuntimeUpgradeCommitted || exists(f.env.rollbackPath) {
		t.Fatalf("an older rollback record must be removed on commit (got %s)", got)
	}
}
