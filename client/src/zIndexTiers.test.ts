import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * 层级只许用手册那几档，不许随手写大数字。
 *
 * 手册第五节给了六档（内容 0 · 悬浮卡片 10 · 下拉气泡 20 · 吸顶导航 40 ·
 * 遮罩弹窗 50 · Toast 60），并明确要求「用变量统一管理，禁止随手写大数字」。
 *
 * 动手前全站普查过一遍，两个真正「随手写的大数字」是：
 *   - toast 的内联 `zIndex: 200`（写在 JS 里，grep CSS 类名根本搜不到）
 *   - 日期面板的 `z-[70]`
 * 两个都已经换成 `shared/design-tokens.css` 里的令牌。
 *
 * **浮层容器内部是另一套坐标系**：所有浮层都 portal 进 `#forwardx-overlay-root`，
 * 而那个容器 `isolation: isolate`，自成一个层叠上下文 —— 里面的 50/70/200 只和
 * 彼此比较，跟页面上的 0~60 没有可比性。所以令牌分了两组，名字写明是容器内。
 *
 * 这条测试盯的是**字面量清单**：哪个文件里出现了哪些层叠数字，一律记在案。
 * 新写一个数字就会红，逼人先想清楚该用哪一档 —— 这正是「随手写」的反面。
 */

const ROOT = path.resolve(import.meta.dirname);

/** 手册的六档。页面层只许用这些。 */
const 手册档位 = new Set([0, 10, 20, 40, 50, 60]);

/*
  在案的例外，一处一行，都得写清楚为什么不在六档里。

  这不是豁免名单，是**账本**：清单变了就红，不管是多了还是少了。
  少了要么是删干净了（那就从这里删掉），要么是漏扫了（那要修扫描器）。
*/
const 在案: Record<string, { 值: number[]; 因为: string }> = {
  "index.css": {
    值: [-1, 0, 1],
    因为: "页面基座：背景视频压在 -1，#root 抬到 1 盖住它。不是分层，是一对固定搭配",
  },
  "styles/workspace.css": {
    值: [1],
    因为: "组件内部同级排序（滚动按钮、连线节点、箭头），不参与全站分层",
  },
  "pages/Hosts.tsx": {
    值: [20, 30],
    因为: "30 是表格冻结列，只和同表格的单元格比先后；20 在六档内",
  },
  "components/plugins/Live2DWidgetHost.tsx": {
    值: [45],
    因为: "看板娘浮窗要压住吸顶头部（40）又不能盖住弹窗（50），卡在中间。第三方挂件的样式，单独记着",
  },
};

function collect(dir: string, out: string[] = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (/\.(tsx?|css)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** 注释里出现的写法不算数 —— 组件说明里写「内容要 relative z-10」不是用法。 */
function stripComments(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function scan() {
  const found = new Map<string, Set<number>>();
  for (const file of collect(ROOT)) {
    const relative = path.relative(ROOT, file);
    const source = stripComments(fs.readFileSync(file, "utf8"));
    const values = new Set<number>();
    // Tailwind 的 z-10 / z-[70]；z-[var(--…)] 不算字面量，那正是我们要的写法
    for (const m of source.matchAll(/(?<![\w-])z-\[(-?\d+)\]|(?<![\w-])z-(-?\d+)(?![\w\]])/g)) {
      values.add(Number(m[1] ?? m[2]));
    }
    for (const m of source.matchAll(/z-index:\s*(-?\d+)/g)) values.add(Number(m[1]));
    for (const m of source.matchAll(/zIndex:\s*(-?\d+)/g)) values.add(Number(m[1]));
    if (values.size) found.set(relative, values);
  }
  return found;
}

test("层叠数字要么在手册六档里，要么记在案", () => {
  const found = scan();
  const 越界: string[] = [];
  for (const [file, values] of found) {
    const 记录 = 在案[file];
    for (const value of values) {
      if (手册档位.has(value)) continue;
      if (记录?.值.includes(value)) continue;
      越界.push(`${file}: ${value}`);
    }
  }
  assert.deepEqual(
    越界,
    [],
    `这些层叠数字既不在手册六档（0/10/20/40/50/60）里，也没记在案。\n`
      + `先想清楚该用哪一档，用 shared/design-tokens.css 里的 --fx-z-* 令牌；\n`
      + `确实是特例就写进 zIndexTiers.test.ts 的「在案」表，并说明为什么：\n  `
      + 越界.join("\n  "),
  );
});

test("在案清单只许变短，不许悄悄变长", () => {
  const found = scan();
  const 已经没有了: string[] = [];
  for (const [file, 记录] of Object.entries(在案)) {
    const values = found.get(file);
    for (const value of 记录.值) {
      if (!values?.has(value)) 已经没有了.push(`${file}: ${value}`);
    }
  }
  assert.deepEqual(
    已经没有了,
    [],
    `这些已经不在代码里了，请从「在案」表里删掉（留着就等于账本对不上）：\n  ${已经没有了.join("\n  ")}`,
  );
});

test("两个真正的大数字已经换成令牌", () => {
  const tokens = fs.readFileSync(path.resolve(ROOT, "../../shared/design-tokens.css"), "utf8");
  for (const name of ["--fx-z-in-overlay-base", "--fx-z-in-overlay-popover", "--fx-z-in-overlay-toast"]) {
    assert.match(tokens, new RegExp(name), `令牌 ${name} 不见了`);
  }
  const sonner = fs.readFileSync(path.resolve(ROOT, "components/ui/sonner.tsx"), "utf8");
  assert.match(sonner, /zIndex: "var\(--fx-z-in-overlay-toast\)"/, "toast 又写回数字了");
  const picker = stripComments(fs.readFileSync(path.resolve(ROOT, "components/DatePickerInput.tsx"), "utf8"));
  assert.match(picker, /z-\[var\(--fx-z-in-overlay-popover\)\]/, "日期面板又写回数字了");
});
