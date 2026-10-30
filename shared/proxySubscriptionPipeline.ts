/**
 * 订阅渲染流水线：把「取出来的原料」变成「发给客户端的正文」。
 *
 *   plan（转发 × 模板 × 主机算出的条目）
 *     → 令牌作用域过滤
 *     → 条目处理器（命名模板、旗帜、前缀、改名、去重、排序、字段覆盖）
 *     → 组装文档（去重名、自动组、地区组、模板里的自定义组、分类组、预设规则）
 *     → 自定义规则（全局前置 / 用户 / 令牌 / 全局后置）插进规则列表
 *     → 信息节点
 *     → 渲染（格式 + 模板开头 + 客户端能力门控 + 可调参数）
 *
 * 纯函数：服务端路由和界面上的「预览」都走它，两边看到的必须是同一份。
 */

import { PROXY_RULE_TARGET_DIRECT, PROXY_RULE_TARGET_REJECT, type ProxyRouteRule, type ProxyRulePreset } from "./proxyRuleset";
import type { DetectedProxyClient } from "./proxyClientUserAgent";
import { formatBytes } from "./formatBytes";
import {
  renderProxySubscription,
  PROXY_SUBSCRIPTION_GROUP_NAME,
  type ProxySubscriptionFormat,
  type ProxySubRenderSettings,
} from "./proxySubscription";
import {
  buildProxySubscriptionDocument,
  type ProxyNodeTemplateRow,
  type ProxySubCustomGroup,
  type ProxySubscriptionDocument,
  type ProxySubscriptionPlan,
} from "./proxySubscriptionPlan";
import { customRulesToRouteRules, parseProxyCustomRules } from "./proxySubCustomRules";
import { buildProxySubInfoNodes, runProxySubEntryProcessors, type ProxySubInfoNodeInput } from "./proxySubProcessors";
import type { ProxySubSettings } from "./proxySubSettings";
import { renderProxySubTemplatePrelude, PROXY_SUB_BUILTIN_PRELUDES, proxySubTemplateTargetForFormat, type ProxySubTemplate } from "./proxySubTemplates";
import { resolveTriState, type ProxySubTokenOptions, type ProxySubTokenScope } from "./proxySubTokenScope";
import type { ProxyNode } from "./proxyNode";
import type { ProxySubUnlockStatusMap } from "./proxySubUnlock";

export type ProxySubPipelineInput = {
  plan: ProxySubscriptionPlan;
  templates: readonly ProxyNodeTemplateRow[];
  rulePreset: ProxyRulePreset;
  scope: ProxySubTokenScope;
  options: ProxySubTokenOptions;
  settings: ProxySubSettings;
  /** 用户级自定义规则文本（管理员给这个用户写的）。 */
  userCustomRules?: string;
  /** 选中的模板；没有就用内置的开头部分。 */
  template?: Pick<ProxySubTemplate, "prelude" | "customGroups"> | null;
  /** 信息节点要显示的数字；不传 = 不插信息节点。 */
  info?: ProxySubInfoNodeInput | null;
  /** 模板占位符要用的值。 */
  vars: { appName: string; panelUrl: string; subUrl: string; username: string };
  /** 透传的外部订阅（provider 模式的来源）。 */
  providers?: readonly { name: string; url: string; intervalSec: number }[];
  /** 出口主机最新的解锁检测结论（服务端按条目的 exitHostId 批量查好），见 shared/proxySubUnlock.ts。 */
  unlockStatuses?: ProxySubUnlockStatusMap | null;
};

export type ProxySubPipelineDocument = {
  document: ProxySubscriptionDocument;
  /** 处理器跑完之后的 plan（预览界面要显示的那份）。 */
  plan: ProxySubscriptionPlan;
  infoNodes: ProxyNode[];
  customGroups: ProxySubCustomGroup[];
  /** 自定义规则里解析失败的行（三处合在一起）。 */
  customRuleErrors: Array<{ scope: "global-prepend" | "user" | "token" | "global-append"; line: number; message: string }>;
};

/** 自定义规则插在哪：前置的排在预设规则前面（命中即止），后置的排在 MATCH 前面。 */
function spliceCustomRules(rules: readonly ProxyRouteRule[], prepend: readonly ProxyRouteRule[], append: readonly ProxyRouteRule[]): ProxyRouteRule[] {
  const matchIndex = rules.findIndex((rule) => rule.type === "match");
  const body = matchIndex >= 0 ? rules.slice(0, matchIndex) : [...rules];
  const tail = matchIndex >= 0 ? rules.slice(matchIndex) : [];
  return [...prepend, ...body, ...append, ...tail];
}

/** 第一步到第五步：出文档。渲染拆开是为了预览界面只要文档不要正文。 */
export function buildProxySubPipelineDocument(input: ProxySubPipelineInput): ProxySubPipelineDocument {
  const plan = runProxySubEntryProcessors(input.plan, { scope: input.scope, options: input.options, settings: input.settings });
  const customGroups = input.template?.customGroups || [];
  const document = buildProxySubscriptionDocument(plan, input.templates, {
    mainGroupName: PROXY_SUBSCRIPTION_GROUP_NAME,
    rulePreset: input.rulePreset,
    regionGroups: resolveTriState(input.options.regionGroups, input.settings.regionGroupsDefault),
    customGroups,
    categoryTargets: input.options.categoryTargets,
    providers: input.providers,
    unlockStatuses: input.unlockStatuses,
  });

  // 自定义规则。没有节点时文档里没有组，规则也不该有（客户端会拒绝指向不存在的组）。
  const customRuleErrors: ProxySubPipelineDocument["customRuleErrors"] = [];
  if ((document.nodes.length > 0 || (document.providers?.length || 0) > 0) && input.rulePreset !== "off") {
    const knownTargets = new Set<string>([
      PROXY_RULE_TARGET_DIRECT,
      PROXY_RULE_TARGET_REJECT,
      ...document.groups.map((group) => group.name),
      ...document.nodes.map((node) => node.name),
    ]);
    const convert = (text: string, scope: ProxySubPipelineDocument["customRuleErrors"][number]["scope"]) => {
      const parsed = parseProxyCustomRules(text);
      for (const error of parsed.errors) customRuleErrors.push({ scope, line: error.line, message: error.message });
      return customRulesToRouteRules(parsed.rules, { mainGroupName: PROXY_SUBSCRIPTION_GROUP_NAME, knownTargets });
    };
    const prepend = [
      ...convert(input.settings.customRulesPrepend, "global-prepend"),
      ...convert(input.userCustomRules || "", "user"),
      ...convert(input.options.customRules, "token"),
    ];
    const append = convert(input.settings.customRulesAppend, "global-append");
    if (prepend.length > 0 || append.length > 0) {
      document.rules = spliceCustomRules(document.rules, prepend, append);
    }
  }

  const wantInfo = input.info && resolveTriState(input.options.infoNodes, input.settings.infoNodesDefault);
  const infoNodes = wantInfo && input.info ? buildProxySubInfoNodes({ ...input.info, announce: input.info.announce ?? input.settings.announce }) : [];
  return { document, plan, infoNodes, customGroups, customRuleErrors };
}

export type ProxySubRenderInput = {
  built: ProxySubPipelineDocument;
  format: ProxySubscriptionFormat;
  profile: boolean;
  profileUrl: string;
  client: DetectedProxyClient | null;
  settings: ProxySubSettings;
  template?: Pick<ProxySubTemplate, "prelude"> | null;
  vars: ProxySubPipelineInput["vars"] & { expireDate: string; dataLeft: string };
  /** 节点订阅（没带 rules）时不用模板的开头部分：那种订阅本来就只有节点。 */
  weightedLoadBalance: boolean;
  shadowrocketClient: boolean;
};

export function renderSettingsFrom(settings: ProxySubSettings): ProxySubRenderSettings {
  return {
    testUrl: settings.testUrl,
    testIntervalSec: settings.testIntervalSec,
    toleranceMs: settings.toleranceMs,
    rulesetIntervalSec: settings.rulesetIntervalSec,
    rulesetMirror: settings.rulesetMirror,
    updateIntervalHours: settings.updateIntervalHours,
  };
}

/** 第六步：出正文。 */
export function renderProxySubPipeline(input: ProxySubRenderInput): string {
  const target = proxySubTemplateTargetForFormat(input.format);
  let prelude = "";
  /*
    模板的开头部分只进「规则订阅」（带 rules 参数的完整配置）。节点订阅保持原样：
    Clash / sing-box 的节点订阅是「节点 + 策略组、没有分流规则」的最小配置，用户往往
    拿它和客户端自己的配置合并，硬塞 DNS / TUN 进去会改变已经在用的人的行为；
    Surge / Loon / QX / Shadowrocket 的节点订阅是裸节点行，带了 [General] 会让导入失败。
  */
  const wantPrelude = target && input.profile;
  if (wantPrelude && target) {
    const raw = input.template?.prelude ?? PROXY_SUB_BUILTIN_PRELUDES[target];
    prelude = renderProxySubTemplatePrelude(raw, {
      appName: input.vars.appName,
      panelUrl: input.vars.panelUrl,
      subUrl: input.vars.subUrl,
      username: input.vars.username,
      expireDate: input.vars.expireDate,
      dataLeft: input.vars.dataLeft,
      testUrl: input.settings.testUrl,
      mainGroup: PROXY_SUBSCRIPTION_GROUP_NAME,
    }, target);
  }
  return renderProxySubscription(input.built.document, input.format, {
    profile: input.profile,
    profileUrl: input.profileUrl,
    shadowrocketClient: input.shadowrocketClient,
    weightedLoadBalance: input.weightedLoadBalance,
    settings: renderSettingsFrom(input.settings),
    prelude,
    infoNodes: input.built.infoNodes,
    client: input.client || undefined,
  });
}

/** 模板占位符里的「剩余流量」「到期日」。 */
export function proxySubTemplateUserVars(info: { trafficUsed: number; trafficLimit: number; expiresAt: number }): { expireDate: string; dataLeft: string } {
  const left = info.trafficLimit > 0 ? Math.max(0, info.trafficLimit - info.trafficUsed) : 0;
  const date = info.expiresAt > 0 ? new Date(info.expiresAt) : null;
  return {
    expireDate: date ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}` : "长期",
    dataLeft: info.trafficLimit > 0 ? formatBytes(left) : "不限",
  };
}
