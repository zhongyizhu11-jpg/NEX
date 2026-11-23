import { isIP } from "node:net";
import { parseFailoverTargets } from "../shared/failoverTargets";
import { classifyIpAddress, expandIpv6, type IpAddressClass } from "../shared/ipAddress";
import { parseRoutePaths, routePathDestination } from "../shared/routeGroup";
import { appendPanelLog } from "./_core/panelLogger";
import * as db from "./db";
import { dbBool } from "./repositories/repositoryUtils";

/*
  转发目标能不能是内网 / 环回 / 链路本地 / 保留 / 组播地址。

  拨目标的是出口那台机器（直连规则是规则所在的机器，隧道规则是隧道出口，转发组是各成员）。
  租户在管理员的出口机上把目标写成 127.0.0.1:3306 或 169.254.169.254:80，等于借管理员的
  机器去连它自己的数据库、云厂商的元数据接口 —— 转发一建好，这些东西就暴露在公网入口上了。

  但租户把流量转到自己机器上的本地服务是正经用法（127.0.0.1:8080、局域网里的 NAS），
  所以只有「每一台会去拨这个目标的机器都是他自己的」时才放行。管理员不受限。
*/

const TARGET_CLASS_LABELS: Record<string, string> = {
  loopback: "环回地址",
  private: "内网地址",
  linkLocal: "链路本地地址",
  multicast: "组播地址",
  reserved: "保留或未指定地址",
};

function normalizeTargetToken(value: unknown) {
  return String(value ?? "")
    .trim()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.$/, "")
    .toLowerCase();
}

/**
 * inet_aton 认的 IPv4 写法：`127.1`、`0x7f.1`、`2130706433`、`0177.0.0.1`。
 *
 * 这些写法过得了目标地址的格式校验（它们长得像域名），而 Agent 上的 gost / realm / iptables
 * 交给 getaddrinfo 时会被当成 127.0.0.1 —— 只按点分四段去判，换个写法就绕过去了。
 * 认不出来返回 null（当域名处理）。
 */
export function inetAtonIpv4(value: string): string | null {
  const text = normalizeTargetToken(value);
  if (!text || !/^[0-9][0-9a-fx.]*$/.test(text)) return null;
  const parts = text.split(".");
  if (parts.length > 4 || parts.some((part) => !part)) return null;
  const numbers: number[] = [];
  for (const part of parts) {
    let parsed: number;
    if (/^0x[0-9a-f]+$/.test(part)) parsed = Number.parseInt(part.slice(2), 16);
    else if (/^0[0-7]*$/.test(part)) parsed = Number.parseInt(part, 8);
    else if (/^[1-9][0-9]*$/.test(part)) parsed = Number(part);
    else return null;
    if (!Number.isSafeInteger(parsed)) return null;
    numbers.push(parsed);
  }
  const last = numbers.pop()!;
  if (numbers.some((part) => part > 255)) return null;
  const tailBytes = 4 - numbers.length;
  if (last >= 2 ** (8 * tailBytes)) return null;
  let value32 = last;
  numbers.forEach((part, index) => {
    value32 += part * 2 ** (8 * (3 - index));
  });
  return [24, 16, 8, 0].map((shift) => Math.floor(value32 / 2 ** shift) % 256).join(".");
}

/**
 * shared/ipAddress 为了「只收紧不放松」把几段文档用地址划得比 RFC 宽（192.0/16、192.2/16、
 * 192.88/16、198.51/16、203.0/16）。那对 SSRF 守卫没问题，对转发目标就不行了：203.0.x.x 里有
 * 大把正在用的公网地址，按宽的算会把正常的转发拦下来。
 *
 * 文档专用段（TEST-NET 192.0.2/24、198.51.100/24、203.0.113/24、2001:db8::/32）和 6to4 中继
 * 192.88.99/24 也不拦：它们要么根本路由不到哪里，要么就是公网上的中继，都碰不到出口机的
 * 本机和内网。真正要拦的「保留」是 0/8（连的是本机）、240/4、::、fec0::/10 这些。
 */
function isHarmlessReservedAddress(address: string) {
  if (isIP(address) === 6) {
    const groups = expandIpv6(address);
    return !!groups && groups[0] === 0x2001 && groups[1] === 0x0db8;
  }
  const octets = address.split(".").map(Number);
  if (octets.length !== 4) return false;
  const [a, b, c] = octets;
  if (a === 192 && b === 0) return c !== 0;
  if (a === 192 && (b === 2 || b === 88)) return true;
  if (a === 198 && b === 51) return true;
  if (a === 203 && b === 0) return true;
  return false;
}

/** IPv4-mapped IPv6（::ffff:a.b.c.d）拆成里面那个 IPv4；别的原样返回。 */
function unwrapMappedIpv4(address: string) {
  if (!address.includes(":")) return address;
  const groups = expandIpv6(address);
  if (!groups || !groups.slice(0, 5).every((group) => group === 0) || groups[5] !== 0xffff) return address;
  return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join(".");
}

/**
 * 目标是不是一个受限地址。是就返回类别（loopback / private / ...），公网地址和域名返回 null。
 * `localhost` 这类名字直接算环回：它们不走 DNS，面板解析不到也拦不住。
 */
export function restrictedForwardTargetClass(value: unknown): Exclude<IpAddressClass, "public" | "invalid"> | null {
  const text = normalizeTargetToken(value);
  if (!text) return null;
  if (text === "localhost" || text.endsWith(".localhost") || text === "ip6-localhost" || text === "ip6-loopback") {
    return "loopback";
  }
  let address: string | null = null;
  if (isIP(text) === 4) address = text;
  else if (text.includes(":")) address = isIP(text.split("%")[0]) === 6 ? text : null;
  else address = inetAtonIpv4(text);
  if (!address) return null;
  address = unwrapMappedIpv4(address);
  const kind = classifyIpAddress(address);
  if (kind === "public" || kind === "invalid") return null;
  if (kind === "reserved" && isHarmlessReservedAddress(address)) return null;
  return kind;
}

export function restrictedForwardTargetLabel(kind: string) {
  return TARGET_CLASS_LABELS[kind] || "受限地址";
}

/**
 * 一条规则（或者一份即将落库的规则数据）会去拨的所有目标地址：主目标、老式主备的备用线路、
 * 线路组每条路径的落地。线路组存在时 failoverTargets 里放的是入口 Agent 的拨号地址（中转机
 * 的入口），那是面板自己算的，不是用户填的目标，所以改看路径。
 */
export function ruleTargetAddresses(rule: any): string[] {
  const targets = [String(rule?.targetIp || "").trim()];
  const paths = parseRoutePaths(rule?.routePaths);
  if (paths.length > 0) {
    for (const path of paths) targets.push(routePathDestination(path, rule).ip);
  } else if (dbBool(rule?.failoverEnabled)) {
    for (const target of parseFailoverTargets(rule?.failoverTargets)) targets.push(String(target.targetIp || "").trim());
  }
  return Array.from(new Set(targets.filter(Boolean)));
}

async function tunnelExitHostIds(tunnel: any): Promise<number[]> {
  const tunnelId = Number(tunnel?.id || 0);
  const ids = [Number(tunnel?.exitHostId || 0)];
  if (tunnelId > 0) {
    for (const node of await db.getTunnelExitNodes(tunnelId) as any[]) ids.push(Number(node?.hostId || 0));
  }
  return ids;
}

/**
 * 会去拨目标的机器。宁可多算：多算一台只会让「全是自己的机器」这条放行条件更难满足，
 * 少算一台就是漏拦。
 *
 * - 直连规则：规则所在的机器
 * - 隧道规则：隧道出口，加上所有额外出口
 * - 转发组模板：组里每个成员（主机成员本身；隧道成员的出口）
 * - 线路组的中转：每一跳的中转机（最后一跳拨落地）
 */
async function ruleTargetDialHostIds(route: {
  hostId?: number | null;
  tunnel?: any | null;
  forwardGroupId?: number | null;
  routePaths?: unknown;
}): Promise<number[]> {
  const ids: number[] = [];
  const groupId = Number(route.forwardGroupId || 0);
  if (groupId > 0) {
    const group = await db.getForwardGroupById(groupId) as any;
    for (const member of (Array.isArray(group?.members) ? group.members : []) as any[]) {
      if (member?.memberType === "tunnel") {
        const tunnel = await db.getTunnelById(Number(member.tunnelId || 0));
        if (tunnel) ids.push(...await tunnelExitHostIds(tunnel));
      } else {
        ids.push(Number(member?.hostId || 0));
      }
    }
    // 组里一个成员都没有时没有谁会拨它；但也没有「都是自己的机器」可言，按不放行处理。
    if (ids.length === 0) ids.push(0);
  } else if (route.tunnel) {
    ids.push(...await tunnelExitHostIds(route.tunnel));
  } else {
    ids.push(Number(route.hostId || 0));
  }
  for (const path of parseRoutePaths(route.routePaths)) ids.push(...path.hops.map(Number));
  return Array.from(new Set(ids));
}

/**
 * 非管理员保存规则前：目标是受限地址时，每一台会拨它的机器都得是他自己的。
 */
export async function assertRuleTargetsAllowedForActor(
  actor: { id: number; role: string },
  rule: any,
  route: { hostId?: number | null; tunnel?: any | null; forwardGroupId?: number | null },
) {
  if (actor.role === "admin") return;
  const restricted = ruleTargetAddresses(rule)
    .map((address) => ({ address, kind: restrictedForwardTargetClass(address) }))
    .filter((item) => item.kind);
  if (restricted.length === 0) return;
  const hostIds = await ruleTargetDialHostIds({ ...route, routePaths: rule?.routePaths });
  const validIds = hostIds.filter((id) => id > 0);
  const hosts = validIds.length === hostIds.length ? await db.getHostsByIds(validIds) as any[] : [];
  const allOwned = hosts.length === hostIds.length
    && hosts.every((host) => Number(host?.userId) === Number(actor.id));
  if (allOwned) return;
  const first = restricted[0];
  throw new Error(
    `转发目标 ${first.address} 是${restrictedForwardTargetLabel(String(first.kind))}，`
      + "只有负责连接目标的出口主机全部是您自己的主机时才能使用，请改成公网地址",
  );
}

/**
 * 下发时的那一道：目标写的是域名，面板替 Agent 解析出来的却是内网 / 环回地址。
 *
 * 保存时只能看字面量，域名要到解析时才知道指向哪里（把 a.example.com 解析到 127.0.0.1 很容易）。
 * 所以非管理员的规则、在不是他自己的出口机上拨目标时，解析结果是受限地址就不下发这条规则
 * （当成停用，按正常的移除路径清掉监听），并记一条日志。
 *
 * 只管「这台机器就是拨目标的那台」：直连规则是规则所在的机器，隧道规则是隧道出口（含额外出口）。
 * 转发链中间的成员、线路组中间的中转拨的是下一台机器的入口地址（常常就是内网地址），不在这里拦。
 * 字面量的受限地址保存时已经查过，这里不重复处理。
 */
const resolvedTargetLoggedAt = new Map<number, number>();

export function createResolvedTargetGate(host: { id: unknown; userId?: unknown }) {
  const hostId = Number(host?.id || 0);
  const hostOwnerId = Number(host?.userId || 0);
  const roles = new Map<number, Promise<string>>();
  const exitHosts = new Map<number, Promise<number[]>>();
  const chainGroups = new Map<number, Promise<boolean>>();
  const logged = new Set<number>();
  const ownerRole = (userId: number) => {
    if (!roles.has(userId)) {
      roles.set(userId, db.getUserById(userId).then((user: any) => String(user?.role || "user")).catch(() => "user"));
    }
    return roles.get(userId)!;
  };
  const tunnelExits = (tunnelId: number) => {
    if (!exitHosts.has(tunnelId)) {
      exitHosts.set(tunnelId, db.getTunnelById(tunnelId)
        .then((tunnel) => (tunnel ? tunnelExitHostIds(tunnel) : []))
        .catch(() => [] as number[]));
    }
    return exitHosts.get(tunnelId)!;
  };
  const isChainGroup = (groupId: number) => {
    if (!chainGroups.has(groupId)) {
      chainGroups.set(groupId, db.getForwardGroupById(groupId)
        .then((group: any) => String(group?.groupMode || "") === "chain")
        .catch(() => false));
    }
    return chainGroups.get(groupId)!;
  };
  const isIntermediateRelay = async (rule: any) => {
    const parentId = Number(rule?.routeParentRuleId || 0);
    if (parentId <= 0) return false;
    const parent = await db.getForwardRuleById(parentId).catch(() => null) as any;
    const path = parseRoutePaths(parent?.routePaths).find((item) => item.key === String(rule?.routePathKey || ""));
    if (!path) return false;
    return Number(rule?.routeHopIndex || 0) < path.hops.length - 1;
  };

  return async function shouldBlockResolvedTarget(rule: any, rawTarget: unknown, resolved: unknown): Promise<boolean> {
    if (restrictedForwardTargetClass(rawTarget)) return false;
    const kind = restrictedForwardTargetClass(resolved);
    if (!kind) return false;
    const ownerId = Number(rule?.userId || 0);
    if (ownerId <= 0 || ownerId === hostOwnerId) return false;
    const tunnelId = Number(rule?.tunnelId || 0);
    if (tunnelId > 0) {
      if (!(await tunnelExits(tunnelId)).includes(hostId)) return false;
    } else if (Number(rule?.hostId || 0) !== hostId) {
      return false;
    }
    const groupId = Number(rule?.forwardGroupId || 0);
    if (groupId > 0 && await isChainGroup(groupId)) return false;
    if (await isIntermediateRelay(rule)) return false;
    if ((await ownerRole(ownerId)) === "admin") return false;
    const ruleId = Number(rule?.id || 0);
    const now = Date.now();
    // 心跳半分钟一次，每次都记会刷屏：同一条规则十分钟记一次。
    if (!logged.has(ruleId) && now - (resolvedTargetLoggedAt.get(ruleId) || 0) >= 10 * 60_000) {
      logged.add(ruleId);
      if (resolvedTargetLoggedAt.size >= 5_000) resolvedTargetLoggedAt.clear();
      resolvedTargetLoggedAt.set(ruleId, now);
      appendPanelLog(
        "warn",
        `[RuleTarget] rule=${ruleId} user=${ownerId} host=${hostId} target=${String(rawTarget || "")} resolved=${String(resolved || "")} (${kind}) 不下发：非管理员规则在别人的出口机上解析到了受限地址`,
      );
    }
    return true;
  };
}
