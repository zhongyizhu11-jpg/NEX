import assert from "node:assert/strict";
import test from "node:test";

import {
  expandWeightedMembers,
  hostBandwidthHintMbps,
  proxyLoadBalanceWeights,
  type ProxySubscriptionDocument,
} from "./proxySubscriptionPlan";
import { renderProxySubscription } from "./proxySubscription";

test("前置带宽：总限速 > 出口整形 > 主机名括号里的带宽", () => {
  assert.equal(hostBandwidthHintMbps({ name: "Po0(500M)", rateLimitMbps: 400 }), 400);
  assert.equal(hostBandwidthHintMbps({ name: "Po0(500M)", egressMbps: 450 }), 450);
  assert.equal(hostBandwidthHintMbps({ name: "Po0(500M)" }), 500);
  assert.equal(hostBandwidthHintMbps({ name: "po0（300M）" }), 300);
  assert.equal(hostBandwidthHintMbps({ name: "港机【1G】" }), 1000);
  assert.equal(hostBandwidthHintMbps({ name: "HK [2.5Gbps]" }), 2500);
  assert.equal(hostBandwidthHintMbps({ name: "香港5G" }), 0, "不在括号里：多半是说移动网络");
  assert.equal(hostBandwidthHintMbps({ name: "Jinx(29.9y)" }), 0, "括号里是价格");
  assert.equal(hostBandwidthHintMbps(null), 0);
});

test("权重：按带宽比例取小整数；不知道带宽或都一样就平均分", () => {
  assert.deepEqual(proxyLoadBalanceWeights([500, 300]), [5, 3]);
  assert.deepEqual(proxyLoadBalanceWeights([1000, 100]), [10, 1]);
  assert.deepEqual(proxyLoadBalanceWeights([600, 300]), [2, 1]);
  assert.equal(proxyLoadBalanceWeights([500, 500]), null);
  assert.equal(proxyLoadBalanceWeights([500, 0]), null, "有一台不知道带宽：猜错不如平均");
  assert.equal(proxyLoadBalanceWeights([500]), null);
});

test("展开成平滑的轮询顺序：5:3 交错排，不是连着五个 A", () => {
  const order = expandWeightedMembers(["A", "B"], [5, 3]);
  assert.equal(order.length, 8);
  assert.equal(order.filter((name) => name === "A").length, 5);
  assert.ok(!order.join("").includes("AAA"), order.join(""));
  assert.deepEqual(expandWeightedMembers(["A", "B"], null), ["A", "B"]);
});

test("Clash 订阅：mihomo 客户端按份数展开，其它客户端照旧平均分", () => {
  const document: ProxySubscriptionDocument = {
    nodes: [
      { ...({} as any), name: "Po0(500M)", protocol: "shadowsocks", address: "1.1.1.1", port: 1, password: "p", method: "aes-256-gcm" },
      { ...({} as any), name: "po0(300M)", protocol: "shadowsocks", address: "2.2.2.2", port: 2, password: "p", method: "aes-256-gcm" },
    ],
    groups: [{ name: "落地 负载均衡", type: "load-balance", members: ["Po0(500M)", "po0(300M)"], weights: [5, 3] }],
    ruleSets: [],
    rules: [],
  };
  const groupLine = (yaml: string) => yaml.split("\n").find((line) => line.trim().startsWith("proxies: ["))!;
  const weighted = groupLine(renderProxySubscription(document, "clash", { weightedLoadBalance: true }));
  assert.equal((weighted.match(/Po0\(500M\)/g) || []).length, 5, weighted);
  assert.equal((weighted.match(/po0\(300M\)/g) || []).length, 3, weighted);
  const plain = groupLine(renderProxySubscription(document, "clash"));
  assert.equal((plain.match(/Po0\(500M\)/g) || []).length, 1, plain);
});
