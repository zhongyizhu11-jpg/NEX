/*
  探测失败的种类：Agent 报上来的一个短词，面板翻成人话。

  以前 DNS 解析失败、连接被拒、网络不可达、超时、本机句柄用完，到了面板全叫「超时」——
  都是 isTimeout=true。可它们该做的事完全不同：被拒是对端端口没开，解析失败是域名的事，
  句柄用完是本机的事，只有真超时才是链路的事。Open-Box 0.1.370 也是为这个把测速的错误分开。

  Agent 2.2.236 起随 /api/agent/tcping 带 failure；更老的 Agent 没有，面板照旧说「超时」。
*/

export const PROBE_FAILURE_KINDS = ["dns", "refused", "unreachable", "timeout", "resource", "error"] as const;
export type ProbeFailureKind = (typeof PROBE_FAILURE_KINDS)[number];

export const PROBE_FAILURE_LABELS: Record<ProbeFailureKind, string> = {
  dns: "域名解析失败",
  refused: "连接被拒绝（对端端口没开，或被防火墙拒绝）",
  unreachable: "网络不可达（路由不通，或中途被丢包）",
  timeout: "连接超时",
  resource: "本机连接资源耗尽（文件句柄或临时端口用完）",
  error: "连接失败",
};

/** 短一点的说法，给卡片角标和表格用。 */
export const PROBE_FAILURE_SHORT_LABELS: Record<ProbeFailureKind, string> = {
  dns: "解析失败",
  refused: "被拒绝",
  unreachable: "不可达",
  timeout: "超时",
  resource: "本机资源耗尽",
  error: "失败",
};

export function normalizeProbeFailure(value: unknown): ProbeFailureKind | null {
  const text = String(value ?? "").trim().toLowerCase();
  return (PROBE_FAILURE_KINDS as readonly string[]).includes(text) ? (text as ProbeFailureKind) : null;
}

export function describeProbeFailure(value: unknown, fallback = "探测超时"): string {
  const kind = normalizeProbeFailure(value);
  return kind ? PROBE_FAILURE_LABELS[kind] : fallback;
}

export function describeProbeFailureShort(value: unknown, fallback = "超时"): string {
  const kind = normalizeProbeFailure(value);
  return kind ? PROBE_FAILURE_SHORT_LABELS[kind] : fallback;
}
