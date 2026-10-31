import { and, asc, eq, inArray, like, or } from "drizzle-orm";

import { forwardRules, proxyInboundUsers, proxyNodes } from "../drizzle/schema";
import { appendPanelLog } from "./_core/panelLogger";
import { pushAgentRefresh } from "./agentEvents";
import * as db from "./db";
import { getDb, insertAndGetId, nowDate } from "./dbRuntime";
import { withKeyedTaskLock } from "./keyedTaskLock";
import { getNodePool, listNodePools, updateNodePool, type NodePool } from "./nodePools";
import { invalidateProxySubCacheForUser } from "./proxySubCache";
import {
  generateProxyInboundPassword,
  generateProxyInboundPsk,
  generateProxyInboundUuid,
  generateRealityKeyPair,
  generateRealityShortId,
} from "./proxyRealityKeys";
import { dbBool } from "./repositories/repositoryUtils";
import { getHostEntryAddress } from "../shared/hostEntryAddress";
import {
  landingConfigToInbound,
  landingMemberPort,
  landingPoolDnsValues,
  landingPoolPrimary,
  landingUserCredentialKinds,
  MAX_LANDING_POOL_MEMBERS,
  MAX_LANDING_POOL_USERS,
  parseLandingConfig,
  parseLandingState,
  serializeLandingConfig,
  serializeLandingState,
  withLandingDefaults,
  type LandingConfig,
  type LandingMemberHealth,
  type LandingMemberState,
} from "../shared/landingPool";
import {
  PROXY_INBOUND_DEFAULT_REALITY_SERVER_NAME,
  proxyInboundShadowsocksKeyBytes,
  proxyInboundSupportsMultiUser,
  proxyNodesFromInbound,
  type ProxyInboundUser,
} from "../shared/proxyInbound";
import { parseRoutePaths } from "../shared/routeGroup";

/*
  落地池（2.3.500）的同步：池的那一份配置（node_pools.landingJson，shared/landingPool.ts）→
    · 每台成员机上一个入站（proxy_inbounds.nodePoolId），凭据、用户、密钥逐字相同；某台的端口被占了
      换一个（开了域名直连时不换，那台不开并报出来）；成员去掉了，那台的入站收掉；
    · 订阅里的池节点（proxy_nodes.nodePoolId）：一份凭据一条，地址是直连域名，没设域名就是首选那台；
    · 用到这个池的转发 / 线路：线路组按成员重新展开、重新解析每台的地址端口；只能指向一台的普通转发
      跟着首选走（server/proxyNodeFollow.ts）；
    · 设了直连域名：DNS 只解析到能用的成员（server/ddns.ts），变了才写。

  谁来叫它：保存 / 删掉节点池（lineDiagnostics.nodePoolSave / nodePoolDelete）、换密钥、分享发收凭据、
  成员机换了地址（proxyInboundRepository.syncProxyNodesForHostAddress）、每分钟看一次健康
  （scheduler：首选换没换、DNS 该不该改）。同一个池同一时间只跑一个（keyed lock）。
*/

export type LandingActor = { id: number; role: string };

export type LandingSyncResult = {
  poolId: number;
  members: LandingMemberState[];
  /** 收掉了几台的入站（成员去掉了、开不出来了）。 */
  removed: number;
  /** 跟着重新展开 / 解析 / 改目标的转发条数。 */
  dependents: number;
  dnsError: string | null;
};

class LandingMemberError extends Error {}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------- 凭据

/**
 * 补齐这份配置要的凭据和密钥（已有的不动 —— 改个名字不该让所有客户端掉线）。多用户协议一个用户都没有时
 * 补一个「默认」。私钥只在这里生成、只存在池配置和成员入站上，不出接口。
 */
export function fillLandingCredentials(config: LandingConfig): LandingConfig {
  const next = withLandingDefaults({ ...config, users: config.users.map((user) => ({ ...user })) });
  if (proxyInboundSupportsMultiUser(next.protocol)) {
    if (next.users.length === 0) {
      next.users.push({ id: next.nextUserId, name: "默认", uuid: "", password: "", sharedUserId: 0 });
      next.nextUserId += 1;
    }
    const kinds = landingUserCredentialKinds(next.protocol);
    next.users = next.users.map((user) => ({
      ...user,
      uuid: kinds.includes("uuid") ? (user.uuid || generateProxyInboundUuid()) : "",
      password: kinds.includes("password") ? (user.password || generateProxyInboundPassword()) : "",
    }));
    next.password = "";
  } else {
    next.users = [];
  }
  if (next.protocol === "shadowsocks") {
    const bytes = proxyInboundShadowsocksKeyBytes(next.method);
    next.password = next.password || (bytes > 0 ? generateProxyInboundPsk(bytes) : generateProxyInboundPassword());
  } else if (next.protocol === "snell") {
    next.password = next.password || generateProxyInboundPsk(16);
  }
  if (next.security === "reality") {
    next.serverName = next.serverName || PROXY_INBOUND_DEFAULT_REALITY_SERVER_NAME;
    if (!next.realityPrivateKey || !next.realityPublicKey) {
      const pair = generateRealityKeyPair();
      next.realityPrivateKey = pair.privateKey;
      next.realityPublicKey = pair.publicKey;
    }
    next.realityShortId = next.realityShortId || generateRealityShortId();
  }
  return next;
}

/** 清掉全部凭据（换密钥、换协议 / 加密方式时），交给 fillLandingCredentials 重新生成。用户的编号和名字留着。 */
export function clearLandingCredentials(config: LandingConfig): LandingConfig {
  return {
    ...config,
    password: "",
    realityPrivateKey: "",
    realityPublicKey: "",
    realityShortId: "",
    users: config.users.map((user) => ({ ...user, uuid: "", password: "" })),
  };
}

// ---------------------------------------------------------------- 读

/** 这个池在成员机上开的入站（含停用的），按 id。 */
export async function getLandingMemberInbounds(poolId: number): Promise<any[]> {
  const database = await getDb();
  if (!database) return [];
  const { proxyInbounds } = await import("../drizzle/schema");
  return database.select().from(proxyInbounds).where(eq(proxyInbounds.nodePoolId, Number(poolId))).orderBy(asc(proxyInbounds.id)) as Promise<any[]>;
}

/** 这个池的池节点（一份凭据一条）。 */
export async function getLandingPoolNodes(poolId: number): Promise<any[]> {
  const database = await getDb();
  if (!database) return [];
  return database.select().from(proxyNodes).where(eq(proxyNodes.nodePoolId, Number(poolId))).orderBy(asc(proxyNodes.inboundUserId), asc(proxyNodes.id)) as Promise<any[]>;
}

function hostIpv4(host: any): string {
  const value = String(host?.ipv4 || "").trim();
  if (value) return value;
  const ip = String(host?.ip || "").trim();
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? ip : "";
}

/** 每台成员现在的样子：开出来没有、在不在线、对外地址、端口。 */
export async function landingMemberHealth(pool: NodePool, rows?: any[], states?: LandingMemberState[]): Promise<LandingMemberHealth[]> {
  const memberRows = rows ?? await getLandingMemberInbounds(pool.id);
  const memberStates = states ?? parseLandingState(pool.landingStateJson);
  const hostIds = pool.hostIds.slice(0, MAX_LANDING_POOL_MEMBERS);
  const hosts = hostIds.length > 0 ? await db.getHostsByIds(hostIds) as any[] : [];
  const hostById = new Map(hosts.map((host) => [Number(host.id), host]));
  return hostIds.map((hostId) => {
    const row = memberRows.find((item) => Number(item.hostId) === hostId);
    const state = memberStates.find((item) => item.hostId === hostId);
    const host = hostById.get(hostId);
    return {
      hostId,
      ready: !!row && dbBool(row.isEnabled, true) && !state?.error,
      healthy: !!host && dbBool(host.isOnline) && !dbBool(host.maintenanceMode),
      address: getHostEntryAddress(host),
      ipv4: hostIpv4(host),
      port: Number(row?.port || 0),
    };
  });
}

// ---------------------------------------------------------------- 成员入站

/** 这个端口在这台机器上被别的东西占了吗（别的落地入站、转发规则、隧道监听；不算这个成员自己）。 */
async function portBusyOnHost(hostId: number, port: number, selfInboundId?: number): Promise<boolean> {
  if (!(port > 0)) return true;
  const conflict = await db.findProxyInboundPortConflict(hostId, port, Number(selfInboundId || 0));
  if (conflict) return true;
  return db.isPortUsedOnHost(hostId, port, undefined, "both", undefined, true, undefined, Number(selfInboundId || 0) || undefined);
}

function sameColumn(left: unknown, right: unknown) {
  if (typeof left === "boolean" || typeof right === "boolean") return dbBool(left) === dbBool(right);
  return String(left ?? "") === String(right ?? "");
}

/**
 * 成员入站的用户照池的用户写：凭据一样的那一行留着（id 不变，sing-box 里的名字不变），其余插入；
 * 池里没有了的删掉 —— 包括分享时单独发的那种（池里收回了就是收回了，和单台入站的「表单没带上先留着」不同）。
 */
async function replaceMemberUsers(inboundId: number, users: readonly ProxyInboundUser[]) {
  const database = await getDb();
  if (!database) throw new Error("Database not available");
  const existing = await db.getProxyInboundUsers(inboundId);
  const keep = new Set<number>();
  for (const [index, user] of users.entries()) {
    const data = {
      inboundId,
      name: String(user.name || "").slice(0, 64),
      uuid: user.uuid || null,
      password: user.password || null,
      sharedUserId: Number(user.sharedUserId || 0),
      sortOrder: index,
    };
    const current = user.id > 0 ? existing.find((item) => item.id === user.id) : undefined;
    if (current) {
      keep.add(current.id);
      const same = current.name === data.name && current.uuid === (data.uuid || "") && current.password === (data.password || "") && Number(current.sharedUserId || 0) === data.sharedUserId;
      if (!same) await database.update(proxyInboundUsers).set({ ...data, updatedAt: nowDate() } as any).where(eq(proxyInboundUsers.id, current.id));
      else await database.update(proxyInboundUsers).set({ sortOrder: index } as any).where(eq(proxyInboundUsers.id, current.id));
    } else {
      keep.add(Number(await insertAndGetId("proxy_inbound_users", data as any)));
    }
  }
  for (const item of existing) {
    if (!keep.has(item.id)) await database.delete(proxyInboundUsers).where(eq(proxyInboundUsers.id, item.id));
  }
}

/** 一台成员的入站照池配置写一遍；没变就不写（不变就不重推，sing-box 不重载）。 */
async function upsertMemberInbound(pool: NodePool, config: LandingConfig, host: any, row: any | undefined, port: number, owner: LandingActor): Promise<{ id: number; changed: boolean }> {
  const { inboundNeedsHostGrant } = await import("./routers/proxyInbounds");
  const userRows = row ? await db.getProxyInboundUsers(Number(row.id)) : [];
  // 池用户 → 这台入站上那一行：凭据一样就是同一个人
  const userIds = new Map<number, number>();
  for (const user of config.users) {
    const match = userRows.find((item) => item.uuid === user.uuid && item.password === user.password && !Array.from(userIds.values()).includes(item.id));
    if (match) userIds.set(user.id, match.id);
  }
  const inbound = landingConfigToInbound({ ...config, port }, pool.name.slice(0, 64) || "落地池", userIds);
  const data: Record<string, unknown> = {
    userId: pool.userId,
    hostId: Number(host.id),
    name: pool.name.slice(0, 64) || "落地池",
    remark: `落地池「${pool.name}」的成员`,
    nodePoolId: pool.id,
    isEnabled: true,
    hostGrantRequired: inboundNeedsHostGrant({ user: owner }, host),
    landingEgress: false,
    ...db.proxyInboundToRow(inbound),
  };
  if (row) {
    const usersChanged = userRows.length !== inbound.users.length
      || inbound.users.some((user, index) => {
        const current = userRows[index];
        return !current || current.id !== user.id || current.name !== user.name || Number(current.sharedUserId || 0) !== Number(user.sharedUserId || 0);
      });
    const rowChanged = Object.entries(data).some(([key, value]) => !sameColumn((row as any)[key], value));
    if (rowChanged) await db.updateProxyInbound(Number(row.id), data as any);
    if (usersChanged) await replaceMemberUsers(Number(row.id), inbound.users);
    return { id: Number(row.id), changed: rowChanged || usersChanged };
  }
  const id = Number(await db.createProxyInbound(data as any));
  await replaceMemberUsers(id, inbound.users);
  return { id, changed: true };
}

// ---------------------------------------------------------------- 池节点

/**
 * 池节点照池配置写：一份凭据一条（多用户协议一个池用户一条，分享时单独发的那份也是一条，标着收件人）。
 * 地址：设了直连域名就是域名（订阅里那条直连连它），否则是首选那台（订阅里不出直连，只给普通转发跟着用）。
 * 一台都开不出来时停用（不删：转发上的绑定、订阅里的名字留着，机器回来就接着用）。
 */
async function syncPoolNodes(pool: NodePool, config: LandingConfig, health: LandingMemberHealth[], options: { domainChanged?: boolean }) {
  const database = await getDb();
  if (!database) throw new Error("Database not available");
  const primary = landingPoolPrimary(health);
  const address = pool.directDomain || primary?.address || "";
  const port = pool.directDomain ? config.port : Number(primary?.port || config.port);
  const anyReady = health.some((member) => member.ready);
  const existing = await getLandingPoolNodes(pool.id);
  const moved: number[] = [];
  const kept = new Set<number>();
  const recipients = new Set<number>();

  if (!address) {
    for (const node of existing) {
      kept.add(Number(node.id));
      if (dbBool(node.isEnabled, true)) await database.update(proxyNodes).set({ isEnabled: false, updatedAt: nowDate() } as any).where(eq(proxyNodes.id, Number(node.id)));
    }
  } else {
    const inbound = landingConfigToInbound({ ...config, port }, pool.name || "落地池");
    for (const { user, node } of proxyNodesFromInbound(inbound, { address })) {
      const inboundUserId = Number(user?.id || 0);
      const poolSharedUserId = Number(user?.sharedUserId || 0);
      if (poolSharedUserId > 0) recipients.add(poolSharedUserId);
      const data: Record<string, unknown> = {
        userId: pool.userId,
        nodePoolId: pool.id,
        inboundId: 0,
        inboundUserId,
        poolSharedUserId,
        name: node.name,
        remark: pool.note || null,
        protocol: node.protocol,
        address: node.address,
        port: node.port,
        uuid: node.uuid || null,
        password: node.password || null,
        method: node.method || null,
        alterId: node.alterId,
        flow: node.flow || null,
        transport: node.transport,
        path: node.path || null,
        host: node.host || null,
        tls: node.tls,
        sni: node.sni || null,
        alpn: node.alpn.length ? node.alpn.join(",") : null,
        fingerprint: node.fingerprint || null,
        allowInsecure: node.allowInsecure,
        realityPublicKey: node.realityPublicKey || null,
        realityShortId: node.realityShortId || null,
        udp: node.udp,
        obfs: node.obfs || null,
        obfsPassword: node.obfsPassword || null,
        snellVersion: node.snellVersion,
        snellMode: node.snellMode || null,
        isEnabled: anyReady,
        ...(!pool.directDomain ? { includeDirect: false } : options.domainChanged ? { includeDirect: true } : {}),
      };
      const current = existing.find((item) => Number(item.inboundUserId || 0) === inboundUserId);
      if (current) {
        kept.add(Number(current.id));
        if (Object.entries(data).some(([key, value]) => !sameColumn(current[key], value))) {
          await database.update(proxyNodes).set({ ...data, updatedAt: nowDate() } as any).where(eq(proxyNodes.id, Number(current.id)));
        }
        if (!sameColumn(current.address, data.address) || !sameColumn(current.port, data.port)) moved.push(Number(current.id));
      } else {
        const created = Number(await insertAndGetId("proxy_nodes", { includeDirect: !!pool.directDomain, ...data } as any));
        kept.add(created);
      }
    }
  }
  // 池里删掉的用户：它那条池节点走 deleteProxyNode（解绑转发、删分享记录、清订阅缓存）
  for (const node of existing) {
    if (kept.has(Number(node.id))) continue;
    if (Number(node.poolSharedUserId || 0) > 0) recipients.add(Number(node.poolSharedUserId));
    await db.deleteProxyNode(Number(node.id));
  }
  invalidateProxySubCacheForUser(pool.userId);
  for (const recipient of recipients) invalidateProxySubCacheForUser(recipient);
  const shares = await db.getProxyNodeShareUserIds(Array.from(kept));
  for (const users of shares.values()) for (const recipient of users) invalidateProxySubCacheForUser(recipient);
  return { nodeIds: Array.from(kept), moved };
}

// ---------------------------------------------------------------- 用到池的转发

/** 用到这个池的转发：绑着池节点的（目标是池），和线路的路径落在池节点上的。只算顶层规则（中继、组成员跟着父规则走）。 */
export async function rulesUsingLandingPool(poolId: number, nodeIds?: readonly number[]): Promise<any[]> {
  const ids = nodeIds ?? (await getLandingPoolNodes(poolId)).map((node) => Number(node.id));
  if (ids.length === 0) return [];
  const database = await getDb();
  if (!database) return [];
  const idSet = new Set(ids.map(Number));
  const bound = await database.select().from(forwardRules).where(and(inArray(forwardRules.proxyNodeId, ids.map(Number)), eq(forwardRules.pendingDelete, false))) as any[];
  // 路径里的 destNodeId：先用 LIKE 粗筛（"destNodeId":12 也会粗筛进 123），再解析出来精确比
  const withPaths = await database.select().from(forwardRules).where(and(
    eq(forwardRules.pendingDelete, false),
    or(...ids.map((id) => like(forwardRules.routePaths, `%"destNodeId":${Number(id)}%`))),
  )) as any[];
  const byId = new Map<number, any>();
  for (const rule of bound) byId.set(Number(rule.id), rule);
  for (const rule of withPaths) {
    if (!rule.routePaths || byId.has(Number(rule.id))) continue;
    if (parseRoutePaths(rule.routePaths).some((path) => Number(path.destNodeId || 0) > 0 && idSet.has(Number(path.destNodeId)))) byId.set(Number(rule.id), rule);
  }
  return Array.from(byId.values()).filter((rule) => !(Number(rule.forwardGroupRuleId || 0) > 0 && !dbBool(rule.isForwardGroupTemplate)) && !(Number(rule.routeParentRuleId || 0) > 0));
}

/**
 * 池变了之后让用到它的转发跟上：
 *   · 线路组：成员变了就重新展开（加一台多一条路径、去掉一台少一条），再按成员解析一遍地址端口；
 *   · 普通转发（只能指向一台）：池节点的首选换了，跟着首选走（proxyNodeFollow）。目标是池、能做成线路组的，
 *     在规则保存时就已经做成线路组了（server/landingRouteTarget.ts）；池从一台变成两台时这里补上。
 */
async function refreshLandingDependents(pool: NodePool, nodeIds: number[], moved: number[], membershipChanged: boolean, reason: string): Promise<number> {
  const rules = await rulesUsingLandingPool(pool.id, nodeIds);
  if (rules.length === 0) return 0;
  const { syncRouteRelayRulesForRule } = await import("./routeGroups");
  const { reexpandRouteLinesForRules } = await import("./routeLineExpansion");
  const { followBoundRulesToNode } = await import("./proxyNodeFollow");
  const { ensureLandingRouteGroupForRule } = await import("./landingRouteTarget");
  let count = 0;
  for (const rule of rules) {
    try {
      if (dbBool(rule.failoverEnabled) && rule.routePaths) {
        if (membershipChanged) await reexpandRouteLinesForRules([Number(rule.id)], reason);
        if (dbBool(rule.isForwardGroupTemplate) && Number(rule.forwardGroupId || 0) > 0) {
          const { syncForwardGroupRules } = await import("./repositories/forwardGroupRepository");
          await syncForwardGroupRules(Number(rule.forwardGroupId));
        } else {
          await syncRouteRelayRulesForRule(Number(rule.id), { reason });
        }
        count += 1;
      } else if (await ensureLandingRouteGroupForRule(Number(rule.id), reason)) {
        count += 1;
      }
    } catch (error) {
      appendPanelLog("warn", `[LandingPool] pool=${pool.id} rule=${rule.id} 跟着池更新失败：${errorText(error)}`);
    }
  }
  for (const nodeId of moved) {
    const followed = await followBoundRulesToNode(nodeId, `${reason}-primary`).catch((error) => {
      appendPanelLog("warn", `[LandingPool] pool=${pool.id} node=${nodeId} 普通转发跟着首选失败：${errorText(error)}`);
      return null;
    });
    count += followed?.retargeted.length || 0;
  }
  return count;
}

// ---------------------------------------------------------------- DNS

/** 直连域名：解析到能用的成员（和池同端口、有 IPv4）。一台能用的都没有时不动（别把记录写空）。 */
async function refreshLandingDns(pool: NodePool, config: LandingConfig, health: LandingMemberHealth[]): Promise<string | null> {
  if (!pool.directDomain) return null;
  const values = landingPoolDnsValues(health, config.port).sort();
  if (values.length === 0) return "没有能用的成员，域名先保持原来的解析";
  const serialized = values.join(",");
  if (serialized === pool.directDnsValue) return null;
  try {
    const { updateDdnsRecordValues } = await import("./ddns");
    await updateDdnsRecordValues({ domain: pool.directDomain, recordType: "A", values, ttl: 60, groupId: 0 });
    await updateNodePool(pool.id, { directDnsValue: serialized });
    appendPanelLog("info", `[LandingPool] pool=${pool.id} ${pool.directDomain} → ${serialized}`);
    return null;
  } catch (error) {
    const message = errorText(error);
    appendPanelLog("warn", `[LandingPool] pool=${pool.id} 写 DNS ${pool.directDomain} 失败：${message}`);
    return `写 DNS 失败：${message}`;
  }
}

// ---------------------------------------------------------------- 同步

async function retireLandingPool(poolId: number, rows: any[]): Promise<number> {
  const touched = new Set<number>();
  for (const row of rows) {
    await db.deleteProxyInbound(Number(row.id));
    touched.add(Number(row.hostId));
  }
  for (const node of await getLandingPoolNodes(poolId)) await db.deleteProxyNode(Number(node.id));
  if (touched.size > 0) {
    const { invalidateInboundRoutingContext } = await import("./inboundRoutingRuntime");
    invalidateInboundRoutingContext();
  }
  for (const hostId of touched) pushAgentRefresh(hostId, `landing-pool-${poolId}-retired`, { urgent: true });
  return rows.length;
}

/**
 * 照池的配置把每台成员、池节点、用到它的转发、DNS 都同步一遍。池不是落地池（或者还没配）就把开过的
 * 入站和池节点都收掉。domainChanged：直连域名刚设上 / 刚去掉，池节点的「进订阅」跟着改。
 */
export async function syncLandingPool(poolId: number, options: { reason: string; domainChanged?: boolean }): Promise<LandingSyncResult> {
  return withKeyedTaskLock(`landing-pool:${Number(poolId)}`, () => syncLandingPoolLocked(Number(poolId), options));
}

async function syncLandingPoolLocked(poolId: number, options: { reason: string; domainChanged?: boolean }): Promise<LandingSyncResult> {
  const result: LandingSyncResult = { poolId, members: [], removed: 0, dependents: 0, dnsError: null };
  const pool = await getNodePool(poolId);
  const rows = await getLandingMemberInbounds(poolId);
  const config = pool && pool.role === "landing" ? parseLandingConfig(pool.landingJson) : null;
  if (!pool || !config) {
    result.removed = await retireLandingPool(poolId, rows);
    if (pool && pool.landingStateJson) await updateNodePool(poolId, { landingStateJson: null });
    return result;
  }

  const ownerRow = await db.getUserById(pool.userId) as any;
  const owner: LandingActor = { id: pool.userId, role: String(ownerRow?.role || "user") };
  const allowed = owner.role === "admin" ? [] : await db.getUserEffectiveAllowedHostIds(owner.id).catch(() => [] as number[]);
  const { canOpenInboundOnHost, inboundPortPolicyError, assertInboundQuota } = await import("./routers/proxyInbounds");
  const memberHostIds = pool.hostIds.slice(0, MAX_LANDING_POOL_MEMBERS);
  const previous = parseLandingState(pool.landingStateJson);
  const touched = new Set<number>();
  const deleted = new Set<number>();
  const states: LandingMemberState[] = [];

  for (const hostId of memberHostIds) {
    const row = rows.find((item) => Number(item.hostId) === hostId);
    try {
      const host = await db.getHostById(hostId) as any;
      if (!host) throw new LandingMemberError("这台机器已经不在了");
      if (!canOpenInboundOnHost(owner, host, allowed, hostId)) throw new LandingMemberError("池的主人没有这台机器的使用权限");
      const requireSamePort = !!pool.directDomain;
      const currentPort = Number(row?.port || 0);
      const desiredBusy = await portBusyOnHost(hostId, config.port, row?.id);
      const currentFree = currentPort > 0 && currentPort !== config.port ? !(await portBusyOnHost(hostId, currentPort, row?.id)) : false;
      let fallbackPort = 0;
      if (desiredBusy && !requireSamePort && !currentFree) {
        fallbackPort = await db.pickFreeInboundPort(hostId).catch(() => 0);
      }
      const decision = landingMemberPort({ desiredPort: config.port, desiredFree: !desiredBusy, currentPort, currentFree, requireSamePort, fallbackPort });
      if (!decision.port) throw new LandingMemberError(decision.error || "端口不能用");
      const policyError = await inboundPortPolicyError({ user: owner }, host, decision.port);
      if (policyError) throw new LandingMemberError(policyError);
      if (!row) {
        try {
          await assertInboundQuota(pool.userId, { user: owner });
        } catch (error) {
          throw new LandingMemberError(errorText(error));
        }
      }
      const saved = await upsertMemberInbound(pool, config, host, row, decision.port, owner);
      if (saved.changed) touched.add(hostId);
      states.push({ hostId, inboundId: saved.id, port: decision.port, portFallback: decision.fallback, error: null });
    } catch (error) {
      const message = errorText(error);
      // 开不出来（端口、权限、额度）：那台的入站收掉，别留一个和池对不上的；意外的错留着下次再试
      if (row && error instanceof LandingMemberError) {
        await db.deleteProxyInbound(Number(row.id));
        deleted.add(Number(row.id));
        touched.add(hostId);
        result.removed += 1;
      }
      states.push({ hostId, inboundId: row && !(error instanceof LandingMemberError) ? Number(row.id) : 0, port: 0, portFallback: false, error: message.slice(0, 200) });
    }
  }
  // 池里去掉的机器（以及同一台上多出来的、上面已经收掉的以外）：入站收掉
  const keptIds = new Set(states.map((state) => state.inboundId).filter((id) => id > 0));
  for (const row of rows) {
    if (keptIds.has(Number(row.id)) || deleted.has(Number(row.id))) continue;
    await db.deleteProxyInbound(Number(row.id));
    touched.add(Number(row.hostId));
    result.removed += 1;
  }
  if (touched.size > 0) {
    const { invalidateInboundRoutingContext } = await import("./inboundRoutingRuntime");
    invalidateInboundRoutingContext();
  }
  for (const hostId of touched) pushAgentRefresh(hostId, `landing-pool-${poolId}`, { urgent: true });
  result.members = states;

  const fresh = await getLandingMemberInbounds(poolId);
  const health = await landingMemberHealth(pool, fresh, states);
  const { nodeIds, moved } = await syncPoolNodes(pool, config, health, { domainChanged: options.domainChanged });
  const before = new Map(previous.map((state) => [state.hostId, state]));
  const membershipChanged = states.length !== previous.length
    || states.some((state) => {
      const old = before.get(state.hostId);
      return !old || (!!old.error) !== (!!state.error) || old.port !== state.port;
    });
  await updateNodePool(poolId, { landingStateJson: serializeLandingState(states) });
  result.dependents = await refreshLandingDependents(pool, nodeIds, moved, membershipChanged, options.reason);
  result.dnsError = await refreshLandingDns(pool, config, health);
  if (touched.size > 0 || result.removed > 0) {
    appendPanelLog("info", `[LandingPool] pool=${poolId} (${options.reason}) ${states.filter((state) => !state.error).length}/${states.length} 台开着，收掉 ${result.removed} 台，${result.dependents} 条转发跟着更新`);
  }
  return result;
}

/**
 * 不改成员入站，只看健康：首选换没换（换了池节点地址跟着换、普通转发跟着走）、DNS 该不该改。
 * scheduler 每分钟跑一遍；成员机换了地址时也走它。
 */
export async function refreshLandingPoolHealth(poolId: number, reason: string): Promise<void> {
  await withKeyedTaskLock(`landing-pool:${Number(poolId)}`, async () => {
    const pool = await getNodePool(poolId);
    const config = pool && pool.role === "landing" ? parseLandingConfig(pool.landingJson) : null;
    if (!pool || !config) return;
    const health = await landingMemberHealth(pool);
    const { nodeIds, moved } = await syncPoolNodes(pool, config, health, {});
    if (moved.length > 0) await refreshLandingDependents(pool, nodeIds, moved, false, reason);
    await refreshLandingDns(pool, config, health);
  });
}

/** scheduler 用：所有配好的落地池看一遍健康。一个池出错不拦别的。 */
export async function refreshAllLandingPoolsHealth(): Promise<void> {
  const pools = (await listNodePools(null)).filter((pool) => pool.role === "landing" && pool.landingJson);
  for (const pool of pools) {
    await refreshLandingPoolHealth(pool.id, "landing-pool-health").catch((error) => {
      appendPanelLog("warn", `[LandingPool] pool=${pool.id} 健康检查失败：${errorText(error)}`);
    });
  }
}

/** 这台机器换了地址：它所在的落地池重新算池节点、线路解析、DNS。 */
export async function refreshLandingPoolsForHost(hostId: number, reason: string): Promise<void> {
  const pools = (await listNodePools(null)).filter((pool) => pool.role === "landing" && pool.landingJson && pool.hostIds.includes(Number(hostId)));
  for (const pool of pools) {
    try {
      await refreshLandingPoolHealth(pool.id, reason);
      const nodeIds = (await getLandingPoolNodes(pool.id)).map((node) => Number(node.id));
      await refreshLandingDependents(pool, nodeIds, [], false, reason);
    } catch (error) {
      appendPanelLog("warn", `[LandingPool] pool=${pool.id} 跟着主机 ${hostId} 换地址失败：${errorText(error)}`);
    }
  }
}

// ---------------------------------------------------------------- 配置的改动

/** 写进新配置（凭据补齐）并同步。config 为 null = 落地池不再有配置（收掉成员入站和池节点）。 */
export async function saveLandingConfig(poolId: number, config: LandingConfig | null, options: { reason: string; domainChanged?: boolean }) {
  await updateNodePool(poolId, { landingJson: config ? serializeLandingConfig(fillLandingCredentials(config)) : null });
  return syncLandingPool(poolId, options);
}

/** 换全部凭据和密钥（疑似泄漏时）：每台成员一起换，客户端要重新拉订阅。 */
export async function rotateLandingPoolCredentials(poolId: number): Promise<LandingSyncResult> {
  const pool = await getNodePool(poolId);
  const config = pool ? parseLandingConfig(pool.landingJson) : null;
  if (!pool || pool.role !== "landing" || !config) throw new Error("这个池还没配落地协议");
  return saveLandingConfig(poolId, clearLandingCredentials(config), { reason: "landing-pool-rotated" });
}

/** 删池 / 改回中转之前：有转发在用就不让（报出几条），免得转发指向一个收掉了的落地。 */
export async function assertLandingPoolUnused(poolId: number) {
  const rules = await rulesUsingLandingPool(poolId);
  if (rules.length > 0) {
    const names = rules.slice(0, 3).map((rule) => `「${String(rule.name || `#${rule.id}`)}」`).join("、");
    throw new Error(`还有 ${rules.length} 条转发在用这个落地池（${names}${rules.length > 3 ? " 等" : ""}）：先把它们的目标换掉`);
  }
}

// ---------------------------------------------------------------- 分享（每人一份凭据）

/** 这个池上，为分享单独发的凭据各自的池节点：收件人 → 节点 id。 */
export async function getSharedNodeIdsByLandingPool(poolId: number): Promise<Map<number, number>> {
  const result = new Map<number, number>();
  for (const node of await getLandingPoolNodes(poolId)) {
    const recipient = Number(node.poolSharedUserId || 0);
    if (recipient > 0) result.set(recipient, Number(node.id));
  }
  return result;
}

/** 池主人自己那份凭据的池节点（分享选择框里代表整个池的那一条）。 */
export async function anchorNodeIdForLandingPool(poolId: number): Promise<number> {
  const nodes = await getLandingPoolNodes(poolId);
  return Number((nodes.find((node) => !(Number(node.poolSharedUserId || 0) > 0)) || nodes[0])?.id || 0);
}

/**
 * 给某人在这个池上发一份凭据（已有就直接用）：池配置里加一个用户，每台成员都加上，派生一条池节点。
 * 只有多用户协议做得到；单用户协议（SS / Snell）返回 null，调用方退回「共用主人那一份」。
 */
export async function ensureSharedLandingCredential(poolId: number, recipient: number, label: string): Promise<{ nodeId: number; hostIds: number[] } | null> {
  const pool = await getNodePool(poolId);
  const config = pool && pool.role === "landing" ? parseLandingConfig(pool.landingJson) : null;
  if (!pool || !config || !proxyInboundSupportsMultiUser(config.protocol)) return null;
  if (!config.users.some((user) => user.sharedUserId === Number(recipient))) {
    if (config.users.length >= MAX_LANDING_POOL_USERS) return null;
    config.users.push({ id: config.nextUserId, name: label.slice(0, 64), uuid: "", password: "", sharedUserId: Number(recipient) });
    config.nextUserId += 1;
    await saveLandingConfig(poolId, config, { reason: "landing-pool-share" });
  }
  const nodeId = (await getSharedNodeIdsByLandingPool(poolId)).get(Number(recipient)) || 0;
  if (!nodeId) return null;
  return { nodeId, hostIds: pool.hostIds };
}

/** 收回某人在这个池上的那份凭据：每台成员都删掉，他的池节点跟着删（分享记录一起清）。 */
export async function releaseSharedLandingCredential(poolId: number, recipient: number): Promise<boolean> {
  const pool = await getNodePool(poolId);
  const config = pool ? parseLandingConfig(pool.landingJson) : null;
  if (!pool || !config) return false;
  if (!config.users.some((user) => user.sharedUserId === Number(recipient))) return false;
  config.users = config.users.filter((user) => user.sharedUserId !== Number(recipient));
  await saveLandingConfig(poolId, config, { reason: "landing-pool-unshare" });
  return true;
}

/** 这个人在哪些落地池上有单独发的凭据。 */
export async function getSharedLandingPoolIdsForUser(userId: number): Promise<number[]> {
  const pools = await listNodePools(null);
  return pools
    .filter((pool) => pool.role === "landing" && (parseLandingConfig(pool.landingJson)?.users || []).some((user) => user.sharedUserId === Number(userId)))
    .map((pool) => pool.id);
}
