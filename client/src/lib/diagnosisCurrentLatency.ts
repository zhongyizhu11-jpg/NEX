import type { LinkTestDetail, ParsedLinkTestMessage } from "@/components/LinkTestLatencySummary";

/*
  诊断弹窗「延迟测试」那一页和规则卡显示同一个数（2.3.544，用户：「弹窗测出来的延迟怎么和卡片上的不一样」）。

  规则卡上的延迟是面板最近一次测的两段之和（入口 → 在用出口、在用出口 → 目标，server/ruleLatencyView.ts）；
  诊断测的也是这两段，测完记进同一份。可诊断弹窗以前只画「上次诊断」那一刻的快照，一分钟后定时探测把卡片
  更新了，弹窗还停在旧数：155 对 159、8 对 12。

  现在弹窗拿卡片那一行（trafficSummary 里这条规则的 latestLatency*）：比上次诊断新、而且测通了，就把两段和合计
  换成卡片上的（在用出口换了的话节点也跟着换），状态行写明「延迟为几点的定时探测」；上次诊断本身更新就照旧画诊断。
*/

export type RuleCurrentLatency = {
  latestLatencyMs?: number | null;
  latestLatencyIsTimeout?: boolean | null;
  latestLatencyAt?: Date | string | number | null;
  latestLatencySource?: string | null;
  latestLatencyChain?: {
    exitHostId?: number | null;
    exitName?: string | null;
    exitMs?: number | null;
    targetMs?: number | null;
  } | null;
};

export type RuleCurrentLatencyView = {
  parsed: ParsedLinkTestMessage;
  /** 合计（卡片上那个数） */
  latencyMs: number;
  /** 这个数是什么时候测的（毫秒时间戳） */
  at: number;
  /** 怎么测的：panel 面板两段相加、probe 定时探测、exit-target 在用出口探目标（只有后半段） */
  source: "panel" | "probe" | "exit-target";
};

function epochMs(value: unknown) {
  if (value === null || value === undefined || value === "") return 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value > 0 && value < 1_000_000_000_000 ? value * 1000 : value;
  const ms = new Date(String(value)).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function finite(value: unknown) {
  const number = Number(value);
  return value !== null && value !== undefined && Number.isFinite(number) ? number : null;
}

/** 「Po0(200M) -> hep ix」：把箭头后面那一段换成在用出口的名字 */
function swapRouteTail(label: string | null | undefined, name: string) {
  const text = String(label || "");
  const index = text.lastIndexOf("->");
  if (index < 0 || !name) return text || null;
  return `${text.slice(0, index + 2)} ${name}`;
}

function swapRouteHead(label: string | null | undefined, name: string) {
  const text = String(label || "");
  const index = text.indexOf("->");
  if (index < 0 || !name) return text || null;
  return `${name} ${text.slice(index)}`;
}

/**
 * 卡片上的延迟比上次诊断新：把诊断画的两段、合计换成卡片上的。没有可换的（没有数、超时、不比诊断新、诊断没通）返回 null。
 * diagnosisAt：上次诊断的时间（forward_tests.updatedAt）。
 */
export function applyRuleCurrentLatency(input: {
  parsed: ParsedLinkTestMessage;
  diagnosisAt: unknown;
  diagnosisSuccess: boolean;
  current: RuleCurrentLatency | null | undefined;
  /** 直连规则的消息是一句话（「目标 … 延迟 7ms」），画的是 fallbackLatencyMs */
  fallbackLatencyMs?: number | null;
}): RuleCurrentLatencyView | null {
  const current = input.current;
  if (!current || !input.diagnosisSuccess) return null;
  const ms = finite(current.latestLatencyMs);
  if (ms === null || ms < 0 || current.latestLatencyIsTimeout === true) return null;
  const at = epochMs(current.latestLatencyAt);
  const diagnosisAt = epochMs(input.diagnosisAt);
  // 数据库里的诊断时间只到秒：同一秒的算诊断自己（两边本来就是同一个数）
  if (!(at > 0) || at < diagnosisAt + 1000) return null;
  const source = String(current.latestLatencySource || "");
  if (source !== "panel" && source !== "probe" && source !== "exit-target") return null;
  const total = Math.round(ms);
  const details = (input.parsed.details || []).map((detail) => ({ ...detail }));
  const hops = details.filter((detail) => detail.hopIndex !== null && detail.hopIndex !== undefined);
  const targets = details.filter((detail) => detail.hopIndex === null || detail.hopIndex === undefined);
  const chain = current.latestLatencyChain;
  const exitMs = finite(chain?.exitMs);
  const targetMs = finite(chain?.targetMs);
  let message = input.parsed.message;
  let tunnelLatencyMs = input.parsed.tunnelLatencyMs ?? null;
  if (source === "panel" && exitMs !== null && targetMs !== null && hops.length === 1 && targets.length === 1) {
    // 两段各写各的，合计正好是卡片上的数（后半段按差算，免得四舍五入后两段加起来差 1）
    const exit = Math.max(0, Math.round(exitMs));
    const target = Math.max(0, total - exit);
    const hop = hops[0];
    const target0 = targets[0];
    hop.success = true;
    hop.latencyMs = exit;
    hop.pending = false;
    target0.success = true;
    target0.latencyMs = target;
    target0.pending = false;
    tunnelLatencyMs = exit;
    const exitHostId = Number(chain?.exitHostId || 0);
    const exitName = String(chain?.exitName || "").trim();
    if (exitHostId > 0 && Number(hop.toHostId || 0) > 0 && Number(hop.toHostId) !== exitHostId) {
      // 在用的出口换了：诊断画的还是旧出口，节点跟着卡片换
      hop.toHostId = exitHostId;
      hop.routeLabel = swapRouteTail(hop.routeLabel, exitName || `主机 ${exitHostId}`);
      hop.hopLabel = `1/1 ${Number(hop.fromHostId || 0) || "入口"}->${exitHostId}`;
      if (Number(target0.fromHostId || 0) > 0) target0.fromHostId = exitHostId;
      if (exitName && String(target0.routeLabel || "").includes("->") && !String(target0.routeLabel || "").startsWith("出口")) {
        target0.routeLabel = swapRouteHead(target0.routeLabel, exitName);
      }
    }
  } else if (details.length === 1) {
    const only = details[0] as LinkTestDetail;
    only.success = true;
    only.latencyMs = total;
    only.pending = false;
  } else if (details.length === 0 && typeof message === "string") {
    message = message.replace(/延迟\s*\d+(?:\.\d+)?\s*ms/, `延迟 ${total}ms`);
  }
  return {
    parsed: {
      ...input.parsed,
      message,
      details,
      totalLatencyMs: total,
      tunnelLatencyMs,
      tunnelProbeTimedOut: false,
    },
    latencyMs: total,
    at,
    source,
  };
}

/** 状态行那一句：延迟是几点测的、怎么测的。formatTime 交给调用方（和「上次诊断」同一个格式）。 */
export function describeRuleCurrentLatency(view: RuleCurrentLatencyView, formatTime: (at: number) => string) {
  const when = formatTime(view.at);
  if (view.source === "exit-target") return `延迟为 ${when} 在用出口探目标的结果，和规则卡一致`;
  return `延迟为 ${when} 的定时探测，和规则卡一致`;
}

/**
 * 上次诊断是旧路线测的（服务端 latestTest 的 routeOutdated，见 shared/diagnosisRoute.ts）：状态行写明原因。
 * routeChangedAt：链路最近一次换拓扑的时间（规则自己换了隧道 / 目标时没有）。
 */
export function describeOutdatedDiagnosisRoute(input: { routeChangedAt: unknown; diagnosedAt: unknown }, formatTime: (at: number) => string) {
  const changed = epochMs(input.routeChangedAt);
  const diagnosed = epochMs(input.diagnosedAt);
  const when = diagnosed > 0 ? `上次诊断（${formatTime(diagnosed)}）` : "上次诊断";
  if (changed > 0) return `链路 ${formatTime(changed)} 换过出口 / 入口，${when}测的是旧路线，正在按现在的路线重测`;
  return `规则的隧道或目标改过，${when}测的是旧路线，正在按现在的路线重测`;
}
