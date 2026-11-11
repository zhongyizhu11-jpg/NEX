import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { MotionGlobalConfig } from "motion/react";
import { applyMotionAttribute, applyRememberedMotion, isMotionAttributeOff, readRememberedMotion, rememberMotion, MOTION_STORAGE_KEY } from "./uiMotion";

/** 只要 setAttribute / removeAttribute / getAttribute 的假 <html>。 */
function fakeRoot() {
  const attributes = new Map<string, string>();
  return {
    attributes,
    setAttribute: (name: string, value: string) => { attributes.set(name, value); },
    removeAttribute: (name: string) => { attributes.delete(name); },
    getAttribute: (name: string) => attributes.get(name) ?? null,
  };
}

function fakeStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

test("关掉界面动画：<html data-motion=\"off\">，motion 的动画也全局跳过；打开时两样都撤掉", () => {
  const root = fakeRoot();
  applyMotionAttribute(false, root);
  assert.equal(root.getAttribute("data-motion"), "off");
  assert.equal(isMotionAttributeOff(root), true);
  assert.equal(MotionGlobalConfig.skipAnimations, true);
  applyMotionAttribute(true, root);
  assert.equal(root.getAttribute("data-motion"), null);
  assert.equal(isMotionAttributeOff(root), false);
  assert.equal(MotionGlobalConfig.skipAnimations, false);
});

test("第一帧按本机记住的值：只有明确记成 off 才关，读不到存储也按开", () => {
  const storage = fakeStorage();
  assert.equal(readRememberedMotion(storage), true);
  rememberMotion(false, storage);
  assert.equal(storage.values.get(MOTION_STORAGE_KEY), "off");
  const root = fakeRoot();
  applyRememberedMotion(root, storage);
  assert.equal(root.getAttribute("data-motion"), "off");
  rememberMotion(true, storage);
  applyRememberedMotion(root, storage);
  assert.equal(root.getAttribute("data-motion"), null);
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assert.equal(readRememberedMotion(broken), true);
  assert.doesNotThrow(() => rememberMotion(false, broken));
  applyMotionAttribute(true, root);
});

test("启动时挂上记住的值、样式表里有全局关动画的规则、页内切换也认这个开关", () => {
  const src = path.resolve(import.meta.dirname, "..");
  const main = fs.readFileSync(path.join(src, "main.tsx"), "utf8");
  assert.ok(main.indexOf("applyRememberedMotion();") > 0 && main.indexOf("applyRememberedMotion();") < main.indexOf("createRoot("), "createRoot 之前就挂上");
  const css = fs.readFileSync(path.join(src, "index.css"), "utf8");
  assert.match(css, /html\[data-motion="off"\] \*,[^{]*\{[^}]*transition-duration: 0\.01ms !important;[^}]*animation-duration: 0\.01ms !important|html\[data-motion="off"\] \*,[^{]*\{[^}]*animation-duration: 0\.01ms !important;[^}]*transition-duration: 0\.01ms !important/);
  const section = fs.readFileSync(path.join(src, "components", "SectionTransition.tsx"), "utf8");
  assert.match(section, /useMotionEnabled\(\)/);
  const layer = fs.readFileSync(path.join(src, "components", "LayoutLayer.tsx"), "utf8");
  assert.match(layer, /applyMotionAttribute\(motionEnabled\)/);
  assert.match(layer, /rememberMotion\(motionEnabled\)/);
});
