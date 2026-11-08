// 心跳对照基准第一步：灌一份开发面板种子库，所有主机的 Agent 版本设成 2.2.251，存成 <输出目录>/seed.db。
// 用法（在仓库根目录下）：node --import tsx scripts/bench/heartbeat-golden/seed.mjs <输出目录>
// 整套流程见 capture.mjs 开头。
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const outDir = path.resolve(process.argv[2]);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const dbPath = path.join(outDir, "seed.db");
fs.writeFileSync(path.join(outDir, "database.json"), JSON.stringify({ type: "sqlite", sqlite: { path: dbPath } }));
process.env.DATABASE_CONFIG_PATH = path.join(outDir, "database.json");
process.env.FORWARDX_DATA_DIR = outDir;
process.env.FORWARDX_DEV_PANEL = "1";
process.env.NODE_ENV = "development";
process.env.FORWARDX_PANEL_TIME_SYNC = "false";
process.env.FORWARDX_LOG_DIR = path.join(outDir, "logs");
fs.mkdirSync(process.env.FORWARDX_LOG_DIR, { recursive: true });

const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
const db = await import(url("server/db.ts"));
const runtime = await import(url("server/dbRuntime.ts"));
const result = await db.initDatabase();
console.log("init", JSON.stringify(result));
await runtime.executeRaw('UPDATE hosts SET "agentVersion" = ?', ["2.2.251"]);
const hosts = await runtime.queryRaw('SELECT id, name, "agentVersion" FROM hosts ORDER BY id');
console.log("hosts", hosts.length, JSON.stringify(hosts.map((h) => [h.id, h.name])));
await runtime.executeRaw("PRAGMA wal_checkpoint(TRUNCATE)").catch(() => {});
await runtime.closeDatabase();
process.exit(0);
