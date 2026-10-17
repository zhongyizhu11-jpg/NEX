package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadLogFileInitialTailAndIncremental(t *testing.T) {
	path := filepath.Join(t.TempDir(), "a.log")
	if err := os.WriteFile(path, []byte("one\ntwo\nthree\npartial"), 0644); err != nil {
		t.Fatal(err)
	}
	var first logsResult
	readLogFile(path, "", 2, &first)
	if strings.Join(first.Lines, "|") != "two|three" {
		t.Fatalf("initial tail = %q", first.Lines)
	}
	if first.Cursor != "14" { // 半行留到下次
		t.Fatalf("cursor = %q", first.Cursor)
	}
	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0644)
	f.WriteString(" line\nfour\n")
	f.Close()
	var next logsResult
	readLogFile(path, first.Cursor, 100, &next)
	if strings.Join(next.Lines, "|") != "partial line|four" {
		t.Fatalf("incremental = %q", next.Lines)
	}
	var none logsResult
	readLogFile(path, next.Cursor, 100, &none)
	if len(none.Lines) != 0 || none.Cursor != next.Cursor {
		t.Fatalf("no new data should keep cursor, got %q %q", none.Lines, none.Cursor)
	}
}

func TestReadLogFileTruncatedResets(t *testing.T) {
	path := filepath.Join(t.TempDir(), "a.log")
	os.WriteFile(path, []byte("x\n"), 0644)
	var result logsResult
	readLogFile(path, "9999", 10, &result)
	if !result.Reset || strings.Join(result.Lines, "|") != "x" {
		t.Fatalf("truncated file should reset: %+v", result)
	}
}

func TestReadLogSourceRejectsUnknownAndTraversal(t *testing.T) {
	for _, source := range []string{"/etc/shadow", "fxp:../../etc/passwd", "fxp:agent-go.log", "shell"} {
		result := readLogSource(logsRequest{ID: "a", Source: source})
		if result.Error != "unknown log source" {
			t.Fatalf("source %q must be rejected, got %+v", source, result)
		}
	}
}

func TestParseJournalOutput(t *testing.T) {
	lines, cursor := parseJournalOutput("2026-10-17T10:00:00+0800 host gost[1]: started\n-- No entries --\n-- cursor: s=abc;i=1\n")
	if strings.Join(lines, "|") != "2026-10-17T10:00:00+0800 host gost[1]: started" || cursor != "s=abc;i=1" {
		t.Fatalf("got %q %q", lines, cursor)
	}
}

func TestCleanLogLineRedactsAndCaps(t *testing.T) {
	if got := cleanLogLine("connect token=abcdef123 ok"); strings.Contains(got, "abcdef123") {
		t.Fatalf("secret not redacted: %q", got)
	}
	long := strings.Repeat("好", logsMaxLineLength)
	if got := cleanLogLine(long); len(got) > logsMaxLineLength+len("…") {
		t.Fatalf("line not capped: %d", len(got))
	}
}
