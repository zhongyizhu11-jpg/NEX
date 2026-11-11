import assert from "node:assert/strict";
import test from "node:test";

import { apiTokenPolicyError } from "../ops/apiTokenPolicy";
import { apiTokenModuleOfPath } from "../../shared/apiTokenModules";
import { assertShopToken } from "../routers/shopSync";

test("商城回调入口单独一档：只勾「商城对接」的令牌能调回调，调不了别的，也改不了对接设置", () => {
  assert.equal(apiTokenModuleOfPath("shopSync.inbound.push"), "shop");
  assert.equal(apiTokenModuleOfPath("shopSync.save"), "system", "设置归系统设置模块");
  assert.equal(apiTokenPolicyError("full", "shopSync.inbound.push", "mutation", ["shop"]), null);
  assert.ok(apiTokenPolicyError("full", "shopSync.save", "mutation", ["shop"]));
  assert.ok(apiTokenPolicyError("full", "users.listPage", "query", ["shop"]));
  assert.ok(apiTokenPolicyError("read", "shopSync.inbound.push", "mutation", ["shop"]), "只读令牌开不了套餐");
});

test("令牌不能给自己签对接令牌，勾了哪个模块都不行", () => {
  assert.ok(apiTokenPolicyError("full", "shopSync.createToken", "mutation", null));
  assert.ok(apiTokenPolicyError("full", "shopSync.createToken", "mutation", ["system"]));
});

test("回调入口只收勾了「商城对接」的令牌：网页会话、不限模块的万能令牌都拒", () => {
  assert.throws(() => assertShopToken(null), /只给商城用/);
  assert.throws(() => assertShopToken({ id: 1, scope: "full", name: "全能", modules: null }), /没勾「商城对接」/);
  assert.throws(() => assertShopToken({ id: 1, scope: "full", name: "规则", modules: ["rules"] }), /没勾「商城对接」/);
  assert.doesNotThrow(() => assertShopToken({ id: 1, scope: "full", name: "商城对接", modules: ["shop"] }));
});
