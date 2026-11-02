import { isRestrictedOutboundAddress } from "../shared/ipAddress";
import dns from "node:dns";
import { lookup } from "dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "net";

type SafeOutboundOptions = {
  allowPrivate?: boolean;
  purpose?: string;
};

function blockedHostError(purpose: string, host: string) {
  return new Error(`${purpose} 不允许访问受限地址 ${host}`);
}

function normalizeHost(host: string) {
  return String(host || "").trim().replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

function isRestrictedIp(value: string, allowPrivate: boolean) {
  return isRestrictedOutboundAddress(value, { allowPrivate });
}

export async function assertSafeOutboundHost(rawHost: string, options: SafeOutboundOptions = {}) {
  const purpose = options.purpose || "此请求";
  const host = normalizeHost(rawHost);
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw blockedHostError(purpose, host || "-");
  }
  const allowPrivate = options.allowPrivate === true;
  if (isIP(host)) {
    if (isRestrictedIp(host, allowPrivate)) throw blockedHostError(purpose, host);
    return;
  }
  let records: Array<{ address: string }>;
  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error(`${purpose} 无法解析目标地址 ${host}`);
  }
  if (records.length === 0 || records.some((record) => isRestrictedIp(record.address, allowPrivate))) {
    throw blockedHostError(purpose, host);
  }
}

export async function assertSafeOutboundUrl(rawUrl: string, options: SafeOutboundOptions = {}) {
  let url: URL;
  try {
    url = new URL(String(rawUrl || "").trim());
  } catch {
    throw new Error(`${options.purpose || "此请求"} 地址无效`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${options.purpose || "此请求"} 仅支持 HTTP/HTTPS 地址`);
  }
  if (url.username || url.password) {
    throw new Error(`${options.purpose || "此请求"} 不允许 URL 内嵌账号信息`);
  }
  await assertSafeOutboundHost(url.hostname, options);
  return url;
}

export async function assertSafePluginHttpUrl(rawUrl: string) {
  const allowPrivate = /^(1|true|yes|on)$/i.test(String(process.env.FORWARDX_ALLOW_PRIVATE_PLUGIN_HTTP || ""));
  return assertSafeOutboundUrl(rawUrl, { allowPrivate, purpose: "插件 HTTP 请求" });
}

/*
  「先查后连」的毛病：上面的 assert* 自己解析一次判断是不是公网，fetch 连接时又解析一次 ——
  第二次可以被 DNS 重绑定换成内网地址。下面这一套把检查放进连接用的 lookup 里：解析出来的地址
  当场检查，连接只会落在检查过的那个地址上。TLS 照样按主机名校验证书（servername 不变）。
*/

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

export type SafeLookupOptions = SafeOutboundOptions & {
  /** 自定义「这个地址不能连」。不给就用 isRestrictedOutboundAddress（按 allowPrivate）。 */
  isBlockedAddress?: (address: string) => boolean;
};

function blockedByOptions(address: string, options: SafeLookupOptions) {
  return options.isBlockedAddress ? options.isBlockedAddress(address) : isRestrictedIp(address, options.allowPrivate === true);
}

export type SafeOutboundErrorCode = "blocked" | "resolve" | "too-large" | "timeout" | "network" | "invalid-url";

export class SafeOutboundError extends Error {
  readonly code: SafeOutboundErrorCode;
  constructor(message: string, code: SafeOutboundErrorCode) {
    super(message);
    this.code = code;
  }
}

function isBlockedHostName(host: string) {
  return !host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal");
}

/** 给 http(s).request / net.connect 用的 lookup：解析、逐个检查、只交出检查过的地址。 */
export function createSafeLookup(options: SafeLookupOptions = {}) {
  const purpose = options.purpose || "此请求";
  return (hostname: string, lookupOptions: dns.LookupOptions | number | undefined, callback: LookupCallback) => {
    const opts: dns.LookupOptions = typeof lookupOptions === "number" ? { family: lookupOptions } : { ...(lookupOptions || {}) };
    const host = normalizeHost(hostname);
    if (isBlockedHostName(host)) {
      callback(new SafeOutboundError(`${purpose} 不允许访问受限地址 ${host || "-"}`, "blocked"), "");
      return;
    }
    const literal = isIP(host) ? [{ address: host, family: isIP(host) }] : null;
    const check = (list: dns.LookupAddress[]) => {
      if (list.length === 0) {
        callback(new SafeOutboundError(`${purpose} 无法解析目标地址 ${host}`, "resolve"), "");
        return;
      }
      if (list.some((item) => blockedByOptions(item.address, options))) {
        callback(new SafeOutboundError(`${purpose} 不允许访问受限地址 ${host}`, "blocked"), "");
        return;
      }
      if (opts.all) callback(null, list);
      else callback(null, list[0].address, list[0].family);
    };
    if (literal) {
      check(literal);
      return;
    }
    dns.lookup(hostname, { family: opts.family as any, hints: opts.hints, all: true, verbatim: true }, (error, addresses) => {
      if (error) {
        callback(error, "");
        return;
      }
      check(((addresses as unknown) as dns.LookupAddress[]) || []);
    });
  };
}

export type SafeHttpResponse = {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
};

/**
 * GET 一个外部地址：连接钉在检查过的地址上，正文边读边数，超过 maxBytes 立刻断开。
 * 不跟随跳转（3xx 原样返回，调用方自己决定跟不跟；跟的话下一跳照样走这里，照样检查）。
 */
export function safeHttpGet(rawUrl: string, options: SafeLookupOptions & {
  headers?: Record<string, string>;
  timeoutMs: number;
  maxBytes: number;
}): Promise<SafeHttpResponse> {
  const purpose = options.purpose || "此请求";
  let url: URL;
  try {
    url = new URL(String(rawUrl || "").trim());
  } catch {
    return Promise.reject(new SafeOutboundError(`${purpose} 地址无效`, "invalid-url"));
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return Promise.reject(new SafeOutboundError(`${purpose} 仅支持 HTTP/HTTPS 地址`, "invalid-url"));
  }
  // 主机名是 IP 字面量时 Node 连接不走 lookup，要在这里查。
  const literal = normalizeHost(url.hostname);
  if (isIP(literal) && blockedByOptions(literal, options)) {
    return Promise.reject(new SafeOutboundError(`${purpose} 不允许访问受限地址 ${literal}`, "blocked"));
  }
  const client = url.protocol === "https:" ? https : http;
  return new Promise<SafeHttpResponse>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (error: Error | null, value?: SafeHttpResponse) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(value!);
    };
    const asError = (error: Error) => (error instanceof SafeOutboundError ? error : new SafeOutboundError(error.message, "network"));
    const request = client.get(url, {
      headers: options.headers,
      lookup: createSafeLookup(options) as any,
      // 不用连接池：池里的连接可能是按别的口径检查过的。
      agent: false,
    }, (response) => {
      const status = Number(response.statusCode || 0);
      const tooLarge = () => {
        finish(new SafeOutboundError(`${purpose} 正文超过上限`, "too-large"));
        response.destroy();
        request.destroy();
      };
      if (Number(response.headers["content-length"] || 0) > options.maxBytes) {
        tooLarge();
        return;
      }
      const chunks: Buffer[] = [];
      let received = 0;
      response.on("data", (chunk: Buffer) => {
        if (settled) return;
        received += chunk.length;
        if (received > options.maxBytes) {
          tooLarge();
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => finish(null, { status, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on("error", (error) => finish(asError(error)));
      response.on("aborted", () => finish(new SafeOutboundError(`${purpose} 连接中断`, "network")));
    });
    timer = setTimeout(() => {
      finish(new SafeOutboundError(`${purpose} 超时`, "timeout"));
      request.destroy();
    }, options.timeoutMs);
    request.on("error", (error) => finish(asError(error)));
  });
}
