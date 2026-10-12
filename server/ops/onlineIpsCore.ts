/*
  在线 IP（#6）里不碰数据库、不碰网络的那部分：整理 Agent 上报、内存快照、按用户归并、
  「超过上限」事件的节流、历史写入的节流。单独一个文件好写单元测试（onlineIpsCore.test.ts）。
*/

/** 面板告诉 Agent「这个端口归谁」。userId 只在面板这边用，不发给 Agent。 */
export type OnlinePortOwner = {
  port: number;
  proto: "tcp" | "udp" | "both";
  ruleId: number;
  inboundId: number;
  userId: number;
  dnat: boolean;
  /** 「规则 · 香港入口」或「入站 · vless-443」 */
  label: string;
};

export type OnlineReportIp = { ip: string; conns: number; since: number };
export type OnlineReportPort = { port: number; ruleId: number; inboundId: number; ips: OnlineReportIp[]; truncated: boolean };
export type OnlineReport = { at: number; conntrack: boolean; ports: OnlineReportPort[] };

export type OnlineIpRow = {
  hostId: number;
  port: number;
  ruleId: number;
  inboundId: number;
  userId: number;
  ip: string;
  conns: number;
  /** 秒级时间戳：这个 IP 从什么时候开始一直连着（Agent 记的）。 */
  since: number;
};

const MAX_PORTS_PER_REPORT = 4096;
const MAX_IPS_PER_PORT = 256;
const IP_PATTERN = /^[0-9a-fA-F:.]{2,45}$/;

function positiveInt(value: unknown, max = 2 ** 31 - 1) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : 0;
}

/** 把 Agent 的上报洗一遍：字段类型、上限、明显不是 IP 的值都在这里挡掉。 */
export function normalizeOnlineReport(raw: unknown, nowSeconds = Math.floor(Date.now() / 1000)): OnlineReport | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as Record<string, unknown>;
  const ports: OnlineReportPort[] = [];
  const list = Array.isArray(input.ports) ? input.ports.slice(0, MAX_PORTS_PER_REPORT) : [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const p = item as Record<string, unknown>;
    const port = positiveInt(p.port);
    if (!port || port > 65535) continue;
    const ips: OnlineReportIp[] = [];
    for (const entry of Array.isArray(p.ips) ? p.ips.slice(0, MAX_IPS_PER_PORT) : []) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const ip = String(e.ip || "").trim();
      if (!IP_PATTERN.test(ip)) continue;
      const since = positiveInt(e.since);
      ips.push({ ip: ip.toLowerCase(), conns: Math.max(1, positiveInt(e.conns, 1_000_000)), since: since && since <= nowSeconds + 60 ? since : nowSeconds });
    }
    ports.push({ port, ruleId: positiveInt(p.ruleId), inboundId: positiveInt(p.inboundId), ips, truncated: p.truncated === true });
  }
  const at = positiveInt(input.at);
  return { at: at && Math.abs(at - nowSeconds) < 600 ? at : nowSeconds, conntrack: input.conntrack === true, ports };
}

/**
 * 上报 → 快照行。端口的归属以面板此刻的规则 / 入站为准（ownersByPort），Agent 带回来的 ruleId
 * 只在面板这边已经找不到这个端口时兜底用。本面板管的主机自己的地址（隧道上一跳、中转回连）不算客户端。
 */
export function buildOnlineRows(
  hostId: number,
  report: OnlineReport,
  ownersByPort: Map<number, OnlinePortOwner>,
  excludeIps: Set<string> = new Set(),
): OnlineIpRow[] {
  const rows: OnlineIpRow[] = [];
  for (const port of report.ports) {
    const owner = ownersByPort.get(port.port);
    if (!owner) continue;
    for (const entry of port.ips) {
      if (excludeIps.has(entry.ip)) continue;
      rows.push({
        hostId,
        port: port.port,
        ruleId: owner.ruleId,
        inboundId: owner.inboundId,
        userId: owner.userId,
        ip: entry.ip,
        conns: entry.conns,
        since: entry.since,
      });
    }
  }
  return rows;
}

type SnapshotEntry = { at: number; intervalSeconds: number; rows: OnlineIpRow[] };

/**
 * 每台主机最近一轮的在线快照。每轮整份替换；超过两个上报周期没更新的主机当作没有数据
 * （Agent 掉线、模块关了、主机删了），读的时候顺手清掉。
 */
export class OnlineSnapshotStore {
  private readonly hosts = new Map<number, SnapshotEntry>();

  set(hostId: number, rows: OnlineIpRow[], atMs: number, intervalSeconds: number) {
    this.hosts.set(hostId, { at: atMs, intervalSeconds: Math.max(5, intervalSeconds), rows });
  }

  delete(hostId: number) {
    this.hosts.delete(hostId);
  }

  /** 快照多久算过期：两个周期，再给 5 秒网络抖动。 */
  static staleAfterMs(intervalSeconds: number) {
    return (Math.max(5, intervalSeconds) * 2 + 5) * 1000;
  }

  live(nowMs = Date.now()): OnlineIpRow[] {
    const out: OnlineIpRow[] = [];
    for (const [hostId, entry] of this.hosts) {
      if (nowMs - entry.at > OnlineSnapshotStore.staleAfterMs(entry.intervalSeconds)) {
        this.hosts.delete(hostId);
        continue;
      }
      out.push(...entry.rows);
    }
    return out;
  }

  /** 有快照（没过期）的主机。 */
  reportingHostIds(nowMs = Date.now()): number[] {
    this.live(nowMs);
    return Array.from(this.hosts.keys());
  }

  clear() {
    this.hosts.clear();
  }
}

/** 每个用户此刻有哪些不同的 IP（跨主机去重 —— 同一台手机连两台机器只算一个设备）。 */
export function distinctIpsByUser(rows: OnlineIpRow[]): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>();
  for (const row of rows) {
    if (!row.userId) continue;
    let set = out.get(row.userId);
    if (!set) {
      set = new Set();
      out.set(row.userId, set);
    }
    set.add(row.ip);
  }
  return out;
}

export const IP_LIMIT_EVENT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * 哪些用户该记一条「超过 IP 上限」：在线 IP 数 > 上限（上限 0 = 不限），且距离上一条超过 6 小时。
 * 会把选中的用户写进 lastEventAt。
 */
export function pickIpLimitExceeded(
  ipsByUser: Map<number, Set<string>>,
  limits: Map<number, number>,
  lastEventAt: Map<number, number>,
  nowMs = Date.now(),
): Array<{ userId: number; count: number; limit: number; ips: string[] }> {
  const out: Array<{ userId: number; count: number; limit: number; ips: string[] }> = [];
  for (const [userId, ips] of ipsByUser) {
    const limit = Number(limits.get(userId) || 0);
    if (limit <= 0 || ips.size <= limit) continue;
    const last = lastEventAt.get(userId);
    if (last !== undefined && nowMs - last < IP_LIMIT_EVENT_COOLDOWN_MS) continue;
    lastEventAt.set(userId, nowMs);
    out.push({ userId, count: ips.size, limit, ips: Array.from(ips).sort() });
  }
  return out;
}

export function sightingKey(row: Pick<OnlineIpRow, "hostId" | "ip" | "userId" | "ruleId" | "inboundId">) {
  return `${row.hostId}|${row.ip}|${row.userId}|${row.ruleId}|${row.inboundId}`;
}

export const SIGHTING_WRITE_INTERVAL_MS = 60_000;

/** 这一轮要不要写库：第一次见、过了一分钟、或者连接数创了新高（max 要准）。 */
export function shouldWriteSighting(
  state: { lastWrittenAt: number; maxConn: number } | undefined,
  conns: number,
  nowMs = Date.now(),
) {
  if (!state) return true;
  if (conns > state.maxConn) return true;
  return nowMs - state.lastWrittenAt >= SIGHTING_WRITE_INTERVAL_MS;
}

/** 入站协议 → 它在哪种传输上收连接。 */
export function inboundTransportProto(protocol: unknown): OnlinePortOwner["proto"] {
  const p = String(protocol || "").toLowerCase();
  if (p === "hysteria2" || p === "hysteria" || p === "tuic") return "udp";
  if (p === "shadowsocks" || p === "ss") return "both";
  return "tcp";
}

export function ruleTransportProto(protocol: unknown): OnlinePortOwner["proto"] {
  const p = String(protocol || "").toLowerCase();
  return p === "tcp" || p === "udp" ? p : "both";
}

/** 历史查询的天数只认这几档。 */
export const HISTORY_DAYS = [1, 7, 30, 90] as const;
export const SIGHTING_RETENTION_DAYS = 90;
