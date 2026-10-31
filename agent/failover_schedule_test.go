package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

/*
时段表的判定用例和面板共用一份。

两边各有一套实现是没办法的事 —— Agent 必须能在面板挂掉时照常按表走 —— 但漂移的
后果是「面板上显示走备线、机器上还在走主线」，而这种不一致没有任何地方会报错。
所以判定本身由 shared/failoverSchedule.cases.json 钉住：谁改出了偏差，谁那边红。
*/

type scheduleCase struct {
	Name     string                   `json:"name"`
	Timezone string                   `json:"timezone"`
	Windows  []failoverScheduleWindow `json:"windows"`
	At       string                   `json:"at"`
	Expected *int                     `json:"expected"`
}

func TestFailoverScheduleSharedCases(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "shared", "failoverSchedule.cases.json"))
	if err != nil {
		t.Fatalf("读共用用例表: %v", err)
	}
	var fixture struct {
		Cases []scheduleCase `json:"cases"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("解析共用用例表: %v", err)
	}
	// 锚点校验：读空了的话下面整轮断言会全部空转。
	if len(fixture.Cases) < 10 {
		t.Fatalf("用例表只读到 %d 条，路径大概不对", len(fixture.Cases))
	}

	for _, testCase := range fixture.Cases {
		at, err := time.Parse(time.RFC3339, testCase.At)
		if err != nil {
			t.Fatalf("%s: 时间格式不对 %q", testCase.Name, testCase.At)
		}
		schedule := &failoverSchedule{Timezone: testCase.Timezone, Windows: testCase.Windows}
		actual := failoverScheduleTargetIndexAt(schedule, at)
		expected := -1
		if testCase.Expected != nil {
			expected = *testCase.Expected
		}
		if actual != expected {
			t.Errorf("%s：期望 %d，拿到 %d", testCase.Name, expected, actual)
		}
	}
}

func TestFailoverScheduleNormalizationMatchesPanel(t *testing.T) {
	// 收不下的窗口一条都不留，不要半收 —— 半张表最危险：界面上像是配好了，
	// 实际什么都不会发生。
	schedule := normalizeFailoverSchedule(&failoverSchedule{
		Timezone: "Asia/Shanghai",
		Windows: []failoverScheduleWindow{
			{Days: nil, From: "18:00", To: "23:00", TargetIndex: 1},
			{Days: nil, From: "25:00", To: "26:00", TargetIndex: 1},
			{Days: nil, From: "10:00", To: "10:00", TargetIndex: 1},
			{Days: nil, From: "10:00", To: "11:00", TargetIndex: -1},
		},
	})
	if schedule == nil || len(schedule.Windows) != 1 {
		t.Fatalf("只有第一条是完整的，拿到 %+v", schedule)
	}

	// 七天全选等于每天，存成同一种写法。
	everyDay := normalizeFailoverSchedule(&failoverSchedule{
		Timezone: "Asia/Shanghai",
		Windows:  []failoverScheduleWindow{{Days: []int{0, 1, 2, 3, 4, 5, 6}, From: "18:00", To: "23:00", TargetIndex: 1}},
	})
	if everyDay == nil || len(everyDay.Windows[0].Days) != 0 {
		t.Fatalf("七天全选没被归一成每天：%+v", everyDay)
	}

	if normalizeFailoverSchedule(&failoverSchedule{Timezone: "", Windows: []failoverScheduleWindow{{From: "18:00", To: "23:00"}}}) != nil {
		t.Fatal("没有时区不该算一张表")
	}
	if normalizeFailoverSchedule(nil) != nil {
		t.Fatal("空的不该算一张表")
	}
}

func TestFailoverScheduleEmbedsTimezoneData(t *testing.T) {
	/*
		Agent 装在各种精简镜像上，很多根本没有 /usr/share/zoneinfo。缺了的话时段表
		会**静默不生效**：面板上配得好好的，机器上永远按主线路走，没有任何地方报错。
		所以 tzdata 是编进二进制的，这条盯着别哪天被当成"没用的依赖"删掉。
	*/
	for _, zone := range []string{"Asia/Shanghai", "America/Los_Angeles", "Europe/London"} {
		if _, err := time.LoadLocation(zone); err != nil {
			t.Fatalf("加载时区 %s 失败：%v —— time/tzdata 是不是被删了？", zone, err)
		}
	}
}

/*
时段表接进主备选路之后的行为。

三条不变量，每一条都是被现实逼出来的：
  · 时段表只改「谁是首选」，不重排剩下的兜底顺序
  · 首选那条不健康时，时段表说了不算 —— 切不切得过去由健康检查决定
  · 最短驻留拦的是「好线路之间来回切」，不是「逃离一条死路」
*/

func scheduleProxy(targets int, schedule *failoverSchedule, minHold int) *failoverProxy {
	list := make([]failoverTarget, 0, targets)
	for i := 0; i < targets; i++ {
		list = append(list, failoverTarget{TargetIP: "10.0.0." + strconv.Itoa(i+1), TargetPort: 80})
	}
	proxy := &failoverProxy{
		ruleID: 90, sourcePort: 21000,
		spec: normalizeFailoverSpec(failoverSpec{
			Enabled: true, ListenPort: 64000, BindAddress: "127.0.0.1", Strategy: "fallback",
			AutoFailback: true, Targets: list, Schedule: schedule, MinHoldSeconds: minHold,
		}),
	}
	proxy.ensureHealthStateLocked()
	return proxy
}

func eveningSchedule(targetIndex int) *failoverSchedule {
	return &failoverSchedule{
		Timezone: "Asia/Shanghai",
		Windows:  []failoverScheduleWindow{{From: "18:00", To: "23:00", TargetIndex: targetIndex}},
	}
}

func TestPriorityOrderFollowsSchedule(t *testing.T) {
	proxy := scheduleProxy(3, eveningSchedule(2), 0)
	evening := time.Date(2026, 9, 21, 19, 0, 0, 0, time.FixedZone("CST", 8*3600))
	morning := time.Date(2026, 9, 21, 9, 0, 0, 0, time.FixedZone("CST", 8*3600))

	proxy.mu.Lock()
	defer proxy.mu.Unlock()
	if got := proxy.priorityOrderLocked(evening); got[0] != 2 {
		t.Fatalf("晚高峰时首选应当是第 2 条，拿到 %v", got)
	}
	// 时段表只改首选，剩下的兜底顺序保持原样。
	if got := proxy.priorityOrderLocked(evening); got[1] != 0 || got[2] != 1 {
		t.Fatalf("兜底顺序被时段表重排了：%v", got)
	}
	if got := proxy.priorityOrderLocked(morning); got[0] != 0 || got[1] != 1 || got[2] != 2 {
		t.Fatalf("没有时段命中时应当还是数组顺序，拿到 %v", got)
	}
}

func TestScheduleDoesNotOverrideHealth(t *testing.T) {
	/*
		18 点到了而那条线正挂着，不该机械地切过去。时段表决定「首选是谁」，
		切不切得过去仍然由健康检查说了算 —— 这两件事是正交的。

		时刻必须显式传进去。读真实时钟的话这条用例只在真实时间落在 18-23 点时才
		走到判断，其余时候压根没有窗口命中 —— 测试照常绿，什么也没验证。第一版
		就是这么写的，反向验证没红才发现。
	*/
	proxy := scheduleProxy(3, eveningSchedule(2), 0)
	evening := time.Date(2026, 9, 21, 19, 0, 0, 0, time.FixedZone("CST", 8*3600))

	proxy.mu.Lock()
	// 先确认这个时刻时段表**确实**命中了，否则下面的断言是空的。
	if preferred := failoverScheduleTargetIndexAt(proxy.spec.Schedule, evening); preferred != 2 {
		proxy.mu.Unlock()
		t.Fatalf("用例前提没成立：这个时刻时段表该选第 2 条，拿到 %d", preferred)
	}
	proxy.targetHealth[2] = false
	proxy.updateFallbackActiveAtLocked(evening, "health check")
	active := proxy.activeIndex
	proxy.mu.Unlock()
	if active == 2 {
		t.Fatal("首选那条不健康时不该切过去 —— 那是把流量往死路里送")
	}
}

func TestScheduleSwitchesWhenPreferredIsHealthy(t *testing.T) {
	// 反过来也得成立：首选那条是健康的，到点就该走过去，否则时段表等于没配。
	proxy := scheduleProxy(3, eveningSchedule(2), 0)
	evening := time.Date(2026, 9, 21, 19, 0, 0, 0, time.FixedZone("CST", 8*3600))
	proxy.mu.Lock()
	proxy.updateFallbackActiveAtLocked(evening, "schedule")
	active := proxy.activeIndex
	proxy.mu.Unlock()
	if active != 2 {
		t.Fatalf("晚高峰该走第 2 条，拿到 %d", active)
	}
}

func TestScheduleReturnsToPriorityAfterWindow(t *testing.T) {
	// 窗口过了要自己回来。回不来的话「晚高峰错峰」就变成了「换了条线就不回来了」。
	proxy := scheduleProxy(3, eveningSchedule(2), 0)
	evening := time.Date(2026, 9, 21, 19, 0, 0, 0, time.FixedZone("CST", 8*3600))
	morning := time.Date(2026, 9, 22, 9, 0, 0, 0, time.FixedZone("CST", 8*3600))
	proxy.mu.Lock()
	proxy.updateFallbackActiveAtLocked(evening, "schedule")
	proxy.updateFallbackActiveAtLocked(morning, "schedule")
	active := proxy.activeIndex
	proxy.mu.Unlock()
	if active != 0 {
		t.Fatalf("窗口过了应当回到主出站，拿到 %d", active)
	}
}

func TestMinHoldBlocksFailbackButNotEscape(t *testing.T) {
	proxy := scheduleProxy(2, nil, 600)

	// 先制造一次切换：0 号挂了，逃到 1 号。
	proxy.mu.Lock()
	proxy.targetHealth[0] = false
	proxy.updateFallbackActiveLocked("health check")
	escaped := proxy.activeIndex
	proxy.mu.Unlock()
	if escaped != 1 {
		t.Fatalf("0 号挂了应当逃到 1 号，拿到 %d", escaped)
	}

	// 0 号马上恢复：在最短驻留时间里不许切回去，否则线路会来回抖。
	proxy.mu.Lock()
	proxy.targetHealth[0] = true
	proxy.updateFallbackActiveLocked("health check")
	held := proxy.activeIndex
	proxy.mu.Unlock()
	if held != 1 {
		t.Fatal("最短驻留时间里不该往回切")
	}

	// 但 1 号也挂了的话必须立刻逃 —— 守着一条死路比抖动更糟。
	proxy.mu.Lock()
	proxy.targetHealth[1] = false
	proxy.updateFallbackActiveLocked("health check")
	final := proxy.activeIndex
	proxy.mu.Unlock()
	if final != 0 {
		t.Fatal("当前这条挂了时，最短驻留不该拦住逃生")
	}
}

func TestMinHoldExpires(t *testing.T) {
	proxy := scheduleProxy(2, nil, 1)
	proxy.mu.Lock()
	proxy.targetHealth[0] = false
	proxy.updateFallbackActiveLocked("health check")
	proxy.targetHealth[0] = true
	proxy.lastSwitchAt = time.Now().Add(-2 * time.Second)
	proxy.updateFallbackActiveLocked("health check")
	active := proxy.activeIndex
	proxy.mu.Unlock()
	if active != 0 {
		t.Fatal("驻留时间过了就该按优先级切回主线路")
	}
}

func TestScheduleChangeRebuildsSignature(t *testing.T) {
	// 不带上时段表的话，只改时段表不触发重建：面板显示成功，机器还按老表走，
	// 而时段表恰恰是「到点才知道有没有生效」的东西。
	base := normalizeFailoverSpec(failoverSpec{
		ListenPort: 1, BindAddress: "127.0.0.1", Strategy: "fallback",
		Targets: []failoverTarget{{TargetIP: "10.0.0.1", TargetPort: 80}},
	})
	withSchedule := base
	withSchedule.Schedule = eveningSchedule(0)
	if failoverSignature(base) == failoverSignature(withSchedule) {
		t.Fatal("加了时段表签名没变")
	}
	moved := base
	moved.Schedule = eveningSchedule(1)
	if failoverSignature(withSchedule) == failoverSignature(moved) {
		t.Fatal("时段表改了首选出站，签名没变")
	}
	withHold := base
	withHold.MinHoldSeconds = 600
	if failoverSignature(base) == failoverSignature(withHold) {
		t.Fatal("改了最短驻留，签名没变")
	}
}

/*
人工钉住某一条出站。

语义是「把它排到最前」，不是「只许走它」—— 钉住的那条挂了仍然往下找。运维想要的是
「现在走 B」，不是「B 死了也守着 B」，后者等于用一个应急开关制造一次故障。
*/

func TestPinnedIndexOutranksSchedule(t *testing.T) {
	proxy := scheduleProxy(3, eveningSchedule(2), 0)
	pinned := 1
	proxy.spec.PinnedIndex = &pinned
	evening := time.Date(2026, 9, 21, 19, 0, 0, 0, time.FixedZone("CST", 8*3600))

	proxy.mu.Lock()
	defer proxy.mu.Unlock()
	// 前提确认：这个时刻时段表本来会选第 2 条。
	if preferred := failoverScheduleTargetIndexAt(proxy.spec.Schedule, evening); preferred != 2 {
		t.Fatalf("用例前提没成立：时段表该选第 2 条，拿到 %d", preferred)
	}
	if got := proxy.priorityOrderLocked(evening); got[0] != 1 {
		t.Fatalf("人工钉住应当压过时段表，拿到 %v", got)
	}
}

func TestPinnedIndexExpires(t *testing.T) {
	/*
		有期限这件事很要紧：应急处理完没人记得去关，那条线就一直被钉着，后面所有
		自动切换（包括时段表）全部静默失效，而面板上看不出任何异常。
	*/
	proxy := scheduleProxy(3, eveningSchedule(2), 0)
	evening := time.Date(2026, 9, 21, 19, 0, 0, 0, time.FixedZone("CST", 8*3600))
	pinned := 1
	proxy.spec.PinnedIndex = &pinned
	proxy.spec.PinnedUntil = evening.Add(time.Hour).UnixMilli()

	proxy.mu.Lock()
	defer proxy.mu.Unlock()
	if got := proxy.priorityOrderLocked(evening); got[0] != 1 {
		t.Fatalf("还没到期就该钉着，拿到 %v", got)
	}
	// 到点之后自动交回时段表。
	afterExpiry := evening.Add(2 * time.Hour)
	if preferred := failoverScheduleTargetIndexAt(proxy.spec.Schedule, afterExpiry); preferred != 2 {
		t.Fatalf("用例前提没成立：21 点该还在晚高峰窗口里，拿到 %d", preferred)
	}
	if got := proxy.priorityOrderLocked(afterExpiry); got[0] != 2 {
		t.Fatalf("钉住到期后应当交回时段表，拿到 %v", got)
	}
}

func TestPinnedTargetStillFailsOverWhenDead(t *testing.T) {
	// 钉住的那条挂了仍然要逃。用一个应急开关制造一次故障，是最糟的那种设计。
	proxy := scheduleProxy(3, nil, 0)
	pinned := 1
	proxy.spec.PinnedIndex = &pinned
	now := time.Now()

	proxy.mu.Lock()
	proxy.targetHealth[1] = false
	proxy.updateFallbackActiveAtLocked(now, "health check")
	active := proxy.activeIndex
	proxy.mu.Unlock()
	if active == 1 {
		t.Fatal("钉住的出站挂了还守着它 —— 这是拿应急开关制造故障")
	}
}

func TestPinnedIndexOutOfRangeIsIgnored(t *testing.T) {
	// 越界的序号一律当成没钉：宁可交回自动，也不能让一条规则因为一个坏值走不通。
	outOfRange := 7
	spec := normalizeFailoverSpec(failoverSpec{
		Enabled: true, ListenPort: 1, BindAddress: "127.0.0.1", Strategy: "fallback",
		Targets:     []failoverTarget{{TargetIP: "10.0.0.1", TargetPort: 80}},
		PinnedIndex: &outOfRange, PinnedUntil: time.Now().Add(time.Hour).UnixMilli(),
	})
	if spec.PinnedIndex != nil || spec.PinnedUntil != 0 {
		t.Fatalf("越界的钉住没被清掉：%+v", spec)
	}
}

func TestPinnedChangeRebuildsSignature(t *testing.T) {
	base := normalizeFailoverSpec(failoverSpec{
		ListenPort: 1, BindAddress: "127.0.0.1", Strategy: "fallback",
		Targets: []failoverTarget{{TargetIP: "10.0.0.1", TargetPort: 80}, {TargetIP: "10.0.0.2", TargetPort: 80}},
	})
	pinnedIndex := 1
	pinned := base
	pinned.PinnedIndex = &pinnedIndex
	if failoverSignature(base) == failoverSignature(pinned) {
		t.Fatal("钉住了出站，签名没变 —— 改动不会下发到已经在跑的主备代理")
	}
	later := pinned
	later.PinnedUntil = time.Now().Add(time.Hour).UnixMilli()
	if failoverSignature(pinned) == failoverSignature(later) {
		t.Fatal("改了钉住的期限，签名没变")
	}
}

/*
按实测延迟自动择优。

不是「谁快切谁」—— 那样线路会一直漂：两条线延迟在几毫秒之间来回，每次探测都能得出
不同的结论，而每次切换都会让新连接换一条路。三道门槛：绝对值、百分比、持续时间。
*/

func fastestProxy(latencies []int, active int) *failoverProxy {
	targets := make([]failoverTarget, 0, len(latencies))
	for i := range latencies {
		targets = append(targets, failoverTarget{TargetIP: "10.0.0." + strconv.Itoa(i+1), TargetPort: 80})
	}
	proxy := &failoverProxy{
		ruleID: 91, sourcePort: 21001,
		spec: normalizeFailoverSpec(failoverSpec{
			Enabled: true, ListenPort: 64001, BindAddress: "127.0.0.1", Strategy: "fallback",
			AutoFailback: true, Targets: targets, PreferFastest: true,
		}),
	}
	proxy.ensureHealthStateLocked()
	copy(proxy.lastLatencyMs, latencies)
	proxy.activeIndex = active
	return proxy
}

/*
先建立候选、再等够时间，才算真的问到了「值不值得切」。

只调一次的话永远得到 -1（第一次调用只是把候选记下来并开始计时），于是「差距不够
大就不该切」这类用例会**看起来通过而什么都没验证** —— 它被持续时间那道门槛挡住了，
根本没走到差距判断。差点就这么写进去了：反向验证里把百分比门槛整个删掉，测试照样绿。
*/
func fastestAfterHold(proxy *failoverProxy, start time.Time) int {
	proxy.fastestIndexLocked(start)
	return proxy.fastestIndexLocked(start.Add((failoverFastestHoldSeconds + 1) * time.Second))
}

func TestFastestNeedsSustainedAdvantage(t *testing.T) {
	// 第 1 条明显更快（200ms → 140ms：快 60ms、30%），但得连着够久才算数。
	proxy := fastestProxy([]int{200, 140}, 0)
	start := time.Now()

	proxy.mu.Lock()
	defer proxy.mu.Unlock()
	if got := proxy.fastestIndexLocked(start); got != -1 {
		t.Fatalf("第一次看到就切，持续时间那道门槛没起作用：%d", got)
	}
	if got := proxy.fastestIndexLocked(start.Add(60 * time.Second)); got != -1 {
		t.Fatalf("才 60 秒就切了：%d", got)
	}
	if got := proxy.fastestIndexLocked(start.Add((failoverFastestHoldSeconds + 1) * time.Second)); got != 1 {
		t.Fatalf("连着 %d 秒都更快，应当选它，拿到 %d", failoverFastestHoldSeconds, got)
	}
}

func TestFastestResetsWhenCandidateChanges(t *testing.T) {
	// 候选换人就重新计时：两条线轮流领先的话，谁都不该被选中。（只是明显更快、不是快一半以上，走的是完整的持续时间）
	proxy := fastestProxy([]int{200, 150, 160}, 0)
	start := time.Now()
	proxy.mu.Lock()
	defer proxy.mu.Unlock()
	proxy.fastestIndexLocked(start)
	proxy.lastLatencyMs[1] = 300 // 1 号变慢，2 号成了新候选
	proxy.fastestIndexLocked(start.Add(100 * time.Second))
	if got := proxy.fastestIndexLocked(start.Add((failoverFastestHoldSeconds + 1) * time.Second)); got != -1 {
		t.Fatalf("候选换过人，计时该重来，拿到 %d", got)
	}
}

func TestFastestIgnoresNoiseLevelDifferences(t *testing.T) {
	start := time.Now()

	proxy := fastestProxy([]int{60, 45}, 0) // 快 15ms，没到 20ms 的绝对门槛
	proxy.mu.Lock()
	absolute := fastestAfterHold(proxy, start)
	proxy.mu.Unlock()
	if absolute != -1 {
		t.Fatalf("差距不到绝对门槛就切了：%d", absolute)
	}

	// 长肥链路上 25ms 的差距也不该算「明显更快」：过了绝对门槛，但只有 5%。
	ratio := fastestProxy([]int{500, 475}, 0)
	ratio.mu.Lock()
	percentage := fastestAfterHold(ratio, start)
	ratio.mu.Unlock()
	if percentage != -1 {
		t.Fatalf("差距不到百分比门槛就切了：%d", percentage)
	}

	// 对照：同样是 25ms 的差距，放在 60ms 的链路上就该算数（快 42%）。
	meaningful := fastestProxy([]int{60, 35}, 0)
	meaningful.mu.Lock()
	defer meaningful.mu.Unlock()
	if got := fastestAfterHold(meaningful, start); got != 1 {
		t.Fatalf("两道门槛都过了却没选它：%d —— 对照组不成立的话，上面两条也证明不了什么", got)
	}
}

func TestFastestSkipsUnprobedAndUnhealthy(t *testing.T) {
	// 0 表示这一轮没探出耗时，不能当成「快得不得了」。
	proxy := fastestProxy([]int{200, 0}, 0)
	start := time.Now()
	proxy.mu.Lock()
	if got := fastestAfterHold(proxy, start); got != -1 {
		proxy.mu.Unlock()
		t.Fatalf("把「没探出耗时」当成了最快：%d", got)
	}
	proxy.mu.Unlock()

	unhealthy := fastestProxy([]int{200, 50}, 0)
	unhealthy.mu.Lock()
	defer unhealthy.mu.Unlock()
	unhealthy.targetHealth[1] = false
	if got := fastestAfterHold(unhealthy, start); got != -1 {
		t.Fatalf("选了一条不健康的出站：%d", got)
	}
}

func TestFastestZeroValueCandidateDoesNotSkipHold(t *testing.T) {
	/*
		fastestCandidate 的 Go 零值是 0。第一次评估如果恰好选中第 0 条，
		`fastestCandidate != best` 是 false，而 now.Sub(零时刻) 是个巨大的数 ——
		持续时间那道门槛会被整个跳过，第一次探测就切。

		只在「最快的恰好是第 0 条」时发生，最难查，所以单独钉一条。
	*/
	proxy := fastestProxy([]int{50, 200}, 1) // 当前走第 1 条，第 0 条更快
	start := time.Now()
	proxy.mu.Lock()
	defer proxy.mu.Unlock()
	if got := proxy.fastestIndexLocked(start); got != -1 {
		t.Fatalf("第一次评估就选中了第 0 条，持续时间门槛被跳过了：%d", got)
	}
	if got := proxy.fastestIndexLocked(start.Add((failoverFastestHoldSeconds + 1) * time.Second)); got != 0 {
		t.Fatalf("等够了之后应当选第 0 条，拿到 %d", got)
	}
}

func TestScheduleOutranksFastest(t *testing.T) {
	// 时段表是人事先排好的意图，该压过机器自己算出来的择优。
	proxy := fastestProxy([]int{200, 50, 50}, 0)
	proxy.spec.Schedule = normalizeFailoverSchedule(eveningSchedule(2))
	evening := time.Date(2026, 9, 21, 19, 0, 0, 0, time.FixedZone("CST", 8*3600))
	proxy.mu.Lock()
	defer proxy.mu.Unlock()
	proxy.fastestIndexLocked(evening)
	if got := proxy.priorityOrderLocked(evening.Add((failoverFastestHoldSeconds + 1) * time.Second)); got[0] != 2 {
		t.Fatalf("时段表该压过自动择优，拿到 %v", got)
	}
}

func TestPinnedIndexZeroValueIsNotAPin(t *testing.T) {
	/*
		Go 的 int 零值是 0，而 0 是一个合法的出站序号（主出站）。

		这个字段要是用 int，任何没带它的规格 —— 老 Agent 落在盘上的快照、面板漏传
		的那一次 —— 都会被解成「钉死在主出站」：时段表不生效、自动择优不生效、
		故障之外的一切自动切换全部静默失效，而面板上看不出任何异常。

		这条是被测试抓出来的：加完人工钉住之后，两条本来绿着的时段表用例突然红了，
		原因就是构造出来的 spec 带着零值 PinnedIndex，把时段表压住了。
	*/
	spec := normalizeFailoverSpec(failoverSpec{
		Enabled: true, ListenPort: 1, BindAddress: "127.0.0.1", Strategy: "fallback",
		Targets:  []failoverTarget{{TargetIP: "10.0.0.1", TargetPort: 80}, {TargetIP: "10.0.0.2", TargetPort: 80}},
		Schedule: eveningSchedule(1),
	})
	if spec.PinnedIndex != nil {
		t.Fatalf("没传钉住却被当成钉住了：%+v", spec.PinnedIndex)
	}

	proxy := &failoverProxy{ruleID: 92, sourcePort: 21002, spec: spec}
	proxy.ensureHealthStateLocked()
	evening := time.Date(2026, 9, 21, 19, 0, 0, 0, time.FixedZone("CST", 8*3600))
	proxy.mu.Lock()
	defer proxy.mu.Unlock()
	if got := proxy.pinnedIndexAt(evening); got != -1 {
		t.Fatalf("零值被当成了「钉在主出站」：%d", got)
	}
	if got := proxy.priorityOrderLocked(evening); got[0] != 1 {
		t.Fatalf("时段表被零值的钉住压住了，拿到 %v", got)
	}
}

// 好得多（快 100ms 以上、只要一半时间）：连着 10 秒都是它就切，不用等满三分钟；第一次看到照样不切。
func TestFastestSwitchesSoonerWhenDramaticallyBetter(t *testing.T) {
	proxy := fastestProxy([]int{557, 3}, 0)
	start := time.Now()
	proxy.mu.Lock()
	defer proxy.mu.Unlock()
	if got := proxy.fastestIndexLocked(start); got != -1 {
		t.Fatalf("第一次看到就切了：%d", got)
	}
	if got := proxy.fastestIndexLocked(start.Add(5 * time.Second)); got != -1 {
		t.Fatalf("才 5 秒就切了：%d", got)
	}
	if got := proxy.fastestIndexLocked(start.Add(failoverDramaticHold + time.Second)); got != 1 {
		t.Fatalf("557ms 对 3ms，连着 10 秒都更快，应当切过去，拿到 %d", got)
	}

	// 只快一点点（快 60ms、30%）的照旧要等满持续时间。
	modest := fastestProxy([]int{200, 140}, 0)
	modest.mu.Lock()
	defer modest.mu.Unlock()
	modest.fastestIndexLocked(start)
	if got := modest.fastestIndexLocked(start.Add(failoverDramaticHold + time.Second)); got != -1 {
		t.Fatalf("只快一点不该走快速通道：%d", got)
	}
}

// 探测间隔跟着「异常多久切」：一半，夹在 1–5 秒；面板改了就按新的来。
func TestFailoverHealthIntervalFollowsFailoverSeconds(t *testing.T) {
	cases := map[int]time.Duration{0: time.Second, 1: time.Second, 2: time.Second, 3: 1500 * time.Millisecond, 8: 4 * time.Second, 10: 5 * time.Second, 60: 5 * time.Second}
	for seconds, want := range cases {
		if got := failoverHealthInterval(seconds); got != want {
			t.Fatalf("failoverSeconds=%d：探测间隔应当 %s，拿到 %s", seconds, want, got)
		}
	}
	proxy := fastestProxy([]int{10, 20}, 0)
	proxy.spec.FailoverSeconds = 3
	if got := proxy.healthInterval(); got != 1500*time.Millisecond {
		t.Fatalf("规格里 3 秒：%s", got)
	}
}
