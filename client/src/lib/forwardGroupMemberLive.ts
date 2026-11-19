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
  · 外部观察（主备转发组、入口组，member.peerHealth）：别的机器替面板去探这个成员对外的入口端口。
    上面那些都是「成员自己报告的」，这一项是「别人看到的」，两样分开说：
      自己报告正常、外部连不上  → 访客连不上，红点「外部连不上」；
      面板连不上它、外部连得上  → 访客还能用，黄点「面板连不上」，解析里继续留着；
      都正常                    → 悬停里多一句「外部观察 N/M 可达」。
    没有可用的观察点（单成员组、别的成员 Agent 太旧）时只看成员自己的报告，悬停里说明。
*/

export type MemberLiveTone = "healthy" | "degraded" | "down" | "off" | "unknown";

export type MemberLiveState = {
  tone: MemberLiveTone;
  /** 胶囊上跟在名字后面的短字：延迟或者状态；null = 不写。 */
  note: string | null;
  /** 悬停说明的一句 */
  title: string;
  /** 不正常时卡片上直接写的一句人话（手机没有悬停）；正常的没有 */
  reason?: string | null;
};

type LiveGroup = {
  groupMode?: unknown;
  isEnabled?: unknown;
  templateRuleCount?: unknown;
  chinaHealthCheckEnabled?: unknown;
  /** 外部观察在这个组上的情况（只有管理员的列表里带）：active = 有成员被观察着。 */
  peerProbe?: { active?: unknown; outdatedHosts?: Array<{ id?: unknown; name?: unknown }> | null } | null;
};

export type MemberPeerHealth = {
  state?: unknown;
  down?: unknown;
  reachableWhileAgentOffline?: unknown;
  reachableCount?: unknown;
  usableCount?: unknown;
  assignedCount?: unknown;
  label?: unknown;
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
  peerHealth?: MemberPeerHealth | null;
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
  const self = describeMemberSelfReport(group, member);
  const peer = member.peerHealth || null;
  const peerLabel = peer ? String(peer.label || "").trim() : "";
  if (!peer || Number(peer.assignedCount || 0) <= 0) {
    // 这个组开着外部观察，但这个成员没有可用的观察点：只看它自己的报告，说一声。
    if (self && group.peerProbe && String(group.groupMode || "failover") !== "exit" && self.tone !== "off") {
      return { ...self, title: `自己报告：${self.title}；没有可用的观察点，只看成员自己的报告` };
    }
    return self;
  }
  if (flag(peer.reachableWhileAgentOffline)) {
    return { tone: "degraded", note: "面板连不上", title: `自己报告：面板连不上这台的 Agent；${peerLabel}，访客还能用，继续留在解析里`, reason: "面板连不上它的 Agent，别的机器连得上，继续留在解析里" };
  }
  if (!self || self.tone === "down" || self.tone === "off") return self ? { ...self, title: `自己报告：${self.title}；${peerLabel}` } : self;
  const state = String(peer.state || "");
  if (flag(peer.down) || state === "down") {
    return { tone: "down", note: "外部连不上", title: `自己报告：${self.title}；${peerLabel}：别的机器连不上它的入口端口，按不可用处理`, reason: "它自己报告正常，但别的机器连不上它的入口端口，按不可用处理" };
  }
  if (state === "failing") {
    return { tone: "degraded", note: "外部连不上", title: `自己报告：${self.title}；${peerLabel}：别的机器连不上它的入口端口，观察中`, reason: "别的机器连不上它的入口端口，持续下去就按不可用处理" };
  }
  return { ...self, title: `自己报告：${self.title}；${peerLabel}` };
}

/** 只看成员自己这一侧（主机在线、面板按它的子规则探测算的健康）。 */
function describeMemberSelfReport(group: LiveGroup, member: LiveMember): MemberLiveState | null {
  const host = member.host || null;
  if (host && host.isOnline !== undefined && !flag(host.isOnline)) return { tone: "down", note: "离线", title: "主机离线", reason: "主机离线（面板收不到它的 Agent）" };
  if (groupHasMemberProbes(group)) {
    const status = String(member.healthStatus || "").trim().toLowerCase();
    if (status === "unhealthy") return { tone: "down", note: "连不上", title: "转发探测连不上", reason: "转发探测连不上，检查这台的转发和防火墙" };
    if (status !== "healthy") return { tone: "unknown", note: null, title: "等检测结果" };
    const latency = latencyOf(member.lastLatencyMs);
    const china = String(member.chinaHealthStatus || "").trim().toLowerCase();
    if (flag(group.chinaHealthCheckEnabled) && china === "unhealthy") {
      return { tone: "degraded", note: "国内连不上", title: `转发正常${latency !== null ? `（${latency} ms）` : ""}，但国内探测连不上`, reason: "转发正常，但从国内探测连不上" };
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
  const parts = [`${down > 0 ? `${down} 个不可用` : ""}`, `${degraded > 0 ? `${degraded} 个部分连不上` : ""}`, `${states.length - known.length > 0 ? `${states.length - known.length} 个等检测` : ""}`].filter(Boolean);
  return {
    text: `${healthy}/${states.length} 正常`,
    tone: healthy === 0 ? "down" : healthy < states.length ? "warn" : "ok",
    title: parts.length > 0 ? `启用的 ${states.length} 个成员里：${parts.join("，")}` : `启用的 ${states.length} 个成员都正常`,
  };
}

/** 卡片上成员胶囊下面那几行：不正常的成员一人一行「名字：原因」（最多 3 行，手机上没有悬停也看得到）。 */
export function memberIssueLines<M extends LiveMember>(group: LiveGroup, members: readonly M[], nameOf: (member: M) => string) {
  return members
    .map((member) => ({ member, live: describeMemberLive(group, member) }))
    .filter((item): item is { member: M; live: MemberLiveState } => !!item.live?.reason && (item.live.tone === "down" || item.live.tone === "degraded"))
    .slice(0, 3)
    .map(({ member, live }) => ({ tone: live.tone as "down" | "degraded", text: `${nameOf(member)}：${live.reason}` }));
}
