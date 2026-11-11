import type { DdnsLineFallbackMode, DdnsLineRef, DdnsLineSource, DdnsLineStateEntry } from "@shared/ddnsLines";

/*
  分线路解析的规划：纯函数，不碰库、不碰网络。

  输入是组里每个启用成员此刻的状态（健康 / 观察期 / 等结果 / 不可用 / 流量到阈值）、它分到的线路、
  上一轮每条线路发布了什么；输出是每条非默认线路该发布的记录值，或者该删掉。默认线路仍由
  forwardGroupRepository 原来那套逻辑发布（保留最后一条、事件、通知都在那里），这里只告诉它
  默认线路上是哪些成员。

  为什么成员的健康判断不在这里做：故障观察时间、恢复稳定时间、Agent 离线宽限这些都已经在组的
  评估里算过一遍并写回了成员行，再算一遍只会和默认线路的结论对不上。这里只拿结论（status）。

  规则：
  1. 没分线路的成员只在默认线路，和以前完全一样；分了线路的成员只在它分到的线路（勾上「默认」
     才同时在默认线路）。一个成员都不在默认线路时，默认线路用全部成员 —— 默认线路是所有没单独
     配置的运营商的兜底，绝不能因为都分走了就空着。
  2. 每条线路：取这条线路上可用的成员（入口组取全部，主备组取一个）。
  3. 线路上一个可用的都没有：
     - fallback = default（默认）：改用默认线路此刻的健康成员；默认线路也没有健康成员时保留这条
       线路上一次的记录（流量到阈值的地址照样剔掉），什么都留不下就删掉，让用户回落到默认线路；
     - fallback = remove：删掉这条线路的记录，让服务商把这条线路的用户回落到默认线路。
     无论哪种都不会发布一个空的记录集。
  4. 线路不再有任何启用成员（改了配置）：删掉面板在这条线路上写过的记录。
  5. 带宽排序（rank）只在一条线路自己的成员里排；流量到阈值的成员任何时候都不进解析。
*/

export type LineMemberStatus =
  /** 可用：进解析。 */
  | "up"
  /** 不健康但还在故障观察时间内：已经在这条线路里的留着，不新加进来。 */
  | "grace"
  /** 健康结果还没出来：同上。 */
  | "pending"
  /** 不可用（故障观察时间已到 / 未恢复 / 没有可用地址）。 */
  | "down"
  /** 主机流量到阈值：立刻剔除，保留上一次记录时也剔掉。 */
  | "quota";

export type LinePlannerMember = {
  memberId: number;
  hostId: number;
  priority: number;
  /** 这个成员对应记录类型的值（A → IPv4、AAAA → IPv6、CNAME → 域名）；空 = 没有可用值。 */
  value: string;
  /** 分到的线路；空 = 只在默认线路。 */
  lines: DdnsLineRef[];
  status: LineMemberStatus;
  /** 主备组：恢复稳定时间已到，可以回切到它。 */
  recovered?: boolean;
  bandwidthMbps?: number | null;
  aggregationWeight?: number | null;
};

export type LinePlanInput = {
  recordType: string;
  /** multi：入口组，线路上所有可用成员都发布；single：主备组，每条线路只发布一个。 */
  mode: "multi" | "single";
  defaultLine: DdnsLineRef;
  /** 启用的成员（停用的不算线路成员：停掉线路上最后一个成员等于这条线路不再分配）。 */
  members: LinePlannerMember[];
  /** 默认线路上一轮发布的值（组的 lastDdnsValue）。 */
  defaultPreviousValues: string[];
  /** 上一轮每条非默认线路的状态，按线路 id。 */
  previous: Record<string, Pick<DdnsLineStateEntry, "id" | "name" | "values">>;
  fallback: DdnsLineFallbackMode;
  /** 主备组：高优先级成员恢复后自动回切。 */
  autoFailback?: boolean;
  /** 入口组的带宽排序：给出一条线路的成员和值，返回排好的值（只能重排，不能增删）。 */
  rank?: (members: LinePlannerMember[], values: string[]) => string[];
};

export type LinePlanReason =
  | "members"
  | "fallback"
  | "hold"
  | "fallback-remove"
  | "nothing-to-hold"
  | "unassigned";

export type LinePlanEntry = {
  line: DdnsLineRef;
  action: "publish" | "delete";
  /** publish 时要发布的值（非空）；delete 时为空。 */
  values: string[];
  memberIds: number[];
  /** publish 时值的来源。 */
  source: DdnsLineSource | null;
  reason: LinePlanReason;
};

export type LinePlan = {
  /** 默认线路上的成员 id（默认线路原来那套逻辑只看这些成员）。 */
  defaultMemberIds: number[];
  /** 默认线路此刻的健康值（线路回落时用的就是它）。 */
  defaultValues: string[];
  defaultValueMemberIds: number[];
  lines: LinePlanEntry[];
};

/** 两条线路是不是同一条：两边都有 id 就比 id（DNSPod 的线路 ID），否则比名字。 */
export function sameDdnsLine(a: DdnsLineRef, b: DdnsLineRef) {
  return a.id && b.id ? a.id === b.id : a.name === b.name;
}

export function memberOnDefaultLine(member: Pick<LinePlannerMember, "lines">, defaultLine: DdnsLineRef) {
  return member.lines.length === 0 || member.lines.some((line) => sameDdnsLine(line, defaultLine));
}

/**
 * 默认线路上的成员：没分线路的 + 勾了默认线路的。一个都没有时就是全部成员（规则 1）。
 * 默认线路原来那套发布逻辑也用这个判定，两边对「谁在默认线路」只有一个说法。
 */
export function defaultLineMembers<T extends Pick<LinePlannerMember, "lines">>(members: T[], defaultLine: DdnsLineRef): T[] {
  const onDefault = members.filter((member) => memberOnDefaultLine(member, defaultLine));
  return onDefault.length > 0 ? onDefault : members;
}

function normalizeValue(recordType: string, value: string) {
  const text = String(value || "").trim();
  return recordType === "CNAME" ? text.toLowerCase().replace(/\.+$/, "") : text;
}

function byPriority(a: LinePlannerMember, b: LinePlannerMember) {
  return a.priority - b.priority || a.memberId - b.memberId;
}

type Selection = { values: string[]; members: LinePlannerMember[] };

/** 入口组：上一轮已经在这组值里的观察期 / 等结果成员留着，可用的全部进来。 */
function selectMulti(members: LinePlannerMember[], previous: Set<string>, recordType: string): Selection {
  const values: string[] = [];
  const chosen: LinePlannerMember[] = [];
  for (const member of members) {
    const value = normalizeValue(recordType, member.value);
    if (!value) continue;
    const keep = member.status === "up"
      || ((member.status === "grace" || member.status === "pending") && previous.has(value));
    if (!keep) continue;
    if (!values.includes(value)) values.push(value);
    if (!chosen.some((entry) => entry.memberId === member.memberId)) chosen.push(member);
    // CNAME 一个名字只能有一条，取顺序最靠前的。
    if (recordType === "CNAME") break;
  }
  return { values, members: chosen };
}

/**
 * 主备组：每条线路一个成员。当前在用的成员还没到故障观察时间就不换；它不可用了换顺序最靠前的
 * 可用成员；开了自动回切时，排在它前面的成员恢复够久了就切回去。和默认线路的主备规则一致。
 */
function selectSingle(members: LinePlannerMember[], previous: Set<string>, recordType: string, autoFailback: boolean): Selection {
  const usable = members.filter((member) => normalizeValue(recordType, member.value));
  const current = usable.find((member) => previous.has(normalizeValue(recordType, member.value)));
  const firstUp = usable.find((member) => member.status === "up");
  let pick: LinePlannerMember | undefined;
  if (current && (current.status === "up" || current.status === "grace" || current.status === "pending")) {
    pick = current;
    if (autoFailback && current.status === "up") {
      const better = usable.find((member) => member.status === "up" && member.recovered && member.priority < current.priority);
      if (better) pick = better;
    }
  } else {
    pick = firstUp;
  }
  return pick ? { values: [normalizeValue(recordType, pick.value)], members: [pick] } : { values: [], members: [] };
}

export function planDdnsLineRecordSets(input: LinePlanInput): LinePlan {
  const recordType = String(input.recordType || "A").trim().toUpperCase();
  const members = [...input.members].sort(byPriority);
  const select = (list: LinePlannerMember[], previousValues: Iterable<string>): Selection => {
    const previous = new Set(Array.from(previousValues, (value) => normalizeValue(recordType, value)).filter(Boolean));
    const selection = input.mode === "single"
      ? selectSingle(list, previous, recordType, !!input.autoFailback)
      : selectMulti(list, previous, recordType);
    if (input.mode === "multi" && input.rank && selection.values.length > 1) {
      const ranked = input.rank(selection.members, selection.values);
      // 排序只许重排：值的集合变了就不用它，免得一个排序 bug 把入口加多或弄丢。
      const same = ranked.length === selection.values.length && ranked.every((value) => selection.values.includes(value));
      if (same) return { ...selection, values: ranked };
    }
    return selection;
  };

  const defaultMembers = defaultLineMembers(members, input.defaultLine);
  const defaultSelection = select(defaultMembers, input.defaultPreviousValues);
  const quotaValues = new Set(members
    .filter((member) => member.status === "quota")
    .map((member) => normalizeValue(recordType, member.value))
    .filter(Boolean));

  // 线路按第一次出现的顺序（成员优先级顺序），之后是上一轮有、这一轮没人分配的。
  const lines: DdnsLineRef[] = [];
  const addLine = (line: DdnsLineRef) => {
    if (sameDdnsLine(line, input.defaultLine) || lines.some((existing) => existing.id === line.id)) return;
    lines.push(line);
  };
  for (const member of members) for (const line of member.lines) addLine(line);
  for (const previous of Object.values(input.previous)) addLine({ id: previous.id, name: previous.name });

  const entries: LinePlanEntry[] = [];
  for (const line of lines) {
    const previous = input.previous[line.id];
    const lineMembers = members.filter((member) => member.lines.some((assigned) => assigned.id === line.id));
    const remove = (reason: LinePlanReason): LinePlanEntry => ({ line, action: "delete", values: [], memberIds: [], source: null, reason });
    if (lineMembers.length === 0) {
      entries.push(remove("unassigned"));
      continue;
    }
    const selection = select(lineMembers, previous?.values || []);
    if (selection.values.length > 0) {
      entries.push({ line, action: "publish", values: selection.values, memberIds: selection.members.map((member) => member.memberId), source: "members", reason: "members" });
      continue;
    }
    if (input.fallback === "remove") {
      entries.push(remove("fallback-remove"));
      continue;
    }
    if (defaultSelection.values.length > 0) {
      entries.push({
        line,
        action: "publish",
        values: defaultSelection.values,
        memberIds: defaultSelection.members.map((member) => member.memberId),
        source: "fallback",
        reason: "fallback",
      });
      continue;
    }
    // 默认线路也没有健康成员：和默认线路一样保留上一次的记录，但流量到阈值的地址不留。
    const held = (previous?.values || [])
      .map((value) => normalizeValue(recordType, value))
      .filter((value, index, list) => value && !quotaValues.has(value) && list.indexOf(value) === index);
    const heldValues = recordType === "CNAME" ? held.slice(0, 1) : held;
    if (heldValues.length > 0) {
      const heldMemberIds = members
        .filter((member) => heldValues.includes(normalizeValue(recordType, member.value)))
        .map((member) => member.memberId);
      entries.push({ line, action: "publish", values: heldValues, memberIds: heldMemberIds, source: "hold", reason: "hold" });
      continue;
    }
    entries.push(remove("nothing-to-hold"));
  }

  return {
    defaultMemberIds: defaultMembers.map((member) => member.memberId),
    defaultValues: defaultSelection.values,
    defaultValueMemberIds: defaultSelection.members.map((member) => member.memberId),
    lines: entries,
  };
}

/** 两组值作为 DNS 记录集是否相同（顺序无关）。 */
export function sameDdnsValueSet(recordType: string, left: readonly string[], right: readonly string[]) {
  const normalize = (values: readonly string[]) => Array.from(new Set(values.map((value) => normalizeValue(String(recordType || "A").toUpperCase(), value)).filter(Boolean))).sort().join(",");
  return normalize(left) === normalize(right);
}

export const LINE_PLAN_REASON_TEXT: Record<LinePlanReason, string> = {
  members: "线路成员",
  fallback: "线路成员全不可用，改用默认线路的健康成员",
  hold: "线路和默认线路都没有健康成员，保留上一次解析",
  "fallback-remove": "线路成员全不可用，按设置删掉这条线路的记录（回落到默认线路）",
  "nothing-to-hold": "线路成员全不可用，又没有可以保留的记录，删掉这条线路的记录（回落到默认线路）",
  unassigned: "这条线路已经没有成员，删掉面板写过的记录",
};
