import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { normalizeFxpRuntimeMetricRow } from "./fxpRuntimeMetrics";

test("规整上报行：名字 / 角色 / 种类是闭合名单，进程级没有隧道，counter 为 0 不收", () => {
  const ok = normalizeFxpRuntimeMetricRow({ tunnelId: 7, ruleId: 3, role: "Entry", name: "UDP_QUEUE_DROP", kind: "counter", value: 5 });
  assert.deepEqual(ok, { tunnelId: 7, ruleId: 3, role: "entry", name: "udp_queue_drop", kind: "counter", value: 5 });
  assert.equal(normalizeFxpRuntimeMetricRow({ tunnelId: 7, role: "entry", name: "udp_queue_drop", kind: "counter", value: 0 }), null, "counter 为 0");
  assert.deepEqual(normalizeFxpRuntimeMetricRow({ tunnelId: 7, role: "exit", name: "tcp_sessions", kind: "gauge", value: 0 })?.value, 0, "gauge 为 0 要收");
  assert.equal(normalizeFxpRuntimeMetricRow({ tunnelId: 7, role: "entry", name: "evil_label", kind: "counter", value: 1 }), null, "名字不认");
  assert.equal(normalizeFxpRuntimeMetricRow({ tunnelId: 7, role: "hacker", name: "pool_miss", kind: "counter", value: 1 }), null, "角色不认");
  assert.equal(normalizeFxpRuntimeMetricRow({ tunnelId: 7, role: "entry", name: "udp_sessions", kind: "counter", value: 1 }), null, "gauge 名字冒充 counter");
  assert.equal(normalizeFxpRuntimeMetricRow({ tunnelId: 0, role: "entry", name: "pool_miss", kind: "counter", value: 1 }), null, "非进程级没有隧道");
  assert.equal(normalizeFxpRuntimeMetricRow({ tunnelId: 5, role: "process", name: "peer_gone", kind: "counter", value: 1 }), null, "进程级不能带隧道");
  assert.deepEqual(normalizeFxpRuntimeMetricRow({ tunnelId: 0, role: "process", name: "peer_gone", kind: "counter", value: 2 }), { tunnelId: 0, ruleId: 0, role: "process", name: "peer_gone", kind: "counter", value: 2 });
  assert.equal(normalizeFxpRuntimeMetricRow({ tunnelId: 7, role: "entry", name: "pool_miss", kind: "counter", value: -3 }), null, "负数");
  assert.equal(normalizeFxpRuntimeMetricRow(null), null);
});

/** 接上真库：落库、不存在的隧道不收、进程级行照收、最近 5 分钟 counter 相加、gauge 取最新、过时的不算。 */
test("fxp runtime metrics ingest and 5-minute collection against a real database", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-fxp-metrics-"));
  try {
    const script = String.raw`
      import assert from "node:assert/strict";
      import path from "node:path";
      import { pathToFileURL } from "node:url";
      const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
      const runtime = await import(url("server/dbRuntime.ts"));
      const schema = await import(url("server/dbSchema.ts"));
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const metrics = await import(url("server/ops/fxpRuntimeMetrics.ts"));
      const exists = async (id) => id === 7;
      const now = Date.now();
      const row = (patch) => ({ tunnelId: 7, ruleId: 3, role: "entry", name: "udp_queue_drop", kind: "counter", value: 2, ...patch });
      // 8 分钟前的：不在 5 分钟窗口里
      assert.equal(await metrics.recordFxpRuntimeMetricsReport(1, [row({ value: 100 })], { nowMs: now - 8 * 60_000, tunnelExists: exists }), 1);
      // 3 分钟前和刚才：counter 相加、gauge 取最新
      assert.equal(await metrics.recordFxpRuntimeMetricsReport(1, [
        row({ value: 5 }),
        row({ name: "udp_sessions", kind: "gauge", value: 40 }),
        row({ tunnelId: 99 }),                                             // 隧道不存在
        { tunnelId: 0, role: "process", name: "peer_gone", kind: "counter", value: 3 },
      ], { nowMs: now - 3 * 60_000, tunnelExists: exists }), 3);
      assert.equal(await metrics.recordFxpRuntimeMetricsReport(1, [
        row({ value: 7 }),
        row({ name: "udp_sessions", kind: "gauge", value: 12 }),
        row({ role: "exit", name: "tcp_sessions", kind: "gauge", value: 0, ruleId: 0 }),
      ], { nowMs: now, tunnelExists: exists }), 3);
      const samples = await metrics.collectFxpRuntimeMetrics(now);
      const find = (role, name) => samples.find((s) => s.role === role && s.name === name);
      assert.equal(find("entry", "udp_queue_drop").value, 12, "最近 5 分钟的 counter 相加，8 分钟前的不算");
      assert.equal(find("entry", "udp_sessions").value, 12, "gauge 取最新一分钟的值");
      assert.equal(find("exit", "tcp_sessions").value, 0, "gauge 为 0 也在");
      assert.equal(find("process", "peer_gone").value, 3);
      assert.equal(find("process", "peer_gone").tunnelId, 0);
      assert.equal(samples.length, 4);
      console.log("ok");
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: path.resolve(import.meta.dirname, "..", ".."),
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_TYPE: "sqlite",
        FORWARDX_TEST_DB: path.join(directory, "fxp-metrics.db"),
        FORWARDX_LOG_DIR: path.join(directory, "logs"),
      },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /ok/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
