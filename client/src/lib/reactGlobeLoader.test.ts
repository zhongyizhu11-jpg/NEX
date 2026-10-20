import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

/*
  地球组件（react-globe.gl，1.78 MB）只在用户要看地球时才下载。

  原来规则页、链路页一打开就空闲预取，手机上规则页根本不给切地球视图，
  下了也白下；更糟的是 three-globe 一加载就留下几个永不停止的
  requestAnimationFrame 循环，看过地球切走后还会再多几个（见
  patches/three-globe@2.45.2.patch、patches/globe.gl@2.46.1.patch）。
  补丁是打在 node_modules 里的，升级这两个库时补丁会失效 —— 这里盯着。
*/

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

for (const page of ["client/src/pages/Rules.tsx", "client/src/pages/Tunnels.tsx"]) {
  test(`${page}：进页面不预取地球，碰到地球按钮才开始下`, () => {
    const source = read(page);
    assert.doesNotMatch(source, /useEffect\(\(\)\s*=>\s*\{\s*prefetchReactGlobe\(\);?\s*\}/);
    // 地球那格按钮现在由 ViewModeToggle 画：onHover 同时挂到 onPointerEnter 和 onFocus（见 ui/view-mode-toggle.tsx）
    assert.match(source, /onPointerEnter=\{prefetchReactGlobe\}|onHover: prefetchReactGlobe/);
    assert.match(source, /onFocus=\{prefetchReactGlobe\}|onHover: prefetchReactGlobe/);
  });
}

function installedSource(chain: string[]) {
  let resolver = createRequire(path.join(root, "package.json"));
  let resolved = "";
  for (const name of chain) {
    resolved = resolver.resolve(name);
    resolver = createRequire(resolved);
  }
  return fs.readFileSync(resolved, "utf8");
}

test("装上的 three-globe 带着补丁：读默认值、列方法名用的临时实例建完就销毁", () => {
  const source = installedSource(["react-globe.gl", "globe.gl", "three-globe"]);
  const start = source.indexOf("function linkKapsule (kapsulePropName, kapsuleType) {");
  assert.ok(start >= 0, "three-globe 里找不到 linkKapsule，库结构变了，补丁要重看");
  const linkBody = source.slice(start, source.indexOf("return {", start));
  assert.match(linkBody, /var dummyK = new kapsuleType\(\);/);
  assert.match(linkBody, /dummyK\._destructor && dummyK\._destructor\(\);/);

  const fromStart = source.indexOf("function fromKapsule (kapsule) {");
  assert.ok(fromStart >= 0, "three-globe 里找不到 fromKapsule，库结构变了，补丁要重看");
  const fromBody = source.slice(fromStart, source.indexOf("return Globe;", fromStart));
  assert.doesNotMatch(fromBody, /Object\.keys\(kapsule\(\)\)/, "列方法名的临时实例又变回没人销毁的写法了");
  assert.match(fromBody, /methodLister\._destructor && methodLister\._destructor\(\);/);
});

test("装上的 globe.gl 带着补丁：没挂载的地球不跑动画，挂载时才恢复", () => {
  const source = installedSource(["react-globe.gl", "globe.gl"]);
  assert.match(source, /var globe = new ThreeGlobe\([\s\S]{0,200}?\)\);[\s\S]{0,800}?globe\.pauseAnimation\(\);\s*return \{/);
  assert.match(source, /state\.globe\.resumeAnimation\(\);[^\n]*\n\s*this\._animationCycle\(\);\s*\}\s*\}\);/);
});
