#!/usr/bin/env node
/*
  把 server/ 平铺目录里的一组文件搬进 server/<domain>/，并重写全仓库 TS 文件里的相对导入。
  用法：node move-server-domain.mjs <domain> <file-glob-regex> [--apply]
  例：node move-server-domain.mjs telegram '^telegram' --apply
  只处理 server/ 顶层的 .ts 文件（含 .test.ts / .fixture.ts）；导入重写覆盖 server/、shared/、client/src、scripts/、e2e/、drizzle/。
*/
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(new URL("../package.json", import.meta.url));
const ts = require("typescript");
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const [, , domain, pattern, ...rest] = process.argv;
const apply = rest.includes("--apply");
if (!domain || !pattern) { console.error("usage: move-server-domain.mjs <domain> <regex> [--apply]"); process.exit(2); }
const re = new RegExp(pattern);

const serverDir = path.join(root, "server");
const moving = fs.readdirSync(serverDir).filter((f) => f.endsWith(".ts") && re.test(f) && fs.statSync(path.join(serverDir, f)).isFile());
if (moving.length === 0) { console.error("没有匹配的文件"); process.exit(1); }
const movedMap = new Map(); // old abs path (no ext) -> new abs path (no ext)
for (const f of moving) {
  const base = f.replace(/\.ts$/, "");
  movedMap.set(path.join(serverDir, base), path.join(serverDir, domain, base));
}
console.log(`搬 ${moving.length} 个文件到 server/${domain}/：`, moving.join(", "));

// 收集全仓库 TS 文件
function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts)$/.test(entry.name)) out.push(full);
  }
}
const files = [];
for (const d of ["server", "shared", "client/src", "scripts", "e2e", "drizzle", "docs/.vitepress"]) {
  const full = path.join(root, d);
  if (fs.existsSync(full)) walk(full, files);
}

function resolveSpecifier(fromFile, spec) {
  // 只处理相对路径
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  // 去掉可能的扩展名
  const noExt = base.replace(/\.(ts|tsx|js|mjs)$/, "");
  return noExt;
}

function toSpecifier(fromDir, targetNoExt, original) {
  let rel = path.relative(fromDir, targetNoExt).replace(/\\/g, "/");
  if (!rel.startsWith(".")) rel = "./" + rel;
  // 保留原来是否带扩展名的写法
  const ext = original.match(/\.(ts|tsx|js|mjs)$/)?.[0] ?? "";
  return rel + ext;
}

let rewrites = 0;
const plans = []; // {file, newText, newPath}
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const fileNoExt = file.replace(/\.(ts|tsx|mts)$/, "");
  const newFileNoExt = movedMap.get(fileNoExt) ?? fileNoExt;
  const newDir = path.dirname(newFileNoExt);
  const edits = [];
  const visit = (node) => {
    let specNode = null;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specNode = node.moduleSpecifier;
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) specNode = node.arguments[0];
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) specNode = node.argument.literal;
    if (specNode) {
      const spec = specNode.text;
      const target = resolveSpecifier(file, spec);
      if (target) {
        const newTarget = movedMap.get(target) ?? target;
        if (newTarget !== target || newDir !== path.dirname(fileNoExt)) {
          // 目标搬了，或者自己搬了（相对路径要重算）
          const newSpec = toSpecifier(newDir, newTarget, spec);
          if (newSpec !== spec) edits.push([specNode.getStart(sf) + 1, specNode.end - 1, newSpec]);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (edits.length === 0 && newFileNoExt === fileNoExt) continue;
  let out = text;
  for (const [s, e, r] of edits.sort((a, b) => b[0] - a[0])) out = out.slice(0, s) + r + out.slice(e);
  rewrites += edits.length;
  const ext = file.match(/\.(ts|tsx|mts)$/)[0];
  plans.push({ file, newText: out, newPath: newFileNoExt + ext });
}
console.log(`改写 ${rewrites} 处导入，涉及 ${plans.length} 个文件（含搬走的 ${moving.length} 个）。`);
if (!apply) process.exit(0);

fs.mkdirSync(path.join(serverDir, domain), { recursive: true });
for (const plan of plans) {
  if (plan.newPath !== plan.file) {
    fs.writeFileSync(plan.newPath, plan.newText);
    fs.unlinkSync(plan.file);
  } else {
    fs.writeFileSync(plan.file, plan.newText);
  }
}
// package.json 里 test:server / pretest:server 的显式路径
const pkgPath = path.join(root, "package.json");
let pkg = fs.readFileSync(pkgPath, "utf8");
for (const f of moving) {
  pkg = pkg.split(`server/${f}`).join(`server/${domain}/${f}`);
}
fs.writeFileSync(pkgPath, pkg);
console.log("已应用；请跑 tsc 和测试。");
