import express, { type Request, type Response } from "express";

import * as db from "./db";
import { resolvePanelUrl } from "./agentPanelUrl";
import {
  formatProxySubscriptionUserInfo,
  normalizeProxySubscriptionFormat,
  PROXY_SUBSCRIPTION_FORMAT_CONTENT_TYPES,
  PROXY_SUBSCRIPTION_FORMATS,
  type ProxySubscriptionFormat,
} from "../shared/proxySubscription";
import { normalizeProxyRulePreset } from "../shared/proxyRuleset";
import { proxySubscriptionProfileHeaders, proxySubscriptionProfileName, buildProxySubscriptionUrl } from "../shared/proxyClientImport";
import { detectProxyClient, type DetectedProxyClient } from "../shared/proxyClientUserAgent";
import { proxySubTemplateUserVars, renderProxySubPipeline } from "../shared/proxySubscriptionPipeline";
import { normalizeProxySubHwid, evaluateProxySubDeviceAccess } from "../shared/proxySubDeviceLimit";
import { normalizeProxySubAlias } from "../shared/proxySubTokenScope";
import { PROXY_SUB_TOKEN_FAILURE_LABELS, type ProxySubTokenFailureReason } from "../shared/proxySubTokenStatus";
import { proxyCredentialRecipientActive } from "./repositories/proxyInboundRepository";
import { infoNodesWanted, loadProxySubTokenContext, resolveTemplateForToken, type ProxySubTokenContext } from "./proxySubBundle";
import { getProxySubCached, proxySubCacheKey, setProxySubCached } from "./proxySubCache";
import { checkProxySubRateLimit } from "./proxySubRateLimit";
import { notifyProxySubEvent } from "./proxySubNotify";
import { announceHeaderValue, renderProxySubPage } from "./proxySubPage";
import { panelRulesetMirrorBase } from "./proxySubRulesetMirror";

export const proxySubscriptionRouter = express.Router();

/**
 * 各家客户端拉订阅时不会带 format 参数，只能靠 User-Agent 区分。识别不出来时
 * 回落到令牌上配置的默认格式，而不是猜。识别表在 shared/proxyClientUserAgent.ts。
 */
function formatFromUserAgent(userAgent: string, flag?: unknown): ProxySubscriptionFormat | null {
  return detectProxyClient(userAgent, flag).target;
}

/**
 * 这个客户端能不能按带宽加权的负载均衡组（组里重复列同一个节点 = 多分连接）。
 * 只认 mihomo / Clash 内核（Clash Verge、Mihomo Party、FlClash、ClashMetaForAndroid……），
 * 代码里核实过不去重；Stash 是另一套实现，没核实，不展开。
 */
export function clientSupportsWeightedLoadBalance(userAgent: string): boolean {
  const ua = userAgent.toLowerCase();
  if (!ua || ua.includes("stash") || ua.includes("shadowrocket")) return false;
  return ua.includes("clash") || ua.includes("mihomo");
}

function clientIp(req: Request): string {
  // 用 req.ip：它按面板的 trust proxy 设置解析 X-Forwarded-For。直接读这个头的话，
  // 谁都能在请求里写一个假 IP，「谁在拉这个订阅」的记录就不可信了。
  return req.ip || "";
}

/** 记一笔时要留的来路。成功和失败两条路共用，免得两边记的东西不一样。 */
function clientInfo(req: Request) {
  return { ip: clientIp(req), userAgent: String(req.headers["user-agent"] || "") };
}

function header(req: Request, name: string): string {
  const value = req.headers[name];
  return String(Array.isArray(value) ? value[0] : value || "").trim();
}

type Rejection = ProxySubTokenFailureReason | "page";

/**
 * 一次拉取的记录：令牌行上的「最后一次」照旧写，另外每次一行进日志表（保留天数为 0 时不记）。
 * 两处都是尽力而为，不影响已经发出去的回应。
 */
function logAccess(
  req: Request,
  context: { token: any; settings: { accessLogRetentionDays: number } } | null,
  client: DetectedProxyClient,
  detail: { format: string; profile: boolean; result: Rejection | "ok"; hwid: string; bytes: number },
) {
  if (!context) return;
  const info = clientInfo(req);
  const tokenId = Number(context.token.id);
  const task = (async () => {
    if (detail.result === "ok") {
      await db.recordProxySubTokenAccess(tokenId, info);
      await db.updateProxySubTokenClient(tokenId, client.family, client.version);
    } else if (detail.result !== "page") {
      await db.recordProxySubTokenFailure(tokenId, detail.result, info);
    }
    if (context.settings.accessLogRetentionDays > 0) {
      await db.recordProxySubAccessLog({
        tokenId,
        userId: Number(context.token.userId),
        ip: info.ip,
        userAgent: info.userAgent,
        clientFamily: client.family,
        clientVersion: client.version,
        format: detail.format,
        profile: detail.profile,
        result: detail.result,
        hwid: detail.hwid,
        bytes: detail.bytes,
      });
    }
  })();
  void task.catch((error) => console.warn("[proxy-subscription] 记录拉取失败:", error instanceof Error ? error.message : error));
}

function notFound(res: Response) {
  res.status(404).type("text/plain").send("订阅不存在");
}

/**
 * 令牌在、但这次不放行：403 + 原因。原来一律 404「订阅不存在」，设备满了、账号到期、地址停用
 * 在客户端上都像地址没了，用户只能去重置 —— 重置又解决不了到期之类的问题，换了地址照样 404。
 * 令牌是 40 位随机串，拿得到它的就是订阅的主人，告诉他为什么拉不到不算泄露。
 */
function rejected(res: Response, reason: ProxySubTokenFailureReason) {
  res.status(403).type("text/plain").send(`订阅暂时拉不到：${PROXY_SUB_TOKEN_FAILURE_LABELS[reason] || "被拒绝"}`);
}

async function findToken(param: string, byAlias: boolean) {
  const value = String(param || "").trim();
  if (!value) return undefined;
  if (byAlias) {
    const alias = normalizeProxySubAlias(value);
    return alias ? db.getProxySubTokenByAlias(alias) : undefined;
  }
  return db.getProxySubTokenByToken(value);
}

/** 请求上带的格式：显式路径段 / ?format= / ?target=。都没有返回 null。 */
function requestedFormat(req: Request, pathFormat?: string): ProxySubscriptionFormat | null {
  const raw = String(pathFormat || req.query.format || req.query.target || "").trim();
  return raw ? normalizeProxySubscriptionFormat(raw) : null;
}

/**
 * 三步资格检查：令牌存在且启用、令牌没过期、主人有资格。
 * 不过的回 403 并写明是哪一步（见 rejected），面板这边也记下来。
 */
async function gate(req: Request, token: any, client: DetectedProxyClient): Promise<{ ok: true; context: ProxySubTokenContext } | { ok: false; reason: ProxySubTokenFailureReason; context: ProxySubTokenContext | null }> {
  const context = await loadProxySubTokenContext(token);
  if (!context) return { ok: false, reason: "not-eligible", context: null };
  if (!token.isEnabled) return { ok: false, reason: "disabled", context };
  const expiresAt = token.expiresAt ? new Date(token.expiresAt as any).getTime() : 0;
  if (expiresAt && expiresAt <= Date.now()) return { ok: false, reason: "token-expired", context };
  /**
   * 订阅本身的资格：和落地机那边用**同一把尺子**（proxyCredentialRecipientActive）。
   * 到期的租户照样拉到一份列着全部节点的订阅，页头还老老实实写着他已经过期 ——
   * 落地机那边早就把他的凭据拿掉了，两处判定必须一致。
   */
  if (!proxyCredentialRecipientActive(context.owner as any)) return { ok: false, reason: "not-eligible", context };
  void client;
  return { ok: true, context };
}

/** 响应头：流量信息、更新间隔、名字、公告、帮助地址。 */
function applyHeaders(res: Response, context: ProxySubTokenContext, options: { format: ProxySubscriptionFormat; profile: boolean; panelUrl: string; token: any }) {
  const { owner, settings } = context;
  const userExpiresAt = owner.expiresAt ? new Date(owner.expiresAt as any).getTime() : 0;
  res.setHeader(
    "Subscription-Userinfo",
    formatProxySubscriptionUserInfo({
      // 面板只记录总量，没有分上下行的口径，全部计入 download 以免客户端重复累加。
      upload: 0,
      download: Number(owner.trafficUsed || 0),
      total: Number(owner.trafficLimit || 0),
      expire: userExpiresAt ? Math.floor(userExpiresAt / 1000) : 0,
    }),
  );
  res.setHeader("Content-Type", PROXY_SUBSCRIPTION_FORMAT_CONTENT_TYPES[options.format]);
  res.setHeader("Profile-Update-Interval", String(settings.updateIntervalHours));
  for (const [name, value] of Object.entries(proxySubscriptionProfileHeaders(
    proxySubscriptionProfileName(String(options.token.name || ""), options.profile ? "rules" : "nodes", context.username),
  ))) res.setHeader(name, value);
  if (options.panelUrl) {
    // 浏览器打开这条地址给落地页，客户端（Happ、Hiddify、v2RayTun……）读这个头把它放在订阅详情里。
    res.setHeader("Profile-Web-Page-Url", `${options.panelUrl.replace(/\/+$/, "")}/api/sub/${options.token.token}`);
  }
  if (settings.supportUrl) res.setHeader("Support-Url", settings.supportUrl);
  const announce = announceHeaderValue(settings.announce);
  if (announce) res.setHeader("Announce", announce);
  // 订阅内容随转发增删而变，缓存会让用户以为新建的转发没生效。
  res.setHeader("Cache-Control", "no-store");
}

/**
 * 设备数限制：带 x-hwid 的按 hwid 算，不带的按 IP 退化（或严格模式拒绝）。
 * 登记和通知都是尽力而为，拒绝才是硬的。
 */
async function deviceGate(req: Request, context: ProxySubTokenContext, client: DetectedProxyClient): Promise<{ allowed: boolean; reason?: "device-limit" | "hwid-required"; headers: Record<string, string>; hwid: string }> {
  const { settings, token } = context;
  const hwid = normalizeProxySubHwid(header(req, "x-hwid"));
  const ip = clientIp(req);
  if (!settings.deviceLimitEnabled && !hwid) return { allowed: true, headers: {}, hwid: "" };
  const devices = await db.listProxySubDevicesByToken(Number(token.id)) as any[];
  const decision = evaluateProxySubDeviceAccess({
    enabled: settings.deviceLimitEnabled,
    strict: settings.deviceLimitStrict,
    limit: context.deviceLimit,
    hwid,
    ip,
    now: Date.now(),
    ipWindowMs: settings.deviceIpWindowHours * 3_600_000,
    devices: devices.map((device) => ({ hwid: String(device.hwid), lastSeenAt: device.lastSeenAt ? new Date(device.lastSeenAt).getTime() : 0 })),
  });
  if (decision.allowed && decision.deviceKey) {
    void db.touchProxySubDevice({
      tokenId: Number(token.id),
      userId: Number(token.userId),
      hwid: decision.deviceKey,
      deviceOs: header(req, "x-device-os"),
      osVersion: header(req, "x-ver-os"),
      model: header(req, "x-device-model"),
      ip,
      userAgent: String(req.headers["user-agent"] || ""),
    }).then((result) => {
      if (result.isNew && devices.length > 0) {
        void notifyProxySubEvent({ kind: "new-device", tokenId: Number(token.id), tokenName: String(token.name || ""), userId: Number(token.userId), detail: `${client.label}${client.version ? " " + client.version : ""}，来自 ${ip || "未知 IP"}` });
      }
    }).catch(() => {});
  }
  if (!decision.allowed && decision.reason === "device-limit") {
    void notifyProxySubEvent({ kind: "device-limit", tokenId: Number(token.id), tokenName: String(token.name || ""), userId: Number(token.userId), detail: `已有 ${decision.count} 台，上限 ${context.deviceLimit}；这次来自 ${client.label}（${ip || "未知 IP"}）` });
  }
  return { allowed: decision.allowed, reason: decision.reason, headers: decision.headers, hwid };
}

/** 主流程：/api/sub/:token、/api/sub/:token/:format、/s/:alias 都走它。 */
async function handleSubscription(req: Request, res: Response, options: { param: string; byAlias: boolean; pathFormat?: string }) {
  let context: ProxySubTokenContext | null = null;
  const userAgent = String(req.headers["user-agent"] || "");
  const client = detectProxyClient(userAgent, req.query.flag);
  try {
    const record = await findToken(options.param, options.byAlias);
    if (!record) {
      // 令牌根本不存在的那一种记不了：没有任何一行能挂上这笔记录。
      notFound(res);
      return;
    }
    const gated = await gate(req, record, client);
    context = gated.context;
    if (!gated.ok) {
      logAccess(req, context, client, { format: "", profile: false, result: gated.reason, hwid: "", bytes: 0 });
      if (context && gated.reason !== "disabled") {
        void notifyProxySubEvent({ kind: "failure", tokenId: Number(record.id), tokenName: String(record.name || ""), userId: Number(record.userId), detail: `原因：${gated.reason}，来自 ${clientIp(req) || "未知 IP"}（${client.label}）` });
      }
      rejected(res, gated.reason);
      return;
    }
    const { settings, token } = gated.context;
    const panelUrl = await resolvePanelUrl(req);

    // 浏览器打开：落地页（不需要登录；不列节点）。
    const wantsHtml = !options.pathFormat && !req.query.format && !req.query.target
      && String(req.headers.accept || "").includes("text/html") && client.browser;
    if (wantsHtml && settings.landingPageEnabled) {
      const html = await renderLandingPage(req, gated.context, panelUrl);
      logAccess(req, context, client, { format: "html", profile: false, result: "page", hwid: "", bytes: html.length });
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Robots-Tag", "noindex");
      res.status(200).type("text/html; charset=utf-8").send(html);
      return;
    }

    // 限流：先于一切重活。
    const limit = checkProxySubRateLimit({
      tokenId: Number(token.id),
      ip: clientIp(req),
      tokenLimit: settings.rateLimitPerMinute,
      ipLimit: settings.ipRateLimitPerMinute,
    });
    if (limit.limited) {
      logAccess(req, context, client, { format: "", profile: false, result: "rate-limited", hwid: "", bytes: 0 });
      res.setHeader("Retry-After", String(limit.retryAfterSeconds));
      res.status(429).type("text/plain").send("拉取太频繁，稍后再试");
      return;
    }

    // 设备数。
    const device = await deviceGate(req, gated.context, client);
    for (const [name, value] of Object.entries(device.headers)) res.setHeader(name, value);
    if (!device.allowed) {
      logAccess(req, context, client, { format: "", profile: false, result: device.reason || "device-limit", hwid: device.hwid, bytes: 0 });
      rejected(res, device.reason || "device-limit");
      return;
    }

    const format: ProxySubscriptionFormat = requestedFormat(req, options.pathFormat)
      ?? formatFromUserAgent(userAgent, req.query.flag)
      ?? normalizeProxySubscriptionFormat(token.defaultFormat);

    // 同一个令牌提供两种订阅：不带 rules 参数是节点订阅，带上才是规则订阅。
    const rulesParam = String(req.query.rules ?? "").trim().toLowerCase();
    const rulePreset = !rulesParam || rulesParam === "0" || rulesParam === "false"
      ? "off"
      : (rulesParam === "1" || rulesParam === "true"
        ? normalizeProxyRulePreset(token.rulePreset)
        : normalizeProxyRulePreset(rulesParam));
    const profile = !!rulesParam && rulesParam !== "0" && rulesParam !== "false";

    // 查询串上的临时覆盖（subconverter 习惯）：emoji / info / prefix / udp / scv / sort / include / exclude。
    const overrides = queryOverrides(req);
    const tokenOptions = { ...gated.context.options, ...overrides.options };
    const scope = { ...gated.context.scope, ...overrides.scope };

    const template = await resolveTemplateForToken(gated.context, format);
    const renderSettings = settings.rulesetMirror === "panel" && panelUrl
      ? { ...settings, rulesetMirror: panelRulesetMirrorBase(panelUrl) }
      : settings;
    const selfUrl = panelUrl ? `${panelUrl.replace(/\/+$/, "")}${req.originalUrl}` : "";
    const vars = {
      appName: gated.context.appName,
      panelUrl,
      subUrl: selfUrl,
      username: gated.context.username,
      ...proxySubTemplateUserVars(gated.context.info),
    };

    const cacheKey = proxySubCacheKey(Number(token.userId), [
      "v1", token.id, format, rulePreset, profile, client.family, client.version, tokenOptions, scope, template?.id || 0, renderSettings, selfUrl,
      // 信息节点带着用量，用量一直在变；进缓存键的是取整到 10 MB 的值，免得每次都不一样。
      infoNodesWanted(gated.context) ? Math.floor(gated.context.info.trafficUsed / 10_485_760) : -1,
    ]);
    let body = settings.cacheTtlSec > 0 ? getProxySubCached(cacheKey) : null;
    if (body === null) {
      const built = await db.buildProxySubscriptionForToken(Number(token.userId), {
        rulePreset,
        scope,
        options: tokenOptions,
        settings: renderSettings,
        userCustomRules: String(gated.context.owner.proxySubCustomRules || ""),
        template,
        info: infoNodesWanted(gated.context) ? gated.context.info : null,
        vars,
      });
      body = renderProxySubPipeline({
        built,
        format,
        profile,
        profileUrl: selfUrl,
        client,
        settings: renderSettings,
        template,
        vars,
        weightedLoadBalance: clientSupportsWeightedLoadBalance(userAgent),
        shadowrocketClient: client.family === "shadowrocket",
      });
      if (settings.cacheTtlSec > 0) setProxySubCached(cacheKey, body, settings.cacheTtlSec);
    }

    applyHeaders(res, gated.context, { format, profile, panelUrl, token });
    res.status(200).send(body);

    if (!token.lastAccessAt && Number(token.accessCount || 0) === 0) {
      void notifyProxySubEvent({ kind: "first-access", tokenId: Number(token.id), tokenName: String(token.name || ""), userId: Number(token.userId), detail: `${client.label}${client.version ? " " + client.version : ""}，来自 ${clientIp(req) || "未知 IP"}` });
    }
    logAccess(req, context, client, { format, profile, result: "ok", hwid: device.hwid, bytes: Buffer.byteLength(body) });
  } catch (error) {
    console.error("[proxy-subscription] 生成订阅失败:", error);
    /*
      500 也要记：这一种在商家看来和「被停用」完全不同 —— 客户没做错任何事，
      是面板自己出的问题。不记的话，他只会一遍遍让客户重新导入。
    */
    logAccess(req, context, client, { format: "", profile: false, result: "error", hwid: "", bytes: 0 });
    res.status(500).type("text/plain").send("订阅生成失败");
  }
}

/** 查询串上的临时覆盖。只认 0 / 1 和短字符串，别的忽略。 */
function queryOverrides(req: Request): { options: Partial<ProxySubTokenContext["options"]>; scope: Partial<ProxySubTokenContext["scope"]> } {
  const options: Partial<ProxySubTokenContext["options"]> = {};
  const scope: Partial<ProxySubTokenContext["scope"]> = {};
  const flag = (key: string): "on" | "off" | null => {
    const raw = String(req.query[key] ?? "").trim().toLowerCase();
    if (raw === "1" || raw === "true") return "on";
    if (raw === "0" || raw === "false") return "off";
    return null;
  };
  const emoji = flag("emoji");
  if (emoji) options.flagEmoji = emoji;
  const info = flag("info");
  if (info) options.infoNodes = info;
  const prefix = flag("prefix");
  if (prefix) options.protocolPrefix = prefix;
  const udp = flag("udp");
  if (udp) options.udp = udp;
  const scv = flag("scv");
  if (scv) options.skipCertVerify = scv;
  const sort = String(req.query.sort ?? "").trim().toLowerCase();
  if (sort === "name" || sort === "region" || sort === "protocol" || sort === "latency") options.sortMode = sort;
  const include = String(req.query.include ?? "").trim().slice(0, 64);
  if (include) scope.include = include;
  const exclude = String(req.query.exclude ?? "").trim().slice(0, 64);
  if (exclude) scope.exclude = exclude;
  const types = String(req.query.types ?? "").trim().toLowerCase();
  if (types && types !== "all") {
    const list = types.split(/[|,，]/).map((item) => item.trim()).filter(Boolean) as any[];
    if (list.length > 0) scope.protocols = list;
  }
  return { options, scope };
}

async function renderLandingPage(req: Request, context: ProxySubTokenContext, panelUrl: string): Promise<string> {
  const { token, settings } = context;
  const origin = panelUrl || `${req.protocol}://${req.get("host") || ""}`;
  const origins = [origin, ...settings.domains.filter((item) => item.replace(/\/+$/, "") !== origin.replace(/\/+$/, ""))];
  const [deviceCount, built] = await Promise.all([
    db.countProxySubDevices(Number(token.id)),
    db.buildProxySubscriptionForToken(Number(token.userId), {
      rulePreset: "off",
      scope: context.scope,
      options: context.options,
      settings,
      template: null,
      info: null,
      vars: { appName: context.appName, panelUrl, subUrl: "", username: context.username },
    }).catch(() => null),
  ]);
  let qrDataUrl = "";
  try {
    const { toDataURL } = await import("qrcode");
    qrDataUrl = await toDataURL(buildProxySubscriptionUrl({ origin, token: String(token.token), format: "base64", kind: "nodes" }), { margin: 1, width: 360 });
  } catch {
    // 二维码生成不了就不显示，地址照样在。
  }
  return renderProxySubPage({
    appName: context.appName,
    username: context.username,
    tokenName: String(token.name || ""),
    planNames: context.plan.planNames,
    trafficUsed: context.info.trafficUsed,
    trafficLimit: context.info.trafficLimit,
    expiresAt: context.info.expiresAt,
    nextResetAt: context.info.nextResetAt || 0,
    deviceCount,
    deviceLimit: context.deviceLimit,
    nodeCount: built ? built.document.nodes.length : 0,
    announce: settings.announce,
    supportUrl: settings.supportUrl,
    origins,
    token: String(token.token),
    alias: String(token.alias || ""),
    qrDataUrl,
  });
}

/** 显式格式段只认这些名字（和 normalizeProxySubscriptionFormat 的别名一致），别的当成 404。 */
const PATH_FORMATS = new Set<string>([
  ...PROXY_SUBSCRIPTION_FORMATS,
  "mihomo", "meta", "stash", "sing-box", "v2ray-json", "xray", "xray-json", "json", "surfboard", "quanx", "qx", "v2ray",
]);

/**
 * 客户端订阅地址。
 *
 * 这条路由不走登录态：订阅客户端只会带上地址里的令牌。因此令牌本身就是凭据，
 * 长度和随机性由签发处保证，用户可以随时重置。
 */
proxySubscriptionRouter.get("/api/sub/:token", (req: Request, res: Response) => {
  void handleSubscription(req, res, { param: String(req.params.token || ""), byAlias: false });
});

/** 订阅的基本信息（JSON）：给自定义客户端、落地页脚本、排查问题用。不含节点。 */
proxySubscriptionRouter.get("/api/sub/:token/info", async (req: Request, res: Response) => {
  try {
    const record = await findToken(String(req.params.token || ""), false);
    if (!record) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const client = detectProxyClient(String(req.headers["user-agent"] || ""));
    const gated = await gate(req, record, client);
    if (!gated.ok) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const context = gated.context;
    const panelUrl = await resolvePanelUrl(req);
    const [deviceCount, built] = await Promise.all([
      db.countProxySubDevices(Number(record.id)),
      db.buildProxySubscriptionForToken(Number(record.userId), {
        rulePreset: "off",
        scope: context.scope,
        options: context.options,
        settings: context.settings,
        template: null,
        info: null,
        vars: { appName: context.appName, panelUrl, subUrl: "", username: context.username },
      }),
    ]);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      name: String(record.name || ""),
      username: context.username,
      plans: context.plan.planNames,
      upload: 0,
      download: context.info.trafficUsed,
      total: context.info.trafficLimit,
      expire: context.info.expiresAt ? Math.floor(context.info.expiresAt / 1000) : 0,
      nextReset: context.info.nextResetAt ? Math.floor(context.info.nextResetAt / 1000) : 0,
      nodeCount: built.document.nodes.length,
      deviceCount,
      deviceLimit: context.deviceLimit,
      updateIntervalHours: context.settings.updateIntervalHours,
      announce: context.settings.announce,
      supportUrl: context.settings.supportUrl,
      formats: PROXY_SUBSCRIPTION_FORMATS,
      urls: [panelUrl, ...context.settings.domains].filter(Boolean).map((origin) => buildProxySubscriptionUrl({ origin, token: String(record.token), format: "base64", kind: "nodes" })),
    });
  } catch (error) {
    console.error("[proxy-subscription] info 失败:", error);
    res.status(500).json({ error: "internal" });
  }
});

/** 显式格式路径：/api/sub/<token>/clash、/singbox、/v2ray-json…… 不用猜 UA。 */
proxySubscriptionRouter.get("/api/sub/:token/:format", (req: Request, res: Response, next) => {
  const format = String(req.params.format || "").trim().toLowerCase();
  if (!PATH_FORMATS.has(format)) {
    next();
    return;
  }
  void handleSubscription(req, res, { param: String(req.params.token || ""), byAlias: false, pathFormat: format });
});

/** 短链：/s/<alias>。内容和 /api/sub/<token> 完全一样，只是地址短、能手打。 */
proxySubscriptionRouter.get("/s/:alias", (req: Request, res: Response) => {
  void handleSubscription(req, res, { param: String(req.params.alias || ""), byAlias: true });
});

proxySubscriptionRouter.get("/s/:alias/:format", (req: Request, res: Response, next) => {
  const format = String(req.params.format || "").trim().toLowerCase();
  if (!PATH_FORMATS.has(format)) {
    next();
    return;
  }
  void handleSubscription(req, res, { param: String(req.params.alias || ""), byAlias: true, pathFormat: format });
});
