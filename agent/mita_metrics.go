package main

// mita 的按用户计数，以及「这份计数属于哪一个 mita 进程」。
//
// mita get metrics（经 NEX 自己的 UDS）输出一段 JSON，里面 users 段按用户名给累计字节：
//   {"users": {"nexab12…": {"UploadBytes": 123, "DownloadBytes": 456, …}, …}, …}
// 这是 mita 进程启动以来的累计值，进程一重启就从 0 数。面板按「进程 + 用户名」记基线算增量
// （server/mitaTraffic.ts），所以每次上报都带上进程身份：进程号 + 进程启动时刻（/proc/<pid>/stat
// 第 22 项），进程号被重用也认得出是另一个进程。

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

const mitaMetricsTimeout = 5 * time.Second

func mitaMetricNumber(raw json.RawMessage) uint64 {
	var number json.Number
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&number); err != nil {
		// 个别版本把数字写成字符串
		var text string
		if json.Unmarshal(raw, &text) != nil {
			return 0
		}
		number = json.Number(strings.TrimSpace(text))
	}
	value, err := strconv.ParseUint(number.String(), 10, 64)
	if err != nil {
		if f, ferr := number.Float64(); ferr == nil && f > 0 {
			return uint64(f)
		}
		return 0
	}
	return value
}

// parseMitaUserMetrics 从 get metrics 的输出里取按用户的累计上下行。输出前后可能夹着日志行，
// 取第一个 { 到最后一个 } 之间那段。没有 users 段（还没人连过）是正常的，返回空表。
func parseMitaUserMetrics(raw []byte) ([]mitaUserCounter, error) {
	start := bytes.IndexByte(raw, '{')
	end := bytes.LastIndexByte(raw, '}')
	if start < 0 || end < start {
		return nil, fmt.Errorf("mita metrics 里没有 JSON")
	}
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(raw[start:end+1], &envelope); err != nil {
		return nil, err
	}
	counters := []mitaUserCounter{}
	usersRaw, ok := envelope["users"]
	if !ok {
		return counters, nil
	}
	var users map[string]map[string]json.RawMessage
	if err := json.Unmarshal(usersRaw, &users); err != nil {
		return nil, fmt.Errorf("mita metrics 的 users 段看不懂: %w", err)
	}
	for name, metrics := range users {
		name = strings.TrimSpace(name)
		if !mitaUsernamePattern.MatchString(name) {
			continue
		}
		counters = append(counters, mitaUserCounter{
			Name: name,
			Up:   mitaMetricNumber(metrics["UploadBytes"]),
			Down: mitaMetricNumber(metrics["DownloadBytes"]),
		})
	}
	sort.Slice(counters, func(i, j int) bool { return counters[i].Name < counters[j].Name })
	return counters, nil
}

// mitaProcessInstance 在 procRoot（正常是 /proc）下找可执行文件是 binary 的进程，返回「pid:启动时刻」。
// 换二进制之后正在跑的那个进程 exe 显示成「… (deleted)」，同样认。找不到返回空串。
func mitaProcessInstance(procRoot string, binary string) string {
	entries, err := os.ReadDir(procRoot)
	if err != nil {
		return ""
	}
	best := ""
	bestPID := 0
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil || pid <= 0 {
			continue
		}
		exe, err := os.Readlink(filepath.Join(procRoot, entry.Name(), "exe"))
		if err != nil {
			continue
		}
		if strings.TrimSuffix(exe, " (deleted)") != binary {
			continue
		}
		stat, err := os.ReadFile(filepath.Join(procRoot, entry.Name(), "stat"))
		if err != nil {
			continue
		}
		startTime := procStatStartTime(string(stat))
		if startTime == "" {
			continue
		}
		// 同时有两个（重启交接的一瞬间）取进程号小的那个，结果稳定。
		if best == "" || pid < bestPID {
			best = strconv.Itoa(pid) + ":" + startTime
			bestPID = pid
		}
	}
	return best
}

// procStatStartTime 取 /proc/<pid>/stat 的第 22 项（starttime）。第 2 项是括号里的进程名，
// 里面可能有空格，所以从最后一个右括号往后数。
func procStatStartTime(stat string) string {
	paren := strings.LastIndexByte(stat, ')')
	if paren < 0 {
		return ""
	}
	fields := strings.Fields(stat[paren+1:])
	// 括号后面第一项是第 3 项（state），第 22 项是它往后第 19 个。
	if len(fields) < 20 {
		return ""
	}
	if _, err := strconv.ParseUint(fields[19], 10, 64); err != nil {
		return ""
	}
	return fields[19]
}

func queryMitaMetrics() ([]byte, error) {
	out, err := commandCombinedOutputWithTimeout(
		mitaMetricsTimeout,
		"env",
		"MITA_UDS_PATH="+mitaSocketPath,
		"MITA_INSECURE_UDS=1",
		mitaBinaryPath,
		"get",
		"metrics",
	)
	if err != nil {
		message := strings.TrimSpace(string(out))
		if message == "" {
			return nil, err
		}
		return nil, fmt.Errorf("%w: %s", err, compactLogOutput(message))
	}
	return out, nil
}
