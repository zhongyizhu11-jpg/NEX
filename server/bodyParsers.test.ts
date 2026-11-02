import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { COOKIE_NAME } from "../shared/const";
import { installJsonBodyParsers, needsLargeJsonBody, trpcProceduresFromPath } from "./bodyParsers";

const authed = { authorization: "Bearer x" };
const cookie = { cookie: `theme=dark; ${COOKIE_NAME}=abc` };

test("只有 Agent 上报和几条大上传的 tRPC 过程用大上限，而且要带凭据", () => {
  assert.deepEqual(trpcProceduresFromPath("/api/trpc/system.updateSettings,auth.me"), ["system.updateSettings", "auth.me"]);
  assert.deepEqual(trpcProceduresFromPath("/plugins.installFromUpload"), ["plugins.installFromUpload"]);
  assert.equal(needsLargeJsonBody("/api/agent/heartbeat", authed), true);
  assert.equal(needsLargeJsonBody("/api/sync", authed), true);
  assert.equal(needsLargeJsonBody("/api/trpc/plugins.installFromUpload", cookie), true);
  assert.equal(needsLargeJsonBody("/api/trpc/system.importPanelBackup", authed), true);
  assert.equal(needsLargeJsonBody("/api/trpc/auth.me,system.updateSettings", cookie), true);
  assert.equal(needsLargeJsonBody("/api/trpc/system.updateSettings%2Cauth.me", cookie), true);
  // 匿名请求、登录接口、别的过程一律 1MB。
  assert.equal(needsLargeJsonBody("/api/agent/heartbeat", {}), false);
  assert.equal(needsLargeJsonBody("/api/trpc/plugins.installFromUpload", { cookie: "theme=dark" }), false);
  assert.equal(needsLargeJsonBody("/api/trpc/auth.login", cookie), false);
  assert.equal(needsLargeJsonBody("/api/trpc/auth.login,auth.register", authed), false);
  assert.equal(needsLargeJsonBody("/mcp", authed), false);
  assert.equal(needsLargeJsonBody("/api/agentx", authed), false);
});

test("真实请求：登录接口超过 1MB 回 413，插件上传和 Agent 上报还能传到 10MB", async () => {
  const app = express();
  installJsonBodyParsers(app);
  app.post("*", (req, res) => res.json({ size: JSON.stringify(req.body || {}).length }));
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error?.status || 500).json({ error: error?.type || "error" });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const post = (path: string, bytes: number, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ content: "a".repeat(bytes) }),
  });
  try {
    const twoMb = 2 * 1024 * 1024;
    assert.equal((await post("/api/trpc/auth.login", twoMb, cookie)).status, 413);
    assert.equal((await post("/api/trpc/auth.login", 1024)).status, 200);
    assert.equal((await post("/api/trpc/plugins.installFromUpload", twoMb)).status, 413);
    assert.equal((await post("/api/trpc/plugins.installFromUpload", twoMb, cookie)).status, 200);
    assert.equal((await post("/api/trpc/system.importPanelBackup", 8 * 1024 * 1024, authed)).status, 200);
    assert.equal((await post("/api/agent/heartbeat", twoMb, authed)).status, 200);
    assert.equal((await post("/api/agent/heartbeat", 11 * 1024 * 1024, authed)).status, 413);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
