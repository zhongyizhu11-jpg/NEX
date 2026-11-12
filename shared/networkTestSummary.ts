import { sameNetworkAddress } from "./ipAddress";

/*
  网络测试结果的摘要：把 Agent 跑完 ping / traceroute / mtr 交回来的原始输出读成数字。

  Agent 跑的命令见 agent/looking_glass.go 的 lookingGlassCommand：
    ping -4|-6 -c 4 -W 3 <ip>
    traceroute -4|-6 -n -m 20 -w 2 <ip>
    mtr -4|-6 --report --report-cycles 10 --no-dns <ip>
  这几条命令一直没变过，所以老 Agent 交回来的输出一样能读，不用按 Agent 版本开关。

  只认得出的格式（iputils / BusyBox 的 ping，Linux traceroute，mtr 0.8x / 0.9x 的 report）；
  认不出就返回 null，页面照旧只显示原始输出 —— 宁可不出摘要，也不出一个算错的摘要。

  上游 ForwardX 2.3.286 的 shared/networkTestSummary.ts 是同一个意思，这里多做了几件：
    · ping 的抖动按相邻两次回包的差算（上游只把 mdev 当抖动，BusyBox 的 ping 不出 mdev）；
    · 命令中途被掐（超时、截断）没有统计行时，按已收到的回包给一个「不完整」的摘要；
    · mtr 无回应那一跳（???）丢包列不带 %，上游的正则会漏掉它；多路径的附加地址并到同一跳；
    · traceroute 每跳记下发了几个探测、几个没回，算出这一跳的无回应比例；
    · 给几句人话结论（中间跳丢包不等于业务丢包、从哪一跳开始一路丢、哪一跳延迟突然变高）。
*/

export type PingSummary = {
  kind: "ping";
  /** 发了几个；统计行没出来（命令被掐）时是 null。 */
  sent: number | null;
  received: number;
  /** 丢包率（%）；sent 未知时是 null。 */
  lossPercent: number | null;
  duplicates: number;
  errors: number;
  minMs: number | null;
  avgMs: number | null;
  maxMs: number | null;
  /** 抖动：相邻两次回包往返时间之差的平均值（ms），少于两个回包时是 null。 */
  jitterMs: number | null;
  /** iputils 统计行里的 mdev（往返时间的标准差）；BusyBox 没有。 */
  stddevMs: number | null;
  /** 每个回包的往返时间（ms），按收到的顺序；重复包（DUP!）不算。 */
  samples: number[];
  /** 统计行齐全；false = 命令中途结束，数字只按已经收到的回包算。 */
  complete: boolean;
};

export type RouteHop = {
  hop: number;
  /** 这一跳回应过的地址（多路径时不止一个）；整跳无回应时为空。 */
  addresses: string[];
  /** 这一跳一个回应都没有。 */
  timedOut: boolean;
  /** 发了几个探测（traceroute 是每跳的探测数，mtr 是 Snt）。 */
  sent: number | null;
  /** 没回应的比例（%）。traceroute 每跳只有三个探测，这个数只能看个大概。 */
  lossPercent: number | null;
  lastMs: number | null;
  avgMs: number | null;
  bestMs: number | null;
  worstMs: number | null;
  stddevMs: number | null;
  /** traceroute 的 !H !N !X 之类（主机 / 网络不可达、被管理员禁止）。 */
  annotations: string[];
};

export type RouteSummary = {
  kind: "route";
  tool: "traceroute" | "mtr";
  hops: RouteHop[];
  /** 最后一跳就是目标地址；不知道目标地址时是 null。 */
  reachedTarget: boolean | null;
};

export type NetworkTestSummary = PingSummary | RouteSummary;

const MAX_OUTPUT = 256_000;
const MAX_HOPS = 64;

function round(value: number, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function finite(value: string | undefined | null): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 相邻两次往返时间之差的平均值（RFC 3550 那种「抖动」的不平滑版本）。 */
export function averageJitter(samples: readonly number[]): number | null {
  if (samples.length < 2) return null;
  let total = 0;
  for (let index = 1; index < samples.length; index += 1) total += Math.abs(samples[index] - samples[index - 1]);
  return round(total / (samples.length - 1));
}

/* ───────────────────────── ping ───────────────────────── */

export function parsePingOutput(output: string): PingSummary | null {
  const text = String(output || "").slice(0, MAX_OUTPUT);
  const samples: number[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/\bDUP!/.test(line)) continue;
    // iputils：64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=1.23 ms；BusyBox：seq=0 … time=1.234 ms
    const match = /\bbytes from\b.*?\btime[=<]\s*([\d.]+)\s*ms/i.exec(line);
    if (match) {
      const value = finite(match[1]);
      if (value !== null) samples.push(value);
    }
  }

  // iputils：4 packets transmitted, 4 received, +1 duplicates, +2 errors, 0% packet loss, time 3004ms
  // BusyBox：4 packets transmitted, 4 packets received, 0% packet loss
  const stats = /(\d+) packets transmitted,\s*(\d+)(?: packets)? received(.*?)([\d.]+)% packet loss/.exec(text);
  const times = /(?:rtt|round-trip)\s+min\/avg\/max(?:\/(?:mdev|stddev))?\s*=\s*([\d.]+)\/([\d.]+)\/([\d.]+)(?:\/([\d.]+))?\s*ms/.exec(text);
  if (!stats && samples.length === 0) return null;

  const extra = stats?.[3] || "";
  const duplicates = Number(/\+(\d+) duplicates?/.exec(extra)?.[1] || 0);
  const errors = Number(/\+(\d+) errors?/.exec(extra)?.[1] || 0);
  const sent = stats ? Number(stats[1]) : null;
  const received = stats ? Number(stats[2]) : samples.length;
  const lossPercent = stats ? finite(stats[4]) : null;

  let minMs = times ? finite(times[1]) : null;
  let avgMs = times ? finite(times[2]) : null;
  let maxMs = times ? finite(times[3]) : null;
  if ((minMs === null || avgMs === null || maxMs === null) && samples.length > 0) {
    minMs = round(Math.min(...samples), 3);
    maxMs = round(Math.max(...samples), 3);
    avgMs = round(samples.reduce((sum, value) => sum + value, 0) / samples.length, 3);
  }
  return {
    kind: "ping",
    sent,
    received,
    lossPercent,
    duplicates,
    errors,
    minMs,
    avgMs,
    maxMs,
    jitterMs: averageJitter(samples),
    stddevMs: times ? finite(times[4]) : null,
    samples,
    complete: !!stats,
  };
}

/* ───────────────────────── traceroute ───────────────────────── */

const ADDRESS_TOKEN = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f]*:[0-9a-f:.]*[0-9a-f])$/i;

function hopStats(times: number[]) {
  if (times.length === 0) return { lastMs: null, avgMs: null, bestMs: null, worstMs: null };
  return {
    lastMs: times[times.length - 1],
    avgMs: round(times.reduce((sum, value) => sum + value, 0) / times.length),
    bestMs: Math.min(...times),
    worstMs: Math.max(...times),
  };
}

/**
 * Linux traceroute -n 的输出：
 *    1  10.0.0.1  0.345 ms  0.300 ms  0.290 ms
 *    2  * * *
 *    3  1.2.3.4  1.123 ms 1.2.3.5  1.300 ms  1.2 ms !H
 */
export function parseTracerouteOutput(output: string, target?: string | null): RouteSummary | null {
  const text = String(output || "").slice(0, MAX_OUTPUT);
  const hops: RouteHop[] = [];
  for (const line of text.split(/\r?\n/)) {
    const head = /^\s*(\d{1,2})\s+(.*)$/.exec(line);
    if (!head) continue;
    const hop = Number(head[1]);
    if (hop < 1 || hop > MAX_HOPS) continue;
    const tokens = head[2].replace(/(\d)ms\b/g, "$1 ms").split(/\s+/).filter(Boolean);
    const addresses: string[] = [];
    const times: number[] = [];
    const annotations: string[] = [];
    let stars = 0;
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token === "*") stars += 1;
      else if (/^!\S*$/.test(token)) annotations.push(token);
      else if (/^[\d.]+$/.test(token) && tokens[index + 1] === "ms") {
        const value = finite(token);
        if (value !== null) times.push(value);
        index += 1;
      } else if (ADDRESS_TOKEN.test(token.replace(/^\(|\)$/g, ""))) {
        const address = token.replace(/^\(|\)$/g, "");
        if (!addresses.includes(address)) addresses.push(address);
      }
    }
    // 这一行什么都没认出来（不是 traceroute 的跳行），不当一跳。
    if (addresses.length === 0 && times.length === 0 && stars === 0) continue;
    const sent = times.length + stars;
    hops.push({
      hop,
      addresses,
      timedOut: times.length === 0,
      sent: sent > 0 ? sent : null,
      lossPercent: sent > 0 ? round((stars / sent) * 100, 1) : null,
      ...hopStats(times),
      stddevMs: null,
      annotations: Array.from(new Set(annotations)),
    });
    if (hops.length >= MAX_HOPS) break;
  }
  if (hops.length === 0) return null;
  return { kind: "route", tool: "traceroute", hops, reachedTarget: reachedTarget(hops, target) };
}

/* ───────────────────────── mtr ───────────────────────── */

/**
 * mtr --report 的输出（0.9x 带「|--」，0.8x 没有）：
 *   HOST: vps                 Loss%   Snt   Last   Avg  Best  Wrst StDev
 *     1.|-- 10.0.0.1           0.0%    10    0.3   0.4   0.3   0.6   0.1
 *     2.|-- ???               100.0    10    0.0   0.0   0.0   0.0   0.0
 *     3.|-- 1.2.3.4            0.0%    10    1.0   1.1   1.0   1.3   0.1
 *         |  `|-- 1.2.3.5                                    ← 同一跳的另一条路
 */
export function parseMtrReport(output: string, target?: string | null): RouteSummary | null {
  const text = String(output || "").slice(0, MAX_OUTPUT);
  const hops: RouteHop[] = [];
  const row = /^\s*(\d{1,2})\.\s*(?:\|--\s+)?(\S+)\s+([\d.]+)%?\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/;
  const alternate = /^\s*\|\s*`\|--\s+(\S+)/;
  for (const line of text.split(/\r?\n/)) {
    const match = row.exec(line);
    if (match) {
      const hop = Number(match[1]);
      if (hop < 1 || hop > MAX_HOPS) continue;
      const address = match[2];
      const timedOut = address === "???";
      const latency = (value: string) => (timedOut ? null : finite(value));
      hops.push({
        hop,
        addresses: timedOut ? [] : [address],
        timedOut,
        sent: finite(match[4]),
        lossPercent: finite(match[3]),
        lastMs: latency(match[5]),
        avgMs: latency(match[6]),
        bestMs: latency(match[7]),
        worstMs: latency(match[8]),
        stddevMs: latency(match[9]),
        annotations: [],
      });
      if (hops.length >= MAX_HOPS) break;
      continue;
    }
    const extra = alternate.exec(line);
    const last = hops[hops.length - 1];
    if (extra && last && extra[1] !== "???" && !last.addresses.includes(extra[1])) last.addresses.push(extra[1]);
  }
  if (hops.length === 0) return null;
  return { kind: "route", tool: "mtr", hops, reachedTarget: reachedTarget(hops, target) };
}

function reachedTarget(hops: readonly RouteHop[], target?: string | null): boolean | null {
  const wanted = String(target || "").trim();
  if (!wanted) return null;
  const last = hops[hops.length - 1];
  return !!last && last.addresses.some((address) => sameNetworkAddress(address, wanted));
}

/* ───────────────────────── 入口 ───────────────────────── */

/**
 * 按测试方法读摘要。target 是面板解析好下发给 Agent 的那个地址（resolvedAddress），用来判断
 * 路由有没有走到目标。TCPing、iperf3 不出摘要（它们的输出本身就是结论）。
 */
export function summarizeNetworkTest(method: string, output: string, target?: string | null): NetworkTestSummary | null {
  if (method === "ping" || method === "ping6") return parsePingOutput(output);
  if (method === "traceroute" || method === "traceroute6") return parseTracerouteOutput(output, target);
  if (method === "mtr" || method === "mtr6") return parseMtrReport(output, target);
  return null;
}

/* ───────────────────────── 人话结论 ───────────────────────── */

export type SummaryNote = { level: "ok" | "info" | "warn"; text: string };

/** 一跳延迟比上一跳多出这么多，才单独说一句（跨境、跨运营商出口通常是几十上百毫秒）。 */
export const ROUTE_LATENCY_JUMP_MS = 50;

export function pingSummaryNotes(summary: PingSummary): SummaryNote[] {
  const notes: SummaryNote[] = [];
  if (!summary.complete) {
    notes.push({ level: "info", text: "命令没有正常结束（超时或被截断），以下数字只按已经收到的回包算" });
  }
  if (summary.sent !== null && summary.sent > 0 && summary.received === 0) {
    notes.push({ level: "warn", text: "一个回包都没收到：目标可能不回 ICMP（很多服务器和防火墙默认禁 Ping），不一定是不通；用 TCPing 测目标端口确认" });
  } else if (summary.lossPercent !== null && summary.lossPercent > 0) {
    notes.push({ level: "warn", text: `丢包 ${summary.lossPercent}%：只发了 ${summary.sent ?? summary.received} 个包，偶尔丢一个也会显示很高的比例；持续丢包再用 MTR 看是从哪一跳开始丢的` });
  } else if (summary.received > 0 && summary.complete) {
    notes.push({ level: "ok", text: "全部收到，没有丢包" });
  }
  if (summary.jitterMs !== null && summary.avgMs !== null && summary.jitterMs >= Math.max(20, summary.avgMs * 0.3)) {
    notes.push({ level: "warn", text: `抖动 ${summary.jitterMs} ms，相对平均延迟偏大：线路拥塞或高峰期常见，游戏、语音这类业务会明显感觉卡` });
  }
  if (summary.duplicates > 0) notes.push({ level: "info", text: `收到 ${summary.duplicates} 个重复包，多半是线路上有设备在复制报文` });
  return notes;
}

/**
 * 路由的几句结论。原则是不把「中间跳不回应」说成「丢包」：路由器对发给自己的探测限速、
 * 不回很常见，只要后面的跳和终点不丢，业务就不受影响。
 */
export function routeSummaryNotes(summary: RouteSummary): SummaryNote[] {
  const notes: SummaryNote[] = [];
  const hops = summary.hops;
  const last = hops[hops.length - 1];
  if (!last) return notes;

  if (summary.reachedTarget === true) {
    notes.push({ level: "ok", text: `${hops.length} 跳到达目标` });
  } else if (summary.reachedTarget === false) {
    let silentTail = 0;
    for (let index = hops.length - 1; index >= 0 && hops[index].timedOut; index -= 1) silentTail += 1;
    notes.push(silentTail > 0
      ? { level: "warn", text: `最后 ${silentTail} 跳都没有回应，没看到目标回应：目标或它前面的设备可能不回探测包，不一定是不通；用 TCPing 测目标端口确认` }
      : { level: "warn", text: "最后一跳不是目标地址：路由在中途停下了（或者达到了最大跳数），看最后一个有回应的跳在哪" });
  }

  if (summary.tool === "mtr") {
    const finalLoss = last.lossPercent ?? 0;
    if (!last.timedOut && finalLoss > 0) {
      // 从哪一跳开始一路丢到终点：那一跳以及之后每一跳都在丢。
      let start = hops.length - 1;
      while (start > 0 && !hops[start - 1].timedOut && (hops[start - 1].lossPercent ?? 0) > 0) start -= 1;
      const from = hops[start];
      notes.push({
        level: "warn",
        text: start < hops.length - 1
          ? `终点丢包 ${finalLoss}%，从第 ${from.hop} 跳（${from.addresses[0] || "?"}）开始一直丢到终点：问题多半出在这一跳附近`
          : `终点丢包 ${finalLoss}%：这是到目标的真实丢包`,
      });
    }
    const lossyMiddle = hops.slice(0, -1).filter((hop) => !hop.timedOut && (hop.lossPercent ?? 0) > 0);
    if (lossyMiddle.length > 0 && finalLoss === 0 && !last.timedOut) {
      notes.push({ level: "info", text: `中间有 ${lossyMiddle.length} 跳显示丢包，但终点不丢：多半是路由器对探测限速，不影响业务` });
    }
  } else if (hops.some((hop) => hop.timedOut)) {
    notes.push({ level: "info", text: "中间有跳显示 * 没有回应：路由器不回探测很常见，只要后面的跳有回应就不影响业务" });
  }

  let jump: { hop: RouteHop; delta: number } | null = null;
  let previous: RouteHop | null = null;
  for (const hop of hops) {
    if (hop.timedOut || hop.avgMs === null) continue;
    if (previous && previous.avgMs !== null) {
      const delta = hop.avgMs - previous.avgMs;
      if (delta >= ROUTE_LATENCY_JUMP_MS && (!jump || delta > jump.delta)) jump = { hop, delta };
    }
    previous = hop;
  }
  if (jump) {
    notes.push({ level: "info", text: `第 ${jump.hop.hop} 跳（${jump.hop.addresses[0] || "?"}）比上一个有回应的跳多了 ${Math.round(jump.delta)} ms：常见于跨境、跨运营商的出口` });
  }

  const unreachable = hops.find((hop) => hop.annotations.length > 0);
  if (unreachable) {
    notes.push({ level: "warn", text: `第 ${unreachable.hop} 跳回了 ${unreachable.annotations.join(" ")}（不可达 / 被禁止）：路由在这里被拒了` });
  }
  return notes;
}
