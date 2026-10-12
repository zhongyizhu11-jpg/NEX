package main

// 主机安全巡检（扩展模块 "security"，面板那头见 server/ops/hostSecurityAgent.ts）。
//
// 每 N 分钟（指令给，默认 5）把这台机器上容易被人动手脚的地方看一遍，和磁盘上的基线比：
//   新开的监听端口、新的可登录账号、authorized_keys、sudoers、crontab、systemd 服务、
//   内核模块、跑在临时目录 / 已删除文件里的进程、挖矿进程、长时间吃满 CPU 的陌生进程、
//   SSH 登录、Agent 自己的程序文件。
// 第一次跑只建基线，不报任何事 —— 装 Agent 之前就在的东西默认是主人自己的。
//
// 发现分两种：
//   - 「变化」（多了一把钥匙、sudoers 改了、有人登录）只报一次，报完基线就跟上；
//   - 「状态」（端口开着、可疑进程在跑）每次巡检都报，带上这一段从什么时候开始（since），
//     消失后再出现就是新的一段 —— 面板靠它判断「已知道」的发现要不要重新打开。
//
// 成本：只读小文件（单个文件封顶 256KB），进程表扫一遍 /proc，Agent 程序文件只在
// 大小 / 修改时间变了才重新算哈希。动手处置（停进程、隔离文件）只在面板确认后、
// 重新核对过发现仍然成立才做，见 security_actions.go。账号和 SSH 钥匙从不自动改动。

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	securityStateVersion       = 1
	securityDefaultInterval    = 5 * time.Minute
	securitySmallFileMax       = 256 * 1024
	securityHashFileMax        = 64 * 1024 * 1024
	securityAuthLogReadMax     = 1024 * 1024
	securityMaxProcesses       = 4096
	securityMaxPendingFindings = 200
	securityMaxFilesPerDir     = 200
	securityClockTicks         = 100.0
	securityCPUThreshold       = 90.0
	securityCPUMinWindow       = 2 * time.Minute
)

var (
	securityStateDir      = persistentRuntimeDir + "/security"
	securityStatePath     = securityStateDir + "/state.json"
	securityQuarantineDir = persistentRuntimeDir + "/quarantine"
)

type securityFinding struct {
	Fingerprint string         `json:"fingerprint"`
	Kind        string         `json:"kind"`
	Severity    string         `json:"severity"` // low | medium | high | critical
	Title       string         `json:"title"`
	Detail      string         `json:"detail"`
	Evidence    map[string]any `json:"evidence"`
	Persistent  bool           `json:"persistent"`
	Since       int64          `json:"since"`
	At          int64          `json:"at"`
}

type securityFileStamp struct {
	Path    string `json:"path"`
	Size    int64  `json:"size"`
	ModTime int64  `json:"modTime"`
	Inode   uint64 `json:"inode"`
	SHA256  string `json:"sha256"`
}

type securityLogCursor struct {
	Path   string `json:"path"`
	Inode  uint64 `json:"inode"`
	Offset int64  `json:"offset"`
}

type securityState struct {
	Version              int                    `json:"version"`
	BaselineAt           int64                  `json:"baselineAt"`
	AgentVersion         string                 `json:"agentVersion"`
	AgentBinary          securityFileStamp      `json:"agentBinary"`
	BinaryMismatchChecks int                    `json:"binaryMismatchChecks"`
	ListenPorts          []string               `json:"listenPorts"`
	Accounts             []string               `json:"accounts"`
	AuthorizedKeys       map[string][]string    `json:"authorizedKeys"`
	Sudoers              map[string][]string    `json:"sudoers"`
	Crontabs             map[string][]string    `json:"crontabs"`
	SystemdUnits         []string               `json:"systemdUnits"`
	KernelModules        []string               `json:"kernelModules"`
	Executables          []string               `json:"executables"`
	AuthLog              securityLogCursor      `json:"authLog"`
	Episodes             map[string]int64       `json:"episodes"`
	Pending              []securityFinding      `json:"pending"`
	PendingResults       []securityActionResult `json:"pendingResults"`
	Executed             map[string]int64       `json:"executed"`
	BaselineToken        string                 `json:"baselineToken"`
}

type securityDirective struct {
	IntervalMinutes int                     `json:"intervalMinutes"`
	ManagedPorts    []int                   `json:"managedPorts"`
	Actions         []securityActionRequest `json:"actions"`
	// 面板想让这台机器重建基线时换一个新值（「重新建立基线」按钮）。
	BaselineToken string `json:"baselineToken,omitempty"`
}

type securityReport struct {
	CheckedAt       int64 `json:"checkedAt,omitempty"`
	BaselineReady   bool  `json:"baselineReady"`
	BaselineAt      int64 `json:"baselineAt,omitempty"`
	IntervalMinutes int   `json:"intervalMinutes"`
	// Complete 为真时 Active 是这次巡检里所有「状态」类发现的完整列表，面板据此把不在里面的标成已消失。
	Complete      bool                   `json:"complete"`
	Findings      []securityFinding      `json:"findings"`
	Active        []string               `json:"active"`
	ActionResults []securityActionResult `json:"actionResults,omitempty"`
}

type securityCPUSample struct {
	ticks uint64
	at    time.Time
	exe   string
}

type securityModule struct {
	mu            sync.Mutex
	stateLoaded   bool
	state         *securityState
	directiveSeen bool
	directiveHash string
	interval      time.Duration
	managedPorts  map[int]bool
	pendingToken  string
	lastCheck     time.Time
	lastCheckAt   int64
	checkSeq      int64 // 第几次巡检（同一秒里跑两次也分得开）
	checkSent     int64 // 已经送达面板的那次巡检序号
	current       []securityFinding
	cpuPrev       map[int]securityCPUSample
	ownerCache    map[string]procInfo
	hashCache     map[string]string
	// 这一轮 Report 送出去了多少条 Pending / PendingResults；Apply（说明这一轮成功）时从头删掉这么多。
	inflightFindings int
	inflightResults  int
	inflightCheck    int64
}

func init() {
	registerExtModule(&securityModule{
		interval:     securityDefaultInterval,
		managedPorts: map[int]bool{},
		cpuPrev:      map[int]securityCPUSample{},
		ownerCache:   map[string]procInfo{},
		hashCache:    map[string]string{},
	})
}

func (m *securityModule) Name() string { return "security" }

func (m *securityModule) loadStateLocked() {
	if m.stateLoaded {
		return
	}
	m.stateLoaded = true
	raw, err := os.ReadFile(securityStatePath)
	if err != nil {
		return
	}
	var st securityState
	if json.Unmarshal(raw, &st) != nil || st.Version != securityStateVersion || st.BaselineAt <= 0 {
		return
	}
	st.ensureMaps()
	m.state = &st
}

func (st *securityState) ensureMaps() {
	if st.AuthorizedKeys == nil {
		st.AuthorizedKeys = map[string][]string{}
	}
	if st.Sudoers == nil {
		st.Sudoers = map[string][]string{}
	}
	if st.Crontabs == nil {
		st.Crontabs = map[string][]string{}
	}
	if st.Episodes == nil {
		st.Episodes = map[string]int64{}
	}
	if st.Executed == nil {
		st.Executed = map[string]int64{}
	}
}

func (m *securityModule) saveStateLocked() {
	if m.state == nil {
		return
	}
	if err := writePersistentJSON(securityStatePath, m.state); err != nil && shouldLogAgentReport("security-state-save", 10*time.Minute) {
		logf("security: save state failed: %v", err)
	}
}

func (m *securityModule) Apply(cfg Config, directive json.RawMessage) {
	m.mu.Lock()
	// 走到 Apply 说明这一轮 POST 成功了：上一轮 Report 里带出去的东西已经送达。
	m.loadStateLocked()
	if m.state != nil && (m.inflightFindings > 0 || m.inflightResults > 0) {
		if m.inflightFindings > len(m.state.Pending) {
			m.inflightFindings = len(m.state.Pending)
		}
		if m.inflightResults > len(m.state.PendingResults) {
			m.inflightResults = len(m.state.PendingResults)
		}
		m.state.Pending = m.state.Pending[m.inflightFindings:]
		m.state.PendingResults = m.state.PendingResults[m.inflightResults:]
		m.saveStateLocked()
	}
	m.inflightFindings, m.inflightResults = 0, 0
	if m.inflightCheck > m.checkSent {
		m.checkSent = m.inflightCheck
	}
	sum := sha256.Sum256(directive)
	hash := hex.EncodeToString(sum[:])
	if hash == m.directiveHash {
		m.mu.Unlock()
		return
	}
	var d securityDirective
	if err := json.Unmarshal(directive, &d); err != nil {
		m.mu.Unlock()
		logf("security: bad directive: %v", err)
		return
	}
	m.directiveHash = hash
	m.directiveSeen = true
	minutes := d.IntervalMinutes
	if minutes <= 0 {
		minutes = 5
	}
	if minutes > 60 {
		minutes = 60
	}
	m.interval = time.Duration(minutes) * time.Minute
	ports := make(map[int]bool, len(d.ManagedPorts))
	for _, p := range d.ManagedPorts {
		if p > 0 && p <= 65535 {
			ports[p] = true
		}
	}
	m.managedPorts = ports
	if d.BaselineToken != "" && (m.state == nil || m.state.BaselineToken != d.BaselineToken) {
		m.pendingToken = d.BaselineToken
	}
	var todo []securityActionRequest
	for _, a := range d.Actions {
		key := strconv.Itoa(a.ID)
		if a.ID <= 0 {
			continue
		}
		if m.state != nil {
			if _, done := m.state.Executed[key]; done {
				continue
			}
			m.state.Executed[key] = time.Now().Unix()
		}
		todo = append(todo, a)
	}
	if len(todo) > 0 && m.state != nil {
		m.saveStateLocked()
	}
	m.mu.Unlock()
	for _, a := range todo {
		go m.runAction(a)
	}
}

func (m *securityModule) runAction(req securityActionRequest) {
	result := executeSecurityAction(req)
	m.mu.Lock()
	if m.state != nil {
		m.state.PendingResults = append(m.state.PendingResults, result)
		m.saveStateLocked()
	}
	m.mu.Unlock()
	logf("security: action id=%d %s ok=%v %s", req.ID, req.Action, result.OK, result.Message)
	wakeAgentExt()
}

func (m *securityModule) Report(cfg Config) any {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.loadStateLocked()
	if !m.directiveSeen {
		return nil
	}
	now := time.Now()
	if m.pendingToken != "" {
		// 面板要求重建基线：扔掉旧的，下面这次巡检就当第一次。
		m.state = nil
		m.lastCheck = time.Time{}
	}
	if m.lastCheck.IsZero() || now.Sub(m.lastCheck) >= m.interval {
		m.runCheckLocked(now)
	}
	if m.state == nil {
		return nil
	}
	newCheck := m.checkSeq > m.checkSent
	if !newCheck && len(m.state.Pending) == 0 && len(m.state.PendingResults) == 0 {
		return nil
	}
	findings := make([]securityFinding, 0, len(m.state.Pending)+len(m.current))
	findings = append(findings, m.state.Pending...)
	report := securityReport{
		BaselineReady:   true,
		BaselineAt:      m.state.BaselineAt,
		IntervalMinutes: int(m.interval / time.Minute),
		ActionResults:   append([]securityActionResult(nil), m.state.PendingResults...),
	}
	if newCheck {
		report.CheckedAt = m.lastCheckAt
		report.Complete = true
		findings = append(findings, m.current...)
		report.Active = make([]string, 0, len(m.current))
		for _, f := range m.current {
			report.Active = append(report.Active, f.Fingerprint)
		}
	}
	report.Findings = findings
	m.inflightFindings = len(m.state.Pending)
	m.inflightResults = len(m.state.PendingResults)
	m.inflightCheck = m.checkSeq
	return report
}

// ---------- 一次巡检 ----------

type securitySnapshot struct {
	listen         map[string]listenSocket
	accounts       []passwdAccount
	loginAccounts  []string
	authorizedKeys map[string][]authorizedKey
	sudoers        map[string]map[string]string
	crontabs       map[string]map[string]string
	systemdUnits   []string
	kernelModules  []string
	processes      []procInfo
	agentBinary    securityFileStamp
}

func (m *securityModule) runCheckLocked(now time.Time) {
	m.lastCheck = now
	m.lastCheckAt = now.Unix()
	m.checkSeq++
	snap := collectSecuritySnapshot()
	if m.state == nil {
		m.state = newSecurityBaseline(snap, now)
		if m.pendingToken != "" {
			m.state.BaselineToken = m.pendingToken
			m.pendingToken = ""
		}
		m.current = nil
		m.sampleCPU(snap.processes, now)
		m.saveStateLocked()
		logf("security: baseline created ports=%d accounts=%d units=%d modules=%d", len(m.state.ListenPorts), len(m.state.Accounts), len(m.state.SystemdUnits), len(m.state.KernelModules))
		return
	}
	st := m.state
	at := now.Unix()
	var events []securityFinding
	var persistent []securityFinding

	persistent = append(persistent, m.checkListenPorts(snap)...)
	events = append(events, diffAccounts(st, snap)...)
	events = append(events, diffAuthorizedKeys(st, snap)...)
	events = append(events, diffLineFiles("sudoers", st.Sudoers, snap.sudoers)...)
	events = append(events, diffLineFiles("cron", st.Crontabs, snap.crontabs)...)
	events = append(events, diffSystemdUnits(st, snap)...)
	events = append(events, diffKernelModules(st, snap)...)
	persistent = append(persistent, m.checkProcesses(snap, now)...)
	events = append(events, checkSSHLogins(st)...)
	events = append(events, checkAgentBinary(st, snap)...)

	// 状态类：维护每段的开始时间。
	seen := map[string]bool{}
	for i := range persistent {
		f := &persistent[i]
		seen[f.Fingerprint] = true
		since, ok := st.Episodes[f.Fingerprint]
		if !ok {
			since = at
			st.Episodes[f.Fingerprint] = at
		}
		f.Persistent = true
		f.Since = since
		f.At = at
	}
	for fp := range st.Episodes {
		if !seen[fp] {
			delete(st.Episodes, fp)
		}
	}
	for i := range events {
		events[i].Since = at
		events[i].At = at
	}
	st.Pending = append(st.Pending, events...)
	if len(st.Pending) > securityMaxPendingFindings {
		st.Pending = st.Pending[len(st.Pending)-securityMaxPendingFindings:]
	}
	// 已执行动作的记录只留一天，够面板收走结果了。
	for id, t := range st.Executed {
		if at-t > 86400 {
			delete(st.Executed, id)
		}
	}
	m.current = persistent
	m.saveStateLocked()
}

func newSecurityBaseline(snap securitySnapshot, now time.Time) *securityState {
	st := &securityState{
		Version:      securityStateVersion,
		BaselineAt:   now.Unix(),
		AgentVersion: Version,
		AgentBinary:  snap.agentBinary,
	}
	st.ensureMaps()
	for key := range snap.listen {
		st.ListenPorts = append(st.ListenPorts, key)
	}
	sort.Strings(st.ListenPorts)
	st.Accounts = append([]string(nil), snap.loginAccounts...)
	for p, keys := range snap.authorizedKeys {
		for _, k := range keys {
			st.AuthorizedKeys[p] = append(st.AuthorizedKeys[p], k.Hash)
		}
	}
	for p, lines := range snap.sudoers {
		st.Sudoers[p] = lineHashes(lines)
	}
	for p, lines := range snap.crontabs {
		st.Crontabs[p] = lineHashes(lines)
	}
	st.SystemdUnits = append([]string(nil), snap.systemdUnits...)
	st.KernelModules = append([]string(nil), snap.kernelModules...)
	exes := map[string]bool{}
	for _, p := range snap.processes {
		if p.Exe != "" {
			exes[strings.TrimSuffix(p.Exe, " (deleted)")] = true
		}
	}
	for e := range exes {
		st.Executables = append(st.Executables, e)
	}
	sort.Strings(st.Executables)
	// SSH 日志从现在的末尾开始读：装之前的登录不算。
	if path := securityAuthLogPath(); path != "" {
		if info, err := os.Stat(path); err == nil {
			st.AuthLog = securityLogCursor{Path: path, Inode: fileInode(info), Offset: info.Size()}
		}
	}
	return st
}

func collectSecuritySnapshot() securitySnapshot {
	snap := securitySnapshot{
		listen:         map[string]listenSocket{},
		authorizedKeys: map[string][]authorizedKey{},
		sudoers:        map[string]map[string]string{},
		crontabs:       map[string]map[string]string{},
	}
	for _, src := range []struct{ path, proto string }{
		{"/proc/net/tcp", "tcp"}, {"/proc/net/tcp6", "tcp"}, {"/proc/net/udp", "udp"}, {"/proc/net/udp6", "udp"},
	} {
		f, err := os.Open(src.path)
		if err != nil {
			continue
		}
		for _, s := range parseListeningSockets(f, src.proto) {
			if s.Loopback {
				continue
			}
			key := listenKey(s.Proto, s.Port)
			if _, ok := snap.listen[key]; !ok {
				snap.listen[key] = s
			}
		}
		f.Close()
	}
	// UDP 的临时端口（DNS 查询、转发程序给每个客户端开的出口）不是「监听」：只看临时端口范围以下的。
	low := ephemeralPortLow()
	for key, s := range snap.listen {
		if s.Proto == "udp" && s.Port >= low {
			delete(snap.listen, key)
		}
	}

	if content, ok := readSmallFile("/etc/passwd"); ok {
		snap.accounts = parsePasswdAccounts(content)
	}
	keyPaths := map[string]string{}
	for _, a := range snap.accounts {
		if !isLoginShell(a.Shell) && a.UID != 0 {
			continue
		}
		snap.loginAccounts = append(snap.loginAccounts, a.Name)
		if a.Home == "" || a.Home == "/" || len(keyPaths) >= 100 {
			continue
		}
		for _, name := range []string{"authorized_keys", "authorized_keys2"} {
			keyPaths[filepath.Join(a.Home, ".ssh", name)] = a.Name
		}
	}
	sort.Strings(snap.loginAccounts)
	for p := range keyPaths {
		if content, ok := readSmallFile(p); ok {
			snap.authorizedKeys[p] = parseAuthorizedKeys(content)
		}
	}

	for _, p := range append([]string{"/etc/sudoers"}, listDirFiles("/etc/sudoers.d")...) {
		if content, ok := readSmallFile(p); ok {
			snap.sudoers[p] = significantLines(content, 2000)
		}
	}
	cronFiles := []string{"/etc/crontab"}
	cronFiles = append(cronFiles, listDirFiles("/etc/cron.d")...)
	cronFiles = append(cronFiles, listDirFiles("/var/spool/cron")...)
	cronFiles = append(cronFiles, listDirFiles("/var/spool/cron/crontabs")...)
	for _, p := range cronFiles {
		if content, ok := readSmallFile(p); ok {
			snap.crontabs[p] = significantLines(content, 2000)
		}
	}

	if entries, err := os.ReadDir("/etc/systemd/system"); err == nil {
		for _, e := range entries {
			name := e.Name()
			if e.IsDir() || strings.HasPrefix(name, "forwardx") {
				continue
			}
			switch filepath.Ext(name) {
			case ".service", ".timer", ".socket", ".path":
				snap.systemdUnits = append(snap.systemdUnits, name)
			}
		}
		sort.Strings(snap.systemdUnits)
	}
	if content, ok := readSmallFile("/proc/modules"); ok {
		snap.kernelModules = parseProcModules(content)
	}
	snap.processes = scanProcesses()
	snap.agentBinary = statAgentBinary()
	return snap
}

// ---------- 各项比对 ----------

func (m *securityModule) checkListenPorts(snap securitySnapshot) []securityFinding {
	baseline := map[string]bool{}
	for _, k := range m.state.ListenPorts {
		baseline[k] = true
	}
	var candidates []listenSocket
	for key, s := range snap.listen {
		if baseline[key] || m.managedPorts[s.Port] {
			continue
		}
		candidates = append(candidates, s)
	}
	if len(candidates) == 0 {
		return nil
	}
	sort.Slice(candidates, func(i, j int) bool {
		return listenKey(candidates[i].Proto, candidates[i].Port) < listenKey(candidates[j].Proto, candidates[j].Port)
	})
	owners := m.socketOwners(candidates, snap.processes)
	users := uidNames(snap.accounts)
	var out []securityFinding
	for _, s := range candidates {
		owner, known := owners[s.Inode]
		if known && isAgentManagedProcess(owner) {
			continue
		}
		key := listenKey(s.Proto, s.Port)
		exeBase := ""
		evidence := map[string]any{"proto": s.Proto, "port": s.Port}
		detail := "巡检基线里没有这个端口。"
		if known {
			exe := strings.TrimSuffix(owner.Exe, " (deleted)")
			exeBase = filepath.Base(exe)
			evidence["pid"] = owner.PID
			evidence["exe"] = exe
			evidence["comm"] = owner.Comm
			if u := users[processUID(owner.PID)]; u != "" {
				evidence["user"] = u
			}
			detail = "进程 " + owner.Comm + "（" + exe + "，pid " + strconv.Itoa(owner.PID) + "）在对外监听 " + key + "，巡检基线里没有这个端口。"
		}
		out = append(out, securityFinding{
			Fingerprint: securityFingerprint("listen_port", key, exeBase),
			Kind:        "listen_port",
			Severity:    "medium",
			Title:       "新开了对外监听端口 " + key,
			Detail:      detail,
			Evidence:    evidence,
		})
	}
	return out
}

func diffAccounts(st *securityState, snap securitySnapshot) []securityFinding {
	added := addedStrings(st.Accounts, snap.loginAccounts)
	byName := map[string]passwdAccount{}
	for _, a := range snap.accounts {
		byName[a.Name] = a
	}
	var out []securityFinding
	for _, name := range added {
		a := byName[name]
		sev := "high"
		title := "新增了可登录账号 " + name
		if a.UID == 0 && name != "root" {
			sev = "critical"
			title = "新增了 UID 为 0 的账号 " + name
		}
		out = append(out, securityFinding{
			Fingerprint: securityFingerprint("account_new", name, strconv.Itoa(a.UID)),
			Kind:        "account_new",
			Severity:    sev,
			Title:       title,
			Detail:      "账号 " + name + "（UID " + strconv.Itoa(a.UID) + "，shell " + a.Shell + "，家目录 " + a.Home + "）是上次巡检之后出现的。",
			Evidence:    map[string]any{"user": name, "uid": a.UID, "shell": a.Shell, "home": a.Home},
		})
	}
	st.Accounts = append([]string(nil), snap.loginAccounts...)
	return out
}

func diffAuthorizedKeys(st *securityState, snap securitySnapshot) []securityFinding {
	var out []securityFinding
	paths := make([]string, 0, len(snap.authorizedKeys))
	for p := range snap.authorizedKeys {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	next := map[string][]string{}
	for _, p := range paths {
		keys := snap.authorizedKeys[p]
		known := map[string]bool{}
		for _, h := range st.AuthorizedKeys[p] {
			known[h] = true
		}
		owner := ownerFromKeyPath(p, snap.accounts)
		for _, k := range keys {
			next[p] = append(next[p], k.Hash)
			if known[k.Hash] {
				continue
			}
			known[k.Hash] = true
			sev := "high"
			if owner == "root" {
				sev = "critical"
			}
			comment := k.Comment
			if comment == "" {
				comment = "（没有注释）"
			}
			out = append(out, securityFinding{
				Fingerprint: securityFingerprint("ssh_key_added", p, k.Hash),
				Kind:        "ssh_key_added",
				Severity:    sev,
				Title:       owner + " 的 authorized_keys 多了一把钥匙",
				Detail:      p + " 里新增了一把 " + k.Type + " 钥匙，注释：" + comment + "。拿着对应私钥的人可以直接登录这台机器。",
				Evidence:    map[string]any{"path": p, "user": owner, "keyType": k.Type, "comment": k.Comment, "keyHash": k.Hash},
			})
		}
	}
	st.AuthorizedKeys = next
	return out
}

func ownerFromKeyPath(p string, accounts []passwdAccount) string {
	home := filepath.Dir(filepath.Dir(p))
	for _, a := range accounts {
		if a.Home == home {
			return a.Name
		}
	}
	return filepath.Base(home)
}

// diffLineFiles：sudoers / crontab 这类「一行一条」的配置，新增的行算一次变化。
func diffLineFiles(kind string, baseline map[string][]string, current map[string]map[string]string) []securityFinding {
	var out []securityFinding
	paths := make([]string, 0, len(current))
	for p := range current {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	next := map[string][]string{}
	for _, p := range paths {
		lines := current[p]
		next[p] = lineHashes(lines)
		added := addedLines(baseline[p], lines)
		if len(added) == 0 {
			continue
		}
		shown := added
		if len(shown) > 5 {
			shown = shown[:5]
		}
		for i := range shown {
			shown[i] = truncateText(shown[i], 200)
		}
		more := ""
		if len(added) > len(shown) {
			more = "（另有 " + strconv.Itoa(len(added)-len(shown)) + " 行）"
		}
		var f securityFinding
		_, existed := baseline[p]
		switch kind {
		case "sudoers":
			f = securityFinding{Kind: "sudoers_changed", Severity: "high", Title: "sudo 权限配置有改动：" + p}
			if !existed {
				f.Title = "新增了 sudo 权限配置：" + p
			}
		default:
			f = securityFinding{Kind: "cron_changed", Severity: "medium", Title: "定时任务有改动：" + p}
			if !existed {
				f.Title = "新增了定时任务：" + p
			}
			if riskyCronPattern.MatchString(strings.Join(added, "\n")) {
				f.Severity = "high"
			}
		}
		f.Fingerprint = securityFingerprint(f.Kind, p, strings.Join(lineHashesOf(added), ","))
		f.Detail = "新增的内容：\n" + strings.Join(shown, "\n") + more
		f.Evidence = map[string]any{"path": p, "addedLines": shown}
		out = append(out, f)
	}
	for k := range baseline {
		delete(baseline, k)
	}
	for k, v := range next {
		baseline[k] = v
	}
	return out
}

func lineHashesOf(lines []string) []string {
	out := make([]string, 0, len(lines))
	for _, l := range lines {
		out = append(out, shortHash(l))
	}
	sort.Strings(out)
	return out
}

func diffSystemdUnits(st *securityState, snap securitySnapshot) []securityFinding {
	var out []securityFinding
	for _, name := range addedStrings(st.SystemdUnits, snap.systemdUnits) {
		p := filepath.Join("/etc/systemd/system", name)
		sev := "medium"
		execLine := ""
		if content, ok := readSmallFile(p); ok {
			for _, line := range strings.Split(content, "\n") {
				line = strings.TrimSpace(line)
				if strings.HasPrefix(line, "ExecStart") {
					execLine = truncateText(line, 200)
					break
				}
			}
		}
		if execLine != "" && riskyCronPattern.MatchString(execLine) {
			sev = "high"
		}
		detail := p + " 是上次巡检之后新出现的。"
		if execLine != "" {
			detail += "\n" + execLine
		}
		out = append(out, securityFinding{
			Fingerprint: securityFingerprint("systemd_unit_new", name, shortHash(execLine)),
			Kind:        "systemd_unit_new",
			Severity:    sev,
			Title:       "新增了系统服务 " + name,
			Detail:      detail,
			Evidence:    map[string]any{"path": p, "exec": execLine},
		})
	}
	st.SystemdUnits = append([]string(nil), snap.systemdUnits...)
	return out
}

func diffKernelModules(st *securityState, snap securitySnapshot) []securityFinding {
	var out []securityFinding
	if len(snap.kernelModules) == 0 {
		return nil
	}
	for _, name := range addedStrings(st.KernelModules, snap.kernelModules) {
		if isBenignKernelModule(name) {
			continue
		}
		out = append(out, securityFinding{
			Fingerprint: securityFingerprint("kernel_module_new", name),
			Kind:        "kernel_module_new",
			Severity:    "medium",
			Title:       "加载了新的内核模块 " + name,
			Detail:      "内核模块 " + name + " 是上次巡检之后加载的。内核模块能直接改系统行为，不认识的话值得查一下。",
			Evidence:    map[string]any{"module": name},
		})
	}
	// 基线取并集：模块按需加载又卸载很常见，卸了再加载不该再提一次。
	st.KernelModules = mergeSorted(st.KernelModules, snap.kernelModules)
	return out
}

func mergeSorted(a, b []string) []string {
	set := map[string]bool{}
	for _, v := range a {
		set[v] = true
	}
	for _, v := range b {
		set[v] = true
	}
	out := make([]string, 0, len(set))
	for v := range set {
		out = append(out, v)
	}
	sort.Strings(out)
	return out
}

func (m *securityModule) checkProcesses(snap securitySnapshot, now time.Time) []securityFinding {
	users := uidNames(snap.accounts)
	baselineExe := map[string]bool{}
	for _, e := range m.state.Executables {
		baselineExe[e] = true
	}
	var out []securityFinding
	seenFP := map[string]bool{}
	add := func(f securityFinding) {
		if seenFP[f.Fingerprint] {
			return
		}
		seenFP[f.Fingerprint] = true
		out = append(out, f)
	}
	self := os.Getpid()
	for _, p := range snap.processes {
		if p.PID == self || p.PPID == self {
			continue
		}
		exe := strings.TrimSuffix(p.Exe, " (deleted)")
		evidence := func() map[string]any {
			ev := map[string]any{"pid": p.PID, "exe": exe, "comm": p.Comm, "cmdline": truncateText(p.Cmdline, 300)}
			if u := users[processUID(p.PID)]; u != "" {
				ev["user"] = u
			}
			if sum, size := m.fileHash(exe); sum != "" {
				ev["sha256"] = sum
				ev["size"] = size
			}
			return ev
		}
		if miner, match := looksLikeMiner(p); miner {
			add(securityFinding{
				Fingerprint: securityFingerprint("miner_process", match, filepath.Base(exe)),
				Kind:        "miner_process",
				Severity:    "critical",
				Title:       "发现疑似挖矿进程 " + p.Comm,
				Detail:      "进程 " + p.Comm + "（pid " + strconv.Itoa(p.PID) + "）的名字或命令行像挖矿程序（命中「" + match + "」）。这类程序通常是机器被入侵后植入的。",
				Evidence:    evidence(),
			})
			continue
		}
		if where, bad := suspiciousExeLocation(p.Exe, pathExists); bad {
			title := "有进程从临时目录运行：" + p.Comm
			detail := "进程 " + p.Comm + "（pid " + strconv.Itoa(p.PID) + "）的程序文件在 " + exe + "。正常软件很少从 /tmp、/var/tmp、/dev/shm 运行，入侵后植入的程序常放在这里。"
			switch where {
			case "deleted":
				title = "有进程的程序文件已被删除：" + p.Comm
				detail = "进程 " + p.Comm + "（pid " + strconv.Itoa(p.PID) + "）还在运行，但它的程序文件 " + exe + " 已经从磁盘上删掉了。运行后自删是恶意程序常见的藏身办法。"
			case "memfd":
				title = "有进程直接从内存运行：" + p.Comm
				detail = "进程 " + p.Comm + "（pid " + strconv.Itoa(p.PID) + "）的程序不在磁盘上（" + exe + "），是从内存里直接启动的。"
			}
			sev := "high"
			if where == "memfd" {
				sev = "medium"
			}
			add(securityFinding{
				Fingerprint: securityFingerprint("suspicious_process", where, exe),
				Kind:        "suspicious_process",
				Severity:    sev,
				Title:       title,
				Detail:      detail,
				Evidence:    evidence(),
			})
		}
	}
	// CPU：和上次采样比，一整个巡检周期都在吃满一个核、又不是基线里就有的程序。
	for _, p := range snap.processes {
		prev, ok := m.cpuPrev[p.PID]
		if !ok || prev.exe != p.Exe || p.PID == self || p.PPID == self {
			continue
		}
		window := now.Sub(prev.at)
		if window < securityCPUMinWindow {
			continue
		}
		pct := cpuPercent(prev.ticks, p.cpuTicks, window.Seconds(), securityClockTicks)
		exe := strings.TrimSuffix(p.Exe, " (deleted)")
		if pct < securityCPUThreshold || baselineExe[exe] || isAgentManagedProcess(p) {
			continue
		}
		add(securityFinding{
			Fingerprint: securityFingerprint("high_cpu", exe),
			Kind:        "high_cpu",
			Severity:    "medium",
			Title:       "陌生进程长时间占满 CPU：" + p.Comm,
			Detail:      "进程 " + p.Comm + "（" + exe + "，pid " + strconv.Itoa(p.PID) + "）过去 " + strconv.Itoa(int(window.Minutes())) + " 分钟平均占用 " + strconv.Itoa(int(pct)) + "% 的 CPU，而它不是建立基线时就在跑的程序。",
			Evidence: map[string]any{
				"pid": p.PID, "exe": exe, "comm": p.Comm, "cpuPercent": int(pct), "cmdline": truncateText(p.Cmdline, 300),
			},
		})
	}
	m.sampleCPU(snap.processes, now)
	return out
}

func (m *securityModule) sampleCPU(processes []procInfo, now time.Time) {
	next := make(map[int]securityCPUSample, len(processes))
	for _, p := range processes {
		next[p.PID] = securityCPUSample{ticks: p.cpuTicks, at: now, exe: p.Exe}
	}
	m.cpuPrev = next
}

// fileHash 只给可疑进程的程序文件算哈希（隔离前核对用），按 路径+大小+修改时间 缓存。
func (m *securityModule) fileHash(p string) (string, int64) {
	info, err := os.Stat(p)
	if err != nil || !info.Mode().IsRegular() || info.Size() > securityHashFileMax {
		return "", 0
	}
	key := p + "|" + strconv.FormatInt(info.Size(), 10) + "|" + strconv.FormatInt(info.ModTime().UnixNano(), 10)
	if sum, ok := m.hashCache[key]; ok {
		return sum, info.Size()
	}
	sum, err := sha256File(p, securityHashFileMax)
	if err != nil {
		return "", 0
	}
	if len(m.hashCache) > 256 {
		m.hashCache = map[string]string{}
	}
	m.hashCache[key] = sum
	return sum, info.Size()
}

func checkSSHLogins(st *securityState) []securityFinding {
	path := securityAuthLogPath()
	if path == "" {
		return nil
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil
	}
	inode := fileInode(info)
	cur := st.AuthLog
	if cur.Path != path || cur.Inode != inode || info.Size() < cur.Offset {
		// 日志轮转了（或换了文件）：从新文件开头读。
		cur = securityLogCursor{Path: path, Inode: inode, Offset: 0}
	}
	if info.Size()-cur.Offset > securityAuthLogReadMax {
		cur.Offset = info.Size() - securityAuthLogReadMax
	}
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	if _, err := f.Seek(cur.Offset, io.SeekStart); err != nil {
		return nil
	}
	buf, err := io.ReadAll(io.LimitReader(f, securityAuthLogReadMax))
	if err != nil {
		return nil
	}
	// 只处理到最后一个换行：半行留到下次。
	end := strings.LastIndexByte(string(buf), '\n')
	if end < 0 {
		st.AuthLog = cur
		return nil
	}
	cur.Offset += int64(end + 1)
	st.AuthLog = cur
	logins := parseSSHAccepted(string(buf[:end+1]))
	var out []securityFinding
	seen := map[string]bool{}
	for _, l := range logins {
		fp := securityFingerprint("ssh_login", l.User, l.IP)
		if seen[fp] {
			continue
		}
		seen[fp] = true
		sev := "low"
		if l.Method != "publickey" {
			sev = "medium"
		}
		out = append(out, securityFinding{
			Fingerprint: fp,
			Kind:        "ssh_login",
			Severity:    sev,
			Title:       "SSH 登录：" + l.User + " 来自 " + l.IP,
			Detail:      l.User + " 用 " + l.Method + " 从 " + l.IP + " 登录了这台机器。是你自己的话点「这是我的」，以后同一账号从这个地址登录就不再提醒。",
			Evidence:    map[string]any{"user": l.User, "ip": l.IP, "method": l.Method},
		})
		if len(out) >= 20 {
			break
		}
	}
	return out
}

// checkAgentBinary：Agent 程序文件被换了却不是升级（版本号没变）。升级时文件先换、进程随后重启，
// 中间会有一小段「文件变了、版本没变」，所以要连续两次巡检都对不上才报。
func checkAgentBinary(st *securityState, snap securitySnapshot) []securityFinding {
	cur := snap.agentBinary
	if cur.Path == "" {
		return nil
	}
	if st.AgentVersion != Version {
		st.AgentVersion = Version
		st.AgentBinary = cur
		st.BinaryMismatchChecks = 0
		return nil
	}
	base := st.AgentBinary
	if base.Path == cur.Path && base.Size == cur.Size && base.ModTime == cur.ModTime && base.Inode == cur.Inode {
		st.BinaryMismatchChecks = 0
		return nil
	}
	sum, err := sha256File(cur.Path, 512*1024*1024)
	if err != nil {
		return nil
	}
	cur.SHA256 = sum
	if base.SHA256 != "" && sum == base.SHA256 {
		st.AgentBinary = cur
		st.BinaryMismatchChecks = 0
		return nil
	}
	st.BinaryMismatchChecks++
	if st.BinaryMismatchChecks < 2 {
		return nil
	}
	st.AgentBinary = cur
	st.BinaryMismatchChecks = 0
	return []securityFinding{{
		Fingerprint: securityFingerprint("agent_binary_changed", sum),
		Kind:        "agent_binary_changed",
		Severity:    "critical",
		Title:       "Agent 程序文件被替换了",
		Detail:      cur.Path + " 的内容变了，但不是通过升级换的（版本号还是 " + Version + "）。如果你没有手动替换过它，这台机器可能已经被人动过。",
		Evidence:    map[string]any{"path": cur.Path, "sha256": sum, "previousSha256": base.SHA256, "version": Version},
	}}
}

// ---------- 读系统的小工具 ----------

func readSmallFile(p string) (string, bool) {
	f, err := os.Open(p)
	if err != nil {
		return "", false
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || info.IsDir() {
		return "", false
	}
	buf, err := io.ReadAll(io.LimitReader(f, securitySmallFileMax))
	if err != nil {
		return "", false
	}
	return string(buf), true
}

func listDirFiles(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		if e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		out = append(out, filepath.Join(dir, e.Name()))
		if len(out) >= securityMaxFilesPerDir {
			break
		}
	}
	sort.Strings(out)
	return out
}

func pathExists(p string) bool {
	_, err := os.Lstat(p)
	return err == nil
}

func fileInode(info os.FileInfo) uint64 {
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		return uint64(st.Ino)
	}
	return 0
}

func sha256File(p string, max int64) (string, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, io.LimitReader(f, max)); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func securityAuthLogPath() string {
	for _, p := range []string{"/var/log/auth.log", "/var/log/secure"} {
		if f, err := os.Open(p); err == nil {
			f.Close()
			return p
		}
	}
	return ""
}

func ephemeralPortLow() int {
	if content, ok := readSmallFile("/proc/sys/net/ipv4/ip_local_port_range"); ok {
		if fields := strings.Fields(content); len(fields) >= 1 {
			if n, err := strconv.Atoi(fields[0]); err == nil && n > 1024 {
				return n
			}
		}
	}
	return 32768
}

func statAgentBinary() securityFileStamp {
	p, err := os.Executable()
	if err != nil {
		return securityFileStamp{}
	}
	if resolved, err := filepath.EvalSymlinks(p); err == nil {
		p = resolved
	}
	info, err := os.Stat(p)
	if err != nil {
		return securityFileStamp{}
	}
	stamp := securityFileStamp{Path: p, Size: info.Size(), ModTime: info.ModTime().Unix(), Inode: fileInode(info)}
	return stamp
}

// scanProcesses 扫一遍 /proc：exe、comm、cmdline、ppid、CPU 滴答。内核线程没有 exe，跳过。
func scanProcesses() []procInfo {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}
	var out []procInfo
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid <= 0 {
			continue
		}
		dir := "/proc/" + e.Name()
		exe, err := os.Readlink(dir + "/exe")
		if err != nil || exe == "" {
			continue
		}
		p := procInfo{PID: pid, Exe: exe}
		if stat, ok := readSmallFile(dir + "/stat"); ok {
			p.PPID, p.cpuTicks, _ = parseProcStatCPU(stat)
		}
		if comm, ok := readSmallFile(dir + "/comm"); ok {
			p.Comm = strings.TrimSpace(comm)
		}
		if f, err := os.Open(dir + "/cmdline"); err == nil {
			buf, _ := io.ReadAll(io.LimitReader(f, 4096))
			f.Close()
			p.Cmdline = strings.TrimSpace(strings.ReplaceAll(string(buf), "\x00", " "))
		}
		out = append(out, p)
		if len(out) >= securityMaxProcesses {
			break
		}
	}
	return out
}

func processUID(pid int) int {
	content, ok := readSmallFile("/proc/" + strconv.Itoa(pid) + "/status")
	if !ok {
		return -1
	}
	for _, line := range strings.Split(content, "\n") {
		if strings.HasPrefix(line, "Uid:") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				if n, err := strconv.Atoi(fields[1]); err == nil {
					return n
				}
			}
		}
	}
	return -1
}

func uidNames(accounts []passwdAccount) map[int]string {
	out := make(map[int]string, len(accounts))
	for _, a := range accounts {
		if _, ok := out[a.UID]; !ok {
			out[a.UID] = a.Name
		}
	}
	return out
}

var agentManagedBinaries = map[string]bool{
	"gost": true, "realm": true, "xray": true, "sing-box": true, "hysteria": true, "hysteria2": true,
	"snell-server": true, "tuic-server": true,
}

// isAgentManagedProcess：Agent 自己拉起来的转发 / 代理程序，它们开的端口是面板配的，不是新情况。
func isAgentManagedProcess(p procInfo) bool {
	if p.PID == os.Getpid() || p.PPID == os.Getpid() {
		return true
	}
	exe := strings.TrimSuffix(p.Exe, " (deleted)")
	base := filepath.Base(exe)
	if strings.HasPrefix(base, "forwardx") || agentManagedBinaries[base] {
		return true
	}
	for _, prefix := range []string{"/etc/forwardx/", "/opt/forwardx", "/var/lib/forwardx-agent/", "/usr/local/forwardx"} {
		if strings.HasPrefix(exe, prefix) {
			return true
		}
	}
	return false
}

// socketOwners 找出这些 socket（按 inode）属于哪个进程。要翻每个进程的 /proc/pid/fd，比较贵，
// 所以只在有新端口时做，上次找到的直接复用，fd 成千上万的进程（忙的转发程序）跳过不翻。
func (m *securityModule) socketOwners(sockets []listenSocket, processes []procInfo) map[string]procInfo {
	want := map[string]bool{}
	out := map[string]procInfo{}
	for _, s := range sockets {
		if p, ok := m.ownerCache[s.Inode]; ok {
			out[s.Inode] = p
			continue
		}
		want[s.Inode] = true
	}
	// 先翻非 Agent 管的进程（新端口多半是它们开的），还没找齐再翻 Agent 管的。
	ordered := make([]procInfo, 0, len(processes))
	var managed []procInfo
	for _, p := range processes {
		if isAgentManagedProcess(p) {
			managed = append(managed, p)
		} else {
			ordered = append(ordered, p)
		}
	}
	ordered = append(ordered, managed...)
	if len(want) > 0 {
		for _, p := range ordered {
			fds, err := os.ReadDir("/proc/" + strconv.Itoa(p.PID) + "/fd")
			if err != nil {
				continue
			}
			if len(fds) > 20000 {
				continue
			}
			for _, fd := range fds {
				link, err := os.Readlink("/proc/" + strconv.Itoa(p.PID) + "/fd/" + fd.Name())
				if err != nil || !strings.HasPrefix(link, "socket:[") {
					continue
				}
				inode := strings.TrimSuffix(strings.TrimPrefix(link, "socket:["), "]")
				if want[inode] {
					out[inode] = p
					delete(want, inode)
				}
			}
			if len(want) == 0 {
				break
			}
		}
	}
	m.ownerCache = map[string]procInfo{}
	for k, v := range out {
		m.ownerCache[k] = v
	}
	return out
}
