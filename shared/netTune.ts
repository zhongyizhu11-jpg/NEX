/*
  一键网络调优（批次 2 · 第 14 项）：主机详情 › 更多 › 网络调优。

  Agent 端是扩展模块 "nettune"（agent/ext_nettune.go，Agent 2.2.250 起），面板端见
  server/ops/netTuneAgent.ts。规则和安装脚本 apply_network_tuning（server/agentInstallScripts.ts）
  是同一套：只往「更适合转发」的方向调，已经更好的值保留；拥塞控制只在默认的 cubic / reno 时
  改成 bbr，用户自选的算法不动。三处改一处记得同步另外两处。

  这里放参数表、给人看的名字和「达标」的判断，界面和面板都用。
*/

type NetTuneRuleKind = "atLeast" | "atMost" | "bitsSet" | "equals" | "rmemAtLeast" | "tripleAtLeast";
/** 按这台机器的内存 / 带宽算目标值的几项（2.2.276，和 agent/ext_nettune.go 的 netTuneMemRule 一致）。 */
type NetTuneMemRule = "buffer" | "tcpMem" | "minFree";
export type NetTuneGroup = "forwarding" | "congestion" | "buffers" | "conntrack" | "queues" | "tcp";

export const NETTUNE_GROUP_LABELS: Record<NetTuneGroup, string> = {
  forwarding: "转发",
  congestion: "拥塞控制",
  buffers: "缓冲区",
  conntrack: "连接跟踪",
  queues: "队列",
  tcp: "TCP 行为",
};

export type NetTuneRule = {
  key: string;
  kind: NetTuneRuleKind;
  want: number;
  label: string;
  group: NetTuneGroup;
  /** 值是字节数（显示成 MB / KB）。 */
  bytes?: boolean;
  /** rmemAtLeast：三元组「最小 起点 上限」的起点（中间值）至少要到多少；上限看 want。 */
  wantDefault?: number;
  /** 值的单位是页（tcp_mem）/ KB（min_free_kbytes），显示时换成字节。 */
  unit?: "pages" | "kb";
  mem?: NetTuneMemRule;
  /** 从哪个 Agent 版本起才管这一项（老 Agent 不报，界面上写「升级后能看到」）。 */
  since?: string;
  hint: string;
};

/** 2.2.276 起：缓冲按带宽和内存算、tcp_mem、初始窗口和 tcpfit 基础调优的其余几项。 */
export const NETTUNE_TCPFIT_AGENT_VERSION = "2.2.276";

/**
 * tcp_rmem 的起点（每条 TCP 接收缓冲从多大开始长）至少抬到 1 MB（Agent 2.2.257 起；和
 * agent/ext_nettune.go 的 netTuneTCPRmemDefault 一致）。内核默认 128 KB 时，高延迟又丢包的线路上
 * 新连接的 BBR 启动阶段会被接收窗口卡住，之后十几秒只有几到几十 Mbit/s。实测见
 * forwardx-fxp/internal/v3/BENCHMARKS.md「tcp_rmem 起点」（4 MB 起步更快，但 50 ms 丢包线路上多条新连接
 * 同时下载反而更慢，所以取 1 MB）。
 */
const NETTUNE_TCP_RMEM_DEFAULT = 1048576;

/** 和 agent/ext_nettune.go 的 netTuneRules 一一对应（哈希桶和拥塞控制另算，见下面）。 */
export const NETTUNE_RULES: readonly NetTuneRule[] = [
  { key: "net.ipv4.ip_forward", kind: "equals", want: 1, label: "IPv4 转发", group: "forwarding", hint: "iptables / nftables 转发要它打开" },
  { key: "net.core.rmem_max", kind: "atLeast", want: 67108864, mem: "buffer", label: "接收缓冲上限", group: "buffers", bytes: true, hint: "长距离线路跑满带宽需要的窗口；只是上限，不会多占内存。按带宽（2 × 带宽 × 150 ms + 2 MB）和内存（不超过内存的 1/32）算" },
  { key: "net.core.wmem_max", kind: "atLeast", want: 67108864, mem: "buffer", label: "发送缓冲上限", group: "buffers", bytes: true, hint: "同上，发送方向" },
  { key: "net.ipv4.tcp_rmem", kind: "rmemAtLeast", want: 67108864, mem: "buffer", wantDefault: NETTUNE_TCP_RMEM_DEFAULT, label: "TCP 接收窗口", group: "buffers", bytes: true, hint: "上限：按带宽和内存算（同接收缓冲上限）；小内存机器上太大的上限会让几条大流吃光全局 TCP 内存，所有连接的窗口一起被压小。起点：内核默认 128 KB，高延迟丢包线路上新连接会被它卡住、十几秒都爬不起来；1 MB 只是起点，按收到的数据才占内存" },
  { key: "net.ipv4.tcp_wmem", kind: "rmemAtLeast", want: 67108864, mem: "buffer", wantDefault: NETTUNE_TCP_RMEM_DEFAULT, label: "TCP 发送窗口", group: "buffers", bytes: true, hint: "同上，发送方向（起点 Agent 2.2.276 起才抬）" },
  { key: "net.ipv4.tcp_mem", kind: "tripleAtLeast", want: 0, mem: "tcpMem", unit: "pages", since: NETTUNE_TCPFIT_AGENT_VERSION, label: "全局 TCP 内存", group: "buffers", bytes: true, hint: "所有 TCP 连接加起来能用多少内存：到「压力」开始缩窗，到「上限」拒绝分配。按内存的 1/16、1/8、1/4 算（内核默认约 3/64、1/16、3/32，大流多时过早进入内存压力）" },
  { key: "net.core.rmem_default", kind: "atLeast", want: 1048576, label: "默认接收缓冲", group: "buffers", bytes: true, hint: "隧道、游戏的 UDP 突发时不在套接字缓冲上丢包" },
  { key: "net.core.wmem_default", kind: "atLeast", want: 1048576, label: "默认发送缓冲", group: "buffers", bytes: true, hint: "同上，发送方向" },
  { key: "net.ipv4.udp_rmem_min", kind: "atLeast", want: 16384, label: "UDP 接收缓冲下限", group: "buffers", bytes: true, hint: "内存紧张时每个 UDP 套接字至少保留这么多" },
  { key: "net.ipv4.udp_wmem_min", kind: "atLeast", want: 16384, label: "UDP 发送缓冲下限", group: "buffers", bytes: true, hint: "同上，发送方向" },
  { key: "net.netfilter.nf_conntrack_max", kind: "atLeast", want: 1048576, label: "连接跟踪表上限", group: "conntrack", hint: "满了新连接直接被丢（dmesg 里的 nf_conntrack: table full）" },
  { key: "net.netfilter.nf_conntrack_tcp_be_liberal", kind: "atLeast", want: 1, label: "宽松跟踪 TCP", group: "conntrack", hint: "对端重启、窗口漂移后的连接照样放行，不被当成非法包掐掉" },
  { key: "net.core.netdev_max_backlog", kind: "atLeast", want: 16384, label: "网卡收包队列", group: "queues", hint: "流量突发时内核来不及处理的包先排在这里" },
  { key: "net.core.netdev_budget", kind: "atLeast", want: 600, since: NETTUNE_TCPFIT_AGENT_VERSION, label: "软中断每轮收包数", group: "queues", hint: "网卡收包时内核一轮最多处理多少包；高流量时少攒一点积压" },
  { key: "net.core.optmem_max", kind: "atLeast", want: 65536, since: NETTUNE_TCPFIT_AGENT_VERSION, label: "套接字附加内存", group: "queues", bytes: true, hint: "每个套接字给辅助数据（零拷贝、时间戳这类）的内存上限" },
  { key: "net.core.somaxconn", kind: "atLeast", want: 8192, label: "监听队列上限", group: "queues", hint: "高并发建连时不丢新连接" },
  { key: "net.ipv4.tcp_max_syn_backlog", kind: "atLeast", want: 8192, label: "SYN 队列", group: "queues", hint: "同上，握手还没完成的连接" },
  { key: "net.ipv4.tcp_mtu_probing", kind: "atLeast", want: 1, label: "MTU 探测", group: "tcp", hint: "路径上 MTU 变小时自己探出来，不卡死在大包上" },
  { key: "net.ipv4.tcp_notsent_lowat", kind: "atMost", want: 131072, label: "未发送数据上限", group: "tcp", bytes: true, hint: "发送队列里堆的数据少一点，中转上的排队延迟低一点" },
  { key: "net.ipv4.tcp_slow_start_after_idle", kind: "atMost", want: 0, label: "空闲后重新慢启动", group: "tcp", hint: "关掉：长连接空闲后突发时不用重新爬坡" },
  { key: "net.ipv4.tcp_fastopen", kind: "bitsSet", want: 3, label: "TCP Fast Open", group: "tcp", hint: "客户端和服务端都打开（按位，保留已有的位）" },
  { key: "net.ipv4.tcp_tw_reuse", kind: "equals", want: 1, label: "TIME_WAIT 复用", group: "tcp", hint: "转发出去的连接多时，本地端口不被 TIME_WAIT 占满" },
  { key: "net.ipv4.tcp_no_metrics_save", kind: "atLeast", want: 1, label: "不沿用旧连接指标", group: "tcp", hint: "一次丢包的坏印象不拖慢后面的新连接" },
  // 以下 2.2.276 起，和 tcpfit 的基础调优一致（本机端口范围刻意不改：会占到规则要监听的端口）
  { key: "net.ipv4.tcp_window_scaling", kind: "equals", want: 1, since: NETTUNE_TCPFIT_AGENT_VERSION, label: "窗口缩放", group: "tcp", hint: "关掉时窗口最大 64 KB，长距离线路跑不起来" },
  { key: "net.ipv4.tcp_moderate_rcvbuf", kind: "equals", want: 1, since: NETTUNE_TCPFIT_AGENT_VERSION, label: "接收缓冲自动调整", group: "tcp", hint: "按实际速度把接收缓冲从起点长到上限" },
  { key: "net.ipv4.tcp_adv_win_scale", kind: "equals", want: 1, since: NETTUNE_TCPFIT_AGENT_VERSION, label: "窗口占缓冲比例", group: "tcp", hint: "缓冲的一半拿来当窗口（缓冲上限按 2 × BDP 算就是这个原因）" },
  { key: "net.ipv4.tcp_sack", kind: "equals", want: 1, since: NETTUNE_TCPFIT_AGENT_VERSION, label: "选择确认（SACK）", group: "tcp", hint: "丢一个包只重传那一个" },
  { key: "net.ipv4.tcp_dsack", kind: "equals", want: 1, since: NETTUNE_TCPFIT_AGENT_VERSION, label: "重复确认（D-SACK）", group: "tcp", hint: "分清是真丢包还是乱序，少做无谓的重传" },
  { key: "net.ipv4.tcp_timestamps", kind: "equals", want: 1, since: NETTUNE_TCPFIT_AGENT_VERSION, label: "时间戳", group: "tcp", hint: "往返时间测得准，TIME_WAIT 复用也要它" },
  { key: "net.ipv4.tcp_syncookies", kind: "equals", want: 1, since: NETTUNE_TCPFIT_AGENT_VERSION, label: "SYN Cookie", group: "tcp", hint: "SYN 队列满时照样接新连接（挡 SYN 洪水）" },
  { key: "net.ipv4.tcp_fin_timeout", kind: "atMost", want: 15, since: NETTUNE_TCPFIT_AGENT_VERSION, label: "FIN 等待", group: "tcp", hint: "对端不回 FIN 的半关闭连接 15 秒就收掉（默认 60 秒）" },
  { key: "net.ipv4.tcp_keepalive_time", kind: "atMost", want: 600, since: NETTUNE_TCPFIT_AGENT_VERSION, label: "保活探测间隔", group: "tcp", hint: "空闲 10 分钟开始探对端还在不在（默认 2 小时），死连接早点收" },
  { key: "vm.min_free_kbytes", kind: "atLeast", want: 32768, mem: "minFree", unit: "kb", since: NETTUNE_TCPFIT_AGENT_VERSION, label: "保留空闲内存", group: "buffers", bytes: true, hint: "内核始终留出的空闲内存，突发收包时网卡驱动不会因为分配不到内存丢包。至少 32 MB，但不超过内存的 1/32" },
  { key: "fs.file-max", kind: "atLeast", want: 1000000, since: NETTUNE_TCPFIT_AGENT_VERSION, label: "全局文件句柄", group: "queues", hint: "每条连接占一个句柄，并发多时不够用会拒绝新连接" },
];

/* ---------- 按内存 / 带宽算的目标值（2.2.276，和 agent/ext_nettune.go 一致） ---------- */

export const NETTUNE_KEY_MEMTOTAL = "meminfo.memtotal";
export const NETTUNE_KEY_INITCWND = "route.initcwnd";
export const NETTUNE_KEY_INITRWND = "route.initrwnd";
export const NETTUNE_INIT_WINDOW = 32;

const MIB = 1048576;
const NETTUNE_BUFFER_WANT = 64 * MIB;
const NETTUNE_BUFFER_FLOOR = 4 * MIB;
const NETTUNE_BUFFER_CEIL = 256 * MIB;
const NETTUNE_BUFFER_RTT_MS = 150;

/**
 * 缓冲上限的建议值和内存预算（budget 为 null：不知道内存，不封顶）。
 * 知道带宽：2 × BDP（150 ms 往返）+ 2 MiB，向上取整到 MiB；不知道：64 MiB。都不超过内存的 1/32（4–256 MiB）。
 */
export function netTuneBufferLimits(memBytes: number | null | undefined, bandwidthMbps?: number | null): { want: number; budget: number | null } {
  let want = NETTUNE_BUFFER_WANT;
  const bw = Number(bandwidthMbps) || 0;
  if (bw > 0) {
    const bdp = Math.floor((Math.floor((bw * 1_000_000) / 8) * NETTUNE_BUFFER_RTT_MS) / 1000);
    want = Math.ceil((2 * bdp + 2 * MIB) / MIB) * MIB;
    want = Math.min(Math.max(want, NETTUNE_BUFFER_FLOOR), NETTUNE_BUFFER_CEIL);
  }
  const mem = Number(memBytes) || 0;
  if (mem <= 0) return { want, budget: null };
  let budget = Math.floor(mem / 32 / MIB) * MIB;
  budget = Math.min(Math.max(budget, NETTUNE_BUFFER_FLOOR), NETTUNE_BUFFER_CEIL);
  return { want: Math.min(want, budget), budget };
}

/** 全局 TCP 内存（页）：内存的 1/16、1/8、1/4。 */
export function netTuneTcpMem(memBytes: number): [number, number, number] {
  const pages = Math.floor(memBytes / 4096);
  return [Math.max(Math.floor(pages / 16), 4096), Math.max(Math.floor(pages / 8), 8192), Math.max(Math.floor(pages / 4), 16384)];
}

export type NetTuneEvaluateOptions = {
  /** 这台机器的带宽（面板上的线路带宽 / 出口整形带宽），0 或不给 = 不知道。 */
  bandwidthMbps?: number | null;
};

export const NETTUNE_KEY_CC = "net.ipv4.tcp_congestion_control";
export const NETTUNE_KEY_QDISC = "net.core.default_qdisc";
const NETTUNE_KEY_BUCKETS = "net.netfilter.nf_conntrack_buckets";
const NETTUNE_KEY_COUNT = "net.netfilter.nf_conntrack_count";
const NETTUNE_KEY_CONNTRACK_MAX = "net.netfilter.nf_conntrack_max";
const NETTUNE_KEY_OS_RELEASE = "kernel.osrelease";
const NETTUNE_MIN_BUCKETS = 262144;
/** 安装脚本和 Agent 只在这几种拥塞控制时改成 bbr；别的算是用户自选。 */
const NETTUNE_DEFAULT_CC = new Set(["cubic", "reno", "bbr"]);

/* ---------- Agent 上报的形状（agent/ext_nettune.go 的 netTuneResult） ---------- */

type NetTuneChange = { key: string; from: string; to: string };
type NetTuneFailure = { key: string; error: string };

/*
  2.2.255 起除了「检查 / 一键调优」还有两种（老 Agent 不认，只当一次检查，不会误改）：
    set      逐项设置：只收 NETTUNE_EDITABLE_KEYS 里的键，值在面板和 Agent 两头都校验，
             Agent 写完读回来核对，内核没接受就改回原值；
    restore  还原到面板第一次改这台机器之前的值（第一次改动前 Agent 自动存一份），并删掉面板写的持久化文件。
  上游 poouo/Forwardx 的 BBR 管理插件（2.3.287）给的也是这两样：按参数改、能还原。
*/
export type NetTuneMode = "check" | "apply" | "set" | "restore";
export const NETTUNE_CUSTOM_AGENT_VERSION = "2.2.255";

export type NetTuneResult = {
  id: string;
  apply: boolean;
  mode?: NetTuneMode;
  /** Agent 上有没有「调优前的原值」备份（有才能还原）。老 Agent 不报，按 undefined。 */
  hasBackup?: boolean;
  status: "running" | "done";
  startedAt: number;
  finishedAt?: number;
  values?: Record<string, string>;
  missing?: string[];
  changed?: NetTuneChange[];
  failed?: NetTuneFailure[];
  file?: string;
  fileError?: string;
  error?: string;
};

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TEXT = 512;

function text(value: unknown, max = MAX_TEXT): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function epoch(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

/** 把 Agent 上报的一个结果收拾干净（字段缺了、类型不对、太长的都处理掉）；认不出来返回 null。 */
export function normalizeNetTuneResult(raw: unknown): NetTuneResult | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const id = text(item.id, 64);
  if (!ID_PATTERN.test(id)) return null;
  const status = item.status === "done" ? "done" : item.status === "running" ? "running" : null;
  if (!status) return null;
  const values: Record<string, string> = {};
  if (item.values && typeof item.values === "object") {
    for (const [key, value] of Object.entries(item.values as Record<string, unknown>).slice(0, 64)) {
      if (/^[a-z0-9_.-]{1,80}$/.test(key)) values[key] = text(value, 256);
    }
  }
  const list = <T,>(value: unknown, map: (entry: Record<string, unknown>) => T | null): T[] =>
    (Array.isArray(value) ? value : []).slice(0, 64).map((entry) => (entry && typeof entry === "object" ? map(entry as Record<string, unknown>) : null)).filter((entry): entry is T => entry !== null);
  const mode = typeof item.mode === "string" && ["check", "apply", "set", "restore"].includes(item.mode) ? item.mode as NetTuneMode : undefined;
  return {
    id,
    apply: item.apply === true,
    mode,
    hasBackup: typeof item.hasBackup === "boolean" ? item.hasBackup : undefined,
    status,
    startedAt: epoch(item.startedAt),
    finishedAt: epoch(item.finishedAt) || undefined,
    values,
    missing: (Array.isArray(item.missing) ? item.missing : []).slice(0, 64).map((key) => text(key, 80)).filter(Boolean),
    changed: list(item.changed, (entry) => (text(entry.key, 80) ? { key: text(entry.key, 80), from: text(entry.from, 256), to: text(entry.to, 256) } : null)),
    failed: list(item.failed, (entry) => (text(entry.key, 80) ? { key: text(entry.key, 80), error: text(entry.error) } : null)),
    file: text(item.file, 256) || undefined,
    fileError: text(item.fileError) || undefined,
    error: text(item.error) || undefined,
  };
}

/* ---------- 「达标」判断 ---------- */

export type NetTuneItemStatus =
  /** 已经和建议一样或更好。 */
  | "ok"
  /** 比建议差，一键调优会改。 */
  | "low"
  /** 超过这台机器的内存预算（缓冲上限），一键调优会压下来。 */
  | "high"
  /** 用户自己选的（例如别的拥塞控制算法），不动也不算不达标。 */
  | "custom"
  /** 这台机器上没有这个参数（例如没加载连接跟踪模块）。 */
  | "missing";

export type NetTuneItem = {
  key: string;
  label: string;
  group: NetTuneGroup;
  hint: string;
  current: string | null;
  /** 建议值，给人看的。 */
  want: string;
  status: NetTuneItemStatus;
};

export type NetTuneEvaluation = {
  items: NetTuneItem[];
  ok: number;
  /** 一键调优会改的项数（偏低 + 偏高）。 */
  low: number;
  /** 参与评判的项数（不含 missing / custom）。 */
  total: number;
  congestionControl: string | null;
  qdisc: string | null;
  conntrackCount: number | null;
  conntrackMax: number | null;
  kernel: string | null;
  /** 缓冲上限按什么算的（界面上写一句）：内存、带宽，都不知道是 null。 */
  memBytes: number | null;
  bandwidthMbps: number | null;
};

function formatNetTuneBytes(value: number): string {
  if (value >= 1048576 && value % 1048576 === 0) return `${value / 1048576} MB`;
  if (value >= 1024 && value % 1024 === 0) return `${value / 1024} KB`;
  return `${value} B`;
}

function lastNumber(value: string): number | null {
  const fields = value.trim().split(/\s+/);
  const number = Number(fields[fields.length - 1]);
  return fields.length > 0 && fields[fields.length - 1] !== "" && Number.isFinite(number) ? number : null;
}

/** 三元组「最小 起点 上限」的起点；不是三段数字返回 null。 */
function middleNumber(value: string): number | null {
  const fields = value.trim().split(/\s+/);
  if (fields.length !== 3 || !/^\d+$/.test(fields[1])) return null;
  return Number(fields[1]);
}

/** 内核用 2^32 - 1（或更大）表示「不限」，例如 tcp_notsent_lowat 的默认值。 */
const NETTUNE_UNLIMITED = 4294967295;

function unitBytes(rule: NetTuneRule, value: number): number {
  return rule.unit === "pages" ? value * 4096 : rule.unit === "kb" ? value * 1024 : value;
}

function display(rule: NetTuneRule, value: string): string {
  if (rule.kind === "tripleAtLeast") {
    const fields = value.trim().split(/\s+/).map(Number);
    if (fields.length !== 3 || fields.some((field) => !Number.isFinite(field))) return value;
    return `${formatNetTuneBytes(unitBytes(rule, fields[1]))} 起缩窗 · 上限 ${formatNetTuneBytes(unitBytes(rule, fields[2]))}`;
  }
  const number = lastNumber(value);
  if (rule.unit && number !== null) return formatNetTuneBytes(unitBytes(rule, number));
  if (rule.kind === "rmemAtLeast" && number !== null) {
    const start = middleNumber(value);
    return start === null ? formatNetTuneBytes(number) : `起点 ${formatNetTuneBytes(start)} · 上限 ${formatNetTuneBytes(number)}`;
  }
  if (rule.bytes && number !== null && number >= NETTUNE_UNLIMITED) return "不限";
  if (rule.bytes && number !== null) return formatNetTuneBytes(number);
  if (rule.kind === "atMost" && rule.want === 0) return number === 0 ? "关" : "开";
  if (rule.kind === "equals" && rule.want === 1 && rule.key === "net.ipv4.ip_forward") return number === 1 ? "开" : "关";
  return value;
}

type HostRule = NetTuneRule & { budget?: number | null; triple?: [number, number, number] };

function capText(rule: HostRule): string {
  return rule.budget && rule.budget > rule.want ? `${formatNetTuneBytes(rule.want)} – ${formatNetTuneBytes(rule.budget)}` : `≥ ${formatNetTuneBytes(rule.want)}`;
}

function wantText(rule: HostRule): string {
  switch (rule.kind) {
    case "tripleAtLeast":
      return rule.triple ? `${formatNetTuneBytes(unitBytes(rule, rule.triple[1]))} 起缩窗 · 上限 ≥ ${formatNetTuneBytes(unitBytes(rule, rule.triple[2]))}` : "按内存";
    case "atLeast":
      if (rule.mem === "buffer") return capText(rule);
      return `≥ ${rule.bytes ? formatNetTuneBytes(unitBytes(rule, rule.want)) : rule.want}`;
    case "atMost":
      if (rule.want === 0) return "关";
      return `≤ ${rule.bytes ? formatNetTuneBytes(rule.want) : rule.want}`;
    case "bitsSet":
      return `含 ${rule.want}`;
    case "equals":
      return rule.key === "net.ipv4.ip_forward" ? "开" : String(rule.want);
    case "rmemAtLeast":
      return `起点 ≥ ${formatNetTuneBytes(rule.wantDefault ?? 0)} · 上限 ${capText(rule).replace(/^≥ /, "≥ ")}`;
  }
}

/** true 达标 / "low" 偏低 / "high" 超过内存预算 / null 认不出。 */
function ruleSatisfied(rule: HostRule, value: string): boolean | "high" | null {
  if (rule.kind === "tripleAtLeast") {
    const fields = value.trim().split(/\s+/);
    if (fields.length !== 3 || fields.some((field) => !/^\d+$/.test(field))) return null;
    if (!rule.triple) return true; // 不知道内存：不评判
    return fields.every((field, index) => Number(field) >= rule.triple![index]);
  }
  const number = lastNumber(value);
  if (number === null) return null;
  if (rule.budget && number > rule.budget) return "high";
  switch (rule.kind) {
    case "atLeast":
      return number >= rule.want;
    case "atMost":
      return number <= rule.want;
    case "bitsSet":
      return (number & rule.want) === rule.want;
    case "equals":
      return number === rule.want;
    case "rmemAtLeast": {
      const start = middleNumber(value);
      // 认不出三段时只看上限（和 Agent 一样退回 atLeast）
      return number >= rule.want && (start === null || start >= (rule.wantDefault ?? 0));
    }
  }
}

/** 按 Agent 读到的值逐项判断（和 Agent 端调优的规则一致）。 */
export function evaluateNetTune(values: Record<string, string> | null | undefined, options: NetTuneEvaluateOptions = {}): NetTuneEvaluation {
  const v = values ?? {};
  const items: NetTuneItem[] = [];
  const memRaw = v[NETTUNE_KEY_MEMTOTAL] === undefined ? null : Number(v[NETTUNE_KEY_MEMTOTAL]);
  const memBytes = memRaw !== null && Number.isFinite(memRaw) && memRaw > 0 ? memRaw : null;
  const bandwidthMbps = Number(options.bandwidthMbps) > 0 ? Number(options.bandwidthMbps) : null;
  const buffer = netTuneBufferLimits(memBytes, bandwidthMbps);
  // 老 Agent（2.2.276 之前）不报内存，也不读新加的那几项：那几项写「升级后能看到」，不说「这台机器上没有」
  const newAgent = memBytes !== null;
  const hostRule = (rule: NetTuneRule): HostRule => {
    if (rule.mem === "buffer") return { ...rule, want: buffer.want, budget: buffer.budget };
    if (rule.mem === "tcpMem") return { ...rule, triple: memBytes ? netTuneTcpMem(memBytes) : undefined };
    if (rule.mem === "minFree" && memBytes) return { ...rule, want: Math.min(rule.want, Math.floor(memBytes / 1024 / 32)) };
    return rule;
  };

  const cc = v[NETTUNE_KEY_CC] ?? null;
  const qdisc = v[NETTUNE_KEY_QDISC] ?? null;
  const customCc = cc !== null && !NETTUNE_DEFAULT_CC.has(cc);
  items.push({
    key: NETTUNE_KEY_CC,
    label: "拥塞控制",
    group: "congestion",
    hint: customCc ? "这是自己选的算法，调优不会改它" : "BBR 在有丢包的长距离线路上比 cubic 快得多",
    current: cc,
    want: "bbr",
    status: cc === null ? "missing" : customCc ? "custom" : cc === "bbr" ? "ok" : "low",
  });
  items.push({
    key: NETTUNE_KEY_QDISC,
    label: "默认队列",
    group: "congestion",
    hint: "BBR 配 fq 才能按速率均匀发包",
    current: qdisc,
    want: "fq",
    status: qdisc === null ? "missing" : customCc ? "custom" : qdisc === "fq" ? "ok" : "low",
  });

  for (const base of NETTUNE_RULES) {
    const rule = hostRule(base);
    const value = v[rule.key];
    if (value === undefined) {
      const hint = rule.since && !newAgent ? `Agent ${rule.since} 起才管这一项，升级后能看到。${rule.hint}` : rule.hint;
      items.push({ key: rule.key, label: rule.label, group: rule.group, hint, current: null, want: wantText(rule), status: "missing" });
      continue;
    }
    const satisfied = ruleSatisfied(rule, value);
    items.push({
      key: rule.key,
      label: rule.label,
      group: rule.group,
      hint: rule.hint,
      current: display(rule, value),
      want: wantText(rule),
      status: satisfied === null ? "custom" : satisfied === "high" ? "high" : satisfied ? "ok" : "low",
    });
    if (rule.key === NETTUNE_KEY_CONNTRACK_MAX) {
      // 哈希桶跟在表上限后面：至少 表上限 / 4（不低于 262144）。
      const buckets = v[NETTUNE_KEY_BUCKETS];
      const max = lastNumber(value);
      const wantBuckets = Math.max(NETTUNE_MIN_BUCKETS, Math.floor(Math.max(max ?? 0, 1048576) / 4));
      const current = buckets === undefined ? null : lastNumber(buckets);
      items.push({
        key: NETTUNE_KEY_BUCKETS,
        label: "连接跟踪哈希桶",
        group: "conntrack",
        hint: "只抬表上限不抬桶，查表的链会越来越长",
        current: buckets === undefined ? null : buckets,
        want: `≥ ${wantBuckets}`,
        status: buckets === undefined ? "missing" : current === null ? "custom" : current >= wantBuckets ? "ok" : "low",
      });
    }
  }

  // 初始窗口（2.2.276）：Agent 报几条 IPv4 默认路由里最小的 initcwnd（没设按内核默认 10）
  const initcwnd = v[NETTUNE_KEY_INITCWND];
  const cwnd = initcwnd === undefined ? null : lastNumber(initcwnd);
  items.push({
    key: NETTUNE_KEY_INITCWND,
    label: "初始窗口",
    group: "tcp",
    hint: initcwnd === undefined
      ? newAgent
        ? "这台机器没有 IPv4 默认路由（纯 IPv6 或策略路由），不调"
        : `Agent ${NETTUNE_TCPFIT_AGENT_VERSION} 起才管这一项，升级后能看到`
      : "新连接第一个来回能发多少包：默认 10 个（约 14 KB），32 个约 46 KB，网页首屏这类短响应一个来回就发完。改在默认路由上，网络重连冲掉后 Agent 每分钟补回",
    current: initcwnd === undefined ? null : initcwnd,
    want: `≥ ${NETTUNE_INIT_WINDOW}`,
    status: initcwnd === undefined ? "missing" : cwnd === null ? "custom" : cwnd >= NETTUNE_INIT_WINDOW ? "ok" : "low",
  });

  const judged = items.filter((item) => item.status === "ok" || item.status === "low" || item.status === "high");
  const count = v[NETTUNE_KEY_COUNT] === undefined ? null : lastNumber(v[NETTUNE_KEY_COUNT]);
  const max = v[NETTUNE_KEY_CONNTRACK_MAX] === undefined ? null : lastNumber(v[NETTUNE_KEY_CONNTRACK_MAX]);
  return {
    items,
    ok: judged.filter((item) => item.status === "ok").length,
    low: judged.filter((item) => item.status === "low" || item.status === "high").length,
    total: judged.length,
    congestionControl: cc,
    qdisc,
    conntrackCount: count,
    conntrackMax: max,
    kernel: v[NETTUNE_KEY_OS_RELEASE] ?? null,
    memBytes,
    bandwidthMbps,
  };
}

/** 参数名对应的中文名（调优结果里「改了哪些」用）。 */
export function netTuneKeyLabel(key: string): string {
  if (key === NETTUNE_KEY_CC) return "拥塞控制";
  if (key === NETTUNE_KEY_INITCWND) return "初始窗口";
  if (key === NETTUNE_KEY_QDISC) return "默认队列";
  if (key === NETTUNE_KEY_BUCKETS) return "连接跟踪哈希桶";
  return NETTUNE_RULES.find((rule) => rule.key === key)?.label ?? key;
}

/* ---------- 逐项设置（2.2.255） ---------- */

/** 能逐项设置的键：规则表里的全部，加拥塞控制和默认队列。和 agent/ext_nettune.go 的 netTuneEditableKey 一致。 */
export const NETTUNE_EDITABLE_KEYS: readonly string[] = [...NETTUNE_RULES.map((rule) => rule.key), NETTUNE_KEY_CC, NETTUNE_KEY_QDISC];
export const NETTUNE_QDISC_CHOICES = ["fq", "fq_codel", "cake", "pfifo_fast", "sfq", "codel"] as const;

/**
 * 面板这头先校验一遍（Agent 那头还会再校验，并且按当前值核对段数、拥塞控制是否可用）。
 * 返回整理后的值；不合法抛出带原因的 Error。
 */
export function normalizeNetTuneSetting(key: string, raw: string): string {
  if (!NETTUNE_EDITABLE_KEYS.includes(key)) throw new Error(`${key} 不能在这里改`);
  const fields = String(raw ?? "").trim().split(/\s+/).filter(Boolean);
  if (fields.length === 0) throw new Error(`${netTuneKeyLabel(key)}：值是空的`);
  if (key === NETTUNE_KEY_CC) {
    if (fields.length !== 1 || !/^[a-z0-9_]{1,32}$/.test(fields[0])) throw new Error("拥塞控制算法名不对");
    return fields[0];
  }
  if (key === NETTUNE_KEY_QDISC) {
    if (fields.length !== 1 || !(NETTUNE_QDISC_CHOICES as readonly string[]).includes(fields[0])) {
      throw new Error(`默认队列只支持 ${NETTUNE_QDISC_CHOICES.join("、")}`);
    }
    return fields[0];
  }
  if (fields.length > 3) throw new Error(`${netTuneKeyLabel(key)}：最多 3 个数`);
  for (const field of fields) {
    if (!/^\d{1,19}$/.test(field)) throw new Error(`${netTuneKeyLabel(key)}：「${field}」不是非负整数`);
  }
  // TCP 缓冲三元组：最小 ≤ 起点 ≤ 上限（Agent 那头同样拦）
  if ((key === "net.ipv4.tcp_rmem" || key === "net.ipv4.tcp_wmem" || key === "net.ipv4.tcp_mem") && fields.length === 3) {
    const [low, start, high] = fields.map((field) => BigInt(field));
    if (low > start || start > high) throw new Error(`${netTuneKeyLabel(key)}：三个数要从小到大：最小 ≤ 起点 ≤ 上限`);
  }
  return fields.join(" ");
}
