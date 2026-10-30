import { appendPanelLog } from "./_core/panelLogger";
import { normalizeAgentText } from "./agentInputValidation";
import * as db from "./db";
import { timestampMillis } from "../shared/timestamp";
import { failoverLineEndpoints } from "../shared/failoverActiveLine";
import { normalizeRouteEventKind, routePathLabel, routePathsOf, type RouteEventKind, type RouteGroupRule } from "../shared/routeGroup";
import { recordRouteAgentStats } from "./routeGroupStats";
import { recordRoutePathQuality } from "./routePathQualityHistory";
import { notifyRouteSwitch } from "./routeSwitchNotifier";
import { recordRouteHealthEvent, recordRouteSwitchEvent } from "./ops/eventHooks";

/*
  主备切换：Agent 自己切完，面板才知道。

  规则级的主备是**数据面**的 —— Agent 每 5 秒探一次、自己在出站之间切，毫秒级，
  不经过面板。好处是快且面板挂了也照常工作；代价是切换这件事原来只留在机器本地的
  日志里，面板一无所知。而主备恰恰是「平时看不出来、出事才知道有没有用」的东西：
  切了没人知道，没切更没人知道。

  Agent 随心跳带回来三样东西：

  · 事件（failoverEvents）：切换和健康翻转，落进面板日志和 forward_rule_route_events ——
    一条转发什么时候从哪条线切到哪条、为什么切、当时那条线多少延迟，查得到；线路组的
    「最近切换」列表读的就是这张表。2.2.198 起还有预热（prewarm）、预检没过没切
    （precheck_failed）、人工指定到期（unpinned）。
  · 快照（failoverActive，Agent 2.2.197 起）：每条主备规则此刻走的是哪条、从什么时候
    起。「现在走哪条」以它为准。
  · 评分（failoverStats，Agent 2.2.198 起）：每条路径的评分、延迟、丢包、抖动、可用率。
    只留在内存里（routeGroupStats），给界面和下发用。

  为什么事件不够：代理还会不报事件就回到主线路 —— 面板改了主备设置（换规格）、
  Agent 重启之后都是。只靠事件，面板会一直写着最后一次报上来的那条。

  **这一步必须放在心跳的所有早退之前。** 上一版写在三处早退之后：
    · 对账合并：同一台机器 5 秒内的第二次心跳、或者同时对账的机器超过 8 台，直接返回；
    · 忙碌心跳：Agent 正在执行动作时发来的心跳；
    · 稳定快路径：机器上什么都没变 —— 也就是绝大多数心跳。
  这几种心跳里带的事件，Agent 那边已经清掉了，面板这边没看 —— 切换就这么丢了，
  日志里没有，当前线路也没记。
*/

/** 快照没变就不再核对。但隔一阵子总要重新核一次：库里的值万一被别的路径改过，不能一直不知道。 */
const SNAPSHOT_RECHECK_MS = 10 * 60 * 1000;
/** 评分每次心跳都带，全收就是每几秒查一次规则表；半分钟一份足够画图，有事件时顺带更新。 */
const STATS_RECORD_INTERVAL_MS = 30 * 1000;
const lastSnapshotByHost = new Map<number, { signature: string; checkedAt: number }>();
const lastStatsAtByHost = new Map<number, number>();

/** Agent 报的事件里面板要入库的几种；别的（比如将来加的）只进日志。 */
const STORED_EVENT_KINDS: ReadonlySet<RouteEventKind> = new Set<RouteEventKind>(["switch", "unhealthy", "recovered", "prewarm", "precheck_failed", "unpinned", "flap_hold", "slow_dial"]);

/**
 * Agent 报的时刻换成面板存的秒。
 *
 * Agent 报的是 Unix 毫秒（time.Now().UnixMilli()）。上一版当成秒原样往下传：sqlite 里
 * 存成了五万多年以后；MySQL / PostgreSQL 的 epoch 列是 32 位整数，干脆写不进去 ——
 * 那两种库上「现在走哪条」从这个功能上线起一次都没记上，只在日志里留下一行
 * 「当前线路写入失败」。
 *
 * 秒和毫秒都认（按量级判断）。认不出来的、比面板时钟还晚一天以上的，按收到的时刻算。
 */
export function agentReportedSeconds(value: unknown, nowMs = Date.now()) {
  const ms = timestampMillis(value);
  if (!(ms > 0) || ms > nowMs + 86_400_000) return Math.floor(nowMs / 1000);
  return Math.floor(ms / 1000);
}

type ReportedLine = { target: string; at: number };

function snapshotSignature(snapshot: unknown[]) {
  return JSON.stringify(snapshot.map((item: any) => [
    Number(item?.ruleId || 0),
    Number(item?.sourcePort || 0),
    String(item?.target || ""),
    Number(item?.since || 0),
  ]));
}

/** Agent 报的下标（2.2.198 起）；老 Agent 没有这个字段，按拨号地址反查。 */
function reportedIndex(raw: unknown, target: string, endpoints: string[]) {
  if (raw !== undefined && raw !== null) {
    const index = Math.floor(Number(raw));
    if (Number.isInteger(index) && index >= 0 && index < endpoints.length) return index;
    if (Number.isInteger(index) && index < 0) return -1;
  }
  if (!target) return -1;
  return endpoints.indexOf(target);
}

export async function ingestFailoverLineReports(input: {
  hostId: number;
  events: unknown;
  snapshot: unknown;
  /** Agent 2.2.198 起随心跳带的评分快照。 */
  stats?: unknown;
  /** 这台机器有权报告的规则（带着库里现在记的线路）。只在真有东西要处理时才取。 */
  loadHostRules: () => Promise<any[]>;
  nowMs?: number;
}) {
  const nowMs = input.nowMs ?? Date.now();
  const hostId = Number(input.hostId);
  const events = Array.isArray(input.events) ? input.events.slice(0, 128) : [];
  const snapshot = Array.isArray(input.snapshot) ? input.snapshot.slice(0, 1024) : null;
  const stats = Array.isArray(input.stats) && input.stats.length > 0 ? input.stats : null;
  const signature = snapshot ? snapshotSignature(snapshot) : "";
  const previous = lastSnapshotByHost.get(hostId);
  const snapshotNeedsCheck = snapshot !== null
    && (!previous || previous.signature !== signature || nowMs - previous.checkedAt >= SNAPSHOT_RECHECK_MS);
  const statsDue = stats !== null && nowMs - (lastStatsAtByHost.get(hostId) || 0) >= STATS_RECORD_INTERVAL_MS;
  if (events.length === 0 && !snapshotNeedsCheck && !statsDue) return { written: 0, events: 0 };

  const rules = await input.loadHostRules();
  /*
    规则归属必须验：Agent 只能报自己机器上的规则，否则一台被攻陷的机器能往任意
    规则上写日志。
  */
  const rulesById = new Map<number, any>();
  for (const rule of rules || []) {
    const id = Number(rule?.id || 0);
    if (id > 0) rulesById.set(id, rule);
  }

  if (stats && (statsDue || events.length > 0)) {
    recordRouteAgentStats({ hostId, reports: stats, isAllowed: (ruleId) => rulesById.has(ruleId), nowMs });
    lastStatsAtByHost.set(hostId, nowMs);
    // 质量历史：每条路径最多一分钟落一行（routePathQualityHistory 自己节流，写失败只记日志）。
    const reportedRules = Array.from(new Set((stats as any[]).map((item) => Math.floor(Number(item?.ruleId || 0)))))
      .map((ruleId) => rulesById.get(ruleId))
      .filter((rule) => !!rule);
    if (reportedRules.length > 0) await recordRoutePathQuality({ rules: reportedRules, nowMs });
  }

  // 一次心跳里同一条规则可能连切几次，只有最后一次才是「现在」。
  const eventLines = new Map<number, ReportedLine>();
  let storedEvents = 0;
  for (const rawEvent of events) {
    const ruleId = Math.max(0, Math.floor(Number(rawEvent?.ruleId || 0)));
    if (!ruleId || !rulesById.has(ruleId)) continue;
    const kind = normalizeRouteEventKind(normalizeAgentText(rawEvent?.kind, 24));
    if (!kind || !STORED_EVENT_KINDS.has(kind)) continue;
    const rule = rulesById.get(ruleId);
    const toTarget = normalizeAgentText(rawEvent?.toTarget, 256);
    if (kind === "switch" && !toTarget) continue;
    const fromTarget = normalizeAgentText(rawEvent?.fromTarget, 256);
    const reason = normalizeAgentText(rawEvent?.reason, 256);
    const latencyMs = Math.max(0, Math.floor(Number(rawEvent?.latencyMs || 0)));
    // Agent 没评分时报 0 或 -1（切换原因是探测不通、没样本）；只有真有分才记。
    const score = Number.isFinite(Number(rawEvent?.score)) && Number(rawEvent?.score) > 0 ? Math.min(100, Math.floor(Number(rawEvent.score))) : null;
    const transition = kind === "switch"
      ? `${fromTarget || "(无)"} -> ${toTarget}`
      : toTarget;
    appendPanelLog(
      kind === "recovered" || kind === "prewarm" ? "info" : "warn",
      `[Failover] host=${hostId} rule=${ruleId} ${kind} ${transition}`
        + `${reason ? ` reason=${reason}` : ""}${latencyMs > 0 ? ` latencyMs=${latencyMs}` : ""}${score !== null ? ` score=${score}` : ""}`,
    );
    /*
      只有 switch 改变「现在走哪条」。unhealthy / recovered 说的是某一条
      出站的健康翻转 —— 一条备线恢复了不等于流量就回到它身上（最短驻留、
      人工钉住都可能压着不切），拿它去写当前线路会显示成一个没有发生过的
      切换。
    */
    const atSeconds = agentReportedSeconds(rawEvent?.occurredAt, nowMs);
    if (kind === "switch") {
      eventLines.set(ruleId, { target: toTarget, at: atSeconds });
    }

    // 入库：目标地址 → 路径。老 Agent 的事件没有下标，按拨号地址反查。
    const paths = routePathsOf(rule as RouteGroupRule);
    const endpoints = failoverLineEndpoints(rule as RouteGroupRule);
    const toIndex = reportedIndex(rawEvent?.toIndex, toTarget, endpoints);
    const fromIndex = reportedIndex(rawEvent?.fromIndex, fromTarget, endpoints);
    const toLabel = toIndex >= 0 ? routePathLabel(paths[toIndex], toIndex) : (toTarget || null);
    const fromLabel = fromIndex >= 0 ? routePathLabel(paths[fromIndex], fromIndex) : (fromTarget || null);
    try {
      await db.insertForwardRuleRouteEvent({
        ruleId,
        kind,
        fromKey: fromIndex >= 0 ? paths[fromIndex]?.key : null,
        toKey: toIndex >= 0 ? paths[toIndex]?.key : null,
        fromLabel,
        toLabel,
        reason: reason || null,
        score,
        latencyMs: latencyMs > 0 ? latencyMs : null,
        atSeconds,
      });
      storedEvents += 1;
    } catch (error) {
      appendPanelLog("warn", `[Failover] host=${hostId} rule=${ruleId} 切换记录写入失败: ${String((error as any)?.message || error)}`);
    }
    recordRouteSwitchEvent({ rule, hostId, kind, fromLabel, toLabel, reason }); // 事件时间线（与 TG 开关无关）
    if (kind === "unhealthy" || kind === "recovered") {
      // 某一条路径坏了 / 好了：Agent 把那条路径放在 to 上。也进时间线，故障看板据此数异常和恢复。
      recordRouteHealthEvent({ rule, hostId, kind, pathKey: toIndex >= 0 ? paths[toIndex]?.key ?? null : null, pathLabel: toLabel, reason });
    }
    if ((kind === "switch" || kind === "precheck_failed") && rule?.telegramErrorNotifyEnabled) {
      void notifyRouteSwitch({
        rule,
        host: null,
        kind,
        fromLabel,
        fromValue: fromTarget || (fromIndex >= 0 ? endpoints[fromIndex] : null),
        toLabel,
        toValue: toTarget || (toIndex >= 0 ? endpoints[toIndex] : null),
        reason,
        score,
        latencyMs,
      }).catch((error) => {
        appendPanelLog("warn", `[Failover] host=${hostId} rule=${ruleId} Telegram 提醒失败: ${String((error as any)?.message || error)}`);
      });
    }
  }

  // 快照是「现在」，事件是「刚才发生过什么」：两样都有时以快照为准。
  const lines = new Map<number, ReportedLine>(eventLines);
  if (snapshot) {
    const newest = new Map<number, ReportedLine>();
    for (const raw of snapshot as any[]) {
      const ruleId = Math.max(0, Math.floor(Number(raw?.ruleId || 0)));
      if (!ruleId || !rulesById.has(ruleId)) continue;
      const target = normalizeAgentText(raw?.target, 256);
      if (!target) continue;
      const line = { target, at: agentReportedSeconds(raw?.since, nowMs) };
      // 一条规则可能有几个监听端口（几个代理）。各自走哪条通常一致；不一致时取最近变过的那个。
      const existing = newest.get(ruleId);
      if (!existing || line.at >= existing.at) newest.set(ruleId, line);
    }
    for (const [ruleId, line] of newest) lines.set(ruleId, line);
  }

  let written = 0;
  let failed = false;
  for (const [ruleId, line] of lines) {
    const rule = rulesById.get(ruleId);
    const storedAt = Math.floor(timestampMillis(rule?.failoverActiveAt) / 1000);
    // 没变就不写：快照每次心跳都来，原样再写一遍是白白的写放大。
    if (String(rule?.failoverActiveTarget || "") === line.target && storedAt === line.at) continue;
    try {
      await db.updateForwardRuleFailoverActiveLine(ruleId, line.target, line.at);
      written += 1;
    } catch (error) {
      failed = true;
      // 一条规则写不进去不该让整个心跳失败 —— 心跳还带着流量和运行状态。
      appendPanelLog("warn", `[Failover] host=${hostId} rule=${ruleId} 当前线路写入失败: ${String((error as any)?.message || error)}`);
    }
  }
  // 写失败了就不记这份快照，下一次心跳再核一遍。
  if (snapshot && !failed) lastSnapshotByHost.set(hostId, { signature, checkedAt: nowMs });
  return { written, events: storedEvents };
}

/** 测试用：模拟面板重启。 */
export function resetFailoverLineReportMemory() {
  lastSnapshotByHost.clear();
  lastStatsAtByHost.clear();
}
