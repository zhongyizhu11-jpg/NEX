// 列出前端源码里的中文字符串，并统计英文词典（client/src/i18n/en.json）覆盖了多少。
//
// 抓三类：JSX 里的文字、普通字符串字面量、模板字符串（`已选 ${n} 条` 记成「已选 {0} 条」，和词典的模板键同一个写法）。
// JSX 元素的子节点只有文字和 {表达式}（没有子元素）时，按运行时 DOM 翻译器的拼法整组记一条：
// <span>共 {total} 条</span> 在页面上是三个相邻文字节点，翻译器会拼成「共 12 条」去套「共 {0} 条」。
//
// 覆盖率用的就是运行时同一套匹配（client/src/i18n/translate.ts + patterns.ts），所以这里算「翻了」的，页面上就会是英文。
// console.* / 抛出的 Error / import 路径里的中文不算界面文字，不统计。
//
// 用法：
//   pnpm i18n:report                     各页面分组的覆盖率
//   pnpm i18n:report -- --missing rules  列出某一组还没翻的（按出现次数排序）
//   pnpm i18n:report -- --missing all --json > out.json
//   pnpm i18n:report -- --dump strings.json   所有字符串（含出处），给补词典的脚本用
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { createTranslator, hasCjk, normalizeSource } from "../client/src/i18n/translate.ts";
import { PATTERNS } from "../client/src/i18n/patterns.ts";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SOURCE_DIRS = ["client/src", "shared"];
const DICTIONARY = path.join(ROOT, "client/src/i18n/en.json");

// 页面分组：按文件路径归到「哪一屏」，第一条命中的算
export const GROUPS = [
  ["navigation", /^client\/src\/(components\/(DashboardLayout|WorkspaceHeader|WorkspaceNavigation|HeaderStatusChips|SystemStatusHeader|PearlHeaderBadges|PearlNavMarker|UiThemeQuickSwitch|LayoutLayer)|App|pages\/(More|NotFound))\b/],
  ["login", /^client\/src\/(pages\/(Login|PublicHome)|features\/(googleLogin|discordLogin|oauthLogin|ops\/account)|lib\/authErrorMessage)\b/],
  ["setup", /^client\/src\/pages\/Setup\b/],
  ["dashboard", /^client\/src\/(pages\/Home|features\/(dashboard|traffic|network|ops\/slots|ops\/events)|components\/network)\b/],
  ["hosts", /^client\/src\/(pages\/(Hosts|HostMonitor)|components\/hosts)\b/],
  ["rules", /^client\/src\/(pages\/(Rules|ForwardGroups)|components\/rules|features\/rules)\b/],
  ["links", /^client\/src\/(pages\/Tunnels|components\/(tunnels|links)|features\/(links|lines))\b/],
  ["settings", /^client\/src\/(pages\/(Settings|EmailSettings|settingsSections)|components\/(settings|PersonalizationLayer|MobileAppSettings))\b/],
  ["common", /^client\/src\/(components\/(ui|EmptyState|ListControls|PersistentPagination|FilterToolbar|QueryErrorState|DataSection|RouteFallback|ErrorBoundary|DatabaseHealthGate|SettingRow|entity)|lib|hooks|contexts|_core|i18n)\b/],
  // shared/ 里被前端 import 到的（界面上会显示）和只给服务端用的分开算
  ["shared-ui", /^shared-ui\//],
  ["shared", /^shared\//],
  ["other", /.*/],
];
export const PRIORITY_GROUPS = ["navigation", "login", "setup", "dashboard", "hosts", "rules", "links", "settings", "common", "shared-ui"];

function* walkFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      yield* walkFiles(full);
    } else if (/\.(tsx?|mjs)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      yield full;
    }
  }
}

let clientSharedFiles = null;

/** 从 client/src 顺着 import 找到的 shared/ 文件：这些文件里的字会出现在界面上 */
function clientVisibleSharedFiles() {
  if (clientSharedFiles) return clientSharedFiles;
  const seen = new Set();
  const queue = [...walkFiles(path.join(ROOT, "client/src"))];
  const resolve = (from, spec) => {
    let base;
    if (spec.startsWith("@shared/")) base = path.join(ROOT, "shared", spec.slice(8));
    else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
    else return null;
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    return null;
  };
  const visited = new Set();
  while (queue.length) {
    const file = queue.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      const target = resolve(file, match[1]);
      if (!target || !/\.(tsx?)$/.test(target)) continue;
      const relative = path.relative(ROOT, target).split(path.sep).join("/");
      if (relative.startsWith("shared/")) {
        seen.add(relative);
        queue.push(target);
      }
    }
  }
  clientSharedFiles = seen;
  return seen;
}

function groupOf(file) {
  if (file.startsWith("shared/") && clientVisibleSharedFiles().has(file)) return "shared-ui";
  for (const [name, re] of GROUPS) if (re.test(file)) return name;
  return "other";
}

/** 这个节点是不是在 console.x(...) / new Error(...) / throw 里：那是给开发者看的 */
function isDiagnostic(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isCallExpression(current)) {
      const callee = current.expression.getText();
      if (/^console\./.test(callee)) return true;
    }
    if (ts.isNewExpression(current) && /Error$/.test(current.expression.getText())) return true;
    if (ts.isThrowStatement(current)) return true;
    if (ts.isImportDeclaration(current) || ts.isExportDeclaration(current)) return true;
    if (ts.isFunctionLike(current) || ts.isSourceFile(current)) break;
  }
  return false;
}

/** JSX 子节点只有文字和非 JSX 表达式？ */
function textOnlyChildren(element) {
  for (const child of element.children) {
    if (ts.isJsxText(child)) continue;
    if (ts.isJsxExpression(child)) {
      if (!child.expression) continue;
      let hasJsx = false;
      const visit = (node) => {
        if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) hasJsx = true;
        else if (!hasJsx && !ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) ts.forEachChild(node, visit);
      };
      visit(child.expression);
      if (hasJsx) return false;
      continue;
    }
    return false;
  }
  return true;
}

// React 对 JSX 文字的空白处理：按行去首尾空白，含换行的空白行丢掉，剩下的行用空格连起来
function jsxTextValue(text) {
  const lines = text.split(/\r?\n/);
  if (lines.length === 1) return text;
  return lines.map((line, index) => {
    let value = line;
    if (index > 0) value = value.replace(/^\s+/, "");
    if (index < lines.length - 1) value = value.replace(/\s+$/, "");
    return value;
  }).filter((value) => value.length > 0).join(" ");
}

export function extractStrings() {
  const strings = new Map(); // key -> { count, files:Set, group }
  const add = (raw, file, line) => {
    const key = normalizeSource(raw);
    if (!key || !hasCjk(key)) return;
    const item = strings.get(key) ?? { key, count: 0, files: new Set(), groups: new Set(), firstAt: `${file}:${line}` };
    item.count += 1;
    item.files.add(file);
    item.groups.add(groupOf(file));
    strings.set(key, item);
  };

  for (const dir of SOURCE_DIRS) {
    for (const full of walkFiles(path.join(ROOT, dir))) {
      const file = path.relative(ROOT, full).split(path.sep).join("/");
      if (file.startsWith("client/src/i18n/")) continue;
      const text = fs.readFileSync(full, "utf8");
      if (!hasCjk(text)) continue;
      const source = ts.createSourceFile(full, text, ts.ScriptTarget.Latest, true, full.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const lineOf = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      const combined = new Set();

      const visit = (node) => {
        if (ts.isJsxElement(node) && textOnlyChildren(node) && node.children.some((child) => ts.isJsxExpression(child) && child.expression)) {
          let index = 0;
          const parts = node.children.map((child) => {
            if (ts.isJsxText(child)) return jsxTextValue(child.text);
            if (!child.expression) return "";
            if (ts.isStringLiteral(child.expression)) return child.expression.text;
            return `{${index++}}`;
          });
          const joined = parts.join("");
          if (hasCjk(joined.replace(/\{\d+\}/g, ""))) {
            add(joined, file, lineOf(node));
            for (const child of node.children) if (ts.isJsxText(child)) combined.add(child);
          }
        }
        if (ts.isJsxText(node)) {
          if (!combined.has(node)) add(jsxTextValue(node.text), file, lineOf(node));
        } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
          if (hasCjk(node.text) && !isDiagnostic(node)) add(node.text, file, lineOf(node));
        } else if (ts.isTemplateExpression(node)) {
          if (!isDiagnostic(node)) {
            let value = node.head.text;
            node.templateSpans.forEach((span, index) => {
              value += `{${index}}${span.literal.text}`;
            });
            if (hasCjk(value.replace(/\{\d+\}/g, ""))) add(value, file, lineOf(node));
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  return strings;
}

export function loadDictionary() {
  return JSON.parse(fs.readFileSync(DICTIONARY, "utf8"));
}

function main() {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? null : args[index + 1] ?? "";
  };
  const strings = extractStrings();
  const dictionary = loadDictionary();
  const translator = createTranslator(dictionary, PATTERNS);
  const translated = (key) => translator.translate(key) != null;

  const dumpPath = flag("--dump");
  if (dumpPath) {
    const rows = [...strings.values()].map((item) => ({
      key: item.key,
      count: item.count,
      groups: [...item.groups],
      files: [...item.files],
      at: item.firstAt,
      translated: translated(item.key),
    }));
    fs.writeFileSync(dumpPath, JSON.stringify(rows, null, 1));
    console.log(`写了 ${rows.length} 条到 ${dumpPath}`);
    return;
  }

  const missing = flag("--missing");
  if (missing != null) {
    const rows = [...strings.values()]
      .filter((item) => !translated(item.key) && (missing === "all" || missing === "" || item.groups.has(missing)))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
    if (args.includes("--json")) console.log(JSON.stringify(rows.map((item) => ({ key: item.key, count: item.count, at: item.firstAt })), null, 1));
    else for (const item of rows) console.log(`${String(item.count).padStart(4)}  ${item.key}    (${item.firstAt})`);
    return;
  }

  const groupStats = new Map(GROUPS.map(([name]) => [name, { total: 0, done: 0, uses: 0, usesDone: 0 }]));
  let total = 0;
  let done = 0;
  let uses = 0;
  let usesDone = 0;
  for (const item of strings.values()) {
    const ok = translated(item.key);
    total += 1;
    uses += item.count;
    if (ok) {
      done += 1;
      usesDone += item.count;
    }
    for (const group of item.groups) {
      const stat = groupStats.get(group);
      stat.total += 1;
      stat.uses += item.count;
      if (ok) {
        stat.done += 1;
        stat.usesDone += item.count;
      }
    }
  }
  const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) : "100.0").padStart(5) + "%";
  const keys = Object.keys(dictionary).length;
  const rows = [...groupStats.entries()].map(([name, stat]) => ({ name, ...stat }));
  if (args.includes("--json")) {
    console.log(JSON.stringify({ dictionaryEntries: keys, total, translated: done, uses, usesTranslated: usesDone, groups: rows }, null, 1));
    return;
  }
  console.log(`词典 ${keys} 条；源码里不重复的中文字符串 ${total} 条，已有英文 ${done} 条（${pct(done, total).trim()}）；`
    + `按出现次数算 ${usesDone}/${uses}（${pct(usesDone, uses).trim()}）`);
  console.log("");
  console.log(`${"分组".padEnd(12)}${"已翻/总数".padStart(14)}${"覆盖".padStart(8)}${"按次数".padStart(10)}`);
  for (const row of rows) {
    if (!row.total) continue;
    const mark = PRIORITY_GROUPS.includes(row.name) ? "*" : " ";
    console.log(`${mark}${row.name.padEnd(11)}${`${row.done}/${row.total}`.padStart(14)}${pct(row.done, row.total).padStart(8)}${pct(row.usesDone, row.uses).padStart(10)}`);
  }
  console.log("\n* = 优先保证的界面（导航、登录、首次部署、总览、主机、规则、链路、设置、通用组件，以及它们用到的 shared/ 文字）");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) main();
