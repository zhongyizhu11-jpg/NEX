package main

import (
	"net"
	"strings"
	"time"
)

/*
  主机上配置的全部公网地址（2.2.255 起随静态信息一起上报，面板 shared/hostPublicAddresses.ts 收）。

  原来只报一个 IPv4（ipify 看到的出口）和一个 IPv6：多 IP 的机器（站群、多段 IPv6、一张网卡挂好几个
  公网 IP）面板只知道出口那一个，主 IP 选不了，DDNS 也只能发一条记录。这里列的是**网卡上真正配着的**
  公网地址，不出网去问：ipify 只能告诉你出口是哪个，不能告诉你网卡上还有哪些。

  过滤掉的：私网 / CGNAT / 链路本地 / ULA / 文档段这些别人连不进来的；docker、网桥、veth、虚拟机、
  隧道这类接口上的地址（那是容器或隧道的地址，不是这台机器的入口）；DAD 没过的、已废弃的、临时
  （隐私扩展）IPv6 —— 临时地址几小时就换一个，拿去做 DDNS「全部 IP」只会让记录一直抖。
  每族最多 maxReportedPublicAddresses 个，面板那边同样再截一次。
*/

const maxReportedPublicAddresses = 16

type interfaceAddressCandidate struct {
	Iface string
	IP    string
	// ip 命令那一行地址后面的标志（小写），net.Interfaces 回退时为空
	Flags string
}

type publicAddressList struct {
	IPv4 []string
	IPv6 []string
}

func (list publicAddressList) signature() string {
	return strings.Join(list.IPv4, ",") + "|" + strings.Join(list.IPv6, ",")
}

var publicAddressListCache publicAddressList
var publicAddressListReady bool

// 这些接口上的地址不是本机的公网入口：容器网桥、veth、虚拟机网桥、CNI、各家组网软件、隧道。
var ignoredPublicAddressInterfacePrefixes = []string{
	"lo", "docker", "br-", "veth", "virbr", "vnet", "cni", "flannel", "cali", "cilium", "kube",
	"weave", "lxcbr", "lxdbr", "podman", "tailscale", "zt", "wg", "tun", "tap",
}

func ignoredPublicAddressInterface(name string) bool {
	name = strings.ToLower(strings.TrimSpace(name))
	if name == "" {
		return true
	}
	for _, prefix := range ignoredPublicAddressInterfacePrefixes {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}

var nonPublicIPv4Networks = mustParseCIDRs(
	"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
	"192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24",
	"203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
)

var nonPublicIPv6Networks = mustParseCIDRs(
	"::/128", "::1/128", "::ffff:0:0/96", "64:ff9b::/96", "100::/64", "2001:db8::/32",
	"fc00::/7", "fe80::/10", "ff00::/8",
)

func mustParseCIDRs(values ...string) []*net.IPNet {
	out := make([]*net.IPNet, 0, len(values))
	for _, value := range values {
		_, network, err := net.ParseCIDR(value)
		if err != nil {
			panic(err)
		}
		out = append(out, network)
	}
	return out
}

// publicAddressFamily 返回 4 / 6 表示这是别人能连进来的公网单播地址，0 表示不是。
func publicAddressFamily(ip net.IP) int {
	if ip == nil {
		return 0
	}
	if v4 := ip.To4(); v4 != nil {
		for _, network := range nonPublicIPv4Networks {
			if network.Contains(v4) {
				return 0
			}
		}
		return 4
	}
	if ip.To16() == nil || !ip.IsGlobalUnicast() {
		return 0
	}
	for _, network := range nonPublicIPv6Networks {
		if network.Contains(ip) {
			return 0
		}
	}
	return 6
}

// parseIPAddrOutput 解析 `ip -o addr show scope global` 的输出。每行形如
// `2: eth0    inet 203.0.113.5/24 brd … scope global secondary eth0:1\       valid_lft …`。
func parseIPAddrOutput(raw []byte) []interfaceAddressCandidate {
	out := []interfaceAddressCandidate{}
	for _, line := range strings.Split(string(raw), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}
		iface := strings.TrimSuffix(fields[1], ":")
		if at := strings.Index(iface, "@"); at > 0 {
			iface = iface[:at]
		}
		for i, field := range fields {
			if (field != "inet" && field != "inet6") || i+1 >= len(fields) {
				continue
			}
			ip := strings.Split(fields[i+1], "/")[0]
			flags := strings.ToLower(strings.Join(fields[i+2:], " "))
			out = append(out, interfaceAddressCandidate{Iface: iface, IP: ip, Flags: flags})
			break
		}
	}
	return out
}

func skippedAddressFlags(flags string) bool {
	for _, flag := range strings.Fields(flags) {
		switch strings.TrimSuffix(flag, "\\") {
		case "tentative", "dadfailed", "deprecated", "temporary":
			return true
		}
	}
	return false
}

// collectPublicAddresses 把候选地址过滤、去重、截断。默认路由那张网卡上的排在前面（通常就是主 IP），
// 其余按内核给的次序：次序稳定，面板那边才不会因为换了个顺序就当成地址变了。
func collectPublicAddresses(candidates []interfaceAddressCandidate, defaultIface string) publicAddressList {
	list := publicAddressList{IPv4: []string{}, IPv6: []string{}}
	seen := map[string]bool{}
	add := func(candidate interfaceAddressCandidate) {
		if ignoredPublicAddressInterface(candidate.Iface) || skippedAddressFlags(candidate.Flags) {
			return
		}
		ip := net.ParseIP(strings.Trim(strings.TrimSpace(candidate.IP), "[]"))
		if ip == nil {
			return
		}
		text := ip.String()
		if seen[text] {
			return
		}
		switch publicAddressFamily(ip) {
		case 4:
			if len(list.IPv4) >= maxReportedPublicAddresses {
				return
			}
			seen[text] = true
			list.IPv4 = append(list.IPv4, text)
		case 6:
			if len(list.IPv6) >= maxReportedPublicAddresses {
				return
			}
			seen[text] = true
			list.IPv6 = append(list.IPv6, text)
		}
	}
	baseIface := func(name string) string {
		// eth0:1 这种别名属于 eth0
		if colon := strings.Index(name, ":"); colon > 0 {
			return name[:colon]
		}
		return name
	}
	if defaultIface != "" {
		for _, candidate := range candidates {
			if baseIface(candidate.Iface) == defaultIface {
				add(candidate)
			}
		}
	}
	for _, candidate := range candidates {
		if defaultIface == "" || baseIface(candidate.Iface) != defaultIface {
			add(candidate)
		}
	}
	return list
}

func interfaceAddressCandidatesFromNet() []interfaceAddressCandidate {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	out := []interfaceAddressCandidate{}
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
			if ip != nil {
				out = append(out, interfaceAddressCandidate{Iface: iface.Name, IP: ip.String()})
			}
		}
	}
	return out
}

// localPublicAddresses 优先用 ip 命令（看得到 tentative / deprecated / temporary 标志），没有 ip 命令再退回标准库。
func localPublicAddresses() publicAddressList {
	defaultIface := defaultNetworkInterface()
	if out, err := commandOutputWithTimeout(3*time.Second, "ip", "-o", "addr", "show", "scope", "global"); err == nil {
		if candidates := parseIPAddrOutput(out); len(candidates) > 0 {
			return collectPublicAddresses(candidates, defaultIface)
		}
	}
	return collectPublicAddresses(interfaceAddressCandidatesFromNet(), defaultIface)
}

func refreshPublicAddressList() {
	list := localPublicAddresses()
	publicIPMu.Lock()
	publicAddressListCache = list
	publicAddressListReady = true
	publicIPMu.Unlock()
}

// publicAddressListSnapshot 第一次刷新还没跑完时 ready=false：这时不上报，免得面板把「还没查」当成「一个都没有」。
func publicAddressListSnapshot() (publicAddressList, bool) {
	publicIPMu.Lock()
	defer publicIPMu.Unlock()
	return publicAddressListCache, publicAddressListReady
}

func publicAddressListSignature() string {
	list, ready := publicAddressListSnapshot()
	if !ready {
		return ""
	}
	return list.signature()
}

// addPublicAddressReport 只在报静态信息的那一拍带上：地址列表一般十分钟都不变，没必要每次心跳都发。
func addPublicAddressReport(payload map[string]any, shouldReport bool, egressIPv4 string, egressIPv6 string) {
	if !shouldReport {
		return
	}
	list, ready := publicAddressListSnapshot()
	if !ready {
		return
	}
	payload["publicAddresses"] = map[string]any{
		"ipv4":       list.IPv4,
		"ipv6":       list.IPv6,
		"egressIpv4": egressIPv4,
		"egressIpv6": egressIPv6,
	}
}
