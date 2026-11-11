package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func sampleMitaConfig() *mitaServerConfig {
	return &mitaServerConfig{
		PortBindings: []mitaPortBinding{
			{Port: 27001, Protocol: "TCP"},
			{PortRange: "27010-27012", Protocol: "UDP"},
		},
		Users: []mitaUser{
			{Name: "nexaaaa", Password: "pw-one"},
			{Name: "nexbbbb", Password: "pw-two"},
		},
		LoggingLevel: "INFO",
		MTU:          1400,
	}
}

func TestValidateMitaServerConfigAcceptsPanelShape(t *testing.T) {
	if err := validateMitaServerConfig(sampleMitaConfig()); err != nil {
		t.Fatalf("expected valid config, got %v", err)
	}
}

func TestValidateMitaServerConfigRejectsWhatMitaWouldRefuse(t *testing.T) {
	cases := map[string]func(*mitaServerConfig){
		"no bindings":     func(c *mitaServerConfig) { c.PortBindings = nil },
		"bad protocol":    func(c *mitaServerConfig) { c.PortBindings[0].Protocol = "QUIC" },
		"lowercase proto": func(c *mitaServerConfig) { c.PortBindings[0].Protocol = "tcp" },
		"port and range":  func(c *mitaServerConfig) { c.PortBindings[0].PortRange = "1-2" },
		"port zero":       func(c *mitaServerConfig) { c.PortBindings[0].Port = 0 },
		"port too big":    func(c *mitaServerConfig) { c.PortBindings[0].Port = 70000 },
		"range reversed":  func(c *mitaServerConfig) { c.PortBindings[1].PortRange = "27012-27010" },
		"range too long":  func(c *mitaServerConfig) { c.PortBindings[1].PortRange = "20000-20200" },
		"range garbage":   func(c *mitaServerConfig) { c.PortBindings[1].PortRange = "a-b" },
		"overlap same prot": func(c *mitaServerConfig) {
			c.PortBindings[1] = mitaPortBinding{PortRange: "27000-27002", Protocol: "TCP"}
		},
		"no users":         func(c *mitaServerConfig) { c.Users = nil },
		"bad username":     func(c *mitaServerConfig) { c.Users[0].Name = "bad name" },
		"dup username":     func(c *mitaServerConfig) { c.Users[1].Name = c.Users[0].Name },
		"empty password":   func(c *mitaServerConfig) { c.Users[0].Password = "" },
		"control password": func(c *mitaServerConfig) { c.Users[0].Password = "a\nb" },
		"mtu low":          func(c *mitaServerConfig) { c.MTU = 1000 },
	}
	for name, mutate := range cases {
		cfg := sampleMitaConfig()
		mutate(cfg)
		if err := validateMitaServerConfig(cfg); err == nil {
			t.Errorf("%s: expected rejection", name)
		}
	}
}

func TestValidateMitaServerConfigAllowsSamePortOnBothTransports(t *testing.T) {
	cfg := sampleMitaConfig()
	cfg.PortBindings = []mitaPortBinding{{Port: 27001, Protocol: "TCP"}, {Port: 27001, Protocol: "UDP"}}
	if err := validateMitaServerConfig(cfg); err != nil {
		t.Fatalf("TCP and UDP on one port should be fine: %v", err)
	}
}

func TestRenderMitaServerConfigOnlyCarriesKnownFields(t *testing.T) {
	// 面板指令里多出来的字段（比如别人塞进来的 egress）不能到 mita。
	raw := []byte(`{"v":1,"enabled":true,"revision":"r1","version":"3.39.0","config":{
		"portBindings":[{"port":27001,"protocol":"TCP","extra":1}],
		"users":[{"name":"nexaaaa","password":"pw","quotas":[{"days":1}]}],
		"loggingLevel":"DEBUG","mtu":0,
		"egress":{"proxies":[{"name":"x"}]},"advancedSettings":{"noCheckUpdate":false}}}`)
	var directive mitaDirective
	if err := json.Unmarshal(raw, &directive); err != nil {
		t.Fatal(err)
	}
	rendered, err := renderMitaServerConfig(directive.Config)
	if err != nil {
		t.Fatal(err)
	}
	text := string(rendered)
	for _, forbidden := range []string{"egress", "quotas", "advancedSettings", "extra", "DEBUG"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("rendered config leaks %q: %s", forbidden, text)
		}
	}
	var back map[string]any
	if err := json.Unmarshal(rendered, &back); err != nil {
		t.Fatal(err)
	}
	if back["loggingLevel"] != "INFO" || back["mtu"] != float64(1400) {
		t.Fatalf("expected forced INFO and default MTU, got %v", back)
	}
	again, _ := renderMitaServerConfig(directive.Config)
	if !bytes.Equal(rendered, again) {
		t.Fatal("render must be deterministic, otherwise mita restarts every round")
	}
}

func TestMitaListenTargetsExpandsRanges(t *testing.T) {
	targets := mitaListenTargets(sampleMitaConfig())
	want := []mitaListenTarget{{27001, "TCP"}, {27010, "UDP"}, {27011, "UDP"}, {27012, "UDP"}}
	if len(targets) != len(want) {
		t.Fatalf("targets=%v", targets)
	}
	for i := range want {
		if targets[i] != want[i] {
			t.Fatalf("targets[%d]=%v want %v", i, targets[i], want[i])
		}
	}
}

func validMitaDirective() *mitaDirective {
	return &mitaDirective{
		V:        1,
		Enabled:  true,
		Revision: "rev1",
		Version:  "3.39.0",
		Binaries: map[string]mitaBinarySource{
			"amd64": {
				SHA256:         strings.Repeat("a", 64),
				PanelAssetPath: "/api/agent/assets/v2.3.523/forwardx-mita-linux-amd64",
				TarballURLs:    []string{"https://github.com/enfein/mieru/releases/download/v3.39.0/mita_3.39.0_linux_amd64.tar.gz"},
				TarballSHA256:  strings.Repeat("b", 64),
			},
		},
		Config: sampleMitaConfig(),
	}
}

func TestValidateMitaDirectiveGuardsDownloadSources(t *testing.T) {
	if _, err := validateMitaDirective(validMitaDirective(), "amd64"); err != nil {
		t.Fatalf("valid directive rejected: %v", err)
	}
	if _, err := validateMitaDirective(validMitaDirective(), "arm64"); err == nil {
		t.Fatal("missing arch must be rejected")
	}
	d := validMitaDirective()
	src := d.Binaries["amd64"]
	src.SHA256 = "nothex"
	d.Binaries["amd64"] = src
	if _, err := validateMitaDirective(d, "amd64"); err == nil {
		t.Fatal("bad sha must be rejected")
	}
	d = validMitaDirective()
	src = d.Binaries["amd64"]
	src.PanelAssetPath = "/etc/passwd"
	d.Binaries["amd64"] = src
	if _, err := validateMitaDirective(d, "amd64"); err == nil {
		t.Fatal("non-asset panel path must be rejected")
	}
	d = validMitaDirective()
	src = d.Binaries["amd64"]
	src.PanelAssetPath = ""
	src.TarballURLs = []string{"http://evil.example/mita.tgz", "file:///tmp/x"}
	d.Binaries["amd64"] = src
	if _, err := validateMitaDirective(d, "amd64"); err == nil {
		t.Fatal("only https tarball URLs may be used")
	}
	if _, err := validateMitaDirective(&mitaDirective{Revision: "disabled"}, "amd64"); err != nil {
		t.Fatalf("disabled directive needs no binaries: %v", err)
	}
}

func TestPlanMitaLifecycle(t *testing.T) {
	rendered, _ := renderMitaServerConfig(sampleMitaConfig())
	want := strings.Repeat("a", 64)
	signature := mitaSignature(rendered, want)

	if plan := planMitaLifecycle(false, nil, "", mitaObserved{}); !plan.noop() {
		t.Fatalf("not managed by NEX: must not touch anything, got %+v", plan)
	}
	if plan := planMitaLifecycle(false, nil, "", mitaObserved{Managed: true}); !plan.Retire || plan.InstallBinary || plan.ApplyService {
		t.Fatalf("managed but no inbound: retire only, got %+v", plan)
	}
	fresh := planMitaLifecycle(true, rendered, want, mitaObserved{})
	if !fresh.InstallBinary || !fresh.WriteConfig || !fresh.ApplyService || fresh.Retire {
		t.Fatalf("fresh host: install+write+start, got %+v", fresh)
	}
	steady := mitaObserved{Managed: true, BinarySHA256: want, ConfigOnDisk: rendered, ServiceActive: true, AppliedSignature: signature}
	if plan := planMitaLifecycle(true, rendered, want, steady); !plan.noop() {
		t.Fatalf("nothing changed: must not restart, got %+v", plan)
	}
	stopped := steady
	stopped.ServiceActive = false
	if plan := planMitaLifecycle(true, rendered, want, stopped); plan.InstallBinary || plan.WriteConfig || !plan.ApplyService {
		t.Fatalf("service died: start only, got %+v", plan)
	}
	changed := steady
	changed.ConfigOnDisk = []byte("{}")
	if plan := planMitaLifecycle(true, rendered, want, changed); plan.InstallBinary || !plan.WriteConfig || !plan.ApplyService {
		t.Fatalf("config changed: write+restart, got %+v", plan)
	}
	upgraded := steady
	upgraded.BinarySHA256 = strings.Repeat("c", 64)
	if plan := planMitaLifecycle(true, rendered, want, upgraded); !plan.InstallBinary || plan.WriteConfig || !plan.ApplyService {
		t.Fatalf("new mita version: install+restart, got %+v", plan)
	}
}

type fakeMitaSystem struct {
	isManaged   bool
	sha         string
	config      []byte
	active      bool
	signature   string
	installErr  error
	ready       bool
	metrics     []byte
	instance    string
	calls       []string
	appliedUnit string
}

func (f *fakeMitaSystem) arch() string  { return "amd64" }
func (f *fakeMitaSystem) managed() bool { return f.isManaged }
func (f *fakeMitaSystem) markManaged() error {
	f.calls = append(f.calls, "mark")
	f.isManaged = true
	return nil
}
func (f *fakeMitaSystem) clearManaged() {
	f.calls = append(f.calls, "unmark")
	f.isManaged = false
}
func (f *fakeMitaSystem) binarySHA256() string { return f.sha }
func (f *fakeMitaSystem) installBinary(ctx context.Context, source mitaBinarySource) error {
	f.calls = append(f.calls, "install")
	if f.installErr != nil {
		return f.installErr
	}
	f.sha = source.SHA256
	return nil
}
func (f *fakeMitaSystem) readConfig() []byte { return f.config }
func (f *fakeMitaSystem) writeConfig(data []byte) error {
	f.calls = append(f.calls, "write")
	f.config = append([]byte(nil), data...)
	return nil
}
func (f *fakeMitaSystem) removeConfig() {
	f.calls = append(f.calls, "rmconfig")
	f.config = nil
}
func (f *fakeMitaSystem) serviceActive() bool      { return f.active }
func (f *fakeMitaSystem) appliedSignature() string { return f.signature }
func (f *fakeMitaSystem) applyService(unit string, signature string) bool {
	f.calls = append(f.calls, "apply")
	f.appliedUnit = unit
	f.signature = signature
	f.active = true
	return true
}
func (f *fakeMitaSystem) retireService() {
	f.calls = append(f.calls, "retire")
	f.active = false
}
func (f *fakeMitaSystem) listenReady(targets []mitaListenTarget) []bool {
	out := make([]bool, len(targets))
	for i := range out {
		out[i] = f.ready
	}
	return out
}
func (f *fakeMitaSystem) listenOwner(port int) string   { return "" }
func (f *fakeMitaSystem) queryMetrics() ([]byte, error) { return f.metrics, nil }
func (f *fakeMitaSystem) processInstance() string       { return f.instance }

func testMitaManager(sys *fakeMitaSystem) *mitaManager {
	m := newMitaManager(sys)
	m.readyWait = 0
	m.readyPoll = time.Millisecond
	return m
}

func TestMitaManagerInstallsOnceAndDoesNotRestartWhenUnchanged(t *testing.T) {
	sys := &fakeMitaSystem{ready: true}
	m := testMitaManager(sys)
	m.setDesired(validMitaDirective())
	m.reconcile(context.Background())
	if got := strings.Join(sys.calls, ","); got != "mark,install,write,apply" {
		t.Fatalf("first apply calls=%s", got)
	}
	if status := m.currentStatus(); status.State != "running" || status.Revision != "rev1" || len(status.Listeners) != 4 {
		t.Fatalf("status=%+v", status)
	}
	if !strings.Contains(sys.appliedUnit, "MITA_CONFIG_JSON_FILE="+mitaConfigPath) || systemdUnitExecStart(sys.appliedUnit) == "" {
		t.Fatalf("unit missing config env: %s", sys.appliedUnit)
	}
	sys.calls = nil
	m.reconcile(context.Background())
	if len(sys.calls) != 0 {
		t.Fatalf("unchanged config must not restart mita, calls=%v", sys.calls)
	}
}

func TestMitaManagerKeepsRunningVersionWhenNewConfigInvalid(t *testing.T) {
	sys := &fakeMitaSystem{ready: true}
	m := testMitaManager(sys)
	m.setDesired(validMitaDirective())
	m.reconcile(context.Background())
	sys.calls = nil

	bad := validMitaDirective()
	bad.Revision = "rev2"
	bad.Config.Users[1].Name = bad.Config.Users[0].Name
	m.setDesired(bad)
	m.reconcile(context.Background())
	if len(sys.calls) != 0 {
		t.Fatalf("invalid config must not be written or applied, calls=%v", sys.calls)
	}
	status := m.currentStatus()
	if status.State != "error" || !strings.Contains(status.Error, "校验失败") || status.Revision != "rev1" {
		t.Fatalf("status=%+v", status)
	}
}

func TestMitaManagerInstallFailureLeavesOldConfig(t *testing.T) {
	sys := &fakeMitaSystem{installErr: errors.New("boom")}
	m := testMitaManager(sys)
	m.setDesired(validMitaDirective())
	m.reconcile(context.Background())
	for _, call := range sys.calls {
		if call == "write" || call == "apply" {
			t.Fatalf("must not write config / start service after failed install: %v", sys.calls)
		}
	}
	if status := m.currentStatus(); status.State != "error" || !strings.Contains(status.Error, "boom") {
		t.Fatalf("status=%+v", status)
	}
}

func TestMitaManagerReportsListenersNotReady(t *testing.T) {
	sys := &fakeMitaSystem{ready: false}
	m := testMitaManager(sys)
	m.setDesired(validMitaDirective())
	m.reconcile(context.Background())
	status := m.currentStatus()
	if status.State != "error" || !strings.Contains(status.Error, "端口没有听上") {
		t.Fatalf("status=%+v", status)
	}
	sys.calls = nil
	m.reconcile(context.Background())
	if len(sys.calls) != 0 {
		t.Fatalf("a port held by someone else must not cause a restart loop, calls=%v", sys.calls)
	}
}

func TestMitaManagerRetiresOnlyWhatItManages(t *testing.T) {
	sys := &fakeMitaSystem{}
	m := testMitaManager(sys)
	m.setDesired(&mitaDirective{V: 1, Enabled: false, Revision: "disabled"})
	m.reconcile(context.Background())
	if len(sys.calls) != 0 {
		t.Fatalf("foreign / absent mita must not be touched, calls=%v", sys.calls)
	}
	sys.isManaged = true
	sys.active = true
	m.reconcile(context.Background())
	if got := strings.Join(sys.calls, ","); got != "retire,rmconfig,unmark" {
		t.Fatalf("retire calls=%s", got)
	}
}

func TestMitaManagerWithoutDirectiveDoesNothing(t *testing.T) {
	sys := &fakeMitaSystem{isManaged: true, active: true}
	m := testMitaManager(sys)
	m.reconcile(context.Background())
	if len(sys.calls) != 0 {
		t.Fatalf("no directive yet: leave the running mita alone, calls=%v", sys.calls)
	}
}

func TestMitaManagerTrafficReport(t *testing.T) {
	sys := &fakeMitaSystem{isManaged: true, active: true, instance: "123:456",
		metrics: []byte("INFO something\n{\"users\":{\"nexaaaa\":{\"UploadBytes\":10,\"DownloadBytes\":20},\"bad name\":{\"UploadBytes\":1}}}\n")}
	m := testMitaManager(sys)
	report := m.trafficReport()
	if report == nil || report["instance"] != "123:456" {
		t.Fatalf("report=%v", report)
	}
	users := report["users"].([]mitaUserCounter)
	if len(users) != 1 || users[0] != (mitaUserCounter{Name: "nexaaaa", Up: 10, Down: 20}) {
		t.Fatalf("users=%v", users)
	}
	sys.active = false
	if m.trafficReport() != nil {
		t.Fatal("inactive service must not report counters")
	}
}

func TestParseMitaUserMetrics(t *testing.T) {
	counters, err := parseMitaUserMetrics([]byte(`{"connections":{"ActiveOpens":1},"users":{"b":{"UploadBytes":"5","DownloadBytes":6},"a":{"DownloadBytes":7}}}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(counters) != 2 || counters[0] != (mitaUserCounter{Name: "a", Down: 7}) || counters[1] != (mitaUserCounter{Name: "b", Up: 5, Down: 6}) {
		t.Fatalf("counters=%v", counters)
	}
	empty, err := parseMitaUserMetrics([]byte(`{"connections":{}}`))
	if err != nil || len(empty) != 0 {
		t.Fatalf("no users yet should be empty, got %v %v", empty, err)
	}
	if _, err := parseMitaUserMetrics([]byte("mita is not running")); err == nil {
		t.Fatal("garbage must be an error")
	}
}

func TestMitaProcessInstance(t *testing.T) {
	root := t.TempDir()
	binary := filepath.Join(root, "forwardx-mita")
	if err := os.WriteFile(binary, []byte("x"), 0755); err != nil {
		t.Fatal(err)
	}
	makeProc := func(pid string, exe string, stat string) {
		dir := filepath.Join(root, pid)
		if err := os.MkdirAll(dir, 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(exe, filepath.Join(dir, "exe")); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "stat"), []byte(stat), 0644); err != nil {
			t.Fatal(err)
		}
	}
	fields := func(start string) string {
		// pid (comm with space) state + 18 more fields, then starttime as the 22nd field
		rest := []string{"S"}
		for i := 0; i < 18; i++ {
			rest = append(rest, "0")
		}
		rest = append(rest, start, "0", "0")
		return strings.Join(rest, " ")
	}
	makeProc("900", "/usr/bin/other", "900 (other) "+fields("1"))
	makeProc("812", binary, "812 (forwardx mita) "+fields("424242"))
	if got := mitaProcessInstance(root, binary); got != "812:424242" {
		t.Fatalf("instance=%q", got)
	}
	if got := mitaProcessInstance(filepath.Join(root, "missing"), binary); got != "" {
		t.Fatalf("missing proc root should give empty, got %q", got)
	}
}

func buildMitaTarball(t *testing.T, binary []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for name, data := range map[string][]byte{"LICENSE": []byte("GPLv3"), "mita": binary} {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0755, Size: int64(len(data)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestFetchVerifiedMitaBinaryChecksEverySource(t *testing.T) {
	binary := append([]byte{0x7f, 'E', 'L', 'F'}, []byte("mita-binary")...)
	tarball := buildMitaTarball(t, binary)
	panelServes := []byte("tampered")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/agent/assets/v1.0.0/forwardx-mita-linux-amd64":
			_, _ = w.Write(panelServes)
		case "/mita.tar.gz":
			_, _ = w.Write(tarball)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	source := mitaBinarySource{
		SHA256:         sha256Hex(binary),
		PanelAssetPath: "/api/agent/assets/v1.0.0/forwardx-mita-linux-amd64",
		TarballURLs:    []string{server.URL + "/mita.tar.gz"},
		TarballSHA256:  sha256Hex(tarball),
	}
	// 面板给的内容被换过：哈希不对就退回发布包。
	got, err := fetchVerifiedMitaBinary(context.Background(), server.Client(), server.URL, source)
	if err != nil || !bytes.Equal(got, binary) {
		t.Fatalf("fallback to tarball failed: %v", err)
	}
	// 面板给的是对的：直接用。
	panelServes = binary
	if got, err := fetchVerifiedMitaBinary(context.Background(), server.Client(), server.URL, source); err != nil || !bytes.Equal(got, binary) {
		t.Fatalf("panel asset should be used: %v", err)
	}
	// 发布包哈希不对、面板也不对：整体失败，不能装。
	panelServes = []byte("tampered")
	bad := source
	bad.TarballSHA256 = strings.Repeat("0", 64)
	if _, err := fetchVerifiedMitaBinary(context.Background(), server.Client(), server.URL, bad); err == nil {
		t.Fatal("tampered sources must not be installed")
	}

	dest := filepath.Join(t.TempDir(), "bin", "forwardx-mita")
	if err := installMitaBinaryAt(dest, binary); err != nil {
		t.Fatal(err)
	}
	if fileSHA256(dest) != sha256Hex(binary) {
		t.Fatal("installed binary hash mismatch")
	}
	if info, _ := os.Stat(dest); info.Mode().Perm() != 0755 {
		t.Fatalf("installed mode=%v", info.Mode())
	}
}

func TestMitaServiceUnitWorksOnNonSystemdInits(t *testing.T) {
	unit := mitaServiceUnit()
	execStart := systemdUnitExecStart(unit)
	if !strings.Contains(execStart, mitaBinaryPath+" run") || !strings.Contains(execStart, "MITA_UDS_PATH="+mitaSocketPath) {
		t.Fatalf("execStart=%s", execStart)
	}
	// OpenRC / procd / SysV 脚本把 ExecStart 塞进 sh -c '…'：里面不能有单引号。
	if strings.Contains(execStart, "'") {
		t.Fatalf("execStart must not contain single quotes: %s", execStart)
	}
	if !strings.Contains(openRCServiceScript(mitaServiceName, execStart, systemdUnitLimitNOFILE(unit)), mitaBinaryPath) {
		t.Fatal("openrc script lost the command")
	}
}
