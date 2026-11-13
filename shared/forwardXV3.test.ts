import assert from "node:assert/strict";
import test from "node:test";
import { normalizeForwardXVersion } from "./forwardTypes";
import {
  FORWARDX_V3_MIN_AGENT_VERSION,
  FORWARDX_V3_MIN_FXP_VERSION,
  forwardXV3BlockerMessage,
  forwardXV3Blockers,
  forwardXV3ConflictReason,
  forwardXV3OptionsError,
  forwardXV3SpecFields,
  forwardXV3TunnelPatch,
  isForwardXV3Tunnel,
  normalizeForwardXV3Options,
} from "./forwardXV3";
import { tunnelParallelStreamsUnavailableReason } from "./tunnelParallelStreams";

test("NEX V3：传输版本认 v3，不认识的仍按 v1", () => {
  assert.equal(normalizeForwardXVersion(" V3 "), "v3");
  assert.equal(normalizeForwardXVersion("v2"), "v2");
  assert.equal(normalizeForwardXVersion("v9"), "v1");
  assert.equal(normalizeForwardXVersion(undefined), "v1");
  assert.equal(isForwardXV3Tunnel({ mode: "forwardx", forwardxVersion: "v3" }), true);
  assert.equal(isForwardXV3Tunnel({ mode: "tls", forwardxVersion: "v3" }), false);
  assert.equal(isForwardXV3Tunnel({ mode: "forwardx", forwardxVersion: "v1" }), false);
});

test("NEX V3：选项归一化和默认值（TLS、不复用）", () => {
  assert.deepEqual(normalizeForwardXV3Options({}), {
    v3Transport: "tls", v3Host: "", v3Path: "", v3UserAgent: "", v3ServerName: "", v3Multiplex: false,
  });
  // HTTP / WS 不带 SNI；路径补斜杠；数据库里的 0/1 布尔值也认。
  assert.deepEqual(normalizeForwardXV3Options({ v3Transport: " WS ", v3Path: "chat", v3Host: " a.example ", v3ServerName: "x", v3Multiplex: 1 }), {
    v3Transport: "ws", v3Host: "a.example", v3Path: "/chat", v3UserAgent: "", v3ServerName: "", v3Multiplex: true,
  });
  // TLS 不带 Host / 路径 / UA。
  assert.deepEqual(normalizeForwardXV3Options({ v3Transport: "tls", v3Host: "a", v3Path: "/p", v3UserAgent: "ua", v3ServerName: " cdn.example ", v3Multiplex: "0" }), {
    v3Transport: "tls", v3Host: "", v3Path: "", v3UserAgent: "", v3ServerName: "cdn.example", v3Multiplex: false,
  });
});

test("NEX V3：注入请求头的写法在保存时就拒，给中文原因", () => {
  assert.equal(forwardXV3OptionsError({ v3Transport: "http", v3Path: "/ok", v3Host: "a.example", v3UserAgent: "Mozilla/5.0 (X11)" }), "");
  assert.match(forwardXV3OptionsError({ v3Transport: "quic" }), /只能选 HTTP、WebSocket 或 TLS/);
  assert.match(forwardXV3OptionsError({ v3Transport: "http", v3Path: "/a\r\nX-Evil: 1" }), /路径/);
  assert.match(forwardXV3OptionsError({ v3Transport: "http", v3Path: "/has space" }), /路径/);
  assert.match(forwardXV3OptionsError({ v3Transport: "ws", v3Host: "a\nb" }), /Host/);
  assert.match(forwardXV3OptionsError({ v3Transport: "ws", v3UserAgent: "a\u0000b" }), /User-Agent/);
  assert.match(forwardXV3OptionsError({ v3Transport: "ws", v3UserAgent: "x".repeat(600) }), /User-Agent 最长/);
  assert.match(forwardXV3OptionsError({ v3Transport: "tls", v3ServerName: "a/b" }), /SNI/);
  assert.equal(forwardXV3OptionsError({ v3Transport: "tls", v3ServerName: "www.example-cdn.com" }), "");
});

test("NEX V3：只有 V3 隧道写外层选项，其余模式 / 版本清空", () => {
  const cleared = { v3Transport: null, v3Host: null, v3Path: null, v3UserAgent: null, v3ServerName: null, v3Multiplex: false };
  assert.deepEqual(forwardXV3TunnelPatch({ v3Transport: "ws", v3Path: "/x" }, "forwardx", "v1"), cleared);
  assert.deepEqual(forwardXV3TunnelPatch({ v3Transport: "ws", v3Path: "/x" }, "tls", "v3"), cleared);
  assert.deepEqual(forwardXV3TunnelPatch({ v3Transport: "ws", v3Path: "x", v3Multiplex: true }, "forwardx", "v3"), {
    v3Transport: "ws", v3Host: null, v3Path: "/x", v3UserAgent: null, v3ServerName: null, v3Multiplex: true,
  });
  assert.throws(() => forwardXV3TunnelPatch({ v3Transport: "http", v3Path: "/a b" }, "forwardx", "v3"), /路径/);
});

test("NEX V3：下发给 FXP 的字段", () => {
  assert.equal(forwardXV3SpecFields({ mode: "forwardx", forwardxVersion: "v1", v3Transport: "ws" }), null);
  assert.deepEqual(forwardXV3SpecFields({ mode: "forwardx", forwardxVersion: "v3", v3Transport: "ws", v3Path: "/live", v3Host: "", v3Multiplex: 0 }), {
    v3Transport: "ws", v3Path: "/live", v3Multiplex: false,
  });
  // 老库里没存过外层（null）：按默认 TLS、不复用，多路复用总是显式写（FXP 没写时按开）。
  assert.deepEqual(forwardXV3SpecFields({ mode: "forwardx", forwardxVersion: "v3", v3Transport: null, v3Multiplex: null }), {
    v3Transport: "tls", v3Multiplex: false,
  });
  assert.deepEqual(forwardXV3SpecFields({ mode: "forwardx", forwardxVersion: "v3", v3Transport: "tls", v3ServerName: "cdn.example", v3Multiplex: true }), {
    v3Transport: "tls", v3ServerName: "cdn.example", v3Multiplex: true,
  });
});

test("NEX V3：和已有特性的组合，不能组合的说清为什么", () => {
  assert.equal(forwardXV3ConflictReason({}), "");
  assert.equal(forwardXV3ConflictReason({ relayMode: "failover", parallelStreams: 1, lossTolerant: false, kernelPassthrough: 0 }), "");
  assert.equal(forwardXV3ConflictReason({ relayMode: "chain" }), "");
  assert.match(forwardXV3ConflictReason({ lossTolerant: true }), /抗丢包传输/);
  assert.match(forwardXV3ConflictReason({ lossTolerant: 1 }), /抗丢包传输/);
  assert.match(forwardXV3ConflictReason({ kernelPassthrough: true }), /内核直通/);
  // 中转「叠加」「热备」、单连接多路并发可以和 V3 一起开了（FXP 2.2.141：每条腿一条自己的 V3 物理连接）。
  assert.equal(forwardXV3ConflictReason({ relayMode: "aggregate" }), "");
  assert.equal(forwardXV3ConflictReason({ relayMode: "hot_standby" }), "");
  assert.equal(forwardXV3ConflictReason({ parallelStreams: 4 }), "");
  // 抗丢包传输照旧不行，不管中转方式是什么。
  assert.match(forwardXV3ConflictReason({ relayMode: "aggregate", lossTolerant: true }), /抗丢包传输/);
  // 单连接多路并发那边 V3 和 V1 一样能开，V2 照旧不行。
  assert.equal(tunnelParallelStreamsUnavailableReason({ mode: "forwardx", forwardxVersion: "v3" }, []), "");
  assert.equal(tunnelParallelStreamsUnavailableReason({ mode: "forwardx", forwardxVersion: "v1" }, []), "");
  assert.match(tunnelParallelStreamsUnavailableReason({ mode: "forwardx", forwardxVersion: "v2" }, []), /V2/);
});

test("NEX V3：两端（含中转）的 Agent / FXP 版本都要够新", () => {
  const hosts = [
    { id: 1, name: "入口", agentVersion: FORWARDX_V3_MIN_AGENT_VERSION, fxpVersion: FORWARDX_V3_MIN_FXP_VERSION },
    { id: 2, name: "中转", agentVersion: "2.2.256", fxpVersion: FORWARDX_V3_MIN_FXP_VERSION },
    { id: 3, name: "出口", agentVersion: "2.2.300", fxpVersion: "2.2.140" },
    { id: 4, name: "新出口", agentVersion: "2.3.0", fxpVersion: "2.3.0" },
  ];
  const blockers = forwardXV3Blockers(hosts, [1, 2, 3, 4, 5, 2]);
  assert.deepEqual(blockers, [
    { hostId: 2, name: "中转", missing: ["agent"] },
    { hostId: 3, name: "出口", missing: ["fxp"] },
    { hostId: 5, name: "#5", missing: ["agent", "fxp"] },
  ]);
  const message = forwardXV3BlockerMessage(blockers);
  assert.match(message, /NEX V3 要隧道上每台机器都升级/);
  assert.match(message, new RegExp(`中转（要 Agent ${FORWARDX_V3_MIN_AGENT_VERSION.replace(/\./g, "\\.")} 以上）`));
  assert.match(message, new RegExp(`出口（要 FXP ${FORWARDX_V3_MIN_FXP_VERSION.replace(/\./g, "\\.")} 以上）`));
  assert.deepEqual(forwardXV3Blockers(hosts, [1, 4]), []);
});

test("NEX V3：门槛版本和 Agent 里写的 FXP 门槛一致", async () => {
  const { readFileSync } = await import("node:fs");
  const agentSource = readFileSync(new URL("../agent/fxp_v3_transport.go", import.meta.url), "utf8");
  const match = agentSource.match(/fxpV3MinVersion\s*=\s*"([^"]+)"/);
  assert.equal(match?.[1], FORWARDX_V3_MIN_FXP_VERSION);
});
