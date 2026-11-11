import assert from "node:assert/strict";
import type { TrpcContext } from "./_core/context";
import { connectDatabase, closeDatabase } from "./dbRuntime";
import { ensureDatabaseSchema } from "./dbSchema";
import { createTelegramLoginCode, createUser, getUserById } from "./repositories/userRepository";
import { getSetting, setSetting } from "./repositories/settingsRepository";
import { telegramRouter } from "./routers/telegram";
import { authRouter } from "./routers/auth";
import { systemRouter } from "./_core/systemRouter";
import { parseUiPreferences } from "../shared/uiPreferences";

/*
  两样按账号 / 按站的开关在服务端的样子：
  1. Telegram 登录单独开关（server/telegramLoginSwitch.ts）：关了所有 Telegram 登录过程都拒绝，绑定和机器人照旧。
  2. 按账号保存的界面偏好（auth.updateUiPreferences）：只改提交的那一项，清洗后落库，auth.me 带回来。
*/

/** 断言里只看这几样：tRPC 错误的 code / message，返回值里的某个字段。 */
type TrpcErrorLike = { code?: string; message?: string };
type Loose = Record<string, unknown>;

await connectDatabase();
await ensureDatabaseSchema();
try {
  const ip = "192.0.2.120";
  const context = (user: unknown = null) => ({
    user, req: { ip, socket: { remoteAddress: ip }, headers: {}, secure: false, get: () => "" },
    res: { cookie() {}, clearCookie() {}, setHeader() {} },
  }) as unknown as TrpcContext;
  const adminId = await createUser({ username: "admin@example.com", password: "test-admin-password", role: "admin" });
  const admin = systemRouter.createCaller(context(await getUserById(adminId)));
  const anonymous = systemRouter.createCaller(context());
  const userId = await createUser({ username: "user@example.com", password: "test-user-password" });
  await setSetting("telegramBotToken", "123456:fixture-token-for-telegram-login-switch");
  await setSetting("telegramBotEnabled", "true");
  await setSetting("telegramBotUsername", "fixture_bot");

  // ---- 1. Telegram 登录：默认开 ----
  assert.equal(await getSetting("telegramLoginEnabled"), null);
  assert.equal((await anonymous.publicInfo()).telegramLoginEnabled, true);
  const tgAnonymous = telegramRouter.createCaller(context());
  assert.equal((await tgAnonymous.loginStatus()).loginEnabled, true);
  await createTelegramLoginCode(userId, "FIXTURELOGINCODE0001", new Date(Date.now() + 60_000));
  assert.equal((await tgAnonymous.previewLogin({ code: "FIXTURELOGINCODE0001" })).username, "user@example.com");
  assert.equal((await tgAnonymous.login({ code: "FIXTURELOGINCODE0001" }) as unknown as Loose).id, userId);
  const mobile = await tgAnonymous.startMobileLogin();
  assert.match(mobile.code, /^APP/);

  // 关掉：登录页拿到 false，所有 Telegram 登录过程都拒绝（而且在消费登录码之前）
  // 只有管理员能关
  await assert.rejects(systemRouter.createCaller(context(await getUserById(userId))).updateSettings({ telegramLoginEnabled: false }), (error: TrpcErrorLike) => error.code === "FORBIDDEN");
  await admin.updateSettings({ telegramLoginEnabled: false });
  assert.equal(await getSetting("telegramLoginEnabled"), "false");
  assert.equal((await anonymous.publicInfo()).telegramLoginEnabled, false);
  assert.equal((await anonymous.getSettings()).telegramLoginEnabled, false);
  assert.equal((await tgAnonymous.loginStatus()).loginEnabled, false);
  await createTelegramLoginCode(userId, "FIXTURELOGINCODE0002", new Date(Date.now() + 60_000));
  const disabled = (error: TrpcErrorLike) => error.code === "FORBIDDEN" && error.message === "TELEGRAM_LOGIN_DISABLED";
  await assert.rejects(tgAnonymous.previewLogin({ code: "FIXTURELOGINCODE0002" }), disabled);
  await assert.rejects(tgAnonymous.login({ code: "FIXTURELOGINCODE0002" }), disabled);
  await assert.rejects(tgAnonymous.startMobileLogin(), disabled);
  await assert.rejects(tgAnonymous.mobileLoginStatus({ code: mobile.code, pollToken: mobile.pollToken }), disabled);
  await assert.rejects(tgAnonymous.loginWithWidget({ id: "123456", auth_date: Math.floor(Date.now() / 1000), hash: "a".repeat(64) }), disabled);
  await assert.rejects(tgAnonymous.loginWithWebApp({ initData: "query_id=fixture&user=%7B%7D&hash=abc" }), disabled);
  // 被拒的那次没有把登录码用掉：重新打开以后它照样能用
  assert.equal((await getUserById(userId) as unknown as Loose).telegramLoginCode, "FIXTURELOGINCODE0002");

  // 绑定、机器人状态不受影响
  const tgUser = telegramRouter.createCaller(context(await getUserById(userId)));
  const status = await tgUser.status();
  assert.equal(status.enabled, true);
  assert.equal(status.configured, true);
  const bind = await tgUser.createBindCode();
  assert.match(bind.code, /^TG-/);

  await admin.updateSettings({ telegramLoginEnabled: true });
  assert.equal((await tgAnonymous.login({ code: "FIXTURELOGINCODE0002" }) as unknown as Loose).id, userId);
  // 解绑（关着登录时也一样能用，这里放在最后：解绑会顺带清掉没用完的登录码）
  await admin.updateSettings({ telegramLoginEnabled: false });
  assert.deepEqual(await tgUser.unbind(), { success: true });
  await admin.updateSettings({ telegramLoginEnabled: true });

  // ---- 2. 界面偏好 ----
  const me = async () => authRouter.createCaller(context(await getUserById(userId)));
  assert.equal((await (await me()).me() as unknown as Loose).uiPreferences ?? null, null);
  // 关动画
  let result = await (await me()).updateUiPreferences({ motion: false });
  assert.deepEqual(JSON.parse(result.uiPreferences!), { motion: false });
  // 改主机表的列：结构清洗（重复、非法 key、超范围宽度）后落库；动画那一项不被盖掉
  result = await (await me()).updateUiPreferences({
    table: { id: "hosts", columns: { order: ["traffic", "traffic", "bad key!", "runtime"], hidden: ["systemTotal"], widths: { name: 99999, traffic: 10 } } },
  });
  const stored = parseUiPreferences(result.uiPreferences);
  assert.equal(stored.motion, false);
  assert.deepEqual(stored.tables?.hosts, { order: ["traffic", "runtime"], hidden: ["systemTotal"], widths: { name: 1200, traffic: 48 } });
  assert.equal((await (await me()).me() as unknown as Loose).uiPreferences, result.uiPreferences);
  // 不认识的表直接拒
  await assert.rejects((await me()).updateUiPreferences({ table: { id: "nope" as unknown as "hosts", columns: null } }));
  // 恢复默认：两项都清掉后存 null
  await (await me()).updateUiPreferences({ table: { id: "hosts", columns: null } });
  result = await (await me()).updateUiPreferences({ motion: null });
  assert.equal(result.uiPreferences, null);
  // 没登录不能改
  await assert.rejects(authRouter.createCaller(context()).updateUiPreferences({ motion: false }), (error: TrpcErrorLike) => error.code === "UNAUTHORIZED");
} finally {
  await closeDatabase();
}
