import assert from "node:assert/strict";
import type { TrpcContext } from "./_core/context";
import type { AddressInfo } from "node:net";
import express from "express";
import { connectDatabase, closeDatabase } from "./dbRuntime";
import { ensureDatabaseSchema } from "./dbSchema";
import { createUser } from "./repositories/userRepository";
import { getSetting } from "./repositories/settingsRepository";
import { getUserById } from "./repositories/userRepository";
import { authRouter } from "./routers/auth";
import { systemRouter } from "./_core/systemRouter";
import { authCaptcha, authCapRouter } from "./authCaptcha";
import { capSolutions } from "./authCaptchaTestSolver";

/*
  人机验证方式（server/authCaptchaMode.ts）的服务端强制：选了哪种只认哪种，另一种的答案按 CAPTCHA_INVALID，
  另一种的挑战也不发。两个方向都走一遍：登录、注册、找回密码，加上 Cap 的 HTTP 接口。
*/

/** 断言里只看这几样：tRPC 错误的 code / message，返回值里的某个字段。 */
type TrpcErrorLike = { code?: string; message?: string };
type Loose = Record<string, unknown>;

await connectDatabase();
await ensureDatabaseSchema();
const app = express();
app.use(express.json());
app.use(authCapRouter);
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const capBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

try {
  const context = (ip: string, user: unknown = null) => ({
    user, req: { ip, socket: { remoteAddress: ip }, headers: {}, secure: false },
    res: { cookie() {}, clearCookie() {}, setHeader() {} },
  }) as unknown as TrpcContext;
  const adminId = await createUser({ username: "admin@example.com", password: "test-admin-password", role: "admin" });
  const admin = systemRouter.createCaller(context("192.0.2.1", await getUserById(adminId)));
  const userId = await createUser({ username: "user@example.com", password: "test-user-password" });
  const anonymous = systemRouter.createCaller(context("192.0.2.1"));

  /** 某个来源要验证码：连续输错三次。 */
  const requireCaptcha = (ip: string) => {
    for (let i = 0; i < 3; i++) authCaptcha.recordLoginFailure(ip, "user@example.com");
  };
  /** 直接问服务拿一张图片挑战的答案（测试里才这么干）。 */
  const imageChallenge = (ip: string, purpose: "login" | "register") => {
    const challenge = authCaptcha.createImageChallenge(ip, purpose);
    const answer = (authCaptcha as unknown as { challenges: Map<string, { answer: string }> }).challenges.get(challenge.captchaId)!.answer;
    return { captchaId: challenge.captchaId, captchaAnswer: answer };
  };
  /** 走一遍 Cap：发挑战、解、兑换，拿到登录时交的那枚令牌。 */
  const capToken = async (ip: string, purpose: "login" | "register") => {
    const issued = await authCaptcha.createCapChallenge(ip, purpose);
    const redeemed = await authCaptcha.redeemCapChallenge(ip, purpose, issued.token!, capSolutions(issued.token!, issued.challenge));
    assert.equal(redeemed.success, true);
    return redeemed.token!;
  };
  const postCap = (path: string, body: unknown) => fetch(`${capBase}${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

  // ---- 默认：点击验证 ----
  assert.equal(await getSetting("authCaptchaMode"), null);
  assert.equal((await anonymous.publicInfo()).authCaptchaMode, "click");
  assert.equal((await anonymous.getSettings()).authCaptchaMode, "click");
  {
    const ip = "198.51.100.10";
    const auth = authRouter.createCaller(context(ip));
    assert.equal((await auth.emailConfig()).authCaptchaMode, "click");
    assert.equal((await auth.passwordResetOptions()).captchaMode, "click");
    // 点击模式不发图片挑战
    await assert.rejects(auth.createCaptcha({ purpose: "login" }), (error: TrpcErrorLike) => error.code === "FORBIDDEN" && /CAPTCHA_MODE_MISMATCH/.test(error.message ?? ""));
    requireCaptcha(ip);
    assert.equal((await auth.needsCaptcha({ username: "user@example.com" })).mode, "click");
    // 图片答案（哪怕是对的）一律不认，而且算一次失败
    await assert.rejects(auth.login({ username: "user@example.com", password: "test-user-password", ...imageChallenge(ip, "login") }), /CAPTCHA_INVALID/);
    await assert.rejects(auth.register({ username: "new1@example.com", password: "test-new-password", ...imageChallenge(ip, "register") }), /CAPTCHA_INVALID/);
    await assert.rejects(auth.requestPasswordReset({ identifier: "user@example.com", ...imageChallenge(ip, "login") }), /CAPTCHA_INVALID/);
    // 两种一起带也不行：不能让请求自己挑一种来过
    await assert.rejects(auth.login({ username: "user@example.com", password: "test-user-password", capToken: await capToken(ip, "login"), ...imageChallenge(ip, "login") }), /CAPTCHA_INVALID/);
    // 只带选中那一种：照常登录
    assert.equal((await auth.login({ username: "user@example.com", password: "test-user-password", capToken: await capToken(ip, "login") }) as unknown as Loose).id, userId);
  }
  // Cap 的 HTTP 接口在点击模式下照常工作
  {
    const response = await postCap("/api/auth/cap/login/challenge", {});
    assert.equal(response.status, 200);
  }

  // ---- 换成图片验证码 ----
  await admin.updateSettings({ authCaptchaMode: "image" });
  assert.equal(await getSetting("authCaptchaMode"), "image");
  assert.equal((await anonymous.publicInfo()).authCaptchaMode, "image");
  {
    const ip = "198.51.100.20";
    const auth = authRouter.createCaller(context(ip));
    assert.equal((await auth.emailConfig()).authCaptchaMode, "image");
    assert.equal((await auth.passwordResetOptions()).captchaMode, "image");
    const issued = await auth.createCaptcha({ purpose: "login" });
    assert.match(issued.imageDataUrl, /^data:image\/svg\+xml;base64,/);
    requireCaptcha(ip);
    assert.equal((await auth.needsCaptcha({ username: "user@example.com" })).mode, "image");
    // 有效的 Cap 令牌在图片模式下不认
    await assert.rejects(auth.login({ username: "user@example.com", password: "test-user-password", capToken: await capToken(ip, "login") }), /CAPTCHA_INVALID/);
    await assert.rejects(auth.register({ username: "new2@example.com", password: "test-new-password", capToken: await capToken(ip, "register") }), /CAPTCHA_INVALID/);
    // 只带 id 不带答案：验证失败，不是「没验证」
    await assert.rejects(auth.login({ username: "user@example.com", password: "test-user-password", captchaId: issued.captchaId }), /CAPTCHA_INVALID/);
    // 什么都不带：还是 CAPTCHA_REQUIRED（页面据此把验证框画出来）
    await assert.rejects(auth.login({ username: "user@example.com", password: "test-user-password" }), /CAPTCHA_REQUIRED/);
    // 图片答案：登录、注册、找回密码都能过
    assert.equal((await auth.login({ username: "user@example.com", password: "test-user-password", ...imageChallenge(ip, "login") }) as unknown as Loose).id, userId);
  }
  {
    const ip = "198.51.100.21";
    const auth = authRouter.createCaller(context(ip));
    assert.ok((await auth.register({ username: "new3@example.com", password: "test-new-password", ...imageChallenge(ip, "register") })).id);
    await assert.rejects(auth.requestPasswordReset({ identifier: "user@example.com", capToken: "x".repeat(50) }), /CAPTCHA_INVALID/);
    await assert.rejects(auth.requestPasswordReset({ identifier: "user@example.com" }), /CAPTCHA_REQUIRED/);
  }
  // 图片模式下 Cap 的挑战、兑换都不开
  {
    const challenge = await postCap("/api/auth/cap/login/challenge", {});
    assert.equal(challenge.status, 409);
    assert.equal((await challenge.json()).error, "CAPTCHA_MODE_MISMATCH");
    const redeem = await postCap("/api/auth/cap/register/redeem", { token: "a".repeat(50), solutions: [1] });
    assert.equal(redeem.status, 409);
  }

  // 只有管理员能改；存的值认不出来按点击验证
  const ordinary = systemRouter.createCaller(context("192.0.2.1", await getUserById(userId)));
  await assert.rejects(ordinary.updateSettings({ authCaptchaMode: "click" }), (error: TrpcErrorLike) => error.code === "FORBIDDEN");
  await assert.rejects(admin.updateSettings({ authCaptchaMode: "puzzle" as unknown as "click" }));
  await admin.updateSettings({ authCaptchaMode: "click" });
  assert.equal((await anonymous.publicInfo()).authCaptchaMode, "click");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await closeDatabase();
}
