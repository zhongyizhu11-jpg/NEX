/*
  安全巡检（#3）里的纯逻辑：洗 Agent 上报、发现状态怎么流转。单独成文件好测（hostSecurityCore.test.ts）。

  三种状态：
    open          待处理
    acknowledged  已知道 —— 看过了；同一件事之后「又发生」会重新打开
    expected      这是我的 —— 不再提醒（scope host 只这台主机，all 所有主机）
  「又发生」的判断：Agent 每条发现带 since（这一段从什么时候开始）。变化类每次都是新的 since；
  状态类在一直存在期间 since 不变，消失后再出现才变大。所以只看 since 有没有比记下的 episodeAt 新。
*/

export type FindingSeverity = "low" | "medium" | "high" | "critical";
export type FindingStatus = "open" | "acknowledged" | "expected";
export type ExpectedScope = "host" | "all";
export type FindingDecision = "acknowledge" | "expected" | "reopen";

export const SEVERITY_RANK: Record<FindingSeverity, number> = { low: 0, medium: 1, high: 2, critical: 3 };
export const SEVERITIES: FindingSeverity[] = ["low", "medium", "high", "critical"];

export type IncomingFinding = {
  fingerprint: string;
  kind: string;
  severity: FindingSeverity;
  title: string;
  detail: string;
  evidence: Record<string, unknown>;
  persistent: boolean;
  since: number;
  at: number;
};

export type IncomingActionResult = { id: number; ok: boolean; message: string; quarantineId: string; at: number };

export type SecurityReport = {
  checkedAt: number;
  baselineReady: boolean;
  baselineAt: number;
  intervalMinutes: number;
  complete: boolean;
  findings: IncomingFinding[];
  active: string[];
  actionResults: IncomingActionResult[];
};

const FINGERPRINT = /^[0-9a-f]{8,64}$/;
const KIND = /^[a-z_]{2,48}$/;

function int(value: unknown, max = 2 ** 31 - 1) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : 0;
}

function text(value: unknown, max: number) {
  return String(value ?? "").slice(0, max);
}

export function normalizeSeverity(value: unknown): FindingSeverity {
  return value === "low" || value === "high" || value === "critical" ? value : "medium";
}

/** 证据只留平铺的字符串 / 数字 / 布尔 / 字符串数组，截短，免得一条发现把库撑大。 */
function cleanEvidence(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>).slice(0, 24)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(key)) continue;
    if (typeof raw === "string") out[key] = raw.slice(0, 600);
    else if (typeof raw === "number" && Number.isFinite(raw)) out[key] = raw;
    else if (typeof raw === "boolean") out[key] = raw;
    else if (Array.isArray(raw)) out[key] = raw.slice(0, 10).map((item) => String(item).slice(0, 300));
  }
  return out;
}

export function normalizeSecurityReport(raw: unknown, nowSeconds = Math.floor(Date.now() / 1000)): SecurityReport | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as Record<string, unknown>;
  const clampTime = (value: unknown) => {
    const n = int(value);
    return n && n <= nowSeconds + 600 ? n : 0;
  };
  const findings: IncomingFinding[] = [];
  for (const item of Array.isArray(input.findings) ? input.findings.slice(0, 300) : []) {
    if (!item || typeof item !== "object") continue;
    const f = item as Record<string, unknown>;
    const fingerprint = String(f.fingerprint || "").toLowerCase();
    const kind = String(f.kind || "");
    if (!FINGERPRINT.test(fingerprint) || !KIND.test(kind)) continue;
    const at = clampTime(f.at) || nowSeconds;
    findings.push({
      fingerprint,
      kind,
      severity: normalizeSeverity(f.severity),
      title: text(f.title, 200) || kind,
      detail: text(f.detail, 4000),
      evidence: cleanEvidence(f.evidence),
      persistent: f.persistent === true,
      since: clampTime(f.since) || at,
      at,
    });
  }
  const actionResults: IncomingActionResult[] = [];
  for (const item of Array.isArray(input.actionResults) ? input.actionResults.slice(0, 100) : []) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const id = int(r.id);
    if (!id) continue;
    actionResults.push({ id, ok: r.ok === true, message: text(r.message, 500), quarantineId: text(r.quarantineId, 80), at: clampTime(r.at) || nowSeconds });
  }
  const active = Array.isArray(input.active)
    ? input.active.map((v) => String(v).toLowerCase()).filter((v) => FINGERPRINT.test(v)).slice(0, 1000)
    : [];
  return {
    checkedAt: clampTime(input.checkedAt),
    baselineReady: input.baselineReady === true,
    baselineAt: clampTime(input.baselineAt),
    intervalMinutes: Math.min(60, int(input.intervalMinutes) || 5),
    complete: input.complete === true,
    findings,
    active,
    actionResults,
  };
}

export type ExistingFindingState = {
  status: FindingStatus;
  expectedScope: ExpectedScope | null;
  episodeAt: number | null;
  resolvedAt: number | null;
};

export type FindingTransition = {
  status: FindingStatus;
  expectedScope: ExpectedScope | null;
  episodeAt: number;
  /** 这一条是新的一段（第一次出现或消失后又出现 / 又发生了一次）。 */
  newEpisode: boolean;
  /** 从「已知道」被重新打开。 */
  reopened: boolean;
  /** 该不该提醒管理员（新的或重新打开的高危 / 严重）。 */
  notify: boolean;
};

/** Agent 报来一条发现，结合库里已有的那行（可能没有）和「所有主机都别提」名单，算出新的状态。 */
export function applyIncomingFinding(
  existing: ExistingFindingState | null,
  incoming: Pick<IncomingFinding, "severity" | "since">,
  globallyExpected: boolean,
): FindingTransition {
  const serious = SEVERITY_RANK[incoming.severity] >= SEVERITY_RANK.high;
  if (!existing) {
    const status: FindingStatus = globallyExpected ? "expected" : "open";
    return {
      status,
      expectedScope: globallyExpected ? "all" : null,
      episodeAt: incoming.since,
      newEpisode: true,
      reopened: false,
      notify: status === "open" && serious,
    };
  }
  const newEpisode = incoming.since > (existing.episodeAt || 0);
  const episodeAt = Math.max(existing.episodeAt || 0, incoming.since);
  if (globallyExpected) {
    return { status: "expected", expectedScope: existing.status === "expected" && existing.expectedScope === "host" ? "host" : "all", episodeAt, newEpisode, reopened: false, notify: false };
  }
  if (existing.status === "expected") {
    return { status: "expected", expectedScope: existing.expectedScope || "host", episodeAt, newEpisode, reopened: false, notify: false };
  }
  if (existing.status === "acknowledged" && newEpisode) {
    return { status: "open", expectedScope: null, episodeAt, newEpisode, reopened: true, notify: serious };
  }
  return { status: existing.status, expectedScope: null, episodeAt, newEpisode, reopened: false, notify: false };
}

/** 人在界面上点了一下：知道了 / 这是我的 / 重新打开。 */
export function decideFinding(decision: FindingDecision, scope: ExpectedScope = "host"): { status: FindingStatus; expectedScope: ExpectedScope | null } {
  if (decision === "acknowledge") return { status: "acknowledged", expectedScope: null };
  if (decision === "expected") return { status: "expected", expectedScope: scope };
  return { status: "open", expectedScope: null };
}

/** 一次完整巡检之后，哪些状态类发现已经不在了（只看还没标消失的）。 */
export function findingsToResolve(
  rows: Array<{ id: number; fingerprint: string; persistent: boolean; resolvedAt: number | null }>,
  active: string[],
): number[] {
  const set = new Set(active);
  return rows.filter((row) => row.persistent && !row.resolvedAt && !set.has(row.fingerprint)).map((row) => row.id);
}

/** 这条发现能做哪些处置。账号、钥匙、配置文件只能人去处理。 */
export function availableActions(kind: string, evidence: Record<string, unknown>, quarantined: boolean) {
  const actions: Array<"kill" | "quarantine" | "restore"> = [];
  const isProcess = kind === "miner_process" || kind === "suspicious_process" || kind === "high_cpu";
  if (isProcess && Number(evidence.pid) > 1 && String(evidence.exe || "")) actions.push("kill");
  // 隔离要先核对文件哈希：发现时没算出哈希（文件已删、太大、读不了）就不提供。
  if (quarantined) actions.push("restore");
  else if (isProcess && String(evidence.exe || "").startsWith("/") && String(evidence.sha256 || "")) actions.push("quarantine");
  return actions;
}

export function severityAtLeast(severity: FindingSeverity, min: FindingSeverity) {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[min];
}
