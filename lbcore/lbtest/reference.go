package lbtest

import (
	"fmt"
	"math/rand"
	"time"

	"github.com/zhongyizhu11-jpg/NEX/lbcore"
)

/*
Reference 是直接调 lbcore 的那个实现：最简单的「调用方」—— 健康就是用例里写的那个词，负载就是数出来的
在途和活动连接，延迟就是用例里给的样本。它是另外两边的对照：用例的预期在它上面必须先成立。
*/
type Reference struct {
	strategy  string
	members   []lbcore.Member
	peak      []lbcore.PeakEWMA
	last      []float64
	words     []string
	health    []lbcore.Health
	recovered []time.Time
	keys      []string
	scratch   []float64
	wrr       lbcore.SmoothWRR
	near      lbcore.NearSet
	next      int
	rnd       *rand.Rand
	now       time.Time
}

// NewReference 新建一个对照实现。
func NewReference() *Reference { return &Reference{} }

func (r *Reference) Name() string { return "lbcore" }

func (r *Reference) Start(c Case) error {
	n := len(c.Members)
	*r = Reference{
		strategy:  c.Strategy,
		members:   make([]lbcore.Member, n),
		peak:      make([]lbcore.PeakEWMA, n),
		last:      make([]float64, n),
		words:     make([]string, n),
		health:    make([]lbcore.Health, n),
		recovered: make([]time.Time, n),
		keys:      make([]string, n),
		scratch:   make([]float64, n),
		wrr:       make(lbcore.SmoothWRR, n),
		rnd:       rand.New(rand.NewSource(20261119)),
		now:       time.Unix(1_800_000_000, 0),
	}
	for i, member := range c.Members {
		r.members[i].Weight = member.Weight
		r.words[i] = member.Health
		r.keys[i] = member.Name
	}
	return nil
}

func (r *Reference) SetHealth(index int, health string) error {
	r.words[index] = health
	return nil
}

func (r *Reference) SetRecovered(index int, seconds float64) error {
	r.recovered[index] = r.now.Add(-time.Duration(seconds * float64(time.Second)))
	return nil
}

func (r *Reference) SetLatency(index int, samples []LatencySample) error {
	r.peak[index].Reset()
	r.last[index] = 0
	for _, sample := range samples {
		r.peak[index].Observe(sample.Ms, r.now.Add(-time.Duration(sample.Ago*float64(time.Second))), 0)
		r.last[index] = sample.Ms
	}
	return nil
}

func (r *Reference) SetQuality(index int, quality QualitySpec) error {
	r.members[index].Loss = quality.LossPct / 100
	r.members[index].Utilisation = quality.Utilisation
	return nil
}

func (r *Reference) MemberKeys() []string { return r.keys }

func (r *Reference) Close() {}

// HealthFor 把用例里的健康词换成 lbcore 的信号。
func HealthFor(word string) (lbcore.Health, error) {
	switch word {
	case "", HealthHealthy:
		return lbcore.Health{}, nil
	case HealthUnstable:
		return lbcore.Health{Soft: true}, nil
	case HealthTargetDown:
		return lbcore.Health{DownstreamDown: true}, nil
	case HealthDown:
		return lbcore.Health{Dead: true}, nil
	case HealthExcluded:
		return lbcore.Health{Excluded: true}, nil
	}
	return lbcore.Health{}, fmt.Errorf("不认识的健康 %q", word)
}

func (r *Reference) Pick(key string, mode string) (int, error) {
	for i, word := range r.words {
		health, err := HealthFor(word)
		if err != nil {
			return -1, err
		}
		r.health[i] = health
	}
	if r.strategy == "fallback" {
		return r.settle(lbcore.First(r.health, nil), mode), nil
	}
	candidates, _ := lbcore.Candidates(nil, r.health, nil, lbcore.EjectPolicy{})
	if len(candidates) == 0 {
		return -1, nil
	}
	for _, index := range candidates {
		r.members[index].Share = lbcore.DefaultSlowStart.Factor(r.recovered[index], r.now)
		r.members[index].Latency = 0
	}
	pick := -1
	switch r.strategy {
	case "weighted":
		pick = r.wrr.Pick(r.members, candidates)
	case "round_robin":
		pick = lbcore.RoundRobin(&r.next, r.members, candidates, r.rnd)
	case "random":
		pick = lbcore.Random(r.members, candidates, r.rnd)
	case "ip_hash":
		pick = lbcore.Rendezvous(r.members, r.keys, candidates, key, lbcore.RendezvousOptions{Scratch: r.scratch})
	case "least_load":
		pick = lbcore.LeastLoad(r.members, candidates, &r.next, r.rnd)
	case "auto":
		for _, index := range candidates {
			r.members[index].Latency = r.peak[index].Value(r.now, 0)
		}
		pick = lbcore.Auto(r.members, candidates, &r.next, r.rnd)
	case "latency":
		for _, index := range candidates {
			r.members[index].Latency = r.last[index]
		}
		near := r.near.Select(nil, r.members, candidates, lbcore.NearPolicy{}, r.now)
		pick = lbcore.Auto(r.members, near, &r.next, r.rnd)
	default:
		return -1, fmt.Errorf("不认识的分配方式 %q", r.strategy)
	}
	return r.settle(pick, mode), nil
}

func (r *Reference) settle(pick int, mode string) int {
	if pick < 0 {
		return pick
	}
	switch mode {
	case ModeBurst:
		r.members[pick].InFlight++
	case ModeHold:
		r.members[pick].Active++
	}
	return pick
}
