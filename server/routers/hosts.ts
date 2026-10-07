import { protectedProcedure, adminProcedure, publicProcedure, router } from "../_core/trpc";
import { githubRepoParts } from "@shared/githubAccelerator";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { nanoid } from "nanoid";
import * as db from "../db";
import { appendPanelLog } from "../_core/panelLogger";
import { markHostMetricsWatching, pushAgentRefresh, pushAgentUpgrade } from "../agentEvents";
import { AGENT_ASSET_NAMES, getMissingBundledAgentAssets } from "../agentAssets";
import { pushTunnelEndpointRefresh, requireHostAccess, requireHostsAccess } from "./helpers";
import { AGENT_VERSION, APP_VERSION, REPO_URL } from "../_core/systemRouter";
import { isAgentUpgradeCompleted, isHostAgentUpgradeUnnecessary } from "../agentRouteUtils";
import { hostNeedsAgentUpgrade } from "@shared/fxpRuntime";
import { normalizeVersion } from "@shared/version";
import { scheduleHostGeoRefresh } from "../hostGeo";
import { agentPrivateIpv4 } from "../agentPrivateAddress";
import { refreshHostAddressRuntime } from "../hostAddressRuntime";
import { scheduleHostDdnsUpdate } from "../hostDdns";
import { scheduleRuleEntryDomainSyncForHost } from "../ruleEntryDomain";
import { clearTunnelRuntimeStatusForHost } from "../tunnelRuntimeStatus";
import { createQueryCache } from "../queryCache";
import { describePortPolicy, normalizePortAllowlist, portPolicyFrom, portPolicyHasRestriction } from "@shared/portPolicy";
import { ENV } from "../env";
import { isValidHostOrIp as isValidNetworkHostOrIp } from "../networkAddress";
import { planAgentUpgradeWaves } from "../agentUpgradeRollout";
import { billingCalendarParts } from "@shared/billingTime";
import { normalizeAgentProbeCounts } from "@shared/agentDtos";
import { buildAgentScriptCommand } from "@shared/agentInstallCommand";
import { getConfiguredPanelUrl } from "../agentPanelUrl";
import { hostEgressShaping, normalizeHostEgressShapingMode, TUNNEL_LINK_MBPS_MAX } from "../tunnelFxpRuntime";
import { parseManualHostAddress } from "@shared/hostManualAddress";

const HOST_UPGRADE_CLEANUP_INTERVAL_MS = 60 * 1000;
const GITHUB_API_LIMIT_STATUSES = new Set([403, 429]);
const hostQueryCache = createQueryCache(500);

let lastHostUpgradeCleanupAt = 0;
let hostUpgradeCleanupRunning = false;
const ORPHANED_AGENT_HOST_CLEANUP_INTERVAL_MS = 60 * 1000;
let lastOrphanedAgentHostCleanupAt = 0;
let orphanedAgentHostCleanupRunning = false;
const hostProtocolPolicyFields = ["blockHttp", "blockSocks", "blockTls"] as const;

async function refreshHostPolicyRuntime(hostId: number, reason: string) {
  const id = Number(hostId);
  if (!Number.isFinite(id) || id <= 0) return;
  const host = await db.getHostById(id).catch(() => null);
  await db.resetAgentRuntimeStateForHost(id);
  clearTunnelRuntimeStatusForHost(id);
  const tunnels = await db.getTunnelsByHost(id);
  appendPanelLog("info", `[Host] refresh runtime host=${id} name=${String(host?.name || `主机 #${id}`)} reason=${reason} tunnelCount=${tunnels.length}`);
  for (const tunnel of tunnels as any[]) {
    await pushTunnelEndpointRefresh(tunnel, reason);
  }
  pushAgentRefresh(id, reason);
}

const isValidHostOrIp = (value: unknown) => isValidNetworkHostOrIp(value, { allowUnderscore: true, allowLooseIpLiteral: true });

const hostAddressSchema = z.string().trim().min(1).max(253).refine(isValidHostOrIp, "Invalid host or IP");
const optionalHostAddressSchema = z.string().trim().max(253).nullable().optional().refine(
  (value) => !value || isValidHostOrIp(value),
  "Invalid host or IP",
);
const networkInterfaceSchema = z.string().trim().max(32).nullable().optional().refine(
  (value) => !value || /^[a-zA-Z0-9_.:@-]+$/.test(value),
  "Invalid network interface",
);
const hostSortOrderSchema = z.number().int().min(0).max(200).optional();

const optionalDateInputSchema = z.string().trim().max(64).nullable().optional();
const hostTrafficMeasureModeSchema = z.enum(["outbound", "both", "max"]).default("both");
const hostEgressShapingModeSchema = z.enum(["auto", "manual", "off"]);
const hostEgressMbpsSchema = z.number().int().min(0).max(TUNNEL_LINK_MBPS_MAX);

/**
 * 主机公网出口整形的档位和手动上限收敛成要写库的两个字段。手动档必须有值；
 * 没打开时上限清零，免得界面上残留一个没用的数字。
 */
function hostEgressShapingPayload(input: { egressShapingMode?: unknown; egressMbps?: unknown }) {
  const mode = normalizeHostEgressShapingMode(input.egressShapingMode);
  const parsed = Math.floor(Number(input.egressMbps));
  const mbps = Number.isFinite(parsed) && parsed > 0 ? Math.min(TUNNEL_LINK_MBPS_MAX, parsed) : 0;
  if (mode === "manual" && mbps <= 0) throw new Error("公网出口整形选了手动，需要填公网带宽上限（Mbit/s）");
  return { egressShapingMode: mode, egressMbps: mode === "manual" ? mbps : 0 };
}
const hostBillingCycleMonthsSchema = z.union([
  z.literal(1), z.literal(3), z.literal(6), z.literal(12), z.literal(24), z.literal(36),
]);
const hostExpiryActionSchema = z.enum(["none", "extend_cycle"]);
const hostDdnsIpVersionSchema = z.enum(["ipv4", "ipv6"]);
const hostDdnsRecordTypeSchema = z.enum(["A", "AAAA"]);
const hostDdnsDomainSchema = z.string().trim().max(253).nullable().optional();
const pageRequestSchema = z.object({
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().min(1).max(100).default(12),
});
const hostProbeTargetSchema = z.string().trim().min(1).max(253).refine(isValidHostOrIp, "Invalid target IP or host");
const hostProbeIdsSchema = z.array(z.number().int().positive()).max(500).optional();
const hostProbeServiceInputSchema = z.object({
  name: z.string().trim().min(1).max(128),
  method: z.enum(["tcping", "ping"]),
  targetIp: hostProbeTargetSchema,
  targetPort: z.number().int().min(1).max(65535).nullable().optional(),
  hostScope: z.enum(["all", "exclude", "specific"]).default("all"),
  hostIds: hostProbeIdsSchema,
  excludeHostIds: hostProbeIdsSchema,
  intervalSeconds: z.number().int().min(5).max(86400).default(30),
  isEnabled: z.boolean().optional(),
});
const hostGroupInputSchema = z.object({
  name: z.string().trim().min(1).max(128),
  hostIds: z.array(z.number().int().positive()).max(500).optional(),
  isEnabled: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(200).optional(),
});
const reorderIdsSchema = z.array(z.number().int().positive()).min(1).max(2000);

function normalizeHostProbeServiceInput(input: z.infer<typeof hostProbeServiceInputSchema>) {
  if (input.method === "tcping" && !input.targetPort) throw new Error("TCPing 服务需要填写目标端口");
  const hostIds = Array.from(new Set((input.hostIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0)));
  const excludeHostIds = Array.from(new Set((input.excludeHostIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0)));
  if (input.hostScope === "specific" && hostIds.length === 0) throw new Error("请选择需要运行服务的主机");
  return {
    ...input,
    targetPort: input.method === "tcping" ? Number(input.targetPort) : null,
    hostIds: input.hostScope === "specific" ? hostIds : [],
    excludeHostIds: input.hostScope === "exclude" ? excludeHostIds : [],
    intervalSeconds: Math.max(5, Number(input.intervalSeconds) || 30),
    isEnabled: input.isEnabled !== false,
  };
}

function normalizeHostGroupInput(input: z.infer<typeof hostGroupInputSchema>) {
  return {
    name: input.name.trim(),
    hostIds: Array.from(new Set((input.hostIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))),
    isEnabled: input.isEnabled !== false,
    sortOrder: input.sortOrder === undefined ? undefined : Math.max(0, Math.floor(Number(input.sortOrder) || 0)),
  };
}

async function assertHostGroupHostIdsExist(hostIds: number[]) {
  if (hostIds.length === 0) return;
  // 只问这几个 id 在不在，别把整张 hosts 读回来在内存里建 Set。
  const existingIds = await db.findExistingHostIds(hostIds);
  const missing = hostIds.filter((hostId) => !existingIds.has(hostId));
  if (missing.length > 0) throw new Error(`主机不存在：${missing.join(", ")}`);
}

function parseOptionalDateInput(value: string | null | undefined, label: string) {
  const text = String(value || "").trim();
  if (!text) return null;
  const date = new Date(text);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label}格式不正确`);
  return date;
}

function normalizeExistingOptionalDate(value: unknown) {
  if (!value) return null;
  if (value instanceof Date) {
    return value.getTime() > 0 ? value : null;
  }
  const date = new Date(String(value));
  return Number.isFinite(date.getTime()) && date.getTime() > 0 ? date : null;
}

function assertHostTrafficDates(purchasedAt: Date | null, stoppedAt: Date | null) {
  if (purchasedAt && stoppedAt && stoppedAt.getTime() <= purchasedAt.getTime()) {
    throw new Error("机器停止时间必须晚于购买时间");
  }
}

function normalizeHostTrafficMeasureMode(value: unknown) {
  if (value === "outbound" || value === "max") return value;
  return "both";
}

function normalizeTrafficAlertThresholdPercent(value: unknown) {
  return Math.min(99, Math.max(1, Math.floor(Number(value) || 20)));
}

function normalizeRenewalReminderDays(value: unknown) {
  return Math.min(365, Math.max(1, Math.floor(Number(value) || 3)));
}

const HOST_BILLING_CYCLE_MONTHS = [1, 3, 6, 12, 24, 36] as const;
type HostBillingCycleMonths = (typeof HOST_BILLING_CYCLE_MONTHS)[number];

function normalizeHostBillingCycleMonths(value: unknown): HostBillingCycleMonths {
  const months = Math.floor(Number(value));
  return (HOST_BILLING_CYCLE_MONTHS as readonly number[]).includes(months)
    ? months as HostBillingCycleMonths
    : 1;
}

function normalizeHostBillingMonth(value: unknown) {
  return Math.min(12, Math.max(1, Math.floor(Number(value) || 1)));
}

function normalizeHostBillingDay(value: unknown) {
  return Math.min(31, Math.max(1, Math.floor(Number(value) || 1)));
}

function normalizeHostExpiryAction(value: unknown) {
  return value === "extend_cycle" ? "extend_cycle" : "none";
}

function normalizeHostDdnsIpVersion(value: unknown, recordType?: string) {
  if (value === "ipv6" || (!value && String(recordType || "").toUpperCase() === "AAAA")) return "ipv6";
  return "ipv4";
}

function normalizeHostDdnsRecordType(ipVersion: unknown) {
  return ipVersion === "ipv6" ? "AAAA" : "A";
}

function normalizeHostDdnsPayload(input: {
  ddnsEnabled?: boolean;
  ddnsDomain?: string | null;
  ddnsRecordType?: "A" | "AAAA";
  ddnsIpVersion?: "ipv4" | "ipv6";
}) {
  const ipVersion = normalizeHostDdnsIpVersion(input.ddnsIpVersion, input.ddnsRecordType);
  const recordType = normalizeHostDdnsRecordType(ipVersion);
  const domain = String(input.ddnsDomain || "").trim().replace(/\.+$/, "").toLowerCase();
  if (input.ddnsEnabled && !domain) throw new Error("开启 DDNS 服务需要填写域名");
  return {
    ddnsEnabled: !!input.ddnsEnabled,
    ddnsDomain: domain || null,
    ddnsRecordType: recordType,
    ddnsIpVersion: ipVersion,
  };
}

async function assertHostDdnsServiceConfigured() {
  const settings = await db.getAllSettings();
  const provider = String(settings.ddnsProvider || "disabled");
  if (settings.ddnsEnabled !== "true" || provider === "disabled") {
    throw new Error("请先在系统设置内启用 DDNS 服务商");
  }
}

async function assertTelegramBotConfiguredForHostReminder() {
  const settings = await db.getAllSettings();
  const envToken = ENV.telegramBotToken.trim();
  const botEnabled = settings.telegramBotEnabled === "true" || (!!envToken && settings.telegramBotEnabled !== "false");
  const botConfigured = !!String(settings.telegramBotToken || envToken).trim();
  if (!botEnabled || !botConfigured) {
    throw new Error("请先在系统设置内配置并启用 Telegram 机器人");
  }
}

function hostTrafficConfigPayload(input: {
  purchasedAt?: string | null;
  stoppedAt?: string | null;
  trafficLimit?: number;
  trafficMeasureMode?: "outbound" | "both" | "max";
  telegramTrafficAlertEnabled?: boolean;
  trafficAlertThresholdPercent?: number;
  telegramRenewalReminderEnabled?: boolean;
  renewalReminderDays?: number;
  billingCycleMonths?: number;
  billingMonth?: number;
  billingDay?: number;
  expiryHandling?: "none" | "extend_cycle";
  trafficAutoReset?: boolean;
  trafficResetDay?: number;
}) {
  const purchasedAt = parseOptionalDateInput(input.purchasedAt, "机器购买时间");
  const stoppedAt = parseOptionalDateInput(input.stoppedAt, "机器停止时间");
  assertHostTrafficDates(purchasedAt, stoppedAt);
  const stoppedAtMonth = stoppedAt ? billingCalendarParts(stoppedAt).month : 1;
  return {
    purchasedAt,
    stoppedAt,
    trafficLimit: Math.max(0, Math.floor(Number(input.trafficLimit || 0))),
    trafficMeasureMode: normalizeHostTrafficMeasureMode(input.trafficMeasureMode),
    telegramTrafficAlertEnabled: !!input.telegramTrafficAlertEnabled,
    trafficAlertThresholdPercent: normalizeTrafficAlertThresholdPercent(input.trafficAlertThresholdPercent),
    telegramRenewalReminderEnabled: !!input.telegramRenewalReminderEnabled,
    renewalReminderDays: normalizeRenewalReminderDays(input.renewalReminderDays),
    billingCycleMonths: normalizeHostBillingCycleMonths(input.billingCycleMonths),
    billingMonth: normalizeHostBillingMonth(input.billingMonth ?? stoppedAtMonth),
    billingDay: normalizeHostBillingDay(input.billingDay),
    expiryHandling: normalizeHostExpiryAction(input.expiryHandling),
    trafficAutoReset: !!input.trafficAutoReset,
    trafficResetDay: input.trafficResetDay ?? 1,
  };
}

async function releaseAssetExistsViaDownloadUrl(tag: string, assetName: string) {
  const { owner, repo } = githubRepoParts(REPO_URL);
  const url = `https://github.com/${owner}/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`;
  const headers = {
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    "User-Agent": `NEX/${APP_VERSION}`,
  };
  let res = await fetch(`${url}?_=${Date.now()}`, {
    cache: "no-store",
    method: "HEAD",
    redirect: "follow",
    headers,
  });
  if (res.status === 405) {
    res = await fetch(`${url}?_=${Date.now()}`, {
      cache: "no-store",
      method: "GET",
      redirect: "follow",
      headers: {
        ...headers,
        Range: "bytes=0-0",
      },
    });
  }
  return res.ok;
}

async function assertAgentReleaseAssetsReady(agentVersion: string, releaseVersion = APP_VERSION) {
  const normalizedAgentVersion = normalizeVersion(agentVersion);
  const missingBundledAssets = getMissingBundledAgentAssets(releaseVersion);
  if (missingBundledAssets.length === 0) return;

  const tag = `v${normalizeVersion(releaseVersion)}`;
  const { owner, repo } = githubRepoParts(REPO_URL);
  const url = `https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`;
  const res = await fetch(`${url}?_=${Date.now()}`, {
    cache: "no-store",
    headers: {
      Accept: "application/vnd.github+json",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      "User-Agent": `NEX/${APP_VERSION}`,
    },
  });
  if (res.status === 404) {
    throw new Error(`Agent v${normalizedAgentVersion} 所需的 Release ${tag} 尚未生成，可能仍在构建中，请稍后再试`);
  }
  if (!res.ok) {
    if (GITHUB_API_LIMIT_STATUSES.has(res.status)) {
      const missingByUrl: string[] = [];
      for (const name of missingBundledAssets) {
        if (!await releaseAssetExistsViaDownloadUrl(tag, name)) missingByUrl.push(name);
      }
      if (missingByUrl.length === 0) return;
      throw new Error(`GitHub API 已限流，且无法通过下载直链确认 Release ${tag} 的 Agent 资产，请稍后再试：${missingByUrl.join(", ")}`);
    }
    throw new Error(`无法验证 Release ${tag} 的 Agent 资产：${res.status} ${res.statusText}`);
  }
  const release = await res.json() as { assets?: Array<{ name?: string; state?: string; size?: number }> };
  const assets = new Map((release.assets || []).map((asset) => [asset.name || "", asset]));
  const missing = missingBundledAssets.filter((name) => {
    const asset = assets.get(name);
    return !asset || asset.state !== "uploaded" || Number(asset.size || 0) <= 0;
  });
  if (missing.length > 0) {
    throw new Error(`Agent v${normalizedAgentVersion} 所需的 Release ${tag} 资产还未构建完成，请稍后再试：${missing.join(", ")}`);
  }
}

async function clearCompletedHostAgentUpgradeRequests<T extends any[]>(hostRows: T): Promise<T> {
  const completedIds: number[] = [];
  const cleanedRows = hostRows.map((host: any) => {
    const targetVersion = host.agentUpgradeTargetVersion || AGENT_VERSION;
    if (host.agentUpgradeRequested && host.agentVersion && isAgentUpgradeCompleted(host, targetVersion, AGENT_VERSION)) {
      completedIds.push(Number(host.id));
      return {
        ...host,
        agentUpgradeRequested: false,
        agentUpgradeTargetVersion: null,
        agentUpgradeReleaseVersion: null,
      };
    }
    return host;
  }) as T;
  await Promise.all(completedIds.map((id) => db.clearHostAgentUpgradeRequest(id)));
  return cleanedRows;
}

async function getHostsWithUpgradeStateCleanup(userId?: number) {
  return clearCompletedHostAgentUpgradeRequests(await db.getHosts(userId));
}

/**
 * 一个用户能查到哪些主机。
 *
 * 租户看得到的是：**自己加的，加上管理员显式授权给他的**。没授权的机器在他那儿
 * 从头到尾不存在 —— 不在列表里，也不在转发规则的主机下拉里。
 *
 * 被授权的那些会出现，但只读：hosts.update / hosts.delete 都要求
 * `host.userId === 自己`，服务端本来就挡着。界面据此不渲染改名和删除的入口 ——
 * 别让人点进去才发现动不了。
 */
async function visibleHostQueryScope(user: { id: number; role: string }) {
  if (user.role === "admin") return {} as { ownerUserId?: number; allowedHostIds?: number[]; sortUserId?: number };
  const [allowedHostIds, billingResourceIds] = await Promise.all([
    db.getUserEffectiveAllowedHostIds(user.id),
    db.getUserUsableTrafficBillingResourceIds(user.id),
  ]);
  return {
    ownerUserId: user.id,
    allowedHostIds: Array.from(new Set([...allowedHostIds, ...billingResourceIds.hostIds])),
    sortUserId: user.id,
  };
}

async function getVisibleHostsForUser(user: { id: number; role: string }, options: { scheduleGeoRefresh?: boolean } = {}) {
  const shouldScheduleGeoRefresh = options.scheduleGeoRefresh !== false;
  const isAdmin = user.role === "admin";
  if (isAdmin) {
    const hosts = await getHostsWithUpgradeStateCleanup();
    if (shouldScheduleGeoRefresh) scheduleHostGeoRefresh(hosts);
    return hosts;
  }
  // 普通用户可见自己创建、获授权及按量计费授权的主机。
  const [allowedHostIds, billingResourceIds] = await Promise.all([
    db.getUserEffectiveAllowedHostIds(user.id),
    db.getUserUsableTrafficBillingResourceIds(user.id),
  ]);
  const allHosts = await getHostsWithUpgradeStateCleanup();
  const allowedSet = new Set([...allowedHostIds, ...billingResourceIds.hostIds]);
  const visibleHosts = allHosts.filter((h: any) => allowedSet.has(h.id) || h.userId === user.id);
  if (shouldScheduleGeoRefresh) scheduleHostGeoRefresh(visibleHosts);
  return db.orderVisibleHostsForUser(visibleHosts, user.id);
}

/**
 * 谁能看某台主机的 Agent 安装命令。
 *
 * 命令里带着 agentToken，谁拿到谁就能把一台机器接进面板并冒充它上报 —— 所以
 * 这条判定跟 canOpenInboundOnHost 一样，宁可单独拎出来测：被授权用这台主机
 * （管理员授权或套餐附带）不等于可以拿它的令牌，只有主人和管理员可以。
 *
 * userId 从不同数据库回来有时是字符串，用 Number() 归一 —— 用 === 比的话，
 * 主人会被判成外人。
 */
/** 普通用户自己能加几台机器。0 = 不限；没配就是这个数。 */
export {
  DEFAULT_SELF_SERVICE_HOST_LIMIT,
  canAddSelfServiceHost,
  selfServiceHostLimitForUser,
  selfServiceHostLimitFrom,
} from "../selfServiceHostLimit";
import { canAddSelfServiceHost, selfServiceHostLimitForUser, selfServiceHostLimitFrom } from "../selfServiceHostLimit";

/**
 * 公开监控页只展示管理员的机器（以及没有主人的机器）。
 *
 * 这个页面不需要登录。租户自助添加的机器是他自己的，名字、所在地、负载和流量不该被
 * 管理员打开的公开页一起挂出去。
 */
async function filterPublicMonitorHosts(rawHosts: any[]) {
  const ownerIds = Array.from(new Set(rawHosts.map((host) => Number(host?.userId || 0)).filter((id) => id > 0)));
  // 一次 IN 查询拿全部主人的角色，不再每个主人一次 getUserById（公开页每 3 秒轮询一次）。
  const ownerRoles = await db.getUserRolesByIds(ownerIds);
  const adminOwnerIds = new Set(ownerIds.filter((id) => ownerRoles.get(id) === "admin"));
  return rawHosts.filter((host) => {
    const ownerId = Number(host?.userId || 0);
    return ownerId <= 0 || adminOwnerIds.has(ownerId);
  });
}

export function canReadHostInstallCommand(
  user: { id: number; role: string },
  host: { userId?: unknown } | null | undefined,
): boolean {
  if (!host) return false;
  if (user.role === "admin") return true;
  return Number((host as any).userId) === Number(user.id);
}

/**
 * 列表上要不要标出「这台机器是谁的」，标什么。
 *
 * 租户可以自助加机器，加完就出现在管理员的主机管理里 —— 那是对的（面板是管理员在
 * 跑，出了事要能查、要能删），但不标出主人的话，管理员看到的是一台凭空多出来的
 * 陌生机器：不知道能不能动它，也不知道该找谁。
 *
 * 三条规矩：
 *
 * 1. **只给管理员**。普通用户能看见的除了自己的，还有被授权用的别人的机器 ——
 *    在那儿标出主人等于把另一个租户的身份透给他。
 * 2. **自己建的不标**。满屏都是自己的名字，等于没标，还把真正该注意的那几台淹了。
 * 3. **人没了也要说**。用户注销但机器还留着时照说「已注销用户 #N」，不能静悄悄
 *    当成自己的 —— 那是一台没人认领的机器，恰恰最需要管理员看见。
 */
export function hostOwnerLabel(
  viewer: { id: number; role: string },
  host: { userId?: unknown },
  names: ReadonlyMap<number, string>,
): string | null {
  if (viewer.role !== "admin") return null;
  const ownerId = Number(host?.userId || 0);
  if (ownerId <= 0) return null;
  if (ownerId === Number(viewer.id)) return null;
  return names.get(ownerId) || `已注销用户 #${ownerId}`;
}

function compactHostForList(host: any) {
  const { agentToken, ...rest } = host || {};
  return withDetectedPrivateIpv4(rest);
}

/**
 * 带上 FXP 报上来的主机公网出口整形状态（forwardx-fxp/link_shaper.go 的 egress，
 * 面板记在 tunnel_link_shaping 里 tunnelId 0 那一行）。关着的机器也给 null，卡片好判断。
 */
async function withHostEgressShapingStatus<T extends { id?: unknown }>(hostRows: T[]) {
  const ids = hostRows.filter((host: any) => hostEgressShaping(host).mode !== "off").map((host: any) => Number(host.id));
  const rows = ids.length > 0 ? await db.listHostEgressShapingByHostIds(ids).catch(() => []) : [];
  const byHost = new Map(rows.map((row: any) => [Number(row.hostId), row]));
  return hostRows.map((host: any) => {
    const row = byHost.get(Number(host.id));
    return {
      ...host,
      egressShapingStatus: row
        ? {
            mode: String(row.mode || "off"),
            state: String(row.state || "off"),
            rateMbps: Number(row.rateMbps || 0),
            learnedMbps: Number(row.learnedMbps || 0),
            lossPct: Number(row.lossPermille || 0) / 10,
            updatedAt: row.updatedAt ?? null,
          }
        : null,
    };
  });
}

/** 带上 Agent 上报的内网 IPv4，编辑框里「内网地址」拿它做建议（见 agentPrivateAddress） */
function withDetectedPrivateIpv4<T extends Record<string, any>>(host: T): T & { detectedPrivateIpv4: string | null } {
  return { ...host, detectedPrivateIpv4: agentPrivateIpv4(host?.id) };
}

function hostMatchesListSearch(host: any, search: string) {
  const tokens = String(search || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const text = [
    host?.id,
    host?.name,
    host?.ip,
    host?.ipv4,
    host?.ipv6,
    host?.entryIp,
    host?.tunnelEntryIp,
    host?.osInfo,
    host?.cpuInfo,
    host?.agentVersion,
    host?.hostType,
  ].map((value) => String(value || "").toLowerCase()).join(" ");
  return tokens.every((token) => text.includes(token));
}

function orderHostsByGroups(hostRows: any[], groups: any[], selectedGroupId?: number | null) {
  const hostById = new Map(hostRows.map((host) => [Number(host.id), host]));
  const enabledGroups = [...groups]
    .filter((group) => group?.isEnabled !== false)
    .sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0) || Number(a.id || 0) - Number(b.id || 0));
  if (selectedGroupId) {
    const selected = enabledGroups.find((group) => Number(group.id) === Number(selectedGroupId));
    return (selected?.hostIds || selected?.members?.map((member: any) => member.hostId) || [])
      .map((hostId: unknown) => hostById.get(Number(hostId)))
      .filter(Boolean);
  }
  if (enabledGroups.length === 0) return hostRows;

  const ordered: any[] = [];
  const used = new Set<number>();
  for (const group of enabledGroups) {
    const hostIds = group?.hostIds || group?.members?.map((member: any) => member.hostId) || [];
    for (const value of hostIds) {
      const hostId = Number(value || 0);
      const host = hostById.get(hostId);
      if (!host || used.has(hostId)) continue;
      used.add(hostId);
      ordered.push(host);
    }
  }
  for (const host of hostRows) {
    const hostId = Number(host.id || 0);
    if (!used.has(hostId)) ordered.push(host);
  }
  return ordered;
}

function compactHostStatus(host: any) {
  return {
    id: Number(host?.id || 0),
    isOnline: !!host?.isOnline,
    lastHeartbeat: host?.lastHeartbeat || null,
    agentVersion: host?.agentVersion || null,
    fxpVersion: host?.fxpVersion || null,
    agentUpgradeRequested: !!host?.agentUpgradeRequested,
    agentUpgradeTargetVersion: host?.agentUpgradeTargetVersion || null,
    agentUpgradeRequestedAt: host?.agentUpgradeRequestedAt || null,
    updatedAt: host?.updatedAt || null,
  };
}

function compactHostMetricSummary(row: any) {
  return {
    hostId: Number(row?.hostId || 0),
    cpuUsage: row?.cpuUsage ?? null,
    memoryUsage: row?.memoryUsage ?? null,
    memoryUsed: row?.memoryUsed ?? null,
    swapUsage: row?.swapUsage ?? null,
    swapUsed: row?.swapUsed ?? null,
    swapTotal: row?.swapTotal ?? null,
    networkSpeedIn: row?.networkSpeedIn == null ? null : Math.round(Number(row.networkSpeedIn) || 0),
    networkIn: row?.networkIn == null ? null : Math.max(0, Number(row.networkIn) || 0),
    networkOut: row?.networkOut == null ? null : Math.max(0, Number(row.networkOut) || 0),
    networkSpeedOut: row?.networkSpeedOut == null ? null : Math.round(Number(row.networkSpeedOut) || 0),
    diskUsage: row?.diskUsage ?? null,
    diskUsed: row?.diskUsed ?? null,
    diskTotal: row?.diskTotal ?? null,
    uptime: row?.uptime ?? null,
    recordedAt: row?.recordedAt || null,
  };
}

function compactHostTrafficSummary(row: any) {
  return {
    hostId: Number(row?.hostId || 0),
    bytesIn: Math.max(0, Number(row?.bytesIn) || 0),
    bytesOut: Math.max(0, Number(row?.bytesOut) || 0),
  };
}

function normalizePublicHostMonitorPath(value: unknown) {
  const text = String(value || "dev")
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
  return text || "dev";
}

function compactPublicMonitorHost(host: any) {
  return {
    id: Number(host?.id || 0),
    name: host?.name || "",
    memoryTotal: host?.memoryTotal ?? null,
    agentVersion: host?.agentVersion || null,
    stoppedAt: host?.stoppedAt || null,
    trafficLimit: host?.trafficLimit ?? 0,
    trafficMeasureMode: host?.trafficMeasureMode || "both",
    isOnline: !!host?.isOnline,
    lastHeartbeat: host?.lastHeartbeat || null,
    sortOrder: Number(host?.sortOrder || 0),
    geoCountryCode: host?.geoCountryCode || null,
    geoCountryName: host?.geoCountryName || null,
    geoRegion: host?.geoRegion || null,
    geoEmoji: host?.geoEmoji || null,
  };
}

function compactPublicMonitorGroup(group: any, visibleHostIds: Set<number>) {
  const hostIds = (group?.hostIds || [])
    .map((id: unknown) => Number(id))
    .filter((id: number) => Number.isInteger(id) && id > 0 && visibleHostIds.has(id));
  return {
    id: Number(group?.id || 0),
    name: String(group?.name || ""),
    sortOrder: Number(group?.sortOrder || 0),
    hostIds,
  };
}

function publicProbeServiceAppliesToHost(service: any, hostId: number) {
  const id = Number(hostId);
  if (!id || service?.isEnabled === false) return false;
  const scope = String(service?.hostScope || "all");
  if (scope === "specific") return (service.hostIds || []).map(Number).includes(id);
  if (scope === "exclude") return !(service.excludeHostIds || []).map(Number).includes(id);
  return true;
}

function compactPublicProbeService(service: any, latest?: any) {
  const latestCounts = latest
    ? normalizeAgentProbeCounts({ ...latest, isTimeout: !!latest.isTimeout })
    : null;
  return {
    id: Number(service?.id || 0),
    name: String(service?.name || ""),
    method: service?.method === "ping" ? "ping" : "tcping",
    latest: latest ? {
      latencyMs: latest.latencyMs == null ? null : Number(latest.latencyMs),
      isTimeout: latestCounts ? latestCounts.probeSuccesses <= 0 : !!latest.isTimeout,
      // Keep packet-level counters in the public monitor response so a
      // partial-loss ping (for example 4/5 replies) is not collapsed into a
      // binary success when the detail page builds its statistics.
      probeCount: latestCounts?.probeCount ?? 1,
      probeSuccesses: latestCounts?.probeSuccesses ?? 0,
      recordedAt: latest.recordedAt || null,
    } : null,
  };
}

function compactPublicProbeSeries(row: any) {
  const counts = normalizeAgentProbeCounts({ ...row, isTimeout: !!row?.isTimeout });
  return {
    serviceId: Number(row?.serviceId || 0),
    hostId: Number(row?.hostId || 0),
    latencyMs: row?.latencyMs == null ? null : Number(row.latencyMs),
    isTimeout: counts.probeSuccesses <= 0,
    probeCount: counts.probeCount,
    probeSuccesses: counts.probeSuccesses,
    recordedAt: row?.recordedAt || null,
  };
}

async function assertPublicHostMonitorRequest(path: unknown) {
  const settings = await db.getAllSettings();
  const configuredPath = normalizePublicHostMonitorPath(settings.publicHostMonitorPath);
  const requestedPath = normalizePublicHostMonitorPath(path);
  if (settings.publicHostMonitorEnabled !== "true" || requestedPath !== configuredPath) {
    throw new TRPCError({ code: "NOT_FOUND", message: "主机监控面板未开启或路径不正确" });
  }
  return { settings, configuredPath };
}

async function loadPublicMonitor(configuredPath: string) {
  const hosts = (await filterPublicMonitorHosts(await db.getHosts() as any[])).map(compactPublicMonitorHost).filter((host) => host.id > 0);
  const hostIds = hosts.map((host) => host.id);
  const visibleHostIds = new Set(hostIds);
  const [metricRows, trafficRows] = await Promise.all([
    db.getLatestHostMetricRows(hostIds),
    db.getHostTrafficSummary(hostIds),
  ]);
  const groups = ((await db.getHostGroups()) as any[])
    .filter((group) => !!group?.isEnabled)
    .map((group) => compactPublicMonitorGroup(group, visibleHostIds))
    .filter((group) => group.id > 0 && group.name && group.hostIds.length > 0)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  const compactMetrics = (metricRows as any[]).map(compactHostMetricSummary).filter((row) => row.hostId > 0);
  const compactTraffic = (trafficRows as any[]).map(compactHostTrafficSummary).filter((row) => row.hostId > 0);
  let currentTrafficIn = 0;
  let currentTrafficOut = 0;
  for (const row of compactMetrics) {
    currentTrafficIn += Math.max(0, Number(row.networkSpeedIn) || 0);
    currentTrafficOut += Math.max(0, Number(row.networkSpeedOut) || 0);
  }
  let totalTrafficIn = 0;
  let totalTrafficOut = 0;
  for (const row of compactTraffic) {
    totalTrafficIn += Math.max(0, Number(row.bytesIn) || 0);
    totalTrafficOut += Math.max(0, Number(row.bytesOut) || 0);
  }
  return {
    path: configuredPath,
    refreshedAt: new Date().toISOString(),
    hosts,
    groups,
    metrics: compactMetrics,
    traffic: compactTraffic,
    summary: {
      totalHosts: hosts.length,
      onlineHosts: hosts.filter((host) => !!host.isOnline).length,
      currentTrafficIn,
      currentTrafficOut,
      totalTrafficIn,
      totalTrafficOut,
    },
  };
}

async function loadPublicMonitorHostDetail(configuredPath: string, hostId: number, hours: number) {
  const rawHost = await db.getHostById(hostId) as any;
  if (!rawHost || (await filterPublicMonitorHosts([rawHost])).length === 0) throw new TRPCError({ code: "NOT_FOUND", message: "主机不存在" });
  const host = compactPublicMonitorHost(rawHost);
  const [metricRows, trafficRows, allServices] = await Promise.all([
    db.getLatestHostMetricRows([host.id]),
    db.getHostTrafficSummary([host.id]),
    db.getHostProbeServices(),
  ]);
  const services = (allServices as any[])
    .filter((service) => publicProbeServiceAppliesToHost(service, host.id));
  const serviceIds = services.map((service) => Number(service.id)).filter((id) => Number.isInteger(id) && id > 0);
  let series: any[] = [];
  let latestByService = new Map<number, any>();
  if (serviceIds.length > 0) {
    const [rawSeries, latest] = await Promise.all([
      db.getHostProbeServiceSeries({ serviceIds, hostId: host.id, hours, limit: 20_000 }),
      db.getLatestHostProbeServiceStats(serviceIds, host.id),
    ]);
    series = (rawSeries as any[])
      .map(compactPublicProbeSeries)
      .filter((row) => row.serviceId > 0 && row.hostId === host.id);
    latestByService = latest as Map<number, any>;
  }
  return {
    path: configuredPath,
    refreshedAt: new Date().toISOString(),
    host,
    metric: (metricRows as any[]).map(compactHostMetricSummary).find((row) => row.hostId === host.id) || null,
    traffic: (trafficRows as any[]).map(compactHostTrafficSummary).find((row) => row.hostId === host.id) || compactHostTrafficSummary({ hostId: host.id }),
    services: services.map((service) => compactPublicProbeService(service, latestByService.get(Number(service.id))))
      .filter((service) => service.id > 0 && service.name),
    serviceSeries: series,
  };
}

function scheduleStaleHostUpgradeCleanup() {
  const now = Date.now();
  if (hostUpgradeCleanupRunning || now - lastHostUpgradeCleanupAt < HOST_UPGRADE_CLEANUP_INTERVAL_MS) return;
  hostUpgradeCleanupRunning = true;
  lastHostUpgradeCleanupAt = now;
  void db.clearStaleHostAgentUpgradeRequests()
    .catch((error) => {
      console.warn("[Hosts] Failed to clear stale Agent upgrade requests:", error);
    })
    .finally(() => {
      hostUpgradeCleanupRunning = false;
    });
}

function scheduleOrphanedAgentHostCleanup() {
  const now = Date.now();
  if (orphanedAgentHostCleanupRunning || now - lastOrphanedAgentHostCleanupAt < ORPHANED_AGENT_HOST_CLEANUP_INTERVAL_MS) return;
  orphanedAgentHostCleanupRunning = true;
  lastOrphanedAgentHostCleanupAt = now;
  void db.purgeOrphanedAgentHosts()
    .then((count) => {
      if (count > 0) console.info(`[Hosts] Purged orphaned Agent host records count=${count}`);
    })
    .catch((error) => {
      console.warn("[Hosts] Failed to purge orphaned Agent hosts:", error instanceof Error ? error.message : String(error));
    })
    .finally(() => {
      orphanedAgentHostCleanupRunning = false;
    });
}

export const hostsRouter = router({
    publicMonitor: publicProcedure
      .input(z.object({ path: z.string().max(128).optional() }).optional())
      .query(async ({ input }) => {
        // 开关/路径校验留在缓存外面：面板关掉或改了路径要立刻生效，不能被缓存里的旧结果放行。
        const { configuredPath } = await assertPublicHostMonitorRequest(input?.path);
        // 这一页不登录、每个观看者每 3 秒轮询一次，N 个人开着就是 N 倍的整页查询。
        // 结果与观看者无关，按配置的路径缓存 2 秒（过期后 5 秒内先回旧值、后台刷新）。
        return hostQueryCache.get(
          `publicMonitor:${configuredPath}`,
          { ttlMs: 2_000, staleMs: 5_000 },
          () => loadPublicMonitor(configuredPath),
        );
      }),
    publicMonitorHostDetail: publicProcedure
      .input(z.object({
        path: z.string().max(128).optional(),
        hostId: z.number().int().positive(),
        hours: z.number().int().min(1).max(72).default(24),
      }))
      .query(async ({ input }) => {
        const { configuredPath } = await assertPublicHostMonitorRequest(input.path);
        // 同上：校验在缓存外，结果按路径 + 主机 + 时间范围缓存。
        return hostQueryCache.get(
          `publicMonitorHostDetail:${configuredPath}:${input.hostId}:${input.hours}`,
          { ttlMs: 2_000, staleMs: 5_000 },
          () => loadPublicMonitorHostDetail(configuredPath, input.hostId, input.hours),
        );
      }),
    list: protectedProcedure.query(async ({ ctx }) => {
      if (ctx.user.role === "admin") {
        scheduleStaleHostUpgradeCleanup();
        scheduleOrphanedAgentHostCleanup();
      }
      const hosts = await getVisibleHostsForUser(ctx.user);
      return withHostEgressShapingStatus(hosts.map(compactHostForList));
    }),
    options: protectedProcedure.query(async ({ ctx }) => {
      const scope = await visibleHostQueryScope(ctx.user);
      let hosts: any[];
      try {
        hosts = await db.getHostOptions(scope.ownerUserId, scope.allowedHostIds, scope.sortUserId) as any[];
      } catch (error) {
        // Keep compact host consumers usable when a deployment has a transient
        // projection/order incompatibility. The fallback uses the same scope;
        // it never broadens a non-admin user's host visibility.
        console.warn(
          `[Hosts] options projection failed user=${ctx.user.id}; falling back to list query:`,
          error instanceof Error ? error.message : String(error),
        );
        const visible = await getVisibleHostsForUser(ctx.user, { scheduleGeoRefresh: false });
        hosts = visible.map(compactHostForList);
      }
      scheduleHostGeoRefresh(hosts);
      return hosts;
    }),
    listPage: protectedProcedure
      .input(pageRequestSchema.extend({
        search: z.string().trim().max(200).optional().default(""),
        groupId: z.number().int().positive().nullable().optional(),
      }))
      .query(async ({ input, ctx }) => {
        if (ctx.user.role === "admin") {
          scheduleStaleHostUpgradeCleanup();
          scheduleOrphanedAgentHostCleanup();
        }
        const scope = await visibleHostQueryScope(ctx.user);
        const [pageData, groups] = await Promise.all([
          db.getHostsPage({
            ...input,
            ...scope,
            orderByGroups: ctx.user.role === "admin",
          }),
          ctx.user.role === "admin" ? db.getHostGroups() : Promise.resolve([]),
        ]);
        const items = await clearCompletedHostAgentUpgradeRequests(pageData.items as any[]);
        scheduleHostGeoRefresh(items);
        /*
          管理员那边标出每台机器是谁的。

          租户可以自助加机器（订阅管理里那个入口），加完了这台机器就出现在管理员
          的主机管理里 —— 这是对的，面板是管理员在跑，出了事要能查、要能删。但列表
          上一个字都没说这是谁的，管理员看到的是一台凭空多出来的陌生机器。

          只给管理员：普通用户能看见的除了自己的，还有被授权用的别人的机器，
          在那里标出主人等于把另一个租户的身份透给他。
        */
        const ownerNames = ctx.user.role === "admin"
          ? await db.getUserDisplayNamesByIds(items.map((row: any) => Number(row.userId)))
          : new Map<number, string>();
        /*
          这台机器上的转发是扣余额还是吃套餐流量 —— 摆到卡片上。

          两条路互斥（见 agentReportRoutes 里那个 billingResource 分支），而列表上
          原来一个字都没有：「这台到底在不在计费」得一台台点进去看，记错账的代价是
          真金白银。

          答案不在主机上。计费配置挂在**转发组 / 隧道**上（主机那一档只剩历史配置，
          界面里那一项是禁用的），所以只能顺着这台机器上的转发去问：每条转发按
          转发组 → 隧道 → 主机 的顺序找配置，找得到就是按量计费。

          第一版我只查了主机那一档，于是新部署上每台都显示「走套餐流量」—— 哪怕
          上面的转发正按组计费。摆一个关于钱的结论在显眼处，就得是真的。
        */
        // 总开关关着就一分钱都不扣（agentReportRoutes 里是同一个判断），那卡片上也
        // 不能说「按量计费」—— 顺带省掉底下这一整串查询。
        const trafficBillingEnabled = await db.isTrafficBillingEnabled();
        const billingRules = trafficBillingEnabled
          ? await db.getBillingRelevantRulesByHostIds(items.map((row: any) => Number(row.id)))
          : [];
        const billingByRuleId = billingRules.length > 0
          ? await db.findTrafficBillingResourcesForRules(billingRules)
          : new Map();
        /*
          这台机器自己那条「整台兜底价」。

          和上面那个统计是两件事：上面答的是「现在这台上的转发实际在怎么算钱」（走
          转发组 / 隧道 / 主机哪一档都算），这个答的是「这台机器本身配没配价」——
          主机管理里的按量计费弹窗要拿它回填，没有的话每次打开都是空白，人会以为
          没配过然后再配一条。只给管理员：配置和价钱都是商家的事。
        */
        const hostBillingConfigs = ctx.user.role === "admin"
          ? await db.findHostTrafficBillingConfigs(items.map((row: any) => Number(row.id)))
          : new Map();
        /*
          这台机器上挂了几条转发、在几条隧道里 —— 摆到卡片上。

          两个数都是整页一次 GROUP BY 查完（不是一台台查）。只是个数，不按人过滤：
          能看见这台机器的人看见「上面有 3 条转发」透不出别的租户的任何东西。
          转发不看启用状态；隧道按入口 / 出口 / 任一跳算，同一条隧道只算一次。
        */
        const pageHostIds = items.map((row: any) => Number(row.id));
        const [ruleCounts, tunnelCounts] = await Promise.all([
          db.countForwardRulesByHostIds(pageHostIds),
          db.countTunnelsByHostIds(pageHostIds),
        ]);
        const billingStatsByHost = new Map<number, { total: number; billed: number; milliCents: number; hostDefault: boolean }>();
        for (const rule of billingRules) {
          const hostId = Number(rule.hostId);
          const stat = billingStatsByHost.get(hostId) || { total: 0, billed: 0, milliCents: 0, hostDefault: false };
          stat.total += 1;
          const resource = billingByRuleId.get(Number(rule.id));
          if (resource?.config) {
            stat.billed += 1;
            // 这条是靠「整台兜底价」才算上钱的（转发组 / 隧道都没配）。读的是转发
            // 实际落在哪一档，而不是「这台机器有没有一条 host 配置」—— 后者在配了
            // 但每条转发都被组价接走时会说谎。
            if (resource.resourceType === "host") stat.hostDefault = true;
            // 同一台机器上的几条转发可能挂在不同资源上、单价不同 —— 取其一做展示，
            // 多种价钱时界面只说「按量计费」，不编一个平均值出来。
            const price = Math.max(0, Number(resource.config.pricePerGbMilliCents) || 0);
            stat.milliCents = stat.milliCents === 0 || stat.milliCents === price ? price : -1;
          }
          billingStatsByHost.set(hostId, stat);
        }
        const withOwners = items.map((row: any) => {
          const stat = billingStatsByHost.get(Number(row.id));
          const billed = stat?.billed || 0;
          return {
            ...row,
            ownerLabel: hostOwnerLabel(ctx.user, row, ownerNames),
            // 非管理员不给单价：他只需要知道「这台上的转发在按量计费」，价钱是商家的事。
            trafficBilling: billed > 0
              ? {
                billedRules: billed,
                totalRules: stat?.total || 0,
                // -1 表示这台机器上有好几种单价，界面据此只说「按量计费」不报价。
                pricePerGbMilliCents: ctx.user.role === "admin" ? (stat?.milliCents ?? 0) : 0,
                // 整台兜底价在管着的话，界面要说清「这台上没单独计价的转发按这个走」，
                // 而不是让人以为每一条都单独配过。
                hostDefault: !!stat?.hostDefault,
              }
              : null,
            // 这台机器自己配的整台兜底价（含停用的），只给管理员。
            hostBillingConfig: hostBillingConfigs.get(Number(row.id)) || null,
            // 这台上挂了几条转发、在几条隧道里；没有的话就是 0，不是 undefined。
            ruleCount: ruleCounts.get(Number(row.id)) || 0,
            tunnelCount: tunnelCounts.get(Number(row.id)) || 0,
            // 不是自己的机器：能看（说明管理员授权过），但改不动也删不掉 ——
            // 服务端 update/delete 本来就按 userId 挡着，界面据此收起入口。
            manageable: ctx.user.role === "admin" || Number(row.userId) === ctx.user.id,
          };
        });
        let outdatedItems = 0;
        let onlineOutdatedItems = 0;
        let offlineUpgradeableItems = 0;
        for (const row of pageData.versionCounts as any[]) {
          if (!hostNeedsAgentUpgrade(row, AGENT_VERSION)) continue;
          const count = Math.max(0, Number(row.count || 0));
          outdatedItems += count;
          if (row.online) onlineOutdatedItems += count;
          else offlineUpgradeableItems += count;
        }
        const groupCounts = Object.fromEntries((groups as any[]).map((group) => [
          Number(group.id),
          (group.hostIds || group.members?.map((member: any) => member.hostId) || [])
            .filter((hostId: unknown) => Number(hostId) > 0).length,
        ]));
        return {
          ...pageData,
          items: withOwners.map(compactHostForList),
          versionCounts: undefined,
          outdatedItems,
          onlineOutdatedItems,
          offlineUpgradeableItems,
          groupCounts,
        };
      }),
    upgradeCandidates: adminProcedure
      .input(z.object({
        search: z.string().trim().max(200).optional().default(""),
        groupId: z.number().int().positive().nullable().optional(),
      }))
      .query(async ({ input }) => {
        scheduleStaleHostUpgradeCleanup();
        const hosts = await db.getHostUpgradeCandidates(input) as any[];
        const outdated = hosts.filter((host: any) => hostNeedsAgentUpgrade(host, AGENT_VERSION));
        const candidates = outdated.filter((host: any) => {
          if (!host.isOnline) return false;
          const requestedAt = host.agentUpgradeRequestedAt ? new Date(host.agentUpgradeRequestedAt).getTime() : 0;
          const timedOut = !!host.agentUpgradeRequested && requestedAt > 0 && Date.now() - requestedAt > 10 * 60 * 1000;
          return !host.agentUpgradeRequested || timedOut;
        });
        return {
          ids: candidates.map((host: any) => Number(host.id)),
          totalItems: candidates.length,
          offlineItems: outdated.filter((host: any) => !host.isOnline).length,
        };
      }),
    mapPoints: protectedProcedure
      .input(z.object({
        cursor: z.number().int().min(0).optional(),
        limit: z.number().int().min(20).max(250).default(100),
        search: z.string().trim().max(200).optional().default(""),
        groupId: z.number().int().positive().nullable().optional(),
      }))
      .query(async ({ input, ctx }) => {
        const cursor = Math.max(0, Number(input.cursor || 0));
        const scope = await visibleHostQueryScope(ctx.user);
        const pageData = await db.getHostsPage({
          ...scope,
          search: input.search,
          groupId: input.groupId,
          orderByGroups: ctx.user.role === "admin",
          page: Math.floor(cursor / input.limit) + 1,
          pageSize: input.limit,
        });
        const rows = cursor < pageData.totalItems ? pageData.items as any[] : [];
        scheduleHostGeoRefresh(rows);
        const items = rows.map((host: any) => ({
          id: Number(host.id),
          name: String(host.name || ""),
          ip: host.ip || null,
          ipv4: host.ipv4 || null,
          ipv6: host.ipv6 || null,
          isOnline: !!host.isOnline,
          osInfo: host.osInfo || null,
          agentVersion: host.agentVersion || null,
          geoCountryCode: host.geoCountryCode || null,
          geoCountryName: host.geoCountryName || null,
          geoRegion: host.geoRegion || null,
          geoLatitudeMicro: host.geoLatitudeMicro ?? null,
          geoLongitudeMicro: host.geoLongitudeMicro ?? null,
        }));
        const nextCursor = cursor + rows.length < pageData.totalItems ? cursor + rows.length : undefined;
        return { items, nextCursor, totalItems: pageData.totalItems };
      }),
    statusSummary: protectedProcedure
      .input(z.object({ hostIds: z.array(z.number().int().positive()).max(100).optional() }).optional())
      .query(async ({ input, ctx }) => {
      const requestedIds = Array.from(new Set((input?.hostIds || []).map(Number).filter((id) => id > 0)));
      if (requestedIds.length === 0) return [];
      const scope = await visibleHostQueryScope(ctx.user);
      const hosts = await db.getHostStatusRows({ ...scope, hostIds: requestedIds });
      return hosts
        .map(compactHostStatus)
        .filter((host: ReturnType<typeof compactHostStatus>) => host.id > 0);
    }),
    summary: protectedProcedure
      .input(z.object({
        search: z.string().trim().max(200).optional().default(""),
        groupId: z.number().int().positive().nullable().optional(),
      }).optional())
      .query(async ({ input, ctx }) => hostQueryCache.get(
      `summary:${ctx.user.id}:${input?.groupId || "all"}:${input?.search || ""}`,
      { ttlMs: 2_000, staleMs: 10_000 },
      async () => {
        const scope = await visibleHostQueryScope(ctx.user);
        const summaryScope = await db.getHostSummaryScope({
          ...scope,
          search: input?.search || "",
          groupId: input?.groupId,
        });
        const hostIds = summaryScope.hostIds;
        const [metricSnapshots, trafficRows, statusRows] = await Promise.all([
          db.getLatestHostMetricSnapshots(hostIds),
          db.getHostTrafficSummary(hostIds),
          db.getHostStatusRows({ ...scope, search: input?.search || "", groupId: input?.groupId, hostIds }),
        ]);
        // 「此刻进出多快」只算在线的：离线主机最后两份快照算出来的速度是它掉线前的，
        // 加进去会让页头在 0 台在线时还写着几十 MB/s。
        const onlineHostIds = new Set(
          (statusRows as any[]).filter((row) => !!row?.isOnline).map((row) => Number(row.id)),
        );
        const instantTraffic = db.summarizeHostInstantTraffic(
          (metricSnapshots as any[]).filter((row) => onlineHostIds.has(Number(row?.hostId))),
        );
        let totalTrafficIn = 0;
        let totalTrafficOut = 0;
        for (const row of trafficRows as any[]) {
          totalTrafficIn += Math.max(0, Number(row?.bytesIn) || 0);
          totalTrafficOut += Math.max(0, Number(row?.bytesOut) || 0);
        }
        return {
          totalHosts: summaryScope.totalHosts,
          onlineHosts: summaryScope.onlineHosts,
          currentTrafficIn: instantTraffic.currentTrafficIn,
          currentTrafficOut: instantTraffic.currentTrafficOut,
          currentTrafficTotal: instantTraffic.currentTrafficTotal,
          measuredHosts: instantTraffic.measuredHosts,
          totalTrafficIn,
          totalTrafficOut,
          totalTraffic: totalTrafficIn + totalTrafficOut,
        };
      },
    )),
    probeServices: protectedProcedure.query(async ({ ctx }) => {
      const isAdmin = ctx.user.role === "admin";
      const services = await db.getHostProbeServices(isAdmin ? undefined : ctx.user.id);
      const latestById = await db.getLatestHostProbeServiceStats(services.map((service: any) => Number(service.id)));
      return services.map((service: any) => ({
        ...service,
        latest: latestById.get(Number(service.id)) || null,
      }));
    }),
    probeServiceSeries: protectedProcedure
      .input(z.object({ serviceIds: z.array(z.number().int().positive()).max(200).optional(), hostId: z.number().int().positive().optional(), hours: z.number().min(0.5).max(24 * 3).default(24) }).optional())
      .query(async ({ input, ctx }) => {
        const isAdmin = ctx.user.role === "admin";
        const visibleServices = await db.getHostProbeServices(isAdmin ? undefined : ctx.user.id);
        const visibleIds = new Set((visibleServices as any[]).map((service) => Number(service.id)));
        const requested = Array.from(new Set((input?.serviceIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0)));
        const serviceIds = requested.length > 0 ? requested.filter((id) => visibleIds.has(id)) : Array.from(visibleIds);
        if (serviceIds.length === 0) return [];
        return db.getHostProbeServiceSeries({ serviceIds, hostId: input?.hostId, hours: input?.hours || 24 });
      }),
    createProbeService: adminProcedure
      .input(hostProbeServiceInputSchema)
      .mutation(async ({ input, ctx }) => {
        const payload = normalizeHostProbeServiceInput(input);
        const id = await db.createHostProbeService({ ...payload, userId: ctx.user.id });
        return { id };
      }),
    updateProbeService: adminProcedure
      .input(hostProbeServiceInputSchema.extend({ id: z.number().int().positive() }))
      .mutation(async ({ input }) => {
        const service = await db.getHostProbeServiceById(input.id);
        if (!service) throw new Error("服务不存在");
        const payload = normalizeHostProbeServiceInput(input);
        await db.updateHostProbeService(input.id, payload);
        return { success: true };
      }),
    deleteProbeService: adminProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(async ({ input }) => {
        const service = await db.getHostProbeServiceById(input.id);
        if (!service) throw new Error("服务不存在");
        await db.deleteHostProbeService(input.id);
        return { success: true };
      }),
    reorderProbeServices: adminProcedure
      .input(z.object({ ids: reorderIdsSchema }))
      .mutation(async ({ input }) => {
        await db.reorderHostProbeServices(input.ids);
        return { success: true };
      }),
    hostGroups: adminProcedure.query(async () => db.getHostGroups()),
    createHostGroup: adminProcedure
      .input(hostGroupInputSchema)
      .mutation(async ({ input, ctx }) => {
        const payload = normalizeHostGroupInput(input);
        await assertHostGroupHostIdsExist(payload.hostIds);
        const id = await db.createHostGroup({ ...payload, userId: ctx.user.id });
        return { id };
      }),
    updateHostGroup: adminProcedure
      .input(hostGroupInputSchema.extend({ id: z.number().int().positive() }))
      .mutation(async ({ input }) => {
        const group = await db.getHostGroupById(input.id);
        if (!group) throw new Error("主机分组不存在");
        const payload = normalizeHostGroupInput(input);
        await assertHostGroupHostIdsExist(payload.hostIds);
        await db.updateHostGroup(input.id, payload);
        return { success: true };
      }),
    deleteHostGroup: adminProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(async ({ input }) => {
        const group = await db.getHostGroupById(input.id);
        if (!group) throw new Error("主机分组不存在");
        await db.deleteHostGroup(input.id);
        return { success: true };
      }),
    reorderHostGroups: adminProcedure
      .input(z.object({ ids: reorderIdsSchema }))
      .mutation(async ({ input }) => {
        await db.reorderHostGroups(input.ids);
        return { success: true };
      }),
    reorderHostGroupMembers: adminProcedure
      .input(z.object({
        groupId: z.number().int().positive(),
        hostIds: reorderIdsSchema,
        startIndex: z.number().int().min(0).max(1_000_000).optional().default(0),
      }))
      .mutation(async ({ input }) => {
        const group = await db.getHostGroupById(input.groupId);
        if (!group) throw new Error("主机分组不存在");
        await assertHostGroupHostIdsExist(input.hostIds);
        await db.reorderHostGroupMembers(input.groupId, input.hostIds, input.startIndex);
        return { success: true };
      }),
    /** 获取所有主机列表（管理员用，用于权限分配） */
    listAll: adminProcedure.query(async () => {
      const hosts = await getHostsWithUpgradeStateCleanup();
      scheduleHostGeoRefresh(hosts);
      return hosts;
    }),
    getById: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input, ctx }) => {
        const host = await db.getHostById(input.id);
        if (!host) return null;
        if (ctx.user.role !== "admin") {
          if (host.userId !== ctx.user.id) {
            const hasPermission = await db.checkUserHostPermission(ctx.user.id, host.id);
            if (!hasPermission) return null;
          }
        }
        return ctx.user.role === "admin" ? withDetectedPrivateIpv4(host) : compactHostForList(host);
      }),
    create: protectedProcedure
      .input(z.object({
        name: z.string().min(1).max(128),
        ip: hostAddressSchema,
        hostType: z.enum(["master", "slave"]).default("slave"),
        networkInterface: networkInterfaceSchema,
        sortOrder: hostSortOrderSchema,
        entryIp: optionalHostAddressSchema,
        tunnelEntryIp: optionalHostAddressSchema,
        portRangeStart: z.number().int().min(1).max(65535).nullable().optional(),
        portRangeEnd: z.number().int().min(1).max(65535).nullable().optional(),
        portAllowlist: z.string().max(2000).nullable().optional(),
        purchasedAt: optionalDateInputSchema,
        stoppedAt: optionalDateInputSchema,
        trafficLimit: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
        trafficMeasureMode: hostTrafficMeasureModeSchema.optional(),
        egressShapingMode: hostEgressShapingModeSchema.optional(),
        egressMbps: hostEgressMbpsSchema.optional(),
        telegramTrafficAlertEnabled: z.boolean().optional(),
        trafficAlertThresholdPercent: z.number().int().min(1).max(99).optional(),
        telegramRenewalReminderEnabled: z.boolean().optional(),
        renewalReminderDays: z.number().int().min(1).max(365).optional(),
        billingCycleMonths: hostBillingCycleMonthsSchema.optional(),
        billingMonth: z.number().int().min(1).max(12).optional(),
        billingDay: z.number().int().min(1).max(31).optional(),
        expiryHandling: hostExpiryActionSchema.optional(),
        trafficAutoReset: z.boolean().optional(),
        trafficResetDay: z.number().int().min(1).max(31).optional(),
        ddnsEnabled: z.boolean().optional(),
        ddnsDomain: hostDdnsDomainSchema,
        ddnsRecordType: hostDdnsRecordTypeSchema.optional(),
        ddnsIpVersion: hostDdnsIpVersionSchema.optional(),
        blockHttp: z.boolean().optional(),
        blockSocks: z.boolean().optional(),
        blockTls: z.boolean().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        if (ctx.user.role !== "admin") {
          const [globalLimit, owner] = await Promise.all([
            db.getSetting("selfServiceHostLimit").then(selfServiceHostLimitFrom),
            db.getUserById(ctx.user.id),
          ]);
          const limit = selfServiceHostLimitForUser(owner, globalLimit);
          const owned = await db.countHostsByUserId(ctx.user.id);
          if (!canAddSelfServiceHost(ctx.user, owned, limit)) {
            throw new Error(`你自己添加的机器已达上限（${owned}/${limit}）。删掉一台，或让管理员调高上限。`);
          }
        }
        // 验证端口区间
        if ((input.portRangeStart != null && input.portRangeEnd == null) || (input.portRangeStart == null && input.portRangeEnd != null)) {
          throw new Error("请同时填写端口区间的起始和结束值，或同时留空");
        }
        if (input.portRangeStart != null && input.portRangeEnd != null) {
          if (input.portRangeStart > input.portRangeEnd) {
            throw new Error("端口区间起始值不能大于结束值");
          }
        }
        const agentToken = nanoid(32);
        const trafficConfig = ctx.user.role === "admin"
          ? hostTrafficConfigPayload(input)
          : { purchasedAt: null, stoppedAt: null, trafficLimit: 0, trafficMeasureMode: "both", telegramTrafficAlertEnabled: false, trafficAlertThresholdPercent: 20, telegramRenewalReminderEnabled: false, renewalReminderDays: 3, billingCycleMonths: 1, billingMonth: 1, billingDay: 1, expiryHandling: "none", trafficAutoReset: false, trafficResetDay: 1 };
        if (ctx.user.role === "admin" && (trafficConfig.telegramTrafficAlertEnabled || trafficConfig.telegramRenewalReminderEnabled)) {
          await assertTelegramBotConfiguredForHostReminder();
        }
        const ddnsConfig = ctx.user.role === "admin"
          ? normalizeHostDdnsPayload(input)
          : { ddnsEnabled: false, ddnsDomain: null, ddnsRecordType: "A", ddnsIpVersion: "ipv4" };
        if ((ddnsConfig as any).ddnsEnabled) await assertHostDdnsServiceConfigured();
        const egressConfig = hostEgressShapingPayload(input);
        const id = await db.createHost({
          ...input,
          ...trafficConfig,
          ...ddnsConfig,
          ...egressConfig,
          agentToken,
          networkInterface: input.networkInterface || null,
          sortOrder: input.sortOrder ?? 0,
          entryIp: input.entryIp || null,
          tunnelEntryIp: input.tunnelEntryIp || null,
          portRangeStart: input.portRangeStart ?? null,
          portRangeEnd: input.portRangeEnd ?? null,
          portAllowlist: normalizePortAllowlist(input.portAllowlist) || null,
          blockHttp: ctx.user.role === "admin" ? !!input.blockHttp : false,
          blockSocks: ctx.user.role === "admin" ? !!input.blockSocks : false,
          blockTls: ctx.user.role === "admin" ? !!input.blockTls : false,
          userId: ctx.user.id,
        });
        return { id, agentToken };
      }),
    /**
     * 自己那台机器的 Agent 安装命令。
     *
     * 「主机管理」整页对普通用户是关着的，可 hosts.create 本来就允许他建自己的
     * 主机 —— 建完却拿不到安装命令，机器就永远连不上，等于建了个空壳。
     *
     * 命令由服务端拼：拼它要读 panelPublicUrl、GitHub 加速、agentPreferPanelInstall
     * 三个系统设置，那是管理员接口，租户读不到。顺带 agentToken 也不必再单独
     * 发一趟 —— 列表接口是特意把它摘掉的（compactHostForList）。
     */
    agentInstallCommand: protectedProcedure
      .input(z.object({ hostId: z.number().int().positive() }))
      .query(async ({ input, ctx }) => {
        const host = await db.getHostById(input.hostId);
        if (!host) throw new Error("主机不存在");
        if (!canReadHostInstallCommand(ctx.user, host)) throw new Error("无权查看此主机的安装命令");
        const token = String((host as any).agentToken || "");
        if (!token) throw new Error("这台主机还没有 Agent 令牌");
        const settings = await db.getAllSettings();
        const panelUrl = await getConfiguredPanelUrl();
        return {
          /** 面板公开地址没配时为空 —— 界面要据此提示去配，而不是给一条装不上的命令。 */
          panelUrl,
          command: panelUrl
            ? buildAgentScriptCommand({
              panelUrl,
              action: "install",
              token,
              githubAcceleratorUrl: settings.githubAcceleratorUrl || "",
              githubAcceleratorEnabled: settings.githubAcceleratorEnabled === "true",
              preferPanelInstall: settings.agentPreferPanelInstall === "true",
            })
            : "",
        };
      }),
    /**
     * 自助加机器还能加几台。界面要把「2/10」摆出来 —— 到了上限才弹一句错误
     * 提示，等于让人白填一遍表单。
     */
    selfServiceQuota: protectedProcedure.query(async ({ ctx }) => {
      const [globalLimit, owner] = await Promise.all([
        db.getSetting("selfServiceHostLimit").then(selfServiceHostLimitFrom),
        db.getUserById(ctx.user.id),
      ]);
      // 这个人自己的上限优先，没设才用全局那一档。
      const limit = selfServiceHostLimitForUser(owner, globalLimit);
      const used = await db.countHostsByUserId(ctx.user.id);
      return {
        used,
        // 0 在这个接口上一直表示「不限」，界面据此显示「2 台」而不是「2/10」。
        // null（不限）翻回 0，管理员同理。
        limit: ctx.user.role === "admin" || limit === null ? 0 : limit,
        canAdd: canAddSelfServiceHost(ctx.user, used, limit),
      };
    }),
    reorder: protectedProcedure
      .input(z.object({
        ids: reorderIdsSchema,
        startIndex: z.number().int().min(0).max(1_000_000).optional().default(0),
      }))
      .mutation(async ({ input, ctx }) => {
        if (ctx.user.role === "admin") {
          await db.reorderHosts(input.ids, undefined, input.startIndex);
        } else {
          const scope = await visibleHostQueryScope(ctx.user);
          await db.reorderVisibleHostsForUser(input.ids, ctx.user.id, scope.allowedHostIds, input.startIndex);
        }
        return { success: true };
      }),
    update: protectedProcedure
      .input(z.object({
        id: z.number(),
        name: z.string().min(1).max(128).optional(),
        ip: hostAddressSchema.optional(),
        /** 手改「Agent 检测 IP」：只有改过才传；空串 = 交回自动检测（shared/hostManualAddress） */
        detectedAddress: z.string().max(200).optional(),
        hostType: z.enum(["master", "slave"]).optional(),
        networkInterface: networkInterfaceSchema,
        sortOrder: hostSortOrderSchema,
        entryIp: optionalHostAddressSchema,
        tunnelEntryIp: optionalHostAddressSchema,
        portRangeStart: z.number().int().min(1).max(65535).nullable().optional(),
        portRangeEnd: z.number().int().min(1).max(65535).nullable().optional(),
        portAllowlist: z.string().max(2000).nullable().optional(),
        purchasedAt: optionalDateInputSchema,
        stoppedAt: optionalDateInputSchema,
        trafficLimit: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
        trafficMeasureMode: hostTrafficMeasureModeSchema.optional(),
        egressShapingMode: hostEgressShapingModeSchema.optional(),
        egressMbps: hostEgressMbpsSchema.optional(),
        telegramTrafficAlertEnabled: z.boolean().optional(),
        trafficAlertThresholdPercent: z.number().int().min(1).max(99).optional(),
        telegramRenewalReminderEnabled: z.boolean().optional(),
        renewalReminderDays: z.number().int().min(1).max(365).optional(),
        billingCycleMonths: hostBillingCycleMonthsSchema.optional(),
        billingMonth: z.number().int().min(1).max(12).optional(),
        billingDay: z.number().int().min(1).max(31).optional(),
        expiryHandling: hostExpiryActionSchema.optional(),
        trafficAutoReset: z.boolean().optional(),
        trafficResetDay: z.number().int().min(1).max(31).optional(),
        ddnsEnabled: z.boolean().optional(),
        ddnsDomain: hostDdnsDomainSchema,
        ddnsRecordType: hostDdnsRecordTypeSchema.optional(),
        ddnsIpVersion: hostDdnsIpVersionSchema.optional(),
        blockHttp: z.boolean().optional(),
        blockSocks: z.boolean().optional(),
        blockTls: z.boolean().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const host = await db.getHostById(input.id);
        if (!host) throw new Error("主机不存在");
        if (ctx.user.role !== "admin" && host.userId !== ctx.user.id) throw new Error("无权操作此主机");
        // 验证端口区间
        const pStart = input.portRangeStart !== undefined ? input.portRangeStart : (host as any).portRangeStart;
        const pEnd = input.portRangeEnd !== undefined ? input.portRangeEnd : (host as any).portRangeEnd;
        if ((input.portRangeStart !== undefined || input.portRangeEnd !== undefined) && ((pStart != null && pEnd == null) || (pStart == null && pEnd != null))) {
          throw new Error("请同时填写端口区间的起始和结束值，或同时留空");
        }
        if (pStart != null && pEnd != null && pStart > pEnd) {
          throw new Error("端口区间起始值不能大于结束值");
        }
        const nextPortAllowlist = input.portAllowlist !== undefined
          ? normalizePortAllowlist(input.portAllowlist)
          : String((host as any).portAllowlist || "");
        const { id, detectedAddress, ...data } = input;
        let ddnsConfigChanged = false;
        // 公网出口整形：两个字段一起收敛；变了要让这台机器的 Agent 重发 FXP 配置。
        let egressShapingChanged = false;
        if ((data as any).egressShapingMode !== undefined || (data as any).egressMbps !== undefined) {
          const egressConfig = hostEgressShapingPayload({
            egressShapingMode: (data as any).egressShapingMode !== undefined ? (data as any).egressShapingMode : (host as any).egressShapingMode,
            egressMbps: (data as any).egressMbps !== undefined ? (data as any).egressMbps : (host as any).egressMbps,
          });
          const current = hostEgressShaping(host);
          egressShapingChanged = egressConfig.egressShapingMode !== current.mode || egressConfig.egressMbps !== current.mbps;
          Object.assign(data as any, egressConfig);
        }
        if (detectedAddress !== undefined) {
          const parsed = parseManualHostAddress(detectedAddress);
          if ("error" in parsed) throw new Error(`Agent 检测 IP：${parsed.error}`);
          if (parsed.manual) Object.assign(data as any, { ip: parsed.ip, ipv4: parsed.ipv4, ipv6: parsed.ipv6, addressManual: true });
          // 清空：交回 Agent，下一次心跳就会写上它查到的地址
          else (data as any).addressManual = false;
        }
        if (data.networkInterface !== undefined) data.networkInterface = data.networkInterface || null;
        if ((data as any).sortOrder !== undefined) (data as any).sortOrder = Math.min(200, Math.max(0, Math.floor(Number((data as any).sortOrder) || 0)));
        if (data.entryIp !== undefined) data.entryIp = data.entryIp || null;
        if (data.tunnelEntryIp !== undefined) data.tunnelEntryIp = data.tunnelEntryIp || null;
        if ((data as any).portAllowlist !== undefined) (data as any).portAllowlist = nextPortAllowlist || null;
        if (ctx.user.role === "admin") {
          const hasDdnsConfigInput = ["ddnsEnabled", "ddnsDomain", "ddnsRecordType", "ddnsIpVersion"].some((key) => (data as any)[key] !== undefined);
          if (hasDdnsConfigInput) {
            const ddnsConfig = normalizeHostDdnsPayload({
              ddnsEnabled: (data as any).ddnsEnabled !== undefined ? (data as any).ddnsEnabled : (host as any).ddnsEnabled,
              ddnsDomain: (data as any).ddnsDomain !== undefined ? (data as any).ddnsDomain : (host as any).ddnsDomain,
              ddnsRecordType: (data as any).ddnsRecordType !== undefined ? (data as any).ddnsRecordType : (host as any).ddnsRecordType,
              ddnsIpVersion: (data as any).ddnsIpVersion !== undefined ? (data as any).ddnsIpVersion : (host as any).ddnsIpVersion,
            });
            if (ddnsConfig.ddnsEnabled) await assertHostDdnsServiceConfigured();
            Object.assign(data as any, ddnsConfig);
            ddnsConfigChanged = true;
            const previousDdnsDomain = String((host as any).ddnsDomain || "").trim().replace(/\.+$/, "").toLowerCase();
            const ddnsTargetChanged = ddnsConfig.ddnsDomain !== previousDdnsDomain
              || ddnsConfig.ddnsEnabled !== !!(host as any).ddnsEnabled
              || ddnsConfig.ddnsIpVersion !== normalizeHostDdnsIpVersion((host as any).ddnsIpVersion, (host as any).ddnsRecordType);
            if (ddnsTargetChanged) {
              (data as any).lastDdnsValue = null;
              (data as any).lastDdnsAt = null;
              (data as any).lastDdnsError = null;
            }
          }
          const hasTrafficConfigInput = ["purchasedAt", "stoppedAt", "trafficLimit", "trafficMeasureMode", "telegramTrafficAlertEnabled", "trafficAlertThresholdPercent", "telegramRenewalReminderEnabled", "renewalReminderDays", "billingCycleMonths", "billingMonth", "billingDay", "expiryHandling", "trafficAutoReset", "trafficResetDay"].some((key) => (data as any)[key] !== undefined);
          if (hasTrafficConfigInput) {
            const purchasedAt = (data as any).purchasedAt !== undefined
              ? parseOptionalDateInput((data as any).purchasedAt, "机器购买时间")
              : normalizeExistingOptionalDate((host as any).purchasedAt);
            const stoppedAt = (data as any).stoppedAt !== undefined
              ? parseOptionalDateInput((data as any).stoppedAt, "机器停止时间")
              : normalizeExistingOptionalDate((host as any).stoppedAt);
            assertHostTrafficDates(purchasedAt, stoppedAt);
            if ((data as any).purchasedAt !== undefined) (data as any).purchasedAt = purchasedAt;
            if ((data as any).stoppedAt !== undefined) (data as any).stoppedAt = stoppedAt;
            if ((data as any).trafficLimit !== undefined) (data as any).trafficLimit = Math.max(0, Math.floor(Number((data as any).trafficLimit) || 0));
            if ((data as any).trafficMeasureMode !== undefined) (data as any).trafficMeasureMode = normalizeHostTrafficMeasureMode((data as any).trafficMeasureMode);
            if ((data as any).telegramTrafficAlertEnabled !== undefined) (data as any).telegramTrafficAlertEnabled = !!(data as any).telegramTrafficAlertEnabled;
            if ((data as any).trafficAlertThresholdPercent !== undefined) (data as any).trafficAlertThresholdPercent = normalizeTrafficAlertThresholdPercent((data as any).trafficAlertThresholdPercent);
            if ((data as any).telegramRenewalReminderEnabled !== undefined) (data as any).telegramRenewalReminderEnabled = !!(data as any).telegramRenewalReminderEnabled;
            if ((data as any).renewalReminderDays !== undefined) (data as any).renewalReminderDays = normalizeRenewalReminderDays((data as any).renewalReminderDays);
            if ((data as any).billingCycleMonths !== undefined) (data as any).billingCycleMonths = normalizeHostBillingCycleMonths((data as any).billingCycleMonths);
            if ((data as any).billingMonth !== undefined) (data as any).billingMonth = normalizeHostBillingMonth((data as any).billingMonth);
            if ((data as any).billingDay !== undefined) (data as any).billingDay = normalizeHostBillingDay((data as any).billingDay);
            if ((data as any).expiryHandling !== undefined) (data as any).expiryHandling = normalizeHostExpiryAction((data as any).expiryHandling);
            if ((data as any).trafficAutoReset !== undefined) (data as any).trafficAutoReset = !!(data as any).trafficAutoReset;
            if ((data as any).trafficResetDay !== undefined) (data as any).trafficResetDay = Math.min(31, Math.max(1, Number((data as any).trafficResetDay) || 1));
            const nextTelegramTrafficAlertEnabled = (data as any).telegramTrafficAlertEnabled !== undefined
              ? !!(data as any).telegramTrafficAlertEnabled
              : !!(host as any).telegramTrafficAlertEnabled;
            const nextTelegramRenewalReminderEnabled = (data as any).telegramRenewalReminderEnabled !== undefined
              ? !!(data as any).telegramRenewalReminderEnabled
              : !!(host as any).telegramRenewalReminderEnabled;
            if (nextTelegramTrafficAlertEnabled || nextTelegramRenewalReminderEnabled) {
              await assertTelegramBotConfiguredForHostReminder();
            }
          }
        } else {
          for (const field of ["purchasedAt", "stoppedAt", "trafficLimit", "trafficMeasureMode", "telegramTrafficAlertEnabled", "trafficAlertThresholdPercent", "telegramRenewalReminderEnabled", "renewalReminderDays", "billingCycleMonths", "billingMonth", "billingDay", "expiryHandling", "trafficAutoReset", "trafficResetDay", "ddnsEnabled", "ddnsDomain", "ddnsRecordType", "ddnsIpVersion"] as const) delete (data as any)[field];
        }
        if (ctx.user.role !== "admin") {
          for (const field of hostProtocolPolicyFields) delete (data as any)[field];
        }
        const protocolPolicyChanged = hostProtocolPolicyFields.some((key) =>
          (data as any)[key] !== undefined && !!(data as any)[key] !== !!(host as any)[key]
        );
        const portRangeChanged = ["portRangeStart", "portRangeEnd"].some((key) =>
          (data as any)[key] !== undefined && Number((data as any)[key] ?? 0) !== Number((host as any)[key] ?? 0)
        ) || ((data as any).portAllowlist !== undefined && nextPortAllowlist !== String((host as any).portAllowlist || ""));
        const entryChanged = ["entryIp", "tunnelEntryIp", "ip", "ipv4", "ipv6"].some((key) =>
          (data as any)[key] !== undefined && String((data as any)[key] || "") !== String((host as any)[key] || "")
        );
        if (entryChanged) {
          Object.assign(data as any, {
            geoCountryCode: null,
            geoCountryName: null,
            geoRegion: null,
            geoEmoji: null,
            geoLatitudeMicro: null,
            geoLongitudeMicro: null,
            geoUpdatedAt: null,
          });
        }
        await db.updateHost(id, data as any);
        if (egressShapingChanged) pushAgentRefresh(id, "host-egress-shaping-updated", { urgent: true });
        if (ddnsConfigChanged) {
          scheduleHostDdnsUpdate({ ...host, ...(data as any), id }, "host-ddns-config-updated", { force: true });
          /**
           * 开关 DDNS、换 DDNS 域名都会改变这台机器的入口地址（见 getHostEntryAddresses
           * 的优先级），订阅里派生出来的节点得跟着改。这里不走整套
           * refreshHostAddressRuntime：转发链和隧道各自认的是 DDNS 域名本身，
           * 不需要因为一次配置变更被重置。
           */
          await db.syncProxyNodesForHostAddress(id);
        }
        if (entryChanged) {
          await refreshHostAddressRuntime(id, host, "host-address-updated");
        }
        // 手填入口、主机 DDNS 都会改变首选入口地址，规则专属域名的记录值跟着改。
        if (entryChanged || ddnsConfigChanged) void scheduleRuleEntryDomainSyncForHost(id, "host-entry-updated");
        if (portRangeChanged) {
          const nextPolicy = portPolicyFrom({
            portRangeStart: pStart,
            portRangeEnd: pEnd,
            portAllowlist: nextPortAllowlist,
          });
          const policyText = describePortPolicy(nextPolicy);
          const disabledCount = await db.disableForwardRulesOutsideHostPortRange(
            id,
            {
              portRangeStart: pStart,
              portRangeEnd: pEnd,
              portAllowlist: nextPortAllowlist,
            },
            portPolicyHasRestriction(nextPolicy)
              ? `入口端口不在当前主机允许范围 ${policyText} 内，请修改端口后再启用。`
              : "主机端口限制已变更，请确认端口后再启用。",
          );
          if (disabledCount > 0) {
            console.info(`[HostPolicy] disabled out-of-range rules host=${id} count=${disabledCount} range=${pStart ?? "-"}-${pEnd ?? "-"}`);
          }
          await refreshHostPolicyRuntime(id, "host-port-policy-updated");
        }
        if (protocolPolicyChanged) {
          await refreshHostPolicyRuntime(id, "host-protocol-policy-updated");
        }
        return { success: true };
      }),
    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const host = await db.getHostById(input.id);
        if (!host) throw new Error("主机不存在");
        if (ctx.user.role !== "admin" && host.userId !== ctx.user.id) throw new Error("无权操作此主机");
        // 检查是否存在仍会占用此主机的规则。已标记删除且停止运行的历史记录不应阻止删除主机。
        const blockers = await db.getHostRuleDeleteBlockers(input.id);
        if (blockers.ruleCount > 0) {
          throw new Error(`该主机下还有 ${blockers.ruleCount} 条转发规则，请先删除所有规则后再删除主机`);
        }
        if (blockers.managedRuleCount > 0) {
          throw new Error(`该主机仍被 ${blockers.managedRuleCount} 条转发组/转发链规则引用，请先在转发组中移除该主机或删除对应转发组`);
        }
        // 隧道、转发组成员、套餐里还引用着它时不能删：这些行不会跟着主机删，会留下指向空主机的引用。
        const references = await db.getHostDeleteReferenceLabels(input.id);
        if (references.length > 0) {
          throw new Error(`该主机仍被引用：${references.join("；")}。请先解除这些引用后再删除主机`);
        }
        if (blockers.pendingCleanupCount > 0) {
          await db.releaseHostPendingRuleCleanup(input.id);
        }
        await db.deleteHostPermissions(input.id);
        await db.deleteHost(input.id);
        return { success: true };
      }),
    metrics: protectedProcedure
      // limit 直接进 SQL 的 LIMIT 和缓存键：不设上限一次能拖出整张指标表，小数 / 负数在
      // 各库上要么报错要么行为不一；1440 = 按分钟采样一天，前端实际只要 2。
      .input(z.object({ hostId: z.number(), limit: z.number().int().min(1).max(1440).default(60), live: z.boolean().optional() }))
      .query(async ({ input, ctx }) => {
        await requireHostAccess(ctx, input.hostId);
        if (input.live) return db.getLatestHostMetrics(input.hostId, input.limit);
        return hostQueryCache.get(
          `metrics:${ctx.user.id}:${input.hostId}:${input.limit}`,
          { ttlMs: 10_000, staleMs: 60_000 },
          () => db.getLatestHostMetrics(input.hostId, input.limit),
        );
      }),
    latestMetricsSummary: protectedProcedure
      .input(z.object({ hostIds: z.array(z.number()).max(500).optional() }).optional())
      .query(async ({ input, ctx }) => {
        const hostIds = Array.from(new Set((input?.hostIds || [])
          .map((id) => Number(id))
          .filter((id) => Number.isInteger(id) && id > 0)));
        if (hostIds.length === 0) return [];
        await requireHostsAccess(ctx, hostIds);
        const rows = await db.getLatestHostMetricRows(hostIds);
        return (rows as any[]).map(compactHostMetricSummary).filter((row) => row.hostId > 0);
      }),
    traffic: protectedProcedure
      .input(z.object({ hostId: z.number() }))
      .query(async ({ input, ctx }) => {
        await requireHostAccess(ctx, input.hostId);
        return db.getHostTraffic(input.hostId);
      }),
    trafficSummary: protectedProcedure
      .input(z.object({ hostIds: z.array(z.number()).max(500).optional() }).optional())
      .query(async ({ input, ctx }) => {
        const hostIds = Array.from(new Set((input?.hostIds || [])
          .map((id) => Number(id))
          .filter((id) => Number.isInteger(id) && id > 0)));
        if (ctx.user.role !== "admin" && hostIds.length === 0) return [];
        if (ctx.user.role !== "admin" || hostIds.length > 0) {
          await requireHostsAccess(ctx, hostIds);
          const rows = await db.getHostTrafficSummary(hostIds);
          return (rows as any[]).map(compactHostTrafficSummary).filter((row) => row.hostId > 0);
        }
        const rows = await db.getHostTrafficSummary();
        return (rows as any[]).map(compactHostTrafficSummary).filter((row) => row.hostId > 0);
      }),
    resetTraffic: adminProcedure
      .input(z.object({ hostId: z.number() }))
      .mutation(async ({ input }) => {
        const host = await db.getHostById(input.hostId);
        if (!host) throw new Error("主机不存在");
        appendPanelLog("info", `[HostTraffic] reset host=${host.id} name=${host.name} reason=manual-admin-reset`);
        return db.resetHostTraffic(input.hostId);
      }),
    correctTraffic: adminProcedure
      .input(z.object({
        hostId: z.number().int().positive(),
        usedBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      }))
      .mutation(async ({ input }) => {
        const host = await db.getHostById(input.hostId);
        if (!host) throw new Error("主机不存在");
        const measureMode = normalizeHostTrafficMeasureMode((host as any).trafficMeasureMode);
        appendPanelLog(
          "info",
          `[HostTraffic] correct host=${host.id} name=${host.name} usedBytes=${input.usedBytes} mode=${measureMode} reason=manual-admin-correction`,
        );
        return db.correctHostTraffic(input.hostId, input.usedBytes, measureMode);
      }),
    watchMetrics: protectedProcedure
      .input(z.object({ hostIds: z.array(z.number()).max(200) }))
      .mutation(async ({ input, ctx }) => {
        // 批量校验：任何一台不通过就抛出与逐台校验相同的第一个错误，全部通过才继续。
        await requireHostsAccess(ctx, input.hostIds);
        const allowed: number[] = [...input.hostIds];
        const newlyWatched = markHostMetricsWatching(allowed);
        for (const hostId of newlyWatched) pushAgentRefresh(hostId, "metrics-watch");
        return { success: true, count: allowed.length };
      }),
    /*
      主机列表当前这一页的实时数据，一次拿齐：在线状态、累计流量、最新指标，顺带续上「正在看」。

      原来是 statusSummary / trafficSummary / latestMetricsSummary 三个查询加一个 watchMetrics
      各自定时，每个响应到了都把整页重渲一遍。合成一个请求、一次渲染。
      看得见哪些机器只按列表同一套可见范围算，范围外的 id 直接略过，不整个报错。
    */
    pageLive: protectedProcedure
      .input(z.object({
        hostIds: z.array(z.number().int().positive()).max(100),
        watch: z.boolean().optional(),
      }))
      .query(async ({ input, ctx }) => {
        const requestedIds = Array.from(new Set(input.hostIds.map(Number).filter((id) => Number.isInteger(id) && id > 0)));
        const empty = {
          status: [] as Array<ReturnType<typeof compactHostStatus>>,
          traffic: [] as Array<ReturnType<typeof compactHostTrafficSummary>>,
          metrics: [] as Array<ReturnType<typeof compactHostMetricSummary>>,
        };
        if (requestedIds.length === 0) return empty;
        const scope = await visibleHostQueryScope(ctx.user);
        const status = (await db.getHostStatusRows({ ...scope, hostIds: requestedIds }))
          .map(compactHostStatus)
          .filter((host: ReturnType<typeof compactHostStatus>) => host.id > 0);
        const hostIds = status.map((host: ReturnType<typeof compactHostStatus>) => host.id);
        if (hostIds.length === 0) return empty;
        const [trafficRows, metricRows] = await Promise.all([
          db.getHostTrafficSummary(hostIds),
          db.getLatestHostMetricRows(hostIds),
        ]);
        if (input.watch) {
          // 手机上 5 秒一轮，默认 6 秒的「正在看」会在两轮之间断掉、每轮都重新叫一次 Agent；放宽到 15 秒。
          for (const hostId of markHostMetricsWatching(hostIds, 15_000)) pushAgentRefresh(hostId, "metrics-watch");
        }
        return {
          status,
          traffic: (trafficRows as any[]).map(compactHostTrafficSummary).filter((row) => row.hostId > 0),
          metrics: (metricRows as any[]).map(compactHostMetricSummary).filter((row) => row.hostId > 0),
        };
      }),
    requestAgentUpgrade: adminProcedure
      .input(z.object({ hostId: z.number(), targetVersion: z.string().max(64).nullable().optional() }))
      .mutation(async ({ input }) => {
        const host = await db.getHostById(input.hostId);
        if (!host) throw new Error("主机不存在");
        if (!(host as any).isOnline) {
          return { success: true, pushed: false, alreadyLatest: false, skippedOffline: true };
        }
        const targetVersion = normalizeVersion(input.targetVersion || AGENT_VERSION);
        const currentVersion = normalizeVersion((host as any).agentVersion);
        if (isHostAgentUpgradeUnnecessary({ agentVersion: currentVersion, fxpVersion: (host as any).fxpVersion }, targetVersion, AGENT_VERSION)) {
          return { success: true, pushed: false, alreadyLatest: true };
        }
        appendPanelLog("info", `[AgentUpgrade] request host=${host.id} name=${host.name} current=${currentVersion || "-"} fxp=${(host as any).fxpVersion || "-"} target=${targetVersion}`);
        await assertAgentReleaseAssetsReady(targetVersion);
        await db.requestHostAgentUpgrade(input.hostId, targetVersion);
        const configuredPanelUrl = (await db.getSetting("panelPublicUrl")) || "";
        const panelUrl = /^https?:\/\//.test(configuredPanelUrl) ? configuredPanelUrl.replace(/\/+$/, "") : "";
        const pushed = pushAgentUpgrade(input.hostId, targetVersion, panelUrl);
        return { success: true, pushed };
      }),
    requestAgentUpgradeMany: adminProcedure
      .input(z.object({ hostIds: z.array(z.number()).min(1).max(500), targetVersion: z.string().max(64).nullable().optional() }))
      .mutation(async ({ input }) => {
        const targetVersion = normalizeVersion(input.targetVersion || AGENT_VERSION);
        const configuredPanelUrl = (await db.getSetting("panelPublicUrl")) || "";
        const panelUrl = /^https?:\/\//.test(configuredPanelUrl) ? configuredPanelUrl.replace(/\/+$/, "") : "";
        let requested = 0;
        let pushed = 0;
        let skippedLatest = 0;
        let skippedOffline = 0;
        let scheduled = 0;
        const missing: number[] = [];
        const uniqueHostIds = Array.from(new Set(input.hostIds.map((id) => Number(id)).filter((id) => id > 0)));
        const onlineHosts: any[] = [];
        for (const hostId of uniqueHostIds) {
          const host = await db.getHostById(hostId);
          if (!host) {
            missing.push(hostId);
            continue;
          }
          if (!(host as any).isOnline) {
            skippedOffline += 1;
            continue;
          }
          onlineHosts.push(host);
        }
        if (onlineHosts.length > 0) {
          await assertAgentReleaseAssetsReady(targetVersion);
        }
        const upgradeHosts = onlineHosts.filter((host) => {
          const currentVersion = normalizeVersion((host as any).agentVersion);
          if (isHostAgentUpgradeUnnecessary({ agentVersion: currentVersion, fxpVersion: (host as any).fxpVersion }, targetVersion, AGENT_VERSION)) {
            skippedLatest += 1;
            return false;
          }
          return true;
        });
        for (const rollout of planAgentUpgradeWaves(upgradeHosts)) {
          const { host, wave, delayMs, requestedAt } = rollout;
          const currentVersion = normalizeVersion((host as any).agentVersion);
          appendPanelLog("info", `[AgentUpgrade] request host=${host.id} name=${host.name} current=${currentVersion || "-"} target=${targetVersion} batch=true wave=${wave + 1} delayMs=${delayMs}`);
          await db.requestHostAgentUpgrade(host.id, targetVersion, null, requestedAt);
          requested += 1;
          if (delayMs === 0) {
            if (pushAgentUpgrade(host.id, targetVersion, panelUrl)) pushed += 1;
          } else {
            scheduled += 1;
            const timer = setTimeout(() => {
              void db.getHostById(Number(host.id)).then((currentHost: any) => {
                if (!currentHost?.agentUpgradeRequested) return;
                if (normalizeVersion(currentHost.agentUpgradeTargetVersion) !== targetVersion) return;
                pushAgentUpgrade(host.id, targetVersion, panelUrl);
              }).catch((error) => {
                console.warn(`[AgentUpgrade] scheduled push failed host=${host.id}: ${error instanceof Error ? error.message : String(error)}`);
              });
            }, delayMs);
            timer.unref?.();
          }
        }
        return { success: true, requested, pushed, scheduled, missing, skippedLatest, skippedOffline };
      }),
  });
