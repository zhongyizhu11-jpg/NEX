import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { HealthBadge, StatusDot } from "./StatusDot";
import { NetworkPath, PathPreview } from "./NetworkPath";

const po0 = { id: "po0", name: "Po0", sublabel: "广东", health: "healthy" as const };
const jinx = { id: "jinx", name: "Jinx", sublabel: "香港", health: "healthy" as const };
const relay = { id: "relay", name: "Relay HK-01", health: "standby" as const };

test("两个节点默认横排，三个及以上默认竖排", () => {
  // 一行放得下两个节点，而且左右天然就是「从这到那」；三个横排会把每个
  // 节点压到放不下名字。
  const two = renderToStaticMarkup(<NetworkPath nodes={[po0, jinx]} />);
  assert.match(two, /flex-row/);

  const three = renderToStaticMarkup(<NetworkPath nodes={[po0, relay, jinx]} />);
  assert.match(three, /flex-col/);
});

test("显式指定方向时不再自动判断", () => {
  const forced = renderToStaticMarkup(<NetworkPath nodes={[po0, jinx]} orientation="vertical" />);
  assert.doesNotMatch(forced, /flex-row items-start gap-3/);
});

test("节点名和注脚都渲染出来，注脚不是第二个标题", () => {
  const html = renderToStaticMarkup(<NetworkPath nodes={[po0, jinx]} />);
  assert.match(html, /Po0/);
  assert.match(html, /广东/);
  assert.match(html, /Jinx/);
  // 名字走 primary 档，注脚走 meta 档 —— 一行里只有一个主角
  assert.match(html, /text-primary-type/);
  assert.match(html, /text-meta/);
});

test("延迟是数字在前、单位在后，不是「延迟 8ms」一整串", () => {
  // 数据型产品里数字本身就是视觉元素，一眼该看到 8 而不是「延迟」两个字。
  const html = renderToStaticMarkup(
    <NetworkPath nodes={[po0, jinx]} edges={[{ via: "NEX", latencyMs: 8 }]} />,
  );
  assert.match(html, /NEX/);
  assert.match(html, /8/);
  assert.match(html, /ms/);
  assert.doesNotMatch(html, /延迟 ?8/);
});

test("待命的线画成虚线，切换中的线带脉冲", () => {
  const standby = renderToStaticMarkup(
    <NetworkPath nodes={[po0, jinx]} edges={[{ health: "standby" }]} />,
  );
  assert.match(standby, /border-dashed/);

  const switching = renderToStaticMarkup(
    <NetworkPath nodes={[po0, jinx]} edges={[{ health: "switching" }]} />,
  );
  assert.match(switching, /fx-edge-pulse/);
  assert.doesNotMatch(switching, /border-dashed/);
});

test("edges 比 nodes 少一段时，剩下的按默认实线补，不报错", () => {
  const html = renderToStaticMarkup(
    <NetworkPath nodes={[po0, relay, jinx]} edges={[{ latencyMs: 8 }]} />,
  );
  assert.match(html, /Relay HK-01/);
  assert.match(html, /Jinx/);
});

test("竖排时连线不带左边距 —— 它要落在状态点的圆心上", () => {
  /*
    边自己的 w-2 容器已经把线居中到 x=4，和 8px 状态点的圆心重合。再加 ml-1
    会把线推到 x=8，实机上看就是线和点各走各的，根本没连起来。
  */
  const html = renderToStaticMarkup(
    <NetworkPath nodes={[po0, relay, jinx]} orientation="vertical" />,
  );
  assert.doesNotMatch(html, /class="[^"]*\bml-1\b/);
});

test("没有标注的那一段只留 12px，有标注的才留 24px", () => {
  /*
    没标注的段只是在说「这两个点是连着的」，一条短线足够。统一用 24px 的话，
    一条四跳路径光在三段空线上就花掉 72px —— 而列表卡总共才 350px。
  */
  const bare = renderToStaticMarkup(
    <NetworkPath nodes={[po0, relay, jinx]} orientation="vertical" />,
  );
  assert.match(bare, /min-h-3/);
  assert.doesNotMatch(bare, /min-h-6/);

  const labelled = renderToStaticMarkup(
    <NetworkPath nodes={[po0, jinx]} edges={[{ via: "GOST", latencyMs: 46 }]} orientation="vertical" />,
  );
  assert.match(labelled, /min-h-6/);
});

test("空节点列表渲染成空，不抛错", () => {
  assert.equal(renderToStaticMarkup(<NetworkPath nodes={[]} />), "");
});

test("单个节点只画点，不画线", () => {
  const html = renderToStaticMarkup(<NetworkPath nodes={[po0]} />);
  assert.match(html, /Po0/);
  assert.doesNotMatch(html, /border-t|border-l/);
});

test("状态点颜色走语义令牌，不写死调色板颜色", () => {
  // 换一次主题这里不用动；写 emerald-500 就得一处处找。
  const html = renderToStaticMarkup(<StatusDot health="down" />);
  assert.match(html, /var\(--fx-down\)/);
  assert.doesNotMatch(html, /emerald|amber-|red-5/);
});

test("状态点带读屏文字，不是一个纯装饰的色块", () => {
  const html = renderToStaticMarkup(<StatusDot health="degraded" />);
  assert.match(html, /aria-label="降级"/);
});

test("没上报过的点是灰的，不是绿的", () => {
  // 把没有结论显示成健康，等于让失联的机器看起来正常。
  const html = renderToStaticMarkup(<StatusDot health="unknown" />);
  assert.match(html, /var\(--fx-standby\)/);
  assert.doesNotMatch(html, /var\(--fx-healthy\)/);
});

test("HealthBadge 不传文字时用状态自带的中文标签", () => {
  assert.match(renderToStaticMarkup(<HealthBadge health="healthy" />), /正常/);
  assert.match(renderToStaticMarkup(<HealthBadge health="switching" />), /切换中/);
  assert.match(renderToStaticMarkup(<HealthBadge health="down" text="主线不通" />), /主线不通/);
});

test("Review 预览永远竖排，一行一个节点像一份清单", () => {
  const html = renderToStaticMarkup(<PathPreview nodes={[po0, jinx]} />);
  assert.doesNotMatch(html, /flex-row items-start gap-3/);
});
