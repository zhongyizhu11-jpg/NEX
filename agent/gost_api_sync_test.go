package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
)

func gostTestService(name, addr string) map[string]any {
	return map[string]any{
		"name":     name,
		"addr":     addr,
		"handler":  map[string]any{"type": "tcp"},
		"listener": map[string]any{"type": "tcp"},
		"forwarder": map[string]any{"nodes": []any{
			map[string]any{"name": "target-" + name, "addr": "127.0.0.1:9"},
		}},
	}
}

func gostTestUDPService(name, addr string) map[string]any {
	service := gostTestService(name, addr)
	service["handler"] = map[string]any{"type": "udp"}
	service["listener"] = map[string]any{"type": "udp"}
	return service
}

func gostTestChain(name, addr string) map[string]any {
	return map[string]any{"name": name, "hops": []any{map[string]any{"name": "hop-" + name, "nodes": []any{map[string]any{"name": "node-" + name, "addr": addr}}}}}
}

func gostTestConfig(socket string, services []any, chains []any, limiters []any) map[string]any {
	config := map[string]any{"services": services, "api": map[string]any{"addr": "unix://" + socket}}
	if chains != nil {
		config["chains"] = chains
	}
	if limiters != nil {
		config["limiters"] = limiters
	}
	return config
}

// 测试里配置先过一遍 JSON，和 gost / API 输出的类型（float64、[]any）一致。
func gostTestJSON(t *testing.T, value any) (map[string]any, []byte) {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out, raw
}

func gostPlanSteps(plan gostSyncPlan) []string {
	var out []string
	for _, step := range plan.steps {
		if step.op == gostOpCut {
			out = append(out, fmt.Sprintf("cut %v", step.ports))
		} else {
			out = append(out, step.op+" "+step.collection+"/"+step.name)
		}
	}
	return out
}

func mustPlan(t *testing.T, previous, desired map[string]any) gostSyncPlan {
	t.Helper()
	plan, reason, err := planGostSync(previous, desired, nil)
	if err != nil || reason != "" {
		t.Fatalf("plan rejected reason=%q err=%v", reason, err)
	}
	return plan
}

func TestGostSyncPlanAdditionsOnlyTouchNewObjects(t *testing.T) {
	limiter := map[string]any{"name": "fwx-user-1-host-1-100", "limits": []any{"$ 100B 100B"}}
	previous, _ := gostTestJSON(t, gostTestConfig("/s", []any{gostTestService("fwx-1-tcp", ":1001")}, []any{gostTestChain("chain-tunnel-2", "10.0.0.2:1")}, []any{limiter}))
	newService := gostTestService("fwx-3-tcp", ":1003")
	newService["handler"] = map[string]any{"type": "tcp", "chain": "chain-egress-3-tcp"}
	newService["limiter"] = "fwx-user-2-host-1-50"
	// 新服务排在旧服务前面：按名字比，不看顺序。
	desired, _ := gostTestJSON(t, gostTestConfig("/s",
		[]any{newService, gostTestService("fwx-1-tcp", ":1001")},
		[]any{gostTestChain("chain-egress-3-tcp", "10.0.0.3:8388"), gostTestChain("chain-tunnel-2", "10.0.0.2:1")},
		[]any{limiter, map[string]any{"name": "fwx-user-2-host-1-50", "limits": []any{"$ 50B 50B"}}}))
	got := gostPlanSteps(mustPlan(t, previous, desired))
	want := []string{"add limiters/fwx-user-2-host-1-50", "add chains/chain-egress-3-tcp", "add services/fwx-3-tcp"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("steps = %v, want %v", got, want)
	}
	// 只是顺序变了：什么都不用做。
	if plan := mustPlan(t, previous, previous); len(plan.steps) != 0 {
		t.Fatalf("no-op plan = %v", gostPlanSteps(plan))
	}
}

func TestGostSyncPlanEditsAndRemovalsRecreateOnlyTheTouchedRule(t *testing.T) {
	sharedLimiter := map[string]any{"name": "fwx-user-1-host-1-100", "limits": []any{"$ 100B 100B"}}
	untouched := gostTestService("fwx-9-tcp", ":1009")
	untouched["limiter"] = "fwx-user-1-host-1-100"
	untouchedUDP := gostTestUDPService("fwx-9-udp", ":1009")
	egress := gostTestService("fwx-3-tcp", ":1003")
	egress["handler"] = map[string]any{"type": "tcp", "chain": "chain-egress-3-tcp"}
	base := func() map[string]any {
		c, _ := gostTestJSON(t, gostTestConfig("/s",
			[]any{untouched, untouchedUDP, gostTestService("fwx-1-tcp", ":1001"), gostTestUDPService("fwx-1-udp", ":1001"), egress, gostTestService("fwx-2-tcp", ":1002")},
			[]any{gostTestChain("chain-egress-3-tcp", "10.0.0.3:8388"), gostTestChain("chain-old", "10.0.0.4:1")},
			[]any{sharedLimiter, map[string]any{"name": "fwx-gone", "limits": []any{"$ 1B 1B"}}}))
		return c
	}
	previous := base()
	services := func(c map[string]any) []any { return c["services"].([]any) }
	find := func(c map[string]any, name string) map[string]any {
		for _, item := range services(c) {
			if item.(map[string]any)["name"] == name {
				return item.(map[string]any)
			}
		}
		t.Fatalf("no service %s", name)
		return nil
	}

	// 改目标（TCP）：删、断这个端口的连接、按新配置建；同端口的 UDP 服务和别的规则都不碰。
	next := base()
	find(next, "fwx-1-tcp")["forwarder"] = map[string]any{"nodes": []any{map[string]any{"name": "target-fwx-1-tcp", "addr": "127.0.0.1:10"}}}
	if got := gostPlanSteps(mustPlan(t, previous, next)); !reflect.DeepEqual(got, []string{"delete services/fwx-1-tcp", "cut [1001]", "add services/fwx-1-tcp"}) {
		t.Fatalf("tcp edit steps = %v", got)
	}
	// 改 UDP 服务：关监听会话就结束，不用断 TCP（同端口的 fwx-1-tcp 不能被误伤）。
	next = base()
	find(next, "fwx-1-udp")["forwarder"] = map[string]any{"nodes": []any{map[string]any{"name": "target-fwx-1-udp", "addr": "127.0.0.1:10"}}}
	if got := gostPlanSteps(mustPlan(t, previous, next)); !reflect.DeepEqual(got, []string{"delete services/fwx-1-udp", "add services/fwx-1-udp"}) {
		t.Fatalf("udp edit steps = %v", got)
	}
	// 删规则（TCP + UDP）+ 删它独用的链和限速器。
	next = base()
	kept := []any{}
	for _, item := range services(next) {
		if name := item.(map[string]any)["name"]; name != "fwx-1-tcp" && name != "fwx-1-udp" {
			kept = append(kept, item)
		}
	}
	next["services"] = kept
	next["chains"] = next["chains"].([]any)[:1]
	next["limiters"] = next["limiters"].([]any)[:1]
	if got := gostPlanSteps(mustPlan(t, previous, next)); !reflect.DeepEqual(got, []string{
		"delete services/fwx-1-tcp", "delete services/fwx-1-udp", "cut [1001]", "delete chains/chain-old", "delete limiters/fwx-gone",
	}) {
		t.Fatalf("removal steps = %v", got)
	}
	// 改出口链（例如换了落地）：引用它的服务先删、断连接，链切换期间没有服务能拿到空链直连目标，再按新配置建回来。
	next = base()
	next["chains"].([]any)[0] = map[string]any{"name": "chain-egress-3-tcp", "hops": []any{map[string]any{"name": "hop-chain-egress-3-tcp", "nodes": []any{map[string]any{"name": "node", "addr": "10.0.0.5:8388"}}}}}
	if got := gostPlanSteps(mustPlan(t, previous, next)); !reflect.DeepEqual(got, []string{
		"delete services/fwx-3-tcp", "cut [1003]", "update chains/chain-egress-3-tcp", "add services/fwx-3-tcp",
	}) {
		t.Fatalf("chain edit steps = %v", got)
	}
	// 只改限速值（共享限速器）：PUT 限速器就行，服务每次读写都现查，不重建、不断连接。
	next = base()
	next["limiters"].([]any)[0] = map[string]any{"name": "fwx-user-1-host-1-100", "limits": []any{"$ 200B 200B"}}
	if got := gostPlanSteps(mustPlan(t, previous, next)); !reflect.DeepEqual(got, []string{"update limiters/fwx-user-1-host-1-100"}) {
		t.Fatalf("limiter edit steps = %v", got)
	}
	// 规则换了限速器（限速值变了，名字带着 Mbps）：新限速器先建、服务重建、旧限速器最后删。
	next = base()
	find(next, "fwx-2-tcp")["limiter"] = "fwx-rule-2-host-1-10"
	next["limiters"] = append(next["limiters"].([]any), map[string]any{"name": "fwx-rule-2-host-1-10", "limits": []any{"$ 10B 10B"}})
	if got := gostPlanSteps(mustPlan(t, previous, next)); !reflect.DeepEqual(got, []string{
		"add limiters/fwx-rule-2-host-1-10", "delete services/fwx-2-tcp", "cut [1002]", "add services/fwx-2-tcp",
	}) {
		t.Fatalf("limiter switch steps = %v", got)
	}
	// 线上坏掉的服务：重建它（不为它重启整个进程）。
	plan, reason, err := planGostSync(previous, previous, map[string]bool{"fwx-2-tcp": true})
	if err != nil || reason != "" || !reflect.DeepEqual(gostPlanSteps(plan), []string{"delete services/fwx-2-tcp", "cut [1002]", "add services/fwx-2-tcp"}) {
		t.Fatalf("unhealthy recreate = %v %q %v", gostPlanSteps(plan), reason, err)
	}
}

func TestGostSyncPlanRestartOnlyCases(t *testing.T) {
	previous, _ := gostTestJSON(t, gostTestConfig("/s", []any{gostTestService("fwx-1-tcp", ":1001"), gostTestService("fwx-2-tcp", "127.0.0.1:1001")}, nil, nil))
	cases := map[string]func(c map[string]any){
		"global-config-changed:api": func(c map[string]any) { c["api"] = map[string]any{"addr": "unix:///tmp/other.sock"} },
		"global-config-changed:log": func(c map[string]any) { c["log"] = map[string]any{"level": "debug"} },
		// gost 没有 NEX 用得上的 API 的集合（这里是独立的 hops）也只能重启。
		"global-config-changed:hops": func(c map[string]any) { c["hops"] = []any{map[string]any{"name": "h"}} },
		// 同一个 TCP 端口上还有没变的服务：断连接会误伤它。
		"connection-cut-port-shared": func(c map[string]any) {
			c["services"].([]any)[0].(map[string]any)["forwarder"] = map[string]any{"nodes": []any{}}
		},
	}
	for want, mutate := range cases {
		next, _ := gostTestJSON(t, previous)
		mutate(next)
		if _, reason, err := planGostSync(previous, next, nil); err != nil || reason != want {
			t.Fatalf("%s: reason=%q err=%v", want, reason, err)
		}
	}
	// 看不懂的监听（这里是 tun）：删它时不知道怎么断它的连接，重启。
	tun := gostTestService("fwx-tun", ":0")
	tun["listener"] = map[string]any{"type": "tun"}
	withTun, _ := gostTestJSON(t, gostTestConfig("/s", []any{tun}, nil, nil))
	without, _ := gostTestJSON(t, gostTestConfig("/s", []any{}, nil, nil))
	if _, reason, _ := planGostSync(withTun, without, nil); reason != "connection-cut-unknown-listener" {
		t.Fatalf("unknown listener reason=%q", reason)
	}
	duplicate, _ := gostTestJSON(t, previous)
	duplicate["services"] = append(duplicate["services"].([]any), gostTestService("fwx-1-tcp", ":1001"))
	if _, _, err := planGostSync(previous, duplicate, nil); err == nil {
		t.Fatal("duplicate service names accepted")
	}
	badName, _ := gostTestJSON(t, previous)
	badName["services"] = append(badName["services"].([]any), gostTestService("../x", ":1001"))
	if _, _, err := planGostSync(previous, badName, nil); err == nil {
		t.Fatal("unsafe service name accepted")
	}
}

func TestGostConfigsEquivalentIgnoresOrderAndLiveStatus(t *testing.T) {
	canonical, _ := gostTestJSON(t, gostTestConfig("/s", []any{gostTestService("a", ":1"), gostTestService("b", ":2")}, nil, nil))
	live, _ := gostTestJSON(t, canonical)
	services := live["services"].([]any)
	services[0], services[1] = services[1], services[0]
	services[0].(map[string]any)["status"] = map[string]any{"state": "ready", "createTime": 1.0}
	if drift, err := gostConfigsEquivalent(live, canonical, true, false); err != nil || drift != "" {
		t.Fatalf("equivalent configs reported drift=%q err=%v", drift, err)
	}
	if len(gostLiveUnhealthyServices(live)) != 0 {
		t.Fatal("ready service reported unhealthy")
	}
	services[1].(map[string]any)["status"] = map[string]any{"state": "failed"}
	if got := gostLiveUnhealthyServices(live); !got["a"] || len(got) != 1 {
		t.Fatalf("failed service not detected: %v", got)
	}
	services[1].(map[string]any)["addr"] = ":3"
	if drift, _ := gostConfigsEquivalent(live, canonical, true, false); drift != "services-content" {
		t.Fatalf("content drift = %q", drift)
	}
	live["services"] = services[:1]
	if drift, _ := gostConfigsEquivalent(live, canonical, true, false); drift != "services-count" {
		t.Fatalf("count drift = %q", drift)
	}
}

func TestGostAPISyncCapability(t *testing.T) {
	nex := gostRuntimeVersionInfo{Version: "3.2.6-nex4", Base: "3.2.6", NexBuild: 4, OK: true}
	official := gostRuntimeVersionInfo{Version: "3.2.6", Base: "3.2.6", OK: true}
	old := gostRuntimeVersionInfo{Version: "3.0.0", Base: "3.0.0", OK: true}
	for _, tc := range []struct {
		agent string
		info  gostRuntimeVersionInfo
		want  bool
	}{
		{"2.2.229", nex, true},
		{"2.2.230", official, true},
		{"2.2.228", nex, false},
		{"2.2.229", old, false},
		{"2.2.229", gostRuntimeVersionInfo{Version: gostRuntimeVersionMissing}, false},
		{"2.2.229", gostRuntimeVersionInfo{Version: gostRuntimeVersionUnknown}, false},
	} {
		if got := gostAPISyncCapable(tc.agent, tc.info); got != tc.want {
			t.Fatalf("gostAPISyncCapable(%s, %s) = %v", tc.agent, tc.info.Version, got)
		}
	}
}

/* ── 假的 gost API：内存里一份配置，POST / PUT / DELETE 改它 ───────────── */

type fakeGostAPI struct {
	mu       sync.Mutex
	config   map[string]any
	failPost map[string]bool
	calls    []string
}

func (f *fakeGostAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	path := strings.TrimPrefix(r.URL.Path, "/config")
	f.calls = append(f.calls, r.Method+" "+path)
	reply := func(status int, body any) {
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(body)
	}
	parts := strings.Split(strings.TrimPrefix(path, "/"), "/")
	indexOf := func(collection, name string) int {
		items, _ := f.config[collection].([]any)
		for i, item := range items {
			if item.(map[string]any)["name"] == name {
				return i
			}
		}
		return -1
	}
	switch {
	case r.Method == http.MethodGet && path == "":
		out, _ := json.Marshal(f.config)
		var live map[string]any
		_ = json.Unmarshal(out, &live)
		if services, ok := live["services"].([]any); ok {
			for _, item := range services {
				item.(map[string]any)["status"] = map[string]any{"state": "ready", "createTime": 1}
			}
		}
		reply(200, live)
	case r.Method == http.MethodPost || r.Method == http.MethodPut:
		var object map[string]any
		if err := json.NewDecoder(r.Body).Decode(&object); err != nil {
			reply(400, map[string]any{"code": 40001})
			return
		}
		name, _ := object["name"].(string)
		if r.Method == http.MethodPut {
			name = parts[1]
		}
		if f.failPost[name] {
			reply(500, map[string]any{"code": 40005, "msg": "create service failed: listen tcp :1: secret=hunter2"})
			return
		}
		i := indexOf(parts[0], name)
		items, _ := f.config[parts[0]].([]any)
		if r.Method == http.MethodPost {
			if i >= 0 {
				reply(400, map[string]any{"code": 40002})
				return
			}
			f.config[parts[0]] = append(items, object)
		} else {
			if i < 0 {
				reply(400, map[string]any{"code": 40004})
				return
			}
			items[i] = object
		}
		reply(200, map[string]any{"msg": "OK"})
	case r.Method == http.MethodDelete:
		i := indexOf(parts[0], parts[1])
		if i < 0 {
			reply(400, map[string]any{"code": 40004})
			return
		}
		items := f.config[parts[0]].([]any)
		f.config[parts[0]] = append(append([]any{}, items[:i]...), items[i+1:]...)
		reply(200, map[string]any{"msg": "OK"})
	default:
		reply(404, map[string]any{"code": 40400})
	}
}

func (f *fakeGostAPI) names(collection string) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	items, _ := f.config[collection].([]any)
	for _, item := range items {
		out = append(out, item.(map[string]any)["name"].(string))
	}
	return out
}

func (f *fakeGostAPI) object(collection, name string) map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	items, _ := f.config[collection].([]any)
	for _, item := range items {
		if item.(map[string]any)["name"] == name {
			return item.(map[string]any)
		}
	}
	return nil
}

func (f *fakeGostAPI) mutations() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, call := range f.calls {
		if !strings.HasPrefix(call, "GET") {
			out = append(out, call)
		}
	}
	return out
}

type gostSyncFixture struct {
	dir    string
	path   string
	socket string
	api    *fakeGostAPI
	target gostAPISyncTarget
	cuts   [][]int
}

// newGostSyncFixture：临时目录里一份「旧配置」、对应的 .sha256、一个假的 API 套接字；规范化直接用 JSON 原样；
// 断连接只记下来。
func newGostSyncFixture(t *testing.T, previous map[string]any) *gostSyncFixture {
	t.Helper()
	dir, err := os.MkdirTemp("", "gost-api-sync-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	f := &gostSyncFixture{dir: dir, path: filepath.Join(dir, "gost.json"), socket: filepath.Join(dir, "api.sock")}
	previous["api"] = map[string]any{"addr": "unix://" + f.socket}
	_, raw := gostTestJSON(t, previous)
	if err := os.WriteFile(f.path, raw, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f.path+".sha256", []byte(gostShellHash(raw)), 0o644); err != nil {
		t.Fatal(err)
	}
	live, _ := gostTestJSON(t, previous)
	f.api = &fakeGostAPI{config: live, failPost: map[string]bool{}}
	listener, err := net.Listen("unix", f.socket)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: f.api}
	go server.Serve(listener)
	t.Cleanup(func() { server.Close() })
	f.target = gostAPISyncTarget{service: "test-runtime", path: f.path, socket: f.socket, binary: "unused"}

	oldCanonical, oldActive, oldVerify, oldHash := canonicalGostConfig, gostAPISyncServiceActive, verifyGostAPISocket, gostShellHashAvailable
	oldCut, oldCutAvailable, oldPID := gostCutConnections, gostConnCutAvailable, gostRuntimePID
	canonicalGostConfig = func(_ string, data []byte) (map[string]any, error) {
		var out map[string]any
		return out, json.Unmarshal(data, &out)
	}
	gostAPISyncServiceActive = func(string) bool { return true }
	verifyGostAPISocket = func(string) error { return nil }
	gostShellHashAvailable = func() bool { return true }
	gostCutConnections = func(pid int, ports []int) (int, error) {
		f.cuts = append(f.cuts, append([]int(nil), ports...))
		return len(ports), nil
	}
	gostConnCutAvailable = func() string { return "test" }
	gostRuntimePID = func(string) (int, error) { return 4242, nil }
	t.Cleanup(func() {
		canonicalGostConfig, gostAPISyncServiceActive, verifyGostAPISocket, gostShellHashAvailable = oldCanonical, oldActive, oldVerify, oldHash
		gostCutConnections, gostConnCutAvailable, gostRuntimePID = oldCut, oldCutAvailable, oldPID
	})
	return f
}

// write 像 applyManagedConfigs 那样写入新配置，返回事务（spec 不带服务名：回滚时不会去重启任何真服务）。
func (f *gostSyncFixture) write(t *testing.T, desired map[string]any) (*managedConfigTransaction, []byte) {
	t.Helper()
	desired["api"] = map[string]any{"addr": "unix://" + f.socket}
	_, raw := gostTestJSON(t, desired)
	tx, err := applyManagedConfigs([]managedConfigSpec{{Path: f.path, Format: "json", ContentBase64: base64.StdEncoding.EncodeToString(raw)}})
	if err != nil {
		t.Fatal(err)
	}
	// 事务按服务名找备份；测试的服务名只在这里补上。回滚时只有 API 恢复失败才会去「重启」它（不存在的服务，无害）。
	for i := range tx.backups {
		tx.backups[i].spec.ServiceName = f.target.service
	}
	return tx, raw
}

func (f *gostSyncFixture) liveEquals(t *testing.T, config map[string]any) {
	t.Helper()
	want, _ := gostTestJSON(t, config)
	want["api"] = map[string]any{"addr": "unix://" + f.socket}
	f.api.mu.Lock()
	live, _ := gostTestJSON(t, f.api.config)
	f.api.mu.Unlock()
	if drift, err := gostConfigsEquivalent(live, want, true, false); err != nil || drift != "" {
		t.Fatalf("live state differs: %q %v", drift, err)
	}
}

func syncTestBase() map[string]any {
	return gostTestConfig("",
		[]any{gostTestService("fwx-1-tcp", ":1001"), gostTestService("fwx-2-tcp", ":1002"), gostTestService("fwx-9-tcp", ":1009")},
		[]any{gostTestChain("chain-a", "10.0.0.1:1")},
		[]any{map[string]any{"name": "fwx-l", "limits": []any{"$ 1B 1B"}}})
}

func TestGostAPISyncAddModifyDeleteAndTransactionRollback(t *testing.T) {
	f := newGostSyncFixture(t, syncTestBase())
	desired := syncTestBase()
	services := desired["services"].([]any)
	services[0].(map[string]any)["addr"] = ":2001"
	// fwx-1 改端口、fwx-2 删掉、fwx-3 新增、fwx-9 不动；限速器改值。
	desired["services"] = []any{services[0], services[2], gostTestService("fwx-3-tcp", ":1003")}
	desired["limiters"] = []any{map[string]any{"name": "fwx-l", "limits": []any{"$ 2B 2B"}}}
	untouchedBefore := f.api.object("services", "fwx-9-tcp")
	tx, raw := f.write(t, desired)
	handled, reason := gostAPISync(f.target, tx)
	if !handled {
		t.Fatalf("api sync not handled reason=%s", reason)
	}
	if got := f.api.mutations(); !reflect.DeepEqual(got, []string{
		"PUT /limiters/fwx-l", "DELETE /services/fwx-2-tcp", "DELETE /services/fwx-1-tcp", "POST /services", "POST /services",
	}) {
		t.Fatalf("mutations = %v", got)
	}
	if !reflect.DeepEqual(f.cuts, [][]int{{1001, 1002}}) {
		t.Fatalf("cuts = %v (only the edited and the deleted rule's ports)", f.cuts)
	}
	if f.api.object("services", "fwx-9-tcp")["addr"] != untouchedBefore["addr"] {
		t.Fatal("untouched rule modified")
	}
	f.liveEquals(t, desired)
	if hash, _ := os.ReadFile(f.path + ".sha256"); string(hash) != gostShellHash(raw) {
		t.Fatalf("hash not updated: %s", hash)
	}
	// 之后的步骤失败、事务回滚：文件回到旧配置，API 把运行状态改回旧配置，不重启。
	if !tx.rollback() {
		t.Fatal("rollback failed")
	}
	f.liveEquals(t, syncTestBase())
	current, _ := os.ReadFile(f.path)
	if hash, _ := os.ReadFile(f.path + ".sha256"); string(hash) != gostShellHash(current) {
		t.Fatal("rollback did not restore the previous runtime hash")
	}
}

func TestGostAPISyncFailureUndoesEveryStepAndForcesRestart(t *testing.T) {
	f := newGostSyncFixture(t, syncTestBase())
	desired := syncTestBase()
	services := desired["services"].([]any)
	services[1].(map[string]any)["addr"] = ":2002" // 改 fwx-2（删了再建，建的时候失败）
	desired["services"] = []any{services[1], services[2], gostTestService("fwx-3-tcp", ":1003")}
	desired["chains"] = []any{gostTestChain("chain-a", "10.0.0.9:1"), gostTestChain("chain-new", "10.0.0.8:1")}
	desired["limiters"] = []any{map[string]any{"name": "fwx-l", "limits": []any{"$ 9B 9B"}}, map[string]any{"name": "fwx-new", "limits": []any{"$ 1B 1B"}}}
	f.api.failPost["fwx-3-tcp"] = true
	tx, _ := f.write(t, desired)
	handled, reason := gostAPISync(f.target, tx)
	if handled || reason != "api-step-failed" {
		t.Fatalf("handled=%v reason=%s", handled, reason)
	}
	// 每一步都撤销了：删掉的 fwx-1 回来了、fwx-2 是旧端口、链和限速器是旧的、新对象都没了。
	f.liveEquals(t, syncTestBase())
	if _, err := os.Stat(f.path + ".sha256"); !os.IsNotExist(err) {
		t.Fatal("hash record kept; the fallback restart would be skipped")
	}
	if tx.backups[0].restoreRuntime != nil {
		t.Fatal("failed sync left an API restore hook")
	}
	tx.commit()
}

func TestGostAPISyncFallsBackWithoutTouchingAPI(t *testing.T) {
	addOne := func() map[string]any {
		c := syncTestBase()
		c["services"] = append(c["services"].([]any), gostTestService("fwx-3-tcp", ":1003"))
		return c
	}
	removeOne := func() map[string]any {
		c := syncTestBase()
		c["services"] = c["services"].([]any)[1:]
		return c
	}
	for _, tc := range []struct {
		name   string
		reason string
		setup  func(f *gostSyncFixture)
		next   func() map[string]any
	}{
		{"global change", "global-config-changed:log", nil, func() map[string]any { c := addOne(); c["log"] = map[string]any{"level": "debug"}; return c }},
		{"unknown runtime hash", "runtime-hash-unknown", func(f *gostSyncFixture) { os.Remove(f.path + ".sha256") }, addOne},
		{"live drift", "live-drift-services-count", func(f *gostSyncFixture) {
			f.api.config["services"] = f.api.config["services"].([]any)[:1]
		}, addOne},
		{"service inactive", "service-inactive", func(*gostSyncFixture) { gostAPISyncServiceActive = func(string) bool { return false } }, addOne},
		{"api unreachable", "api-unavailable", func(f *gostSyncFixture) { os.Remove(f.socket) }, addOne},
		{"no way to cut connections", "connection-cut-unavailable", func(*gostSyncFixture) { gostConnCutAvailable = func() string { return "" } }, removeOne},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newGostSyncFixture(t, syncTestBase())
			if tc.setup != nil {
				tc.setup(f)
			}
			tx, _ := f.write(t, tc.next())
			defer tx.commit()
			handled, reason := gostAPISync(f.target, tx)
			if handled || reason != tc.reason {
				t.Fatalf("handled=%v reason=%s want %s", handled, reason, tc.reason)
			}
			if got := f.api.mutations(); len(got) != 0 {
				t.Fatalf("fallback touched the API: %v", got)
			}
		})
	}
}

func TestGostAPISyncBootstrapAndApiNotConfigured(t *testing.T) {
	f := newGostSyncFixture(t, syncTestBase())
	// 旧配置没有 api 段（刚开能力时的第一次同步）：必须重启，让进程带着 API 起来。
	_, raw := gostTestJSON(t, map[string]any{"services": []any{gostTestService("fwx-1-tcp", ":1001")}})
	if err := os.WriteFile(f.path, raw, 0o644); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(f.path+".sha256", []byte(gostShellHash(raw)), 0o644)
	tx, _ := f.write(t, syncTestBase())
	defer tx.commit()
	if handled, reason := gostAPISync(f.target, tx); handled || reason != "api-not-configured" {
		t.Fatalf("handled=%v reason=%s", handled, reason)
	}
	if handled, reason := gostAPISync(f.target, nil); handled || reason != "bootstrap" {
		t.Fatalf("no transaction: handled=%v reason=%s", handled, reason)
	}
}

func TestRunGostAPISyncCommandsRunsFallbackOnlyWhenNeeded(t *testing.T) {
	f := newGostSyncFixture(t, syncTestBase())
	oldTarget := gostAPISyncTargetFor
	gostAPISyncTargetFor = func(service, path string) (gostAPISyncTarget, bool) {
		if service == f.target.service && path == f.path {
			return f.target, true
		}
		return gostAPISyncTarget{}, false
	}
	defer func() { gostAPISyncTargetFor = oldTarget }()
	marker := filepath.Join(f.dir, "restarted")
	before := filepath.Join(f.dir, "before")
	after := filepath.Join(f.dir, "after")
	commands := func() []string {
		return []string{
			"touch " + shellQuote(before),
			fmt.Sprintf("%s%s %s\ntouch %s", gostAPISyncMarker, f.target.service, f.path, shellQuote(marker)),
			"touch " + shellQuote(after),
		}
	}
	// 删一条规则、加一条规则：都走 API，重启命令不执行。
	next := syncTestBase()
	next["services"] = append(next["services"].([]any)[1:], gostTestService("fwx-3-tcp", ":1003"))
	tx, _ := f.write(t, next)
	if !runGostAPISyncCommands(commands(), tx, &actionMessage{}) {
		t.Fatal("api sync commands failed")
	}
	tx.commit()
	for _, path := range []string{before, after} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("surrounding command not executed: %s", path)
		}
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("restart fallback executed although the change was applied via the API")
	}
	// 全局配置变了：只能重启，执行后面的命令。
	next2, _ := gostTestJSON(t, next)
	next2["log"] = map[string]any{"level": "info"}
	tx, _ = f.write(t, next2)
	if !runGostAPISyncCommands(commands(), tx, &actionMessage{}) {
		t.Fatal("fallback commands failed")
	}
	tx.commit()
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("restart fallback not executed for a global change")
	}
	// 看不懂的标记（路径不对）：照旧执行后面的命令。
	os.Remove(marker)
	bad := []string{fmt.Sprintf("%sforwardx-runtime /tmp/evil.json\ntouch %s", gostAPISyncMarker, shellQuote(marker))}
	if !runGostAPISyncCommands(bad, nil, &actionMessage{}) {
		t.Fatal("fallback for rejected marker failed")
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("rejected marker did not run its fallback")
	}
}

func TestGostAPIErrorsNeverCarryResponseBodies(t *testing.T) {
	f := newGostSyncFixture(t, gostTestConfig("", []any{}, nil, nil))
	f.api.failPost["x"] = true
	plan := gostSyncPlan{steps: []gostAPIStep{{op: gostOpAdd, collection: "services", name: "x", object: gostTestService("x", ":1")}}}
	_, _, err := executeGostSyncPlan(context.Background(), newGostAPIClient(f.socket), plan, 0)
	if err == nil || strings.Contains(err.Error(), "hunter2") || gostAPIErrorCode(err) != 40005 {
		t.Fatalf("err = %v", err)
	}
}

func TestVerifyGostAPISocketRequiresRootOnlyDirectory(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("needs root to own the socket directory")
	}
	dir := t.TempDir()
	socket := filepath.Join(dir, "api.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if verifyGostAPISocket(socket) == nil {
		t.Fatal("group/other-accessible directory accepted")
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := verifyGostAPISocket(socket); err != nil {
		t.Fatalf("root-only socket rejected: %v", err)
	}
	if verifyGostAPISocket(filepath.Join(dir, "missing.sock")) == nil {
		t.Fatal("missing socket accepted")
	}
}

func TestManagedConfigUnchangedGostRuntimeFlag(t *testing.T) {
	if !isSelfContainedGostRuntimeConfig(managedConfigSpec{Path: runtimeConfigPath, ServiceName: runtimeServiceName}) ||
		!isSelfContainedGostRuntimeConfig(managedConfigSpec{Path: tunnelRuntimeConfigPath, ServiceName: tunnelRuntimeServiceName}) {
		t.Fatal("gost runtime configs not recognised")
	}
	if isSelfContainedGostRuntimeConfig(managedConfigSpec{Path: "/etc/forwardx/nginx/nginx.conf", ServiceName: "forwardx-nginx"}) ||
		isSelfContainedGostRuntimeConfig(managedConfigSpec{Path: tunnelRuntimeConfigPath, ServiceName: runtimeServiceName}) {
		t.Fatal("non-gost config treated as self-contained")
	}
}
