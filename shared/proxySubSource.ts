/**
 * 外部订阅的内容解析：把别家面板 / 机场发来的订阅正文变成节点列表。
 *
 * 认四种正文：
 *   1. 一行一条分享链接（vless:// ss:// …）
 *   2. 整体 base64 之后的 1
 *   3. Clash / mihomo 的 YAML（取 proxies: 列表）
 *   4. sing-box 的 JSON（取 outbounds）或 Clash 的 JSON
 *
 * 每个条目都走面板已有的解析器（parseProxyNodeLink / parseProxyNodeJson），所以外部节点
 * 和手工粘进来的节点能力完全一样。解析不了的条目记原因、不中断。
 */

import { parseMiniYaml } from "./miniYaml";
import { decodeBase64Utf8, parseProxyNodeLink, type ProxyNode } from "./proxyNode";
import { parseProxyNodeJson } from "./proxyNodeJson";

export type ProxySubSourceFormat = "links" | "base64" | "clash" | "singbox" | "json" | "unknown";

export type ProxySubSourceParseResult = {
  format: ProxySubSourceFormat;
  nodes: ProxyNode[];
  /** 没解析出来的条目：前几十个字和原因。 */
  errors: Array<{ item: string; error: string }>;
};

const LINK_SCHEMES = /^(vless|vmess|trojan|ss|hysteria2|hy2|tuic|anytls|socks5?):\/\//i;

function uniqueByIdentity(nodes: ProxyNode[]): ProxyNode[] {
  const seen = new Set<string>();
  return nodes.filter((node) => {
    const key = `${node.protocol}|${node.address.toLowerCase()}|${node.port}|${node.uuid || node.password}|${node.transport}|${node.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseLinkLines(lines: string[], result: ProxySubSourceParseResult) {
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    if (!LINK_SCHEMES.test(line)) {
      // 常见的「REMARKS= / STATUS=」这种 SSR 订阅里的说明行直接跳过。
      if (/^[A-Z_]+=/i.test(line)) continue;
      result.errors.push({ item: line.slice(0, 60), error: "不是节点链接" });
      continue;
    }
    const parsed = parseProxyNodeLink(line);
    if (parsed.ok) result.nodes.push(parsed.node);
    else result.errors.push({ item: line.slice(0, 60), error: parsed.error });
  }
}

function parseJsonEntries(entries: unknown[], result: ProxySubSourceParseResult) {
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const type = String((entry as any).type || "").toLowerCase();
    // 组、直连、DNS 之类不是节点，静默跳过；真正解析失败的才报。
    if (["direct", "block", "dns", "selector", "urltest", "select", "url-test", "fallback", "load-balance", "relay"].includes(type)) continue;
    const parsed = parseProxyNodeJson(JSON.stringify(entry));
    if (parsed.ok) result.nodes.push(parsed.node);
    else result.errors.push({ item: String((entry as any).name || (entry as any).tag || type).slice(0, 60), error: parsed.error });
  }
}

export function parseProxySubSourceContent(content: unknown): ProxySubSourceParseResult {
  const text = String(content ?? "").replace(/^﻿/, "").trim();
  const result: ProxySubSourceParseResult = { format: "unknown", nodes: [], errors: [] };
  if (!text) return result;

  // JSON：sing-box 整份配置、Clash 的 JSON、或者一个数组。
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      const entries = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.outbounds) ? parsed.outbounds : Array.isArray(parsed?.proxies) ? parsed.proxies : null;
      if (entries) {
        result.format = Array.isArray(parsed?.outbounds) ? "singbox" : "json";
        parseJsonEntries(entries, result);
        result.nodes = uniqueByIdentity(result.nodes);
        return result;
      }
    } catch {
      // 不是 JSON，往下试别的。
    }
  }

  // Clash YAML：有 proxies: 这一段。
  if (/^proxies\s*:/m.test(text)) {
    const parsed = parseMiniYaml(text);
    const proxies = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as any).proxies : null;
    if (Array.isArray(proxies)) {
      result.format = "clash";
      parseJsonEntries(proxies, result);
      result.nodes = uniqueByIdentity(result.nodes);
      return result;
    }
  }

  // 裸链接。
  const lines = text.split(/\r?\n/);
  if (lines.some((line) => LINK_SCHEMES.test(line.trim()))) {
    result.format = "links";
    parseLinkLines(lines, result);
    result.nodes = uniqueByIdentity(result.nodes);
    return result;
  }

  // base64 一整块。
  const decoded = decodeBase64Utf8(text);
  if (decoded && /:\/\//.test(decoded)) {
    result.format = "base64";
    parseLinkLines(decoded.split(/\r?\n/), result);
    result.nodes = uniqueByIdentity(result.nodes);
    return result;
  }

  result.errors.push({ item: text.slice(0, 60), error: "认不出订阅格式（不是链接列表、base64、Clash YAML 或 sing-box JSON）" });
  return result;
}

/**
 * 上游订阅响应头里的流量信息：`upload=…; download=…; total=…; expire=…`。
 * 解析成数字，界面上显示「上游还剩多少」。
 */
export function parseSubscriptionUserinfoHeader(value: unknown): { upload: number; download: number; total: number; expire: number } | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const out = { upload: 0, download: 0, total: 0, expire: 0 };
  let any = false;
  for (const part of text.split(";")) {
    const [key, raw] = part.split("=").map((item) => item.trim().toLowerCase());
    const number = Number(raw);
    if (!key || !Number.isFinite(number)) continue;
    if (key in out) {
      (out as any)[key] = Math.max(0, Math.floor(number));
      any = true;
    }
  }
  return any ? out : null;
}

/** 外部订阅的地址：只收 http(s)，长度有限。 */
export function normalizeProxySubSourceUrl(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw || raw.length > 2048) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    if (!url.hostname) return "";
    return url.toString();
  } catch {
    return "";
  }
}

export const PROXY_SUB_SOURCE_MODES = ["import", "provider"] as const;
export type ProxySubSourceMode = (typeof PROXY_SUB_SOURCE_MODES)[number];
export const PROXY_SUB_SOURCE_MODE_LABELS: Record<ProxySubSourceMode, string> = {
  import: "面板定时拉取，节点并进订阅",
  provider: "透传给客户端（mihomo / Stash 的 proxy-providers），面板不存节点",
};

/** 拉取间隔：最短 10 分钟，最长 7 天，默认 6 小时。 */
export function normalizeProxySubSourceInterval(value: unknown): number {
  const n = Math.floor(Number(value) || 0);
  if (!n) return 6 * 3600;
  return Math.min(7 * 86400, Math.max(600, n));
}
