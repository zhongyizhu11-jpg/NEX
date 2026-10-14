import express, { type Request, type Response } from "express";

import * as db from "./db";
import { resolvePanelUrl } from "./agentPanelUrl";
import {
  formatProxySubscriptionUserInfo,
  normalizeProxySubscriptionFormat,
  PROXY_SUBSCRIPTION_FORMAT_CONTENT_TYPES,
  renderProxySubscription,
  type ProxySubscriptionFormat,
} from "../shared/proxySubscription";
import { normalizeProxyRulePreset } from "../shared/proxyRuleset";
import { proxySubscriptionProfileHeaders, proxySubscriptionProfileName } from "../shared/proxyClientImport";
import { proxyCredentialRecipientActive } from "./repositories/proxyInboundRepository";

export const proxySubscriptionRouter = express.Router();

/**
 * 各家客户端拉订阅时不会带 format 参数，只能靠 User-Agent 区分。识别不出来时
 * 回落到令牌上配置的默认格式，而不是猜。
 */
function formatFromUserAgent(userAgent: string): ProxySubscriptionFormat | null {
  const ua = userAgent.toLowerCase();
  if (!ua) return null;
  if (ua.includes("clash") || ua.includes("mihomo") || ua.includes("stash")) return "clash";
  if (ua.includes("sing-box") || ua.includes("singbox")) return "singbox";
  if (ua.includes("loon")) return "loon";
  // Surfboard 用 Surge 的配置格式，两者归一。
  if (ua.includes("surge") || ua.includes("surfboard")) return "surge";
  // QX 的 UA 里域名部分是 URL 编码的 "Quantumult%20X"。
  if (ua.includes("quantumult")) return "quantumultx";
  // 下面这些吃通用 base64。不认它们的话会掉到令牌默认格式上 ——
  // 默认设成 Clash 的话，Shadowrocket 会收到一份它读不懂的 Clash YAML。
  // Shadowrocket 的节点订阅就是 base64；单列一种格式是为了规则订阅能给它完整配置。
  if (ua.includes("shadowrocket")) return "shadowrocket";
  if (ua.includes("hiddify")) return "base64";
  if (ua.includes("v2rayng") || ua.includes("v2rayn")) return "base64";
  if (ua.includes("nekobox") || ua.includes("nekoray")) return "base64";
  return null;
}

function clientIp(req: Request): string {
  // 用 req.ip：它按面板的 trust proxy 设置解析 X-Forwarded-For。直接读这个头的话，
  // 谁都能在请求里写一个假 IP，「谁在拉这个订阅」的记录就不可信了。
  return req.ip || "";
}

/**
 * 客户端订阅地址。
 *
 * 这条路由不走登录态：订阅客户端只会带上地址里的令牌。因此令牌本身就是凭据，
 * 长度和随机性由签发处保证，用户可以随时重置。
 */
/** 记一笔时要留的来路。成功和失败两条路共用，免得两边记的东西不一样。 */
function clientInfo(req: Request) {
  return { ip: clientIp(req), userAgent: String(req.headers["user-agent"] || "") };
}

proxySubscriptionRouter.get("/api/sub/:token", async (req: Request, res: Response) => {
  // 出错时也要能记到那一行上，所以 id 提到 try 外面。
  let tokenRowId = 0;
  try {
    const token = String(req.params.token || "").trim();
    if (!token) {
      res.status(404).type("text/plain").send("订阅不存在");
      return;
    }

    const record = await db.getProxySubTokenByToken(token);
    tokenRowId = Number(record?.id || 0);
    /**
     * 令牌无效与被停用统一返回 404，避免把「这个令牌存在但停用了」的信息泄露出去。
     *
     * 但**面板这边要记下来**：给客户端的回应必须一样含糊，给商家的记录不必 ——
     * 「客户说订阅更新不了」这句话，只有记下被拒的那一次和原因才回答得了。
     * 令牌根本不存在的那一种记不了：没有任何一行能挂上这笔记录。
     */
    if (!record || !record.isEnabled) {
      if (record) void db.recordProxySubTokenFailure(Number(record.id), "disabled", clientInfo(req));
      res.status(404).type("text/plain").send("订阅不存在");
      return;
    }
    const expiresAt = record.expiresAt ? new Date(record.expiresAt as any).getTime() : 0;
    if (expiresAt && expiresAt <= Date.now()) {
      void db.recordProxySubTokenFailure(Number(record.id), "token-expired", clientInfo(req));
      res.status(404).type("text/plain").send("订阅不存在");
      return;
    }

    const requested = String(req.query.format || req.query.target || "").trim();
    const format: ProxySubscriptionFormat = requested
      ? normalizeProxySubscriptionFormat(requested)
      : formatFromUserAgent(String(req.headers["user-agent"] || ""))
        ?? normalizeProxySubscriptionFormat(record.defaultFormat);

    // 同一个令牌提供两种订阅：不带 rules 参数是节点订阅，带上才是规则订阅。
    // 这样换一种不必重新签发地址，Loon 这类要自己配分流的客户端也不受影响。
    const rulesParam = String(req.query.rules ?? "").trim().toLowerCase();
    const rulePreset = !rulesParam || rulesParam === "0" || rulesParam === "false"
      ? "off"
      : (rulesParam === "1" || rulesParam === "true"
        ? normalizeProxyRulePreset(record.rulePreset)
        : normalizeProxyRulePreset(rulesParam));

    /**
     * 订阅本身的资格：和落地机那边用**同一把尺子**（proxyCredentialRecipientActive）。
     *
     * 原来这里只看「有没有订阅权限」，不看账号有没有停用、有没有到期 —— 于是
     * 到期的租户照样拉得到一份列着全部节点的订阅，页头还老老实实写着他已经过期。
     * 落地机那边早就把他的凭据拿掉了，所以他看到的是一排连不上的节点，而界面上
     * 看不出为什么。两处判定必须一致，否则「到期就停服」这句话只兑现了一半。
     *
     * 与令牌无效同样返回 404，不泄露「这个令牌存在但没资格」。
     */
    const owner = await db.getUserById(Number(record.userId));
    if (!proxyCredentialRecipientActive(owner as any)) {
      // 商家最需要看到的就是这一条：客户在拉，被挡在「账号没资格」上（到期/超流量/权限收回）。
      void db.recordProxySubTokenFailure(Number(record.id), "not-eligible", clientInfo(req));
      res.status(404).type("text/plain").send("订阅不存在");
      return;
    }

    const document = await db.getProxySubscriptionDocumentForUser(Number(record.userId), { rulePreset });
    // 带 rules 参数就是规则订阅：Surge / Loon / QX / Shadowrocket 此时给完整配置。
    const profile = !!rulesParam && rulesParam !== "0" && rulesParam !== "false";
    // 后台配置了面板公网地址时以它为准，不从请求头推断。
    const panelUrl = await resolvePanelUrl(req);
    const body = renderProxySubscription(document, format, {
      profile,
      profileUrl: panelUrl ? `${panelUrl.replace(/\/+$/, "")}${req.originalUrl}` : "",
      shadowrocketClient: formatFromUserAgent(String(req.headers["user-agent"] || "")) === "shadowrocket",
    });

    {
      const used = Number(owner.trafficUsed || 0);
      const userExpiresAt = owner.expiresAt ? new Date(owner.expiresAt as any).getTime() : 0;
      res.setHeader(
        "Subscription-Userinfo",
        formatProxySubscriptionUserInfo({
          // 面板只记录总量，没有分上下行的口径，全部计入 download 以免客户端重复累加。
          upload: 0,
          download: used,
          total: Number(owner.trafficLimit || 0),
          expire: userExpiresAt ? Math.floor(userExpiresAt / 1000) : 0,
        }),
      );
    }

    res.setHeader("Content-Type", PROXY_SUBSCRIPTION_FORMAT_CONTENT_TYPES[format]);
    res.setHeader("Profile-Update-Interval", "12");
    // 不带 name 参数导入的客户端按这个给订阅起名：用户名，规则订阅加「规则」。
    for (const [header, value] of Object.entries(proxySubscriptionProfileHeaders(
      proxySubscriptionProfileName(String((owner as any).username || ""), profile ? "rules" : "nodes"),
    ))) res.setHeader(header, value);
    // 订阅内容随转发增删而变，缓存会让用户以为新建的转发没生效。
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(body);

    // 记录访问失败不应该影响已经发出的订阅内容。
    void db.recordProxySubTokenAccess(Number(record.id), clientInfo(req)).catch(() => {});
  } catch (error) {
    console.error("[proxy-subscription] 生成订阅失败:", error);
    /*
      500 也要记：这一种在商家看来和「被停用」完全不同 —— 客户没做错任何事，
      是面板自己出的问题。不记的话，他只会一遍遍让客户重新导入。
    */
    if (tokenRowId > 0) void db.recordProxySubTokenFailure(tokenRowId, "error", clientInfo(req)).catch(() => {});
    res.status(500).type("text/plain").send("订阅生成失败");
  }
});
