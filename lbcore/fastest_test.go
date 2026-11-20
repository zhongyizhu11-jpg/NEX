package lbcore

import (
	"testing"
	"time"
)

func fastestMembers(latencies ...float64) []Member {
	members := make([]Member, len(latencies))
	for i, latency := range latencies {
		members[i] = Member{Weight: 1, Share: 1, Quality: Quality{Latency: latency}}
	}
	return members
}

func TestFastestPicksOnlyTheFastest(t *testing.T) {
	var state Fastest
	members := fastestMembers(4, 3, 60)
	now := time.Unix(1_800_000_000, 0)
	for i := 0; i < 50; i++ {
		if got := state.Select(members, []int{0, 1, 2}, FastestPolicy{Margin: 50}, now, true); got != 1 {
			t.Fatalf("第 %d 次：只该走最快的 1，得到 %d", i, got)
		}
	}
	if current, ok := state.Current(); !ok || current != 1 {
		t.Fatalf("在用的应当是 1，得到 %d %v", current, ok)
	}
}

func TestFastestSlightlyFasterChallengerDoesNotTakeOver(t *testing.T) {
	var state Fastest
	policy := FastestPolicy{Margin: 50}
	now := time.Unix(1_800_000_000, 0)
	members := fastestMembers(3, 4, 60)
	state.Select(members, []int{0, 1, 2}, policy, now, true)
	// 1 变得比 0 快 1ms：不够门槛，一直不换
	members[1].Latency = 2
	for i := 0; i <= 10; i++ {
		if got := state.Select(members, []int{0, 1, 2}, policy, now.Add(time.Duration(i)*time.Minute), true); got != 0 {
			t.Fatalf("快 1ms 不该换过去（%d 分钟），得到 %d", i, got)
		}
	}
}

func TestFastestMuchFasterChallengerTakesOverAfterHold(t *testing.T) {
	var state Fastest
	policy := FastestPolicy{Margin: 50}
	now := time.Unix(1_800_000_000, 0)
	members := fastestMembers(80, 90, 100)
	if got := state.Select(members, []int{0, 1, 2}, policy, now, true); got != 0 {
		t.Fatalf("起步应当是最快的 0，得到 %d", got)
	}
	// 2 快出 60ms 以上、快一半多（「好得多」）：照样要等满 60 秒
	members[2].Latency = 20
	for _, after := range []time.Duration{0, 10 * time.Second, 30 * time.Second, 59 * time.Second} {
		if got := state.Select(members, []int{0, 1, 2}, policy, now.Add(after), true); got != 0 {
			t.Fatalf("%s：还没稳住 60 秒，不该换，得到 %d", after, got)
		}
	}
	if got := state.Select(members, []int{0, 1, 2}, policy, now.Add(60*time.Second), true); got != 2 {
		t.Fatalf("稳住 60 秒后该换到 2，得到 %d", got)
	}
}

func TestFastestChallengeResetsWhenItStopsLeading(t *testing.T) {
	var state Fastest
	policy := FastestPolicy{Margin: 50}
	now := time.Unix(1_800_000_000, 0)
	members := fastestMembers(100, 120)
	state.Select(members, []int{0, 1}, policy, now, true)
	members[1].Latency = 20
	state.Select(members, []int{0, 1}, policy, now.Add(time.Second), true)
	// 中途回到一样快：重新计时
	members[1].Latency = 90
	state.Select(members, []int{0, 1}, policy, now.Add(40*time.Second), true)
	members[1].Latency = 20
	if got := state.Select(members, []int{0, 1}, policy, now.Add(70*time.Second), true); got != 0 {
		t.Fatalf("中途断过，应当重新计时，得到 %d", got)
	}
	if got := state.Select(members, []int{0, 1}, policy, now.Add(130*time.Second), true); got != 1 {
		t.Fatalf("重新稳住 60 秒后该换，得到 %d", got)
	}
}

func TestFastestCurrentDownTakesNextFastestAtOnce(t *testing.T) {
	var state Fastest
	policy := FastestPolicy{Margin: 50}
	now := time.Unix(1_800_000_000, 0)
	members := fastestMembers(3, 4, 60, 90)
	state.Select(members, []int{0, 1, 2, 3}, policy, now, true)
	// 0 坏了（不在候选里）：当场换到次快的 1
	if got := state.Select(members, []int{1, 2, 3}, policy, now.Add(time.Second), true); got != 1 {
		t.Fatalf("在用的坏了，该当场换到次快的 1，得到 %d", got)
	}
	// 0 恢复了、只快 1ms：不切回
	if got := state.Select(members, []int{0, 1, 2, 3}, policy, now.Add(10*time.Minute), true); got != 1 {
		t.Fatalf("恢复的只快 1ms，不该切回，得到 %d", got)
	}
}

func TestFastestTransientPickDoesNotMoveTheState(t *testing.T) {
	var state Fastest
	policy := FastestPolicy{Margin: 50}
	now := time.Unix(1_800_000_000, 0)
	members := fastestMembers(3, 4, 60)
	state.Select(members, []int{0, 1, 2}, policy, now, true)
	// 这一条连接拨 0 失败了，排除 0 重挑：给次快的，但在用的还是 0
	if got := state.Select(members, []int{1, 2}, policy, now, false); got != 1 {
		t.Fatalf("换路重拨该给次快的 1，得到 %d", got)
	}
	if current, _ := state.Current(); current != 0 {
		t.Fatalf("换路重拨不该改在用的，得到 %d", current)
	}
}

func TestFastestUnknownLatency(t *testing.T) {
	var state Fastest
	policy := FastestPolicy{Margin: 50}
	now := time.Unix(1_800_000_000, 0)
	members := fastestMembers(0, 0, 0)
	if got := state.Select(members, []int{2, 0, 1}, policy, now, true); got != 2 {
		t.Fatalf("都不知道延迟：取候选里的第一个，得到 %d", got)
	}
	// 量出来了：在用的那台没量出，当场换到最快的
	members[0].Latency, members[1].Latency = 30, 10
	if got := state.Select(members, []int{0, 1, 2}, policy, now.Add(time.Second), true); got != 1 {
		t.Fatalf("在用的没量出延迟，该当场换到最快的 1，得到 %d", got)
	}
}

func TestFastestRemapFollowsTheMember(t *testing.T) {
	var state Fastest
	policy := FastestPolicy{Margin: 50}
	now := time.Unix(1_800_000_000, 0)
	members := fastestMembers(10, 100)
	state.Select(members, []int{0, 1}, policy, now, true)
	// 顺序换了：新的 1 是旧的 0
	moved := state.Remap([]int{1, 0})
	if current, ok := moved.Current(); !ok || current != 1 {
		t.Fatalf("Remap 后在用的应当跟到新下标 1，得到 %d %v", current, ok)
	}
	// 在用的那台没了：当刚起来
	gone := state.Remap([]int{1, -1})
	if _, ok := gone.Current(); ok {
		t.Fatal("在用的那台不在了，应当当刚起来")
	}
}

func TestPickLatencyFastestOnly(t *testing.T) {
	var fastest Fastest
	var near NearSet
	members := fastestMembers(4, 3, 30)
	now := time.Unix(1_800_000_000, 0)
	state := State{Near: &near, Fastest: &fastest}
	counts := make([]int, 3)
	for i := 0; i < 30; i++ {
		counts[Pick(StrategyLatency, state, members, nil, []int{0, 1, 2}, "", now, nil, Options{Near: NearPolicy{Margin: 50}, FastestOnly: true})]++
	}
	if counts[1] != 30 {
		t.Fatalf("只走最快的一台：want 全给 1，got %v", counts)
	}
}
