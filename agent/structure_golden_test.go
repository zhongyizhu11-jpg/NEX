package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	mathrand "math/rand"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

/*
结构整理（2.3.521 之后那次「只改结构、不改行为」）的对照测试。

整理之前先把下面这些录进 testdata/structure_golden.json，之后每一步都必须逐字节一致：

  - 签名：failoverSignature、actionCommandSignature、managedServiceActionSignature、failoverSpecSignatureJSON；
  - 落盘：persistFailoverSpec 写出去的文件内容（逐字节）；
  - 规整：normalizeFailoverSpec / stripFailoverRelayHints 之后规格的样子（按键排序的规范 JSON，和结构体里字段
    排在哪儿无关），以及每条目标上运行时提示的值；
  - 解码：面板发来的规格 JSON 解出来的样子，和据此算出的签名；
  - 选路：一组固定规格和状态下，各种 hashKey / exclude / TCP·UDP 组合连续挑的结果，挑完以后的轮转计数、
    「按权重」的计数，以及随机数又往下走到了哪（用掉几个、顺序不同都会变）；
  - 主备切换：updateFallbackActiveAtLocked 之后在走哪条、发了哪些事件；
  - 运行时提示：applyRelayHintsLocked 换上提示以后规格里的值、中转异常状态和事件。

时间一律用固定值；随机数换成固定种子（newFailoverRand 用当前时间做种子，测试里预先塞一个）。

确实改了行为、需要重录时：FORWARDX_UPDATE_STRUCTURE_GOLDEN=1 go test -run TestStructureGolden .
*/

type structureGoldenRecord struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type structureGoldenRecorder struct {
	t       *testing.T
	records []structureGoldenRecord
	// 每条的完整值（records 里长的只存摘要），对不上时打出来看。
	full []string
}

// 长的值（规整后的规格、落盘内容、一串切换步骤）只存摘要和开头一段，对照文件不至于太大；对不上时测试会把
// 现在的完整值打出来，录的那份要看全文就在整理前的提交上重录一遍。
const structureGoldenInlineMax = 300

func structureGoldenValue(value string) string {
	if len(value) <= structureGoldenInlineMax {
		return value
	}
	sum := sha256.Sum256([]byte(value))
	head := value
	if len(head) > 40 {
		head = head[:40]
	}
	return fmt.Sprintf("sha256=%s len=%d head=%q", hex.EncodeToString(sum[:16]), len(value), head)
}

func (r *structureGoldenRecorder) add(name string, value string) {
	r.records = append(r.records, structureGoldenRecord{Name: name, Value: structureGoldenValue(value)})
	r.full = append(r.full, value)
}

// 按键排序的规范 JSON：只看有哪些字段、各是什么值，不看结构体里字段的先后。数字原样保留（UseNumber）。
func (r *structureGoldenRecorder) canonical(value any) string {
	r.t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		r.t.Fatalf("marshal: %v", err)
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var generic any
	if err := decoder.Decode(&generic); err != nil {
		r.t.Fatalf("decode: %v", err)
	}
	out, err := json.Marshal(generic)
	if err != nil {
		r.t.Fatalf("marshal canonical: %v", err)
	}
	return string(out)
}

// 每条目标上运行时提示的值（按字段名逐个取，和这些字段放在哪个结构体里无关）。
func structureHintDump(targets []failoverTarget) string {
	if targets == nil {
		return "<nil>"
	}
	parts := make([]string, 0, len(targets))
	for _, target := range targets {
		parts = append(parts, fmt.Sprintf("%t/%q/%d/%d/%q", target.Down, target.DownReason, target.ExtraLatencyMs, target.LoadPct, target.ExitIP))
	}
	return "[" + strings.Join(parts, " ") + "]"
}

func structureIntPtr(value int) *int { return &value }

func structureTargets(count int) []failoverTarget {
	targets := make([]failoverTarget, 0, count)
	for i := 0; i < count; i++ {
		targets = append(targets, failoverTarget{TargetIP: "10.20.0." + strconv.Itoa(i+1), TargetPort: 8000 + i, Weight: i%3 + 1})
	}
	return targets
}

func structureBaseSpec(strategy, protocol string, targets int) failoverSpec {
	return failoverSpec{
		Enabled: true, ListenPort: 65040, BindAddress: "127.0.0.1", Protocol: protocol, Strategy: strategy,
		Targets: structureTargets(targets), FailoverSeconds: 30, RecoverSeconds: 90, AutoFailback: true,
	}
}

type structureSpecCase struct {
	name string
	spec failoverSpec
}

func structureSpecCases() []structureSpecCase {
	cases := []structureSpecCase{}
	add := func(name string, spec failoverSpec) {
		cases = append(cases, structureSpecCase{name: name, spec: spec})
	}
	for _, strategy := range []string{"fallback", "weighted", "least_load", "auto", "round_robin", "random", "ip_hash", "", " auto ", "bogus"} {
		for _, protocol := range []string{"tcp", "udp", "both", ""} {
			add("strategy="+strategy+"/protocol="+protocol, structureBaseSpec(strategy, protocol, 3))
		}
	}
	with := func(name string, mutate func(spec *failoverSpec)) {
		spec := structureBaseSpec("fallback", "both", 4)
		mutate(&spec)
		add(name, spec)
	}
	with("tier/all", func(spec *failoverSpec) {
		for i := range spec.Targets {
			spec.Targets[i].Tier = structureIntPtr(i / 2)
		}
	})
	with("tier/partial", func(spec *failoverSpec) { spec.Targets[0].Tier = structureIntPtr(0) })
	with("tier/negative", func(spec *failoverSpec) {
		for i := range spec.Targets {
			spec.Targets[i].Tier = structureIntPtr(i - 1)
		}
	})
	for _, spread := range []string{"least_load", "round_robin", "random", "ip_hash", "auto", "bogus", ""} {
		spread := spread
		with("line/spread="+spread, func(spec *failoverSpec) {
			landings := []string{"A", " B ", "A"}
			for i := 0; i < 3; i++ {
				spec.Targets[i].Line = structureIntPtr(0)
				spec.Targets[i].Landing = landings[i]
				spec.Targets[i].Spread = " " + spread
			}
		})
	}
	with("line/negative", func(spec *failoverSpec) {
		spec.Targets[0].Line = structureIntPtr(-1)
		spec.Targets[0].Spread = "least_load"
		spec.Targets[0].Landing = "A"
	})
	with("line/missing", func(spec *failoverSpec) {
		spec.Targets[1].Spread = "least_load"
		spec.Targets[1].Landing = "B"
	})
	with("pin/forever", func(spec *failoverSpec) { spec.PinnedIndex = structureIntPtr(1) })
	with("pin/until", func(spec *failoverSpec) {
		spec.PinnedIndex = structureIntPtr(2)
		spec.PinnedUntil = 1893456000000
	})
	with("pin/out-of-range", func(spec *failoverSpec) {
		spec.PinnedIndex = structureIntPtr(9)
		spec.PinnedUntil = 5
	})
	with("pin/negative", func(spec *failoverSpec) { spec.PinnedIndex = structureIntPtr(-1) })
	with("pin/until-without-index", func(spec *failoverSpec) { spec.PinnedUntil = 5 })
	with("schedule/valid", func(spec *failoverSpec) {
		spec.Schedule = &failoverSchedule{Timezone: "Asia/Shanghai", Windows: []failoverScheduleWindow{
			{Days: []int{1, 2, 3, 4, 5}, From: "18:00", To: "23:00", TargetIndex: 1},
			{Days: nil, From: "23:00", To: "02:00", TargetIndex: 2},
			{Days: []int{0, 1, 2, 3, 4, 5, 6}, From: "08:00", To: "09:00", TargetIndex: 3},
		}}
	})
	with("schedule/invalid-windows", func(spec *failoverSpec) {
		spec.Schedule = &failoverSchedule{Timezone: "UTC", Windows: []failoverScheduleWindow{
			{From: "10:00", To: "10:00", TargetIndex: 1},
			{From: "25:00", To: "26:00", TargetIndex: 1},
			{From: "10:00", To: "11:00", TargetIndex: -1},
			{Days: []int{9, 1, 1}, From: "12:00", To: "13:00", TargetIndex: 2},
		}}
	})
	with("schedule/no-timezone", func(spec *failoverSpec) {
		spec.Schedule = &failoverSchedule{Windows: []failoverScheduleWindow{{From: "10:00", To: "11:00", TargetIndex: 1}}}
	})
	with("schedule/bad-timezone", func(spec *failoverSpec) {
		spec.Schedule = &failoverSchedule{Timezone: "Mars/Olympus", Windows: []failoverScheduleWindow{{From: "10:00", To: "11:00", TargetIndex: 1}}}
	})
	with("probe/mixed", func(spec *failoverSpec) {
		spec.Targets[0].ProbeIP = " 10.9.9.9 "
		spec.Targets[0].ProbePort = 80
		spec.Targets[1].ProbeIP = "10.9.9.8"
		spec.Targets[2].ProbePort = 81
		spec.Targets[3].ProbeIP = "10.9.9.7"
		spec.Targets[3].ProbePort = 70000
	})
	with("probe/udp-echo", func(spec *failoverSpec) {
		spec.Targets[0].ProbeUdpEcho = true
		spec.Targets[2].ProbeUdpEcho = true
	})
	with("weights", func(spec *failoverSpec) {
		for i, weight := range []int{-5, 0, 150, 100} {
			spec.Targets[i].Weight = weight
		}
	})
	with("hints/down", func(spec *failoverSpec) {
		spec.Targets[0].Down = true
		spec.Targets[0].DownReason = " relay down: a → b "
		spec.Targets[1].DownReason = "stale reason"
		spec.Targets[2].Down = true
	})
	with("hints/extra-latency", func(spec *failoverSpec) {
		for i, value := range []int{-3, 50, 100000, 0} {
			spec.Targets[i].ExtraLatencyMs = value
		}
	})
	with("hints/load", func(spec *failoverSpec) {
		for i, value := range []int{90, -1, 150, 0} {
			spec.Targets[i].LoadPct = value
		}
	})
	with("hints/exit-ip", func(spec *failoverSpec) {
		for i, value := range []string{" 203.0.113.9 ", "203.0.113.10", "", "203.0.113.9"} {
			spec.Targets[i].ExitIP = value
		}
	})
	with("hints/all", func(spec *failoverSpec) {
		spec.Targets[0].Down = true
		spec.Targets[0].DownReason = "relay down: hk → jp"
		spec.Targets[1].ExtraLatencyMs = 12
		spec.Targets[1].LoadPct = 85
		spec.Targets[2].ExitIP = "203.0.113.9"
		spec.Targets[3].LoadPct = 35
		spec.Targets[3].ExitIP = " 203.0.113.9"
		spec.Targets[3].Tier = structureIntPtr(1)
		spec.Targets[3].ProbeUdpEcho = true
	})
	with("targets/nil", func(spec *failoverSpec) { spec.Targets = nil })
	with("targets/empty", func(spec *failoverSpec) { spec.Targets = []failoverTarget{} })
	with("targets/12", func(spec *failoverSpec) { spec.Targets = structureTargets(12) })
	with("targets/invalid", func(spec *failoverSpec) {
		spec.Targets = []failoverTarget{
			{TargetIP: "", TargetPort: 80},
			{TargetIP: "10.1.1.1", TargetPort: 0},
			{TargetIP: "10.1.1.2", TargetPort: 70000},
			{TargetIP: " 10.1.1.3 ", TargetPort: 443},
			{TargetIP: "10.1.1.4", TargetPort: 65535},
		}
		spec.Targets[3].LoadPct = 40
		spec.Targets[4].Down = true
	})
	for _, mode := range []string{"fast", "force", " smooth ", "bogus"} {
		mode := mode
		with("switch-mode="+mode, func(spec *failoverSpec) { spec.SwitchMode = mode })
	}
	for _, delivery := range []string{"cold", "hot", "aggregate", " replicate ", "bogus"} {
		delivery := delivery
		with("delivery="+delivery, func(spec *failoverSpec) { spec.Delivery = delivery })
	}
	with("prefer-fastest", func(spec *failoverSpec) {
		spec.PreferFastest = true
		spec.ScoreMargin = 7
		spec.ScoreHoldSeconds = 45
	})
	with("thresholds/high", func(spec *failoverSpec) {
		spec.FailureThreshold = 25
		spec.ScoreMargin = -1
		spec.ScoreHoldSeconds = 0
		spec.PrewarmSeconds = -5
		spec.MinHoldSeconds = -3
	})
	with("thresholds/low", func(spec *failoverSpec) {
		spec.FailureThreshold = 0
		spec.PrewarmSeconds = 60
		spec.MinHoldSeconds = 120
	})
	with("proxy-protocol", func(spec *failoverSpec) {
		spec.ProxyProtocolReceive = true
		spec.ProxyProtocolStrip = true
	})
	with("defaults", func(spec *failoverSpec) {
		spec.BindAddress = ""
		spec.ListenPort = 0
		spec.FailoverSeconds = 0
		spec.RecoverSeconds = -1
		spec.AutoFailback = false
		spec.Enabled = false
	})
	return cases
}

const structureUnit = "[Service]\nExecStart=/usr/local/bin/realm -l 0.0.0.0:30001 -r 127.0.0.1:65040\n"

func structureRecordSpec(r *structureGoldenRecorder, name string, spec failoverSpec) {
	r.t.Helper()
	normalized := normalizeFailoverSpec(spec)
	r.add(name+"/signature", failoverSignature(normalized))
	if raw, ok := failoverSpecSignatureJSON(&spec); ok {
		r.add(name+"/signature-json", raw)
	} else {
		r.add(name+"/signature-json", "<none>")
	}
	r.add(name+"/normalized", r.canonical(normalized))
	r.add(name+"/normalized-hints", structureHintDump(normalized.Targets))
	stripped := stripFailoverRelayHints(normalized)
	r.add(name+"/stripped", r.canonical(stripped))
	r.add(name+"/stripped-hints", structureHintDump(stripped.Targets))
	if err := persistFailoverSpec(7, 30001, spec); err != nil {
		r.t.Fatalf("%s: persist: %v", name, err)
	}
	persisted, err := os.ReadFile(persistentFailoverPath(7, 30001))
	if err != nil {
		r.t.Fatalf("%s: read persisted: %v", name, err)
	}
	r.add(name+"/persisted", string(persisted))
	removePersistedFailoverSpec(7, 30001)
	act := action{Op: "apply", StatusType: "rule", RuleID: 7, SourcePort: 30001, ForwardType: "realm", ServiceName: "forwardx-realm-30001", Unit: structureUnit, Failover: &spec}
	r.add(name+"/action", actionCommandSignature(act))
	r.add(name+"/service", managedServiceActionSignature(act, act.ServiceName, act.Unit))
	// 算签名、规整、落盘都不该改调用方手里那份规格。
	r.add(name+"/input-after", r.canonical(spec)+" "+structureHintDump(spec.Targets))
}

// 面板发来的 JSON（字段顺序、带不带提示都照面板的样子写）。
var structureWireSpecs = []struct {
	name string
	raw  string
}{
	{"full", `{"enabled":true,"listenPort":65040,"bindAddress":"127.0.0.1","protocol":"both","strategy":"auto","targets":[{"targetIp":"10.0.0.1","targetPort":443,"probeIp":"10.9.9.9","probePort":80,"probeUdpEcho":true,"weight":3,"tier":0,"line":0,"landing":"A","spread":"least_load","extraLatencyMs":12,"loadPct":85,"exitIp":"203.0.113.9","down":true,"downReason":"relay down: hk → jp"},{"targetIp":"10.0.0.2","targetPort":443,"weight":1,"tier":1,"exitIp":" 203.0.113.9 "},{"targetIp":"10.0.0.3","targetPort":8443,"loadPct":40}],"failoverSeconds":30,"recoverSeconds":90,"autoFailback":true,"pinnedIndex":1,"pinnedUntil":1893456000000,"preferFastest":true,"failureThreshold":3,"scoreMargin":8,"scoreHoldSeconds":120,"prewarmSeconds":60,"switchMode":"fast","proxyProtocolReceive":true,"delivery":"hot","schedule":{"timezone":"Asia/Shanghai","windows":[{"days":[1,2,3],"from":"18:00","to":"23:00","targetIndex":2}]}}`},
	{"minimal", `{"enabled":true,"listenPort":1,"targets":[{"targetIp":"1.1.1.1","targetPort":1}]}`},
	{"hints-only", `{"enabled":true,"listenPort":2,"strategy":"fallback","targets":[{"targetIp":"1.1.1.1","targetPort":1,"down":true},{"targetIp":"1.1.1.2","targetPort":2,"downReason":"x","extraLatencyMs":-4},{"targetIp":"1.1.1.3","targetPort":3,"loadPct":101,"exitIp":"198.51.100.1"}]}`},
	{"nulls", `{"enabled":true,"listenPort":3,"targets":null,"schedule":null,"pinnedIndex":null}`},
	{"unknown-fields", `{"enabled":true,"listenPort":4,"futureField":1,"targets":[{"targetIp":"1.1.1.1","targetPort":1,"futureHint":"x","loadPct":10}]}`},
}

var structureWireAction = `{"op":"apply","statusType":"rule","ruleId":7,"sourcePort":30001,"forwardType":"realm","svcName":"forwardx-realm-30001","unit":"[Service]\nExecStart=/usr/local/bin/realm\n","failover":{"enabled":true,"listenPort":65040,"protocol":"both","strategy":"auto","targets":[{"targetIp":"10.0.0.1","targetPort":443,"loadPct":85,"exitIp":"203.0.113.9","down":true,"downReason":"r"},{"targetIp":"10.0.0.2","targetPort":443,"extraLatencyMs":7,"probeUdpEcho":true}]}}`

// ---------------------------------------------------------------- 选路

// 测试时刻：都在 2031 年（离真实时间远，「刚切过去」「一小时内切了几次」这类按真实时钟记的状态不会掺进来）。
var structureBaseTime = time.Date(2031, 3, 3, 10, 30, 0, 0, time.UTC)

type structurePickCall struct {
	hashKey string
	exclude map[int]bool
	udp     bool
}

var structurePickCalls = []structurePickCall{
	{"", nil, false},
	{"198.51.100.7", nil, false},
	{"", map[int]bool{0: true}, false},
	{"203.0.113.44", map[int]bool{1: true, 2: true}, false},
	{"", nil, true},
	{"198.51.100.7", nil, true},
	{"", map[int]bool{0: true}, true},
	{"203.0.113.44", map[int]bool{1: true, 2: true}, true},
}

const structurePicksPerCall = 8

var structureExits = []string{"203.0.113.9", "203.0.113.10", "203.0.113.9", "203.0.113.11"}

func structurePickTargets(kind string) []failoverTarget {
	targets := structureTargets(4)
	for i := range targets {
		targets[i].ExitIP = structureExits[i]
	}
	switch kind {
	case "plain":
		for i, weight := range []int{1, 2, 3, 4} {
			targets[i].Weight = weight
		}
	case "zero-weights":
		for i := range targets {
			targets[i].Weight = 0
		}
	case "tiered":
		for i, weight := range []int{2, 1, 1, 3} {
			targets[i].Weight = weight
		}
		for i, tier := range []int{0, 0, 1, 1} {
			targets[i].Tier = structureIntPtr(tier)
		}
		targets[2].ExitIP = "203.0.113.10"
	default:
		// line:<spread>：第 0 条线路上落地 A、B、C（0 和 2 同出口），第 3 条单独。
		spread := strings.TrimPrefix(kind, "line:")
		for i, landing := range []string{"A", "B", "C"} {
			targets[i].Line = structureIntPtr(0)
			targets[i].Landing = landing
			targets[i].Spread = spread
		}
	}
	return targets
}

type structureState struct {
	name  string
	apply func(p *failoverProxy)
}

func structureDown(indices ...int) func(p *failoverProxy) {
	return func(p *failoverProxy) {
		for _, index := range indices {
			p.targetHealth[index] = false
		}
	}
}

func structureUDPHealth(values ...bool) func(p *failoverProxy) {
	return func(p *failoverProxy) {
		for i, value := range values {
			p.udpSide.health[i] = value
		}
	}
}

// 连接数、延迟指数平均、沿途负载：「按负载」「自动」和线路里分都看它们。
func structureBusy(p *failoverProxy) {
	for i, count := range []int{3, 0, 1, 0} {
		for c := 0; c < count; c++ {
			p.conns[i][&fakeConn{}] = struct{}{}
		}
	}
	for i, latency := range []float64{40, 80, 0, 20} {
		p.stats[i].latencyEwmaMs = latency
	}
	for i, load := range []int{0, 90, 0, 50} {
		p.spec.Targets[i].LoadPct = load
	}
	p.lastLatencyMs = []int{40, 80, 33, 20}
}

// 每条都有几次探测样本：评分出得来，同出口 IP 的平手取舍会看分差。
func structureScored(p *failoverProxy) {
	for i, latency := range []int{30, 31, 90, 30} {
		for s := 0; s < 5; s++ {
			p.stats[i].recordProbe(true, latency, structureBaseTime.Add(time.Duration(s)*time.Second))
		}
	}
	p.lastLatencyMs = []int{30, 31, 90, 30}
}

func structureCombine(steps ...func(p *failoverProxy)) func(p *failoverProxy) {
	return func(p *failoverProxy) {
		for _, step := range steps {
			step(p)
		}
	}
}

var structureStates = []structureState{
	{"healthy", func(p *failoverProxy) {}},
	{"down0", structureDown(0)},
	{"down01", structureDown(0, 1)},
	{"alldown", structureDown(0, 1, 2, 3)},
	{"relay2+active2", func(p *failoverProxy) {
		p.relayDown[2] = true
		p.relayDownReason[2] = "relay down: x"
		p.activeIndex = 2
	}},
	{"udpsplit+down1", structureCombine(structureUDPHealth(false, true, false, true), structureDown(1))},
	{"busy+down0", structureCombine(structureBusy, structureDown(0))},
	{"scored+down0", structureCombine(structureScored, structureDown(0))},
}

type structurePinVariant struct {
	name  string
	apply func(spec *failoverSpec)
}

// 只有主备看人工指定和时段表。时段表两段拼成全天，什么时候跑测试都命中。
var structurePinVariants = []structurePinVariant{
	{"none", func(spec *failoverSpec) {}},
	{"pin1", func(spec *failoverSpec) { spec.PinnedIndex = structureIntPtr(1) }},
	{"pin3-expired", func(spec *failoverSpec) {
		spec.PinnedIndex = structureIntPtr(3)
		spec.PinnedUntil = 1
	}},
	{"schedule3", func(spec *failoverSpec) {
		spec.Schedule = &failoverSchedule{Timezone: "UTC", Windows: []failoverScheduleWindow{
			{From: "00:00", To: "12:00", TargetIndex: 3},
			{From: "12:00", To: "00:00", TargetIndex: 3},
		}}
	}},
}

func structureProxy(spec failoverSpec) *failoverProxy {
	spec.Enabled = true
	if spec.BindAddress == "" {
		spec.BindAddress = "127.0.0.1"
	}
	if spec.ListenPort == 0 {
		spec.ListenPort = 64100
	}
	proxy := &failoverProxy{ruleID: 95, sourcePort: 21005, spec: normalizeFailoverSpec(spec)}
	proxy.ensureHealthStateLocked()
	proxy.rng = mathrand.New(mathrand.NewSource(20261108))
	return proxy
}

func structureRecordPicks(r *structureGoldenRecorder, name string, proxy *failoverProxy) {
	parts := make([]string, 0, len(structurePickCalls)+1)
	for _, call := range structurePickCalls {
		picks := make([]string, 0, structurePicksPerCall)
		for i := 0; i < structurePicksPerCall; i++ {
			target, index := proxy.pickTargetForKeyProto(call.hashKey, call.exclude, call.udp)
			if index >= 0 && (target.TargetIP != proxy.spec.Targets[index].TargetIP || target.TargetPort != proxy.spec.Targets[index].TargetPort) {
				r.t.Fatalf("%s: 返回的目标和下标对不上：%d %+v", name, index, target)
			}
			picks = append(picks, strconv.Itoa(index))
		}
		parts = append(parts, strings.Join(picks, ","))
	}
	proxy.mu.Lock()
	wrr := make([]string, 0, len(proxy.wrrCurrent))
	for _, value := range proxy.wrrCurrent {
		wrr = append(wrr, strconv.Itoa(value))
	}
	tail := fmt.Sprintf("rr=%d wrr=[%s] active=%d rng=%d", proxy.roundRobinNext, strings.Join(wrr, ","), proxy.activeIndex, proxy.rng.Int63())
	proxy.mu.Unlock()
	r.add(name, strings.Join(parts, " | ")+" ; "+tail)
}

func structureRecordSelection(r *structureGoldenRecorder) {
	strategies := []string{"fallback", "weighted", "least_load", "auto", "round_robin", "random", "ip_hash"}
	for _, strategy := range strategies {
		kinds := []string{"plain", "zero-weights", "tiered"}
		if strategy == "fallback" {
			kinds = append(kinds, "line:least_load", "line:round_robin", "line:random", "line:ip_hash", "line:auto")
		}
		for _, kind := range kinds {
			pins := []structurePinVariant{structurePinVariants[0]}
			if strategy == "fallback" && !strings.HasPrefix(kind, "line:") {
				pins = structurePinVariants
			}
			for _, protocol := range []string{"tcp", "both"} {
				for _, pin := range pins {
					for _, state := range structureStates {
						spec := failoverSpec{Strategy: strategy, Protocol: protocol, Targets: structurePickTargets(kind)}
						pin.apply(&spec)
						proxy := structureProxy(spec)
						proxy.mu.Lock()
						state.apply(proxy)
						proxy.mu.Unlock()
						name := fmt.Sprintf("pick/%s/%s/%s/%s/%s", strategy, kind, protocol, pin.name, state.name)
						structureRecordPicks(r, name, proxy)
					}
				}
			}
		}
	}
}

// ---------------------------------------------------------------- 主备切换、运行时提示

func structureEventDump(events []failoverProxyEvent) string {
	parts := make([]string, 0, len(events))
	for _, event := range events {
		parts = append(parts, fmt.Sprintf("%s %d→%d %q→%q reason=%q score=%d latency=%d chain=%d/%d",
			event.Kind, event.FromIndex, event.ToIndex, event.FromTarget, event.ToTarget, event.Reason, event.Score, event.LatencyMs, event.FromChainMs, event.ToChainMs))
	}
	return "[" + strings.Join(parts, "; ") + "]"
}

func structureProxyState(p *failoverProxy) string {
	health := make([]string, 0, len(p.targetHealth))
	for i := range p.targetHealth {
		health = append(health, fmt.Sprintf("%t/%t/%q", p.targetHealth[i], p.relayDown[i], p.relayDownReason[i]))
	}
	return fmt.Sprintf("active=%d prewarm=%d precheck=%d health=[%s] hints=%s",
		p.activeIndex, p.prewarmIndex, p.precheckFailedIndex, strings.Join(health, " "), structureHintDump(p.spec.Targets))
}

type structureFallbackVariant struct {
	name   string
	mutate func(spec *failoverSpec)
}

var structureFallbackVariants = []structureFallbackVariant{
	{"plain", func(spec *failoverSpec) {}},
	{"no-failback", func(spec *failoverSpec) { spec.AutoFailback = false }},
	{"tiered", func(spec *failoverSpec) {
		for i, tier := range []int{0, 0, 1, 1} {
			spec.Targets[i].Tier = structureIntPtr(tier)
		}
	}},
	{"pin2", func(spec *failoverSpec) { spec.PinnedIndex = structureIntPtr(2) }},
	{"pin1-until", func(spec *failoverSpec) {
		spec.PinnedIndex = structureIntPtr(1)
		spec.PinnedUntil = structureBaseTime.Add(150 * time.Second).UnixMilli()
	}},
	{"schedule1", func(spec *failoverSpec) {
		spec.Schedule = &failoverSchedule{Timezone: "UTC", Windows: []failoverScheduleWindow{{From: "10:31", To: "10:40", TargetIndex: 1}}}
	}},
	{"schedule1-prewarm", func(spec *failoverSpec) {
		spec.Schedule = &failoverSchedule{Timezone: "UTC", Windows: []failoverScheduleWindow{{From: "10:31", To: "10:40", TargetIndex: 1}}}
		spec.PrewarmSeconds = 120
	}},
	{"no-exits", func(spec *failoverSpec) {
		for i := range spec.Targets {
			spec.Targets[i].ExitIP = ""
		}
	}},
}

type structureFallbackStep struct {
	name  string
	at    time.Duration
	apply func(p *failoverProxy)
}

func structureSetHealth(index int, healthy bool) func(p *failoverProxy) {
	return func(p *failoverProxy) { p.targetHealth[index] = healthy }
}

var structureFallbackSteps = []structureFallbackStep{
	{"start", 0, func(p *failoverProxy) {}},
	{"down0", time.Second, structureSetHealth(0, false)},
	{"down2", 2 * time.Second, structureSetHealth(2, false)},
	{"up0", 3 * time.Second, structureSetHealth(0, true)},
	{"after-window-start", 70 * time.Second, func(p *failoverProxy) {}},
	{"down1", 80 * time.Second, structureSetHealth(1, false)},
	{"up2", 90 * time.Second, structureSetHealth(2, true)},
	{"pin-expiry", 200 * time.Second, func(p *failoverProxy) {}},
	{"up1", 210 * time.Second, structureSetHealth(1, true)},
	{"after-window", 11 * time.Minute, func(p *failoverProxy) {}},
}

func structureRecordFallback(r *structureGoldenRecorder) {
	for _, scored := range []bool{false, true} {
		for _, variant := range structureFallbackVariants {
			spec := failoverSpec{Strategy: "fallback", Protocol: "tcp", Targets: structurePickTargets("plain"), AutoFailback: true}
			variant.mutate(&spec)
			proxy := structureProxy(spec)
			proxy.mu.Lock()
			if scored {
				structureScored(proxy)
			}
			drainFailoverEvents()
			steps := make([]string, 0, len(structureFallbackSteps))
			for _, step := range structureFallbackSteps {
				step.apply(proxy)
				proxy.updateFallbackActiveAtLocked(structureBaseTime.Add(step.at), "health check")
				steps = append(steps, step.name+": "+structureProxyState(proxy)+" events="+structureEventDump(drainFailoverEvents()))
			}
			proxy.mu.Unlock()
			name := fmt.Sprintf("fallback/%s/scored=%t", variant.name, scored)
			r.add(name, strings.Join(steps, "\n"))
		}
	}
}

// 面板一轮一轮发来的提示：中转断了 / 恢复、换原因、下游延迟、负载、出口 IP。只给不分层、不钉、不按时段的规格，
// 换上之后选路用的是真实时钟，这样结果不受时钟影响。
func structureRecordRelayHints(r *structureGoldenRecorder) {
	rounds := []func(targets []failoverTarget){
		func(targets []failoverTarget) {},
		func(targets []failoverTarget) {
			targets[0].Down = true
			targets[0].DownReason = " relay down: hk → jp "
			targets[1].ExtraLatencyMs = 15
			targets[2].LoadPct = 80
			targets[3].ExitIP = " 203.0.113.9 "
		},
		func(targets []failoverTarget) {
			targets[0].Down = true
			targets[0].DownReason = "relay down: hk → sg"
			targets[1].ExtraLatencyMs = 15
		},
		func(targets []failoverTarget) {
			targets[0].Down = true
			targets[0].DownReason = "relay down: hk → sg "
			targets[2].Down = true
		},
		func(targets []failoverTarget) {
			targets[0].DownReason = "leftover"
			targets[2].Down = true
			targets[2].LoadPct = -5
			targets[1].ExitIP = "198.51.100.1"
		},
		func(targets []failoverTarget) {},
	}
	for _, strategy := range []string{"fallback", "weighted"} {
		for _, normalized := range []bool{true, false} {
			spec := failoverSpec{Strategy: strategy, Protocol: "tcp", Targets: structurePickTargets("plain"), AutoFailback: true}
			proxy := structureProxy(spec)
			proxy.mu.Lock()
			drainFailoverEvents()
			steps := []string{}
			for round, mutate := range rounds {
				incoming := structurePickTargets("plain")
				mutate(incoming)
				if normalized {
					incoming = normalizeFailoverSpec(failoverSpec{Targets: incoming}).Targets
				}
				proxy.applyRelayHintsLocked(incoming)
				steps = append(steps, fmt.Sprintf("round%d: %s events=%s", round, structureProxyState(proxy), structureEventDump(drainFailoverEvents())))
			}
			proxy.mu.Unlock()
			r.add(fmt.Sprintf("relay-hints/%s/normalized=%t", strategy, normalized), strings.Join(steps, "\n"))
		}
	}
}

func structureGoldenRecords(t *testing.T) *structureGoldenRecorder {
	oldPersistentDir := persistentFailoverDir
	persistentFailoverDir = filepath.Join(t.TempDir(), "failover")
	t.Cleanup(func() { persistentFailoverDir = oldPersistentDir })

	r := &structureGoldenRecorder{t: t}
	for _, c := range structureSpecCases() {
		structureRecordSpec(r, "spec/"+c.name, c.spec)
	}
	for _, wire := range structureWireSpecs {
		var spec failoverSpec
		if err := json.Unmarshal([]byte(wire.raw), &spec); err != nil {
			t.Fatalf("wire %s: %v", wire.name, err)
		}
		r.add("wire/"+wire.name+"/decoded", r.canonical(spec)+" "+structureHintDump(spec.Targets))
		structureRecordSpec(r, "wire/"+wire.name, spec)
	}
	var act action
	if err := json.Unmarshal([]byte(structureWireAction), &act); err != nil {
		t.Fatalf("wire action: %v", err)
	}
	r.add("wire-action/decoded-hints", structureHintDump(act.Failover.Targets))
	r.add("wire-action/action", actionCommandSignature(act))
	r.add("wire-action/service", managedServiceActionSignature(act, act.ServiceName, act.Unit))
	nilFailover := action{Op: "apply", StatusType: "rule", RuleID: 7, SourcePort: 30001, ForwardType: "realm", ServiceName: "forwardx-realm-30001", Unit: structureUnit}
	r.add("action/no-failover", actionCommandSignature(nilFailover))
	r.add("service/no-failover", managedServiceActionSignature(nilFailover, nilFailover.ServiceName, nilFailover.Unit))

	structureRecordSelection(r)
	structureRecordFallback(r)
	structureRecordRelayHints(r)
	return r
}

func TestStructureGolden(t *testing.T) {
	recorder := structureGoldenRecords(t)
	records := recorder.records
	path := filepath.Join("testdata", "structure_golden.json")
	// 一行一条：对不上时 git diff 一眼看得出是哪几条。
	var buffer bytes.Buffer
	buffer.WriteString("[\n")
	for i, record := range records {
		line, err := json.Marshal(record)
		if err != nil {
			t.Fatal(err)
		}
		buffer.Write(line)
		if i < len(records)-1 {
			buffer.WriteByte(',')
		}
		buffer.WriteByte('\n')
	}
	buffer.WriteString("]\n")
	encoded := buffer.Bytes()
	if os.Getenv("FORWARDX_UPDATE_STRUCTURE_GOLDEN") == "1" {
		if err := os.WriteFile(path, encoded, 0o644); err != nil {
			t.Fatal(err)
		}
		t.Logf("重录了 %d 条", len(records))
		return
	}
	stored, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读不到对照文件（第一次要用 FORWARDX_UPDATE_STRUCTURE_GOLDEN=1 录）：%v", err)
	}
	if bytes.Equal(stored, encoded) {
		return
	}
	var want []structureGoldenRecord
	if err := json.Unmarshal(stored, &want); err != nil {
		t.Fatalf("对照文件坏了：%v", err)
	}
	if len(want) != len(records) {
		t.Errorf("条数不一样：录的 %d 条，现在 %d 条", len(want), len(records))
	}
	shown := 0
	for i := 0; i < len(want) && i < len(records); i++ {
		if want[i] == records[i] {
			continue
		}
		if shown < 10 {
			t.Errorf("第 %d 条不一样：\n  录的 %s = %s\n  现在 %s = %s\n  现在的完整值：\n%s", i, want[i].Name, want[i].Value, records[i].Name, records[i].Value, recorder.full[i])
		}
		shown++
	}
	if shown == 0 && len(want) == len(records) {
		t.Errorf("内容一样但字节不一样（格式变了？）")
	}
	if shown > 10 {
		t.Errorf("……一共 %d 条不一样", shown)
	}
}
