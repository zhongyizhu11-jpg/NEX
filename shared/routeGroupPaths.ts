/*
  线路组的路径：存储格式的解析和序列化、名字和标签、从老的 failover* 列推出来的路径、
  一条路径该拨哪个地址、对端是谁、最后从哪个 IP 出去。shared/routeGroup.ts 统一再导出。
*/
import {
  formatFailoverEndpoint,
  parseFailoverEndpoint,
  parseFailoverTargets,
  type FailoverTarget,
} from "./failoverTargets";
import { normalizeForwardRuleProtocol } from "./forwardTypes";
import {
  MAX_ROUTE_HOPS,
  MAX_ROUTE_PATHS,
  normalizeRouteDestSpread,
  ROUTE_GUARD_LIMITS,
  type RouteEndpoint,
  type RouteGroupRule,
  type RoutePath,
} from "./routeGroupModel";
import { clampInt } from "./routeGroupUtil";

/** 落地是哪一个（同一个落地经不同中转的几条路径算一个）：落地池按成员机，节点按节点，别的按地址，没写 = 规则目标。 */
export function routePathLandingKey(path: Pick<RoutePath, "dest" | "destNodeId"> & { destHostId?: number | null }): string {
  if (path.destNodeId && path.destHostId) return `n${path.destNodeId}h${path.destHostId}`;
  if (path.destNodeId) return `n${path.destNodeId}`;
  if (path.dest) return `${path.dest.ip}:${path.dest.port}`;
  return "target";
}

function sanitizeEndpoint(raw: unknown): RouteEndpoint | null {
  if (!raw || typeof raw !== "object") return null;
  const ip = String((raw as any).ip ?? (raw as any).host ?? "").trim();
  const port = Math.floor(Number((raw as any).port));
  if (!ip || !(port >= 1 && port <= 65535)) return null;
  return { ip, port };
}

/** 一段稳定的路径标识。字母开头、够短、够随机，切换历史里看着不刺眼。 */
export function newRoutePathKey(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let key = alphabet[Math.floor(Math.random() * 26)];
  for (let index = 0; index < 5; index += 1) key += alphabet[Math.floor(Math.random() * alphabet.length)];
  return key;
}

const PATH_KEY_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

function sanitizePath(raw: any, index: number): RoutePath | null {
  if (!raw || typeof raw !== "object") return null;
  const key = String(raw.key ?? "").trim().toLowerCase();
  const hops = Array.isArray(raw.hops)
    ? Array.from(new Set(raw.hops.map((hop: unknown) => Math.floor(Number(hop))).filter((hop: number) => Number.isInteger(hop) && hop > 0)))
      .slice(0, MAX_ROUTE_HOPS) as number[]
    : [];
  const hopVia = Array.isArray(raw.hopVia) && raw.hopVia.length === hops.length
    ? raw.hopVia.map((value: unknown) => (Number.isInteger(Number(value)) && Number(value) > 0 ? Math.floor(Number(value)) : null))
    : undefined;
  const tier = raw.tier === null || raw.tier === undefined || raw.tier === "" ? undefined : clampInt(raw.tier, 0, MAX_ROUTE_PATHS, 0);
  const lineKey = typeof raw.lineKey === "string" && PATH_KEY_PATTERN.test(raw.lineKey.trim().toLowerCase()) ? raw.lineKey.trim().toLowerCase() : undefined;
  const destSpread = normalizeRouteDestSpread(raw.destSpread);
  return {
    key: PATH_KEY_PATTERN.test(key) ? key : `p${index + 1}`,
    name: String(raw.name ?? "").trim().slice(0, 40),
    hops,
    ...(hopVia && hopVia.some((value: number | null) => value !== null) ? { hopVia } : {}),
    ...(tier !== undefined ? { tier } : {}),
    ...(raw.paused === true || raw.paused === 1 || raw.paused === "1" ? { paused: true } : {}),
    ...(lineKey ? { lineKey } : {}),
    ...(destSpread !== "one" ? { destSpread } : {}),
    dest: sanitizeEndpoint(raw.dest),
    destNodeId: Number.isInteger(Number(raw.destNodeId)) && Number(raw.destNodeId) > 0 ? Math.floor(Number(raw.destNodeId)) : null,
    ...(Number.isInteger(Number(raw.destHostId)) && Number(raw.destHostId) > 0 && Number(raw.destNodeId) > 0 ? { destHostId: Math.floor(Number(raw.destHostId)) } : {}),
    weight: clampInt(raw.weight, ROUTE_GUARD_LIMITS.weight.min, ROUTE_GUARD_LIMITS.weight.max, 50),
    probe: sanitizeEndpoint(raw.probe),
    dial: sanitizeEndpoint(raw.dial),
    issue: String(raw.issue ?? "").trim().slice(0, 200) || null,
  };
}

/** routePaths 那一列（JSON 或已解析的数组）→ 路径清单。认不出的一律扔掉，不猜。 */
export function parseRoutePaths(raw: unknown): RoutePath[] {
  if (!raw) return [];
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return [];
    const paths = parsed.map(sanitizePath).filter((path): path is RoutePath => !!path).slice(0, MAX_ROUTE_PATHS);
    // key 撞了后面的那条改名：两条同名路径会让切换历史指向不清。
    const seen = new Set<string>();
    return paths.map((path, index) => {
      let key = path.key;
      while (seen.has(key)) key = `${path.key}-${index + 1}`;
      seen.add(key);
      return key === path.key ? path : { ...path, key };
    });
  } catch {
    return [];
  }
}

export function serializeRoutePaths(paths: RoutePath[] | null | undefined): string | null {
  if (!paths || paths.length === 0) return null;
  return JSON.stringify(paths.map((path) => ({
    key: path.key,
    name: path.name,
    hops: path.hops,
    dest: path.dest,
    ...(path.destNodeId ? { destNodeId: path.destNodeId } : {}),
    ...(path.destNodeId && path.destHostId ? { destHostId: path.destHostId } : {}),
    weight: path.weight,
    probe: path.probe,
    dial: path.dial,
    ...(path.issue ? { issue: path.issue } : {}),
    ...(path.hopVia && path.hopVia.some((value) => value !== null) ? { hopVia: path.hopVia } : {}),
    ...(typeof path.tier === "number" ? { tier: path.tier } : {}),
    ...(path.paused ? { paused: true } : {}),
    ...(path.lineKey ? { lineKey: path.lineKey } : {}),
    ...(path.destSpread ? { destSpread: path.destSpread } : {}),
  })));
}

/** 「主线路」「备用 1」：没起名时的默认叫法，和老主备一致。 */
export function defaultRoutePathName(index: number): string {
  return index === 0 ? "主线路" : `备用 ${index}`;
}

/**
 * 「主线路」「备用」「备用 2」「备用线路」这种是默认名字，不是人起的：线路拖了位置、删了前面一条，它就对不上了
 * （主线路叫着「备用」）。这种按线路现在的位置叫；人起的名字（「晚高峰」）照旧。
 */
const DEFAULT_LINE_NAME = /^(主线路|主线|主|备用线路|备用|备线|备|备用线路\s*\d+|备用\s*\d+|备\s*\d+)$/;

export function isDefaultRouteLineName(name: unknown): boolean {
  return DEFAULT_LINE_NAME.test(String(name ?? "").trim());
}

/** 线路叫什么：没起名或者是默认名，按第几条线路叫（主线路 / 备用 N）。 */
export function routeLineName(name: unknown, lineIndex: number): string {
  const text = String(name ?? "").trim();
  return !text || isDefaultRouteLineName(text) ? defaultRoutePathName(lineIndex) : text;
}

/** 路径叫什么：线路展开的路径按它那条线路的位置（tier）叫，老的路径按自己的位置。 */
export function routePathLabel(path: (Pick<RoutePath, "name"> & { tier?: number | null }) | null | undefined, index: number): string {
  const tier = path && typeof path.tier === "number" ? path.tier : index;
  return routeLineName(path?.name, tier);
}

/**
 * 两条路径算不算「同一条路」：同样的中转、同样的隧道段、同一个落地（落地池按成员机，节点按节点，别的按地址；
 * 没写落地 = 规则目标）。线路展开去重和保存时的重复检查都用它。
 */
export function routePathRoadKey(path: Pick<RoutePath, "hops" | "hopVia" | "dest" | "destNodeId"> & { destHostId?: number | null }): string {
  const dest = path.destNodeId
    ? `n${path.destNodeId}${path.destHostId ? `h${path.destHostId}` : ""}`
    : path.dest ? `${path.dest.ip}:${path.dest.port}` : "";
  return `${path.hops.join(".")}|${(path.hopVia || []).map((value) => value ?? "").join(".")}|${dest}`;
}

/** 路径的字母序号：A、B、C…… 卡片和切换历史里用它当短称。 */
export function routePathLetter(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : `#${index + 1}`;
}

function endpointOfFailoverTarget(target: FailoverTarget): RouteEndpoint {
  return { ip: target.targetIp, port: target.targetPort };
}

function probeOfFailoverTarget(target: FailoverTarget): RouteEndpoint | null {
  return target.probeIp && target.probePort ? { ip: target.probeIp, port: target.probePort } : null;
}

/**
 * 老主备 → 路径清单：主线路是规则自己的目标，备用各是一个直连的落地。
 *
 * 只在 routePaths 还是空的时候用（2.3.376 之前配的主备）。保存一次之后 routePaths 就有了，
 * 之后以它为准 —— 它才存得下中转。
 */
export function legacyRoutePaths(rule: RouteGroupRule): RoutePath[] {
  const mainProbe = parseFailoverEndpoint(rule.failoverProbeTarget);
  const main: RoutePath = {
    key: "main",
    name: "",
    hops: [],
    dest: null,
    destNodeId: null,
    weight: 50,
    probe: mainProbe && !("error" in mainProbe) ? { ip: mainProbe.host, port: mainProbe.port } : null,
    dial: null,
    issue: null,
  };
  const backups = parseFailoverTargets(rule.failoverTargets).map((target, index): RoutePath => ({
    key: `backup-${index + 1}`,
    name: "",
    hops: [],
    destNodeId: null,
    dest: endpointOfFailoverTarget(target),
    weight: 50,
    probe: probeOfFailoverTarget(target),
    dial: null,
    issue: null,
  }));
  return [main, ...backups];
}

/** 这条规则的路径清单：有 routePaths 就用它，没有就从老主备推。 */
export function routePathsOf(rule: RouteGroupRule): RoutePath[] {
  const stored = parseRoutePaths(rule.routePaths);
  return stored.length > 0 ? stored : legacyRoutePaths(rule);
}

/** 这条路径的落地：没写就是规则自己的目标。 */
export function routePathDestination(path: RoutePath, rule: Pick<RouteGroupRule, "targetIp" | "targetPort">): RouteEndpoint {
  if (path.dest) return path.dest;
  return { ip: String(rule.targetIp || "").trim(), port: Math.floor(Number(rule.targetPort) || 0) };
}

/**
 * 入口 Agent 拨的地址。
 *
 * 有中转而还没解析出 dial 的路径拨不了 —— 返回 null，调用方该把它当成不可用，而不是
 * 退回直连落地：那会绕过中转，和用户配的路径不是一回事。
 */
export function routePathDial(path: RoutePath, rule: Pick<RouteGroupRule, "targetIp" | "targetPort">): RouteEndpoint | null {
  if (path.dial) return path.dial;
  if (path.hops.length > 0) return null;
  const dest = routePathDestination(path, rule);
  return dest.ip && dest.port > 0 ? dest : null;
}

/**
 * 这条路径的对端是哪台 NEX 管的主机：有中转就是第一跳（入口拨的是它上面的中继规则）；没中转而落地是
 * 落地池成员时是那台成员机（拨的是它上面的成员入站）；手填的落地地址不知道是不是自己的机器 → null。
 * UDP 回声探测（routeUdpEchoProbeReady）只发给它。
 */
export function routePathFarEndHostId(path: Pick<RoutePath, "hops" | "destHostId">): number | null {
  if (path.hops.length > 0) return Number(path.hops[0]) > 0 ? Number(path.hops[0]) : null;
  const member = Number(path.destHostId || 0);
  return member > 0 ? member : null;
}

/**
 * 这条目标下发时带不带 probeUdpEcho（agent/udp_probe.go）：规则要带 UDP（udp / both）、没填探测地址（填了照填的
 * 拨 TCP）、对端是 NEX 管的主机 —— 手填的落地不知道是不是自己的机器，探测报会被当普通包转给落地，所以不带，
 * 探测照旧（零长度包探端口不可达，说不准按原来的判法）。
 *
 * 只有落在 Agent 自己的 UDP 监听（协议守护）上的探测报才有回声；对端那个端口是 gost 在听（中转机上的中继规则）
 * 时探测报会被转出去、收不到回声，结论退回零长度包那一档，不会误判。
 */
export function routeUdpEchoProbeReady(options: {
  protocol: unknown;
  path: Pick<RoutePath, "hops" | "destHostId" | "probe">;
}): boolean {
  if (normalizeForwardRuleProtocol(options.protocol) === "tcp") return false;
  if (options.path.probe) return false;
  return routePathFarEndHostId(options.path) !== null;
}

/**
 * 这条路径最后从哪个 IP 出去（下发给 Agent 的 exitIp：当前这条挂了要换时，Agent 在同样够格的候选里优先挑出口 IP
 * 一样的，见 agent/failover_exit_ip.go）。
 *
 * 落地是 NEX 主机（落地池成员，destHostId）时是那台机器的出口地址 —— hostEgressIp 给：面板看到的心跳来源，
 * 没有就是登记的 IPv4 / IPv6；那台一个地址都没有时退回落地的拨号地址。落地是手填地址、节点地址、或者规则
 * 自己的目标时，就是那个地址本身：对端看到的就是它。算不出来返回空串，Agent 当成没有。
 */
export function routePathExitIp(
  path: Pick<RoutePath, "dest" | "destHostId">,
  rule: Pick<RouteGroupRule, "targetIp" | "targetPort">,
  hostEgressIp: (hostId: number) => string | null | undefined,
): string {
  const destHostId = Number(path.destHostId || 0);
  if (destHostId > 0) {
    const egress = String(hostEgressIp(destHostId) || "").trim();
    if (egress) return egress;
  }
  return String(path.dest ? path.dest.ip : rule.targetIp || "").trim();
}

/** 一条新的路径：还没有中转、落地同规则目标、权重和别的路径一样。 */
export function newRoutePath(index: number, patch: Partial<RoutePath> = {}): RoutePath {
  return { key: newRoutePathKey(), name: defaultRoutePathName(index), hops: [], dest: null, destNodeId: null, weight: 50, probe: null, dial: null, issue: null, ...patch };
}

/** 「HK01 → JP01 → US01:443」：路径怎么走的一句话，给列表、事件、Telegram 用。 */
export function describeRoutePath(
  path: RoutePath,
  rule: Pick<RouteGroupRule, "targetIp" | "targetPort">,
  hostName: (hostId: number) => string,
): string {
  const dest = routePathDestination(path, rule);
  const stops = path.hops.map((hop) => hostName(hop));
  stops.push(dest.ip ? formatFailoverEndpoint(dest.ip, dest.port) : "落地");
  return stops.join(" → ");
}

/** 权重按比例换算成百分比，给界面和 Telegram 写「A 70% / B 30%」。 */
export function routeWeightShares(paths: Pick<RoutePath, "weight">[]): number[] {
  const total = paths.reduce((sum, path) => sum + Math.max(0, path.weight), 0);
  if (total <= 0) return paths.map(() => Math.round(100 / Math.max(1, paths.length)));
  return paths.map((path) => Math.round((Math.max(0, path.weight) / total) * 100));
}
