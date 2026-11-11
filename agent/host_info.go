package main

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
)

// localPrivateIPv4 returns the private IPv4 (10/8, 172.16/12, 192.168/16,
// 100.64/10) bound to the default-route interface, so the panel can offer it
// as the host's "内网地址". Only the default interface is looked at: falling
// back to every interface would pick up docker0 / br-* bridge addresses.
func localPrivateIPv4() string {
	name := defaultNetworkInterface()
	if name == "" {
		return ""
	}
	iface, err := net.InterfaceByName(name)
	if err != nil || iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
		return ""
	}
	addrs, err := iface.Addrs()
	if err != nil {
		return ""
	}
	return firstPrivateIPv4(addrs)
}

func firstPrivateIPv4(addrs []net.Addr) string {
	for _, addr := range addrs {
		ipNet, ok := addr.(*net.IPNet)
		if !ok {
			continue
		}
		ip := ipNet.IP.To4()
		if ip == nil {
			continue
		}
		if ip.IsPrivate() || (ip[0] == 100 && ip[1]&0xc0 == 64) {
			return ip.String()
		}
	}
	return ""
}

func defaultNetworkInterface() string {
	if runtime.GOOS != "linux" {
		return ""
	}
	if raw, err := os.ReadFile("/proc/net/route"); err == nil {
		if name := defaultIPv4NetworkInterface(raw); name != "" {
			return name
		}
	}
	if raw, err := os.ReadFile("/proc/net/ipv6_route"); err == nil {
		return defaultIPv6NetworkInterface(raw)
	}
	return ""
}

func defaultIPv4NetworkInterface(raw []byte) string {
	lines := strings.Split(string(raw), "\n")
	for _, line := range lines[1:] {
		fields := strings.Fields(line)
		if len(fields) < 4 || fields[1] != "00000000" {
			continue
		}
		flags, err := strconv.ParseUint(fields[3], 16, 64)
		if err != nil || flags&0x1 == 0 {
			continue
		}
		name := strings.TrimSpace(fields[0])
		if validNetworkInterfaceName(name) {
			return name
		}
	}
	return ""
}

func defaultIPv6NetworkInterface(raw []byte) string {
	for _, line := range strings.Split(string(raw), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 10 || strings.Trim(fields[0], "0") != "" {
			continue
		}
		prefixLength, err := strconv.ParseUint(fields[1], 16, 16)
		if err != nil || prefixLength != 0 {
			continue
		}
		flags, err := strconv.ParseUint(fields[len(fields)-2], 16, 64)
		if err != nil || flags&0x1 == 0 {
			continue
		}
		name := strings.TrimSpace(fields[len(fields)-1])
		if validNetworkInterfaceName(name) {
			return name
		}
	}
	return ""
}

func validNetworkInterfaceName(name string) bool {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 32 {
		return false
	}
	for _, r := range name {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') ||
			r == '_' || r == '-' || r == '.' || r == ':' || r == '@' {
			continue
		}
		return false
	}
	return true
}

func osInfo() string {
	if b, err := os.ReadFile("/etc/os-release"); err == nil {
		for _, line := range strings.Split(string(b), "\n") {
			if strings.HasPrefix(line, "PRETTY_NAME=") {
				return strings.Trim(strings.TrimPrefix(line, "PRETTY_NAME="), `"`)
			}
		}
	}
	return runtime.GOOS + "/" + runtime.GOARCH
}

func publicIPs() (string, string) {
	publicIPMu.Lock()
	ipv4, ipv6 := publicIPv4Cache, publicIPv6Cache
	stale := publicIPCheckedAt.IsZero() || time.Since(publicIPCheckedAt) >= publicIPRefreshInterval
	if stale && !publicIPRefreshRunning {
		publicIPRefreshRunning = true
		go refreshPublicIPs()
	}
	publicIPMu.Unlock()
	return ipv4, ipv6
}

func refreshPublicIPs() {
	ipv4Ch := make(chan string, 1)
	ipv6Ch := make(chan string, 1)
	go func() {
		ipv4Ch <- fetchPublicIP([]string{
			"https://api.ipify.org",
			"https://ipv4.icanhazip.com",
			"https://v4.ident.me",
		})
	}()
	go func() {
		ipv6 := localPublicIPv6()
		if ipv6 == "" {
			ipv6 = fetchPublicIP([]string{
				"https://api6.ipify.org",
				"https://ipv6.icanhazip.com",
				"https://v6.ident.me",
			})
		}
		ipv6Ch <- ipv6
	}()
	// 网卡上的全部公网地址跟出口 IP 同一个节奏刷新（public_addresses.go），不用另起定时器
	refreshPublicAddressList()
	ipv4 := <-ipv4Ch
	ipv6 := <-ipv6Ch
	publicIPMu.Lock()
	if ipv4 != "" {
		publicIPv4Cache = ipv4
	}
	if ipv6 != "" {
		publicIPv6Cache = ipv6
	}
	publicIPCheckedAt = time.Now()
	publicIPRefreshRunning = false
	publicIPMu.Unlock()
}

func fetchPublicIP(urls []string) string {
	if len(urls) == 0 {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	results := make(chan string, len(urls))
	for _, u := range urls {
		u := u
		go func() {
			req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
			if err != nil {
				results <- ""
				return
			}
			res, err := agentPublicHTTPClient.Do(req)
			if err != nil {
				results <- ""
				return
			}
			body, _ := io.ReadAll(io.LimitReader(res.Body, 128))
			_ = res.Body.Close()
			ip := strings.TrimSpace(string(body))
			if res.StatusCode >= 300 || net.ParseIP(ip) == nil {
				ip = ""
			}
			results <- ip
		}()
	}
	for range urls {
		select {
		case ip := <-results:
			if ip != "" {
				cancel()
				return ip
			}
		case <-ctx.Done():
			return ""
		}
	}
	return ""
}

func localPublicIPv6() string {
	if ip := localPublicIPv6FromIPCommand(); ip != "" {
		return ip
	}
	return localPublicIPv6FromInterfaces()
}

func localPublicIPv6FromIPCommand() string {
	out, err := commandOutputWithTimeout(3*time.Second, "ip", "-o", "-6", "addr", "show", "scope", "global")
	if err != nil {
		return ""
	}
	type candidate struct {
		ip    string
		score int
	}
	candidates := []candidate{}
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		for i, field := range fields {
			if field != "inet6" || i+1 >= len(fields) {
				continue
			}
			ip := publicIPv6Literal(strings.Split(fields[i+1], "/")[0])
			if ip == "" {
				continue
			}
			flags := strings.ToLower(strings.Join(fields[i+2:], " "))
			if strings.Contains(flags, "tentative") || strings.Contains(flags, "dadfailed") {
				continue
			}
			score := 100
			if strings.Contains(flags, "deprecated") {
				score -= 40
			}
			if strings.Contains(flags, "temporary") {
				score -= 20
			}
			candidates = append(candidates, candidate{ip: ip, score: score})
			break
		}
	}
	if len(candidates) == 0 {
		return ""
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		return candidates[i].score > candidates[j].score
	})
	return candidates[0].ip
}

func localPublicIPv6FromInterfaces() string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			var ip net.IP
			switch value := addr.(type) {
			case *net.IPNet:
				ip = value.IP
			case *net.IPAddr:
				ip = value.IP
			}
			if ip := publicIPv6Literal(ip.String()); ip != "" {
				return ip
			}
		}
	}
	return ""
}

func publicIPv6Literal(value string) string {
	ip := net.ParseIP(strings.Trim(strings.TrimSpace(value), "[]"))
	if ip == nil || ip.To4() != nil || !ip.IsGlobalUnicast() || isUniqueLocalIPv6(ip) {
		return ""
	}
	return ip.String()
}

func isUniqueLocalIPv6(ip net.IP) bool {
	ip = ip.To16()
	return ip != nil && ip[0]&0xfe == 0xfc
}

func readMeminfo() map[string]uint64 {
	out := map[string]uint64{}
	b, _ := os.ReadFile("/proc/meminfo")
	for _, line := range strings.Split(string(b), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 {
			v, _ := strconv.ParseUint(fields[1], 10, 64)
			out[strings.TrimSuffix(fields[0], ":")] = v * 1024
		}
	}
	return out
}

func memTotalFrom(m map[string]uint64) uint64 { return m["MemTotal"] }

func memUsedFrom(m map[string]uint64) uint64 {
	total := m["MemTotal"]
	available := m["MemAvailable"]
	if total <= available {
		return 0
	}
	return total - available
}

func swapTotalFrom(m map[string]uint64) uint64 { return m["SwapTotal"] }

func swapUsedFrom(m map[string]uint64) uint64 {
	total := m["SwapTotal"]
	free := m["SwapFree"]
	if total <= free {
		return 0
	}
	return total - free
}

func usagePercent(used, total uint64) int {
	if total == 0 {
		return 0
	}
	return int(used * 100 / total)
}

func memTotal() uint64 { return memTotalFrom(readMeminfo()) }

func uptime() int64 {
	b, _ := os.ReadFile("/proc/uptime")
	f := strings.Fields(string(b))
	if len(f) == 0 {
		return 0
	}
	v, _ := strconv.ParseFloat(f[0], 64)
	return int64(v)
}

func readAgentBootID() string {
	raw, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(raw))
}

func cpuInfo() string {
	model := ""
	cores := runtime.NumCPU()
	if b, err := os.ReadFile("/proc/cpuinfo"); err == nil {
		for _, line := range strings.Split(string(b), "\n") {
			if strings.HasPrefix(line, "model name") {
				parts := strings.SplitN(line, ":", 2)
				if len(parts) == 2 {
					model = strings.TrimSpace(parts[1])
				}
				break
			}
		}
	}
	if model == "" {
		model = "Unknown CPU"
	}
	coreLabel := "Virtual Cores"
	if cores == 1 {
		coreLabel = "Virtual Core"
	}
	if cores > 0 {
		return fmt.Sprintf("%s %d %s", model, cores, coreLabel)
	}
	return model
}

type cpuTimes struct {
	Idle  uint64
	Total uint64
}

func cpuUsage() int {
	current, ok := readCPUTimes()
	if !ok {
		return cpuLoadAveragePercentFallback()
	}
	cpuUsageMu.Lock()
	ready := previousCPUReady
	if !ready {
		previousCPUTimes = current
		previousCPUReady = true
	}
	cpuUsageMu.Unlock()
	if !ready {
		time.Sleep(200 * time.Millisecond)
		if next, ok := readCPUTimes(); ok {
			current = next
		}
	}
	return cpuUsageFromTimes(current)
}

func cpuUsageFromTimes(current cpuTimes) int {
	cpuUsageMu.Lock()
	defer cpuUsageMu.Unlock()
	previous := previousCPUTimes
	previousCPUTimes = current
	previousCPUReady = true
	if current.Total <= previous.Total {
		return 0
	}
	totalDelta := current.Total - previous.Total
	idleDelta := uint64(0)
	if current.Idle > previous.Idle {
		idleDelta = current.Idle - previous.Idle
	}
	if idleDelta >= totalDelta {
		return 0
	}
	busyDelta := totalDelta - idleDelta
	usage := int((busyDelta*100 + totalDelta/2) / totalDelta)
	if usage < 0 {
		return 0
	}
	if usage > 100 {
		return 100
	}
	return usage
}

func readCPUTimes() (cpuTimes, bool) {
	b, err := os.ReadFile("/proc/stat")
	if err != nil {
		return cpuTimes{}, false
	}
	for _, line := range strings.Split(string(b), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 5 || fields[0] != "cpu" {
			continue
		}
		values := make([]uint64, 0, len(fields)-1)
		for _, field := range fields[1:] {
			value, err := strconv.ParseUint(field, 10, 64)
			if err != nil {
				value = 0
			}
			values = append(values, value)
		}
		total := uint64(0)
		for _, value := range values {
			total += value
		}
		idle := values[3]
		if len(values) > 4 {
			idle += values[4]
		}
		if total == 0 {
			return cpuTimes{}, false
		}
		return cpuTimes{Idle: idle, Total: total}, true
	}
	return cpuTimes{}, false
}

func cpuLoadAveragePercentFallback() int {
	b, _ := os.ReadFile("/proc/loadavg")
	f := strings.Fields(string(b))
	if len(f) == 0 {
		return 0
	}
	v, _ := strconv.ParseFloat(f[0], 64)
	cores := runtime.NumCPU()
	if cores <= 0 {
		cores = 1
	}
	usage := int((v/float64(cores))*100 + 0.5)
	if usage < 0 {
		return 0
	}
	if usage > 100 {
		return 100
	}
	return usage
}

func netBytes(idx int) uint64 {
	b, _ := os.ReadFile("/proc/net/dev")
	var total uint64
	for _, line := range strings.Split(string(b), "\n") {
		if !strings.Contains(line, ":") || strings.Contains(line, "lo:") {
			continue
		}
		parts := strings.Fields(strings.ReplaceAll(line, ":", " "))
		if len(parts) > 9 {
			if idx == 0 {
				v, _ := strconv.ParseUint(parts[1], 10, 64)
				total += v
			} else {
				v, _ := strconv.ParseUint(parts[9], 10, 64)
				total += v
			}
		}
	}
	return total
}

func diskStats() (usage int, used uint64, total uint64) {
	out, err := commandOutputWithTimeout(3*time.Second, "sh", "-c", `df -P -B1 / | awk 'NR==2 {gsub("%","",$5); print $5, $3, $2}'`)
	if err != nil {
		return 0, 0, 0
	}
	fields := strings.Fields(string(out))
	if len(fields) >= 1 {
		usage, _ = strconv.Atoi(fields[0])
	}
	if len(fields) >= 2 {
		used, _ = strconv.ParseUint(fields[1], 10, 64)
	}
	if len(fields) >= 3 {
		total, _ = strconv.ParseUint(fields[2], 10, 64)
	}
	return usage, used, total
}
