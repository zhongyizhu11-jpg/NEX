/*
  流量用尽时的处理（#18）。

  ── 现在（改动前）流量用尽时到底发生了什么 ──
  1. Agent 上报流量（server/agentReportRoutes.ts），面板累加到 users.trafficUsed；一旦
     trafficUsed ≥ trafficLimit，调 setUserForwardAccess(userId, false, "traffic_limit")：
     账户的转发权限、隧道、代理订阅三个开关关掉，名下所有启用中的规则写成
     isEnabled = false、disabledByUser = true（规则本身保留，流量重置 / 续费后由
     healAutoStoppedRules 自动拉回来）。
  2. 紧接着 refreshUserRuleAgents 让相关机器立刻重新拉配置；Agent 发现这些规则不在期望状态里了，
     按转发类型把它们撤掉：
       - realm / socat / gost / nginx / ForwardX 这类「进程」转发：进程停掉或重建，
         经过它的连接随进程一起断开 —— 已经连着的也立即断。
       - iptables / nftables 内核转发：只删 DNAT 和计数规则，conntrack 里已经建立的连接
         不受影响，会一直跑到自己断开（TCP 已建立连接的默认超时是 5 天）；而且计数规则也删了，
         这段流量不再计入任何人的用量。
  3. 新连接在两类转发上都会被拒（端口没人听 / 没有 DNAT）。

  ── 这个设置 ──
  「立即断开」（默认，与上面第 2 步的进程类转发一致）：另外让 Agent 用 conntrack -D
     把这些内核转发端口上已建立的连接也清掉，两类转发表现一致。需要 Agent 2.2.216+
     （扩展通道模块 "quota"）和机器上装了 conntrack 工具，缺哪个就保持原样。
  「允许跑完」：不清 conntrack —— 也就是改动前的原样。内核转发上已连着的连接跑到自然断开；
     进程类转发仍会立即断开（进程本身要停下）。让进程类转发也「跑完」需要停用规则时不撤进程、
     改成只拒新连接，这要动规则停用的整条链路（计费、恢复、界面都依赖 isEnabled），
     这一版没有做。
*/
import { getSetting, setSetting } from "../repositories/settingsRepository";

export const QUOTA_MODES = ["cut", "drain"] as const;
export type QuotaMode = (typeof QUOTA_MODES)[number];
export const QUOTA_MODE_SETTING = "ops.quota.mode";
export const DEFAULT_QUOTA_MODE: QuotaMode = "cut";

export function normalizeQuotaMode(value: unknown): QuotaMode {
  return value === "drain" ? "drain" : value === "cut" ? "cut" : DEFAULT_QUOTA_MODE;
}

export async function getQuotaMode(): Promise<QuotaMode> {
  return normalizeQuotaMode(await getSetting(QUOTA_MODE_SETTING));
}

export async function setQuotaMode(mode: QuotaMode) {
  await setSetting(QUOTA_MODE_SETTING, mode);
}

/** 会在 conntrack 里留下已建立连接的转发类型（内核转发）。 */
export const KERNEL_FORWARD_TYPES = ["iptables", "nftables"] as const;

export type QuotaFlushItem = { key: string; port: number; protocol: "tcp" | "udp" | "both" };

/**
 * 给一台主机的清理清单：因流量用尽停下、最近一天内停的内核转发规则。
 *
 * 只要最近一天的：更早的连接要么早断了，要么早清过了，没必要每轮都带着。
 * 停下不到 5 秒的先不给 —— Agent 那边 DNAT 可能还没撤，这时清掉 conntrack，
 * 新连接马上又会建起来（Agent 也会隔 30 秒再清一次兜底，见 agent/ext_quota.go）。
 */
export function quotaFlushItems(
  rows: ReadonlyArray<{ id: unknown; sourcePort: unknown; protocol: unknown; updatedAt: unknown }>,
  nowSeconds: number,
): QuotaFlushItem[] {
  const items: QuotaFlushItem[] = [];
  for (const row of rows) {
    const id = Number(row.id);
    const port = Number(row.sourcePort);
    const updatedAt = epochSeconds(row.updatedAt);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(port) || port <= 0 || port > 65535 || updatedAt === null) continue;
    if (nowSeconds - updatedAt < 5 || nowSeconds - updatedAt > 86400) continue;
    const proto = String(row.protocol || "").toLowerCase();
    const protocol = proto === "tcp" || proto === "udp" ? proto : "both";
    items.push({ key: `r${id}-p${port}-t${updatedAt}`, port, protocol });
  }
  return items;
}

function epochSeconds(value: unknown): number | null {
  if (value == null || value === "") return null;
  const ms = value instanceof Date ? value.getTime() : Number(value) > 10_000_000_000 ? Number(value) : Number(value) * 1000;
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : null;
}
