import { routePathDestination, routePathsOf } from "./routeGroup";

/**
 * 首页「概览」上的转发连线：哪台主机上的转发把流量送到了另一台主机。
 *
 * 隧道本来就画在图上（入口 → 中转 → 出口）；端口转发、转发链、线路组的中转都是规则，规则只写
 * 「目标地址」，图上要的是「目标是哪台主机」—— 拿目标地址去和每台主机的地址（IP / 入口 IP /
 * 开着的 DDNS 域名）对上。对不上的（落地是外面的机器）不画：它不是两台主机之间的线。
 *
 * 各种规则怎么算：
 *   普通规则       本机 → 目标那台主机。
 *   线路组 / 主备   每条路径：本机 → 中转 1 → … → 落地那台主机（中转存的就是主机 id）。中转上的中继
 *                  规则（routeParentRuleId）不再单算，不然同一段算两遍。
 *   转发链         面板拆出来的每一跳都是一条规则，各自指向下一跳；链的模板（isForwardGroupTemplate）
 *                  本身不跑流量，不算。
 *   隧道规则       走的是隧道，隧道那条线已经在图上了，不算。
 *
 * 同一对主机之间有几条规则就合成一条线，记条数和其中开着的条数。
 */
export type ForwardMapRule = {
  id: number;
  hostId: number;
  targetIp?: unknown;
  targetPort?: unknown;
  tunnelId?: unknown;
  isEnabled?: unknown;
  isForwardGroupTemplate?: unknown;
  routeParentRuleId?: unknown;
  failoverEnabled?: unknown;
  failoverTargets?: unknown;
  routePaths?: unknown;
};

export type ForwardMapHost = {
  id: number;
  ip?: unknown;
  ipv4?: unknown;
  ipv6?: unknown;
  entryIp?: unknown;
  tunnelEntryIp?: unknown;
  ddnsDomain?: unknown;
  /** DDNS 关掉之后域名可能还留着，那时它已经不是这台主机的地址了 */
  ddnsEnabled?: unknown;
};

export type ForwardMapLink = {
  fromHostId: number;
  toHostId: number;
  /** 这一段上有几条规则 */
  rules: number;
  /** 其中开着的几条；0 = 整段都停着 */
  enabled: number;
};

function addressToken(value: unknown) {
  return String(value ?? "")
    .trim()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.$/, "")
    .toLowerCase();
}

function truthy(value: unknown) {
  return value === true || value === 1 || value === "1" || value === "true";
}

/** 地址 → 主机 id；两台主机报了同一个地址（同一个 NAT 入口）时说不清是谁，这个地址不认 */
export function buildHostAddressIndex(hosts: readonly ForwardMapHost[]): Map<string, number> {
  const index = new Map<string, number>();
  const ambiguous = new Set<string>();
  for (const host of hosts) {
    const id = Number(host.id);
    if (!Number.isFinite(id) || id <= 0) continue;
    const ddnsDomain = truthy(host.ddnsEnabled) ? host.ddnsDomain : null;
    for (const raw of [host.ip, host.ipv4, host.ipv6, host.entryIp, host.tunnelEntryIp, ddnsDomain]) {
      const token = addressToken(raw);
      if (!token) continue;
      const seen = index.get(token);
      if (seen !== undefined && seen !== id) ambiguous.add(token);
      else index.set(token, id);
    }
  }
  for (const token of ambiguous) index.delete(token);
  return index;
}

export function buildForwardMapLinks(
  rules: readonly ForwardMapRule[],
  hosts: readonly ForwardMapHost[],
  options: { visibleHostIds?: ReadonlySet<number> } = {},
): ForwardMapLink[] {
  const index = buildHostAddressIndex(hosts);
  const hostIds = new Set(hosts.map((host) => Number(host.id)));
  const visible = options.visibleHostIds;
  const pairs = new Map<string, { link: ForwardMapLink; ruleIds: Set<number>; enabledIds: Set<number> }>();
  const add = (ruleId: number, from: number, to: number | undefined, enabled: boolean) => {
    if (!to || from === to || !hostIds.has(from) || !hostIds.has(to)) return;
    if (visible && (!visible.has(from) || !visible.has(to))) return;
    const key = `${from}>${to}`;
    let entry = pairs.get(key);
    if (!entry) {
      entry = { link: { fromHostId: from, toHostId: to, rules: 0, enabled: 0 }, ruleIds: new Set(), enabledIds: new Set() };
      pairs.set(key, entry);
    }
    entry.ruleIds.add(ruleId);
    if (enabled) entry.enabledIds.add(ruleId);
  };
  for (const rule of rules) {
    if (truthy(rule.isForwardGroupTemplate)) continue;
    if (Number(rule.routeParentRuleId || 0) > 0) continue;
    if (Number(rule.tunnelId || 0) > 0) continue;
    const from = Number(rule.hostId);
    const ruleId = Number(rule.id);
    const enabled = rule.isEnabled === undefined || rule.isEnabled === null ? true : truthy(rule.isEnabled);
    const hasRoutes = truthy(rule.failoverEnabled) || addressToken(rule.routePaths).length > 2;
    if (!hasRoutes) {
      add(ruleId, from, index.get(addressToken(rule.targetIp)), enabled);
      continue;
    }
    for (const path of routePathsOf(rule)) {
      let at = from;
      for (const hop of path.hops) {
        const hopId = Number(hop);
        add(ruleId, at, hopId, enabled);
        at = hopId;
      }
      add(ruleId, at, index.get(addressToken(routePathDestination(path, rule).ip)), enabled);
    }
  }
  return Array.from(pairs.values())
    .map(({ link, ruleIds, enabledIds }) => ({ ...link, rules: ruleIds.size, enabled: enabledIds.size }))
    .sort((a, b) => a.fromHostId - b.fromHostId || a.toHostId - b.toHostId);
}
