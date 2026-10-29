// 查「函数体里的 const / let 还没定义就被用到」（Cannot access 'x' before initialization）。
//
// 2.3.488 的转发页整页白屏就是这个：组件里一个 useMemo 在渲染时调用了前面定义的 useCallback，
// 那个回调又引用了写在 useMemo **后面**的 const。类型检查看不出来（名字都在作用域里），
// 只有真跑到才炸。这里按语句顺序算一遍：
//
//   · 对每个函数（组件）体，按顶层语句编号；记下每个顶层 const / let 的编号。
//   · 每个顶层变量 / 语句「立刻执行」的部分引用了哪些顶层名字：直接的表达式、以及传给
//     useMemo / useState / useReducer / useSyncExternalStore / useImperativeHandle 的回调（渲染时就跑）。
//     其它回调（useCallback、useEffect、事件处理、普通箭头函数）要等以后才跑，不算立刻，
//     但它们**引用了谁**要记住：立刻执行的部分一旦调用了这个回调，它引用的名字也算立刻用到。
//   · 立刻用到的名字如果定义在当前语句之后 → 报出来。
//
// 用法：node scripts/check-tdz.mjs [目录或文件…]（默认 client/src shared）。有问题退出码 1。
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const roots = process.argv.slice(2);
const targets = roots.length > 0 ? roots : ["client/src", "shared"];
const EAGER_HOOKS = new Set(["useMemo", "useState", "useReducer", "useSyncExternalStore", "useImperativeHandle", "useLayoutEffect"]);

function* walkFiles(dir) {
  if (fs.statSync(dir).isFile()) { yield dir; return; }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      yield* walkFiles(full);
    } else if (/\.(tsx?|jsx?|mjs)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
      yield full;
    }
  }
}

function functionBody(node) {
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) {
    return node.body && ts.isBlock(node.body) ? node.body : null;
  }
  return null;
}

function bindingNames(name, out) {
  if (ts.isIdentifier(name)) out.push(name.text);
  else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const element of name.elements) if (ts.isBindingElement(element)) bindingNames(element.name, out);
  }
  return out;
}

function isEagerCallback(node) {
  // 传给 useMemo(() => …) 这类钩子的第一个参数：渲染时立刻跑。
  const parent = node.parent;
  if (!parent || !ts.isCallExpression(parent) || parent.arguments[0] !== node) return false;
  const callee = parent.expression;
  const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
  return EAGER_HOOKS.has(name);
}

function isIIFE(node) {
  const parent = node.parent;
  const unwrapped = parent && ts.isParenthesizedExpression(parent) ? parent.parent : parent;
  return !!unwrapped && ts.isCallExpression(unwrapped) && (unwrapped.expression === node || unwrapped.expression === parent);
}

/**
 * 收集一个语句里对顶层名字的引用，分成两类：eager（现在就会读到）和 deferred（在以后才跑的函数里）。
 * deferred 按「是哪个顶层名字的定义」归档，立刻执行部分调用了那个名字时再并进来。
 */
function declaredInBlock(block, out) {
  // 这个块里直接声明的名字（let / const / var / function / class），进块时一次性收齐：块内先用后声明的也算块内的。
  for (const statement of block.statements || []) {
    if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) bindingNames(decl.name, out);
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
      out.push(statement.name.text);
    }
  }
  return out;
}

function scopeNamesOf(node) {
  // 进入 node 之后、离开之前，哪些名字被它遮住了。
  const out = [];
  if (ts.isFunctionLike(node)) {
    for (const parameter of node.parameters) bindingNames(parameter.name, out);
    if (node.name && (ts.isFunctionExpression(node) || ts.isClassExpression?.(node))) out.push(node.name.text);
    if (node.body && ts.isBlock(node.body)) declaredInBlock(node.body, out);
  } else if (ts.isBlock(node)) {
    declaredInBlock(node, out);
  } else if (ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node)) {
    if (node.initializer && ts.isVariableDeclarationList(node.initializer)) {
      for (const decl of node.initializer.declarations) bindingNames(decl.name, out);
    }
  } else if (ts.isCatchClause(node) && node.variableDeclaration) {
    bindingNames(node.variableDeclaration.name, out);
  }
  return out;
}

/**
 * 收集一个语句里对顶层名字的引用，分成两类：eager（现在就会读到）和 deferred（在以后才跑的函数里）。
 * deferred 按「是哪个顶层名字的定义」归档，立刻执行部分调用了那个名字时再并进来。
 * 内层作用域里同名的声明（参数、块内 const、for 的变量、catch 的 e）会遮住顶层的，不算引用。
 */
function collectReferences(statement, topNames) {
  const eager = new Set();
  const eagerCalls = new Set(); // 立刻执行部分**调用**了哪些顶层名字（只有调用才会跑到它的函数体）
  const deferredByOwner = new Map(); // 声明的名字 → 它的函数体里引用了哪些顶层名字
  const deferredCallsByOwner = new Map(); // 声明的名字 → 它的函数体里调用了哪些顶层名字
  const owners = [];
  if (ts.isVariableStatement(statement)) {
    for (const decl of statement.declarationList.declarations) bindingNames(decl.name, owners);
  }
  const shadow = new Map(); // 名字 → 被遮住的层数
  const push = (names) => { for (const name of names) shadow.set(name, (shadow.get(name) || 0) + 1); };
  const pop = (names) => { for (const name of names) { const n = (shadow.get(name) || 0) - 1; if (n <= 0) shadow.delete(name); else shadow.set(name, n); } };
  const visit = (node, deferredOwner) => {
    if (ts.isIdentifier(node) && topNames.has(node.text) && !shadow.has(node.text)) {
      const parent = node.parent;
      const isDeclName = parent && (
        ((ts.isVariableDeclaration(parent) || ts.isBindingElement(parent) || ts.isParameter(parent)) && parent.name === node)
        || (ts.isBindingElement(parent) && parent.propertyName === node) // { data: hosts } 里的 data 是属性名
      );
      const isPropertyName = parent && (
        (ts.isPropertyAccessExpression(parent) && parent.name === node)
        || (ts.isPropertyAssignment(parent) && parent.name === node)
        || (ts.isPropertySignature(parent) && parent.name === node)
        || (ts.isMethodDeclaration(parent) && parent.name === node)
        || (ts.isJsxAttribute(parent) && parent.name === node)
        || (ts.isTypeReferenceNode(parent))
        || (ts.isQualifiedName(parent))
        || (ts.isEnumMember(parent) && parent.name === node)
        || (ts.isLabeledStatement(parent) && parent.label === node)
        || (ts.isBreakOrContinueStatement(parent))
      );
      if (!isDeclName && !isPropertyName) {
        const called = parent && ts.isCallExpression(parent) && parent.expression === node;
        if (deferredOwner === null) {
          eager.add(node.text);
          if (called) eagerCalls.add(node.text);
        } else {
          if (!deferredByOwner.has(deferredOwner)) deferredByOwner.set(deferredOwner, new Set());
          deferredByOwner.get(deferredOwner).add(node.text);
          if (called) {
            if (!deferredCallsByOwner.has(deferredOwner)) deferredCallsByOwner.set(deferredOwner, new Set());
            deferredCallsByOwner.get(deferredOwner).add(node.text);
          }
        }
      }
    }
    if (ts.isTypeNode(node) && !ts.isTypeQueryNode(node)) return; // 类型里的名字不是运行时引用
    const names = scopeNamesOf(node);
    push(names);
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) {
      const eagerFn = isEagerCallback(node) || isIIFE(node);
      const nextOwner = eagerFn ? deferredOwner : (deferredOwner ?? (owners.length === 1 ? owners[0] : `#${statement.pos}`));
      ts.forEachChild(node, (child) => visit(child, nextOwner));
    } else {
      ts.forEachChild(node, (child) => visit(child, deferredOwner));
    }
    pop(names);
  };
  visit(statement, null);
  return { eager, eagerCalls, deferredByOwner, deferredCallsByOwner };
}

function checkBody(body, sourceFile, findings) {
  const statements = body.statements;
  const declaredAt = new Map(); // name → statement index（只看 const / let）
  statements.forEach((statement, index) => {
    if (ts.isVariableStatement(statement) && !(statement.declarationList.flags & ts.NodeFlags.Let) && !(statement.declarationList.flags & ts.NodeFlags.Const)) return;
    if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) for (const name of bindingNames(decl.name, [])) declaredAt.set(name, index);
    }
  });
  if (declaredAt.size === 0) return;
  const topNames = new Set(declaredAt.keys());
  const deferred = new Map(); // owner → Set(names)：这个名字的函数体读到了谁
  const deferredCalls = new Map(); // owner → Set(names)：这个名字的函数体调用了谁
  const perStatement = statements.map((statement) => collectReferences(statement, topNames));
  for (const { deferredByOwner, deferredCallsByOwner } of perStatement) {
    for (const [owner, names] of deferredByOwner) {
      if (!deferred.has(owner)) deferred.set(owner, new Set());
      for (const name of names) deferred.get(owner).add(name);
    }
    for (const [owner, names] of deferredCallsByOwner) {
      if (!deferredCalls.has(owner)) deferredCalls.set(owner, new Set());
      for (const name of names) deferredCalls.get(owner).add(name);
    }
  }
  const expand = (reads, calls) => {
    // 立刻读到的名字要已定义；立刻**调用**的名字，它函数体里读到的也要已定义，它再调用的接着往下算。
    const seen = new Set(reads);
    const visited = new Set();
    const queue = [...calls];
    while (queue.length) {
      const name = queue.pop();
      if (visited.has(name)) continue;
      visited.add(name);
      for (const inner of deferred.get(name) || []) seen.add(inner);
      for (const inner of deferredCalls.get(name) || []) queue.push(inner);
    }
    return seen;
  };
  perStatement.forEach(({ eager, eagerCalls }, index) => {
    const statement = statements[index];
    const selfNames = ts.isVariableStatement(statement)
      ? new Set(statement.declarationList.declarations.flatMap((decl) => bindingNames(decl.name, [])))
      : new Set();
    // 立刻读到的名字本身：定义在后面就是 TDZ。只对「直接读到」的名字做传递展开 ——
    // 传递来的名字只有在直接读到的是个函数并被调用时才会真的跑到，这里按会跑到算（宁可多报）。
    for (const name of expand(eager, eagerCalls)) {
      if (selfNames.has(name)) continue;
      const at = declaredAt.get(name);
      if (at === undefined || at <= index) continue;
      const { line } = sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile));
      const { line: declLine } = sourceFile.getLineAndCharacterOfPosition(statements[at].getStart(sourceFile));
      findings.push(`${sourceFile.fileName}:${line + 1}: 用到了 ${name}，它在第 ${declLine + 1} 行才定义`);
    }
  });
}

const findings = [];
for (const target of targets) {
  for (const file of walkFiles(target)) {
    if (/\.test\.[tj]sx?$/.test(file) || /__render-/.test(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node) => {
      const body = functionBody(node);
      if (body) checkBody(body, sourceFile, findings);
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
}
if (findings.length) {
  console.error(findings.join("\n"));
  console.error(`\n${findings.length} 处「定义前就用到」。`);
  process.exit(1);
}
console.log("check-tdz: ok");
