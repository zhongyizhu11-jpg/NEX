import assert from "node:assert/strict";
import test from "node:test";
import { TRPCError } from "@trpc/server";
import { publicProcedure, router } from "./_core/trpc";
import { resetApiRateLimitForTests } from "./apiRateLimit";
import { resetApiRateLimitNotifyForTests, setApiRateLimitConfigForTests } from "./apiRateLimitConfig";

/*
  tRPC 中间件这一层：超额回 TOO_MANY_REQUESTS 并写 Retry-After；过程里再 createCaller 的
  嵌套调用不重复计数；没有 HTTP 请求的进程内调用（测试、定时任务）不限。
*/
const inner = router({
  ping: publicProcedure.mutation(() => "pong"),
});
const outer = router({
  ping: publicProcedure.mutation(() => "pong"),
  read: publicProcedure.query(() => "ok"),
  batch: publicProcedure.mutation(async ({ ctx }) => {
    const caller = inner.createCaller(ctx as any);
    for (let i = 0; i < 20; i += 1) await caller.ping();
    return "done";
  }),
});

function ctxFor(ip: string) {
  const headers: Record<string, string> = {};
  return {
    req: { ip, headers: {}, socket: {} } as any,
    res: { headers, setHeader(name: string, value: string) { headers[name] = value; } } as any,
    user: null,
    authSession: null,
    authFailureReason: null,
    apiToken: null,
  } as any;
}

test.beforeEach(() => {
  resetApiRateLimitForTests();
  resetApiRateLimitNotifyForTests();
  setApiRateLimitConfigForTests({
    enabled: true,
    userQueryPerMinute: 50,
    userMutationPerMinute: 50,
    tokenQueryPerMinute: 50,
    tokenMutationPerMinute: 50,
    anonymousQueryPerMinute: 10,
    anonymousMutationPerMinute: 3,
  });
});

test.after(() => setApiRateLimitConfigForTests(null));

test("匿名修改超额：第 4 次回 TOO_MANY_REQUESTS，响应头带 Retry-After", async () => {
  const ctx = ctxFor("203.0.113.50");
  const caller = outer.createCaller(ctx);
  for (let i = 0; i < 3; i += 1) assert.equal(await caller.ping(), "pong");
  await assert.rejects(caller.ping(), (error: unknown) => {
    assert.ok(error instanceof TRPCError);
    assert.equal(error.code, "TOO_MANY_REQUESTS");
    assert.match(error.message, /请求太频繁/);
    return true;
  });
  assert.ok(Number(ctx.res.headers["Retry-After"]) >= 1);
  // 查询是另一份额度
  assert.equal(await caller.read(), "ok");
});

test("过程里嵌套调用的 20 次不算数：外层只记 1 次", async () => {
  const caller = outer.createCaller(ctxFor("203.0.113.51"));
  assert.equal(await caller.batch(), "done");
  assert.equal(await caller.ping(), "pong");
  assert.equal(await caller.ping(), "pong");
  await assert.rejects(caller.ping(), (error: any) => error?.code === "TOO_MANY_REQUESTS");
});

test("没有 HTTP 请求的进程内调用不限", async () => {
  const caller = outer.createCaller({ user: null, authSession: null, authFailureReason: null } as any);
  for (let i = 0; i < 30; i += 1) assert.equal(await caller.ping(), "pong");
});
