import {
  MAX_ROUTE_HOPS,
  MAX_ROUTE_PATHS,
  defaultRoutePathName,
  newRoutePathKey,
  parseRoutePaths,
  type RouteEndpoint,
  type RouteGroupRule,
  type RoutePath,
} from "./routeGroup";

/*
  线路（2.3.496 起）：线路组的「定义」那一层。

  以前一条路径就是写死的一串机器：入口 → HK01 → JP01 → 落地。想让中转在三台香港机里挑最快的，
  就得手写三条路径；再加两个落地就是六条。线路把它倒过来：

      主线路   入口 → [香港中转池 | 隧道 华南-香港] → [落地 A | 落地 B]
      备用 1   入口 → [jinx] → 落地 A
      备用 2   入口 → 落地 A（直连）

  每一层放几个候选（几台机器、一个节点池，或者一条隧道），落地也可以放几个。面板把每条线路
  展开成具体路径（shared/routeGroup 的 RoutePath，Agent 只认它），同一条线路展开出来的路径
  是同一组（tier）：调度器先在主线路那一组里按整条链的分数挑，那一组全坏了才去备用 1 那一组。

  几条定死的规矩：
    · 展开总数不超过 MAX_ROUTE_PATHS（Agent 出站上限）。主线路先分，每条线路至少保一条。
    · 展开出来的路径 key 由线路 key + 组合算出来，组合不变 key 就不变：切换历史、评分、质量
      历史都按 key 记，池里加一台机器不会让已有路径的历史丢掉。
    · 维护中、离线的机器展开时跳过；一层全被跳过就记 issue，这条线路不出路径。
    · 隧道段：这一层是一条隧道，隧道的入口必须是上一个节点（入口机或上一跳）；走完它就到了
      隧道出口机。没对上就记 issue，不硬接。
*/

export const ROUTE_LAYER_KINDS = ["hosts", "pool", "tunnel"] as const;
export type RouteLayerKind = (typeof ROUTE_LAYER_KINDS)[number];

/** 一层里怎么挑：best = 按整条链估的延迟挑，order = 按写的顺序（前面的优先）。 */
export const ROUTE_LAYER_PICKS = ["best", "order"] as const;
export type RouteLayerPick = (typeof ROUTE_LAYER_PICKS)[number];

export type RouteLayer = {
  /**
   * pool = 这一层是一个节点池；hosts / tunnel = 这一层是几个候选：机器（hostIds）和隧道（tunnelIds）
   * 可以混着放（「隧道 Jinx」和「jinx(39.9y)」二选一）。只有隧道的叫 tunnel，有机器的叫 hosts。
   * 按顺序挑时隧道在前、机器在后（界面也按这个顺序画）。
   */
  kind: RouteLayerKind;
  /** 候选机器，按写的顺序。 */
  hostIds: number[];
  /** kind = pool：节点池（node_pools）。 */
  poolId: number | null;
  /** 候选隧道：走它到它的出口机，隧道入口得是上一个节点。 */
  tunnelIds: number[];
  pick: RouteLayerPick;
  /** 可跳过：这一层多一个「不经过」的选项，候选全坏了还能直连下一层。 */
  skippable: boolean;
};

export type RouteDestCandidate = {
  /** null = 规则自己的目标。 */
  dest: RouteEndpoint | null;
  destNodeId: number | null;
};

export type RouteLine = {
  key: string;
  name: string;
  paused: boolean;
  layers: RouteLayer[];
  /** 落地候选；空 = 只有规则自己的目标。 */
  dests: RouteDestCandidate[];
  /** 权重负载模式：这条线路展开出来的路径一起分到的权重。 */
  weight: number;
  /** 健康检查探哪：空 = 探路径的拨号地址；直连落地是用户态转发时填一个能反映整条链的地址。 */
  probe?: RouteEndpoint | null;
};

export const MAX_ROUTE_LINES = MAX_ROUTE_PATHS;
export const MAX_LAYER_CANDIDATES = 8;
export const MAX_LINE_DESTS = 4;

const KEY_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

function intIds(raw: unknown, limit: number): number[] {
  if (!Array.isArray(raw)) return [];
  return Array.from(new Set(raw.map((value) => Math.floor(Number(value))).filter((value) => Number.isInteger(value) && value > 0))).slice(0, limit);
}

function endpointOf(raw: unknown): RouteEndpoint | null {
  if (!raw || typeof raw !== "object") return null;
  const ip = String((raw as any).ip ?? (raw as any).host ?? "").trim();
  const port = Math.floor(Number((raw as any).port));
  if (!ip || !(port >= 1 && port <= 65535)) return null;
  return { ip, port };
}

export function newRouteLayer(patch: Partial<RouteLayer> = {}): RouteLayer {
  return { kind: "hosts", hostIds: [], poolId: null, tunnelIds: [], pick: "best", skippable: false, ...patch };
}

export function newRouteLine(index: number, patch: Partial<RouteLine> = {}): RouteLine {
  return { key: newRoutePathKey(), name: defaultRoutePathName(index), paused: false, layers: [], dests: [], weight: 50, ...patch };
}

function sanitizeLayer(raw: any): RouteLayer | null {
  if (!raw || typeof raw !== "object") return null;
  const kind = (ROUTE_LAYER_KINDS as readonly string[]).includes(String(raw.kind)) ? raw.kind as RouteLayerKind : "hosts";
  const pick = (ROUTE_LAYER_PICKS as readonly string[]).includes(String(raw.pick)) ? raw.pick as RouteLayerPick : "best";
  const poolId = Number.isInteger(Number(raw.poolId)) && Number(raw.poolId) > 0 ? Math.floor(Number(raw.poolId)) : null;
  const skippable = raw.skippable === true || raw.skippable === 1;
  if (kind === "pool") return poolId ? { kind, hostIds: [], poolId, tunnelIds: [], pick, skippable } : null;
  // 机器和隧道一起算候选上限，隧道在前。
  const tunnelIds = intIds(raw.tunnelIds ?? (raw.tunnelId ? [raw.tunnelId] : []), MAX_LAYER_CANDIDATES);
  const hostIds = intIds(raw.hostIds, MAX_LAYER_CANDIDATES - tunnelIds.length);
  if (hostIds.length === 0 && tunnelIds.length === 0) return null;
  return { kind: hostIds.length > 0 ? "hosts" : "tunnel", hostIds, poolId: null, tunnelIds, pick, skippable };
}

function sanitizeLine(raw: any, index: number): RouteLine | null {
  if (!raw || typeof raw !== "object") return null;
  const key = String(raw.key ?? "").trim().toLowerCase();
  const layers = Array.isArray(raw.layers) ? raw.layers.map(sanitizeLayer).filter((layer: RouteLayer | null): layer is RouteLayer => !!layer).slice(0, MAX_ROUTE_HOPS) : [];
  const dests: RouteDestCandidate[] = Array.isArray(raw.dests)
    ? raw.dests.slice(0, MAX_LINE_DESTS).map((item: any) => ({
      dest: endpointOf(item?.dest),
      destNodeId: Number.isInteger(Number(item?.destNodeId)) && Number(item?.destNodeId) > 0 ? Math.floor(Number(item.destNodeId)) : null,
    }))
    : [];
  const weight = Math.min(100, Math.max(1, Math.floor(Number(raw.weight)) || 50));
  const probe = endpointOf(raw.probe);
  return {
    key: KEY_PATTERN.test(key) ? key : `l${index + 1}`,
    name: String(raw.name ?? "").trim().slice(0, 40),
    paused: raw.paused === true || raw.paused === 1,
    layers,
    dests,
    weight,
    ...(probe ? { probe } : {}),
  };
}

/** routeLines 那一列 → 线路清单。认不出的扔掉；key 撞了后面的改名。 */
export function parseRouteLines(raw: unknown): RouteLine[] {
  if (!raw) return [];
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return [];
    const lines = parsed.map(sanitizeLine).filter((line): line is RouteLine => !!line).slice(0, MAX_ROUTE_LINES);
    const seen = new Set<string>();
    return lines.map((line, index) => {
      let key = line.key;
      while (seen.has(key)) key = `${line.key}-${index + 1}`;
      seen.add(key);
      return key === line.key ? line : { ...line, key };
    });
  } catch {
    return [];
  }
}

export function serializeRouteLines(lines: RouteLine[] | null | undefined): string | null {
  if (!lines || lines.length === 0) return null;
  return JSON.stringify(lines.map((line) => ({
    key: line.key,
    name: line.name,
    ...(line.paused ? { paused: true } : {}),
    layers: line.layers.map((layer) => ({
      kind: layer.kind,
      ...(layer.kind !== "pool" && layer.hostIds.length > 0 ? { hostIds: layer.hostIds } : {}),
      ...(layer.kind === "pool" ? { poolId: layer.poolId } : {}),
      ...(layer.kind !== "pool" && layer.tunnelIds.length > 0 ? { tunnelIds: layer.tunnelIds } : {}),
      pick: layer.pick,
      ...(layer.skippable ? { skippable: true } : {}),
    })),
    dests: line.dests.map((item) => ({ dest: item.dest, ...(item.destNodeId ? { destNodeId: item.destNodeId } : {}) })),
    weight: line.weight,
    ...(line.probe ? { probe: line.probe } : {}),
  })));
}

/**
 * 老数据（只有 routePaths）→ 线路：每条路径一条线路，每跳一层、一层一台机器。
 * 隧道段（hopVia）还原成隧道层。展开回去得到的还是同样的路径（key 用路径自己的）。
 */
export function routeLinesFromPaths(paths: RoutePath[]): RouteLine[] {
  const byLine = new Map<string, RoutePath[]>();
  const order: string[] = [];
  for (const path of paths) {
    const key = path.lineKey || path.key;
    if (!byLine.has(key)) {
      byLine.set(key, []);
      order.push(key);
    }
    byLine.get(key)!.push(path);
  }
  return order.map((key) => {
    const group = byLine.get(key)!;
    const first = group[0];
    const layers: RouteLayer[] = first.hops.map((hostId, index) => {
      const tunnelId = first.hopVia?.[index] ?? null;
      return tunnelId
        ? newRouteLayer({ kind: "tunnel", tunnelIds: [tunnelId], pick: "order" })
        : newRouteLayer({ kind: "hosts", hostIds: [hostId], pick: "order" });
    });
    const dests: RouteDestCandidate[] = [];
    for (const path of group) {
      const candidate = { dest: path.dest, destNodeId: path.destNodeId };
      if (!dests.some((item) => sameEndpoint(item.dest, candidate.dest) && item.destNodeId === candidate.destNodeId)) dests.push(candidate);
    }
    return {
      key: first.lineKey || first.key,
      name: first.name,
      paused: group.every((path) => !!path.paused),
      layers,
      dests: dests.length === 1 && !dests[0].dest && !dests[0].destNodeId ? [] : dests,
      weight: first.weight,
      ...(first.probe ? { probe: first.probe } : {}),
    };
  });
}

/** 这条规则的线路：存了 routeLines 就用它，没有就从路径推。 */
export function routeLinesOf(rule: Pick<RouteGroupRule, "routeLines" | "routePaths">): RouteLine[] {
  const stored = parseRouteLines(rule.routeLines);
  if (stored.length > 0) return stored;
  return routeLinesFromPaths(parseRoutePaths(rule.routePaths));
}

/**
 * 编辑框用的线路：存的线路 → 存的路径还原 → routeGroupOf 从老的 failover* 列推出来的路径还原 →
 * 一条空的主线路。编辑框只认线路，老规则打开也是线路的样子。
 */
export function routeLinesForEditor(rule: Pick<RouteGroupRule, "routeLines" | "routePaths">, paths: RoutePath[]): RouteLine[] {
  const lines = routeLinesOf(rule);
  if (lines.length > 0) return lines;
  const fromPaths = routeLinesFromPaths(paths);
  return fromPaths.length > 0 ? fromPaths : [newRouteLine(0)];
}

function sameEndpoint(a: RouteEndpoint | null, b: RouteEndpoint | null) {
  if (!a || !b) return !a && !b;
  return a.ip === b.ip && a.port === b.port;
}

// ---------------------------------------------------------------- 展开

export type RouteTunnelInfo = { id: number; entryHostId: number; exitHostId: number; name: string; usable: boolean; issue?: string | null };

export type RouteExpandContext = {
  entryHostId: number | null;
  /** 节点池的成员（按池里的顺序）。 */
  poolMembers: (poolId: number) => number[] | null;
  /** 这台机器现在能不能当中转（在线、不在维护、看得见）。 */
  hostUsable: (hostId: number) => boolean;
  tunnel: (tunnelId: number) => RouteTunnelInfo | null;
  /** 一段的延迟估计（毫秒）；不知道返回 null。from 为 0 表示入口机。 */
  estimateMs?: (fromHostId: number, toHostId: number) => number | null;
};

/** 一层展开后的一个选项：经过一台机器，或者经一条隧道到它的出口机，或者跳过。 */
type LayerOption = { hostId: number; via: number | null } | { skip: true };

export type RouteExpandResult = {
  paths: RoutePath[];
  /** 线路 key → 展开时遇到的问题（这条线路一条路径都没出就会有）。 */
  issues: Map<string, string>;
};

const DEFAULT_SEGMENT_MS = 40;

function hashKey(text: string) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).slice(0, 5).padStart(5, "0");
}

function layerOptions(layer: RouteLayer, previous: number[], ctx: RouteExpandContext): { options: LayerOption[]; issue: string | null } {
  const options: LayerOption[] = [];
  let issue: string | null = null;
  if (layer.kind !== "pool") {
    for (const tunnelId of layer.tunnelIds) {
      const tunnel = ctx.tunnel(tunnelId);
      if (!tunnel) {
        issue = `隧道 #${tunnelId} 不在了`;
        continue;
      }
      // 隧道的入口得是上一个节点；上一个节点是一组候选时，在组合那一步再筛。
      if (!tunnel.usable) {
        issue = tunnel.issue || `隧道「${tunnel.name}」现在用不了`;
        continue;
      }
      if (!ctx.hostUsable(tunnel.exitHostId)) {
        issue = `隧道「${tunnel.name}」的出口机不可用`;
        continue;
      }
      options.push({ hostId: tunnel.exitHostId, via: tunnel.id });
    }
  }
  if (layer.kind === "pool" || layer.hostIds.length > 0) {
    const candidates = layer.kind === "pool" ? (layer.poolId ? ctx.poolMembers(layer.poolId) : null) : layer.hostIds;
    if (!candidates) issue = "节点池不在了";
    for (const hostId of candidates || []) {
      if (ctx.entryHostId && hostId === ctx.entryHostId) continue;
      if (previous.includes(hostId)) continue;
      if (!ctx.hostUsable(hostId)) continue;
      options.push({ hostId, via: null });
    }
    if (options.length === 0 && !issue) issue = layer.kind === "pool" ? "节点池里没有能用的机器" : "这一层的机器都用不了（离线或维护中）";
  }
  if (layer.skippable) options.push({ skip: true });
  return { options, issue: options.length === 0 ? issue : null };
}

type Combo = { hops: number[]; via: Array<number | null>; dest: RouteDestCandidate; estimate: number; order: number[] };

function lineCombos(line: RouteLine, ctx: RouteExpandContext, cap: number): { combos: Combo[]; issue: string | null } {
  const dests = line.dests.length > 0 ? line.dests : [{ dest: null, destNodeId: null }];
  let partial: Array<Omit<Combo, "dest" | "estimate"> & { estimate: number }> = [{ hops: [], via: [], estimate: 0, order: [] }];
  for (const layer of line.layers) {
    const next: typeof partial = [];
    let lastIssue: string | null = null;
    for (const combo of partial) {
      const { options, issue } = layerOptions(layer, combo.hops, ctx);
      if (issue) lastIssue = issue;
      options.forEach((option, optionIndex) => {
        if ("skip" in option) {
          next.push({ ...combo, order: [...combo.order, optionIndex] });
          return;
        }
        const from = combo.hops.length > 0 ? combo.hops[combo.hops.length - 1] : 0;
        if (option.via) {
          const tunnel = ctx.tunnel(option.via);
          const fromHost = from === 0 ? ctx.entryHostId : from;
          if (!tunnel || tunnel.entryHostId !== fromHost) {
            lastIssue = `隧道「${tunnel?.name || option.via}」的入口不是上一个节点`;
            return;
          }
        }
        if (combo.hops.includes(option.hostId)) return;
        const segment = ctx.estimateMs?.(from, option.hostId) ?? null;
        next.push({
          hops: [...combo.hops, option.hostId],
          via: [...combo.via, option.via],
          estimate: combo.estimate + (segment ?? DEFAULT_SEGMENT_MS),
          order: [...combo.order, optionIndex],
        });
      });
    }
    if (next.length === 0) return { combos: [], issue: lastIssue || "这条线路组合不出能走的路径" };
    // 每层后剪枝：组合太多时只留估计最快 / 顺序最前的那些，免得指数爆炸。
    next.sort((a, b) => (layer.pick === "order" ? compareOrder(a.order, b.order) : a.estimate - b.estimate || compareOrder(a.order, b.order)));
    partial = next.slice(0, Math.max(cap * 4, 16));
  }
  const combos: Combo[] = [];
  for (const combo of partial) {
    dests.forEach((dest, destIndex) => {
      const last = combo.hops.length > 0 ? combo.hops[combo.hops.length - 1] : 0;
      void last;
      combos.push({ ...combo, dest, order: [...combo.order, destIndex] });
    });
  }
  const anyBest = line.layers.some((layer) => layer.pick === "best");
  combos.sort((a, b) => (anyBest ? a.estimate - b.estimate || compareOrder(a.order, b.order) : compareOrder(a.order, b.order)));
  return { combos, issue: null };
}

function compareOrder(a: number[], b: number[]) {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? -1) - (b[index] ?? -1);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * 线路 → 具体路径。总数不超过 limit（默认 MAX_ROUTE_PATHS）：先给每条线路一条，余下的按线路顺序
 * 轮着分（主线路先拿），线路自己组合不出更多就让给后面的。
 */
export function expandRouteLines(lines: RouteLine[], ctx: RouteExpandContext, limit = MAX_ROUTE_PATHS): RouteExpandResult {
  const issues = new Map<string, string>();
  const perLine = lines.map((line) => {
    const result = lineCombos(line, ctx, limit);
    if (result.issue) issues.set(line.key, result.issue);
    return result.combos;
  });
  const quota = lines.map(() => 0);
  let remaining = limit;
  // 第一轮：每条有组合的线路一条。
  perLine.forEach((combos, index) => {
    if (remaining > 0 && combos.length > 0) {
      quota[index] = 1;
      remaining -= 1;
    }
  });
  // 之后按顺序轮着加，直到用完或谁都加不了。
  let progressed = true;
  while (remaining > 0 && progressed) {
    progressed = false;
    for (let index = 0; index < lines.length && remaining > 0; index += 1) {
      if (quota[index] < perLine[index].length) {
        quota[index] += 1;
        remaining -= 1;
        progressed = true;
      }
    }
  }
  const paths: RoutePath[] = [];
  lines.forEach((line, lineIndex) => {
    perLine[lineIndex].slice(0, quota[lineIndex]).forEach((combo, comboIndex) => {
      const signature = `${combo.hops.join(".")}|${combo.via.map((value) => value ?? "").join(".")}|${combo.dest.dest ? `${combo.dest.dest.ip}:${combo.dest.dest.port}` : ""}|${combo.dest.destNodeId ?? ""}`;
      const key = comboIndex === 0 && perLine[lineIndex].length === 1 ? line.key : `${line.key.slice(0, 24)}-${hashKey(signature)}`;
      const hasVia = combo.via.some((value) => value !== null);
      paths.push({
        key,
        name: line.name || defaultRoutePathName(lineIndex),
        hops: combo.hops,
        ...(hasVia ? { hopVia: combo.via } : {}),
        dest: combo.dest.dest,
        destNodeId: combo.dest.destNodeId,
        weight: line.weight,
        // 线路上填的探测地址给它展开出来的每一条路径（以前这里写死 null，编辑框里填了也被丢掉）
        probe: line.probe ?? null,
        dial: null,
        issue: null,
        tier: lineIndex,
        ...(line.paused ? { paused: true } : {}),
        lineKey: line.key,
      });
    });
  });
  return { paths, issues };
}

/** 一条线路此刻展开出来几条路径（给编辑框显示「组合出 3 条」）。 */
export function countLinePaths(paths: RoutePath[], lineKey: string) {
  return paths.filter((path) => path.lineKey === lineKey).length;
}

// ---------------------------------------------------------------- 中继布局

/** 隧道从入口机出发时，入口机上那条中继规则的 routeHopIndex（真正的跳从 0 起，最多 MAX_ROUTE_HOPS）。 */
export const ROUTE_ENTRY_RELAY_INDEX = 99;

export type RouteRelayTarget = { kind: "landing" } | { kind: "relay"; node: number; loopback: boolean };

export type RouteRelaySlot = {
  /** 节点序号：0 = 入口机，k = hops[k-1]。 */
  node: number;
  /** 中继规则的 routeHopIndex：k-1；入口机上的是 ROUTE_ENTRY_RELAY_INDEX。 */
  hopIndex: number;
  /** 建在哪台机器上；null = 入口机（规则自己的主机）。 */
  hostId: number | null;
  /** 走哪条隧道；null = 普通 gost 中继。 */
  tunnelId: number | null;
  target: RouteRelayTarget;
};

export type RouteRelayPlan = {
  slots: RouteRelaySlot[];
  /** 调度器（入口）拨谁。 */
  dial: RouteRelayTarget;
};

/**
 * 一条路径要在哪些机器上建中继、每条转给谁。
 *
 * 节点 0..n：0 是入口机，k 是 hops[k-1]；进入节点 k 的那一段走 hopVia[k-1]（隧道）或普通中继。
 *   · 节点 k 上建中继 ⇔ 进它的那一段是普通中继（k ≥ 1），或者从它出发的下一段是隧道。
 *   · 下一段是隧道时，这条中继走那条隧道；隧道出口机直接拨「它后面的入口」，出口机自己不再建中继
 *     （除非从出口机再接一条隧道，这时出口拨本机那条中继：loopback）。
 *   · 拨号方在同一台机器上（入口调度器拨入口机上的中继、隧道出口拨本机中继）一律走 127.0.0.1：
 *     云厂商的 NAT 不让机器连自己的公网地址。
 * 没有隧道段的路径得到的就是以前的布局：hops[i] 上一条中继，转给下一跳或落地。
 */
export function routePathRelayPlan(path: Pick<RoutePath, "hops" | "hopVia">): RouteRelayPlan {
  const n = path.hops.length;
  const via = (k: number): number | null => (k >= 1 && k <= n ? path.hopVia?.[k - 1] ?? null : null);
  const hostsRelay = (k: number) => (k >= 1 && !via(k)) || (k < n && !!via(k + 1));
  /** 从节点 j 往后接着走：远端（上一台机器拨过来）时该拨的目标。 */
  const remoteIngress = (j: number): RouteRelayTarget => (j > n ? { kind: "landing" } : { kind: "relay", node: j, loopback: false });
  /** 隧道出口就在节点 j 上：它该拨谁。 */
  const afterTunnelExit = (j: number): RouteRelayTarget => (hostsRelay(j) ? { kind: "relay", node: j, loopback: true } : remoteIngress(j + 1));
  const slots: RouteRelaySlot[] = [];
  for (let k = 0; k <= n; k += 1) {
    if (!hostsRelay(k)) continue;
    const tunnelId = k < n ? via(k + 1) : null;
    slots.push({
      node: k,
      hopIndex: k === 0 ? ROUTE_ENTRY_RELAY_INDEX : k - 1,
      hostId: k === 0 ? null : path.hops[k - 1],
      tunnelId,
      target: tunnelId ? afterTunnelExit(k + 1) : remoteIngress(k + 1),
    });
  }
  const dial: RouteRelayTarget = hostsRelay(0) ? { kind: "relay", node: 0, loopback: true } : remoteIngress(1);
  return { slots, dial };
}

/** 中继规则探的「下一个」是谁：节点序号（n+1 = 落地）。 */
export function routeRelayTargetNode(target: RouteRelayTarget, hopCount: number) {
  return target.kind === "landing" ? hopCount + 1 : target.node;
}
