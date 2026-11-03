import assert from "node:assert/strict";
import test from "node:test";
import { replaceEqualDeep } from "@tanstack/react-query";

import { reuseStableRows, sameDataDeep } from "./stableRows";

/*
  规则页、主机页 memo 的卡片能不能比得上，第一步是「没变的那一行还是同一个对象」。
  React Query 自己的结构共享对 Date 无能为力（superjson 每轮还原出新的 Date），这里守着补上的那一层。
*/
const fetchRules = (bytes: number) => [
  { id: 1, name: "a", createdAt: new Date("2026-01-01T00:00:00Z"), egress: { type: "none" }, sniNames: "[]" },
  { id: 2, name: "b", createdAt: new Date("2026-01-02T00:00:00Z"), egress: { type: "none" }, quotaUsedIn: bytes },
  { id: 3, name: "c", createdAt: new Date("2026-01-03T00:00:00Z"), members: [{ hostId: 7 }] },
];
const key = (row: { id: number }) => row.id;

test("sameDataDeep：Date 按时间比，普通对象 / 数组逐项比", () => {
  assert.equal(sameDataDeep(new Date(5), new Date(5)), true);
  assert.equal(sameDataDeep(new Date(5), new Date(6)), false);
  assert.equal(sameDataDeep({ a: [1, { b: new Date(1) }] }, { a: [1, { b: new Date(1) }] }), true);
  assert.equal(sameDataDeep({ a: 1 }, { a: 1, b: undefined }), false);
  assert.equal(sameDataDeep([1, 2], [1, 2, 3]), false);
  assert.equal(sameDataDeep(Number.NaN, Number.NaN), true);
});

test("React Query 的结构共享单靠自己：带 Date 的行每轮都是新对象（所以才要这一层）", () => {
  const first = fetchRules(10);
  const second = replaceEqualDeep(first, fetchRules(10));
  assert.notEqual(second, first);
  assert.notEqual(second[0], first[0]);
});

test("一条规则变了：只有它换了对象，别的沿用上一轮；全都没变连数组都是上一轮的", () => {
  const round1 = reuseStableRows<ReturnType<typeof fetchRules>[number]>(null, replaceEqualDeep(undefined, fetchRules(10)), key);
  const round2 = reuseStableRows(round1, replaceEqualDeep(round1.rows, fetchRules(10)), key);
  assert.equal(round2.rows, round1.rows, "内容全一样：同一个数组");

  const round3 = reuseStableRows(round2, replaceEqualDeep(round2.rows, fetchRules(99)), key);
  assert.notEqual(round3.rows, round2.rows);
  assert.equal(round3.rows[0], round2.rows[0]);
  assert.notEqual(round3.rows[1], round2.rows[1], "变了的那条是新对象");
  assert.equal(round3.rows[1].quotaUsedIn, 99);
  assert.equal(round3.rows[2], round2.rows[2]);

  // 顺序变了：行还是旧对象，数组是新的
  const reordered = reuseStableRows(round3, [...fetchRules(99)].reverse(), key);
  assert.notEqual(reordered.rows, round3.rows);
  assert.equal(reordered.rows[2], round3.rows[0]);
});
