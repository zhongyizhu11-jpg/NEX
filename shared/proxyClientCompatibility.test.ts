import assert from "node:assert/strict";
import test from "node:test";

import {
  PROXY_CLIENT_FAMILIES,
  proxyClientCompatibility,
  summarizeProxyClientCompatibility,
  uncoveredProxyClientTargets,
  type CompatInboundInput,
} from "./proxyClientCompatibility";
import { PROXY_INBOUND_PROTOCOLS, proxyInboundSecurities, proxyInboundTransports } from "./proxyInbound";

function verdict(inbound: CompatInboundInput, id: string) {
  const row = proxyClientCompatibility(inbound).find((item) => item.id === id);
  assert.ok(row, `missing client ${id}`);
  return row;
}

test("面板列出的每个导入目标都归到了某一家", () => {
  assert.deepEqual(uncoveredProxyClientTargets(), []);
});

test("每家都给出了全部协议的结论", () => {
  for (const family of PROXY_CLIENT_FAMILIES) {
    for (const protocol of PROXY_INBOUND_PROTOCOLS) {
      assert.ok(protocol in family.facts.protocols, `${family.id} 缺 ${protocol}`);
    }
  }
});

test("VLESS + REALITY：Surge / Quantumult X / 原版 Clash 用不了，mihomo / sing-box 能用", () => {
  const inbound = { protocol: "vless", transport: "tcp", security: "reality", flow: "xtls-rprx-vision" };
  assert.equal(verdict(inbound, "surge").ok, false);
  assert.match(verdict(inbound, "surge").why, /VLESS/);
  assert.equal(verdict(inbound, "quantumultx").ok, false);
  assert.match(verdict(inbound, "quantumultx").why, /REALITY/);
  assert.equal(verdict(inbound, "clash-premium").ok, false);
  assert.equal(verdict(inbound, "mihomo").ok, true);
  assert.equal(verdict(inbound, "singbox").ok, true);
  assert.equal(verdict(inbound, "v2rayn").ok, true);
  assert.equal(verdict(inbound, "shadowrocket").ok, true);
});

test("Hysteria2：Quantumult X 不支持，Surge / Loon 支持", () => {
  const inbound = { protocol: "hysteria2", transport: "tcp", security: "acme", obfs: "salamander" };
  assert.equal(verdict(inbound, "quantumultx").ok, false);
  assert.equal(verdict(inbound, "surge").ok, true);
  assert.equal(verdict(inbound, "loon").ok, true);
  assert.equal(verdict(inbound, "clash-premium").ok, false);
});

test("TUIC：Loon 与 Quantumult X 不支持", () => {
  const inbound = { protocol: "tuic", security: "acme" };
  assert.equal(verdict(inbound, "loon").ok, false);
  assert.equal(verdict(inbound, "quantumultx").ok, false);
  assert.equal(verdict(inbound, "surge").ok, true);
  assert.equal(verdict(inbound, "singbox").ok, true);
});

test("Snell：通用订阅装不下；v6 mihomo 不行，Surge 与 sing-box 可以", () => {
  const v6 = { protocol: "snell", security: "none", snellVersion: 6 };
  assert.equal(verdict(v6, "mihomo").ok, false);
  assert.match(verdict(v6, "mihomo").why, /v6/);
  assert.equal(verdict(v6, "surge").ok, true);
  assert.equal(verdict(v6, "singbox").ok, true);
  assert.equal(verdict(v6, "v2rayn").ok, false);
  assert.equal(verdict(v6, "shadowrocket").ok, false);
  const v5 = { protocol: "snell", security: "none", snellVersion: 5 };
  assert.equal(verdict(v5, "mihomo").ok, true);
  assert.equal(verdict(v5, "clash-premium").ok, false);
  // Stash 对 Snell 的版本没核实
  assert.equal(verdict(v5, "stash").ok, null);
});

test("传输：gRPC 在 Surge / Quantumult X 不行；Loon 没核实", () => {
  const inbound = { protocol: "vmess", transport: "grpc", security: "tls" };
  assert.equal(verdict(inbound, "surge").ok, false);
  assert.match(verdict(inbound, "surge").why, /gRPC/);
  assert.equal(verdict(inbound, "quantumultx").ok, false);
  assert.equal(verdict(inbound, "loon").ok, null);
  assert.equal(verdict(inbound, "mihomo").ok, true);
});

test("HTTPUpgrade 走订阅格式那一层：Loon 用不了", () => {
  const inbound = { protocol: "vless", transport: "httpupgrade", security: "tls" };
  assert.equal(verdict(inbound, "loon").ok, false);
  assert.equal(verdict(inbound, "singbox").ok, true);
});

test("Shadowsocks 2022 在原版 Clash 不行，老 AEAD 可以", () => {
  assert.equal(verdict({ protocol: "shadowsocks", method: "2022-blake3-aes-128-gcm", security: "none" }, "clash-premium").ok, false);
  assert.equal(verdict({ protocol: "shadowsocks", method: "aes-128-gcm", security: "none" }, "clash-premium").ok, true);
  assert.equal(verdict({ protocol: "shadowsocks", method: "2022-blake3-aes-128-gcm", security: "none" }, "surge").ok, true);
});

test("没核实的写进原因，不算能用", () => {
  const row = verdict({ protocol: "anytls", security: "acme" }, "hiddify");
  assert.equal(row.ok, null);
  assert.match(row.why, /没核实/);
});

test("小标文字：全能用写「所有客户端」，否则写 x/y", () => {
  const all = summarizeProxyClientCompatibility([
    { id: "a", label: "A", ok: true, why: "" },
    { id: "b", label: "B", ok: true, why: "" },
  ]);
  assert.equal(all.label, "所有客户端");
  const some = summarizeProxyClientCompatibility(proxyClientCompatibility({ protocol: "vless", security: "reality", flow: "xtls-rprx-vision" }));
  assert.equal(some.total, PROXY_CLIENT_FAMILIES.length);
  assert.equal(some.okCount + some.noCount + some.unknownCount, some.total);
  assert.match(some.label, /^\d+\/\d+ 款客户端$/);
});

test("所有能开出来的组合都不抛错，且每家都有结论", () => {
  for (const protocol of PROXY_INBOUND_PROTOCOLS) {
    for (const security of proxyInboundSecurities(protocol)) {
      for (const transport of proxyInboundTransports(protocol)) {
        const rows = proxyClientCompatibility({ protocol, security, transport, snellVersion: 5 });
        assert.equal(rows.length, PROXY_CLIENT_FAMILIES.length);
        for (const row of rows) {
          if (row.ok !== true) assert.ok(row.why.length > 0, `${protocol}/${security}/${transport}/${row.id} 缺原因`);
        }
      }
    }
  }
});
