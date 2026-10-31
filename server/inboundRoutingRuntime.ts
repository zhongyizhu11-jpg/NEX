/**
 * 落地节点分流的服务端那一半：把存着的分流规则（shared/inboundRouting.ts）解析成
 * sing-box 能用的路由 —— 主要是给每条规则挑好出口。
 *
 *   - 直连 / 拒绝：原样；
 *   - 走另一台落地：那台落地上的 Shadowsocks 入站（地址 + 端口 + 方法 + 密码现取，换密码不用回来改）。
 *     入站没了、停了、主人用不了了 → 这部分流量拒绝，不悄悄退回直连：用户选另一台落地
 *     就是不想从这台的 IP 出去（和转发规则的 SS 出口同一个原则）。落地离线照样指过去，
 *     面板看到的离线不一定真断，回来了也不用重新下发。
 *   - 自动挑解锁的落地：在这个入站主人能用的 SS 落地里，挑一台在线的、最新一次解锁检测里
 *     规则里每个服务都「可用」的。挑不出来就直连（界面上写明了），检测结果一变下次心跳就换。
 *
 * 用得着它的只有带分流的入站；一台机器上没有分流时一次查询都不多。
 */

import { getHostEntryAddress } from "../shared/hostEntryAddress";
import {
  inboundRouteDomainSuffixes,
  inboundRoutingShapeError,
  parseInboundRouting,
  type InboundRoute,
  type InboundRouting,
  type ResolvedInboundRoute,
} from "../shared/inboundRouting";
import { isProxyInboundShadowsocksMethod } from "../shared/proxyInbound";
import * as db from "./db";
import { isHostConsideredOnline } from "./hostHeartbeatPolicy";
import { latestUnlockStatusesByHostIds } from "./ops/unlock";
import { dbBool } from "./repositories/repositoryUtils";

export type RoutingLandingCandidate = {
  inboundId: number;
  inboundName: string;
  ownerId: number;
  landingEgress: boolean;
  enabled: boolean;
  hostId: number;
  hostName: string;
  hostUserId: number;
  online: boolean;
  server: string;
  port: number;
  method: string;
  password: string;
};

export type RoutingOwner = { id: number; role: string; allowedHostIds: ReadonlySet<number> };

export type RoutingContext = {
  candidates: readonly RoutingLandingCandidate[];
  /** hostId → 服务 → 最新检测结论。 */
  unlock: ReadonlyMap<number, ReadonlyMap<string, { status: string; checkedAt: number }>>;
};

/** 和规则的 SS 出口同一套：管理员都行；普通用户用自己的，或管理员开放的「落地出口」入站且有那台主机的权限。 */
export function routingLandingUsableBy(owner: RoutingOwner, candidate: RoutingLandingCandidate) {
  if (owner.role === "admin") return true;
  if (candidate.ownerId === owner.id) return true;
  if (!candidate.landingEgress) return false;
  return candidate.hostUserId === owner.id || owner.allowedHostIds.has(candidate.hostId);
}

function candidateUsable(candidate: RoutingLandingCandidate) {
  return candidate.enabled && !!candidate.server && candidate.port > 0 && !!candidate.password && isProxyInboundShadowsocksMethod(candidate.method);
}

function egressOf(candidate: RoutingLandingCandidate) {
  return { server: candidate.server, port: candidate.port, method: candidate.method, password: candidate.password };
}

/**
 * 自动挑：规则里每个服务都「可用」的在线落地。几台都行时挑最近检测过的那台（结果更可信），
 * 再按入站 id —— 同一份检测结果每次挑的都是同一台，不会每次心跳换来换去。
 */
export function pickAutoUnlockLanding(
  route: Pick<InboundRoute, "presets">,
  context: RoutingContext,
  owner: RoutingOwner,
  selfHostId: number,
): RoutingLandingCandidate | null {
  if (route.presets.length === 0) return null;
  let best: { candidate: RoutingLandingCandidate; checkedAt: number } | null = null;
  for (const candidate of context.candidates) {
    if (candidate.hostId === selfHostId || !candidate.online || !candidateUsable(candidate)) continue;
    if (!routingLandingUsableBy(owner, candidate)) continue;
    const services = context.unlock.get(candidate.hostId);
    if (!services) continue;
    let oldest = Infinity;
    let unlocked = true;
    for (const id of route.presets) {
      const result = services.get(id);
      if (!result || result.status !== "ok") {
        unlocked = false;
        break;
      }
      oldest = Math.min(oldest, result.checkedAt);
    }
    if (!unlocked) continue;
    if (!best || oldest > best.checkedAt || (oldest === best.checkedAt && candidate.inboundId < best.candidate.inboundId)) {
      best = { candidate, checkedAt: oldest };
    }
  }
  return best?.candidate || null;
}

export type ResolvedRouteView = ResolvedInboundRoute & {
  /** 给界面看的：这条最后去了哪、为什么。 */
  landingInboundId: number;
  landingName: string;
  note: string;
};

export function resolveInboundRoutes(
  routing: InboundRouting | null,
  context: RoutingContext,
  owner: RoutingOwner,
  selfHostId: number,
): ResolvedRouteView[] {
  if (!routing) return [];
  return routing.routes.map((route) => {
    const domainSuffix = inboundRouteDomainSuffixes(route);
    if (route.target === "block") return { domainSuffix, action: "block", landingInboundId: 0, landingName: "", note: "拒绝" };
    if (route.target === "direct") return { domainSuffix, action: "direct", landingInboundId: 0, landingName: "", note: "直连" };
    if (route.target === "landing") {
      const candidate = context.candidates.find((item) => item.inboundId === route.landingInboundId);
      const name = candidate ? `${candidate.hostName} · ${candidate.inboundName}` : "";
      let problem = "";
      if (!candidate) problem = "选的落地入站已被删除";
      else if (candidate.hostId === selfHostId) problem = "选的落地就是这台机器";
      else if (!routingLandingUsableBy(owner, candidate)) problem = "这个节点的主人用不了选的落地";
      else if (!candidateUsable(candidate)) problem = candidate.enabled ? "选的落地入站没有可用地址或加密方式不支持" : "选的落地入站已停用";
      if (problem) return { domainSuffix, action: "block", landingInboundId: route.landingInboundId, landingName: name, note: `${problem}，这部分流量先拒绝` };
      return {
        domainSuffix,
        action: "shadowsocks",
        egress: egressOf(candidate!),
        landingInboundId: candidate!.inboundId,
        landingName: name,
        note: candidate!.online ? `走「${name}」` : `走「${name}」（落地当前离线）`,
      };
    }
    const picked = pickAutoUnlockLanding(route, context, owner, selfHostId);
    if (!picked) {
      return { domainSuffix, action: "direct", landingInboundId: 0, landingName: "", note: "没有在线且检测为可用的落地，暂时直连" };
    }
    const name = `${picked.hostName} · ${picked.inboundName}`;
    return { domainSuffix, action: "shadowsocks", egress: egressOf(picked), landingInboundId: picked.inboundId, landingName: name, note: `自动选了「${name}」` };
  });
}

/* ── 查库 ─────────────────────────────────────────────────────────── */

const CONTEXT_CACHE_MS = 30_000;
let contextCache: { value: RoutingContext; at: number } | null = null;

/** 落地入站改了（密码、端口、启停、删除）或者检测出了新结果：下一次心跳重新取。 */
export function invalidateInboundRoutingContext() {
  contextCache = null;
}

/** 全部 SS 入站 + 它们所在主机 + 这些主机的最新解锁结论。30 秒缓存：每台落地每次心跳都会问。 */
export async function loadRoutingContext(now = Date.now()): Promise<RoutingContext> {
  if (contextCache && now - contextCache.at < CONTEXT_CACHE_MS) return contextCache.value;
  // 落地池的成员入站不当分流落地（跟着池走，池里去掉那台它就没了）
  const inbounds = ((await db.getAllProxyInbounds()) as any[]).filter((row) => String(row.protocol) === "shadowsocks" && !(Number(row.nodePoolId || 0) > 0));
  const hostIds = Array.from(new Set(inbounds.map((row) => Number(row.hostId)).filter((id) => id > 0)));
  const hosts = hostIds.length > 0 ? ((await db.getHostsByIds(hostIds)) as any[]) : [];
  const hostById = new Map(hosts.map((host) => [Number(host.id), host]));
  const candidates: RoutingLandingCandidate[] = [];
  for (const row of inbounds) {
    const host = hostById.get(Number(row.hostId));
    if (!host) continue;
    candidates.push({
      inboundId: Number(row.id),
      inboundName: String(row.name || `#${row.id}`),
      ownerId: Number(row.userId || 0),
      landingEgress: dbBool(row.landingEgress),
      enabled: dbBool(row.isEnabled, true),
      hostId: Number(host.id),
      hostName: String(host.name || `#${host.id}`),
      hostUserId: Number(host.userId || 0),
      online: isHostConsideredOnline(host),
      server: getHostEntryAddress(host) || "",
      port: Number(row.port) || 0,
      method: String(row.method || ""),
      password: String(row.password || ""),
    });
  }
  const unlock = await latestUnlockStatusesByHostIds(hostIds);
  const value = { candidates, unlock };
  contextCache = { value, at: now };
  return value;
}

/**
 * 按谁的权限挑落地：一般是入站主人；面板克隆给租户的专属端口（clonedFromInboundId）按源入站的主人 ——
 * 分流是源入站上配的、复制过来的，租户自己用不了管理员的落地，不该因此被拒绝。
 */
async function routingOwnerIdOf(row: { userId?: unknown; clonedFromInboundId?: unknown }) {
  const sourceId = Number(row.clonedFromInboundId || 0);
  if (sourceId > 0) {
    const source = await db.getProxyInboundById(sourceId) as any;
    if (source) return Number(source.userId || 0);
  }
  return Number(row.userId || 0);
}

export async function loadRoutingOwner(userId: number): Promise<RoutingOwner> {
  const user = await db.getUserById(userId);
  const role = String((user as any)?.role || "user");
  const allowed = role === "admin" ? [] : await db.getUserEffectiveAllowedHostIds(userId);
  return { id: Number(userId), role, allowedHostIds: new Set(allowed.map(Number)) };
}

/**
 * 心跳用：这台主机上每个带分流的入站，解析好的路由。没有分流的入站不在 Map 里。
 */
export async function resolveHostInboundRoutes(
  hostId: number,
  rows: readonly { id: number; userId: number; clonedFromInboundId?: number; routingJson: string | null }[],
): Promise<Map<number, ResolvedInboundRoute[]>> {
  const out = new Map<number, ResolvedInboundRoute[]>();
  const withRouting = rows
    .map((row) => ({ row, routing: parseInboundRouting(row.routingJson) }))
    .filter((item) => !!item.routing);
  if (withRouting.length === 0) return out;
  const context = await loadRoutingContext();
  const owners = new Map<number, RoutingOwner>();
  for (const { row, routing } of withRouting) {
    const ownerId = await routingOwnerIdOf(row);
    if (!owners.has(ownerId)) owners.set(ownerId, await loadRoutingOwner(ownerId));
    const resolved = resolveInboundRoutes(routing, context, owners.get(ownerId)!, hostId);
    out.set(row.id, resolved.map(({ domainSuffix, action, egress }) => ({ domainSuffix, action, ...(egress ? { egress } : {}) })));
  }
  return out;
}

/** 有哪些入站在分流里点名用了这个落地入站（删除保护、改密码后催下发用）。 */
export async function getInboundsRoutingVia(landingInboundId: number) {
  const rows = (await db.getAllProxyInbounds()) as any[];
  return rows.filter((row) => {
    if (Number(row.id) === Number(landingInboundId)) return false;
    const routing = parseInboundRouting(row.routingJson);
    return !!routing?.routes.some((route) => route.target === "landing" && route.landingInboundId === Number(landingInboundId));
  });
}

/** 点名用这个落地的入站所在的主机：落地改了密码 / 端口 / 启停，它们要马上换配置。 */
export async function refreshInboundRoutingDependents(landingInboundId: number, reason: string) {
  invalidateInboundRoutingContext();
  const { pushAgentRefresh } = await import("./agentEvents");
  const hostIds = new Set((await getInboundsRoutingVia(landingInboundId)).map((row: any) => Number(row.hostId)));
  for (const hostId of hostIds) pushAgentRefresh(hostId, reason, { urgent: true });
}

/**
 * 保存分流前的检查：形态、点名的落地存在且是 Shadowsocks、不是同一台机器、节点主人用得了。
 * 返回规整后的存储值（null = 不分流）。
 */
export async function validateInboundRoutingForSave(raw: unknown, options: { ownerId: number; hostId: number }) {
  const shape = inboundRoutingShapeError(raw);
  if (shape) throw new Error(shape);
  const routing = parseInboundRouting(raw);
  if (!routing) return null;
  const owner = await loadRoutingOwner(options.ownerId);
  for (const [index, route] of routing.routes.entries()) {
    if (route.target !== "landing") continue;
    const label = `第 ${index + 1} 条分流`;
    const inbound = await db.getProxyInboundById(route.landingInboundId) as any;
    if (!inbound) throw new Error(`${label}选的落地入站不存在`);
    if (String(inbound.protocol) !== "shadowsocks") throw new Error(`${label}只能选 Shadowsocks 落地入站`);
    if (Number(inbound.hostId) === Number(options.hostId)) throw new Error(`${label}选的落地就是这台机器，不用分流`);
    const host = await db.getHostById(Number(inbound.hostId)) as any;
    if (!host) throw new Error(`${label}选的落地主机不存在`);
    const usable = routingLandingUsableBy(owner, {
      inboundId: Number(inbound.id),
      ownerId: Number(inbound.userId || 0),
      landingEgress: dbBool(inbound.landingEgress),
      hostId: Number(host.id),
      hostUserId: Number(host.userId || 0),
    } as RoutingLandingCandidate);
    if (!usable) throw new Error(`${label}：这个节点的主人用不了「${inbound.name}」（只能用自己的落地，或管理员开放的落地出口）`);
  }
  return routing;
}

/** 编辑器里「走哪台落地」的选项：操作者能用的 SS 落地，带各服务的最新检测结论。 */
export async function listRoutingLandingOptions(actor: { id: number; role: string }) {
  const context = await loadRoutingContext();
  const owner = await loadRoutingOwner(actor.id);
  return context.candidates
    .filter((candidate) => routingLandingUsableBy(owner, candidate))
    .map((candidate) => {
      const services = context.unlock.get(candidate.hostId);
      return {
        inboundId: candidate.inboundId,
        name: `${candidate.hostName} · ${candidate.inboundName}`,
        hostId: candidate.hostId,
        port: candidate.port,
        online: candidate.online,
        enabled: candidate.enabled,
        unlock: services ? Object.fromEntries(Array.from(services.entries()).map(([id, value]) => [id, value.status])) : {},
        checkedAt: services ? Math.max(0, ...Array.from(services.values()).map((value) => value.checkedAt)) : 0,
      };
    })
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
}

/** 列表里每个带分流的入站，现在每条分流实际去了哪。 */
export async function describeInboundRoutingStatus(rows: readonly any[]) {
  const out = new Map<number, Array<{ note: string; action: string; landingName: string }>>();
  const withRouting = rows.map((row) => ({ row, routing: parseInboundRouting(row.routingJson) })).filter((item) => !!item.routing);
  if (withRouting.length === 0) return out;
  const context = await loadRoutingContext();
  const owners = new Map<number, RoutingOwner>();
  for (const { row, routing } of withRouting) {
    const ownerId = await routingOwnerIdOf(row);
    if (!owners.has(ownerId)) owners.set(ownerId, await loadRoutingOwner(ownerId));
    out.set(Number(row.id), resolveInboundRoutes(routing, context, owners.get(ownerId)!, Number(row.hostId))
      .map((view) => ({ note: view.note, action: view.action, landingName: view.landingName })));
  }
  return out;
}
