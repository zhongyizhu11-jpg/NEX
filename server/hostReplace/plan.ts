/*
  主机替换的清点和预览：旧机上挂着哪些东西、各自怎么引用这台机器、搬到新机会撞上什么。

  这里只读不写。执行（./execute.ts）开头会再算一遍、比对指纹：预览之后有人改了规则、新机上多了
  占端口的东西，指纹就对不上，执行直接拒绝，让人重新预览 —— 不在过时的预览上照着做。

  引用关系（以代码里实际有的为准）：
    forward_rules.hostId            直连规则（不含转发组子规则、中继规则、模板）、隧道入口上的规则
    forward_rules.routePaths/Lines  线路组规则里的中转（路径 hops、线路层 hostIds）
    tunnels.entryHostId/exitHostId  隧道入口 / 出口
    tunnel_hops.hostId              多跳隧道的每一跳（含首尾）
    tunnel_exit_nodes.hostId        多出口隧道的额外出口
    forward_group_members.hostId    转发组 / 入口组 / 出口组 / 转发链的主机成员
    node_pools.hostIdsJson          节点池成员
    host_group_members / user_host_permissions / subscription_plan_hosts  分组、授权、套餐
  中继规则（routeParentRuleId）和转发组子规则（forwardGroupRuleId）不直接改：它们是同步的产物，
  改了上游（线路、成员）再同步就会建到新机上。
*/
import { createHash } from "node:crypto";
import * as db from "../db";
import { queryRaw, quoteDbIdentifier } from "../dbRuntime";
import { isHostConsideredOnline } from "../hostHeartbeatPolicy";
import { dbBool } from "../repositories/repositoryUtils";
import { forwardGroupModeOf, normalizeForwardRuleProtocol } from "../../shared/forwardTypes";
import { getHostEntryAddress, type HostEntryAddressSource } from "../../shared/hostEntryAddress";
import { isPortAllowedByPolicy, portPolicyFrom, type PortPolicySource } from "../../shared/portPolicy";
import { compareVersions } from "../../shared/version";
import {
  HOST_REPLACE_CATEGORIES,
  HOST_REPLACE_CATEGORY_LABELS,
  replaceIdInList,
  swapRouteLinesHost,
  swapRoutePathsHost,
  type HostReplaceCategory,
  type HostReplaceConflict,
  type HostReplaceHostSummary,
  type HostReplaceItem,
  type HostReplaceManualItem,
  type HostReplacePreview,
} from "../../shared/hostReplace";

const q = (name: string) => quoteDbIdentifier(name);

type Row = Record<string, unknown>;

/** 搬到新机上要监听的一个端口（直连规则、隧道入口上的规则）。 */
export type PlannedListener = {
  ruleId: number;
  port: number;
  protocol: string;
  /** 启用着、真的在监听：只有它要查端口，也只有它留旧入口桥接。 */
  listening: boolean;
  conflictKey: string | null;
};

export type RuleUnit = { kind: "rule"; unit: string; rule: Row; listener: PlannedListener };

export type TunnelUnit = {
  kind: "tunnel";
  unit: string;
  tunnel: Row;
  hops: Row[];
  exitNodes: Row[];
  /** 这台旧机在隧道里的身份。入口组 / 出口组托管的那一端不在这里（跟着组成员走）。 */
  roles: Array<"entry" | "exit" | "hop" | "extraExit">;
  /** 入口在旧机上：隧道上的规则跟着搬。 */
  listeners: Array<PlannedListener & { rule: Row }>;
  /** 隧道上全部规则（撤回时要还原 tunnelExitPort）。 */
  allRuleIds: number[];
  connectHostPatch: { connectHost: string | null; networkType: string } | null;
};

export type MemberUnit = {
  kind: "member";
  unit: string;
  member: Row;
  group: Row;
  collection: boolean;
  connectHost: string | null | undefined;
  templateIds: number[];
};

export type RouteUnit = {
  kind: "route";
  unit: string;
  rule: Row;
  routePaths: string | null;
  routeLines: string | null;
};

export type PoolUnit = { kind: "pool"; unit: string; pool: Row; hostIds: number[] };

export type AccessUnit = { kind: "access"; unit: string; hostGroupIds: number[]; userIds: number[]; planIds: number[] };

export type PlanUnit = RuleUnit | TunnelUnit | MemberUnit | RouteUnit | PoolUnit | AccessUnit;

export type HostReplacePlan = {
  oldHost: Row;
  newHost: Row;
  units: PlanUnit[];
  /** 冲突 key → 冲突。阻断类（新机已在隧道 / 组里）也在这里，只能选跳过。 */
  conflicts: Map<string, HostReplaceConflict>;
  preview: HostReplacePreview;
};

function hostSummary(host: Row): HostReplaceHostSummary {
  return {
    id: Number(host.id),
    name: String(host.name || "").trim() || `主机 ${host.id}`,
    address: getHostEntryAddress(host as HostEntryAddressSource) || String(host.ip || ""),
    online: isHostConsideredOnline(host),
    agentVersion: String(host.agentVersion || "").trim(),
  };
}

function nameOf(row: Row | null | undefined, fallback: string) {
  return String(row?.name || "").trim() || fallback;
}

/** 旧机的所有地址：别处写死了这些的，搬完要人去改。 */
export function hostAddresses(host: Row): string[] {
  return Array.from(new Set(["ip", "ipv4", "ipv6", "entryIp", "tunnelEntryIp"]
    .map((key) => String(host?.[key] || "").trim().toLowerCase())
    .filter(Boolean)));
}

/**
 * 隧道 / 转发链上「指定的连接地址」：写的是旧机自己的地址就跟着换（内网地址换成新机的内网地址，
 * 公网地址清空 = 用新机默认地址）；写的是别的（域名、另一台的地址）原样留着，提示人确认。
 */
export function swapConnectHost(value: unknown, networkType: unknown, oldHost: Row, newHost: Row): { connectHost: string | null; networkType: string; note: string | null } {
  const text = String(value || "").trim();
  const type = String(networkType || "public") === "private" ? "private" : "public";
  if (!text) return { connectHost: null, networkType: type === "private" ? (String(newHost.tunnelEntryIp || "").trim() ? "private" : "public") : "public", note: null };
  if (hostAddresses(oldHost).includes(text.toLowerCase())) {
    if (type === "private") {
      const next = String(newHost.tunnelEntryIp || "").trim();
      return next
        ? { connectHost: next, networkType: "private", note: null }
        : { connectHost: null, networkType: "public", note: "新机没有内网地址，改走公网" };
    }
    return { connectHost: null, networkType: "public", note: null };
  }
  return { connectHost: text, networkType: type, note: `指定的连接地址「${text}」不是旧机的地址，原样保留，请确认它现在指向新机` };
}

async function rows(sqlText: string, params: unknown[] = []): Promise<Row[]> {
  return queryRaw<Row>(sqlText, params);
}

function sortUnique(values: Iterable<unknown>) {
  return Array.from(new Set(Array.from(values).map(Number).filter((id) => Number.isInteger(id) && id > 0))).sort((a, b) => a - b);
}

/** 端口在新机上能不能用：被占（含入站、桥接、隧道监听）或不在新机的端口范围里都算不能。 */
async function newHostPortProblem(newHost: Row, port: number, protocol: string, excludeRuleIds: number[], planned: Set<number>): Promise<string | null> {
  if (!isPortAllowedByPolicy(port, portPolicyFrom(newHost as PortPolicySource))) return `端口 ${port} 不在新机允许的端口范围里`;
  if (planned.has(port)) return `端口 ${port} 已经分给这次搬过去的另一项`;
  if (await db.isPortUsedOnHost(Number(newHost.id), port, excludeRuleIds, protocol, undefined, false)) return `端口 ${port} 在新机上已被占用`;
  return null;
}

async function suggestPort(newHost: Row, protocol: string, excludeRuleIds: number[], planned: Set<number>): Promise<number | null> {
  return db.findAvailablePort(Number(newHost.id), null, null, protocol, Array.from(planned), excludeRuleIds).catch(() => null);
}

/**
 * 清点 + 预览。oldHostId → newHostId，不写库。
 */
export async function buildHostReplacePlan(oldHostId: number, newHostId: number): Promise<HostReplacePlan> {
  const oldId = Math.floor(Number(oldHostId) || 0);
  const newId = Math.floor(Number(newHostId) || 0);
  const oldHost = await db.getHostById(oldId) as Row | undefined;
  const newHost = await db.getHostById(newId) as Row | undefined;
  if (!oldHost) throw new Error("旧主机不存在");
  if (!newHost) throw new Error("新主机不存在");

  const blockers: string[] = [];
  const warnings: string[] = [];
  const manual: HostReplaceManualItem[] = [];
  const items: HostReplaceItem[] = [];
  const conflicts = new Map<string, HostReplaceConflict>();
  const units: PlanUnit[] = [];
  /** 指纹的原料：每个单元涉及的行和它们现在的样子。 */
  const versions: unknown[] = [];
  /** 这次要在新机上占的端口（含建议换成的端口），互相不能撞。 */
  const planned = new Set<number>();

  if (oldId === newId) blockers.push("旧机和新机不能是同一台");
  if (!isHostConsideredOnline(newHost)) blockers.push("新机不在线：先把新机接入面板、等它上线再换");
  if (dbBool(newHost.maintenanceMode)) warnings.push("新机正在维护中：搬过去的东西要等它结束维护才会被线路和转发组选用");
  if (compareVersions(String(newHost.agentVersion || ""), String(oldHost.agentVersion || "")) < 0) {
    warnings.push(`新机 Agent（${newHost.agentVersion || "未知"}）比旧机（${oldHost.agentVersion || "未知"}）旧，建议先升级新机`);
  }

  const portConflict = async (input: {
    key: string;
    unit: string;
    label: string;
    port: number;
    protocol: string;
    ruleId: number;
    canChange: boolean;
  }) => {
    const problem = await newHostPortProblem(newHost, input.port, input.protocol, [input.ruleId], planned);
    if (!problem) {
      planned.add(input.port);
      return null;
    }
    const suggested = input.canChange ? await suggestPort(newHost, input.protocol, [input.ruleId], planned) : null;
    if (suggested) planned.add(suggested);
    const conflict: HostReplaceConflict = {
      key: input.key,
      unit: input.unit,
      label: input.label,
      detail: problem,
      port: input.port,
      suggestedPort: suggested,
      options: suggested ? ["newPort", "skip"] : ["skip"],
    };
    conflicts.set(input.key, conflict);
    return conflict.key;
  };

  const blocked = (unit: string, label: string, detail: string) => {
    const key = `${unit}:blocked`;
    conflicts.set(key, { key, unit, label, detail, port: null, suggestedPort: null, options: ["skip"] });
  };

  // ---------- 隧道（先清点：入口在旧机上的隧道，它上面的规则跟着隧道走，不算直连规则） ----------
  const tunnelIds = sortUnique([
    ...(await rows(`SELECT ${q("id")} FROM ${q("tunnels")} WHERE ${q("entryHostId")} = ? OR ${q("exitHostId")} = ?`, [oldId, oldId])).map((row) => row.id),
    ...(await rows(`SELECT ${q("tunnelId")} FROM ${q("tunnel_hops")} WHERE ${q("hostId")} = ?`, [oldId])).map((row) => row.tunnelId),
    ...(await rows(`SELECT ${q("tunnelId")} FROM ${q("tunnel_exit_nodes")} WHERE ${q("hostId")} = ?`, [oldId])).map((row) => row.tunnelId),
  ]);
  const tunnelEntryMoving = new Set<number>();
  for (const tunnelId of tunnelIds) {
    const tunnel = await db.getTunnelById(tunnelId) as Row | undefined;
    if (!tunnel) continue;
    const hops = (await db.getTunnelHops(tunnelId) || []) as Row[];
    const exitNodes = (await db.getTunnelExitNodes(tunnelId) || []) as Row[];
    const unit = `tunnel:${tunnelId}`;
    const label = `隧道「${nameOf(tunnel, `#${tunnelId}`)}」`;
    const roles: TunnelUnit["roles"] = [];
    const entryByGroup = Number(tunnel.entryGroupId || 0) > 0;
    const exitByGroup = Number(tunnel.exitGroupId || 0) > 0;
    if (Number(tunnel.entryHostId) === oldId && !entryByGroup) roles.push("entry");
    if (Number(tunnel.exitHostId) === oldId && !exitByGroup) roles.push("exit");
    if (hops.some((hop, index) => Number(hop.hostId) === oldId && index > 0 && index < hops.length - 1)) roles.push("hop");
    if (exitNodes.some((node) => Number(node.hostId) === oldId)) roles.push("extraExit");
    if (roles.length === 0) {
      manual.push({ kind: "tunnel-group", label, detail: "这条隧道的入口 / 出口由入口组、出口组托管：组成员换过去之后隧道自动跟上" });
      continue;
    }
    const members = new Set<number>([
      Number(tunnel.entryHostId), Number(tunnel.exitHostId),
      ...hops.map((hop) => Number(hop.hostId)), ...exitNodes.map((node) => Number(node.hostId)),
    ]);
    const tunnelRules = await rows(`SELECT * FROM ${q("forward_rules")} WHERE ${q("tunnelId")} = ?`, [tunnelId]);
    const listeners: TunnelUnit["listeners"] = [];
    let connectHostPatch: TunnelUnit["connectHostPatch"] = null;
    if (members.has(newId)) {
      blocked(unit, label, "新机已经在这条隧道里（入口、出口或中转），不能再替换旧机");
    } else {
      if (roles.includes("entry")) {
        for (const rule of tunnelRules) {
          if (Number(rule.hostId) !== oldId || dbBool(rule.pendingDelete) || dbBool(rule.isForwardGroupTemplate)) continue;
          if (Number(rule.forwardGroupRuleId || 0) > 0 || Number(rule.routeParentRuleId || 0) > 0) continue;
          const protocol = normalizeForwardRuleProtocol(rule.protocol, "both");
          const listening = dbBool(rule.isEnabled) && Number(rule.sourcePort) > 0;
          const conflictKey = listening
            ? await portConflict({
              key: `${unit}:rule:${rule.id}`,
              unit,
              label: `${label} 上的规则「${nameOf(rule, `#${rule.id}`)}」`,
              port: Number(rule.sourcePort),
              protocol,
              ruleId: Number(rule.id),
              canChange: true,
            })
            : null;
          listeners.push({ rule, ruleId: Number(rule.id), port: Number(rule.sourcePort), protocol, listening, conflictKey });
        }
        tunnelEntryMoving.add(tunnelId);
      }
      if (roles.includes("exit")) {
        const swapped = swapConnectHost(tunnel.connectHost, tunnel.networkType, oldHost, newHost);
        if (swapped.note) manual.push({ kind: "tunnel-connect", label, detail: swapped.note });
        if (swapped.connectHost !== (String(tunnel.connectHost || "").trim() || null) || swapped.networkType !== String(tunnel.networkType || "public")) {
          connectHostPatch = { connectHost: swapped.connectHost, networkType: swapped.networkType };
        }
        const mode = String(tunnel.mode || "").toLowerCase();
        const needsMimic = mode === "forwardx" && dbBool(tunnel.udpOverTcp);
        if (needsMimic && newHost.mimicAvailable === false) warnings.push(`${label} 开着 UDP 伪装，新机还没装 mimic，搬过去后 UDP 用不了`);
        if (dbBool(tunnel.kernelPassthrough)) warnings.push(`${label} 开着内核直通，新机也要是内核 WireGuard 才生效`);
        if (mode === "nginx_stream" && String(tunnel.certDomain || "").trim()) {
          manual.push({ kind: "tunnel-cert", label, detail: `证书域名「${tunnel.certDomain}」要解析到新机` });
        }
      }
    }
    const roleText = roles.map((role) => ({ entry: "入口", exit: "出口", hop: "中转", extraExit: "额外出口" })[role]).join("、");
    items.push({
      unit,
      category: "tunnels",
      label,
      detail: `${roleText}换成新机${listeners.length > 0 ? `，带着 ${listeners.length} 条规则` : ""}；隧道端口在新机上占不到会自动换`,
    });
    units.push({ kind: "tunnel", unit, tunnel, hops, exitNodes, roles, listeners, allRuleIds: tunnelRules.map((rule) => Number(rule.id)), connectHostPatch });
    versions.push([unit, tunnel.updatedAt, tunnel.entryHostId, tunnel.exitHostId, tunnel.listenPort, hops.map((hop) => [hop.id, hop.hostId, hop.listenPort]), exitNodes.map((node) => [node.id, node.hostId, node.listenPort]), tunnelRules.map((rule) => [rule.id, rule.hostId, rule.sourcePort, rule.isEnabled, rule.updatedAt])]);
  }

  // ---------- 直连规则 ----------
  const directRules = await rows(
    `SELECT * FROM ${q("forward_rules")} WHERE ${q("hostId")} = ? AND ${q("pendingDelete")} = ? AND ${q("isForwardGroupTemplate")} = ?
       AND (${q("forwardGroupId")} IS NULL OR ${q("forwardGroupId")} = 0)
       AND (${q("forwardGroupRuleId")} IS NULL OR ${q("forwardGroupRuleId")} = 0)
       AND (${q("routeParentRuleId")} IS NULL OR ${q("routeParentRuleId")} = 0)
     ORDER BY ${q("id")}`,
    [oldId, false, false],
  );
  const sniRules: Row[] = [];
  for (const rule of directRules) {
    const ruleId = Number(rule.id);
    const tunnelId = Number(rule.tunnelId || 0);
    if (tunnelId > 0) {
      if (!tunnelEntryMoving.has(tunnelId) && !conflicts.has(`tunnel:${tunnelId}:blocked`)) {
        manual.push({ kind: "rule-tunnel", label: `规则「${nameOf(rule, `#${ruleId}`)}」`, detail: "走的隧道入口不在旧机上（入口组托管），跟着入口组走" });
      }
      continue;
    }
    if (Number(rule.tlsInboundId || 0) > 0) {
      sniRules.push(rule);
      continue;
    }
    const unit = `rule:${ruleId}`;
    const label = `规则「${nameOf(rule, `#${ruleId}`)}」`;
    const protocol = normalizeForwardRuleProtocol(rule.protocol, "both");
    const listening = dbBool(rule.isEnabled) && Number(rule.sourcePort) > 0;
    const conflictKey = listening
      ? await portConflict({ key: `${unit}:port`, unit, label, port: Number(rule.sourcePort), protocol, ruleId, canChange: true })
      : null;
    items.push({ unit, category: "rules", label, detail: `端口 ${rule.sourcePort} → 新机${listening ? "" : "（停用中，照样搬）"}` });
    units.push({ kind: "rule", unit, rule, listener: { ruleId, port: Number(rule.sourcePort), protocol, listening, conflictKey } });
    versions.push([unit, rule.updatedAt, rule.hostId, rule.sourcePort, rule.isEnabled]);
  }
  if (sniRules.length > 0) {
    manual.push({ kind: "sni-rules", label: `共享 TLS 入站上的 ${sniRules.length} 条规则`, detail: "挂在旧机的 SNI 共享入站上，暂不支持自动搬：在新机建好共享入站后把规则改过去" });
  }

  // ---------- 转发组成员 ----------
  const memberRows = await rows(
    `SELECT * FROM ${q("forward_group_members")} WHERE ${q("memberType")} = ? AND ${q("hostId")} = ? ORDER BY ${q("groupId")}, ${q("id")}`,
    ["host", oldId],
  );
  for (const member of memberRows) {
    const group = await db.getForwardGroupById(Number(member.groupId)) as Row | undefined;
    if (!group) continue;
    const groupId = Number(group.id);
    const unit = `member:${member.id}`;
    const label = `转发组「${nameOf(group, `#${groupId}`)}」的成员`;
    const mode = forwardGroupModeOf(group);
    if (Number(group.poolId || 0) > 0) {
      // 成员跟着节点池同步：改池（下面的节点池单元），组自己会跟上。
      continue;
    }
    const groupMembers = await rows(`SELECT * FROM ${q("forward_group_members")} WHERE ${q("groupId")} = ?`, [groupId]);
    const templates = (await rows(
      `SELECT * FROM ${q("forward_rules")} WHERE ${q("forwardGroupId")} = ? AND ${q("isForwardGroupTemplate")} = ? AND ${q("pendingDelete")} = ?`,
      [groupId, true, false],
    ));
    const collection = mode === "entry" || mode === "exit";
    if (groupMembers.some((row) => row.memberType === "host" && Number(row.hostId) === newId)) {
      blocked(unit, label, "新机已经是这个组的成员：旧成员不动，需要的话在组里把旧机移掉");
    } else if (dbBool(member.isEnabled) && dbBool(group.isEnabled)) {
      if (mode === "entry") {
        const entryTunnels = await rows(`SELECT ${q("id")} FROM ${q("tunnels")} WHERE ${q("entryGroupId")} = ?`, [groupId]);
        try {
          await db.assertTunnelRulePortsFreeOnEntryHosts(entryTunnels.map((row) => Number(row.id)), [newId]);
        } catch (error) {
          blocked(unit, label, error instanceof Error ? error.message : String(error));
        }
      } else if (!collection) {
        const ordered = groupMembers
          .filter((row) => dbBool(row.isEnabled))
          .sort((a, b) => Number(a.priority || 0) - Number(b.priority || 0) || Number(a.id) - Number(b.id));
        // 转发链只有第一台监听模板端口，后面的端口由组同步自己挑。
        const checksTemplatePort = mode !== "chain" || (Number(ordered[0]?.id) === Number(member.id) && !(Number(group.entryGroupId || 0) > 0));
        for (const template of checksTemplatePort ? templates : []) {
          if (!dbBool(template.isEnabled)) continue;
          const child = (await rows(
            `SELECT ${q("id")} FROM ${q("forward_rules")} WHERE ${q("forwardGroupRuleId")} = ? AND ${q("forwardGroupMemberId")} = ?`,
            [Number(template.id), Number(member.id)],
          ))[0];
          const port = Number(template.sourcePort);
          const problem = await newHostPortProblem(newHost, port, normalizeForwardRuleProtocol(template.protocol, "both"), [Number(template.id), Number(child?.id || 0)].filter((id) => id > 0), new Set());
          if (problem) {
            blocked(unit, label, `${problem}（规则「${nameOf(template, `#${template.id}`)}」整组共用这个端口，只能跳过或先改端口）`);
            break;
          }
        }
      }
    }
    const swapped = member.connectHost ? swapConnectHost(member.connectHost, "public", oldHost, newHost) : null;
    if (swapped?.note) manual.push({ kind: "member-connect", label, detail: swapped.note });
    items.push({
      unit,
      category: "groupMembers",
      label,
      detail: collection ? "成员换成新机；用到这个组的隧道、入口域名跟着刷新" : "成员换成新机，组同步会在新机上重建子规则",
    });
    units.push({
      kind: "member",
      unit,
      member,
      group,
      collection,
      connectHost: swapped ? swapped.connectHost : undefined,
      templateIds: templates.filter((template) => Number(template.hostId) === oldId).map((template) => Number(template.id)),
    });
    versions.push([unit, member.updatedAt, member.hostId, member.isEnabled, group.updatedAt, templates.map((t) => [t.id, t.sourcePort, t.isEnabled, t.hostId])]);
  }

  // ---------- 线路组：路径里的中转 / 线路层里的候选 ----------
  const routeRules = await rows(
    `SELECT * FROM ${q("forward_rules")} WHERE ${q("pendingDelete")} = ? AND (${q("routePaths")} IS NOT NULL OR ${q("routeLines")} IS NOT NULL)
       AND (${q("forwardGroupRuleId")} IS NULL OR ${q("forwardGroupRuleId")} = 0)
       AND (${q("routeParentRuleId")} IS NULL OR ${q("routeParentRuleId")} = 0)
     ORDER BY ${q("id")}`,
    [false],
  );
  let landingMemberRoutes = 0;
  for (const rule of routeRules) {
    const ruleId = Number(rule.id);
    // 调度器在哪：隧道规则在隧道出口，其余在规则自己的机器（照 routeLineExpansion.schedulerHostOf）。
    let entryHostId = Number(rule.hostId || 0);
    if (Number(rule.tunnelId || 0) > 0) {
      const tunnel = await db.getTunnelById(Number(rule.tunnelId)).catch(() => null) as Row | null;
      entryHostId = Number(tunnel?.exitHostId || entryHostId);
    }
    // 入口本身就是旧机、会跟着规则 / 隧道搬到新机：拿新机去比。
    if (entryHostId === oldId) entryHostId = newId;
    const pathSwap = swapRoutePathsHost(rule.routePaths, oldId, newId, dbBool(rule.isForwardGroupTemplate) ? null : entryHostId);
    const lineSwap = swapRouteLinesHost(rule.routeLines, oldId, newId);
    if (pathSwap.landingMember) landingMemberRoutes += 1;
    if (!pathSwap.changed && !lineSwap.changed) continue;
    const unit = `route:${ruleId}`;
    const label = `线路组「${nameOf(rule, `#${ruleId}`)}」`;
    if (pathSwap.blocked) blocked(unit, label, pathSwap.blocked);
    items.push({ unit, category: "routeGroups", label, detail: "中转换成新机，中继规则按路径重新同步（中转端口自动挑）" });
    units.push({ kind: "route", unit, rule, routePaths: pathSwap.routePaths, routeLines: lineSwap.routeLines });
    versions.push([unit, rule.updatedAt, rule.routePaths, rule.routeLines]);
  }
  if (landingMemberRoutes > 0) {
    manual.push({ kind: "landing-route", label: `${landingMemberRoutes} 条线路落在旧机的落地池成员上`, detail: "跟着落地池走：在节点池里把旧机换成新机" });
  }

  // ---------- 节点池 ----------
  for (const pool of await rows(`SELECT * FROM ${q("node_pools")} ORDER BY ${q("id")}`)) {
    let hostIds: number[] = [];
    try {
      const parsed = JSON.parse(String(pool.hostIdsJson || "[]"));
      hostIds = Array.isArray(parsed) ? parsed.map(Number).filter((id) => Number.isInteger(id) && id > 0) : [];
    } catch {
      hostIds = [];
    }
    if (!hostIds.includes(oldId)) continue;
    const label = `节点池「${nameOf(pool, `#${pool.id}`)}」`;
    if (String(pool.role || "relay") === "landing") {
      manual.push({ kind: "landing-pool", label, detail: "落地池暂不支持自动搬：在节点池里把旧机换成新机，面板会照池的配置在新机上开入站" });
      continue;
    }
    const unit = `pool:${pool.id}`;
    const next = replaceIdInList(hostIds, oldId, newId);
    items.push({ unit, category: "nodePools", label, detail: hostIds.includes(newId) ? "新机已在池里，旧机从池里拿掉" : "旧机换成新机，用到这个池的线路和转发组自动重新展开" });
    units.push({ kind: "pool", unit, pool, hostIds: next });
    versions.push([unit, pool.updatedAt, pool.hostIdsJson]);
  }

  // ---------- 分组、授权、套餐 ----------
  const pick = async (table: string, column: string) => {
    const withOld = await rows(`SELECT ${q(column)} FROM ${q(table)} WHERE ${q("hostId")} = ?`, [oldId]);
    const withNew = new Set((await rows(`SELECT ${q(column)} FROM ${q(table)} WHERE ${q("hostId")} = ?`, [newId])).map((row) => Number(row[column])));
    return sortUnique(withOld.map((row) => Number(row[column])).filter((id) => !withNew.has(id)));
  };
  const access: AccessUnit = {
    kind: "access",
    unit: "access",
    hostGroupIds: await pick("host_group_members", "groupId"),
    userIds: await pick("user_host_permissions", "userId"),
    planIds: await pick("subscription_plan_hosts", "planId"),
  };
  if (access.hostGroupIds.length + access.userIds.length + access.planIds.length > 0) {
    const parts = [
      access.hostGroupIds.length ? `${access.hostGroupIds.length} 个主机分组` : "",
      access.userIds.length ? `${access.userIds.length} 个用户的授权` : "",
      access.planIds.length ? `${access.planIds.length} 个套餐` : "",
    ].filter(Boolean).join("、");
    items.push({ unit: "access", category: "access", label: "分组和授权", detail: `新机加进 ${parts}（旧机的保留）` });
    units.push(access);
    versions.push(["access", access.hostGroupIds, access.userIds, access.planIds]);
  }

  // ---------- 不自动搬的 ----------
  const countOf = async (sqlText: string, params: unknown[]) => Number((await rows(sqlText, params))[0]?.count || 0);
  const inbounds = await countOf(`SELECT COUNT(*) AS ${q("count")} FROM ${q("proxy_inbounds")} WHERE ${q("hostId")} = ? AND (${q("nodePoolId")} IS NULL OR ${q("nodePoolId")} = 0)`, [oldId]);
  if (inbounds > 0) manual.push({ kind: "proxy-inbounds", label: `${inbounds} 个落地入站（订阅节点）`, detail: "暂不支持自动搬（密钥、证书跟着机器）：在新机上重开，订阅里的节点会换成新地址" });
  const tlsInbounds = await countOf(`SELECT COUNT(*) AS ${q("count")} FROM ${q("host_tls_inbounds")} WHERE ${q("hostId")} = ?`, [oldId]);
  if (tlsInbounds > 0) manual.push({ kind: "tls-inbounds", label: `${tlsInbounds} 个 SNI 共享入站`, detail: "暂不支持自动搬：在新机上建一个同端口的共享入站" });
  const egressRules = await countOf(
    `SELECT COUNT(*) AS ${q("count")} FROM ${q("forward_rules")} r JOIN ${q("proxy_inbounds")} i ON i.${q("id")} = r.${q("egressInboundId")}
      WHERE r.${q("egressType")} = ? AND i.${q("hostId")} = ? AND r.${q("pendingDelete")} = ?`,
    ["ss_host", oldId, false],
  );
  if (egressRules > 0) manual.push({ kind: "egress", label: `${egressRules} 条规则把旧机的落地入站当出口`, detail: "入站不搬，它们照旧从旧机出去；换出口要在规则里改" });
  if (dbBool(oldHost.ddnsEnabled) && String(oldHost.ddnsDomain || "").trim()) {
    manual.push({ kind: "ddns", label: `DDNS「${oldHost.ddnsDomain}」`, detail: "旧机开着 DDNS：在新机上开同一个域名，再把旧机的关掉，不然两台抢一个域名" });
  }
  const firewall = await countOf(`SELECT COUNT(*) AS ${q("count")} FROM ${q("firewall_host_policies")} WHERE ${q("hostId")} = ?`, [oldId]).catch(() => 0);
  if (firewall > 0) manual.push({ kind: "firewall", label: "防火墙策略", detail: "旧机设过防火墙策略，新机要自己设一遍" });
  const billing = await countOf(`SELECT COUNT(*) AS ${q("count")} FROM ${q("traffic_billing_configs")} WHERE ${q("resourceType")} = ? AND ${q("resourceId")} = ?`, ["host", oldId]).catch(() => 0);
  if (billing > 0) manual.push({ kind: "billing", label: "整台按量计费", detail: "旧机配了按量计费，新机要自己配" });
  const ipChange = await countOf(`SELECT COUNT(*) AS ${q("count")} FROM ${q("ip_change_host_configs")} WHERE ${q("hostId")} = ?`, [oldId]).catch(() => 0);
  if (ipChange > 0) manual.push({ kind: "ip-change", label: "自动换 IP", detail: "旧机配了自动换 IP，新机要自己配" });
  const addresses = hostAddresses(oldHost);
  if (addresses.length > 0) {
    const placeholders = addresses.map(() => "?").join(", ");
    const targeting = await countOf(
      `SELECT COUNT(*) AS ${q("count")} FROM ${q("forward_rules")} WHERE LOWER(${q("targetIp")}) IN (${placeholders}) AND ${q("hostId")} <> ? AND ${q("pendingDelete")} = ? AND ${q("isForwardGroupTemplate")} = ?
         AND (${q("routeParentRuleId")} IS NULL OR ${q("routeParentRuleId")} = 0) AND (${q("forwardGroupRuleId")} IS NULL OR ${q("forwardGroupRuleId")} = 0)`,
      [...addresses, oldId, false, false],
    );
    if (targeting > 0) manual.push({ kind: "target-address", label: `${targeting} 条规则的目标写的是旧机地址`, detail: "目标是手填的 IP，不会自动改：搬完把目标改成新机地址" });
    const nodes = await countOf(
      `SELECT COUNT(*) AS ${q("count")} FROM ${q("proxy_nodes")} WHERE LOWER(${q("address")}) IN (${placeholders}) AND (${q("inboundId")} IS NULL OR ${q("inboundId")} = 0)`,
      addresses,
    );
    if (nodes > 0) manual.push({ kind: "node-address", label: `${nodes} 个手填的订阅节点写着旧机地址`, detail: "手填的节点不会自动改：搬完改成新机地址" });
  }
  manual.push({ kind: "external", label: "面板以外的地方", detail: "外部 DNS 指向旧 IP、客户端里写死的旧地址，面板管不到，要自己改" });

  const bridgeHours = await db.getRuleSwitchBridgeHours().catch(() => 0);
  const categories = HOST_REPLACE_CATEGORIES
    .map((category: HostReplaceCategory) => ({
      category,
      label: HOST_REPLACE_CATEGORY_LABELS[category],
      count: items.filter((item) => item.category === category).length,
      note: CATEGORY_NOTES[category],
    }))
    .filter((summary) => summary.count > 0);

  const conflictList = Array.from(conflicts.values());
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({
      oldId,
      newId,
      versions,
      conflicts: conflictList.map((conflict) => [conflict.key, conflict.port, conflict.detail]),
    }, (_key, value) => (value instanceof Date ? value.getTime() : typeof value === "bigint" ? value.toString() : value)))
    .digest("hex")
    .slice(0, 32);

  return {
    oldHost,
    newHost,
    units,
    conflicts,
    preview: {
      oldHost: hostSummary(oldHost),
      newHost: hostSummary(newHost),
      fingerprint,
      categories,
      items,
      conflicts: conflictList,
      manual,
      warnings,
      blockers,
      bridgeHours,
    },
  };
}

const CATEGORY_NOTES: Record<HostReplaceCategory, string> = {
  rules: "入口换成新机；客户端连旧地址的可以先桥到新机",
  tunnels: "隧道端点换成新机，隧道上的规则一起走",
  groupMembers: "组同步在新机上重建子规则，入口域名 / 订阅自动换地址",
  routeGroups: "按路径重新同步中继规则",
  nodePools: "用到池的线路、转发组自动重新展开",
  access: "新机加进同样的分组、授权和套餐",
};
