import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDiscordRedirectUri,
  discordLoginErrorMessage,
  isDiscordAcceptableRedirectBase,
  isDiscordSnowflake,
  sanitizeDiscordInviteCode,
} from "./discordLogin";
import { sanitizeRedirectPath } from "./googleLogin";

test("回调地址：面板公开地址 + /api/auth/discord/callback", () => {
  assert.equal(buildDiscordRedirectUri("https://panel.example.com/"), "https://panel.example.com/api/auth/discord/callback");
  assert.equal(buildDiscordRedirectUri("https://example.com/nex/"), "https://example.com/nex/api/auth/discord/callback");
  assert.equal(buildDiscordRedirectUri(""), "");
  assert.equal(buildDiscordRedirectUri("ftp://x"), "");
});

test("只接受 https 回调（localhost / 127.0.0.1 例外）", () => {
  assert.equal(isDiscordAcceptableRedirectBase("https://panel.example.com"), true);
  assert.equal(isDiscordAcceptableRedirectBase("http://panel.example.com"), false);
  assert.equal(isDiscordAcceptableRedirectBase("http://localhost:3000"), true);
  assert.equal(isDiscordAcceptableRedirectBase("http://127.0.0.1:5320"), true);
  assert.equal(isDiscordAcceptableRedirectBase(""), false);
});

test("失败码 → 中文；认不出的码不原样显示", () => {
  assert.match(discordLoginErrorMessage("not_linked"), /还没绑定面板账号：请先用密码登录，在 账号设置 里绑定 Discord/);
  assert.match(discordLoginErrorMessage("email_unverified"), /邮箱还没有验证/);
  assert.equal(discordLoginErrorMessage("<img src=x>"), "Discord 登录失败，请稍后重试");
  assert.equal(discordLoginErrorMessage("toString"), "Discord 登录失败，请稍后重试");
});

test("跳回地址清洗和 Google 同一套：只接受本站相对路径", () => {
  for (const bad of ["//evil.com", "/\\evil.com", "https://evil.com", "javascript:alert(1)", "/api/auth/discord/start"]) {
    assert.equal(sanitizeRedirectPath(bad), "/", bad);
  }
  assert.equal(sanitizeRedirectPath("/rules?tab=1"), "/rules?tab=1");
});

test("雪花 ID 和邀请码", () => {
  assert.equal(isDiscordSnowflake("80351110224678912"), true);
  assert.equal(isDiscordSnowflake(80351110224678912), false);
  assert.equal(isDiscordSnowflake("12ab"), false);
  assert.equal(sanitizeDiscordInviteCode("ABCD2345"), "ABCD2345");
  assert.equal(sanitizeDiscordInviteCode("bad code!"), null);
});
