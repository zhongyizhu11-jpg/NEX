import { eq } from "drizzle-orm";
import { forwardGroups } from "../drizzle/schema";
import {
  normalizeDdnsLineFallback,
  parseDdnsLines,
  parseDdnsLineState,
  type DdnsLineFallbackMode,
  type DdnsLineRef,
  type DdnsLineState,
  type DdnsLineStateEntry,
} from "@shared/ddnsLines";
import { DEFAULT_DDNS_TTL, type DdnsSettings } from "./ddns";
import {
  LINE_PLAN_REASON_TEXT,
  defaultLineMembers,
  planDdnsLineRecordSets,
  sameDdnsValueSet,
  type LinePlannerMember,
  type LinePlanInput,
} from "./ddnsLinePlanner";
import { ddnsDefaultLine, ddnsLineSupport, deleteDdnsLineRecords, publishDdnsLineRecords } from "./ddnsLineRecords";
import { getDb, nowDate } from "./dbRuntime";

/*
  转发组 / 入口组的分线路解析：在组原来那次 DDNS 发布（默认线路）之后，按 server/ddnsLinePlanner.ts
  的规划把每条非默认线路的记录写到服务商，并把结果记在组的 ddnsLineState 里。

  对没分线路的组（也没有残留的线路记录）prepareForwardGroupDdnsLines 直接返回 null：
  forwardGroupRepository 里所有分支都按 null 走原来的路，不多发一个请求、不多读一次库。

  失败的处理：一条线路写失败不影响别的线路，也不回滚默认线路；失败的那条保持上一次的状态（下一轮
  照旧会重试），全部处理完后抛错，让组的评估队列按退避重试。
*/

function truthy(value: unknown, fallback = false) {
  if (value === undefined || value === null) return fallback;
  return value === true || value === 1 || value === "1" || value === "true";
}

/** 这里用到的组字段（组行在仓库层是宽松的 any，这里只声明读写的这几样）。 */
export type ForwardGroupLineGroup = {
  id?: unknown;
  domain?: unknown;
  recordType?: unknown;
  members?: Array<{ ddnsLines?: unknown; isEnabled?: unknown }> | null;
  ddnsAutoResolveEnabled?: unknown;
  ddnsLineFallback?: unknown;
  ddnsLineState?: unknown;
  lastDdnsValue?: unknown;
  autoFailback?: unknown;
};

export type ForwardGroupLineContext = {
  defaultLine: DdnsLineRef;
  fallback: DdnsLineFallbackMode;
  state: DdnsLineState | null;
  /** 成员分到的线路（规整过的）。 */
  linesOf(member: { ddnsLines?: unknown }): DdnsLineRef[];
  /**
   * 只留默认线路上的成员（没分线路的、勾了默认线路的；一个都没有时是全部）。
   * 用启用的成员判断：停用的成员不能决定默认线路上有没有人。
   */
  defaultOnly<T extends { ddnsLines?: unknown; isEnabled?: unknown }>(members: T[]): T[];
};

/**
 * 这个组这一轮要不要管线路。null = 不管（服务商不支持、组没分线路也没有残留记录、没开自动解析）。
 * 纯内存判断，不发请求。
 */
export function prepareForwardGroupDdnsLines(group: ForwardGroupLineGroup | null | undefined, settings: DdnsSettings): ForwardGroupLineContext | null {
  if (!group || !truthy(group.ddnsAutoResolveEnabled, true)) return null;
  if (!String(group.domain || "").trim()) return null;
  const members = group.members || [];
  const hasAssignments = members.some((member) => truthy(member?.isEnabled, true) && parseDdnsLines(member?.ddnsLines).length > 0);
  const state = parseDdnsLineState(group.ddnsLineState);
  const hasState = !!state && Object.keys(state.lines).length > 0;
  if (!hasAssignments && !hasState) return null;
  if (!ddnsLineSupport(settings).supported) return null;
  const defaultLine = ddnsDefaultLine(settings);
  const linesOf = (member: { ddnsLines?: unknown }) => parseDdnsLines(member?.ddnsLines);
  return {
    defaultLine,
    fallback: normalizeDdnsLineFallback(group.ddnsLineFallback),
    state,
    linesOf,
    defaultOnly(list) {
      const enabled = list.filter((member) => truthy(member?.isEnabled, true));
      const onDefault = new Set(defaultLineMembers(enabled.map((member) => ({ member, lines: linesOf(member) })), defaultLine).map((entry) => entry.member));
      // 启用的成员一个都不在默认线路 → defaultLineMembers 已经给了全部启用成员；停用的成员原样留着（后面本来就会跳过）。
      return list.filter((member) => onDefault.has(member) || !truthy(member?.isEnabled, true));
    },
  };
}

export type ForwardGroupLineSyncInput = {
  group: ForwardGroupLineGroup;
  ctx: ForwardGroupLineContext;
  settings: DdnsSettings;
  mode: LinePlanInput["mode"];
  members: LinePlannerMember[];
  forceSync?: boolean;
  rank?: LinePlanInput["rank"];
  recordEvent: (type: string, message: string, memberId?: number | null) => Promise<void>;
};

// 进程里已经和服务商核对过的线路：重启后每条线路先完整对账一次，之后只在值变了时才写。
const reconciledLines = new Map<string, string>();

export function resetForwardGroupDdnsLinesForTests() {
  reconciledLines.clear();
}

function lineSignature(domain: string, recordType: string, values: string[]) {
  return `${domain}|${recordType}|${[...values].sort().join(",")}`;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function stateJson(state: DdnsLineState | null) {
  return state && Object.keys(state.lines).length > 0 ? JSON.stringify(state) : null;
}

/**
 * 把一个组的非默认线路同步到服务商。返回这一轮之后的线路状态。
 */
export async function syncForwardGroupDdnsLines(input: ForwardGroupLineSyncInput): Promise<DdnsLineState | null> {
  const { group, ctx, settings } = input;
  const groupId = Number(group.id);
  const domain = String(group.domain || "").trim().toLowerCase();
  const recordType = String(group.recordType || "A").trim().toUpperCase();
  const ttl = Number(settings.ttl || DEFAULT_DDNS_TTL);
  const previousState = ctx.state;
  const failures: string[] = [];
  const nextLines: Record<string, DdnsLineStateEntry> = {};
  let previousLines: Record<string, DdnsLineStateEntry> = previousState?.lines || {};

  // 组改了域名或记录类型：旧名字 / 旧类型上的线路记录按记下的 ID 先清掉，再按新的发布。
  if (previousState && (previousState.domain !== domain || previousState.recordType !== recordType)) {
    for (const entry of Object.values(previousLines)) {
      try {
        const result = await deleteDdnsLineRecords(settings, {
          domain: previousState.domain,
          recordType: previousState.recordType,
          line: { id: entry.id, name: entry.name },
          recordIds: entry.recordIds,
        });
        await input.recordEvent("ddns-line-delete", `组的域名或记录类型改了，旧线路记录已清理；线路=${entry.name} domain=${previousState.domain} type=${previousState.recordType} 删除 ${result.deleted.length} 条`);
      } catch (error) {
        const message = errorText(error);
        if (/不在主域名/.test(message)) {
          // 旧名字已经不在 DNSPod 主域名下（DDNS 设置换了域名），面板删不了，只能提示人去手动清。
          await input.recordEvent("ddns-line-error", `旧线路记录不在当前 DNSPod 主域名下，面板没法清理，请到 DNSPod 手动删除；线路=${entry.name} domain=${previousState.domain} type=${previousState.recordType}`);
          continue;
        }
        await input.recordEvent("ddns-line-error", `清理旧线路记录失败：${message}；线路=${entry.name} domain=${previousState.domain} type=${previousState.recordType}`);
        // 旧记录没清掉就先不发布新的：状态不动，下一轮再来。
        throw new Error(`分线路解析：清理旧记录失败（${entry.name}）：${message}`);
      }
    }
    previousLines = {};
  }

  const plan = planDdnsLineRecordSets({
    recordType,
    mode: input.mode,
    defaultLine: ctx.defaultLine,
    members: input.members,
    defaultPreviousValues: String(group.lastDdnsValue || "").split(",").map((value) => value.trim()).filter(Boolean),
    previous: previousLines,
    fallback: ctx.fallback,
    autoFailback: truthy(group.autoFailback, true),
    rank: input.rank,
  });

  const at = nowDate().toISOString();
  for (const entry of plan.lines) {
    const key = entry.line.id;
    const previous = previousLines[key];
    const reconcileKey = `${groupId}:${key}`;
    if (entry.action === "delete") {
      if (!previous) continue;
      try {
        const result = await deleteDdnsLineRecords(settings, { domain, recordType, line: entry.line, recordIds: previous.recordIds });
        reconciledLines.delete(reconcileKey);
        await input.recordEvent(
          "ddns-line-delete",
          `线路 ${entry.line.name} 的记录已删除：${LINE_PLAN_REASON_TEXT[entry.reason]}；domain=${domain} type=${recordType} 删除 ${result.deleted.length} 条${result.untouched > 0 ? `，另有 ${result.untouched} 条不是面板写的，未动` : ""}`,
        );
      } catch (error) {
        failures.push(`${entry.line.name}：${errorText(error)}`);
        nextLines[key] = previous;
        await input.recordEvent("ddns-line-error", `删除线路 ${entry.line.name} 的记录失败：${errorText(error)}；domain=${domain} type=${recordType}`);
      }
      continue;
    }

    const signature = lineSignature(domain, recordType, entry.values);
    const unchanged = !!previous && sameDdnsValueSet(recordType, previous.values, entry.values) && previous.recordIds.length > 0;
    if (unchanged && !input.forceSync && reconciledLines.get(reconcileKey) === signature) {
      nextLines[key] = { ...previous, name: entry.line.name, memberIds: entry.memberIds, source: entry.source || "members" };
      continue;
    }
    try {
      const result = await publishDdnsLineRecords(settings, { domain, recordType, line: entry.line, values: entry.values, ttl });
      reconciledLines.set(reconcileKey, signature);
      nextLines[key] = {
        id: entry.line.id,
        name: entry.line.name,
        values: entry.values,
        recordIds: result.recordIds,
        memberIds: entry.memberIds,
        source: entry.source || "members",
        at,
      };
      if (!unchanged || result.writes > 0) {
        await input.recordEvent(
          entry.source === "hold" ? "ddns-line-hold" : "ddns-line-update",
          `线路 ${entry.line.name} 已同步（${LINE_PLAN_REASON_TEXT[entry.reason]}）；domain=${domain} type=${recordType} values=${entry.values.join(",")}`,
          entry.memberIds[0] ?? null,
        );
      }
    } catch (error) {
      failures.push(`${entry.line.name}：${errorText(error)}`);
      if (previous) nextLines[key] = previous;
      await input.recordEvent("ddns-line-error", `线路 ${entry.line.name} 更新失败：${errorText(error)}；domain=${domain} type=${recordType} values=${entry.values.join(",")}`);
    }
  }

  const nextState: DdnsLineState = { v: 1, domain, recordType, lines: nextLines };
  const nextJson = stateJson(nextState);
  const currentJson = stateJson(previousState);
  if (nextJson !== currentJson || String(group.ddnsLineState ?? "") !== String(nextJson ?? "")) {
    const db = await getDb();
    await db.update(forwardGroups).set({ ddnsLineState: nextJson }).where(eq(forwardGroups.id, groupId));
    group.ddnsLineState = nextJson;
  }
  if (failures.length > 0) throw new Error(`分线路解析有 ${failures.length} 条线路没更新成功：${failures.join("；")}`);
  return nextJson ? nextState : null;
}
