import assert from "node:assert/strict";
import test from "node:test";
import {
  discordAdminView,
  isDiscordBotReadyFromSettings,
  isDiscordLoginUsable,
  isPlausibleDiscordBotToken,
  planDiscordSettingsUpdate,
  readDiscordLoginSettings,
} from "./discordSettings";
import { maskSecret } from "./ddns";

// 测试用的假凭据：拆开拼接，明显是假的（不会被推送保护当成真密钥）
const SECRET = ["fake", "discord", "client", "secret", "000"].join("_");
const BOT_TOKEN = ["fakebottoken" + "a".repeat(12), "fake00", "z".repeat(27)].join(".");
const CLIENT_ID = "123456789012345678";
const base = {
  panelPublicUrl: "https://panel.example.com/",
  discordLoginEnabled: "true",
  discordClientId: CLIENT_ID,
  discordClientSecret: SECRET,
  discordAllowRegistration: "false",
  discordAllowedDomains: "example.com,corp.example.org",
  discordBotEnabled: "true",
  discordBotToken: BOT_TOKEN,
  discordBotUsername: "NEX Bot",
};

test("管理员看到的设置里密钥和 Token 是打码的，回调地址按公开地址拼好", () => {
  const view = discordAdminView(base);
  const json = JSON.stringify(view);
  assert.equal(view.login.clientSecretSet, true);
  assert.equal(view.login.clientSecretMasked, maskSecret(SECRET));
  assert.ok(!json.includes(SECRET) && !json.includes(SECRET.slice(4, -4)), "完整 Secret 不能出现在返回值里");
  assert.ok(!json.includes(BOT_TOKEN) && !json.includes(BOT_TOKEN.slice(4, -4)), "完整 Bot Token 不能出现在返回值里");
  assert.equal(view.bot.tokenMasked, maskSecret(BOT_TOKEN));
  assert.equal(view.bot.ready, true);
  assert.equal(view.bot.botUsername, "NEX Bot");
  assert.equal(view.login.redirectUri, "https://panel.example.com/api/auth/discord/callback");
  assert.equal(view.login.allowedDomains, "example.com, corp.example.org");
  assert.equal(view.login.usable, true);
});

test("交回打码值 / 空串 = 不改；明确清空才删；清掉 Token 顺手关掉机器人", () => {
  const keep = planDiscordSettingsUpdate(base, { clientSecret: maskSecret(SECRET), botToken: maskSecret(BOT_TOKEN), allowRegistration: true });
  assert.equal(keep.error, null);
  assert.ok(!("discordClientSecret" in keep.patch));
  assert.ok(!("discordBotToken" in keep.patch));
  assert.equal(keep.botTokenChanged, false);
  assert.equal(keep.patch.discordAllowRegistration, "true");
  const blank = planDiscordSettingsUpdate(base, { clientSecret: "", botToken: "   " });
  assert.deepEqual(blank.patch, {});

  const cleared = planDiscordSettingsUpdate(base, { clearBotToken: true });
  assert.equal(cleared.patch.discordBotToken, null);
  assert.equal(cleared.patch.discordBotEnabled, "false");
  assert.equal(cleared.patch.discordBotUsername, null);

  const fresh = planDiscordSettingsUpdate(base, { botToken: ["fresh" + "b".repeat(16), "fake11", "y".repeat(27)].join(".") });
  assert.equal(fresh.botTokenChanged, true);
  assert.equal(fresh.patch.discordBotUsername, null, "换了 Token，机器人名字要重新查");
});

test("登录能不能用：开关 + ID + Secret + https 公开地址缺一不可", () => {
  assert.equal(isDiscordLoginUsable(readDiscordLoginSettings(base)), true);
  assert.equal(isDiscordLoginUsable(readDiscordLoginSettings({ ...base, discordLoginEnabled: "false" })), false);
  assert.equal(isDiscordLoginUsable(readDiscordLoginSettings({ ...base, panelPublicUrl: "" })), false);
  assert.equal(isDiscordLoginUsable(readDiscordLoginSettings({ ...base, discordClientSecret: "" })), false);
  assert.equal(isDiscordLoginUsable(readDiscordLoginSettings({ ...base, discordClientId: null })), false);
  assert.equal(readDiscordLoginSettings({}).enabled, false, "默认关");
  assert.equal(readDiscordLoginSettings({}).allowRegistration, false, "默认不许注册");
});

test("面板公开地址是 http（不是本机）时不让开，开着的也按没配好处理", () => {
  const httpPanel = { ...base, panelPublicUrl: "http://panel.example.com/" };
  assert.equal(isDiscordLoginUsable(readDiscordLoginSettings(httpPanel)), false, "登录页不显示按钮");
  assert.match(String(planDiscordSettingsUpdate({ ...httpPanel, discordLoginEnabled: "false" }, { enabled: true }).error), /https/);
  const localPanel = { ...base, panelPublicUrl: "http://127.0.0.1:3000/" };
  assert.equal(isDiscordLoginUsable(readDiscordLoginSettings(localPanel)), true, "本机调试例外");
  assert.equal(planDiscordSettingsUpdate({ ...localPanel, discordLoginEnabled: "false" }, { enabled: true }).error, null);
});

test("没配面板公开地址、没填 ID / Secret / Token 时不让开；格式不对的拒绝", () => {
  const off = { ...base, discordLoginEnabled: "false" };
  assert.match(String(planDiscordSettingsUpdate({ ...off, panelPublicUrl: "" }, { enabled: true }).error), /面板公开地址/);
  assert.match(String(planDiscordSettingsUpdate({ ...off, discordClientSecret: "" }, { enabled: true }).error), /Client ID 和 Client Secret/);
  assert.match(String(planDiscordSettingsUpdate(off, { enabled: true, clearClientSecret: true }).error), /Client Secret/);
  assert.equal(planDiscordSettingsUpdate({ ...off, discordClientSecret: "" }, { enabled: true, clientSecret: "freshsecretvalue01" }).error, null);
  assert.equal(planDiscordSettingsUpdate({ ...off, panelPublicUrl: "" }, { enabled: false }).error, null, "关掉随时可以");
  assert.match(String(planDiscordSettingsUpdate(base, { clientId: "1234-abc.apps.googleusercontent.com" }).error), /Client ID/);
  assert.match(String(planDiscordSettingsUpdate(base, { clientSecret: "has spaces in it" }).error), /Client Secret/);
  assert.match(String(planDiscordSettingsUpdate(base, { allowedDomains: "!!!" }).error), /域名/);
  assert.match(String(planDiscordSettingsUpdate(base, { botToken: "not-a-token" }).error), /Bot Token/);
  assert.match(String(planDiscordSettingsUpdate({ ...base, discordBotToken: "" }, { botEnabled: true }).error), /Bot Token/);
  assert.equal(planDiscordSettingsUpdate({ ...base, discordBotToken: "", discordBotEnabled: "false" }, { botEnabled: true, botToken: BOT_TOKEN }).error, null);
  assert.equal(isPlausibleDiscordBotToken(BOT_TOKEN), true);
  assert.equal(isPlausibleDiscordBotToken("a.b.c"), false);
});

test("机器人就绪：开关开着且有 Token", () => {
  assert.equal(isDiscordBotReadyFromSettings(base), true);
  assert.equal(isDiscordBotReadyFromSettings({ ...base, discordBotEnabled: "false" }), false);
  assert.equal(isDiscordBotReadyFromSettings({ ...base, discordBotToken: "" }), false);
  assert.equal(isDiscordBotReadyFromSettings({}), false);
});
