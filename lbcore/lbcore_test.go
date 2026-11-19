package lbcore

import (
	"fmt"
	"hash/fnv"
	"math"
	"math/rand"
	"testing"
	"time"
)

func equalMembers(weights ...float64) ([]Member, []int) {
	members := make([]Member, len(weights))
	candidates := make([]int, len(weights))
	for i, weight := range weights {
		members[i] = Member{Weight: weight, Share: 1}
		candidates[i] = i
	}
	return members, candidates
}

// ---- 平滑加权轮询 ----

func TestSmoothWRRInterleaves(t *testing.T) {
	members, candidates := equalMembers(5, 3)
	wrr := make(SmoothWRR, 2)
	sequence := ""
	for i := 0; i < 8; i++ {
		sequence += string(rune('A' + wrr.Pick(members, candidates)))
	}
	if sequence != "ABAABABA" {
		t.Fatalf("5:3 应该交错成 ABAABABA，实际 %s", sequence)
	}
	for i, value := range wrr {
		if value != 0 {
			t.Fatalf("走完一整圈计数应该回到 0：成员 %d 是 %d", i, value)
		}
	}
}

func TestSmoothWRRZeroWeightGetsNothingUnlessAllZero(t *testing.T) {
	members, candidates := equalMembers(3, 0, 1)
	wrr := make(SmoothWRR, 3)
	counts := [3]int{}
	for i := 0; i < 400; i++ {
		counts[wrr.Pick(members, candidates)]++
	}
	if counts != [3]int{300, 0, 100} {
		t.Fatalf("权重 0 的不分：%v", counts)
	}
	members, candidates = equalMembers(0, 0)
	wrr = make(SmoothWRR, 2)
	counts = [3]int{}
	for i := 0; i < 100; i++ {
		counts[wrr.Pick(members, candidates)]++
	}
	if counts[0] != 50 || counts[1] != 50 {
		t.Fatalf("全是 0 时一律当 1：%v", counts)
	}
}

// 都分不到（Share 全是 0）时退一步只看 Weight，不能一个都不给。
func TestSmoothWRRFallsBackToStaticWeightWhenNobodyHasAShare(t *testing.T) {
	members := []Member{{Weight: 3}, {Weight: 1}}
	wrr := make(SmoothWRR, 2)
	counts := [2]int{}
	for i := 0; i < 400; i++ {
		counts[wrr.Pick(members, []int{0, 1})]++
	}
	if counts != [2]int{300, 100} {
		t.Fatalf("%v", counts)
	}
}

func TestSmoothWRRSpinKeepsSharesAndVariesTheStart(t *testing.T) {
	members, candidates := equalMembers(6, 3, 1)
	firsts := map[int]bool{}
	for seed := uint64(0); seed < 40; seed++ {
		wrr := make(SmoothWRR, 3)
		wrr.Spin(members, candidates, seed*7919)
		counts := [3]int{}
		for i := 0; i < 1000; i++ {
			pick := wrr.Pick(members, candidates)
			if i == 0 {
				firsts[pick] = true
			}
			counts[pick]++
		}
		if counts != [3]int{600, 300, 100} {
			t.Fatalf("起步位置不该改变份额（seed=%d）：%v", seed, counts)
		}
	}
	if len(firsts) < 2 {
		t.Fatalf("不同的种子应该从不同的成员起步：%v", firsts)
	}
}

func TestSmoothWRRRemapFollowsTheMember(t *testing.T) {
	members, candidates := equalMembers(5, 3, 2)
	wrr := make(SmoothWRR, 3)
	wrr.Pick(members, candidates)
	before := append(SmoothWRR(nil), wrr...)
	after := wrr.Remap([]string{"a", "b", "c"}, []string{"x", "c", "a"})
	if len(after) != 3 || after[0] != 0 || after[1] != before[2] || after[2] != before[0] {
		t.Fatalf("计数应该跟着成员走：原来 %v 现在 %v", before, after)
	}
	if fresh := SmoothWRR(nil).Remap(nil, []string{"a", "b"}); len(fresh) != 2 || fresh[0] != 0 || fresh[1] != 0 {
		t.Fatalf("没用过的状态搬过来是全 0：%v", fresh)
	}
}

func TestPickersReturnMinusOneWithoutCandidates(t *testing.T) {
	next := 0
	if SmoothWRR(nil).Pick(nil, nil) != -1 || RoundRobin(&next, nil, nil, nil) != -1 || Random(nil, nil, nil) != -1 ||
		Rendezvous(nil, nil, nil, "k", RendezvousOptions{}) != -1 || LeastLoad(nil, nil, &next, nil) != -1 || Auto(nil, nil, &next, nil) != -1 {
		t.Fatal("没有候选应该返回 -1")
	}
	if First(nil, nil) != -1 {
		t.Fatal("没有成员应该返回 -1")
	}
}

// ---- 轮流 / 随机 ----

func TestRoundRobinHonorsShare(t *testing.T) {
	members := []Member{{Share: 1}, {Share: 0.25}}
	next := 0
	rnd := rand.New(rand.NewSource(1))
	counts := [2]int{}
	for i := 0; i < 5000; i++ {
		counts[RoundRobin(&next, members, []int{0, 1}, rnd)]++
	}
	// 轮到 b 时四次收一次：b 的份额 = 0.25 ÷ (2×0.25 + 0.75) = 20%。
	if counts[1] < 900 || counts[1] > 1100 {
		t.Fatalf("少分的应该占两成上下：%v", counts)
	}
	// 没有随机数来源：总是收下，纯轮流。
	next = 0
	if a, b := RoundRobin(&next, members, []int{0, 1}, nil), RoundRobin(&next, members, []int{0, 1}, nil); a != 0 || b != 1 {
		t.Fatalf("rnd 为 nil 应该纯轮流：%d %d", a, b)
	}
	// 谁都分不到时也得给一个。
	next = 0
	if got := RoundRobin(&next, []Member{{}, {}}, []int{0, 1}, rnd); got < 0 {
		t.Fatal("都分不到也不能返回 -1")
	}
}

func TestRandomHonorsShare(t *testing.T) {
	members := []Member{{Share: 1}, {Share: 0.5}, {Share: 0}}
	rnd := rand.New(rand.NewSource(2))
	counts := [3]int{}
	for i := 0; i < 6000; i++ {
		counts[Random(members, []int{0, 1, 2}, rnd)]++
	}
	if counts[2] != 0 || counts[0] < 3800 || counts[0] > 4200 {
		t.Fatalf("应该大约 2:1:0：%v", counts)
	}
	if Random(nil, []int{4, 5}, nil) != 4 {
		t.Fatal("没有随机数来源返回第一个候选")
	}
}

// ---- 按访客固定 ----

// 手写的 FNV-1a 必须和 hash/fnv 逐位一致（再搅一遍）：同一个访客在哪台机器上算都落在同一个成员上。
func TestHashKeyIsMixedStdlibFNV(t *testing.T) {
	for _, pair := range [][2]string{{"198.51.100.7", "10.0.0.1:443"}, {"", "x"}, {"key", ""}, {"会话", "出口:1"}} {
		hash := fnv.New64a()
		_, _ = hash.Write([]byte(pair[0]))
		_, _ = hash.Write([]byte{0})
		_, _ = hash.Write([]byte(pair[1]))
		if got := HashKey(pair[0], pair[1]); got != Mix64(hash.Sum64()) {
			t.Fatalf("HashKey(%q,%q)=%d，应该是 %d", pair[0], pair[1], got, Mix64(hash.Sum64()))
		}
	}
}

// 路线图 X2：两个成员的标识只差最后一个字符、分量 900:100。哈希不搅的话所有访客都给了 900 那个。
func TestRendezvousSpreadsNearlyIdenticalMemberKeys(t *testing.T) {
	members, candidates := equalMembers(900, 100)
	keys := []string{"127.0.0.1:20001", "127.0.0.1:20002"}
	counts := [2]int{}
	for i := 0; i < 2000; i++ {
		counts[Rendezvous(members, keys, candidates, fmt.Sprintf("198.51.100.%d", i), RendezvousOptions{})]++
	}
	if counts[1] < 140 || counts[1] > 260 {
		t.Fatalf("应该大约 9:1：%v", counts)
	}
}

func TestRendezvousOnlyMovesTheLeavingMembersVisitors(t *testing.T) {
	members, all := equalMembers(1, 1, 1, 1)
	keys := []string{"a", "b", "c", "d"}
	moved, onLeaving := 0, 0
	for i := 0; i < 2000; i++ {
		visitor := fmt.Sprintf("v%d", i)
		before := Rendezvous(members, keys, all, visitor, RendezvousOptions{})
		after := Rendezvous(members, keys, []int{0, 1, 3}, visitor, RendezvousOptions{})
		if before == 2 {
			onLeaving++
			continue
		}
		if before != after {
			moved++
		}
	}
	if moved != 0 || onLeaving < 400 {
		t.Fatalf("只有落在走掉那个成员上的访客该换：别人换了 %d 个，它上面原有 %d 个", moved, onLeaving)
	}
}

func TestRendezvousBoundedLoadSpillsToTheNextMember(t *testing.T) {
	members, candidates := equalMembers(1, 1)
	keys := []string{"a", "b"}
	scratch := make([]float64, 2)
	options := RendezvousOptions{Scratch: scratch}
	home := Rendezvous(members, keys, candidates, "203.0.113.7", options)
	if again := Rendezvous(members, keys, candidates, "203.0.113.7", options); again != home {
		t.Fatal("同一个访客换了成员")
	}
	members[home].Active = 10
	if spilled := Rendezvous(members, keys, candidates, "203.0.113.7", options); spilled == home {
		t.Fatal("一个已经压了 10 条、另一个空着，还往满的那个放")
	}
	// 都满了：还是给分数最高的。
	members[1-home].Active = 10
	if got := Rendezvous(members, keys, candidates, "203.0.113.7", options); got != home {
		t.Fatalf("都满了应该回到分数最高的 %d，实际 %d", home, got)
	}
	// 不给临时区也能算（现分配）。
	if got := Rendezvous(members, keys, candidates, "203.0.113.7", RendezvousOptions{LoadFactor: 1.25}); got != home {
		t.Fatalf("不给临时区结果应该一样：%d", got)
	}
	// 关掉上限：不管压了多少都回自己的成员。在途的也算负载。
	members[1-home].Active = 0
	if got := Rendezvous(members, keys, candidates, "203.0.113.7", RendezvousOptions{LoadFactor: -1}); got != home {
		t.Fatal("关掉上限应该是纯哈希")
	}
	members[home].Active, members[home].InFlight = 0, 10
	if got := Rendezvous(members, keys, candidates, "203.0.113.7", options); got == home {
		t.Fatal("在途的 10 条也该算进上限")
	}
}

func TestRendezvousIgnoresShareAndZeroWeight(t *testing.T) {
	members := []Member{{Weight: 1, Share: 0.1}, {Weight: 1, Share: 1}, {Weight: 0, Share: 1}}
	plain := []Member{{Weight: 1, Share: 1}, {Weight: 1, Share: 1}, {Weight: 0, Share: 1}}
	keys := []string{"a", "b", "c"}
	for i := 0; i < 500; i++ {
		visitor := fmt.Sprintf("v%d", i)
		got := Rendezvous(members, keys, []int{0, 1, 2}, visitor, RendezvousOptions{})
		if got == 2 {
			t.Fatal("分量 0 的成员不接访客")
		}
		if got != Rendezvous(plain, keys, []int{0, 1, 2}, visitor, RendezvousOptions{}) {
			t.Fatal("慢启动不该挪动访客")
		}
	}
}

// ---- 按负载 / 自动 ----

func TestCostFormula(t *testing.T) {
	members := []Member{
		{Weight: 100, Share: 1, InFlight: 2, Active: 4, Quality: Quality{Latency: 20}},
		{Weight: 100, Share: 0.5, Quality: Quality{Latency: 180, Jitter: 20, Loss: 0.1, Success: 0.9, Utilisation: 0.5}},
		{Weight: 100, Share: 1},
	}
	all := []int{0, 1, 2}
	cost, ok := Cost(members, all, 0, false)
	if want := 20 * 7 / 100.0; !ok || math.Abs(cost-want) > 1e-9 {
		t.Fatalf("成本 = 延迟 × (在途 + 活动 + 1) ÷ 分量：应该是 %v，实际 %v", want, cost)
	}
	cost, ok = Cost(members, all, 1, false)
	if want := (180.0 + 20) * (1 + 10*0.1) * (1 + 10*0.1) * 1 / (100 * 0.5 * 0.5); !ok || math.Abs(cost-want) > 1e-9 {
		t.Fatalf("应该是 %v，实际 %v", want, cost)
	}
	// 不知道延迟的按最快的那个（20ms）算；别的不知道就是不罚。
	if cost, _ = Cost(members, all, 2, false); math.Abs(cost-20/100.0) > 1e-9 {
		t.Fatalf("什么都不知道的成员是中性的：%v", cost)
	}
	// 按负载：只留负载那一半（利用率是负载，照算；延迟、丢包不看）。
	if cost, _ = Cost(members, all, 1, true); math.Abs(cost-1/(100*0.5*0.5)) > 1e-9 {
		t.Fatalf("按负载：%v", cost)
	}
	if _, ok := Cost([]Member{{Weight: 1, Share: 1}, {Weight: 0, Share: 1}}, []int{0, 1}, 1, false); ok {
		t.Fatal("分量 0 的成员不参与")
	}
}

func TestQualityClampsAndNeutralDefaults(t *testing.T) {
	if (Quality{}).Penalty() != 1 || (Quality{}).Headroom() != 1 {
		t.Fatal("什么都不知道：不罚，余量是满的")
	}
	if got := (Quality{Loss: 0.08}).Penalty(); math.Abs(got-1.8) > 1e-9 {
		t.Fatalf("8%% 丢包乘 1.8：%v", got)
	}
	if got := (Quality{Loss: 7}).Penalty(); got != 11 {
		t.Fatalf("丢包率最多按 100%% 算：%v", got)
	}
	if got := (Quality{Loss: math.NaN(), Utilisation: math.NaN()}); got.Penalty() != 1 || got.Headroom() != 1 {
		t.Fatal("NaN 当不知道")
	}
	if got := (Quality{Success: 0.5}).Penalty(); math.Abs(got-6) > 1e-9 {
		t.Fatalf("一半连接失败乘 6：%v", got)
	}
	if got := (Quality{Utilisation: 1}).Headroom(); math.Abs(got-0.05) > 1e-9 {
		t.Fatalf("跑满了也留 5%%：%v", got)
	}
	if got := (Quality{Utilisation: -3}).Headroom(); got != 1 {
		t.Fatalf("负的利用率当 0：%v", got)
	}
}

// 成本对每一项都单调：哪一项变差，成本都不会变低。
func TestCostIsMonotone(t *testing.T) {
	base := Member{Weight: 10, Share: 1, Active: 3, InFlight: 1, Quality: Quality{Latency: 40, Jitter: 5, Loss: 0.01, Success: 0.99, Utilisation: 0.3}}
	other := Member{Weight: 10, Share: 1, Quality: Quality{Latency: 30}}
	costWith := func(change func(*Member)) float64 {
		member := base
		change(&member)
		cost, _ := Cost([]Member{member, other}, []int{0, 1}, 0, false)
		return cost
	}
	reference := costWith(func(*Member) {})
	for name, worse := range map[string]func(*Member){
		"延迟":  func(m *Member) { m.Latency += 10 },
		"抖动":  func(m *Member) { m.Jitter += 10 },
		"丢包":  func(m *Member) { m.Loss += 0.05 },
		"成功率": func(m *Member) { m.Success -= 0.2 },
		"利用率": func(m *Member) { m.Utilisation += 0.3 },
		"活动":  func(m *Member) { m.Active++ },
		"在途":  func(m *Member) { m.InFlight++ },
		"分量":  func(m *Member) { m.Weight /= 2 },
		"几成":  func(m *Member) { m.Share /= 2 },
	} {
		if got := costWith(worse); !(got > reference) {
			t.Errorf("%s变差了成本应该变高：%v → %v", name, reference, got)
		}
	}
}

// ---- peak EWMA ----

func TestPeakEWMAJumpsUpAndDecaysBack(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	var peak PeakEWMA
	if peak.Value(now, 0) != 0 {
		t.Fatal("没有样本是 0")
	}
	peak.Observe(20, now, 0)
	peak.Observe(2000, now.Add(time.Second), 0)
	if got := peak.Value(now.Add(time.Second), 0); got != 2000 {
		t.Fatalf("慢样本应该立刻跳上去：%v", got)
	}
	// 没有新样本：读数按 e^(-t/10s) 落回去。
	if got := peak.Value(now.Add(11*time.Second), 0); math.Abs(got-2000*math.Exp(-1)) > 1e-6 {
		t.Fatalf("10 秒后应该剩 1/e：%v", got)
	}
	if got := peak.Value(now.Add(61*time.Second), 0); got > 6 {
		t.Fatalf("一分钟后尖峰应该基本落完：%v", got)
	}
	// 来了正常的样本：按间隔加权往样本靠，隔得越久靠得越多。
	peak.Observe(20, now.Add(11*time.Second), 0)
	want := 2000*math.Exp(-1) + 20*(1-math.Exp(-1))
	if got := peak.Value(now.Add(11*time.Second), 0); math.Abs(got-want) > 1e-6 {
		t.Fatalf("应该是 %v，实际 %v", want, got)
	}
	// 自定义时间常数；不合法的样本不记；Reset 清空。
	var fast PeakEWMA
	fast.Observe(100, now, time.Second)
	fast.Observe(0, now, time.Second)
	fast.Observe(-5, now, time.Second)
	if got := fast.Value(now.Add(time.Second), time.Second); math.Abs(got-100*math.Exp(-1)) > 1e-6 {
		t.Fatalf("%v", got)
	}
	fast.Reset()
	if fast.Value(now, 0) != 0 {
		t.Fatal("Reset 之后是 0")
	}
}

func TestLeastLoadAvoidsTheBusyMember(t *testing.T) {
	members, candidates := equalMembers(1, 1, 1)
	members[1].Active = 50
	next := 0
	for i := 0; i < 30; i++ {
		if LeastLoad(members, candidates, &next, nil) == 1 {
			t.Fatal("挂着 50 条的那个不该被挑中")
		}
	}
}

// 候选多于 3 个：抽两个比。跑满的那个永远赢不了，其余的都分得到。
func TestLeastLoadPowerOfTwoChoices(t *testing.T) {
	members, candidates := equalMembers(1, 1, 1, 1, 1)
	members[2].Active = 1000
	rnd := rand.New(rand.NewSource(3))
	next := 0
	counts := [5]int{}
	for i := 0; i < 2000; i++ {
		counts[LeastLoad(members, candidates, &next, rnd)]++
	}
	if counts[2] != 0 {
		t.Fatalf("跑满的那个被挑中 %d 次", counts[2])
	}
	for _, index := range []int{0, 1, 3, 4} {
		if counts[index] < 350 {
			t.Fatalf("其余的应该都分到：%v", counts)
		}
	}
	// 抽签看有效分量：一个都分不到的成员（Share 0）不会被抽中。
	members[4].Share = 0
	for i := 0; i < 500; i++ {
		if LeastLoad(members, candidates, &next, rnd) == 4 {
			t.Fatal("Share 为 0 的成员被挑中了")
		}
	}
}

// ---- 延迟优先 ----

func latencies(values ...float64) []Member {
	members := make([]Member, len(values))
	for i, value := range values {
		members[i] = Member{Weight: 1, Share: 1, Quality: Quality{Latency: value}}
	}
	return members
}

func TestNearSetKeepsEveryoneWithinTheMargin(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	members := latencies(20, 60, 200, 0)
	var set NearSet
	near := set.Select(nil, members, []int{0, 1, 2, 3}, NearPolicy{}, now)
	if len(near) != 2 || near[0] != 0 || near[1] != 1 {
		t.Fatalf("20 和 60 一样快，200 和不知道的不算：%v", near)
	}
	var unknown NearSet
	if all := unknown.Select(nil, []Member{{}, {}}, []int{0, 1}, NearPolicy{}, now); len(all) != 2 {
		t.Fatalf("都不知道延迟时不排除谁：%v", all)
	}
}

func TestNearSetHoldsMembersInButLetsThemBackImmediately(t *testing.T) {
	var set NearSet
	policy := NearPolicy{Margin: 50, Hold: time.Minute}
	now := time.Unix(1_800_000_000, 0)
	members := latencies(20, 60)
	all := []int{0, 1}
	if near := set.Select(nil, members, all, policy, now); len(near) != 2 {
		t.Fatalf("起初两个都在：%v", near)
	}
	// b 的延迟跳到门槛外：刚进组不到一分钟，先留着。
	members[1].Latency = 90
	if near := set.Select(nil, members, all, policy, now.Add(10*time.Second)); len(near) != 2 {
		t.Fatalf("驻留期内不该踢出去：%v", near)
	}
	// 过了驻留还在门槛外：出组。
	if near := set.Select(nil, members, all, policy, now.Add(61*time.Second)); len(near) != 1 || near[0] != 0 {
		t.Fatalf("过了驻留应该出组：%v", near)
	}
	// 回到门槛内：马上回来（一个尖峰不该让它空等一分钟）。
	members[1].Latency = 30
	if near := set.Select(nil, members, all, policy, now.Add(64*time.Second)); len(near) != 2 {
		t.Fatalf("回到门槛以内应该马上回来：%v", near)
	}
	// 刚回来又慢了：回来不到一分钟，留着。
	members[1].Latency = 200
	if near := set.Select(nil, members, all, policy, now.Add(70*time.Second)); len(near) != 2 {
		t.Fatalf("刚回来的要留满驻留：%v", near)
	}
	if !set.Contains(1) || set.Contains(7) {
		t.Fatal("Contains 不对")
	}
	// 抖动算在延迟上：30ms + 抖动 60ms 按 90ms 比。
	var jitter NearSet
	jittery := latencies(20, 30)
	jittery[1].Jitter = 60
	if near := jitter.Select(nil, jittery, all, NearPolicy{Margin: 50}, now); len(near) != 1 || near[0] != 0 {
		t.Fatalf("抖得厉害的不算一样快：%v", near)
	}
}

// 驻留不拦逃生：组里的成员不在候选里了（挂了），剩下的哪怕刚被踢出去也得用。
func TestNearSetEscapesWhenTheSetIsEmpty(t *testing.T) {
	var set NearSet
	policy := NearPolicy{Margin: 50, Hold: time.Minute}
	now := time.Unix(1_800_000_000, 0)
	members := latencies(20, 300)
	if near := set.Select(nil, members, []int{0, 1}, policy, now); len(near) != 1 || near[0] != 0 {
		t.Fatalf("%v", near)
	}
	if near := set.Select(nil, members, []int{1}, policy, now.Add(time.Second)); len(near) != 1 || near[0] != 1 {
		t.Fatalf("快的那个没了，慢的也得用：%v", near)
	}
}

// ---- 慢启动 ----

func TestSlowStartRamp(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	for _, item := range []struct {
		ago  time.Duration
		want float64
	}{{0, 0.1}, {3 * time.Second, 0.1}, {30 * time.Second, 0.5}, {59 * time.Second, 59.0 / 60}, {60 * time.Second, 1}, {time.Hour, 1}} {
		if got := DefaultSlowStart.Factor(now.Add(-item.ago), now); math.Abs(got-item.want) > 1e-9 {
			t.Fatalf("恢复 %s 后应该是 %v，实际 %v", item.ago, item.want, got)
		}
	}
	if DefaultSlowStart.Factor(time.Time{}, now) != 1 {
		t.Fatal("没挂过的是满份")
	}
	if got := DefaultSlowStart.Factor(now.Add(time.Second), now); got != 0.1 {
		t.Fatalf("恢复时刻在未来（时钟回拨）按起步算：%v", got)
	}
}

// ---- 抖动抑制 ----

var testFlapPolicy = FlapPolicy{Window: time.Hour, Threshold: 3, Base: 5 * time.Minute, Max: time.Hour}

func TestFlapDamperDoublesUpToTheMax(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	damper := FlapDamper{Policy: testFlapPolicy}
	if damper.Hold(now) != 0 || damper.Flapping(now) {
		t.Fatal("没切过不该压")
	}
	for i := 3; i >= 1; i-- {
		damper.Note(now.Add(-time.Duration(i) * time.Minute))
	}
	if got := damper.Hold(now); got != 5*time.Minute {
		t.Fatalf("三次起压 5 分钟：%s", got)
	}
	damper.Note(now)
	if got := damper.Hold(now); got != 10*time.Minute {
		t.Fatalf("第四次翻倍：%s", got)
	}
	for i := 0; i < 10; i++ {
		damper.Note(now)
	}
	if got := damper.Hold(now); got != time.Hour {
		t.Fatalf("最多一小时：%s", got)
	}
	// 窗口以外的不算，记的时候顺手丢掉。
	old := FlapDamper{Policy: testFlapPolicy}
	for i := 0; i < 5; i++ {
		old.Note(now.Add(-2 * time.Hour))
	}
	if old.Hold(now) != 0 {
		t.Fatal("两小时前的不该算")
	}
	old.Note(now)
	if len(old.Events) != 1 {
		t.Fatalf("窗口以外的应该被丢掉：%d", len(old.Events))
	}
}

func TestFlapDamperIgnoresWarmupAndNeverBlocksAnEscape(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	damper := FlapDamper{Policy: testFlapPolicy, WarmupUntil: now}
	for i := 1; i <= 3; i++ {
		if damper.Note(now.Add(-time.Duration(i) * time.Second)) {
			t.Fatal("预热期里的不该记")
		}
	}
	if damper.Count(now) != 0 {
		t.Fatal("预热期里的切换被记了账")
	}
	for i := 0; i < 3; i++ {
		if !damper.Note(now.Add(time.Duration(i) * time.Second)) {
			t.Fatal("过了预热期应该记")
		}
	}
	at := now.Add(3 * time.Second)
	if !damper.Holding(at, at.Add(-time.Minute), 0, false) {
		t.Fatal("一分钟前刚切过、要求驻留 5 分钟：应该压着")
	}
	if damper.Holding(at, at.Add(-time.Minute), 0, true) {
		t.Fatal("逃生不受限")
	}
	if damper.Holding(at, at.Add(-6*time.Minute), 0, false) {
		t.Fatal("驻留过了就不压")
	}
	if damper.Holding(at, time.Time{}, time.Hour, false) {
		t.Fatal("还没切过不压")
	}
	// 配置的最短驻留和抖动抑制取长的。
	calm := FlapDamper{Policy: testFlapPolicy}
	if !calm.Holding(at, at.Add(-time.Minute), 10*time.Minute, false) || calm.Holding(at, at.Add(-11*time.Minute), 10*time.Minute, false) {
		t.Fatal("没在抖时按配置的最短驻留")
	}
}

func TestFlapPolicyFixedHold(t *testing.T) {
	policy := FlapPolicy{Window: time.Hour, Threshold: 4, Base: 5 * time.Minute, Max: 5 * time.Minute}
	if policy.HoldFor(3) != 0 || policy.HoldFor(4) != 5*time.Minute || policy.HoldFor(40) != 5*time.Minute {
		t.Fatalf("Base = Max 是固定的驻留：%s %s %s", policy.HoldFor(3), policy.HoldFor(4), policy.HoldFor(40))
	}
	if (FlapPolicy{}).HoldFor(100) != 0 {
		t.Fatal("没配置的策略不压")
	}
}

// ---- 候选：摘除上限和恐慌 ----

func healths(words string) []Health {
	list := make([]Health, len(words))
	for i, word := range words {
		switch word {
		case 's':
			list[i] = Health{Soft: true}
		case 't':
			list[i] = Health{DownstreamDown: true}
		case 'd':
			list[i] = Health{Dead: true}
		case 'c':
			list[i] = Health{Dead: true, Cooling: true}
		case 'x':
			list[i] = Health{Excluded: true}
		}
	}
	return list
}

func TestCandidates(t *testing.T) {
	for _, item := range []struct {
		health string // h 健康 s 软信号 t 下游不通 d 连不上 x 排除
		skip   map[int]bool
		policy EjectPolicy
		want   []int
		level  Level
	}{
		{"hhd", nil, EjectPolicy{}, []int{0, 1}, LevelNormal},
		{"hshs", nil, EjectPolicy{}, []int{0, 2}, LevelNormal},                      // 4 个里 2 个软：一半以内，全摘
		{"sssh", nil, EjectPolicy{}, []int{0, 3}, LevelNormal},                      // 3 个软：最多摘 2 个，留下标小的
		{"ssss", nil, EjectPolicy{}, []int{0, 1}, LevelNormal},                      // 全软：摘一半
		{"sh", nil, EjectPolicy{}, []int{1}, LevelNormal},                           // 2 个里摘 1 个
		{"s", nil, EjectPolicy{}, []int{0}, LevelNormal},                            // 只有一个：至少留一个
		{"sd", nil, EjectPolicy{}, []int{0}, LevelNormal},                           // 连得上的只有它
		{"shh", nil, EjectPolicy{MaxSoftEject: -1}, []int{0, 1, 2}, LevelNormal},    // 不摘
		{"sshh", nil, EjectPolicy{MaxSoftEject: 0.25}, []int{0, 2, 3}, LevelNormal}, // 上限两成半：4 个里摘 1 个
		{"tdt", nil, EjectPolicy{}, []int{0, 2}, LevelPanic},                        // 没有正常的：所有连得上的
		{"htt", nil, EjectPolicy{PanicBelow: 2}, []int{0, 1, 2}, LevelPanic},        // 正常的不到 2 个：恐慌
		{"hht", nil, EjectPolicy{PanicBelow: 2}, []int{0, 1}, LevelNormal},
		{"sht", nil, EjectPolicy{PanicBelow: 2}, []int{0, 1, 2}, LevelPanic}, // 摘完只剩 1 个，不够：恐慌，软的也算
		{"ddx", nil, EjectPolicy{}, []int{0, 1}, LevelDead},                  // 都连不上：所有没被排除的
		{"cdc", nil, EjectPolicy{}, []int{0, 1, 2}, LevelDead},               // 分着用时不分冷却没冷却：摊开
		{"xx", nil, EjectPolicy{}, nil, LevelNone},
		{"hhd", map[int]bool{0: true, 1: true}, EjectPolicy{}, []int{2}, LevelDead}, // 健康的都试过了
		{"hd", map[int]bool{0: true, 1: true}, EjectPolicy{}, nil, LevelNone},
		{"", nil, EjectPolicy{}, nil, LevelNone},
	} {
		got, level := Candidates(nil, healths(item.health), item.skip, item.policy)
		if level != item.level || fmt.Sprint(got) != fmt.Sprint(item.want) {
			t.Errorf("%q skip=%v policy=%+v：应该是 %v（第 %d 步），实际 %v（第 %d 步）", item.health, item.skip, item.policy, item.want, item.level, got, level)
		}
	}
	// 追加到 dst，不动 dst 里原有的。
	if got, _ := Candidates([]int{9}, healths("hh"), nil, EjectPolicy{}); fmt.Sprint(got) != "[9 0 1]" {
		t.Fatalf("%v", got)
	}
}

func TestFirstPrefersStableThenSoftThenDownstreamThenDead(t *testing.T) {
	for _, item := range []struct {
		health string
		skip   map[int]bool
		want   int
	}{
		{"tssh", nil, 3},
		{"tssd", nil, 1},
		{"tdd", nil, 0},
		{"dd", nil, 0},
		{"cd", nil, 1}, // 全都连不上：先试冷却到期的
		{"cc", nil, 0},
		{"ctc", nil, 1},
		{"xd", nil, 1},
		{"xx", nil, -1},
		{"hh", map[int]bool{0: true}, 1},
	} {
		if got := First(healths(item.health), item.skip); got != item.want {
			t.Errorf("%q：应该是 %d，实际 %d", item.health, item.want, got)
		}
	}
}

func TestEffectiveWeight(t *testing.T) {
	members := []Member{{Weight: 10, Share: 0.5}, {Weight: 20, Share: 1}}
	if EffectiveWeight(members, []int{0, 1}, 0) != 5 || EffectiveWeight(members, []int{0, 1}, 1) != 20 {
		t.Fatal("有效分量 = Weight × Share")
	}
}

// ---- 开销 ----

func benchMembers() ([]Member, []int, []string) {
	members := []Member{
		{Weight: 500, Share: 1, InFlight: 1.5, Active: 12, Quality: Quality{Latency: 23, Jitter: 4, Loss: 0.01, Utilisation: 0.4}},
		{Weight: 300, Share: 0.6, InFlight: 0.2, Active: 5, Quality: Quality{Latency: 31, Utilisation: 0.1}},
		{Weight: 200, Share: 1, InFlight: 0, Active: 2, Quality: Quality{Latency: 140, Success: 0.97}},
	}
	return members, []int{0, 1, 2}, []string{"10.0.0.1:443", "10.0.0.2:443", "10.0.0.3:443"}
}

func BenchmarkAuto(b *testing.B) {
	members, candidates, _ := benchMembers()
	next := 0
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		Auto(members, candidates, &next, nil)
	}
}

func BenchmarkRendezvousBounded(b *testing.B) {
	members, candidates, keys := benchMembers()
	options := RendezvousOptions{Scratch: make([]float64, len(members))}
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		Rendezvous(members, keys, candidates, "203.0.113.7", options)
	}
}

func BenchmarkSmoothWRR(b *testing.B) {
	members, candidates, _ := benchMembers()
	wrr := make(SmoothWRR, len(members))
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		wrr.Pick(members, candidates)
	}
}

func BenchmarkCandidates(b *testing.B) {
	health := healths("hshd")
	buffer := make([]int, 0, 4)
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		Candidates(buffer[:0], health, nil, EjectPolicy{})
	}
}

// ---- 总入口 ----

func TestPickDispatchesEveryStrategy(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	members, candidates := equalMembers(1, 1, 1)
	keys := []string{"a", "b", "c"}
	for _, strategy := range Strategies {
		if !ValidStrategy(strategy) {
			t.Fatalf("%s 应该认得", strategy)
		}
		next := 0
		var near NearSet
		state := State{WRR: make(SmoothWRR, 3), Near: &near, Next: &next}
		if got := Pick(strategy, state, members, keys, candidates, "203.0.113.7", now, nil, Options{}); got < 0 || got > 2 {
			t.Fatalf("%s 挑出了 %d", strategy, got)
		}
		if Pick(strategy, state, members, keys, nil, "k", now, nil, Options{}) != -1 {
			t.Fatalf("%s：没有候选应该是 -1", strategy)
		}
	}
	if ValidStrategy("least_conn") || len(Strategies) != 8 {
		t.Fatal("只有八种分配方式")
	}
	// 认不出的名字、不知道访客是谁的按访客固定：轮流。零值的 State 也能用。
	next := 0
	for _, strategy := range []string{"nonsense", StrategyIPHash} {
		next = 0
		first := Pick(strategy, State{Next: &next}, members, keys, candidates, "", now, nil, Options{})
		second := Pick(strategy, State{Next: &next}, members, keys, candidates, "", now, nil, Options{})
		if first != 0 || second != 1 {
			t.Fatalf("%s 应该轮流：%d %d", strategy, first, second)
		}
	}
	if got := Pick(StrategyWeighted, State{}, members, keys, candidates, "", now, nil, Options{}); got < 0 {
		t.Fatal("零值的 State 也得挑得出来")
	}
	// 按访客固定走的就是 Rendezvous。
	if got, want := Pick(StrategyIPHash, State{}, members, keys, candidates, "v1", now, nil, Options{}), Rendezvous(members, keys, candidates, "v1", RendezvousOptions{}); got != want {
		t.Fatalf("%d != %d", got, want)
	}
}
