/*
Package lbtest 是 lbcore 的一致性测试：同一批用例（lbcore/testdata/conformance/*.json），三处各跑一遍 ——

  - lbcore 自己（Reference：直接调 lbcore 的函数）；
  - agent/ 里一个测试，拿线路组真实的挑选入口（failoverProxy.pickTargetForKeyProto / pickReserved）跑；
  - forwardx-fxp/ 里一个测试，拿出口选择器真实的挑选入口（exitEndpointSelector.pick）跑。

两边以后谁改了挑选的规矩而另一边没跟上，这里就红。用例只写三边都该一样的东西：分布的上下界、确定的序列、
「谁永远不该被挑中」；某一边没有的概念（线路组没有「不稳」「下游不通」这两个信号）用 only 标出只给谁跑。

用例格式见 Case。只给测试用，不要在产品代码里引用。
*/
package lbtest

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"

	"github.com/zhongyizhu11-jpg/NEX/lbcore"
)

// 成员的健康，用例里写这几个词。每个实现按自己的状态去摆（见各自的 Driver）。
const (
	HealthHealthy    = "healthy"     // 健康而且稳（默认）
	HealthUnstable   = "unstable"    // 软信号：连得上但不稳（按「切走」处理）/ 刚恢复还在观察
	HealthTargetDown = "target_down" // 连得上，但它到下游（目标）不通
	HealthDown       = "down"        // 硬信号：连不上
	HealthExcluded   = "excluded"    // 管理上排除（暂停 / 维护）：永远不挑
)

// 一次挑选之后那条连接怎么样。
const (
	ModeRelease = "release" // 默认：挑完就退（不留负载），只看挑选规矩本身
	ModeBurst   = "burst"   // 挑中了、还没拨通：留一笔在途。同时到的一批连接
	ModeHold    = "hold"    // 拨通了、一直挂着：留一条活动连接
)

// Case 是一个用例：一组成员、一种分配方式、几步操作和每一步的预期。
type Case struct {
	Name     string   `json:"name"`
	About    string   `json:"about"`
	Strategy string   `json:"strategy"`
	Members  []Member `json:"members"`
	Steps    []Step   `json:"steps"`
	// Only：只给这几个实现跑（lbcore / agent / fxp）。不写就是都跑。
	Only []string `json:"only,omitempty"`
}

// Member 是用例里的一个成员。
type Member struct {
	Name string `json:"name"`
	// Weight 权重（线路带宽）。都不写就是一样大。
	Weight float64 `json:"weight,omitempty"`
	// Health 起始的健康，不写是 healthy。
	Health string `json:"health,omitempty"`
	// LatencyMs 到这个成员的延迟（自动用）：等于起步时刚量到这么一个样本。不写是不知道。
	LatencyMs float64 `json:"latencyMs,omitempty"`
	// 丢包率、利用率。不写是不知道。
	QualitySpec
}

// Step 是一步：先改状态（Set / Recovered），再挑 Picks 次，再核对 Expect。
type Step struct {
	About string `json:"about,omitempty"`
	// Set：成员 → 健康。
	Set map[string]string `json:"set,omitempty"`
	// Recovered：成员 → 多少秒之前从挂掉恢复的（慢启动从那时起算）。
	Recovered map[string]float64 `json:"recovered,omitempty"`
	// Quality：成员 → 丢包率、利用率（整个换掉以前的）。
	Quality map[string]QualitySpec `json:"quality,omitempty"`
	// Latency：成员 → 它的延迟样本（整个换掉以前的），每个样本是 [多少秒之前, 毫秒]，按时间先后写。
	Latency map[string][][2]float64 `json:"latency,omitempty"`
	// Picks：挑几次（给了 Keys 就按 Keys 的个数）。
	Picks int `json:"picks,omitempty"`
	// Keys：每次挑选的访客标识。
	Keys *Keys  `json:"keys,omitempty"`
	Mode string `json:"mode,omitempty"`
	// Save：把这一步「哪个访客挑到了谁」记在这个名字下，后面的步骤可以拿来比。
	Save   string `json:"save,omitempty"`
	Expect Expect `json:"expect"`
	// Only：这一步只给这几个实现跑。
	Only []string `json:"only,omitempty"`
}

// Keys 是一批访客标识：直接列出来，或者 Pattern（带一个 %d）从 0 数到 Count-1。Repeat > 1 时整批重复这么多遍
// （同一个访客开很多条连接）。
type Keys struct {
	List    []string `json:"list,omitempty"`
	Pattern string   `json:"pattern,omitempty"`
	Count   int      `json:"count,omitempty"`
	Repeat  int      `json:"repeat,omitempty"`
}

// Expect 是一步的预期。不写的就不查。
type Expect struct {
	// Exact：挑选的结果依次是这些成员（可以比挑的次数短，只对前几个）。
	Exact []string `json:"exact,omitempty"`
	// Counts：成员 → [最少, 最多] 被挑中几次。
	Counts map[string][2]int `json:"counts,omitempty"`
	// Totals：成员 → [最少, 最多]，从用例开始到这一步为止一共被挑中几次（hold / burst 时就是它身上压着多少）。
	Totals map[string][2]int `json:"totals,omitempty"`
	// Never：这些成员一次都不该被挑中。
	Never []string `json:"never,omitempty"`
	// Rejected：每一次都挑不出来（全被排除）。
	Rejected bool `json:"rejected,omitempty"`
	// SameAs：每个访客挑到的和记下的那一步一模一样。
	SameAs string `json:"sameAs,omitempty"`
	// MovedOnlyFrom：和记下的那一步比，只有原来落在 Members 上的访客换了成员，其余人不动。
	MovedOnlyFrom *Moved `json:"movedOnlyFrom,omitempty"`
	// Reference：每个访客挑到的就是 lbcore.Rendezvous 按这个实现的成员标识算出来的那个（所有成员都参与）。
	Reference bool `json:"reference,omitempty"`
}

// QualitySpec 是用例里能给的质量信号（延迟另有样本）：LossPct 丢包率（百分比），Utilisation 利用率（0–1）。
type QualitySpec struct {
	LossPct     float64 `json:"lossPct,omitempty"`
	Utilisation float64 `json:"utilisation,omitempty"`
}

// LatencySample 是一个延迟样本：Ago 秒之前量到 Ms 毫秒。
type LatencySample struct {
	Ago float64
	Ms  float64
}

// Moved 见 Expect.MovedOnlyFrom。
type Moved struct {
	Saved   string   `json:"saved"`
	Members []string `json:"members"`
}

/*
Driver 是一个被测的实现。Run 对每个用例调一次 Start，再按步骤调其余的。

实现要保证确定性：轮询、加权从第一个成员起步（相位清零），随机数用固定种子。
*/
type Driver interface {
	// Name：lbcore / agent / fxp。
	Name() string
	// Start 按用例搭一个挑选器（成员、权重、起始健康；起始延迟由 Run 接着用 SetLatency 给）。
	Start(c Case) error
	// SetHealth 把成员 index 摆成 health。
	SetHealth(index int, health string) error
	// SetRecovered 成员 index 是 seconds 秒之前从挂掉恢复的。
	SetRecovered(index int, seconds float64) error
	// SetLatency 把成员 index 的延迟样本整个换成 samples（按时间先后）。
	SetLatency(index int, samples []LatencySample) error
	// Pick 给访客 key 挑一个成员，返回下标；挑不出来返回 -1。
	Pick(key string, mode string) (int, error)
	// SetQuality 把成员 index 的丢包率、利用率换成 quality。
	SetQuality(index int, quality QualitySpec) error
	// MemberKeys 按访客固定时每个成员参与哈希的标识。
	MemberKeys() []string
	// Close 收尾（关掉为这个用例起的东西）。
	Close()
}

// Dir 找到 lbcore/testdata/conformance。测试是从源码跑的，按这个文件自己的位置找；找不到再按当前目录猜。
func Dir() (string, error) {
	candidates := []string{}
	if _, file, _, ok := runtime.Caller(0); ok {
		candidates = append(candidates, filepath.Join(filepath.Dir(file), "..", "testdata", "conformance"))
	}
	candidates = append(candidates,
		filepath.Join("testdata", "conformance"),
		filepath.Join("..", "testdata", "conformance"),
		filepath.Join("..", "lbcore", "testdata", "conformance"),
	)
	for _, dir := range candidates {
		if matches, _ := filepath.Glob(filepath.Join(dir, "*.json")); len(matches) > 0 {
			return dir, nil
		}
	}
	return "", fmt.Errorf("找不到 lbcore/testdata/conformance（试过 %s）", strings.Join(candidates, "、"))
}

// Load 读出全部用例，按文件名、文件里的先后排。一个文件是一个用例数组。
func Load() ([]Case, error) {
	dir, err := Dir()
	if err != nil {
		return nil, err
	}
	files, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil {
		return nil, err
	}
	sort.Strings(files)
	var cases []Case
	seen := map[string]string{}
	for _, file := range files {
		data, err := os.ReadFile(file)
		if err != nil {
			return nil, err
		}
		var batch []Case
		decoder := json.NewDecoder(strings.NewReader(string(data)))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&batch); err != nil {
			return nil, fmt.Errorf("%s: %w", filepath.Base(file), err)
		}
		for _, c := range batch {
			if c.Name == "" || len(c.Members) == 0 || len(c.Steps) == 0 {
				return nil, fmt.Errorf("%s: 用例要有名字、成员和步骤：%+v", filepath.Base(file), c.Name)
			}
			if other, dup := seen[c.Name]; dup {
				return nil, fmt.Errorf("用例重名 %q（%s 和 %s）", c.Name, other, filepath.Base(file))
			}
			seen[c.Name] = filepath.Base(file)
			cases = append(cases, c)
		}
	}
	return cases, nil
}

func applies(only []string, name string) bool {
	if len(only) == 0 {
		return true
	}
	for _, item := range only {
		if item == name {
			return true
		}
	}
	return false
}

func (k *Keys) expand(picks int) []string {
	if k == nil {
		return make([]string, picks)
	}
	keys := append([]string(nil), k.List...)
	for i := 0; i < k.Count; i++ {
		keys = append(keys, fmt.Sprintf(k.Pattern, i))
	}
	once := len(keys)
	for round := 1; round < k.Repeat; round++ {
		keys = append(keys, keys[:once]...)
	}
	return keys
}

// Run 拿 driver 把全部用例跑一遍。
func Run(t *testing.T, driver Driver) {
	t.Helper()
	cases, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(cases) == 0 {
		t.Fatal("一个用例都没有")
	}
	for _, c := range cases {
		c := c
		t.Run(c.Name, func(t *testing.T) {
			if !applies(c.Only, driver.Name()) {
				t.Skipf("只给 %v 跑", c.Only)
			}
			runCase(t, driver, c)
		})
	}
}

func runCase(t *testing.T, driver Driver, c Case) {
	t.Helper()
	index := map[string]int{}
	for i, member := range c.Members {
		index[member.Name] = i
	}
	lookup := func(name string) int {
		i, ok := index[name]
		if !ok {
			t.Fatalf("用例里没有成员 %q", name)
		}
		return i
	}
	if err := driver.Start(c); err != nil {
		t.Fatalf("搭不起来：%v", err)
	}
	defer driver.Close()
	for i, member := range c.Members {
		if member.LatencyMs > 0 {
			if err := driver.SetLatency(i, []LatencySample{{Ms: member.LatencyMs}}); err != nil {
				t.Fatal(err)
			}
		}
		if member.QualitySpec != (QualitySpec{}) {
			if err := driver.SetQuality(i, member.QualitySpec); err != nil {
				t.Fatal(err)
			}
		}
	}
	saved := map[string]map[string]int{}
	totals := make([]int, len(c.Members))
	for number, step := range c.Steps {
		if !applies(step.Only, driver.Name()) {
			continue
		}
		label := fmt.Sprintf("第 %d 步", number+1)
		if step.About != "" {
			label += "（" + step.About + "）"
		}
		for _, name := range sortedKeys(step.Set) {
			if err := driver.SetHealth(lookup(name), step.Set[name]); err != nil {
				t.Fatalf("%s：把 %s 摆成 %s 失败：%v", label, name, step.Set[name], err)
			}
		}
		for _, name := range sortedKeys(step.Recovered) {
			if err := driver.SetRecovered(lookup(name), step.Recovered[name]); err != nil {
				t.Fatalf("%s：%v", label, err)
			}
		}
		for _, name := range sortedKeys(step.Latency) {
			samples := make([]LatencySample, 0, len(step.Latency[name]))
			for _, pair := range step.Latency[name] {
				samples = append(samples, LatencySample{Ago: pair[0], Ms: pair[1]})
			}
			if err := driver.SetLatency(lookup(name), samples); err != nil {
				t.Fatalf("%s：%v", label, err)
			}
		}
		for _, name := range sortedKeys(step.Quality) {
			if err := driver.SetQuality(lookup(name), step.Quality[name]); err != nil {
				t.Fatalf("%s：%v", label, err)
			}
		}
		keys := step.Keys.expand(step.Picks)
		mode := step.Mode
		if mode == "" {
			mode = ModeRelease
		}
		picks := make([]int, len(keys))
		for i, key := range keys {
			pick, err := driver.Pick(key, mode)
			if err != nil {
				t.Fatalf("%s：第 %d 次挑选出错：%v", label, i+1, err)
			}
			if pick < -1 || pick >= len(c.Members) {
				t.Fatalf("%s：第 %d 次挑到了不存在的成员 %d", label, i+1, pick)
			}
			picks[i] = pick
			if pick >= 0 {
				totals[pick]++
			}
		}
		for _, member := range sortedKeys(step.Expect.Totals) {
			bounds := step.Expect.Totals[member]
			if got := totals[lookup(member)]; got < bounds[0] || got > bounds[1] {
				t.Errorf("%s：到这一步为止 %s 应该一共被挑中 %d～%d 次，实际 %d（各成员 %v）", label, member, bounds[0], bounds[1], got, totals)
			}
		}
		if step.Save != "" {
			record := map[string]int{}
			for i, key := range keys {
				record[key] = picks[i]
			}
			saved[step.Save] = record
		}
		checkStep(t, driver, c, label, step.Expect, keys, picks, saved, lookup)
	}
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func checkStep(t *testing.T, driver Driver, c Case, label string, expect Expect, keys []string, picks []int, saved map[string]map[string]int, lookup func(string) int) {
	t.Helper()
	name := func(index int) string {
		if index < 0 {
			return "（挑不出来）"
		}
		return c.Members[index].Name
	}
	counts := make([]int, len(c.Members))
	rejected := 0
	for _, pick := range picks {
		if pick < 0 {
			rejected++
			continue
		}
		counts[pick]++
	}
	summary := func() string {
		parts := make([]string, 0, len(counts)+1)
		for i, count := range counts {
			parts = append(parts, fmt.Sprintf("%s=%d", c.Members[i].Name, count))
		}
		if rejected > 0 {
			parts = append(parts, fmt.Sprintf("挑不出来=%d", rejected))
		}
		return strings.Join(parts, " ")
	}
	if expect.Rejected {
		if rejected != len(picks) {
			t.Errorf("%s：应该每次都挑不出来，实际 %s", label, summary())
		}
		return
	}
	if rejected > 0 && (len(expect.Exact) > 0 || len(expect.Counts) > 0 || len(expect.Never) > 0) {
		t.Errorf("%s：有 %d 次挑不出来：%s", label, rejected, summary())
	}
	for i, want := range expect.Exact {
		if i >= len(picks) {
			t.Errorf("%s：预期写了 %d 个，只挑了 %d 次", label, len(expect.Exact), len(picks))
			break
		}
		if picks[i] != lookup(want) {
			got := make([]string, 0, len(expect.Exact))
			for j := 0; j < len(expect.Exact) && j < len(picks); j++ {
				got = append(got, name(picks[j]))
			}
			t.Errorf("%s：第 %d 次应该是 %s，实际序列 %s", label, i+1, want, strings.Join(got, " "))
			break
		}
	}
	for _, member := range sortedKeys(expect.Counts) {
		bounds := expect.Counts[member]
		if got := counts[lookup(member)]; got < bounds[0] || got > bounds[1] {
			t.Errorf("%s：%s 应该被挑中 %d～%d 次，实际 %d（%s）", label, member, bounds[0], bounds[1], got, summary())
		}
	}
	for _, member := range expect.Never {
		if got := counts[lookup(member)]; got != 0 {
			t.Errorf("%s：%s 不该被挑中，实际 %d 次（%s）", label, member, got, summary())
		}
	}
	if expect.SameAs != "" {
		before, ok := saved[expect.SameAs]
		if !ok {
			t.Fatalf("%s：没有记过 %q", label, expect.SameAs)
		}
		moved := 0
		for i, key := range keys {
			if before[key] != picks[i] {
				moved++
			}
		}
		if moved != 0 {
			t.Errorf("%s：%d 个访客里有 %d 个和「%s」那一步挑到的不一样", label, len(keys), moved, expect.SameAs)
		}
	}
	if expect.MovedOnlyFrom != nil {
		before, ok := saved[expect.MovedOnlyFrom.Saved]
		if !ok {
			t.Fatalf("%s：没有记过 %q", label, expect.MovedOnlyFrom.Saved)
		}
		from := map[int]bool{}
		for _, member := range expect.MovedOnlyFrom.Members {
			from[lookup(member)] = true
		}
		wrong, movable := 0, 0
		for i, key := range keys {
			if from[before[key]] {
				movable++
				continue
			}
			if before[key] != picks[i] {
				wrong++
			}
		}
		if wrong != 0 {
			t.Errorf("%s：有 %d 个本来不在 %v 上的访客被换走了", label, wrong, expect.MovedOnlyFrom.Members)
		}
		if movable == 0 {
			t.Errorf("%s：没有一个访客原来落在 %v 上，这一步什么都没验证", label, expect.MovedOnlyFrom.Members)
		}
	}
	if expect.Reference {
		memberKeys := driver.MemberKeys()
		if len(memberKeys) != len(c.Members) {
			t.Fatalf("%s：成员标识有 %d 个，成员有 %d 个", label, len(memberKeys), len(c.Members))
		}
		members := make([]lbcore.Member, len(c.Members))
		all := make([]int, len(c.Members))
		for i, member := range c.Members {
			members[i] = lbcore.Member{Weight: member.Weight, Share: 1}
			all[i] = i
		}
		wrong := 0
		for i, key := range keys {
			// 这一步用 release 跑（不留负载），有界负载的上限碰不到：就是纯哈希的结果。
			if want := lbcore.Rendezvous(members, memberKeys, all, key, lbcore.RendezvousOptions{LoadFactor: -1}); want != picks[i] {
				wrong++
			}
		}
		if wrong != 0 {
			t.Errorf("%s：%d 个访客里有 %d 个和 lbcore.Rendezvous 算出来的不一样", label, len(keys), wrong)
		}
	}
}
