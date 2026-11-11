import assert from "node:assert/strict";
import test from "node:test";

import { buildMitaHostPlan } from "../shared/mieruInbound";
import { MITA_AGENT_ASSET_NAMES, MITA_VERSION, mitaBinarySha256, mitaTarballSha256 } from "../shared/mitaAssets";
import { createEmptyProxyInbound, type ProxyInbound } from "../shared/proxyInbound";
import {
  buildMitaDirective,
  mieruInboundStatusView,
  parseMitaRuntimeReport,
  parseMitaTrafficReport,
  rememberMitaPlan,
  rememberMitaReport,
  resetMitaRuntimeStateForTest,
} from "./mitaRuntime";
import { mitaCounterDelta, planMitaAccounting } from "./mitaTrafficPlan";
import { buildSingboxRuntimePlan } from "./singboxRuntimePlan";

function mieru(patch: Partial<ProxyInbound> = {}): ProxyInbound {
  return {
    ...createEmptyProxyInbound(),
    protocol: "mieru",
    name: "M",
    port: 27001,
    security: "none",
    mieruTransport: "TCP",
    users: [{ id: 11, name: "a", uuid: "nexaaaa", password: "pw" }],
    ...patch,
  };
}

test("mita 版本与哈希都钉死：两种架构的包和二进制各有一个哈希", () => {
  assert.match(MITA_VERSION, /^\d+\.\d+\.\d+$/);
  for (const arch of ["amd64", "arm64"] as const) {
    assert.match(String(mitaTarballSha256(MITA_VERSION, arch)), /^[0-9a-f]{64}$/);
    assert.match(String(mitaBinarySha256(MITA_VERSION, arch)), /^[0-9a-f]{64}$/);
  }
  assert.equal(mitaBinarySha256("9.9.9", "amd64"), null);
  assert.deepEqual([...MITA_AGENT_ASSET_NAMES], ["forwardx-mita-linux-amd64", "forwardx-mita-linux-arm64"]);
});

test("指令：先面板转发、再 GitHub（加速在前），revision 只跟配置和二进制走", () => {
  const plan = buildMitaHostPlan([{ id: 3, inbound: mieru() }]);
  const directive = buildMitaDirective(plan, { appVersion: "2.3.600", accelerator: { enabled: true, url: "https://gh.example.com/" } });
  assert.equal(directive.enabled, true);
  assert.equal(directive.version, MITA_VERSION);
  const amd64 = directive.binaries?.amd64;
  assert.ok(amd64);
  assert.equal(amd64!.panelAssetPath, "/api/agent/assets/v2.3.600/forwardx-mita-linux-amd64");
  assert.equal(amd64!.sha256, mitaBinarySha256(MITA_VERSION, "amd64"));
  assert.equal(amd64!.tarballUrls.length, 2);
  assert.match(amd64!.tarballUrls[0], /^https:\/\/gh\.example\.com\//);
  assert.match(amd64!.tarballUrls[1], /^https:\/\/github\.com\/enfein\/mieru\/releases\/download\/v/);
  assert.deepEqual(directive.config, plan.config);

  // 加速地址、面板版本换了不该让 mita 重启
  const again = buildMitaDirective(plan, { appVersion: "2.3.601" });
  assert.equal(again.revision, directive.revision);
  // 配置换了 revision 跟着换
  const changed = buildMitaDirective(buildMitaHostPlan([{ id: 3, inbound: mieru({ port: 27002 }) }]), { appVersion: "2.3.600" });
  assert.notEqual(changed.revision, directive.revision);
  // 没钉哈希的版本不给下载地址
  assert.deepEqual(buildMitaDirective(plan, { appVersion: "2.3.600", version: "9.9.9" }).binaries, {});

  assert.deepEqual(buildMitaDirective(buildMitaHostPlan([]), { appVersion: "2.3.600" }), { v: 1, enabled: false, revision: "disabled" });
});

test("Agent 上报解析：只收认识的字段，计数去重、封顶", () => {
  const report = parseMitaRuntimeReport({ state: "running", revision: "r1", active: true, listeners: [{ port: 27001, protocol: "tcp", ready: true }, { port: 0 }], extra: 1 }, 1000);
  assert.deepEqual(report, { state: "running", error: "", revision: "r1", version: "", active: true, listeners: [{ port: 27001, protocol: "TCP", ready: true }], at: 1000 });
  assert.equal(parseMitaRuntimeReport(null), null);

  const traffic = parseMitaTrafficReport({ traffic: { instance: "12:34", users: [{ name: "a", up: 5, down: "7" }, { name: "a", up: 9 }, { name: "", up: 1 }, { name: "b", up: -3, down: 1e30 }] } });
  assert.deepEqual(traffic, { instance: "12:34", users: [{ name: "a", up: 5, down: 7 }, { name: "b", up: 0, down: Number.MAX_SAFE_INTEGER }] });
  assert.equal(parseMitaTrafficReport({ traffic: { users: [] } }), null);
});

test("行上的状态：需要升级 Agent → 没下发 → 出错 → 等生效 → 端口没听上 → 正常", () => {
  resetMitaRuntimeStateForTest();
  const base = { inboundId: 3, hostId: 9, isEnabled: true, ports: [27001] };
  const upgrade = mieruInboundStatusView({ ...base, agentVersion: "2.2.252" });
  assert.equal(upgrade.state, "upgrade");
  assert.match(upgrade.message, /需要升级 Agent/);
  assert.equal(mieruInboundStatusView({ ...base, isEnabled: false, agentVersion: "2.2.252" }).state, "disabled");

  assert.equal(mieruInboundStatusView({ ...base, agentVersion: "2.2.255" }).state, "pending");

  const plan = buildMitaHostPlan([{ id: 3, inbound: mieru() }, { id: 4, inbound: mieru({ users: [] }) }]);
  rememberMitaPlan(9, plan, "rev-1");
  assert.equal(mieruInboundStatusView({ ...base, inboundId: 4, agentVersion: "2.2.255" }).state, "skipped");

  const now = Date.now();
  rememberMitaReport(9, { state: "running", error: "", revision: "rev-0", version: "3.39.0", active: true, listeners: [], at: now });
  assert.equal(mieruInboundStatusView({ ...base, agentVersion: "2.2.255" }, now).state, "pending");

  rememberMitaReport(9, { state: "error", error: "安装 mita 失败", revision: "rev-0", version: "3.39.0", active: false, listeners: [], at: now });
  assert.deepEqual(mieruInboundStatusView({ ...base, agentVersion: "2.2.255" }, now), { state: "error", message: "安装 mita 失败" });

  rememberMitaReport(9, { state: "running", error: "", revision: "rev-1", version: "3.39.0", active: true, listeners: [{ port: 27001, protocol: "TCP", ready: false }], at: now });
  assert.match(mieruInboundStatusView({ ...base, agentVersion: "2.2.255" }, now).message, /端口没有听上：TCP 27001/);

  rememberMitaReport(9, { state: "running", error: "", revision: "rev-1", version: "3.39.0", active: true, listeners: [{ port: 27001, protocol: "TCP", ready: true }], at: now });
  assert.equal(mieruInboundStatusView({ ...base, agentVersion: "2.2.255" }, now).state, "ready");
  // 报告太旧了不当真
  assert.equal(mieruInboundStatusView({ ...base, agentVersion: "2.2.255" }, now + 10 * 60_000).state, "pending");
  resetMitaRuntimeStateForTest();
});

test("按用户记账：累计值算增量，进程或用户名换了从 0 重新数，重放同一份不重复记", () => {
  assert.deepEqual(mitaCounterDelta(null, { key: "p1|a", up: 10, down: 20 }), { up: 10, down: 20 });
  assert.deepEqual(mitaCounterDelta({ key: "p1|a", up: 10, down: 20 }, { key: "p1|a", up: 15, down: 20 }), { up: 5, down: 0 });
  assert.deepEqual(mitaCounterDelta({ key: "p1|a", up: 10, down: 20 }, { key: "p1|a", up: 10, down: 20 }), { up: 0, down: 0 });
  assert.deepEqual(mitaCounterDelta({ key: "p1|a", up: 100, down: 200 }, { key: "p2|a", up: 3, down: 4 }), { up: 3, down: 4 });
  assert.deepEqual(mitaCounterDelta({ key: "p1|a", up: 100, down: 200 }, { key: "p1|a", up: 3, down: 400 }), { up: 3, down: 400 });

  const rows = [
    { id: 11, inboundId: 3, ownerId: 7, name: "nexaaaa", counterKey: "1:1|nexaaaa", counterUp: 100, counterDown: 100 },
    { id: 12, inboundId: 3, ownerId: 7, name: "nexbbbb", counterKey: "", counterUp: 0, counterDown: 0 },
    { id: 21, inboundId: 4, ownerId: 8, name: "nexcccc", counterKey: "1:1|nexcccc", counterUp: 0, counterDown: 0 },
  ];
  const plan = planMitaAccounting({
    instance: "1:1",
    users: [
      { name: "nexaaaa", up: 150, down: 120 },
      { name: "nexbbbb", up: 5, down: 5 },
      { name: "nexcccc", up: 0, down: 0 },
      // 面板不认识的用户名（别的机器的、已经删掉的）：不记
      { name: "nexzzzz", up: 999, down: 999 },
    ],
  }, rows);
  assert.deepEqual(plan.rows.map((row) => [row.id, row.delta, row.key]), [
    [11, 70, "1:1|nexaaaa"],
    [12, 10, "1:1|nexbbbb"],
    [21, 0, "1:1|nexcccc"],
  ]);
  assert.deepEqual([...plan.byInbound], [[3, 80]]);
  assert.deepEqual([...plan.byOwner], [[7, 80]]);
});

test("一台机器上只剩 Mieru：sing-box 走收尾，Mieru 不进 sing-box 配置", () => {
  const onlyMieru = buildSingboxRuntimePlan({ inbounds: [{ inbound: mieru(), tag: "inbound-3" }] });
  assert.equal(onlyMieru.active, false);
  const mixed = buildSingboxRuntimePlan({
    inbounds: [
      { inbound: mieru(), tag: "inbound-3" },
      { inbound: { ...createEmptyProxyInbound(), protocol: "socks5", security: "none", port: 1080, users: [{ id: 1, name: "a", uuid: "u", password: "p" }] }, tag: "inbound-4" },
    ],
  });
  assert.equal(mixed.active, true);
  const config = JSON.parse(Buffer.from(mixed.managedConfigs[0].contentBase64, "base64").toString("utf8"));
  assert.deepEqual(config.inbounds.map((item: any) => item.tag), ["inbound-4"]);
});
