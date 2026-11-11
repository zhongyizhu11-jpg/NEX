/*
  主机替换（换 VPS）：把旧机上挂着的东西整体改到新机上。面板侧流程在 server/hostReplace/，
  这里只放两边都要用的类型和几样纯计算（换线路里的主机 id），方便单测。

  一次替换按「单元」组织：一条直连规则、一条隧道（连同它上面的规则）、一个转发组成员、一条线路组规则、
  一个节点池、一组访问授权。执行时冲突选「跳过」就跳过整个单元；撤回也按单元撤 —— 一条隧道撤回了、
  它上面的规则没撤回，两边就对不上了。
*/
import { parseRoutePaths, serializeRoutePaths, type RoutePath } from "./routeGroup";
import { parseRouteLines, serializeRouteLines } from "./routeLines";

/** 替换记录保留多少天：过了就不能撤回，行也删掉。 */
export const HOST_REPLACE_RECORD_DAYS = 30;

export const HOST_REPLACE_CATEGORIES = [
  "rules",
  "tunnels",
  "groupMembers",
  "routeGroups",
  "nodePools",
  "access",
] as const;
export type HostReplaceCategory = (typeof HOST_REPLACE_CATEGORIES)[number];

export const HOST_REPLACE_CATEGORY_LABELS: Record<HostReplaceCategory, string> = {
  rules: "直连规则",
  tunnels: "隧道",
  groupMembers: "转发组成员",
  routeGroups: "线路组中转",
  nodePools: "节点池",
  access: "分组和授权",
};

export type HostReplaceUnitKind = "rule" | "tunnel" | "member" | "route" | "pool" | "access";

/** 预览里的一项（一个单元）。 */
export type HostReplaceItem = {
  unit: string;
  category: HostReplaceCategory;
  label: string;
  /** 一句话说清会怎么改，例如「入口 → 新机，端口 10086 不变」。 */
  detail: string;
};

export type HostReplaceResolution = "newPort" | "skip";

/** 一个冲突：端口在新机上被占、或者新机已经在这条隧道 / 这个组里。 */
export type HostReplaceConflict = {
  key: string;
  unit: string;
  label: string;
  detail: string;
  /** 被占的端口（端口冲突才有）。 */
  port: number | null;
  /** 新机上能换的空闲端口；null = 只能跳过。 */
  suggestedPort: number | null;
  options: HostReplaceResolution[];
};

/** 不自动搬、要用户自己处理的。 */
export type HostReplaceManualItem = {
  kind: string;
  label: string;
  detail: string;
};

export type HostReplaceCategorySummary = {
  category: HostReplaceCategory;
  label: string;
  count: number;
  /** 搬完之后会自动跟上的说明（转发组同步、中继重算……）。 */
  note: string;
};

export type HostReplaceHostSummary = {
  id: number;
  name: string;
  address: string;
  online: boolean;
  agentVersion: string;
};

export type HostReplacePreview = {
  oldHost: HostReplaceHostSummary;
  newHost: HostReplaceHostSummary;
  /** 执行时带回来：预览之后数据变了，执行会被拒绝。 */
  fingerprint: string;
  categories: HostReplaceCategorySummary[];
  items: HostReplaceItem[];
  conflicts: HostReplaceConflict[];
  manual: HostReplaceManualItem[];
  /** 不挡执行、但要让人知道的（新机版本低、没装 mimic……）。 */
  warnings: string[];
  /** 挡住执行的（新机离线、选了同一台……）。 */
  blockers: string[];
  /** 「旧地址临时转到新机」能留几个小时；0 = 设置里关了。 */
  bridgeHours: number;
};

export type HostReplaceRecordSummary = {
  id: number;
  oldHostId: number;
  newHostId: number;
  oldHostName: string;
  newHostName: string;
  status: "done" | "undone";
  createdAt: number;
  undoneAt: number | null;
  expiresAt: number;
  counts: Partial<Record<HostReplaceCategory, number>>;
  skipped: number;
  manual: HostReplaceManualItem[];
  undoReport: string[];
};

/** 列表里换一个 id：old 换成 next，换完去重（next 已经在里面就只是把 old 拿掉）。 */
export function replaceIdInList(ids: readonly number[], oldId: number, nextId: number): number[] {
  const out: number[] = [];
  for (const raw of ids) {
    const id = Number(raw) === oldId ? nextId : Number(raw);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

export type RoutePathSwap = {
  /** 换过的 routePaths（没变就是 null）。 */
  routePaths: string | null;
  changed: boolean;
  /** 换不了的原因：新机已经在这条路径上 / 新机就是入口。有它整条规则不动。 */
  blocked: string | null;
  /** 落在落地池成员（destHostId）上的路径：跟着落地池走，这里不改，只提示。 */
  landingMember: boolean;
};

/**
 * 路径里的中转 old → next。dial / issue 清掉，等中继同步重新算（server/routeGroups.ts）。
 *
 * entryHostId：调度器所在的机器（规则入口；隧道规则是隧道出口）。新机就是入口时不能当它的中转。
 */
export function swapRoutePathsHost(raw: unknown, oldId: number, nextId: number, entryHostId: number | null): RoutePathSwap {
  const paths = parseRoutePaths(raw);
  let changed = false;
  let blocked: string | null = null;
  let landingMember = false;
  const next: RoutePath[] = paths.map((path, index) => {
    if (Number(path.destHostId || 0) === oldId) landingMember = true;
    if (!path.hops.includes(oldId)) return path;
    const name = path.name || `路径 ${index + 1}`;
    if (path.hops.includes(nextId)) blocked = blocked || `「${name}」已经经过新机`;
    if (entryHostId && entryHostId === nextId) blocked = blocked || `新机就是这条规则的入口，不能再当「${name}」的中转`;
    changed = true;
    return { ...path, hops: path.hops.map((hop) => (hop === oldId ? nextId : hop)), dial: null, issue: null };
  });
  return { routePaths: changed ? serializeRoutePaths(next) : null, changed, blocked, landingMember };
}

/** 线路定义（routeLines）里候选机器 old → next。节点池层不动（池本身单独换）。 */
export function swapRouteLinesHost(raw: unknown, oldId: number, nextId: number): { routeLines: string | null; changed: boolean } {
  const lines = parseRouteLines(raw);
  let changed = false;
  const next = lines.map((line) => ({
    ...line,
    layers: line.layers.map((layer) => {
      if (layer.kind === "pool" || !layer.hostIds.includes(oldId)) return layer;
      changed = true;
      return { ...layer, hostIds: replaceIdInList(layer.hostIds, oldId, nextId) };
    }),
  }));
  return { routeLines: changed ? serializeRouteLines(next) : null, changed };
}

/** 冲突的默认处理：能换端口就换，不能就跳过。 */
export function defaultHostReplaceResolution(conflict: Pick<HostReplaceConflict, "options">): HostReplaceResolution {
  return conflict.options.includes("newPort") ? "newPort" : "skip";
}
