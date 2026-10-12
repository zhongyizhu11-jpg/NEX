package main

// 安全巡检的纯解析 / 比对逻辑（不碰真系统，测试直接喂字符串）。读文件、扫 /proc 的部分在
// ext_security.go，处置动作在 security_actions.go。

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// securityFingerprint：同一件事每次算出同一个指纹（不带主机、不带 pid、不带时间），
// 面板靠它判断「又出现了」，「所有主机都别再提」也靠它跨主机对上。
func securityFingerprint(parts ...string) string {
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return hex.EncodeToString(sum[:12])
}

func shortHash(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:8])
}

// ---------- 监听端口 ----------

type listenSocket struct {
	Proto    string // tcp | udp
	Port     int
	Inode    string
	Loopback bool
}

// parseListeningSockets 读 /proc/net/{tcp,udp}{,6}。TCP 取 LISTEN（0A）；UDP 没有监听状态，
// 取「本地绑了端口、远端是 0」的 socket（07 且远端端口 0）。
func parseListeningSockets(r io.Reader, proto string) []listenSocket {
	var out []listenSocket
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	first := true
	for scanner.Scan() {
		if first {
			first = false
			continue
		}
		fields := strings.Fields(scanner.Text())
		if len(fields) < 10 {
			continue
		}
		state := fields[3]
		if proto == "tcp" && state != "0A" {
			continue
		}
		if proto == "udp" {
			if state != "07" {
				continue
			}
			if _, remotePort, ok := decodeProcNetAddr(fields[2]); !ok || remotePort != 0 {
				continue
			}
		}
		ip, port, ok := decodeProcNetAddr(fields[1])
		if !ok || port == 0 {
			continue
		}
		out = append(out, listenSocket{Proto: proto, Port: port, Inode: fields[9], Loopback: ip.IsLoopback()})
	}
	return out
}

func listenKey(proto string, port int) string { return proto + "/" + strconv.Itoa(port) }

// ---------- 账号 ----------

type passwdAccount struct {
	Name  string
	UID   int
	Home  string
	Shell string
}

var nonLoginShells = map[string]bool{
	"nologin": true, "false": true, "sync": true, "shutdown": true, "halt": true, "true": true,
}

func isLoginShell(shell string) bool {
	shell = strings.TrimSpace(shell)
	if shell == "" {
		return false
	}
	return !nonLoginShells[path.Base(shell)]
}

// parsePasswdAccounts 读 /etc/passwd，返回所有账号（调用方再挑带登录 shell 的）。
func parsePasswdAccounts(content string) []passwdAccount {
	var out []passwdAccount
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.Split(line, ":")
		if len(parts) < 7 || parts[0] == "" {
			continue
		}
		uid, err := strconv.Atoi(parts[2])
		if err != nil {
			continue
		}
		out = append(out, passwdAccount{Name: parts[0], UID: uid, Home: parts[5], Shell: parts[6]})
	}
	return out
}

// ---------- authorized_keys ----------

type authorizedKey struct {
	Hash    string
	Type    string
	Comment string
}

var sshKeyTypePattern = regexp.MustCompile(`^(ssh-|ecdsa-|sk-)`)

// parseAuthorizedKeys：每把钥匙按「类型 + 公钥本体」算哈希 —— 前面的 options、后面的注释改了
// 不算换钥匙，公钥本体变了才算。
func parseAuthorizedKeys(content string) []authorizedKey {
	var out []authorizedKey
	for _, raw := range strings.Split(content, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		idx := -1
		for i, f := range fields {
			if sshKeyTypePattern.MatchString(f) && i+1 < len(fields) {
				idx = i
				break
			}
		}
		if idx < 0 {
			continue
		}
		comment := ""
		if idx+2 < len(fields) {
			comment = strings.Join(fields[idx+2:], " ")
		}
		out = append(out, authorizedKey{Hash: shortHash(fields[idx] + " " + fields[idx+1]), Type: fields[idx], Comment: truncateText(comment, 80)})
	}
	return out
}

// ---------- sudoers / crontab：按「有意义的行」比 ----------

// significantLines 去掉空行和注释，返回 行哈希 → 原文。sudoers 里的 #include / #includedir
// 是指令不是注释，要留着。
func significantLines(content string, maxLines int) map[string]string {
	out := map[string]string{}
	for _, raw := range strings.Split(content, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "#") && !strings.HasPrefix(line, "#include") {
			continue
		}
		line = strings.Join(strings.Fields(line), " ")
		out[shortHash(line)] = line
		if maxLines > 0 && len(out) >= maxLines {
			break
		}
	}
	return out
}

// addedLines：current 里有、baseline 里没有的行（按原文排序，便于展示）。
func addedLines(baseline []string, current map[string]string) []string {
	seen := make(map[string]bool, len(baseline))
	for _, h := range baseline {
		seen[h] = true
	}
	var out []string
	for h, line := range current {
		if !seen[h] {
			out = append(out, line)
		}
	}
	sort.Strings(out)
	return out
}

func lineHashes(lines map[string]string) []string {
	out := make([]string, 0, len(lines))
	for h := range lines {
		out = append(out, h)
	}
	sort.Strings(out)
	return out
}

var riskyCronPattern = regexp.MustCompile(`(?i)(curl|wget|base64|/tmp/|/dev/shm|/var/tmp/|\bnc\b|bash -i|python -c|\|\s*(ba)?sh)`)

// ---------- 内核模块 ----------

func parseProcModules(content string) []string {
	var out []string
	for _, line := range strings.Split(content, "\n") {
		fields := strings.Fields(line)
		if len(fields) > 0 {
			out = append(out, fields[0])
		}
	}
	sort.Strings(out)
	return out
}

// 这些前缀的模块是防火墙 / 隧道 / 常见驱动按需自动加载的（Agent 自己下 iptables 规则就会
// 带出一串 xt_*），新出现不值得提醒。
var benignModulePrefixes = []string{
	"nf_", "nft_", "xt_", "x_tables", "ip_", "ip6_", "ipt_", "ip6t_", "iptable_", "ip6table_", "ebt", "arpt", "arptable",
	"nfnetlink", "br_netfilter", "bridge", "stp", "llc", "veth", "overlay", "tun", "tap", "wireguard",
	"udp_tunnel", "ip6_udp_tunnel", "ipip", "gre", "ip_gre", "ip6_gre", "sit", "vxlan", "geneve", "dummy",
	"tcp_", "sch_", "cls_", "act_", "em_", "ifb", "crc", "libcrc", "nls_", "fuse", "loop", "binfmt_misc",
	"ipv6", "af_packet", "xfrm", "esp", "ah", "authenc", "echainiv", "cryptd", "aes", "ghash", "sha", "md5", "des",
	"virtio", "vhost", "kvm", "irqbypass", "dm_", "raid", "xor", "async_", "zstd", "lz4", "intel_", "amd", "rapl",
	"cfg80211", "rfkill", "snd", "joydev", "input_leds", "serio_raw", "mousedev", "evdev", "psmouse", "pcspkr",
	"ext4", "xfs", "btrfs", "jbd2", "mbcache", "isofs", "vfat", "fat", "squashfs", "nfs", "lockd", "grace", "sunrpc",
	"ena", "e1000", "ixgbe", "mlx", "vmxnet", "hv_", "xen", "ena_", "8021q", "garp", "mrp", "bonding", "macvlan", "ipvlan",
	"ipvs", "ip_vs", "conntrack", "openvswitch", "nsh", "mpls", "tls", "sctp", "udp_diag", "tcp_diag", "inet_diag", "unix_diag",
	"netlink_diag", "af_alg", "algif_", "ecdh", "ecc", "kheaders", "efi", "button", "ac", "battery", "video", "drm", "ttm",
	"sha1", "sha256", "sha512", "aesni", "amd64_edac", "crct10dif", "polyval", "gf128mul", "i2c", "ata_", "libata", "pata_",
	"scsi", "sd_mod", "sr_mod", "cdrom", "usb", "hid", "uhci", "ehci", "xhci", "floppy", "parport", "ppdev", "qemu_fw_cfg",
	"msr", "cpuid", "edac", "pcbc", "ghash", "lrw", "xts", "cbc", "ecb", "ctr", "gcm", "ccm", "chacha", "poly1305", "curve25519",
	"blake2", "ip_set", "ipt_", "nfsd", "autofs", "configfs", "efivarfs", "dmi_sysfs", "mii", "virtio_net", "net_failover", "failover",
}

func isBenignKernelModule(name string) bool {
	for _, prefix := range benignModulePrefixes {
		// 三个字母以内的（ac、ah、tun……）只认整名或「名_」开头，免得把不相干的模块一并放过。
		if len(prefix) <= 3 && !strings.HasSuffix(prefix, "_") {
			if name == prefix || strings.HasPrefix(name, prefix+"_") {
				return true
			}
			continue
		}
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}

// ---------- SSH 登录 ----------

type sshLogin struct {
	User   string
	IP     string
	Method string
}

var sshAcceptedPattern = regexp.MustCompile(`sshd\[\d+\]: Accepted (\S+) for (\S+) from (\S+) port \d+`)

// parseSSHAccepted 从 auth.log / secure 的一段里挑出成功登录。
func parseSSHAccepted(content string) []sshLogin {
	var out []sshLogin
	for _, line := range strings.Split(content, "\n") {
		m := sshAcceptedPattern.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		out = append(out, sshLogin{Method: m[1], User: m[2], IP: m[3]})
	}
	return out
}

// ---------- 进程 ----------

type procInfo struct {
	PID     int
	PPID    int
	Exe     string // readlink /proc/pid/exe，可能带 " (deleted)"
	Comm    string
	Cmdline string
	// utime+stime（时钟滴答），算 CPU 占用用。
	cpuTicks uint64
}

var minerNames = []string{
	"xmrig", "xmr-stak", "xmrstak", "kdevtmpfsi", "kinsing", "minerd", "cpuminer", "ccminer", "cgminer", "bfgminer",
	"nbminer", "t-rex", "lolminer", "phoenixminer", "ethminer", "nanominer", "srbminer", "teamredminer", "gminer",
	"kthreaddi", "sysrv", "xmrigdaemon", "moneroocean", "c3pool",
}

var minerCmdlinePattern = regexp.MustCompile(`(?i)(stratum\+(tcp|ssl|tls)://|--donate-level|--coin[= ](monero|xmr)|randomx|cryptonight|nicehash|minexmr|supportxmr|moneroocean|c3pool|nanopool\.org|2miners\.com|f2pool)`)

// looksLikeMiner：进程名 / 可执行文件名 / 命令行任一像挖矿程序。
func looksLikeMiner(p procInfo) (bool, string) {
	base := strings.ToLower(path.Base(strings.TrimSuffix(p.Exe, " (deleted)")))
	comm := strings.ToLower(p.Comm)
	for _, name := range minerNames {
		if comm == name || base == name || strings.HasPrefix(comm, name) || strings.HasPrefix(base, name) {
			return true, name
		}
	}
	if m := minerCmdlinePattern.FindString(p.Cmdline); m != "" {
		return true, m
	}
	return false, ""
}

var tmpExecDirs = []string{"/tmp/", "/var/tmp/", "/dev/shm/"}

// suspiciousExeLocation：可执行文件在临时目录里，或者已经被删掉（还在跑，磁盘上没了）。
// 「被删」只在原路径上现在**也没有**文件时才算 —— 软件升级会把正在跑的老文件替换掉，
// 那种进程的 exe 也显示 (deleted)，但同一路径上有新文件，不是可疑的事。
func suspiciousExeLocation(exe string, pathExists func(string) bool) (string, bool) {
	deleted := strings.HasSuffix(exe, " (deleted)")
	clean := strings.TrimSuffix(exe, " (deleted)")
	for _, dir := range tmpExecDirs {
		if strings.HasPrefix(clean, dir) {
			return "tmp", true
		}
	}
	if deleted && clean != "" && !strings.HasPrefix(clean, "/memfd:") && pathExists != nil && !pathExists(clean) {
		return "deleted", true
	}
	// runc 启动容器时会把自己复制进 memfd 再执行（runc_cloned），那是正常的。
	if strings.HasPrefix(clean, "/memfd:") && !strings.HasPrefix(clean, "/memfd:runc_cloned") {
		return "memfd", true
	}
	return "", false
}

// parseProcStatCPU 从 /proc/pid/stat 取 ppid 和 utime+stime（时钟滴答）。comm 里可能有空格和括号，
// 按最后一个 ')' 切开再数字段。
func parseProcStatCPU(content string) (ppid int, ticks uint64, ok bool) {
	end := strings.LastIndexByte(content, ')')
	if end < 0 || end+2 > len(content) {
		return 0, 0, false
	}
	fields := strings.Fields(content[end+2:])
	// 切开后：0=state 1=ppid … 11=utime 12=stime
	if len(fields) < 13 {
		return 0, 0, false
	}
	ppid, err := strconv.Atoi(fields[1])
	if err != nil {
		return 0, 0, false
	}
	utime, err1 := strconv.ParseUint(fields[11], 10, 64)
	stime, err2 := strconv.ParseUint(fields[12], 10, 64)
	if err1 != nil || err2 != nil {
		return 0, 0, false
	}
	return ppid, utime + stime, true
}

// cpuPercent：两次采样之间这个进程用了一个核的百分之几。
func cpuPercent(prevTicks, curTicks uint64, seconds float64, clkTck float64) float64 {
	if curTicks < prevTicks || seconds <= 0 || clkTck <= 0 {
		return 0
	}
	return float64(curTicks-prevTicks) / clkTck / seconds * 100
}

// ---------- 集合比对 ----------

// addedStrings：current 里有、baseline 里没有的（排好序）。
func addedStrings(baseline, current []string) []string {
	seen := make(map[string]bool, len(baseline))
	for _, v := range baseline {
		seen[v] = true
	}
	var out []string
	dup := map[string]bool{}
	for _, v := range current {
		if !seen[v] && !dup[v] {
			out = append(out, v)
			dup[v] = true
		}
	}
	sort.Strings(out)
	return out
}

func truncateText(value string, max int) string {
	if len(value) <= max {
		return value
	}
	// 按 rune 截，别把中文截成半个字。
	runes := []rune(value)
	if len(runes) <= max {
		return value
	}
	return string(runes[:max]) + "…"
}
