import { isAllowedMobileCorsOrigin } from "../mobileCors";

/*
  跨站写操作防护（CSRF）。

  会话 Cookie 是 SameSite=Lax：浏览器从别的站点发 POST 时不会带它，这挡住了大多数跨站请求伪造。
  但 Lax 挡不住「同站不同源」—— 面板跑在 panel.example.com，攻击者在 evil.example.com 放一个页面，
  那个页面发出的请求照样带 Cookie。再加上面板给手机 App 的 CORS 带着 Allow-Credentials，所以这里
  再对每个用 Cookie 认证的写操作（tRPC mutation）核一次请求来源：

    · 带 Origin 头：必须是面板自己的域名（按请求的 Host / 反代传来的 X-Forwarded-Host 比对主机名，
      不比端口和协议 —— 反代做 TLS 卸载时协议会变）、手机 App 的固定源，或 FORWARDX_TRUSTED_ORIGINS
      里额外放行的来源。Origin: null（沙箱 iframe、file://）一律拒。
    · 不带 Origin 头：浏览器跨站 POST 一定带 Origin，没有就只可能是非浏览器客户端（curl、脚本）或
      极老的浏览器同源请求；再看 Sec-Fetch-Site，明确写着 cross-site 的拒掉，其余放行。

  用 Bearer 令牌（个人 API 令牌、App 的令牌）认证的请求不在这里管：令牌不会被浏览器自动附带，
  本来就不受 CSRF 影响。
*/

export const CROSS_SITE_MUTATION_ERR_MSG = "请求来源与面板地址不一致，已拒绝（CSRF 防护）";

type CsrfRequest = {
  headers?: Record<string, string | string[] | undefined>;
  /** Express 的 req.hostname：已按 trust proxy 策略处理过 X-Forwarded-Host，不带端口。 */
  hostname?: string;
};

function headerValue(headers: CsrfRequest["headers"], name: string): string {
  const raw = headers?.[name];
  if (Array.isArray(raw)) return String(raw[0] ?? "");
  return String(raw ?? "");
}

function hostnameOf(origin: string): string | null {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** 解析 FORWARDX_TRUSTED_ORIGINS：逗号分隔，每项是完整来源（https://a.example）或裸主机名（a.example）。 */
export function parseTrustedOrigins(raw: string | undefined | null): Set<string> {
  const result = new Set<string>();
  for (const part of String(raw ?? "").split(",")) {
    const value = part.trim().toLowerCase();
    if (!value) continue;
    result.add(value);
    const host = hostnameOf(value.includes("://") ? value : `https://${value}`);
    if (host) result.add(host);
  }
  return result;
}

/**
 * 这个请求是不是跨站发来的。返回 null 表示放行，否则是拒绝原因（给日志用，对外统一回 CROSS_SITE_MUTATION_ERR_MSG）。
 * 没有请求头（进程内调用、Telegram 机器人拼出来的上下文）直接放行。
 */
export function crossSiteRequestReason(
  req: CsrfRequest | null | undefined,
  options: { trustedOrigins?: Set<string>; isProduction?: boolean } = {},
): string | null {
  const headers = req?.headers;
  if (!headers) return null;

  const origin = headerValue(headers, "origin").trim();
  if (!origin) {
    const fetchSite = headerValue(headers, "sec-fetch-site").trim().toLowerCase();
    return fetchSite === "cross-site" ? "sec-fetch-site=cross-site without Origin" : null;
  }
  if (origin === "null") return "Origin: null";

  const originLower = origin.toLowerCase();
  const originHost = hostnameOf(originLower);
  if (!originHost) return `unparseable Origin ${origin}`;

  const requestHost = String(req?.hostname ?? "").trim().toLowerCase()
    || hostnameOf(`http://${headerValue(headers, "host").trim()}`)
    || "";
  if (requestHost && originHost === requestHost) return null;
  if (isAllowedMobileCorsOrigin(originLower, options.isProduction)) return null;
  const trusted = options.trustedOrigins;
  if (trusted && (trusted.has(originLower) || trusted.has(originHost))) return null;
  return `Origin ${origin} does not match panel host ${requestHost || "(unknown)"}`;
}
