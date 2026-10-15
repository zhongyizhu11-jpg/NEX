package main

import (
	"strings"
	"testing"
	"time"
)

func TestTailBufferKeepsOnlyTheEnd(t *testing.T) {
	buf := &tailBuffer{limit: 32}
	for i := 0; i < 10; i++ {
		buf.Write([]byte("line-0123456789\n"))
	}
	got := buf.String()
	if len(got) > 32 {
		t.Fatalf("tail buffer exceeded limit: %d bytes", len(got))
	}
	if !strings.HasPrefix(got, "line-") || !strings.HasSuffix(got, "\n") {
		t.Fatalf("tail buffer should cut on a line boundary, got %q", got)
	}
}

func TestMimicInstallerCandidatesOrder(t *testing.T) {
	task := mimicInstallTask{
		InstallerURL:       "https://raw.githubusercontent.com/x/y/main/scripts/install-mimic.sh",
		AcceleratorEnabled: true,
		AcceleratorURL:     "https://ghfast.example/",
		Mirrors:            "https://gh.ddlc.top/,https://gh-proxy.com/",
	}
	got := mimicInstallerCandidates(task)
	want := []string{
		"https://ghfast.example/https://raw.githubusercontent.com/x/y/main/scripts/install-mimic.sh",
		"https://gh.ddlc.top/https://raw.githubusercontent.com/x/y/main/scripts/install-mimic.sh",
		"https://gh-proxy.com/https://raw.githubusercontent.com/x/y/main/scripts/install-mimic.sh",
		"https://raw.githubusercontent.com/x/y/main/scripts/install-mimic.sh",
	}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("unexpected candidates:\n got %v\nwant %v", got, want)
	}
	if len(mimicInstallerCandidates(mimicInstallTask{})) != 0 {
		t.Fatalf("empty installer URL should produce no candidates")
	}
}

func TestMimicInstallFailureSummaryPicksLastError(t *testing.T) {
	output := "[NEX mimic] installing\n[NEX mimic] ERROR: mimic installation failed for distro family 'debian'\n[NEX mimic] RESULT: failed reason=dkms-build\n"
	if got := mimicInstallFailureSummary(output, 1); !strings.Contains(got, "RESULT: failed") {
		t.Fatalf("expected the RESULT line, got %q", got)
	}
	if got := mimicInstallFailureSummary("nothing useful", 3); got != "安装脚本退出码 3" {
		t.Fatalf("unexpected fallback summary %q", got)
	}
}

func TestShouldAutoRepairMimicModule(t *testing.T) {
	now := time.Now()
	missing := mimicEnvironmentReport{Status: "kernel-module-missing", CommandReady: true}
	if !shouldAutoRepairMimicModule(missing, true, "6.12.1", "", time.Time{}, now, false) {
		t.Fatalf("first miss on a kernel with dkms present should repair")
	}
	if shouldAutoRepairMimicModule(missing, false, "6.12.1", "", time.Time{}, now, false) {
		t.Fatalf("without dkms there is nothing to rebuild with")
	}
	if shouldAutoRepairMimicModule(missing, true, "6.12.1", "6.12.1", now.Add(-10*time.Minute), now, false) {
		t.Fatalf("same kernel within the hour should not retry")
	}
	if !shouldAutoRepairMimicModule(missing, true, "6.12.2", "6.12.1", now.Add(-10*time.Minute), now, false) {
		t.Fatalf("a new kernel should be retried right away")
	}
	if !shouldAutoRepairMimicModule(missing, true, "6.12.1", "6.12.1", now.Add(-2*time.Hour), now, false) {
		t.Fatalf("after an hour the same kernel may be retried")
	}
	if shouldAutoRepairMimicModule(missing, true, "6.12.1", "", time.Time{}, now, true) {
		t.Fatalf("a repair already in flight must not start another")
	}
	if shouldAutoRepairMimicModule(mimicEnvironmentReport{Status: "command-missing"}, true, "6.12.1", "", time.Time{}, now, false) {
		t.Fatalf("missing CLI is not something dkms can fix")
	}
}

func TestMimicInstallEnvAndTimeout(t *testing.T) {
	task := mimicInstallTask{Mode: "repair", Version: "v0.7.1", AcceleratorEnabled: true, AcceleratorURL: "https://ghfast.example", Mirrors: "https://m/"}
	env := strings.Join(mimicInstallEnv(task), "\n")
	for _, want := range []string{"FORWARDX_INSTALL_MIMIC=yes", "FORWARDX_MIMIC_MODE=repair", "FORWARDX_MIMIC_VERSION=0.7.1", "GITHUB_ACCELERATOR_URL=https://ghfast.example", "FORWARDX_GITHUB_MIRRORS=https://m/", "DEBIAN_FRONTEND=noninteractive"} {
		if !strings.Contains(env, want) {
			t.Fatalf("env missing %s", want)
		}
	}
	if mimicInstallTimeout(mimicInstallTask{}) != mimicInstallDefaultTimeout {
		t.Fatalf("zero timeout should use the default")
	}
	if mimicInstallTimeout(mimicInstallTask{TimeoutSeconds: 99999}) != mimicInstallMaxTimeout {
		t.Fatalf("timeout should be capped")
	}
}
