package main

import (
	"encoding/json"
	"net"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

func managedRuntimeConfigServiceCount(path string) (int, bool) {
	if strings.HasSuffix(path, ".json") {
		return gostRuntimeConfigServiceCount(path)
	}
	return nginxRuntimeConfigServiceCount(path)
}

func gostRuntimeConfigUsesPort(path string, port int) bool {
	addrs, ok := readGostRuntimeServiceAddrs(path)
	if !ok {
		return false
	}
	for _, addr := range addrs {
		if addrUsesPort(addr, port) {
			return true
		}
	}
	return false
}

func gostRuntimeConfigServiceCount(path string) (int, bool) {
	addrs, ok := readGostRuntimeServiceAddrs(path)
	return len(addrs), ok
}

type runtimeListenConfig struct {
	Addr     string
	Protocol string
}

func readGostRuntimeServiceListens(path string) ([]runtimeListenConfig, bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, false
	}
	var cfg struct {
		Services []struct {
			Addr     string `json:"addr"`
			Listener struct {
				Type string `json:"type"`
			} `json:"listener"`
		} `json:"services"`
	}
	if err := json.Unmarshal(b, &cfg); err != nil {
		return nil, false
	}
	listens := make([]runtimeListenConfig, 0, len(cfg.Services))
	for _, svc := range cfg.Services {
		protocol := strings.TrimSpace(svc.Listener.Type)
		if protocol == "" {
			protocol = protocolFromListenAddr(svc.Addr)
		}
		listens = append(listens, runtimeListenConfig{Addr: svc.Addr, Protocol: protocol})
	}
	return listens, true
}

func readGostRuntimeServiceAddrs(path string) ([]string, bool) {
	listens, ok := readGostRuntimeServiceListens(path)
	if !ok {
		return nil, false
	}
	addrs := make([]string, 0, len(listens))
	for _, listen := range listens {
		addrs = append(addrs, listen.Addr)
	}
	return addrs, true
}

func protocolFromListenAddr(addr string) string {
	value := strings.ToLower(strings.TrimSpace(addr))
	switch {
	case strings.HasPrefix(value, "udp://"):
		return "udp"
	case strings.HasPrefix(value, "tcp://"):
		return "tcp"
	default:
		return "tcp"
	}
}

func nginxRuntimeListenConfigs(path string) ([]runtimeListenConfig, bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, false
	}
	re := regexp.MustCompile(`(?m)\blisten\s+([^;]+);`)
	matches := re.FindAllStringSubmatch(string(b), -1)
	listens := make([]runtimeListenConfig, 0, len(matches))
	for _, match := range matches {
		if len(match) < 2 {
			continue
		}
		fields := strings.Fields(match[1])
		if len(fields) == 0 {
			continue
		}
		protocol := "tcp"
		for _, field := range fields[1:] {
			if strings.EqualFold(strings.TrimSpace(field), "udp") {
				protocol = "udp"
				break
			}
		}
		listens = append(listens, runtimeListenConfig{Addr: fields[0], Protocol: protocol})
	}
	return listens, true
}

func nginxRuntimeListenAddrs(path string) ([]string, bool) {
	listens, ok := nginxRuntimeListenConfigs(path)
	if !ok {
		return nil, false
	}
	addrs := make([]string, 0, len(listens))
	for _, listen := range listens {
		addrs = append(addrs, listen.Addr)
	}
	return addrs, true
}

func nginxRuntimeConfigUsesPort(path string, port int) bool {
	addrs, ok := nginxRuntimeListenAddrs(path)
	if !ok {
		return false
	}
	for _, addr := range addrs {
		if addrUsesPort(addr, port) {
			return true
		}
	}
	return false
}

func nginxRuntimeConfigServiceCount(path string) (int, bool) {
	addrs, ok := nginxRuntimeListenAddrs(path)
	return len(addrs), ok
}

func addrUsesPort(addr string, port int) bool {
	text := strings.TrimSpace(addr)
	if text == "" || port <= 0 {
		return false
	}
	if text == ":"+strconv.Itoa(port) {
		return true
	}
	_, rawPort, err := net.SplitHostPort(text)
	if err != nil {
		return strings.HasSuffix(text, ":"+strconv.Itoa(port))
	}
	value, err := strconv.Atoi(rawPort)
	return err == nil && value == port
}

func managedGostConfigPathsForListenPortProtocol(port int, protocol string) []string {
	paths := map[string]bool{}
	for _, pid := range listenPortOwnerPIDsForProtocol(port, protocol) {
		cmdline, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/cmdline")
		if err != nil {
			continue
		}
		cmd := strings.ReplaceAll(string(cmdline), "\x00", " ")
		for _, item := range managedRuntimeConfigs() {
			if strings.Contains(cmd, item.path) {
				paths[item.path] = true
			}
		}
	}
	result := make([]string, 0, len(paths))
	for path := range paths {
		result = append(result, path)
	}
	sort.Strings(result)
	return result
}

func managedGostServiceNameForConfig(path string) string {
	for _, item := range managedRuntimeConfigs() {
		if path == item.path {
			return item.service
		}
	}
	return ""
}

func managedRuntimeConfigs() []struct {
	path    string
	service string
} {
	return []struct {
		path    string
		service string
	}{
		{runtimeConfigPath, runtimeServiceName},
		{tunnelRuntimeConfigPath, tunnelRuntimeServiceName},
		{nginxConfigPath, nginxServiceName},
		{legacyRuntimeConfigPath, runtimeServiceName},
		{legacyTunnelRuntimeConfigPath, tunnelRuntimeServiceName},
		{legacyGostConfigPath, legacyGostServiceName},
		{legacyTunnelConfigPath, legacyTunnelServiceName},
	}
}
