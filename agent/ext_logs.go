package main

/*
扩展模块 "logs"（面板 2.3.449 起）：面板主机详情里看这台机器的实时日志，不用 SSH。

面板那头见 server/ops/hostLogsAgent.ts。有人开着日志窗口时，面板每轮下发
{"requests":[{"id","source","cursor","lines"}]}；Agent 在 Apply 里按来源读出 cursor 之后的新行，
立刻再跑一轮扩展通道把结果报上去（不等下一个 interval），面板拼起来给浏览器。

只读、白名单：来源只能是下面这几个固定名字，或者 Agent 日志目录里 fxp-*.log 的某一个文件名，
不接受任意路径或命令。每行截到 2000 字符，密码 / token 之类按支持包同一套规则打码。

游标：
  - 文件来源是字节偏移（十进制）。文件被日志维护截短（比游标小）时从新的末尾往回读一段。
  - journald 来源是 journalctl 的 cursor（--show-cursor / --after-cursor）。
  - 空游标表示「先给最近 N 行」。
*/

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	logsMaxLines        = 500
	logsDefaultLines    = 200
	logsMaxLineLength   = 2000
	logsMaxRequests     = 4
	logsInitialTailSize = 256 * 1024
	logsMaxReadBytes    = 512 * 1024
	logsCommandTimeout  = 8 * time.Second
)

var logsFXPFilePattern = regexp.MustCompile(`^fxp-[A-Za-z0-9._-]{1,120}\.log$`)

// journald 来源：名字 → journalctl 参数。
var logsJournalSources = map[string][]string{
	"runtime": {"-u", "forwardx-runtime"},
	"tunnel":  {"-u", "forwardx-tunnel-runtime"},
	"nginx":   {"-u", "forwardx-nginx"},
	"kernel":  {"-k"},
}

type logsRequest struct {
	ID     string `json:"id"`
	Source string `json:"source"`
	Cursor string `json:"cursor"`
	Lines  int    `json:"lines"`
}

type logsDirective struct {
	Requests []logsRequest `json:"requests"`
}

type logsResult struct {
	ID        string   `json:"id"`
	Source    string   `json:"source"`
	Cursor    string   `json:"cursor"`
	Lines     []string `json:"lines"`
	Reset     bool     `json:"reset,omitempty"`
	Truncated bool     `json:"truncated,omitempty"`
	Error     string   `json:"error,omitempty"`
	At        int64    `json:"at"`
}

type logsReport struct {
	Sources []string     `json:"sources"`
	Results []logsResult `json:"results,omitempty"`
}

type logsExtModule struct {
	mu      sync.Mutex
	pending []logsResult
	// 上一次上报来源列表的时间：列表不常变，一分钟报一次就够。
	sourcesReportedAt time.Time
}

func (m *logsExtModule) Name() string { return "logs" }

func (m *logsExtModule) Report(cfg Config) any {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.pending) == 0 && time.Since(m.sourcesReportedAt) < time.Minute {
		return nil
	}
	report := logsReport{Sources: availableLogSources(), Results: m.pending}
	m.pending = nil
	m.sourcesReportedAt = time.Now()
	return report
}

func (m *logsExtModule) Apply(cfg Config, raw json.RawMessage) {
	var directive logsDirective
	if err := json.Unmarshal(raw, &directive); err != nil || len(directive.Requests) == 0 {
		return
	}
	requests := directive.Requests
	if len(requests) > logsMaxRequests {
		requests = requests[:logsMaxRequests]
	}
	results := make([]logsResult, 0, len(requests))
	for _, request := range requests {
		if !opsValidID(request.ID) {
			continue
		}
		results = append(results, readLogSource(request))
	}
	if len(results) == 0 {
		return
	}
	m.mu.Lock()
	m.pending = append(m.pending, results...)
	if len(m.pending) > logsMaxRequests*4 {
		m.pending = m.pending[len(m.pending)-logsMaxRequests*4:]
	}
	m.mu.Unlock()
	// 结果马上报回去，不等下一个 interval。
	wakeAgentExt()
}

// availableLogSources：固定来源 + 现有的 FXP 日志文件。
func availableLogSources() []string {
	sources := []string{"agent"}
	if _, err := exec.LookPath("journalctl"); err == nil {
		for _, name := range []string{"runtime", "tunnel", "nginx", "kernel"} {
			sources = append(sources, name)
		}
	}
	entries, err := os.ReadDir(agentLogDir)
	if err == nil {
		files := []string{}
		for _, entry := range entries {
			if !entry.IsDir() && logsFXPFilePattern.MatchString(entry.Name()) {
				files = append(files, "fxp:"+entry.Name())
			}
		}
		sort.Strings(files)
		if len(files) > 64 {
			files = files[:64]
		}
		sources = append(sources, files...)
	}
	return sources
}

func clampLogLines(n int) int {
	if n <= 0 {
		return logsDefaultLines
	}
	if n > logsMaxLines {
		return logsMaxLines
	}
	return n
}

func readLogSource(request logsRequest) logsResult {
	result := logsResult{ID: request.ID, Source: request.Source, Lines: []string{}, At: time.Now().Unix()}
	lines := clampLogLines(request.Lines)
	switch {
	case request.Source == "agent":
		readLogFile(agentLogPath, request.Cursor, lines, &result)
	case strings.HasPrefix(request.Source, "fxp:"):
		name := strings.TrimPrefix(request.Source, "fxp:")
		if !logsFXPFilePattern.MatchString(name) || filepath.Base(name) != name {
			result.Error = "unknown log source"
			return result
		}
		readLogFile(filepath.Join(agentLogDir, name), request.Cursor, lines, &result)
	default:
		args, ok := logsJournalSources[request.Source]
		if !ok {
			result.Error = "unknown log source"
			return result
		}
		readJournal(args, request.Cursor, lines, &result)
	}
	for i, line := range result.Lines {
		result.Lines[i] = cleanLogLine(line)
	}
	return result
}

func cleanLogLine(line string) string {
	line = strings.TrimRight(line, "\r")
	if !utf8.ValidString(line) {
		line = strings.ToValidUTF8(line, "�")
	}
	if len(line) > logsMaxLineLength {
		cut := logsMaxLineLength
		for cut > 0 && !utf8.RuneStart(line[cut]) {
			cut--
		}
		line = line[:cut] + "…"
	}
	return redactSupportOutput(line)
}

// readLogFile 读文件里游标（字节偏移）之后的完整行。
func readLogFile(path, cursor string, maxLines int, result *logsResult) {
	file, err := os.Open(path)
	if err != nil {
		result.Error = "log file not found"
		result.Cursor = cursor
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		result.Error = err.Error()
		return
	}
	size := info.Size()
	offset, parseErr := strconv.ParseInt(cursor, 10, 64)
	initial := cursor == "" || parseErr != nil || offset < 0
	if !initial && offset > size {
		// 日志被截短了：游标作废，当作第一次读。
		initial = true
		result.Reset = true
	}
	start := offset
	if initial {
		start = size - logsInitialTailSize
		if start < 0 {
			start = 0
		}
	}
	end := size
	if end-start > logsMaxReadBytes {
		start = end - logsMaxReadBytes
		result.Truncated = !initial
	}
	if _, err := file.Seek(start, io.SeekStart); err != nil {
		result.Error = err.Error()
		return
	}
	data := make([]byte, end-start)
	n, _ := io.ReadFull(file, data)
	data = data[:n]
	skipFirst := initial && start > 0
	// 只交完整的行：最后一个换行之后的半行留到下次。
	last := strings.LastIndexByte(string(data), '\n')
	if last < 0 {
		result.Cursor = strconv.FormatInt(start, 10)
		return
	}
	complete := string(data[:last])
	result.Cursor = strconv.FormatInt(start+int64(last)+1, 10)
	lines := strings.Split(complete, "\n")
	if skipFirst && len(lines) > 0 {
		lines = lines[1:] // 从中间开始读，第一行多半是半行
	}
	if len(lines) > maxLines {
		if !initial {
			result.Truncated = true
		}
		lines = lines[len(lines)-maxLines:]
	}
	result.Lines = lines
}

// readJournal 用 journalctl 读游标之后的新行（短 ISO 时间格式）。
func readJournal(args []string, cursor string, maxLines int, result *logsResult) {
	if _, err := exec.LookPath("journalctl"); err != nil {
		result.Error = "journalctl not available"
		result.Cursor = cursor
		return
	}
	full := append([]string{}, args...)
	full = append(full, "--no-pager", "-o", "short-iso", "--show-cursor", "-n", strconv.Itoa(maxLines))
	if cursor != "" && len(cursor) <= 512 && !strings.ContainsAny(cursor, "\n\r") {
		full = append(full, "--after-cursor="+cursor)
	}
	ctx, cancel := context.WithTimeout(context.Background(), logsCommandTimeout)
	defer cancel()
	output, err := exec.CommandContext(ctx, "journalctl", full...).Output()
	if err != nil && len(output) == 0 {
		result.Error = "journalctl failed"
		result.Cursor = cursor
		return
	}
	lines, nextCursor := parseJournalOutput(string(output))
	if nextCursor == "" {
		nextCursor = cursor
	}
	result.Cursor = nextCursor
	result.Lines = lines
}

// parseJournalOutput 去掉「-- No entries --」这类提示，取出末尾的 "-- cursor: …"。
func parseJournalOutput(output string) ([]string, string) {
	lines := []string{}
	cursor := ""
	scanner := bufio.NewScanner(strings.NewReader(output))
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "-- cursor: ") {
			cursor = strings.TrimSpace(strings.TrimPrefix(line, "-- cursor: "))
			continue
		}
		if strings.HasPrefix(line, "-- ") && strings.HasSuffix(line, " --") {
			continue
		}
		lines = append(lines, line)
	}
	return lines, cursor
}

func init() {
	registerExtModule(&logsExtModule{})
}
