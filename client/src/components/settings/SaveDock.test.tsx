import assert from "node:assert/strict";
import test from "node:test";

import { shouldShowSaveDock } from "./SaveDock";

/*
  设置页贴底保存栏什么时候出现。2026-10-12 用户报的：玫瑰和朱砂下这条栏一直挂在页底，
  写着「改动都已保存」，两个按钮是灰的，点了也不消失。它只该在真的有东西没存时出现。
*/

test("没有未保存的改动就不画这条栏", () => {
  assert.equal(shouldShowSaveDock({ active: true, dirtyCount: 0, busy: false, savedFlash: false }), false);
});

test("有未保存的改动才画", () => {
  assert.equal(shouldShowSaveDock({ active: true, dirtyCount: 1, busy: false, savedFlash: false }), true);
});

test("正在保存、以及存完那一下还留着", () => {
  assert.equal(shouldShowSaveDock({ active: true, dirtyCount: 0, busy: true, savedFlash: false }), true);
  assert.equal(shouldShowSaveDock({ active: true, dirtyCount: 0, busy: false, savedFlash: true }), true);
});

test("别的界面主题下不画", () => {
  assert.equal(shouldShowSaveDock({ active: false, dirtyCount: 3, busy: true, savedFlash: true }), false);
});
