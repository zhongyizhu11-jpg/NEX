package main

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

func netTuneArchiveSeqs(result netTuneResult) []string {
	seqs := make([]string, 0, len(result.Archives))
	for _, archive := range result.Archives {
		seqs = append(seqs, archive.Seq+":"+archive.Name)
	}
	return seqs
}

// 调优存档（和 tcpfit 一样）：0000 是调优前原样（不能改名、删除，恢复它就是「还原」）；
// 一键调优后自动存一份；手动存当前、按存档恢复（参数、初始窗口一起）、改名、删除。
func TestNetTuneArchivesSaveRestoreRenameDelete(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("只在 Linux 上跑")
	}
	netTuneFakeProc(t, netTuneDistroDefaults())
	routes := netTuneFakeIP(t, "default via 10.0.0.1 dev eth0 proto dhcp metric 100")

	if check := netTuneRunMode("check", nil); len(check.Archives) != 0 {
		t.Fatalf("没调过：没有存档，连 0000 都没有：%+v", check.Archives)
	}
	applied := netTuneRunMode("apply", nil)
	if got := netTuneArchiveSeqs(applied); strings.Join(got, ",") != "0000:调优前,0001:一键调优" {
		t.Fatalf("一键调优后应该有 0000（调优前）和自动存的 0001：%v", got)
	}

	// 手动改一项再存一份
	netTuneRunMode("set", map[string]string{"net.core.somaxconn": "16384"})
	saved := netTuneRunWith("archive", netTuneRunOptions{Archive: &netTuneArchiveOp{Op: "save", Name: "  晚高峰\n配置  "}})
	if saved.Error != "" {
		t.Fatalf("存档失败：%+v", saved)
	}
	if got := netTuneArchiveSeqs(saved); strings.Join(got, ",") != "0000:调优前,0001:一键调优,0002:晚高峰 配置" {
		t.Fatalf("存档列表：%v", got)
	}

	// 改乱：恢复 0001 回到一键调优后的样子（参数和初始窗口都回去）
	netTuneRunMode("set", map[string]string{"net.core.somaxconn": "1024", "net.ipv4.tcp_congestion_control": "cubic"})
	routes.set(0, "default via 10.0.0.1 dev eth0 proto dhcp metric 100 initcwnd 10")
	restored := netTuneRunWith("archive", netTuneRunOptions{Archive: &netTuneArchiveOp{Op: "restore", Seq: "1"}})
	if restored.Error != "" || len(restored.Failed) != 0 {
		t.Fatalf("恢复 0001 失败：%+v", restored)
	}
	for key, want := range map[string]string{"net.core.somaxconn": "8192", "net.ipv4.tcp_congestion_control": "bbr"} {
		if value, _, _ := netTuneRead(key); value != want {
			t.Errorf("恢复 0001 后 %s = %s，应该是 %s", key, value, want)
		}
	}
	if !strings.HasSuffix(routes.line(0), "initcwnd 32 initrwnd 32") {
		t.Errorf("恢复存档要把初始窗口也恢复：%s", routes.line(0))
	}
	conf, _ := os.ReadFile(netTuneConfPath)
	if !strings.Contains(string(conf), "net.core.somaxconn = 8192\n") {
		t.Errorf("恢复的值要写进 sysctl.d：\n%s", conf)
	}

	// 改名、删除；0000 不能动
	if renamed := netTuneRunWith("archive", netTuneRunOptions{Archive: &netTuneArchiveOp{Op: "rename", Seq: "0002", Name: "备用"}}); renamed.Error != "" {
		t.Fatalf("改名失败：%+v", renamed)
	}
	if zero := netTuneRunWith("archive", netTuneRunOptions{Archive: &netTuneArchiveOp{Op: "rename", Seq: "0000", Name: "x"}}); !strings.Contains(zero.Error, "0000") {
		t.Errorf("0000 不能改名：%+v", zero)
	}
	if zero := netTuneRunWith("archive", netTuneRunOptions{Archive: &netTuneArchiveOp{Op: "delete", Seq: "0"}}); !strings.Contains(zero.Error, "0000") {
		t.Errorf("0000 不能删：%+v", zero)
	}
	deleted := netTuneRunWith("archive", netTuneRunOptions{Archive: &netTuneArchiveOp{Op: "delete", Seq: "0001"}})
	if got := netTuneArchiveSeqs(deleted); strings.Join(got, ",") != "0000:调优前,0002:备用" {
		t.Fatalf("删掉 0001 后：%v", got)
	}
	if missing := netTuneRunWith("archive", netTuneRunOptions{Archive: &netTuneArchiveOp{Op: "restore", Seq: "0009"}}); !strings.Contains(missing.Error, "找不到") {
		t.Errorf("恢复不存在的存档要说清楚：%+v", missing)
	}

	// 恢复 0000 = 还原：回到调优前，初始窗口摘掉
	zero := netTuneRunWith("archive", netTuneRunOptions{Archive: &netTuneArchiveOp{Op: "restore", Seq: "0000"}})
	if zero.Error != "" {
		t.Fatalf("恢复 0000 失败：%+v", zero)
	}
	if value, _, _ := netTuneRead("net.ipv4.tcp_congestion_control"); value != "cubic" {
		t.Errorf("恢复 0000 后拥塞控制应该回到 cubic：%s", value)
	}
	if routes.line(0) != "default via 10.0.0.1 dev eth0 proto dhcp metric 100" {
		t.Errorf("恢复 0000 后初始窗口应该摘掉：%s", routes.line(0))
	}
}

// 存档最多 20 份：满了先删最老的自动存档；全是手动存的就拒绝。
func TestNetTuneArchiveLimit(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("只在 Linux 上跑")
	}
	netTuneFakeProc(t, netTuneDistroDefaults())
	netTuneRunMode("apply", nil) // 0001 自动
	for i := 2; i <= netTuneArchiveMax; i++ {
		if saved := netTuneRunWith("archive", netTuneRunOptions{Archive: &netTuneArchiveOp{Op: "save", Name: "手动" + strconv.Itoa(i)}}); saved.Error != "" {
			t.Fatalf("第 %d 份存不下：%+v", i, saved)
		}
	}
	full := netTuneRunWith("archive", netTuneRunOptions{Archive: &netTuneArchiveOp{Op: "save", Name: "再来一份"}})
	if full.Error != "" {
		t.Fatalf("满了应该删掉最老的自动存档腾地方：%+v", full)
	}
	for _, archive := range full.Archives {
		if archive.Seq == "0001" {
			t.Fatalf("最老的自动存档 0001 应该被删掉：%v", netTuneArchiveSeqs(full))
		}
	}
	if refused := netTuneRunWith("archive", netTuneRunOptions{Archive: &netTuneArchiveOp{Op: "save", Name: "多的"}}); !strings.Contains(refused.Error, "最多") {
		t.Errorf("全是手动存档时应该拒绝：%+v", refused)
	}
}

// 假的 swap 环境：/proc/swaps、fstab、swapfile 都在临时目录里，fallocate / mkswap / swapon / swapoff 换成假的。
type netTuneFakeSwapEnv struct {
	active  bool
	calls   []string
	failOn  string
	freeMiB int64
}

func netTuneFakeSwap(t *testing.T) *netTuneFakeSwapEnv {
	t.Helper()
	root := t.TempDir()
	env := &netTuneFakeSwapEnv{freeMiB: 50 * 1024}
	oldFile, oldFstab, oldSwaps, oldMarker, oldConf, oldExec, oldFree := netTuneSwapFile, netTuneFstabPath, netTuneSwapsPath, netTuneSwapMarker, netTuneSwapConf, netTuneSwapExec, netTuneDiskFree
	netTuneSwapFile = filepath.Join(root, "swapfile")
	netTuneFstabPath = filepath.Join(root, "fstab")
	netTuneSwapsPath = filepath.Join(root, "swaps")
	netTuneSwapMarker = filepath.Join(root, "forwardx-nettune", "swapfile.json")
	netTuneSwapConf = filepath.Join(root, "sysctl.d", "99-forwardx-swap.conf")
	_ = os.WriteFile(netTuneFstabPath, []byte("UUID=abc / ext4 defaults 0 1\n"), 0644)
	writeSwaps := func() {
		text := "Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n"
		if env.active {
			text += netTuneSwapFile + "\tfile\t\t2097148\t\t0\t\t-2\n"
		}
		_ = os.WriteFile(netTuneSwapsPath, []byte(text), 0644)
	}
	writeSwaps()
	netTuneSwapExec = func(name string, args ...string) ([]byte, error) {
		env.calls = append(env.calls, name+" "+strings.Join(args, " "))
		if env.failOn == name {
			return []byte(name + ": Operation not permitted"), errors.New("exit status 1")
		}
		switch name {
		case "fallocate":
			size, _ := strconv.Atoi(strings.TrimSuffix(args[1], "G"))
			if err := os.WriteFile(args[2], make([]byte, size), 0644); err != nil {
				return nil, err
			}
		case "swapon":
			env.active = true
		case "swapoff":
			env.active = false
		}
		writeSwaps()
		return nil, nil
	}
	netTuneDiskFree = func(string) (int64, error) { return env.freeMiB << 20, nil }
	t.Cleanup(func() {
		netTuneSwapFile, netTuneFstabPath, netTuneSwapsPath, netTuneSwapMarker, netTuneSwapConf, netTuneSwapExec, netTuneDiskFree = oldFile, oldFstab, oldSwaps, oldMarker, oldConf, oldExec, oldFree
	})
	return env
}

// 加 swap（和 tcpfit 的 harden 一样）：建 /swapfile、写 fstab、swappiness 调到 10；删的时候只删面板建的，
// swappiness 回到原值。已有 swap、/swapfile 已经在、磁盘不够、swapon 不让（OpenVZ / LXC）都不留半截。
func TestNetTuneSwapCreateAndRemove(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("只在 Linux 上跑")
	}
	values := netTuneDistroDefaults()
	values["vm.swappiness"] = "60"
	netTuneFakeProc(t, values)
	env := netTuneFakeSwap(t)

	created := netTuneRunWith("swap", netTuneRunOptions{Swap: &netTuneSwapOp{SizeGB: 2}})
	if created.Error != "" || len(created.Failed) != 0 {
		t.Fatalf("加 swap 失败：%+v", created)
	}
	if !env.active || strings.Join(env.calls, ";") != "fallocate -l 2G "+netTuneSwapFile+";mkswap "+netTuneSwapFile+";swapon "+netTuneSwapFile {
		t.Errorf("建 swap 的步骤：%v", env.calls)
	}
	if info, err := os.Stat(netTuneSwapFile); err != nil || info.Mode().Perm() != 0600 {
		t.Errorf("swapfile 权限要 600：%v %v", info, err)
	}
	fstab, _ := os.ReadFile(netTuneFstabPath)
	if !strings.Contains(string(fstab), netTuneSwapFile+" none swap sw 0 0\n") || !strings.HasPrefix(string(fstab), "UUID=abc") {
		t.Errorf("fstab 要加一行、原来的不动：\n%s", fstab)
	}
	if value, _, _ := netTuneRead("vm.swappiness"); value != "10" {
		t.Errorf("swappiness 应该是 10：%s", value)
	}
	if created.Values["swap.owned"] != "1" {
		t.Errorf("要报 swap 是面板建的：%+v", created.Values)
	}

	if again := netTuneRunWith("swap", netTuneRunOptions{Swap: &netTuneSwapOp{SizeGB: 2}}); !strings.Contains(again.Error, "已经有 swap") {
		t.Errorf("已有 swap 时不再加：%+v", again)
	}

	removed := netTuneRunWith("swap", netTuneRunOptions{Swap: &netTuneSwapOp{Remove: true}})
	if removed.Error != "" {
		t.Fatalf("删 swap 失败：%+v", removed)
	}
	if env.active {
		t.Error("要先 swapoff")
	}
	if _, err := os.Stat(netTuneSwapFile); !os.IsNotExist(err) {
		t.Errorf("swapfile 要删掉：%v", err)
	}
	fstab, _ = os.ReadFile(netTuneFstabPath)
	if string(fstab) != "UUID=abc / ext4 defaults 0 1\n" {
		t.Errorf("fstab 只删那一行：\n%s", fstab)
	}
	if value, _, _ := netTuneRead("vm.swappiness"); value != "60" {
		t.Errorf("swappiness 回到原来的 60：%s", value)
	}
	if notOurs := netTuneRunWith("swap", netTuneRunOptions{Swap: &netTuneSwapOp{Remove: true}}); !strings.Contains(notOurs.Error, "不是面板建的") {
		t.Errorf("没有面板建的 swap 时不删：%+v", notOurs)
	}

	// 磁盘不够：什么都不做
	env.freeMiB = 1024
	if low := netTuneRunWith("swap", netTuneRunOptions{Swap: &netTuneSwapOp{SizeGB: 2}}); !strings.Contains(low.Error, "磁盘") {
		t.Errorf("磁盘不够要拒绝：%+v", low)
	}
	env.freeMiB = 50 * 1024
	// swapon 不让（OpenVZ / LXC）：文件删掉，fstab 不动
	env.failOn = "swapon"
	failed := netTuneRunWith("swap", netTuneRunOptions{Swap: &netTuneSwapOp{SizeGB: 1}})
	if !strings.Contains(failed.Error, "swapon") {
		t.Errorf("swapon 失败要说清楚：%+v", failed)
	}
	if _, err := os.Stat(netTuneSwapFile); !os.IsNotExist(err) {
		t.Errorf("失败了不留半截 swapfile：%v", err)
	}
	fstab, _ = os.ReadFile(netTuneFstabPath)
	if strings.Contains(string(fstab), "swap") {
		t.Errorf("失败了 fstab 不动：\n%s", fstab)
	}
	// 已经有一个没启用的 /swapfile（可能是别人的）：不碰
	env.failOn = ""
	_ = os.WriteFile(netTuneSwapFile, []byte("x"), 0600)
	if exists := netTuneRunWith("swap", netTuneRunOptions{Swap: &netTuneSwapOp{SizeGB: 1}}); !strings.Contains(exists.Error, "已经有") {
		t.Errorf("/swapfile 已存在时不碰：%+v", exists)
	}
	if bad := netTuneRunWith("swap", netTuneRunOptions{Swap: &netTuneSwapOp{SizeGB: 64}}); !strings.Contains(bad.Error, "1–20") {
		t.Errorf("大小要在 1–20 GB：%+v", bad)
	}
}
