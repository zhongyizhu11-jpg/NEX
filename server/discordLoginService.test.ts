import assert from "node:assert/strict";
import test from "node:test";
import { DiscordAppFlowStore, resolveDiscordSignIn, type DiscordSignInDeps, type DiscordSignInInput } from "./discordLoginService";

type FakeUser = { id: number; username: string; email: string | null; accountEnabled: boolean; discordId: string | null; discordUsername?: string | null; discordEmail?: string | null };

function fakeDb(
  initial: FakeUser[],
  policy = { registrationEnabled: true, emailWhitelist: [] as string[] },
  invites: { codes?: Record<string, number>; forceInvite?: boolean } = {},
) {
  const users = initial.map((user) => ({ ...user }));
  const registered: any[] = [];
  const inviteLookups: Array<string | null> = [];
  const deps: DiscordSignInDeps<FakeUser> = {
    async getUserByDiscordId(id) {
      return users.find((user) => user.discordId === id);
    },
    async getUserById(id) {
      return users.find((user) => user.id === id);
    },
    async linkDiscordAccount(userId, discordId, username, email) {
      if (users.some((user) => user.discordId === discordId)) throw new Error("UNIQUE constraint failed: users.discordId");
      const user = users.find((item) => item.id === userId && !item.discordId);
      if (!user) return false;
      user.discordId = discordId;
      user.discordUsername = username;
      user.discordEmail = email;
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
      users.push({ id, username: data.username, email: data.email ?? null, accountEnabled: true, discordId: data.discordId ?? null, discordUsername: data.discordUsername, discordEmail: data.discordEmail });
      return id;
    },
    async getRegistrationPolicy() {
      return policy;
    },
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

const DISCORD_ID = "80351110224678912";
const alice = (): FakeUser => ({ id: 1, username: "alice@example.com", email: "alice@example.com", accountEnabled: true, discordId: null });
const profile = { id: DISCORD_ID, username: "alice_d", globalName: "Alice", email: "alice@example.com" };

function input(overrides: Partial<DiscordSignInInput> = {}): DiscordSignInInput {
  return { mode: "login", profile, allowRegistration: false, allowedDomains: [], linkUserId: null, sessionUserId: null, ...overrides };
}

test("已绑定的 Discord 账号直接登录；停用的账号拒绝", async () => {
  const db = fakeDb([{ ...alice(), discordId: DISCORD_ID }]);
  const outcome = await resolveDiscordSignIn(input(), db.deps);
  assert.equal(outcome.kind === "signed_in" && outcome.user.id, 1);
  assert.equal(outcome.kind === "signed_in" && outcome.created, false);
  db.users[0].accountEnabled = false;
  assert.deepEqual(await resolveDiscordSignIn(input(), db.deps), { kind: "error", code: "account_disabled" });
  assert.deepEqual(await resolveDiscordSignIn(input({ mode: "app" }), db.deps), { kind: "error", code: "account_disabled" });
});

test("只按 Discord ID 认人：没绑定时绝不按邮箱自动并到已有账号上", async () => {
  const db = fakeDb([alice()]);
  assert.deepEqual(await resolveDiscordSignIn(input(), db.deps), { kind: "error", code: "not_linked" });
  assert.equal(db.users[0].discordId, null, "已有账号没有被偷偷绑上");
  assert.deepEqual(await resolveDiscordSignIn(input({ allowRegistration: true }), db.deps), { kind: "error", code: "email_in_use" });
  assert.equal(db.registered.length, 0);
  // 用户名和面板账号一样也不算
  const sameName = fakeDb([{ ...alice(), username: "alice_d", email: "other@example.com" }]);
  assert.deepEqual(await resolveDiscordSignIn(input(), sameName.deps), { kind: "error", code: "not_linked" });
});

test("注册受「允许 Discord 注册」「开放注册」、邮箱白名单和允许的域名管着", async () => {
  const newcomer = { id: "175928847299117063", username: "bob", globalName: "Bob", email: "bob@corp.example.org" };
  assert.deepEqual(await resolveDiscordSignIn(input({ profile: newcomer }), fakeDb([]).deps), { kind: "error", code: "not_linked" });
  assert.deepEqual(
    await resolveDiscordSignIn(input({ profile: newcomer, allowRegistration: true }), fakeDb([], { registrationEnabled: false, emailWhitelist: [] }).deps),
    { kind: "error", code: "registration_closed" },
  );
  const allowed = await resolveDiscordSignIn(input({ profile: newcomer, allowRegistration: true }), fakeDb([], { registrationEnabled: true, emailWhitelist: ["example.org"] }).deps);
  assert.equal(allowed.kind === "signed_in" && allowed.created, true);
  assert.deepEqual(
    await resolveDiscordSignIn(input({ profile: newcomer, allowRegistration: true }), fakeDb([], { registrationEnabled: true, emailWhitelist: ["gmail.com"] }).deps),
    { kind: "error", code: "domain_not_allowed" },
  );
  assert.deepEqual(await resolveDiscordSignIn(input({ profile: newcomer, allowRegistration: true, allowedDomains: ["example.net"] }), fakeDb([]).deps), { kind: "error", code: "domain_not_allowed" });
  // 允许的域名对已绑定账号的登录、绑定同样生效
  const linkedOutside = fakeDb([{ ...alice(), discordId: DISCORD_ID }]);
  assert.deepEqual(await resolveDiscordSignIn(input({ allowedDomains: ["corp.example.org"] }), linkedOutside.deps), { kind: "error", code: "domain_not_allowed" });
  assert.deepEqual(await resolveDiscordSignIn(input({ mode: "link", linkUserId: 1, sessionUserId: 1, allowedDomains: ["corp.example.org"] }), fakeDb([alice()]).deps), { kind: "error", code: "domain_not_allowed" });
});

test("注册成功：用户名取 Discord 用户名去重，没有可用密码，邮箱已验证，同时写上绑定", async () => {
  const db = fakeDb([{ id: 7, username: "bob", email: null, accountEnabled: true, discordId: null }]);
  const outcome = await resolveDiscordSignIn(input({ profile: { id: "175928847299117063", username: "bob", globalName: "Bob B.", email: "bob@example.com" }, allowRegistration: true }), db.deps);
  assert.equal(outcome.kind, "signed_in");
  if (outcome.kind !== "signed_in") return;
  assert.equal(outcome.created, true);
  assert.equal(outcome.user.username, "bob2");
  assert.equal(outcome.user.discordId, "175928847299117063");
  const data = db.registered[0];
  assert.equal(data.unusablePassword, true);
  assert.equal(data.password, "");
  assert.equal(data.emailVerified, true);
  assert.equal(data.email, "bob@example.com");
  assert.equal(data.discordEmail, "bob@example.com");
  assert.equal(data.discordUsername, "bob");
  assert.equal(data.name, "Bob B.");
  // 显示名没有时用用户名；奇怪的用户名退回邮箱前缀
  const odd = fakeDb([]);
  const oddOutcome = await resolveDiscordSignIn(input({ profile: { id: "175928847299117064", username: "...", globalName: null, email: "carol@example.com" }, allowRegistration: true }), odd.deps);
  assert.equal(oddOutcome.kind === "signed_in" && oddOutcome.user.username, "carol");
  // 同一个 Discord 账号再来：认出来是刚建的那个，不再建
  const again = await resolveDiscordSignIn(input({ profile: { id: "175928847299117063", username: "bob", globalName: null, email: "bob@example.com" }, allowRegistration: true }), db.deps);
  assert.equal(again.kind === "signed_in" && again.created, false);
  assert.equal(db.registered.length, 1);
});

test("绑定：只绑到发起绑定、现在还登录着的那个人；ID 已在别人那里就拒绝", async () => {
  const db = fakeDb([alice(), { id: 2, username: "carol", email: "carol@example.com", accountEnabled: true, discordId: "175928847299117999" }]);
  assert.deepEqual(await resolveDiscordSignIn(input({ mode: "link", linkUserId: 1, sessionUserId: 2 }), db.deps), { kind: "error", code: "link_requires_login" });
  assert.deepEqual(await resolveDiscordSignIn(input({ mode: "link", linkUserId: 1, sessionUserId: null }), db.deps), { kind: "error", code: "link_requires_login" });
  assert.deepEqual(await resolveDiscordSignIn(input({ mode: "link", linkUserId: null, sessionUserId: 1 }), db.deps), { kind: "error", code: "link_requires_login" });
  assert.deepEqual(
    await resolveDiscordSignIn(input({ mode: "link", profile: { ...profile, id: "175928847299117999" }, linkUserId: 1, sessionUserId: 1 }), db.deps),
    { kind: "error", code: "linked_elsewhere" },
  );
  assert.equal(db.users[0].discordId, null);

  const linked = await resolveDiscordSignIn(input({ mode: "link", profile: { ...profile, email: "someone.else@gmail.com" }, linkUserId: 1, sessionUserId: 1 }), db.deps);
  assert.equal(linked.kind, "linked");
  assert.equal(db.users[0].discordId, DISCORD_ID);
  assert.equal(db.users[0].discordUsername, "alice_d");
  assert.equal(db.users[0].discordEmail, "someone.else@gmail.com");

  const same = await resolveDiscordSignIn(input({ mode: "link", linkUserId: 1, sessionUserId: 1 }), db.deps);
  assert.equal(same.kind === "linked" && same.alreadyLinked, true);
  assert.deepEqual(
    await resolveDiscordSignIn(input({ mode: "link", profile: { ...profile, id: "175928847299117000" }, linkUserId: 1, sessionUserId: 1 }), db.deps),
    { kind: "error", code: "already_linked" },
  );
  db.users[0].accountEnabled = false;
  assert.deepEqual(await resolveDiscordSignIn(input({ mode: "link", linkUserId: 1, sessionUserId: 1 }), db.deps), { kind: "error", code: "account_disabled" });
});

test("绑定时撞上唯一约束（并发抢绑同一个 ID）按「已被绑定」处理", async () => {
  const db = fakeDb([alice()]);
  db.deps.getUserByDiscordId = async () => undefined;
  db.deps.linkDiscordAccount = async () => { throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" }); };
  assert.deepEqual(await resolveDiscordSignIn(input({ mode: "link", linkUserId: 1, sessionUserId: 1 }), db.deps), { kind: "error", code: "linked_elsewhere" });
});

test("Discord 注册走和密码注册同一条邀请规则：带码记邀请人，必须邀请注册时没码不建号", async () => {
  const invited = fakeDb([], undefined, { codes: { ABCD2345: 7 } });
  const ok = await resolveDiscordSignIn(input({ profile: { ...profile, email: "new@example.com" }, allowRegistration: true, inviteCode: "ABCD2345" }), invited.deps);
  assert.equal(ok.kind === "signed_in" && ok.created, true);
  assert.equal(invited.registered[0].inviterId, 7);

  const plain = fakeDb([]);
  await resolveDiscordSignIn(input({ profile: { ...profile, email: "new@example.com" }, allowRegistration: true }), plain.deps);
  assert.equal(plain.registered[0].inviterId, null);

  const forced = fakeDb([], undefined, { forceInvite: true, codes: { ABCD2345: 7 } });
  assert.deepEqual(await resolveDiscordSignIn(input({ profile: { ...profile, email: "new@example.com" }, allowRegistration: true }), forced.deps), { kind: "error", code: "invite_required" });
  assert.deepEqual(await resolveDiscordSignIn(input({ profile: { ...profile, email: "new@example.com" }, allowRegistration: true, inviteCode: "WRONG999" }), forced.deps), { kind: "error", code: "invite_required" });
  assert.equal(forced.registered.length, 0);

  const linked = fakeDb([{ ...alice(), discordId: DISCORD_ID }], undefined, { forceInvite: true });
  assert.equal((await resolveDiscordSignIn(input(), linked.deps)).kind, "signed_in");
  assert.deepEqual(linked.inviteLookups, [], "已绑定的账号登录不看邀请码");
});

test("App 流程：start 只开一次、轮询凭据要对、结果只交出去一次、IP 不同要确认", () => {
  let now = 0;
  const store = new DiscordAppFlowStore({ now: () => now });
  const flow = store.create("203.0.113.9");
  assert.equal(flow.expiresInSeconds, 600);
  assert.equal(store.markStarted(flow.flowId), true);
  assert.equal(store.markStarted(flow.flowId), false);
  assert.deepEqual(store.poll(flow.flowId, flow.pollToken), { status: "pending" });
  assert.equal(store.complete(flow.flowId, 42), true);
  assert.deepEqual(store.poll(flow.flowId, "x".repeat(43)), { status: "pending" });
  assert.deepEqual(store.poll(flow.flowId, flow.pollToken), { status: "done", userId: 42 });
  assert.deepEqual(store.poll(flow.flowId, flow.pollToken), { status: "expired" });

  const failed = store.create("203.0.113.9");
  store.markStarted(failed.flowId);
  store.fail(failed.flowId, "email_unverified");
  assert.deepEqual(store.poll(failed.flowId, failed.pollToken), { status: "failed", code: "email_unverified" });

  const far = store.create("2001:db8:1:2::10");
  store.markStarted(far.flowId);
  assert.equal(store.sameOrigin(far.flowId, "2001:db8:1:2:abcd::1"), true);
  assert.equal(store.sameOrigin(far.flowId, "198.51.100.1"), false);
  const confirmId = store.requireConfirm(far.flowId, 7)!;
  assert.deepEqual(store.poll(far.flowId, far.pollToken), { status: "pending" });
  assert.equal(store.confirm(far.flowId, "wrong"), false);
  assert.equal(store.confirm(far.flowId, confirmId), true);
  assert.deepEqual(store.poll(far.flowId, far.pollToken), { status: "done", userId: 7 });

  const stale = store.create("203.0.113.9");
  now += 10 * 60 * 1000;
  assert.equal(store.markStarted(stale.flowId), false);
});
