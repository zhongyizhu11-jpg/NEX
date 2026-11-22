#!/usr/bin/env node
/*
  把一个页面文件里的顶层组件（function X 或 const X = memo(...)）抽成单独的懒加载模块。
  用法：node extract-component.mjs <源文件> <组件名> <目标文件> [--apply] [--pages-alias @/pages/Rules]
  不带 --apply 只打印依赖分析。
*/
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(new URL("../package.json", import.meta.url));
const ts = require("typescript");

const [, , sourceArg, targetName, destArg, ...rest] = process.argv;
const apply = rest.includes("--apply");
const aliasIdx = rest.indexOf("--pages-alias");
const sourceAlias = aliasIdx >= 0 ? rest[aliasIdx + 1] : null;
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const sourcePath = path.resolve(root, sourceArg);
const destPath = path.resolve(root, destArg);
const text = fs.readFileSync(sourcePath, "utf8");
const sf = ts.createSourceFile(sourcePath, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);

// ---- 顶层声明表
const decls = new Map(); // name -> { node, kind }
const imports = []; // ImportDeclaration nodes
for (const stmt of sf.statements) {
  if (ts.isImportDeclaration(stmt)) { imports.push(stmt); continue; }
  if (ts.isFunctionDeclaration(stmt) && stmt.name) decls.set(stmt.name.text, { node: stmt, kind: "function" });
  else if (ts.isVariableStatement(stmt)) {
    for (const d of stmt.declarationList.declarations) {
      if (ts.isIdentifier(d.name)) decls.set(d.name.text, { node: stmt, kind: "var" });
      else if (ts.isObjectBindingPattern(d.name) || ts.isArrayBindingPattern(d.name)) {
        for (const el of d.name.elements) if (el.name && ts.isIdentifier(el.name)) decls.set(el.name.text, { node: stmt, kind: "var" });
      }
    }
  } else if (ts.isTypeAliasDeclaration(stmt) || ts.isInterfaceDeclaration(stmt) || ts.isEnumDeclaration(stmt) || ts.isClassDeclaration(stmt)) {
    if (stmt.name) decls.set(stmt.name.text, { node: stmt, kind: "type" });
  }
}
if (!decls.has(targetName)) { console.error(`没有找到顶层声明 ${targetName}`); process.exit(1); }

// 每个导入绑定名 -> import 语句
const importBindings = new Map();
for (const imp of imports) {
  const clause = imp.importClause; if (!clause) continue;
  if (clause.name) importBindings.set(clause.name.text, imp);
  const nb = clause.namedBindings;
  if (nb) {
    if (ts.isNamespaceImport(nb)) importBindings.set(nb.name.text, imp);
    else for (const el of nb.elements) importBindings.set(el.name.text, imp);
  }
}

function identifiersIn(node) {
  const names = new Set();
  const walk = (n) => {
    if (ts.isIdentifier(n)) names.add(n.text);
    else if (ts.isJsxText(n)) return;
    ts.forEachChild(n, walk);
  };
  walk(node);
  return names;
}

// 一个声明引用了哪些别的顶层声明（去掉自己）
function deps(name) {
  const node = decls.get(name).node;
  const ids = identifiersIn(node);
  ids.delete(name);
  return [...ids].filter((id) => decls.has(id));
}

// 闭包
const closure = new Set([targetName]);
const queue = [targetName];
while (queue.length) {
  const n = queue.shift();
  for (const d of deps(n)) if (!closure.has(d)) { closure.add(d); queue.push(d); }
}
closure.delete(targetName);

// 其余代码（不在闭包、不是目标）对每个闭包成员的引用
const others = [...decls.keys()].filter((n) => n !== targetName && !closure.has(n));
const usedElsewhere = new Set();
for (const o of others) for (const d of deps(o)) if (closure.has(d)) usedElsewhere.add(d);
// 还要看闭包外的顶层语句（比如 export default 的表达式）——简单起见把整个文件去掉闭包和目标的文本再搜一次
const nodesToRemove = new Set([decls.get(targetName).node, ...[...closure].filter((d) => !usedElsewhere.has(d)).map((d) => decls.get(d).node)]);

const move = [...closure].filter((d) => !usedElsewhere.has(d));
const shared = [...closure].filter((d) => usedElsewhere.has(d));
console.log(`目标 ${targetName}：${text.slice(decls.get(targetName).node.pos, decls.get(targetName).node.end).split("\n").length} 行`);
console.log(`随行搬走（只有它用）：${move.length ? move.join(", ") : "无"}`);
console.log(`留在源文件并导出（别处也用）：${shared.length ? shared.join(", ") : "无"}`);

if (!apply) process.exit(0);
if (shared.length && !sourceAlias) { console.error("有共享依赖，需要 --pages-alias 指定源模块的导入路径"); process.exit(1); }

// ---- 生成新文件
const movedText = [...nodesToRemove].sort((a, b) => a.pos - b.pos).map((n) => text.slice(n.getFullStart(), n.end)).join("\n");
const newIds = identifiersIn(ts.createSourceFile("x.tsx", movedText, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX));
const importLines = [];
for (const imp of imports) {
  const clause = imp.importClause; if (!clause) continue;
  const spec = imp.moduleSpecifier.text;
  const typeOnly = clause.isTypeOnly;
  const parts = [];
  let def = null;
  if (clause.name && newIds.has(clause.name.text)) def = clause.name.text;
  const nb = clause.namedBindings;
  let ns = null;
  if (nb && ts.isNamespaceImport(nb) && newIds.has(nb.name.text)) ns = nb.name.text;
  if (nb && ts.isNamedImports(nb)) {
    for (const el of nb.elements) if (newIds.has(el.name.text)) parts.push(`${el.isTypeOnly ? "type " : ""}${el.propertyName ? el.propertyName.text + " as " : ""}${el.name.text}`);
  }
  if (!def && !ns && parts.length === 0) continue;
  let line = `import ${typeOnly ? "type " : ""}`;
  const segs = [];
  if (def) segs.push(def);
  if (ns) segs.push(`* as ${ns}`);
  if (parts.length) segs.push(`{ ${parts.join(", ")} }`);
  line += segs.join(", ") + ` from "${spec}";`;
  importLines.push(line);
}
if (shared.length) importLines.push(`import { ${shared.join(", ")} } from "${sourceAlias}";`);
// 把目标改成 export default
let newBody = movedText.replace(new RegExp(`(^|\\n)(export )?function ${targetName}\\(`), `$1export default function ${targetName}(`);
if (!newBody.includes(`export default function ${targetName}(`)) {
  newBody = newBody.replace(new RegExp(`(^|\\n)(export )?const ${targetName} = `), `$1const ${targetName} = `) + `\n\nexport default ${targetName};\n`;
}
const header = `/* 从 ${path.relative(root, sourcePath)} 抽出来的懒加载模块（见该文件里的 lazy(() => import(...))）。 */\n`;
fs.mkdirSync(path.dirname(destPath), { recursive: true });
fs.writeFileSync(destPath, header + importLines.join("\n") + "\n\n" + newBody.trimStart() + "\n");

// ---- 改源文件：删掉搬走的声明、导出共享的、加 lazy
let out = text;
const ranges = [...nodesToRemove].map((n) => [n.getFullStart(), n.end]).sort((a, b) => b[0] - a[0]);
for (const [s, e] of ranges) out = out.slice(0, s) + out.slice(e);
for (const name of shared) {
  const node = decls.get(name).node;
  const start = node.getStart(sf);
  const snippet = text.slice(start, start + 7);
  if (!snippet.startsWith("export")) {
    // 在原文位置找到这段声明的开头，加 export
    const declText = text.slice(start, node.end);
    const idx = out.indexOf(declText);
    if (idx >= 0) out = out.slice(0, idx) + "export " + out.slice(idx);
  }
}
const relImport = "@/" + path.relative(path.join(root, "client/src"), destPath).replace(/\\/g, "/").replace(/\.tsx?$/, "");
// 懒加载声明放在最后一条 import 之后
const lastImport = imports[imports.length - 1];
const lastImportEnd = lastImport.end;
const lazyDecl = `\nconst ${targetName} = lazy(() => import("${relImport}"));`;
// 位置按新文本：找到最后一条 import 的文本
const lastImportText = text.slice(lastImport.getStart(sf), lastImport.end);
const li = out.indexOf(lastImportText);
out = out.slice(0, li + lastImportText.length) + lazyDecl + out.slice(li + lastImportText.length);
// 源文件里不再用到的导入：删掉绑定
const outSf = ts.createSourceFile("y.tsx", out, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
const outIds = new Set();
for (const stmt of outSf.statements) if (!ts.isImportDeclaration(stmt)) for (const id of identifiersIn(stmt)) outIds.add(id);
let pruned = out;
const edits = [];
for (const stmt of outSf.statements) {
  if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue;
  const clause = stmt.importClause;
  const keepDef = clause.name && outIds.has(clause.name.text) ? clause.name.text : null;
  const nb = clause.namedBindings;
  const keepNs = nb && ts.isNamespaceImport(nb) && outIds.has(nb.name.text) ? nb.name.text : null;
  const keepNamed = nb && ts.isNamedImports(nb) ? nb.elements.filter((el) => outIds.has(el.name.text)) : [];
  const total = (clause.name ? 1 : 0) + (nb && ts.isNamespaceImport(nb) ? 1 : 0) + (nb && ts.isNamedImports(nb) ? nb.elements.length : 0);
  const kept = (keepDef ? 1 : 0) + (keepNs ? 1 : 0) + keepNamed.length;
  if (kept === total) continue;
  let replacement = "";
  if (kept > 0) {
    const segs = [];
    if (keepDef) segs.push(keepDef);
    if (keepNs) segs.push(`* as ${keepNs}`);
    if (keepNamed.length) segs.push(`{ ${keepNamed.map((el) => `${el.isTypeOnly ? "type " : ""}${el.propertyName ? el.propertyName.text + " as " : ""}${el.name.text}`).join(", ")} }`);
    replacement = `import ${clause.isTypeOnly ? "type " : ""}${segs.join(", ")} from "${stmt.moduleSpecifier.text}";`;
  }
  edits.push([stmt.getStart(outSf), stmt.end, replacement]);
}
for (const [s, e, r] of edits.sort((a, b) => b[0] - a[0])) pruned = pruned.slice(0, s) + r + pruned.slice(e);
pruned = pruned.replace(/\n{3,}/g, "\n\n");
// 确保 react 导入里有 lazy（和 Suspense 由人补）
if (!/import\s*\{[^}]*\blazy\b[^}]*\}\s*from\s*"react"/.test(pruned)) {
  pruned = pruned.replace(/import\s*\{([^}]*)\}\s*from\s*"react";/, (m, inner) => `import {${inner.trimEnd()}, lazy } from "react";`);
}
fs.writeFileSync(sourcePath, pruned);
console.log(`已写 ${path.relative(root, destPath)}，源文件已更新；请补 <Suspense> 包裹并跑 tsc。`);
