import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_MOBILE_LOGIN_CHALLENGES,
  MOBILE_LOGIN_ISSUE_LIMIT_PER_MINUTE,
  consumeMobileTelegramLoginIssue,
  createMobileTelegramLoginChallenge,
  hasMobileTelegramLoginChallenge,
  mobileTelegramLoginChallengeCount,
} from "./telegramMobileLogin";

/**
 * startMobileLogin 是不登录就能调的公开接口，每调一次就挂一个 5 分钟的挑战。
 * 不封顶、不限流的话，一个脚本循环调就能把面板内存撑爆。
 */
test("未完成的手机登录挑战封顶，满了先踢最早的", () => {
  for (let index = 0; index < MAX_MOBILE_LOGIN_CHALLENGES + 50; index += 1) {
    createMobileTelegramLoginChallenge(`APPCAP${index}`, 5 * 60 * 1000);
  }
  assert.equal(mobileTelegramLoginChallengeCount(), MAX_MOBILE_LOGIN_CHALLENGES);
  assert.equal(hasMobileTelegramLoginChallenge("APPCAP0"), false, "最早的被踢掉");
  assert.equal(hasMobileTelegramLoginChallenge(`APPCAP${MAX_MOBILE_LOGIN_CHALLENGES + 49}`), true, "最新的还在");
});

test("同一来源一分钟内发起次数有上限，别的来源不受影响", () => {
  for (let index = 0; index < MOBILE_LOGIN_ISSUE_LIMIT_PER_MINUTE; index += 1) {
    assert.equal(consumeMobileTelegramLoginIssue("203.0.113.7"), 0);
  }
  assert.ok(consumeMobileTelegramLoginIssue("203.0.113.7") > 0, "超过上限要告诉调用方还要等多久");
  assert.equal(consumeMobileTelegramLoginIssue("203.0.113.8"), 0);
  // IPv6 按 /64 归并：同一个 /64 里换地址不能绕过。
  for (let index = 0; index < MOBILE_LOGIN_ISSUE_LIMIT_PER_MINUTE; index += 1) {
    assert.equal(consumeMobileTelegramLoginIssue(`2001:db8:1:2::${index + 1}`), 0);
  }
  assert.ok(consumeMobileTelegramLoginIssue("2001:db8:1:2::ffff") > 0);
});
