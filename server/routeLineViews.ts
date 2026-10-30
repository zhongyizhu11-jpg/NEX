import * as db from "./db";
import { queryRaw, quoteDbIdentifier } from "./dbRuntime";
import { dbBool } from "./repositories/repositoryUtils";
import { getRouteStatus, routeTrippedNodeIds } from "./routeGroupStats";
import { describeRouteReason, routeEventMillis, routeGroupOf, routePathLabel } from "../shared/routeGroup";

const q = quoteDbIdentifier;

/*
  线路工作台和节点详情要的几份视图：
    · lineWorkspace：看板头（在线节点、24 小时告警、已自动恢复、最近几条）。
    · linesThroughHost：经过某台机器的线路，以及此刻是在走它还是避开了它。
  线路卡本身还是 rules.routeBoard（server/routeStatusView.ts）。
*/

const ALERT_KINDS = new Set(["unhealthy", "issue", "precheck_failed", "slow_dial", "flap_hold"]);
const FAILURE_SWITCH = /health check|dial failed|relay down|maintenance|breaker|node offline|paused/i;

export async function lineWorkspace(actor: { id: number; role: string }, hours = 24) {
  const isAdmin = actor.role === "admin";
  const rules = (await db.getForwardRules(isAdmin ? undefined : actor.id, undefined, { failoverOnly: true }) as any[])
    .filter((rule) => !!routeGroupOf(rule) && !dbBool(rule.pendingDelete));
  const hostIds = new Set<number>();
  for (const rule of rules) {
    hostIds.add(Number(rule.hostId));
    for (const path of routeGroupOf(rule)!.paths) for (const hop of path.hops) hostIds.add(Number(hop));
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
  const recent: Array<{ ruleId: number; ruleName: string; kind: string; tone: "down" | "warn" | "ok"; text: string; at: number }> = [];
  for (const row of events) {
    const kind = String(row.kind || "");
    const reason = String(row.reason || "");
    const failureSwitch = kind === "switch" && FAILURE_SWITCH.test(reason);
    const isAlert = ALERT_KINDS.has(kind) || failureSwitch;
    const isRecovery = kind === "recovered" || (kind === "switch" && /failback|relay recovered/i.test(reason));
    if (isAlert) alerts += 1;
    if (isRecovery) recovered += 1;
    if ((isAlert || isRecovery) && recent.length < 12) {
      const label = [row.fromLabel, row.toLabel].filter(Boolean).join(" → ");
      recent.push({
        ruleId: Number(row.ruleId),
        ruleName: nameByRule.get(Number(row.ruleId)) || `规则 ${row.ruleId}`,
        kind,
        tone: isRecovery ? "ok" : kind === "slow_dial" || kind === "flap_hold" ? "warn" : "down",
        text: [describeRouteReason(reason) || kind, label].filter(Boolean).join(" · "),
        at: routeEventMillis(row.createdAt),
      });
    }
  }
  const maintenance = hosts.filter((host) => dbBool(host.maintenanceMode));
  for (const host of maintenance.slice(0, 4)) {
    recent.unshift({ ruleId: 0, ruleName: String(host.name || `主机 ${host.id}`), kind: "maintenance", tone: "warn", text: `维护中${host.maintenanceNote ? `：${host.maintenanceNote}` : ""}`, at: Date.now() });
  }
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
    recent: recent.slice(0, 12),
    hours,
  };
}

export async function linesThroughHost(hostId: number, actor: { id: number; role: string }) {
  const id = Number(hostId);
  const rules = (await db.getForwardRules(actor.role === "admin" ? undefined : actor.id, undefined, { failoverOnly: true }) as any[])
    .filter((rule) => !dbBool(rule.pendingDelete));
  const out: Array<{ ruleId: number; name: string; paths: Array<{ name: string; active: boolean }>; usingNow: boolean }> = [];
  for (const rule of rules) {
    const group = routeGroupOf(rule);
    if (!group) continue;
    const through = group.paths
      .map((path, index) => ({ path, index }))
      .filter(({ path }) => path.hops.includes(id) || Number(rule.hostId) === id);
    if (through.length === 0) continue;
    const status = getRouteStatus(Number(rule.id));
    const activeIndex = status.agent ? status.agent.activeIndex : -1;
    out.push({
      ruleId: Number(rule.id),
      name: String(rule.name || ""),
      paths: through.map(({ path, index }) => ({ name: routePathLabel(path, index), active: index === activeIndex })),
      usingNow: through.some(({ index }) => index === activeIndex),
    });
  }
  return out.slice(0, 50);
}
