import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { RouteGroupFields } from "./features/rules/RouteGroupFields";
import { applyRouteMode, newRouteGroupDraft, type RouteMode } from "@shared/routeGroup";

/**
 * 「更多设置」折起来的东西，必须是真的可以不看的。
 *
 * 创建转发原来把要填的和可以不管的并排放在同一片方格里：源端口、目标地址、目标端口
 * 旁边就是规则名称、转发工具、异常提醒、主备线路 —— 后四项都有能用的默认值，不动
 * 也能把转发建出来，可它们长得和必填项一模一样。于是每个新手都要当一次选择题：
 * 「转发工具这三个我该选哪个」，而正确答案通常是「别动」。
 *
 * 折叠能解决这个，但折叠也最容易做坏。做坏的三种方式，这一组各钉一条：
 *
 *   · **把必须填的折进去**。用户打不开就交不了表，而他不知道要打开什么。
 *   · **把警告折进去**。警告的全部意义就是被看见，折起来等于删掉。
 *   · **折起来什么都不说**。那叫藏，不叫收纳 —— 折叠条上得挂着里面现在是什么样。
 *
 * 还有第四条在 shared/forwardRuleForm.test.ts：缺口指向折叠里的控件时得自动展开，
 * 否则用户读到一句自己看不见的提示。
 */

const rulesPagePath = path.resolve(import.meta.dirname, "pages/Rules.tsx");

function collapsedSection(source: string): string {
  const start = source.indexOf("{advancedOpen && (");
  assert.notEqual(start, -1, "找不到「更多设置」的折叠块 —— 这条测试锚错了地方");
  const end = source.indexOf("<DialogFooter", start);
  assert.notEqual(end, -1, "折叠块之后找不到对话框的按钮栏");
  const section = source.slice(start, end);
  // 锚点校验：抓空了的话下面的断言会全部空转。
  assert.ok(section.includes("转发工具"), "折叠块里没抓到「转发工具」，范围大概不对");
  assert.ok(section.includes("异常TG提醒"), "折叠块里没抓到「异常TG提醒」，范围大概不对");
  return section;
}

test("主备线路不折进「更多设置」—— 它是用户会专门来找的功能", () => {
  /*
    它原来就在折叠块里，折叠条上还不写它：用户问「主备线路怎么用」，第一步就是
    找不到入口。放在外面、一行一个勾，不勾的时候也只占一行。
  */
  const source = fs.readFileSync(rulesPagePath, "utf8");
  const section = collapsedSection(source);
  assert.equal(section.includes("<RouteGroupFields"), false, "线路组的编辑块又被折进「更多设置」了");
  // 线路组现在自己是一个折叠框（RuleFormCollapsible，testId 落到 data-testid），在「更多设置」外面、前面。
  assert.equal(section.includes('testId="failover-section"'), false);
  const dialogStart = source.indexOf("<DialogTitle>{editingId ?");
  const foldAt = source.indexOf("更多设置</span>");
  const failoverAt = source.indexOf('testId="failover-section"');
  assert.ok(dialogStart > 0 && failoverAt > dialogStart, "编辑框里找不到主备那一块");
  assert.ok(failoverAt < foldAt, "主备那一块应该在「更多设置」折叠条的前面");
});

test("线路组用不了就不显示，除非这条规则已经开着线路组", () => {
  // 转发链、共享 TLS 入站、SS 出口……点不开的折叠框只是噪音；但已经开着的得留着，人才关得掉。
  const source = fs.readFileSync(rulesPagePath, "utf8");
  assert.match(source, /const routeGroupSectionVisible = !mainBackupBlock \|\| form\.failoverEnabled;/);
  const gateAt = source.indexOf("{routeGroupSectionVisible && (");
  const sectionAt = source.indexOf('testId="failover-section"');
  assert.ok(gateAt > 0 && gateAt < sectionAt && sectionAt - gateAt < 400, "线路组折叠框外面没有 routeGroupSectionVisible 这道判断");
});

test("折起来的都是可以不管的 —— 里面不许有必填项", () => {
  const section = collapsedSection(fs.readFileSync(rulesPagePath, "utf8"));
  const required = section.split("\n").filter((line) =>
    /text-destructive">\*/.test(line) || /sourcePortRequired/.test(line));
  assert.deepEqual(
    required,
    [],
    "「更多设置」里出现了必填项：\n" + required.join("\n")
      + "\n折叠默认是收起的：用户交不了表，而他不知道要去打开什么。必填的得留在外面。",
  );
});

test("警告不许折进去 —— 折起来就等于删掉", () => {
  const section = collapsedSection(fs.readFileSync(rulesPagePath, "utf8"));
  for (const marker of ["kernelForwardWarning", "border-amber"]) {
    assert.equal(
      section.includes(marker),
      false,
      `「更多设置」里出现了 ${marker}。警告的全部意义就是被看见，`
        + "默认收起的地方放警告，等于这条警告不存在。",
    );
  }
});

test("折叠条上得说清楚里面现在是什么样", () => {
  const source = fs.readFileSync(rulesPagePath, "utf8");
  /*
    从按钮的那行文字切起，不是从「更多设置」四个字切起 —— 这四个字在上面的注释里
    也出现过，按它切会一路切到文件开头，把定义 advancedSummary 的 useMemo 也圈进来，
    于是这条断言永远成立。第一版就是这么写的，反向验证没红才发现。
  */
  const labelAt = source.indexOf("更多设置</span>");
  assert.notEqual(labelAt, -1, "找不到折叠条上的那行字 —— 这条测试锚错了地方");
  const header = source.slice(labelAt, source.indexOf("{advancedOpen && ("));
  assert.ok(header.includes("ChevronDown"), "切出来的不是折叠条 —— 里面连箭头都没有");
  assert.ok(header.length < 1200, `切出来的范围太大了（${header.length} 字），锚点大概滑了`);
  assert.match(
    header,
    /advancedSummary/,
    "折叠条上没有摘要。折起来看不见里面有什么，那叫藏 —— 用户会为了确认一件事"
      + "反复展开收起，比不折还累。",
  );
});

test("缺口指向折叠里的控件时会自动展开", () => {
  const source = fs.readFileSync(rulesPagePath, "utf8");
  assert.match(
    source,
    /const advancedOpen = showAdvanced \|\| advancedBlocked;/,
    "展开条件不再考虑「缺口在不在折叠里」了。footer 说了缺什么、按钮也灰着，"
      + "而那个控件被折叠藏着 —— 用户读到一句自己看不见的话，比什么都不说更糟。",
  );
  assert.match(source, /isAdvancedSectionBlocker\(submitBlocker\)/);
});

test("时段表编辑器跟着定时 / 混合走，发出去的那一份也按模式归零", () => {
  /*
    时段表只在定时主备、混合策略下生效。界面上可以先配好它、再把模式改成权重负载 —— 这时候
    如果照样把它发上去，服务端会拒绝整次保存，用户看到的是「改个策略而已，怎么报了个
    时段表的错」。一个看着能用的控件把保存弄失败了，是最难受的那种坏法。

    所以两件事都得做到：编辑器只在这两种模式下渲染，提交前按模式归零（routeGroupPayload）。
    缺任何一件，要么控件在那儿骗人，要么保存直接失败。
  */
  const draft = newRouteGroupDraft({ timezone: "Asia/Shanghai" });
  const render = (mode: RouteMode) => renderToStaticMarkup(createElement(RouteGroupFields, {
    value: { ...draft, policy: applyRouteMode(draft.policy, mode, { timezone: "Asia/Shanghai", pathCount: draft.paths.length }) },
    onChange: () => {},
    hosts: [],
    entryHostId: 1,
    mainAddress: "10.0.0.1:80",
    policy: null,
    scheduleTimeZone: "Asia/Shanghai",
    defaultAdvancedOpen: true,
  }));
  assert.match(render("scheduled"), /添加时段/, "定时主备下应当能配时段表");
  assert.match(render("hybrid"), /添加时段/, "混合策略下应当能配时段表");
  assert.doesNotMatch(render("weighted"), /添加时段|第 1 个时段/, "时段表编辑器不再只在定时 / 混合下渲染了");
  assert.doesNotMatch(render("failover"), /添加时段|第 1 个时段/);
  assert.match(
    fs.readFileSync(rulesPagePath, "utf8"),
    /routeGroupPayload\(form\.routeGroup\)/,
    "提交时没有走 routeGroupPayload 按模式归零 —— 换成权重负载之后保存会被服务端拒绝",
  );
});
