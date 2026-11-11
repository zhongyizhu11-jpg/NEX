/*
  主机替换的执行和撤回。清点 / 预览见 ./plan.ts。

  执行：
    1. 重新清点、比指纹：预览之后数据变了就拒绝（让人重新预览，不在过时的计划上做）。
    2. 先在进程里占好新机上的端口（直连规则、隧道入口规则的监听端口），旧机上的老端口也占住给桥接用。
    3. 拿锁（隧道、转发组同步锁）→ 一个数据库事务：改引用、记替换记录，事务末尾在同一个事务里同步
       转发组（子规则在新机上重建，失败整体回滚）。
    4. 提交之后：中继同步、入口组 / 出口组刷新、节点池重新展开、隧道出口映射校正、旧入口桥接，
       最后给两台机器（和隧道各端）推刷新。
  旧机不删、不停机：引用都改走了，旧机上对应的监听随下一次下发撤掉；需要的话顺手把旧机设成维护。

  撤回：按单元来。先核对这个单元现在是不是还是我们改成的样子（之后有人改过就不碰，写进报告），
  再按反方向「替换」一遍（端口尽量用回原来的；原来的端口在旧机上被别的占了就跳过这个单元）。
*/
import { TRPCError } from "@trpc/server";
import * as db from "../db";
import { executeRaw, insertAndGetId, queryRaw, quoteDbIdentifier, rawEpochToDate } from "../dbRuntime";
import { appendPanelLog } from "../_core/panelLogger";
import { pushAgentRefresh } from "../agentEvents";
import { recordConfigAuditEvent } from "../configAudit";
import { withKeyedTaskLock } from "../keyedTaskLock";
import {
  releaseHostPortReservations,
  reserveAvailableHostPort,
  reserveSpecificHostPort,
  runWithHeldHostPortReservations,
  type HostPortReservation,
} from "../portReservations";
import { invalidateProxySubCacheAll } from "../proxySubCache";
import { dbBool } from "../repositories/repositoryUtils";
import { normalizeForwardRuleProtocol, normalizeForwardXVersion } from "../../shared/forwardTypes";
import { parseRoutePaths, routeGroupOf, type RouteGroupRule } from "../../shared/routeGroup";
import type { PortPolicySource } from "../../shared/portPolicy";
import type { InsertForwardRule, InsertTunnel } from "../../drizzle/schema";
import {
  HOST_REPLACE_CATEGORY_LABELS,
  HOST_REPLACE_RECORD_DAYS,
  defaultHostReplaceResolution,
  type HostReplaceCategory,
  type HostReplaceManualItem,
  type HostReplaceRecordSummary,
  type HostReplaceResolution,
} from "../../shared/hostReplace";
import { buildHostReplacePlan, swapConnectHost, type MemberUnit, type PlanUnit, type TunnelUnit } from "./plan";

const q = (name: string) => quoteDbIdentifier(name);
type Row = Record<string, unknown>;

// 仓库层的写接口按 drizzle 的插入类型收参数；这里的补丁都是几列整数 / 文本，按列名拼的。
const rulePatch = (value: Record<string, unknown>) => value as unknown as Partial<InsertForwardRule>;
const asRouteRule = (row: Row) => row as unknown as RouteGroupRule;

export type HostReplaceActor = { id: number; name?: string | null };

export type HostReplaceExecuteInput = {
  oldHostId: number;
  newHostId: number;
  fingerprint: string;
  resolutions?: Record<string, { action: HostReplaceResolution; port?: number | null }>;
  /** 旧入口在旧机的老端口上临时转到新机（时长用「换入口桥接」的设置）。 */
  bridge?: boolean;
  /** 搬完把旧机设成维护。 */
  maintenance?: boolean;
};

// ==================== 记录的格式 ====================

type PortPlan = { ruleId: number; fromPort: number; toPort: number; protocol: string; listening: boolean };

type HopSnapshot = { id: number; hostId: number; listenPort: number; connectHost: string | null };

/** 一个单元做了什么：撤回要的全在这里（反方向重做 + 核对现在还是不是这个样子）。 */
type UnitRecord =
  | { kind: "rule"; unit: string; label: string; ports: PortPlan[] }
  | {
    kind: "tunnel";
    unit: string;
    label: string;
    tunnelId: number;
    roles: TunnelUnit["roles"];
    ports: PortPlan[];
    before: { listenPort: number; connectHost: string | null; networkType: string; hops: HopSnapshot[]; nodes: HopSnapshot[] };
    after: { entryHostId: number; exitHostId: number };
  }
  | { kind: "member"; unit: string; label: string; memberId: number; groupId: number; collection: boolean; connectHostBefore: string | null; templateIds: number[]; bridgedRuleIds: number[] }
  | { kind: "route"; unit: string; label: string; ruleId: number; groupId: number; isTemplate: boolean; before: { routePaths: string | null; routeLines: string | null }; after: { routePaths: string | null; routeLines: string | null } }
  | { kind: "pool"; unit: string; label: string; poolId: number; before: number[]; after: number[] }
  | { kind: "access"; unit: string; label: string; inserts: Array<{ table: string; id: number }> };

type ChangesDoc = { version: 1; units: UnitRecord[]; bridgedRuleIds: number[] };

type SummaryDoc = {
  counts: Partial<Record<HostReplaceCategory, number>>;
  skipped: string[];
  manual: HostReplaceManualItem[];
  warnings: string[];
  oldHostName: string;
  newHostName: string;
};

const CATEGORY_OF_KIND: Record<UnitRecord["kind"], HostReplaceCategory> = {
  rule: "rules",
  tunnel: "tunnels",
  member: "groupMembers",
  route: "routeGroups",
  pool: "nodePools",
  access: "access",
};

// ==================== 小工具 ====================

function optionalNumber(value: unknown): number | null {
  const n = Number(value);
  return value === null || value === undefined || value === "" || !Number.isFinite(n) ? null : n;
}

function textOrNull(value: unknown): string | null {
  return value === null || value === undefined || value === "" ? null : String(value);
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function hostName(host: Row | null | undefined, id: number) {
  return String(host?.name || "").trim() || `主机 ${id}`;
}

async function oneRow(table: string, id: number): Promise<Row | null> {
  return (await queryRaw<Row>(`SELECT * FROM ${q(table)} WHERE ${q("id")} = ?`, [id]))[0] || null;
}

function routeHopsSignature(raw: unknown) {
  return JSON.stringify(parseRoutePaths(raw).map((path) => [path.key, path.hops]));
}

/** 按 key 排好锁，避免两个请求各拿一半互等。 */
async function withLocks<T>(keys: string[], work: () => Promise<T>): Promise<T> {
  const sorted = Array.from(new Set(keys)).sort();
  return sorted.reduceRight<() => Promise<T>>((inner, key) => () => withKeyedTaskLock(key, inner), work)();
}

/** 在 host 上占一个端口：优先 preferred，不行就在它的端口范围里另挑一个。 */
async function reservePortOn(hostId: number, preferred: number, protocol: string, excludeRuleIds: number[], allowOther: boolean) {
  const isUsed = (port: number) => db.isPortUsedOnHost(hostId, port, excludeRuleIds, protocol, undefined, false);
  const host = await db.getHostById(hostId) as Row | undefined;
  const { isPortAllowedByPolicy, portPolicyFrom } = await import("../../shared/portPolicy");
  if (preferred > 0 && isPortAllowedByPolicy(preferred, portPolicyFrom(host as PortPolicySource | undefined))) {
    const exact = await reserveSpecificHostPort({ hostId, port: preferred, protocol, isUsed });
    if (exact) return exact;
  }
  if (!allowOther) return null;
  return reserveAvailableHostPort({
    hostId,
    protocol,
    findPort: (reserved) => db.findAvailablePort(hostId, null, null, protocol, reserved, excludeRuleIds),
    isUsed,
  });
}

// ==================== 隧道：把一端从 fromId 挪到 toId ====================

type ConnectTarget = { kind: "tunnel" | "hop" | "node"; id: number; connectHost: unknown; networkType?: unknown };

type TunnelMove = {
  tunnel: Row;
  hops: Row[];
  nodes: Row[];
  roles: TunnelUnit["roles"];
  fromId: number;
  toId: number;
  /** 出口 / 中转 / 额外出口在 toId 上想用的端口（撤回时是原来的端口）。 */
  preferredListenPort: number;
  preferredHopPorts: Map<number, number>;
  /** 每一行的连接地址：撤回时原样写回；执行时由 swapConnectHost 算。 */
  connectFor: (target: ConnectTarget) => { connectHost: string | null; networkType: string };
  /** 入口在 fromId 上的规则：端口已经在 toId 上占好。 */
  listeners: PortPlan[];
  held: HostPortReservation[];
};

/**
 * 端口照 tunnels.update 的路子来：出口监听用 reserveTunnelListenerPort（占不到原端口就换），
 * 中转 / 额外出口用 reserveTunnelExitPort，写完再同步最后一跳的端口、校正规则的出口端口、补 mimic 端口。
 * 必须在事务里调用（调用方已经拿了 tunnel:<id> 锁）。
 */
async function moveTunnelEndpoints(move: TunnelMove) {
  const { tunnel, fromId, toId } = move;
  const tunnelId = Number(tunnel.id);
  const toHost = await db.getHostById(toId) as Row | undefined;
  const patch: Record<string, unknown> = { isRunning: false };
  if (move.roles.includes("entry")) patch.entryHostId = toId;
  let listenPort = Number(tunnel.listenPort || 0);
  if (move.roles.includes("exit")) {
    patch.exitHostId = toId;
    const connect = move.connectFor({ kind: "tunnel", id: tunnelId, connectHost: tunnel.connectHost, networkType: tunnel.networkType });
    patch.connectHost = connect.connectHost;
    patch.networkType = connect.networkType;
    // 在写库之前占：这时隧道还挂在 fromId 上，它自己的规则不会被当成 toId 上的占用。
    const reservation = await db.reserveTunnelListenerPort(tunnel, { hostId: toId, currentPort: move.preferredListenPort || listenPort, protocol: "both" });
    if (!reservation) throw new Error(`隧道「${tunnel.name || tunnelId}」在${hostName(toHost, toId)}上分不到出口端口`);
    move.held.push(reservation);
    listenPort = reservation.port;
    patch.listenPort = listenPort;
  }
  const lastHopIndex = move.hops.length - 1;
  const hopWrites: Array<{ id: number; hostId: number; listenPort: number; connectHost: string | null }> = [];
  for (const [index, hop] of move.hops.entries()) {
    if (Number(hop.hostId) !== fromId) continue;
    let port = Number(hop.listenPort || 0);
    if (index > 0 && index < lastHopIndex) {
      const reservation = await db.reserveTunnelExitPort({
        hostId: toId,
        preferredStart: optionalNumber(toHost?.portRangeStart),
        preferredEnd: optionalNumber(toHost?.portRangeEnd),
        currentPort: move.preferredHopPorts.get(Number(hop.id)) || port,
        excludeTunnelId: tunnelId,
        protocol: "both",
      });
      if (!reservation) throw new Error(`隧道「${tunnel.name || tunnelId}」的中转在${hostName(toHost, toId)}上分不到端口`);
      move.held.push(reservation);
      port = reservation.port;
    }
    // 第一跳就是入口，它的 connectHost 没有意义（没人拨它），原样留着。
    const connect = index > 0 ? move.connectFor({ kind: "hop", id: Number(hop.id), connectHost: hop.connectHost }) : { connectHost: textOrNull(hop.connectHost) };
    hopWrites.push({ id: Number(hop.id), hostId: toId, listenPort: port, connectHost: connect.connectHost });
  }
  const nodeWrites: Array<{ id: number; hostId: number; listenPort: number; connectHost: string | null }> = [];
  for (const node of move.nodes) {
    if (Number(node.hostId) !== fromId) continue;
    const reservation = await db.reserveTunnelExitPort({
      hostId: toId,
      preferredStart: optionalNumber(toHost?.portRangeStart),
      preferredEnd: optionalNumber(toHost?.portRangeEnd),
      currentPort: move.preferredHopPorts.get(-Number(node.id)) || Number(node.listenPort || 0),
      excludeTunnelId: tunnelId,
      protocol: "both",
    });
    if (!reservation) throw new Error(`隧道「${tunnel.name || tunnelId}」的额外出口在${hostName(toHost, toId)}上分不到端口`);
    move.held.push(reservation);
    nodeWrites.push({ id: Number(node.id), hostId: toId, listenPort: reservation.port, connectHost: move.connectFor({ kind: "node", id: Number(node.id), connectHost: node.connectHost }).connectHost });
  }

  await db.updateTunnel(tunnelId, patch as unknown as Partial<InsertTunnel>);
  for (const hop of hopWrites) {
    await executeRaw(
      `UPDATE ${q("tunnel_hops")} SET ${q("hostId")} = ?, ${q("listenPort")} = ?, ${q("connectHost")} = ? WHERE ${q("id")} = ?`,
      [hop.hostId, hop.listenPort, hop.connectHost, hop.id],
    );
  }
  for (const node of nodeWrites) {
    await executeRaw(
      `UPDATE ${q("tunnel_exit_nodes")} SET ${q("hostId")} = ?, ${q("listenPort")} = ?, ${q("connectHost")} = ?, ${q("updatedAt")} = ? WHERE ${q("id")} = ?`,
      [node.hostId, node.listenPort, node.connectHost, nowSeconds(), node.id],
    );
    // 规则在这个出口上的映射跟着换机；端口提交后由 reconcileTunnelRuleExitMappings 校正。
    await executeRaw(`UPDATE ${q("forward_rule_tunnel_exits")} SET ${q("exitHostId")} = ? WHERE ${q("exitNodeId")} = ?`, [toId, node.id]);
  }
  for (const listener of move.listeners) {
    await db.updateForwardRule(listener.ruleId, rulePatch({ hostId: toId, sourcePort: listener.toPort, isRunning: false }));
  }
  const updated = { ...tunnel, ...patch, listenPort } as Row;
  if (move.roles.includes("exit")) {
    await db.syncTunnelListenerPortReferences(tunnelId, listenPort, { syncSharedPrimaryRule: db.usesSharedTunnelPrimaryListener(updated) });
    if (String(updated.mode || "").toLowerCase() !== "forwardx") {
      await db.reconcileTunnelRulePrimaryExitPorts(updated, { hostId: Number(updated.exitHostId), listenPort, reservations: move.held });
    }
  }
  const mode = String(updated.mode || "").toLowerCase();
  if (mode === "forwardx" && (dbBool(updated.udpOverTcp) || normalizeForwardXVersion(updated.forwardxVersion) === "v2")) {
    const [hops, nodes] = await Promise.all([db.getTunnelHops(tunnelId), db.getTunnelExitNodes(tunnelId)]);
    await db.ensureForwardXMimicPorts(await db.getTunnelById(tunnelId), hops || [], nodes || []);
  }
  await db.resetForwardRulesByTunnel(tunnelId);
  await db.clearTunnelTestSnapshot(tunnelId, { clearHistory: true });
}

// ==================== 提交之后的同步（执行、撤回共用） ====================

type FollowUps = {
  oldHostId: number;
  newHostId: number;
  tunnelIds: Set<number>;
  tunnelsWithNodes: Set<number>;
  collectionGroupIds: Set<number>;
  routeRuleIds: Set<number>;
  reexpandRuleIds: Set<number>;
  poolIds: Set<number>;
  refreshHostIds: Set<number>;
};

function newFollowUps(oldHostId: number, newHostId: number): FollowUps {
  return {
    oldHostId,
    newHostId,
    tunnelIds: new Set(),
    tunnelsWithNodes: new Set(),
    collectionGroupIds: new Set(),
    routeRuleIds: new Set(),
    reexpandRuleIds: new Set(),
    poolIds: new Set(),
    refreshHostIds: new Set([oldHostId, newHostId]),
  };
}

/**
 * 都在提交之后、锁放掉之后跑：这些同步各自拿键锁（route-relays、tunnel、forward-group-sync），
 * 有的还要求不在事务里。一项失败只记日志，不影响别的 —— 引用已经改好了，心跳和启动修复会再对一遍。
 */
async function runFollowUps(follow: FollowUps, reason: string) {
  const warn = (what: string, error: unknown) => appendPanelLog("warn", `[HostReplace] ${what} 失败：${error instanceof Error ? error.message : String(error)}`);
  for (const tunnelId of follow.tunnelsWithNodes) {
    await db.reconcileTunnelRuleExitMappings(tunnelId).catch((error) => warn(`tunnel=${tunnelId} 出口映射校正`, error));
  }
  for (const tunnelId of follow.tunnelIds) {
    const tunnel = await db.getTunnelById(tunnelId).catch(() => null) as Row | null;
    if (!tunnel) continue;
    for (const hostId of await db.tunnelRuleListenHostIds(tunnel).catch(() => [] as number[])) follow.refreshHostIds.add(hostId);
    follow.refreshHostIds.add(Number(tunnel.exitHostId));
    for (const hop of await db.getTunnelHops(tunnelId).catch(() => [] as Row[])) follow.refreshHostIds.add(Number(hop.hostId));
    for (const node of await db.getTunnelExitNodes(tunnelId).catch(() => [] as Row[])) follow.refreshHostIds.add(Number(node.hostId));
  }
  for (const groupId of follow.collectionGroupIds) {
    await db.runForwardGroupFailover(groupId, { forceSync: true, manual: true }).catch((error) => warn(`group=${groupId} 重选成员`, error));
    await db.refreshForwardGroupReferences(groupId, { reason, previousHostIds: [follow.oldHostId, follow.newHostId] })
      .catch((error) => warn(`group=${groupId} 刷新引用`, error));
  }
  const { reexpandRouteLinesForRules } = await import("../routeLineExpansion");
  const routeGroups = await import("../routeGroups");
  if (follow.poolIds.size > 0) {
    const { syncGroupsFollowingPool } = await import("../nodePoolGroups");
    const { ruleIdsUsingPool } = await import("../nodePools");
    for (const poolId of follow.poolIds) {
      await syncGroupsFollowingPool(poolId, reason).catch((error) => warn(`pool=${poolId} 同步转发组`, error));
      for (const ruleId of await ruleIdsUsingPool(poolId).catch(() => [] as number[])) follow.reexpandRuleIds.add(ruleId);
    }
  }
  if (follow.reexpandRuleIds.size > 0) {
    await reexpandRouteLinesForRules(Array.from(follow.reexpandRuleIds), reason).catch((error) => warn("线路重新展开", error));
  }
  for (const ruleId of follow.routeRuleIds) {
    const rule = await db.getForwardRuleById(ruleId).catch(() => null) as Row | null;
    if (!rule || dbBool(rule.pendingDelete) || dbBool(rule.isForwardGroupTemplate) || !routeGroupOf(asRouteRule(rule))) continue;
    await routeGroups.syncRouteRelayRulesForRule(ruleId, { reason }).catch((error) => warn(`rule=${ruleId} 中继同步`, error));
  }
  // 旧机上还挂着的中继（父规则没被这次改到的）也对一遍：它们的父规则会把旧机换掉或者标成不可用。
  await routeGroups.syncRouteRelayRulesForHost(follow.oldHostId, { reason }).catch((error) => warn("旧机中继同步", error));
  invalidateProxySubCacheAll();
  for (const hostId of follow.refreshHostIds) {
    if (hostId > 0) pushAgentRefresh(hostId, reason, { urgent: true });
  }
}

// ==================== 执行 ====================

function resolutionFor(input: HostReplaceExecuteInput, key: string, options: HostReplaceResolution[]) {
  const chosen = input.resolutions?.[key];
  const action = chosen && options.includes(chosen.action) ? chosen.action : defaultHostReplaceResolution({ options });
  return { action, port: Number(chosen?.port || 0) || 0 };
}

export async function executeHostReplace(input: HostReplaceExecuteInput, actor: HostReplaceActor) {
  return withKeyedTaskLock("host-replace", () => executeLocked(input, actor));
}

async function executeLocked(input: HostReplaceExecuteInput, actor: HostReplaceActor) {
  await pruneExpiredHostReplacements();
  const plan = await buildHostReplacePlan(input.oldHostId, input.newHostId);
  if (plan.preview.blockers.length > 0) throw new TRPCError({ code: "PRECONDITION_FAILED", message: plan.preview.blockers.join("；") });
  if (plan.preview.fingerprint !== String(input.fingerprint || "")) {
    throw new TRPCError({ code: "CONFLICT", message: "预览之后数据有变动（规则、端口或成员改过了），请重新预览再执行" });
  }
  const oldId = Number(plan.oldHost.id);
  const newId = Number(plan.newHost.id);
  const oldHost = plan.oldHost;
  const newHost = plan.newHost;

  // 冲突的处理：选了跳过的单元整个不动；阻断类只能跳过。
  const skippedUnits = new Set<string>();
  const newPortFor = new Map<string, number>();
  const skipped: string[] = [];
  for (const conflict of plan.conflicts.values()) {
    const { action, port } = resolutionFor(input, conflict.key, conflict.options);
    if (action === "skip") {
      if (!skippedUnits.has(conflict.unit)) skipped.push(`${conflict.label}：${conflict.detail}`);
      skippedUnits.add(conflict.unit);
    } else {
      newPortFor.set(conflict.key, port || Number(conflict.suggestedPort || 0));
    }
  }
  const units = plan.units.filter((unit) => !skippedUnits.has(unit.unit));

  const held: HostPortReservation[] = [];
  const bridgeHours = input.bridge === false ? 0 : plan.preview.bridgeHours;
  /** 旧机上留桥接的规则：规则 id → 老端口、协议。 */
  const bridgePlans: Array<{ ruleId: number; port: number; protocol: string }> = [];
  const portPlans = new Map<string, PortPlan[]>();

  try {
    // ---- 端口：新机上占好要监听的端口，旧机上占住老端口给桥接 ----
    const planListener = async (unit: string, listener: { ruleId: number; port: number; protocol: string; listening: boolean; conflictKey: string | null }) => {
      let toPort = listener.port;
      if (listener.listening) {
        const wanted = listener.conflictKey ? newPortFor.get(listener.conflictKey) || 0 : listener.port;
        const reservation = await reservePortOn(newId, wanted, listener.protocol, [listener.ruleId], !!listener.conflictKey);
        if (!reservation) throw new TRPCError({ code: "CONFLICT", message: `端口 ${wanted || listener.port} 在新机上刚被占用，请重新预览` });
        held.push(reservation);
        toPort = reservation.port;
        if (bridgeHours > 0) {
          const old = await reserveSpecificHostPort({
            hostId: oldId,
            port: listener.port,
            protocol: listener.protocol,
            isUsed: (port) => db.isPortUsedOnHost(oldId, port, [listener.ruleId], listener.protocol, undefined, false),
          });
          if (old) {
            held.push(old);
            bridgePlans.push({ ruleId: listener.ruleId, port: listener.port, protocol: listener.protocol });
          }
        }
      }
      const plans = portPlans.get(unit) || [];
      plans.push({ ruleId: listener.ruleId, fromPort: listener.port, toPort, protocol: listener.protocol, listening: listener.listening });
      portPlans.set(unit, plans);
    };
    for (const unit of units) {
      if (unit.kind === "rule") await planListener(unit.unit, unit.listener);
      if (unit.kind === "tunnel") for (const listener of unit.listeners) await planListener(unit.unit, listener);
    }

    // 转发组成员搬过去之后能原地留桥接的子规则（主机成员的子规则 id 不变、主机换成新机）。
    const memberChildrenBefore = new Map<number, Array<{ id: number; port: number; protocol: string }>>();
    for (const unit of units) {
      if (unit.kind !== "member" || unit.collection) continue;
      const children = await queryRaw<Row>(
        `SELECT ${q("id")}, ${q("sourcePort")}, ${q("protocol")}, ${q("isEnabled")} FROM ${q("forward_rules")} WHERE ${q("forwardGroupMemberId")} = ? AND ${q("hostId")} = ? AND ${q("pendingDelete")} = ?`,
        [Number(unit.member.id), oldId, false],
      );
      memberChildrenBefore.set(Number(unit.member.id), children
        .filter((row) => dbBool(row.isEnabled))
        .map((row) => ({ id: Number(row.id), port: Number(row.sourcePort), protocol: normalizeForwardRuleProtocol(row.protocol, "both") })));
    }

    const memberUnits = units.filter((unit): unit is MemberUnit => unit.kind === "member");
    const routeTemplateGroupIds = units
      .filter((unit) => unit.kind === "route" && dbBool(unit.rule.isForwardGroupTemplate) && Number(unit.rule.forwardGroupId || 0) > 0)
      .map((unit) => Number((unit as Extract<PlanUnit, { kind: "route" }>).rule.forwardGroupId));
    const lockGroupIds = [...memberUnits.map((unit) => Number(unit.group.id)), ...routeTemplateGroupIds];
    const syncGroupIds = [...memberUnits.filter((unit) => !unit.collection).map((unit) => Number(unit.group.id)), ...routeTemplateGroupIds];
    const tunnelLockKeys = units.filter((unit) => unit.kind === "tunnel").map((unit) => `tunnel:${(unit as TunnelUnit).tunnel.id}`);

    const records: UnitRecord[] = [];
    const follow = newFollowUps(oldId, newId);
    const reason = "host-replace";

    const recordId = await withLocks(tunnelLockKeys, () => runWithHeldHostPortReservations(held, () => db.withForwardGroupsSyncTransaction(
      lockGroupIds,
      async () => {
        for (const unit of units) {
          const record = await applyUnit(unit, { oldHost, newHost, held, ports: portPlans.get(unit.unit) || [], follow });
          if (record) records.push(record);
        }
        const counts: SummaryDoc["counts"] = {};
        for (const record of records) {
          const category = CATEGORY_OF_KIND[record.kind];
          counts[category] = (counts[category] || 0) + 1;
        }
        const summary: SummaryDoc = {
          counts,
          skipped,
          manual: plan.preview.manual,
          warnings: plan.preview.warnings,
          oldHostName: hostName(oldHost, oldId),
          newHostName: hostName(newHost, newId),
        };
        const createdAt = nowSeconds();
        const changes: ChangesDoc = { version: 1, units: records, bridgedRuleIds: [] };
        return insertAndGetId("host_replacements", {
          oldHostId: oldId,
          newHostId: newId,
          status: "done",
          actorUserId: actor.id,
          summaryJson: JSON.stringify(summary),
          changesJson: JSON.stringify(changes),
          maintenanceSet: false,
          createdAt,
          expiresAt: createdAt + HOST_REPLACE_RECORD_DAYS * 86400,
        });
      },
      { syncGroupIds, deferRefresh: true },
    )));

    // ---- 提交之后 ----
    await runFollowUps(follow, reason);

    // 旧入口桥接：旧机老端口上临时转到规则现在的入口（新机）。规则端口换了也没关系，桥接按规则当前端口转。
    const bridged: number[] = [];
    if (bridgeHours > 0) {
      for (const item of bridgePlans) {
        await db.recordRuleEntryBridges({ ruleId: item.ruleId, hostIds: [oldId], sourcePort: item.port, protocol: item.protocol, hours: bridgeHours });
        bridged.push(item.ruleId);
      }
      for (const [memberId, children] of memberChildrenBefore) {
        const record = records.find((entry) => entry.kind === "member" && entry.memberId === memberId);
        if (!record) continue;
        for (const child of children) {
          const now = await oneRow("forward_rules", child.id);
          if (!now || Number(now.hostId) !== newId || dbBool(now.pendingDelete)) continue;
          // 子规则搬过去以后旧机这个端口就空出来了；被别的占了就不桥。
          if (await db.isPortUsedOnHost(oldId, child.port, [child.id], child.protocol, undefined, false)) continue;
          await db.recordRuleEntryBridges({ ruleId: child.id, hostIds: [oldId], sourcePort: child.port, protocol: child.protocol, hours: bridgeHours });
          bridged.push(child.id);
          if (record.kind === "member") record.bridgedRuleIds.push(child.id);
        }
      }
      if (bridged.length > 0) {
        const changes: ChangesDoc = { version: 1, units: records, bridgedRuleIds: bridged };
        await executeRaw(`UPDATE ${q("host_replacements")} SET ${q("changesJson")} = ? WHERE ${q("id")} = ?`, [JSON.stringify(changes), recordId]);
        pushAgentRefresh(oldId, "host-replace-entry-bridge", { urgent: true });
      }
    }

    let maintenanceSet = false;
    if (input.maintenance && !dbBool(oldHost.maintenanceMode)) {
      const { setHostMaintenance } = await import("../hostMaintenance");
      await setHostMaintenance(oldId, true, `已替换到 ${hostName(newHost, newId)}`, actor).catch((error) => {
        appendPanelLog("warn", `[HostReplace] 旧机设维护失败：${error instanceof Error ? error.message : String(error)}`);
      });
      maintenanceSet = true;
      await executeRaw(`UPDATE ${q("host_replacements")} SET ${q("maintenanceSet")} = ? WHERE ${q("id")} = ?`, [true, recordId]);
    }

    const counts = Object.fromEntries(Object.entries(countRecords(records)));
    await recordConfigAuditEvent({
      resourceType: "host",
      resourceId: oldId,
      hostId: oldId,
      action: "update",
      source: "host-replace",
      before: { replacedBy: null },
      after: { replacedBy: newId, replacementId: recordId, counts, skipped: skipped.length, bridged: bridged.length, maintenanceSet },
    }).catch(() => 0);
    appendPanelLog("info", `[HostReplace] #${recordId} host=${oldId} → ${newId} by user=${actor.id} units=${records.length} skipped=${skipped.length} bridged=${bridged.length}`);
    return {
      recordId: Number(recordId),
      counts,
      skipped,
      bridged: bridged.length,
      bridgeHours: bridged.length > 0 ? bridgeHours : 0,
      maintenanceSet,
      manual: plan.preview.manual,
    };
  } finally {
    releaseHostPortReservations(held);
  }
}

function countRecords(records: UnitRecord[]) {
  const counts: Partial<Record<HostReplaceCategory, number>> = {};
  for (const record of records) {
    const category = CATEGORY_OF_KIND[record.kind];
    counts[category] = (counts[category] || 0) + 1;
  }
  return counts;
}

type ApplyContext = {
  oldHost: Row;
  newHost: Row;
  held: HostPortReservation[];
  ports: PortPlan[];
  follow: FollowUps;
};

async function applyUnit(unit: PlanUnit, ctx: ApplyContext): Promise<UnitRecord | null> {
  const oldId = Number(ctx.oldHost.id);
  const newId = Number(ctx.newHost.id);
  const label = unitLabel(unit);
  switch (unit.kind) {
    case "rule": {
      const port = ctx.ports[0];
      await db.updateForwardRule(Number(unit.rule.id), rulePatch({ hostId: newId, sourcePort: port?.toPort ?? Number(unit.rule.sourcePort), isRunning: false }));
      if (routeGroupOf(asRouteRule(unit.rule))) ctx.follow.routeRuleIds.add(Number(unit.rule.id));
      return { kind: "rule", unit: unit.unit, label, ports: ctx.ports };
    }
    case "tunnel": {
      const tunnelId = Number(unit.tunnel.id);
      const snapshot = (rows: Row[]): HopSnapshot[] => rows.map((row) => ({
        id: Number(row.id), hostId: Number(row.hostId), listenPort: Number(row.listenPort || 0), connectHost: row.connectHost ? String(row.connectHost) : null,
      }));
      const before = {
        listenPort: Number(unit.tunnel.listenPort || 0),
        connectHost: unit.tunnel.connectHost ? String(unit.tunnel.connectHost) : null,
        networkType: String(unit.tunnel.networkType || "public"),
        hops: snapshot(unit.hops),
        nodes: snapshot(unit.exitNodes),
      };
      await moveTunnelEndpoints({
        tunnel: unit.tunnel,
        hops: unit.hops,
        nodes: unit.exitNodes,
        roles: unit.roles,
        fromId: oldId,
        toId: newId,
        preferredListenPort: before.listenPort,
        preferredHopPorts: new Map(),
        connectFor: (target) => swapConnectHost(target.connectHost, target.networkType ?? "public", ctx.oldHost, ctx.newHost),
        listeners: ctx.ports,
        held: ctx.held,
      });
      const after = await db.getTunnelById(tunnelId) as Row;
      ctx.follow.tunnelIds.add(tunnelId);
      if (unit.exitNodes.length > 0) ctx.follow.tunnelsWithNodes.add(tunnelId);
      for (const listener of ctx.ports) {
        const rule = unit.listeners.find((item) => item.ruleId === listener.ruleId)?.rule;
        if (rule && routeGroupOf(asRouteRule(rule))) ctx.follow.routeRuleIds.add(listener.ruleId);
      }
      // 隧道规则的线路调度器在隧道出口：出口换了，这几条的中继也要重新对。
      if (unit.roles.includes("exit")) for (const ruleId of unit.allRuleIds) ctx.follow.routeRuleIds.add(ruleId);
      return {
        kind: "tunnel",
        unit: unit.unit,
        label,
        tunnelId,
        roles: unit.roles,
        ports: ctx.ports,
        before,
        after: { entryHostId: Number(after.entryHostId), exitHostId: Number(after.exitHostId) },
      };
    }
    case "member": {
      const memberId = Number(unit.member.id);
      const connectHostBefore = unit.member.connectHost ? String(unit.member.connectHost) : null;
      const connectHost = unit.connectHost === undefined ? connectHostBefore : unit.connectHost;
      await executeRaw(
        `UPDATE ${q("forward_group_members")} SET ${q("hostId")} = ?, ${q("connectHost")} = ?, ${q("updatedAt")} = ? WHERE ${q("id")} = ?`,
        [newId, connectHost, nowSeconds(), memberId],
      );
      // 模板挂在哪台机器上只是个默认值（不下发），跟着成员换，免得删旧机时被它挡住。
      for (const templateId of unit.templateIds) await db.updateForwardRule(templateId, rulePatch({ hostId: newId }));
      if (unit.collection) ctx.follow.collectionGroupIds.add(Number(unit.group.id));
      return { kind: "member", unit: unit.unit, label, memberId, groupId: Number(unit.group.id), collection: unit.collection, connectHostBefore, templateIds: unit.templateIds, bridgedRuleIds: [] };
    }
    case "route": {
      const ruleId = Number(unit.rule.id);
      const before = { routePaths: textOrNull(unit.rule.routePaths), routeLines: textOrNull(unit.rule.routeLines) };
      const patch: Record<string, unknown> = {};
      if (unit.routePaths !== null) patch.routePaths = unit.routePaths;
      if (unit.routeLines !== null) patch.routeLines = unit.routeLines;
      await db.updateForwardRule(ruleId, rulePatch(patch));
      const isTemplate = dbBool(unit.rule.isForwardGroupTemplate);
      if (unit.routeLines !== null) ctx.follow.reexpandRuleIds.add(ruleId);
      if (!isTemplate) ctx.follow.routeRuleIds.add(ruleId);
      return {
        kind: "route",
        unit: unit.unit,
        label,
        ruleId,
        groupId: Number(unit.rule.forwardGroupId || 0),
        isTemplate,
        before,
        after: { routePaths: unit.routePaths ?? before.routePaths, routeLines: unit.routeLines ?? before.routeLines },
      };
    }
    case "pool": {
      const { updateNodePool } = await import("../nodePools");
      const before = JSON.parse(String(unit.pool.hostIdsJson || "[]")) as number[];
      await updateNodePool(Number(unit.pool.id), { hostIds: unit.hostIds });
      ctx.follow.poolIds.add(Number(unit.pool.id));
      return { kind: "pool", unit: unit.unit, label, poolId: Number(unit.pool.id), before, after: unit.hostIds };
    }
    case "access": {
      const inserts: Array<{ table: string; id: number }> = [];
      const createdAt = nowSeconds();
      for (const groupId of unit.hostGroupIds) {
        const sort = await queryRaw<Row>(`SELECT COALESCE(MAX(${q("sortOrder")}), -1) + 1 AS ${q("next")} FROM ${q("host_group_members")} WHERE ${q("groupId")} = ?`, [groupId]);
        inserts.push({ table: "host_group_members", id: await insertAndGetId("host_group_members", { groupId, hostId: newId, sortOrder: Number(sort[0]?.next || 0), createdAt }) });
      }
      for (const userId of unit.userIds) {
        inserts.push({ table: "user_host_permissions", id: await insertAndGetId("user_host_permissions", { userId, hostId: newId, createdAt }) });
      }
      for (const planId of unit.planIds) {
        inserts.push({ table: "subscription_plan_hosts", id: await insertAndGetId("subscription_plan_hosts", { planId, hostId: newId, createdAt }) });
      }
      return { kind: "access", unit: unit.unit, label, inserts };
    }
    default:
      return null;
  }
}

function unitLabel(unit: PlanUnit) {
  const name = (row: Row, fallback: string) => String(row?.name || "").trim() || fallback;
  switch (unit.kind) {
    case "rule": return `规则「${name(unit.rule, `#${unit.rule.id}`)}」`;
    case "tunnel": return `隧道「${name(unit.tunnel, `#${unit.tunnel.id}`)}」`;
    case "member": return `转发组「${name(unit.group, `#${unit.group.id}`)}」的成员`;
    case "route": return `线路组「${name(unit.rule, `#${unit.rule.id}`)}」`;
    case "pool": return `节点池「${name(unit.pool, `#${unit.pool.id}`)}」`;
    default: return HOST_REPLACE_CATEGORY_LABELS.access;
  }
}

// ==================== 撤回 ====================

export async function undoHostReplace(recordId: number, actor: HostReplaceActor) {
  return withKeyedTaskLock("host-replace", () => undoLocked(recordId, actor));
}

async function undoLocked(recordIdValue: number, actor: HostReplaceActor) {
  await pruneExpiredHostReplacements();
  const recordId = Math.floor(Number(recordIdValue) || 0);
  const record = await oneRow("host_replacements", recordId);
  if (!record) throw new TRPCError({ code: "NOT_FOUND", message: "这次替换的记录不在了（超过保留期会自动删除）" });
  if (String(record.status) !== "done") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "这次替换已经撤回过了" });
  const oldId = Number(record.oldHostId);
  const newId = Number(record.newHostId);
  const oldHost = await db.getHostById(oldId) as Row | undefined;
  const newHost = await db.getHostById(newId) as Row | undefined;
  if (!oldHost) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "旧机已经删掉了，撤回不了" });
  if (!newHost) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "新机已经删掉了，撤回不了" });
  let changes: ChangesDoc;
  try {
    changes = JSON.parse(String(record.changesJson || "{}"));
  } catch {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "替换记录损坏，撤回不了" });
  }
  const units = Array.isArray(changes.units) ? changes.units : [];
  const report: string[] = [];
  const keep: UnitRecord[] = [];
  const held: HostPortReservation[] = [];
  try {
    // ---- 核对：之后被改过的单元不碰；旧机上原来的端口被占了的也不碰 ----
    for (const unit of units) {
      const problem = await undoProblem(unit, oldId, newId, held);
      if (problem) report.push(`${unit.label}：${problem}，没有撤回`);
      else keep.push(unit);
    }

    const memberUnits = keep.filter((unit): unit is Extract<UnitRecord, { kind: "member" }> => unit.kind === "member");
    const routeTemplateGroupIds = keep.filter((unit) => unit.kind === "route" && unit.isTemplate && unit.groupId > 0).map((unit) => (unit as Extract<UnitRecord, { kind: "route" }>).groupId);
    const lockGroupIds = [...memberUnits.map((unit) => unit.groupId), ...routeTemplateGroupIds];
    const syncGroupIds = [...memberUnits.filter((unit) => !unit.collection).map((unit) => unit.groupId), ...routeTemplateGroupIds];
    const tunnelLockKeys = keep.filter((unit) => unit.kind === "tunnel").map((unit) => `tunnel:${(unit as Extract<UnitRecord, { kind: "tunnel" }>).tunnelId}`);
    const follow = newFollowUps(oldId, newId);
    const reason = "host-replace-undo";

    await withLocks(tunnelLockKeys, () => runWithHeldHostPortReservations(held, () => db.withForwardGroupsSyncTransaction(
      lockGroupIds,
      async () => {
        for (const unit of keep) await revertUnit(unit, { oldHost, newHost, held, follow });
        await executeRaw(
          `UPDATE ${q("host_replacements")} SET ${q("status")} = ?, ${q("undoneAt")} = ?, ${q("undoReportJson")} = ? WHERE ${q("id")} = ?`,
          ["undone", nowSeconds(), JSON.stringify(report), recordId],
        );
      },
      { syncGroupIds, deferRefresh: true },
    )));

    await runFollowUps(follow, reason);
    // 规则回到旧机：旧机上替它留的桥接就没用了（心跳本来也不会再下发它），删掉。
    for (const ruleId of changes.bridgedRuleIds || []) {
      await db.deleteRuleEntryBridgesOnHosts(ruleId, [oldId]).catch(() => [] as number[]);
    }
    if (dbBool(record.maintenanceSet) && dbBool(oldHost.maintenanceMode)) {
      const { setHostMaintenance } = await import("../hostMaintenance");
      await setHostMaintenance(oldId, false, null, actor).catch(() => null);
    }
    await recordConfigAuditEvent({
      resourceType: "host",
      resourceId: oldId,
      hostId: oldId,
      action: "update",
      source: "host-replace-undo",
      before: { replacedBy: newId, replacementId: recordId },
      after: { replacedBy: null, replacementId: recordId, reverted: keep.length, notReverted: report.length },
    }).catch(() => 0);
    appendPanelLog("info", `[HostReplace] #${recordId} undone by user=${actor.id} reverted=${keep.length} kept=${report.length}`);
    return { recordId, reverted: keep.length, report };
  } finally {
    releaseHostPortReservations(held);
  }
}

/** 这个单元能不能撤：现在还是不是我们改成的样子；规则原来的端口在旧机上还空着没有（空着就先占上）。 */
async function undoProblem(unit: UnitRecord, oldId: number, newId: number, held: HostPortReservation[]): Promise<string | null> {
  const reservePorts = async (ports: PortPlan[]) => {
    for (const port of ports) {
      const rule = await oneRow("forward_rules", port.ruleId);
      if (!rule || dbBool(rule.pendingDelete)) return "规则已经删掉了";
      if (Number(rule.hostId) !== newId || Number(rule.sourcePort) !== port.toPort) return "之后被改过";
      if (!port.listening) continue;
      const reservation = await reserveSpecificHostPort({
        hostId: oldId,
        port: port.fromPort,
        protocol: port.protocol,
        isUsed: (value) => db.isPortUsedOnHost(oldId, value, [port.ruleId], port.protocol, undefined, false),
      });
      if (!reservation) return `旧机上端口 ${port.fromPort} 已被别的占用`;
      held.push(reservation);
    }
    return null;
  };
  switch (unit.kind) {
    case "rule":
      return reservePorts(unit.ports);
    case "tunnel": {
      const tunnel = await oneRow("tunnels", unit.tunnelId);
      if (!tunnel) return "隧道已经删掉了";
      if (Number(tunnel.entryHostId) !== unit.after.entryHostId || Number(tunnel.exitHostId) !== unit.after.exitHostId) return "之后被改过";
      const hops = await queryRaw<Row>(`SELECT ${q("id")}, ${q("hostId")} FROM ${q("tunnel_hops")} WHERE ${q("tunnelId")} = ?`, [unit.tunnelId]);
      const hopIds = new Set(hops.map((hop) => Number(hop.id)));
      if (unit.before.hops.some((hop) => !hopIds.has(hop.id))) return "中转改过";
      if (await db.getTunnelHops(unit.tunnelId).then((rows) => (rows as Row[]).some((hop) => Number(hop.hostId) === oldId)).catch(() => false)) return "旧机已经在这条隧道里";
      return reservePorts(unit.ports);
    }
    case "member": {
      const member = await oneRow("forward_group_members", unit.memberId);
      if (!member) return "成员已经删掉了";
      if (Number(member.hostId) !== newId) return "之后被改过";
      const already = await queryRaw<Row>(`SELECT ${q("id")} FROM ${q("forward_group_members")} WHERE ${q("groupId")} = ? AND ${q("memberType")} = ? AND ${q("hostId")} = ?`, [unit.groupId, "host", oldId]);
      if (already.length > 0) return "旧机已经又是这个组的成员";
      return null;
    }
    case "route": {
      const rule = await oneRow("forward_rules", unit.ruleId);
      if (!rule || dbBool(rule.pendingDelete)) return "规则已经删掉了";
      // 有线路定义的比线路（路径会重新展开、顺序会变）；只有路径的比每条路径的中转。
      if (unit.after.routeLines) {
        if (String(rule.routeLines || "") !== String(unit.after.routeLines)) return "之后被改过";
      } else if (routeHopsSignature(rule.routePaths) !== routeHopsSignature(unit.after.routePaths)) {
        return "之后被改过";
      }
      return null;
    }
    case "pool": {
      const pool = await oneRow("node_pools", unit.poolId);
      if (!pool) return "节点池已经删掉了";
      let current: number[] = [];
      try {
        current = JSON.parse(String(pool.hostIdsJson || "[]"));
      } catch {
        current = [];
      }
      return JSON.stringify(current) === JSON.stringify(unit.after) ? null : "之后被改过";
    }
    default:
      return null;
  }
}

async function revertUnit(unit: UnitRecord, ctx: { oldHost: Row; newHost: Row; held: HostPortReservation[]; follow: FollowUps }) {
  const oldId = Number(ctx.oldHost.id);
  const newId = Number(ctx.newHost.id);
  switch (unit.kind) {
    case "rule": {
      for (const port of unit.ports) {
        await db.updateForwardRule(port.ruleId, rulePatch({ hostId: oldId, sourcePort: port.fromPort, isRunning: false }));
        const rule = await db.getForwardRuleById(port.ruleId) as Row | undefined;
        if (rule && routeGroupOf(asRouteRule(rule))) ctx.follow.routeRuleIds.add(port.ruleId);
      }
      return;
    }
    case "tunnel": {
      const tunnel = await db.getTunnelById(unit.tunnelId) as Row;
      const hops = (await db.getTunnelHops(unit.tunnelId) || []) as Row[];
      const nodes = (await db.getTunnelExitNodes(unit.tunnelId) || []) as Row[];
      // 替换时新机不可能已经在这条隧道里（预览会挡），所以现在在新机上的那几行都是这次挪过去的。
      const preferredHopPorts = new Map<number, number>();
      for (const hop of unit.before.hops) preferredHopPorts.set(hop.id, hop.listenPort);
      for (const node of unit.before.nodes) preferredHopPorts.set(-node.id, node.listenPort);
      const hopBefore = new Map(unit.before.hops.map((hop) => [hop.id, hop]));
      const nodeBefore = new Map(unit.before.nodes.map((node) => [node.id, node]));
      await moveTunnelEndpoints({
        tunnel,
        hops,
        nodes,
        roles: unit.roles,
        fromId: newId,
        toId: oldId,
        preferredListenPort: unit.before.listenPort,
        preferredHopPorts,
        connectFor: (target) => {
          if (target.kind === "tunnel") return { connectHost: unit.before.connectHost, networkType: unit.before.networkType };
          const before = target.kind === "hop" ? hopBefore.get(target.id) : nodeBefore.get(target.id);
          return { connectHost: before ? before.connectHost : null, networkType: "public" };
        },
        listeners: unit.ports.map((port) => ({ ...port, fromPort: port.toPort, toPort: port.fromPort })),
        held: ctx.held,
      });
      ctx.follow.tunnelIds.add(unit.tunnelId);
      if (unit.before.nodes.length > 0) ctx.follow.tunnelsWithNodes.add(unit.tunnelId);
      for (const port of unit.ports) ctx.follow.routeRuleIds.add(port.ruleId);
      return;
    }
    case "member": {
      await executeRaw(
        `UPDATE ${q("forward_group_members")} SET ${q("hostId")} = ?, ${q("connectHost")} = ?, ${q("updatedAt")} = ? WHERE ${q("id")} = ?`,
        [oldId, unit.connectHostBefore, nowSeconds(), unit.memberId],
      );
      for (const templateId of unit.templateIds) await db.updateForwardRule(templateId, rulePatch({ hostId: oldId }));
      if (unit.collection) ctx.follow.collectionGroupIds.add(unit.groupId);
      return;
    }
    case "route": {
      await db.updateForwardRule(unit.ruleId, rulePatch({ routePaths: unit.before.routePaths, routeLines: unit.before.routeLines }));
      if (unit.before.routeLines) ctx.follow.reexpandRuleIds.add(unit.ruleId);
      if (!unit.isTemplate) ctx.follow.routeRuleIds.add(unit.ruleId);
      return;
    }
    case "pool": {
      const { updateNodePool } = await import("../nodePools");
      await updateNodePool(unit.poolId, { hostIds: unit.before });
      ctx.follow.poolIds.add(unit.poolId);
      return;
    }
    case "access": {
      for (const insert of unit.inserts) {
        if (!["host_group_members", "user_host_permissions", "subscription_plan_hosts"].includes(insert.table)) continue;
        await executeRaw(`DELETE FROM ${q(insert.table)} WHERE ${q("id")} = ?`, [insert.id]);
      }
      return;
    }
    default:
      return;
  }
}

// ==================== 记录列表 / 清理 ====================

/** 过了保留期的记录删掉（没有定时任务：执行、撤回、列表时顺手清）。 */
export async function pruneExpiredHostReplacements() {
  await executeRaw(`DELETE FROM ${q("host_replacements")} WHERE ${q("expiresAt")} < ?`, [nowSeconds()]).catch(() => undefined);
}

function epochSeconds(value: unknown): number | null {
  const date = rawEpochToDate(value);
  return date ? Math.floor(date.getTime() / 1000) : null;
}

export async function listHostReplacements(hostId: number | null, limit = 20): Promise<HostReplaceRecordSummary[]> {
  await pruneExpiredHostReplacements();
  const id = Math.floor(Number(hostId) || 0);
  const where = id > 0 ? ` WHERE ${q("oldHostId")} = ? OR ${q("newHostId")} = ?` : "";
  const params = id > 0 ? [id, id] : [];
  const rows = await queryRaw<Row>(
    `SELECT ${q("id")}, ${q("oldHostId")}, ${q("newHostId")}, ${q("status")}, ${q("summaryJson")}, ${q("undoReportJson")}, ${q("createdAt")}, ${q("undoneAt")}, ${q("expiresAt")}
       FROM ${q("host_replacements")}${where} ORDER BY ${q("id")} DESC LIMIT ${Math.max(1, Math.min(100, Math.floor(limit)))}`,
    params,
  );
  return rows.map((row) => {
    let summary: Partial<SummaryDoc> = {};
    let undoReport: string[] = [];
    try { summary = JSON.parse(String(row.summaryJson || "{}")); } catch { summary = {}; }
    try { undoReport = JSON.parse(String(row.undoReportJson || "[]")); } catch { undoReport = []; }
    return {
      id: Number(row.id),
      oldHostId: Number(row.oldHostId),
      newHostId: Number(row.newHostId),
      oldHostName: String(summary.oldHostName || `主机 ${row.oldHostId}`),
      newHostName: String(summary.newHostName || `主机 ${row.newHostId}`),
      status: String(row.status) === "undone" ? "undone" : "done",
      createdAt: epochSeconds(row.createdAt) || 0,
      undoneAt: epochSeconds(row.undoneAt),
      expiresAt: epochSeconds(row.expiresAt) || 0,
      counts: summary.counts || {},
      skipped: Array.isArray(summary.skipped) ? summary.skipped.length : 0,
      manual: Array.isArray(summary.manual) ? summary.manual : [],
      undoReport: Array.isArray(undoReport) ? undoReport : [],
    };
  });
}
