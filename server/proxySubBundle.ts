/**
 * 把一条令牌要的全部原料收齐：主人、全局设置、作用域、外观选项、模板、信息节点的数字、
 * 占位符的值。订阅路由、/info 接口、落地页、界面上的「按令牌预览」都从这里拿。
 */

import * as db from "./db";
import { loadProxySubSettings } from "./proxySubSettings";
import { effectiveProxySubExpiry, parseProxySubTokenOptions, parseProxySubTokenScope, type ProxySubTokenOptions, type ProxySubTokenScope } from "../shared/proxySubTokenScope";
import { proxySubTemplateTargetForFormat, type ProxySubTemplate } from "../shared/proxySubTemplates";
import type { ProxySubscriptionFormat } from "../shared/proxySubscription";
import type { ProxySubSettings } from "../shared/proxySubSettings";
import type { ProxySubInfoNodeInput } from "../shared/proxySubProcessors";
import { effectiveDeviceLimit } from "../shared/proxySubDeviceLimit";
import { resolveSiteTitle } from "../shared/brand";

export type ProxySubTokenContext = {
  token: any;
  owner: any;
  settings: ProxySubSettings;
  scope: ProxySubTokenScope;
  options: ProxySubTokenOptions;
  /** 套餐名、模板候选、设备上限等。 */
  plan: Awaited<ReturnType<typeof db.getUserPlanSubscriptionInfo>>;
  /** 用量与到期（毫秒）。 */
  info: ProxySubInfoNodeInput;
  /** 这条令牌 / 用户 / 套餐 / 全局合起来的设备数上限（0 = 不限）。 */
  deviceLimit: number;
  appName: string;
  username: string;
};

export async function loadProxySubTokenContext(token: any): Promise<ProxySubTokenContext | null> {
  const owner = await db.getUserById(Number(token.userId));
  if (!owner) return null;
  const [settings, plan, all] = await Promise.all([
    loadProxySubSettings(),
    db.getUserPlanSubscriptionInfo(Number(token.userId)),
    db.getAllSettings(),
  ]);
  // 账号到期和这条链接的到期取更早的那个（链接设了到期，信息节点要写出来）。
  const expiresAt = effectiveProxySubExpiry(token.expiresAt, (owner as any).expiresAt);
  return {
    token,
    owner,
    settings,
    scope: parseProxySubTokenScope(token.scopeJson),
    options: parseProxySubTokenOptions(token.optionsJson),
    plan,
    info: {
      trafficUsed: Number((owner as any).trafficUsed || 0),
      trafficLimit: Number((owner as any).trafficLimit || 0),
      expiresAt: expiresAt > 0 ? expiresAt : 0,
      nextResetAt: plan.nextResetAt,
    },
    deviceLimit: effectiveDeviceLimit(token.maxDevices, (owner as any).maxProxyDevices, settings.deviceLimitFallback),
    appName: resolveSiteTitle(all.siteTitle),
    username: String((owner as any).username || ""),
  };
}

/** 这条令牌拉这种格式该用哪份模板：令牌 → 用户 → 套餐 → 该格式的默认模板 → 内置。 */
export async function resolveTemplateForToken(context: ProxySubTokenContext, format: ProxySubscriptionFormat): Promise<ProxySubTemplate | null> {
  const target = proxySubTemplateTargetForFormat(format);
  if (!target) return null;
  return db.resolveProxySubTemplate(target, [
    Number(context.token.templateId || 0),
    Number(context.owner.proxySubTemplateId || 0),
    ...context.plan.templateIds,
  ]);
}

/** 信息节点要不要插：令牌三态 → 套餐开了就开 → 全局默认。 */
export function infoNodesWanted(context: ProxySubTokenContext): boolean {
  if (context.options.infoNodes === "on") return true;
  if (context.options.infoNodes === "off") return false;
  return context.plan.showSubInfoNodes || context.settings.infoNodesDefault;
}
