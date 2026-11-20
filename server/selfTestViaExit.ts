import type { LiveRuleReport } from "./balanceLive";

/*
  负载均衡链路的诊断从在用的出口测目标（rules.startSelfTest：扛流量的那台不是主出口时，meta.viaActiveExit）。

  以前「入口 → 出口」那一段拿的是链路自己的延迟样本（入口量到**主出口**的，最长 5 分钟前），路径也画成主出口：
  诊断里画的是「po0 → 7 ms → Jinx（主出口）」，目标那一段却是从 hep ix 测的，两段拼起来的总延迟哪条路都不是。
  现在这一段只认测目标的那台，而且和规则卡、链路卡同一口径（面板自己探的，server/ruleLatencyView.ts）：
    1. 链路定时探测里这台出口那条分支（入口 TCPing 这台出口机，6 分钟内的）；
    2. 没有：开始诊断时让入口现测一次到这台的 tcping（kind = line-segment，和线路编辑框逐段测延迟同一套：
       Agent 按普通目标测一次就报，不碰转发运行时），这里等它回来；
    3. 现测也没回来：入口的真实上报里这台的 exitMs（FXP 报的是建隧道握手的时间，比 TCPing 大一截，所以排最后，
       诊断里写「入口实时探测」）；连这个都没有，这一段写「没测到」，不拿主出口的样本凑。
*/

export type ViaExitSegment = {
  entryHostId: number;
  exitHostId: number;
  latencyMs: number | null;
  isTimeout: boolean;
  recordedAt: number;
  source: "panel" | "live" | "tcping";
};

/** 链路定时探测里「入口到这台出口」那一段（面板探的，新鲜的才有）。 */
export function panelEntryExitSegment(leg: { ms: number; at: number } | null | undefined, entryHostId: number, exitHostId: number): ViaExitSegment | null {
  if (!leg || !(exitHostId > 0)) return null;
  return { entryHostId, exitHostId, latencyMs: Math.max(1, Math.round(leg.ms)), isTimeout: false, recordedAt: leg.at, source: "panel" };
}

/** 入口真实上报里「入口到这台出口」那一段（新鲜的上报才有）。这台被报成「入口连不上出口机」时是超时。 */
export function liveEntryExitSegment(live: LiveRuleReport | null | undefined, exitHostId: number): ViaExitSegment | null {
  if (!live || !(exitHostId > 0)) return null;
  const exit = live.exits.find((item) => item.hostId === exitHostId);
  if (!exit) return null;
  const base = { entryHostId: live.entryHostId, exitHostId, recordedAt: live.at, source: "live" as const };
  if (exit.state === "down" && exit.reason === "exit") return { ...base, latencyMs: null, isTimeout: true };
  if (exit.exitMs != null && exit.exitMs > 0) return { ...base, latencyMs: Math.max(1, Math.round(exit.exitMs)), isTimeout: false };
  return null;
}

/** 入口现测的那一次（line-segment 那一行）→ 这一段。还没回来是 null。 */
export function tcpingEntryExitSegment(
  row: { status?: unknown; latencyMs?: unknown; updatedAt?: unknown } | null | undefined,
  entryHostId: number,
  exitHostId: number,
  nowMs = Date.now(),
): ViaExitSegment | null {
  const status = String(row?.status || "");
  if (!row || status === "pending" || status === "running") return null;
  const at = row.updatedAt ? new Date(row.updatedAt as string | number | Date).getTime() : nowMs;
  const latency = Number(row.latencyMs);
  const ok = status === "success" && Number.isFinite(latency) && latency > 0;
  return {
    entryHostId,
    exitHostId,
    latencyMs: ok ? Math.max(1, Math.round(latency)) : null,
    isTimeout: !ok,
    recordedAt: Number.isFinite(at) && at > 0 ? at : nowMs,
    source: "tcping",
  };
}

/** 诊断里「入口 → 出口」那一行（主机号、名字都是测目标的那台）。 */
export function viaExitSegmentDetail(segment: ViaExitSegment | null, input: { entryHostId: number; exitHostId: number; entryName: string; exitName: string }) {
  const routeLabel = `${input.entryName} -> ${input.exitName}`;
  const base = {
    fromHostId: input.entryHostId || null,
    toHostId: input.exitHostId || null,
    hopIndex: 0,
    hopCount: 1,
    hopLabel: `1/1 ${input.entryHostId || input.entryName}->${input.exitHostId || input.exitName}`,
    routeLabel,
    method: "tcp",
    pending: false,
  };
  if (!segment) return { ...base, success: false, latencyMs: null, message: `入口到 ${input.exitName} 这一段没测到（入口没报、现测也没回来）` };
  if (segment.isTimeout || segment.latencyMs == null) {
    return { ...base, success: false, latencyMs: null, message: segment.source === "live" ? `入口连不上 ${input.exitName}` : `入口到 ${input.exitName} 测不通` };
  }
  return { ...base, success: true, latencyMs: segment.latencyMs, message: segment.source === "live" ? "入口实时探测" : segment.source === "panel" ? "链路探测" : null };
}

/** 等「入口 → 这台出口」那一段：先看链路定时探测，没有再等入口现测的那一行回来（最多 waitMs），最后才用入口的真实上报。 */
export async function waitViaExitSegment(input: {
  ruleId: number;
  entryHostId: number;
  exitHostId: number;
  entryExitTestId?: number;
  waitMs: number;
  loadLive: (ruleId: number) => LiveRuleReport | null;
  /** 链路定时探测里这台出口那条分支（ruleLatencyView.tunnelExitLatency）；不传当没有 */
  loadPanel?: () => { ms: number; at: number } | null;
  loadTest: (testId: number) => Promise<{ status?: unknown; latencyMs?: unknown; updatedAt?: unknown } | null | undefined>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<ViaExitSegment | null> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + Math.max(0, input.waitMs);
  const liveFallback = () => liveEntryExitSegment(input.loadLive(input.ruleId), input.exitHostId);
  for (;;) {
    const panel = panelEntryExitSegment(input.loadPanel?.() ?? null, input.entryHostId, input.exitHostId);
    if (panel) return panel;
    const testId = Number(input.entryExitTestId || 0);
    if (!(testId > 0)) return liveFallback();
    const measured = tcpingEntryExitSegment(await input.loadTest(testId).catch(() => null), input.entryHostId, input.exitHostId, now());
    if (measured) return measured;
    if (now() >= deadline) return liveFallback();
    await sleep(500);
  }
}
