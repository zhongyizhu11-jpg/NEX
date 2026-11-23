import { networkHealthPriority, type NetworkHealth } from "./networkHealth";

/**
 * 首页「需要关注」。
 *
 * 顶上那一行说「3 处异常」，这里把它拆成一条条点得进去的东西：哪台机器、哪条
 * 隧道、哪个转发组、哪条转发。只给一个数，等于让人去四个页面挨个找。
 *
 * 行和顶上那个数出自**同一次查询、同一组判据**：列表里有几类红的，顶上就写几处
 * 异常。两边各算各的话，迟早一边多一条，人就不知道该信哪边。
 *
 * 这里只放和展示有关的纯函数（状态映射、排序、文案），服务端出行，客户端决定
 * 画几行、点进去落在哪一页。
 */

export type DashboardAttentionReason =
  | "host-offline"
  | "host-never-connected"
  | "tunnel-stopped"
  | "group-down"
  | "group-degraded"
  | "forward-stalled"
  | "forward-paused";

type DashboardAttentionKind = "host" | "tunnel" | "group" | "forward";

export type DashboardAttentionRow = {
  reason: DashboardAttentionReason;
  id: number;
  name: string;
  /** 时间线索（毫秒）：主机是最后一次心跳，其余是最后一次状态变化。拿不到是 null */
  at: number | null;
  /** tunnel-stopped：入口 / 出口主机名 */
  entryName?: string | null;
  exitName?: string | null;
  /** forward-stalled：转发所在的主机；模板规则给的是它所属的转发组 */
  hostName?: string | null;
  groupName?: string | null;
  /** group-*：转发组自己报的那句原因 */
  message?: string | null;
  /** group-*：转发组的形态，决定点进去落在链路页哪个 tab */
  groupMode?: string | null;
  /** forward-paused：停着的转发条数，以及账户为什么被暂停 */
  count?: number;
  pauseReason?: string | null;
};

export type DashboardAttentionTotals = Record<DashboardAttentionReason, number>;

export type DashboardAttention = {
  /** 每一类最多取几条（服务端截断）；排序和最终画几行在客户端 */
  rows: DashboardAttentionRow[];
  /** 每一类一共多少条。「还有 N 项」和顶上的异常数都从这里算 */
  totals: DashboardAttentionTotals;
};

type ReasonSpec = { kind: DashboardAttentionKind; health: NetworkHealth; label: string };

export const ATTENTION_REASONS: Record<DashboardAttentionReason, ReasonSpec> = {
  "host-offline": { kind: "host", health: "down", label: "主机掉线" },
  /*
    从没收过心跳 = 还没装 Agent。一步没做完不是故障，所以是 unknown 不是 down：
    不计入顶上的「异常」，但要在这里出现 —— 没有结论本身就是一件待办的事。
  */
  "host-never-connected": { kind: "host", health: "unknown", label: "还没接入" },
  "tunnel-stopped": { kind: "tunnel", health: "down", label: "隧道没在运行" },
  "group-down": { kind: "group", health: "down", label: "转发组故障" },
  "group-degraded": { kind: "group", health: "degraded", label: "转发组降级" },
  "forward-stalled": { kind: "forward", health: "down", label: "转发没在运行" },
  /*
    租户自己的账户被暂停了转发（到期、超额、欠费、管理员手动）。只在租户自己的
    首页出现，而且合成一行 —— 十条转发一起停，原因只有一个，列十行是在刷屏。
  */
  "forward-paused": { kind: "forward", health: "down", label: "转发已暂停" },
};

const REASON_KEYS = Object.keys(ATTENTION_REASONS) as DashboardAttentionReason[];

export function emptyAttentionTotals(): DashboardAttentionTotals {
  return Object.fromEntries(REASON_KEYS.map((reason) => [reason, 0])) as DashboardAttentionTotals;
}

export function attentionHealth(reason: DashboardAttentionReason): NetworkHealth {
  return ATTENTION_REASONS[reason]?.health ?? "unknown";
}

function sumTotals(totals: Partial<DashboardAttentionTotals> | null | undefined, health: NetworkHealth) {
  if (!totals) return 0;
  return REASON_KEYS.reduce((sum, reason) => (
    ATTENTION_REASONS[reason].health === health ? sum + Math.max(0, Number(totals[reason]) || 0) : sum
  ), 0);
}

/** 顶上「N 处异常」的 N：所有 down 那几类加起来。 */
export function countAttentionIssues(totals: Partial<DashboardAttentionTotals> | null | undefined): number {
  return sumTotals(totals, "down");
}

/** 没有异常时顶上退一档说「N 处降级」—— 不能在列表里挂着琥珀色的同时写「运行正常」。 */
export function countAttentionDegraded(totals: Partial<DashboardAttentionTotals> | null | undefined): number {
  return sumTotals(totals, "degraded");
}

const KIND_ORDER: readonly DashboardAttentionKind[] = ["host", "tunnel", "group", "forward"];

/**
 * 排序。
 *
 * 先按状态：最该先看到的在前（和 rollUpNetworkHealth 同一个顺序）。
 *
 * 同一档里按「从根上往下」：主机 → 隧道 → 转发组 → 转发。一台机器掉了，挂在它上面
 * 的隧道和转发会跟着一起报 —— 机器排在最前面，人第一眼看到的就是根因，而不是
 * 三条症状。
 *
 * 同一类里最近出事的在前；没有时间线索的排在最后。
 */
export function sortAttentionRows(rows: readonly DashboardAttentionRow[]): DashboardAttentionRow[] {
  return [...rows].sort((a, b) => {
    const byHealth = networkHealthPriority(attentionHealth(a.reason)) - networkHealthPriority(attentionHealth(b.reason));
    if (byHealth !== 0) return byHealth;
    const byKind = KIND_ORDER.indexOf(ATTENTION_REASONS[a.reason].kind) - KIND_ORDER.indexOf(ATTENTION_REASONS[b.reason].kind);
    if (byKind !== 0) return byKind;
    const aAt = a.at ?? Number.NEGATIVE_INFINITY;
    const bAt = b.at ?? Number.NEGATIVE_INFINITY;
    if (aAt !== bAt) return bAt - aAt;
    return a.id - b.id;
  });
}

/**
 * 「18 分钟前」这类说法。
 *
 * 精度跟着距离走：几分钟前的事要精确到分钟，几天前的事精确到天就够了 ——
 * 「5 天 17 小时 3 分钟前」里后面那两截没有人会读。
 *
 * 负数（面板和数据库时钟有一点偏差）按「刚刚」算，不写「-2 分钟前」。
 */
export function formatAgo(elapsedMs: number): string {
  const ms = Number(elapsedMs);
  if (!Number.isFinite(ms)) return "";
  if (ms < 60_000) return "刚刚";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/**
 * 暂停原因，写给**租户自己**看的版本：说原因，也说出路。
 *
 * 和 forwardAccessBlockedReasonText 不是一回事 —— 那句是写给管理员的（「先重置
 * 流量统计或调高额度」），租户做不了那些事。
 */
function tenantPauseReasonText(reason: string | null | undefined): string {
  switch (reason) {
    case "expired":
      return "账户到期了，续期后自动恢复";
    case "traffic_limit":
      return "流量额度用完了，加购或等下个周期";
    case "traffic_billing_balance":
      return "余额不足，充值后自动恢复";
    case "manual":
      return "管理员暂停了你的转发";
    default:
      return "转发权限没有开通，请联系管理员";
  }
}

function joinParts(parts: Array<string | null | undefined>) {
  return parts.map((part) => String(part || "").trim()).filter(Boolean).join(" · ");
}

/**
 * 一行的文案：标题是那个东西的名字，下面一行是「出了什么事 · 线索」。
 *
 * 线索挑的是**下一步最有用**的那一条：掉线的主机给「最后在线多久前」（刚掉和
 * 掉了三天是两种处理），停着的隧道给「入口 → 出口」（常常一眼就能对上上面那台
 * 掉线的机器），转发组给它自己报的原因。
 */
export function describeAttentionRow(row: DashboardAttentionRow, now = Date.now()): { title: string; detail: string } {
  const label = ATTENTION_REASONS[row.reason]?.label ?? "需要处理";
  switch (row.reason) {
    case "host-offline":
      return {
        title: row.name,
        detail: joinParts([label, row.at !== null ? `最后在线 ${formatAgo(now - row.at)}` : null]),
      };
    case "host-never-connected":
      return { title: row.name, detail: joinParts([label, "装好 Agent 后自动上线"]) };
    case "tunnel-stopped":
      return {
        title: row.name,
        detail: joinParts([label, row.entryName && row.exitName ? `${row.entryName} → ${row.exitName}` : null]),
      };
    case "group-down":
    case "group-degraded":
      return { title: row.name, detail: joinParts([label, row.message]) };
    case "forward-stalled":
      return {
        title: row.name,
        detail: joinParts([
          label,
          row.groupName ? `${row.groupName} 里没有一台在跑` : row.hostName ? `在 ${row.hostName} 上` : null,
        ]),
      };
    case "forward-paused":
      return {
        // 这一行是合出来的，没有「一个东西」可以当标题 —— 标题就说出了什么事。
        title: label,
        // 原因和出路在前、条数在后：窄屏上截断时，先丢的应该是不那么要紧的那半句。
        detail: joinParts([
          tenantPauseReasonText(row.pauseReason),
          Number(row.count) > 0 ? `${row.count} 条转发停着` : null,
        ]),
      };
    default:
      return { title: row.name, detail: label };
  }
}

const KIND_UNITS: Record<DashboardAttentionKind, string> = {
  host: "台主机",
  tunnel: "条隧道",
  group: "个转发组",
  forward: "条转发",
};

/**
 * 列表截断之后的那句「还有 …」。
 *
 * 说到类别，不只说一个总数：「还有 3 项」让人不知道该去哪一页找，
 * 「还有 2 条转发、1 个转发组」就知道了。
 */
export function summarizeHiddenAttention(
  totals: Partial<DashboardAttentionTotals> | null | undefined,
  shown: readonly DashboardAttentionRow[],
): string | null {
  if (!totals) return null;
  const hiddenByKind = new Map<DashboardAttentionKind, number>();
  for (const reason of REASON_KEYS) {
    const kind = ATTENTION_REASONS[reason].kind;
    const total = Math.max(0, Number(totals[reason]) || 0);
    const shownCount = shown.filter((row) => row.reason === reason).length;
    const hidden = Math.max(0, total - shownCount);
    if (hidden > 0) hiddenByKind.set(kind, (hiddenByKind.get(kind) || 0) + hidden);
  }
  const parts = KIND_ORDER
    .filter((kind) => (hiddenByKind.get(kind) || 0) > 0)
    .map((kind) => `${hiddenByKind.get(kind)} ${KIND_UNITS[kind]}`);
  return parts.length > 0 ? `还有 ${parts.join("、")}` : null;
}
