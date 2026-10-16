/*
  Google 登录的几项系统设置（存在 system_settings 里）：

    googleLoginEnabled        "true" / 其它    总开关，默认关
    googleClientId            OAuth 客户端 ID
    googleClientSecret        OAuth 客户端密钥（读出去时打码；交回打码值 = 不改）
    googleAllowRegistration   "true" / 其它    没绑定过的 Google 账号能不能直接注册新账号，默认不能
    googleAllowedDomains      逗号分隔的邮箱域名，空 = 不限

  「真正能用」= 开关开着 + ID / 密钥都填了 + 配了面板公开地址（回调地址要用它拼）。
*/
import { maskSecret } from "./ddns";
import { buildGoogleRedirectUri, normalizePanelBaseUrl, parseEmailDomainList } from "../shared/googleLogin";

export const GOOGLE_SETTING_KEYS = {
  enabled: "googleLoginEnabled",
  clientId: "googleClientId",
  clientSecret: "googleClientSecret",
  allowRegistration: "googleAllowRegistration",
  allowedDomains: "googleAllowedDomains",
} as const;

export type GoogleLoginSettings = {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  allowRegistration: boolean;
  allowedDomains: string[];
  panelBaseUrl: string;
  redirectUri: string;
};

export function readGoogleLoginSettings(all: Record<string, string | null | undefined>): GoogleLoginSettings {
  const panelBaseUrl = normalizePanelBaseUrl(all.panelPublicUrl);
  return {
    enabled: all[GOOGLE_SETTING_KEYS.enabled] === "true",
    clientId: String(all[GOOGLE_SETTING_KEYS.clientId] || "").trim(),
    clientSecret: String(all[GOOGLE_SETTING_KEYS.clientSecret] || "").trim(),
    allowRegistration: all[GOOGLE_SETTING_KEYS.allowRegistration] === "true",
    allowedDomains: parseEmailDomainList(all[GOOGLE_SETTING_KEYS.allowedDomains]),
    panelBaseUrl,
    redirectUri: buildGoogleRedirectUri(panelBaseUrl),
  };
}

export function isGoogleLoginConfigured(settings: GoogleLoginSettings) {
  return !!(settings.clientId && settings.clientSecret && settings.redirectUri);
}

/** 登录页能不能显示「使用 Google 登录」。 */
export function isGoogleLoginUsable(settings: GoogleLoginSettings) {
  return settings.enabled && isGoogleLoginConfigured(settings);
}

/** 管理员设置页看到的样子：密钥只给打码值。 */
export function googleLoginAdminView(all: Record<string, string | null | undefined>) {
  const settings = readGoogleLoginSettings(all);
  return {
    enabled: settings.enabled,
    clientId: settings.clientId,
    clientSecretMasked: maskSecret(settings.clientSecret),
    clientSecretSet: !!settings.clientSecret,
    allowRegistration: settings.allowRegistration,
    allowedDomains: settings.allowedDomains.join(", "),
    panelPublicUrl: settings.panelBaseUrl,
    redirectUri: settings.redirectUri,
    usable: isGoogleLoginUsable(settings),
  };
}

/**
 * 交回来的密钥怎么处理：
 * - 明确要清空 → null（删掉）
 * - 没给、空串、或者原样交回打码值 → undefined（不改）
 * - 其它 → 新值
 */
export function resolveSecretUpdate(current: string, submitted: string | null | undefined, clear?: boolean): string | null | undefined {
  if (clear) return null;
  const text = String(submitted ?? "").trim();
  if (!text) return undefined;
  if (current && text === maskSecret(current)) return undefined;
  // 打码值的样子（中间一串 *）不可能是真的密钥：别把打码值当新密钥存进去。
  if (/\*{4,}/.test(text)) return undefined;
  return text;
}

export type GoogleSettingsUpdateInput = {
  enabled?: boolean;
  clientId?: string;
  clientSecret?: string;
  clearClientSecret?: boolean;
  allowRegistration?: boolean;
  allowedDomains?: string;
};

/**
 * 算出要写进设置表的键值，以及一条要给管理员看的错误（有错误就什么都不写）。
 * 纯函数：调用方负责真正写库。
 */
export function planGoogleSettingsUpdate(all: Record<string, string | null | undefined>, input: GoogleSettingsUpdateInput) {
  const current = readGoogleLoginSettings(all);
  const patch: Record<string, string | null> = {};
  if (input.clientId !== undefined) {
    const clientId = input.clientId.trim();
    if (clientId && !/^[A-Za-z0-9._-]{8,256}$/.test(clientId)) {
      return { error: "客户端 ID 格式不对：应当形如 1234567890-xxxx.apps.googleusercontent.com", patch: {} };
    }
    patch[GOOGLE_SETTING_KEYS.clientId] = clientId || null;
  }
  const secret = resolveSecretUpdate(current.clientSecret, input.clientSecret, input.clearClientSecret);
  if (secret !== undefined) {
    if (secret && secret.length > 256) return { error: "客户端密钥太长", patch: {} };
    patch[GOOGLE_SETTING_KEYS.clientSecret] = secret;
  }
  if (input.allowRegistration !== undefined) patch[GOOGLE_SETTING_KEYS.allowRegistration] = input.allowRegistration ? "true" : "false";
  if (input.allowedDomains !== undefined) {
    const raw = input.allowedDomains.trim();
    const domains = parseEmailDomainList(raw);
    if (raw && !domains.length) return { error: "允许的邮箱域名格式不对，例如 example.com, corp.example.org", patch: {} };
    patch[GOOGLE_SETTING_KEYS.allowedDomains] = domains.length ? domains.join(",") : null;
  }
  if (input.enabled !== undefined) {
    if (input.enabled) {
      const next = readGoogleLoginSettings({ ...all, ...patch });
      if (!next.panelBaseUrl) return { error: "请先在「面板地址」里填好面板公开地址：Google 回调地址要用它拼出来", patch: {} };
      if (!next.clientId || !next.clientSecret) return { error: "开启前请先填好客户端 ID 和客户端密钥", patch: {} };
    }
    patch[GOOGLE_SETTING_KEYS.enabled] = input.enabled ? "true" : "false";
  }
  return { error: null as string | null, patch };
}
