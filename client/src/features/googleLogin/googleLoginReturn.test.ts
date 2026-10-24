import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { googleWebStartUrl, parseGoogleLoginReturn } from "./googleLoginReturn";

test("回调带回来的失败码变成中文，乱写的码不原样显示", () => {
  assert.match(String(parseGoogleLoginReturn("?googleError=not_linked", "").errorMessage), /还没绑定面板账号：请先用密码登录，在 账号设置 里绑定 Google/);
  assert.equal(parseGoogleLoginReturn("?googleError=%3Cimg%20src%3Dx%3E", "").errorMessage, "Google 登录失败，请稍后重试");
  assert.equal(parseGoogleLoginReturn("", "").errorMessage, null);
  assert.equal(parseGoogleLoginReturn("?googleLinked=1", "").linked, true);
});

test("2FA 挑战从 # 里读，跳回地址被清洗", () => {
  const challengeId = "a".repeat(48);
  const result = parseGoogleLoginReturn("", `#googleTwoFactor=${challengeId}&u=alice%40example.com&exp=300&next=%2Fhosts`);
  assert.deepEqual(result.twoFactor, { challengeId, username: "alice@example.com", expiresInSeconds: 300, next: "/hosts" });
  assert.equal(parseGoogleLoginReturn("", `#googleTwoFactor=${challengeId}&next=%2F%2Fevil.com`).twoFactor?.next, "/");
  assert.equal(parseGoogleLoginReturn("", "#googleTwoFactor=not-hex!").twoFactor, null);
  assert.equal(parseGoogleLoginReturn("", `#googleTwoFactor=${challengeId}&exp=999999`).twoFactor?.expiresInSeconds, 600);
});

test("网页发起地址只带相对路径", () => {
  assert.equal(googleWebStartUrl("login", "/rules"), "/api/auth/google/start?mode=login&redirect=%2Frules");
  assert.equal(googleWebStartUrl("login", "https://evil.com"), "/api/auth/google/start?mode=login&redirect=%2F");
  assert.equal(googleWebStartUrl("link", "//x"), "/api/auth/google/start?mode=link&redirect=%2Fprofile");
  // 邀请码：只在登录（注册）流程带，只认字母数字
  assert.equal(googleWebStartUrl("login", "/", "ABCD2345"), "/api/auth/google/start?mode=login&redirect=%2F&invite=ABCD2345");
  assert.equal(googleWebStartUrl("login", "/", "bad code!"), "/api/auth/google/start?mode=login&redirect=%2F");
  assert.equal(googleWebStartUrl("link", "/profile", "ABCD2345"), "/api/auth/google/start?mode=link&redirect=%2Fprofile");
});

test("登录页只在开启时显示 Google 按钮；App 里用系统浏览器打开", () => {
  const login = fs.readFileSync(path.resolve(import.meta.dirname, "../../pages/Login.tsx"), "utf8");
  assert.match(login, /googleLoginEnabled && hasMobilePanelUrl \? \(\s*<GoogleLoginButton/);
  // 两家共用 OAuthLoginButton：App 里用系统浏览器打开授权页，按钮写「使用 <名字> 登录」。
  const shared = fs.readFileSync(path.resolve(import.meta.dirname, "../oauthLogin/OAuthLoginButton.tsx"), "utf8");
  assert.match(shared, /Browser\.open\(\{ url: flow\.startUrl \}\)/);
  assert.match(shared, /`使用 \$\{label\} 登录`/);
  const button = fs.readFileSync(path.resolve(import.meta.dirname, "GoogleLoginButton.tsx"), "utf8");
  assert.match(button, /label: "Google"/);
  assert.match(button, /trpc\.googleAuth\.appStatus/);
});
