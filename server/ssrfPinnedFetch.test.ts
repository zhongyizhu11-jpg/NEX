import assert from "node:assert/strict";
import dns from "node:dns";
import http from "node:http";
import test from "node:test";

import { createSafeLookup, safeHttpGet, SafeOutboundError } from "./ssrf";

/*
  外部拉取（P1-4）：检查放在连接用的 lookup 里，连接只落在检查过的地址上；正文边读边数，超了就断。
*/

async function withServer(handler: http.RequestListener, fn: (port: number) => Promise<void>) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await fn((server.address() as any).port);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

const allowAll = { isBlockedAddress: () => false };

test("lookup 当场检查解析结果：解析到内网就不连，解析到公网只交出检查过的地址", async () => {
  const original = dns.lookup;
  let answer: dns.LookupAddress[] = [];
  (dns as any).lookup = (_host: string, _options: any, callback: any) => callback(null, answer);
  try {
    const lookup = createSafeLookup({ purpose: "测试" });
    const run = (host: string, options: any) => new Promise<{ error: any; address: any; family: any }>((resolve) => {
      lookup(host, options, (error, address, family) => resolve({ error, address, family }));
    });
    // 重绑定：第二次解析换成了内网地址 —— 连接时的这一次就是检查的这一次，挡得住。
    answer = [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }];
    const rebound = await run("rebind.example", {});
    assert.ok(rebound.error instanceof SafeOutboundError);
    assert.equal(rebound.error.code, "blocked");
    answer = [{ address: "169.254.169.254", family: 4 }];
    assert.equal((await run("meta.example", { all: true })).error?.code, "blocked");
    answer = [{ address: "93.184.216.34", family: 4 }];
    const single = await run("ok.example", {});
    assert.equal(single.error, null);
    assert.equal(single.address, "93.184.216.34");
    assert.equal(single.family, 4);
    const all = await run("ok.example", { all: true });
    assert.deepEqual(all.address, [{ address: "93.184.216.34", family: 4 }]);
    // 不走 DNS 的名字和 IP 字面量也查。
    assert.equal((await run("localhost", {})).error?.code, "blocked");
    assert.equal((await run("10.1.2.3", {})).error?.code, "blocked");
  } finally {
    (dns as any).lookup = original;
  }
});

test("safeHttpGet：默认不让连内网；放行时正常拿到正文和头", async () => {
  await withServer((_req, res) => {
    res.setHeader("subscription-userinfo", "upload=1");
    res.end("hello");
  }, async (port) => {
    await assert.rejects(
      () => safeHttpGet(`http://127.0.0.1:${port}/`, { timeoutMs: 5000, maxBytes: 1024 }),
      (error: any) => error instanceof SafeOutboundError && error.code === "blocked",
    );
    await assert.rejects(
      () => safeHttpGet(`http://localhost:${port}/`, { timeoutMs: 5000, maxBytes: 1024 }),
      (error: any) => error instanceof SafeOutboundError && error.code === "blocked",
    );
    const response = await safeHttpGet(`http://127.0.0.1:${port}/`, { ...allowAll, timeoutMs: 5000, maxBytes: 1024 });
    assert.equal(response.status, 200);
    assert.equal(response.body.toString("utf8"), "hello");
    assert.equal(response.headers["subscription-userinfo"], "upload=1");
    await assert.rejects(
      () => safeHttpGet("ftp://example.com/", { timeoutMs: 5000, maxBytes: 1024 }),
      (error: any) => error instanceof SafeOutboundError && error.code === "invalid-url",
    );
  });
});

test("safeHttpGet：连接用的就是检查过的那次解析", async () => {
  const original = dns.lookup;
  (dns as any).lookup = (_host: string, _options: any, callback: any) => callback(null, [{ address: "127.0.0.1", family: 4 }]);
  try {
    await withServer((_req, res) => res.end("pinned"), async (port) => {
      await assert.rejects(
        () => safeHttpGet(`http://rebind.example:${port}/`, { timeoutMs: 5000, maxBytes: 1024 }),
        (error: any) => error instanceof SafeOutboundError && error.code === "blocked",
      );
      const response = await safeHttpGet(`http://rebind.example:${port}/`, { ...allowAll, timeoutMs: 5000, maxBytes: 1024 });
      assert.equal(response.body.toString("utf8"), "pinned");
    });
  } finally {
    (dns as any).lookup = original;
  }
});

test("safeHttpGet：边读边数，超过上限立刻断开，不等全部读完", async () => {
  let written = 0;
  let closedEarly = false;
  await withServer((_req, res) => {
    // 不给 content-length，一直往外写，直到对面断开。
    res.on("close", () => { closedEarly = written < 10 * 1024 * 1024; });
    const chunk = Buffer.alloc(16 * 1024, 97);
    const pump = () => {
      while (written < 10 * 1024 * 1024) {
        written += chunk.length;
        if (!res.write(chunk)) {
          res.once("drain", pump);
          return;
        }
      }
      res.end();
    };
    pump();
  }, async (port) => {
    await assert.rejects(
      () => safeHttpGet(`http://127.0.0.1:${port}/`, { ...allowAll, timeoutMs: 5000, maxBytes: 64 * 1024 }),
      (error: any) => error instanceof SafeOutboundError && error.code === "too-large",
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(closedEarly, true, `上游写了 ${written} 字节才被断开`);
  });
  // 声明的长度超了：不读正文直接拒。
  await withServer((_req, res) => {
    res.setHeader("content-length", String(5 * 1024 * 1024));
    res.write("x");
  }, async (port) => {
    await assert.rejects(
      () => safeHttpGet(`http://127.0.0.1:${port}/`, { ...allowAll, timeoutMs: 5000, maxBytes: 1024 }),
      (error: any) => error instanceof SafeOutboundError && error.code === "too-large",
    );
  });
});

test("safeHttpGet：超时", async () => {
  await withServer(() => {
    // 不回。
  }, async (port) => {
    await assert.rejects(
      () => safeHttpGet(`http://127.0.0.1:${port}/`, { ...allowAll, timeoutMs: 200, maxBytes: 1024 }),
      (error: any) => error instanceof SafeOutboundError && error.code === "timeout",
    );
  });
});
