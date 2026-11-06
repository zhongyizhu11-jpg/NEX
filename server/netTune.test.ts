import assert from "node:assert/strict";
import test from "node:test";

import { evaluateNetTune, normalizeNetTuneResult, NETTUNE_RULES } from "../shared/netTune";
import { __test, ingestNetTuneReport, netTuneStatus, NETTUNE_PENDING_TIMEOUT_MS, requestNetTuneRun, resetNetTuneStateForTest } from "./ops/netTuneAgent";

const distroDefaults: Record<string, string> = {
  "net.ipv4.ip_forward": "1",
  "net.core.rmem_max": "212992",
  "net.core.wmem_max": "134217728",
  "net.ipv4.tcp_rmem": "4096 131072 6291456",
  "net.ipv4.tcp_wmem": "4096 16384 4194304",
  "net.netfilter.nf_conntrack_max": "262144",
  "net.netfilter.nf_conntrack_buckets": "65536",
  "net.netfilter.nf_conntrack_count": "1234",
  "net.netfilter.nf_conntrack_tcp_be_liberal": "0",
  "net.ipv4.tcp_no_metrics_save": "0",
  "net.core.rmem_default": "212992",
  "net.core.wmem_default": "212992",
  "net.ipv4.udp_rmem_min": "4096",
  "net.ipv4.udp_wmem_min": "4096",
  "net.core.netdev_max_backlog": "1000",
  "net.core.somaxconn": "4096",
  "net.ipv4.tcp_max_syn_backlog": "512",
  "net.ipv4.tcp_mtu_probing": "0",
  "net.ipv4.tcp_notsent_lowat": "4294967295",
  "net.ipv4.tcp_slow_start_after_idle": "1",
  "net.ipv4.tcp_fastopen": "1",
  "net.ipv4.tcp_tw_reuse": "2",
  "net.ipv4.tcp_congestion_control": "cubic",
  "net.ipv4.tcp_available_congestion_control": "reno cubic bbr",
  "net.core.default_qdisc": "fq_codel",
  "kernel.osrelease": "6.1.0",
};

// Agent 按规则调完以后的样子（和 agent/ext_nettune_test.go 里的期望一致）。
const tuned: Record<string, string> = {
  ...distroDefaults,
  "net.core.rmem_max": "67108864",
  "net.ipv4.tcp_rmem": "4096 131072 67108864",
  "net.ipv4.tcp_wmem": "4096 16384 67108864",
  "net.netfilter.nf_conntrack_max": "1048576",
  "net.netfilter.nf_conntrack_buckets": "262144",
  "net.netfilter.nf_conntrack_tcp_be_liberal": "1",
  "net.ipv4.tcp_no_metrics_save": "1",
  "net.core.rmem_default": "1048576",
  "net.core.wmem_default": "1048576",
  "net.ipv4.udp_rmem_min": "16384",
  "net.ipv4.udp_wmem_min": "16384",
  "net.core.netdev_max_backlog": "16384",
  "net.ipv4.tcp_max_syn_backlog": "8192",
  "net.ipv4.tcp_mtu_probing": "1",
  "net.ipv4.tcp_notsent_lowat": "131072",
  "net.ipv4.tcp_slow_start_after_idle": "0",
  "net.ipv4.tcp_fastopen": "3",
  "net.ipv4.tcp_tw_reuse": "1",
  "net.ipv4.tcp_congestion_control": "bbr",
  "net.core.default_qdisc": "fq",
};

test("网络调优判断：发行版默认值大多偏低，调完全部达标", () => {
  const before = evaluateNetTune(distroDefaults);
  assert.equal(before.total, NETTUNE_RULES.length + 3, "规则 + 拥塞控制 + 队列 + 哈希桶都参与评判");
  assert.ok(before.low >= 15, `默认值偏低的应该很多，实际 ${before.low}`);
  const byKey = Object.fromEntries(before.items.map((item) => [item.key, item]));
  assert.equal(byKey["net.core.wmem_max"].status, "ok", "调得比建议还大的算达标");
  assert.equal(byKey["net.core.wmem_max"].current, "128 MB");
  assert.equal(byKey["net.ipv4.tcp_rmem"].current, "6 MB", "三元组看最后一个字段");
  assert.equal(byKey["net.ipv4.tcp_congestion_control"].status, "low");
  assert.equal(byKey["net.netfilter.nf_conntrack_buckets"].status, "low");
  assert.equal(before.conntrackCount, 1234);
  assert.equal(before.conntrackMax, 262144);

  const after = evaluateNetTune(tuned);
  assert.equal(after.low, 0, `调完不该还有偏低的：${after.items.filter((item) => item.status === "low").map((item) => item.key).join(",")}`);
  assert.equal(after.ok, after.total);
});

test("网络调优判断：自选的拥塞控制算法不算不达标；缺的参数单列", () => {
  const custom = evaluateNetTune({ ...tuned, "net.ipv4.tcp_congestion_control": "hybla", "net.core.default_qdisc": "fq_codel" });
  const byKey = Object.fromEntries(custom.items.map((item) => [item.key, item]));
  assert.equal(byKey["net.ipv4.tcp_congestion_control"].status, "custom");
  assert.equal(byKey["net.core.default_qdisc"].status, "custom");
  assert.equal(custom.low, 0);

  const noConntrack = Object.fromEntries(Object.entries(tuned).filter(([key]) => !key.startsWith("net.netfilter.")));
  const evaluation = evaluateNetTune(noConntrack);
  assert.equal(evaluation.conntrackMax, null);
  assert.ok(evaluation.items.filter((item) => item.group === "conntrack").every((item) => item.status === "missing"));
  assert.equal(evaluation.low, 0);

  // 表上限调得比建议大时，哈希桶要跟着到 上限 / 4
  const bigTable = evaluateNetTune({ ...tuned, "net.netfilter.nf_conntrack_max": "4194304", "net.netfilter.nf_conntrack_buckets": "262144" });
  assert.equal(bigTable.items.find((item) => item.key === "net.netfilter.nf_conntrack_buckets")?.status, "low");
});

test("Agent 上报收拾干净：非法 id、超长字段、乱类型", () => {
  assert.equal(normalizeNetTuneResult({ id: "../etc", status: "done" }), null);
  assert.equal(normalizeNetTuneResult({ id: "ok-1", status: "weird" }), null);
  const result = normalizeNetTuneResult({
    id: "ok-1",
    apply: true,
    status: "done",
    startedAt: "123",
    finishedAt: 456,
    values: { "net.core.rmem_max": "67108864", "BAD KEY": "x", "net.core.wmem_max": 5 },
    changed: [{ key: "net.core.rmem_max", from: "212992", to: "67108864" }, "junk", { from: "no key" }],
    failed: [{ key: "net.netfilter.nf_conntrack_max", error: "x".repeat(2000) }],
    error: 7,
  });
  assert.ok(result);
  assert.equal(result.startedAt, 123);
  assert.deepEqual(Object.keys(result.values ?? {}).sort(), ["net.core.rmem_max", "net.core.wmem_max"]);
  assert.equal(result.values?.["net.core.wmem_max"], "", "不是字符串的值清成空");
  assert.equal(result.changed?.length, 1);
  assert.equal(result.failed?.[0].error.length, 512);
  assert.equal(result.error, undefined);
});

test("面板一轮：点检查 → 下发 → 收到结果；调优优先；超时", () => {
  resetNetTuneStateForTest();
  const host = { id: 9, agentVersion: "2.2.250" };
  const oldHost = { id: 9, agentVersion: "2.2.249" };
  assert.equal(__test.directiveFor(host, 500), undefined, "没点过不下发");

  const check = requestNetTuneRun(9, false, 1_000);
  assert.deepEqual(__test.directiveFor(host, 1_500), { runs: [{ id: check.id, apply: false }] });
  assert.equal(__test.directiveFor(oldHost, 1_500), undefined, "老 Agent 不下发");

  // 在等检查时点调优：换成调优
  const apply = requestNetTuneRun(9, true, 2_000);
  assert.notEqual(apply.id, check.id);
  assert.equal(apply.apply, true);
  assert.equal(requestNetTuneRun(9, false, 3_000).id, apply.id, "在等调优时再点检查：还是那一轮");

  // 别的 id、还在跑的：不算
  ingestNetTuneReport(host, { results: [{ id: check.id, status: "done", values: {} }, { id: apply.id, status: "running" }] });
  assert.ok(netTuneStatus(9, 3_000).pending);
  ingestNetTuneReport(host, { results: [{ id: apply.id, apply: true, status: "done", finishedAt: 5, values: tuned, changed: [{ key: "net.core.rmem_max", from: "1", to: "2" }] }] });
  const status = netTuneStatus(9, 3_000);
  assert.equal(status.pending, null);
  assert.equal(status.latest?.id, apply.id);
  assert.equal(status.lastApply?.changed?.length, 1);
  assert.equal(__test.directiveFor(host, 3_000), undefined, "收到了就不再下发");

  // 超时
  const late = requestNetTuneRun(9, false, 10_000);
  const expired = netTuneStatus(9, 10_000 + NETTUNE_PENDING_TIMEOUT_MS + 1);
  assert.equal(expired.pending, null);
  assert.equal(expired.timedOut?.id, late.id);
  assert.equal(expired.lastApply?.id, apply.id, "超时不清掉上一次调优的结果");
  resetNetTuneStateForTest();
});
