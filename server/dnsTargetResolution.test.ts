import assert from "node:assert/strict";
import test from "node:test";
import { resolveTargetIpWithTimeout, selectResolvedTargetIp } from "./dnsTargetResolution";

const never = () => new Promise<string[]>(() => {});

test("target DNS resolution returns the first A record", async () => {
  const ip = await resolveTargetIpWithTimeout("edge.example.com", {
    resolve4: async () => ["192.0.2.1", "192.0.2.2"],
    resolve6: async () => ["2001:db8::1"],
  });
  assert.equal(ip, "192.0.2.1");
});

test("target DNS resolution falls back to AAAA when there is no A record", async () => {
  const ip = await resolveTargetIpWithTimeout("edge.example.com", {
    resolve4: async () => { throw Object.assign(new Error("queryA ENODATA"), { code: "ENODATA" }); },
    resolve6: async () => ["2001:db8::1"],
  });
  assert.equal(ip, "2001:db8::1");
});

test("a hung resolver times out and the caller keeps the previous address", async () => {
  const started = Date.now();
  const raw = await resolveTargetIpWithTimeout("edge.example.com", { resolve4: never, resolve6: never }, 50);
  const elapsed = Date.now() - started;
  assert.equal(raw, "edge.example.com");
  assert.ok(elapsed < 1000, `should give up quickly, took ${elapsed}ms`);
  // 心跳里拿到原值后用上次的解析结果
  assert.equal(selectResolvedTargetIp("edge.example.com", raw, { raw: "edge.example.com", ip: "192.0.2.9" }), "192.0.2.9");
});

test("the timeout covers A and AAAA lookups together", async () => {
  const started = Date.now();
  const raw = await resolveTargetIpWithTimeout("edge.example.com", {
    resolve4: () => new Promise((_, reject) => setTimeout(() => reject(new Error("ETIMEOUT")), 40)),
    resolve6: never,
  }, 80);
  assert.equal(raw, "edge.example.com");
  assert.ok(Date.now() - started < 1000);
});

test("IP literals and empty values skip DNS entirely", async () => {
  const resolvers = {
    resolve4: async () => { throw new Error("should not be called"); },
    resolve6: async () => { throw new Error("should not be called"); },
  };
  assert.equal(await resolveTargetIpWithTimeout(" 198.51.100.4 ", resolvers), "198.51.100.4");
  assert.equal(await resolveTargetIpWithTimeout("2001:db8::5", resolvers), "2001:db8::5");
  assert.equal(await resolveTargetIpWithTimeout("", resolvers), "");
});
