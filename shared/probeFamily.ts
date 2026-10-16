/*
  探测的地址族选择（Agent 2.2.225 起生效）：网络测试的 TCPing、主机探测服务。

  目标是域名时才有意义：auto = 照旧（系统解析器给什么用什么），ipv4 / ipv6 = 只用这一族的地址。
  目标本身就是 IP 时一律存成 auto —— 地址族已经由地址决定了。老 Agent 不认这个字段，照旧。
*/
import { expandIpv6 } from "./ipAddress";

function isIpLiteral(value: string) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return value.split(".").every((part) => Number(part) <= 255);
  return value.includes(":") && expandIpv6(value) !== null;
}

export const PROBE_ADDRESS_FAMILIES = ["auto", "ipv4", "ipv6"] as const;
export type ProbeAddressFamily = (typeof PROBE_ADDRESS_FAMILIES)[number];

export const PROBE_ADDRESS_FAMILY_LABELS: Record<ProbeAddressFamily, string> = {
  auto: "自动",
  ipv4: "仅 IPv4",
  ipv6: "仅 IPv6",
};

/** 探测服务按地址族解析需要的 Agent 版本。 */
export const PROBE_FAMILY_MIN_AGENT_VERSION = "2.2.225";

export function isProbeAddressFamily(value: unknown): value is ProbeAddressFamily {
  return typeof value === "string" && (PROBE_ADDRESS_FAMILIES as readonly string[]).includes(value);
}

/** 认不出来的当 auto；目标是 IP 字面量也是 auto。 */
export function normalizeProbeAddressFamily(value: unknown, target?: string | null): ProbeAddressFamily {
  const family = isProbeAddressFamily(value) ? value : "auto";
  if (family !== "auto" && target && isIpLiteral(String(target).trim().replace(/^\[|\]$/g, ""))) return "auto";
  return family;
}

/** dns.lookup 的 family 参数：0 / 4 / 6。 */
export function probeFamilyNumber(family: ProbeAddressFamily): 0 | 4 | 6 {
  return family === "ipv4" ? 4 : family === "ipv6" ? 6 : 0;
}
