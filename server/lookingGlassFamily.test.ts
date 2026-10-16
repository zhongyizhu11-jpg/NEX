import assert from "node:assert/strict";
import dns from "node:dns";
import test from "node:test";

import { resolvePublicTarget } from "./routers/lookingGlass";

/*
  网络测试 TCPing 的地址族：目标是域名时只用选中那一族的地址；没有就报错，不悄悄换另一族。
  地址由面板解析好下发，所以老 Agent 照样生效。
*/
test("TCPing 地址族：auto 照旧、ipv4 / ipv6 只取那一族、没有就报错", async (t) => {
  const original = dns.promises.lookup;
  const calls: Array<{ host: string; family: number }> = [];
  (dns.promises as any).lookup = async (host: string, options: any) => {
    calls.push({ host, family: Number(options?.family || 0) });
    const all = host === "dual.example"
      ? [{ address: "2606:4700::6810:84e5", family: 6 }, { address: "104.16.132.229", family: 4 }]
      : [{ address: "104.16.132.229", family: 4 }];
    const family = Number(options?.family || 0);
    const filtered = family ? all.filter((entry) => entry.family === family) : all;
    if (filtered.length === 0) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    return filtered;
  };
  t.after(() => { (dns.promises as any).lookup = original; });

  const auto = await resolvePublicTarget("dual.example", "tcp");
  assert.equal(auto.address, "2606:4700::6810:84e5", "auto：解析器给什么用什么（verbatim 顺序）");
  assert.equal(calls.at(-1)?.family, 0);

  const v4 = await resolvePublicTarget("dual.example", "tcp", "ipv4");
  assert.equal(v4.address, "104.16.132.229");
  assert.equal(v4.family, 4);
  assert.deepEqual(v4.addresses, ["104.16.132.229"]);
  assert.equal(calls.at(-1)?.family, 4);

  const v6 = await resolvePublicTarget("dual.example", "tcp", "ipv6");
  assert.equal(v6.family, 6);

  await assert.rejects(resolvePublicTarget("v4only.example", "tcp", "ipv6"), /没有可用 IPv6 地址/);

  // 目标是 IP：地址族由地址决定，选了也不管
  const literal = await resolvePublicTarget("1.1.1.1", "tcp", "ipv6");
  assert.equal(literal.address, "1.1.1.1");

  // 别的方法不吃这个参数
  const ping = await resolvePublicTarget("dual.example", "ping", "ipv6");
  assert.equal(ping.family, 4);
});
