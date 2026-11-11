/**
 * Mieru 的流量按用户记：mita 自己按用户名计累计字节（mita get metrics 里的 users 段），
 * Agent 每轮扩展通道原样报上来，面板在这里换算成增量记账。
 *
 * 为什么面板算增量、而不是 Agent 算好了报差值：累计值本身就是幂等的 —— 同一份上报重放、
 * 扩展通道一轮失败重试，算出来的增量都是 0，不需要再搭一套「待确认上报」的落盘与回执。
 * 代价只有一个：mita 进程重启时，上一次上报之后、重启之前那一小段（最多一轮，约一分钟）记不上。
 *
 * 记到哪：
 *   - 这一份凭据自己（proxy_inbound_users.trafficUsed）—— 这才是「按用户」；
 *   - 端口的用量（proxy_inbounds.trafficUsed）—— 和别的落地一样，落地机的额度提醒看它；
 *   - 入站主人的套餐流量（users.trafficUsed）—— 和 sing-box 那几个协议同一个口径：分享出去的凭据
 *     跑的流量也算在主人头上（主人的端口、主人的套餐）。超了照转发那条路的做法停他的转发。
 *
 * 不再按端口计数：mita 的用户不分端口（A 入站的凭据连 B 入站的端口也能通），按端口计会记错人，
 * 所以心跳里不给 Mieru 端口装计数链（server/agentHeartbeatRoute.ts）。
 */

import * as db from "./db";
import { executeRaw, queryRaw, quoteDbIdentifier, withDatabaseTransaction } from "./dbRuntime";
import { withKeyedTaskLock } from "./keyedTaskLock";
import { pushAgentRefresh } from "./agentEvents";
import type { MitaTrafficReport } from "./mitaRuntime";
import { planMitaAccounting, type MitaAccountingRow } from "./mitaTrafficPlan";

/**
 * 这台机器上启用中的 Mieru 入站的每一份凭据，连同上次的计数基线。
 * 只认这台机器上的：token 认的是「哪台机器」，别的机器报这里的用户名不该记得上。
 */
async function loadMitaAccountingRows(hostId: number): Promise<MitaAccountingRow[]> {
  const q = quoteDbIdentifier;
  const rows = await queryRaw<Record<string, unknown>>(
    // 别名要加引号：PostgreSQL 会把不加引号的 inboundId 折成小写。
    `SELECT u.${q("id")} AS ${q("id")}, u.${q("inboundId")} AS ${q("inboundId")}, i.${q("userId")} AS ${q("ownerId")}, u.${q("uuid")} AS ${q("name")},
            u.${q("mitaCounterKey")} AS ${q("counterKey")}, u.${q("mitaCounterUp")} AS ${q("counterUp")}, u.${q("mitaCounterDown")} AS ${q("counterDown")}
       FROM ${q("proxy_inbound_users")} u
       JOIN ${q("proxy_inbounds")} i ON i.${q("id")} = u.${q("inboundId")}
      WHERE i.${q("hostId")} = ? AND i.${q("protocol")} = ? AND i.${q("isEnabled")} = ?`,
    [Number(hostId), "mieru", true],
  );
  return rows
    .map((row) => ({
      id: Number(row.id),
      inboundId: Number(row.inboundId),
      ownerId: Number(row.ownerId),
      name: String(row.name || "").trim(),
      counterKey: String(row.counterKey || ""),
      counterUp: Math.max(0, Number(row.counterUp) || 0),
      counterDown: Math.max(0, Number(row.counterDown) || 0),
    }))
    .filter((row) => row.id > 0 && row.name);
}

/** 记一轮账。同一台机器的两轮不并发（扩展通道正常是串行的，这里再锁一下）。 */
export async function applyMitaTrafficReport(hostId: number, report: MitaTrafficReport): Promise<{ accountedBytes: number }> {
  if (report.users.length === 0) return { accountedBytes: 0 };
  return withKeyedTaskLock(`mita-traffic:${Number(hostId)}`, async () => {
    const rows = await loadMitaAccountingRows(hostId);
    if (rows.length === 0) return { accountedBytes: 0 };
    const plan = planMitaAccounting(report, rows);
    if (plan.rows.length === 0) return { accountedBytes: 0 };
    const q = quoteDbIdentifier;
    const ownerIds = Array.from(plan.byOwner.keys()).sort((a, b) => a - b);
    const exceeded: number[] = [];
    await withDatabaseTransaction(async () => {
      if (ownerIds.length > 0) await db.lockTrafficBillingUserRows(ownerIds);
      for (const row of plan.rows) {
        await executeRaw(
          `UPDATE ${q("proxy_inbound_users")}
              SET ${q("trafficUsed")} = COALESCE(${q("trafficUsed")}, 0) + ?, ${q("mitaCounterKey")} = ?, ${q("mitaCounterUp")} = ?, ${q("mitaCounterDown")} = ?
            WHERE ${q("id")} = ?`,
          [row.delta, row.key, row.up, row.down, row.id],
        );
      }
      await db.addProxyInboundTraffic(plan.byInbound);
      for (const ownerId of ownerIds) {
        const user = await db.addUserTraffic(ownerId, plan.byOwner.get(ownerId) || 0);
        if (user && Number(user.trafficLimit || 0) > 0 && Number(user.trafficUsed || 0) >= Number(user.trafficLimit)) {
          exceeded.push(ownerId);
        }
      }
    });
    // 超额的处理放在事务外面，和转发那条路（agentReportRoutes.ts）一样：停转发、断内核转发上的连接。
    // 落地端口本身下一轮心跳 / 扩展通道就会因为主人没资格了而从配置里拿掉。
    for (const ownerId of exceeded) {
      await db.setUserForwardAccess(ownerId, false, "traffic_limit").catch(() => undefined);
      const { onUserTrafficQuotaExhausted } = await import("./ops/quotaAgent");
      onUserTrafficQuotaExhausted(ownerId);
      pushAgentRefresh(Number(hostId), "mita-traffic-limit-exceeded");
    }
    let accountedBytes = 0;
    for (const value of plan.byInbound.values()) accountedBytes += value;
    return { accountedBytes };
  });
}
