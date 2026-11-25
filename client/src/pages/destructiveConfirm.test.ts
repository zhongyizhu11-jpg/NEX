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
  // 调用方拿到的 hook 有的叫 confirm、有的叫 confirmDialog
  const pattern = /\bconfirm(?:Dialog)?\(\{/g;
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

/**
 * 手写的确认弹窗换成了 useConfirmDialog（第二批）：Rules 的删除 / 重置统计、Users 的删除用户 / 移除 2FA /
 * 重置流量 / 取消订阅、AgentTokenManager 删 Token、Telegram 删机器人、DeepSeek 删 Key、Hosts 重置流量 / 升级 Agent。
 *
 * 换掉的原因是 hook 原来没有 pending 态：请求在路上时弹窗要留着、按钮写「删除中...」、成功了才关。
 * 所以这里守两件事：每一处都把请求交给 onConfirm（而不是点了就关再 mutate），
 * 以及按钮上的字含「删除 / 移除 / 重置」的会被认成破坏性语气（或者明说了 tone）。
 * 反向对照：那几个标题不能再以 <DialogTitle> 的形式出现在页面里 —— 出现了说明有人又手写了一个。
 */
for (const [file, title, needle, destructive] of [
  // Rules 的批量删除也叫「删除转发规则」，但它把活交给后台任务（没有 onConfirm），所以按说明那句认
  ["Rules.tsx", "删除转发规则", "确认删除 \"${rule?.name}\"？", true],
  ["Rules.tsx", "重置规则数据", "重置全部规则数据", true],
  ["Users.tsx", "删除用户", "title: \"删除用户\"", true],
  ["Users.tsx", "移除双因素认证", "title: \"移除双因素认证\"", true],
  ["Users.tsx", "重置流量统计", "title: \"重置流量统计\"", true],
  ["Users.tsx", "取消订阅", "title: \"取消订阅\"", true],
  ["Hosts.tsx", "重置流量统计", "title: \"重置流量统计\"", true],
  ["Hosts.tsx", "升级 Agent", "title: \"升级 Agent\"", false],
  ["../components/AgentTokenManager.tsx", "删除 Agent Token", "title: \"删除 Agent Token\"", true],
  ["../components/settings/TelegramBotSettingsCard.tsx", "删除 Telegram 机器人", "title: \"删除 Telegram 机器人\"", true],
  ["../components/settings/DeepSeekSettingsCard.tsx", "删除 AI API Key", "title: \"删除 AI API Key\"", true],
] as const) {
  test(`${file}：「${title}」走 useConfirmDialog，请求交给 onConfirm${destructive ? "，破坏性语气" : ""}`, () => {
    const source = read(file);
    const calls = confirmCallsContaining(source, needle);
    assert.ok(calls.length >= 1, `没找到含「${needle}」的 confirm 调用`);
    for (const call of calls) {
      assert.match(call, /onConfirm: /, `「${title}」的请求没交给 onConfirm：${call.slice(0, 120)}…`);
      const confirmText = /confirmText: "([^"]+)"/.exec(call)?.[1] || "确认";
      const inferredDestructive = /tone: "destructive"/.test(call) || /删除|移除|清空|重置/.test(confirmText);
      assert.equal(inferredDestructive, destructive, `「${title}」的语气不对：confirmText=${confirmText}`);
    }
    assert.doesNotMatch(source, new RegExp(`<DialogTitle[^>]*>\\s*(?:<[^>]+>\\s*)?${title}\\s*</DialogTitle>`), `「${title}」又被手写成了 Dialog`);
  });
}
