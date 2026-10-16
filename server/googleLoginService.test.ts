import assert from "node:assert/strict";
import test from "node:test";
import {
  allocateUsername,
  deriveUsernameBase,
  GoogleAppFlowStore,
  resolveGoogleSignIn,
  type GoogleSignInDeps,
  type GoogleSignInInput,
} from "./googleLoginService";

type FakeUser = { id: number; username: string; email: string | null; accountEnabled: boolean; googleSub: string | null; googleEmail?: string | null; unusablePassword?: boolean };

function fakeDb(
  initial: FakeUser[],
  policy = { registrationEnabled: true, emailWhitelist: [] as string[] },
  invites: { codes?: Record<string, number>; forceInvite?: boolean } = {},
) {
  const users = initial.map((user) => ({ ...user }));
  const registered: any[] = [];
  const inviteLookups: Array<string | null> = [];
  const deps: GoogleSignInDeps<FakeUser> = {
    async getUserByGoogleSub(sub) {
      return users.find((user) => user.googleSub === sub);
    },
    async getUserById(id) {
      return users.find((user) => user.id === id);
    },
    async linkGoogleAccount(userId, sub, email) {
      if (users.some((user) => user.googleSub === sub)) throw new Error("UNIQUE constraint failed: users.googleSub");
      const user = users.find((item) => item.id === userId && !item.googleSub);
      if (!user) return false;
      user.googleSub = sub;
      user.googleEmail = email;
      return true;
    },
    async isEmailTakenByAnyUser(email) {
      return users.some((user) => user.username.toLowerCase() === email || user.email?.toLowerCase() === email);
    },
    async isUsernameTaken(username) {
      return users.some((user) => user.username.toLowerCase() === username.toLowerCase());
    },
    async registerUser(data) {
      registered.push(data);
      const id = users.length + 100;
      users.push({ id, username: data.username, email: data.email ?? null, accountEnabled: true, googleSub: data.googleSub ?? null, googleEmail: data.googleEmail, unusablePassword: data.unusablePassword });
      return id;
    },
    async getRegistrationPolicy() {
      return policy;
    },
    // 和 resolveRegistrationInviter 一样：认得的码返回邀请人，开了「必须邀请注册」时认不出就抛错
    async resolveInviter(code) {
      inviteLookups.push(code);
      const inviterId = code ? invites.codes?.[code] : undefined;
      if (inviterId) return inviterId;
      if (invites.forceInvite) throw new Error("当前仅支持邀请注册，请填写有效的邀请码");
      return null;
    },
  };
  return { users, registered, inviteLookups, deps };
}

const alice = (): FakeUser => ({ id: 1, username: "alice@example.com", email: "alice@example.com", accountEnabled: true, googleSub: null });
const claims = { sub: "google-sub-1", email: "alice@example.com", name: "Alice" };

function input(overrides: Partial<GoogleSignInInput> = {}): GoogleSignInInput {
  return { mode: "login", claims, allowRegistration: false, allowedDomains: [], linkUserId: null, sessionUserId: null, ...overrides };
}

test("已绑定的 Google 账号直接登录；停用的账号拒绝", async () => {
  const db = fakeDb([{ ...alice(), googleSub: "google-sub-1" }]);
  const outcome = await resolveGoogleSignIn(input(), db.deps);
  assert.equal(outcome.kind, "signed_in");
  assert.equal(outcome.kind === "signed_in" && outcome.user.id, 1);
  assert.equal(outcome.kind === "signed_in" && outcome.created, false);

  db.users[0].accountEnabled = false;
  assert.deepEqual(await resolveGoogleSignIn(input(), db.deps), { kind: "error", code: "account_disabled" });
  assert.deepEqual(await resolveGoogleSignIn(input({ mode: "app" }), db.deps), { kind: "error", code: "account_disabled" });
});

test("没绑定时绝不按邮箱自动并到已有账号上", async () => {
  // 邮箱一模一样的账号就在那儿：不许注册时 → 未绑定
  const db = fakeDb([alice()]);
  assert.deepEqual(await resolveGoogleSignIn(input(), db.deps), { kind: "error", code: "not_linked" });
  assert.equal(db.users[0].googleSub, null, "已有账号没有被偷偷绑上");

  // 允许注册时也不合并，而是提示这个邮箱已有账号
  assert.deepEqual(await resolveGoogleSignIn(input({ allowRegistration: true }), db.deps), { kind: "error", code: "email_in_use" });
  assert.equal(db.users[0].googleSub, null);
  assert.equal(db.registered.length, 0);

  // 大小写不同的同一个邮箱也算撞上
  const upper = fakeDb([{ ...alice(), username: "Alice@Example.com", email: null }]);
  assert.deepEqual(await resolveGoogleSignIn(input({ allowRegistration: true }), upper.deps), { kind: "error", code: "email_in_use" });
});

test("注册受「允许 Google 注册」「开放注册」、邮箱白名单和允许的域名管着", async () => {
  const newcomer = { sub: "google-sub-2", email: "bob@corp.example.org", name: "Bob" };
  // 允许 Google 注册关着
  assert.deepEqual(await resolveGoogleSignIn(input({ claims: newcomer }), fakeDb([]).deps), { kind: "error", code: "not_linked" });
  // 面板关了注册
  assert.deepEqual(
    await resolveGoogleSignIn(input({ claims: newcomer, allowRegistration: true }), fakeDb([], { registrationEnabled: false, emailWhitelist: [] }).deps),
    { kind: "error", code: "registration_closed" },
  );
  // 邮箱白名单：在白名单里（子域名也算）能注册，不在就拒绝
  const allowed = await resolveGoogleSignIn(input({ claims: newcomer, allowRegistration: true }), fakeDb([], { registrationEnabled: true, emailWhitelist: ["example.org"] }).deps);
  assert.equal(allowed.kind === "signed_in" && allowed.created, true);
  const whitelisted = fakeDb([], { registrationEnabled: true, emailWhitelist: ["gmail.com"] });
  assert.deepEqual(await resolveGoogleSignIn(input({ claims: newcomer, allowRegistration: true }), whitelisted.deps), { kind: "error", code: "domain_not_allowed" });
  // Google 登录自己的「允许的域名」：注册、登录、绑定都管
  assert.deepEqual(await resolveGoogleSignIn(input({ claims: newcomer, allowRegistration: true, allowedDomains: ["example.net"] }), fakeDb([]).deps), { kind: "error", code: "domain_not_allowed" });
  const linkedOutside = fakeDb([{ ...alice(), googleSub: "google-sub-1" }]);
  assert.deepEqual(await resolveGoogleSignIn(input({ allowedDomains: ["corp.example.org"] }), linkedOutside.deps), { kind: "error", code: "domain_not_allowed" });
});

test("注册成功：用户名取邮箱前缀去重，没有可用密码，邮箱已验证，同时写上绑定", async () => {
  const db = fakeDb([{ id: 7, username: "bob", email: null, accountEnabled: true, googleSub: null }]);
  const outcome = await resolveGoogleSignIn(input({ claims: { sub: "google-sub-3", email: "bob@example.com", name: "Bob B." }, allowRegistration: true }), db.deps);
  assert.equal(outcome.kind, "signed_in");
  if (outcome.kind !== "signed_in") return;
  assert.equal(outcome.created, true);
  assert.equal(outcome.user.username, "bob2");
  assert.equal(outcome.user.googleSub, "google-sub-3");
  const data = db.registered[0];
  assert.equal(data.unusablePassword, true);
  assert.equal(data.emailVerified, true);
  assert.ok(data.emailVerifiedAt instanceof Date);
  assert.equal(data.email, "bob@example.com");
  assert.equal(data.googleEmail, "bob@example.com");
  assert.equal(data.name, "Bob B.");

  // 同一个 Google 账号再来：认出来是刚建的那个，不再建
  const again = await resolveGoogleSignIn(input({ claims: { sub: "google-sub-3", email: "bob@example.com", name: "Bob" }, allowRegistration: true }), db.deps);
  assert.equal(again.kind === "signed_in" && again.created, false);
  assert.equal(db.registered.length, 1);
});

test("绑定：只绑到发起绑定、现在还登录着的那个人；sub 已在别人那里就拒绝", async () => {
  const db = fakeDb([alice(), { id: 2, username: "carol", email: "carol@example.com", accountEnabled: true, googleSub: "google-sub-9" }]);
  // 发起时登录的是 1，回调时浏览器里登录的不是 1
  assert.deepEqual(await resolveGoogleSignIn(input({ mode: "link", linkUserId: 1, sessionUserId: 2 }), db.deps), { kind: "error", code: "link_requires_login" });
  assert.deepEqual(await resolveGoogleSignIn(input({ mode: "link", linkUserId: 1, sessionUserId: null }), db.deps), { kind: "error", code: "link_requires_login" });
  assert.deepEqual(await resolveGoogleSignIn(input({ mode: "link", linkUserId: null, sessionUserId: 1 }), db.deps), { kind: "error", code: "link_requires_login" });

  // 这个 Google 账号已经绑在 carol 身上
  assert.deepEqual(
    await resolveGoogleSignIn(input({ mode: "link", claims: { ...claims, sub: "google-sub-9" }, linkUserId: 1, sessionUserId: 1 }), db.deps),
    { kind: "error", code: "linked_elsewhere" },
  );
  assert.equal(db.users[0].googleSub, null);

  // 正常绑定（Google 邮箱和面板账号邮箱不同也没关系 —— 认的是 sub）
  const linked = await resolveGoogleSignIn(input({ mode: "link", claims: { ...claims, email: "someone.else@gmail.com" }, linkUserId: 1, sessionUserId: 1 }), db.deps);
  assert.equal(linked.kind, "linked");
  assert.equal(db.users[0].googleSub, "google-sub-1");
  assert.equal(db.users[0].googleEmail, "someone.else@gmail.com");

  // 再绑一次同一个：没事
  const same = await resolveGoogleSignIn(input({ mode: "link", linkUserId: 1, sessionUserId: 1 }), db.deps);
  assert.equal(same.kind === "linked" && same.alreadyLinked, true);
  // 已经绑了一个，再绑另一个：先解绑
  assert.deepEqual(
    await resolveGoogleSignIn(input({ mode: "link", claims: { ...claims, sub: "google-sub-new" }, linkUserId: 1, sessionUserId: 1 }), db.deps),
    { kind: "error", code: "already_linked" },
  );
  // 停用的账号不能绑
  db.users[0].accountEnabled = false;
  assert.deepEqual(await resolveGoogleSignIn(input({ mode: "link", linkUserId: 1, sessionUserId: 1 }), db.deps), { kind: "error", code: "account_disabled" });
});

test("绑定时撞上唯一约束（并发抢绑同一个 sub）按「已被绑定」处理", async () => {
  const db = fakeDb([alice()]);
  db.deps.getUserByGoogleSub = async () => undefined; // 读的时候还没人绑
  db.deps.linkGoogleAccount = async () => { throw Object.assign(new Error("Duplicate entry"), { code: "ER_DUP_ENTRY" }); };
  assert.deepEqual(await resolveGoogleSignIn(input({ mode: "link", linkUserId: 1, sessionUserId: 1 }), db.deps), { kind: "error", code: "linked_elsewhere" });
});

test("用户名：邮箱前缀清洗后去重", async () => {
  assert.equal(deriveUsernameBase("Alice.Smith+tag@gmail.com"), "alice.smith");
  assert.equal(deriveUsernameBase("..__--@x.com"), "user");
  assert.equal(deriveUsernameBase("张三@example.com"), "user");
  assert.equal(deriveUsernameBase("a-b_c@x.io"), "a-b_c");
  assert.equal(deriveUsernameBase(`${"x".repeat(50)}@x.io`).length, 32);
  const taken = new Set(["bob", "bob2", "bob3"]);
  assert.equal(await allocateUsername("bob", async (name) => taken.has(name)), "bob4");
  assert.equal(await allocateUsername("carol", async () => false), "carol");
  assert.match(await allocateUsername("dave", async (name) => !/^dave-/.test(name)), /^dave-[0-9a-f]{6}$/);
});

test("App 流程：start 只能开一次、轮询凭据要对、结果只交出去一次", () => {
  let now = 0;
  const store = new GoogleAppFlowStore({ now: () => now });
  const flow = store.create("203.0.113.9");
  assert.equal(flow.expiresInSeconds, 600);
  assert.equal(store.markStarted(flow.flowId), true);
  assert.equal(store.markStarted(flow.flowId), false, "转发出去的链接再打开就作废");
  assert.deepEqual(store.poll(flow.flowId, flow.pollToken), { status: "pending" });

  assert.equal(store.sameOrigin(flow.flowId, "203.0.113.9"), true);
  assert.equal(store.sameOrigin(flow.flowId, "::ffff:203.0.113.9"), true);
  assert.equal(store.sameOrigin(flow.flowId, "198.51.100.1"), false);
  assert.equal(store.complete(flow.flowId, 42), true);

  assert.deepEqual(store.poll(flow.flowId, "x".repeat(43)), { status: "pending" }, "猜不到轮询凭据就拿不到会话");
  assert.deepEqual(store.poll(flow.flowId, flow.pollToken), { status: "done", userId: 42 });
  assert.deepEqual(store.poll(flow.flowId, flow.pollToken), { status: "expired" }, "只交出去一次");

  const failed = store.create("203.0.113.9");
  store.markStarted(failed.flowId);
  store.fail(failed.flowId, "not_linked");
  assert.deepEqual(store.poll(failed.flowId, failed.pollToken), { status: "failed", code: "not_linked" });

  const stale = store.create("203.0.113.9");
  now += 10 * 60 * 1000;
  assert.equal(store.markStarted(stale.flowId), false);
  assert.deepEqual(store.poll(stale.flowId, stale.pollToken), { status: "expired" });
});

test("App 流程：浏览器和 App 不在同一处时要在浏览器里确认", () => {
  const store = new GoogleAppFlowStore();
  const flow = store.create("2001:db8:1:2::10");
  store.markStarted(flow.flowId);
  assert.equal(store.sameOrigin(flow.flowId, "2001:db8:1:2:abcd::1"), true, "IPv6 同一个 /64");
  assert.equal(store.sameOrigin(flow.flowId, "2001:db8:1:3::1"), false);
  const confirmId = store.requireConfirm(flow.flowId, 7);
  assert.ok(confirmId);
  assert.deepEqual(store.poll(flow.flowId, flow.pollToken), { status: "pending" }, "没确认前 App 拿不到");
  assert.equal(store.confirm(flow.flowId, "wrong"), false);
  assert.equal(store.confirm(flow.flowId, confirmId), true);
  assert.equal(store.confirm(flow.flowId, confirmId), false, "确认也只能一次");
  assert.deepEqual(store.poll(flow.flowId, flow.pollToken), { status: "done", userId: 7 });

  const cancelled = store.create("203.0.113.1");
  assert.equal(store.cancel(cancelled.flowId, "nope"), false);
  assert.equal(store.cancel(cancelled.flowId, cancelled.pollToken), true);
  assert.equal(store.markStarted(cancelled.flowId), false);
});

test("Google 注册走和密码注册同一条邀请规则：带码记邀请人，必须邀请注册时没码不建号", async () => {
  // 带了有效邀请码：新账号记上邀请人
  const invited = fakeDb([], undefined, { codes: { ABCD2345: 7 } });
  const ok = await resolveGoogleSignIn(input({ allowRegistration: true, inviteCode: "ABCD2345" }), invited.deps);
  assert.equal(ok.kind === "signed_in" && ok.created, true);
  assert.equal(invited.registered[0].inviterId, 7);

  // 没开强制邀请、也没带码：照常注册，没有邀请人
  const plain = fakeDb([]);
  const noInvite = await resolveGoogleSignIn(input({ allowRegistration: true }), plain.deps);
  assert.equal(noInvite.kind === "signed_in" && noInvite.created, true);
  assert.equal(plain.registered[0].inviterId, null);

  // 开了「必须邀请注册」：没码或码无效都不建号
  const forced = fakeDb([], undefined, { forceInvite: true, codes: { ABCD2345: 7 } });
  assert.deepEqual(await resolveGoogleSignIn(input({ allowRegistration: true }), forced.deps), { kind: "error", code: "invite_required" });
  assert.deepEqual(await resolveGoogleSignIn(input({ allowRegistration: true, inviteCode: "WRONG999" }), forced.deps), { kind: "error", code: "invite_required" });
  assert.equal(forced.registered.length, 0);

  // 已绑定的账号登录、绑定流程都不看邀请码
  const linked = fakeDb([{ ...alice(), googleSub: "google-sub-1" }], undefined, { forceInvite: true });
  assert.equal((await resolveGoogleSignIn(input(), linked.deps)).kind, "signed_in");
  assert.deepEqual(linked.inviteLookups, []);
});
