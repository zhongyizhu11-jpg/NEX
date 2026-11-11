import assert from "node:assert/strict";
import test from "node:test";
import { activeOidcSubOf, resolveOidcSignIn, type OidcSignInDeps, type OidcSignInInput } from "./oidcLoginService";

/*
  通用 OIDC「认出一个身份之后让谁登录」：按 (issuer, sub) 认人；登录 / 注册 / 绑定三条路各自的规则；
  绝不按邮箱自动并到已有账号上；邮箱域名限制；换了 Issuer 之后的旧绑定。
*/

const ISSUER = "https://id.example.com";

type FakeUser = {
  id: number;
  username: string;
  email: string | null;
  emailVerified?: boolean;
  accountEnabled: boolean;
  oidcIssuer: string | null;
  oidcSub: string | null;
  oidcEmail?: string | null;
};

function fakeDb(initial: FakeUser[], policy = { registrationEnabled: true, emailWhitelist: [] as string[] }, invites: { codes?: Record<string, number>; forceInvite?: boolean } = {}) {
  const users = initial.map((user) => ({ ...user }));
  const registered: any[] = [];
  const deps: OidcSignInDeps<FakeUser> = {
    async getUserByOidcIdentity(issuer, sub) {
      return users.find((user) => user.oidcIssuer === issuer && user.oidcSub === sub);
    },
    async getUserById(id) {
      return users.find((user) => user.id === id);
    },
    // 和 SQL 一样：(issuer, sub) 唯一；只在没绑过、或者绑的是别的 Issuer 时写
    async linkOidcAccount(userId, issuer, sub, email) {
      if (users.some((user) => user.oidcIssuer === issuer && user.oidcSub === sub)) throw new Error("UNIQUE constraint failed: users.oidcIssuer, users.oidcSub");
      const user = users.find((item) => item.id === userId && (!item.oidcSub || item.oidcIssuer !== issuer));
      if (!user) return false;
      Object.assign(user, { oidcIssuer: issuer, oidcSub: sub, oidcEmail: email });
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
      users.push({ id, username: data.username, email: data.email ?? null, emailVerified: data.emailVerified, accountEnabled: true, oidcIssuer: data.oidcIssuer, oidcSub: data.oidcSub, oidcEmail: data.oidcEmail });
      return id;
    },
    async getRegistrationPolicy() {
      return policy;
    },
    async resolveInviter(code) {
      const inviterId = code ? invites.codes?.[code] : undefined;
      if (inviterId) return inviterId;
      if (invites.forceInvite) throw new Error("当前仅支持邀请注册");
      return null;
    },
  };
  return { users, registered, deps };
}

const alice = (overrides: Partial<FakeUser> = {}): FakeUser => ({ id: 1, username: "alice", email: "alice@example.com", accountEnabled: true, oidcIssuer: null, oidcSub: null, ...overrides });

function input(overrides: Partial<OidcSignInInput> = {}): OidcSignInInput {
  return {
    mode: "login",
    issuer: ISSUER,
    claims: { sub: "sub-1", name: "Alice", preferredUsername: "alice.pid" },
    email: "alice@example.com",
    emailVerified: true,
    allowRegistration: false,
    allowedDomains: [],
    linkUserId: null,
    sessionUserId: null,
    ...overrides,
  };
}

test("登录：已绑定 (issuer, sub) 的账号直接登录；停用的拒绝；同 sub 换了 Issuer 不是同一个人", async () => {
  const { deps } = fakeDb([alice({ oidcIssuer: ISSUER, oidcSub: "sub-1" })]);
  const outcome = await resolveOidcSignIn(input(), deps);
  assert.equal(outcome.kind, "signed_in");
  assert.equal(outcome.kind === "signed_in" && outcome.user.id, 1);
  assert.equal(outcome.kind === "signed_in" && outcome.created, false);

  const other = await resolveOidcSignIn(input({ issuer: "https://other-idp.example.com" }), deps);
  assert.deepEqual(other, { kind: "error", code: "not_linked" }, "另一个 IdP 里同样的 sub 不能登录 alice");

  const disabled = fakeDb([alice({ oidcIssuer: ISSUER, oidcSub: "sub-1", accountEnabled: false })]);
  assert.deepEqual(await resolveOidcSignIn(input(), disabled.deps), { kind: "error", code: "account_disabled" });
});

test("没绑定时绝不按邮箱自动并到已有账号上（哪怕邮箱一模一样、已验证）", async () => {
  const db = fakeDb([alice()]);
  assert.deepEqual(await resolveOidcSignIn(input(), db.deps), { kind: "error", code: "not_linked" });
  assert.equal(db.users[0].oidcSub, null);
  // 允许注册时也不合并，也不另建一个同邮箱的账号
  assert.deepEqual(await resolveOidcSignIn(input({ allowRegistration: true }), db.deps), { kind: "error", code: "email_in_use" });
  assert.equal(db.registered.length, 0);
  assert.equal(db.users[0].oidcSub, null);
});

test("注册：要管理员允许、注册开着、过白名单和域名限制、邀请码规则和密码注册一样", async () => {
  const fresh = { email: "new@fresh.io", claims: { sub: "sub-new", name: "New", preferredUsername: "alice" } };
  assert.deepEqual(await resolveOidcSignIn(input(fresh), fakeDb([alice()]).deps), { kind: "error", code: "not_linked" });
  assert.deepEqual(
    await resolveOidcSignIn(input({ ...fresh, allowRegistration: true }), fakeDb([alice()], { registrationEnabled: false, emailWhitelist: [] }).deps),
    { kind: "error", code: "registration_closed" },
  );
  assert.deepEqual(
    await resolveOidcSignIn(input({ ...fresh, allowRegistration: true }), fakeDb([alice()], { registrationEnabled: true, emailWhitelist: ["corp.io"] }).deps),
    { kind: "error", code: "domain_not_allowed" },
  );
  assert.deepEqual(
    await resolveOidcSignIn(input({ ...fresh, allowRegistration: true }), fakeDb([alice()], undefined, { forceInvite: true }).deps),
    { kind: "error", code: "invite_required" },
  );

  const db = fakeDb([alice()], undefined, { codes: { ABCD2345: 1 } });
  const outcome = await resolveOidcSignIn(input({ ...fresh, allowRegistration: true, inviteCode: "ABCD2345" }), db.deps);
  assert.equal(outcome.kind, "signed_in");
  assert.equal(outcome.kind === "signed_in" && outcome.created, true);
  const data = db.registered[0];
  assert.equal(data.username, "alice2", "用 IdP 的用户名，被占了加数字");
  assert.equal(data.oidcIssuer, ISSUER);
  assert.equal(data.oidcSub, "sub-new");
  assert.equal(data.oidcEmail, "new@fresh.io");
  assert.equal(data.unusablePassword, true);
  assert.equal(data.emailVerified, true);
  assert.equal(data.inviterId, 1);
});

test("注册：管理员关了「只接受已验证邮箱」时，未验证的邮箱建号但不记成已验证", async () => {
  const db = fakeDb([]);
  const outcome = await resolveOidcSignIn(input({ allowRegistration: true, emailVerified: false, email: "u@fresh.io", claims: { sub: "s", name: null, preferredUsername: null } }), db.deps);
  assert.equal(outcome.kind, "signed_in");
  assert.equal(db.registered[0].emailVerified, false);
  assert.equal(db.registered[0].emailVerifiedAt, null);
  assert.equal(db.registered[0].username, "u", "没有用户名提示就用邮箱前缀");
});

test("邮箱域名限制对登录、绑定、注册都生效（子域名算在内）", async () => {
  const bound = fakeDb([alice({ oidcIssuer: ISSUER, oidcSub: "sub-1" })]);
  assert.deepEqual(await resolveOidcSignIn(input({ allowedDomains: ["corp.io"] }), bound.deps), { kind: "error", code: "domain_not_allowed" });
  assert.equal((await resolveOidcSignIn(input({ allowedDomains: ["example.com"] }), bound.deps)).kind, "signed_in");
  assert.equal((await resolveOidcSignIn(input({ allowedDomains: ["example.com"], email: "a@mail.example.com" }), bound.deps)).kind, "signed_in");
  const link = fakeDb([alice()]);
  assert.deepEqual(
    await resolveOidcSignIn(input({ mode: "link", linkUserId: 1, sessionUserId: 1, allowedDomains: ["corp.io"] }), link.deps),
    { kind: "error", code: "domain_not_allowed" },
  );
});

test("绑定：只绑到发起绑定、回调时还登录着的那个人；身份已在别人那里就拒绝", async () => {
  const bob = { id: 2, username: "bob", email: "bob@example.com", accountEnabled: true, oidcIssuer: null, oidcSub: null };
  const db = fakeDb([alice(), bob]);
  assert.deepEqual(await resolveOidcSignIn(input({ mode: "link", linkUserId: 1, sessionUserId: null }), db.deps), { kind: "error", code: "link_requires_login" });
  assert.deepEqual(await resolveOidcSignIn(input({ mode: "link", linkUserId: 1, sessionUserId: 2 }), db.deps), { kind: "error", code: "link_requires_login" }, "回调时换了人");

  const linked = await resolveOidcSignIn(input({ mode: "link", linkUserId: 1, sessionUserId: 1, email: "whatever@else.io" }), db.deps);
  assert.equal(linked.kind, "linked");
  assert.deepEqual([db.users[0].oidcIssuer, db.users[0].oidcSub, db.users[0].oidcEmail], [ISSUER, "sub-1", "whatever@else.io"], "绑定不看邮箱是否一致");
  assert.deepEqual(await resolveOidcSignIn(input({ mode: "link", linkUserId: 1, sessionUserId: 1 }), db.deps), { kind: "linked", user: db.users[0], alreadyLinked: true });
  // bob 想把同一个身份绑到自己身上
  assert.deepEqual(await resolveOidcSignIn(input({ mode: "link", linkUserId: 2, sessionUserId: 2 }), db.deps), { kind: "error", code: "linked_elsewhere" });
  // alice 想再绑同一个 IdP 的另一个身份：先解绑
  assert.deepEqual(
    await resolveOidcSignIn(input({ mode: "link", linkUserId: 1, sessionUserId: 1, claims: { sub: "sub-2", name: null, preferredUsername: null } }), db.deps),
    { kind: "error", code: "already_linked" },
  );
  // 停用的账号不能绑
  const disabled = fakeDb([alice({ accountEnabled: false })]);
  assert.deepEqual(await resolveOidcSignIn(input({ mode: "link", linkUserId: 1, sessionUserId: 1 }), disabled.deps), { kind: "error", code: "account_disabled" });
});

test("换了 Issuer：旧绑定不再算数，可以直接绑新 IdP 的身份（覆盖掉旧的）", async () => {
  const db = fakeDb([alice({ oidcIssuer: "https://old-idp.example.com", oidcSub: "old-sub" })]);
  assert.equal(activeOidcSubOf(db.users[0], ISSUER), null);
  assert.equal(activeOidcSubOf(db.users[0], "https://old-idp.example.com"), "old-sub");
  const linked = await resolveOidcSignIn(input({ mode: "link", linkUserId: 1, sessionUserId: 1 }), db.deps);
  assert.equal(linked.kind, "linked");
  assert.deepEqual([db.users[0].oidcIssuer, db.users[0].oidcSub], [ISSUER, "sub-1"]);
});

test("并发：同一个身份两个回调同时注册，另一个已经建好了就用那一个", async () => {
  const db = fakeDb([]);
  const realRegister = db.deps.registerUser;
  db.deps.registerUser = async (data) => {
    await realRegister(data);
    throw new Error("UNIQUE constraint failed: users.oidcIssuer, users.oidcSub");
  };
  const outcome = await resolveOidcSignIn(input({ allowRegistration: true, email: "c@fresh.io" }), db.deps);
  assert.equal(outcome.kind, "signed_in");
  assert.equal(outcome.kind === "signed_in" && outcome.created, false);
});
