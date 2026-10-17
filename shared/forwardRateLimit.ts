/*
  转发限速（面板 2.3.451 起）：上下行分开、多级叠加、先放一段突发再降速。

  一条转发规则同时受这几级约束，每一级是一个按 scope 共享的桶（同一个 scope 下所有规则、所有连接
  共用，开多少线程都绕不过去）；同一方向上每一级都要过，实际速度就是最严的那一级：

    用户        user-<用户>-host-<主机>             上行 / 下行分开（users.gostRateLimitIn / Out）
    用户突发    同上 + user-…-sustain              峰值 burstMbps，跑满 burstSeconds 秒的额度后回到基础速率
    隧道        user-<用户>-host-<主机>-tunnel-<隧道> 上下行同一个数
    转发组      user-<用户>-host-<主机>-group-<组>   上下行同一个数
    规则        rule-<根规则>-host-<主机>            上下行同一个数（规则表单里的单条规则限速，管理员设）
    整台主机    host-<主机>                         所有用户加起来，上下行同一个数

  方向：in = 客户端 → 目标（上行），out = 目标 → 客户端（下行），和 Agent 守卫、gost 限速器一致。

  突发：峰值桶按 burstMbps 限，基础桶按基础速率限、桶深 = (burstMbps - 基础速率) × burstSeconds。
  一开始桶是满的，可以按峰值跑 burstSeconds 秒左右；桶空了就只剩基础速率；用得少的时候桶慢慢回满，
  速度自动恢复。

  完整的多级 / 突发只有 Agent 守卫（iptables / nftables / realm / socat / nginx 和 Nginx 隧道入口）
  做得到；gost 自带的限速器和 FXP 隧道入口只认一个上下行数，用 strictestForwardRate 取每个方向最严的那一级。
*/

export const BYTES_PER_MEGABIT = 1_000_000 / 8;

export type ForwardRateTier = {
  scope: string;
  inMbps: number;
  outMbps: number;
  /** 这一级的桶深（字节），只有突发的基础桶有；0 / 缺省 = Agent 默认（100 ms）。 */
  burstInBytes?: number;
  burstOutBytes?: number;
};

export type ForwardRateInput = {
  userId: number;
  hostId: number;
  user?: { inMbps?: unknown; outMbps?: unknown; burstMbps?: unknown; burstSeconds?: unknown } | null;
  tunnel?: { id?: unknown; mbps?: unknown } | null;
  group?: { id?: unknown; mbps?: unknown } | null;
  rule?: { id?: unknown; inMbps?: unknown; outMbps?: unknown } | null;
  hostLimitMbps?: unknown;
};

export function normalizeMbps(value: unknown) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.min(1_000_000, Math.floor(num));
}

function positiveId(value: unknown) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** 突发秒数：0 关；1–3600。 */
export function normalizeBurstSeconds(value: unknown) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(3600, n);
}

export function userRateScope(userId: number, hostId: number) {
  return `user-${Math.max(0, userId)}-host-${Math.max(0, hostId)}`;
}

/** 按上面那张表列出这条规则的各级限速（没限的级不列）。 */
export function buildForwardRateTiers(input: ForwardRateInput): ForwardRateTier[] {
  const userId = Math.max(0, Number(input.userId) || 0);
  const hostId = Math.max(0, Number(input.hostId) || 0);
  const tiers: ForwardRateTier[] = [];
  const userScope = userRateScope(userId, hostId);

  const userIn = normalizeMbps(input.user?.inMbps);
  const userOut = normalizeMbps(input.user?.outMbps);
  const burstMbps = normalizeMbps(input.user?.burstMbps);
  const burstSeconds = normalizeBurstSeconds(input.user?.burstSeconds);
  const burstFor = (base: number) => (base > 0 && burstMbps > base && burstSeconds > 0 ? burstMbps : 0);
  const peakIn = burstFor(userIn);
  const peakOut = burstFor(userOut);
  if (peakIn > 0 || peakOut > 0) {
    // 峰值桶占用户原来的 scope（和旧 Agent、gost 共用名字没关系：它们只拿 strictest 那个数）。
    tiers.push({ scope: userScope, inMbps: peakIn || userIn, outMbps: peakOut || userOut });
    tiers.push({
      scope: `${userScope}-sustain`,
      inMbps: userIn,
      outMbps: userOut,
      burstInBytes: peakIn > 0 ? Math.floor((peakIn - userIn) * BYTES_PER_MEGABIT * burstSeconds) : 0,
      burstOutBytes: peakOut > 0 ? Math.floor((peakOut - userOut) * BYTES_PER_MEGABIT * burstSeconds) : 0,
    });
  } else if (userIn > 0 || userOut > 0) {
    tiers.push({ scope: userScope, inMbps: userIn, outMbps: userOut });
  }

  const tunnelId = positiveId(input.tunnel?.id);
  const tunnelMbps = normalizeMbps(input.tunnel?.mbps);
  if (tunnelId > 0 && tunnelMbps > 0) tiers.push({ scope: `${userScope}-tunnel-${tunnelId}`, inMbps: tunnelMbps, outMbps: tunnelMbps });

  const groupId = positiveId(input.group?.id);
  const groupMbps = normalizeMbps(input.group?.mbps);
  if (groupId > 0 && groupMbps > 0) tiers.push({ scope: `${userScope}-group-${groupId}`, inMbps: groupMbps, outMbps: groupMbps });

  const ruleId = positiveId(input.rule?.id);
  const ruleIn = normalizeMbps(input.rule?.inMbps);
  const ruleOut = normalizeMbps(input.rule?.outMbps);
  // 和 server/ruleLimits.ts 的口径一致：根规则的 id，同一台机器上共用一个桶。
  if (ruleId > 0 && (ruleIn > 0 || ruleOut > 0)) tiers.push({ scope: `rule-${ruleId}-host-${hostId}`, inMbps: ruleIn, outMbps: ruleOut });

  const hostMbps = normalizeMbps(input.hostLimitMbps);
  if (hostId > 0 && hostMbps > 0) tiers.push({ scope: `host-${hostId}`, inMbps: hostMbps, outMbps: hostMbps });

  return tiers;
}

export type StrictestForwardRate = {
  inMbps: number;
  outMbps: number;
  /** 上行最严那一级的 scope（旧 Agent 只认一个 scope，用它）。 */
  scope: string;
};

/**
 * 每个方向最严的那一级（只认一个数的地方用：gost、FXP、旧 Agent）。突发的峰值桶不算 ——
 * 那些地方做不了突发，按基础速率限。
 */
export function strictestForwardRate(tiers: readonly ForwardRateTier[]): StrictestForwardRate {
  let inMbps = 0;
  let outMbps = 0;
  let scope = "";
  let scopeRate = 0;
  const peakScopes = new Set(tiers.filter((tier) => tier.scope.endsWith("-sustain")).map((tier) => tier.scope.slice(0, -"-sustain".length)));
  for (const tier of tiers) {
    if (peakScopes.has(tier.scope)) continue;
    if (tier.inMbps > 0 && (inMbps === 0 || tier.inMbps < inMbps)) inMbps = tier.inMbps;
    if (tier.outMbps > 0 && (outMbps === 0 || tier.outMbps < outMbps)) outMbps = tier.outMbps;
    const tierRate = Math.min(...[tier.inMbps, tier.outMbps].filter((value) => value > 0));
    if (Number.isFinite(tierRate) && (scopeRate === 0 || tierRate < scopeRate)) {
      scopeRate = tierRate;
      // 突发的基础桶对旧 Agent 来说就是用户那一级。
      scope = tier.scope.endsWith("-sustain") ? tier.scope.slice(0, -"-sustain".length) : tier.scope;
    }
  }
  return { inMbps, outMbps, scope };
}

export function mbpsToBytesPerSecond(mbps: unknown) {
  return Math.max(0, Math.floor(normalizeMbps(mbps) * BYTES_PER_MEGABIT));
}

/** 下发给 Agent 守卫的那份（字节 / 秒）。 */
export function forwardRateTiersForAgent(tiers: readonly ForwardRateTier[]) {
  return tiers.map((tier) => ({
    scope: tier.scope,
    in: mbpsToBytesPerSecond(tier.inMbps),
    out: mbpsToBytesPerSecond(tier.outMbps),
    ...(tier.burstInBytes ? { burstIn: tier.burstInBytes } : {}),
    ...(tier.burstOutBytes ? { burstOut: tier.burstOutBytes } : {}),
  }));
}

/** 「上行 100 Mbps / 下行 50 Mbps」「上下行 100 Mbps」「不限」。 */
export function describeForwardRate(inMbps: unknown, outMbps: unknown) {
  const a = normalizeMbps(inMbps);
  const b = normalizeMbps(outMbps);
  if (a === 0 && b === 0) return "不限";
  if (a === b) return `上下行 ${a} Mbps`;
  return `上行 ${a > 0 ? `${a} Mbps` : "不限"} / 下行 ${b > 0 ? `${b} Mbps` : "不限"}`;
}
