// 心跳对照基准第二步：在 seed.db 上补几条覆盖面更广的规则 / 组设置（只改这份测试库），并记下灌库时刻。
// 用法（在仓库根目录下）：node --import tsx scripts/bench/heartbeat-golden/seed-extra.mjs <seed 目录>
// 整套流程见 capture.mjs 开头。
import path from "node:path";
import { pathToFileURL } from "node:url";

const seedDir = path.resolve(process.argv[2]);
const dbPath = path.join(seedDir, "seed.db");
process.env.NODE_ENV = "development";
process.env.DATABASE_TYPE = "sqlite";
process.env.FORWARDX_PANEL_TIME_SYNC = "false";
process.env.FORWARDX_LOG_DIR = path.join(seedDir, "logs");

const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
const runtime = await import(url("server/dbRuntime.ts"));
const schema = await import(url("server/dbSchema.ts"));
await runtime.connectDatabase({ type: "sqlite", sqlite: { path: dbPath } });
await schema.ensureDatabaseSchema();
const q = (name) => '"' + name + '"';

async function cloneRule(sourceId, patch) {
  const [row] = await runtime.queryRaw(`SELECT * FROM ${q("forward_rules")} WHERE ${q("id")} = ?`, [sourceId]);
  if (!row) throw new Error("no rule " + sourceId);
  const next = { ...row, ...patch };
  delete next.id;
  const columns = Object.keys(next);
  await runtime.executeRaw(
    `INSERT INTO ${q("forward_rules")} (${columns.map(q).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    columns.map((column) => next[column]),
  );
  const [created] = await runtime.queryRaw(`SELECT ${q("id")} FROM ${q("forward_rules")} WHERE ${q("name")} = ? ORDER BY ${q("id")} DESC LIMIT 1`, [patch.name]);
  return Number(created.id);
}

const extra = [
  await cloneRule(53, { name: "Golden auto both realm", protocol: "both", forwardType: "realm", failoverStrategy: "auto", sourcePort: 40001 }),
  await cloneRule(42, { name: "Golden udp gost", protocol: "udp", sourcePort: 40002 }),
  await cloneRule(43, { name: "Golden both socat", protocol: "both", forwardType: "socat", sourcePort: 40003 }),
];
// 「落地怎么分」：一条线路两个落地，主线路「自动」、备用「按访客固定」。
const spreadRuleId = await cloneRule(43, { name: "Golden dest spread", protocol: "tcp", sourcePort: 40004, routeDelivery: "cold" });
{
  const [row] = await runtime.queryRaw(`SELECT ${q("routeLines")} FROM ${q("forward_rules")} WHERE ${q("id")} = ?`, [spreadRuleId]);
  const lines = JSON.parse(row.routeLines || "[]");
  const twoDests = (base) => [
    { dest: { ip: `198.51.100.${base}`, port: 443 }, destNodeId: null },
    { dest: { ip: `198.51.100.${base + 1}`, port: 443 }, destNodeId: null },
  ];
  lines.forEach((line, index) => {
    line.dests = twoDests(21 + index * 10);
    line.destSpread = index === 0 ? "auto" : "ip_hash";
  });
  await runtime.executeRaw(`UPDATE ${q("forward_rules")} SET ${q("routeLines")} = ? WHERE ${q("id")} = ?`, [JSON.stringify(lines), spreadRuleId]);
  const expansion = await import(url("server/routeLineExpansion.ts"));
  await expansion.reexpandRouteLinesForRules([spreadRuleId], "golden");
}
extra.push(spreadRuleId);
const routeGroups = await import(url("server/routeGroups.ts"));
for (const ruleId of extra) {
  const result = await routeGroups.syncRouteRelayRulesForRule(ruleId, { deferRefresh: true, reason: "golden" });
  console.log("synced", ruleId, (result.paths || []).length, "paths");
}
await runtime.executeRaw(`UPDATE ${q("forward_groups")} SET ${q("chinaHealthCheckEnabled")} = 1, ${q("chinaHealthCheckMethod")} = ?, ${q("chinaHealthCheckTarget")} = ? WHERE ${q("id")} = 2`, ["udp", "223.5.5.5:53"]);
await runtime.executeRaw(`UPDATE ${q("forward_groups")} SET ${q("chinaHealthCheckEnabled")} = 1, ${q("chinaHealthCheckMethod")} = ?, ${q("chinaHealthCheckTarget")} = ? WHERE ${q("id")} = 12`, ["ping", "www.189.cn"]);
await runtime.executeRaw(`UPDATE ${q("hosts")} SET ${q("agentVersion")} = ?`, ["2.2.251"]);
await runtime.executeRaw("PRAGMA wal_checkpoint(TRUNCATE)").catch(() => {});
await runtime.closeDatabase();
// 录制时把时钟冻在这个时刻之后：心跳里「多久没心跳」之类的判断每次都一样。
const fs = await import("node:fs");
fs.writeFileSync(path.join(seedDir, "seed-time.json"), JSON.stringify({ seededAt: Date.now() }));
console.log("extra rules", JSON.stringify(extra));
process.exit(0);
