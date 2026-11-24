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

/**
 * 删除、重置这类回不了头的确认，tone 要是 destructive：桌面版按钮变红、手机操作表那一行用红字，
 * 用户在按下去之前就看得出「这个不一样」。原来这几处和「保存」用同一个默认样子。
 *
 * 按确认框的标题（或说明里的一句）找到那次 confirm({...}) 调用，看它的参数里有没有 tone。
 */
function confirmCallsContaining(source: string, needle: string) {
  const calls: string[] = [];
  const pattern = /\bconfirm\(\{/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    // 从 `{` 起数括号，取到配对的 `}` 为止：参数对象里可能嵌着模板串和三元表达式
    let depth = 0;
    let index = match.index + match[0].length - 1;
    for (; index < source.length; index += 1) {
      if (source[index] === "{") depth += 1;
      else if (source[index] === "}") { depth -= 1; if (depth === 0) break; }
    }
    const call = source.slice(match.index, index + 1);
    if (call.includes(needle)) calls.push(call);
  }
  return calls;
}

for (const [file, needle] of [
  ["AdminSubscriptions.tsx", "重置这条地址？"],
  ["AdminSubscriptions.tsx", "删除这条地址？"],
  ["AdminSubscriptions.tsx", "删除模板「"],
  ["ClientSubscriptions.tsx", "重置这个订阅地址？"],
  ["ClientSubscriptions.tsx", "删除这个订阅链接？"],
  ["ClientSubscriptions.tsx", "删除这个客户端节点？"],
  ["../components/proxy/ProxySubSourcesSection.tsx", "它同步来的节点会一起删掉"],
] as const) {
  test(`${file}：「${needle}」的确认框是破坏性语气`, () => {
    const calls = confirmCallsContaining(read(file), needle);
    // 反向对照：确实找到了那次确认，不是因为找不到才通过
    assert.ok(calls.length >= 1, `没找到含「${needle}」的 confirm 调用`);
    for (const call of calls) {
      assert.match(call, /tone: "destructive"/, `确认框少了 tone: "destructive"：${call.slice(0, 120)}…`);
    }
  });
}
