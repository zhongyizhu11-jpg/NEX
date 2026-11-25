import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * 每个弹窗都要有标题和说明。
 *
 * Radix 的 Dialog 把 DialogTitle 当作弹窗的可访问名称、DialogDescription 当作描述：缺标题读屏
 * 只会念「对话框」，缺说明控制台每开一次就告警一次。全站普查时隧道页两处、转发组一处、
 * 落地入站两处、节点分享一处都没有 Description，规则页、插件页则是「有时有」。
 * 看不见的说明用 `className="sr-only"` 即可（Hosts 的「编辑主机」就是这么写的）。
 *
 * 这是**源码级**检查：按每一个 <DialogContent>…</DialogContent> 块数，块里得同时有
 * <DialogTitle 和 <DialogDescription。按块数而不是按文件数，否则一个文件里只要有一个弹窗写对了，
 * 其他几个都能混过去。
 *
 * 认不出的写法：标题 / 说明由别的组件（比如一个自定义的 Header）间接渲染。那种直接写进
 * 名单里说明原因，不去教脚本追组件。
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

/** 找出每个 <DialogContent …>…</DialogContent> 块，返回 { loc, hasTitle, hasDescription }。 */
export function scanDialogContents(source: string, relative: string) {
  const found: { loc: string; hasTitle: boolean; hasDescription: boolean }[] = [];
  const opens = /<DialogContent\b/g;
  let match: RegExpExecArray | null;
  while ((match = opens.exec(source))) {
    const start = match.index;
    // 自闭合（<DialogContent … />）的块里什么都没有，一样算缺
    let depth = 1;
    let i = start + match[0].length;
    let end = source.length;
    while (i < source.length) {
      if (source.startsWith("<DialogContent", i)) depth += 1;
      else if (source.startsWith("</DialogContent>", i)) {
        depth -= 1;
        if (depth === 0) { end = i; break; }
      }
      i += 1;
    }
    const block = source.slice(start, end);
    found.push({
      loc: `${relative}:${source.slice(0, start).split("\n").length}`,
      hasTitle: /<DialogTitle\b/.test(block),
      hasDescription: /<DialogDescription\b/.test(block),
    });
    opens.lastIndex = start + match[0].length;
  }
  return found;
}

/*
  还没补齐的弹窗，一处一行，写上缺什么。

  这是**棘轮**不是豁免：名单只许变短。新写的弹窗漏了标题或说明会直接红，
  名单里的补好了就从这里删掉 —— 删不掉说明没真补。
*/
const 待补: readonly string[] = [
  // 已清空：审计里点名的 ProxyInboundsSection ×2、ProxyNodeShareDialog、Rules 几处在同一批里补上了。
  // 新增的漏网会直接红。
];

test("每个 <DialogContent> 里都有 <DialogTitle> 和 <DialogDescription>", () => {
  const offenders: string[] = [];
  let total = 0;
  for (const file of collectTsx(ROOT)) {
    // 组件自身的定义不算用法
    if (file.endsWith(path.join("ui", "dialog.tsx"))) continue;
    for (const item of scanDialogContents(fs.readFileSync(file, "utf8"), path.relative(ROOT, file))) {
      total += 1;
      if (!item.hasTitle || !item.hasDescription) {
        offenders.push(item.loc);
      }
    }
  }
  assert.ok(total >= 80, `只扫到 ${total} 个弹窗，扫描逻辑可能失效了`);
  const 新增 = offenders.filter((x) => !待补.includes(x));
  assert.deepEqual(
    新增,
    [],
    `新写的弹窗缺标题或说明（看不见的说明用 className="sr-only"）：\n  ${新增.join("\n  ")}`,
  );
  // 名单只许变短：补好了就从 待补 里删掉。
  const 已补好 = 待补.filter((x) => !offenders.includes(x));
  assert.deepEqual(
    已补好,
    [],
    `这些已经补好了（或者行号变了），请更新 待补 名单：\n  ${已补好.join("\n  ")}`,
  );
});

test("扫描器按块数，不按文件数", () => {
  const two = scanDialogContents(
    '<Dialog><DialogContent><DialogTitle>甲</DialogTitle><DialogDescription>a</DialogDescription></DialogContent></Dialog>\n'
    + '<Dialog><DialogContent>\n  <DialogTitle>乙</DialogTitle>\n</DialogContent></Dialog>\n',
    "a.tsx",
  );
  assert.equal(two.length, 2);
  assert.deepEqual(two.map((x) => x.hasDescription), [true, false], "同一文件里第二个弹窗漏了说明也要报");
  assert.equal(two[1].loc, "a.tsx:2");

  const selfClosing = scanDialogContents("<DialogContent className=\"x\" />\n", "b.tsx");
  assert.equal(selfClosing.length, 1);
  assert.equal(selfClosing[0].hasTitle, false);
});
