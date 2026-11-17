import { getHostNamesByIds, getHostsByIds } from "./repositories/hostRepository";
import { getForwardRulesByIds } from "./repositories/forwardRuleRepository";
import { getTunnelsByIds, getTunnelExitNodesByTunnelIds } from "./repositories/tunnelRepository";
import { getForwardGroupById } from "./repositories/forwardGroupRepository";

/*
  负载均衡的真实状态（2.3.539，用户：「全部排查下优化改进……不要再这么多问题了」）。

  做决定的入口自己报：NEX 隧道是入口机的 FXP（2.2.145 起，forwardx-fxp/balance_report.go），GOST 隧道是入口机的
  Agent（2.2.262 起，本机故障转移代理）。每条有几台出口的规则，每台出口在用 / 备用 / 连不上 / 不稳、新连接分给它的
  比例、到目标的延迟抖动丢包，加最近 10 次状态变化。

  面板只存最新一份（内存，按「规则 + 入口机」），不再自己猜入口会怎么挑。入口 10 秒报一次、有变化 1 秒内报，
  面板重启后 10 秒内就有数据，所以不落库。超过 35 秒没报的当作没有，退回老办法（exitTargetHealth.ts 的估算）。
*/

export type LiveExitState = "active" | "standby" | "down" | "unstable";

export type LiveExit = {
  hostId: number;
  hostName: string;
  host: string;
  port: number;
  state: LiveExitState;
  /** down / unstable 的原因：target = 到目标不行，exit = 出口机本身连不上 */
  reason: "target" | "exit" | null;
  /** 这段时间新连接分给它的比例（0–1）；这段时间没有新连接时 null */
  share: number | null;
  picks: number;
  medianMs: number | null;
  jitterMs: number | null;
  lossPct: number | null;
  samples: number;
};

export type LiveEvent = {
  at: number;
  hostId: number;
  hostName: string;
  from: LiveExitState;
  to: LiveExitState;
  reason: "target" | "exit" | null;
};

export type LiveRuleReport = {
  ruleId: number;
  tunnelId: number;
  entryHostId: number;
  entryHostName: string;
  strategy: string;
  targetAware: boolean;
  source: "fxp" | "agent";
  /** 第一台是主出口（入口配置里的顺序） */
  exits: LiveExit[];
  events: LiveEvent[];
  at: number;
};

export const BALANCE_LIVE_STALE_MS = 35_000;
const MAX_REPORTS = 20_000;

const reports = new Map<string, LiveRuleReport>();

const STATES: readonly LiveExitState[] = ["active", "standby", "down", "unstable"];

function asState(value: unknown): LiveExitState {
  const text = String(value || "").toLowerCase();
  return (STATES as readonly string[]).includes(text) ? text as LiveExitState : "standby";
}

function asReason(value: unknown): "target" | "exit" | null {
  return value === "target" || value === "exit" ? value : null;
}

function finiteOrNull(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

type RawExit = { hostId?: unknown; host?: unknown; port?: unknown; state?: unknown; reason?: unknown; share?: unknown; picks?: unknown; medianMs?: unknown; jitterMs?: unknown; lossPct?: unknown; samples?: unknown };
type RawEvent = { at?: unknown; hostId?: unknown; host?: unknown; from?: unknown; to?: unknown; reason?: unknown };
type RawRule = { tunnelId?: unknown; ruleId?: unknown; strategy?: unknown; targetAware?: unknown; exits?: unknown; events?: unknown };

type TunnelLite = { id: number; entryHostId?: number | null; entryGroupId?: number | null; exitHostId?: number | null };
type NodeLite = { tunnelId: number; hostId: number; listenPort?: number | null; connectHost?: string | null };
type HostLite = { id: number; ip?: string | null; entryIp?: string | null; tunnelEntryIp?: string | null; name?: string | null };

/** 入口没带主机号（老配置还没刷新）时按「地址 + 端口」认是哪台出口。 */
function resolveExitHostId(exit: { host: string; port: number }, candidates: number[], nodes: NodeLite[], hosts: Map<number, HostLite>) {
  const host = exit.host.replace(/^\[|\]$/g, "").toLowerCase();
  const matchesHost = (hostId: number) => {
    const row = hosts.get(hostId);
    const node = nodes.find((item) => Number(item.hostId) === hostId);
    return [row?.ip, row?.entryIp, row?.tunnelEntryIp, node?.connectHost]
      .some((value) => String(value || "").replace(/^\[|\]$/g, "").toLowerCase() === host);
  };
  const byPort = nodes.filter((node) => Number(node.listenPort || 0) === exit.port).map((node) => Number(node.hostId));
  const portAndHost = byPort.filter(matchesHost);
  if (portAndHost.length === 1) return portAndHost[0];
  const hostOnly = candidates.filter(matchesHost);
  if (hostOnly.length === 1) return hostOnly[0];
  if (byPort.length === 1) return byPort[0];
  return 0;
}

/**
 * 收一次入口的上报。只认这台机器确实是入口的规则（入口机本身，或入口组的成员）：别的机器报的不收，
 * 免得一台机器替别人的规则「报」状态。
 */
export async function ingestBalanceLiveReport(input: {
  hostId: number;
  hostName?: string;
  source: "fxp" | "agent";
  rules: unknown[];
  nowMs?: number;
}): Promise<{ recorded: number; reports: LiveRuleReport[] }> {
  const nowMs = input.nowMs ?? Date.now();
  const hostId = Number(input.hostId);
  const raw = (Array.isArray(input.rules) ? input.rules : []).slice(0, 2000) as RawRule[];
  const ruleIds = Array.from(new Set(raw.map((item) => Math.floor(Number(item?.ruleId || 0))).filter((id) => id > 0)));
  if (hostId <= 0 || ruleIds.length === 0) return { recorded: 0, reports: [] };
  const rules = await getForwardRulesByIds(ruleIds) as Array<{ id: number; tunnelId?: number | null; hostId?: number | null }>;
  const ruleById = new Map(rules.map((rule) => [Number(rule.id), rule]));
  const tunnelIds = Array.from(new Set(rules.map((rule) => Number(rule.tunnelId || 0)).filter((id) => id > 0)));
  const [tunnels, nodes] = await Promise.all([
    getTunnelsByIds(tunnelIds) as Promise<TunnelLite[]>,
    getTunnelExitNodesByTunnelIds(tunnelIds) as Promise<NodeLite[]>,
  ]);
  const tunnelById = new Map(tunnels.map((tunnel) => [Number(tunnel.id), tunnel]));
  const entryGroupMembers = new Map<number, Set<number>>();
  for (const tunnel of tunnels) {
    const groupId = Number(tunnel.entryGroupId || 0);
    if (groupId > 0 && !entryGroupMembers.has(groupId)) {
      const group = await getForwardGroupById(groupId).catch(() => null) as { members?: Array<{ hostId?: number | null }> } | null;
      entryGroupMembers.set(groupId, new Set((group?.members || []).map((member) => Number(member?.hostId || 0)).filter((id) => id > 0)));
    }
  }
  const exitHostIdsByTunnel = new Map<number, number[]>();
  for (const tunnel of tunnels) {
    const ids = [Number(tunnel.exitHostId || 0), ...nodes.filter((node) => Number(node.tunnelId) === Number(tunnel.id)).map((node) => Number(node.hostId))]
      .filter((id, index, list) => id > 0 && list.indexOf(id) === index);
    exitHostIdsByTunnel.set(Number(tunnel.id), ids);
  }
  const allExitIds = Array.from(new Set(Array.from(exitHostIdsByTunnel.values()).flat()));
  const hostRows = (await getHostsByIds(allExitIds).catch(() => [])) as HostLite[];
  const hostById = new Map(hostRows.map((row) => [Number(row.id), row]));
  let entryHostName = String(input.hostName || "").trim();
  if (!entryHostName) entryHostName = (await getHostNamesByIds([hostId])).get(hostId) || `主机 ${hostId}`;

  let recorded = 0;
  const saved: LiveRuleReport[] = [];
  for (const item of raw) {
    const ruleId = Math.floor(Number(item?.ruleId || 0));
    const rule = ruleById.get(ruleId);
    const tunnel = tunnelById.get(Number(rule?.tunnelId || 0));
    if (!rule || !tunnel || Number(item?.tunnelId || 0) !== Number(tunnel.id)) continue;
    const isEntry = Number(tunnel.entryHostId || 0) === hostId
      || Number(rule.hostId || 0) === hostId
      || !!entryGroupMembers.get(Number(tunnel.entryGroupId || 0))?.has(hostId);
    if (!isEntry) continue;
    const candidates = exitHostIdsByTunnel.get(Number(tunnel.id)) || [];
    const tunnelNodes = nodes.filter((node) => Number(node.tunnelId) === Number(tunnel.id));
    const rawExits = (Array.isArray(item.exits) ? item.exits : []).slice(0, 64) as RawExit[];
    const exits: LiveExit[] = rawExits.map((exit) => {
      const host = String(exit?.host || "").slice(0, 255);
      const port = Math.floor(Number(exit?.port || 0));
      let exitHostId = Math.floor(Number(exit?.hostId || 0));
      if (!candidates.includes(exitHostId)) exitHostId = resolveExitHostId({ host, port }, candidates, tunnelNodes, hostById);
      const share = Number(exit?.share);
      return {
        hostId: exitHostId,
        hostName: exitHostId > 0 ? String(hostById.get(exitHostId)?.name || `主机 ${exitHostId}`) : host,
        host,
        port,
        state: asState(exit?.state),
        reason: asReason(exit?.reason),
        share: Number.isFinite(share) && share >= 0 && share <= 1 ? share : null,
        picks: Math.max(0, Math.floor(Number(exit?.picks || 0))),
        medianMs: finiteOrNull(exit?.medianMs),
        jitterMs: finiteOrNull(exit?.jitterMs) ?? (Number(exit?.medianMs) > 0 ? 0 : null),
        lossPct: finiteOrNull(exit?.lossPct) ?? (Number(exit?.samples) > 0 ? 0 : null),
        samples: Math.max(0, Math.floor(Number(exit?.samples || 0))),
      };
    });
    if (exits.length < 2) continue;
    const nameByHost = new Map(exits.map((exit) => [exit.host, exit]));
    const events: LiveEvent[] = ((Array.isArray(item.events) ? item.events : []).slice(-20) as RawEvent[])
      .map((event) => {
        const exit = exits.find((candidate) => candidate.hostId > 0 && candidate.hostId === Math.floor(Number(event?.hostId || 0)))
          || nameByHost.get(String(event?.host || ""));
        const at = Math.floor(Number(event?.at || 0));
        return {
          at: at > 0 && at <= nowMs + 60_000 ? at : nowMs,
          hostId: exit?.hostId || 0,
          hostName: exit?.hostName || String(event?.host || ""),
          from: asState(event?.from),
          to: asState(event?.to),
          reason: asReason(event?.reason),
        };
      });
    const report: LiveRuleReport = {
      ruleId,
      tunnelId: Number(tunnel.id),
      entryHostId: hostId,
      entryHostName,
      strategy: String(item.strategy || "").slice(0, 32),
      targetAware: item.targetAware === true,
      source: input.source,
      exits,
      events,
      at: nowMs,
    };
    const key = `${ruleId}:${hostId}`;
    if (!reports.has(key) && reports.size >= MAX_REPORTS) pruneStale(nowMs, true);
    reports.set(key, report);
    saved.push(report);
    recorded += 1;
  }
  return { recorded, reports: saved };
}

function pruneStale(nowMs: number, aggressive = false) {
  for (const [key, report] of reports) {
    if (nowMs - report.at > (aggressive ? BALANCE_LIVE_STALE_MS : 10 * 60_000)) reports.delete(key);
  }
}

const pruneTimer = setInterval(() => pruneStale(Date.now()), 5 * 60_000);
pruneTimer.unref?.();

const STATE_RANK: Record<LiveExitState, number> = { active: 3, standby: 2, unstable: 1, down: 0 };

/**
 * 一条规则合起来的真实状态（入口组时几台入口各报一份，合成一份：一台出口只要有入口在往它分就算在用，
 * 比例按各入口的新连接数加起来算）。没有新鲜的上报返回 null。
 */
export function liveBalanceForRule(ruleId: number, nowMs = Date.now()): LiveRuleReport | null {
  const fresh: LiveRuleReport[] = [];
  for (const report of reports.values()) {
    if (report.ruleId === Number(ruleId) && nowMs - report.at <= BALANCE_LIVE_STALE_MS) fresh.push(report);
  }
  if (fresh.length === 0) return null;
  if (fresh.length === 1) return fresh[0];
  fresh.sort((left, right) => right.at - left.at);
  const base = fresh[0];
  const merged = new Map<string, LiveExit>();
  const order: string[] = [];
  for (const report of fresh) {
    for (const exit of report.exits) {
      const key = exit.hostId > 0 ? `h${exit.hostId}` : `${exit.host}:${exit.port}`;
      const current = merged.get(key);
      if (!current) {
        merged.set(key, { ...exit });
        order.push(key);
        continue;
      }
      if (STATE_RANK[exit.state] > STATE_RANK[current.state]) {
        current.state = exit.state;
        current.reason = exit.reason;
      }
      current.picks += exit.picks;
    }
  }
  const exits = order.map((key) => merged.get(key)!);
  const totalPicks = exits.reduce((sum, exit) => sum + exit.picks, 0);
  for (const exit of exits) exit.share = totalPicks > 0 ? exit.picks / totalPicks : null;
  const events = fresh.flatMap((report) => report.events).sort((left, right) => left.at - right.at).slice(-10);
  return { ...base, exits, events };
}

/** 一条链路所有规则的真实状态（新鲜的）。 */
export function liveBalanceForTunnel(tunnelId: number, nowMs = Date.now()): LiveRuleReport[] {
  const ruleIds = new Set<number>();
  for (const report of reports.values()) {
    if (report.tunnelId === Number(tunnelId) && nowMs - report.at <= BALANCE_LIVE_STALE_MS) ruleIds.add(report.ruleId);
  }
  return Array.from(ruleIds).sort((left, right) => left - right)
    .map((ruleId) => liveBalanceForRule(ruleId, nowMs))
    .filter((report): report is LiveRuleReport => !!report);
}

/** 只给测试用 */
export function resetBalanceLiveForTest() {
  reports.clear();
}

export function setBalanceLiveReportForTest(report: LiveRuleReport) {
  reports.set(`${report.ruleId}:${report.entryHostId}`, report);
}
