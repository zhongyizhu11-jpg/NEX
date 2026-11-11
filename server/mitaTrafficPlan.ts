/**
 * Mieru 按用户记账的纯计算部分（不碰数据库，单独成文件好测）。落库在 server/mitaTraffic.ts。
 */

import type { MitaTrafficReport } from "./mitaRuntime";

export type MitaCounterBaseline = { key: string; up: number; down: number };

/**
 * 一个用户这一轮的增量。
 *
 * key 是「哪个 mita 进程 + 哪个用户名」：进程换了（重启、换机器）或者凭据换了（换密钥会换用户名），
 * 计数是从 0 重新数的，这一轮看到的累计值整个都是新流量。同一个进程里累计值还变小了，
 * 说明我们没看到那次重启（进程号恰好重用）—— 一样当成从 0 重来，宁可少记一段也不报负数。
 */
export function mitaCounterDelta(previous: MitaCounterBaseline | null, current: MitaCounterBaseline): { up: number; down: number } {
  const up = Math.max(0, Math.floor(Number(current.up) || 0));
  const down = Math.max(0, Math.floor(Number(current.down) || 0));
  if (!previous || previous.key !== current.key) return { up, down };
  if (up < previous.up || down < previous.down) return { up, down };
  return { up: up - previous.up, down: down - previous.down };
}

export type MitaAccountingRow = {
  /** proxy_inbound_users.id */
  id: number;
  inboundId: number;
  ownerId: number;
  name: string;
  counterKey: string;
  counterUp: number;
  counterDown: number;
};

export type MitaAccountingPlan = {
  /** 每一行凭据：新的计数基线和这一轮的增量 */
  rows: Array<{ id: number; key: string; up: number; down: number; delta: number }>;
  byInbound: Map<number, number>;
  byOwner: Map<number, number>;
};

/** 纯计算：上报 + 库里的基线 → 这一轮该记多少、记给谁。报上来但面板不认识的用户名直接丢掉。 */
export function planMitaAccounting(report: MitaTrafficReport, rows: readonly MitaAccountingRow[]): MitaAccountingPlan {
  const byName = new Map(rows.map((row) => [row.name, row]));
  const plan: MitaAccountingPlan = { rows: [], byInbound: new Map(), byOwner: new Map() };
  for (const user of report.users) {
    const row = byName.get(user.name);
    if (!row) continue;
    const key = `${report.instance}|${user.name}`;
    const delta = mitaCounterDelta(
      row.counterKey ? { key: row.counterKey, up: row.counterUp, down: row.counterDown } : null,
      { key, up: user.up, down: user.down },
    );
    const bytes = delta.up + delta.down;
    plan.rows.push({ id: row.id, key, up: user.up, down: user.down, delta: bytes });
    if (bytes > 0) {
      plan.byInbound.set(row.inboundId, (plan.byInbound.get(row.inboundId) || 0) + bytes);
      plan.byOwner.set(row.ownerId, (plan.byOwner.get(row.ownerId) || 0) + bytes);
    }
  }
  return plan;
}
