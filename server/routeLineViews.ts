import * as db from "./db";
import { queryRaw, quoteDbIdentifier } from "./dbRuntime";
import { dbBool } from "./repositories/repositoryUtils";
import { getRouteStatus, routeLatencyIntoHost, routeTrippedNodeIds } from "./routeGroupStats";
import { describeRouteReason, routeEventMillis, routeGroupOf, type RoutePath } from "../shared/routeGroup";
import { parseRouteLines } from "../shared/routeLines";
import { normalizeExitGroupStrategy } from "../shared/exitStrategy";

const q = quoteDbIdentifier;

/*
  线路工作台和节点详情要的几份视图：
    · lineWorkspace：看板头（在线节点、24 小时告警、已自动恢复、最近几条）。
    · linesThroughHost：经过某台机器的线路，以及此刻是在走它还是避开了它。
  线路卡本身还是 rules.routeBoard（server/routeStatusView.ts）。
*/

const ALERT_KINDS = new Set(["unhealthy", "issue", "precheck_failed", "slow_dial", "flap_hold"]);
const FAILURE_SWITCH = /health check|dial failed|relay down|maintenance|breaker|node offline|paused/i;

/** 线路序号：同一条线路展开的几条路径算一条，按 tier 排（0 = 主线路）。老数据每条路径一条线路。 */
export function routePathLineIndex(paths: readonly RoutePath[]) {
  const order: Array<{ key: string; tier: number }> = [];
  for (const [index, path] of paths.entries()) {
    const key = path.lineKey || path.key;
    if (!order.some((item) => item.key === key)) order.push({ key, tier: typeof path.tier === "number" ? path.tier : index });
  }
  order.sort((a, b) => a.tier - b.tier);
  const byKey = new Map(order.map((item, index) => [item.key, index]));
  return (path: RoutePath) => byKey.get(path.lineKey || path.key) ?? 0;
}

const lineName = (index: number) => (index === 0 ? "主线路" : `备 ${index}`);

/** 故障看板一行：左边出了什么事，右边系统做了什么。 */
export type LineAlertRow = { tone: "down" | "warn" | "ok"; text: string; action: string; at: number; ruleId: number };

function switchAlert(row: any, ruleName: string): LineAlertRow | null {
  const kind = String(row.kind || "");
  const reason = String(row.reason || "");
  const lower = reason.toLowerCase();
  const at = routeEventMillis(row.createdAt);
  const ruleId = Number(row.ruleId);
  if (kind === "switch") {
    if (/failback/.test(lower)) return { tone: "ok", text: `${ruleName} 主线路恢复`, action: "自动切回", at, ruleId };
    if (/relay recovered/.test(lower)) return { tone: "ok", text: `${ruleName} 中转恢复`, action: "已恢复", at, ruleId };
    if (lower.startsWith("relay down:")) return { tone: "down", text: reason.slice("relay down:".length).trim() || `${ruleName} 中转异常`, action: "已切换线路", at, ruleId };
    if (lower === "health check") return { tone: "down", text: `${ruleName} ${row.fromLabel || "当前线路"}探不通`, action: "已切换线路", at, ruleId };
    if (lower === "dial failed") return { tone: "down", text: `${ruleName} 新连接拨不通`, action: "已切换线路", at, ruleId };
    if (FAILURE_SWITCH.test(reason)) return { tone: "down", text: `${ruleName} ${describeRouteReason(reason)}`, action: "已切换线路", at, ruleId };
    return null;
  }
  if (kind === "recovered") return { tone: "ok", text: `${ruleName} ${row.toLabel || "线路"}恢复`, action: "重新参与", at, ruleId };
  if (kind === "unhealthy" || kind === "issue") return { tone: "down", text: `${ruleName} ${describeRouteReason(reason) || "线路异常"}`, action: "已标记", at, ruleId };
  if (kind === "slow_dial") return { tone: "warn", text: `${ruleName} 连接变慢`, action: "已复查", at, ruleId };
  if (kind === "flap_hold") return { tone: "warn", text: `${ruleName} 线路来回切`, action: "暂停自动切换", at, ruleId };
  if (kind === "precheck_failed") return { tone: "warn", text: `${ruleName} 计划切换预检不过`, action: "留在原线路", at, ruleId };
  return null;
}

export async function lineWorkspace(actor: { id: number; role: string }, hours = 24) {
  const isAdmin = actor.role === "admin";
  const rules = (await db.getForwardRules(isAdmin ? undefined : actor.id, undefined, { failoverOnly: true }) as any[])
    .filter((rule) => !!routeGroupOf(rule) && !dbBool(rule.pendingDelete) && !(Number(rule.forwardGroupRuleId || 0) > 0));
  const hostIds = new Set<number>();
  const linesByHost = new Map<number, Set<number>>();
  for (const rule of rules) {
    hostIds.add(Number(rule.hostId));
    for (const path of routeGroupOf(rule)!.paths) {
      for (const hop of path.hops) {
        hostIds.add(Number(hop));
        if (!linesByHost.has(Number(hop))) linesByHost.set(Number(hop), new Set());
        linesByHost.get(Number(hop))!.add(Number(rule.id));
      }
    }
  }
  const hosts = hostIds.size > 0 ? await db.getHostsByIds(Array.from(hostIds)) as any[] : [];
  const tripped = routeTrippedNodeIds();
  const since = Math.floor((Date.now() - hours * 3600_000) / 1000);
  const ruleIds = rules.map((rule) => Number(rule.id));
  const events = ruleIds.length > 0
    ? await queryRaw<any>(
      `SELECT * FROM ${q("forward_rule_route_events")} WHERE ${q("createdAt")} >= ? AND ${q("ruleId")} IN (${ruleIds.map(() => "?").join(",")}) ORDER BY ${q("createdAt")} DESC LIMIT 400`,
      [since, ...ruleIds],
    ).catch(() => [] as any[])
    : [];
  const nameByRule = new Map(rules.map((rule) => [Number(rule.id), String(rule.name || "")]));
  let alerts = 0;
  let recovered = 0;
  const recent: LineAlertRow[] = [];
  const nowMs = Date.now();
  // 此刻还在的问题排前面：维护、熔断、离线的中转，各自有几条线路在避开它。
  for (const host of hosts) {
    const id = Number(host.id);
    const through = linesByHost.get(id)?.size || 0;
    if (through === 0) continue;
    const name = String(host.name || `主机 ${id}`);
    if (dbBool(host.maintenanceMode)) recent.push({ tone: "warn", text: `${name} 维护中`, action: `${through} 条线路避开`, at: nowMs, ruleId: 0 });
    else if (tripped.has(id)) recent.push({ tone: "down", text: `${name} 熔断`, action: `${through} 条线路避开`, at: nowMs, ruleId: 0 });
    else if (!dbBool(host.isOnline)) recent.push({ tone: "down", text: `${name} 离线`, action: `${through} 条线路避开`, at: nowMs, ruleId: 0 });
  }
  const seen = new Set<string>();
  const eventRows: LineAlertRow[] = [];
  for (const row of events) {
    const kind = String(row.kind || "");
    const reason = String(row.reason || "");
    const failureSwitch = kind === "switch" && FAILURE_SWITCH.test(reason);
    const isAlert = ALERT_KINDS.has(kind) || failureSwitch;
    const isRecovery = kind === "recovered" || (kind === "switch" && /failback|relay recovered/i.test(reason));
    if (isAlert) alerts += 1;
    if (isRecovery) recovered += 1;
    if (!isAlert && !isRecovery) continue;
    const alert = switchAlert(row, nameByRule.get(Number(row.ruleId)) || `规则 ${row.ruleId}`);
    if (!alert) continue;
    const key = `${alert.ruleId}:${alert.tone}:${alert.action}`;
    if (seen.has(key)) continue;
    seen.add(key);
    eventRows.push(alert);
  }
  recent.push(...eventRows);
  const maintenance = hosts.filter((host) => dbBool(host.maintenanceMode));
  return {
    hosts: {
      total: hosts.length,
      online: hosts.filter((host) => dbBool(host.isOnline)).length,
      maintenance: maintenance.length,
      tripped: hosts.filter((host) => tripped.has(Number(host.id))).length,
    },
    lines: rules.length,
    alerts,
    recovered,
    recent: recent.slice(0, 6),
    hours,
  };
}

export type HostLineImpact = {
  ruleId: number;
  name: string;
  /** 「备 2 → 已避开」「主线路 → 已切到 备 1」「不受影响」「主线路 · 在走」 */
  impact: string;
  tone: "ok" | "warn" | "down" | "gray";
  usingNow: boolean;
  /** 这台机器在哪几条线路里（0 = 主线路）。 */
  lineIndexes: number[];
  entry: boolean;
  /** 这条线路的「恢复观察」秒数：维护结束后要探通、稳定这么久才切回来。 */
  recoverSeconds?: number;
};

/**
 * 经过这台机器的线路，以及它此刻对每条线路意味着什么。avoiding = 这台机器正被避开（维护、熔断、
 * 离线）：说清楚每条线路是已经避开了、切到了哪条、还是根本不受影响；没在避开时说它在哪条线路里、
 * 在不在走。
 */
export function describeHostLineImpact(input: {
  hostId: number;
  isEntry: boolean;
  paths: readonly RoutePath[];
  activeIndex: number;
  avoiding: boolean;
}): Omit<HostLineImpact, "ruleId" | "name"> {
  const lineOf = routePathLineIndex(input.paths);
  const through = input.paths.filter((path) => path.hops.includes(input.hostId));
  const lineIndexes = Array.from(new Set(through.map(lineOf))).sort((a, b) => a - b);
  const active = input.activeIndex >= 0 ? input.paths[input.activeIndex] || null : null;
  const activeLine = active ? lineOf(active) : -1;
  const usingNow = !!active && (input.isEntry || active.hops.includes(input.hostId));
  const names = (indexes: number[]) => indexes.map(lineName).join("、");
  if (input.isEntry) {
    return { impact: input.avoiding ? "入口在这台：整条线路都受影响" : "入口在这台", tone: input.avoiding ? "down" : "ok", usingNow, lineIndexes, entry: true };
  }
  if (!input.avoiding) {
    if (usingNow) return { impact: `${lineName(activeLine)} · 在走`, tone: "ok", usingNow, lineIndexes, entry: false };
    return { impact: `${names(lineIndexes)} · 待命`, tone: "gray", usingNow, lineIndexes, entry: false };
  }
  if (usingNow) return { impact: `${lineName(activeLine)} → 还在走，等切走`, tone: "warn", usingNow, lineIndexes, entry: false };
  if (activeLine >= 0 && lineIndexes.includes(activeLine)) return { impact: "不受影响", tone: "ok", usingNow, lineIndexes, entry: false };
  if (lineIndexes.includes(0) && activeLine > 0) return { impact: `主线路 → 已切到 ${lineName(activeLine)}`, tone: "warn", usingNow, lineIndexes, entry: false };
  if (lineIndexes.length > 0) return { impact: `${names(lineIndexes)} → 已避开`, tone: "gray", usingNow, lineIndexes, entry: false };
  return { impact: "不受影响", tone: "ok", usingNow, lineIndexes, entry: false };
}

export async function linesThroughHost(hostId: number, actor: { id: number; role: string }) {
  const id = Number(hostId);
  const host = await db.getHostById(id).catch(() => null) as any;
  const avoiding = !!host && (dbBool(host.maintenanceMode) || routeTrippedNodeIds().has(id) || !dbBool(host.isOnline));
  const rules = (await db.getForwardRules(actor.role === "admin" ? undefined : actor.id, undefined, { failoverOnly: true }) as any[])
    .filter((rule) => !dbBool(rule.pendingDelete) && !(Number(rule.forwardGroupRuleId || 0) > 0));
  const out: HostLineImpact[] = [];
  for (const rule of rules) {
    const group = routeGroupOf(rule);
    if (!group) continue;
    const isEntry = Number(rule.hostId) === id;
    if (!isEntry && !group.paths.some((path) => path.hops.includes(id))) continue;
    const status = getRouteStatus(Number(rule.id));
    const activeIndex = status.agent ? status.agent.activeIndex : -1;
    out.push({
      ruleId: Number(rule.id),
      name: String(rule.name || ""),
      ...describeHostLineImpact({ hostId: id, isEntry, paths: group.paths, activeIndex, avoiding }),
      recoverSeconds: Number(group.policy.recoverSeconds || 0),
    });
  }
  return out.slice(0, 50);
}

// ---------------------------------------------------------------- 节点池一页（入口组 / 中转 / 落地 / 出口合成一种）

type PoolMemberView = { hostId: number; name: string; tone: "ok" | "warn" | "down"; state: string; latencyMs: number | null };

function hostState(host: any, tripped: Set<number>): { tone: "ok" | "warn" | "down"; state: string } {
  if (!host) return { tone: "down", state: "不在了" };
  if (dbBool(host.maintenanceMode)) return { tone: "warn", state: "维护" };
  if (tripped.has(Number(host.id))) return { tone: "down", state: "熔断" };
  if (!dbBool(host.isOnline)) return { tone: "down", state: "离线" };
  return { tone: "ok", state: "" };
}

function hostAddressForRecord(host: any, member: any, recordType: string) {
  if (member?.connectHost) return String(member.connectHost).trim();
  if (!host) return "";
  if (recordType === "AAAA") return String(host.ipv6 || "").trim();
  return String(host.ipv4 || host.ip || "").trim();
}

export async function poolBoard(actor: { id: number; role: string }) {
  const isAdmin = actor.role === "admin";
  const { listNodePools } = await import("./nodePools");
  const pools = await listNodePools(isAdmin ? null : actor.id);
  const groups = (await db.getForwardGroups(isAdmin ? undefined : actor.id).catch(() => [] as any[]) as any[])
    .filter((group) => ["entry", "failover", "exit"].includes(String(group.groupMode || "")));
  const memberRows = groups.length > 0
    ? await queryRaw<any>(`SELECT * FROM ${q("forward_group_members")} WHERE ${q("groupId")} IN (${groups.map(() => "?").join(",")}) ORDER BY ${q("priority")} ASC`, groups.map((group) => Number(group.id))).catch(() => [] as any[])
    : [];
  const hostIds = new Set<number>(pools.flatMap((pool) => pool.hostIds));
  for (const member of memberRows) if (Number(member.hostId) > 0) hostIds.add(Number(member.hostId));
  const hosts = hostIds.size > 0 ? await db.getHostsByIds(Array.from(hostIds)) as any[] : [];
  const hostById = new Map(hosts.map((host) => [Number(host.id), host]));
  const tripped = routeTrippedNodeIds();

  // 节点池用在几条线路、怎么挑：看规则里引用它的那几层。
  const rules = (await db.getForwardRules(isAdmin ? undefined : actor.id, undefined, { failoverOnly: true }) as any[])
    .filter((rule) => !dbBool(rule.pendingDelete) && !(Number(rule.forwardGroupRuleId || 0) > 0) && rule.routeLines);
  const usage = new Map<number, { rules: Set<number>; picks: Set<string> }>();
  for (const rule of rules) {
    for (const line of parseRouteLines(rule.routeLines)) {
      for (const layer of line.layers) {
        if (layer.kind !== "pool" || !layer.poolId) continue;
        if (!usage.has(layer.poolId)) usage.set(layer.poolId, { rules: new Set(), picks: new Set() });
        usage.get(layer.poolId)!.rules.add(Number(rule.id));
        usage.get(layer.poolId)!.picks.add(layer.pick);
      }
    }
  }
  // 成员的毫秒数：任一中转 / 入口探它的那一段里最快的（没人探过 = null）。
  const latencyInto = (hostId: number) => routeLatencyIntoHost(hostId);

  const nodePools = pools.map((pool) => {
    const members: PoolMemberView[] = pool.hostIds.map((hostId) => {
      const host = hostById.get(hostId);
      return { hostId, name: String(host?.name || `主机 ${hostId}`), ...hostState(host, tripped), latencyMs: latencyInto(hostId) };
    });
    const used = usage.get(pool.id);
    const picks = used ? Array.from(used.picks) : [];
    return {
      id: pool.id,
      name: pool.name,
      role: pool.role,
      note: pool.note,
      hostIds: pool.hostIds,
      members,
      usable: members.filter((member) => member.tone === "ok").length,
      total: members.length,
      lines: used ? used.rules.size : 0,
      pick: picks.length === 0 ? null : picks.length > 1 ? "混用" : picks[0] === "order" ? "按顺序" : "整链最优",
    };
  });

  let ddnsProvider: string | null = null;
  try {
    const { getDdnsSettings } = await import("./ddns");
    const settings: any = await getDdnsSettings();
    ddnsProvider = settings?.enabled && settings.provider && settings.provider !== "disabled" ? String(settings.provider) : null;
  } catch {
    ddnsProvider = null;
  }
  const providerLabel = (provider: string | null) => {
    const text = String(provider || "").toLowerCase();
    if (text === "cloudflare") return "Cloudflare";
    if (text === "aliyun" || text === "alidns") return "阿里云 DNS";
    if (text === "dnspod" || text === "tencent") return "DNSPod";
    if (text === "huawei") return "华为云 DNS";
    return provider ? String(provider) : null;
  };

  const entryGroups = groups.filter((group) => group.groupMode === "entry" || group.groupMode === "failover").map((group) => {
    const recordType = String(group.recordType || "A").toUpperCase();
    const inDns = new Set(String(group.lastDdnsValue || "").split(",").map((value) => value.trim()).filter(Boolean));
    const failover = group.groupMode === "failover";
    // 主备：解析只指向「在用」那一台（activeMemberId），其余健康的是待命，不算坏。
    const activeMemberId = Number(group.activeMemberId || 0);
    const members = memberRows.filter((member) => Number(member.groupId) === Number(group.id) && Number(member.hostId) > 0).map((member) => {
      const host = hostById.get(Number(member.hostId));
      const value = hostAddressForRecord(host, member, recordType);
      const listed = failover && activeMemberId > 0 ? Number(member.id) === activeMemberId : !!value && inDns.has(value);
      const health = hostState(host, tripped);
      const enabled = dbBool(member.isEnabled, true);
      const unhealthy = String(member.healthStatus || "") === "failed";
      let state: string;
      let tone: "ok" | "warn" | "down" | "gray";
      if (!enabled) { state = "停用"; tone = "gray"; }
      else if (listed) { state = failover ? "在用" : "在线"; tone = health.tone === "ok" && !unhealthy ? "ok" : "warn"; }
      else if (health.state === "维护") { state = "维护，已摘除"; tone = "warn"; }
      else if (health.state === "离线" || health.state === "熔断") { state = `${health.state}，已摘除`; tone = "down"; }
      else if (unhealthy) { state = "丢包，已摘除"; tone = "down"; }
      else { state = failover ? "待命" : "不在解析里"; tone = "gray"; }
      const ready = enabled && health.tone === "ok" && !unhealthy;
      return { memberId: Number(member.id), hostId: Number(member.hostId), name: String(host?.name || `主机 ${member.hostId}`), value: value || String(host?.name || ""), state, tone, listed, ready };
    });
    return {
      id: Number(group.id),
      name: String(group.name || ""),
      mode: failover ? "failover" as const : "entry" as const,
      domain: group.domain ? String(group.domain) : null,
      provider: providerLabel(ddnsProvider),
      autoDns: group.ddnsAutoResolveEnabled !== false && group.ddnsAutoResolveEnabled !== 0,
      autoFailback: dbBool(group.autoFailback, true),
      members,
      // DNS 轮询数在解析里的；主备数能接班的（在用 + 健康待命）
      usable: members.filter((member) => (failover ? member.ready : member.listed)).length,
      total: members.length,
    };
  });

  const exitGroupsRaw = groups.filter((group) => group.groupMode === "exit");
  const exitHostIds = memberRows.filter((member) => exitGroupsRaw.some((group) => Number(group.id) === Number(member.groupId))).map((member) => Number(member.hostId)).filter((id) => id > 0);
  const { latestUnlockStatusesByHostIds } = await import("./ops/unlock");
  const unlock = exitHostIds.length > 0 ? await latestUnlockStatusesByHostIds(exitHostIds).catch(() => new Map()) : new Map();
  const profiles = exitHostIds.length > 0
    ? await queryRaw<any>(`SELECT ${q("hostId")}, ${q("resultJson")} FROM ${q("host_network_profiles")} WHERE ${q("hostId")} IN (${exitHostIds.map(() => "?").join(",")})`, exitHostIds).catch(() => [] as any[])
    : [];
  const nativeByHost = new Map<number, boolean>();
  for (const row of profiles) {
    try {
      const parsed = JSON.parse(String(row.resultJson || "{}"));
      const type = String(parsed?.ipType || parsed?.ipv4?.ipType || "").toLowerCase();
      if (type) nativeByHost.set(Number(row.hostId), type === "native" || type === "residential" || type === "原生");
    } catch {
      // 网络画像读不出来就不写「原生」。
    }
  }
  const exitGroups = exitGroupsRaw.map((group) => {
    const members = memberRows.filter((member) => Number(member.groupId) === Number(group.id) && Number(member.hostId) > 0).map((member) => {
      const host = hostById.get(Number(member.hostId));
      const health = hostState(host, tripped);
      const services = unlock.get(Number(member.hostId)) as Map<string, { status: string }> | undefined;
      const ok = (id: string) => services?.get(id)?.status === "ok";
      const unlocked = [["netflix", "Netflix"], ["chatgpt", "ChatGPT"], ["claude", "Claude"], ["disney", "Disney+"]]
        .filter(([id]) => ok(id))
        .slice(0, 2)
        .map(([, label]) => `${label} ✓`);
      const region = String(host?.geoCountryCode || host?.countryCode || "").toUpperCase() || String(host?.name || `主机 ${member.hostId}`);
      const label = [`${region}${nativeByHost.get(Number(member.hostId)) ? " 原生" : ""}`, ...unlocked].join(" · ");
      return { hostId: Number(member.hostId), name: String(host?.name || `主机 ${member.hostId}`), label, tone: dbBool(member.isEnabled, true) && health.tone === "ok" && String(member.healthStatus || "") !== "failed" ? "ok" as const : health.tone === "warn" ? "warn" as const : "down" as const, state: health.state, checked: !!services };
    });
    return {
      id: Number(group.id),
      name: String(group.name || ""),
      strategy: normalizeExitGroupStrategy(group.exitStrategy),
      members,
      usable: members.filter((member) => member.tone === "ok").length,
      total: members.length,
    };
  });
  return { nodePools, entryGroups, exitGroups };
}
