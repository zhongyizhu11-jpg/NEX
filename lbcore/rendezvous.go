package lbcore

import "math"

/*
「按访客固定」：加权的最高随机权重哈希（rendezvous hashing）。

每个成员按「访客 + 成员标识」算一个分，分最高的拿走。一个成员挂了，只有原来落在它上面的访客要换，其余人不动
（「哈希 % 健康的个数」挂一个几乎所有人都换，要保持登录的服务全掉线）；它回来以后，那些访客又回到它上面。

哈希是 FNV-1a 64（访客、一个 0 字节、成员标识），再过一遍 splitmix64 的收尾（Mix64）。只有这一种哈希，没有「不搅」的开关。为什么要搅：FNV-1a 的
最后一步是「异或一个字节、乘一个常数」，两个成员标识只差最后一两个字符时（同一台机器的两个端口，或者只差 IP
最后一段），同一个访客对这两个成员算出来的哈希只差在低位，换算成 0~1 的数几乎相等，加权之后永远是分量大的
那个赢 —— 900:100 的两个成员，所有访客都固定到 900 那个上（路线图 X2 的回归测试跑出来的）。

不设负载上限（默认，产品定的）：按访客固定的意义就是「同一个访客的出口 IP 不变」—— 登录态、风控、按 IP 授权都靠它。
所以这个访客的成员只要还能用，他的每一条连接都落在那上面，不管那个成员此刻压了多少。以前默认带「有界负载」
（一个成员挂着的会话到了它该分的 × 1.25 就往分数第二的放）：一个访客自己就占了大头时（整条规则只有他一个人
在用、他一次开十几条连接、或者别的访客的 UDP 会话还挂着），他的连接就在几个成员之间来回落，出口 IP 一会儿一个，
真实 gost 端到端（gost-runtime/test/balance-proxy）里一个访客连 4 次就换了出口。大 NAT 出口压垮一个成员的
风险要靠「按负载 / 自动」去分，选了按访客固定就是选了「别换」。

有界负载仍然留着可选（RendezvousOptions.LoadFactor > 0，常用 DefaultHashLoadFactor = 1.25）：一个成员挂着的会话
已经到了「它该分的 × 倍数」，这个访客就往分数第二的成员放，以此类推；都满了还是给分数最高的。该分的 =
(全部会话 + 1) × 它的分量占比。会话少的时候上限向上取整。现在没有哪个分配方式默认开它。

同一个访客、同一批成员标识、同样的分量和负载，在哪台机器、哪个进程里算出来都是同一个成员。成员标识由调用方定
（FXP 是「主机:端口」，线路组是「地址:端口#下标」或落地的标识），所以跨产品不保证落在「同一台」上，
保证的是算法一样。

参数：RendezvousOptions.LoadFactor（默认 0 = 不设上限，结果只由访客、成员标识和分量决定 —— 几台机器上算出来
也是同一个；> 0 才按那个倍数设上限）。
*/

const (
	fnv64aOffset = 14695981039346656037
	fnv64aPrime  = 1099511628211
)

// HashKey 是 Mix64(FNV-1a 64(key, 0x00, member))；FNV 那一步和 hash/fnv 逐位一致，手写是为了不在挑选路径上分配。
func HashKey(key, member string) uint64 {
	hash := uint64(fnv64aOffset)
	for i := 0; i < len(key); i++ {
		hash ^= uint64(key[i])
		hash *= fnv64aPrime
	}
	hash *= fnv64aPrime // 分隔用的 0 字节：异或 0 不变，只乘一次
	for i := 0; i < len(member); i++ {
		hash ^= uint64(member[i])
		hash *= fnv64aPrime
	}
	return Mix64(hash)
}

// Mix64 把哈希再搅一遍（splitmix64 的收尾），让每一位都参与。
func Mix64(x uint64) uint64 {
	x ^= x >> 30
	x *= 0xbf58476d1ce4e5b9
	x ^= x >> 27
	x *= 0x94d049bb133111eb
	x ^= x >> 31
	return x
}

// RendezvousScore 把哈希换算成加权的分：u = 哈希的高 53 位落在 (0,1) 上，分 = -分量 ÷ ln(u)。
// 分量大的更容易拿到高分，期望的份额正比于分量。
func RendezvousScore(hash uint64, weight float64) float64 {
	u := (float64(hash>>11) + 0.5) / float64(uint64(1)<<53)
	return -weight / math.Log(u)
}

// DefaultHashLoadFactor：要开有界负载时常用的倍数（一个成员最多比它该分的多 25%）。默认不开，见文件开头。
const DefaultHashLoadFactor = 1.25

// RendezvousOptions 是按访客固定的可选项。零值 = 不设上限（纯 rendezvous 哈希）。
type RendezvousOptions struct {
	// LoadFactor：有界负载的上限倍数。≤ 0（默认）不设上限：结果只由访客、成员标识和分量决定，访客的成员
	// 能用就一直是它（按访客固定的承诺；FXP 叠加连接还要各台中继算出同一个结果）。> 0 才设上限，
	// 负载看的是 Member.Active + Member.InFlight。
	LoadFactor float64
	// Scratch：有上限时用来放每个成员分数的临时区（按成员下标，长度 ≥ len(members)）。不给或不够长就现分配。
	Scratch []float64
}

/*
Rendezvous 给访客 key 挑一个成员。keys 是每个成员的标识（按成员下标）。

只看 Weight，不看 Share：按访客固定看重「别换」，乘了慢启动的话恢复那一分钟里访客会先被挪走、再被挪回来。
Weight ≤ 0 的不参与（全都 ≤ 0 时一律当 1）。
*/
func Rendezvous(members []Member, keys []string, candidates []int, key string, opts RendezvousOptions) int {
	if len(candidates) == 0 {
		return -1
	}
	mode := staticModeOf(members, candidates)
	factor := opts.LoadFactor
	if factor <= 0 {
		best, bestScore := -1, 0.0
		for _, index := range candidates {
			weight := members[index].weightBy(mode)
			if weight <= 0 {
				continue
			}
			score := RendezvousScore(HashKey(key, keys[index]), weight)
			if best < 0 || score > bestScore {
				best, bestScore = index, score
			}
		}
		if best < 0 {
			return candidates[0]
		}
		return best
	}
	scores := opts.Scratch
	if len(scores) < len(members) {
		scores = make([]float64, len(members))
	}
	totalActive, totalWeight := 0.0, 0.0
	for _, index := range candidates {
		weight := members[index].weightBy(mode)
		if weight <= 0 {
			scores[index] = -1
			continue
		}
		scores[index] = RendezvousScore(HashKey(key, keys[index]), weight)
		totalActive += members[index].Active + members[index].InFlight
		totalWeight += weight
	}
	// 从高到低一个个找（每轮扫一遍取最大的），不排序、不分配。
	top := -1
	for range candidates {
		best := -1
		for _, index := range candidates {
			if scores[index] >= 0 && (best < 0 || scores[index] > scores[best]) {
				best = index
			}
		}
		if best < 0 {
			break
		}
		if top < 0 {
			top = best
		}
		limit := math.Ceil(factor * (totalActive + 1) * members[best].weightBy(mode) / totalWeight)
		if members[best].Active+members[best].InFlight < limit {
			return best
		}
		scores[best] = -1 // 这个满了，看下一个
	}
	if top < 0 {
		return candidates[0]
	}
	return top
}
