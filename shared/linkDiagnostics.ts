/**
 * 一键链路诊断（2.3.444 / Agent 2.2.225）：面板和浏览器共用的那一半。
 *
 * 一次诊断产出一张清单：每一项有状态（通过 / 警告 / 失败 / 跳过 / 等待）、一句结论、
 * 一句「怎么修」，按 配置 → 主机 → 入口 → 链路 → 目标 分组。面板侧的项（配置、主机在线、
 * 端口冲突、域名解析……）点下去立刻出结果；要到主机上看的项（端口有没有在听、防火墙、
 * 目标从主机上拨不拨得通……）由 Agent 的 diagnostics 任务回报，回来之前是「等待」。
 *
 * 这里只放纯函数：总评、「最可能的原因」、复制给客服的文本。谁该是哪个状态由
 * server/linkDiagnosticsChecks.ts 判。
 */

export const LINK_DIAGNOSTICS_AGENT_VERSION = "2.2.225";

export type DiagnosticStatus = "pass" | "warn" | "fail" | "skip" | "pending";
export type DiagnosticGroup = "config" | "host" | "entry" | "link" | "target";
export type DiagnosticSubjectKind = "rule" | "tunnel" | "forwardGroup";

export const DIAGNOSTIC_GROUPS: readonly DiagnosticGroup[] = ["config", "host", "entry", "link", "target"];

export const DIAGNOSTIC_GROUP_LABELS: Record<DiagnosticGroup, string> = {
  config: "配置",
  host: "主机",
  entry: "入口",
  link: "链路",
  target: "目标",
};

export const DIAGNOSTIC_STATUS_LABELS: Record<DiagnosticStatus, string> = {
  pass: "通过",
  warn: "警告",
  fail: "失败",
  skip: "跳过",
  pending: "等待",
};

/** 旧 Agent 上那几项不算失败，换成这一句。 */
export const DIAGNOSTIC_NEEDS_UPGRADE_LABEL = "需要升级 Agent";
export const DIAGNOSTIC_NEEDS_UPGRADE_SUMMARY = `需要升级 Agent 到 ${LINK_DIAGNOSTICS_AGENT_VERSION}`;

export type DiagnosticItem = {
  /** 在一次诊断里唯一，例如 `config.enabled`、`agent:3:listen:443/tcp`。 */
  key: string;
  group: DiagnosticGroup;
  title: string;
  status: DiagnosticStatus;
  /** 一句话结论。 */
  summary: string;
  /** 一句「怎么修」；通过的项通常没有。 */
  hint?: string;
  /** 展开看的原始细节（命令输出、解析到的地址……）。 */
  detail?: string;
  hostId?: number;
  hostName?: string;
  /** 这一项要 Agent 来测；true = Agent 太旧，没测。 */
  needsUpgrade?: boolean;
  /** 来源：panel = 面板直接判；agent = Agent 回报。 */
  source: "panel" | "agent";
  latencyMs?: number;
};

export type DiagnosticVerdict = "pass" | "warn" | "fail" | "pending";

export type DiagnosticCause = {
  key: string;
  title: string;
  summary: string;
  hint?: string;
  hostName?: string;
};

export type LinkDiagnosticsReport = {
  sessionId: string;
  subject: { kind: DiagnosticSubjectKind; id: number; name: string };
  startedAt: string;
  updatedAt: string;
  /** 还有 Agent 项没回来。 */
  running: boolean;
  verdict: DiagnosticVerdict;
  verdictText: string;
  cause: DiagnosticCause | null;
  items: DiagnosticItem[];
  counts: Record<DiagnosticStatus, number>;
};

export function countDiagnosticStatuses(items: readonly DiagnosticItem[]): Record<DiagnosticStatus, number> {
  const counts: Record<DiagnosticStatus, number> = { pass: 0, warn: 0, fail: 0, skip: 0, pending: 0 };
  for (const item of items) counts[item.status] += 1;
  return counts;
}

const GROUP_ORDER = new Map(DIAGNOSTIC_GROUPS.map((group, index) => [group, index] as const));

/**
 * 「最可能的原因」：第一项失败；没有失败就第一项警告。
 *
 * 「第一」按分组顺序（配置 → 主机 → 入口 → 链路 → 目标），组内按清单顺序 —— 越靠前的
 * 越根本：规则被停了，后面端口没在听、目标拨不通都只是它的结果，不该把人引到防火墙上去。
 * 跳过、等待、需要升级的项不当原因。
 */
export function pickDiagnosticCause(items: readonly DiagnosticItem[]): DiagnosticCause | null {
  const ordered = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (GROUP_ORDER.get(a.item.group)! - GROUP_ORDER.get(b.item.group)!) || a.index - b.index)
    .map(({ item }) => item);
  const pick = ordered.find((item) => item.status === "fail") || ordered.find((item) => item.status === "warn");
  if (!pick) return null;
  return {
    key: pick.key,
    title: pick.title,
    summary: pick.summary,
    ...(pick.hint ? { hint: pick.hint } : {}),
    ...(pick.hostName ? { hostName: pick.hostName } : {}),
  };
}

/** 总评：有失败就是失败；否则有项还在等就是「诊断中」；否则有警告是警告；都没有是通过。 */
export function diagnosticVerdict(items: readonly DiagnosticItem[]): DiagnosticVerdict {
  if (items.some((item) => item.status === "fail")) return "fail";
  if (items.some((item) => item.status === "pending")) return "pending";
  if (items.some((item) => item.status === "warn")) return "warn";
  return "pass";
}

export function diagnosticVerdictText(verdict: DiagnosticVerdict, counts: Record<DiagnosticStatus, number>) {
  switch (verdict) {
    case "fail":
      return counts.pending > 0
        ? `发现 ${counts.fail} 项失败，还有 ${counts.pending} 项在等主机回报`
        : `发现 ${counts.fail} 项失败`;
    case "pending":
      return `还有 ${counts.pending} 项在等主机回报`;
    case "warn":
      return `没有发现失败项，有 ${counts.warn} 项警告`;
    default:
      return "全部检查通过";
  }
}

export function buildDiagnosticsReport(input: {
  sessionId: string;
  subject: LinkDiagnosticsReport["subject"];
  startedAt: string;
  updatedAt?: string;
  items: DiagnosticItem[];
}): LinkDiagnosticsReport {
  const counts = countDiagnosticStatuses(input.items);
  const verdict = diagnosticVerdict(input.items);
  return {
    sessionId: input.sessionId,
    subject: input.subject,
    startedAt: input.startedAt,
    updatedAt: input.updatedAt || new Date().toISOString(),
    running: counts.pending > 0,
    verdict,
    verdictText: diagnosticVerdictText(verdict, counts),
    cause: pickDiagnosticCause(input.items),
    items: input.items,
    counts,
  };
}

const SUBJECT_KIND_LABELS: Record<DiagnosticSubjectKind, string> = {
  rule: "规则",
  tunnel: "隧道",
  forwardGroup: "转发链",
};

function itemStatusText(item: DiagnosticItem) {
  return item.needsUpgrade ? DIAGNOSTIC_NEEDS_UPGRADE_LABEL : DIAGNOSTIC_STATUS_LABELS[item.status];
}

/**
 * 「复制结果」：贴给客服 / 发工单用的纯文本。每组一段，每项一行
 * 「[状态] 标题：结论」，有修复建议另起一行，原始细节缩进跟在后面。
 */
export function formatDiagnosticsReportText(report: LinkDiagnosticsReport, options: { includeDetail?: boolean } = {}) {
  const includeDetail = options.includeDetail !== false;
  const lines: string[] = [];
  lines.push(`NEX 链路诊断 · ${SUBJECT_KIND_LABELS[report.subject.kind]}「${report.subject.name}」(#${report.subject.id})`);
  lines.push(`时间：${report.startedAt}`);
  lines.push(`结论：${report.verdictText}`);
  if (report.cause) {
    lines.push(`最可能的原因：${report.cause.title} —— ${report.cause.summary}`);
    if (report.cause.hint) lines.push(`建议：${report.cause.hint}`);
  }
  for (const group of DIAGNOSTIC_GROUPS) {
    const items = report.items.filter((item) => item.group === group);
    if (items.length === 0) continue;
    lines.push("");
    lines.push(`【${DIAGNOSTIC_GROUP_LABELS[group]}】`);
    for (const item of items) {
      const latency = typeof item.latencyMs === "number" && item.latencyMs >= 0 ? `（${item.latencyMs} ms）` : "";
      lines.push(`[${itemStatusText(item)}] ${item.title}：${item.summary}${latency}`);
      if (item.hint && item.status !== "pass") lines.push(`    建议：${item.hint}`);
      if (includeDetail && item.detail) {
        for (const detailLine of item.detail.split("\n").slice(0, 40)) lines.push(`    | ${detailLine}`);
      }
    }
  }
  return lines.join("\n");
}
