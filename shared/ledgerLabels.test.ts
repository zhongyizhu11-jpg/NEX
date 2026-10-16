import assert from "node:assert/strict";
import test from "node:test";

import {
  balanceTypeLabel,
  quotaSourceLabel,
  subscriptionSourceLabel,
  subscriptionStatusLabel,
} from "./ledgerLabels";

/**
 * 这几组文案是**同一条记录在不同页面上的名字**。
 *
 * 它们出过真事：`subscriptionSourceLabel` 一度有三份，`source='admin'` 在服务端
 * 通知里叫「管理员分配」、在「我的套餐」里叫「后台分配」；`payment` 在用户管理页
 * 叫「在线支付」、别处叫「在线购买」。一笔钱、一条订阅在两个地方两个名字，比叫错
 * 更让人不敢信 —— 人会开始怀疑是不是两笔。
 *
 * 所以这一组不测「好不好听」，只钉死**口径唯一**：每个键只有一个答案，且认不出来
 * 的值按各自的规矩兜底。
 */

test("订阅来源：每个键只有一个名字", () => {
  assert.equal(subscriptionSourceLabel("admin"), "管理员分配");
  assert.equal(subscriptionSourceLabel("payment"), "在线购买");
  assert.equal(subscriptionSourceLabel("redeem"), "兑换套餐");
  assert.equal(subscriptionSourceLabel("balance"), "余额购买");
});

test("余额流水类型：每个键只有一个名字", () => {
  assert.equal(balanceTypeLabel("admin_recharge"), "管理员充值");
  assert.equal(balanceTypeLabel("admin_adjust"), "管理员修改");
  assert.equal(balanceTypeLabel("payment"), "在线充值入账");
  assert.equal(balanceTypeLabel("purchase"), "余额消费");
  assert.equal(balanceTypeLabel("redeem"), "兑换入账");
  assert.equal(balanceTypeLabel("traffic_billing"), "流量计费");
  assert.equal(balanceTypeLabel("traffic_addon_purchase"), "购买附加流量");
  assert.equal(balanceTypeLabel("referral_commission"), "邀请返利");
});

test("订阅状态：每个键只有一个名字", () => {
  assert.equal(subscriptionStatusLabel("active"), "生效中");
  assert.equal(subscriptionStatusLabel("expired"), "已过期");
  assert.equal(subscriptionStatusLabel("cancelled"), "已取消");
});

test("额度来源：每个键只有一个名字", () => {
  assert.equal(quotaSourceLabel("manual"), "手工额度");
  assert.equal(quotaSourceLabel("addon"), "已购附加流量");
  assert.equal(quotaSourceLabel("grant"), "管理员加赠");
  assert.equal(quotaSourceLabel("plan"), "套餐额度");
});

test("认不出来的值，各按各的规矩兜底", () => {
  /*
    两种兜底是有意分开的：
    - 流水类型和订阅来源**原样显示**。这两列将来可能加新类型，把一个没见过的
      类型吞成一句「余额变动」等于把唯一的线索抹掉，出了账务疑问就查不下去。
    - 额度来源回「套餐额度」。这一列的取值是面板自己定的枚举、不是用户填的，
      出现新值只可能是版本没对齐，那时候按最常见的那种说更不容易误导。
  */
  assert.equal(balanceTypeLabel("some_new_type"), "some_new_type");
  assert.equal(subscriptionSourceLabel("some_new_source"), "some_new_source");
  assert.equal(subscriptionStatusLabel("weird"), "weird");
  assert.equal(quotaSourceLabel("weird"), "套餐额度");
});

test("空值不显示成 null 或 undefined", () => {
  assert.equal(balanceTypeLabel(null), "余额变动");
  assert.equal(balanceTypeLabel(undefined), "余额变动");
  assert.equal(subscriptionSourceLabel(""), "套餐变更");
  assert.equal(subscriptionStatusLabel(null), "-");
  assert.equal(quotaSourceLabel(undefined), "套餐额度");
});
