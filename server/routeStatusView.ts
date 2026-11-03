import * as db from "./db";
import { describeFailoverActiveLine } from "../shared/failoverActiveLine";
import { normalizeForwardRuleProtocol } from "../shared/forwardTypes";
import {
  ROUTE_GROUP_AGENT_VERSION,
  describeRouteIssue,
  routeEventMillis,
  routeGroupIsForwardXTunnel,
  routeGroupOf,
  routeGroupSchedulerAgentVersion,
  routePathDestination,
  routePathDial,
  routePathLabel,
  routePathLetter,
  type RoutePath,
} from "../shared/routeGroup";
import { routeScoreGrade } from "../shared/routeScore";
import { summarizeRouteSwitches, type RouteSwitchSummary } from "../shared/routeSwitchSummary";
import { isAgentVersionBehind } from "../shared/version";
import { getRouteStatus, routeHopDownHints, routeHopSuccessPct, routeNodeHints, routePathDownstreamMs, routeTrippedNodeIds } from "./routeGroupStats";
import { ensureRouteNodeHealthFresh, getRouteNodeStatus } from "./routeNodeHealth";
import { ROUTE_DEST_SPREAD_AGENT_VERSION, ROUTE_LINES_AGENT_VERSION, normalizeRouteDelivery, routeAgentStrategy, routePathsOf, serializeRoutePaths } from "../shared/routeGroup";
import { routeLinesOf, ROUTE_ENTRY_RELAY_INDEX } from "../shared/routeLines";
import { routeRelayRulesByKey } from "./routeGroups";
import { routeSchedulerHostIds } from "./routers/rules.crud";
import { dbBool } from "./repositories/repositoryUtils";
import { getRuleLiveRate, type RuleLiveRate } from "./ruleLiveRates";
import { queryRaw, quoteDbIdentifier } from "./dbRuntime";

/*
  落地叫什么（线路详情的图、线路行上写它，不只写「落地」两个字，2.3.498）：选的是「我的节点」就是节点名；
  地址是规则主人自己某台机器的 IP / 域名就是那台的名字；都不是返回 null，界面写地址的主机部分。
  线路详情 3 秒刷一次、线路板一次查全部规则，所以按地址缓存一分钟。
*/
const DEST_NAME_TTL_MS = 60_000;
const destNameCache = new Map<string, { name: string | null; at: number }>();

export async function routeDestNames(rule: any, paths: readonly RoutePath[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const now = Date.now();
  const userId = Number(rule.userId || 0);
  const cached = (key: string) => {
    const hit = destNameCache.get(key);
    return hit && now - hit.at < DEST_NAME_TTL_MS ? hit : null;
  };
  const missingAddresses: string[] = [];
  for (const path of paths) {
    const nodeId = Number(path.destNodeId || 0);
    if (nodeId > 0) {
      const key = `node:${nodeId}`;
      let hit = cached(key);
      if (!hit) {
        const node = await (db.getProxyNodeById(nodeId) as Promise<any>).catch(() => undefined);
        hit = { name: node?.name ? String(node.name) : null, at: now };
        destNameCache.set(key, hit);
      }
      // 落地池的成员（2.3.500）：池名后面带上是哪台，几条路径才分得清
      const memberHostId = Number(path.destHostId || 0);
      if (hit.name && memberHostId > 0) {
        const hostKey = `hostid:${memberHostId}`;
        let hostHit = cached(hostKey);
        if (!hostHit) {
          const host = await (db.getHostById(memberHostId) as Promise<any>).catch(() => undefined);
          hostHit = { name: host?.name ? String(host.name) : null, at: now };
          destNameCache.set(hostKey, hostHit);
        }
        names.set(path.key, hostHit.name ? `${hit.name} · ${hostHit.name}` : hit.name);
        continue;
      }
      if (hit.name) names.set(path.key, hit.name);
      continue;
    }
    const address = routePathDestination(path, rule).ip.trim();
    if (address && !cached(`host:${userId}:${address}`) && !missingAddresses.includes(address)) missingAddresses.push(address);
  }
  if (missingAddresses.length > 0 && userId > 0) {
    const q = quoteDbIdentifier;
    const marks = missingAddresses.map(() => "?").join(",");
    const columns = ["ip", "ipv4", "ipv6", "entryIp", "ddnsDomain"];
    const rows = await queryRaw<any>(
      `SELECT ${q("name")}, ${columns.map((column) => q(column)).join(", ")} FROM ${q("hosts")} WHERE ${q("userId")} = ? AND (${columns.map((column) => `${q(column)} IN (${marks})`).join(" OR ")})`,
      [userId, ...columns.flatMap(() => missingAddresses)],
    ).catch(() => [] as any[]);
    for (const address of missingAddresses) {
      const lower = address.toLowerCase();
      const host = rows.find((row) => columns.some((column) => String(row[column] || "").trim().toLowerCase() === lower));
      destNameCache.set(`host:${userId}:${address}`, { name: host?.name ? String(host.name) : null, at: now });
    }
  }
  for (const path of paths) {
    if (names.has(path.key) || Number(path.destNodeId || 0) > 0) continue;
    const hit = cached(`host:${userId}:${routePathDestination(path, rule).ip.trim()}`);
    if (hit?.name) names.set(path.key, hit.name);
  }
  return names;
}

/*
  线路组此刻的样子：每条路径走哪几跳、拨哪个地址、评分几分、哪一跳断了、现在走的是哪条，
  再加每一跳此刻的速率和最近切了几次。rules.routeStatus（一条）和 rules.routeBoard（全部）
  都从这里出，界面上规则卡的线路面板和链路管理页的线路板画的是同一份东西。

  评分和逐跳探测都是内存里的（routeGroupStats）：入口 Agent 每次心跳带评分，中转机的
  Agent 一分钟报一次它那一跳。Agent 没升到 2.2.198 的，评分为空，界面据 agentSupportsScores
  说明「升级 Agent 后才有评分」。
*/

/**
 * 几台调度机里最旧的 Agent 版本。有一台读不到版本就返回空串：说不准它认不认，按不支持算，
 * 和心跳那边 isAgentVersionAtLeast("", …) 为假一致。
 */
export function oldestAgentVersion(versions: readonly string[]): string {
  let oldest = "";
  for (const version of versions) {
    if (!version) return "";
    if (!oldest || isAgentVersionBehind(version, oldest)) oldest = version;
  }
  return oldest;
}

export type RouteStatusRate = RuleLiveRate | null;

/** 切换记录只留最近的，够数一天的就行。 */
const SWITCH_EVENT_LIMIT = 60;

/**
 * 端口转发（转发组模板，2.3.4xx 起能挂线路组）自己不下发：真正在入口机上跑、调度、上报评分的是它展开出来的
 * 那条规则（forwardGroupRuleId = 模板），中转机上的中继规则也挂在展开的规则下面。线路的状态（评分、在走哪条、
 * 中转端口、切换记录、速率、入口）都得从那条读，否则模板上永远是「两条都待命」。
 * 入口组有几台机器时展开成几条，取最近有 Agent 上报的那条（其次在跑的、再其次最早的）。
 * 不是模板、或者还没展开出来，就是它自己。
 */
/** 一行 forward_rules（只用到这里读的几个字段，别的照原样带着）。 */
type RuleRow = Record<string, unknown>;

export async function routeStatusSubject<T extends RuleRow>(rule: T, nowMs = Date.now()): Promise<T> {
  if (!dbBool(rule?.isForwardGroupTemplate)) return rule;
  const rows = (await (db.getForwardGroupChildRulesForTemplate(Number(rule.id)) as Promise<unknown[]>).catch(() => [])) || [];
  const children = (rows as T[])
    .filter((child) => child && !dbBool(child.pendingDelete) && Number(child.sourcePort || 0) > 0);
  if (children.length === 0) return rule;
  const reportedAt = (child: T) => {
    const status = getRouteStatus(Number(child.id), nowMs);
    return (status.agent || status.staleAgent)?.reportedAt ?? 0;
  };
  const ranked = children
    .map((child) => ({ child, at: reportedAt(child), running: dbBool(child.isRunning), enabled: child.isEnabled === undefined ? true : dbBool(child.isEnabled) }))
    .sort((left, right) => (
      Number(right.enabled) - Number(left.enabled)
      || right.at - left.at
      || Number(right.running) - Number(left.running)
      || Number(left.child.id) - Number(right.child.id)
    ));
  return ranked[0].child;
}

/**
 * 规则列表里的端口转发模板：「现在走哪条」（failoverActiveTarget / failoverActiveAt）换成它展开那条的。
 * 模板上留着的是转成端口转发之前那条规则最后报的，早就不对了 —— 规则卡和线路面板上会写成
 * 「Agent 报的 … 不在线路清单里」。别的规则原样返回。
 */
export async function withTemplateRouteActive<T>(value: T): Promise<T> {
  const items = (value as { items?: unknown } | null)?.items;
  const list = (Array.isArray(value) ? value : Array.isArray(items) ? items : []) as RuleRow[];
  const templates = list.filter((rule) => rule && dbBool(rule.isForwardGroupTemplate) && dbBool(rule.failoverEnabled));
  if (templates.length === 0) return value;
  const nowMs = Date.now();
  const overlay = new Map<number, { failoverActiveTarget: unknown; failoverActiveAt: unknown; routePaths?: string | null }>();
  await Promise.all(templates.map(async (rule) => {
    const subject = await routeStatusSubject(rule, nowMs).catch(() => rule);
    overlay.set(Number(rule.id), subject === rule
      ? { failoverActiveTarget: null, failoverActiveAt: null }
      : {
        failoverActiveTarget: subject.failoverActiveTarget ?? null,
        failoverActiveAt: subject.failoverActiveAt ?? null,
        routePaths: withSubjectDials(rule, subject),
      });
  }));
  const decorate = (rule: RuleRow) => {
    const next = rule ? overlay.get(Number(rule.id)) : undefined;
    return next ? { ...rule, ...next } : rule;
  };
  if (Array.isArray(value)) return (value as RuleRow[]).map(decorate) as T;
  return { ...(value as object), items: (items as RuleRow[]).map(decorate) } as T;
}

/**
 * 模板的路径带上展开那条解析好的拨号地址（dial）。
 *
 * 模板上的路径有中转而 dial 为空（中转端口是展开时才在中转机上开的），界面拿模板算「Agent 报的
 * 地址对应哪条线路」时每条线路的地址都是空的，于是规则卡写「择优 · 2 条」、异常明细报
 * 「Agent 报的 172.81.104.166:43418 不在线路清单里」（用户 2026-11-03），而线路详情（按展开那条算）
 * 明明标着主线路在用。按 key 对上展开那条的路径，把 dial 抄过来；对不上的保持原样。
 */
function withSubjectDials(template: RuleRow, subject: RuleRow): string | null {
  const templatePaths = routePathsOf(template as Parameters<typeof routePathsOf>[0]);
  const subjectPaths = routePathsOf(subject as Parameters<typeof routePathsOf>[0]);
  if (templatePaths.length === 0 || subjectPaths.length === 0) return (template.routePaths as string | null | undefined) ?? null;
  const byKey = new Map(subjectPaths.map((path) => [path.key, path]));
  let changed = false;
  const merged = templatePaths.map((path, index) => {
    if (path.dial) return path;
    const match = byKey.get(path.key) ?? byKey.get(String(path.lineKey || "")) ?? subjectPaths[index];
    if (!match?.dial || match.hops.length !== path.hops.length) return path;
    changed = true;
    return { ...path, dial: match.dial };
  });
  return changed ? serializeRoutePaths(merged) : ((template.routePaths as string | null | undefined) ?? null);
}

/** 切换记录：展开的规则自己的，再加上模板上的（转成端口转发之前那条规则攒下的），按时间合在一起。 */
type RouteEventRow = {
  kind?: string; createdAt?: unknown; reason?: string | null;
  fromKey?: string | null; toKey?: string | null; fromLabel?: string | null; toLabel?: string | null;
};

async function routeSwitchEventsFor(rule: RuleRow, subject: RuleRow) {
  const load = (ruleId: number) => (db.getForwardRuleRouteEvents(ruleId, SWITCH_EVENT_LIMIT) as Promise<RouteEventRow[]>)
    .catch(() => [] as RouteEventRow[]);
  if (Number(subject.id) === Number(rule.id)) return load(Number(rule.id));
  const [own, inherited] = await Promise.all([load(Number(subject.id)), load(Number(rule.id))]);
  return [...own, ...inherited]
    .sort((left, right) => routeEventMillis(right.createdAt) - routeEventMillis(left.createdAt))
    .slice(0, SWITCH_EVENT_LIMIT);
}

export async function buildRouteStatus(rule: any) {
  const nowMs = Date.now();
  // subject：真正跑着、上报着的那条（端口转发模板 → 它展开的规则；别的就是 rule 本身）。线路定义照旧按 rule 显示。
  const subject = await routeStatusSubject(rule, nowMs);
  const group = routeGroupOf(subject) || routeGroupOf(rule);
  if (!group) return null;
  const { paths, policy } = group;
  const status = getRouteStatus(Number(subject.id), nowMs);
  const agent = status.agent || status.staleAgent;
  const hints = routeHopDownHints(Number(subject.id), paths, nowMs);
  await ensureRouteNodeHealthFresh();
  const nodeHints = routeNodeHints(paths, getRouteNodeStatus);
  const tripped = routeTrippedNodeIds();
  const hopIds = Array.from(new Set(paths.flatMap((path) => path.hops)));
  const viaTunnelIds = Array.from(new Set(paths.flatMap((path) => (path.hopVia || []).filter((value): value is number => !!value))));
  const viaTunnels = new Map<number, any>();
  for (const tunnelId of viaTunnelIds) {
    const tunnel = await (db.getTunnelById(tunnelId) as Promise<any>).catch(() => null);
    if (tunnel) viaTunnels.set(tunnelId, tunnel);
  }
  /*
    评分和预热跑在调度层那台机器上 —— GOST 隧道规则是隧道的出口机，不是规则的入口机。
    版本读错机器的话，界面会说「支持评分」而真正跑调度的那台 Agent 还是旧的（或者反过来）。
    负载均衡的隧道每个出口各跑一个调度器，心跳要每一台都够版本才下发 UDP 调度，所以这里
    按最旧的那台说（routeSchedulerHostIds 和心跳是同一个口径）。
  */
  const routeTunnel = Number(subject.tunnelId || 0) > 0
    ? await (db.getTunnelById(Number(subject.tunnelId)) as Promise<any>).catch(() => null)
    : null;
  const routeExitNodes = routeTunnel ? await db.getTunnelExitNodes(Number(routeTunnel.id)).catch(() => []) : [];
  const schedulerHostIds = routeSchedulerHostIds(Number(subject.hostId), routeTunnel, routeExitNodes);
  const [names, relays, schedulerHosts, events, entryHost, destNames] = await Promise.all([
    hopIds.length > 0 ? db.getHostNamesByIds(hopIds) : Promise.resolve(new Map<number, string>()),
    routeRelayRulesByKey(Number(subject.id)),
    Promise.all(schedulerHostIds.map((hostId) => (db.getHostById(hostId) as Promise<any>).catch(() => null))),
    routeSwitchEventsFor(rule, subject),
    (db.getHostById(Number(subject.hostId)) as Promise<any>).catch(() => null),
    routeDestNames(subject, paths).catch(() => new Map<string, string>()),
  ]);
  const active = describeFailoverActiveLine(subject);
  const activeIndex = status.agent && status.agent.activeIndex >= 0 ? status.agent.activeIndex : (active ? active.index : -1);
  const rows = paths.map((path, index) => {
    const target = agent?.targets.find((item) => item.index === index) || null;
    const hint = hints.get(path.key) || null;
    const hops = path.hops.map((hostId, hopIndex) => {
      const probe = status.hops.find((item) => item.pathKey === path.key && item.hopIndex === hopIndex) || null;
      const relay = relays.get(`${path.key}:${hopIndex}`) as any;
      const node = getRouteNodeStatus(hostId);
      const viaId = path.hopVia?.[hopIndex] ?? null;
      const via = viaId ? viaTunnels.get(viaId) : null;
      return {
        hostId,
        name: names.get(hostId) || `主机 ${hostId}`,
        /** 到这一跳走的隧道（隧道段）；null = 普通中继。 */
        viaTunnel: viaId ? { id: viaId, name: String(via?.name || `隧道 ${viaId}`), mode: String(via?.mode || "") } : null,
        maintenance: !!node?.maintenance,
        offline: node ? !node.online : null,
        tripped: tripped.has(Number(hostId)),
        /** 这一段最近 20 次探测的成功率；没样本为 null。 */
        successPct: probe ? routeHopSuccessPct(probe) : null,
        port: relay ? Number(relay.sourcePort) : null,
        running: relay ? dbBool(relay.isRunning) : null,
        enabled: relay ? dbBool(relay.isEnabled) : null,
        ok: probe ? probe.ok : null,
        latencyMs: probe?.latencyMs ?? null,
        consecutiveFailures: probe?.consecutiveFailures ?? 0,
        probedAt: probe?.at ?? null,
        nextLabel: probe?.nextLabel ?? null,
        // 这一跳的中继规则此刻跑多快：只有流量真走到这一跳才有数。
        rate: relay ? getRuleLiveRate(Number(relay.id), nowMs) : null,
      };
    });
    const nodeHint = nodeHints.get(path.key) || null;
    const down = !!target?.down || !!hint || !!nodeHint || !!path.issue;
    const downReason = path.issue || (nodeHint ? nodeHint.reason : hint ? hint.reason : target?.downReason || "");
    // 隧道从入口机出发：入口机上那条走隧道的中继（routeHopIndex = 99）。
    const entryRelay = relays.get(`${path.key}:${ROUTE_ENTRY_RELAY_INDEX}`) as any;
    return {
      key: path.key,
      index,
      letter: routePathLetter(index),
      name: routePathLabel(path, index),
      /** 第几组（0 = 主线路那组）；老数据没有 = null。 */
      tier: typeof path.tier === "number" ? path.tier : null,
      lineKey: path.lineKey || null,
      paused: !!path.paused,
      entryRelayPort: entryRelay ? Number(entryRelay.sourcePort) : null,
      /** 后面几段（中继各自探的）加起来，整条链 = 入口这段 + 它。 */
      downstreamMs: routePathDownstreamMs(Number(subject.id), path, nowMs),
      hops,
      dest: routePathDestination(path, subject),
      /** 落地叫什么：我的节点的名字，或者自己那台机器的名字；都不是为 null（界面写地址）。 */
      destName: destNames.get(path.key) ?? null,
      dial: routePathDial(path, subject),
      issue: path.issue,
      weight: path.weight,
      probe: path.probe,
      score: target?.score ?? null,
      grade: routeScoreGrade(target?.score ?? null),
      latencyMs: target?.latencyMs ?? null,
      lossPct: target?.lossPct ?? null,
      jitterMs: target?.jitterMs ?? null,
      availabilityPct: target?.availabilityPct ?? null,
      healthy: target ? target.healthy && !down : null,
      down,
      downReason: describeRouteIssue(downReason),
      connections: target?.connections ?? null,
      /** 入口 Agent 连着几次探不通（中转那一跳断了的话按那一跳的次数）。 */
      consecutiveFailures: Math.max(target?.consecutiveFailures ?? 0, ...hops.map((hop) => hop.consecutiveFailures || 0)),
      samples: target?.samples ?? 0,
      active: activeIndex === index,
      prewarming: !!agent && agent.prewarmIndex === index,
      /** 入口 Agent 探到的最近一次（Unix 毫秒）；0 = 没探过。 */
      probedAt: target?.lastProbeAt ?? null,
      /** 真实连接最近 10 分钟的拨号（Agent 2.2.237 起）；老 Agent 没报就是 null。 */
      dials: target?.dials && (target.dials.ok > 0 || target.dials.failed > 0 || target.dials.lastAt > 0) ? target.dials : null,
    };
  });
  const agentVersion = oldestAgentVersion(schedulerHosts.map((schedulerHost) => String(schedulerHost?.agentVersion || "").trim()));
  /*
    「落地怎么分」（2.3.501）：在用的那条线路选了一起分、调度的 Agent 够新时，这条线路上能用的几个落地都在走，
    不只是 Agent 报的那一条 —— 图上、行上都按「在走」画。
  */
  const deliveryNow = normalizeRouteDelivery(policy.delivery);
  const activePath = activeIndex >= 0 ? paths[activeIndex] : null;
  if (
    activePath?.destSpread && typeof activePath.tier === "number"
    && routeAgentStrategy(policy) === "fallback" && deliveryNow !== "aggregate" && deliveryNow !== "replicate"
    && !!agentVersion && !isAgentVersionBehind(agentVersion, ROUTE_DEST_SPREAD_AGENT_VERSION)
  ) {
    for (const row of rows) {
      const path = paths[row.index];
      if (path.tier === activePath.tier && path.destSpread && !row.down && !row.paused && row.healthy !== false) row.active = true;
    }
  }
  /*
    UDP、TCP+UDP 和 NEX 隧道的线路组要 Agent 2.2.199 起才调度；更老的时候面板不下发
    调度，流量走路径 A、不切换（server/agentHeartbeatRoute.ts 的 routePrimaryEndpoint）。
    界面据 agentSupportsProtocol 把这件事说出来，别让人以为配了就生效；schedulerNeed 说是
    哪一样要新 Agent，界面的说法跟着换。
  */
  const protocol = normalizeForwardRuleProtocol(rule.protocol);
  const schedulerAgentVersion = routeGroupSchedulerAgentVersion(protocol, routeTunnel?.mode);
  const schedulerNeed = routeGroupIsForwardXTunnel(routeTunnel?.mode) ? "forwardx" : protocol !== "tcp" ? "udp" : null;
  const switches: RouteSwitchSummary = summarizeRouteSwitches(
    events.map((row) => ({
      kind: String(row.kind || ""),
      at: routeEventMillis(row.createdAt),
      reason: row.reason ?? null,
      fromKey: row.fromKey ?? null,
      toKey: row.toKey ?? null,
      fromLabel: row.fromLabel ?? null,
      toLabel: row.toLabel ?? null,
    })),
    nowMs,
  );
  return {
    ruleId: Number(rule.id),
    protocol,
    policy,
    delivery: normalizeRouteDelivery(policy.delivery),
    /** 线路定义（分层候选）；老数据由路径推。 */
    lines: routeLinesOf(rule),
    paths: rows,
    activeIndex,
    activeSince: status.agent?.activeSince || (active?.since ? active.since * 1000 : null),
    prewarmIndex: agent?.prewarmIndex ?? -1,
    agentReportedAt: agent?.reportedAt ?? null,
    agentStale: !status.agent && !!status.staleAgent,
    agentVersion: agentVersion || null,
    agentSupportsScores: !!agentVersion && !isAgentVersionBehind(agentVersion, ROUTE_GROUP_AGENT_VERSION),
    /** 分层候选按组挑、整链打分、热备抢拨、改完马上探：Agent 2.2.243 起；老的照旧按顺序 / 全部里挑。 */
    agentSupportsLines: !!agentVersion && !isAgentVersionBehind(agentVersion, ROUTE_LINES_AGENT_VERSION),
    agentSupportsProtocol: !schedulerAgentVersion || (!!agentVersion && !isAgentVersionBehind(agentVersion, schedulerAgentVersion)),
    requiredAgentVersion: schedulerAgentVersion || ROUTE_GROUP_AGENT_VERSION,
    schedulerNeed,
    tunnelMode: routeTunnel ? String(routeTunnel.mode || "") : null,
    /** 调度器跑在哪几台机器上（直连是规则所在机器，隧道是出口）。 */
    schedulerHostIds,
    /** 这条规则（入口）此刻的速率。 */
    rate: getRuleLiveRate(Number(subject.id), nowMs),
    /** 最近 10 分钟客户端连进来、拨通了一条路径的有几个、一条都没拨通的有几个（Agent 2.2.243 起，TCP）。 */
    inbound: agent?.inbound ?? null,
    switches,
    /** 入口：规则所在的机器。卡片左端写它的名字；它离线了整条线路组都没法走。 */
    entry: {
      hostId: Number(subject.hostId || 0),
      name: String(entryHost?.name || `主机 ${subject.hostId}`),
      online: entryHost ? dbBool(entryHost.isOnline) : null,
      sourcePort: Number(subject.sourcePort || 0),
    },
  };
}

export type RouteStatusView = NonNullable<Awaited<ReturnType<typeof buildRouteStatus>>>;

const BOARD_MAX_RULES = 120;
const BOARD_CONCURRENCY = 6;

/**
 * 线路板：每条线路组规则一份 routeStatus。一次最多 120 条，六条六条地算
 * （每条要查中继规则、切换记录和几台主机）。
 */
export async function buildRouteBoard(rules: readonly any[]) {
  const candidates = rules.filter((rule) => !!routeGroupOf(rule)).slice(0, BOARD_MAX_RULES);
  const items: Array<{ ruleId: number; name: string; userId: number; userName: string | null; status: RouteStatusView }> = [];
  for (let offset = 0; offset < candidates.length; offset += BOARD_CONCURRENCY) {
    const batch = candidates.slice(offset, offset + BOARD_CONCURRENCY);
    const statuses = await Promise.all(batch.map((rule) => buildRouteStatus(rule).catch(() => null)));
    batch.forEach((rule, index) => {
      const status = statuses[index];
      if (!status) return;
      items.push({
        ruleId: Number(rule.id),
        name: String(rule.name || ""),
        userId: Number(rule.userId || 0),
        userName: rule.userName ? String(rule.userName) : null,
        status,
      });
    });
  }
  return items;
}
