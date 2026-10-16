/*
  Discord 的系统设置（存在 system_settings 里），登录和通知机器人两块：

  登录（OAuth2）
    discordLoginEnabled        "true" / 其它    总开关，默认关
    discordClientId            应用的 Client ID（一串数字）
    discordClientSecret        Client Secret（读出去时打码；交回打码值 = 不改）
    discordAllowRegistration   "true" / 其它    没绑定过的 Discord 账号能不能直接注册新账号，默认不能
    discordAllowedDomains      逗号分隔的邮箱域名，空 = 不限

  通知机器人（只用 REST 发私信，不连 Gateway）
    discordBotEnabled          "true" / 其它    总开关，默认关
    discordBotToken            Bot Token（读出去时打码）
    discordBotUsername         保存 Token 时向 Discord 查到的机器人名字，只用来显示
    discordHostStatusNotify    "true" / 其它    主机上下线通知发不发到 Discord（管理员）
    discordExpiryReminder      "true" / 其它    到期提醒
    discordTrafficReminder     "true" / 其它    流量提醒（阈值、提前天数沿用 Telegram 那边的设置）

  登录「真正能用」= 开关开着 + ID / 密钥都填了 + 面板公开地址是 https（本机例外）。
*/
import { maskSecret } from "./ddns";
import { normalizePanelBaseUrl, parseEmailDomainList } from "../shared/googleLogin";
import { buildDiscordRedirectUri, isDiscordAcceptableRedirectBase } from "../shared/discordLogin";
import { resolveSecretUpdate } from "./googleLoginSettings";

export const DISCORD_SETTING_KEYS = {
  enabled: "discordLoginEnabled",
  clientId: "discordClientId",
  clientSecret: "discordClientSecret",
  allowRegistration: "discordAllowRegistration",
  allowedDomains: "discordAllowedDomains",
  botEnabled: "discordBotEnabled",
  botToken: "discordBotToken",
  botUsername: "discordBotUsername",
  hostStatusNotify: "discordHostStatusNotify",
  expiryReminder: "discordExpiryReminder",
  trafficReminder: "discordTrafficReminder",
} as const;

type SettingsMap = Record<string, string | null | undefined>;

export type DiscordLoginSettings = {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  allowRegistration: boolean;
  allowedDomains: string[];
  panelBaseUrl: string;
  redirectUri: string;
};

export function readDiscordLoginSettings(all: SettingsMap): DiscordLoginSettings {
  const panelBaseUrl = normalizePanelBaseUrl(all.panelPublicUrl);
  return {
    enabled: all[DISCORD_SETTING_KEYS.enabled] === "true",
    clientId: String(all[DISCORD_SETTING_KEYS.clientId] || "").trim(),
    clientSecret: String(all[DISCORD_SETTING_KEYS.clientSecret] || "").trim(),
    allowRegistration: all[DISCORD_SETTING_KEYS.allowRegistration] === "true",
    allowedDomains: parseEmailDomainList(all[DISCORD_SETTING_KEYS.allowedDomains]),
    panelBaseUrl,
    redirectUri: buildDiscordRedirectUri(panelBaseUrl),
  };
}

export function isDiscordLoginConfigured(settings: DiscordLoginSettings) {
  // 面板地址后来改成 http 时，按没配好处理，登录页不显示按钮
  return !!(settings.clientId && settings.clientSecret && settings.redirectUri && isDiscordAcceptableRedirectBase(settings.panelBaseUrl));
}

/** 登录页能不能显示「使用 Discord 登录」。 */
export function isDiscordLoginUsable(settings: DiscordLoginSettings) {
  return settings.enabled && isDiscordLoginConfigured(settings);
}

export type DiscordBotSettings = {
  enabled: boolean;
  token: string;
  botUsername: string;
  hostStatusNotify: boolean;
  expiryReminder: boolean;
  trafficReminder: boolean;
};

export function readDiscordBotSettings(all: SettingsMap): DiscordBotSettings {
  return {
    enabled: all[DISCORD_SETTING_KEYS.botEnabled] === "true",
    token: String(all[DISCORD_SETTING_KEYS.botToken] || "").trim(),
    botUsername: String(all[DISCORD_SETTING_KEYS.botUsername] || "").trim().slice(0, 64),
    hostStatusNotify: all[DISCORD_SETTING_KEYS.hostStatusNotify] === "true",
    expiryReminder: all[DISCORD_SETTING_KEYS.expiryReminder] === "true",
    trafficReminder: all[DISCORD_SETTING_KEYS.trafficReminder] === "true",
  };
}

/** 机器人能不能发私信：开关开着 + 有 Token。 */
export function isDiscordBotReadyFromSettings(all: SettingsMap) {
  const bot = readDiscordBotSettings(all);
  return bot.enabled && !!bot.token;
}

/** 管理员设置页看到的样子：密钥和 Token 只给打码值。 */
export function discordAdminView(all: SettingsMap) {
  const settings = readDiscordLoginSettings(all);
  const bot = readDiscordBotSettings(all);
  return {
    login: {
      enabled: settings.enabled,
      clientId: settings.clientId,
      clientSecretMasked: maskSecret(settings.clientSecret),
      clientSecretSet: !!settings.clientSecret,
      allowRegistration: settings.allowRegistration,
      allowedDomains: settings.allowedDomains.join(", "),
      panelPublicUrl: settings.panelBaseUrl,
      redirectUri: settings.redirectUri,
      usable: isDiscordLoginUsable(settings),
    },
    bot: {
      enabled: bot.enabled,
      tokenMasked: maskSecret(bot.token),
      tokenSet: !!bot.token,
      botUsername: bot.botUsername,
      hostStatusNotify: bot.hostStatusNotify,
      expiryReminder: bot.expiryReminder,
      trafficReminder: bot.trafficReminder,
      ready: bot.enabled && !!bot.token,
    },
  };
}

export type DiscordSettingsUpdateInput = {
  enabled?: boolean;
  clientId?: string;
  clientSecret?: string;
  clearClientSecret?: boolean;
  allowRegistration?: boolean;
  allowedDomains?: string;
  botEnabled?: boolean;
  botToken?: string;
  clearBotToken?: boolean;
  hostStatusNotify?: boolean;
  expiryReminder?: boolean;
  trafficReminder?: boolean;
};

const CLIENT_ID_PATTERN = /^[0-9]{15,25}$/;
// Bot Token 是三段 base64url，用点隔开。只做形状检查，真假要问 Discord（保存时会查一次 /users/@me）。
const BOT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{16,}$/;

export function isPlausibleDiscordBotToken(value: string) {
  return value.length <= 200 && BOT_TOKEN_PATTERN.test(value);
}

/**
 * 算出要写进设置表的键值，以及一条要给管理员看的错误（有错误就什么都不写）。
 * 纯函数：调用方负责真正写库。botTokenChanged 告诉调用方要不要去 Discord 验一下新 Token。
 */
export function planDiscordSettingsUpdate(all: SettingsMap, input: DiscordSettingsUpdateInput) {
  const fail = (error: string) => ({ error, patch: {} as Record<string, string | null>, botTokenChanged: false });
  const current = readDiscordLoginSettings(all);
  const currentBot = readDiscordBotSettings(all);
  const patch: Record<string, string | null> = {};
  let botTokenChanged = false;

  if (input.clientId !== undefined) {
    const clientId = input.clientId.trim();
    if (clientId && !CLIENT_ID_PATTERN.test(clientId)) {
      return fail("Client ID 格式不对：应当是一串数字（Discord Developer Portal › OAuth2 页面上的 Client ID）");
    }
    patch[DISCORD_SETTING_KEYS.clientId] = clientId || null;
  }
  const secret = resolveSecretUpdate(current.clientSecret, input.clientSecret, input.clearClientSecret);
  if (secret !== undefined) {
    if (secret && secret.length > 256) return fail("Client Secret 太长");
    if (secret && !/^[A-Za-z0-9_-]{8,256}$/.test(secret)) return fail("Client Secret 格式不对：请在 OAuth2 页面点 Reset Secret 后原样复制");
    patch[DISCORD_SETTING_KEYS.clientSecret] = secret;
  }
  if (input.allowRegistration !== undefined) patch[DISCORD_SETTING_KEYS.allowRegistration] = input.allowRegistration ? "true" : "false";
  if (input.allowedDomains !== undefined) {
    const raw = input.allowedDomains.trim();
    const domains = parseEmailDomainList(raw);
    if (raw && !domains.length) return fail("允许的邮箱域名格式不对，例如 example.com, corp.example.org");
    patch[DISCORD_SETTING_KEYS.allowedDomains] = domains.length ? domains.join(",") : null;
  }
  if (input.enabled !== undefined) {
    if (input.enabled) {
      const next = readDiscordLoginSettings({ ...all, ...patch });
      if (!next.panelBaseUrl) return fail("请先在「面板地址」里填好面板公开地址：Discord 回调地址要用它拼出来");
      if (!isDiscordAcceptableRedirectBase(next.panelBaseUrl)) {
        return fail("Discord 登录只接受 https 的回调地址（本机 localhost 除外）：请先把面板公开地址改成 https://…");
      }
      if (!next.clientId || !next.clientSecret) return fail("开启 Discord 登录前请先填好 Client ID 和 Client Secret");
    }
    patch[DISCORD_SETTING_KEYS.enabled] = input.enabled ? "true" : "false";
  }

  const token = resolveSecretUpdate(currentBot.token, input.botToken, input.clearBotToken);
  if (token !== undefined) {
    if (token && !isPlausibleDiscordBotToken(token)) {
      return fail("Bot Token 格式不对：请在 Developer Portal › Bot 页面点 Reset Token 后原样复制（形如 xxxx.yyyy.zzzz）");
    }
    patch[DISCORD_SETTING_KEYS.botToken] = token;
    patch[DISCORD_SETTING_KEYS.botUsername] = null;
    botTokenChanged = true;
    // 清掉 Token 就顺手关掉机器人
    if (!token) patch[DISCORD_SETTING_KEYS.botEnabled] = "false";
  }
  if (input.botEnabled !== undefined) {
    const nextToken = token !== undefined ? token : currentBot.token;
    if (input.botEnabled && !nextToken) return fail("开启 Discord 通知前请先填好 Bot Token");
    patch[DISCORD_SETTING_KEYS.botEnabled] = input.botEnabled && nextToken ? "true" : "false";
  }
  if (input.hostStatusNotify !== undefined) patch[DISCORD_SETTING_KEYS.hostStatusNotify] = input.hostStatusNotify ? "true" : "false";
  if (input.expiryReminder !== undefined) patch[DISCORD_SETTING_KEYS.expiryReminder] = input.expiryReminder ? "true" : "false";
  if (input.trafficReminder !== undefined) patch[DISCORD_SETTING_KEYS.trafficReminder] = input.trafficReminder ? "true" : "false";
  return { error: null as string | null, patch, botTokenChanged };
}
