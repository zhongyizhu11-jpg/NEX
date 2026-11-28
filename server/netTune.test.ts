import assert from "node:assert/strict";
import test from "node:test";

import { evaluateNetTune, netTuneBufferLimits, normalizeNetTuneResult, NETTUNE_RULES } from "../shared/netTune";
import { __test, ingestNetTuneReport, netTuneHostBandwidthMbps, netTuneStatus, NETTUNE_PENDING_TIMEOUT_MS, requestNetTuneRun, resetNetTuneStateForTest } from "./ops/netTuneAgent";

const GiB = 1073741824;
const MiB = 1048576;

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
  // 2.2.276 起 Agent 多报的
  "meminfo.memtotal": String(8 * GiB),
  "route.initcwnd": "10",
  "route.initrwnd": "10",
  "net.ipv4.tcp_mem": "12288 16384 24576",
  "net.core.netdev_budget": "300",
  "net.core.optmem_max": "20480",
  "net.ipv4.tcp_window_scaling": "1",
  "net.ipv4.tcp_moderate_rcvbuf": "1",
  "net.ipv4.tcp_adv_win_scale": "1",
  "net.ipv4.tcp_sack": "1",
  "net.ipv4.tcp_dsack": "1",
  "net.ipv4.tcp_timestamps": "1",
  "net.ipv4.tcp_syncookies": "1",
  "net.ipv4.tcp_fin_timeout": "60",
  "net.ipv4.tcp_keepalive_time": "7200",
  "vm.min_free_kbytes": "8192",
  "fs.file-max": "99999",
};

// Agent 按规则调完以后的样子（和 agent/ext_nettune_test.go 里的期望一致）。
const tuned: Record<string, string> = {
  ...distroDefaults,
  "net.core.rmem_max": "67108864",
  "net.ipv4.tcp_rmem": "4096 1048576 67108864",
  "net.ipv4.tcp_wmem": "4096 1048576 67108864",
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
  "net.core.somaxconn": "8192",
  "route.initcwnd": "32",
  "route.initrwnd": "32",
  "net.ipv4.tcp_mem": "131072 262144 524288",
  "net.core.netdev_budget": "600",
  "net.core.optmem_max": "65536",
  "net.ipv4.tcp_fin_timeout": "15",
  "net.ipv4.tcp_keepalive_time": "600",
  "vm.min_free_kbytes": "32768",
  "fs.file-max": "1000000",
};

test("网络调优判断：发行版默认值大多偏低，调完全部达标", () => {
  const before = evaluateNetTune(distroDefaults);
  assert.equal(before.total, NETTUNE_RULES.length + 4, "规则 + 拥塞控制 + 队列 + 哈希桶 + 初始窗口都参与评判");
  assert.ok(before.low >= 15, `默认值偏低的应该很多，实际 ${before.low}`);
  const byKey = Object.fromEntries(before.items.map((item) => [item.key, item]));
  assert.equal(byKey["net.core.wmem_max"].status, "ok", "调得比建议还大的算达标");
  assert.equal(byKey["net.core.wmem_max"].current, "128 MB");
  assert.equal(byKey["net.ipv4.tcp_rmem"].current, "起点 128 KB · 上限 6 MB", "tcp_rmem 看起点和上限");
  assert.equal(byKey["net.ipv4.tcp_rmem"].want, "起点 ≥ 1 MB · 上限 64 MB – 256 MB", "8 GB 内存、没填带宽：建议 64 MB，内存预算 256 MB");
  assert.equal(byKey["net.ipv4.tcp_wmem"].current, "起点 16 KB · 上限 4 MB", "tcp_wmem 起点也看（2.2.276）");
  assert.equal(byKey["net.ipv4.tcp_mem"].current, "64 MB 起缩窗 · 上限 96 MB", "tcp_mem 是页，换成字节");
  assert.equal(byKey["net.ipv4.tcp_mem"].status, "low");
  assert.equal(byKey["route.initcwnd"].status, "low");
  assert.equal(byKey["route.initcwnd"].want, "≥ 32");
  assert.equal(byKey["vm.min_free_kbytes"].current, "8 MB", "min_free_kbytes 是 KB");
  assert.equal(byKey["net.ipv4.tcp_congestion_control"].status, "low");
  assert.equal(byKey["net.ipv4.tcp_notsent_lowat"].current, "不限", "2^32-1 是内核的「不限」");
  assert.equal(byKey["net.netfilter.nf_conntrack_buckets"].status, "low");
  assert.equal(before.conntrackCount, 1234);
  assert.equal(before.conntrackMax, 262144);

  const after = evaluateNetTune(tuned);
  assert.equal(after.low, 0, `调完不该还有偏低的：${after.items.filter((item) => item.status === "low").map((item) => item.key).join(",")}`);
  assert.equal(after.ok, after.total);
});

test("网络调优判断：tcp_rmem 起点和上限都要到（老版本只抬了上限的机器算偏低）", () => {
  const status = (value: string) => evaluateNetTune({ ...tuned, "net.ipv4.tcp_rmem": value }).items.find((item) => item.key === "net.ipv4.tcp_rmem")?.status;
  assert.equal(status("4096 1048576 67108864"), "ok");
  assert.equal(status("4096 131072 67108864"), "low", "老 Agent 调过：起点还是 128 KB");
  assert.equal(status("4096 1048576 33554432"), "low", "上限不够");
  assert.equal(status("4096 1048576 536870912"), "high", "超过内存预算（8 GB 的 1/32 = 256 MB）");
  assert.equal(status("8192 8388608 134217728"), "ok", "自己调得更大的算达标");
  assert.equal(status("67108864"), "ok", "认不出三段时只看上限");
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
  assert.equal(__test.directiveFor(host, 500), undefined, "没点过不下发");

  const check = requestNetTuneRun(9, false, 1_000);
  assert.deepEqual(__test.directiveFor(host, 1_500), { runs: [{ id: check.id, apply: false, mode: "check" }] });

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

test("逐项设置 / 还原：面板先校验，指令带 mode 和 values；检查让位给改动，改动不叠加", async () => {
  const { normalizeNetTuneSetting, NETTUNE_EDITABLE_KEYS, normalizeNetTuneResult } = await import("../shared/netTune");
  const agent = await import("./ops/netTuneAgent");
  agent.resetNetTuneStateForTest();

  assert.equal(normalizeNetTuneSetting("net.ipv4.tcp_rmem", " 4096  131072\t33554432 "), "4096 131072 33554432");
  assert.equal(normalizeNetTuneSetting("net.core.default_qdisc", "cake"), "cake");
  assert.equal(normalizeNetTuneSetting("net.ipv4.tcp_congestion_control", "bbr"), "bbr");
  assert.throws(() => normalizeNetTuneSetting("kernel.panic", "1"), /不能在这里改/);
  assert.throws(() => normalizeNetTuneSetting("net.core.somaxconn", "-1"), /不是非负整数/);
  assert.throws(() => normalizeNetTuneSetting("net.core.somaxconn", "1; reboot"), /不是非负整数/);
  assert.throws(() => normalizeNetTuneSetting("net.core.somaxconn", ""), /值是空的/);
  assert.throws(() => normalizeNetTuneSetting("net.ipv4.tcp_rmem", "1 2 3 4"), /最多 3 个数/);
  assert.equal(normalizeNetTuneSetting("net.ipv4.tcp_rmem", "4096 1048576 67108864"), "4096 1048576 67108864");
  assert.throws(() => normalizeNetTuneSetting("net.ipv4.tcp_rmem", "4096 134217728 67108864"), /最小 ≤ 起点 ≤ 上限/);
  assert.throws(() => normalizeNetTuneSetting("net.ipv4.tcp_wmem", "65536 16384 67108864"), /最小 ≤ 起点 ≤ 上限/);
  assert.throws(() => normalizeNetTuneSetting("net.core.default_qdisc", "noqueue"), /只支持/);
  assert.throws(() => normalizeNetTuneSetting("net.ipv4.tcp_congestion_control", "bbr cubic"), /算法名不对/);
  assert.ok(NETTUNE_EDITABLE_KEYS.includes("net.ipv4.tcp_congestion_control"));

  const host = { id: 7 } as any;
  const check = agent.requestNetTuneRun(7, false, 1_000);
  assert.equal(check.mode, "check");
  const set = agent.requestNetTuneRun(7, "set", 1_001, { "net.core.somaxconn": "65535" });
  assert.notEqual(set.id, check.id, "检查让位给设置");
  assert.equal(agent.requestNetTuneRun(7, "restore", 1_002).id, set.id, "已经在等一轮改动：不叠加");
  assert.deepEqual(agent.__test.directiveFor(host, 1_003), { runs: [{ id: set.id, apply: false, mode: "set", values: { "net.core.somaxconn": "65535" } }] });

  agent.ingestNetTuneReport(host, { results: [{ id: set.id, status: "done", apply: false, mode: "set", hasBackup: true, changed: [{ key: "net.core.somaxconn", from: "4096", to: "65535" }] }] });
  const status = agent.netTuneStatus(7, 1_004);
  assert.equal(status.pending, null);
  assert.equal(status.lastApply?.mode, "set", "逐项设置算「最近一次改动」");
  assert.equal(status.latest?.hasBackup, true);

  // 老 Agent 不报 mode / hasBackup：按 undefined，不当成能还原
  const old = normalizeNetTuneResult({ id: "abc", status: "done", apply: true });
  assert.equal(old?.mode, undefined);
  assert.equal(old?.hasBackup, undefined);
  agent.resetNetTuneStateForTest();
});

test("缓冲上限按带宽和内存算（和 Agent 同一个公式）：小内存压下来、知道带宽按 2×BDP+2MB", () => {
  assert.deepEqual(netTuneBufferLimits(null), { want: 64 * MiB, budget: null }, "老 Agent 不报内存：照旧 64 MB、不封顶");
  assert.deepEqual(netTuneBufferLimits(512 * MiB), { want: 16 * MiB, budget: 16 * MiB });
  assert.deepEqual(netTuneBufferLimits(981 * MiB), { want: 30 * MiB, budget: 30 * MiB }, "按 MiB 往下取整");
  assert.deepEqual(netTuneBufferLimits(8 * GiB), { want: 64 * MiB, budget: 256 * MiB });
  assert.equal(netTuneBufferLimits(8 * GiB, 500).want, 20 * MiB);
  assert.equal(netTuneBufferLimits(8 * GiB, 1000).want, 38 * MiB);
  assert.equal(netTuneBufferLimits(8 * GiB, 2000).want, 74 * MiB, "2G 口比固定 64 MB 大");
  assert.equal(netTuneBufferLimits(GiB, 2000).want, 32 * MiB, "内存小：按内存封顶");
  assert.equal(netTuneBufferLimits(8 * GiB, 30).want, 4 * MiB, "底线 4 MB");

  // 1 GB 小鸡：老版本抬到的 64 MB 算偏高，一键调优会压到 32 MB
  const small = evaluateNetTune({ ...tuned, "meminfo.memtotal": String(GiB) });
  const byKey = Object.fromEntries(small.items.map((item) => [item.key, item]));
  assert.equal(byKey["net.core.rmem_max"].status, "high");
  assert.equal(byKey["net.core.rmem_max"].want, "≥ 32 MB");
  assert.equal(byKey["net.ipv4.tcp_rmem"].status, "high");
  assert.ok(small.low >= 4, "偏高也算「可以调」");
  const fixed = evaluateNetTune({ ...tuned, "meminfo.memtotal": String(GiB), "net.core.rmem_max": String(32 * MiB), "net.core.wmem_max": String(32 * MiB), "net.ipv4.tcp_rmem": `4096 ${MiB} ${32 * MiB}`, "net.ipv4.tcp_wmem": `4096 ${MiB} ${32 * MiB}`, "net.ipv4.tcp_mem": "16384 32768 65536" });
  assert.equal(fixed.low, 0, fixed.items.filter((item) => item.status !== "ok").map((item) => item.key).join(","));

  // 填了 500M 带宽：20 MB 就够
  const withBw = evaluateNetTune({ ...tuned, "net.core.rmem_max": String(20 * MiB) }, { bandwidthMbps: 500 });
  assert.equal(withBw.items.find((item) => item.key === "net.core.rmem_max")?.status, "ok");
  assert.equal(withBw.bandwidthMbps, 500);
  assert.equal(withBw.memBytes, 8 * GiB);
});

test("老 Agent（2.2.276 之前）：新加的几项写「升级后能看到」，不算不达标", () => {
  const added = ["meminfo.memtotal", "route.initcwnd", "route.initrwnd", "net.ipv4.tcp_mem", "net.core.netdev_budget", "net.core.optmem_max", "net.ipv4.tcp_window_scaling", "net.ipv4.tcp_moderate_rcvbuf", "net.ipv4.tcp_adv_win_scale", "net.ipv4.tcp_sack", "net.ipv4.tcp_dsack", "net.ipv4.tcp_timestamps", "net.ipv4.tcp_syncookies", "net.ipv4.tcp_fin_timeout", "net.ipv4.tcp_keepalive_time", "vm.min_free_kbytes", "fs.file-max"];
  const old = Object.fromEntries(Object.entries(tuned).filter(([key]) => !added.includes(key)));
  const evaluation = evaluateNetTune(old);
  const initcwnd = evaluation.items.find((item) => item.key === "route.initcwnd");
  assert.equal(initcwnd?.status, "missing");
  assert.match(initcwnd?.hint ?? "", /Agent 2\.2\.276 起/);
  assert.match(evaluation.items.find((item) => item.key === "net.ipv4.tcp_mem")?.hint ?? "", /升级后能看到/);
  // 新 Agent、没有默认路由：说清楚原因
  const noRoute = evaluateNetTune(Object.fromEntries(Object.entries(tuned).filter(([key]) => !key.startsWith("route."))));
  assert.match(noRoute.items.find((item) => item.key === "route.initcwnd")?.hint ?? "", /没有 IPv4 默认路由/);
  // fs.file-max 带连字符：上报时不能被当成非法键丢掉
  assert.equal(normalizeNetTuneResult({ id: "x", status: "done", values: { "fs.file-max": "1000000" } })?.values?.["fs.file-max"], "1000000");
});

test("一键调优带上这台机器的带宽：线路带宽优先，没填用手动出口整形的带宽", () => {
  assert.equal(netTuneHostBandwidthMbps({ lineBandwidthMbps: 1000, egressShapingMode: "manual", egressMbps: 500 }), 1000);
  assert.equal(netTuneHostBandwidthMbps({ lineBandwidthMbps: 0, egressShapingMode: "manual", egressMbps: 500 }), 500);
  assert.equal(netTuneHostBandwidthMbps({ lineBandwidthMbps: 0, egressShapingMode: "auto", egressMbps: 500 }), 0, "自动整形的值不是填的带宽");
  assert.equal(netTuneHostBandwidthMbps({}), 0);
  resetNetTuneStateForTest();
  const run = requestNetTuneRun(11, "apply", 1_000, undefined, 800);
  assert.deepEqual(__test.directiveFor({ id: 11 } as any, 1_001), { runs: [{ id: run.id, apply: true, mode: "apply", bandwidthMbps: 800 }] });
  resetNetTuneStateForTest();
  const check = requestNetTuneRun(11, false, 2_000);
  assert.deepEqual(__test.directiveFor({ id: 11 } as any, 2_001), { runs: [{ id: check.id, apply: false, mode: "check" }] }, "不知道带宽时不带这个字段");
  resetNetTuneStateForTest();
});

test("面板和 Agent 的规则表一致：同样的键、按内存算的同一批（顺序不管）", async () => {
  const { readFileSync } = await import("node:fs");
  const go = readFileSync(new URL("../agent/ext_nettune.go", import.meta.url), "utf8");
  const table = go.slice(go.indexOf("var netTuneRules = []netTuneRule{"), go.indexOf("\n}\n", go.indexOf("var netTuneRules = []netTuneRule{")));
  const goRules = [...table.matchAll(/\{key: "([^"]+)"[^}]*\}/g)].map((match) => ({ key: match[1], mem: /mem: netTuneMem(\w+)/.exec(match[0])?.[1] ?? null }));
  const memName: Record<string, string> = { buffer: "Buffer", tcpMem: "TCPMem", minFree: "MinFree" };
  const sorted = (rules: { key: string; mem: string | null }[]) => rules.map((rule) => `${rule.key}:${rule.mem ?? "-"}`).sort();
  assert.deepEqual(sorted(goRules), sorted(NETTUNE_RULES.map((rule) => ({ key: rule.key, mem: rule.mem ? memName[rule.mem] : null }))));
});
