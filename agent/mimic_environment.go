package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

func mimicEnvironment(force bool) mimicEnvironmentReport {
	mimicEnvironmentMu.Lock()
	defer mimicEnvironmentMu.Unlock()
	if !force && !mimicEnvironmentCheckedAt.IsZero() && time.Since(mimicEnvironmentCheckedAt) < 30*time.Second {
		return mimicEnvironmentCached
	}
	report := inspectMimicEnvironment(runtime.GOOS, commandExists, func() bool {
		_, err := os.Stat("/sys/module/mimic")
		return err == nil
	}, runMimicEnvironmentCommand)
	mimicEnvironmentCached = report
	mimicEnvironmentCheckedAt = time.Now()
	// 命令在、模块不在：多半是内核升级后 DKMS 没重编，自己试一次（mimic_install.go）
	maybeAutoRepairMimicModule(report)
	return report
}

func invalidateMimicEnvironmentCache() {
	mimicEnvironmentMu.Lock()
	mimicEnvironmentCached = mimicEnvironmentReport{}
	mimicEnvironmentCheckedAt = time.Time{}
	mimicEnvironmentMu.Unlock()
}

func mimicRuntimeEnvironment() mimicEnvironmentReport {
	report := mimicEnvironment(true)
	if !report.Available {
		return report
	}
	output, err := runMimicEnvironmentCommand("modprobe", "mimic")
	if err != nil {
		report.Available = false
		report.ModuleReady = false
		report.Status = "kernel-module-load-failed"
		report.Message = compactMimicEnvironmentOutput(output, 160)
		if report.Message == "" {
			report.Message = err.Error()
		}
		mimicEnvironmentMu.Lock()
		mimicEnvironmentCached = report
		mimicEnvironmentCheckedAt = time.Now()
		mimicEnvironmentMu.Unlock()
	}
	return report
}

func inspectMimicEnvironment(
	goos string,
	hasCommand func(string) bool,
	moduleLoaded func() bool,
	runCommand func(string, ...string) (string, error),
) mimicEnvironmentReport {
	report := mimicEnvironmentReport{Status: "unknown"}
	if goos != "linux" {
		report.Status = "unsupported-os"
		report.Message = "mimic requires Linux"
		return report
	}
	if !hasCommand("mimic") {
		report.Status = "command-missing"
		report.Message = "mimic command is not installed"
		return report
	}
	report.CommandReady = true
	if output, err := runCommand("mimic", "--version"); err == nil {
		report.Version = compactMimicEnvironmentOutput(output, 64)
	} else {
		report.Status = "command-unusable"
		report.Message = compactMimicEnvironmentOutput(output, 160)
		if report.Message == "" {
			report.Message = err.Error()
		}
		return report
	}
	if moduleLoaded() {
		report.ModuleReady = true
	} else {
		var output string
		var moduleErr error
		switch {
		case hasCommand("modprobe"):
			output, moduleErr = runCommand("modprobe", "-n", "mimic")
		case hasCommand("modinfo"):
			output, moduleErr = runCommand("modinfo", "mimic")
		default:
			report.Status = "module-check-unavailable"
			report.Message = "modprobe and modinfo are unavailable"
			return report
		}
		if moduleErr != nil {
			report.Status = "kernel-module-missing"
			report.Message = compactMimicEnvironmentOutput(output, 160)
			if report.Message == "" {
				report.Message = moduleErr.Error()
			}
			return report
		}
		report.ModuleReady = true
	}
	report.Available = report.CommandReady && report.ModuleReady
	report.Status = "ready"
	return report
}

func runMimicEnvironmentCommand(name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
	if ctx.Err() == context.DeadlineExceeded {
		return string(output), fmt.Errorf("%s check timed out", name)
	}
	return string(output), err
}

func compactMimicEnvironmentOutput(value string, limit int) string {
	text := strings.Join(strings.Fields(strings.TrimSpace(value)), " ")
	if limit > 0 && len(text) > limit {
		return text[:limit]
	}
	return text
}
