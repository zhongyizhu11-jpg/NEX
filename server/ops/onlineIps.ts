/*
  在线 IP 与 IP 历史（#6）的面板侧。

  - 端口归属：每台主机上哪个端口属于哪条规则 / 哪个入站 / 哪个用户（读库，缓存 30 秒）。
    指令里把「端口 → 规则 / 入站」发给 Agent，Agent 不用知道面板的状态。
  - 当前在线：每台主机一份内存快照，每轮整份替换，超过两个周期没更新就不算（onlineIpsCore）。
  - 历史：ip_sightings，同一个键每分钟最多写一次，保留 90 天。写库在后台排队做，不拖慢上报。
  - 地区：这里是终端用户的 IP，只查面板自带的离线库（server/ipRegionOffline.ts，ip2region + sha256 校验），
    不发给任何第三方；离线库不可用就显示「未知」，不退回在线查询。后台串行查，从不在上报路径上等它。
  - 刷新频率：有人开着「在线 IP」时 10 秒一轮，否则 60 秒（watch() 续期，第一次打开时叫醒 Agent）。
  - 设备上限：用户在线 IP 数超过 maxIPs 时记一条 user.ip_limit_exceeded（每人 6 小时最多一条）。
*/
import { executeRaw, insertAndGetId, queryRaw, quoteDbIdentifier } from "../dbRuntime";
import { classifyIpAddress, isPrivateOrReservedAddress } from "../../shared/ipAddress";
import { lookupOfflineIpRegion } from "../ipRegionOffline";
import { hostSupportsAgentExt, wakeAgentExt, type AgentExtHost } from "./agentExt";
import { recordPanelEvent } from "./panelEvents";
import {
  OnlineSnapshotStore,
  SIGHTING_RETENTION_DAYS,
  buildOnlineRows,
  distinctIpsByUser,
  inboundTransportProto,
  normalizeOnlineReport,
  pickIpLimitExceeded,
  ruleTransportProto,
  shouldWriteSighting,
  sightingKey,
  type OnlineIpRow,
  type OnlinePortOwner,
} from "./onlineIpsCore";

const q = quoteDbIdentifier;

export const ONLINE_WATCH_INTERVAL_SECONDS = 10;
export const ONLINE_IDLE_INTERVAL_SECONDS = 60;
const WATCH_TTL_MS = 30_000;
const OWNER_CACHE_MS = 30_000;
const HOST_ADDR_CACHE_MS = 5 * 60_000;
const USER_CACHE_MS = 60_000;
const PRUNE_EVERY_MS = 60 * 60_000;
const GEO_QUEUE_MAX = 500;
const GEO_NEGATIVE_MS = 30 * 60_000;
const GEO_POSITIVE_MS = 24 * 60 * 60_000;

export const onlineSnapshots = new OnlineSnapshotStore();

// ---------- 正在看 ----------

let watchUntil = 0;

export function isOnlineIpsWatching(now = Date.now()) {
  return watchUntil > now;
}

/** UI 开着在线 IP 时每 20 秒调一次。从「没人看」变成「有人看」时叫醒所有能跑扩展通道的 Agent。 */
export async function markOnlineIpsWatching(now = Date.now()) {
  const wasWatching = isOnlineIpsWatching(now);
  watchUntil = now + WATCH_TTL_MS;
  if (wasWatching) return { woke: 0 };
  let woke = 0;
  const hosts = await queryRaw<{ id: number; agentVersion: string | null }>(
    `SELECT ${q("id")}, ${q("agentVersion")} FROM ${q("hosts")}`,
  ).catch(() => []);
  for (const host of hosts) {
    if (hostSupportsAgentExt(host) && wakeAgentExt(Number(host.id), "online-ips-watch")) woke += 1;
  }
  return { woke };
}

export function onlineIntervalSeconds() {
  return isOnlineIpsWatching() ? ONLINE_WATCH_INTERVAL_SECONDS : ONLINE_IDLE_INTERVAL_SECONDS;
}

// ---------- 端口归属 ----------

const ownerCache = new Map<number, { at: number; owners: OnlinePortOwner[] }>();

export async function loadHostPortOwners(hostId: number, force = false): Promise<OnlinePortOwner[]> {
  const cached = ownerCache.get(hostId);
  if (!force && cached && Date.now() - cached.at < OWNER_CACHE_MS) return cached.owners;
  const rules = await queryRaw<any>(
    `SELECT ${q("id")}, ${q("userId")}, ${q("name")}, ${q("sourcePort")}, ${q("protocol")}, ${q("forwardType")} FROM ${q("forward_rules")}
     WHERE ${q("hostId")} = ? AND ${q("pendingDelete")} = ? AND ${q("isEnabled")} = ? AND ${q("isForwardGroupTemplate")} = ?`,
    [hostId, false, true, false],
  );
  const inbounds = await queryRaw<any>(
    `SELECT ${q("id")}, ${q("userId")}, ${q("name")}, ${q("port")}, ${q("protocol")} FROM ${q("proxy_inbounds")}
     WHERE ${q("hostId")} = ? AND ${q("isEnabled")} = ?`,
    [hostId, true],
  );
  const byPort = new Map<number, OnlinePortOwner>();
  for (const rule of rules) {
    const port = Number(rule.sourcePort);
    if (!(port > 0 && port <= 65535) || byPort.has(port)) continue;
    const forwardType = String(rule.forwardType || "").toLowerCase();
    byPort.set(port, {
      port,
      proto: ruleTransportProto(rule.protocol),
      ruleId: Number(rule.id),
      inboundId: 0,
      userId: Number(rule.userId) || 0,
      dnat: forwardType === "iptables" || forwardType === "nftables",
      label: `规则 · ${String(rule.name || `#${rule.id}`)}`,
    });
  }
  for (const inbound of inbounds) {
    const port = Number(inbound.port);
    if (!(port > 0 && port <= 65535) || byPort.has(port)) continue;
    byPort.set(port, {
      port,
      proto: inboundTransportProto(inbound.protocol),
      ruleId: 0,
      inboundId: Number(inbound.id),
      userId: Number(inbound.userId) || 0,
      dnat: false,
      label: `入站 · ${String(inbound.name || `#${inbound.id}`)}`,
    });
  }
  const owners = Array.from(byPort.values()).sort((a, b) => a.port - b.port);
  ownerCache.set(hostId, { at: Date.now(), owners });
  return owners;
}

export function cachedOwnerLabel(hostId: number, port: number) {
  return ownerCache.get(hostId)?.owners.find((owner) => owner.port === port)?.label || null;
}

// ---------- 本面板主机自己的地址（不算客户端） ----------

let hostAddrCache: { at: number; ips: Set<string> } | null = null;

async function panelHostAddresses() {
  if (hostAddrCache && Date.now() - hostAddrCache.at < HOST_ADDR_CACHE_MS) return hostAddrCache.ips;
  const rows = await queryRaw<any>(
    `SELECT ${q("ip")}, ${q("ipv4")}, ${q("ipv6")}, ${q("entryIp")}, ${q("tunnelEntryIp")} FROM ${q("hosts")}`,
  ).catch(() => []);
  const ips = new Set<string>();
  for (const row of rows) {
    for (const value of [row.ip, row.ipv4, row.ipv6, row.entryIp, row.tunnelEntryIp]) {
      const text = String(value || "").trim().toLowerCase();
      if (text) ips.add(text.replace(/^\[|\]$/g, ""));
    }
  }
  hostAddrCache = { at: Date.now(), ips };
  return ips;
}

// ---------- 用户（名字 + 上限） ----------

type UserInfo = { id: number; name: string; maxIPs: number };
const userCache = new Map<number, { at: number; info: UserInfo | null }>();

export async function loadUsers(userIds: number[]): Promise<Map<number, UserInfo>> {
  const out = new Map<number, UserInfo>();
  const missing: number[] = [];
  const now = Date.now();
  for (const id of new Set(userIds.filter((v) => v > 0))) {
    const cached = userCache.get(id);
    if (cached && now - cached.at < USER_CACHE_MS) {
      if (cached.info) out.set(id, cached.info);
    } else {
      missing.push(id);
    }
  }
  for (let i = 0; i < missing.length; i += 200) {
    const chunk = missing.slice(i, i + 200);
    const rows = await queryRaw<any>(
      `SELECT ${q("id")}, ${q("username")}, ${q("name")}, ${q("maxIPs")} FROM ${q("users")} WHERE ${q("id")} IN (${chunk.map(() => "?").join(", ")})`,
      chunk,
    ).catch(() => []);
    const found = new Set<number>();
    for (const row of rows) {
      const info: UserInfo = {
        id: Number(row.id),
        name: String(row.name || row.username || `用户 #${row.id}`),
        maxIPs: Math.max(0, Number(row.maxIPs) || 0),
      };
      found.add(info.id);
      out.set(info.id, info);
      userCache.set(info.id, { at: now, info });
    }
    for (const id of chunk) if (!found.has(id)) userCache.set(id, { at: now, info: null });
  }
  return out;
}

// ---------- 地区 ----------

const geoLabels = new Map<string, { label: string | null; at: number }>();
const geoQueue: string[] = [];
const geoQueued = new Set<string>();
let geoWorking = false;

function geoFresh(ip: string, now = Date.now()) {
  const entry = geoLabels.get(ip);
  if (!entry) return false;
  return now - entry.at < (entry.label ? GEO_POSITIVE_MS : GEO_NEGATIVE_MS);
}

/** 现在知道的地区；不知道就是 null（界面显示「未知」）。内网地址直接说「内网」。 */
export function ipRegionLabel(ip: string): string | null {
  const kind = classifyIpAddress(ip);
  if (kind === "private" || kind === "linkLocal" || kind === "loopback") return "内网";
  return geoLabels.get(ip)?.label ?? null;
}

export function queueIpGeo(ips: Iterable<string>) {
  for (const ip of ips) {
    if (geoQueue.length >= GEO_QUEUE_MAX) break;
    if (geoQueued.has(ip) || geoFresh(ip) || isPrivateOrReservedAddress(ip)) continue;
    geoQueued.add(ip);
    geoQueue.push(ip);
  }
  if (!geoWorking && geoQueue.length > 0) void runGeoQueue();
}

const regionNames = (() => {
  try {
    return new Intl.DisplayNames(["zh-CN"], { type: "region" });
  } catch {
    return null;
  }
})();

function countryFlag(code: string) {
  return /^[A-Z]{2}$/.test(code)
    ? Array.from(code).map((char) => String.fromCodePoint(0x1f1e6 + char.charCodeAt(0) - 65)).join("")
    : "";
}

/** 「🇺🇸 美国 · California」：国家名按中文显示，省 / 州照离线库原样。 */
export function offlineRegionLabel(geo: { countryCode: string; countryName: string | null; region: string | null } | null) {
  if (!geo) return null;
  let country = geo.countryName || geo.countryCode;
  try {
    country = regionNames?.of(geo.countryCode) || country;
  } catch {
    // 认不出的代码保留原文
  }
  const region = geo.region && geo.region !== country && geo.region !== geo.countryName ? ` · ${geo.region}` : "";
  return `${[countryFlag(geo.countryCode), country].filter(Boolean).join(" ")}${region}`;
}

async function runGeoQueue() {
  geoWorking = true;
  try {
    while (geoQueue.length > 0) {
      const ip = geoQueue.shift()!;
      geoQueued.delete(ip);
      let label: string | null = null;
      try {
        label = offlineRegionLabel(await lookupOfflineIpRegion(ip));
      } catch {
        label = null;
      }
      geoLabels.set(ip, { label: label || null, at: Date.now() });
      if (geoLabels.size > 20_000) {
        const oldest = geoLabels.keys().next().value;
        if (oldest !== undefined) geoLabels.delete(oldest);
      }
      // 离线查很快，但一轮可能有几百个 IP：每个之间让一下事件循环。
      await new Promise((resolve) => setImmediate(resolve));
    }
  } finally {
    geoWorking = false;
  }
}

// ---------- 历史写库 ----------

const sightingState = new Map<string, { id: number; lastWrittenAt: number; maxConn: number; seenAt: number }>();
let writeChain: Promise<void> = Promise.resolve();
let lastPruneAt = 0;

function enqueueWrite(work: () => Promise<void>) {
  writeChain = writeChain.then(work).catch((error) => {
    console.warn(`[OnlineIps] history write failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  return writeChain;
}

async function persistSightings(rows: OnlineIpRow[], nowMs: number) {
  const nowSec = Math.floor(nowMs / 1000);
  // 同一个键在一轮里可能出现两次（tcp / udp 两个来源合并前），先按键合并取最大。
  const merged = new Map<string, OnlineIpRow>();
  for (const row of rows) {
    const key = sightingKey(row);
    const prev = merged.get(key);
    if (!prev || row.conns > prev.conns) merged.set(key, row);
  }
  for (const [key, row] of merged) {
    const state = sightingState.get(key);
    if (state) state.seenAt = nowMs;
    if (!shouldWriteSighting(state, row.conns, nowMs)) continue;
    if (state?.id) {
      const maxConn = Math.max(state.maxConn, row.conns);
      await executeRaw(
        `UPDATE ${q("ip_sightings")} SET ${q("lastSeenAt")} = ?, ${q("connCount")} = ? WHERE ${q("id")} = ?`,
        [nowSec, maxConn, state.id],
      );
      sightingState.set(key, { id: state.id, lastWrittenAt: nowMs, maxConn, seenAt: nowMs });
      continue;
    }
    const existing = await queryRaw<any>(
      `SELECT ${q("id")}, ${q("connCount")} FROM ${q("ip_sightings")}
       WHERE ${q("hostId")} = ? AND ${q("ip")} = ? AND ${q("userId")} = ? AND ${q("ruleId")} = ? AND ${q("inboundId")} = ?
       ORDER BY ${q("id")} DESC LIMIT 1`,
      [row.hostId, row.ip, row.userId, row.ruleId, row.inboundId],
    );
    if (existing[0]) {
      const id = Number(existing[0].id);
      const maxConn = Math.max(Number(existing[0].connCount) || 0, row.conns);
      await executeRaw(
        `UPDATE ${q("ip_sightings")} SET ${q("lastSeenAt")} = ?, ${q("connCount")} = ? WHERE ${q("id")} = ?`,
        [nowSec, maxConn, id],
      );
      sightingState.set(key, { id, lastWrittenAt: nowMs, maxConn, seenAt: nowMs });
    } else {
      const id = await insertAndGetId("ip_sightings", {
        hostId: row.hostId,
        ip: row.ip,
        userId: row.userId,
        ruleId: row.ruleId,
        inboundId: row.inboundId,
        firstSeenAt: Math.min(nowSec, row.since || nowSec),
        lastSeenAt: nowSec,
        connCount: row.conns,
      });
      sightingState.set(key, { id, lastWrittenAt: nowMs, maxConn: row.conns, seenAt: nowMs });
    }
  }
  // 十分钟没见过的键不用再记着（下次出现时查一次库就好）。
  if (sightingState.size > 5000 || Math.random() < 0.05) {
    for (const [key, state] of sightingState) {
      if (nowMs - state.seenAt > 10 * 60_000) sightingState.delete(key);
    }
  }
  if (nowMs - lastPruneAt >= PRUNE_EVERY_MS) {
    lastPruneAt = nowMs;
    const cutoff = nowSec - SIGHTING_RETENTION_DAYS * 86400;
    await executeRaw(`DELETE FROM ${q("ip_sightings")} WHERE ${q("lastSeenAt")} < ?`, [cutoff]);
  }
}

// ---------- 设备上限 ----------

const ipLimitEventAt = new Map<number, number>();
let lastLimitCheckAt = 0;

async function checkIpLimits(nowMs: number) {
  if (nowMs - lastLimitCheckAt < 10_000) return;
  lastLimitCheckAt = nowMs;
  const ipsByUser = distinctIpsByUser(onlineSnapshots.live(nowMs));
  if (ipsByUser.size === 0) return;
  const users = await loadUsers(Array.from(ipsByUser.keys()));
  const limits = new Map<number, number>();
  for (const [id, info] of users) limits.set(id, info.maxIPs);
  for (const hit of pickIpLimitExceeded(ipsByUser, limits, ipLimitEventAt, nowMs)) {
    const name = users.get(hit.userId)?.name || `用户 #${hit.userId}`;
    await recordPanelEvent({
      kind: "user.ip_limit_exceeded",
      level: "warn",
      userId: hit.userId,
      message: `${name} 同时在线 ${hit.count} 个 IP，超过上限 ${hit.limit} 个，新设备会连不上`,
      data: { count: hit.count, limit: hit.limit, ips: hit.ips.slice(0, 50) },
    });
  }
}

// ---------- 扩展通道 ----------

export async function onlineDirectiveFor(host: AgentExtHost) {
  if (!hostSupportsAgentExt(host)) return undefined;
  const owners = await loadHostPortOwners(Number(host.id));
  return {
    ports: owners.map((owner) => ({
      port: owner.port,
      proto: owner.proto,
      ...(owner.ruleId ? { ruleId: owner.ruleId } : {}),
      ...(owner.inboundId ? { inboundId: owner.inboundId } : {}),
      ...(owner.dnat ? { dnat: true } : {}),
    })),
  };
}

export async function ingestOnlineReport(host: AgentExtHost, raw: unknown) {
  const hostId = Number(host.id);
  const report = normalizeOnlineReport(raw);
  if (!hostId || !report) return;
  const nowMs = Date.now();
  const owners = await loadHostPortOwners(hostId);
  const ownersByPort = new Map(owners.map((owner) => [owner.port, owner]));
  const rows = buildOnlineRows(hostId, report, ownersByPort, await panelHostAddresses());
  onlineSnapshots.set(hostId, rows, nowMs, onlineIntervalSeconds());
  if (rows.length === 0) return;
  queueIpGeo(rows.map((row) => row.ip));
  void enqueueWrite(() => persistSightings(rows, nowMs));
  void checkIpLimits(nowMs).catch(() => undefined);
}

/** 测试 / 删主机时用。 */
export function resetOnlineIpsStateForTests() {
  onlineSnapshots.clear();
  ownerCache.clear();
  userCache.clear();
  sightingState.clear();
  ipLimitEventAt.clear();
  hostAddrCache = null;
  watchUntil = 0;
}
