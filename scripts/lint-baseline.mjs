// pnpm lint 的入口：跑 ESLint，按「规则 → 文件」数警告条数，和 scripts/lint-baseline.json 比。
// - 任何 error 直接失败（比如 react-hooks/rules-of-hooks）；
// - 某个文件某条规则的警告比基线多，失败 —— 说明这次改动在这个文件里新加了问题；
// - 比基线少，提示用 pnpm lint:update 把基线降下来（降了就别再涨回去）。
// 用法：node scripts/lint-baseline.mjs [--update] [要检查的路径，默认整个仓库]
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const baselineFile = path.join(root, "scripts", "lint-baseline.json");
const args = process.argv.slice(2);
const update = args.includes("--update");
const targets = args.filter((arg) => arg !== "--update");
if (update && targets.length) {
  console.error("--update 要对整个仓库跑，不能带路径");
  process.exit(2);
}

const eslintBin = path.join(root, "node_modules", "eslint", "bin", "eslint.js");
const result = spawnSync(process.execPath, [
  "--max-old-space-size=6144",
  eslintBin, "--format", "json", "--no-warn-ignored", ...(targets.length ? targets : ["."]),
], { cwd: root, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });

if (result.error) throw result.error;
let reports;
try {
  reports = JSON.parse(result.stdout);
} catch {
  process.stderr.write(result.stderr || result.stdout || "");
  console.error("ESLint 没有正常输出结果");
  process.exit(2);
}

/** @type {Record<string, Record<string, number>>} */
const counts = {};
/** @type {Record<string, Record<string, string[]>>} */
const locations = {};
const errors = [];
for (const report of reports) {
  const file = path.relative(root, report.filePath).split(path.sep).join("/");
  for (const message of report.messages) {
    const rule = message.ruleId || "(parse)";
    const where = `${file}:${message.line}:${message.column}`;
    if (message.severity === 2 || message.fatal) {
      errors.push(`${where}  ${rule}  ${message.message}`);
      continue;
    }
    counts[rule] ??= {};
    counts[rule][file] = (counts[rule][file] || 0) + 1;
    locations[rule] ??= {};
    (locations[rule][file] ??= []).push(`${where}  ${message.message}`);
  }
}

function sortedBaseline(value) {
  return Object.fromEntries(Object.keys(value).sort().map((rule) => [
    rule,
    Object.fromEntries(Object.keys(value[rule]).sort().map((file) => [file, value[rule][file]])),
  ]));
}

function total(byFile = {}) {
  return Object.values(byFile).reduce((sum, count) => sum + count, 0);
}

if (update) {
  const next = sortedBaseline(counts);
  fs.writeFileSync(baselineFile, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`已更新 ${path.relative(root, baselineFile)}：`);
  for (const rule of Object.keys(next)) console.log(`  ${rule}: ${total(next[rule])}`);
  if (errors.length) {
    console.error(`\n还有 ${errors.length} 个 error，基线不收 error，需要修掉：`);
    for (const line of errors) console.error(`  ${line}`);
    process.exit(1);
  }
  process.exit(0);
}

const baseline = fs.existsSync(baselineFile) ? JSON.parse(fs.readFileSync(baselineFile, "utf8")) : {};
let failed = false;
if (errors.length) {
  failed = true;
  console.error(`${errors.length} 个 error：`);
  for (const line of errors) console.error(`  ${line}`);
}

const checkedFiles = new Set(reports.map((report) => path.relative(root, report.filePath).split(path.sep).join("/")));
let lowered = 0;
for (const rule of [...new Set([...Object.keys(baseline), ...Object.keys(counts)])].sort()) {
  const now = counts[rule] || {};
  const allowed = baseline[rule] || {};
  for (const file of [...new Set([...Object.keys(now), ...Object.keys(allowed)])].sort()) {
    if (!checkedFiles.has(file) && !(file in now)) continue;
    const current = now[file] || 0;
    const limit = allowed[file] || 0;
    if (current > limit) {
      failed = true;
      console.error(`${file}  ${rule}: ${current} 条，基线 ${limit}`);
      for (const line of locations[rule]?.[file] || []) console.error(`    ${line}`);
    } else if (current < limit) {
      lowered += limit - current;
    }
  }
}

if (failed) {
  console.error("\n修掉新加的问题；确实要接受的话跑 pnpm lint:update 更新基线，并在 PR 里说明。");
  process.exit(1);
}
if (lowered > 0) console.log(`比基线少了 ${lowered} 条警告，可以跑 pnpm lint:update 把基线降下来。`);
console.log("lint 通过：没有 error，警告没有超过基线。");
