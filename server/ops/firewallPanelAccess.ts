/*
  面板访问的地区限制（#4b）：谁能打开面板的网页。

  - 只看本地缓存的国家段（firewallCountryData），每个请求不查任何外部接口；
  - 客户端 IP 用 req.ip —— 它已经按 FORWARDX_TRUST_PROXY（server/trustProxy.ts）处理过反向代理；
  - Agent 的路由（/api/agent/*、/api/sync、/api/stream）、支付回调、面板迁移永远放行：
    这些请求来自机器，不是来打开面板的人；
  - 订阅链接（/api/sub/*）默认放行，规则里勾上才一起限制；
  - 内网、环回地址永远放行；
  - 国家数据还没下载好时一律放行（宁可放进来，不能把管理员锁在外面）。
  每个 IP 的判断缓存一分钟；规则或国家数据一变就清空。
*/
import type { NextFunction, Request, Response } from "express";
import { classifyIpAddress } from "../../shared/ipAddress";
import { firewallCountryLabel } from "../../shared/firewallCountries";
import { setBoundedMapValue } from "../boundedCache";
import { normalizeClientIp } from "./firewallCidr";
import { countryMatchers, ensureCountryData, onCountryDataChanged } from "./firewallCountryData";
import { readPanelAccessRule, type PanelAccessRule } from "./firewallStore";
import { databaseHealth } from "../databaseHealthState";

export type CountryLookup = {
  /** 这个 IP 落在哪个选中的国家里；都不在返回 null。 */
  match: (ip: string) => string | null;
  /** 选中的国家里有没有还没下载好的。 */
  missing: string[];
};

export type PanelAccessDecision = {
  allowed: boolean;
  reason: "off" | "private" | "unknown-ip" | "no-data" | "matched" | "not-matched";
  country: string | null;
};

/** 永远放行的路径（不管规则怎么设）。 */
export function isPanelAccessExemptPath(path: string, rule: Pick<PanelAccessRule, "includeSubscription">): boolean {
  const p = String(path || "");
  if (p.startsWith("/api/agent/") || p === "/api/agent") return true;
  if (p === "/api/sync" || p.startsWith("/api/sync/")) return true;
  if (p === "/api/stream" || p.startsWith("/api/stream/")) return true;
  // Agent 测速改测到面板（server/ops/nodeCheckSpeedRoute.ts）：按一次性口令认，和 Agent 接口一样放行。
  if (p.startsWith("/api/nodecheck/speed/")) return true;
  if (p.startsWith("/api/payment/webhook")) return true;
  if (p.startsWith("/api/migration/")) return true;
  if ((p.startsWith("/api/sub/") || p.startsWith("/s/")) && !rule.includeSubscription) return true;
  return false;
}

/** 纯函数：按规则判断这个 IP 能不能打开面板。 */
export function decidePanelAccess(ipInput: string, rule: PanelAccessRule, lookup: CountryLookup): PanelAccessDecision {
  if (rule.mode === "off" || rule.countries.length === 0) return { allowed: true, reason: "off", country: null };
  const ip = normalizeClientIp(ipInput);
  if (!ip) return { allowed: true, reason: "unknown-ip", country: null };
  if (classifyIpAddress(ip) !== "public") return { allowed: true, reason: "private", country: null };
  const country = lookup.match(ip);
  if (rule.mode === "block") {
    return country ? { allowed: false, reason: "matched", country } : { allowed: true, reason: lookup.missing.length > 0 ? "no-data" : "not-matched", country: null };
  }
  // 只放行：数据没齐时不能断定「不在名单里」，放行。
  if (country) return { allowed: true, reason: "matched", country };
  if (lookup.missing.length > 0) return { allowed: true, reason: "no-data", country: null };
  return { allowed: false, reason: "not-matched", country: null };
}

/**
 * 保存前的自检：按新规则，发起保存的这个人自己会不会被挡在外面。会的话返回一句解释，不保存。
 * 选中的国家数据还没下载好时也不让保存（没法判断）。
 */
export function panelAccessSelfLockoutError(ip: string, rule: PanelAccessRule, lookup: CountryLookup): string | null {
  if (rule.mode === "off" || rule.countries.length === 0) return null;
  const normalized = normalizeClientIp(ip);
  if (normalized && classifyIpAddress(normalized) !== "public") return null;
  if (lookup.missing.length > 0) {
    return `这些国家的 IP 段还没下载好：${lookup.missing.map(firewallCountryLabel).join("、")}。下载完再保存，免得判断错把自己挡在外面。`;
  }
  if (!normalized) return "认不出你现在的 IP，没法确认保存后你还能打开面板，所以没有保存。";
  const decision = decidePanelAccess(normalized, rule, lookup);
  if (decision.allowed) return null;
  if (rule.mode === "block" && decision.country) {
    return `你现在的 IP ${normalized} 属于${firewallCountryLabel(decision.country)}，按这个规则保存后你自己也打不开面板了，所以没有保存。`;
  }
  return `你现在的 IP ${normalized} 不在放行的国家里，按这个规则保存后你自己也打不开面板了，所以没有保存。先把你所在的国家加进去。`;
}

export async function buildCountryLookup(countries: string[]): Promise<CountryLookup> {
  const matchers = await countryMatchers(countries);
  const missing = Array.from(matchers.entries()).filter(([, matcher]) => !matcher).map(([code]) => code);
  return {
    missing,
    match: (ip) => {
      for (const [code, matcher] of matchers) {
        if (matcher?.contains(ip)) return code;
      }
      return null;
    },
  };
}

// ── 中间件 ──────────────────────────────────────────────

const RULE_TTL_MS = 60_000;
const DECISION_TTL_MS = 60_000;
const DECISION_CACHE_MAX = 10_000;

let ruleCache: { rule: PanelAccessRule; loadedAt: number } | null = null;
let ruleLoad: Promise<PanelAccessRule> | null = null;
let lookupCache: { key: string; lookup: CountryLookup } | null = null;
const decisions = new Map<string, { allowed: boolean; at: number }>();

export function invalidatePanelAccessCache() {
  ruleCache = null;
  lookupCache = null;
  decisions.clear();
}

onCountryDataChanged(() => {
  lookupCache = null;
  decisions.clear();
});

async function currentRule(): Promise<PanelAccessRule> {
  if (ruleCache && Date.now() - ruleCache.loadedAt < RULE_TTL_MS) return ruleCache.rule;
  // 数据库故障期间不去读库（每个静态资源请求都会等一次连接超时，故障页半天打不开）：
  // 有旧规则就接着用旧的，没有就按「出错放行」处理。
  if (databaseHealth.isUnavailable()) {
    if (ruleCache) return ruleCache.rule;
    throw new Error("database unavailable");
  }
  if (!ruleLoad) {
    ruleLoad = readPanelAccessRule()
      .then((rule) => {
        ruleCache = { rule, loadedAt: Date.now() };
        if (rule.mode !== "off") void ensureCountryData(rule.countries).catch(() => undefined);
        return rule;
      })
      .finally(() => {
        ruleLoad = null;
      });
  }
  return ruleLoad;
}

async function currentLookup(rule: PanelAccessRule) {
  const key = rule.countries.join(",");
  if (lookupCache?.key === key) return lookupCache.lookup;
  const lookup = await buildCountryLookup(rule.countries);
  lookupCache = { key, lookup };
  return lookup;
}

function sendBlocked(req: Request, res: Response) {
  res.setHeader("Cache-Control", "no-store");
  if (req.path.startsWith("/api/")) {
    res.status(403).json({ error: "panel_access_denied", message: "当前所在地区不能访问这个面板" });
    return;
  }
  res.status(403).type("html").send(
    "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>无法访问</title></head>"
    + "<body style=\"font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;color:#444\">"
    + "<p>当前所在地区不能访问这个面板。</p></body></html>",
  );
}

/** express 中间件：挂在最前面（server/index.ts）。出任何错都放行，不能因为这里坏了打不开面板。 */
export async function panelAccessGuard(req: Request, res: Response, next: NextFunction) {
  try {
    const rule = await currentRule();
    if (rule.mode === "off" || isPanelAccessExemptPath(req.path, rule)) return next();
    const ip = normalizeClientIp(req.ip || req.socket?.remoteAddress || "");
    const now = Date.now();
    const cached = ip ? decisions.get(ip) : undefined;
    let allowed: boolean;
    if (cached && now - cached.at < DECISION_TTL_MS) {
      allowed = cached.allowed;
    } else {
      allowed = decidePanelAccess(ip, rule, await currentLookup(rule)).allowed;
      if (ip) setBoundedMapValue(decisions, ip, { allowed, at: now }, DECISION_CACHE_MAX);
    }
    if (allowed) return next();
    sendBlocked(req, res);
  } catch (error) {
    console.warn(`[Firewall] panel access check failed: ${error instanceof Error ? error.message : String(error)}`);
    next();
  }
}
