import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseRoutePaths } from "../shared/routeGroup";
import { recordRouteAgentStats, resetRouteStatsForTest } from "./routeGroupStats";
import {
  ROUTE_PATH_QUALITY_SAMPLE_INTERVAL_MS,
  bucketRouteQualityRows,
  planRoutePathQualitySamples,
  recordRoutePathQuality,
  resetRoutePathQualityThrottleForTest,
  routeQualityBucketMs,
} from "./routePathQualityHistory";
import { routePathQualityToInsert, type RoutePathQualityRow } from "./repositories/routePathQualityRepository";

/*
  线路组路径质量历史：每条路径最多一分钟一行（节流）、旧快照不补点、写失败下次重写、
  按桶合并、七天保留（真的 SQLite 上删对）。
*/

const paths = parseRoutePaths(JSON.stringify([
  { key: "main", name: "主线路", hops: [2], dest: null, weight: 60 },
  { key: "backup", name: "备用", hops: [], dest: { ip: "203.0.113.11", port: 443 }, weight: 40 },
]));

function target(index: number, patch: Record<string, unknown> = {}) {
  return {
    index, target: `10.0.0.${index}:443`, healthy: true, down: false, downReason: "", score: 90, latencyMs: 40 + index,
    lossPct: 0.5, jitterMs: 4, availabilityPct: 99.5, consecutiveFailures: 0, connections: 0, samples: 60, lastProbeAt: 1, ...patch,
  };
}

test("节流：同一条路径一分钟内只落一行，过了一分钟再落", () => {
  const lastWritten = new Map<string, number>();
  const stats = { ruleId: 7, targets: [target(0), target(1)], reportedAt: 1_000_000 };
  const first = planRoutePathQualitySamples({ stats, paths, nowMs: 1_000_000, lastWritten });
  assert.deepEqual(first.map((row) => row.pathKey), ["main", "backup"]);
  assert.equal(first[0].latencyMs, 40);
  assert.equal(first[1].availabilityPct, 99.5);
  const again = planRoutePathQualitySamples({ stats: { ...stats, reportedAt: 1_030_000 }, paths, nowMs: 1_030_000, lastWritten });
  assert.equal(again.length, 0, "30 秒后的心跳不落");
  const later = planRoutePathQualitySamples({ stats: { ...stats, reportedAt: 1_000_000 + ROUTE_PATH_QUALITY_SAMPLE_INTERVAL_MS }, paths, nowMs: 1_000_000 + ROUTE_PATH_QUALITY_SAMPLE_INTERVAL_MS, lastWritten });
  assert.equal(later.length, 2);
});

test("不落：快照太旧、下标对不上路径、还没探过", () => {
  const lastWritten = new Map<string, number>();
  assert.equal(planRoutePathQualitySamples({ stats: { ruleId: 7, targets: [target(0)], reportedAt: 0 }, paths, nowMs: 10 * 60_000, lastWritten }).length, 0);
  const rows = planRoutePathQualitySamples({
    stats: { ruleId: 7, targets: [target(5), target(1, { samples: 0, latencyMs: null, score: null })], reportedAt: 1_000 },
    paths,
    nowMs: 1_000,
    lastWritten,
  });
  assert.equal(rows.length, 0);
});

test("recordRoutePathQuality：从内存里的评分快照写，节流跨心跳生效，写失败撤销节流", async () => {
  resetRouteStatsForTest();
  resetRoutePathQualityThrottleForTest();
  const rule = { id: 42, failoverEnabled: true, routePaths: JSON.stringify(paths) };
  const report = (nowMs: number) => recordRouteAgentStats({ hostId: 1, isAllowed: () => true, nowMs, reports: [{ ruleId: 42, activeIndex: 0, targets: [target(0), target(1)] }] });
  const written: RoutePathQualityRow[][] = [];
  const insert = async (rows: RoutePathQualityRow[]) => { written.push(rows); };

  report(5_000_000);
  assert.equal(await recordRoutePathQuality({ rules: [rule], nowMs: 5_000_000, insert }), 2);
  report(5_005_000);
  assert.equal(await recordRoutePathQuality({ rules: [rule], nowMs: 5_005_000, insert }), 0, "5 秒后的心跳不写");
  assert.equal(written.length, 1);

  const failing = async () => { throw new Error("disk full"); };
  report(5_070_000);
  assert.equal(await recordRoutePathQuality({ rules: [rule], nowMs: 5_070_000, insert: failing }), 0);
  report(5_071_000);
  assert.equal(await recordRoutePathQuality({ rules: [rule], nowMs: 5_071_000, insert }), 2, "上一分钟没写进去，下一次心跳补上");
  resetRouteStatsForTest();
  resetRoutePathQualityThrottleForTest();
});

test("入库换算：丢包、可用率存千分比整数，越界截断", () => {
  const row = routePathQualityToInsert({ ruleId: 1, pathKey: "main", sampledAt: 1_700_000_000_500, latencyMs: 38.6, lossPct: 2.55, jitterMs: 4.4, availabilityPct: 99.95, score: 140 });
  assert.equal(row.lossPermille, 26);
  assert.equal(row.availabilityPermille, 1000);
  assert.equal(row.latencyMs, 39);
  assert.equal(row.score, 100);
  assert.equal((row.sampledAt as Date).getTime(), 1_700_000_000_000);
});

test("按桶合并：平均延迟、丢包；全超时的桶延迟为空", () => {
  const base = 1_700_000_000_000 - (1_700_000_000_000 % 300_000);
  const rows: RoutePathQualityRow[] = [
    { ruleId: 1, pathKey: "main", sampledAt: base, latencyMs: 40, lossPct: 0, jitterMs: 4, availabilityPct: 100, score: 90 },
    { ruleId: 1, pathKey: "main", sampledAt: base + 60_000, latencyMs: 60, lossPct: 2, jitterMs: 6, availabilityPct: 98, score: 80 },
    { ruleId: 1, pathKey: "main", sampledAt: base + 300_000, latencyMs: null, lossPct: 100, jitterMs: null, availabilityPct: 0, score: 0 },
  ];
  const points = bucketRouteQualityRows(rows, 300_000);
  assert.equal(points.length, 2);
  assert.equal(points[0].latencyMs, 50);
  assert.equal(points[0].lossPct, 1);
  assert.equal(points[0].availabilityPct, 99);
  assert.equal(points[0].samples, 2);
  assert.equal(points[1].latencyMs, null);
  assert.equal(points[1].lossPct, 100);
  assert.equal(routeQualityBucketMs(6), 60_000);
  assert.equal(routeQualityBucketMs(24), 5 * 60_000);
  assert.equal(routeQualityBucketMs(168), 30 * 60_000);
});

test("七天保留：真的 SQLite 上只删 7 天前的，读回来换算正确", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nex-route-quality-"));
  const databasePath = path.join(directory, "panel.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const repo = await import(url("server/repositories/routePathQualityRepository.ts"));
    const now = Date.now();
    const day = 24 * 3600 * 1000;
    await repo.insertRoutePathQualityStats([
      { ruleId: 9, pathKey: "main", sampledAt: now - 8 * day, latencyMs: 10, lossPct: 0, jitterMs: 1, availabilityPct: 100, score: 99 },
      { ruleId: 9, pathKey: "main", sampledAt: now - 6 * day, latencyMs: 20, lossPct: 1.5, jitterMs: 2, availabilityPct: 98.5, score: 88 },
      { ruleId: 9, pathKey: "backup", sampledAt: now - 60_000, latencyMs: null, lossPct: 100, jitterMs: null, availabilityPct: 0, score: 0 },
      { ruleId: 10, pathKey: "main", sampledAt: now - 9 * day, latencyMs: 30, lossPct: 0, jitterMs: 3, availabilityPct: 100, score: 95 },
    ]);
    const deleted = await repo.cleanOldRoutePathQualityStats();
    assert.equal(deleted, 2);
    const rows = await repo.getRoutePathQualityHistory(9, { sinceMs: now - 30 * day });
    assert.deepEqual(rows.map((row) => row.pathKey), ["main", "backup"]);
    assert.equal(rows[0].lossPct, 1.5);
    assert.equal(rows[0].availabilityPct, 98.5);
    assert.equal(rows[1].latencyMs, null);
    assert.ok(Math.abs(rows[1].sampledAt - (now - 60_000)) < 2000);
    const onlyBackup = await repo.getRoutePathQualityHistory(9, { sinceMs: now - 30 * day, pathKey: "backup" });
    assert.equal(onlyBackup.length, 1);
    await repo.deleteRoutePathQualityStats(9);
    assert.equal((await repo.getRoutePathQualityHistory(9, { sinceMs: 0 })).length, 0);
    console.log("ROUTE_QUALITY_OK");
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_TYPE: "sqlite", SQLITE_PATH: databasePath, FORWARDX_TEST_DB: databasePath },
    encoding: "utf8",
    timeout: 90_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /ROUTE_QUALITY_OK/);
});
