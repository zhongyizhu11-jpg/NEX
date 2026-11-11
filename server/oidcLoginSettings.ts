/*
  通用 OIDC 登录的几项系统设置（存在 system_settings 里）：

    oidcLoginEnabled           "true" / 其它    总开关，默认关
    oidcProviderName           按钮上显示的名字（「使用 <名字> 登录」），默认 OIDC
    oidcIssuer                 Issuer 地址，原样保存（discovery 返回的 issuer 必须和它一字不差）
    oidcClientId               客户端 ID
    oidcClientSecret           客户端密钥（落库加密，见 server/settingsSecretKeys.ts；读出去时打码；交回打码值 = 不改）
                               可以留空：IdP 那边建的是「公开客户端」时只靠 PKCE
    oidcScopes                 空 = openid email profile
    oidcAllowRegistration      "true" / 其它    没绑定过的账号能不能直接注册新账号，默认不能
    oidcRequireVerifiedEmail   "false" / 其它   只接受 email_verified 为 true 的账号，默认开
    oidcAllowedDomains         逗号分隔的邮箱域名，空 = 不限
    oidcAllowPrivateNetwork    "true" / 其它    IdP 在内网：放行内网地址（默认只连公网，防 SSRF）
    oidcAllowHmacTokens        "true" / 其它    接受用客户端密钥签的 HS256/384/512 ID Token，默认不接受

  「真正能用」= 开关开着 + Issuer 合法 + 客户端 ID 填了 + 配了面板公开地址（回调地址要用它拼）。
*/
import crypto from "node:crypto";
import { maskSecret } from "./ddns";
import { resolveSecretUpdate } from "./googleLoginSettings";
import { isGoogleAcceptableRedirectBase, normalizePanelBaseUrl, parseEmailDomainList } from "../shared/googleLogin";
import {
  buildOidcRedirectUri,
  normalizeOidcProviderName,
  OIDC_DEFAULT_SCOPES,
  parseOidcScopes,
  validateOidcIssuer,
} from "../shared/oidcLogin";

export const OIDC_SETTING_KEYS = {
  enabled: "oidcLoginEnabled",
  providerName: "oidcProviderName",
  issuer: "oidcIssuer",
  clientId: "oidcClientId",
  clientSecret: "oidcClientSecret",
  scopes: "oidcScopes",
  allowRegistration: "oidcAllowRegistration",
  requireVerifiedEmail: "oidcRequireVerifiedEmail",
  allowedDomains: "oidcAllowedDomains",
  allowPrivateNetwork: "oidcAllowPrivateNetwork",
  allowHmacTokens: "oidcAllowHmacTokens",
} as const;

export type OidcLoginSettings = {
  enabled: boolean;
  providerName: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  allowRegistration: boolean;
  requireVerifiedEmail: boolean;
  allowedDomains: string[];
  allowPrivateNetwork: boolean;
  allowHmacTokens: boolean;
  panelBaseUrl: string;
  redirectUri: string;
};

type SettingsMap = Record<string, string | null | undefined>;

export function readOidcLoginSettings(all: SettingsMap): OidcLoginSettings {
  const panelBaseUrl = normalizePanelBaseUrl(all.panelPublicUrl);
  return {
    enabled: all[OIDC_SETTING_KEYS.enabled] === "true",
    providerName: normalizeOidcProviderName(all[OIDC_SETTING_KEYS.providerName]),
    issuer: String(all[OIDC_SETTING_KEYS.issuer] || "").trim(),
    clientId: String(all[OIDC_SETTING_KEYS.clientId] || "").trim(),
    clientSecret: String(all[OIDC_SETTING_KEYS.clientSecret] || "").trim(),
    scopes: parseOidcScopes(all[OIDC_SETTING_KEYS.scopes]) || parseOidcScopes(OIDC_DEFAULT_SCOPES)!,
    allowRegistration: all[OIDC_SETTING_KEYS.allowRegistration] === "true",
    requireVerifiedEmail: all[OIDC_SETTING_KEYS.requireVerifiedEmail] !== "false",
    allowedDomains: parseEmailDomainList(all[OIDC_SETTING_KEYS.allowedDomains]),
    allowPrivateNetwork: all[OIDC_SETTING_KEYS.allowPrivateNetwork] === "true",
    allowHmacTokens: all[OIDC_SETTING_KEYS.allowHmacTokens] === "true",
    panelBaseUrl,
    redirectUri: buildOidcRedirectUri(panelBaseUrl),
  };
}

export function isOidcLoginConfigured(settings: OidcLoginSettings) {
  if (!settings.clientId || !settings.redirectUri) return false;
  if (validateOidcIssuer(settings.issuer, { allowHttp: settings.allowPrivateNetwork })) return false;
  // HS* 令牌拿客户端密钥当钥匙：开了这一项却没有密钥，等于什么都验不了。
  if (settings.allowHmacTokens && !settings.clientSecret) return false;
  return true;
}

/** 登录页能不能显示「使用 … 登录」。 */
export function isOidcLoginUsable(settings: OidcLoginSettings) {
  return settings.enabled && isOidcLoginConfigured(settings);
}

/**
 * 发起登录时的配置指纹。回调时重新算一遍：管理员中途换了 Issuer / 客户端 / 密钥 / 回调地址 / scope / 验签方式，
 * 这次登录就作废（不拿旧配置下拿到的授权码去换票）。只存哈希，看不出密钥。
 */
export function oidcConfigFingerprint(settings: OidcLoginSettings) {
  return crypto.createHash("sha256")
    .update(JSON.stringify([
      settings.issuer, settings.clientId, settings.clientSecret, settings.redirectUri,
      settings.scopes.join(" "), settings.allowPrivateNetwork, settings.allowHmacTokens,
    ]))
    .digest("base64url");
}

/** 管理员设置页看到的样子：密钥只给打码值。 */
export function oidcLoginAdminView(all: SettingsMap) {
  const settings = readOidcLoginSettings(all);
  return {
    enabled: settings.enabled,
    providerName: settings.providerName,
    issuer: settings.issuer,
    clientId: settings.clientId,
    clientSecretMasked: maskSecret(settings.clientSecret),
    clientSecretSet: !!settings.clientSecret,
    scopes: settings.scopes.join(" "),
    allowRegistration: settings.allowRegistration,
    requireVerifiedEmail: settings.requireVerifiedEmail,
    allowedDomains: settings.allowedDomains.join(", "),
    allowPrivateNetwork: settings.allowPrivateNetwork,
    allowHmacTokens: settings.allowHmacTokens,
    panelPublicUrl: settings.panelBaseUrl,
    redirectUri: settings.redirectUri,
    // 面板地址是 http 时 IdP 多半不收这个回调地址（Pocket ID / Authelia 都要 https），设置页提示一句。
    redirectUriInsecure: !!settings.panelBaseUrl && !isGoogleAcceptableRedirectBase(settings.panelBaseUrl),
    usable: isOidcLoginUsable(settings),
  };
}

export type OidcSettingsUpdateInput = {
  enabled?: boolean;
  providerName?: string;
  issuer?: string;
  clientId?: string;
  clientSecret?: string;
  clearClientSecret?: boolean;
  scopes?: string;
  allowRegistration?: boolean;
  requireVerifiedEmail?: boolean;
  allowedDomains?: string;
  allowPrivateNetwork?: boolean;
  allowHmacTokens?: boolean;
};

/**
 * 算出要写进设置表的键值，以及一条要给管理员看的错误（有错误就什么都不写）。
 * 纯函数：调用方负责真正写库。
 */
export function planOidcSettingsUpdate(all: SettingsMap, input: OidcSettingsUpdateInput) {
  const current = readOidcLoginSettings(all);
  const patch: Record<string, string | null> = {};
  const fail = (error: string) => ({ error, patch: {} as Record<string, string | null> });

  if (input.allowPrivateNetwork !== undefined) patch[OIDC_SETTING_KEYS.allowPrivateNetwork] = input.allowPrivateNetwork ? "true" : "false";
  const allowHttp = input.allowPrivateNetwork ?? current.allowPrivateNetwork;

  if (input.providerName !== undefined) {
    const name = input.providerName.trim();
    patch[OIDC_SETTING_KEYS.providerName] = name ? normalizeOidcProviderName(name) : null;
  }
  if (input.issuer !== undefined) {
    const issuer = input.issuer.trim();
    if (issuer) {
      const problem = validateOidcIssuer(issuer, { allowHttp });
      if (problem) return fail(problem);
    }
    patch[OIDC_SETTING_KEYS.issuer] = issuer || null;
  } else if (input.allowPrivateNetwork === false && current.issuer && validateOidcIssuer(current.issuer, { allowHttp: false })) {
    // 取消「IdP 在内网」时，已经存着的 http Issuer 就不合规了：要么一起改成 https，要么别取消。
    return fail("当前 Issuer 是 http 地址：取消「IdP 在内网」前请先把 Issuer 改成 https");
  }
  if (input.clientId !== undefined) {
    const clientId = input.clientId.trim();
    if (clientId && !/^[\x21-\x7e]{1,256}$/.test(clientId)) return fail("客户端 ID 格式不对：不能有空格或中文");
    patch[OIDC_SETTING_KEYS.clientId] = clientId || null;
  }
  const secret = resolveSecretUpdate(current.clientSecret, input.clientSecret, input.clearClientSecret);
  if (secret !== undefined) {
    if (secret && secret.length > 512) return fail("客户端密钥太长");
    patch[OIDC_SETTING_KEYS.clientSecret] = secret;
  }
  if (input.scopes !== undefined) {
    const scopes = parseOidcScopes(input.scopes);
    if (!scopes) return fail("Scope 格式不对：用空格分隔，例如 openid email profile");
    const joined = scopes.join(" ");
    patch[OIDC_SETTING_KEYS.scopes] = joined === OIDC_DEFAULT_SCOPES ? null : joined;
  }
  if (input.allowRegistration !== undefined) patch[OIDC_SETTING_KEYS.allowRegistration] = input.allowRegistration ? "true" : "false";
  if (input.requireVerifiedEmail !== undefined) patch[OIDC_SETTING_KEYS.requireVerifiedEmail] = input.requireVerifiedEmail ? "true" : "false";
  if (input.allowHmacTokens !== undefined) patch[OIDC_SETTING_KEYS.allowHmacTokens] = input.allowHmacTokens ? "true" : "false";
  if (input.allowedDomains !== undefined) {
    const raw = input.allowedDomains.trim();
    const domains = parseEmailDomainList(raw);
    if (raw && !domains.length) return fail("允许的邮箱域名格式不对，例如 example.com, corp.example.org");
    patch[OIDC_SETTING_KEYS.allowedDomains] = domains.length ? domains.join(",") : null;
  }

  const next = readOidcLoginSettings({ ...all, ...patch });
  if (next.allowHmacTokens && !next.clientSecret) return fail("接受 HS256 签名的 ID Token 要用客户端密钥验签：请先填好客户端密钥");
  const willEnable = input.enabled ?? current.enabled;
  if (willEnable && (input.enabled !== undefined || Object.keys(patch).length)) {
    if (!next.panelBaseUrl) return fail("请先在「面板地址」里填好面板公开地址：回调地址要用它拼出来");
    if (!next.issuer) return fail("开启前请先填好 Issuer 地址");
    const problem = validateOidcIssuer(next.issuer, { allowHttp: next.allowPrivateNetwork });
    if (problem) return fail(problem);
    if (!next.clientId) return fail("开启前请先填好客户端 ID");
  }
  if (input.enabled !== undefined) patch[OIDC_SETTING_KEYS.enabled] = input.enabled ? "true" : "false";
  return { error: null as string | null, patch };
}
