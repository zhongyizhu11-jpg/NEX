import assert from "node:assert/strict";
import test from "node:test";
import { oidcWebStartUrl, parseOidcLoginReturn } from "./oidcLoginReturn";

test("OIDC 回调带回来的失败码按码显示中文，认不出的不原样显示，别家的码不归这里管", () => {
  assert.match(String(parseOidcLoginReturn("?oidcError=not_linked", "").errorMessage), /还没绑定面板账号/);
  assert.equal(parseOidcLoginReturn("?oidcError=%3Cimg%20src%3Dx%3E", "").errorMessage, "登录失败，请稍后重试");
  assert.equal(parseOidcLoginReturn("?googleError=not_linked", "").errorMessage, null);
  assert.equal(parseOidcLoginReturn("?oidcLinked=1", "").linked, true);
});

test("2FA 挑战从 # 里读，跳回地址被清洗", () => {
  const challengeId = "b".repeat(48);
  const result = parseOidcLoginReturn("", `#oidcTwoFactor=${challengeId}&u=alice&exp=300&next=%2Fhosts`);
  assert.deepEqual(result.twoFactor, { challengeId, username: "alice", expiresInSeconds: 300, next: "/hosts" });
  assert.equal(parseOidcLoginReturn("", `#oidcTwoFactor=${challengeId}&next=%2F%2Fevil.com`).twoFactor?.next, "/");
  assert.equal(parseOidcLoginReturn("", `#discordTwoFactor=${challengeId}`).twoFactor, null);
});

test("网页起始地址：模式、清洗过的跳回地址、只在登录时带邀请码", () => {
  assert.equal(oidcWebStartUrl("login", "/rules", "ABCD2345"), "/api/auth/oidc/start?mode=login&redirect=%2Frules&invite=ABCD2345");
  assert.equal(oidcWebStartUrl("login", "//evil.com", "bad code!"), "/api/auth/oidc/start?mode=login&redirect=%2F");
  assert.equal(oidcWebStartUrl("link", "/profile", "ABCD2345"), "/api/auth/oidc/start?mode=link&redirect=%2Fprofile");
});
