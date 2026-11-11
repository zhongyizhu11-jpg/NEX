import assert from "node:assert/strict";
import test from "node:test";
import { productStock, productStockText } from "./productStock";

test("库存为 0 表示不限：显示 ∞，卖多少都不会售罄", () => {
  assert.equal(productStockText({ stockLimit: 0, stockUsed: 100 }), "∞");
  assert.equal(productStock({ stockLimit: 0, stockUsed: 100 }).soldOut, false);
  assert.equal(productStock({ stockLimit: 0, stockUsed: 100 }).remaining, null);
  assert.equal(productStockText(undefined), "∞", "老数据没有这两列，也按不限算");
});

test("限量库存显示剩余；卖完是售罄，不会因为算成 0 变回「不限」", () => {
  assert.equal(productStockText({ stockLimit: 5, stockUsed: 2 }), "3");
  assert.equal(productStockText({ stockLimit: 1, stockUsed: 1 }), "0");
  assert.equal(productStock({ stockLimit: 1, stockUsed: 1 }).soldOut, true);
  // 管理员把总量调到比已售还小：剩余按 0，仍是售罄，不出负数。
  assert.equal(productStock({ stockLimit: 2, stockUsed: 5 }).remaining, 0);
  assert.equal(productStock({ stockLimit: 2, stockUsed: 5 }).soldOut, true);
});
