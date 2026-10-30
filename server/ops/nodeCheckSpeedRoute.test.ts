import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { registerNodeCheckSpeedRoutes } from "./nodeCheckSpeedRoute";
import { nodeCheckDirectiveFor, resetNodeCheckStateForTest, startNodeCheck } from "./nodeCheck";

async function listen() {
  const app = express();
  app.use(express.json());
  registerNodeCheckSpeedRoutes(app);
  const server = await new Promise<import("node:http").Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("面板测速接口：只认正在跑的测速的口令，下载给足字节、上传读完回大小", async () => {
  resetNodeCheckStateForTest();
  const { runId } = startNodeCheck({ id: 7, agentVersion: "2.2.242", isOnline: true }, { kind: "speed" });
  const token = String(nodeCheckDirectiveFor(7)!.runs[0].panel!.token);
  const { base, close } = await listen();
  try {
    assert.equal((await fetch(`${base}/api/nodecheck/speed/meta`)).status, 401);
    assert.equal((await fetch(`${base}/api/nodecheck/speed/meta`, { headers: { authorization: "Bearer nope" } })).status, 401);
    const meta = await fetch(`${base}/api/nodecheck/speed/meta`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(meta.status, 200);
    assert.equal((await meta.json()).server, "panel");

    const down = await fetch(`${base}/api/nodecheck/speed/down?bytes=3000000`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(down.status, 200);
    assert.equal(down.headers.get("content-length"), "3000000");
    assert.equal(down.headers.get("content-type"), "application/octet-stream");
    assert.match(String(down.headers.get("cache-control")), /no-transform/);
    assert.equal((await down.arrayBuffer()).byteLength, 3_000_000);
    const capped = await fetch(`${base}/api/nodecheck/speed/down?bytes=999999999999`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(capped.headers.get("content-length"), String(64 << 20));
    await capped.arrayBuffer();

    const up = await fetch(`${base}/api/nodecheck/speed/up`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" }, body: Buffer.alloc(2_500_000) });
    assert.equal(up.status, 200);
    assert.equal((await up.json()).bytes, 2_500_000);
    // 声明超过上限：立刻 413（用 node:http 才能发一个和实际不符的 Content-Length）。
    const tooBigStatus = await new Promise<number>((resolve, reject) => {
      const req = http.request(`${base}/api/nodecheck/speed/up`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream", "content-length": String(65 << 20) } }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode || 0));
      });
      req.on("error", reject);
      req.write(Buffer.alloc(16));
    });
    assert.equal(tooBigStatus, 413);
    assert.equal((await fetch(`${base}/api/nodecheck/speed/up`, { method: "POST", body: Buffer.alloc(8) })).status, 401);
    void runId;
  } finally {
    await close();
    resetNodeCheckStateForTest();
  }
});
