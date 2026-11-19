/*
  转发组各模块共用的东西：组 / 成员行的宽松类型、成员排序、主机地址怎么取（入口地址、A / AAAA / CNAME 的值）、
  成员和 DDNS 目标的显示名、组事件（forward_group_events）的写入、组运行状态「有变化才写」。
  不读写服务商，不做判断；判断在 evaluate*.ts，发布在 ddns*.ts，成员增删改在 repositories/forwardGroupRepository.ts。
*/

import { isIP } from "node:net";
import { forwardGroupModeOf } from "../../shared/forwardTypes";
import { eq } from "drizzle-orm";
import { forwardGroups } from "../../drizzle/schema";
import { appendPanelLog } from "../_core/panelLogger";
import { insertAndGetId, nowDate, rawEpochToDate } from "../dbRuntime";
import { getHostById, getHosts } from "../repositories/hostRepository";
import { getTunnelById, tunnelRuleListenHostIds } from "../repositories/tunnelRepository";
import { dbBool } from "../repositories/repositoryUtils";
import { evaluationHost, evaluationTunnel } from "./evaluateScope";
import { ForwardGroupMemberInput, getForwardGroupById } from "../repositories/forwardGroupRepository";

export type ForwardGroupRuleConfig = {
  sourcePort: number;
  protocol?: "tcp" | "udp" | "both" | string | null;
  excludeTemplateRuleId?: number | null;
  /** 共享 TLS 入站上的规则：sourcePort 是面板分的本机回环端口，不受对外端口策略管（见 server/tlsInbounds.ts）。 */
  sniBackendPort?: boolean;
};

function runtimeFieldEqual(current: unknown, next: unknown) {
  if (next === null) return current === null || current === undefined || current === "";
  if (typeof next === "number") return Number(current || 0) === next;
  if (typeof next === "boolean") return dbBool(current) === next;
  if (next instanceof Date) return toDate(current)?.getTime() === next.getTime();
  return String(current ?? "") === String(next ?? "");
}

export async function updateForwardGroupRuntimeIfChanged(db: any, group: any, patch: Record<string, unknown>) {
  if (Object.entries(patch).every(([key, value]) => runtimeFieldEqual(group?.[key], value))) return false;
  await db.update(forwardGroups).set({ ...patch, updatedAt: nowDate() }).where(eq(forwardGroups.id, group.id));
  Object.assign(group, patch);
  return true;
}

export type ForwardGroupMode = "port" | "failover" | "chain" | "entry" | "exit";

export type ForwardGroupRecordType = "A" | "AAAA" | "CNAME";

export type ForwardGroupFailoverOptions = {
  forcePriority?: boolean;
  forceSync?: boolean;
  manual?: boolean;
  suppressSwitchNotify?: boolean;
  skipRuleSync?: boolean;
  /**
   * 这一轮只算结论（DECIDE）：要写服务商时不在这里写，把组交给发布队列（PUBLISH，
   * server/forwardGroups/publish.ts）。后台评估队列和定时巡检用；人工操作、保存组照旧当场发布。
   */
  deferPublish?: boolean;
};

/** 组 / 成员 / 主机 / 规则行在这个文件里都是宽松的查询结果（和 LineGroupRow 一个说法）；新代码用这个名字，不再添新的 any。 */
export type LooseRow = ReturnType<typeof sortedMembers>[number];

/** 同 dbRuntime 的 rawEpochToDate（原来这里单独抄了一份，负数会落到字符串解析）。 */
export const toDate = rawEpochToDate;

export function forwardGroupFailoverDelayMs(group: any) {
  const seconds = Number(group?.failoverSeconds || 60);
  return Math.max(10, Number.isFinite(seconds) ? seconds : 60) * 1000;
}

export function forwardGroupRecoverDelayMs(group: any) {
  const seconds = Number(group?.recoverSeconds || 120);
  return Math.max(10, Number.isFinite(seconds) ? seconds : 120) * 1000;
}

export function entryAddressForHost(host: any) {
  return String(host?.entryIp || host?.ipv4 || host?.ipv6 || host?.ip || "").trim();
}

function manualEntryAddressForHost(host: any) {
  return String(host?.entryIp || "").trim();
}

export function normalizeIpCandidate(value: unknown) {
  const text = String(value || "").trim();
  if (text.startsWith("[") && text.endsWith("]")) return text.slice(1, -1).trim();
  return text;
}

export function normalizeHostAddressKey(value: unknown) {
  return normalizeIpCandidate(value).toLowerCase();
}

function hostAddressCandidates(host: any) {
  return [host?.entryIp, host?.ipv4, host?.ipv6, host?.ip, host?.tunnelEntryIp]
    .map((value) => normalizeHostAddressKey(value))
    .filter(Boolean);
}

export function hostDisplayLabel(host: any, fallback = "") {
  const id = Number(host?.id || 0);
  return String(host?.name || fallback || (id > 0 ? `主机${id}` : "")).trim();
}

async function findHostByAddress(address: unknown) {
  const key = normalizeHostAddressKey(address);
  if (!key) return null;
  const hosts = await getHosts().catch(() => [] as any[]);
  return (hosts as any[]).find((host) => hostAddressCandidates(host).includes(key)) || null;
}

export async function forwardChainTargetLabel(template: any) {
  const targetIp = String(template?.targetIp || "").trim();
  const targetPort = Number(template?.targetPort || 0);
  const targetHost = await findHostByAddress(targetIp);
  const hostLabel = hostDisplayLabel(targetHost);
  const ruleLabel = String(template?.name || "").trim();
  return hostLabel || ruleLabel || (targetIp && targetPort > 0 ? `目标 ${targetIp}:${targetPort}` : "目标");
}

function ipv4AddressForHost(host: any) {
  const manual = normalizeIpCandidate(manualEntryAddressForHost(host));
  if (isIP(manual) === 4) return manual;
  const reportedIpv4 = normalizeIpCandidate(host?.ipv4);
  if (isIP(reportedIpv4) === 4) return reportedIpv4;
  const primary = normalizeIpCandidate(host?.ip);
  return isIP(primary) === 4 ? primary : "";
}

function ipv6AddressForHost(host: any) {
  const manual = normalizeIpCandidate(manualEntryAddressForHost(host));
  if (isIP(manual) === 6) return manual;
  const reportedIpv6 = normalizeIpCandidate(host?.ipv6);
  if (isIP(reportedIpv6) === 6) return reportedIpv6;
  const primary = normalizeIpCandidate(host?.ip);
  return isIP(primary) === 6 ? primary : "";
}

function ddnsDomainForHost(host: any) {
  return host?.ddnsEnabled ? String(host?.ddnsDomain || "").trim() : "";
}

function cnameTargetForHost(host: any) {
  const manual = manualEntryAddressForHost(host);
  if (manual && isIP(normalizeIpCandidate(manual)) === 0) return manual;
  return ddnsDomainForHost(host);
}

export function normalizeForwardGroupRecordType(recordType: unknown): ForwardGroupRecordType {
  const text = String(recordType || "A").trim().toUpperCase();
  if (text === "AAAA" || text === "CNAME") return text;
  return "A";
}

export function recordTypeRequirementLabel(recordType: ForwardGroupRecordType) {
  if (recordType === "AAAA") return "IPv6";
  if (recordType === "CNAME") return "入口域名或 DDNS 域名";
  return "IPv4";
}

export function ddnsValueForHostByRecordType(host: any, recordType: ForwardGroupRecordType) {
  if (recordType === "AAAA") return ipv6AddressForHost(host);
  if (recordType === "CNAME") return cnameTargetForHost(host);
  return ipv4AddressForHost(host);
}

export function privateAddressForHost(host: any) {
  return String(host?.tunnelEntryIp || "").trim();
}

export function ipv6AddressForConnectHost(host: any) {
  return String(host?.ipv6 || "").trim();
}

export function isSafeHostAddress(value: string) {
  const text = value.trim();
  return !!text && text.length <= 253 && !/[\s'"<>]/.test(text);
}

// Older SQLite/MySQL rows can contain values written before the runtime
// selector normalized its enum input. Keep generated child rules compatible
// with those rows without changing the persisted data in a sync pass.
export function normalizeRuntimeForwardType(value: unknown, fallback = "iptables") {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized || fallback;
}

export function isCollectionGroupMode(mode: ForwardGroupMode) {
  return mode === "entry" || mode === "exit";
}

export function supportsChinaHealthMode(mode: ForwardGroupMode) {
  return mode === "failover" || mode === "entry";
}

export function sortedMembers(group: any, enabledOnly = false) {
  const members = [...((group as any).members || [])].sort((a, b) => Number(a.priority) - Number(b.priority));
  return enabledOnly ? members.filter((member: any) => dbBool(member?.isEnabled)) : members;
}

/*
  挂了入口组的转发链 / 端口转发（2.3.438 起端口转发也能挂，poouo/Forwardx#15 要的「入口组复用」）：
  入口就是组里启用的主机。端口转发挂入口组时自己不放成员，子规则按入口组每台主机各一条，
  forwardGroupMemberId 记的是入口组的成员 id（forwardGroupRuleIntegrity 认这种）；入口组加减主机
  会经 refreshForwardGroupReferences → syncChainsUsingEntryGroup 重新铺。
*/
export async function entryGroupMembersFor(group: any) {
  const mode = forwardGroupModeOf(group);
  return mode === "chain" || mode === "port" ? chainEntryMembers(group) : [];
}

export async function chainEntryMembers(group: any) {
  const entryGroupId = Number((group as any)?.entryGroupId || 0);
  if (!entryGroupId) return [] as any[];
  const entryGroup = await getForwardGroupById(entryGroupId) as any;
  if (!entryGroup || forwardGroupModeOf(entryGroup) !== "entry" || !dbBool(entryGroup.isEnabled)) return [] as any[];
  return sortedMembers(entryGroup, true).filter((member: any) => member.memberType === "host");
}

export function describeDdnsTarget(group: any, value: string, provider?: string) {
  const providerLabel = provider ? `provider=${provider}` : "provider=disabled";
  return `${providerLabel} domain=${String(group.domain || "-")} type=${String(group.recordType || "A")} value=${value}`;
}

export async function forwardGroupMemberLabel(member: any | null | undefined, fallbackId?: number | null) {
  if (!member) return fallbackId ? `成员 #${fallbackId}` : "";
  if (member.memberType === "host") {
    const host = await evaluationHost(member.hostId).catch(() => null);
    return hostDisplayLabel(host, `主机 #${member.hostId || member.id || fallbackId || "-"}`);
  }
  if (member.memberType === "tunnel") {
    const tunnel = await evaluationTunnel(member.tunnelId).catch(() => null);
    return String((tunnel as any)?.name || `隧道 #${member.tunnelId || member.id || fallbackId || "-"}`).trim();
  }
  return fallbackId ? `成员 #${fallbackId}` : `成员 #${member.id || "-"}`;
}

export function normalizeHealthReason(message: unknown) {
  const text = String(message || "").trim();
  if (!text) return "入口不可用";
  if (text.includes("国内健康")) return "国内健康度检测失败";
  if (/timeout/i.test(text)) return "入口延迟探测超时";
  if (/not running/i.test(text)) return "入口规则未运行";
  if (/disabled/i.test(text)) return "入口规则已停用";
  if (/No forwarding rule/i.test(text)) return "入口暂未生成转发规则";
  if (/waiting/i.test(text)) return "等待健康度检测数据";
  return text;
}

export function switchNotifySuppressed(options: ForwardGroupFailoverOptions) {
  return !!options.manual || !!options.forcePriority || !!options.forceSync || !!options.suppressSwitchNotify;
}

export function groupSwitchNotifyEnabled(group: any) {
  return !!group?.telegramSwitchNotifyEnabled;
}

/** 给组外的模块记一条组事件（例如按可用时段切换成员）。 */
export async function recordForwardGroupEvent(groupId: number, memberId: number | null, type: string, message: string) {
  return insertForwardGroupEvent(groupId, memberId, type, message);
}

/** 同一个组 / 成员 / 类型的 DDNS 事件，正文和上一条一样就不再记（巡检每轮都会走到同一句）。 */
const lastDdnsEventByKey = new Map<string, string>();

export async function insertForwardGroupEvent(groupId: number, memberId: number | null, type: string, message: string) {
  if (type.startsWith("ddns-")) {
    const truncated = message.slice(0, 500);
    const key = `${groupId}:${memberId ?? "-"}:${type}`;
    if (lastDdnsEventByKey.get(key) === truncated) {
      return;
    }
    lastDdnsEventByKey.set(key, truncated);
    message = truncated;
  }
  const level = type.includes("error") ? "error" : type.includes("skip") ? "warn" : "info";
  appendPanelLog(level, `[DDNS] group=${groupId} member=${memberId ?? "-"} type=${type} ${message}`);
  await insertAndGetId("forward_group_events", {
    groupId,
    memberId,
    type,
    message: message.slice(0, 500),
    createdAt: nowDate(),
  });
}

export async function targetHostIdForMember(member: ForwardGroupMemberInput) {
  if (member.memberType === "host") {
    if (!member.hostId) throw new Error("Forward group member host is required");
    const host = await getHostById(Number(member.hostId));
    if (!host) throw new Error("Host does not exist");
    return Number(host.id);
  }
  if (!member.tunnelId) throw new Error("Forward group member tunnel is required");
  const tunnel = await getTunnelById(Number(member.tunnelId));
  if (!tunnel) throw new Error("Tunnel does not exist");
  return Number(tunnel.entryHostId);
}

export async function memberEntryHostId(member: any) {
  if (member.memberType === "host") return Number(member.hostId || 0);
  const tunnel = await evaluationTunnel(member.tunnelId);
  return Number(tunnel?.entryHostId || 0);
}

/**
 * 成员子规则实际在哪些主机上监听入口端口：主机成员就是它自己；隧道成员是隧道入口机，隧道挂了
 * 入口组时还有组里每台启用的主机（子规则带着 tunnelId，下发时这些主机都会替它监听）。
 * 查占用、预留端口都要覆盖这整组，只查入口机会和成员机上同端口的规则撞上。
 */
export async function memberListenHostIds(member: any): Promise<number[]> {
  if (member.memberType === "host") {
    const hostId = Number(member.hostId || 0);
    return hostId > 0 ? [hostId] : [];
  }
  const tunnel = await getTunnelById(Number(member.tunnelId));
  return tunnel ? tunnelRuleListenHostIds(tunnel) : [];
}

/*
  分线路解析（server/forwardGroupDdnsLines.ts）挂在组原来那次 DDNS 发布上的钩子：默认线路那套逻辑
  在评估每个成员时顺手把结论记下来（note），评估完只发布默认线路上的成员，走到「默认线路已经定了」
  的几个出口（发布成功 / 已是最新 / 保留最后一条 / 等健康结果）时标 settled，之后再按线路发布。
  没分线路的组钩子是 null，原来的每一步都不变。
*/
// 组 / 成员行在这个文件里都是宽松的查询结果；分线路这几处沿用 sortedMembers 的同一个形状，不另起类型。
export type LineGroupRow = Parameters<typeof sortedMembers>[0];

export type LineMemberRow = ReturnType<typeof sortedMembers>[number];
