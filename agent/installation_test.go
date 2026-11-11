package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
)

// 每个用例自己的配置目录，并把安装实例的进程内状态还原。
func useAgentInstallationTestConfig(t *testing.T) string {
	t.Helper()
	previousConfigPath := activeConfigPath
	agentInstallation.Lock()
	previousKey, previousID, previousDir := agentInstallation.key, agentInstallation.id, agentInstallation.dir
	agentInstallation.key = ""
	agentInstallation.Unlock()
	previousStatus := agentInstallationStatus.Load()
	agentInstallationStatus.Store(agentInstallationActive)
	t.Cleanup(func() {
		activeConfigPath = previousConfigPath
		agentInstallation.Lock()
		agentInstallation.key, agentInstallation.id, agentInstallation.dir = previousKey, previousID, previousDir
		agentInstallation.Unlock()
		agentInstallationStatus.Store(previousStatus)
	})
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{"panelUrl":"http://panel.invalid","token":"tok"}`), 0600); err != nil {
		t.Fatal(err)
	}
	activeConfigPath = path
	return path
}

// 模拟「重启」：进程内状态清掉，下一次用的时候从磁盘重新读。
func restartAgentInstallationForTest() {
	agentInstallation.Lock()
	agentInstallation.key = ""
	agentInstallation.Unlock()
	agentInstallationStatus.Store(agentInstallationActive)
}

func TestAgentInstallationIDPersistsAcrossRestartAndUpgrade(t *testing.T) {
	configPath := useAgentInstallationTestConfig(t)
	cfg := Config{Token: "token-a"}
	first := agentInstallationIDFor(cfg)
	if !validAgentInstallationID(first) {
		t.Fatalf("invalid installation id %q", first)
	}
	if again := agentInstallationIDFor(cfg); again != first {
		t.Fatalf("id changed within one process: %s -> %s", first, again)
	}
	restartAgentInstallationForTest()
	if afterRestart := agentInstallationIDFor(cfg); afterRestart != first {
		t.Fatalf("id changed after restart/upgrade: %s -> %s", first, afterRestart)
	}
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(configPath), "installation.json"))
	if err != nil {
		t.Fatal(err)
	}
	var file agentInstallationFile
	if err := json.Unmarshal(raw, &file); err != nil || file.ID != first || file.TokenHash == "" || file.TokenHash == "token-a" {
		t.Fatalf("unexpected installation file %s (err=%v)", raw, err)
	}
	// 同一台机器换了 token（装成另一台主机）就是另一个实例。
	restartAgentInstallationForTest()
	if other := agentInstallationIDFor(Config{Token: "token-b"}); other == first || !validAgentInstallationID(other) {
		t.Fatalf("token change must create a new id, got %s (old %s)", other, first)
	}
}

func TestAgentInstallationIDRegeneratesCorruptFile(t *testing.T) {
	configPath := useAgentInstallationTestConfig(t)
	if err := os.WriteFile(filepath.Join(filepath.Dir(configPath), "installation.json"), []byte("{not json"), 0600); err != nil {
		t.Fatal(err)
	}
	if id := agentInstallationIDFor(Config{Token: "tok"}); !validAgentInstallationID(id) {
		t.Fatalf("corrupt file should be replaced with a fresh id, got %q", id)
	}
}

func TestAgentInstallationWithoutConfigPathSendsNoID(t *testing.T) {
	useAgentInstallationTestConfig(t)
	activeConfigPath = ""
	if id := agentInstallationIDFor(Config{Token: "tok"}); id != "" {
		t.Fatalf("expected no id without a config path, got %q", id)
	}
}

type fakeInstallationPanel struct {
	token      string
	requests   atomic.Int32
	lastID     atomic.Value
	supersede  atomic.Bool
	plainReply atomic.Bool
}

func (p *fakeInstallationPanel) handler(t *testing.T) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/sync" {
			http.NotFound(w, r)
			return
		}
		p.requests.Add(1)
		raw, _ := io.ReadAll(r.Body)
		var env envelope
		if err := json.Unmarshal(raw, &env); err != nil {
			t.Errorf("request is not an envelope: %v", err)
			return
		}
		plain, err := decrypt(env, p.token)
		if err != nil {
			t.Errorf("decrypt request: %v", err)
			return
		}
		var inner struct {
			Path           string `json:"path"`
			InstallationID string `json:"installationId"`
		}
		_ = json.Unmarshal(plain, &inner)
		p.lastID.Store(inner.InstallationID)
		w.Header().Set("Content-Type", "application/json")
		if p.supersede.Load() {
			w.WriteHeader(http.StatusConflict)
			if p.plainReply.Load() {
				_, _ = w.Write([]byte(`{"success":false,"agentSuperseded":true}`))
				return
			}
			out, _ := encrypt(map[string]any{"success": false, "agentSuperseded": true}, p.token)
			body, _ := json.Marshal(out)
			_, _ = w.Write(body)
			return
		}
		out, _ := encrypt(map[string]any{"success": true}, p.token)
		body, _ := json.Marshal(out)
		_, _ = w.Write(body)
	})
}

func TestAgentInstallationIDTravelsInsideEnvelopeAndSupersededStopsSync(t *testing.T) {
	configPath := useAgentInstallationTestConfig(t)
	panel := &fakeInstallationPanel{token: "tok"}
	srv := httptest.NewServer(panel.handler(t))
	defer srv.Close()
	cfg := Config{Token: "tok"}
	call := func() error {
		return postWithClientToPanelURL(srv.Client(), cfg, srv.URL, "/api/agent/heartbeat", map[string]any{}, &map[string]any{})
	}
	if err := call(); err != nil {
		t.Fatalf("normal request failed: %v", err)
	}
	id, _ := panel.lastID.Load().(string)
	if id == "" || id != agentInstallationIDFor(cfg) {
		t.Fatalf("installation id not sent inside the envelope: %q", id)
	}

	// 明文 409 谁都能伪造：不能让 Agent 停止同步。
	panel.supersede.Store(true)
	panel.plainReply.Store(true)
	if err := call(); errors.Is(err, errAgentSuperseded) || agentInstallationBlocked() {
		t.Fatalf("plaintext superseded reply must be ignored, err=%v", err)
	}

	// 验过 MAC 的 409 + agentSuperseded：停止同步，后面的请求不再发出去。
	panel.plainReply.Store(false)
	if err := call(); !errors.Is(err, errAgentSuperseded) {
		t.Fatalf("expected superseded error, got %v", err)
	}
	if !agentInstallationBlocked() {
		t.Fatal("agent should be blocked after an authenticated superseded reply")
	}
	before := panel.requests.Load()
	for i := 0; i < 3; i++ {
		if err := call(); !errors.Is(err, errAgentSuperseded) {
			t.Fatalf("blocked agent should short-circuit, got %v", err)
		}
	}
	if after := panel.requests.Load(); after != before {
		t.Fatalf("blocked agent still talked to the panel: %d -> %d requests", before, after)
	}
	marker := agentRetiredInstallationMarker(filepath.Dir(configPath), id)
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("superseded marker not persisted: %v", err)
	}

	// 重启：本地标记让它先试一次。面板仍说已接管 —— 继续停着。
	restartAgentInstallationForTest()
	if err := call(); !errors.Is(err, errAgentSuperseded) || !agentInstallationBlocked() {
		t.Fatalf("restart recheck should stay superseded, err=%v blocked=%v", err, agentInstallationBlocked())
	}

	// 管理员在面板上解除了绑定：重启后那一次正常回包就恢复同步，并清掉本地标记。
	restartAgentInstallationForTest()
	panel.supersede.Store(false)
	if err := call(); err != nil {
		t.Fatalf("recheck request failed: %v", err)
	}
	if agentInstallationBlocked() || agentInstallationStatus.Load() != agentInstallationActive {
		t.Fatal("agent should resume synchronization after the panel accepts it again")
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("marker should be removed after re-acceptance, stat err=%v", err)
	}
}

func TestPanelResponseSupersedesAgentNeedsConflictAndFlag(t *testing.T) {
	if panelResponseSupersedesAgent(200, []byte(`{"agentSuperseded":true}`)) {
		t.Fatal("2xx must not supersede")
	}
	if panelResponseSupersedesAgent(409, []byte(`{"error":"conflict"}`)) {
		t.Fatal("409 without flag must not supersede")
	}
	if !panelResponseSupersedesAgent(409, []byte(`{"agentSuperseded":true}`)) {
		t.Fatal("409 with flag should supersede")
	}
}
