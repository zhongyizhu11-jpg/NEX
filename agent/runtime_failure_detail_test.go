package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const realmIPv6PanicLog = `fd: soft=20000, hard=20000
log: level=warn, output=stdout
dns: mode=ipv4_and_ipv6, protocol=tcp+udp, min-ttl=0, max-ttl=86400, cache-size=32, servers=system
inited: [::]:30021 -> [127.0.0.1:9]; options: ipv6-only=false, accept-mptcp=false

thread 'tokio-rt-worker' (4625) panicked at realm_core/src/tcp/mod.rs:37:66:
[tcp]failed to bind [::]:30021: Address family not supported by protocol (os error 97)
stack backtrace:
note: Some details are omitted, run with ` + "`RUST_BACKTRACE=full`" + ` for a verbose backtrace.
`

func TestRuntimeLogExcerptPicksCause(t *testing.T) {
	got := runtimeLogExcerpt(realmIPv6PanicLog, 240)
	want := "[tcp]failed to bind [::]:30021: Address family not supported by protocol (os error 97)"
	if got != want {
		t.Fatalf("realm excerpt = %q, want %q", got, want)
	}
	socat := "2026/11/11 15:03:44 socat[4632] E socket(10, 1, 6): Address family not supported by protocol\n"
	if got := runtimeLogExcerpt(socat, 240); got != "socat[4632] E socket(10, 1, 6): Address family not supported by protocol" {
		t.Fatalf("socat excerpt = %q", got)
	}
	// 没有像原因的行时退回最后一行。
	if got := runtimeLogExcerpt("hello\nworld\n", 240); got != "world" {
		t.Fatalf("fallback excerpt = %q", got)
	}
	if got := runtimeLogExcerpt("", 240); got != "" {
		t.Fatalf("empty log excerpt = %q", got)
	}
}

func TestRuntimeLogExcerptSanitizesAndTruncates(t *testing.T) {
	raw := "\x1b[31mERROR\x1b[0m dial failed password=hunter2 token: abc123 via socks5://user:pa55@1.2.3.4:1080\x07\n"
	got := runtimeLogExcerpt(raw, 240)
	for _, secret := range []string{"hunter2", "abc123", "pa55", "user:", "\x1b", "\x07"} {
		if strings.Contains(got, secret) {
			t.Fatalf("excerpt leaked %q: %q", secret, got)
		}
	}
	if !strings.Contains(got, "password=***") || !strings.Contains(got, "socks5://***@1.2.3.4:1080") {
		t.Fatalf("excerpt not redacted as expected: %q", got)
	}
	long := "error: " + strings.Repeat("端口", 200)
	cut := runtimeLogExcerpt(long, 50)
	if len(cut) > 50 || !strings.HasSuffix(cut, "…") || !strings.HasPrefix(cut, "error: ") {
		t.Fatalf("truncate = %q (%d bytes)", cut, len(cut))
	}
	if !isValidUTF8(cut) {
		t.Fatalf("truncation split a rune: %q", cut)
	}
}

func isValidUTF8(s string) bool { return strings.ToValidUTF8(s, "�") == s }

func TestClassifyRuntimeLogCause(t *testing.T) {
	cases := map[string]string{
		realmIPv6PanicLog: "ipv6-unavailable",
		"socat[1] E socket(10, 2, 17): Address family not supported by protocol":          "ipv6-unavailable",
		"[tcp]failed to bind 0.0.0.0:80: Address already in use (os error 98)":            "address-in-use",
		"nginx: [emerg] bind() to 0.0.0.0:80 failed (13: Permission denied)":              "permission-denied",
		"forwardx-realm-tcp-1.service: Main process exited, code=exited, status=203/EXEC": "runtime-missing",
		"sh: /usr/local/bin/realm: not found":                                             "runtime-missing",
		"connection reset by peer":                                                        "",
	}
	for text, want := range cases {
		if got := classifyRuntimeLogCause(text); got != want {
			t.Errorf("classify(%q) = %q, want %q", text, got, want)
		}
	}
}

func realmTestAction() action {
	return action{
		Op:          "apply",
		ForwardType: "realm",
		SourcePort:  30021,
		Protocol:    "tcp",
		ServiceName: "forwardx-realm-tcp-30021",
		Unit:        "[Service]\nExecStart=/usr/local/bin/realm -c /etc/forwardx/realm/forwardx-realm-tcp-30021.toml\n",
	}
}

func TestManagedRuntimeFailureDetailFromJournal(t *testing.T) {
	journalCalls := []string{}
	env := runtimeFailureEnv{
		systemd: func() bool { return true },
		journal: func(service string) string {
			journalCalls = append(journalCalls, service)
			return realmIPv6PanicLog
		},
		readLog:    func(string) string { t.Fatal("log file should not be read when journal has output"); return "" },
		executable: func(string) bool { return true },
	}
	base := "managed runtime listener not ready after apply port=30021 protocol=tcp forwardType=realm"
	got := appendManagedRuntimeFailureDetail(base, realmTestAction(), env)
	want := base + "; cause=ipv6-unavailable; log: [tcp]failed to bind [::]:30021: Address family not supported by protocol (os error 97)"
	if got != want {
		t.Fatalf("message = %q\nwant      %q", got, want)
	}
	if len(got) > runtimeFailureMessageMax {
		t.Fatalf("message too long: %d", len(got))
	}
	if len(journalCalls) != 1 || journalCalls[0] != "forwardx-realm-tcp-30021" {
		t.Fatalf("journal calls = %v", journalCalls)
	}
}

func TestManagedRuntimeFailureDetailSysVLogFile(t *testing.T) {
	read := []string{}
	env := runtimeFailureEnv{
		systemd: func() bool { return false },
		readLog: func(path string) string {
			read = append(read, path)
			if strings.HasSuffix(path, "forwardx-socat-udp-30021.log") {
				return "2026/11/11 15:03:44 socat[4637] E socket(10, 2, 17): Address family not supported by protocol\n"
			}
			return ""
		},
		executable: func(string) bool { return true },
	}
	a := action{Op: "apply", ForwardType: "socat", SourcePort: 30021, Protocol: "both",
		ServiceName: "forwardx-socat-tcp-30021", ServiceNameExtra: "forwardx-socat-udp-30021",
		Unit: "[Service]\nExecStart=/usr/bin/socat -b65536 TCP6-LISTEN:30021\n", UnitExtra: "[Service]\nExecStart=/usr/bin/socat -b65536 UDP6-LISTEN:30021\n"}
	got := managedRuntimeFailureDetail(a, env, 200)
	if got != "cause=ipv6-unavailable; log: socat[4637] E socket(10, 2, 17): Address family not supported by protocol" {
		t.Fatalf("detail = %q", got)
	}
	if len(read) != 2 || read[0] != "/var/log/forwardx-agent/forwardx-socat-tcp-30021.log" {
		t.Fatalf("read paths = %v", read)
	}
}

func TestManagedRuntimeFailureDetailMissingBinary(t *testing.T) {
	env := runtimeFailureEnv{
		systemd:    func() bool { t.Fatal("logs not needed when the binary is missing"); return false },
		executable: func(path string) bool { return path != "/usr/local/bin/realm" },
	}
	if got := managedRuntimeFailureDetail(realmTestAction(), env, 200); got != "cause=runtime-missing binary=/usr/local/bin/realm" {
		t.Fatalf("detail = %q", got)
	}
	nginx := action{Op: "apply", ForwardType: "nginx", SourcePort: 80, Protocol: "tcp"}
	env.executable = func(path string) bool { return path != "/usr/local/bin/forwardx-nginx" }
	if got := managedRuntimeFailureDetail(nginx, env, 200); got != "cause=runtime-missing binary=/usr/local/bin/forwardx-nginx" {
		t.Fatalf("nginx detail = %q", got)
	}
}

func TestManagedRuntimeFailureDetailNothingKnown(t *testing.T) {
	env := runtimeFailureEnv{
		systemd:    func() bool { return true },
		journal:    func(string) string { return "" },
		readLog:    func(string) string { return "" },
		executable: func(string) bool { return true },
	}
	base := "managed runtime listener not ready after apply port=1 protocol=tcp forwardType=realm"
	if got := appendManagedRuntimeFailureDetail(base, realmTestAction(), env); got != base {
		t.Fatalf("message changed without detail: %q", got)
	}
	if got := managedRuntimeFailureDetail(realmTestAction(), env, 0); got != "" {
		t.Fatalf("zero budget detail = %q", got)
	}
}

func TestManagedRuntimeFailureDetailRespectsBudget(t *testing.T) {
	env := runtimeFailureEnv{
		systemd:    func() bool { return true },
		journal:    func(string) string { return "error: " + strings.Repeat("x", 1000) },
		executable: func(string) bool { return true },
	}
	base := strings.Repeat("m", 200)
	got := appendManagedRuntimeFailureDetail(base, realmTestAction(), env)
	if len(got) > runtimeFailureMessageMax {
		t.Fatalf("message %d bytes > %d", len(got), runtimeFailureMessageMax)
	}
	if !strings.HasPrefix(got, base+"; log: error: ") {
		t.Fatalf("message = %q", got)
	}
}

func TestReadRecentLogTailSkipsStaleFiles(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "svc.log")
	content := strings.Repeat("old line\n", 4000) + "last error: boom\n"
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	tail := readRecentLogTail(path, now)
	if len(tail) != runtimeFailureLogReadMax || !strings.HasSuffix(tail, "last error: boom\n") {
		t.Fatalf("tail len=%d suffix ok=%v", len(tail), strings.HasSuffix(tail, "last error: boom\n"))
	}
	if got := readRecentLogTail(path, now.Add(runtimeFailureLogFreshFor+time.Minute)); got != "" {
		t.Fatalf("stale log should be ignored, got %d bytes", len(got))
	}
	if got := readRecentLogTail(filepath.Join(dir, "missing.log"), now); got != "" {
		t.Fatalf("missing log = %q", got)
	}
}
