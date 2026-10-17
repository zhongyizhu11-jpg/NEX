package main

/*
主机健康计数（面板 2.3.451 起的 OOM / 进程崩溃告警用），随心跳报上去：

  - oomKillCount：/proc/vmstat 里的 oom_kill，开机以来内核 OOM killer 杀掉进程的次数（Linux 4.13+）。
    读不到（老内核、容器里）就不报，面板按「不知道」处理。
  - serviceRestarts：forwardx-* 这些 systemd 服务被 Restart= 自动拉起来的次数（NRestarts）。
    进程崩了 systemd 才会自动重启它；手动 systemctl restart 会把计数清零，面板看到变小就当基线重置。
    只报大于 0 的那些，最多 serviceRestartsMaxUnits 个，机器上几百条 realm 规则时心跳不会变大。

systemctl show 一分钟最多跑一次，结果缓存起来；心跳几秒一次，不能每次都起子进程。
*/

import (
	"bufio"
	"context"
	"io"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	serviceRestartsRefreshInterval = time.Minute
	serviceRestartsCommandTimeout  = 5 * time.Second
	serviceRestartsMaxUnits        = 256
)

// readOOMKillCount 读 /proc/vmstat 的 oom_kill；第二个返回值表示读没读到。
func readOOMKillCount() (int64, bool) {
	file, err := os.Open("/proc/vmstat")
	if err != nil {
		return 0, false
	}
	defer file.Close()
	return parseOOMKillCount(file)
}

func parseOOMKillCount(reader io.Reader) (int64, bool) {
	scanner := bufio.NewScanner(reader)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) != 2 || fields[0] != "oom_kill" {
			continue
		}
		value, err := strconv.ParseInt(fields[1], 10, 64)
		if err != nil || value < 0 {
			return 0, false
		}
		return value, true
	}
	return 0, false
}

// parseSystemctlRestarts 解析 `systemctl show <units> -p Id -p NRestarts` 的输出：
// 每个服务一段 Id=… / NRestarts=…，段之间空一行。只留 forwardx- 开头、计数大于 0 的。
func parseSystemctlRestarts(output string) map[string]int64 {
	result := map[string]int64{}
	id := ""
	restarts := int64(-1)
	flush := func() {
		if id != "" && restarts > 0 && strings.HasPrefix(id, "forwardx-") {
			result[id] = restarts
		}
		id = ""
		restarts = -1
	}
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			flush()
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		switch key {
		case "Id":
			if id != "" {
				flush()
			}
			id = strings.TrimSpace(value)
		case "NRestarts":
			if n, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64); err == nil {
				restarts = n
			}
		}
	}
	flush()
	if len(result) <= serviceRestartsMaxUnits {
		return result
	}
	// 超过上限：留计数最大的那些（最可能是在反复崩的）。
	type entry struct {
		id    string
		count int64
	}
	entries := make([]entry, 0, len(result))
	for unit, count := range result {
		entries = append(entries, entry{unit, count})
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].count != entries[j].count {
			return entries[i].count > entries[j].count
		}
		return entries[i].id < entries[j].id
	})
	trimmed := make(map[string]int64, serviceRestartsMaxUnits)
	for _, item := range entries[:serviceRestartsMaxUnits] {
		trimmed[item.id] = item.count
	}
	return trimmed
}

type serviceRestartsCache struct {
	mu        sync.Mutex
	checkedAt time.Time
	value     map[string]int64
	ok        bool
	running   bool
}

var hostServiceRestarts serviceRestartsCache

// serviceRestartsSnapshot 返回最近一次读到的计数；过期了就在后台刷新（不阻塞心跳）。
func serviceRestartsSnapshot() (map[string]int64, bool) {
	c := &hostServiceRestarts
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.running && time.Since(c.checkedAt) >= serviceRestartsRefreshInterval {
		c.running = true
		go c.refresh()
	}
	if !c.ok {
		return nil, false
	}
	copied := make(map[string]int64, len(c.value))
	for unit, count := range c.value {
		copied[unit] = count
	}
	return copied, true
}

func (c *serviceRestartsCache) refresh() {
	ctx, cancel := context.WithTimeout(context.Background(), serviceRestartsCommandTimeout)
	defer cancel()
	output, err := exec.CommandContext(ctx, "systemctl", "show", "forwardx-*", "-p", "Id", "-p", "NRestarts").Output()
	c.mu.Lock()
	defer c.mu.Unlock()
	c.running = false
	c.checkedAt = time.Now()
	if err != nil {
		// 没有 systemd、systemctl 太老不认通配：不报，面板不做崩溃判定。
		c.ok = false
		c.value = nil
		return
	}
	c.value = parseSystemctlRestarts(string(output))
	c.ok = true
}

// addHostHealthCounters 把这两项加到心跳里；读不到的不加。
func addHostHealthCounters(payload map[string]any) {
	if count, ok := readOOMKillCount(); ok {
		payload["oomKillCount"] = count
	}
	if restarts, ok := serviceRestartsSnapshot(); ok {
		payload["serviceRestarts"] = restarts
	}
}
