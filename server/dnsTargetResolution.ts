import { isIP } from "node:net";

export type ResolvedTargetIpCacheEntry = {
  raw: string;
  ip: string;
};

function normalizeDnsName(value: unknown): string {
  return String(value || "").trim().replace(/\.$/, "").toLowerCase();
}

export function selectResolvedTargetIp(
  raw: string,
  resolved: string,
  cached?: ResolvedTargetIpCacheEntry,
): string {
  const target = String(raw || "").trim();
  const candidate = String(resolved || "").trim();
  if (isIP(candidate)) return candidate;

  const cachedIp = String(cached?.ip || "").trim();
  if (
    cachedIp
    && isIP(cachedIp)
    && normalizeDnsName(cached?.raw) === normalizeDnsName(target)
  ) {
    return cachedIp;
  }

  return target;
}

/** 心跳里解析规则目标域名的总超时：DNS 卡住时不能拖住这台主机的心跳。 */
export const TARGET_DNS_RESOLVE_TIMEOUT_MS = 2500;

export type TargetDnsResolvers = {
  resolve4: (host: string) => Promise<string[]>;
  resolve6: (host: string) => Promise<string[]>;
};

/**
 * 把域名解析成一个 IP（先 A 后 AAAA）。解析失败或超时都返回原值，
 * 调用方再用 selectResolvedTargetIp 回落到上次的解析结果。
 */
export async function resolveTargetIpWithTimeout(
  raw: string,
  resolvers: TargetDnsResolvers,
  timeoutMs = TARGET_DNS_RESOLVE_TIMEOUT_MS,
): Promise<string> {
  const trimmed = String(raw || "").trim();
  if (!trimmed || isIP(trimmed)) return trimmed;
  const lookup = (async () => {
    try {
      const ips = await resolvers.resolve4(trimmed);
      if (ips.length > 0) return ips[0];
    } catch { /* 没有 A 记录时再查 AAAA */ }
    try {
      const ips = await resolvers.resolve6(trimmed);
      if (ips.length > 0) return ips[0];
    } catch { /* 解析失败返回原值 */ }
    return trimmed;
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(trimmed), Math.max(1, timeoutMs));
  });
  try {
    return await Promise.race([lookup, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
