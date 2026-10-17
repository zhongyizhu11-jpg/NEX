import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import PearlNavMarker from "@/components/PearlNavMarker";

/**
 * 「珍珠」主题（data-ui-theme="pearl"）加的那几个结构（侧栏头上的品牌栏、脚下的用户卡、顶栏的面包屑、
 * 手机上的抽屉顶栏、首页标题右边的日期铭牌 + 系统在线、会滑的侧栏标记）只许在珍珠下出现：
 * 别的七套主题的 DOM 一个节点都不能多、不能少、顺序不能变。
 *
 * 外壳那几个节点在 DashboardLayout.tsx 里，整个组件挂着 trpc / 路由 / 侧栏上下文，渲染起来太重；
 * 这里改为按源码守：每一处 fx-pearl-* 都得落在一段 `pearl ? (…)` / `pearl && …` 的分支里，
 * 经典顶栏和底部标签栏只在 !pearl 时画。
 */

const ROOT = path.resolve(import.meta.dirname);
const strip = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

/** `pearl ? (` / `pearl && (` 后面那段括号的范围（含），以及 `pearl ? <X … /> :` 这种单个元素 */
function gatedRanges(source: string) {
  const ranges: Array<[number, number]> = [];
  for (const match of source.matchAll(/\bpearl(?:\s*&&\s*!?isMobile)?\s*(?:\?|&&)\s*\(/g)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === "(") depth += 1;
      else if (source[i] === ")") {
        depth -= 1;
        if (depth === 0) {
          ranges.push([open, i]);
          break;
        }
      }
    }
  }
  return ranges;
}

test("外壳：fx-pearl-* 节点全在珍珠分支里", () => {
  const source = strip(fs.readFileSync(path.join(ROOT, "components/DashboardLayout.tsx"), "utf8"));
  const ranges = gatedRanges(source);
  const hits = [...source.matchAll(/fx-pearl-[\w-]+/g)];
  assert.ok(hits.length >= 10, "确实扫到了珍珠节点");
  const loose = hits.filter((hit) => !ranges.some(([a, b]) => (hit.index ?? 0) > a && (hit.index ?? 0) < b)).map((hit) => hit[0]);
  assert.deepEqual(loose, []);
});

test("外壳：珍珠顶栏只在珍珠下挂；经典顶栏、底部标签栏只在不是珍珠时画", () => {
  const source = strip(fs.readFileSync(path.join(ROOT, "components/DashboardLayout.tsx"), "utf8"));
  assert.match(source, /const pearl = uiTheme === "pearl";/);
  assert.match(source, /const pearlAppbar = pearl \? \(/);
  const uses = [...source.matchAll(/\{([^{}]*)\bpearlAppbar\b[^{}]*\}/g)].map((m) => m[0]);
  assert.deepEqual(uses, ["{pearl && isMobile ? pearlAppbar : null}", "{pearl && !isMobile ? pearlAppbar : null}"]);
  assert.match(source, /\{pearl \? null : \(\s*<header className="workspace-appbar">/);
  assert.match(source, /\{isMobile && !pearl \? \(\s*<IosTabBar/);
  assert.match(source, /isMobile && tabBarPlan\.tabs\.length && !pearl \? "workspace-has-tabbar"/);
  // 侧栏标记：折叠成图标栏、手机抽屉都不挂
  assert.match(source, /<PearlNavMarker collapsed=\{isDesktopCollapsed \|\| isMobile\} \/>/);
});

test("首页：日期铭牌和系统在线只在珍珠下；统计卡在珍珠下排到地图前面，别的主题顺序不变", () => {
  const source = strip(fs.readFileSync(path.join(ROOT, "pages/Home.tsx"), "utf8"));
  const badges = [...source.matchAll(/<PearlHeaderBadges\b/g)];
  assert.equal(badges.length, 1);
  assert.match(source, /actions=\{pearl \? <PearlHeaderBadges \/> : undefined\}/);
  const before = source.indexOf("{pearl ? statusHeader : null}");
  const map = source.indexOf("<NetworkMapSlot");
  const after = source.indexOf("{pearl ? null : statusHeader}");
  assert.ok(before > 0 && before < map && map < after, "非珍珠：地图 → 运行状态；珍珠：运行状态 → 地图");
});

test("侧栏标记：不是珍珠就什么都不渲染", () => {
  const html = renderToStaticMarkup(<PearlNavMarker collapsed={false} />);
  assert.equal(html, "");
  const previous = (globalThis as any).document;
  (globalThis as any).document = { documentElement: { getAttribute: (name: string) => (name === "data-ui-theme" ? "pearl" : null) } };
  try {
    assert.match(renderToStaticMarkup(<PearlNavMarker collapsed={false} />), /fx-pearl-nav-marker/);
    assert.equal(renderToStaticMarkup(<PearlNavMarker collapsed />), "");
  } finally {
    if (previous === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = previous;
  }
});
