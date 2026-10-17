import assert from "node:assert/strict";
import test from "node:test";

import {
  buildInviteLink,
  computeCommissionCents,
  evaluateReferralCommission,
  formatRateBps,
  generateInviteCode,
  INVITE_CODE_ALPHABET,
  maskUsername,
  normalizeInviteCode,
  parseRatePercentToBps,
  readInviteCodeFromSearch,
  type ReferralCommissionInput,
} from "./referral";

test("返利比例：百分比字符串 ↔ 基点，按字符串换算，不走浮点", () => {
  assert.equal(parseRatePercentToBps(""), 0, "空着就是不返");
  assert.equal(parseRatePercentToBps("0"), 0);
  assert.equal(parseRatePercentToBps("5"), 500);
  assert.equal(parseRatePercentToBps("12.5"), 1250);
  assert.equal(parseRatePercentToBps("12.34"), 1234);
  assert.equal(parseRatePercentToBps("0.07"), 7, "Number('0.07') * 100 不是整数，这里必须正好是 7");
  assert.equal(parseRatePercentToBps("0.29"), 29, "0.29 * 100 = 28.999999999999996，截断会少一个基点");
  assert.equal(parseRatePercentToBps(" 100 "), 10000);
  assert.equal(parseRatePercentToBps("100.00"), 10000);
  assert.equal(parseRatePercentToBps("12."), 1200);
  for (const bad of ["100.01", "101", "-1", "1.234", "1e2", "abc", "12,5", "."]) {
    assert.equal(parseRatePercentToBps(bad), null, bad);
  }

  assert.equal(formatRateBps(0), "0");
  assert.equal(formatRateBps(7), "0.07");
  assert.equal(formatRateBps(1205), "12.05");
  assert.equal(formatRateBps(1250), "12.5");
  assert.equal(formatRateBps(1000), "10");
  assert.equal(formatRateBps(10000), "100");
  assert.equal(formatRateBps(-5), "0", "脏值按 0");
  for (let bps = 0; bps <= 10000; bps += 1) {
    assert.equal(parseRatePercentToBps(formatRateBps(bps)), bps, `往返一圈要回到原值：${bps}`);
  }
});

test("返利金额：实付 × 比例 / 10000，向下取整到分", () => {
  assert.equal(computeCommissionCents(999, 1050), 104, "104.895 → 104");
  assert.equal(computeCommissionCents(1000, 1000), 100);
  assert.equal(computeCommissionCents(1, 9999), 0, "不足一分就是 0");
  assert.equal(computeCommissionCents(4321, 1234), 533);
  assert.equal(computeCommissionCents(100_000_000, 10000), 100_000_000);
  assert.equal(computeCommissionCents(0, 5000), 0);
  assert.equal(computeCommissionCents(-100, 5000), 0, "负数不返");
  assert.equal(computeCommissionCents(1.5, 5000), 0, "金额不是整数分就不算");
  assert.equal(computeCommissionCents(1000, 0), 0);
  assert.equal(computeCommissionCents(1000, 20000), 1000, "比例封顶 100%");
  assert.equal(computeCommissionCents(9_007_199_254_740_991, 3), 2_702_159_776_422, "大金额也不丢精度");
});

const base: ReferralCommissionInput = {
  enabled: true,
  mode: "first",
  inviteeId: 3,
  inviterId: 2,
  inviterActive: true,
  rateBps: 1000,
  baseAmountCents: 1000,
  currency: "CNY",
  hasPriorPaidOrder: false,
};

test("返不返：每一种「不返」都有自己的理由", () => {
  assert.deepEqual(evaluateReferralCommission(base), { eligible: true, commissionCents: 100, rateBps: 1000 });
  const reasonOf = (patch: Partial<ReferralCommissionInput>) => {
    const decision = evaluateReferralCommission({ ...base, ...patch });
    return decision.eligible ? "eligible" : decision.reason;
  };
  assert.equal(reasonOf({ enabled: false }), "disabled");
  assert.equal(reasonOf({ inviterId: null }), "no_inviter");
  assert.equal(reasonOf({ inviterId: 0 }), "no_inviter");
  assert.equal(reasonOf({ inviterId: 3 }), "self", "邀请人不能是自己");
  assert.equal(reasonOf({ inviterActive: false }), "inviter_inactive");
  assert.equal(reasonOf({ rateBps: 0 }), "rate_zero");
  assert.equal(reasonOf({ baseAmountCents: 0 }), "free");
  assert.equal(reasonOf({ currency: "USD" }), "non_cny", "Stripe 非人民币单不返");
  assert.equal(reasonOf({ currency: "cny" }), "eligible", "币种大小写不敏感");
  assert.equal(reasonOf({ currency: null }), "eligible", "没写币种按人民币（余额购买）");
  assert.equal(reasonOf({ baseAmountCents: 9, rateBps: 1000 }), "zero_commission");
});

test("首单 / 每单：首单模式只返第一次，每单模式次次返", () => {
  const first = evaluateReferralCommission({ ...base, mode: "first", hasPriorPaidOrder: true });
  assert.equal(first.eligible, false);
  assert.equal(first.eligible ? "" : first.reason, "first_only");
  const recurring = evaluateReferralCommission({ ...base, mode: "recurring", hasPriorPaidOrder: true });
  assert.equal(recurring.eligible, true);
});

test("绑定邀请人之前下的单：首单、每单模式都不返", () => {
  for (const mode of ["first", "recurring"] as const) {
    const decision = evaluateReferralCommission({ ...base, mode, orderedBeforeInviterBound: true });
    assert.equal(decision.eligible ? "" : decision.reason, "before_binding", mode);
  }
});

test("邀请码：去掉易混字符、大小写不敏感、链接里 invite / ref 都认", () => {
  for (const ch of ["0", "O", "1", "I", "L"]) assert.equal(INVITE_CODE_ALPHABET.includes(ch), false, ch);
  let counter = 0;
  const code = generateInviteCode((size) => Uint8Array.from({ length: size }, () => counter++ % 256));
  assert.match(code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
  // 全是会被拒绝采样丢掉的字节时也要能出码（换一批随机数再取）。
  let calls = 0;
  const fromRejected = generateInviteCode((size) => {
    calls += 1;
    return Uint8Array.from({ length: size }, () => (calls === 1 ? 255 : 0));
  });
  assert.equal(fromRejected, "AAAAAAAA");

  assert.equal(normalizeInviteCode(" abcd-2345 "), "ABCD2345");
  assert.equal(normalizeInviteCode("ABCD234"), null, "长度不对");
  assert.equal(normalizeInviteCode("ABCD2340"), null, "含易混字符 0");
  assert.equal(normalizeInviteCode(undefined), null);
  assert.equal(readInviteCodeFromSearch("?mode=register&invite=abcd2345"), "ABCD2345");
  assert.equal(readInviteCodeFromSearch("mode=register&ref=ABCD2345"), "ABCD2345");
  assert.equal(readInviteCodeFromSearch("?invite=bad&ref=ABCD2345"), "ABCD2345");
  assert.equal(readInviteCodeFromSearch("?mode=register"), null);
  assert.equal(buildInviteLink("https://panel.example.com/", "ABCD2345"), "https://panel.example.com/login?mode=register&invite=ABCD2345");
});

test("被邀请人打码：只留本地部分首尾", () => {
  assert.equal(maskUsername("alice@example.com"), "a***e");
  assert.equal(maskUsername("ab"), "a***b");
  assert.equal(maskUsername("a@x.com"), "a***");
  assert.equal(maskUsername(""), "***");
  assert.equal(maskUsername(null), "***");
});
