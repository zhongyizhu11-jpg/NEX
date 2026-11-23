/**
 * 换隧道后旧入口临时桥接的面板侧流程（数据口径见 shared/ruleEntryBridge）。
 *
 *   · 规则编辑：换到别的入口主机时在旧入口留桥接（prepare / apply 两步，见下）；
 *   · 心跳：把这台主机上生效中的桥接合成成一条条普通的 iptables 规则行，交给现有的下发
 *     流程生成动作 —— Agent 一行都不用改，已装的 Agent 直接就能跑；
 *   · 调度器：到期的删掉，并叫那几台机器撤掉监听。
 */
import * as db from "./db";
import { pushAgentRefresh } from "./agentEvents";
import { appendPanelLog } from "./_core/panelLogger";
import { gateForwardRulesForRuntime } from "./linkAccessView";
import { reserveSpecificHostPort, type HostPortReservation } from "./portReservations";
import { dbBool } from "./repositories/repositoryUtils";
import { formatHostAddressWithPort, getHostEntryAddress } from "../shared/hostEntryAddress";
import { normalizeForwardRuleProtocol } from "../shared/forwardTypes";
import {
  ENTRY_BRIDGE_FORWARD_TYPE,
  entryBridgeHostsForSwitch,
  entryBridgeIdFromRuleId,
  entryBridgeRuleId,
  isEntryBridgeRuleId,
} from "../shared/ruleEntryBridge";
import type { RuleEntryBridgeRow } from "./repositories/ruleEntryBridgeRepository";

// ==================== 规则编辑 ====================

export type RuleEntryBridgeSwitchPlan = {
  ruleId: number;
  /** 这次改动换了入口主机：这条规则现有桥接的计时要从这一刻重新算。 */
  entryChanged: boolean;
  /** 规则改完之后在哪些主机上监听：这些主机上的桥接要让位给规则本身。 */
  newListenHostIds: number[];
  /** 这次要新留桥接的旧入口主机（老端口已经占住）。 */
  bridgeHostIds: number[];
  sourcePort: number;
  protocol: string;
  hours: number;
};

/**
 * 写库之前调用：算出这次改动要不要留桥接、留在哪几台，并把旧入口上的老端口先占住。
 *
 * 必须在写库前占：规则一写到新入口，老端口在库里就空出来了，另一条同时在建的规则可能正好
 * 抢走它 —— 桥接再建就晚了。占到的预留交给调用方放进它自己的 heldReservations，
 * 请求结束时统一释放（那时桥接已经落库，端口由桥接自己占着）。
 *
 * 只对「原来启用着、真的在监听」的普通规则留桥接：停用的规则本来就没有客户端在用；转发组 /
 * 线路组的托管规则不走这条编辑路径。设置为 0 小时就只做清理不建桥接。
 */
export async function prepareRuleEntryBridgeSwitch(input: {
  rule: any;
  nextHostId: number;
  nextTunnelId: number | null;
  reservations: HostPortReservation[];
}): Promise<RuleEntryBridgeSwitchPlan> {
  const rule = input.rule;
  const ruleId = Number(rule?.id || 0);
  const oldHostId = Number(rule?.hostId || 0);
  const nextHostId = Number(input.nextHostId || 0);
  const sourcePort = Number(rule?.sourcePort || 0);
  const protocol = normalizeForwardRuleProtocol(rule?.protocol, "both");
  const newListenHostIds = await db.forwardRuleListenHostIds(nextHostId, input.nextTunnelId);
  const plan: RuleEntryBridgeSwitchPlan = {
    ruleId,
    entryChanged: ruleId > 0 && oldHostId !== nextHostId,
    newListenHostIds,
    bridgeHostIds: [],
    sourcePort,
    protocol,
    hours: 0,
  };
  if (!plan.entryChanged) return plan;
  plan.hours = await db.getRuleSwitchBridgeHours();
  const listening = dbBool(rule?.isEnabled)
    && !dbBool(rule?.pendingDelete)
    && !dbBool(rule?.isForwardGroupTemplate)
    && !Number(rule?.forwardGroupRuleId || 0)
    && !Number(rule?.routeParentRuleId || 0);
  if (plan.hours <= 0 || !listening || sourcePort <= 0) return plan;
  const oldListenHostIds = await db.forwardRuleListenHostIds(oldHostId, rule?.tunnelId);
  for (const hostId of entryBridgeHostsForSwitch(oldListenHostIds, newListenHostIds)) {
    const reservation = await reserveSpecificHostPort({
      hostId,
      port: sourcePort,
      protocol,
      isUsed: (port) => db.isPortUsedOnHost(hostId, port, [ruleId], protocol, undefined, false),
    });
    if (!reservation) {
      appendPanelLog("warn", `[EntryBridge] rule=${ruleId} host=${hostId} port=${sourcePort} is taken; old entry bridge skipped`);
      continue;
    }
    input.reservations.push(reservation);
    plan.bridgeHostIds.push(hostId);
  }
  return plan;
}

/**
 * 写库之后调用：规则回到的主机上删掉它的桥接，旧入口上建新桥接（并顺延这条规则所有桥接的
 * 到期时间），最后叫所有相关的旧入口重算一次 —— 规则改了端口 / 入口，桥接的目标跟着变。
 */
export async function applyRuleEntryBridgeSwitch(plan: RuleEntryBridgeSwitchPlan, reason: string) {
  if (!plan.ruleId) return;
  const released = await db.deleteRuleEntryBridgesOnHosts(plan.ruleId, plan.newListenHostIds);
  // 换了入口就重新计时（没有新桥接要建时也一样，比如老端口被占了、原来是停用的）。
  if (plan.entryChanged && plan.hours > 0) {
    await db.recordRuleEntryBridges({
      ruleId: plan.ruleId,
      hostIds: plan.bridgeHostIds,
      sourcePort: plan.sourcePort,
      protocol: plan.protocol,
      hours: plan.hours,
    });
    if (plan.bridgeHostIds.length > 0) {
      appendPanelLog(
        "info",
        `[EntryBridge] rule=${plan.ruleId} old entry hosts=${plan.bridgeHostIds.join(",")} port=${plan.sourcePort} protocol=${plan.protocol} bridged for ${plan.hours}h`,
      );
    }
  }
  if (released.length > 0) {
    appendPanelLog("info", `[EntryBridge] rule=${plan.ruleId} returned to hosts=${released.join(",")}; bridges removed`);
  }
  const affected = new Set<number>([...released, ...await db.getRuleEntryBridgeHostIds(plan.ruleId)]);
  for (const hostId of affected) pushAgentRefresh(hostId, reason);
}

/** 规则开关 / 删除之后：叫这条规则桥接所在的旧入口重算（停用、删除的规则桥接不再下发）。 */
export async function refreshRuleEntryBridgeHosts(ruleId: number, reason: string, options: { deleteBridges?: boolean } = {}) {
  const hostIds = options.deleteBridges
    ? await db.deleteRuleEntryBridgesForRules([ruleId])
    : await db.getRuleEntryBridgeHostIds(ruleId);
  for (const hostId of hostIds) pushAgentRefresh(hostId, reason);
  return hostIds;
}

/** 端口被占时的报错：被桥接占着就说清楚是谁、多久后放开，否则用调用方原来的话。 */
export async function entryBridgeAwarePortError(
  hostIds: readonly unknown[],
  port: number,
  excludeRuleIds: readonly unknown[],
  fallback: string,
) {
  const message = await db.entryBridgePortConflictMessageForHosts(hostIds, port, excludeRuleIds).catch(() => null);
  return new Error(message || fallback);
}

/** 调度器：删掉到期的桥接，并叫那些机器撤掉监听。 */
export async function sweepExpiredRuleEntryBridges(now = Date.now()) {
  const hostIds = await db.deleteExpiredRuleEntryBridges(now);
  for (const hostId of hostIds) pushAgentRefresh(hostId, "rule-entry-bridge-expired");
  if (hostIds.length > 0) {
    appendPanelLog("info", `[EntryBridge] expired bridges removed hosts=${hostIds.join(",")}`);
  }
  return hostIds;
}

// ==================== 心跳 ====================

/** 心跳里合成出来的那一行带着它，下发流程里几处据此区别对待（见 isEntryBridgeRuntimeRule）。 */
type EntryBridgeRuntimeMarker = { bridgeId: number; ruleId: number; expiresAt: Date | null };

export function isEntryBridgeRuntimeRule(rule: any): boolean {
  return !!rule?.entryBridge || isEntryBridgeRuleId(rule?.id);
}

/**
 * 把一条桥接合成成一行「普通的 iptables 规则」。
 *
 * 字段按一条最朴素的直连规则填：不走隧道、不开主备 / 线路组、不收发 PROXY 头、不开 TFO，
 * 这样下发流程里那些按规则开关分叉的地方全走最简单的那条路。userId 用原规则的主人：
 * 目标解析的内网拦截按主人的角色判断，和原规则一致。
 */
export function entryBridgeRuntimeRule(input: {
  bridge: RuleEntryBridgeRow;
  hostId: number;
  ownerUserId: number;
  targetAddress: string;
  targetPort: number;
  isRunning: boolean;
}) {
  const { bridge } = input;
  const marker: EntryBridgeRuntimeMarker = { bridgeId: bridge.id, ruleId: bridge.ruleId, expiresAt: bridge.expiresAt };
  return {
    id: entryBridgeRuleId(bridge.id),
    hostId: Number(input.hostId),
    name: `规则 #${bridge.ruleId} 旧入口桥接`,
    forwardType: ENTRY_BRIDGE_FORWARD_TYPE,
    protocol: normalizeForwardRuleProtocol(bridge.protocol, "both"),
    gostMode: "direct",
    gostRelayHost: null,
    gostRelayPort: null,
    tunnelId: null,
    tunnelExitPort: null,
    forwardGroupId: null,
    forwardGroupRuleId: null,
    forwardGroupMemberId: null,
    isForwardGroupTemplate: false,
    sourcePort: Number(bridge.sourcePort),
    targetIp: input.targetAddress,
    targetPort: Number(input.targetPort),
    telegramErrorNotifyEnabled: false,
    blockHttp: false,
    blockSocks: false,
    blockTls: false,
    proxyProtocolReceive: false,
    proxyProtocolSend: false,
    proxyProtocolExitReceive: false,
    proxyProtocolExitSend: false,
    proxyProtocolVersion: 1,
    tcpFastOpen: false,
    zeroCopy: false,
    udpOverTcp: false,
    udpOverTcpPort: null,
    protocolBlockReason: null,
    isEnabled: true,
    failoverEnabled: false,
    failoverTargets: null,
    failoverProbeTarget: null,
    failoverSchedule: null,
    failoverPinnedIndex: null,
    failoverPinnedUntil: null,
    failoverActiveTarget: null,
    routeMode: null,
    routePaths: null,
    routeParentRuleId: null,
    routePathKey: null,
    routeHopIndex: null,
    disabledByTunnel: false,
    disabledByGroup: false,
    disabledByUser: false,
    isRunning: !!input.isRunning,
    pendingDelete: false,
    proxyNodeId: null,
    userId: Number(input.ownerUserId || 0),
    entryBridge: marker,
  };
}

/**
 * 心跳用的纯计算：这台主机上的桥接各自该不该下发、下发成什么样。
 *
 *   · 规则已经回到这台机器，或这台机器上有真规则用着同一个端口：不下发（端口归真规则）；
 *   · 规则被闸掉了（停用、资源权限没了）、成了转发组模板：不下发；
 *   · 目标取规则**当前**的入口地址 + 当前端口，规则再换入口时桥接自动跟过去；
 *   · 目标和上次下发的不一样：记下新目标、按「未运行」处理，下发流程随即重下。
 */
export function planEntryBridgeRuntime(input: {
  hostId: number;
  bridges: readonly RuleEntryBridgeRow[];
  rulesById: ReadonlyMap<number, any>;
  hostsById: ReadonlyMap<number, any>;
  localRules: readonly any[];
}) {
  const hostId = Number(input.hostId);
  const takenPorts = new Set<number>();
  for (const rule of input.localRules) {
    if (!rule || isEntryBridgeRuntimeRule(rule)) continue;
    if (!dbBool(rule.isEnabled) || dbBool(rule.pendingDelete)) continue;
    const port = Number(rule.sourcePort || 0);
    if (port > 0) takenPorts.add(port);
  }
  const rows: ReturnType<typeof entryBridgeRuntimeRule>[] = [];
  const retarget: Array<{ bridgeId: number; runtimeTarget: string }> = [];
  for (const bridge of input.bridges) {
    const rule = input.rulesById.get(Number(bridge.ruleId));
    if (!rule || !dbBool(rule.isEnabled) || dbBool(rule.pendingDelete) || dbBool(rule.isForwardGroupTemplate)) continue;
    if (Number(rule.hostId) === hostId || takenPorts.has(Number(bridge.sourcePort))) continue;
    const address = getHostEntryAddress(input.hostsById.get(Number(rule.hostId)));
    const targetPort = Number(rule.sourcePort || 0);
    if (!address || targetPort <= 0) continue;
    const runtimeTarget = formatHostAddressWithPort(address, targetPort);
    const targetChanged = String(bridge.runtimeTarget || "") !== runtimeTarget;
    let row: ReturnType<typeof entryBridgeRuntimeRule>;
    try {
      row = entryBridgeRuntimeRule({
        bridge,
        hostId,
        ownerUserId: Number(rule.userId || 0),
        targetAddress: address,
        targetPort,
        isRunning: bridge.isRunning && !targetChanged,
      });
    } catch {
      // 桥接 id 超出编号段（实际到不了）：宁可不桥接，也不能让整次心跳失败。
      continue;
    }
    if (targetChanged) retarget.push({ bridgeId: bridge.id, runtimeTarget });
    rows.push(row);
    takenPorts.add(Number(bridge.sourcePort));
  }
  return { rows, retarget };
}

/**
 * 心跳入口：读这台主机上生效中的桥接，合成规则行。
 *
 * 原规则要先过一遍 gateForwardRulesForRuntime：主人没了权限、套餐停了、规则被连带停掉……
 * 原规则在新入口上不跑，桥接也不该替它在旧入口上接着转。
 */
export async function loadEntryBridgeRuntimeRules(hostId: number, localRules: readonly any[]) {
  const bridges = await db.getActiveRuleEntryBridgesForHost(hostId);
  if (bridges.length === 0) return [];
  const rawRules = await db.getForwardRulesByIds(bridges.map((bridge) => bridge.ruleId));
  const gatedRules = await gateForwardRulesForRuntime(rawRules as any[]);
  const rulesById = new Map((gatedRules as any[]).map((rule) => [Number(rule.id), rule]));
  const hosts = await db.getHostsByIds((gatedRules as any[]).map((rule) => Number(rule.hostId)));
  const hostsById = new Map((hosts as any[]).map((host) => [Number(host.id), host]));
  const plan = planEntryBridgeRuntime({ hostId, bridges, rulesById, hostsById, localRules });
  for (const item of plan.retarget) {
    await db.resetRuleEntryBridgeRuntime(item.bridgeId, item.runtimeTarget);
    appendPanelLog("info", `[EntryBridge] host=${hostId} bridge=${item.bridgeId} target=${item.runtimeTarget}; reapply`);
  }
  return plan.rows;
}

/**
 * 按规则 id 写运行状态：桥接写桥接表，真规则照旧写规则表。
 * 心跳里几处「把规则标成运行 / 未运行」都走这里，免得拿桥接的编号去更新 forward_rules。
 */
export async function setRuntimeRuleRunning(ruleId: number, running: boolean) {
  if (isEntryBridgeRuleId(ruleId)) {
    await db.markRuleEntryBridgeRunning(entryBridgeIdFromRuleId(ruleId), running);
    return;
  }
  await db.updateRuleRunningStatus(ruleId, running);
}

/** 同上，批量标成未运行。 */
export async function markRuntimeRulesNotRunning(ruleIds: readonly number[]) {
  const real: number[] = [];
  for (const id of ruleIds) {
    if (isEntryBridgeRuleId(id)) await db.markRuleEntryBridgeRunning(entryBridgeIdFromRuleId(id), false);
    else real.push(Number(id));
  }
  if (real.length > 0) await db.markForwardRulesNotRunning(real);
}

/**
 * Agent 报上来的桥接运行状态（/api/agent/rule-status 里 ruleId 落在桥接编号段的那些）。
 * 桥接已经没了（到期、规则换回来）就当过期消息吃掉，回 200 免得 Agent 反复重试。
 */
export async function applyEntryBridgeStatus(host: { id: unknown }, payload: any) {
  const bridge = await db.getRuleEntryBridgeById(entryBridgeIdFromRuleId(payload?.ruleId));
  if (!bridge || Number(bridge.hostId) !== Number(host.id)) {
    return { status: 200, body: { success: true, ignored: true } };
  }
  const reportedPort = Number(payload?.sourcePort || 0);
  if (reportedPort > 0 && reportedPort !== Number(bridge.sourcePort)) {
    return { status: 200, body: { success: true, ignored: true, stale: true } };
  }
  await db.markRuleEntryBridgeRunning(bridge.id, !!payload?.isRunning);
  if (!payload?.isRunning) {
    const message = typeof payload?.message === "string"
      ? payload.message.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 300)
      : "";
    appendPanelLog("warn", `[EntryBridge] host=${Number(host.id)} bridge=${bridge.id} rule=${bridge.ruleId} port=${bridge.sourcePort} not running${message ? ` message=${message}` : ""}`);
  }
  return { status: 200, body: { success: true } };
}
