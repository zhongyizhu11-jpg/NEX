import type { Request } from "express";
import * as db from "./db";

function firstHeaderValue(value: unknown) {
  const raw = Array.isArray(value) ? value[0] : value;
  return String(raw || "").split(",")[0].trim();
}

export function normalizePanelUrl(value: string) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) return "";
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

export async function getConfiguredPanelUrl(): Promise<string> {
  // 走设置缓存：订阅拉取、Agent 心跳这些高频路都要它，不该每次都去库里点一条。
  const configured = normalizePanelUrl((await db.getCachedSetting("panelPublicUrl")) || "");
  return configured && /^https?:\/\//i.test(configured) ? configured : "";
}

/*
  X-Forwarded-* / cf-visitor 谁都能伪造。这里算出来的地址会用在支付回跳、Agent 安装脚本里的面板地址、
  订阅 profile URL 上，直接信任就等于让任意客户端把这些链接指向自己的域名。
  只有直连对端是受信代理（与 app 的 trust proxy 配置同一判定，Express 自己的 req.protocol/req.ip
  也是这么判的）时才读转发头，否则只看直连的 Host。
*/
function isFromTrustedProxy(req: Request) {
  const trust = (req as any).app?.get?.("trust proxy fn");
  if (typeof trust !== "function") return false;
  const remoteAddress = req.socket?.remoteAddress || (req as any).connection?.remoteAddress;
  if (!remoteAddress) return false;
  try {
    return !!trust(remoteAddress, 0);
  } catch {
    return false;
  }
}

function forwardedProto(req: Request, trusted: boolean) {
  if (!trusted) return req.protocol === "https" ? "https" : "http";
  const cfVisitor = firstHeaderValue(req.headers["cf-visitor"]);
  if (cfVisitor) {
    try {
      const parsed = JSON.parse(cfVisitor);
      const scheme = String(parsed?.scheme || "").toLowerCase();
      if (scheme === "http" || scheme === "https") return scheme;
    } catch {
      // Ignore malformed proxy metadata and continue with normal headers.
    }
  }
  const proto = firstHeaderValue(req.headers["x-forwarded-proto"]).toLowerCase();
  if (proto === "http" || proto === "https") return proto;
  return req.protocol === "https" ? "https" : "http";
}

function forwardedHost(req: Request, trusted: boolean) {
  const host = (trusted ? firstHeaderValue(req.headers["x-forwarded-host"]) : "") || req.get("host") || "";
  if (!host || /[\s/?#\\@]/.test(host)) return "";
  return host;
}

function forwardedPrefix(req: Request, trusted: boolean) {
  if (!trusted) return "";
  const prefix = firstHeaderValue(req.headers["x-forwarded-prefix"]);
  if (!prefix || prefix === "/") return "";
  if (!prefix.startsWith("/") || /[?#\\\s]/.test(prefix)) return "";
  try {
    const segments = decodeURIComponent(prefix).split("/");
    if (segments.some((segment) => segment === "." || segment === "..")) return "";
  } catch {
    return "";
  }
  return prefix.replace(/\/+$/, "");
}

export function resolveRequestPanelUrl(req: Request, configuredPanelUrl = ""): string {
  const configured = normalizePanelUrl(configuredPanelUrl);
  if (configured) return configured;

  const trusted = isFromTrustedProxy(req);
  const proto = forwardedProto(req, trusted);
  const host = forwardedHost(req, trusted);
  if (!host) return "";

  const forwardedPort = trusted ? firstHeaderValue(req.headers["x-forwarded-port"]) : "";
  const validForwardedPort = /^\d{1,5}$/.test(forwardedPort) && Number(forwardedPort) > 0 && Number(forwardedPort) <= 65535
    ? forwardedPort
    : "";
  const hasPort = /^\[[^\]]+\]:\d+$/.test(host) || /^[^:]+:\d+$/.test(host);
  const defaultPort = (proto === "https" && validForwardedPort === "443") || (proto === "http" && validForwardedPort === "80");
  const hostWithPort = !hasPort && validForwardedPort && !defaultPort ? `${host}:${validForwardedPort}` : host;
  try {
    const url = new URL(`${proto}://${hostWithPort}`);
    url.pathname = forwardedPrefix(req, trusted) || "/";
    return normalizePanelUrl(url.toString());
  } catch {
    return "";
  }
}

export async function resolvePanelUrl(req: Request): Promise<string> {
  return resolveRequestPanelUrl(req, await getConfiguredPanelUrl());
}

export async function resolveAgentAdvertisedPanelUrl(): Promise<string> {
  return getConfiguredPanelUrl();
}
