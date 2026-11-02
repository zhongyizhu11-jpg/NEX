import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const SCRIPT = String.raw`
  import assert from "node:assert/strict";
  import path from "node:path";
  import { pathToFileURL } from "node:url";
  const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
  const runtime = await import(moduleUrl("server/dbRuntime.ts"));
  const schema = await import(moduleUrl("server/dbSchema.ts"));
  const db = await import(moduleUrl("server/db.ts"));
  const tokens = await import(moduleUrl("server/ops/apiTokens.ts"));
  const { apiTokensRouter, DEFAULT_API_TOKEN_EXPIRY_DAYS } = await import(moduleUrl("server/routers/ops/apiTokens.ts"));
  const { authRouter } = await import(moduleUrl("server/routers/auth.ts"));
  const { usersRouter } = await import(moduleUrl("server/routers/users.ts"));

  const context = (user) => ({
    req: { ip: "127.0.0.1", headers: {}, socket: { remoteAddress: "127.0.0.1" } },
    res: { cookie() {}, clearCookie() {} },
    user,
    authSession: null,
    authFailureReason: null,
  });
  const liveTokens = async (userId) => (await tokens.listUserApiTokens(userId)).length;

  try {
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const adminId = await db.createUser({ username: "admin@example.com", password: "admin-password", role: "admin" });
    const userId = await db.createUser({ username: "user@example.com", password: "user-password" });
    const admin = await db.getUserById(adminId);
    const adminTokens = apiTokensRouter.createCaller(context(admin));

    // 没传有效期：默认 90 天；明确传 null：永不过期；传了几天就几天。
    const before = Date.now();
    const defaulted = await adminTokens.create({ name: "default", scope: "read" });
    const days = (defaulted.expiresAt.getTime() - before) / 86_400_000;
    assert.equal(DEFAULT_API_TOKEN_EXPIRY_DAYS, 90);
    assert.ok(days > 89.9 && days <= 90.01, String(days));
    assert.equal((await adminTokens.create({ name: "never", scope: "read", expiresInDays: null })).expiresAt, null);
    const thirty = await adminTokens.create({ name: "thirty", scope: "full", expiresInDays: 30 });
    assert.ok(Math.abs((thirty.expiresAt.getTime() - before) / 86_400_000 - 30) < 0.01);
    assert.equal(await liveTokens(adminId), 3);

    // 自己改密码：令牌全部作废，之后用旧令牌解析不到人。
    const auth = authRouter.createCaller(context(admin));
    await assert.rejects(auth.changePassword({ oldPassword: "wrong", newPassword: "next-password" }), /当前密码错误/);
    assert.equal(await liveTokens(adminId), 3);
    await auth.changePassword({ oldPassword: "admin-password", newPassword: "next-password" });
    assert.equal(await liveTokens(adminId), 0);
    assert.equal(await tokens.resolveApiToken(defaulted.token, "127.0.0.1"), null);

    // 管理员重置别人的密码、摘掉别人的 2FA：那个人的令牌作废；只改名字不动令牌。
    const userTokens = async (count) => {
      for (let index = 0; index < count; index += 1) {
        await tokens.createUserApiToken({ userId, name: "u" + index, scope: "read", expiresInDays: 30 });
      }
    };
    const users = usersRouter.createCaller(context(await db.getUserById(adminId)));
    await userTokens(2);
    await users.resetPassword({ userId, name: "Renamed" });
    assert.equal(await liveTokens(userId), 2);
    await users.resetPassword({ userId, newPassword: "reset-password" });
    assert.equal(await liveTokens(userId), 0);
    await userTokens(2);
    await db.enableUserTwoFactor(userId, "JBSWY3DPEHPK3PXP");
    await users.removeTwoFactor({ userId });
    assert.equal(await liveTokens(userId), 0);
    assert.equal(await liveTokens(adminId), 0);

    // 登录接口的输入有上限：超长密码直接被参数校验挡下，不去算 scrypt。
    const anonymous = authRouter.createCaller(context(null));
    await assert.rejects(anonymous.login({ username: "user@example.com", password: "x".repeat(2000) }), /密码太长/);
    await assert.rejects(anonymous.login({ username: "u".repeat(400) + "@example.com", password: "x" }), /用户名太长/);
  } finally {
    await runtime.closeDatabase();
  }
`;

test("令牌默认 90 天；改密码、被重置密码、被摘 2FA 后令牌全部作废；登录输入有长度上限", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-api-token-lifecycle-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", SCRIPT], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "tokens.db"), NODE_ENV: "test" },
      encoding: "utf8",
      timeout: 180_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
