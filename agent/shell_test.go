package main

import (
	"strings"
	"testing"
)

func TestShellSafePort(t *testing.T) {
	for _, port := range []string{"1", "80", "443", "8080", "65535"} {
		if !shellSafePort(port) {
			t.Fatalf("%q should be accepted", port)
		}
	}
	for _, port := range []string{"", "0", "65536", "99999", "123456", " 80", "80 ", "-1", "8080;reboot", "$(id)", "*", "80\n", "1e3", "０"} {
		if shellSafePort(port) {
			t.Fatalf("%q must be rejected", port)
		}
	}
}

// 端口不是数字时，拼命令的函数一律不拼（返回空或 true），不能把它带进 shell。
func TestShellCommandBuildersRefuseUnsafePorts(t *testing.T) {
	bad := "1;touch /tmp/pwned"
	for name, cmd := range map[string]string{
		"nftPortCleanupCmd":                   nftPortCleanupCmd(bad, "tcp"),
		"iptablesAgentDeleteDnatRulesForPort": iptablesAgentDeleteDnatRulesForPort("iptables", bad, "tcp"),
		"iptablesAgentDeleteCountingRules":    iptablesAgentDeleteCountingRules("iptables", bad),
		"iptablesAgentDedupeCountingRules":    iptablesAgentDedupeCountingRules("iptables", bad),
		"managedNginxCleanupShell":            managedNginxCleanupShell(bad),
		"nftProcessCountingCleanupCmd":        nftProcessCountingCleanupCmd(bad),
	} {
		if cmd != "true" {
			t.Fatalf("%s built a command from an unsafe port: %q", name, cmd)
		}
	}
	for name, cmds := range map[string][]string{
		"managedPortCleanupCmds":         managedPortCleanupCmds(bad),
		"managedListenerCleanupCmds":     managedListenerCleanupCmds(bad),
		"fxpPortCleanupCmds":             fxpPortCleanupCmds(bad),
		"iptablesAgentTargetCleanupCmds": iptablesAgentTargetCleanupCmds(1, bad, "10.0.0.2", 80, "tcp"),
	} {
		if len(cmds) != 0 {
			t.Fatalf("%s built commands from an unsafe port: %q", name, cmds)
		}
	}
}

func TestShellCommandBuildersKeepValidPorts(t *testing.T) {
	if cmd := nftPortCleanupCmd("8080", "tcp"); !strings.Contains(cmd, "tcp dport 8080( |$)") {
		t.Fatalf("nft cleanup lost the port: %q", cmd)
	}
	if cmd := iptablesAgentDeleteDnatRulesForPort("iptables", "8080", "udp"); !strings.Contains(cmd, "--dport 8080( |$)") || !strings.Contains(cmd, "-p udp") {
		t.Fatalf("dnat cleanup lost the port: %q", cmd)
	}
	if cmds := fxpPortCleanupCmds("8080"); len(cmds) != 2 || !strings.Contains(cmds[1], "fxp-*-8080.json") {
		t.Fatalf("fxp cleanup = %q", cmds)
	}
	if cmds := iptablesAgentTargetCleanupCmds(7, "8080", "10.0.0.2", 80, "tcp"); len(cmds) == 0 {
		t.Fatal("target cleanup should still produce commands for a valid port")
	}
}
