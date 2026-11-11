/**
 * 模板编辑框里的「实时预览」：拿一组固定的示例节点，按这份模板（开头部分、自定义组、分流规则、插件）
 * 走一遍真正的订阅流水线，渲染出来给管理员看。
 *
 * 走的是和服务端同一条流水线（shared/proxySubscriptionPipeline.ts），不是另写一个「长得像」的拼接：
 * 预览里看到组成员被丢掉、规则回落到主选择器，客户端拉到的就是那样。示例节点故意覆盖几个地区、
 * 名字里带 IPLC / BGP，按关键词 / 正则筛的组都能看出效果。
 */

import { buildProxySubscriptionPlan } from "./proxySubscriptionPlan";
import { buildProxySubPipelineDocument, renderProxySubPipeline } from "./proxySubscriptionPipeline";
import type { ProxySubscriptionFormat } from "./proxySubscription";
import { PROXY_SUB_DEFAULT_SETTINGS } from "./proxySubSettings";
import { PROXY_SUB_DEFAULT_TOKEN_OPTIONS, PROXY_SUB_EMPTY_SCOPE } from "./proxySubTokenScope";
import type { ProxySubTemplate, ProxySubTemplateTarget } from "./proxySubTemplates";

/** 示例节点：直连条目（不经中转），地址用文档保留段，不会被当成真地址。 */
export const PROXY_SUB_PREVIEW_SAMPLE_NODES = [
  { name: "香港 IPLC 01", countryCode: "HK", protocol: "vless" },
  { name: "香港 BGP 02", countryCode: "HK", protocol: "trojan" },
  { name: "日本 IEPL 01", countryCode: "JP", protocol: "shadowsocks" },
  { name: "新加坡 01", countryCode: "SG", protocol: "trojan" },
  { name: "台湾 01", countryCode: "TW", protocol: "shadowsocks" },
  { name: "美国 01", countryCode: "US", protocol: "hysteria2" },
] as const;

function sampleTemplates() {
  return PROXY_SUB_PREVIEW_SAMPLE_NODES.map((item, index) => ({
    id: index + 1,
    name: item.name,
    protocol: item.protocol,
    address: `192.0.2.${index + 10}`,
    port: 443 + index,
    uuid: "00000000-0000-4000-a000-000000000000",
    password: "preview",
    method: "aes-128-gcm",
    tls: item.protocol !== "shadowsocks",
    sni: "example.com",
    countryCode: item.countryCode,
    includeDirect: true,
    autoGroup: "off",
  }));
}

export type ProxySubTemplatePreviewInput = Pick<ProxySubTemplate, "target" | "prelude" | "customGroups"> & Partial<Pick<ProxySubTemplate, "customRules" | "modules">>;

export type ProxySubTemplatePreview = {
  format: ProxySubscriptionFormat;
  text: string;
  /** 模板分流规则里写坏、渲染时跳过的行。 */
  ruleErrors: Array<{ line: number; message: string }>;
};

/**
 * 预览成哪种格式：Clash（看组和规则最直观），或模板自己的目标格式（看开头部分、Loon 插件）。
 * 模板不是 Clash 的、却要看 Clash 预览时，开头部分不套进去（那是别的格式的写法）。
 */
export function renderProxySubTemplatePreview(template: ProxySubTemplatePreviewInput, as: "clash" | ProxySubTemplateTarget = "clash"): ProxySubTemplatePreview {
  const format: ProxySubscriptionFormat = as;
  const templates = sampleTemplates();
  const plan = buildProxySubscriptionPlan({ rules: [], templates, hosts: [] });
  const usePrelude = as === template.target;
  const pipelineTemplate = {
    prelude: usePrelude ? template.prelude : "",
    customGroups: template.customGroups,
    customRules: template.customRules || "",
    modules: template.modules || [],
  };
  const vars = { appName: "NEX", panelUrl: "https://panel.example", subUrl: "https://panel.example/api/sub/示例?rules=1", username: "示例用户" };
  const built = buildProxySubPipelineDocument({
    plan,
    templates,
    rulePreset: "minimal",
    scope: PROXY_SUB_EMPTY_SCOPE,
    options: PROXY_SUB_DEFAULT_TOKEN_OPTIONS,
    settings: PROXY_SUB_DEFAULT_SETTINGS,
    template: pipelineTemplate,
    vars,
  });
  const text = renderProxySubPipeline({
    built,
    format,
    profile: true,
    profileUrl: vars.subUrl,
    client: null,
    settings: PROXY_SUB_DEFAULT_SETTINGS,
    template: pipelineTemplate,
    vars: { ...vars, expireDate: "2026-12-31", dataLeft: "100 GB" },
    weightedLoadBalance: false,
    shadowrocketClient: false,
  });
  const ruleErrors = built.customRuleErrors.filter((item) => item.scope === "template").map(({ line, message }) => ({ line, message }));
  return { format, text, ruleErrors };
}
