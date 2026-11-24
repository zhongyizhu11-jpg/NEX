#!/usr/bin/env node
/*
  把一个函数体里连续的一段语句抽成单独模块里的函数（行为不变），给 server/agentHeartbeatRoute.ts 这种
  几千行的处理器和 client/src/pages/Rules.tsx 这种几千行的组件做渐进拆分用。

  用法：
    node scripts/extract-block.mjs <源文件> <起始行> <结束行> <新函数名> <新模块路径> [--apply] [--hook]
  例：
    node scripts/extract-block.mjs server/agentHeartbeatRoute.ts 1040 1106 buildMimicRuntimeSyncCmds server/heartbeat/mimicSync.ts --apply

  做什么：
  - 用 TypeScript 程序（带类型检查器，按根目录 tsconfig.json）分析这段语句：
    · 用到的、但在这段之外声明的局部变量 / 参数 → 作为一个 ctx 对象参数传进去，类型从检查器拿；
    · 这段里声明的、后面还在用的变量 → 作为返回值返回，调用处解构；
    · 这段里给外面变量赋值的 → 也返回并在调用处写回；
    · 这段里有直接 return（不在内层函数里）→ 返回 { done: true, value }，调用处 `if (r.done) return r.value`；
    · 有 await → async 函数；
    · 用到的模块级 import / 本文件顶层声明 → 新模块里补 import（本文件顶层的没 export 的会给它加 export）。
  - 不带 --apply 只打印分析结果（会传什么、返回什么、类型长什么样）。
  - --hook：抽成 React 自定义 hook（函数名以 use 开头、不加 async 判断、调用处直接调用）。
  抽完要手动跑：pnpm exec tsc --noEmit；相关测试；pnpm lint。类型长到离谱或打成 any 的地方要手动收拾。
*/
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

const [, , fileArg, startArg, endArg, fnName, newModuleArg, ...rest] = process.argv;
if (!fileArg || !startArg || !endArg || !fnName || !newModuleArg) {
  console.error("usage: extract-block.mjs <file> <startLine> <endLine> <fnName> <newModule> [--apply] [--hook]");
  process.exit(2);
}
const apply = rest.includes("--apply");
const asHook = rest.includes("--hook");
const filePath = path.resolve(root, fileArg);
const newModulePath = path.resolve(root, newModuleArg);
const startLine = Number(startArg), endLine = Number(endArg);

// ---- 程序与检查器
const configPath = path.join(root, "tsconfig.json");
const cfg = ts.readConfigFile(configPath, ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, root);
const program = ts.createProgram({ rootNames: parsed.fileNames.includes(filePath) ? parsed.fileNames : [...parsed.fileNames, filePath], options: parsed.options });
const checker = program.getTypeChecker();
const sf = program.getSourceFile(filePath);
if (!sf) { console.error("源文件不在程序里：" + filePath); process.exit(1); }
const text = sf.getFullText();
const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;

// ---- 找到起止行覆盖的、同一个 block 里的连续语句
let found = null;
function visitBlocks(node) {
  const statements = ts.isBlock(node) || ts.isSourceFile(node) || ts.isModuleBlock(node) || ts.isCaseClause(node) || ts.isDefaultClause(node) ? node.statements : null;
  if (statements) {
    const picked = statements.filter((st) => lineOf(st.getStart(sf)) >= startLine && lineOf(st.end) <= endLine);
    if (picked.length && lineOf(picked[0].getStart(sf)) === startLine && lineOf(picked[picked.length - 1].end) === endLine) {
      found = { container: node, statements: picked };
      return;
    }
  }
  ts.forEachChild(node, visitBlocks);
}
visitBlocks(sf);
if (!found) { console.error(`第 ${startLine}-${endLine} 行不是同一个块里完整的若干条语句（起止行要正好是语句的首尾行）`); process.exit(1); }
const { container, statements } = found;
const rangeStart = statements[0].getFullStart(), rangeEnd = statements[statements.length - 1].end;
const inRange = (node) => node.getStart(sf) >= statements[0].getStart(sf) && node.end <= rangeEnd;

// 包含这段的函数（抽出去的 ctx 只收函数内的局部量；模块级的走 import）
let enclosingFn = container;
while (enclosingFn && !ts.isFunctionLike(enclosingFn) && !ts.isSourceFile(enclosingFn)) enclosingFn = enclosingFn.parent;

// ---- 分析标识符
const isDeclName = (id) => { const p = id.parent; return (ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p) || ts.isBindingElement(p) || ts.isClassDeclaration(p) || ts.isTypeAliasDeclaration(p) || ts.isInterfaceDeclaration(p) || ts.isEnumDeclaration(p) || ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p)) && p.name === id; };
// 标识符对应的符号：{ foo } 这种简写属性要用 getShorthandAssignmentValueSymbol，否则拿到的是属性而不是变量
const symbolOfIdentifier = (id) => (ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id)
  ? checker.getShorthandAssignmentValueSymbol(id.parent)
  : checker.getSymbolAtLocation(id);
const isPropertyName = (id) => { const p = id.parent; return (ts.isPropertyAccessExpression(p) && p.name === id) || (ts.isPropertyAssignment(p) && p.name === id && !ts.isShorthandPropertyAssignment(p)) || (ts.isPropertySignature(p) && p.name === id) || (ts.isMethodDeclaration(p) && p.name === id) || (ts.isPropertyDeclaration(p) && p.name === id) || (ts.isEnumMember(p) && p.name === id) || (ts.isBindingElement(p) && p.propertyName === id) || ts.isJsxAttribute(p) || (ts.isQualifiedName(p) && p.right === id); };
function declNodeOf(symbol) { const decls = symbol?.declarations || []; return decls[0] || null; }
function declaredInsideEnclosingFn(decl) { let n = decl; while (n) { if (n === enclosingFn) return true; if (ts.isSourceFile(n)) return false; n = n.parent; } return false; }

const inputs = new Map();   // name -> {decl, type, mutatedInside}
const outputs = new Map();  // name -> {decl, type}  在段内声明、段后使用
const mutatedOuter = new Set();
const moduleRefs = new Map(); // name -> decl（模块级：import 或顶层声明）
let hasAwait = false, hasTopLevelReturn = false, returnsValue = false, hasYieldOrThis = false;
const rangeIdentifiers = [];

function walkRange(node, fnDepth) {
  if (ts.isAwaitExpression(node) && fnDepth === 0) hasAwait = true;
  if (ts.isReturnStatement(node) && fnDepth === 0) { hasTopLevelReturn = true; if (node.expression) returnsValue = true; }
  if ((node.kind === ts.SyntaxKind.ThisKeyword || ts.isYieldExpression(node)) && fnDepth === 0) hasYieldOrThis = true;
  if (ts.isIdentifier(node) && !isPropertyName(node) && !isDeclName(node)) rangeIdentifiers.push(node);
  const nextDepth = ts.isFunctionLike(node) && !ts.isArrowFunction(node) ? fnDepth + 1 : ts.isArrowFunction(node) ? fnDepth + 1 : fnDepth;
  ts.forEachChild(node, (child) => walkRange(child, nextDepth));
}
for (const st of statements) walkRange(st, 0);

for (const id of rangeIdentifiers) {
  const symbol = symbolOfIdentifier(id);
  const decl = declNodeOf(symbol);
  if (!decl) continue;
  if (inRange(decl)) continue; // 段内声明的
  if (declaredInsideEnclosingFn(decl)) {
    const name = id.text;
    const entry = inputs.get(name) || { decl, mutatedInside: false };
    const p = id.parent;
    if ((ts.isBinaryExpression(p) && p.left === id && [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.AsteriskEqualsToken].includes(p.operatorToken.kind)) || ((ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) && (p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken))) { entry.mutatedInside = true; mutatedOuter.add(name); }
    inputs.set(name, entry);
  } else {
    // 模块级（本文件顶层或 import）
    let top = decl; while (top.parent && !ts.isSourceFile(top.parent)) top = top.parent;
    if (top.getSourceFile() === sf) moduleRefs.set(id.text, { decl, top });
  }
}
// 段内声明、段后还用的
const declaredInRange = new Map();
for (const st of statements) {
  const collect = (node, depth) => {
    if (depth === 0 && ts.isVariableStatement(node)) for (const d of node.declarationList.declarations) { const names = []; const grab = (n) => { if (ts.isIdentifier(n)) names.push(n); else if (ts.isObjectBindingPattern(n) || ts.isArrayBindingPattern(n)) for (const el of n.elements) if (ts.isBindingElement(el)) grab(el.name); }; grab(d.name); for (const n of names) declaredInRange.set(n.text, n); }
    if (depth === 0 && ts.isFunctionDeclaration(node) && node.name) declaredInRange.set(node.name.text, node.name);
    if (depth === 0 && (ts.isBlock(node) || ts.isIfStatement(node) || ts.isTryStatement(node))) { /* 块内声明不会被段后看到（块级作用域），跳过 */ }
  };
  collect(st, 0);
}
const afterRange = (node) => node.getStart(sf) >= rangeEnd;
function walkAfter(node) {
  if (ts.isIdentifier(node) && afterRange(node) && !isPropertyName(node) && !isDeclName(node) && declaredInRange.has(node.text)) {
    const symbol = symbolOfIdentifier(node); const decl = declNodeOf(symbol);
    if (decl && inRange(decl)) outputs.set(node.text, { decl });
  }
  ts.forEachChild(node, walkAfter);
}
walkAfter(enclosingFn);

// 段里直接 return 的表达式类型（并成 union），给 { done: true, value } 用
const returnValueTypes = new Set();
{
  const visit = (node, depth) => {
    if (ts.isReturnStatement(node) && depth === 0) returnValueTypes.add(node.expression ? checker.typeToString(checker.getTypeAtLocation(node.expression), enclosingFn, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope) : "undefined");
    const nextDepth = ts.isFunctionLike(node) ? depth + 1 : depth;
    ts.forEachChild(node, (c) => visit(c, nextDepth));
  };
  for (const st of statements) visit(st, 0);
}
const returnValueType = returnValueTypes.size ? [...returnValueTypes].join(" | ") : "unknown";
const typeOf = (decl) => {
  const node = ts.isVariableDeclaration(decl) || ts.isParameter(decl) || ts.isBindingElement(decl) ? decl.name : decl;
  const type = checker.getTypeAtLocation(node);
  let str = checker.typeToString(type, enclosingFn, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope | ts.TypeFormatFlags.WriteArrayAsGenericType);
  if (/\bimport\(/.test(str) || str.length > 400) str = "any /* 类型太长或引用了别的模块，手动收拾 */";
  return str;
};
// let 变量在段内被赋值但段前已声明 → 必须回写
const inputRows = [...inputs.entries()].map(([name, e]) => ({ name, type: typeOf(e.decl), mutated: e.mutatedInside }));
const outputRows = [...outputs.entries()].map(([name, e]) => ({ name, type: typeOf(e.decl) }));
const writeBack = inputRows.filter((r) => r.mutated).map((r) => r.name);

console.log(`段：${path.relative(root, filePath)} ${startLine}-${endLine}（${statements.length} 条语句，${endLine - startLine + 1} 行）`);
console.log(`await: ${hasAwait}  直接 return: ${hasTopLevelReturn}${returnsValue ? "（带值）" : ""}  this/yield: ${hasYieldOrThis}`);
console.log(`输入 ${inputRows.length} 个：`); for (const r of inputRows) console.log(`  ${r.mutated ? "*" : " "} ${r.name}: ${r.type}`);
console.log(`输出 ${outputRows.length} 个：`); for (const r of outputRows) console.log(`    ${r.name}: ${r.type}`);
if (writeBack.length) console.log(`回写（段内改了外面的变量）：${writeBack.join(", ")}`);
console.log(`用到的模块级名字 ${moduleRefs.size} 个：${[...moduleRefs.keys()].join(", ")}`);
if (hasYieldOrThis) { console.error("段里用了 this / yield，不能机械抽取"); process.exit(1); }
if (!apply) process.exit(0);

// ---- 生成新模块
const resultFields = [...outputRows.map((r) => r.name), ...writeBack.filter((n) => !outputs.has(n))];
const ctxTypeName = `${fnName[0].toUpperCase()}${fnName.slice(1)}Context`;
const resultTypeName = `${fnName[0].toUpperCase()}${fnName.slice(1)}Result`;
const bodyText = text.slice(statements[0].getStart(sf), rangeEnd);
// 段里直接 return X → 改成 return { done: true, value: X }
let newBody = bodyText;
if (hasTopLevelReturn) {
  const edits = [];
  const visit = (node, depth) => {
    if (ts.isReturnStatement(node) && depth === 0) edits.push([node.getStart(sf), node.end, node.expression ? `return { done: true as const, value: ${node.expression.getText(sf)} };` : `return { done: true as const, value: undefined };`]);
    const nextDepth = ts.isFunctionLike(node) ? depth + 1 : depth;
    ts.forEachChild(node, (c) => visit(c, nextDepth));
  };
  for (const st of statements) visit(st, 0);
  edits.sort((a, b) => b[0] - a[0]);
  const base = statements[0].getStart(sf);
  for (const [s, e, r] of edits) newBody = newBody.slice(0, s - base) + r + newBody.slice(e - base);
}
// 去掉公共缩进：按第一条语句所在行的前导空白算（bodyText 从语句开头切，第一行本身没有缩进）
const firstLineStart = text.lastIndexOf("\n", statements[0].getStart(sf)) + 1;
const indent = text.slice(firstLineStart, statements[0].getStart(sf)).match(/^[ \t]*/)[0];
const dedent = (s) => s.split("\n").map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l)).join("\n");
const resultLiteral = hasTopLevelReturn
  ? (resultFields.length ? `{ done: false as const, ${resultFields.join(", ")} }` : `{ done: false as const }`)
  : `{ ${resultFields.join(", ")} }`;
const fnKeyword = hasAwait && !asHook ? "export async function" : "export function";
const ctxParam = inputRows.length ? `ctx: ${ctxTypeName}` : "";
const constInputs = inputRows.filter((r) => !r.mutated).map((r) => r.name);
const letInputs = inputRows.filter((r) => r.mutated).map((r) => r.name);
const destructure = `${constInputs.length ? `  const { ${constInputs.join(", ")} } = ctx;\n` : ""}${letInputs.length ? `  let { ${letInputs.join(", ")} } = ctx;\n` : ""}`;
// 本文件顶层声明：新模块要 import，没 export 的给加上
const importLines = [];
const needExportInSource = [];
const byModule = new Map();
for (const [name, ref] of moduleRefs) {
  const top = ref.top;
  if (ts.isImportDeclaration(top)) {
    const mod = top.moduleSpecifier.text;
    const cl = top.importClause; const typeOnly = cl?.isTypeOnly || false;
    let spec = name; let kind = "named";
    if (cl?.name && cl.name.text === name) kind = "default";
    else if (cl?.namedBindings && ts.isNamespaceImport(cl.namedBindings)) kind = "ns";
    else if (cl?.namedBindings) { const el = cl.namedBindings.elements.find((e) => e.name.text === name); if (el?.propertyName) spec = `${el.propertyName.text} as ${name}`; if (el?.isTypeOnly) kind = "typeNamed"; }
    const resolvedMod = mod.startsWith(".") ? path.relative(path.dirname(newModulePath), path.resolve(path.dirname(filePath), mod)).replace(/\\/g, "/") : mod;
    const finalMod = mod.startsWith(".") ? (resolvedMod.startsWith(".") ? resolvedMod : "./" + resolvedMod) : mod;
    const key = `${finalMod}|${typeOnly}`;
    const g = byModule.get(key) || { mod: finalMod, typeOnly, default: null, ns: null, named: [] };
    if (kind === "default") g.default = name; else if (kind === "ns") g.ns = name; else g.named.push(kind === "typeNamed" ? `type ${spec}` : spec);
    byModule.set(key, g);
  } else {
    const exported = ts.canHaveModifiers(top) && (ts.getModifiers(top) || []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) needExportInSource.push(top);
    const rel = path.relative(path.dirname(newModulePath), filePath.replace(/\.tsx?$/, "")).replace(/\\/g, "/");
    const key = `${rel.startsWith(".") ? rel : "./" + rel}|src`;
    const g = byModule.get(key) || { mod: rel.startsWith(".") ? rel : "./" + rel, typeOnly: false, default: null, ns: null, named: [] };
    const isType = ts.isTypeAliasDeclaration(top) || ts.isInterfaceDeclaration(top);
    g.named.push(isType ? `type ${name}` : name);
    byModule.set(key, g);
  }
}
for (const g of [...byModule.values()].sort((a, b) => a.mod.localeCompare(b.mod))) {
  const parts = []; if (g.default) parts.push(g.default); if (g.ns) parts.push(`* as ${g.ns}`); if (g.named.length) parts.push(`{ ${[...new Set(g.named)].sort().join(", ")} }`);
  importLines.push(`import ${g.typeOnly ? "type " : ""}${parts.join(", ")} from "${g.mod}";`);
}
const externalTypeImports = [];
// 类型字符串里引用到的名字：是本文件顶层声明（type / interface / enum / class / import）的也要进新模块
{
  const topNames = new Map();
  for (const st of sf.statements) {
    if ((ts.isTypeAliasDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isEnumDeclaration(st) || ts.isClassDeclaration(st)) && st.name) topNames.set(st.name.text, { decl: st, top: st });
    if (ts.isImportDeclaration(st) && st.importClause) {
      const cl = st.importClause;
      if (cl.name) topNames.set(cl.name.text, { decl: cl, top: st });
      if (cl.namedBindings && ts.isNamespaceImport(cl.namedBindings)) topNames.set(cl.namedBindings.name.text, { decl: cl.namedBindings, top: st });
      if (cl.namedBindings && ts.isNamedImports(cl.namedBindings)) for (const el of cl.namedBindings.elements) topNames.set(el.name.text, { decl: el, top: st });
    }
  }
  const typeTexts = [...inputRows.map((r) => r.type), ...outputRows.map((r) => r.type), returnValueType];
  const probe = ts.createSourceFile("probe.ts", typeTexts.map((t, i) => `type T${i} = ${t};`).join("\n"), ts.ScriptTarget.ESNext, true);
  const seen = new Set(); const namesByRow = typeTexts.map(() => new Set());
  // 属性名、函数类型里的参数名、方法名都不是类型引用，跳过
  const isTypeRef = (n) => ts.isIdentifier(n) && !(ts.isTypeAliasDeclaration(n.parent) && n.parent.name === n) && !(ts.isQualifiedName(n.parent) && n.parent.right === n) && !((ts.isPropertySignature(n.parent) || ts.isMethodSignature(n.parent) || ts.isParameter(n.parent) || ts.isBindingElement(n.parent)) && n.parent.name === n);
  for (const st of probe.statements) { const idx = Number(st.name.text.slice(1)); const visit = (n) => { if (isTypeRef(n)) { seen.add(n.text); namesByRow[idx].add(n.text); } ts.forEachChild(n, visit); }; visit(st); }
  const unresolvedTypeNames = new Set();
  for (const name of seen) {
    if (moduleRefs.has(name)) continue;
    if (topNames.has(name)) { moduleRefs.set(name, topNames.get(name)); continue; }
    // 不是本文件顶层的名字：可能是别的模块导出的类型（类型字符串由检查器写出，不一定在本文件 import 过）
    const sym = checker.resolveName(name, statements[0], ts.SymbolFlags.Type | ts.SymbolFlags.Value | ts.SymbolFlags.Alias, false);
    const target = sym && (sym.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(sym) : sym;
    const decl = target?.declarations?.[0];
    if (!decl) { if (!/^(Promise|Array|Map|Set|Record|Partial|Pick|Omit|Readonly|ReadonlyArray|Date|Error|Buffer|RegExp|Function|Uint8Array|NodeJS|Awaited|Extract|Exclude|NonNullable|Required|ReturnType|Parameters|string|number|boolean|unknown|any|never|void|null|undefined|object|symbol|bigint|true|false|typeof|keyof)$/.test(name) && !/^T\d+$/.test(name)) unresolvedTypeNames.add(name); continue; }
    const declFile = decl.getSourceFile();
    if (declFile === sf || declFile.fileName.includes("node_modules") || declFile.isDeclarationFile) { if (declFile !== sf && !declFile.fileName.includes("node_modules") && !declFile.isDeclarationFile) unresolvedTypeNames.add(name); continue; }
    let top = decl; while (top.parent && !ts.isSourceFile(top.parent)) top = top.parent;
    const exported = ts.canHaveModifiers(top) && (ts.getModifiers(top) || []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) { unresolvedTypeNames.add(name); continue; }
    externalTypeImports.push({ name, file: declFile.fileName, isType: ts.isTypeAliasDeclaration(top) || ts.isInterfaceDeclaration(top) });
  }
  // 引用了拿不到的类型的那几个类型串整体退成 any（带注释），不留编译错误
  const anyify = (row, idx) => { for (const n of unresolvedTypeNames) if (namesByRow[idx].has(n)) { row.type = `any /* 原类型 ${row.type.slice(0, 80).replace(/\*\//g, "* /")}… 引用了拿不到的 ${n}，手动收拾 */`; break; } };
  inputRows.forEach((row, i) => anyify(row, i)); outputRows.forEach((row, i) => anyify(row, inputRows.length + i));
}
// moduleRefs 现在齐了，再生成 import 行（上面那段先算好的会被覆盖）
byModule.clear(); importLines.length = 0; needExportInSource.length = 0;
for (const [name, ref] of moduleRefs) {
  const top = ref.top;
  if (ts.isImportDeclaration(top)) {
    const mod = top.moduleSpecifier.text;
    const cl = top.importClause; const typeOnly = cl?.isTypeOnly || false;
    let spec = name; let kind = "named";
    if (cl?.name && cl.name.text === name) kind = "default";
    else if (cl?.namedBindings && ts.isNamespaceImport(cl.namedBindings)) kind = "ns";
    else if (cl?.namedBindings) { const el = cl.namedBindings.elements.find((e) => e.name.text === name); if (el?.propertyName) spec = `${el.propertyName.text} as ${name}`; if (el?.isTypeOnly) kind = "typeNamed"; }
    const resolvedMod = mod.startsWith(".") ? path.relative(path.dirname(newModulePath), path.resolve(path.dirname(filePath), mod)).replace(/\\/g, "/") : mod;
    const finalMod = mod.startsWith(".") ? (resolvedMod.startsWith(".") ? resolvedMod : "./" + resolvedMod) : mod;
    const key = `${finalMod}|${typeOnly}`;
    const g = byModule.get(key) || { mod: finalMod, typeOnly, default: null, ns: null, named: [] };
    if (kind === "default") g.default = name; else if (kind === "ns") g.ns = name; else g.named.push(kind === "typeNamed" ? `type ${spec}` : spec);
    byModule.set(key, g);
  } else {
    const exported = ts.canHaveModifiers(top) && (ts.getModifiers(top) || []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) needExportInSource.push(top);
    const rel = path.relative(path.dirname(newModulePath), filePath.replace(/\.tsx?$/, "")).replace(/\\/g, "/");
    const key = `${rel.startsWith(".") ? rel : "./" + rel}|src`;
    const g = byModule.get(key) || { mod: rel.startsWith(".") ? rel : "./" + rel, typeOnly: false, default: null, ns: null, named: [] };
    const isType = ts.isTypeAliasDeclaration(top) || ts.isInterfaceDeclaration(top);
    g.named.push(isType ? `type ${name}` : name);
    byModule.set(key, g);
  }
}
for (const ext of externalTypeImports) {
  let rel = path.relative(path.dirname(newModulePath), ext.file.replace(/\.tsx?$/, "")).replace(/\\/g, "/");
  if (!rel.startsWith(".")) rel = "./" + rel;
  const key = `${rel}|src`;
  const g = byModule.get(key) || { mod: rel, typeOnly: false, default: null, ns: null, named: [] };
  g.named.push(ext.isType ? `type ${ext.name}` : ext.name);
  byModule.set(key, g);
}
for (const g of [...byModule.values()].sort((a, b) => a.mod.localeCompare(b.mod))) {
  const parts = []; if (g.default) parts.push(g.default); if (g.ns) parts.push(`* as ${g.ns}`); if (g.named.length) parts.push(`{ ${[...new Set(g.named)].sort().join(", ")} }`);
  importLines.push(`import ${g.typeOnly ? "type " : ""}${parts.join(", ")} from "${g.mod}";`);
}
const ctxType = inputRows.length ? `export type ${ctxTypeName} = {\n${inputRows.map((r) => `  ${r.name}: ${r.type};`).join("\n")}\n};\n\n` : "";
const resultFieldTypes = resultFields.map((n) => { const row = outputRows.find((r) => r.name === n) || inputRows.find((r) => r.name === n); return `${n}: ${row.type};`; });
const resultType = hasTopLevelReturn
  ? `export type ${resultTypeName} =\n  | { done: true; value: ${returnValueType} }\n  | { done: false${resultFields.length ? "; " + resultFieldTypes.map((f) => f.replace(/;$/, "")).join("; ") : ""} };\n\n`
  : `export type ${resultTypeName} = {\n${resultFieldTypes.map((f) => "  " + f).join("\n")}\n};\n\n`;
const header = `/*\n  从 ${path.relative(root, filePath)} 第 ${startLine}-${endLine} 行抽出（scripts/extract-block.mjs），行为不变。\n*/\n`;
// 生成的模块里没用到的 import 名字剪掉（类型串退成 any 之后，原来为它准备的类型导入就没人用了）
{
  const bodyForScan = `${ctxType}${hasTopLevelReturn || resultFields.length ? resultType : ""}${newBody}`;
  const scan = ts.createSourceFile("scan.ts", bodyForScan, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
  const usedNames = new Set(); const v = (n) => { if (ts.isIdentifier(n)) usedNames.add(n.text); ts.forEachChild(n, v); }; v(scan);
  for (let i = importLines.length - 1; i >= 0; i--) {
    const m = /^import (type )?(?:(\w+)(?:, )?)?(?:\* as (\w+))?(?:\{ ([^}]*) \})? from (".*");$/.exec(importLines[i]);
    if (!m) continue;
    const [, typeKw, def, ns, named, mod] = m;
    const keepDef = def && usedNames.has(def), keepNs = ns && usedNames.has(ns);
    const keepNamed = named ? named.split(",").map((x) => x.trim()).filter((x) => usedNames.has(x.replace(/^type /, "").split(" as ").pop())) : [];
    if (!keepDef && !keepNs && !keepNamed.length) { importLines.splice(i, 1); continue; }
    const parts = []; if (keepDef) parts.push(def); if (keepNs) parts.push(`* as ${ns}`); if (keepNamed.length) parts.push(`{ ${keepNamed.join(", ")} }`);
    importLines[i] = `import ${typeKw || ""}${parts.join(", ")} from ${mod};`;
  }
}
const newModule = `${header}${importLines.join("\n")}${importLines.length ? "\n\n" : ""}${ctxType}${hasTopLevelReturn || resultFields.length ? resultType : ""}${fnKeyword} ${fnName}(${ctxParam})${hasTopLevelReturn || resultFields.length ? `: ${hasAwait && !asHook ? "Promise<" : ""}${resultTypeName}${hasAwait && !asHook ? ">" : ""}` : ""} {\n${destructure}${dedent(newBody).split("\n").map((l) => (l.trim() ? "  " + l : l)).join("\n")}\n${hasTopLevelReturn || resultFields.length ? `  return ${resultLiteral};\n` : ""}}\n`;

// ---- 调用处
const relImport = path.relative(path.dirname(filePath), newModulePath.replace(/\.tsx?$/, "")).replace(/\\/g, "/");
const callExpr = `${hasAwait && !asHook ? "await " : ""}${fnName}(${inputRows.length ? `{ ${inputRows.map((r) => r.name).join(", ")} }` : ""})`;
let callSite;
if (!hasTopLevelReturn && !resultFields.length) callSite = `${indent}${callExpr};`;
else {
  const lines = [`${indent}const ${fnName}Result = ${callExpr};`];
  if (hasTopLevelReturn) lines.push(`${indent}if (${fnName}Result.done) return ${returnsValue ? `${fnName}Result.value as never` : ""};`.replace(" as never", ""));
  // 段内用 let 声明的输出，段后可能还会被重新赋值：调用处也用 let 接
  const isLetDecl = (name) => { const d = outputs.get(name)?.decl; const list = d && ts.isVariableDeclaration(d) ? d.parent : d && ts.isBindingElement(d) ? (() => { let n = d; while (n && !ts.isVariableDeclaration(n)) n = n.parent; return n?.parent; })() : null; return !!list && ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Let) !== 0; };
  const outs = outputRows.map((r) => r.name).filter((n) => !writeBack.includes(n));
  const constOuts = outs.filter((n) => !isLetDecl(n)), letOuts = outs.filter(isLetDecl);
  if (constOuts.length) lines.push(`${indent}const { ${constOuts.join(", ")} } = ${fnName}Result;`);
  if (letOuts.length) lines.push(`${indent}let { ${letOuts.join(", ")} } = ${fnName}Result;`);
  for (const n of writeBack) lines.push(`${indent}${n} = ${fnName}Result.${n};`);
  callSite = lines.join("\n");
}
let newText = text.slice(0, statements[0].getStart(sf)) + callSite.trimStart() + text.slice(rangeEnd);
// import 新模块
const lastImport = sf.statements.filter((s) => ts.isImportDeclaration(s)).pop();
const importLine = `import { ${fnName} } from "${relImport.startsWith(".") ? relImport : "./" + relImport}";\n`;
newText = lastImport ? newText.slice(0, lastImport.end) + "\n" + importLine.trimEnd() + newText.slice(lastImport.end) : importLine + newText;
// 本文件顶层声明补 export（从后往前改）
for (const top of needExportInSource.sort((a, b) => b.getStart(sf) - a.getStart(sf))) {
  const pos = top.getStart(sf);
  // newText 相对原 text 的偏移：只有 import 行插在前面、段被替换；顶层声明都在段之前或之后，按位置修正
  const shift = (p) => { let out = p; if (lastImport && p > lastImport.end) out += importLine.length; if (p > rangeEnd) out += (callSite.trimStart().length - (rangeEnd - statements[0].getStart(sf))); return out; };
  const at = shift(pos);
  newText = newText.slice(0, at) + "export " + newText.slice(at);
}
// 源文件里抽走后不再用到的 import 名字去掉（整条 import 空了就删整条）
{
  const after = ts.createSourceFile(filePath, newText, ts.ScriptTarget.ESNext, true, filePath.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const used = new Set();
  const visit = (n) => { if (ts.isIdentifier(n) && !isDeclNameIn(n)) used.add(n.text); ts.forEachChild(n, visit); };
  function isDeclNameIn(id) {
    const p = id.parent;
    if ((ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p)) && p.name === id) return true;
    // export { a, b } from "./x" 里的名字是转发别的模块的，不算用到了本文件的 import
    if (ts.isExportSpecifier(p) && p.parent.parent.moduleSpecifier) return true;
    return false;
  }
  visit(after);
  const edits = [];
  for (const st of after.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause) continue;
    const cl = st.importClause;
    const keepDefault = cl.name ? used.has(cl.name.text) : false;
    let keepNs = false; const keepNamed = [];
    if (cl.namedBindings && ts.isNamespaceImport(cl.namedBindings)) keepNs = used.has(cl.namedBindings.name.text);
    if (cl.namedBindings && ts.isNamedImports(cl.namedBindings)) for (const el of cl.namedBindings.elements) if (used.has(el.name.text)) keepNamed.push(el.getText(after));
    const hadNamed = cl.namedBindings && ts.isNamedImports(cl.namedBindings) ? cl.namedBindings.elements.length : 0;
    if (!keepDefault && !keepNs && !keepNamed.length) { if (cl.name || hadNamed || (cl.namedBindings && ts.isNamespaceImport(cl.namedBindings))) edits.push([st.getFullStart(), st.end, ""]); continue; }
    if (hadNamed && keepNamed.length !== hadNamed) {
      const parts = []; if (keepDefault) parts.push(cl.name.text); if (keepNamed.length) parts.push(`{ ${keepNamed.join(", ")} }`);
      edits.push([st.getStart(after), st.end, `import ${cl.isTypeOnly ? "type " : ""}${parts.join(", ")} from ${st.moduleSpecifier.getText(after)};`]);
    }
  }
  edits.sort((a, b) => b[0] - a[0]);
  for (const [s0, e0, r] of edits) newText = newText.slice(0, s0) + r + newText.slice(e0);
}
fs.mkdirSync(path.dirname(newModulePath), { recursive: true });
fs.writeFileSync(newModulePath, newModule);
fs.writeFileSync(filePath, newText);
console.log(`已写：${path.relative(root, newModulePath)}；${path.relative(root, filePath)} 里换成调用。请跑 tsc 和测试。`);
