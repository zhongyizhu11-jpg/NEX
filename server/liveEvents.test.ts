import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import express from "express";
import { emitLive, flushLiveForTest, onLive, registerLiveRoute } from "./liveEvents";

test("实时通知：200 毫秒内的合成一条、重复的只算一次", () => {
  const received: string[][] = [];
  const off = onLive((topics) => received.push(topics));
  emitLive("rules.live");
  emitLive("rules.live", "balance");
  flushLiveForTest();
  off();
  assert.deepEqual(received, [["rules.live", "balance"]]);
});

test("GET /api/live：没登录 401；登录了按 text/event-stream 收到「哪一类变了」", async () => {
  const app = express();
  registerLiveRoute(app, async (req) => (req.headers.authorization === "Bearer ok" ? { id: 7 } : null));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/live`;
  try {
    assert.equal((await fetch(url)).status, 401);
    const controller = new AbortController();
    const response = await fetch(url, { headers: { authorization: "Bearer ok" }, signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(String(response.headers.get("content-type")), /text\/event-stream/);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = decoder.decode((await reader.read()).value);
    assert.match(text, /retry: 3000/);
    emitLive("tunnels.live", "mutation:rules");
    flushLiveForTest();
    while (!text.includes("event: change")) text += decoder.decode((await reader.read()).value);
    assert.match(text, /data: \{"topics":\["tunnels\.live","mutation:rules"\]\}/);
    controller.abort();
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("改配置成功之后才通知：rules / tunnels / forwardGroups / hosts 的 mutation，查询和别的模块不发", async () => {
  const { router, publicProcedure } = await import("./_core/trpc");
  const appRouter = router({
    rules: router({ touch: publicProcedure.mutation(() => 1), read: publicProcedure.query(() => 1), fail: publicProcedure.mutation(() => { throw new Error("no"); }) }),
    tickets: router({ touch: publicProcedure.mutation(() => 1) }),
  });
  const ctx = { req: { headers: {}, socket: {} }, res: { setHeader() {} }, user: null, authSession: null, authFailureReason: null };
  const caller = appRouter.createCaller(ctx as never);
  const received: string[][] = [];
  const off = onLive((topics) => received.push(topics));
  try {
    await caller.rules.read();
    await caller.tickets.touch();
    await assert.rejects(caller.rules.fail());
    flushLiveForTest();
    assert.deepEqual(received, []);
    await caller.rules.touch();
    flushLiveForTest();
    assert.deepEqual(received, [["mutation:rules"]]);
  } finally {
    off();
  }
});
