import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * 点一下就删、没有确认的操作，这一轮找到两个：套餐管理的垃圾桶（删套餐会连带它绑的主机、
 * 隧道、转发组 —— 没冻结过内容的订阅跟着就没了资源），面板日志的红色「清空日志」。
 *
 * 守在源码上：这两个 mutation 的每一处调用，前面都得是 `if (confirmed) `。以后有人在别处
 * 再加一个「删除」入口直接 .mutate，这里会报出来。
 */
const read = (file: string) => fs.readFileSync(path.resolve(import.meta.dirname, file), "utf8");

function callSites(source: string, mutation: string) {
  const sites: string[] = [];
  const pattern = new RegExp(`${mutation}\\.mutate\\(`, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    sites.push(source.slice(Math.max(0, match.index - 40), match.index));
  }
  return sites;
}

for (const [file, mutation] of [
  ["Plans.tsx", "deletePlan"],
  ["../components/settings/PanelLogsSection.tsx", "clearLogsMutation"],
  ["../components/TrafficBillingConfigManager.tsx", "deleteConfig"],
  ["Billing.tsx", "deleteRedemptionCode"],
  ["Billing.tsx", "deleteDiscountCode"],
  ["Announcements.tsx", "deleteAnnouncement"],
] as const) {
  test(`${file}：${mutation} 只在确认之后调用`, () => {
    const sites = callSites(read(file), mutation);
    // 反向对照：确实找到了调用处，不是因为没有调用才通过
    assert.ok(sites.length >= 1, `${mutation} 应该至少有一处调用`);
    for (const before of sites) {
      assert.match(before, /if \(confirmed\) $/, `调用前没有确认：…${before}`);
    }
  });
}

// 删除按钮在请求进行中要禁用：确认弹窗之后网络慢，连点会发出多个删除请求。
for (const [file, mutation] of [
  ["../components/TrafficBillingConfigManager.tsx", "deleteConfig"],
  ["Billing.tsx", "deleteRedemptionCode"],
  ["Billing.tsx", "deleteDiscountCode"],
  ["Announcements.tsx", "deleteAnnouncement"],
] as const) {
  test(`${file}：${mutation} 进行中时删除按钮禁用`, () => {
    const source = read(file);
    assert.match(source, new RegExp(`(disabled|deleting)=\\{${mutation}\\.isPending\\}`));
    assert.match(source, new RegExp(`if \\(${mutation}\\.isPending\\) return;`));
  });
}
