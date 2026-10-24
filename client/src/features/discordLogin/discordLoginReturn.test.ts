import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { discordWebStartUrl, parseDiscordLoginReturn } from "./discordLoginReturn";

test("Discord 回调带回来的失败码按码显示中文，认不出的不原样显示", () => {
  assert.match(String(parseDiscordLoginReturn("?discordError=not_linked", "").errorMessage), /还没绑定面板账号：请先用密码登录，在 账号设置 里绑定 Discord/);
  assert.equal(parseDiscordLoginReturn("?discordError=%3Cimg%20src%3Dx%3E", "").errorMessage, "Discord 登录失败，请稍后重试");
  assert.equal(parseDiscordLoginReturn("?googleError=not_linked", "").errorMessage, null, "Google 的码不归这里管");
  assert.equal(parseDiscordLoginReturn("?discordLinked=1", "").linked, true);
});

test("2FA 挑战从 # 里读，跳回地址被清洗", () => {
  const challengeId = "a".repeat(48);
  const result = parseDiscordLoginReturn("", `#discordTwoFactor=${challengeId}&u=alice%40example.com&exp=300&next=%2Fhosts`);
  assert.deepEqual(result.twoFactor, { challengeId, username: "alice@example.com", expiresInSeconds: 300, next: "/hosts" });
  assert.equal(parseDiscordLoginReturn("", `#discordTwoFactor=${challengeId}&next=%2F%2Fevil.com`).twoFactor?.next, "/");
  assert.equal(parseDiscordLoginReturn("", "#discordTwoFactor=not-hex!").twoFactor, null);
  assert.equal(parseDiscordLoginReturn("", `#googleTwoFactor=${challengeId}`).twoFactor, null);
});

test("网页发起地址：只带本站相对路径，邀请码只在登录模式带", () => {
  assert.equal(discordWebStartUrl("login", "/rules"), "/api/auth/discord/start?mode=login&redirect=%2Frules");
  assert.equal(discordWebStartUrl("login", "https://evil.com"), "/api/auth/discord/start?mode=login&redirect=%2F");
  assert.equal(discordWebStartUrl("link", "//x"), "/api/auth/discord/start?mode=link&redirect=%2Fprofile");
  assert.equal(discordWebStartUrl("login", "/", "ABCD2345"), "/api/auth/discord/start?mode=login&redirect=%2F&invite=ABCD2345");
  assert.equal(discordWebStartUrl("login", "/", "bad code!"), "/api/auth/discord/start?mode=login&redirect=%2F");
  assert.equal(discordWebStartUrl("link", "/profile", "ABCD2345"), "/api/auth/discord/start?mode=link&redirect=%2Fprofile");
});

test("登录页只在开启时显示 Discord 按钮；App 里用系统浏览器打开；图标是品牌色", () => {
  const login = fs.readFileSync(path.resolve(import.meta.dirname, "../../pages/Login.tsx"), "utf8");
  assert.match(login, /discordLoginEnabled && hasMobilePanelUrl \? \(\s*<DiscordLoginButton/);
  assert.match(login, /publicInfo\?\.discordLoginEnabled === true/);
  // 两家共用 OAuthLoginButton：App 里用系统浏览器打开授权页，按钮写「使用 <名字> 登录」。
  const shared = fs.readFileSync(path.resolve(import.meta.dirname, "../oauthLogin/OAuthLoginButton.tsx"), "utf8");
  assert.match(shared, /Browser\.open\(\{ url: flow\.startUrl \}\)/);
  assert.match(shared, /`使用 \$\{label\} 登录`/);
  const button = fs.readFileSync(path.resolve(import.meta.dirname, "DiscordLoginButton.tsx"), "utf8");
  assert.match(button, /label: "Discord"/);
  assert.match(button, /trpc\.discordAuth\.appStatus/);
  const mark = fs.readFileSync(path.resolve(import.meta.dirname, "DiscordMark.tsx"), "utf8");
  assert.match(mark, /#5865F2/);
});
