/*
  线路诊断（线路组的分段测速、导出）前后端共用的纯函数：

  - parseIperf3Mbps：从 iperf3 的文字输出里读汇总带宽（Agent 回报的只有原始文本）。
  - planLineSegments：一条路径按「入口 → 第一跳 → 第二跳 … → 落地」拆成一段一段；
    落地不是面板管的机器，那一段只能标成跳过。
  - slowestSegmentIndex：测完以后哪一段最慢（瓶颈）。
  - lineEventsToCsv / lineExportToCsv：导出给技术支持或表格软件看。

  不碰数据库、不碰网络，测试直接喂字符串。
*/

// ---------------- iperf3 输出 ----------------

export type Iperf3Mbps = { sendMbps: number | null; recvMbps: number | null };

const UNIT_TO_MBPS: Record<string, number> = {
  "": 1 / 1_000_000,
  K: 1 / 1_000,
  M: 1,
  G: 1_000,
  T: 1_000_000,
};

/** 「923 Mbits/sec」「1.05 Gbits/sec」「850 Kbits/sec」→ Mbit/s。 */
function rateToMbps(value: string, prefix: string): number | null {
  const number = Number(value);
  const factor = UNIT_TO_MBPS[prefix.toUpperCase()];
  if (!Number.isFinite(number) || factor === undefined) return null;
  return number * factor;
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

/*
  汇总行长这样（iperf3 3.x；老版本列名叫 Bandwidth，新版本叫 Bitrate，行本身一样）：

    [SUM]   0.00-8.00   sec   880 MBytes   923 Mbits/sec  480             sender
    [SUM]   0.00-8.04   sec   872 MBytes   910 Mbits/sec                  receiver
    [  5]   0.00-8.00   sec   220 MBytes   231 Mbits/sec  120             sender

  -P 1 时没有 [SUM] 行，只有单条流的 sender / receiver。-R（反向）时两行的含义不变：
  sender 永远是发数据的那一端（反向时是对端），receiver 是收数据的那一端。
  每秒一行的区间行末尾没有 sender / receiver，不算。
*/
const SUMMARY_LINE = /^\s*\[\s*(SUM|\d+)\s*\]\s+[\d.]+\s*-\s*[\d.]+\s+sec\s+([\d.]+)\s+([KMGT]?)Bytes\s+([\d.]+)\s+([KMGT]?)bits\/sec\b\s*(\d+)?.*\b(sender|receiver)\s*$/i;

/** 一次 iperf3 的汇总，多读几样：重传（发送端那行的 Retr 列）、发了多少字节、接收端每条流各多快。 */
export type Iperf3Detail = Iperf3Mbps & {
  /** 重传次数（TCP，发送端汇总行）；没有这一列（UDP、老版本）是 null。 */
  retransmits: number | null;
  /** 发送端汇总的字节数（算每 GB 重传几次用）。 */
  sentBytes: number | null;
  /** 接收端每条流的速率（多流时才有意义）。 */
  streamMbps: number[];
};

const BYTE_FACTOR: Record<string, number> = { "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

export function parseIperf3Detail(output: string): Iperf3Detail {
  const sum = { sendMbps: null as number | null, recvMbps: null as number | null, retr: null as number | null, bytes: null as number | null };
  const streams = { send: [] as number[], recv: [] as number[], retr: [] as number[], bytes: [] as number[] };
  for (const line of String(output || "").split(/\r?\n/)) {
    const match = SUMMARY_LINE.exec(line);
    if (!match) continue;
    const mbps = rateToMbps(match[4], match[5]);
    if (mbps === null) continue;
    const bytes = Number(match[2]) * (BYTE_FACTOR[match[3].toUpperCase()] ?? 1);
    const retr = match[6] === undefined ? null : Number(match[6]);
    const side = match[7].toLowerCase() === "sender" ? "send" : "recv";
    if (match[1].toUpperCase() === "SUM") {
      // 同一份输出里出现多次（重复粘贴、或者 Agent 把两次测试拼在一起）以最后一次为准。
      if (side === "send") {
        sum.sendMbps = mbps;
        sum.retr = retr;
        sum.bytes = bytes;
      } else {
        sum.recvMbps = mbps;
      }
    } else if (side === "send") {
      streams.send.push(mbps);
      if (retr !== null) streams.retr.push(retr);
      streams.bytes.push(bytes);
    } else {
      streams.recv.push(mbps);
    }
  }
  const total = (values: number[]) => (values.length > 0 ? values.reduce((a, b) => a + b, 0) : null);
  const sendMbps = sum.sendMbps ?? total(streams.send);
  const recvMbps = sum.recvMbps ?? total(streams.recv);
  return {
    sendMbps: sendMbps === null ? null : round2(sendMbps),
    recvMbps: recvMbps === null ? null : round2(recvMbps),
    retransmits: sum.retr ?? total(streams.retr),
    sentBytes: sum.bytes ?? total(streams.bytes),
    streamMbps: streams.recv.length > 1 ? streams.recv.map(round2) : [],
  };
}

export function parseIperf3Mbps(output: string): Iperf3Mbps {
  const { sendMbps, recvMbps } = parseIperf3Detail(output);
  return { sendMbps, recvMbps };
}

/** 一次测试最能代表「这段线路有多快」的数：接收端看到的优先（发送端会把缓冲区里没发出去的也算上）。 */
export function iperf3EffectiveMbps(result: Iperf3Mbps): number | null {
  return result.recvMbps ?? result.sendMbps;
}

/** 每 GiB 发出去的数据重传多少次；算不出来是 null。 */
export function iperf3RetransmitsPerGB(retransmits: number | null, sentBytes: number | null): number | null {
  if (retransmits === null || !sentBytes || sentBytes <= 0) return null;
  return Math.round(retransmits / (sentBytes / 1024 ** 3));
}

/**
 * 对拉一段测完后的一句话判断（iperf3 对拉、线路组分段测速共用）：
 *  · 单条连接和多条合计比：单条就跑满 → 线路干净；单条远低于合计 → 有丢包 / 单流受限，单个下载会慢；
 *    多条合计反而比单条低 → 中间有硬限速（令牌桶，腾讯云联网 / 公网带宽上限都是），几条流互相挤掉。
 *  · 重传：按每 GB 几次分三档。
 */
export function iperf3SegmentVerdict(input: { mbps: number | null; singleMbps: number | null; streams: number; retransmits: number | null; sentBytes: number | null }): string | null {
  const parts: string[] = [];
  const { mbps, singleMbps } = input;
  if (mbps !== null && singleMbps !== null && input.streams > 1 && mbps > 0) {
    if (singleMbps >= mbps * 1.1) parts.push(`${input.streams} 条连接合计反而比单条低：中间有硬限速，几条连接互相挤掉（隧道可以开链路整形）`);
    else if (singleMbps >= mbps * 0.8) parts.push("单条连接就能跑满");
    else parts.push(`单条连接只有 ${Math.round(singleMbps)} Mbps，${input.streams} 条一起才到 ${Math.round(mbps)}：单个下载会慢一些`);
  }
  const perGB = iperf3RetransmitsPerGB(input.retransmits, input.sentBytes);
  if (perGB !== null) {
    if (perGB >= 1000) parts.push(`重传很多（每 GB 约 ${perGB.toLocaleString("en-US")} 次），这段丢包明显`);
    else if (perGB >= 100) parts.push(`有一些重传（每 GB 约 ${perGB} 次）`);
    else parts.push("几乎不丢包");
  }
  return parts.length > 0 ? parts.join("；") : null;
}

/**
 * iperf3 没出结果时，把原因说成人话。Agent 没装 iperf3、连不上对端、对端忙，是最常见的三种。
 * 认不出来的返回输出里第一行像错误的那句（最多 200 字）。
 */
export function describeIperf3Failure(output: string): string {
  const text = String(output || "");
  if (/缺少\s*iperf3|未安装\s*iperf3|iperf3[^\n]*(not found|No such file)|executable file not found/i.test(text)) {
    return "Agent 主机没装 iperf3，测不了速。请在这台机器上安装 iperf3（Debian/Ubuntu: apt install iperf3；RHEL/CentOS: yum install iperf3；Alpine: apk add iperf3）后重试";
  }
  if (/server is busy/i.test(text)) return "对端 iperf3 服务端正忙（有别的测试在跑），稍后再试";
  if (/unable to connect to server|Connection refused|No route to host|Connection timed out/i.test(text)) {
    return "连不上对端的 iperf3 服务端：检查防火墙 / 安全组是否放行了测速端口";
  }
  const errorLine = text.split(/\r?\n/).map((line) => line.trim()).find((line) => /iperf3:\s*error|error\b|失败|超时/i.test(line));
  return (errorLine || "iperf3 没有输出测速结果").slice(0, 200);
}

// ---------------- 分段 ----------------

export const LANDING_NOT_OWNED_REASON = "落地不是自己的机器，测不了";

export type LineSegmentNode = { hostId: number | null; name: string };
export type PlannedLineSegment = { from: LineSegmentNode; to: LineSegmentNode; skipReason: string | null };

/**
 * 入口 → 中转 1 → 中转 2 … → 落地，按相邻两点拆段。前面几段两头都是面板里的机器（都有 Agent），
 * 可以一头开 iperf3 服务端、另一头当客户端测；最后一段到落地，落地不归面板管，只能跳过。
 */
export function planLineSegments(input: {
  entry: LineSegmentNode;
  hops: readonly LineSegmentNode[];
  landing: { name: string };
}): PlannedLineSegment[] {
  const nodes = [input.entry, ...input.hops];
  const segments: PlannedLineSegment[] = [];
  for (let index = 0; index + 1 < nodes.length; index += 1) {
    const from = nodes[index];
    const to = nodes[index + 1];
    const sameHost = from.hostId !== null && from.hostId === to.hostId;
    segments.push({ from, to, skipReason: sameHost ? "前后是同一台机器，不用测" : null });
  }
  segments.push({
    from: nodes[nodes.length - 1],
    to: { hostId: null, name: input.landing.name || "落地" },
    skipReason: LANDING_NOT_OWNED_REASON,
  });
  return segments;
}

/** 测完的段里带宽最低的那一段的下标；一段都没测出来返回 null。 */
/**
 * iperf3 对拉要测的段（网络测试页）：
 *  · 选两台机器：就一段 A → B；
 *  · 选一条隧道：按它经过的机器拆 —— 链式中转是相邻两台一段；主备 / 叠加的几台中转是并排的，
 *    入口到每台中转、每台中转到出口各一段。
 * hostIds 是隧道跳点（入口、中转…、出口）；同一台机器前后相连的段不测。
 */
export function planPairSegments(input: {
  hops: readonly LineSegmentNode[];
  parallelRelays: boolean;
}): PlannedLineSegment[] {
  const hops = input.hops;
  const pairs: Array<[LineSegmentNode, LineSegmentNode]> = [];
  if (input.parallelRelays && hops.length >= 3) {
    const entry = hops[0];
    const exit = hops[hops.length - 1];
    for (const relay of hops.slice(1, -1)) pairs.push([entry, relay]);
    for (const relay of hops.slice(1, -1)) pairs.push([relay, exit]);
  } else {
    for (let index = 0; index + 1 < hops.length; index += 1) pairs.push([hops[index], hops[index + 1]]);
  }
  return pairs.map(([from, to]) => ({
    from,
    to,
    skipReason: from.hostId !== null && from.hostId === to.hostId ? "前后是同一台机器，不用测" : null,
  }));
}

export function slowestSegmentIndex(segments: ReadonlyArray<{ status: string; mbps: number | null }>): number | null {
  let slowest: number | null = null;
  segments.forEach((segment, index) => {
    if (segment.status !== "done" || segment.mbps === null || !Number.isFinite(segment.mbps)) return;
    if (slowest === null || segment.mbps < (segments[slowest].mbps as number)) slowest = index;
  });
  return slowest;
}

// ---------------- 导出 ----------------

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  // 防公式注入：以 = + - @ 开头的格子前面加一个单引号（Excel / WPS 打开不会当公式执行）。
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function csvTable(header: string[], rows: unknown[][]) {
  return [header.join(","), ...rows.map((row) => row.map(csvCell).join(","))].join("\n");
}

function isoOf(ms: unknown) {
  const value = Number(ms);
  return Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : "";
}

export type LineEventRow = {
  id?: number;
  kind: string;
  fromLabel?: string | null;
  toLabel?: string | null;
  reason?: string | null;
  reasonText?: string | null;
  score?: number | null;
  latencyMs?: number | null;
  /** Unix 毫秒 */
  at: number;
};

const LINE_EVENT_HEADER = ["time", "kind", "from", "to", "reason", "reasonText", "score", "latencyMs"];

function lineEventCells(row: LineEventRow) {
  return [isoOf(row.at), row.kind, row.fromLabel ?? "", row.toLabel ?? "", row.reason ?? "", row.reasonText ?? "", row.score ?? "", row.latencyMs ?? ""];
}

/** 线路事件导出成 CSV（带 BOM，Excel 直接打开不乱码）。 */
export function lineEventsToCsv(rows: readonly LineEventRow[]): string {
  const body = csvTable(LINE_EVENT_HEADER, rows.map(lineEventCells));
  return `﻿${body}\n`;
}

export type LineExportPathRow = {
  letter: string;
  name: string;
  key: string;
  active?: boolean;
  healthy?: boolean | null;
  down?: boolean;
  downReason?: string | null;
  score?: number | null;
  latencyMs?: number | null;
  lossPct?: number | null;
  jitterMs?: number | null;
  availabilityPct?: number | null;
  hops?: ReadonlyArray<{ name: string }>;
};

export type LineExportQualityPath = {
  letter: string;
  name: string;
  points: ReadonlyArray<{ at: number; latencyMs: number | null; lossPct: number; jitterMs: number | null; availabilityPct: number | null; score: number | null; samples: number }>;
};

/**
 * 整条线路导出成一个 CSV：三张表（路径现状、事件、质量历史）上下排，中间空一行，
 * 每张表前一行写表名（# 开头）。
 */
export function lineExportToCsv(input: {
  ruleId: number;
  ruleName?: string | null;
  exportedAt: number;
  paths: readonly LineExportPathRow[];
  events: readonly LineEventRow[];
  quality: readonly LineExportQualityPath[];
}): string {
  const pathTable = csvTable(
    ["letter", "name", "key", "active", "healthy", "down", "downReason", "score", "latencyMs", "lossPct", "jitterMs", "availabilityPct", "hops"],
    input.paths.map((path) => [
      path.letter,
      path.name,
      path.key,
      path.active ? "yes" : "",
      path.healthy === null || path.healthy === undefined ? "" : path.healthy ? "yes" : "no",
      path.down ? "yes" : "",
      path.downReason ?? "",
      path.score ?? "",
      path.latencyMs ?? "",
      path.lossPct ?? "",
      path.jitterMs ?? "",
      path.availabilityPct ?? "",
      (path.hops || []).map((hop) => hop.name).join(" > "),
    ]),
  );
  const qualityTable = csvTable(
    ["path", "time", "latencyMs", "lossPct", "jitterMs", "availabilityPct", "score", "samples"],
    input.quality.flatMap((path) => path.points.map((point) => [
      `${path.letter} ${path.name}`.trim(),
      isoOf(point.at),
      point.latencyMs ?? "",
      point.lossPct,
      point.jitterMs ?? "",
      point.availabilityPct ?? "",
      point.score ?? "",
      point.samples,
    ])),
  );
  const title = csvTable(["ruleId", "ruleName", "exportedAt"], [[input.ruleId, input.ruleName ?? "", isoOf(input.exportedAt)]]);
  return `﻿${[
    "# rule",
    title,
    "",
    "# paths",
    pathTable,
    "",
    "# events",
    csvTable(LINE_EVENT_HEADER, input.events.map(lineEventCells)),
    "",
    "# quality",
    qualityTable,
  ].join("\n")}\n`;
}

/** 导出文件名：line-<规则 id>-<UTC 时间>.json / .csv，只含 ASCII，浏览器下载不用转义。 */
export function lineExportFilename(ruleId: number, format: "json" | "csv", nowMs: number) {
  const stamp = new Date(nowMs).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `line-${Math.max(0, Math.floor(ruleId))}-${stamp}.${format}`;
}
