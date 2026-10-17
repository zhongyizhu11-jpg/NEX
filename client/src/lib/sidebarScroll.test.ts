import assert from "node:assert/strict";
import test from "node:test";
import { createSidebarScrollMemory } from "./sidebarScroll";

test("换页后回到上次的滚动位置；菜单还没补齐时不拿夹小的位置覆盖", () => {
  const remember = createSidebarScrollMemory();
  const first = { scrollTop: 0 };
  const a = remember(first, "1:desktop");
  a.interrupt();
  first.scrollTop = 320;
  a.save();

  // 新挂载的侧栏：内容还没长全，scrollTop 被夹到 100
  let max = 100;
  const second = { get scrollTop() { return this._v; }, set scrollTop(v: number) { this._v = Math.min(v, max); }, _v: 0 } as any;
  const b = remember(second, "1:desktop");
  b.restore();
  assert.equal(second.scrollTop, 100);
  b.save();
  max = 1000;
  b.restore();
  assert.equal(second.scrollTop, 320, "补齐后还能还原到 320");

  // 不同形态 / 账号各记各的
  const other = { scrollTop: 0 };
  remember(other, "1:mobile").restore();
  assert.equal(other.scrollTop, 0);
});

test("用户自己滚了就不再往回拉", () => {
  const remember = createSidebarScrollMemory();
  const el = { scrollTop: 0 };
  const a = remember(el, "k");
  a.interrupt();
  el.scrollTop = 500;
  a.save();
  const el2 = { scrollTop: 0 };
  const b = remember(el2, "k");
  b.interrupt();
  el2.scrollTop = 40;
  b.restore();
  assert.equal(el2.scrollTop, 40);
});
