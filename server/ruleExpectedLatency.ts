import * as db from "./db";
import { loadFreshTunnelAutoDetails } from "./agentSelfTestRoutes";
import { getForwardGroupAutoHopDetails } from "./forwardGroupAutoLatencyState";
import { getRouteStatus } from "./routeGroupStats";
import { queryRaw } from "./dbRuntime";
import { quoteIdentifier } from "./dbCompat";
import { timestampMillis } from "../shared/timestamp";
import { routeGroupOf } from "../shared/routeGroup";

/*
  诊断对话框里「推算」那一列：点「诊断」之前，面板凭后台探测**以为**这条链各段是多少。

  Open-Box 的规则页把「按配置推算应该怎么走」和「实际发请求走了哪」并排放，不一致的那行
  高亮 —— 这是它最讨人喜欢的细节。NEX 的后台探测本来就一直在跑（入口探到底、隧道每跳、
  转发链每跳、线路组每跳），只是从来没和诊断的实测放在一起看过。放在一起才看得出：
  「后台说 40ms，这次实测 180ms」是这一段突然变差了，还是后台的数早就陈旧。

  这里只收集，不下结论：每段给延迟 / 超时 / 几分钟前测的，界面对着实测算差。
*/

export type ExpectedSegment = {
  hopIndex: number;
  fromHostId: number | null;
  toHostId: number | null;
  latencyMs: number | null;
  isTimeout: boolean;
  /** Unix 毫秒 */
  at: number | null;
  /** 哪路后台探测给的：tunnel 隧道逐跳、chain 转发链逐跳、route 线路组中转探测。 */
  source: "tunnel" | "chain" | "route";
};

export type ExpectedLatency = {
  /** 入口探到底的最近一次（tcping_stats）。 */
  total: { latencyMs: number | null; isTimeout: boolean; at: number | null } | null;
  /** 隧道自己的整条延迟（隧道探测），和规则的 total 不是一回事：隧道不含最后到目标那一段。 */
  tunnelTotal: { latencyMs: number | null; isTimeout: boolean; at: number | null } | null;
  segments: ExpectedSegment[];
};

async function latestRuleTcping(ruleId: number) {
  const table = quoteIdentifier("tcping_stats");
  const rows = await queryRaw<any>(
    `SELECT ${quoteIdentifier("latencyMs")}, ${quoteIdentifier("isTimeout")}, ${quoteIdentifier("recordedAt")} FROM ${table} WHERE ${quoteIdentifier("ruleId")} = ? ORDER BY ${quoteIdentifier("recordedAt")} DESC LIMIT 1`,
    [ruleId],
  ).catch(() => [] as any[]);
  const row = rows[0];
  if (!row) return null;
  const timeout = row.isTimeout === true || row.isTimeout === 1 || row.isTimeout === "1";
  const latency = row.latencyMs === null || row.latencyMs === undefined ? null : Number(row.latencyMs);
  return { latencyMs: timeout || latency === null || !Number.isFinite(latency) ? null : latency, isTimeout: timeout, at: timestampMillis(row.recordedAt) || null };
}

export async function buildRuleExpectedLatency(rule: any): Promise<ExpectedLatency> {
  const ruleId = Number(rule.id);
  const result: ExpectedLatency = { total: await latestRuleTcping(ruleId), tunnelTotal: null, segments: [] };

  // 线路组：当前走的那条路径，每台中转探它下一跳的结果（routeGroupStats）。
  const routeGroup = routeGroupOf(rule);
  if (routeGroup) {
    const status = getRouteStatus(ruleId);
    const agent = status.agent || status.staleAgent;
    const activeIndex = agent && agent.activeIndex >= 0 ? agent.activeIndex : 0;
    const path = routeGroup.paths[activeIndex];
    if (path) {
      const target = agent?.targets.find((item) => item.index === activeIndex) || null;
      // 第一段：入口探拨号地址（第一跳中继）。
      result.segments.push({
        hopIndex: 0,
        fromHostId: Number(rule.hostId) || null,
        toHostId: path.hops[0] ?? null,
        latencyMs: target?.latencyMs ?? null,
        isTimeout: !!target && !target.healthy,
        at: target?.lastProbeAt || null,
        source: "route",
      });
      path.hops.forEach((hostId, hopIndex) => {
        const probe = status.hops.find((item) => item.pathKey === path.key && item.hopIndex === hopIndex) || null;
        result.segments.push({
          hopIndex: hopIndex + 1,
          fromHostId: hostId,
          toHostId: path.hops[hopIndex + 1] ?? null,
          latencyMs: probe?.latencyMs ?? null,
          isTimeout: probe ? !probe.ok : false,
          at: probe?.at ?? null,
          source: "route",
        });
      });
    }
    return result;
  }

  // 转发链模板：每台成员机探它下一跳（forwardGroupAutoLatencyState）。
  if (rule.isForwardGroupTemplate && Number(rule.forwardGroupId) > 0) {
    const group = await (db.getForwardGroupById(Number(rule.forwardGroupId)) as Promise<any>).catch(() => null);
    if (group && String(group.groupMode || "failover") === "chain") {
      const probes = await db.getForwardGroupChainProbes(Number(group.id), { includeFinalTarget: true, templateRule: rule }).catch(() => []);
      const details = getForwardGroupAutoHopDetails(Number(group.id));
      probes.forEach((probe, index) => {
        const detail = details.find((item) => item.hopIndex === probe.hopIndex && item.hopCount === probe.hopCount) || null;
        result.segments.push({
          hopIndex: probe.hopIndex,
          fromHostId: probe.fromHostId || null,
          toHostId: probes[index + 1]?.fromHostId ?? null,
          latencyMs: detail && !detail.isTimeout ? detail.latencyMs : null,
          isTimeout: !!detail?.isTimeout,
          at: detail?.recordedAt ?? null,
          source: "chain",
        });
      });
      return result;
    }
  }

  // 走隧道：隧道的逐跳后台探测（和诊断结果同一份口径，agentSelfTestRoutes 也用它）。
  if (Number(rule.tunnelId) > 0) {
    const tunnel = await (db.getTunnelById(Number(rule.tunnelId)) as Promise<any>).catch(() => null);
    if (tunnel) {
      const latest = await db.getLatestTunnelLatency(Number(tunnel.id)).catch(() => null) as any;
      if (latest) {
        const timeout = latest.isTimeout === true || latest.isTimeout === 1;
        result.tunnelTotal = { latencyMs: timeout ? null : Number(latest.latencyMs) || null, isTimeout: timeout, at: timestampMillis(latest.recordedAt) || null };
      }
      const details = await loadFreshTunnelAutoDetails(tunnel, latest).catch(() => []);
      for (const detail of details) {
        result.segments.push({
          hopIndex: Number(detail.hopIndex),
          fromHostId: detail.fromHostId ?? null,
          toHostId: detail.toHostId ?? null,
          latencyMs: detail.success ? detail.latencyMs : null,
          isTimeout: !detail.success,
          at: result.tunnelTotal?.at ?? null,
          source: "tunnel",
        });
      }
    }
  }
  return result;
}
