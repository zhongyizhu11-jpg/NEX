import { z } from "zod";

import { clearLandingCredentials, fillLandingCredentials, getLandingPoolNodes, rulesUsingLandingPool } from "./landingPools";
import type { NodePool } from "./nodePools";
import {
  createDefaultLandingConfig,
  describeLandingConfig,
  LANDING_POOL_PROTOCOLS,
  landingConfigShapeChanged,
  MAX_LANDING_POOL_USERS,
  parseLandingConfig,
  parseLandingState,
  validateLandingConfig,
  type LandingConfig,
} from "../shared/landingPool";
import { PROXY_NODE_TRANSPORTS } from "../shared/proxyNode";

/*
  节点池弹窗里「落地」那一块怎么进来、怎么出去（2.3.500）。凭据一律服务端生成，不让前端传 —— 和单台
  入站同一个规矩；出去的视图里也没有私钥和凭据，只有界面要画的那几样。
*/

export const landingConfigInputSchema = z.object({
  protocol: z.enum(LANDING_POOL_PROTOCOLS),
  port: z.number().int().min(1).max(65535),
  transport: z.enum(PROXY_NODE_TRANSPORTS).optional(),
  security: z.enum(["reality", "none"]).optional(),
  flow: z.string().trim().max(64).optional(),
  serverName: z.string().trim().max(253).optional(),
  realityDest: z.string().trim().max(300).optional(),
  path: z.string().trim().max(200).optional(),
  host: z.string().trim().max(253).optional(),
  method: z.string().trim().max(64).optional(),
  snellVersion: z.number().int().min(0).max(10).optional(),
  obfs: z.string().trim().max(32).optional(),
  snellMode: z.string().trim().max(32).optional(),
  /** 多用户协议的用户：只收 id 和名字（新加的 id = 0）。分享时单独发的那几份不在表单里，照留。 */
  users: z.array(z.object({ id: z.number().int().nonnegative().default(0), name: z.string().trim().max(64) })).max(MAX_LANDING_POOL_USERS).optional(),
});

export type LandingConfigInput = z.infer<typeof landingConfigInputSchema>;

/**
 * 表单 → 池配置。没动的凭据留着（按用户 id 对上）；换了协议、安全层、加密方式、Snell 版本就整份换新
 * （旧密钥对不上新的形状）。返回补齐凭据、校验过的配置，以及是不是换了凭据（界面要提醒重新拉订阅）。
 */
export function mergeLandingInput(existing: LandingConfig | null, input: LandingConfigInput): { config: LandingConfig; credentialsReset: boolean } {
  const base = existing ?? createDefaultLandingConfig();
  const merged = parseLandingConfig({
    ...base,
    protocol: input.protocol,
    port: input.port,
    transport: input.transport ?? base.transport,
    security: input.security ?? base.security,
    flow: input.flow ?? base.flow,
    serverName: input.serverName ?? base.serverName,
    realityDest: input.realityDest ?? base.realityDest,
    path: input.path ?? base.path,
    host: input.host ?? base.host,
    method: input.method ?? base.method,
    snellVersion: input.snellVersion ?? base.snellVersion,
    obfs: input.obfs ?? base.obfs,
    snellMode: input.snellMode ?? base.snellMode,
    users: base.users,
  });
  if (!merged) throw new Error("落地配置认不出来");
  if (input.users !== undefined) {
    const byId = new Map(base.users.map((user) => [user.id, user]));
    let nextUserId = merged.nextUserId;
    const manual = input.users.map((item) => {
      const current = item.id > 0 ? byId.get(item.id) : undefined;
      if (current && !current.sharedUserId) return { ...current, name: item.name };
      const id = nextUserId;
      nextUserId += 1;
      return { id, name: item.name, uuid: "", password: "", sharedUserId: 0 };
    });
    const shared = base.users.filter((user) => user.sharedUserId > 0);
    merged.users = [...manual, ...shared].slice(0, MAX_LANDING_POOL_USERS);
    merged.nextUserId = nextUserId;
  }
  const credentialsReset = !!existing && landingConfigShapeChanged(existing, merged);
  const config = fillLandingCredentials(credentialsReset ? clearLandingCredentials(merged) : merged);
  const error = validateLandingConfig(config);
  if (error) throw new Error(error);
  return { config, credentialsReset };
}

/** 直连域名：真域名（不能是 IP），小写。空 = 不要直连。 */
export function normalizeDirectDomain(value: unknown): string | null {
  const domain = String(value ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!domain) return null;
  const labelsOk = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain);
  const tldHasLetter = /[a-z]/.test(domain.slice(domain.lastIndexOf(".") + 1));
  if (!labelsOk || !tldHasLetter) throw new Error("直连域名看起来不是一个合法域名（不能填 IP）");
  return domain;
}

/**
 * 「自动」起的直连域名（2.3.501）：池名能拼成英文就用它（「HK Landing」→ hk-landing）；中文名拼不出来，用池里机器的
 * 地区（hk）；都没有用 lp。后面带 4 位随机字母数字免得重名，挂在 DDNS 管着的主域名下。随机那段由调用方给（测试里固定）。
 */
export function landingDomainSuggestion({ name, root, random, region }: { name: string; root: string; random: string; region?: string | null }): string {
  const slugOf = (value: unknown) => String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20)
    .replace(/-+$/g, "");
  const tail = String(random || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "0000";
  return `${slugOf(name) || slugOf(region) || "lp"}-${tail}.${String(root || "").trim().toLowerCase().replace(/\.+$/, "")}`;
}

/** 池里机器最多的那个地区（两位国家码，小写）；没有就 null。 */
export function landingPoolRegion(countryCodes: ReadonlyArray<unknown>): string | null {
  const counts = new Map<string, number>();
  for (const code of countryCodes) {
    const value = String(code || "").trim().toLowerCase();
    if (/^[a-z]{2}$/.test(value)) counts.set(value, (counts.get(value) || 0) + 1);
  }
  let best: string | null = null;
  for (const [code, count] of Array.from(counts)) if (!best || count > (counts.get(best) || 0)) best = code;
  return best;
}

/** 设直连域名要先有 DNS 服务商（面板要替它写解析）。 */
export async function assertDirectDomainReady(domain: string | null) {
  if (!domain) return;
  const { getDdnsSettings } = await import("./ddns");
  const settings: any = await getDdnsSettings().catch(() => null);
  if (!settings?.enabled || !settings.provider || settings.provider === "disabled") {
    throw new Error("要用域名直连，先到 系统设置 → DDNS 配好 DNS 服务商：面板要替这个域名写解析，只解析到能用的机器");
  }
}

/** 界面要画的落地池那一块：配置（不含凭据）、每台成员的结果、池节点、在用的转发。 */
export async function landingPoolView(pool: NodePool) {
  const config = pool.role === "landing" ? parseLandingConfig(pool.landingJson) : null;
  if (pool.role !== "landing") return null;
  const states = parseLandingState(pool.landingStateJson);
  const nodes = config ? await getLandingPoolNodes(pool.id) : [];
  const anchor = nodes.find((node) => !(Number(node.poolSharedUserId || 0) > 0)) || nodes[0] || null;
  const rules = config ? await rulesUsingLandingPool(pool.id, nodes.map((node) => Number(node.id))).catch(() => [] as any[]) : [];
  return {
    configured: !!config,
    summary: config ? describeLandingConfig(config) : "",
    config: config ? {
      protocol: config.protocol,
      port: config.port,
      transport: config.transport,
      security: config.security,
      flow: config.flow,
      serverName: config.serverName,
      realityDest: config.realityDest,
      path: config.path,
      host: config.host,
      method: config.method,
      snellVersion: config.snellVersion,
      obfs: config.obfs,
      snellMode: config.snellMode,
      users: config.users.map((user) => ({ id: user.id, name: user.name, shared: user.sharedUserId > 0 })),
    } : null,
    directDomain: pool.directDomain || null,
    members: pool.hostIds.map((hostId) => {
      const state = states.find((item) => item.hostId === hostId);
      return {
        hostId,
        port: state?.port || 0,
        portFallback: !!state?.portFallback,
        error: state ? state.error : (config ? "还没同步" : null),
        open: !!state && !state.error && state.inboundId > 0,
      };
    }),
    nodeId: anchor ? Number(anchor.id) : null,
    nodeEnabled: anchor ? anchor.isEnabled !== false && anchor.isEnabled !== 0 : false,
    rules: rules.length,
  };
}
