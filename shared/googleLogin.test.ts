import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGoogleRedirectUri,
  googleLoginErrorMessage,
  isEmailDomainAllowed,
  isGoogleAcceptableRedirectBase,
  parseEmailDomainList,
  sanitizeRedirectPath,
} from "./googleLogin";

test("登录后跳回的地址只接受本站相对路径", () => {
  assert.equal(sanitizeRedirectPath("/"), "/");
  assert.equal(sanitizeRedirectPath("/rules?tab=all#top"), "/rules?tab=all#top");
  assert.equal(sanitizeRedirectPath("/profile"), "/profile");
  assert.equal(sanitizeRedirectPath("/a/../b"), "/b");

  for (const bad of [
    "//evil.com",
    "//evil.com/path",
    "/\\evil.com",
    "\\\\evil.com",
    "https://evil.com",
    "http:/evil.com",
    "javascript:alert(1)",
    "evil.com",
    "rules",
    " //evil.com",
    "/\tevil",
    "/%0d%0aSet-Cookie:x",
    "/api/trpc/auth.logout",
    "/API/auth/google/start",
    "",
    "/" + "a".repeat(600),
  ]) {
    const result = sanitizeRedirectPath(bad);
    assert.ok(result === "/" || (result.startsWith("/") && !result.startsWith("//") && !/^\/api/i.test(result)), `${JSON.stringify(bad)} → ${result}`);
  }
  assert.equal(sanitizeRedirectPath("//evil.com"), "/");
  assert.equal(sanitizeRedirectPath("/\\evil.com"), "/");
  assert.equal(sanitizeRedirectPath("https://evil.com"), "/");
  assert.equal(sanitizeRedirectPath("/api/trpc/x"), "/");
  assert.equal(sanitizeRedirectPath(undefined, "/profile"), "/profile");
  assert.equal(sanitizeRedirectPath(["/a"]), "/");
  // %0d%0a 只是路径里的转义字符，留在路径里不会变成响应头；但它不能变成跨站
  assert.ok(sanitizeRedirectPath("/%0d%0aSet-Cookie:x").startsWith("/%0"));
});

test("回调地址从面板公开地址拼出来", () => {
  assert.equal(buildGoogleRedirectUri("https://panel.example.com/"), "https://panel.example.com/api/auth/google/callback");
  assert.equal(buildGoogleRedirectUri("https://panel.example.com:8443"), "https://panel.example.com:8443/api/auth/google/callback");
  assert.equal(buildGoogleRedirectUri("https://example.com/nex/"), "https://example.com/nex/api/auth/google/callback");
  assert.equal(buildGoogleRedirectUri(""), "");
  assert.equal(buildGoogleRedirectUri("ftp://x"), "");
  assert.equal(buildGoogleRedirectUri("not a url"), "");
  assert.equal(isGoogleAcceptableRedirectBase("https://panel.example.com"), true);
  assert.equal(isGoogleAcceptableRedirectBase("http://localhost:3000"), true);
  assert.equal(isGoogleAcceptableRedirectBase("http://1.2.3.4:9810"), false);
});

test("邮箱域名限制：等于或是子域名才算", () => {
  assert.deepEqual(parseEmailDomainList(" Example.com, @corp.example.org，bad_domain, x"), ["example.com", "corp.example.org"]);
  assert.deepEqual(parseEmailDomainList(""), []);
  const domains = parseEmailDomainList("example.com");
  assert.equal(isEmailDomainAllowed("a@example.com", domains), true);
  assert.equal(isEmailDomainAllowed("a@mail.example.com", domains), true);
  assert.equal(isEmailDomainAllowed("a@EXAMPLE.COM", domains), true);
  assert.equal(isEmailDomainAllowed("a@notexample.com", domains), false);
  assert.equal(isEmailDomainAllowed("a@example.com.evil.io", domains), false);
  assert.equal(isEmailDomainAllowed("broken", domains), false);
  assert.equal(isEmailDomainAllowed("a@anything.io", []), true, "列表为空 = 不限");
});

test("失败码对应中文，认不出的码不原样显示", () => {
  assert.match(googleLoginErrorMessage("not_linked"), /还没绑定面板账号/);
  assert.match(googleLoginErrorMessage("not_linked"), /账号设置/);
  assert.equal(googleLoginErrorMessage("<script>"), googleLoginErrorMessage("server_error"));
  assert.equal(googleLoginErrorMessage("toString"), googleLoginErrorMessage("server_error"));
});
