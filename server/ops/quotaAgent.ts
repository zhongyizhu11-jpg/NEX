/*
  「流量用尽时立即断开」的 Agent 扩展模块 "quota"（见 quotaPolicy.ts 顶部的说明）。

  指令：{ mode, flush: [{ key, port, protocol }] } —— 这台机器上因流量用尽停下的内核转发端口。
  Agent 对每个 key 用 conntrack -D 清一次已建立的连接（30 秒后再清一次兜底），之后不再重复。
  上报：{ conntrack: 有没有 conntrack 工具, flushed: 累计清过几个端口 }，给设置页显示用。
*/
import { queryRaw, quoteDbIdentifier } from "../dbRuntime";
import { hostSupportsAgentExt, registerAgentExtModule, wakeAgentExt } from "./agentExt";
import { getQuotaMode, KERNEL_FORWARD_TYPES, quotaFlushItems } from "./quotaPolicy";

const q = quoteDbIdentifier;

export type QuotaAgentReport = { conntrack: boolean; flushed: number; at: number };
const reports = new Map<number, QuotaAgentReport>();

export function quotaAgentReports(): ReadonlyMap<number, QuotaAgentReport> {
  return reports;
}

async function kernelRulesPausedForTraffic(where: string, params: unknown[]) {
  const types = KERNEL_FORWARD_TYPES.map(() => "?").join(", ");
  return queryRaw<any>(
    `SELECT r.${q("id")} AS ${q("id")}, r.${q("hostId")} AS ${q("hostId")}, r.${q("sourcePort")} AS ${q("sourcePort")},
            r.${q("protocol")} AS ${q("protocol")}, r.${q("updatedAt")} AS ${q("updatedAt")}
       FROM ${q("forward_rules")} r
       INNER JOIN ${q("users")} u ON u.${q("id")} = r.${q("userId")}
      WHERE u.${q("forwardAccessPauseReason")} = ?
        AND r.${q("isEnabled")} = ?
        AND r.${q("forwardType")} IN (${types})
        AND r.${q("updatedAt")} >= ?
        AND ${where}`,
    ["traffic_limit", false, ...KERNEL_FORWARD_TYPES, Math.floor(Date.now() / 1000) - 86400, ...params],
  );
}

registerAgentExtModule({
  name: "quota",
  async directive(host) {
    const mode = await getQuotaMode();
    if (mode !== "cut") return { mode, flush: [] };
    const rows = await kernelRulesPausedForTraffic(`r.${q("hostId")} = ?`, [Number(host.id)]);
    return { mode, flush: quotaFlushItems(rows, Math.floor(Date.now() / 1000)) };
  },
  ingest(host, report) {
    const value = report as any;
    if (!value || typeof value !== "object") return;
    reports.set(Number(host.id), { conntrack: !!value.conntrack, flushed: Number(value.flushed || 0), at: Date.now() });
  },
});

/**
 * 某个用户刚因流量用尽被停（server/agentReportRoutes.ts 里调用）：「立即断开」模式下，
 * 等 Agent 把规则撤掉（约 15 秒）再叫它来取清理清单，不必等下一轮 60 秒。
 */
const lastWakeByUser = new Map<number, number>();

export function onUserTrafficQuotaExhausted(userId: number) {
  // 超额之后只要还有流量上报，这里每次都会被调到（内核转发上没断的连接还在跑）；一分钟最多叫一次。
  const now = Date.now();
  if (now - (lastWakeByUser.get(userId) || 0) < 60_000) return;
  lastWakeByUser.set(userId, now);
  if (lastWakeByUser.size > 5000) lastWakeByUser.clear();
  void (async () => {
    if ((await getQuotaMode()) !== "cut") return;
    const rows = await kernelRulesPausedForTraffic(`r.${q("userId")} = ?`, [Number(userId)]);
    const hostIds = Array.from(new Set(rows.map((row) => Number(row.hostId)).filter((id) => id > 0)));
    if (hostIds.length === 0) return;
    const timer = setTimeout(() => {
      for (const hostId of hostIds) wakeAgentExt(hostId, "quota-exhausted");
    }, 15_000);
    timer.unref?.();
  })().catch((error) => {
    console.warn(`[Quota] wake after exhaustion failed user=${userId}: ${error instanceof Error ? error.message : String(error)}`);
  });
}

export { hostSupportsAgentExt };
