import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * 按需加载的弹窗，第一次点开不能多等一次网络往返。
 *
 * 近两版把一批弹窗改成了 React.lazy：包小了，但 100 ms 往返的网络上第一次打开多等 300–600 ms，
 * 200–300 ms 往返就是 1–2 秒，而 Suspense 的 fallback 是 null —— 点一下什么都不出现。
 * 现在的规矩（lib/lazyWarm.ts、components/ui/dialog-loading.tsx）：
 *   1. 懒加载的弹窗要用一个有名字的 loader：`const loadXxxDialog = () => import(...)` + `lazy(loadXxxDialog)`，
 *      然后在拥有它的页面 / 组件里 `useWarmLazyChunks([loadXxxDialog, …])`（或 warmLazyChunk），页面闲时先热进缓存；
 *   2. 包着它的 <Suspense> 不能再是 fallback={null}，要用 <DialogLoadingFallback />，一帧之内先有个转圈的弹窗。
 *
 * 这是源码级检查：按名字认「弹窗」（组件名以 Dialog 结尾），新加一个漏了预热或占位就红。
 * 不是弹窗的懒加载块（图表、地球、设置分区、路由页面）不在这条规矩里：它们要么本来就有自己的占位，要么太大不该预热。
 */

const ROOT = path.resolve(import.meta.dirname);

function collectTsx(dir: string, out: string[] = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectTsx(full, out);
    else if (entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx")) out.push(full);
  }
  return out;
}

/** 文件里所有 useWarmLazyChunks(...) / warmLazyChunk(...) 调用的参数文本拼成一串，查 loader 名字用。 */
function warmCallText(source: string) {
  const parts: string[] = [];
  const calls = /\b(?:useWarmLazyChunks|warmLazyChunk)\(/g;
  let match: RegExpExecArray | null;
  while ((match = calls.exec(source))) {
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;
    while (i < source.length && depth > 0) {
      if (source[i] === "(") depth += 1;
      else if (source[i] === ")") depth -= 1;
      i += 1;
    }
    parts.push(source.slice(start, i - 1));
  }
  return parts.join("\n");
}

export function scanLazyDialogs(source: string, relative: string) {
  const problems: string[] = [];
  let dialogs = 0;
  const warmText = warmCallText(source);
  const lineOf = (index: number) => source.slice(0, index).split("\n").length;

  // 1. lazy(() => import(...)) 直接写在弹窗上：没有名字的 loader 就没法预热
  const inlineLazy = /const\s+(\w+Dialog)\s*=\s*lazy\(\s*\(\)\s*=>\s*import\(/g;
  let match: RegExpExecArray | null;
  while ((match = inlineLazy.exec(source))) {
    dialogs += 1;
    problems.push(`${relative}:${lineOf(match.index)}  ${match[1]} 的 import 写在 lazy() 里，抽成 const load${match[1]} = () => import(...) 再 lazy(load${match[1]})，页面里 useWarmLazyChunks([load${match[1]}])`);
  }
  // 2. lazy(loadXxx)：loader 要出现在同一个文件的某个 warm 调用里
  const namedLazy = /const\s+(\w+Dialog)\s*=\s*lazy\(\s*(\w+)\s*\)/g;
  while ((match = namedLazy.exec(source))) {
    dialogs += 1;
    if (!new RegExp(`\\b${match[2]}\\b`).test(warmText)) {
      problems.push(`${relative}:${lineOf(match.index)}  ${match[1]} 的 loader ${match[2]} 没有被 useWarmLazyChunks / warmLazyChunk 预热`);
    }
  }
  // 3. <Suspense fallback={null}> 下一行就是弹窗：点开时一帧都没东西
  const nullFallback = /<Suspense fallback=\{null\}>\s*<(\w+)/g;
  while ((match = nullFallback.exec(source))) {
    if (/Dialog$/.test(match[1])) problems.push(`${relative}:${lineOf(match.index)}  包着 ${match[1]} 的 Suspense 还是 fallback={null}，换成 <DialogLoadingFallback />`);
  }
  return { dialogs, problems };
}

test("每个懒加载的弹窗都有预热，Suspense 占位不再是空的", () => {
  const problems: string[] = [];
  let dialogs = 0;
  for (const file of collectTsx(ROOT)) {
    const result = scanLazyDialogs(fs.readFileSync(file, "utf8"), path.relative(ROOT, file));
    dialogs += result.dialogs;
    problems.push(...result.problems);
  }
  assert.ok(dialogs >= 10, `只扫到 ${dialogs} 个懒加载弹窗，扫描逻辑可能失效了`);
  assert.deepEqual(problems, [], `这些懒加载弹窗第一次打开会多等一次网络往返：\n  ${problems.join("\n  ")}`);
});

test("扫描器认得三种写法", () => {
  const inline = scanLazyDialogs('const FooDialog = lazy(() => import("./FooDialog"));\n', "a.tsx");
  assert.equal(inline.dialogs, 1);
  assert.equal(inline.problems.length, 1, "import 直接写在 lazy() 里要报");

  const cold = scanLazyDialogs('const loadFooDialog = () => import("./FooDialog");\nconst FooDialog = lazy(loadFooDialog);\n', "b.tsx");
  assert.equal(cold.problems.length, 1, "有名字的 loader 但没人预热要报");

  const warm = scanLazyDialogs('const loadFooDialog = () => import("./FooDialog");\nconst FooDialog = lazy(loadFooDialog);\nfunction Page() { useWarmLazyChunks(isAdmin ? [loadFooDialog] : []); return <Suspense fallback={<DialogLoadingFallback />}><FooDialog /></Suspense>; }\n', "c.tsx");
  assert.deepEqual(warm.problems, []);

  const empty = scanLazyDialogs('const x = <Suspense fallback={null}>\n  <FooDialog />\n</Suspense>;\n', "d.tsx");
  assert.equal(empty.problems.length, 1, "弹窗外面 fallback={null} 要报");

  const widget = scanLazyDialogs('const x = <Suspense fallback={null}>\n  <FooWidget />\n</Suspense>;\n', "e.tsx");
  assert.deepEqual(widget.problems, [], "不是弹窗的懒加载块不管");
});
