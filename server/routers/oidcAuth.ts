import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { adminProcedure, protectedProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { maskIdentifier } from "./helpers";
import { recordPanelEvent } from "../ops/panelEvents";
import { listUserPasskeys } from "../ops/passkeys";
import { hasUsablePassword } from "../password";
import { OIDC_START_PATH, parseOidcScopes, validateOidcIssuer } from "../../shared/oidcLogin";
import {
  isOidcLoginUsable,
  oidcLoginAdminView,
  planOidcSettingsUpdate,
  readOidcLoginSettings,
} from "../oidcLoginSettings";
import { isGoogleLoginUsable, readGoogleLoginSettings } from "../googleLoginSettings";
import { isDiscordLoginUsable, readDiscordLoginSettings } from "../discordSettings";
import { activeOidcSubOf } from "../oidcLoginService";
import { fetchOidcDiscovery, OidcError, type OidcDiscovery } from "../oidcClient";
import { ASYMMETRIC_JWS_ALGS, importJwks, parseJsonObject } from "../oauthPrimitives";
import { setInitialPasswordForPasswordlessUser } from "../repositories/googleAccountRepository";
import { unlinkOidcAccount } from "../repositories/oidcAccountRepository";
import { oidcProviders } from "../oidcAuthRoute";
import { clientIp } from "../clientIp";
import type { User } from "../../drizzle/schema";

/*
  trpc.oidcAuth.* —— 通用 OIDC 登录的设置、「测试发现」、个人资料里的绑定状态 / 解绑 / 设初始密码。
  浏览器里的跳转（start / callback）在 server/oidcAuthRoute.ts。
  整个路由都不给 API 令牌用（server/ops/apiTokenPolicy.ts）：改 IdP 配置、发出站请求、解绑都只能在网页上做。
*/

function requestIp(ctx: { req: Parameters<typeof clientIp>[0] }) {
  return clientIp(ctx.req, "unknown");
}

function displayName(user: Pick<User, "id" | "name" | "username">) {
  return String(user?.name || user?.username || `#${user?.id}`).slice(0, 60);
}

/**
 * 解绑 OIDC 之后还能不能登录：有能用的密码、通行密钥，或者绑着一个现在开着的 Google / Discord 登录。
 * 只数「现在真能用」的：管理员关了 Google 登录时，绑着 Google 也登不进来。
 */
async function otherSignInMethods(user: User) {
  const all = await db.getAllSettings();
  const password = hasUsablePassword(user.password);
  const passkeys = await listUserPasskeys(user.id).then((items) => items.length).catch(() => 0);
  const google = !!user.googleSub && isGoogleLoginUsable(readGoogleLoginSettings(all));
  const discord = !!user.discordId && isDiscordLoginUsable(readDiscordLoginSettings(all));
  return { password, passkeys, thirdParty: google || discord };
}

function hasOtherMethod(others: Awaited<ReturnType<typeof otherSignInMethods>>) {
  return others.password || others.passkeys > 0 || others.thirdParty;
}

function discoverySummary(discovery: OidcDiscovery) {
  return {
    issuer: discovery.issuer,
    authorizationEndpoint: discovery.authorizationEndpoint,
    tokenEndpoint: discovery.tokenEndpoint,
    jwksUri: discovery.jwksUri,
    userinfoEndpoint: discovery.userinfoEndpoint,
    idTokenSigningAlgs: discovery.idTokenSigningAlgs,
    tokenEndpointAuthMethods: discovery.tokenEndpointAuthMethods,
    codeChallengeMethods: discovery.codeChallengeMethods,
  };
}

/** 「测试发现」顺带给的提醒：不挡保存，只是告诉管理员登录时多半会出什么问题。 */
function discoveryWarnings(discovery: OidcDiscovery, keyCount: number, input: { scopes: string[]; allowHmacTokens: boolean }) {
  const warnings: string[] = [];
  const algs = discovery.idTokenSigningAlgs;
  if (algs.length && !algs.some((alg) => alg === "RS256" || alg === "ES256") && !(input.allowHmacTokens && algs.some((alg) => alg.startsWith("HS")))) {
    warnings.push(`IdP 声明的 ID Token 签名算法是 ${algs.join(", ")}，面板只认 RS256 / ES256：请在 IdP 里把这个客户端的签名算法改成 RS256`);
  }
  if (keyCount === 0) warnings.push("JWKS 里没有面板能用的 RS256 / ES256 公钥");
  if (discovery.codeChallengeMethods.length && !discovery.codeChallengeMethods.includes("S256")) {
    warnings.push("IdP 没有声明支持 PKCE S256：面板仍会带上 code_challenge，若登录失败请在 IdP 里开启 PKCE");
  }
  if (!discovery.userinfoEndpoint) warnings.push("IdP 没有 userinfo 端点：ID Token 里必须直接带上 email");
  const supportedScopes = discovery.scopesSupported;
  const unknownScopes = supportedScopes.length ? input.scopes.filter((scope) => !supportedScopes.includes(scope)) : [];
  if (unknownScopes.length) warnings.push(`IdP 的 scopes_supported 里没有：${unknownScopes.join(", ")}`);
  return warnings;
}

export const oidcAuthRouter = router({
  adminSettings: adminProcedure.query(async () => oidcLoginAdminView(await db.getAllSettings())),

  updateAdminSettings: adminProcedure
    .input(z.object({
      enabled: z.boolean().optional(),
      providerName: z.string().max(64).optional(),
      issuer: z.string().max(512).optional(),
      clientId: z.string().max(256).optional(),
      clientSecret: z.string().max(1024).optional(),
      clearClientSecret: z.boolean().optional(),
      scopes: z.string().max(1000).optional(),
      allowRegistration: z.boolean().optional(),
      requireVerifiedEmail: z.boolean().optional(),
      allowedDomains: z.string().max(2000).optional(),
      allowPrivateNetwork: z.boolean().optional(),
      allowHmacTokens: z.boolean().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const all = await db.getAllSettings();
      const plan = planOidcSettingsUpdate(all, input);
      if (plan.error) throw new TRPCError({ code: "BAD_REQUEST", message: plan.error });
      await db.setSettings(plan.patch);
      // 配置变了就别再用旧的 discovery / 公钥（键里虽然带了 Issuer，清掉更省心）。
      oidcProviders.clear();
      const next = await db.getAllSettings();
      const view = oidcLoginAdminView(next);
      // 只记改了哪些键，不记值（密钥不能进日志）。
      console.info(`[Settings] oidc login updated keys=${Object.keys(plan.patch).join(",") || "-"} enabled=${view.enabled} usable=${view.usable} by userId=${ctx.user.id}`);
      const before = readOidcLoginSettings(all);
      if (input.enabled !== undefined && input.enabled !== before.enabled) {
        void recordPanelEvent({
          kind: "security.oidc_login_toggled",
          level: "info",
          userId: ctx.user.id,
          message: `${displayName(ctx.user)} ${input.enabled ? "开启" : "关闭"}了 OIDC 登录（${view.providerName}）`,
        });
      }
      if (view.issuer !== before.issuer || view.allowPrivateNetwork !== before.allowPrivateNetwork || view.allowHmacTokens !== before.allowHmacTokens) {
        // 换 IdP、放行内网、接受 HS256 都是改「信谁」：单独记一条，事后查得到。
        void recordPanelEvent({
          kind: "security.oidc_login_changed",
          level: "warn",
          userId: ctx.user.id,
          message: `${displayName(ctx.user)} 修改了 OIDC 登录的信任设置：Issuer ${view.issuer || "（空）"}，内网 ${view.allowPrivateNetwork ? "放行" : "不放行"}，HS256 ${view.allowHmacTokens ? "接受" : "不接受"}`,
        });
      }
      return view;
    }),

  /**
   * 「测试发现」：按设置页上（可能还没保存）的 Issuer 拉一次 discovery 和 JWKS，把找到的端点给管理员看。
   * 走和登录完全一样的出站检查（SSRF 防护、内网要勾选才放行、issuer 必须一致）。
   */
  testDiscovery: adminProcedure
    .input(z.object({
      issuer: z.string().max(512).optional(),
      allowPrivateNetwork: z.boolean().optional(),
      scopes: z.string().max(1000).optional(),
      allowHmacTokens: z.boolean().optional(),
    }).optional())
    .mutation(async ({ input, ctx }) => {
      const saved = readOidcLoginSettings(await db.getAllSettings());
      const issuer = String(input?.issuer ?? saved.issuer).trim();
      const allowPrivateNetwork = input?.allowPrivateNetwork ?? saved.allowPrivateNetwork;
      const problem = validateOidcIssuer(issuer, { allowHttp: allowPrivateNetwork });
      if (problem) return { ok: false as const, message: problem };
      const http = oidcProviders.http({ issuer, allowPrivateNetwork });
      try {
        const discovery = await fetchOidcDiscovery(issuer, { http, allowHttp: allowPrivateNetwork });
        let keyCount = 0;
        let jwksError: string | null = null;
        try {
          // 只为数一数能用的钥匙，不进登录用的那份公钥缓存。
          const response = await http(discovery.jwksUri, { method: "GET", purpose: "OIDC JWKS" });
          if (response.status !== 200) jwksError = `JWKS 返回 HTTP ${response.status}`;
          else keyCount = importJwks(parseJsonObject(response.body.toString("utf8")), ASYMMETRIC_JWS_ALGS).length;
        } catch {
          jwksError = "拉取 JWKS 失败";
        }
        const scopes = (input?.scopes !== undefined ? parseOidcScopes(input.scopes) : null) || saved.scopes;
        const warnings = discoveryWarnings(discovery, keyCount, { scopes, allowHmacTokens: input?.allowHmacTokens ?? saved.allowHmacTokens });
        if (jwksError) warnings.unshift(jwksError);
        console.info(`[OidcAuth] discovery test ok by userId=${ctx.user.id} keys=${keyCount}`);
        return { ok: true as const, discovery: discoverySummary(discovery), keyCount, warnings };
      } catch (error) {
        const message = error instanceof OidcError ? error.message : "测试失败";
        console.warn(`[OidcAuth] discovery test failed by userId=${ctx.user.id}: ${message}`);
        return { ok: false as const, message };
      }
    }),

  status: protectedProcedure.query(async ({ ctx }) => {
    const settings = readOidcLoginSettings(await db.getAllSettings());
    const user = ctx.user;
    const others = await otherSignInMethods(user);
    const anyBinding = !!user.oidcSub;
    // 绑着的是旧 Issuer 的身份：已经不能用来登录，显示成「未绑定」，并提示可以重新绑定。
    const linked = anyBinding && !!activeOidcSubOf(user, settings.issuer);
    return {
      enabled: isOidcLoginUsable(settings),
      providerName: settings.providerName,
      linked,
      staleBinding: anyBinding && !linked,
      email: anyBinding ? (user.oidcEmail || null) : null,
      linkedAt: anyBinding ? (user.oidcLinkedAt || null) : null,
      hasPassword: others.password,
      passkeyCount: others.passkeys,
      canUnlink: anyBinding && hasOtherMethod(others),
      panelPublicUrl: settings.panelBaseUrl,
      linkStartUrl: settings.panelBaseUrl ? `${settings.panelBaseUrl}${OIDC_START_PATH}?mode=link&redirect=%2Fprofile` : "",
    };
  }),

  unlink: protectedProcedure.mutation(async ({ ctx }) => {
    const user = ctx.user;
    if (!user.oidcSub) throw new TRPCError({ code: "BAD_REQUEST", message: "当前账号没有绑定 OIDC 账号" });
    const others = await otherSignInMethods(user);
    if (!hasOtherMethod(others)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "解除绑定前请先设置登录密码（或添加通行密钥）：不然这个账号就没有别的办法登录了" });
    }
    await unlinkOidcAccount(user.id);
    console.info(`[OidcAuth] unlinked userId=${user.id} ip=${requestIp(ctx)}`);
    void recordPanelEvent({
      kind: "account.oidc_unlinked",
      level: "info",
      userId: user.id,
      message: `${displayName(user)} 解除了 OIDC 账号 ${maskIdentifier(user.oidcEmail || "")} 的绑定`,
      data: { ip: requestIp(ctx) },
    });
    return { success: true as const };
  }),

  /** OIDC 注册的账号第一次设密码（不用旧密码 —— 本来就没有）。已经有密码的走「修改密码」。 */
  setInitialPassword: protectedProcedure
    .input(z.object({ newPassword: z.string().min(6, "密码至少 6 个字符").max(128) }))
    .mutation(async ({ input, ctx }) => {
      const user = ctx.user;
      if (hasUsablePassword(user.password) || !(await setInitialPasswordForPasswordlessUser(user.id, input.newPassword))) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "这个账号已经有登录密码了，请用「修改密码」" });
      }
      console.info(`[OidcAuth] initial password set userId=${user.id}`);
      void recordPanelEvent({
        kind: "account.password_set",
        level: "info",
        userId: user.id,
        message: `${displayName(user)} 给 OIDC 注册的账号设置了登录密码`,
        data: { ip: requestIp(ctx) },
      });
      return { success: true as const };
    }),
});
