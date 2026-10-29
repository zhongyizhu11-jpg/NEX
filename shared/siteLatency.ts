/*
  概览「出口质量」：每台主机从自己出去，到几个固定站点的 TCP 握手耗时。

  Open-Box 的概览有百度 / Google / OpenAI / GitHub 四张延迟走势小卡，回答「从这里看出去，
  世界怎么样」。NEX 的主机就是出口，同样的问题换成：这台落地到国内回程、到 Google、到
  GitHub、到 OpenAI 现在多快，最近两小时有没有抖。

  Agent 扩展模块 "sitelatency"（Agent 2.2.237 起，agent/ext_sitelatency.go）：面板下发站点
  和间隔，Agent 每 2 分钟先解析、再单独计时 TCP 握手（DNS 不算进去），自己留最近 60 个
  样本（两小时）。面板只放内存，每轮告诉 Agent「我已经有到哪个时刻」，Agent 只补更新的；
  面板重启后第一轮 since=0，Agent 把手里的两小时整段交过来，走势线马上就有。

  2.2.240 起每轮握 3 次取中位数（n / k 记握了几次、连上几次，丢失率按次数算），并在第一次
  连上后做 TLS 握手、看证书是不是这个域名的：DNS 被污染时 TCP 照样几毫秒就通（上海测出
  Google 9 ms 就是这样），证书对不上记 poisoned；TLS 被重置 / 没回应记 blocked。
  更老的 Agent 没这一步，界面上提示「没校验证书」。

  只握手不发请求：不碰对方的应用层，也不会因为对方返回 403 / 跳转算成「不通」。
*/

export const SITE_LATENCY_AGENT_VERSION = "2.2.237";
/** 这一版起校验证书、一轮握多次。 */
export const SITE_LATENCY_VERIFIED_AGENT_VERSION = "2.2.240";
export const SITE_LATENCY_INTERVAL_SECONDS = 120;
export const SITE_LATENCY_KEEP = 60;

export type SiteLatencyTarget = { key: string; label: string; host: string; port: number };

export const SITE_LATENCY_TARGETS: readonly SiteLatencyTarget[] = [
  { key: "baidu", label: "百度", host: "www.baidu.com", port: 443 },
  { key: "google", label: "Google", host: "www.google.com", port: 443 },
  { key: "github", label: "GitHub", host: "github.com", port: 443 },
  { key: "openai", label: "OpenAI", host: "api.openai.com", port: 443 },
];

export type SiteLatencySample = {
  /** Unix 毫秒 */
  at: number;
  /** 握手耗时（毫秒）；null = 没连上 */
  ms: number | null;
  /** 没连上的原因（shared/probeFailure 的种类，外加 poisoned / blocked，见 SITE_FAILURE_LABELS） */
  fail?: string;
  /** 这一轮握了几次、连上几次（Agent 2.2.240 起）；没有就按一次算。 */
  tries?: number;
  ok?: number;
};

/** 出口探测特有的两种失败；其余沿用 shared/probeFailure。 */
export const SITE_FAILURE_LABELS: Record<string, { long: string; short: string }> = {
  poisoned: { long: "连到的不是这个站点：证书对不上（DNS 被污染，或被劫持）", short: "解析被污染" },
  blocked: { long: "TCP 通了，TLS 握手被重置或没回应（按域名阻断的典型样子）", short: "被阻断" },
};

/** 按时刻合并、去重、只留最近 keep 个；时刻晚于 nowMs + 5 分钟的（Agent 时钟乱了）不要。 */
export function mergeSiteSamples(existing: readonly SiteLatencySample[], incoming: readonly SiteLatencySample[], nowMs = Date.now(), keep = SITE_LATENCY_KEEP): SiteLatencySample[] {
  const byAt = new Map<number, SiteLatencySample>();
  for (const sample of existing) byAt.set(sample.at, sample);
  for (const sample of incoming) {
    if (!(sample.at > 0) || sample.at > nowMs + 5 * 60_000) continue;
    byAt.set(sample.at, sample);
  }
  return Array.from(byAt.values()).sort((left, right) => left.at - right.at).slice(-keep);
}

export type SiteLatencySummary = {
  /** 最近一次；null = 最近一次没连上或没有样本 */
  latestMs: number | null;
  latestFail: string | null;
  latestAt: number | null;
  /** 窗口里连上了的中位数 */
  medianMs: number | null;
  /** 窗口里没连上的比例 0–100：按握手次数算（老 Agent 一轮一次） */
  lossPct: number;
  samples: number;
  /** 最近一次那一轮握了几次、连上几次 */
  latestTries: number;
  latestOk: number;
  tone: "ok" | "warn" | "down" | "off";
};

/** 延迟分档：≤150ms 正常；≤350ms 偏慢；更慢或丢得多算差。 */
export const SITE_LATENCY_WARN_MS = 150;
export const SITE_LATENCY_BAD_MS = 350;

/** 一轮握了几次、连上几次：老样本没有这两个数，连上算 1/1，没连上算 0/1。 */
export function siteSampleCounts(sample: SiteLatencySample): { tries: number; ok: number } {
  const tries = Number.isInteger(sample.tries) && Number(sample.tries) > 0 ? Number(sample.tries) : 1;
  if (sample.ms === null) return { tries, ok: 0 };
  const ok = Number.isInteger(sample.ok) && Number(sample.ok) > 0 ? Math.min(tries, Number(sample.ok)) : tries;
  return { tries, ok };
}

export function summarizeSiteSamples(samples: readonly SiteLatencySample[]): SiteLatencySummary {
  if (samples.length === 0) return { latestMs: null, latestFail: null, latestAt: null, medianMs: null, lossPct: 0, samples: 0, latestTries: 0, latestOk: 0, tone: "off" };
  const latest = samples[samples.length - 1];
  const ok = samples.filter((sample) => sample.ms !== null).map((sample) => Number(sample.ms)).sort((left, right) => left - right);
  const middle = Math.floor(ok.length / 2);
  const medianMs = ok.length === 0 ? null : ok.length % 2 === 0 ? Math.round((ok[middle - 1] + ok[middle]) / 2) : ok[middle];
  let tries = 0;
  let connected = 0;
  for (const sample of samples) {
    const counts = siteSampleCounts(sample);
    tries += counts.tries;
    connected += counts.ok;
  }
  const lossPct = Math.round(((tries - connected) * 1000) / tries) / 10;
  const latestCounts = siteSampleCounts(latest);
  let tone: SiteLatencySummary["tone"];
  if (latest.ms === null || lossPct >= 50) tone = "down";
  else if (latest.ms > SITE_LATENCY_BAD_MS || lossPct >= 10) tone = "down";
  else if (latest.ms > SITE_LATENCY_WARN_MS || lossPct > 0) tone = "warn";
  else tone = "ok";
  return {
    latestMs: latest.ms,
    latestFail: latest.ms === null ? latest.fail || "timeout" : null,
    latestAt: latest.at,
    medianMs,
    lossPct,
    samples: samples.length,
    latestTries: latestCounts.tries,
    latestOk: latestCounts.ok,
    tone,
  };
}

/** 收 Agent 报的一份：key 只认 SITE_LATENCY_TARGETS 里的，每个 key 最多 keep 个，耗时取整、负数当没连上。 */
export function normalizeSiteLatencyReport(raw: unknown, keep = SITE_LATENCY_KEEP): Map<string, SiteLatencySample[]> {
  const out = new Map<string, SiteLatencySample[]>();
  const keys = new Set(SITE_LATENCY_TARGETS.map((target) => target.key));
  const targets = Array.isArray((raw as any)?.targets) ? (raw as any).targets.slice(0, 16) : [];
  for (const entry of targets) {
    const key = String(entry?.key || "");
    if (!keys.has(key)) continue;
    const samples: SiteLatencySample[] = [];
    for (const item of Array.isArray(entry?.samples) ? entry.samples.slice(-keep) : []) {
      const at = Math.floor(Number(item?.t));
      if (!Number.isFinite(at) || at <= 0) continue;
      const msRaw = Number(item?.ms);
      const ms = Number.isFinite(msRaw) && msRaw >= 0 ? Math.round(msRaw) : null;
      const fail = ms === null ? String(item?.f || "timeout").slice(0, 24) : undefined;
      const sample: SiteLatencySample = fail ? { at, ms, fail } : { at, ms };
      const tries = Math.floor(Number(item?.n));
      if (Number.isFinite(tries) && tries >= 1 && tries <= 10) {
        sample.tries = tries;
        const okRaw = Math.floor(Number(item?.k ?? 0));
        sample.ok = ms === null ? 0 : Math.max(1, Math.min(tries, Number.isFinite(okRaw) ? okRaw : tries));
      }
      samples.push(sample);
    }
    if (samples.length > 0) out.set(key, samples);
  }
  return out;
}

/**
 * 这台主机是不是根本出不去：每个站点最近一次都没连上，而且整个窗口里一次都没连上过。
 * 国内专线 / 中转入口常这样，四格全红没有信息量，界面收成一句话。
 */
export function siteLatencyNoEgress(summaries: readonly SiteLatencySummary[]): boolean {
  const measured = summaries.filter((summary) => summary.samples > 0);
  return measured.length > 0 && measured.every((summary) => summary.medianMs === null && summary.latestMs === null);
}
