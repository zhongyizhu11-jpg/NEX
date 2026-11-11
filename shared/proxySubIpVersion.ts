/**
 * 订阅地址按 IPv4 / IPv6 输出（`?ipVersion=4` / `?ipVersion=6`）。
 *
 * 不带这个参数时一切照旧：节点地址按「规则专属域名 → 入口域名 → DDNS → 入口 IP → IPv4 → IPv6」
 * 的优先级取（见 shared/hostEntryAddress.ts），域名优先是因为机器换 IP 后域名还能用。
 *
 * 带上以后是用户明确说了「我这台设备只走 v6（或只走 v4）」：家宽只有 v6、手机流量 v4 很烂、
 * 想绕开某段 v4 线路……这时给他一个域名等于让客户端自己挑，十有八九挑到另一种。所以：
 *
 *   - 每条节点用入口机器**真实的**那一种地址（字面量），不用域名；
 *   - 某条节点没有这种地址就跳过，**绝不**悄悄退回另一种 —— 退回去用户会以为在走 v6，
 *     实际全在 v4 上，出了问题根本想不到这一层；
 *   - 跳过的照 NEX 一贯的做法记进 plan.skipped（预览里能看到原因），响应头
 *     `X-ForwardX-Skipped-Entries` 给出条数；一条都不剩时路由回 422 加一句话，
 *     而不是一份空订阅（空订阅导进客户端就是「订阅更新成功，节点全没了」）。
 *
 * 地址从哪来（plan 构建时算好挂在条目上，见 shared/proxySubscriptionPlan.ts）：
 *   中转：转发此刻的入口机器（转发组 / 入口组 / 隧道已在 applyEffectiveEntryHosts 换成真正的入口）
 *         → 手填入口是这种字面量就用它，否则用面板记下的 IPv4 / IPv6（DDNS 发 AAAA 时用的也是
 *         这个 IPv6，见 server/hostDdns.ts 的 hostDdnsTargetValue）；
 *   直连：节点自己的地址就是这种字面量就用它，否则看节点所在机器，落地池看池成员
 *         （服务端按需查好填在模板行的 entryIpv4 / entryIpv6 上）。
 */

import { getEntryAddressFamily, getHostEntryAddresses, hostAutoIpv4, hostAutoIpv6, type HostEntryAddressSource } from "./hostEntryAddress";
import type { ProxySubscriptionEntry, ProxySubscriptionPlan, ProxySubscriptionSkip } from "./proxySubscriptionPlan";

export const PROXY_SUB_IP_VERSIONS = ["4", "6"] as const;
export type ProxySubIpVersion = (typeof PROXY_SUB_IP_VERSIONS)[number];

export const PROXY_SUB_IP_VERSION_LABELS: Record<ProxySubIpVersion, string> = {
  "4": "只要 IPv4",
  "6": "只要 IPv6",
};

/** 跳过原因（和 plan.skipped 里别的原因同一张表，见 PROXY_SUBSCRIPTION_SKIP_LABELS）。 */
export const PROXY_SUB_IP_VERSION_SKIP_REASON = {
  "4": "no-ipv4-address",
  "6": "no-ipv6-address",
} as const;

export type ProxySubIpVersionParse = { ok: true; version: ProxySubIpVersion | null } | { ok: false; error: string };

/**
 * 解析地址上的 ipVersion。空 = 照旧；认得 4 / 6 / v4 / v6 / ipv4 / ipv6；别的报错 ——
 * 手误写成 ipVersion=64 时回 400 比悄悄按默认给一份更好：后者正是这个功能要避免的「以为在走 v6」。
 */
export function parseProxySubIpVersion(value: unknown): ProxySubIpVersionParse {
  const raw = String(Array.isArray(value) ? value[0] ?? "" : value ?? "").trim().toLowerCase();
  if (!raw) return { ok: true, version: null };
  const stripped = raw.replace(/^ip/, "").replace(/^v/, "");
  if (stripped === "4" || stripped === "6") return { ok: true, version: stripped };
  return { ok: false, error: "ipVersion 只能是 4 或 6" };
}

/** 这个值是不是这一种地址的字面量；是就返回去掉方括号的样子，不是返回空串。 */
export function addressLiteralOfFamily(value: unknown, family: "ipv4" | "ipv6"): string {
  let text = String(value ?? "").trim();
  if (text.startsWith("[") && text.includes("]")) text = text.slice(1, text.indexOf("]")).trim();
  if (!text) return "";
  return getEntryAddressFamily(text) === family ? text : "";
}

export type ProxySubEntryAddresses = { ipv4: string; ipv6: string };

/**
 * 一台入口机器的两种地址。手填入口是 IP 字面量时以它为准（那是用户特意指定的入口，
 * 比面板探测到的更可信）；否则用面板记下的 IPv4 / IPv6。
 */
export function hostFamilyEntryAddresses(host: HostEntryAddressSource | null | undefined): ProxySubEntryAddresses {
  if (!host) return { ipv4: "", ipv6: "" };
  return {
    ipv4: addressLiteralOfFamily(host.entryIp, "ipv4") || addressLiteralOfFamily(hostAutoIpv4(host), "ipv4"),
    ipv6: addressLiteralOfFamily(host.entryIp, "ipv6") || addressLiteralOfFamily(hostAutoIpv6(host), "ipv6"),
  };
}

/**
 * 落地池节点的两种地址。池节点的地址是池的直连域名，或首选那台成员的地址：
 *   - 正好是某台成员叫得出的地址 → 就是那台机器，用它的（它没有这种地址就是没有，不换别台 ——
 *     换了等于悄悄把客户端指到另一台机器上）；
 *   - 否则（直连域名，本来就解析到这些成员上）→ 按池里的顺序取第一台有这种地址的成员。
 * 一台都没有就是空串，那条按「没有这种地址」跳过。
 */
export function landingPoolFamilyEntryAddresses(nodeAddress: unknown, members: readonly HostEntryAddressSource[]): ProxySubEntryAddresses {
  const normalized = (value: unknown) => String(value ?? "").trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  const address = normalized(nodeAddress);
  const owner = address
    ? members.find((host) => [...getHostEntryAddresses(host).map((entry) => entry.value), host.ip, host.ipv4, host.ipv6]
      .some((value) => value && normalized(value) === address))
    : undefined;
  if (owner) return hostFamilyEntryAddresses(owner);
  const families = members.map((host) => hostFamilyEntryAddresses(host));
  return {
    ipv4: families.find((item) => item.ipv4)?.ipv4 || "",
    ipv6: families.find((item) => item.ipv6)?.ipv6 || "",
  };
}

/**
 * 直连条目的两种地址：节点自己的地址是字面量就算一种；另一种看节点所在机器，再看服务端
 * 给模板行补的 entryIpv4 / entryIpv6（落地池）。
 */
export function directFamilyEntryAddresses(
  nodeAddress: string,
  host: HostEntryAddressSource | null | undefined,
  extra: { entryIpv4?: unknown; entryIpv6?: unknown } = {},
): ProxySubEntryAddresses {
  const fromHost = hostFamilyEntryAddresses(host);
  return {
    ipv4: addressLiteralOfFamily(nodeAddress, "ipv4") || fromHost.ipv4 || addressLiteralOfFamily(extra.entryIpv4, "ipv4"),
    ipv6: addressLiteralOfFamily(nodeAddress, "ipv6") || fromHost.ipv6 || addressLiteralOfFamily(extra.entryIpv6, "ipv6"),
  };
}

/**
 * 按地址族挑条目、改地址。version 为空时原样返回同一个对象。
 *
 * 前置节点（落地直连那一条）被跳过时，挂着它的条目也跳过：只摘掉前置的话，那条就变成
 * 不经前置直连 —— 又是一种「看着能用、走的不是你以为的路」。
 */
export function selectProxySubPlanAddressFamily(plan: ProxySubscriptionPlan, version: ProxySubIpVersion | null | undefined): ProxySubscriptionPlan {
  if (!version) return plan;
  const key = version === "6" ? "ipv6" : "ipv4";
  const reason = PROXY_SUB_IP_VERSION_SKIP_REASON[version];
  const skipped: ProxySubscriptionSkip[] = [...plan.skipped];
  const skip = (entry: ProxySubscriptionEntry) => {
    skipped.push({
      ruleId: entry.ruleId,
      ruleName: String(entry.meta?.ruleName || entry.node.name || ""),
      reason,
      nodeName: entry.node.name,
      ...(entry.lineGroup ? { lineGroup: true } : {}),
    });
  };
  const droppedDirect = new Set<number>();
  const firstPass: ProxySubscriptionEntry[] = [];
  for (const entry of plan.entries) {
    const address = entry.addresses?.[key] || "";
    if (!address) {
      if (entry.kind === "direct") droppedDirect.add(entry.templateId);
      skip(entry);
      continue;
    }
    firstPass.push(address === entry.node.address ? entry : { ...entry, node: { ...entry.node, address } });
  }
  const entries: ProxySubscriptionEntry[] = [];
  for (const entry of firstPass) {
    if (entry.frontTemplateId && droppedDirect.has(entry.frontTemplateId)) {
      skip(entry);
      continue;
    }
    entries.push(entry);
  }
  return { ...plan, entries, skipped };
}

/** 这份 plan 里因为地址族被跳过的条数（响应头 X-ForwardX-Skipped-Entries）。 */
export function countProxySubAddressFamilySkips(plan: Pick<ProxySubscriptionPlan, "skipped">): number {
  return plan.skipped.filter((item) => item.reason === "no-ipv4-address" || item.reason === "no-ipv6-address").length;
}
