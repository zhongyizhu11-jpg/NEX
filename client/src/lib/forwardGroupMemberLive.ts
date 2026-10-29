/*
  转发组成员胶囊上的那颗点：这个成员「此刻」怎么样，和「配置上能不能用」分开说。

  原来胶囊只有一种绿：配置可用（getGroupConfigState 的 usableMemberIds）。三个成员都绿的
  时候，看不出哪个探测不通、哪个延迟高、哪个主机掉线了 —— Open-Box 的策略卡用一排健康点
  回答这个，这里把点和延迟放进已有的胶囊里，不另画一块。

  数据从哪来，按组的类型分：
  · 转发组（failover）被规则用着时，面板按成员子规则的探测算 healthStatus / lastLatencyMs，
    开了国内探测还有 chinaHealthStatus —— 用这些。
  · 没被用着的转发组、入口组、出口组、端口组没有成员级探测，库里那份健康是旧的：只看主机
    在不在线（隧道成员没有主机，就不画点）。
*/

export type MemberLiveTone = "healthy" | "degraded" | "down" | "off" | "unknown";

export type MemberLiveState = {
  tone: MemberLiveTone;
  /** 胶囊上跟在名字后面的短字：延迟或者状态；null = 不写。 */
  note: string | null;
  /** 悬停说明的一句 */
  title: string;
};

type LiveGroup = {
  groupMode?: unknown;
  isEnabled?: unknown;
  templateRuleCount?: unknown;
  chinaHealthCheckEnabled?: unknown;
};

type LiveMember = {
  memberType?: unknown;
  isEnabled?: unknown;
  scheduleSuspended?: unknown;
  healthStatus?: unknown;
  lastLatencyMs?: unknown;
  chinaHealthStatus?: unknown;
  chinaHealthLatencyMs?: unknown;
  host?: { isOnline?: unknown } | null;
};

const flag = (value: unknown, fallback = false) => value === undefined || value === null ? fallback : value === true || value === 1 || value === "1" || value === "true";

function latencyOf(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

/** 这个组的成员有没有面板算的健康：只有被规则用着的转发组有。 */
export function groupHasMemberProbes(group: LiveGroup) {
  return String(group.groupMode || "failover") === "failover" && Number(group.templateRuleCount ?? 0) > 0;
}

/** 成员此刻的状态；组停用了返回 null（卡片已经写着停用，点再画一遍是噪音）。 */
export function describeMemberLive(group: LiveGroup, member: LiveMember): MemberLiveState | null {
  if (!flag(group.isEnabled, true)) return null;
  if (!flag(member.isEnabled, true)) return { tone: "off", note: null, title: "已停用" };
  if (flag(member.scheduleSuspended)) return { tone: "off", note: "时段外", title: "时段外暂停，到点自己回来" };
  const host = member.host || null;
  if (host && host.isOnline !== undefined && !flag(host.isOnline)) return { tone: "down", note: "离线", title: "主机离线" };
  if (groupHasMemberProbes(group)) {
    const status = String(member.healthStatus || "").trim().toLowerCase();
    if (status === "unhealthy") return { tone: "down", note: "不通", title: "转发探测不通" };
    if (status !== "healthy") return { tone: "unknown", note: null, title: "等检测结果" };
    const latency = latencyOf(member.lastLatencyMs);
    const china = String(member.chinaHealthStatus || "").trim().toLowerCase();
    if (flag(group.chinaHealthCheckEnabled) && china === "unhealthy") {
      return { tone: "degraded", note: "国内不通", title: `转发正常${latency !== null ? `（${latency}ms）` : ""}，但国内探测不通` };
    }
    const chinaLatency = latencyOf(member.chinaHealthLatencyMs);
    const chinaText = flag(group.chinaHealthCheckEnabled) && china === "healthy" ? `；国内 ${chinaLatency !== null ? `${chinaLatency}ms` : "正常"}` : "";
    return { tone: "healthy", note: latency !== null ? `${latency}ms` : null, title: `转发正常${latency !== null ? `，${latency}ms` : ""}${chinaText}` };
  }
  if (host && host.isOnline !== undefined) return { tone: "healthy", note: null, title: "主机在线" };
  return null;
}

export type GroupLiveSummary = { text: string; tone: "ok" | "warn" | "down"; title: string };

/**
 * 成员那一块标题行上的「3/4 正常」。只数启用了的、有状态的成员；全都正常且只有一个成员时
 * 不说（一个成员的组，那一颗点已经说完了）。
 */
export function summarizeGroupLive(group: LiveGroup, members: LiveMember[]): GroupLiveSummary | null {
  const states = members.map((member) => describeMemberLive(group, member)).filter((state): state is MemberLiveState => !!state && state.tone !== "off");
  if (states.length === 0) return null;
  const known = states.filter((state) => state.tone !== "unknown");
  if (known.length === 0) return null;
  const healthy = known.filter((state) => state.tone === "healthy").length;
  const down = known.filter((state) => state.tone === "down").length;
  const degraded = known.length - healthy - down;
  if (states.length === 1 && healthy === 1) return null;
  const parts = [`${down > 0 ? `${down} 个不可用` : ""}`, `${degraded > 0 ? `${degraded} 个国内不通` : ""}`, `${states.length - known.length > 0 ? `${states.length - known.length} 个等检测` : ""}`].filter(Boolean);
  return {
    text: `${healthy}/${states.length} 正常`,
    tone: healthy === 0 ? "down" : healthy < states.length ? "warn" : "ok",
    title: parts.length > 0 ? `启用的 ${states.length} 个成员里：${parts.join("，")}` : `启用的 ${states.length} 个成员都正常`,
  };
}
