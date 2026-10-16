import assert from "node:assert/strict";
import test from "node:test";
import {
  googleLoginAdminView,
  isGoogleLoginUsable,
  planGoogleSettingsUpdate,
  readGoogleLoginSettings,
  resolveSecretUpdate,
} from "./googleLoginSettings";
import { maskSecret } from "./ddns";

// 测试用的假凭据：拆开拼接，免得被 GitHub 推送保护当成真密钥（值本身不变）
const SECRET = ["GOCSPX", "-abcdefghijklmnopqrstuvwxyz12"].join("");
const CLIENT_ID = ["1234567890-abc", "apps.googleusercontent.com"].join(".");
const base = {
  panelPublicUrl: "https://panel.example.com/",
  googleLoginEnabled: "true",
  googleClientId: CLIENT_ID,
  googleClientSecret: SECRET,
  googleAllowRegistration: "false",
  googleAllowedDomains: "example.com,corp.example.org",
};

test("管理员看到的设置里密钥是打码的，回调地址按公开地址拼好", () => {
  const view = googleLoginAdminView(base);
  assert.equal(view.clientSecretSet, true);
  assert.equal(view.clientSecretMasked, maskSecret(SECRET));
  assert.ok(!JSON.stringify(view).includes(SECRET), "完整密钥不能出现在返回值里");
  assert.ok(!JSON.stringify(view).includes(SECRET.slice(4, -4)));
  assert.equal(view.redirectUri, "https://panel.example.com/api/auth/google/callback");
  assert.equal(view.allowedDomains, "example.com, corp.example.org");
  assert.equal(view.usable, true);
});

test("交回打码值 / 空串 = 不改；明确清空才删", () => {
  assert.equal(resolveSecretUpdate(SECRET, maskSecret(SECRET)), undefined);
  assert.equal(resolveSecretUpdate(SECRET, ""), undefined);
  assert.equal(resolveSecretUpdate(SECRET, "   "), undefined);
  assert.equal(resolveSecretUpdate(SECRET, undefined), undefined);
  assert.equal(resolveSecretUpdate(SECRET, "GOCS******wxyz"), undefined, "看着像打码值的不当新密钥存");
  assert.equal(resolveSecretUpdate(SECRET, "new-secret"), "new-secret");
  assert.equal(resolveSecretUpdate(SECRET, "anything", true), null);

  const keep = planGoogleSettingsUpdate(base, { clientSecret: maskSecret(SECRET), allowRegistration: true });
  assert.equal(keep.error, null);
  assert.ok(!("googleClientSecret" in keep.patch), "密钥没动");
  assert.equal(keep.patch.googleAllowRegistration, "true");
});

test("能不能用：开关 + ID + 密钥 + 公开地址缺一不可", () => {
  assert.equal(isGoogleLoginUsable(readGoogleLoginSettings(base)), true);
  assert.equal(isGoogleLoginUsable(readGoogleLoginSettings({ ...base, googleLoginEnabled: "false" })), false);
  assert.equal(isGoogleLoginUsable(readGoogleLoginSettings({ ...base, panelPublicUrl: "" })), false);
  assert.equal(isGoogleLoginUsable(readGoogleLoginSettings({ ...base, googleClientSecret: "" })), false);
  assert.equal(isGoogleLoginUsable(readGoogleLoginSettings({ ...base, googleClientId: null })), false);
  assert.equal(readGoogleLoginSettings({}).enabled, false, "默认关");
  assert.equal(readGoogleLoginSettings({}).allowRegistration, false, "默认不许注册");
});

test("没配面板公开地址、没填 ID / 密钥时不让开", () => {
  const off = { ...base, googleLoginEnabled: "false" };
  assert.match(String(planGoogleSettingsUpdate({ ...off, panelPublicUrl: "" }, { enabled: true }).error), /面板公开地址/);
  assert.match(String(planGoogleSettingsUpdate({ ...off, googleClientSecret: "" }, { enabled: true }).error), /客户端 ID 和客户端密钥/);
  assert.match(String(planGoogleSettingsUpdate(off, { enabled: true, clearClientSecret: true }).error), /客户端密钥/);
  assert.equal(planGoogleSettingsUpdate({ ...off, googleClientSecret: "" }, { enabled: true, clientSecret: "fresh-secret" }).error, null, "同一次填上密钥就行");
  assert.equal(planGoogleSettingsUpdate({ ...off, panelPublicUrl: "" }, { enabled: false }).error, null, "关掉随时可以");
  assert.match(String(planGoogleSettingsUpdate(base, { clientId: "bad id with spaces" }).error), /客户端 ID/);
  assert.match(String(planGoogleSettingsUpdate(base, { allowedDomains: "!!!" }).error), /域名/);
  assert.equal(planGoogleSettingsUpdate(base, { allowedDomains: "" }).patch.googleAllowedDomains, null);
});

test("面板公开地址是 http（不是本机）时不让开，开着的也按没配好处理", () => {
  // Google 不接受非 localhost 的 http 回调地址：开了也是每次都被 Google 拒
  const httpPanel = { ...base, panelPublicUrl: "http://panel.example.com/" };
  assert.equal(isGoogleLoginUsable(readGoogleLoginSettings(httpPanel)), false, "登录页不显示按钮");
  assert.match(String(planGoogleSettingsUpdate({ ...httpPanel, googleLoginEnabled: "false" }, { enabled: true }).error), /https/);
  // 本机调试的 localhost 例外
  const localPanel = { ...base, panelPublicUrl: "http://localhost:3000/" };
  assert.equal(isGoogleLoginUsable(readGoogleLoginSettings(localPanel)), true);
  assert.equal(planGoogleSettingsUpdate({ ...localPanel, googleLoginEnabled: "false" }, { enabled: true }).error, null);
});
