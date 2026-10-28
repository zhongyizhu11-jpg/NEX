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
} from "../shared/routeGroup";
import { routeScoreGrade } from "../shared/routeScore";
import { summarizeRouteSwitches, type RouteSwitchSummary } from "../shared/routeSwitchSummary";
import { isAgentVersionBehind } from "../shared/version";
import { getRouteStatus, routeHopDownHints } from "./routeGroupStats";
import { routeRelayRulesByKey } from "./routeGroups";
import { routeSchedulerHostIds } from "./routers/rules.crud";
import { dbBool } from "./repositories/repositoryUtils";
import { getRuleLiveRate, type RuleLiveRate } from "./ruleLiveRates";

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

export async function buildRouteStatus(rule: any) {
  const group = routeGroupOf(rule);
  if (!group) return null;
  const { paths, policy } = group;
  const nowMs = Date.now();
  const status = getRouteStatus(Number(rule.id), nowMs);
  const agent = status.agent || status.staleAgent;
  const hints = routeHopDownHints(Number(rule.id), paths, nowMs);
  const hopIds = Array.from(new Set(paths.flatMap((path) => path.hops)));
  /*
    评分和预热跑在调度层那台机器上 —— GOST 隧道规则是隧道的出口机，不是规则的入口机。
    版本读错机器的话，界面会说「支持评分」而真正跑调度的那台 Agent 还是旧的（或者反过来）。
    负载均衡的隧道每个出口各跑一个调度器，心跳要每一台都够版本才下发 UDP 调度，所以这里
    按最旧的那台说（routeSchedulerHostIds 和心跳是同一个口径）。
  */
  const routeTunnel = Number(rule.tunnelId || 0) > 0
    ? await (db.getTunnelById(Number(rule.tunnelId)) as Promise<any>).catch(() => null)
    : null;
  const routeExitNodes = routeTunnel ? await db.getTunnelExitNodes(Number(routeTunnel.id)).catch(() => []) : [];
  const schedulerHostIds = routeSchedulerHostIds(Number(rule.hostId), routeTunnel, routeExitNodes);
  const [names, relays, schedulerHosts, events, entryHost] = await Promise.all([
    hopIds.length > 0 ? db.getHostNamesByIds(hopIds) : Promise.resolve(new Map<number, string>()),
    routeRelayRulesByKey(Number(rule.id)),
    Promise.all(schedulerHostIds.map((hostId) => (db.getHostById(hostId) as Promise<any>).catch(() => null))),
    (db.getForwardRuleRouteEvents(Number(rule.id), SWITCH_EVENT_LIMIT) as Promise<any[]>).catch(() => [] as any[]),
    (db.getHostById(Number(rule.hostId)) as Promise<any>).catch(() => null),
  ]);
  const active = describeFailoverActiveLine(rule);
  const activeIndex = status.agent && status.agent.activeIndex >= 0 ? status.agent.activeIndex : (active ? active.index : -1);
  const rows = paths.map((path, index) => {
    const target = agent?.targets.find((item) => item.index === index) || null;
    const hint = hints.get(path.key) || null;
    const hops = path.hops.map((hostId, hopIndex) => {
      const probe = status.hops.find((item) => item.pathKey === path.key && item.hopIndex === hopIndex) || null;
      const relay = relays.get(`${path.key}:${hopIndex}`) as any;
      return {
        hostId,
        name: names.get(hostId) || `主机 ${hostId}`,
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
    const down = !!target?.down || !!hint || !!path.issue;
    const downReason = path.issue || (hint ? hint.reason : target?.downReason || "");
    return {
      key: path.key,
      index,
      letter: routePathLetter(index),
      name: routePathLabel(path, index),
      hops,
      dest: routePathDestination(path, rule),
      dial: routePathDial(path, rule),
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
      samples: target?.samples ?? 0,
      active: activeIndex === index,
      prewarming: !!agent && agent.prewarmIndex === index,
      /** 入口 Agent 探到的最近一次（Unix 毫秒）；0 = 没探过。 */
      probedAt: target?.lastProbeAt ?? null,
    };
  });
  const agentVersion = oldestAgentVersion(schedulerHosts.map((schedulerHost) => String(schedulerHost?.agentVersion || "").trim()));
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
    paths: rows,
    activeIndex,
    activeSince: status.agent?.activeSince || (active?.since ? active.since * 1000 : null),
    prewarmIndex: agent?.prewarmIndex ?? -1,
    agentReportedAt: agent?.reportedAt ?? null,
    agentStale: !status.agent && !!status.staleAgent,
    agentVersion: agentVersion || null,
    agentSupportsScores: !!agentVersion && !isAgentVersionBehind(agentVersion, ROUTE_GROUP_AGENT_VERSION),
    agentSupportsProtocol: !schedulerAgentVersion || (!!agentVersion && !isAgentVersionBehind(agentVersion, schedulerAgentVersion)),
    requiredAgentVersion: schedulerAgentVersion || ROUTE_GROUP_AGENT_VERSION,
    schedulerNeed,
    tunnelMode: routeTunnel ? String(routeTunnel.mode || "") : null,
    /** 这条规则（入口）此刻的速率。 */
    rate: getRuleLiveRate(Number(rule.id), nowMs),
    switches,
    /** 入口：规则所在的机器。卡片左端写它的名字；它离线了整条线路组都没法走。 */
    entry: {
      hostId: Number(rule.hostId || 0),
      name: String(entryHost?.name || `主机 ${rule.hostId}`),
      online: entryHost ? dbBool(entryHost.isOnline) : null,
      sourcePort: Number(rule.sourcePort || 0),
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
