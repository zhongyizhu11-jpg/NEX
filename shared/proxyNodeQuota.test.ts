import assert from "node:assert/strict";
import test from "node:test";

import {
  formatBandwidthMbps,
  formatProxyNodeQuotaDetail,
  formatProxyNodeQuotaLabeled,
  formatProxyNodeQuotaUsedFirst,
  formatQuotaBytes,
  normalizeProxyNodeResetDay,
  proxyNodeQuotaPercent,
  proxyNodeQuotaState,
} from "./proxyNodeQuota";

const GB = 1e9;

test("带宽按机房口径写，没填显示破折号", () => {
  assert.equal(formatBandwidthMbps(500), "500M");
  assert.equal(formatBandwidthMbps(1000), "1G");
  assert.equal(formatBandwidthMbps(2500), "2.5G");
  // 10G 不该写成 10.0G。
  assert.equal(formatBandwidthMbps(10000), "10G");
  assert.equal(formatBandwidthMbps(0), "—");
  assert.equal(formatBandwidthMbps(-1), "—");
  assert.equal(formatBandwidthMbps(Number.NaN), "—");
});

test("流量按 1000 进制换算，跟机房卖的套餐对得上", () => {
  /**
   * 这条是刻意的：机房的「1000G」是按 1000 算的。按 1024 换算会显示成 931G，
   * 跟你买的套餐对不上号，看着像面板算错了 —— 然后你会去查一个不存在的 bug。
   */
  // 满 1T 就写成 T —— 比 1000G 短，节点行那一栏本来就窄。
  assert.equal(formatQuotaBytes(1000 * GB), "1T");
  assert.equal(formatQuotaBytes(367 * GB), "367G");
  assert.equal(formatQuotaBytes(1.5 * GB), "1.5G");
  assert.equal(formatQuotaBytes(2e12), "2T");
  assert.equal(formatQuotaBytes(1.5e12), "1.5T");
  assert.equal(formatQuotaBytes(10e12), "10T");
  // 不满 1T 的仍然按 G 显示。
  assert.equal(formatQuotaBytes(999 * GB), "999G");
  assert.equal(formatQuotaBytes(0), "0");
});

test("不到 1M 的用量显示成 <1M，不四舍五入成 1M", () => {
  // 套餐按 G 卖，几百字节等于没用；写成「1M」会让人以为真跑了 1MB。
  assert.equal(formatQuotaBytes(100), "<1M");
  assert.equal(formatQuotaBytes(999_999), "<1M");
  assert.equal(formatQuotaBytes(1e6), "1M");
  // 0 就是 0，不写成 0G。
  assert.equal(formatQuotaBytes(0), "0");
});

test("大于 100 的数不带小数", () => {
  // 367.4G 这种精度没有意义，还会让列宽跳来跳去。
  assert.equal(formatQuotaBytes(367.4 * GB), "367G");
  assert.equal(formatQuotaBytes(99.9 * GB), "99.9G");
});

test("百分比在没设总量时是 0，而不是除以零", () => {
  assert.equal(proxyNodeQuotaPercent({ bandwidthMbps: 0, trafficLimit: 0, trafficUsed: 5 * GB }), 0);
  assert.equal(proxyNodeQuotaState({ bandwidthMbps: 0, trafficLimit: 0, trafficUsed: 5 * GB }), "none");
});

test("用量状态分成 正常 / 预警 / 超额", () => {
  const quota = (used: number) => ({ bandwidthMbps: 0, trafficLimit: 1000 * GB, trafficUsed: used });
  assert.equal(proxyNodeQuotaState(quota(100 * GB)), "normal");
  // 79.9% 不该因为显示取整就提前变黄。
  assert.equal(proxyNodeQuotaState(quota(799 * GB)), "normal");
  assert.equal(proxyNodeQuotaState(quota(999 * GB)), "warn");
  assert.equal(proxyNodeQuotaState(quota(800 * GB)), "warn");
  assert.equal(proxyNodeQuotaState(quota(1000 * GB)), "exceeded");
  assert.equal(proxyNodeQuotaState(quota(1500 * GB)), "exceeded");
});

test("百分比有上限，超额再多也不会撑爆界面", () => {
  const percent = proxyNodeQuotaPercent({ bandwidthMbps: 0, trafficLimit: 1e6, trafficUsed: 1e15 });
  assert.equal(percent, 999);
});

test("负的已用量按 0 算", () => {
  // 手工校准填了个负数不该变成负百分比。
  assert.equal(proxyNodeQuotaPercent({ bandwidthMbps: 0, trafficLimit: 1000 * GB, trafficUsed: -5 }), 0);
});

test("重置日收敛到 1-31", () => {
  /**
   * 29/30/31 照收。它们在二月不存在，但触发判断会拿当月天数夹一下（见
   * shared/monthlyResetDay.test.ts），所以「每月 31 号」在二月就是月末。
   *
   * 早先这里卡在 28，是怕落在不存在的日子上会整月不触发。那个担心是对的，
   * 但该修的是触发判断，不是不让人填 —— 机房按月末结算太常见了。
   */
  assert.equal(normalizeProxyNodeResetDay(31), 31);
  assert.equal(normalizeProxyNodeResetDay(29), 29);
  assert.equal(normalizeProxyNodeResetDay(32), 31, "超出上限往回夹，不是丢掉");
  assert.equal(normalizeProxyNodeResetDay(0), 1);
  assert.equal(normalizeProxyNodeResetDay(-5), 1);
  assert.equal(normalizeProxyNodeResetDay(15), 15);
  assert.equal(normalizeProxyNodeResetDay("7"), 7);
  assert.equal(normalizeProxyNodeResetDay(undefined), 1);
});

test("展开行只给数字，不写标签 —— 写了会被截断，最想看的已用量反而没了", () => {
  assert.equal(
    formatProxyNodeQuotaDetail({ bandwidthMbps: 1000, trafficLimit: 10e12, trafficUsed: 33.2e6 }),
    "1G / 10T / 33.2M · 0%",
  );
  assert.equal(
    formatProxyNodeQuotaDetail({ bandwidthMbps: 500, trafficLimit: 1000 * GB, trafficUsed: 367 * GB }),
    "500M / 1T / 367G · 37%",
  );
});

test("缺的那一段用破折号占位，三个数的位置才对得齐", () => {
  // 顺序固定为 带宽 / 总流量 / 已用；省略会让人数不清第几个是第几个。
  assert.equal(
    formatProxyNodeQuotaDetail({ bandwidthMbps: 0, trafficLimit: 0, trafficUsed: 12 * GB }),
    "\u2014 / \u2014 / 12G",
  );
});

test("没设总流量就不给百分比 —— 没有分母", () => {
  const text = formatProxyNodeQuotaDetail({ bandwidthMbps: 500, trafficLimit: 0, trafficUsed: 5 * GB });
  assert.doesNotMatch(text, /%/);
});

test("带标签的写法留给悬停说明，那里不缺地方", () => {
  // 手机上靠固定顺序认，桌面端鼠标一停就能知道哪个是哪个。
  assert.equal(
    formatProxyNodeQuotaLabeled({ bandwidthMbps: 500, trafficLimit: 1000 * GB, trafficUsed: 367 * GB }),
    "带宽 500M · 总流量 1T · 已用 367G（37%）",
  );
  // 带标签那一版是散文式的，缺项直接不出现而不是占位。
  assert.equal(
    formatProxyNodeQuotaLabeled({ bandwidthMbps: 0, trafficLimit: 0, trafficUsed: 12 * GB }),
    "已用 12G",
  );
});


/**
 * 展开那一行的顺序。手机上放不下，会被截断 —— 所以最要紧的那个数必须排在最前面，
 * 否则截断正好切掉唯一有用的部分。
 */
test("展开那一行把已用排在最前，截断也先看见它", () => {
  const line = formatProxyNodeQuotaUsedFirst({
    bandwidthMbps: 2000,
    trafficLimit: 100e9,
    trafficUsed: 92e9,
  });
  assert.ok(line.startsWith("已用 "), `已用必须排第一，实际是「${line}」`);
  assert.match(line, /92%/, "百分比要跟已用在一起，别被甩到后面去");
  assert.ok(
    line.indexOf("已用") < line.indexOf("带宽"),
    "带宽是三个数里最不常看的那个，排最后",
  );
});

test("没设总量就没有分母，也就没有百分比", () => {
  const line = formatProxyNodeQuotaUsedFirst({ bandwidthMbps: 0, trafficLimit: 0, trafficUsed: 5e9 });
  assert.ok(!line.includes("%"), `没额度不该编一个百分比出来：「${line}」`);
  assert.ok(!line.includes("带宽"), "带宽没填就别占位置");
  assert.ok(line.includes("已用"));
});
