package main

/*
网络调优的存档和 swap（2.2.276，和 tcpfit 的 archive / harden 学的）。

存档：/etc/forwardx-nettune/archives/NNNN.json，存一键调优管的全部内核参数（netTuneBackupKeys）和每条默认路由的初始窗口。
  - 0000 是「调优前」：不另存文件，就是 backup.json + 初始窗口标记里的原值；恢复它就是「还原」，不能改名、删除。
  - 一键调优后自动存一份（Auto），手动可以存当前、恢复、改名、删除。最多 20 份：满了先删最老的自动存档，
    全是手动存的就拒绝。
  - 恢复：每项写完读回来核对，内核不接受的改回原值并报出来；写进 sysctl.d；初始窗口按存档里的值改（存档里没有窗口时
    摘掉、Agent 不再补）。恢复前照样先补备份，0000 一直在。

swap：小内存机器上加一个 /swapfile（tcpfit 的 harden）。已经有 swap、/swapfile 已经在（可能是别人的）、磁盘不够都不做；
fallocate 不行退回 dd；mkswap / swapon 失败（OpenVZ / LXC 不让）就把文件删掉、fstab 不动。成功后写 fstab、
vm.swappiness 调到 10（只在内存真的紧张时才换出）并写进 /etc/sysctl.d/99-forwardx-swap.conf。
删除只删面板建的（swapfile.json 标记），swappiness 回到原值。「还原」不碰 swap。
*/

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode"
)

const (
	netTuneArchiveMax      = 20
	netTuneArchiveNameMax  = 32
	netTuneArchiveZeroName = "调优前"
	netTuneSwappiness      = "10"
)

var (
	netTuneArchiveDir = "/etc/forwardx-nettune/archives"
	netTuneSwapFile   = "/swapfile"
	netTuneFstabPath  = "/etc/fstab"
	netTuneSwapsPath  = "/proc/swaps"
	netTuneSwapMarker = "/etc/forwardx-nettune/swapfile.json"
	netTuneSwapConf   = "/etc/sysctl.d/99-forwardx-swap.conf"
	// netTuneSwapExec 跑 fallocate / dd / mkswap / swapon / swapoff（测试里换掉）。
	netTuneSwapExec = func(name string, args ...string) ([]byte, error) {
		return commandOutputWithTimeout(10*time.Minute, name, args...)
	}
	netTuneDiskFree = func(dir string) (int64, error) {
		var stat syscall.Statfs_t
		if err := syscall.Statfs(dir, &stat); err != nil {
			return 0, err
		}
		return int64(stat.Bavail) * int64(stat.Bsize), nil
	}
)

type netTuneArchiveOp struct {
	// Op：save / restore / rename / delete。
	Op   string `json:"op"`
	Seq  string `json:"seq"`
	Name string `json:"name"`
}

type netTuneArchiveInfo struct {
	Seq     string `json:"seq"`
	Name    string `json:"name"`
	SavedAt int64  `json:"savedAt"`
	Auto    bool   `json:"auto,omitempty"`
}

type netTuneArchive struct {
	Seq     int                           `json:"seq"`
	Name    string                        `json:"name"`
	SavedAt int64                         `json:"savedAt"`
	Auto    bool                          `json:"auto,omitempty"`
	Values  map[string]string             `json:"values"`
	Windows map[string]netTuneRouteWindow `json:"windows,omitempty"`
}

func netTuneArchiveSeqText(seq int) string { return fmt.Sprintf("%04d", seq) }

// netTuneArchiveParseSeq 收 "3"、"0003" 这样的序号。
func netTuneArchiveParseSeq(text string) (int, error) {
	text = strings.TrimSpace(text)
	seq, err := strconv.Atoi(text)
	if err != nil || seq < 0 || seq > 9999 || len(text) > 4 {
		return 0, fmt.Errorf("存档序号不对：%q", text)
	}
	return seq, nil
}

// netTuneArchiveName：去掉控制字符、连续空白压成一个空格、最多 32 个字。
func netTuneArchiveName(raw, fallback string) string {
	var builder strings.Builder
	for _, r := range raw {
		if unicode.IsControl(r) || unicode.IsSpace(r) {
			builder.WriteRune(' ')
			continue
		}
		builder.WriteRune(r)
	}
	name := strings.Join(strings.Fields(builder.String()), " ")
	if runes := []rune(name); len(runes) > netTuneArchiveNameMax {
		name = string(runes[:netTuneArchiveNameMax])
	}
	if name == "" {
		return fallback
	}
	return name
}

func netTuneArchivePath(seq int) string {
	return filepath.Join(netTuneArchiveDir, netTuneArchiveSeqText(seq)+".json")
}

func netTuneArchivesLoad() []netTuneArchive {
	entries, err := os.ReadDir(netTuneArchiveDir)
	if err != nil {
		return nil
	}
	var archives []netTuneArchive
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(netTuneArchiveDir, entry.Name()))
		if err != nil {
			continue
		}
		var archive netTuneArchive
		if json.Unmarshal(raw, &archive) != nil || archive.Seq <= 0 || entry.Name() != netTuneArchiveSeqText(archive.Seq)+".json" {
			continue
		}
		archives = append(archives, archive)
	}
	sort.Slice(archives, func(i, j int) bool { return archives[i].Seq < archives[j].Seq })
	return archives
}

// netTuneArchiveList：报给面板的存档列表；有调优前的备份时第一条是 0000。
func netTuneArchiveList() []netTuneArchiveInfo {
	var list []netTuneArchiveInfo
	if raw, err := os.ReadFile(netTuneBackupPath); err == nil {
		var backup netTuneBackup
		if json.Unmarshal(raw, &backup) == nil {
			list = append(list, netTuneArchiveInfo{Seq: "0000", Name: netTuneArchiveZeroName, SavedAt: backup.SavedAt})
		}
	}
	for _, archive := range netTuneArchivesLoad() {
		list = append(list, netTuneArchiveInfo{Seq: netTuneArchiveSeqText(archive.Seq), Name: archive.Name, SavedAt: archive.SavedAt, Auto: archive.Auto})
	}
	return list
}

func netTuneArchiveWrite(archive netTuneArchive) error {
	if err := os.MkdirAll(netTuneArchiveDir, 0700); err != nil {
		return err
	}
	raw, _ := json.Marshal(archive)
	return writeFileAtomicDurable(netTuneArchivePath(archive.Seq), raw, 0600)
}

// netTuneArchiveSave 把现在的参数和初始窗口存一份。
func netTuneArchiveSave(name string, auto bool) error {
	archives := netTuneArchivesLoad()
	if len(archives) >= netTuneArchiveMax {
		oldestAuto := -1
		for i, archive := range archives {
			if archive.Auto {
				oldestAuto = i
				break
			}
		}
		if oldestAuto < 0 {
			return fmt.Errorf("存档最多 %d 份，先删掉几份再存", netTuneArchiveMax)
		}
		if err := os.Remove(netTuneArchivePath(archives[oldestAuto].Seq)); err != nil {
			return err
		}
	}
	next := 1
	if len(archives) > 0 {
		next = archives[len(archives)-1].Seq + 1
	}
	if next > 9999 {
		return errors.New("存档序号用完了，先删掉几份")
	}
	archive := netTuneArchive{Seq: next, Name: netTuneArchiveName(name, "手动存档"), SavedAt: time.Now().Unix(), Auto: auto, Values: map[string]string{}}
	for _, key := range netTuneBackupKeys() {
		if value, ok, err := netTuneRead(key); err == nil && ok {
			archive.Values[key] = value
		}
	}
	if routes, err := netTuneDefaultRoutes(); err == nil {
		archive.Windows = map[string]netTuneRouteWindow{}
		for _, route := range routes {
			archive.Windows[route.dev] = netTuneRouteWindow{Cwnd: route.cwnd, Rwnd: route.rwnd}
		}
	}
	return netTuneArchiveWrite(archive)
}

func netTuneRunArchive(result *netTuneResult, op *netTuneArchiveOp) {
	if op == nil {
		result.Error = "没有说要对存档做什么"
		return
	}
	if op.Op == "save" {
		if err := netTuneArchiveSave(op.Name, false); err != nil {
			result.Error = err.Error()
		}
		return
	}
	seq, err := netTuneArchiveParseSeq(op.Seq)
	if err != nil {
		result.Error = err.Error()
		return
	}
	if seq == 0 {
		switch op.Op {
		case "restore":
			netTuneRestoreInitWindow(result)
			netTuneRestore(result)
		case "rename", "delete":
			result.Error = "0000 是调优前的原样，不能改名、删除"
		default:
			result.Error = "不认识的存档操作：" + op.Op
		}
		return
	}
	raw, err := os.ReadFile(netTuneArchivePath(seq))
	if err != nil {
		result.Error = "找不到存档 " + netTuneArchiveSeqText(seq)
		return
	}
	var archive netTuneArchive
	if json.Unmarshal(raw, &archive) != nil || archive.Seq != seq {
		result.Error = "存档 " + netTuneArchiveSeqText(seq) + " 坏了"
		return
	}
	switch op.Op {
	case "restore":
		netTuneEnsureBackup(result)
		netTuneArchiveRestore(result, archive)
	case "rename":
		archive.Name = netTuneArchiveName(op.Name, archive.Name)
		archive.Auto = false
		if err := netTuneArchiveWrite(archive); err != nil {
			result.Error = err.Error()
		}
	case "delete":
		if err := os.Remove(netTuneArchivePath(seq)); err != nil {
			result.Error = err.Error()
		}
	default:
		result.Error = "不认识的存档操作：" + op.Op
	}
}

func netTuneArchiveRestore(result *netTuneResult, archive netTuneArchive) {
	keys := make([]string, 0, len(archive.Values))
	for key := range archive.Values {
		if netTuneEditableKey(key) || key == netTuneKeyBuckets {
			keys = append(keys, key)
		}
	}
	// 先改拥塞控制要的模块：存档里是 bbr 时先加载
	if archive.Values[netTuneKeyCC] == "bbr" {
		netTuneLoadBBR()
	}
	sort.Strings(keys)
	for _, key := range keys {
		want := archive.Values[key]
		current, ok, err := netTuneRead(key)
		if err != nil || !ok || current == want {
			continue
		}
		if err := netTuneWrite(key, want); err != nil {
			result.Failed = netTuneAppendFailure(result.Failed, key, err)
			continue
		}
		if after, _, _ := netTuneRead(key); after != want {
			_ = netTuneWrite(key, current)
			result.Failed = netTuneAppendFailure(result.Failed, key, fmt.Errorf("内核没有接受 %s（读回来是 %s），已改回 %s", want, after, current))
			continue
		}
		result.Changed = append(result.Changed, netTuneChange{Key: key, From: current, To: want})
	}
	netTunePersistCurrent(result)
	if cc, _, _ := netTuneRead(netTuneKeyCC); cc == "bbr" {
		if err := os.MkdirAll(filepath.Dir(netTuneBBRModuleConf), 0755); err == nil {
			_ = writeFileAtomicDurable(netTuneBBRModuleConf, []byte("tcp_bbr\n"), 0644)
		}
	} else {
		_ = os.Remove(netTuneBBRModuleConf)
	}
	netTuneArchiveRestoreWindows(result, archive.Windows)
}

// netTuneArchiveRestoreWindows：按存档里每块网卡的窗口改默认路由；存档里没有的网卡不动。
// 初始窗口标记跟着变：存档里有窗口就按最大的那个继续补，没有就不再补（原值照旧记着，「还原」还能回去）。
func netTuneArchiveRestoreWindows(result *netTuneResult, windows map[string]netTuneRouteWindow) {
	if windows == nil {
		return
	}
	routes, err := netTuneDefaultRoutes()
	if err != nil {
		result.Failed = netTuneAppendFailure(result.Failed, netTuneKeyInitcwnd, err)
		return
	}
	state, ok := netTuneLoadRouteState()
	if !ok {
		state = &netTuneRouteState{SavedAt: time.Now().Unix(), Original: map[string]netTuneRouteWindow{}}
	}
	window := 0
	for _, want := range windows {
		window = max(window, want.Cwnd)
	}
	for _, route := range routes {
		want, known := windows[route.dev]
		if !known || (route.cwnd == want.Cwnd && route.rwnd == want.Rwnd) {
			continue
		}
		if _, recorded := state.Original[route.dev]; !recorded {
			state.Original[route.dev] = netTuneRouteWindow{Cwnd: route.cwnd, Rwnd: route.rwnd}
		}
		if err := netTuneReplaceRoute(route, want); err != nil {
			result.Failed = netTuneAppendFailure(result.Failed, netTuneKeyInitcwnd, fmt.Errorf("%s：%v", route.dev, err))
			continue
		}
		result.Changed = append(result.Changed, netTuneChange{Key: netTuneKeyInitcwnd, From: netTuneWindowText(route.cwnd), To: netTuneWindowText(want.Cwnd)})
	}
	state.Window = window
	if err := netTuneSaveRouteState(state); err != nil {
		result.Failed = netTuneAppendFailure(result.Failed, netTuneKeyInitcwnd, err)
	}
}

/* ---------- swap ---------- */

type netTuneSwapOp struct {
	SizeGB int  `json:"sizeGB"`
	Remove bool `json:"remove"`
}

type netTuneSwapMarkerFile struct {
	CreatedAt        int64  `json:"createdAt"`
	SizeGB           int    `json:"sizeGB"`
	File             string `json:"file"`
	SwappinessBefore string `json:"swappinessBefore"`
}

// netTuneActiveSwaps 读 /proc/swaps，返回在用的 swap（文件或分区）。
func netTuneActiveSwaps() []string {
	raw, err := os.ReadFile(netTuneSwapsPath)
	if err != nil {
		return nil
	}
	var active []string
	for i, line := range strings.Split(string(raw), "\n") {
		fields := strings.Fields(line)
		if i == 0 || len(fields) == 0 {
			continue
		}
		active = append(active, fields[0])
	}
	return active
}

func netTuneSwapFstabLine() string { return netTuneSwapFile + " none swap sw 0 0" }

func netTuneRunSwap(result *netTuneResult, op *netTuneSwapOp) {
	if op == nil {
		result.Error = "没有说要对 swap 做什么"
		return
	}
	if op.Remove {
		netTuneSwapRemove(result)
		return
	}
	netTuneSwapCreate(result, op.SizeGB)
}

func netTuneSwapCreate(result *netTuneResult, sizeGB int) {
	if sizeGB < 1 || sizeGB > 20 {
		result.Error = "swap 大小要在 1–20 GB"
		return
	}
	if active := netTuneActiveSwaps(); len(active) > 0 {
		result.Error = "已经有 swap（" + strings.Join(active, "、") + "），不再加"
		return
	}
	if _, err := os.Lstat(netTuneSwapFile); err == nil {
		result.Error = "已经有 " + netTuneSwapFile + "（没启用，可能是别人放的），不碰它；确认没用的话手动删掉再加"
		return
	}
	need := int64(sizeGB)<<30 + 512<<20
	if free, err := netTuneDiskFree(filepath.Dir(netTuneSwapFile)); err == nil && free < need {
		result.Error = fmt.Sprintf("磁盘剩余 %.1f GB，不够建 %d GB 的 swap（还要留 0.5 GB）", float64(free)/(1<<30), sizeGB)
		return
	}
	cleanup := func(step string, out []byte, err error) {
		_, _ = netTuneSwapExec("swapoff", netTuneSwapFile)
		_ = os.Remove(netTuneSwapFile)
		result.Error = fmt.Sprintf("%s 失败：%s", step, strings.TrimSpace(string(out)+" "+err.Error()))
	}
	if out, err := netTuneSwapExec("fallocate", "-l", strconv.Itoa(sizeGB)+"G", netTuneSwapFile); err != nil {
		// 有的文件系统不支持 fallocate 建 swap：退回 dd 一块块写
		_ = os.Remove(netTuneSwapFile)
		if out2, err2 := netTuneSwapExec("dd", "if=/dev/zero", "of="+netTuneSwapFile, "bs=1M", "count="+strconv.Itoa(sizeGB*1024), "status=none"); err2 != nil {
			cleanup("建 swap 文件", append(out, out2...), err2)
			return
		}
	}
	if err := os.Chmod(netTuneSwapFile, 0600); err != nil {
		cleanup("chmod", nil, err)
		return
	}
	if out, err := netTuneSwapExec("mkswap", netTuneSwapFile); err != nil {
		cleanup("mkswap", out, err)
		return
	}
	if out, err := netTuneSwapExec("swapon", netTuneSwapFile); err != nil {
		cleanup("swapon（OpenVZ / LXC 容器通常不让加 swap）", out, err)
		return
	}
	// 记下是面板建的（删的时候只删有这个标记的）
	before, _, _ := netTuneRead("vm.swappiness")
	marker, _ := json.Marshal(netTuneSwapMarkerFile{CreatedAt: time.Now().Unix(), SizeGB: sizeGB, File: netTuneSwapFile, SwappinessBefore: before})
	if err := os.MkdirAll(filepath.Dir(netTuneSwapMarker), 0700); err == nil {
		if err := writeFileAtomicDurable(netTuneSwapMarker, marker, 0600); err != nil {
			result.Failed = netTuneAppendFailure(result.Failed, "swap", fmt.Errorf("标记没写上，以后面板删不了它：%v", err))
		}
	}
	if err := netTuneFstabEnsure(); err != nil {
		result.Failed = netTuneAppendFailure(result.Failed, "swap", fmt.Errorf("没写进 /etc/fstab，重启后 swap 不会自动启用：%v", err))
	}
	result.Changed = append(result.Changed, netTuneChange{Key: "swap", From: "0", To: strconv.Itoa(sizeGB) + " GB"})
	// 只在内存真的紧张时才换出，平时不把转发进程的热数据换出去
	if before != "" && before != netTuneSwappiness {
		if err := netTuneWrite("vm.swappiness", netTuneSwappiness); err != nil {
			result.Failed = netTuneAppendFailure(result.Failed, "vm.swappiness", err)
		} else {
			result.Changed = append(result.Changed, netTuneChange{Key: "vm.swappiness", From: before, To: netTuneSwappiness})
		}
	}
	if err := os.MkdirAll(filepath.Dir(netTuneSwapConf), 0755); err == nil {
		_ = writeFileAtomicDurable(netTuneSwapConf, []byte("# NEX 网络调优加 swap 时写入：只在内存真的紧张时才换出\nvm.swappiness = "+netTuneSwappiness+"\n"), 0644)
	}
}

func netTuneFstabEnsure() error {
	raw, err := os.ReadFile(netTuneFstabPath)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if fields := strings.Fields(line); len(fields) > 0 && fields[0] == netTuneSwapFile {
			return nil
		}
	}
	text := string(raw)
	if text != "" && !strings.HasSuffix(text, "\n") {
		text += "\n"
	}
	info, statErr := os.Stat(netTuneFstabPath)
	mode := os.FileMode(0644)
	if statErr == nil {
		mode = info.Mode().Perm()
	}
	return writeFileAtomicDurable(netTuneFstabPath, []byte(text+netTuneSwapFstabLine()+"\n"), mode)
}

func netTuneSwapRemove(result *netTuneResult) {
	raw, err := os.ReadFile(netTuneSwapMarker)
	if err != nil {
		result.Error = "这台机器的 swap 不是面板建的，不动"
		return
	}
	var marker netTuneSwapMarkerFile
	if json.Unmarshal(raw, &marker) != nil || marker.File != netTuneSwapFile {
		result.Error = "swap 标记坏了，不动；需要的话手动 swapoff 后删除 " + netTuneSwapFile
		return
	}
	for _, active := range netTuneActiveSwaps() {
		if active == netTuneSwapFile {
			if out, err := netTuneSwapExec("swapoff", netTuneSwapFile); err != nil {
				result.Error = "swapoff 失败（内存可能不够把 swap 里的数据换回来）：" + strings.TrimSpace(string(out)+" "+err.Error())
				return
			}
		}
	}
	// fstab 只删指向这个文件的 swap 行，别的原样
	if fstab, err := os.ReadFile(netTuneFstabPath); err == nil {
		lines := strings.SplitAfter(string(fstab), "\n")
		kept := make([]string, 0, len(lines))
		for _, line := range lines {
			fields := strings.Fields(line)
			if len(fields) >= 3 && fields[0] == netTuneSwapFile && fields[2] == "swap" {
				continue
			}
			kept = append(kept, line)
		}
		if info, err := os.Stat(netTuneFstabPath); err == nil {
			if err := writeFileAtomicDurable(netTuneFstabPath, []byte(strings.Join(kept, "")), info.Mode().Perm()); err != nil {
				result.Failed = netTuneAppendFailure(result.Failed, "swap", fmt.Errorf("/etc/fstab 里那一行没删掉：%v", err))
			}
		}
	}
	if err := os.Remove(netTuneSwapFile); err != nil && !errors.Is(err, os.ErrNotExist) {
		result.Failed = netTuneAppendFailure(result.Failed, "swap", err)
	}
	result.Changed = append(result.Changed, netTuneChange{Key: "swap", From: strconv.Itoa(marker.SizeGB) + " GB", To: "0"})
	if marker.SwappinessBefore != "" {
		if current, ok, _ := netTuneRead("vm.swappiness"); ok && current != marker.SwappinessBefore {
			if err := netTuneWrite("vm.swappiness", marker.SwappinessBefore); err == nil {
				result.Changed = append(result.Changed, netTuneChange{Key: "vm.swappiness", From: current, To: marker.SwappinessBefore})
			}
		}
	}
	_ = os.Remove(netTuneSwapConf)
	_ = os.Remove(netTuneSwapMarker)
}

// netTuneReportSwap：swap 总量（字节，来自 /proc/meminfo）、是不是面板建的。
func netTuneReportSwap(result *netTuneResult) {
	raw, err := os.ReadFile(netTuneMemInfoPath)
	if err == nil {
		for _, line := range strings.Split(string(raw), "\n") {
			fields := strings.Fields(line)
			if len(fields) >= 2 && fields[0] == "SwapTotal:" {
				if kb, err := strconv.ParseInt(fields[1], 10, 64); err == nil {
					result.Values["swap.total"] = strconv.FormatInt(kb*1024, 10)
				}
			}
		}
	}
	if _, err := os.Stat(netTuneSwapMarker); err == nil {
		result.Values["swap.owned"] = "1"
	} else {
		result.Values["swap.owned"] = "0"
	}
}
