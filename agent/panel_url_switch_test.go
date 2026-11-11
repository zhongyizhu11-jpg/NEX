package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// 一个最小的「面板」：只认 /api/sync 里的 panel-url-probe，用 token 加密回包。
func newPanelURLProbeServer(t *testing.T, token string, acknowledge bool) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var probes atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/sync" {
			http.NotFound(w, r)
			return
		}
		raw, _ := io.ReadAll(r.Body)
		var env envelope
		if json.Unmarshal(raw, &env) != nil {
			http.Error(w, "bad", http.StatusBadRequest)
			return
		}
		plain, err := decrypt(env, token)
		if err != nil {
			// 不认得这个 token：真面板这时回明文 401。
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"Unauthorized"}`))
			return
		}
		var inner struct {
			Path string `json:"path"`
		}
		_ = json.Unmarshal(plain, &inner)
		if inner.Path == "/api/agent/panel-url-probe" {
			probes.Add(1)
		}
		out, _ := encrypt(map[string]any{"success": true, "panelUrlProbe": acknowledge}, token)
		body, _ := json.Marshal(out)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)
	return srv, &probes
}

func usePanelURLSwitchTestConfig(t *testing.T, current string) string {
	t.Helper()
	path := writePanelMigrationTestConfig(t, Config{PanelURL: current, Token: "tok"})
	activeConfigPath = path
	runtimePanelURL.Store(current)
	previousClient := panelURLProbeClient
	panelURLProbeClient = func() *http.Client { return &http.Client{Timeout: 5 * time.Second} }
	panelURLSwitchState.Lock()
	panelURLSwitchState.backoff = map[string]time.Duration{}
	panelURLSwitchState.retryAfter = map[string]time.Time{}
	panelURLSwitchState.previous, panelURLSwitchState.switchedTo, panelURLSwitchState.failures = "", "", 0
	panelURLSwitchState.inFlight, panelURLSwitchState.reverting = false, false
	panelURLSwitchState.Unlock()
	t.Cleanup(func() { panelURLProbeClient = previousClient })
	return path
}

func TestPanelURLSwitchVerifiesBeforePersisting(t *testing.T) {
	oldPanel, _ := newPanelURLProbeServer(t, "tok", true)
	newPanel, probes := newPanelURLProbeServer(t, "tok", true)
	path := usePanelURLSwitchTestConfig(t, oldPanel.URL)
	switched, err := switchPanelURLVerified(Config{Token: "tok"}, oldPanel.URL, newPanel.URL)
	if err != nil || !switched {
		t.Fatalf("expected verified switch, switched=%v err=%v", switched, err)
	}
	if probes.Load() != 1 {
		t.Fatalf("expected one probe against the new URL, got %d", probes.Load())
	}
	if got := currentPanelURL(Config{}); got != normalizePanelURL(newPanel.URL) {
		t.Fatalf("runtime URL not switched: %s", got)
	}
	if got := readPanelMigrationTestConfig(t, path)["panelUrl"]; got != normalizePanelURL(newPanel.URL) {
		t.Fatalf("config not persisted after verification: %v", got)
	}
}

func TestPanelURLSwitchFallsBackWhenTargetFailsVerification(t *testing.T) {
	oldPanel, _ := newPanelURLProbeServer(t, "tok", true)
	cases := map[string]string{}
	// 认得别的 token 的面板（填成了另一个 NEX）
	otherPanel, _ := newPanelURLProbeServer(t, "someone-else", true)
	cases["different token"] = otherPanel.URL
	// 通，但不是会回探测确认的面板
	silentPanel, _ := newPanelURLProbeServer(t, "tok", false)
	cases["unacknowledged probe"] = silentPanel.URL
	// 反代没放行 /api/sync
	notFound := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(notFound.Close)
	cases["404"] = notFound.URL
	// 明文 200（不是我们的面板）
	plain := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"success":true,"panelUrlProbe":true}`))
	}))
	t.Cleanup(plain.Close)
	cases["plaintext"] = plain.URL
	// 连不上
	cases["unreachable"] = "http://127.0.0.1:1"

	for name, target := range cases {
		t.Run(name, func(t *testing.T) {
			path := usePanelURLSwitchTestConfig(t, oldPanel.URL)
			switched, err := switchPanelURLVerified(Config{Token: "tok"}, oldPanel.URL, target)
			if switched || err == nil {
				t.Fatalf("switch to a bad URL must fail, switched=%v err=%v", switched, err)
			}
			if got := currentPanelURL(Config{}); got != oldPanel.URL {
				t.Fatalf("runtime URL changed to %s", got)
			}
			if got := readPanelMigrationTestConfig(t, path)["panelUrl"]; got != oldPanel.URL {
				t.Fatalf("config changed to %v", got)
			}
		})
	}
}

func TestRequestVerifiedPanelURLSwitchBacksOffFailedTarget(t *testing.T) {
	oldPanel, _ := newPanelURLProbeServer(t, "tok", true)
	usePanelURLSwitchTestConfig(t, oldPanel.URL)
	runtimeAgentToken.Store("tok")
	target := "http://127.0.0.1:1"
	requestVerifiedPanelURLSwitch(oldPanel.URL, target)
	deadline := time.Now().Add(5 * time.Second)
	for {
		panelURLSwitchState.Lock()
		_, backedOff := panelURLSwitchState.retryAfter[target]
		inFlight := panelURLSwitchState.inFlight
		panelURLSwitchState.Unlock()
		if backedOff && !inFlight {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("failed target was not put into backoff")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if got := currentPanelURL(Config{}); got != oldPanel.URL {
		t.Fatalf("runtime URL changed to %s", got)
	}
}

func TestPanelURLSwitchRevertsWhenNewURLKeepsFailing(t *testing.T) {
	oldPanel, _ := newPanelURLProbeServer(t, "tok", true)
	newPanel, _ := newPanelURLProbeServer(t, "tok", true)
	path := usePanelURLSwitchTestConfig(t, oldPanel.URL)
	if switched, err := switchPanelURLVerified(Config{Token: "tok"}, oldPanel.URL, newPanel.URL); err != nil || !switched {
		t.Fatalf("setup switch failed: %v", err)
	}
	if !revertPanelURLSwitch(Config{Token: "tok"}, oldPanel.URL, normalizePanelURL(newPanel.URL)) {
		t.Fatal("expected revert to the previous URL that still verifies")
	}
	if got := currentPanelURL(Config{}); got != normalizePanelURL(oldPanel.URL) {
		t.Fatalf("runtime URL not reverted: %s", got)
	}
	if got := readPanelMigrationTestConfig(t, path)["panelUrl"]; got != normalizePanelURL(oldPanel.URL) {
		t.Fatalf("config not reverted: %v", got)
	}
	panelURLSwitchState.Lock()
	until := panelURLSwitchState.retryAfter[normalizePanelURL(newPanel.URL)]
	panelURLSwitchState.Unlock()
	if time.Until(until) < panelURLSwitchRevertBackoff-time.Minute {
		t.Fatalf("reverted target should back off for a long time, retry in %s", time.Until(until))
	}

	// 原地址也不通时不要乱切。
	if switched, err := switchPanelURLVerified(Config{Token: "tok"}, normalizePanelURL(oldPanel.URL), newPanel.URL); err != nil || !switched {
		t.Fatalf("second switch failed: %v", err)
	}
	if revertPanelURLSwitch(Config{Token: "tok"}, "http://127.0.0.1:1", normalizePanelURL(newPanel.URL)) {
		t.Fatal("must not revert to a previous URL that fails verification")
	}
	if got := currentPanelURL(Config{}); !strings.HasPrefix(got, normalizePanelURL(newPanel.URL)) {
		t.Fatalf("runtime URL changed unexpectedly: %s", got)
	}
}
