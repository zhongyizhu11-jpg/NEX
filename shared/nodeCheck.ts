/*
  按需的「网速测试」和「经节点的出口检测」（Agent 2.2.241 起，扩展模块 "nodecheck"）。

  两种检查：
    · speed：从一台主机对 Cloudflare 测速，得到延迟 / 抖动 / 下载 / 上传 / 机房 / 出口 IP，跑的时候
      带一条下载 / 上传随时间的曲线。连不上 Cloudflare（国内机器到国外 80 / 443 常常不通）就改测到
      面板自己（server/ops/nodeCheckSpeedRoute.ts），结果标 server = "panel"。
    · exit：站点握手 + 流媒体 / AI 解锁，一次性跑一轮。给粘贴进来、机器不是自己的那些节点用：
      自己的机器有定时的出口探测（sitelatency）和解锁检测（unlock），不走这个。
  都可以「经节点」：让那台主机临时拉一个 sing-box，把要看的节点当出站，检查走它过去。
  面板只认自己排过的 runId；Agent 那头的形状见 agent/ext_nodecheck.go。
*/
import { normalizeUnlockResults, type UnlockServiceResult } from "./unlockCheck";

export const NODE_CHECK_MIN_AGENT_VERSION = "2.2.241";

export const NODE_CHECK_KINDS = ["speed", "exit"] as const;
export type NodeCheckKind = (typeof NODE_CHECK_KINDS)[number];

export type SpeedSample = { t: number; down: number; up: number };

export type SpeedTestResult = {
  latencyMs: number;
  jitterMs: number;
  downloadMbps: number;
  uploadMbps: number;
  colo: string;
  clientIp: string;
  asn: string;
  asOrg: string;
  country: string;
  city: string;
  /** 对谁测的：Cloudflare，或连不上 Cloudflare 时改测到面板自己（note 说明原因）。 */
  server: "cloudflare" | "panel";
  note: string;
  samples: SpeedSample[];
};

export type ExitCheckSite = { key: string; ms: number | null; fail: string | null; tries: number; ok: number };

export type ExitCheckResult = {
  sites: ExitCheckSite[];
  unlock: UnlockServiceResult[];
};

/** Agent 报上来的一次检查：running 时 phase 和 speed.samples 会一轮轮长，done / error 后不再变。 */
export type NodeCheckRunReport = {
  runId: string;
  kind: NodeCheckKind;
  status: "running" | "done" | "error";
  phase: string;
  startedAt: number;
  finishedAt: number;
  error: string;
  speed: SpeedTestResult | null;
  exit: ExitCheckResult | null;
};

export const NODE_CHECK_PHASE_LABELS: Record<string, string> = {
  queued: "排队中",
  singbox: "正在连节点",
  latency: "测延迟",
  download: "测下载",
  upload: "测上传",
  probe: "检测中",
};

const num = (value: unknown, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const text = (value: unknown, max = 128) => String(value ?? "").trim().slice(0, max);

export function normalizeSpeedSamples(raw: unknown): SpeedSample[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 400).map((item) => {
    const entry = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    return { t: Math.max(0, Math.round(num(entry.t))), down: Math.max(0, num(entry.down)), up: Math.max(0, num(entry.up)) };
  });
}

export function normalizeSpeedTestResult(raw: unknown): SpeedTestResult | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  return {
    latencyMs: Math.max(0, num(entry.latencyMs)),
    jitterMs: Math.max(0, num(entry.jitterMs)),
    downloadMbps: Math.max(0, num(entry.downloadMbps)),
    uploadMbps: Math.max(0, num(entry.uploadMbps)),
    colo: text(entry.colo, 16).toUpperCase(),
    clientIp: text(entry.clientIp, 64),
    asn: text(entry.asn, 24),
    asOrg: text(entry.asOrg),
    country: text(entry.country, 8).toUpperCase(),
    city: text(entry.city),
    server: entry.server === "panel" ? "panel" : "cloudflare",
    note: text(entry.note, 400),
    samples: normalizeSpeedSamples(entry.samples),
  };
}

export function normalizeExitCheckResult(raw: unknown): ExitCheckResult | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  const sites: ExitCheckSite[] = [];
  if (Array.isArray(entry.sites)) {
    for (const item of entry.sites.slice(0, 16)) {
      if (!item || typeof item !== "object") continue;
      const site = item as Record<string, unknown>;
      const key = text(site.key, 32);
      if (!key) continue;
      const sample = Array.isArray(site.samples) && site.samples[0] && typeof site.samples[0] === "object" ? site.samples[0] as Record<string, unknown> : null;
      const ms = sample ? num(sample.ms, -1) : -1;
      sites.push({
        key,
        ms: ms >= 0 ? Math.round(ms) : null,
        fail: ms >= 0 ? null : (sample ? text(sample.f, 24) || "error" : "error"),
        tries: sample ? Math.max(0, Math.round(num(sample.n))) : 0,
        ok: sample ? Math.max(0, Math.round(num(sample.k))) : 0,
      });
    }
  }
  return { sites, unlock: normalizeUnlockResults(entry.unlock) || [] };
}

export function normalizeNodeCheckRunReport(raw: unknown): NodeCheckRunReport | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  const runId = text(entry.runId, 64);
  const kind = text(entry.kind, 8) as NodeCheckKind;
  const status = text(entry.status, 8);
  if (!runId || !NODE_CHECK_KINDS.includes(kind) || !["running", "done", "error"].includes(status)) return null;
  return {
    runId,
    kind,
    status: status as NodeCheckRunReport["status"],
    phase: text(entry.phase, 16),
    startedAt: Math.max(0, Math.round(num(entry.startedAt))),
    finishedAt: Math.max(0, Math.round(num(entry.finishedAt))),
    error: text(entry.error, 400),
    speed: kind === "speed" ? normalizeSpeedTestResult(entry.speed) : null,
    exit: kind === "exit" ? normalizeExitCheckResult(entry.exit) : null,
  };
}

/** 「192.7 Mbps」「980 kbps」：曲线和大数字共用。 */
export function formatMbps(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 Mbps";
  if (value >= 1000) return `${(value / 1000).toFixed(2)} Gbps`;
  if (value >= 1) return `${value.toFixed(1)} Mbps`;
  return `${Math.round(value * 1000)} kbps`;
}
