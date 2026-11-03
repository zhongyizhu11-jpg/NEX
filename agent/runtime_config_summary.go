package main

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
)

func gostRuntimeConfigHasServices(path string) bool {
	raw, err := os.ReadFile(path)
	if err != nil || len(raw) == 0 {
		return false
	}
	var cfg struct {
		Services []json.RawMessage `json:"services"`
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return false
	}
	return len(cfg.Services) > 0
}

func nginxRuntimeConfigHasServers(path string) bool {
	raw, err := os.ReadFile(path)
	if err != nil || len(raw) == 0 {
		return false
	}
	text := string(raw)
	return strings.Contains(text, "server {") || strings.Contains(text, "server{")
}

func logGostRuntimeProxySummary(path string, label string) {
	b, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var cfg struct {
		Services []struct {
			Name     string         `json:"name"`
			Addr     string         `json:"addr"`
			Metadata map[string]any `json:"metadata"`
			Handler  struct {
				Type     string         `json:"type"`
				Chain    string         `json:"chain"`
				Metadata map[string]any `json:"metadata"`
			} `json:"handler"`
			Listener struct {
				Type string `json:"type"`
			} `json:"listener"`
			Forwarder struct {
				Nodes []struct {
					Name string `json:"name"`
					Addr string `json:"addr"`
				} `json:"nodes"`
			} `json:"forwarder"`
		} `json:"services"`
		Chains []struct {
			Name string `json:"name"`
			Hops []struct {
				Name     string         `json:"name"`
				Metadata map[string]any `json:"metadata"`
				Nodes    []struct {
					Name     string         `json:"name"`
					Addr     string         `json:"addr"`
					Metadata map[string]any `json:"metadata"`
				} `json:"nodes"`
			} `json:"hops"`
		} `json:"chains"`
	}
	if err := json.Unmarshal(b, &cfg); err != nil {
		logf("proxy-debug %s config parse failed path=%s: %v", label, path, err)
		return
	}
	lines := make([]string, 0)
	for _, svc := range cfg.Services {
		receive := hasProxyProtocolMetadata(svc.Metadata)
		send := hasProxyProtocolMetadata(svc.Handler.Metadata)
		targets := make([]string, 0, len(svc.Forwarder.Nodes))
		for _, node := range svc.Forwarder.Nodes {
			targets = append(targets, fmt.Sprintf("%s@%s", emptyDash(node.Name), emptyDash(node.Addr)))
		}
		if len(targets) == 0 {
			targets = append(targets, "-")
		}
		if receive || send || strings.TrimSpace(svc.Handler.Chain) != "" {
			lines = append(lines, fmt.Sprintf(
				"service=%s addr=%s listener=%s handler=%s chain=%s acceptProxy=%v sendProxy=%v targets=%s",
				emptyDash(svc.Name),
				emptyDash(svc.Addr),
				emptyDash(svc.Listener.Type),
				emptyDash(svc.Handler.Type),
				emptyDash(svc.Handler.Chain),
				receive,
				send,
				strings.Join(targets, ","),
			))
		}
	}
	for _, chain := range cfg.Chains {
		for _, hop := range chain.Hops {
			hopSend := hasProxyProtocolMetadata(hop.Metadata)
			nodeSend := false
			targets := make([]string, 0, len(hop.Nodes))
			for _, node := range hop.Nodes {
				if hasProxyProtocolMetadata(node.Metadata) {
					nodeSend = true
				}
				targets = append(targets, fmt.Sprintf("%s@%s", emptyDash(node.Name), emptyDash(node.Addr)))
			}
			if !hopSend && !nodeSend {
				continue
			}
			lines = append(lines, fmt.Sprintf(
				"chain=%s hop=%s sendProxy=%v hopProxy=%v nodeProxy=%v nodes=%s",
				emptyDash(chain.Name),
				emptyDash(hop.Name),
				hopSend || nodeSend,
				hopSend,
				nodeSend,
				strings.Join(targets, ","),
			))
		}
	}
	sort.Strings(lines)
	signature := strings.Join(lines, "\n")
	runtimeProxyLogMu.Lock()
	if runtimeProxyLogSignatures[label] == signature {
		runtimeProxyLogMu.Unlock()
		return
	}
	runtimeProxyLogSignatures[label] = signature
	runtimeProxyLogMu.Unlock()
	if len(lines) == 0 {
		logVerbosef("proxy-debug %s no proxyProtocol entries services=%d chains=%d path=%s", label, len(cfg.Services), len(cfg.Chains), path)
		return
	}
	logVerbosef("proxy-debug %s proxyProtocol summary entries=%d path=%s", label, len(lines), path)
	for _, line := range lines {
		logVerbosef("proxy-debug %s %s", label, line)
	}
}

func hasProxyProtocolMetadata(metadata map[string]any) bool {
	if len(metadata) == 0 {
		return false
	}
	value, ok := metadata["proxyProtocol"]
	if !ok {
		return false
	}
	switch v := value.(type) {
	case bool:
		return v
	case float64:
		return v != 0
	case string:
		text := strings.ToLower(strings.TrimSpace(v))
		return text != "" && text != "0" && text != "false"
	default:
		return value != nil
	}
}

func emptyDash(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "-"
	}
	return value
}
