package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

/*
gost 共享运行时的不停机同步（思路来自上游 poouo/Forwardx 7c9f142 + 84247e9 的「新增走 API」，
NEX 扩展到新增、修改、删除都走 API，失败语义也按 NEX 的要求改了）。

问题：一台机器上所有 gost 规则共用一个 forwardx-runtime（隧道出口是 forwardx-tunnel-runtime）进程。
以前改任何一条规则，面板重写 gost.json，restartManagedServiceIfConfigChangedCmd 看到哈希变了就重启
进程，这台机器上其它规则的连接全断。

架构不变：面板 → desiredState → 托管的 gost.json（applyManagedConfigs 原样写入）。API 只是在这之上的
优化：每次同步之后运行状态 == gost.json 的内容；做不到就按老办法全量写 + 重启。

面板在能力 gostApiSync（Agent ≥ 2.2.229、运行时 ≥ 3.2.6）的机器上：
  - gost.json 里加 api: {addr: "unix:///run/forwardx-agent/gost-api/<服务>.sock"}，只走 Unix 套接字，
    绝不开 TCP 管理端口；单元的 ExecStart 包一层 sh：建 0700 的目录、删残留套接字、umask 177 后 exec gost，
    所以套接字是 root 的 0600（server/agentActionCommands.ts gostRuntimeApiExecStart）。
  - 重启那条命令前面加一行标记 "# forwardx-gost-api-sync <服务> <配置>"。旧 Agent 把它当注释，照旧执行后面的
    重启命令；新 Agent 先走 API，不行再执行后面那条命令（全量写 + 重启，这是最后的退路）。

比较在 gost 自己解析出来的规范形式上做：`forwardx-runtime -C - -O json` 按重启时完全一样的路径（viper 读
文件：元数据键转小写、时长转纳秒、丢掉不认识的字段）解析后输出。旧配置、新配置各解析一份：
  - services / chains / limiters 三个集合按名字比，得出新增、修改、删除；
  - 其它顶层键（api、log、hops、climiters ……）有任何不同 → 只能重启（gost 没有对应的 API，或 NEX 不用）。
线上状态（GET /config，去掉 status）必须和旧配置的规范形式完全相同，旧配置的哈希必须就是 .sha256 里记的
那份（进程确实是按旧配置起来 / 同步过的），否则说不清进程在跑什么，重启。

执行顺序（每一步先记进回滚日志再发请求：回复丢了也可能已经生效）：
  1. 限速器：POST 新的，PUT 改了的。服务每次读写都按名字现查限速器（registry 的懒包装），
     所以改了的限速对这个限速器下已有的连接立刻生效，和重启后一样，不用动服务。
  2. 删服务：删掉的、改了的、以及引用了改动 / 删除的链的服务，DELETE。
     上游 gost 关服务只关监听，已经接进来的连接按旧配置一直跑下去；删掉 / 停用的规则（例如流量用尽）上的连接
     不断、计数规则也没了 —— 重启时它们是会断的。NEX 运行时 nex5 起（gost-runtime/nex-service-close.patch）
     关服务时连它接进来的连接（TCP 连接、UDP 会话）一起关，别的服务不动，所以 TCP 规则的修改、删除也走 API。
     正在跑的运行时不到 nex5（官方 gost、旧的自编版、刚换了文件还没重启的进程）时，删 / 改 TCP 类服务只能
     重启（connection-close-unsupported）；UDP 服务的监听一关，客户端发来的包就没人收了，会话随之结束，
     所以 UDP 规则的修改、删除在旧运行时上照样走 API。
  3. 链：DELETE 删掉的，PUT 改了的（引用它的服务第 2 步已经删了，切换中间不会有新连接拿到空链直连目标），
     POST 新的。
  4. 服务：POST 新增的和第 2 步删掉的（按新配置重建）。
  5. 限速器：DELETE 删掉的（这时已经没有服务引用它）。
最后再 GET 一次，线上状态必须和新配置的规范形式完全相同，然后把新配置的哈希写进 .sha256（和 shell 一样的
"sha256:<hex>"），重启命令不再执行。

没被改动的规则（服务、它引用的链和限速器都没变）全程不碰：它们的监听、已建立的 TCP 连接、UDP 会话都留着。
被改动 / 删除的规则（nex5）：已有的 TCP 连接被关掉（客户端读到 EOF，上游那条也随即关掉；重连就按新配置走），
同一端口重建期间（通常几毫秒）新连接会被拒；UDP 会话结束、下一个包按新配置建会话。只改了限速值的规则不断连接。

失败（API 不通、请求被拒、核对不一致）：按回滚日志倒序撤销（新加的删掉、改了的 PUT 回旧的、删掉的
POST 回来），再执行后面的全量写 + 重启，gost.json 和运行状态不会分叉。之后的步骤（监听核对）失败、事务回滚时：
配置文件先恢复，再用 API 把运行状态改回旧配置（同样是一次按规范形式的差量同步）；做不到就照旧重启成旧配置。
*/

const (
	gostAPISyncMarker = "# forwardx-gost-api-sync "
	gostAPIDir        = "/run/forwardx-agent/gost-api"
	// 和 shared/gostRuntimeApi.ts 保持一致（scripts/check-versions.mjs 会查）。
	gostAPISyncAgentVersion    = "2.2.229"
	gostAPISyncRuntimeMinBase  = "3.2.6"
	agentCapabilityGostAPISync = "gostApiSync"

	gostAPIResponseLimit = 16 << 20
	gostAPIErrCodeDup    = 40002
	gostAPIErrCodeAbsent = 40004
)

var gostAPIObjectNamePattern = regexp.MustCompile(`^[a-zA-Z0-9_.-]{1,128}$`)

// gost 里可以单独增删改、NEX 也用到的三个集合。
var gostAPICollections = []string{"limiters", "chains", "services"}

// 运行时关服务时会关掉它接进来的连接的最低 NEX 构建号（gost-runtime/nex-service-close.patch）。
const gostServiceCloseMinNexBuild = 5

// 监听在 TCP 上的 gost 监听类型（旧运行时上删 / 改这种服务，已经接进来的连接不会断，只能重启）。
var gostTCPListenerTypes = map[string]bool{
	"": true, "tcp": true, "tls": true, "mtls": true, "ws": true, "wss": true, "mws": true, "mwss": true,
	"mtcp": true, "h2": true, "h2c": true, "http2": true, "grpc": true, "pht": true, "phts": true,
	"ssh": true, "sshd": true, "red": true, "redir": true, "redirect": true, "otls": true, "obfs-http": true, "obfs-tls": true,
}

// 监听在 UDP 上的：关了监听会话就结束，旧运行时上也能走 API。
var gostUDPListenerTypes = map[string]bool{
	"udp": true, "rudp": true, "kcp": true, "quic": true, "h3": true, "wt": true, "dtls": true, "redu": true,
}

func gostAPISocketPath(service string) string {
	return gostAPIDir + "/" + service + ".sock"
}

// gostAPISyncCapable：这台机器能不能用 gost API 同步。只看实测的运行时版本：unix:// 的 API 地址和
// -O json 在 3.2.6 里有（NEX 自编版和官方版同一份 API 代码），更旧的官方版不一定认 unix://，
// 不认的话 gost 会把它当 TCP 地址、起不来。
func gostAPISyncCapable(agentVersion string, info gostRuntimeVersionInfo) bool {
	if !agentVersionAtLeast(agentVersion, gostAPISyncAgentVersion) {
		return false
	}
	return info.OK && compareFXPVersions(info.Base, gostAPISyncRuntimeMinBase) >= 0
}

/* ── API 客户端 ─────────────────────────────────────────────────────── */

type gostAPIClient struct {
	client  *http.Client
	baseURL string
}

type gostAPIError struct{ status, code int }

func (e *gostAPIError) Error() string {
	return fmt.Sprintf("GOST API HTTP=%d code=%d", e.status, e.code)
}

func gostAPIErrorCode(err error) int {
	var apiErr *gostAPIError
	if errors.As(err, &apiErr) {
		return apiErr.code
	}
	return 0
}

func newGostAPIClient(socket string) gostAPIClient {
	transport := &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{Timeout: 3 * time.Second}).DialContext(ctx, "unix", socket)
		},
		DisableKeepAlives: true,
	}
	return gostAPIClient{
		client: &http.Client{Transport: transport, Timeout: 10 * time.Second,
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
		baseURL: "http://gost-api",
	}
}

// 回复正文里可能带着凭据、目标地址（gost 的解析错误会原样带回配置片段），不进日志、不进状态消息。
func (api gostAPIClient) request(ctx context.Context, method, path string, body []byte) ([]byte, error) {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, api.baseURL+"/config"+path, reader)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := api.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("GOST local API unavailable: %w", err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, gostAPIResponseLimit+1))
	if err != nil {
		return nil, err
	}
	if len(data) > gostAPIResponseLimit {
		return nil, fmt.Errorf("GOST API response exceeds limit")
	}
	var envelope struct {
		Code int `json:"code"`
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		_ = json.Unmarshal(data, &envelope)
		return nil, &gostAPIError{resp.StatusCode, envelope.Code}
	}
	if method != http.MethodGet {
		if err := json.Unmarshal(data, &envelope); err != nil {
			return nil, fmt.Errorf("invalid GOST API acknowledgement")
		}
		if envelope.Code != 0 {
			return nil, &gostAPIError{resp.StatusCode, envelope.Code}
		}
	}
	return data, nil
}

func (api gostAPIClient) liveConfig(ctx context.Context) (map[string]any, error) {
	data, err := api.request(ctx, http.MethodGet, "", nil)
	if err != nil {
		return nil, err
	}
	var live map[string]any
	if err := json.Unmarshal(data, &live); err != nil || live == nil {
		return nil, fmt.Errorf("invalid GOST live config")
	}
	return live, nil
}

// verifyGostAPISocket：只和 root 自己的套接字说话 —— 目录是 root 的、组和其他人没有任何权限，
// 套接字本身也是 root 的。不满足就不用 API（走重启），免得对着别人放的假服务端做决定。
var verifyGostAPISocket = func(socket string) error {
	dir := filepath.Dir(socket)
	info, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !info.IsDir() || !ok || st.Uid != 0 || info.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("GOST API directory is not root-only")
	}
	info, err = os.Lstat(socket)
	if err != nil {
		return err
	}
	st, ok = info.Sys().(*syscall.Stat_t)
	if info.Mode()&os.ModeSocket == 0 || !ok || st.Uid != 0 {
		return fmt.Errorf("GOST API socket is not a root-owned socket")
	}
	return nil
}

/* ── 规范形式与比较 ─────────────────────────────────────────────────── */

// canonicalGostConfig 让 gost 自己把配置解析一遍再输出（-O json：解析完就退出，不监听任何端口）。
// 重启时进程读文件走的就是这条路，所以这里拿到的就是重启后的运行状态。
var canonicalGostConfig = func(binary string, data []byte) (map[string]any, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, binary, "-C", "-", "-O", "json")
	cmd.WaitDelay = time.Second
	cmd.Stdin = bytes.NewReader(data)
	// 服务是在干净的环境里跑的：GOST_API / GOST_LOGGER_LEVEL 之类的环境变量会改解析结果，去掉。
	env := make([]string, 0, len(os.Environ()))
	for _, item := range os.Environ() {
		if !strings.HasPrefix(item, "GOST_") {
			env = append(env, item)
		}
	}
	cmd.Env = env
	var stdout bytes.Buffer
	cmd.Stdout = &limitedBuffer{buf: &stdout, limit: gostAPIResponseLimit}
	cmd.Stderr = io.Discard
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("gost config parse failed: %w", err)
	}
	var out map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &out); err != nil || out == nil {
		return nil, fmt.Errorf("gost config parse output invalid")
	}
	return out, nil
}

type limitedBuffer struct {
	buf   *bytes.Buffer
	limit int
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if b.buf.Len()+len(p) > b.limit {
		return 0, fmt.Errorf("output exceeds limit")
	}
	return b.buf.Write(p)
}

// gostNamedObjects 把一个集合按名字建索引。名字不合法或重复就报错（调用方走重启）。
// stripStatus：线上配置里的服务带着运行状态，不是配置的一部分。
func gostNamedObjects(config map[string]any, collection string, stripStatus bool) (map[string]map[string]any, []string, error) {
	result := map[string]map[string]any{}
	order := []string{}
	raw, present := config[collection]
	if !present || raw == nil {
		return result, order, nil
	}
	items, ok := raw.([]any)
	if !ok {
		return nil, nil, fmt.Errorf("invalid GOST %s list", collection)
	}
	for _, item := range items {
		object, ok := item.(map[string]any)
		if !ok {
			return nil, nil, fmt.Errorf("invalid GOST %s object", collection)
		}
		name, _ := object["name"].(string)
		if !gostAPIObjectNamePattern.MatchString(name) || result[name] != nil {
			return nil, nil, fmt.Errorf("invalid or duplicate GOST %s name", collection)
		}
		copy := make(map[string]any, len(object))
		for key, value := range object {
			if stripStatus && collection == "services" && key == "status" {
				continue
			}
			copy[key] = value
		}
		result[name] = copy
		order = append(order, name)
	}
	return result, order, nil
}

func isGostAPICollection(key string) bool {
	for _, collection := range gostAPICollections {
		if key == collection {
			return true
		}
	}
	return false
}

func gostGlobalKeysEqual(a, b map[string]any) (string, bool) {
	keys := map[string]bool{}
	for key := range a {
		keys[key] = true
	}
	for key := range b {
		keys[key] = true
	}
	for key := range keys {
		if !isGostAPICollection(key) && !reflect.DeepEqual(a[key], b[key]) {
			return key, false
		}
	}
	return "", true
}

// gostConfigsEquivalent：两份配置（规范形式或线上状态）是不是同一个运行状态。集合按名字比（顺序无关：
// API 新增的对象排在最后，文件里可能排在中间），其它顶层键逐个完全相同。返回不同的原因，相同时为空。
func gostConfigsEquivalent(a, b map[string]any, stripStatusA, stripStatusB bool) (string, error) {
	if key, ok := gostGlobalKeysEqual(a, b); !ok {
		return "global-" + key, nil
	}
	for _, collection := range gostAPICollections {
		left, _, err := gostNamedObjects(a, collection, stripStatusA)
		if err != nil {
			return "", err
		}
		right, _, err := gostNamedObjects(b, collection, stripStatusB)
		if err != nil {
			return "", err
		}
		if len(left) != len(right) {
			return collection + "-count", nil
		}
		for name, object := range left {
			other, ok := right[name]
			if !ok || !reflect.DeepEqual(object, other) {
				return collection + "-content", nil
			}
		}
	}
	return "", nil
}

// gostLiveUnhealthyServices：线上没起来（failed）或已关闭（closed）的服务名。
func gostLiveUnhealthyServices(live map[string]any) map[string]bool {
	out := map[string]bool{}
	services, _ := live["services"].([]any)
	for _, item := range services {
		service, _ := item.(map[string]any)
		status, _ := service["status"].(map[string]any)
		if state, _ := status["state"].(string); state == "closed" || state == "failed" {
			name, _ := service["name"].(string)
			out[name] = true
		}
	}
	return out
}

// gostObjectMentions：对象里有没有哪个字符串值等于 names 里的名字（服务、链按名字引用链）。宁可多算：
// 多算只是多重建一条规则，少算会让服务在链切换的空档里拿到空链。
func gostObjectMentions(value any, names map[string]bool) bool {
	switch v := value.(type) {
	case string:
		return names[v]
	case map[string]any:
		for key, item := range v {
			if key == "name" {
				continue
			}
			if gostObjectMentions(item, names) {
				return true
			}
		}
	case []any:
		for _, item := range v {
			if gostObjectMentions(item, names) {
				return true
			}
		}
	}
	return false
}

// gostServiceListenerKind：服务的监听是 UDP 类（udp=true）、TCP 类（udp=false），还是看不懂（known=false）。
func gostServiceListenerKind(service map[string]any) (udp bool, known bool) {
	listener, _ := service["listener"].(map[string]any)
	kind, _ := listener["type"].(string)
	kind = strings.ToLower(strings.TrimSpace(kind))
	switch {
	case gostTCPListenerTypes[kind]:
		return false, true
	case gostUDPListenerTypes[kind]:
		return true, true
	}
	return false, false
}

/* ── 计划 ───────────────────────────────────────────────────────────── */

const (
	gostOpAdd    = "add"
	gostOpUpdate = "update"
	gostOpDelete = "delete"
)

type gostAPIStep struct {
	op               string
	collection, name string
	object           map[string]any // add / update：新的对象
	previous         map[string]any // update / delete：旧的对象（回滚用）
}

type gostSyncPlan struct {
	steps []gostAPIStep
	// 计数，只用于日志。
	added, updated, deleted, recreated int
	// closedServices：删掉 / 重建的服务（它们已有的连接随服务关掉）。
	closedServices []string
}

func (p gostSyncPlan) summary() string {
	return fmt.Sprintf("added=%d updated=%d deleted=%d recreatedServices=%d closedServices=%v", p.added, p.updated, p.deleted, p.recreated, p.closedServices)
}

func sortedNames(set map[string]bool) []string {
	out := make([]string, 0, len(set))
	for name := range set {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

// planGostSync 比较旧、新两份规范形式，排出 API 步骤（见文件开头的顺序）。reason 不为空表示只能重启。
// recreate：线上 failed / closed 的服务（重建一次让它重新监听，不用为它重启整个进程）。
// closesConns：正在跑的运行时关服务时会关掉它的连接（nex5 起）；否则删 / 改 TCP 类服务只能重启。
func planGostSync(previous, desired map[string]any, recreate map[string]bool, closesConns bool) (gostSyncPlan, string, error) {
	var plan gostSyncPlan
	if key, ok := gostGlobalKeysEqual(previous, desired); !ok {
		return plan, "global-config-changed:" + key, nil
	}
	old := map[string]map[string]map[string]any{}
	next := map[string]map[string]map[string]any{}
	order := map[string][]string{}
	for _, collection := range gostAPICollections {
		var err error
		if old[collection], _, err = gostNamedObjects(previous, collection, false); err != nil {
			return plan, "", err
		}
		if next[collection], order[collection], err = gostNamedObjects(desired, collection, false); err != nil {
			return plan, "", err
		}
	}
	diff := func(collection string) (added, changed, removed map[string]bool) {
		added, changed, removed = map[string]bool{}, map[string]bool{}, map[string]bool{}
		for name, object := range old[collection] {
			if replacement, ok := next[collection][name]; !ok {
				removed[name] = true
			} else if !reflect.DeepEqual(object, replacement) {
				changed[name] = true
			}
		}
		for name := range next[collection] {
			if old[collection][name] == nil {
				added[name] = true
			}
		}
		return
	}
	limAdded, limChanged, limRemoved := diff("limiters")
	chainAdded, chainChanged, chainRemoved := diff("chains")
	svcAdded, svcChanged, svcRemoved := diff("services")

	// 引用了改动 / 删除的链的链也算改动（链里引用链；NEX 目前没有，按名字兜底）。
	touchedChains := map[string]bool{}
	for name := range chainChanged {
		touchedChains[name] = true
	}
	for name := range chainRemoved {
		touchedChains[name] = true
	}
	for grew := true; grew; {
		grew = false
		for name, object := range next["chains"] {
			if old["chains"][name] != nil && !touchedChains[name] && gostObjectMentions(object, touchedChains) {
				chainChanged[name], touchedChains[name], grew = true, true, true
			}
		}
	}
	// 要重建的服务：内容变了的、引用了改动 / 删除的链的、线上坏掉的。
	rebuild := map[string]bool{}
	for name := range svcChanged {
		rebuild[name] = true
	}
	for name, object := range old["services"] {
		if next["services"][name] == nil {
			continue
		}
		if gostObjectMentions(object, touchedChains) || gostObjectMentions(next["services"][name], touchedChains) || recreate[name] {
			rebuild[name] = true
		}
	}
	plan.recreated = len(rebuild)

	// 要关掉的服务（删掉的 + 重建的）：它们已有的连接必须和重启时一样断开。
	closing := append(sortedNames(svcRemoved), sortedNames(rebuild)...)
	plan.closedServices = closing
	if !closesConns {
		for _, name := range closing {
			udp, known := gostServiceListenerKind(old["services"][name])
			if !known || !udp {
				return plan, "connection-close-unsupported", nil
			}
		}
	}

	add := func(collection, name string) {
		plan.steps = append(plan.steps, gostAPIStep{op: gostOpAdd, collection: collection, name: name, object: next[collection][name]})
	}
	update := func(collection, name string) {
		plan.steps = append(plan.steps, gostAPIStep{op: gostOpUpdate, collection: collection, name: name, object: next[collection][name], previous: old[collection][name]})
	}
	remove := func(collection, name string) {
		plan.steps = append(plan.steps, gostAPIStep{op: gostOpDelete, collection: collection, name: name, previous: old[collection][name]})
	}
	inDesiredOrder := func(collection string, set map[string]bool) []string {
		out := []string{}
		for _, name := range order[collection] {
			if set[name] {
				out = append(out, name)
			}
		}
		return out
	}
	// 1. 限速器
	for _, name := range inDesiredOrder("limiters", limAdded) {
		add("limiters", name)
	}
	for _, name := range inDesiredOrder("limiters", limChanged) {
		update("limiters", name)
	}
	// 2. 删服务（删掉的 + 要重建的）
	for _, name := range append(sortedNames(svcRemoved), inDesiredOrder("services", rebuild)...) {
		remove("services", name)
	}
	// 3. 链
	for _, name := range sortedNames(chainRemoved) {
		remove("chains", name)
	}
	for _, name := range inDesiredOrder("chains", chainChanged) {
		update("chains", name)
	}
	for _, name := range inDesiredOrder("chains", chainAdded) {
		add("chains", name)
	}
	// 4. 服务（新增的 + 重建的，按新配置的顺序）
	recreateOrAdd := map[string]bool{}
	for name := range svcAdded {
		recreateOrAdd[name] = true
	}
	for name := range rebuild {
		recreateOrAdd[name] = true
	}
	for _, name := range inDesiredOrder("services", recreateOrAdd) {
		add("services", name)
	}
	// 5. 删限速器
	for _, name := range sortedNames(limRemoved) {
		remove("limiters", name)
	}
	plan.added = len(limAdded) + len(chainAdded) + len(svcAdded)
	plan.updated = len(limChanged) + len(chainChanged) + len(svcChanged)
	plan.deleted = len(limRemoved) + len(chainRemoved) + len(svcRemoved)
	return plan, "", nil
}

/* ── 执行与回滚 ─────────────────────────────────────────────────────── */

// gostRuntimeClosesConns：正在跑的这个运行时进程关服务时会不会关掉它的连接（NEX 构建号 ≥ 5）。
// 看的是进程，不只是文件：/proc/<pid>/exe 必须就是装着的那个文件（换了文件还没重启时链接会带 "(deleted)"），
// 再按文件的 `-V` 结果（和能力上报同一份缓存）判断构建号。说不清就当不支持（删 / 改 TCP 规则走重启）。
var gostRuntimeClosesConns = func(target gostAPISyncTarget) bool {
	pid := managedServiceMainPID(target.service)
	if pid <= 0 {
		return false
	}
	exe, err := os.Readlink(fmt.Sprintf("/proc/%d/exe", pid))
	if err != nil || exe != target.binary {
		return false
	}
	info, _ := installedGostRuntimeVersion(target.binary)
	return info.OK && info.NexBuild >= gostServiceCloseMinNexBuild
}

// managedServiceMainPID：托管服务的主进程。systemd 问 MainPID；OpenRC / SysV 读面板写的脚本里的 pidfile
// （/run/<服务>.pid）。ExecStart 的 sh 是 exec 过去的，主进程就是 gost 本身。
func managedServiceMainPID(name string) int {
	name = sanitizeServiceName(name)
	if name == "" {
		return 0
	}
	if isSystemdHost() {
		out, err := commandCombinedOutputWithTimeout(10*time.Second, "systemctl", "show", "-p", "MainPID", "--value", name+".service")
		if err != nil {
			return 0
		}
		pid, _ := strconv.Atoi(strings.TrimSpace(string(out)))
		return pid
	}
	raw, err := os.ReadFile("/run/" + name + ".pid")
	if err != nil {
		return 0
	}
	pid, _ := strconv.Atoi(strings.TrimSpace(string(raw)))
	return pid
}

func marshalGostObject(object map[string]any) ([]byte, error) {
	return json.Marshal(object)
}

// executeGostSyncPlan 按顺序执行。返回的日志是「可能已经生效」的步骤（发请求之前就记上：回复丢了也可能已经
// 生效），回滚就按它倒序撤销。gost 说「已存在」的新增不是这次建的，不记，回滚也不删它。
func executeGostSyncPlan(ctx context.Context, api gostAPIClient, plan gostSyncPlan) ([]gostAPIStep, error) {
	journal := make([]gostAPIStep, 0, len(plan.steps))
	for _, step := range plan.steps {
		var err error
		stepStarted := time.Now()
		switch step.op {
		case gostOpAdd:
			var body []byte
			if body, err = marshalGostObject(step.object); err != nil {
				return journal, err
			}
			journal = append(journal, step)
			if _, err = api.request(ctx, http.MethodPost, "/"+step.collection, body); err != nil && gostAPIErrorCode(err) == gostAPIErrCodeDup {
				journal = journal[:len(journal)-1]
			}
		case gostOpUpdate:
			var body []byte
			if body, err = marshalGostObject(step.object); err != nil {
				return journal, err
			}
			journal = append(journal, step)
			_, err = api.request(ctx, http.MethodPut, "/"+step.collection+"/"+step.name, body)
		case gostOpDelete:
			journal = append(journal, step)
			_, err = api.request(ctx, http.MethodDelete, "/"+step.collection+"/"+step.name, nil)
		}
		if elapsed := time.Since(stepStarted); elapsed > 500*time.Millisecond {
			logf("gost api sync slow step op=%s collection=%s name=%s duration=%s", step.op, step.collection, step.name, elapsed.Round(time.Millisecond))
		}
		if err != nil {
			return journal, fmt.Errorf("%s %s/%s: %w", step.op, step.collection, step.name, err)
		}
	}
	return journal, nil
}

// rollbackGostSteps 倒序撤销：新加的删掉，改了的 PUT 回旧的，删掉的 POST 回来。随服务关掉的连接没法恢复（它们
// 本来就在被改动的规则上）。全部撤销成功才返回 true。
func rollbackGostSteps(api gostAPIClient, journal []gostAPIStep) bool {
	if len(journal) == 0 {
		return true
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	ok := true
	for i := len(journal) - 1; i >= 0; i-- {
		step := journal[i]
		var err error
		switch step.op {
		case gostOpAdd:
			_, err = api.request(ctx, http.MethodDelete, "/"+step.collection+"/"+step.name, nil)
			if gostAPIErrorCode(err) == gostAPIErrCodeAbsent {
				err = nil
			}
		case gostOpUpdate:
			var body []byte
			if body, err = marshalGostObject(step.previous); err == nil {
				_, err = api.request(ctx, http.MethodPut, "/"+step.collection+"/"+step.name, body)
			}
		case gostOpDelete:
			var body []byte
			if body, err = marshalGostObject(step.previous); err == nil {
				_, err = api.request(ctx, http.MethodPost, "/"+step.collection, body)
				if gostAPIErrorCode(err) == gostAPIErrCodeDup {
					err = nil
				}
			}
		}
		if err != nil {
			ok = false
			logf("gost api rollback failed op=%s collection=%s name=%s error=%v", step.op, step.collection, step.name, err)
		}
	}
	logf("gost api rollback steps=%d ok=%v", len(journal), ok)
	return ok
}

/* ── 一次同步 ───────────────────────────────────────────────────────── */

type gostAPISyncTarget struct {
	service string
	path    string
	socket  string
	binary  string
}

// gostAPISyncTargetFor 只认两个共享运行时和它们固定的配置路径、固定的套接字（测试里换成临时目录）。
var gostAPISyncTargetFor = func(service, path string) (gostAPISyncTarget, bool) {
	if !((service == runtimeServiceName && path == runtimeConfigPath) || (service == tunnelRuntimeServiceName && path == tunnelRuntimeConfigPath)) {
		return gostAPISyncTarget{}, false
	}
	return gostAPISyncTarget{service: service, path: path, socket: gostAPISocketPath(service), binary: gostRuntimeBinaryPath}, true
}

var gostAPISyncServiceActive = managedServiceActive

// gostShellHashAvailable：shell 那条重启命令有 sha256sum 时记 "sha256:<hex>"，没有就记 cksum。
// 我们只会写前一种；没有 sha256sum 的机器不走 API（否则下次 shell 算出来的哈希对不上，又会重启一次）。
var gostShellHashAvailable = func() bool {
	path := mergeShellPath(os.Getenv("PATH"), shellStandardPath)
	for _, dir := range strings.Split(path, ":") {
		if dir == "" {
			continue
		}
		if info, err := os.Stat(filepath.Join(dir, "sha256sum")); err == nil && !info.IsDir() && info.Mode()&0o111 != 0 {
			return true
		}
	}
	return false
}

func gostShellHash(data []byte) string {
	return fmt.Sprintf("sha256:%x", sha256.Sum256(data))
}

func gostAPIAddr(config map[string]any) string {
	api, _ := config["api"].(map[string]any)
	addr, _ := api["addr"].(string)
	return addr
}

func findManagedConfigBackup(tx *managedConfigTransaction, path, service string) *managedConfigBackup {
	if tx == nil {
		return nil
	}
	for i := range tx.backups {
		if tx.backups[i].spec.Path == path && strings.TrimSpace(tx.backups[i].spec.ServiceName) == service {
			return &tx.backups[i]
		}
	}
	return nil
}

// gostAPIApply 把运行状态从 fromData（必须就是现在在跑的配置）改成 toData：规划、核对线上状态、执行、再核对。
// 成功返回 ""；失败返回原因，这时已经按日志撤销过（mutated 表示撤销前确实改过运行状态）。
func gostAPIApply(target gostAPISyncTarget, fromData, toData []byte) (plan gostSyncPlan, reason string, mutated bool) {
	from, err := canonicalGostConfig(target.binary, fromData)
	if err != nil {
		return plan, "parse-previous", false
	}
	to, err := canonicalGostConfig(target.binary, toData)
	if err != nil {
		return plan, "parse-desired", false
	}
	api := newGostAPIClient(target.socket)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	live, err := api.liveConfig(ctx)
	if err != nil {
		return plan, "api-unavailable", false
	}
	if drift, err := gostConfigsEquivalent(live, from, true, false); err != nil || drift != "" {
		return plan, "live-drift-" + drift, false
	}
	plan, reason, err = planGostSync(from, to, gostLiveUnhealthyServices(live), gostRuntimeClosesConns(target))
	if err != nil {
		return plan, "plan-invalid", false
	}
	if reason != "" {
		return plan, reason, false
	}
	journal, err := executeGostSyncPlan(ctx, api, plan)
	failure := ""
	if err != nil {
		logf("gost api sync step failed service=%s error=%v", target.service, err)
		failure = "api-step-failed"
	} else if live, err = api.liveConfig(ctx); err != nil {
		failure = "api-verify-unavailable"
	} else if unhealthy := gostLiveUnhealthyServices(live); len(unhealthy) > 0 {
		failure = "verify-unhealthy-listener"
	} else if drift, err := gostConfigsEquivalent(live, to, true, false); err != nil || drift != "" {
		failure = "verify-mismatch-" + drift
	}
	if failure != "" {
		rollbackGostSteps(api, journal)
		return plan, failure, len(journal) > 0
	}
	return plan, "", len(journal) > 0
}

// gostAPISync 返回 true 表示已经通过 API 同步好（运行状态 == 新配置），重启命令不用再跑；
// 返回 false 表示要执行后面的全量写 + 重启（这时这次通过 API 做的改动已经撤销了）。reason 只用于日志。
// 没有旧配置（首次）、旧配置没开 API、记录的哈希对不上、服务没在跑：这些是正常的「需要重启」，不是 API 失败。
func gostAPISync(target gostAPISyncTarget, tx *managedConfigTransaction) (bool, string) {
	backup := findManagedConfigBackup(tx, target.path, target.service)
	if backup == nil || !backup.hadPrevious {
		return false, "bootstrap"
	}
	desiredData, err := os.ReadFile(target.path)
	if err != nil {
		return false, "read-config"
	}
	if bytes.Equal(desiredData, backup.previous) {
		// 配置没变：交给 shell（没在跑就拉起来，在跑就什么都不做）。
		return false, "unchanged"
	}
	// 便宜的条件先查：都满足了才去跑 gost 解析、连 API。
	var previousRaw, desiredRaw map[string]any
	if json.Unmarshal(backup.previous, &previousRaw) != nil || json.Unmarshal(desiredData, &desiredRaw) != nil {
		return false, "invalid-json"
	}
	wantAddr := "unix://" + target.socket
	if gostAPIAddr(previousRaw) != wantAddr || gostAPIAddr(desiredRaw) != wantAddr {
		return false, "api-not-configured"
	}
	recorded, err := os.ReadFile(target.path + ".sha256")
	if err != nil || strings.TrimSpace(string(recorded)) != gostShellHash(backup.previous) {
		// 没有记录（首次、DNS 刷新、上次回滚）或者记的不是旧配置：说不清进程按哪份配置在跑，重启。
		return false, "runtime-hash-unknown"
	}
	if !gostShellHashAvailable() {
		return false, "no-sha256sum"
	}
	if !gostAPISyncServiceActive(target.service) {
		return false, "service-inactive"
	}
	if err := verifyGostAPISocket(target.socket); err != nil {
		return false, "api-socket-unsafe"
	}
	started := time.Now()
	plan, reason, _ := gostAPIApply(target, backup.previous, desiredData)
	if reason == "" {
		if err := writeManagedConfigAtomic(target.path+".sha256", []byte(gostShellHash(desiredData)), 0644); err != nil {
			// 运行状态已经是新配置了；记不下哈希只会让后面的重启命令多重启一次，状态不会分叉。
			reason = "write-hash"
		}
	}
	if reason != "" {
		// 后面的重启必须真的重启：清掉哈希记录。
		_ = os.Remove(target.path + ".sha256")
		return false, reason
	}
	// 之后的步骤失败、事务回滚时：配置文件恢复成旧的，再用 API 把运行状态改回旧配置；做不到就重启成旧配置。
	previous := append([]byte(nil), backup.previous...)
	tx.setRuntimeRestore(target.path, func() bool {
		_, reason, _ := gostAPIApply(target, desiredData, previous)
		if reason != "" {
			logf("gost api rollback to previous config failed service=%s reason=%s", target.service, reason)
		}
		return reason == ""
	})
	logf("gost runtime api sync service=%s %s duration=%s; untouched rules kept running",
		target.service, plan.summary(), time.Since(started).Round(time.Millisecond))
	return true, ""
}

// runGostAPISyncCommands 执行 gost-runtime-sync 的命令：遇到标记行就先走 API，不行再跑标记后面那条
// 全量写 + 重启的命令。其它命令照旧成批执行，语义和 runShellBatch 一样（全部执行、汇总成败）。
func runGostAPISyncCommands(commands []string, tx *managedConfigTransaction, message *actionMessage) bool {
	ok := true
	var pending []string
	flush := func() {
		if len(pending) > 0 {
			ok = runShellBatch(pending) && ok
			pending = nil
		}
	}
	for _, command := range commands {
		if !strings.HasPrefix(command, gostAPISyncMarker) {
			pending = append(pending, command)
			continue
		}
		flush()
		line, fallback, _ := strings.Cut(command, "\n")
		fields := strings.Fields(strings.TrimPrefix(line, gostAPISyncMarker))
		target, valid := gostAPISyncTarget{}, false
		if len(fields) == 2 {
			target, valid = gostAPISyncTargetFor(fields[0], fields[1])
		}
		if !valid {
			// 看不懂的标记：只执行后面的命令（就是旧 Agent 的行为）。
			logf("gost api sync marker rejected; using restart path")
			ok = runShell(fallback) && ok
			continue
		}
		handled, reason := gostAPISync(target, tx)
		if handled {
			continue
		}
		switch reason {
		case "unchanged":
		case "bootstrap", "api-not-configured", "runtime-hash-unknown", "service-inactive":
			logf("gost runtime restart service=%s reason=%s", target.service, reason)
		default:
			// 最后的退路：API 做不了或者失败了（已撤销），整进程重启，这台机器上的连接都会断。
			logf("gost runtime FULL RESTART (last-resort fallback) service=%s reason=%s", target.service, reason)
		}
		// 后面这次全量写 + 重启要是失败，事务回滚得按老办法恢复（重启成旧配置），不能再走 API。
		tx.setRuntimeRestore(target.path, nil)
		if !runShell(fallback) {
			ok = false
			if message != nil {
				message.set("gost runtime restart failed service=%s", target.service)
			}
		}
	}
	flush()
	return ok
}

func hasGostAPISyncMarker(commands []string) bool {
	for _, command := range commands {
		if strings.HasPrefix(command, gostAPISyncMarker) {
			return true
		}
	}
	return false
}
