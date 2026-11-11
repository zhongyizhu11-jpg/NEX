import assert from "node:assert/strict";
import test from "node:test";
import {
  isOidcLoginUsable,
  oidcConfigFingerprint,
  oidcLoginAdminView,
  planOidcSettingsUpdate,
  readOidcLoginSettings,
} from "./oidcLoginSettings";
import { isSecretSettingKey } from "./settingsSecretKeys";
import {
  buildOidcRedirectUri,
  oidcButtonLabel,
  oidcLoginErrorMessage,
  parseOidcScopes,
  validateOidcIssuer,
} from "../shared/oidcLogin";

/*
  通用 OIDC 登录的设置：默认值（关、不许注册、只认已验证邮箱、不放行内网、不认 HS256）、
  Issuer / scope 校验、开启前的检查、密钥打码与加密名单、配置指纹。
*/

const BASE = {
  panelPublicUrl: "https://panel.example.com/",
  oidcIssuer: "https://id.example.com",
  oidcClientId: "nex-panel",
  oidcClientSecret: "super-secret-value",
};

test("默认值：关着、不许注册、只接受已验证邮箱、不放行内网、不认 HS256、scope 是 openid email profile", () => {
  const settings = readOidcLoginSettings({});
  assert.equal(settings.enabled, false);
  assert.equal(settings.allowRegistration, false);
  assert.equal(settings.requireVerifiedEmail, true);
  assert.equal(settings.allowPrivateNetwork, false);
  assert.equal(settings.allowHmacTokens, false);
  assert.deepEqual(settings.scopes, ["openid", "email", "profile"]);
  assert.equal(settings.providerName, "OIDC");
  assert.equal(readOidcLoginSettings(BASE).redirectUri, "https://panel.example.com/api/auth/oidc/callback");
  assert.equal(isOidcLoginUsable(readOidcLoginSettings({ ...BASE, oidcLoginEnabled: "true" })), true);
  assert.equal(isOidcLoginUsable(readOidcLoginSettings({ ...BASE, oidcLoginEnabled: "true", panelPublicUrl: "" })), false);
  // 公开客户端（没有密钥）也能用：只靠 PKCE
  assert.equal(isOidcLoginUsable(readOidcLoginSettings({ ...BASE, oidcClientSecret: "", oidcLoginEnabled: "true" })), true);
  // 后来取消了内网放行，http 的 Issuer 就不算配好了
  assert.equal(isOidcLoginUsable(readOidcLoginSettings({ ...BASE, oidcIssuer: "http://10.0.0.8:9000", oidcLoginEnabled: "true" })), false);
  assert.equal(isOidcLoginUsable(readOidcLoginSettings({ ...BASE, oidcIssuer: "http://10.0.0.8:9000", oidcAllowPrivateNetwork: "true", oidcLoginEnabled: "true" })), true);
});

test("客户端密钥：落库加密、读出去打码、交回打码值不改", () => {
  assert.equal(isSecretSettingKey("oidcClientSecret"), true);
  const view = oidcLoginAdminView(BASE);
  assert.equal(view.clientSecretSet, true);
  assert.ok(!JSON.stringify(view).includes("super-secret-value"));
  const unchanged = planOidcSettingsUpdate(BASE, { clientSecret: view.clientSecretMasked });
  assert.equal(unchanged.error, null);
  assert.equal("oidcClientSecret" in unchanged.patch, false);
  assert.equal(planOidcSettingsUpdate(BASE, { clearClientSecret: true }).patch.oidcClientSecret, null);
  assert.equal(planOidcSettingsUpdate(BASE, { clientSecret: "new-one" }).patch.oidcClientSecret, "new-one");
});

test("Issuer：https；http 只有勾了「IdP 在内网」才行；不能带账号密码 / 查询串 / 片段；原样保存", () => {
  assert.equal(validateOidcIssuer("https://id.example.com", { allowHttp: false }), null);
  assert.equal(validateOidcIssuer("https://sso.example.com/realms/main/", { allowHttp: false }), null);
  assert.match(String(validateOidcIssuer("http://10.0.0.8", { allowHttp: false })), /IdP 在内网/);
  assert.equal(validateOidcIssuer("http://10.0.0.8", { allowHttp: true }), null);
  assert.match(String(validateOidcIssuer("ftp://id.example.com", { allowHttp: true })), /https/);
  assert.match(String(validateOidcIssuer("https://u:p@id.example.com", { allowHttp: false })), /账号密码/);
  assert.match(String(validateOidcIssuer("https://id.example.com/?a=1", { allowHttp: false })), /查询/);
  assert.match(String(validateOidcIssuer("https://id.example.com#x", { allowHttp: false })), /片段/);
  assert.match(String(validateOidcIssuer(`https://id.example.com/${"a".repeat(200)}`, { allowHttp: false })), /太长/);
  assert.match(String(validateOidcIssuer("not a url", { allowHttp: false })), /格式/);

  const plan = planOidcSettingsUpdate({}, { issuer: " https://sso.example.com/realms/main/ " });
  assert.equal(plan.patch.oidcIssuer, "https://sso.example.com/realms/main/", "末尾斜杠保留：要和 discovery 一字不差");
  assert.match(String(planOidcSettingsUpdate({}, { issuer: "http://10.0.0.8" }).error), /IdP 在内网/);
  assert.equal(planOidcSettingsUpdate({}, { issuer: "http://10.0.0.8", allowPrivateNetwork: true }).error, null);
  // 已经存着 http Issuer 时取消内网放行：拒绝
  assert.match(String(planOidcSettingsUpdate({ ...BASE, oidcIssuer: "http://10.0.0.8", oidcAllowPrivateNetwork: "true" }, { allowPrivateNetwork: false }).error), /先把 Issuer 改成 https/);
});

test("scope：补上 openid、去重；格式不对拒绝；默认值不落库", () => {
  assert.deepEqual(parseOidcScopes("email profile groups"), ["openid", "email", "profile", "groups"]);
  assert.deepEqual(parseOidcScopes("openid  openid email"), ["openid", "email"]);
  assert.deepEqual(parseOidcScopes(""), ["openid", "email", "profile"]);
  assert.equal(parseOidcScopes('openid "email"'), null);
  assert.equal(planOidcSettingsUpdate({}, { scopes: "openid email profile" }).patch.oidcScopes, null);
  assert.equal(planOidcSettingsUpdate({}, { scopes: "email groups" }).patch.oidcScopes, "openid email groups");
  assert.match(String(planOidcSettingsUpdate({}, { scopes: "a\\b" }).error), /Scope/);
});

test("开启前检查：面板公开地址、Issuer、客户端 ID；勾 HS256 必须有密钥", () => {
  assert.match(String(planOidcSettingsUpdate({ ...BASE, panelPublicUrl: "" }, { enabled: true }).error), /面板公开地址/);
  assert.match(String(planOidcSettingsUpdate({ ...BASE, oidcIssuer: "" }, { enabled: true }).error), /Issuer/);
  assert.match(String(planOidcSettingsUpdate({ ...BASE, oidcClientId: "" }, { enabled: true }).error), /客户端 ID/);
  assert.equal(planOidcSettingsUpdate(BASE, { enabled: true }).patch.oidcLoginEnabled, "true");
  assert.match(String(planOidcSettingsUpdate({ ...BASE, oidcClientSecret: "" }, { allowHmacTokens: true }).error), /客户端密钥/);
  assert.equal(planOidcSettingsUpdate(BASE, { allowHmacTokens: true }).patch.oidcAllowHmacTokens, "true");
  assert.match(String(planOidcSettingsUpdate(BASE, { clientId: "有 空格" }).error), /客户端 ID/);
  assert.match(String(planOidcSettingsUpdate(BASE, { allowedDomains: "not a domain!" }).error), /域名/);
  assert.equal(planOidcSettingsUpdate(BASE, { allowedDomains: "@Corp.io, example.com" }).patch.oidcAllowedDomains, "corp.io,example.com");
  assert.equal(planOidcSettingsUpdate(BASE, { requireVerifiedEmail: false }).patch.oidcRequireVerifiedEmail, "false");
});

test("配置指纹：Issuer、客户端、密钥、回调地址、scope、验签方式任何一项变了都不一样", () => {
  const base = readOidcLoginSettings(BASE);
  const fp = oidcConfigFingerprint(base);
  assert.equal(oidcConfigFingerprint(readOidcLoginSettings(BASE)), fp);
  for (const change of [
    { oidcIssuer: "https://id2.example.com" },
    { oidcClientId: "other" },
    { oidcClientSecret: "rotated" },
    { panelPublicUrl: "https://panel2.example.com" },
    { oidcScopes: "openid email" },
    { oidcAllowHmacTokens: "true" },
    { oidcAllowPrivateNetwork: "true" },
  ]) {
    assert.notEqual(oidcConfigFingerprint(readOidcLoginSettings({ ...BASE, ...change })), fp, JSON.stringify(change));
  }
  assert.ok(!fp.includes("super-secret"));
});

test("按钮文字、回调地址、失败码的中文", () => {
  assert.equal(oidcButtonLabel("Pocket ID"), "使用 Pocket ID 登录");
  assert.equal(oidcButtonLabel(""), "使用 OIDC 登录");
  assert.equal(oidcButtonLabel("<b>x</b>\n  y"), "使用 bx/b y 登录");
  assert.equal(buildOidcRedirectUri("https://panel.example.com/sub/"), "https://panel.example.com/sub/api/auth/oidc/callback");
  assert.match(oidcLoginErrorMessage("not_linked"), /个人资料/);
  assert.equal(oidcLoginErrorMessage("<script>"), oidcLoginErrorMessage("server_error"), "认不出的码不原样显示");
  assert.equal(oidcLoginErrorMessage("toString"), oidcLoginErrorMessage("server_error"));
});
