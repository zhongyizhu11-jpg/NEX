package main

import "testing"

func TestAgentDistributionReport(t *testing.T) {
	payload := map[string]any{"agentVersion": Version}
	addAgentDistributionReport(payload)
	if got := payload["agentDistribution"]; got != "nex" {
		t.Fatalf("agentDistribution = %v, want nex", got)
	}
	// 二开发行版用 -ldflags 改名后，报的就是改过的名字
	previous := Distribution
	Distribution = "custom"
	defer func() { Distribution = previous }()
	addAgentDistributionReport(payload)
	if got := payload["agentDistribution"]; got != "custom" {
		t.Fatalf("agentDistribution = %v, want custom", got)
	}
}
