import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildMetricFamilies, MonotonicTotal, type MetricsSnapshot } from "./metricsFamilies";
import { renderMetricFamilies } from "./metricsText";

function snapshot(patch: Partial<MetricsSnapshot> = {}): MetricsSnapshot {
  return {
    panel: { version: "2.3.999", databaseKind: "sqlite", databaseUp: true },
    hosts: [
      {
        id: 1, name: 'HK "入口" 01', online: true, heartbeatAgeSeconds: 4, agentVersion: "2.2.252",
        cpuPct: 37, memoryPct: 62.5, diskPct: 80, loadPct: 45, tcpConnections: 120, udpConnections: 8,
        trafficIn: 1_000_000, trafficOut: 2_000_000,
      },
      {
        id: 2, name: "JP\\出口\n02", online: false, heartbeatAgeSeconds: 7200, agentVersion: "",
        cpuPct: null, memoryPct: null, diskPct: null, loadPct: null, tcpConnections: null, udpConnections: null,
        trafficIn: 0, trafficOut: null,
      },
    ],
    ruleCounts: { total: 2, enabled: 2, running: 1 },
    rules: [
      {
        id: 10, name: "游戏加速", hostName: 'HK "入口" 01', enabled: true, running: true,
        trafficIn: 5000, trafficOut: 7000, connectionsTotal: 42, rateIn: 1500.5, rateOut: 200,
        probeLatencyMs: 38, probeTimeout: false,
      },
      {
        id: 11, name: "备用线", hostName: "JP\\出口\n02", enabled: true, running: false,
        trafficIn: 0, trafficOut: 0, connectionsTotal: 0, rateIn: null, rateOut: null,
        probeLatencyMs: null, probeTimeout: true,
      },
    ],
    routes: [{
      ruleId: 10,
      ruleName: "游戏加速",
      hostName: 'HK "入口" 01',
      switches24h: 3,
      paths: [
        { key: "main", name: "主线路", score: 93, latencyMs: 130, lossPct: 0, jitterMs: 4, availabilityPct: 100, active: true, down: false },
        { key: "backup", name: "备用线路 1", score: null, latencyMs: null, lossPct: null, jitterMs: null, availabilityPct: null, active: false, down: true },
      ],
    }],
    traffic: { in: 300, out: 500 },
    collectSeconds: 0.012,
    ...patch,
  };
}

const render = (value: MetricsSnapshot) => renderMetricFamilies(buildMetricFamilies(value));

/** 一行样本拆成 名字 / 标签 / 值；格式不对直接断言失败。照 Prometheus 文本格式的语法写的，比正则宽松不了。 */
function parseSample(line: string) {
  const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(.*)\})? (-?[0-9.eE+-]+|NaN|[+-]Inf)$/.exec(line);
  assert.ok(match, `样本行格式不对：${line}`);
  const labels: Record<string, string> = {};
  let rest = match[3] ?? "";
  while (rest.length > 0) {
    const pair = /^([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\\n]|\\\\|\\"|\\n)*)"(,|$)/.exec(rest);
    assert.ok(pair, `标签格式不对：${rest}（整行：${line}）`);
    labels[pair[1]] = pair[2].replace(/\\(\\|"|n)/g, (_all, ch: string) => (ch === "n" ? "\n" : ch));
    rest = rest.slice(pair[0].length);
  }
  return { name: match[1], labels, value: Number(match[4]) };
}

function parse(text: string) {
  assert.ok(text.endsWith("\n"), "整份要以换行结尾");
  const types = new Map<string, string>();
  const helps = new Set<string>();
  const samples: Array<ReturnType<typeof parseSample>> = [];
  let current = "";
  for (const line of text.slice(0, -1).split("\n")) {
    if (line.startsWith("# HELP ")) {
      const name = line.split(" ")[2];
      assert.ok(!helps.has(name), `${name} 的 HELP 出现了两次`);
      helps.add(name);
      current = name;
    } else if (line.startsWith("# TYPE ")) {
      const [, , name, type] = line.split(" ");
      assert.equal(name, current, "TYPE 要紧跟在同一个族的 HELP 后面");
      assert.ok(type === "gauge" || type === "counter");
      types.set(name, type);
    } else {
      const sample = parseSample(line);
      assert.equal(sample.name, current, `样本 ${sample.name} 没有紧跟在它的 HELP / TYPE 后面`);
      samples.push(sample);
    }
  }
  return { types, helps, samples };
}

const find = (parsed: ReturnType<typeof parse>, name: string, labels: Record<string, string> = {}) => parsed.samples.filter((sample) => (
  sample.name === name && Object.entries(labels).every(([key, value]) => sample.labels[key] === value)
));

test("输出的每一行都合语法：名字统一 nex_ 前缀、都有 HELP 和 TYPE、counter 以 _total 结尾", () => {
  const parsed = parse(render(snapshot()));
  assert.ok(parsed.samples.length > 40);
  for (const sample of parsed.samples) {
    assert.ok(sample.name.startsWith("nex_"), sample.name);
    assert.ok(parsed.helps.has(sample.name), `${sample.name} 没有 HELP`);
    assert.ok(parsed.types.has(sample.name), `${sample.name} 没有 TYPE`);
    assert.ok(Number.isFinite(sample.value), `${sample.name} 的值不是数`);
  }
  for (const [name, type] of parsed.types) {
    assert.equal(type === "counter", name.endsWith("_total"), `${name} 的类型和名字对不上`);
  }
});

test("主机名、规则名里的引号、反斜杠、换行转义后能原样读回来", () => {
  const parsed = parse(render(snapshot()));
  assert.equal(find(parsed, "nex_host_online", { host_id: "1" })[0].labels.host, 'HK "入口" 01');
  assert.equal(find(parsed, "nex_host_online", { host_id: "2" })[0].labels.host, "JP\\出口\n02");
  assert.equal(find(parsed, "nex_rule_enabled", { rule_id: "11" })[0].labels.host, "JP\\出口\n02");
});

test("面板：版本信息、数据库是否正常、主机和规则的总数", () => {
  const parsed = parse(render(snapshot()));
  assert.deepEqual(find(parsed, "nex_panel_info")[0].labels, { version: "2.3.999", database: "sqlite" });
  assert.equal(find(parsed, "nex_database_up")[0].value, 1);
  assert.equal(find(parsed, "nex_hosts")[0].value, 2);
  assert.equal(find(parsed, "nex_hosts_online")[0].value, 1);
  assert.equal(find(parsed, "nex_rules")[0].value, 2);
  assert.equal(find(parsed, "nex_rules_enabled")[0].value, 2);
  assert.equal(find(parsed, "nex_rules_running")[0].value, 1);
  assert.equal(find(parsed, "nex_traffic_bytes_total", { direction: "in" })[0].value, 300);
  assert.equal(find(parsed, "nex_traffic_bytes_total", { direction: "out" })[0].value, 500);
});

test("单位换成基本单位：百分比变 0–1 的比例，毫秒变秒", () => {
  const parsed = parse(render(snapshot()));
  assert.equal(find(parsed, "nex_host_cpu_usage_ratio", { host_id: "1" })[0].value, 0.37);
  assert.equal(find(parsed, "nex_host_memory_usage_ratio", { host_id: "1" })[0].value, 0.625);
  assert.equal(find(parsed, "nex_host_load_ratio", { host_id: "1" })[0].value, 0.45);
  assert.equal(find(parsed, "nex_rule_probe_latency_seconds", { rule_id: "10" })[0].value, 0.038);
  assert.equal(find(parsed, "nex_route_path_latency_seconds", { path_key: "main" })[0].value, 0.13);
  assert.equal(find(parsed, "nex_route_path_jitter_seconds", { path_key: "main" })[0].value, 0.004);
  assert.equal(find(parsed, "nex_route_path_availability_ratio", { path_key: "main" })[0].value, 1);
  assert.equal(find(parsed, "nex_route_path_loss_ratio", { path_key: "main" })[0].value, 0);
});

test("离线主机只有在线状态和心跳，没有 CPU / 内存 / 连接数；没报版本的没有 Agent 版本序列", () => {
  const parsed = parse(render(snapshot()));
  assert.equal(find(parsed, "nex_host_online", { host_id: "2" })[0].value, 0);
  assert.equal(find(parsed, "nex_host_heartbeat_age_seconds", { host_id: "2" })[0].value, 7200);
  for (const name of ["nex_host_cpu_usage_ratio", "nex_host_memory_usage_ratio", "nex_host_disk_usage_ratio", "nex_host_load_ratio", "nex_host_connections", "nex_host_agent_info"]) {
    assert.equal(find(parsed, name, { host_id: "2" }).length, 0, name);
  }
  assert.equal(find(parsed, "nex_host_agent_info", { host_id: "1" })[0].labels.version, "2.2.252");
  assert.equal(find(parsed, "nex_host_connections", { host_id: "1", protocol: "tcp" })[0].value, 120);
  assert.equal(find(parsed, "nex_host_connections", { host_id: "1", protocol: "udp" })[0].value, 8);
});

test("累计值是 0 或没读到的不导出：查询失败按 0 返回时，不能让 Prometheus 当成计数器清零", () => {
  const parsed = parse(render(snapshot()));
  assert.equal(find(parsed, "nex_rule_traffic_bytes_total", { rule_id: "10", direction: "in" })[0].value, 5000);
  assert.equal(find(parsed, "nex_rule_traffic_bytes_total", { rule_id: "10", direction: "out" })[0].value, 7000);
  assert.equal(find(parsed, "nex_rule_connections_total", { rule_id: "10" })[0].value, 42);
  assert.equal(find(parsed, "nex_rule_traffic_bytes_total", { rule_id: "11" }).length, 0);
  assert.equal(find(parsed, "nex_rule_connections_total", { rule_id: "11" }).length, 0);
  assert.equal(find(parsed, "nex_host_traffic_bytes_total", { host_id: "2" }).length, 0);
  assert.equal(find(parsed, "nex_host_traffic_bytes_total", { host_id: "1" }).length, 2);
});

test("规则：没有速率上报的不导出速率；探测超时的导出超时标记、不导出延迟；没探测过的两样都没有", () => {
  const base = snapshot();
  const neverProbed = { ...base.rules![0], id: 12, name: "新规则", probeLatencyMs: null, probeTimeout: null };
  const parsed = parse(render(snapshot({ rules: [...base.rules!, neverProbed] })));
  assert.equal(find(parsed, "nex_rule_rate_bytes_per_second", { rule_id: "10", direction: "in" })[0].value, 1500.5);
  assert.equal(find(parsed, "nex_rule_rate_bytes_per_second", { rule_id: "11" }).length, 0);
  assert.equal(find(parsed, "nex_rule_probe_timeout", { rule_id: "10" })[0].value, 0);
  assert.equal(find(parsed, "nex_rule_probe_timeout", { rule_id: "11" })[0].value, 1);
  assert.equal(find(parsed, "nex_rule_probe_latency_seconds", { rule_id: "11" }).length, 0);
  assert.equal(find(parsed, "nex_rule_probe_timeout", { rule_id: "12" }).length, 0);
  assert.equal(find(parsed, "nex_rule_probe_latency_seconds", { rule_id: "12" }).length, 0);
  assert.equal(find(parsed, "nex_rule_running", { rule_id: "11" })[0].value, 0);
});

test("线路组：每条路径一组序列，没评分的路径只有在用 / 异常两个标记；切换次数按规则给", () => {
  const parsed = parse(render(snapshot()));
  assert.equal(find(parsed, "nex_route_path_score", { path_key: "main" })[0].value, 93);
  assert.equal(find(parsed, "nex_route_path_score", { path_key: "backup" }).length, 0);
  assert.equal(find(parsed, "nex_route_path_latency_seconds", { path_key: "backup" }).length, 0);
  assert.equal(find(parsed, "nex_route_path_active", { path_key: "main" })[0].value, 1);
  assert.equal(find(parsed, "nex_route_path_active", { path_key: "backup" })[0].value, 0);
  assert.equal(find(parsed, "nex_route_path_down", { path_key: "backup" })[0].value, 1);
  assert.equal(find(parsed, "nex_route_path_down", { path_key: "main" })[0].labels.path, "主线路");
  assert.deepEqual(find(parsed, "nex_route_switches_24h")[0].labels, { rule_id: "10", rule: "游戏加速", host: 'HK "入口" 01' });
  assert.equal(find(parsed, "nex_route_switches_24h")[0].value, 3);
});

test("上限保护：规则超过上限（快照里 rules 为空）时一条 nex_rule_ 序列都没有，汇总和线路明细照旧", () => {
  const parsed = parse(render(snapshot({ rules: null })));
  assert.equal(parsed.samples.filter((sample) => sample.name.startsWith("nex_rule_")).length, 0);
  assert.equal(find(parsed, "nex_rules")[0].value, 2);
  assert.equal(find(parsed, "nex_rules_running")[0].value, 1);
  assert.equal(find(parsed, "nex_traffic_bytes_total").length, 2);
  assert.equal(find(parsed, "nex_metrics_detail", { scope: "rule" })[0].value, 0);
  assert.equal(find(parsed, "nex_metrics_detail", { scope: "route" })[0].value, 1);
  assert.ok(find(parsed, "nex_route_path_score").length > 0);

  const none = parse(render(snapshot({ rules: null, routes: null })));
  assert.equal(none.samples.filter((sample) => sample.name.startsWith("nex_route_")).length, 0);
  assert.equal(find(none, "nex_metrics_detail", { scope: "route" })[0].value, 0);
});

test("数据库不可用：只剩面板自己知道的几项，nex_database_up 为 0，主机和规则的序列是没有而不是 0", () => {
  const parsed = parse(render(snapshot({
    panel: { version: "2.3.999", databaseKind: "mysql", databaseUp: false },
    hosts: null, ruleCounts: null, rules: null, routes: null, traffic: null,
  })));
  assert.equal(find(parsed, "nex_database_up")[0].value, 0);
  assert.deepEqual(
    Array.from(new Set(parsed.samples.map((sample) => sample.name))).sort(),
    ["nex_database_up", "nex_metrics_collect_duration_seconds", "nex_metrics_detail", "nex_panel_info"],
  );
});

test("全站流量只增不减：读数变小（有用户重置了流量）不往回掉，从新读数接着累加", () => {
  const total = new MonotonicTotal();
  assert.equal(total.observe(1000), 0, "从 0 起算，不是从当前读数起算");
  assert.equal(total.observe(1500), 500);
  assert.equal(total.observe(1200), 500, "读数变小：这一轮不加，也不往回掉");
  assert.equal(total.observe(1300), 600, "从变小后的读数接着算增量");
  assert.equal(total.observe(1300), 600);
});

test("全站流量：读不到（null）或读成 0（底下的查询失败按 0 返回）时保持原值，恢复后不把整段累计当成增量", () => {
  const total = new MonotonicTotal();
  assert.equal(total.observe(null), null, "一次都没读到过：不导出");
  const readings = [5_000_000, 5_000_100, 0, null, Number.NaN, -5, 5_000_300, 4_000_000, 4_000_050];
  const exported = readings.map((reading) => total.observe(reading));
  assert.deepEqual(exported, [0, 100, 100, 100, 100, 100, 300, 300, 350]);
  // 恢复后只多出这段时间真实的增量（200），没有 500 万的尖刺；整个序列单调不减
  for (let index = 1; index < exported.length; index += 1) {
    assert.ok(exported[index]! >= exported[index - 1]!, `第 ${index} 个读数往回掉了`);
  }
});

test("Grafana 仪表盘（deploy/grafana/nex-overview.json）里用到的每个指标名都真的会导出（改名后仪表盘不会悄悄变空）", () => {
  const dashboard = fs.readFileSync(path.join(process.cwd(), "deploy/grafana/nex-overview.json"), "utf8");
  JSON.parse(dashboard);
  const used = Array.from(new Set(dashboard.match(/nex_[a-z0-9_]+/g) || [])).filter((name) => name !== "nex_overview");
  assert.ok(used.length >= 15, `仪表盘里只找到 ${used.length} 个指标`);
  const exported = new Set(buildMetricFamilies(snapshot()).filter((item) => item.samples.length > 0).map((item) => item.name));
  for (const name of used) assert.ok(exported.has(name), `仪表盘用了不存在的指标 ${name}`);
});
