package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

func mimicRuntimeDiagnostics() string {
	services := managedMimicServicesFromLocalConfig()
	if len(services) == 0 {
		return "services=none"
	}
	parts := make([]string, 0, len(services))
	for _, name := range services {
		ok, reason := mimicRuntimeServiceHealth(name)
		parts = append(parts, fmt.Sprintf("%s healthy=%v %s", name, ok, reason))
	}
	return compactLogOutput(strings.Join(parts, " | "))
}

func managedMimicServicesFromLocalConfig() []string {
	return managedMimicServicesFromConfigDir(mimicConfigDir)
}

func managedMimicServicesFromConfigDir(configDir string) []string {
	entries, err := os.ReadDir(configDir)
	if err != nil {
		return nil
	}
	services := []string{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".conf") {
			continue
		}
		path := filepath.Join(configDir, entry.Name())
		raw, err := os.ReadFile(path)
		if err != nil || !strings.Contains(string(raw), "# Managed by ForwardX") {
			continue
		}
		iface := strings.TrimSuffix(entry.Name(), ".conf")
		if !validNetworkInterfaceName(iface) {
			continue
		}
		services = append(services, "mimic@"+iface)
	}
	sort.Strings(services)
	return services
}

func mimicConnectionState(output string) string {
	text := strings.ToLower(output)
	switch {
	case strings.Contains(text, "established"):
		return "established"
	case strings.Contains(text, "connecting"), strings.Contains(text, "syn sent"), strings.Contains(text, "syn received"):
		return "connecting"
	case strings.Contains(text, "no active connection"), strings.Contains(text, "waiting"):
		return "waiting"
	case strings.Contains(text, "idle"):
		return "idle"
	default:
		return "unknown"
	}
}

func mimicHooksReady(iface string) (bool, string) {
	if !validNetworkInterfaceName(iface) {
		return false, "invalid-interface"
	}
	parts := []string{}
	hasXDP := false
	hasTCEgress := false
	if commandExists("ip") {
		if out, err := commandCombinedOutputWithTimeout(3*time.Second, "ip", "-details", "link", "show", "dev", iface); err == nil && strings.Contains(strings.ToLower(string(out)), "xdp") {
			hasXDP = true
			parts = append(parts, "xdp")
		}
	}
	if commandExists("tc") {
		if out, err := commandCombinedOutputWithTimeout(3*time.Second, "tc", "filter", "show", "dev", iface, "egress"); err == nil && strings.TrimSpace(string(out)) != "" {
			hasTCEgress = true
			parts = append(parts, "tc-egress")
		}
	}
	return hasXDP && hasTCEgress, strings.Join(parts, ",")
}

func mimicRuntimeServiceReportFor(name string) localRuntimeServiceState {
	report := localRuntimeServiceState{Name: name, HasWork: true, Status: "unknown", ConnectionState: "unknown"}
	iface := strings.TrimPrefix(name, "mimic@")
	if validNetworkInterfaceName(iface) {
		hooksReady, hooks := mimicHooksReady(iface)
		report.HooksReady = new(bool)
		*report.HooksReady = hooksReady
		if hooks != "" {
			report.Message = "hooks=" + hooks
		}
	}
	ok, message := mimicRuntimeServiceHealth(name)
	report.Active = ok
	if strings.TrimSpace(message) != "" {
		report.Message = strings.TrimSpace(strings.TrimSpace(report.Message) + " " + compactLogOutput(message))
	}
	if !ok {
		report.Status = "unavailable"
		return report
	}
	report.ConnectionState = mimicConnectionState(message)
	report.Status = report.ConnectionState
	if report.Status == "unknown" {
		report.Status = "active"
	}
	return report
}

func mimicRuntimeServiceHealth(name string) (bool, string) {
	if !strings.HasPrefix(name, "mimic@") {
		return false, "invalid-service-name"
	}
	if !managedServiceActive(name) {
		return false, "service-inactive"
	}
	iface := strings.TrimPrefix(name, "mimic@")
	if !validNetworkInterfaceName(iface) {
		return false, "invalid-interface"
	}
	if !commandExists("mimic") {
		return false, "mimic-command-missing"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "mimic", "show", iface).CombinedOutput()
	output := compactLogOutput(string(out))
	if ctx.Err() == context.DeadlineExceeded {
		return false, "mimic-show-timeout"
	}
	if err != nil {
		if output == "" {
			output = err.Error()
		}
		return false, "mimic-show-failed " + output
	}
	if output == "" {
		output = "mimic-show-ok"
	}
	hooksReady, hooks := mimicHooksReady(iface)
	if !hooksReady {
		if hooks == "" {
			hooks = "none"
		}
		return false, "mimic-hooks-unavailable hooks=" + hooks
	}
	network := ensureMimicNetworkCompatibility(iface)
	if strings.Contains(network, "ethtool-missing") || strings.Contains(network, "still-on:") || strings.Contains(network, "inspect-failed") || strings.Contains(network, "state-failed:") {
		if shouldLogAgentReport("mimic-network:"+iface, agentReportLogInterval) {
			logf("mimic network compatibility warning interface=%s %s", iface, network)
		}
	}
	return true, strings.TrimSpace(output + " network=" + network)
}
