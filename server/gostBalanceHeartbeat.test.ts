import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * GOST 出口组由入口机的本机代理挑：整条心跳走下来生成的东西。
 *
 * 2.3.539 那一版加了计划却从没生效（下发前有一句恒真的「跳过」），而那一版的测试是手喂一个算好的计划去看 gost
 * 配置长什么样 —— 计划根本生成不出来这件事测不到。这里不喂任何中间结果：起一个真的 sqlite 和真的心跳路由
 * （gost-runtime/test/balance-proxy/gen-configs.mjs，端到端测试用的同一份脚本），建 1 入口 + 3 出口 + 一条开了
 * 负载均衡的 GOST 链路 + 一条规则，看入口机、出口机实际收到的下发。计划再生成不出来，这里第一条就红。
 */

type Service = { name: string; addr: string; handler: { type: string; chain?: string; retries?: number; metadata?: Record<string, string> }; listener: { type: string }; metadata?: Record<string, string>; forwarder?: { nodes: Array<{ name: string; addr: string }> } };
type Chain = { name: string; hops: Array<{ name: string; selector?: unknown; nodes: Array<{ name: string; addr: string; metadata?: Record<string, unknown> }> }> };
type Bundle = {
  scenario: string;
  entryGost: { services: Service[]; chains: Chain[] };
  entryGostResent: boolean;
  failover: { sourcePort: number; spec: Record<string, any> } | null;
  exitGost: Record<string, { services: Service[] }>;
  relayGost: { services: Service[] } | null;
};

function generate(): Record<string, Bundle> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-gost-balance-"));
  const out = path.join(directory, "gen");
  const result = spawnSync(process.execPath, ["--import", "tsx", "gost-runtime/test/balance-proxy/gen-configs.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_TYPE: "sqlite", OUT: out, FORWARDX_TEST_DB: path.join(directory, "balance.db"), FORWARDX_LOG_DIR: path.join(directory, "logs") },
    encoding: "utf8",
    timeout: 180_000,
  });
  assert.equal(result.status, 0, `gen-configs.mjs 失败：\n${result.stdout}\n${result.stderr}`);
  const bundles: Record<string, Bundle> = {};
  for (const name of fs.readdirSync(out)) {
    const file = path.join(out, name, "bundle.json");
    if (fs.existsSync(file)) bundles[name] = JSON.parse(fs.readFileSync(file, "utf8")) as Bundle;
  }
  fs.rmSync(directory, { recursive: true, force: true });
  return bundles;
}

const bundles = generate();
const service = (bundle: Bundle, name: string) => bundle.entryGost.services.find((item) => item.name === name);

test("每个场景都真的下发了本机代理的规格（老 Agent 的入口除外）", () => {
  const balanced = Object.entries(bundles).filter(([, bundle]) => !!bundle.failover?.spec?.balanceReport).map(([name]) => name).sort();
  assert.deepEqual(balanced, ["auto", "fallback", "ip_hash", "latency", "least_load", "multihop", "pin", "proxy-receive", "proxy-send", "random", "round_robin", "sensitive", "tcp-only", "udp-only", "weighted"]);
  assert.equal(bundles["old-agent"].failover, null);
});

test("入口机的 gost：公网端口交给本机代理（TCP v1 头、UDP v2 头），每台出口一个带目标的本机端口，单节点链、没有选择器", () => {
  const bundle = bundles.round_robin;
  const spec = bundle.failover!.spec;
  assert.deepEqual(bundle.entryGost.services.map((item) => item.name), [
    "fwx-1-tcp", "fwx-1-udp",
    "fwx-1-tcp-x21", "fwx-1-udp-x21", "fwx-1-tcp-x22", "fwx-1-udp-x22", "fwx-1-tcp-x23", "fwx-1-udp-x23",
  ]);
  const proxyAddr = `127.0.0.1:${spec.listenPort}`;
  assert.equal(service(bundle, "fwx-1-tcp")!.addr, ":28900");
  assert.equal(service(bundle, "fwx-1-tcp")!.forwarder!.nodes[0].addr, proxyAddr);
  assert.equal(service(bundle, "fwx-1-tcp")!.handler.chain, undefined);
  assert.deepEqual(service(bundle, "fwx-1-tcp")!.handler.metadata, { proxyProtocol: "1" });
  assert.equal(service(bundle, "fwx-1-udp")!.forwarder!.nodes[0].addr, proxyAddr);
  assert.deepEqual(service(bundle, "fwx-1-udp")!.handler.metadata, { proxyProtocol: "2" });
  // 代理的每条目标就是一台出口的本机端口；那个端口的服务带着出口该拨的目标
  assert.deepEqual(spec.balanceReport, { tunnelId: 1, hostIds: [21, 22, 23] });
  for (const [index, hostId] of [21, 22, 23].entries()) {
    const target = spec.targets[index];
    for (const proto of ["tcp", "udp"]) {
      const local = service(bundle, `fwx-1-${proto}-x${hostId}`)!;
      assert.equal(local.addr, `127.0.0.1:${target.targetPort}`);
      assert.equal(local.handler.chain, `chain-tunnel-1-x${hostId}`);
      assert.equal(local.forwarder!.nodes[0].addr, "127.0.0.1:28901", "没有目标出口不知道往哪儿拨（2.3.539 缺的就是它）");
      assert.equal(local.metadata!.dialTimeout, "3s");
    }
    assert.equal(target.probeIp, `127.0.0.${hostId - 10}`);
    assert.equal(target.probePort, 28911 + index);
  }
  assert.deepEqual(bundle.entryGost.chains.map((chain) => chain.name), ["chain-tunnel-1-x21", "chain-tunnel-1-x22", "chain-tunnel-1-x23"]);
  for (const chain of bundle.entryGost.chains) {
    assert.equal(chain.hops.length, 1);
    assert.equal(chain.hops[0].nodes.length, 1);
    assert.equal(chain.hops[0].selector, undefined);
  }
  // 出口机：relay 监听，和入口链里的节点同一个端口
  assert.equal(bundle.exitGost["22"].services[0].addr, ":28912");
  assert.equal(bundle.exitGost["22"].services[0].handler.type, "relay");
});

test("换分配方式、手动指定：只换代理的规格，入口机的 gost 配置一个字节不变（不重发）", () => {
  for (const name of ["random", "weighted", "least_load", "ip_hash", "fallback", "latency", "auto", "pin"]) {
    assert.equal(bundles[name].entryGostResent, false, `${name}：gost 配置不该重发`);
    assert.deepEqual(bundles[name].entryGost, bundles.round_robin.entryGost);
  }
  assert.deepEqual(
    Object.fromEntries(["round_robin", "random", "weighted", "least_load", "ip_hash", "fallback", "latency", "auto"].map((name) => [name, bundles[name].failover!.spec.strategy])),
    {
      round_robin: "round_robin", random: "random", weighted: "weighted", least_load: "least_load",
      ip_hash: "ip_hash", fallback: "fallback", latency: "latency", auto: "auto",
    },
  );
  // 份数：线路带宽 500 / 300 / 200 → 8 : 5 : 3（和 FXP 用的同一个来源）；轮流、随机、主备不带
  for (const name of ["weighted", "least_load", "auto", "ip_hash"]) {
    assert.deepEqual(bundles[name].failover!.spec.targets.map((target: { weight?: number }) => target.weight), [8, 5, 3], name);
  }
  for (const name of ["round_robin", "random", "fallback"]) {
    assert.deepEqual(bundles[name].failover!.spec.targets.map((target: { weight?: number }) => target.weight), [undefined, undefined, undefined], name);
  }
  assert.equal(bundles.pin.failover!.spec.pinnedIndex, 1);
  assert.equal(bundles.round_robin.failover!.spec.pinnedIndex, null);
});

test("检测灵敏度：均衡（默认）10 秒一轮（2.3.544 三档 2 / 10 / 30 秒）；手填 1 秒的照填的来", () => {
  const balanced = bundles.round_robin.failover!.spec;
  assert.deepEqual([balanced.probeIntervalSeconds, balanced.probeTimeoutMs, balanced.failureThreshold, balanced.failoverSeconds, balanced.recoverSeconds], [10, 2000, 2, 10, 20]);
  // gen-configs.mjs 里的 sensitive 样例是逐项填的 intervalSeconds: 1（不是档位）
  const sensitive = bundles.sensitive.failover!.spec;
  assert.deepEqual([sensitive.probeIntervalSeconds, sensitive.failureThreshold, sensitive.failoverSeconds, sensitive.recoverSeconds], [1, 2, 1, 2]);
});

test("PROXY protocol：入口发送的头原样转（不剥）；入口接收还是公网监听的事", () => {
  const send = bundles["proxy-send"];
  assert.deepEqual(service(send, "fwx-1-tcp")!.handler.metadata, { proxyProtocol: "2" });
  assert.equal(send.failover!.spec.proxyProtocolReceive, true);
  assert.equal(send.failover!.spec.proxyProtocolStrip, undefined);
  assert.equal(send.failover!.spec.proxyProtocolSend, true);
  assert.equal(service(send, "fwx-1-tcp-x21")!.handler.metadata, undefined, "出口那一段不再加头");
  const receive = bundles["proxy-receive"];
  assert.equal(service(receive, "fwx-1-tcp")!.metadata!.proxyProtocol, "1", "公网监听读客户端带来的头");
  assert.deepEqual(service(receive, "fwx-1-tcp")!.handler.metadata, { proxyProtocol: "1" });
  assert.equal(receive.failover!.spec.proxyProtocolStrip, true);
});

test("只有 TCP / 只有 UDP 的规则：只生成那一种协议的服务，代理的协议跟着规则", () => {
  assert.deepEqual(bundles["tcp-only"].entryGost.services.map((item) => item.name), ["fwx-1-tcp", "fwx-1-tcp-x21", "fwx-1-tcp-x22", "fwx-1-tcp-x23"]);
  assert.equal(bundles["tcp-only"].failover!.spec.protocol, "tcp");
  assert.deepEqual(bundles["udp-only"].entryGost.services.map((item) => item.name), ["fwx-1-udp", "fwx-1-udp-x21", "fwx-1-udp-x22", "fwx-1-udp-x23"]);
  assert.equal(bundles["udp-only"].failover!.spec.protocol, "udp");
});

test("入口机的 Agent 还不能执行统一调度：没有老路，只下发主出口一台（单节点、没有选择器、不重试）", () => {
  const bundle = bundles["old-agent"];
  assert.deepEqual(bundle.entryGost.services.map((item) => item.name), ["fwx-1-tcp", "fwx-1-udp"]);
  for (const item of bundle.entryGost.services) {
    assert.equal(item.handler.chain, "chain-tunnel-1");
    assert.equal(item.handler.retries, undefined);
    assert.equal(item.forwarder!.nodes[0].addr, "127.0.0.1:28901");
  }
  assert.equal(bundle.entryGost.chains.length, 1);
  assert.equal(bundle.entryGost.chains[0].hops.length, 1);
  assert.equal(bundle.entryGost.chains[0].hops[0].selector, undefined);
  assert.deepEqual(bundle.entryGost.chains[0].hops[0].nodes.map((node) => node.addr), ["127.0.0.11:28911"]);
});

test("多跳：每台出口的链是「中转 → 那台出口」，两跳各一个节点；出口带 viaRelay；中转拨下一跳 3 秒超时", () => {
  const bundle = bundles.multihop;
  assert.equal(bundle.failover!.spec.targets.length, 3);
  assert.ok(bundle.failover!.spec.targets.every((target: { viaRelay?: boolean }) => target.viaRelay === true));
  assert.deepEqual(bundle.entryGost.chains.map((chain) => chain.hops.map((hop) => hop.nodes.map((node) => node.addr))), [
    [["127.0.0.14:28920"], ["127.0.0.11:28911"]],
    [["127.0.0.14:28920"], ["127.0.0.12:28912"]],
    [["127.0.0.14:28920"], ["127.0.0.13:28913"]],
  ]);
  for (const chain of bundle.entryGost.chains) for (const hop of chain.hops) assert.equal(hop.selector, undefined);
  const names = bundle.entryGost.chains.flatMap((chain) => chain.hops.flatMap((hop) => [hop.name, ...hop.nodes.map((node) => node.name)]));
  assert.equal(new Set(names).size, names.length, "几条链里的跳和节点名字不能撞");
  const relay = bundle.relayGost!.services.find((item) => item.name.startsWith("fwx-mhop-"))!;
  assert.equal(relay.addr, ":28920");
  assert.equal(relay.metadata!.dialTimeout, "3s");
});
