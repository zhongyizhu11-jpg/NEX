import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * workspace.css 的两条底线（PR 8 清出来的）。
 *
 * 一、不按类名片段猜 DOM。`[class*="rounded-"][class*="border"]` 这种选择器会改掉任何
 *    碰巧同时写了这两个类的元素 —— 它误伤过 Entity 卡片的圆角，也按住过一个自己加了
 *    animate-pulse 的圆点。要改谁，就给谁一个明确的 fx-* 类名。
 *
 * 二、工作区卡片「不描边、不投影」要在任何宽度都成立。原来只写在手机那一段里，桌面上的
 *    Card 还带着边框和投影，和旁边的 EntityCard 一有框一没框。
 */
const css = fs.readFileSync(path.resolve(import.meta.dirname, "workspace.css"), "utf8");
const code = css.replace(/\/\*[\s\S]*?\*\//g, "");

test("不按类名片段猜 DOM", () => {
  assert.deepEqual(code.match(/\[class[*^$]=[^\]]*\]/g) ?? [], []);
  // 反向对照：注释里还写着那条被删掉的规则，确认上面确实是去掉注释之后才查的
  assert.match(css, /\[class\*="rounded-"\]\[class\*="border"\]/);
});

test("手机上不再给每个 <p> 加上下 12px", () => {
  assert.doesNotMatch(code, /\.workspace-main p\s*\{[^}]*margin/);
});

/** 最外层（不在任何 @media / @layer 里）的规则：按顶层花括号走，@ 开头的块整块跳过。 */
function topLevelRules(source: string) {
  const rules: { selector: string; body: string }[] = [];
  let i = 0;
  while (i < source.length) {
    const open = source.indexOf("{", i);
    if (open < 0) break;
    let depth = 1;
    let j = open + 1;
    while (j < source.length && depth > 0) {
      if (source[j] === "{") depth += 1;
      else if (source[j] === "}") depth -= 1;
      j += 1;
    }
    const selector = source.slice(i, open).trim();
    if (!selector.startsWith("@")) rules.push({ selector, body: source.slice(open + 1, j - 1) });
    i = j;
  }
  return rules;
}

test("工作区卡片：描边和投影都由令牌给（浅色灰底白卡不描边、软影；深色弱线）—— 写在媒体查询外面，桌面也成立", () => {
  const rules = topLevelRules(code).filter((item) => item.selector === '.workspace-main [data-slot="card"]');
  assert.ok(rules.length > 0, "最外层有一条 .workspace-main [data-slot=\"card\"] 规则");
  const body = rules.map((item) => item.body).join(";");
  assert.match(body, /border:\s*1px solid var\(--fx-card-stroke/, "卡片描边由 --fx-card-stroke 决定：浅色 transparent，深色弱线");
  assert.match(body, /box-shadow:\s*var\(--fx-elevation-card\)/, "灰底上的白卡靠一层软影成形");
});

/*
  2.3.370 之后真机反馈的那一轮（「分类条滑的时候上下晃」「字体全部缩小」）留下的几条底线。
*/

test("横向滚动的分类条不许竖着也能滚", () => {
  /*
    只写 overflow-x: auto 时 overflow-y 也被算成 auto；分类项再用 ::after 往上下各撑 7px，
    这条就能竖着滚 7px —— 手指左右划的时候整条跟着上下晃。
  */
  const viewport = code.match(/\.workspace-tabs-viewport\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.match(viewport, /overflow-y:\s*hidden/);
  assert.doesNotMatch(code, /\.workspace-tab::after/, "分类项不再往外撑命中区");
  // 反向对照：这个选择器确实还在用（不是整条规则被删了才通过）
  assert.match(viewport, /overflow-x:\s*auto/);
});

test("不再用 v3 的 `> * + * { margin-top }` 去压 space-y-*", () => {
  /*
    Tailwind v4 的 space-y-* 给的是 margin-block-end，上下相邻的外边距合并取大值：
    写 margin-top 去「压小」等于没写 —— 手机上页面区块之间一直是 24px。
  */
  assert.deepEqual(code.match(/\.space-y-\d+\s*>\s*\*\s*\+\s*\*/g) ?? [], []);
  assert.match(code, /\.space-y-6 > :not\(:last-child\)(:not\(\.fx-navbar\))? \{ margin-block-end:/);
});

test("输入框字号低于 16px 的前提：viewport 里有 maximum-scale=1", () => {
  /*
    iOS 聚焦字号小于 16px 的输入框时会把整页放大，除非 viewport 写了 maximum-scale=1。
    手机上输入框现在是 15px —— 哪天有人把 maximum-scale 从 index.html 里拿掉，这里会报出来，
    提醒把输入框改回 16px。
  */
  const html = fs.readFileSync(path.resolve(import.meta.dirname, "../../../index.html"), "utf8");
  const sizes = [...code.matchAll(/\[data-slot="input"\]\[class\][^{]*\{[^}]*font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
  assert.ok(sizes.length > 0, "找得到输入框的字号规则");
  if (sizes.some((size) => size < 16)) {
    assert.match(html, /name="viewport"[\s\S]*?maximum-scale=1/);
  }
});

test("iOS App 手机顶栏往上收：安全区只留 83%、顶栏 44px；液态玻璃的浮条不再离顶 8px", () => {
  assert.match(css, /html\.capacitor-ios \.workspace-appbar \{ --fx-header-height: 44px; padding-top: calc\(env\(safe-area-inset-top, 0px\) \* 0\.83\); height: calc\(44px \+ env\(safe-area-inset-top, 0px\) \* 0\.83\); \}/);
  assert.match(css, /html\.capacitor-ios\[data-ui-theme="liquid-glass"\] \.workspace-appbar \{ top: 0; margin-top: 0; \}/);
});
