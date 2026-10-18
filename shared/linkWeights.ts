/**
 * 按带宽给几条线路分连接（订阅的负载均衡组、出口组的「按权重」共用）。
 */

function text(value: unknown): string {
  return String(value ?? "").trim();
}

/**
 * 一台前置的带宽（Mbps），给「负载均衡」组分连接用。依次看：
 *   1. 线路带宽（lineBandwidthMbps）—— 主机里专门填的这一项；
 *   2. 主机总限速（rateLimitMbps）—— 你给这台机器定的上限；
 *   3. 出口整形带宽（egressMbps）；
 *   4. 主机名里括号中的带宽，例如「Po0(500M)」「港机【1G】」—— 很多人就是这么给机器起名的。
 *      只认括号里的：裸写的「5G」多半是说移动网络，不是带宽。
 * 都没有返回 0（不知道）。
 */
export function hostBandwidthHintMbps(host: { lineBandwidthMbps?: unknown; rateLimitMbps?: unknown; egressMbps?: unknown; name?: unknown } | null | undefined): number {
  if (!host) return 0;
  const line = Math.floor(Number(host.lineBandwidthMbps) || 0);
  if (line > 0) return line;
  const limit = Math.floor(Number(host.rateLimitMbps) || 0);
  if (limit > 0) return limit;
  const egress = Math.floor(Number(host.egressMbps) || 0);
  if (egress > 0) return egress;
  const match = /[(（【\[]\s*(\d+(?:\.\d+)?)\s*([MG])(?:bps|b)?\s*[)）】\]]/i.exec(text(host.name));
  if (!match) return 0;
  const value = Number(match[1]) * (match[2].toUpperCase() === "G" ? 1000 : 1);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/** 每个成员最多分几份：份数就是它在组里重复出现的次数，太多会让客户端里的列表很长。 */
export const PROXY_LOAD_BALANCE_MAX_WEIGHT = 10;

/**
 * 按带宽算每个成员分几份连接。有任何一个不知道带宽、或者都一样，就返回 null（平均分）——
 * 猜错的权重比平均分更糟。500 / 300 → [5, 3]；1000 / 100 → [10, 1]。
 */
export function proxyLoadBalanceWeights(bandwidths: readonly number[]): number[] | null {
  if (bandwidths.length < 2 || bandwidths.some((value) => !(value > 0))) return null;
  const min = Math.min(...bandwidths);
  const ratios = bandwidths.map((value) => value / min);
  // 最慢的那台先给 3 份（比例细一点），最快的超过上限时整体缩小，而不是只把最快的截掉 —— 那样比例就歪了。
  const scale = Math.min(3, PROXY_LOAD_BALANCE_MAX_WEIGHT / Math.max(...ratios));
  let weights = ratios.map((ratio) => Math.max(1, Math.round(ratio * scale)));
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const divisor = weights.reduce((acc, value) => gcd(acc, value));
  weights = weights.map((value) => value / divisor);
  return weights.every((value) => value === weights[0]) ? null : weights;
}

/**
 * 按份数把成员展开成轮询顺序（平滑加权轮询，nginx 的做法）：5:3 是 A B A A B A B A，
 * 而不是 A A A A A B B B —— 后者连着几条新连接都压在同一台上，短时间里另一台闲着。
 */
export function expandWeightedMembers(members: readonly string[], weights: readonly number[] | null | undefined): string[] {
  if (!weights || weights.length !== members.length) return [...members];
  const total = weights.reduce((sum, value) => sum + value, 0);
  const current = weights.map(() => 0);
  const out: string[] = [];
  for (let round = 0; round < total; round += 1) {
    let best = 0;
    for (let i = 0; i < weights.length; i += 1) {
      current[i] += weights[i];
      if (current[i] > current[best]) best = i;
    }
    current[best] -= total;
    out.push(members[best]);
  }
  return out;
}
