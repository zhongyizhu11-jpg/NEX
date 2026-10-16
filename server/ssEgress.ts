/**
 * 转发规则的 Shadowsocks 出口：服务端那一半（规则见 shared/ssEgress.ts）。
 *
 *   - 外部链接的加密保存：复用自动换 IP 那套 AES-256-GCM（server/ipChange/secrets.ts），
 *     专用一个 HKDF info，和云账号凭据的密钥隔开。库被拖走时拿到的只是密文；
 *     代价同样是换了面板密钥（迁到另一台机器）后要重新粘贴一次链接。
 *   - 保存规则时的校验：来源（落地入站 / 外部链接）、权限、自环、规则形态。
 *   - 下发：规则在这台 Agent 上的运行视图（太旧 / 出口失效就按停用下发），
 *     以及 gost 的出口链（chain-egress-<规则>-<协议>，一跳、一个 ss 节点）。
 *   - 落地入站被删 / 改时的保护：正在被当作出口的入站不能删、不能改成别的协议或不支持的方法。
 */

import { and, eq, inArray } from "drizzle-orm";

import { forwardRules } from "../drizzle/schema";
import { getHostEntryAddress } from "../shared/hostEntryAddress";
import { pickAvailablePort, portPolicyFrom } from "../shared/portPolicy";
import {
  canonicalSsEgressPassword,
  isSsEgressAgentSupported,
  maskSsEgressEndpoint,
  normalizeRuleEgressType,
  normalizeSsMethod,
  parseSsEgressLink,
  ruleEgressShapeError,
  ruleEgressStateBlocksDelivery,
  ruleEgressWantsUdp,
  hostSsEgressCapabilities,
  isSs2022Method,
  ssEgress2022UpgradeMessage,
  ssEgressHostCapabilityError,
  ssEgressUdpUpgradeMessage,
  ssEgressAgentUpgradeMessage,
  ssEgressEndpointError,
  ssEgressMethodError,
  SS_EGRESS_DEFAULT_METHOD,
  SS_EGRESS_UDP_SUPPORTED,
  NO_EGRESS_COLUMNS,
  ruleEgressColumnsOf,
  type RuleEgressColumns,
  type RuleEgressState,
  type RuleEgressType,
  type SsEgressEndpoint,
} from "../shared/ssEgress";

export { NO_EGRESS_COLUMNS, ruleEgressColumnsOf, type RuleEgressColumns };
import * as db from "./db";
import { getDb } from "./dbRuntime";
import { ENV } from "./env";
import { isHostConsideredOnline } from "./hostHeartbeatPolicy";
import { createCredentialCipher, type CredentialCipher } from "./ipChange/secrets";
import { restrictedForwardTargetClass, restrictedForwardTargetLabel } from "./ruleTargetPolicy";
import { dbBool } from "./repositories/repositoryUtils";

/* ── 外部链接的加密 ─────────────────────────────────────────────────── */

const EGRESS_CIPHER_INFO = "ss-egress-link-v1";
let cipherInstance: CredentialCipher | null = null;
let cipherSecretOverride: string | null = null;

function egressCipher() {
  return (cipherInstance ||= createCredentialCipher(cipherSecretOverride ?? ENV.cookieSecret, EGRESS_CIPHER_INFO));
}

/** 测试用：换一把密钥（模拟「迁到另一台面板」）。传 null 恢复用面板密钥。 */
export function setSsEgressCipherSecretForTests(secret: string | null) {
  cipherSecretOverride = secret;
  cipherInstance = null;
}

export function encryptSsEgressEndpoint(endpoint: SsEgressEndpoint): string {
  return egressCipher().encrypt({
    server: String(endpoint.server),
    port: String(Number(endpoint.port)),
    method: normalizeSsMethod(endpoint.method),
    password: String(endpoint.password),
    ...(endpoint.name ? { name: String(endpoint.name) } : {}),
  });
}

/** 解不开（面板密钥变过）或内容不对时回 null。 */
export function decryptSsEgressEndpoint(stored: unknown): SsEgressEndpoint | null {
  const text = String(stored ?? "");
  if (!text) return null;
  try {
    const raw = egressCipher().decrypt(text);
    const endpoint: SsEgressEndpoint = {
      server: String(raw.server || ""),
      port: Number(raw.port || 0),
      method: normalizeSsMethod(raw.method),
      password: String(raw.password || ""),
      ...(raw.name ? { name: String(raw.name) } : {}),
    };
    return endpoint.server && endpoint.port && endpoint.password ? endpoint : null;
  } catch {
    return null;
  }
}

/* ── 保存规则时 ─────────────────────────────────────────────────────── */

export type RuleEgressInput = {
  egressType?: RuleEgressType;
  egressInboundId?: number | null;
  /** 外部链接原文。编辑时不改链接就不传（或者原样传回界面上那条打码的）。 */
  egressLink?: string | null;
  egressUdp?: boolean;
};

export function hasEgressInput(input: RuleEgressInput | null | undefined) {
  return !!input && (input.egressType !== undefined || input.egressInboundId !== undefined
    || input.egressLink !== undefined || input.egressUdp !== undefined);
}

/** 从 tRPC 入参里拿出出口那几项，剩下的原样交给原来的规则流程（它会把入参直接展开进 createForwardRule）。 */
export function splitEgressInput<T extends Record<string, any>>(input: T): { egress: RuleEgressInput; rest: Omit<T, keyof RuleEgressInput> } {
  const { egressType, egressInboundId, egressLink, egressUdp, ...rest } = input as any;
  return { egress: { egressType, egressInboundId, egressLink, egressUdp }, rest };
}

type Actor = { id: number; role: string };

function addressTokens(host: any) {
  return new Set(
    [host?.ip, host?.ipv4, host?.ipv6, host?.entryIp, host?.tunnelEntryIp, host?.ddnsDomain]
      .flatMap((value) => String(value || "").split(/[\s,]+/))
      .map((value) => value.trim().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "").toLowerCase())
      .filter(Boolean),
  );
}

/**
 * 这个落地入站，这个人能不能拿来当出口。
 *
 * 管理员：都行。普通用户：自己的入站；或者管理员开的「落地出口」入站、而他有那台主机的使用权限
 * （和直连规则同一套主机授权）。别人的普通落地节点不行 —— 那个端口的流量记在入站主人头上。
 */
export async function assertEgressInboundUsable(actor: Actor, inbound: any) {
  if (actor.role === "admin") return;
  if (Number(inbound?.userId) === Number(actor.id)) return;
  if (!dbBool(inbound?.landingEgress)) throw new Error("只能使用自己的落地入站，或管理员开放的落地出口入站");
  const host = await db.getHostById(Number(inbound.hostId));
  if (!host) throw new Error("落地主机不存在");
  if (Number(host.userId) === Number(actor.id)) return;
  const allowed = await db.getUserEffectiveAllowedHostIds(actor.id);
  if (!allowed.map(Number).includes(Number(host.id))) throw new Error("您没有使用这台落地主机的权限，请联系管理员授权");
}

export type EgressSaveContext = {
  actor: Actor;
  /** 这条规则会在哪些主机上监听（直连是主机本身；端口转发资源是它的全部成员）。 */
  entryHostIds: number[];
  forwardType: string;
  protocol: string;
  tunnelId?: number | null;
  forwardGroupMode?: string | null;
  failoverEnabled?: boolean;
  tlsInboundId?: number | null;
  targetIp: unknown;
  /** 编辑时的旧规则（新建为空）。 */
  current?: any;
};

/**
 * 保存规则时算出出口那几列。没传任何出口字段、旧规则也没有出口时回 null（什么都不写）。
 * 抛出的都是给用户看的话。
 */
export async function resolveRuleEgressColumns(input: RuleEgressInput, context: EgressSaveContext): Promise<RuleEgressColumns | null> {
  const current = context.current ? ruleEgressColumnsOf(context.current) : NO_EGRESS_COLUMNS;
  if (!hasEgressInput(input) && current.egressType === "none") return null;
  const egressType = input.egressType !== undefined ? normalizeRuleEgressType(input.egressType) : current.egressType;
  if (egressType === "none") return current.egressType === "none" && !context.current ? null : { ...NO_EGRESS_COLUMNS };

  const egressUdp = input.egressUdp !== undefined ? input.egressUdp === true : (egressType === current.egressType ? current.egressUdp : false);
  const shapeError = ruleEgressShapeError({
    egressType,
    forwardType: context.forwardType,
    protocol: context.protocol,
    egressUdp,
    tunnelId: context.tunnelId,
    forwardGroupMode: context.forwardGroupMode,
    failoverEnabled: context.failoverEnabled,
    tlsInboundId: context.tlsInboundId,
  });
  if (shapeError) throw new Error(shapeError);
  const entryHostIds = Array.from(new Set(context.entryHostIds.map(Number).filter((id) => id > 0)));
  const entryHosts = entryHostIds.length > 0 ? await db.getHostsByIds(entryHostIds) as any[] : [];
  // 新挂 / 换出口时入口机的 Agent 要够新（和共享 TLS 入站一样在保存时就说）；已经挂着的规则改别的不拦，下发时按停用处理。
  const assertEntryAgents = () => {
    for (const host of entryHosts) {
      if (!isSsEgressAgentSupported(String(host?.agentVersion || ""))) throw new Error(ssEgressAgentUpgradeMessage(host?.name));
    }
  };
  /*
    UDP 走出口、SS2022 做出口要每一台入口机此刻都报了能力（Agent ≥ 2.2.227 且运行时 ≥ nex3、没回滚）。
    和上面的 Agent 版本不同，这里每次保存都查：规则一旦存成「UDP 走出口」，界面就会显示它在走出口，
    不能让一台撑不起的入口机混进来。下发时还会再按每台入口机现在的能力判一次（失去能力就按停用下发）。
  */
  const wantsUdp = ruleEgressWantsUdp({ protocol: context.protocol, egressUdp });
  const assertEntryCapabilities = (method: unknown) => {
    for (const host of entryHosts) {
      const error = ssEgressHostCapabilityError(host, { udp: wantsUdp, method });
      if (error) throw new Error(error);
    }
  };

  if (egressType === "ss_host") {
    const inboundId = Number(input.egressInboundId !== undefined ? input.egressInboundId : current.egressInboundId) || 0;
    if (!inboundId) throw new Error("请选择落地主机上的 Shadowsocks 入站");
    const changed = inboundId !== Number(current.egressInboundId || 0) || current.egressType !== "ss_host";
    const inbound = await db.getProxyInboundById(inboundId) as any;
    if (!inbound) throw new Error("所选落地入站不存在");
    if (String(inbound.protocol) !== "shadowsocks") throw new Error("所选落地入站不是 Shadowsocks 协议");
    const methodError = ssEgressMethodError(inbound.method);
    if (methodError) throw new Error(`落地入站「${inbound.name}」：${methodError}`);
    if (!dbBool(inbound.isEnabled, true)) throw new Error(`落地入站「${inbound.name}」已停用`);
    await assertEgressInboundUsable(context.actor, inbound);
    const landingHost = await db.getHostById(Number(inbound.hostId)) as any;
    if (!landingHost) throw new Error("落地主机不存在");
    if (entryHostIds.includes(Number(landingHost.id))) {
      throw new Error("落地主机不能是规则的入口主机自己：那样流量绕一圈还是从入口出去");
    }
    if (changed) assertEntryAgents();
    assertEntryCapabilities(inbound.method);
    // 只在新选 / 换了落地时要求它在线：已经挂着的规则改个名字，不该因为落地临时掉线被卡住。
    if (changed && !isHostConsideredOnline(landingHost)) throw new Error(`落地主机「${landingHost.name}」当前离线，请等它上线后再选`);
    if (!getHostEntryAddress(landingHost)) throw new Error(`落地主机「${landingHost.name}」还没有可用地址`);
    await assertEgressTargetAllowed(context.actor, context.targetIp, landingHost);
    return { egressType, egressInboundId: inboundId, egressConfigJson: null, egressUdp };
  }

  // ss_link
  let stored = current.egressType === "ss_link" ? current.egressConfigJson : null;
  let endpoint: SsEgressEndpoint | null = null;
  const link = typeof input.egressLink === "string" ? input.egressLink.trim() : "";
  const keepExisting = !link || (stored && link === maskSsEgressEndpoint(decryptSsEgressEndpoint(stored)));
  if (keepExisting) {
    endpoint = stored ? decryptSsEgressEndpoint(stored) : null;
    if (!endpoint) throw new Error(stored ? "保存的出口链接已无法解密（面板密钥变过），请重新粘贴 ss:// 链接" : "请粘贴外部 Shadowsocks 链接");
    const error = ssEgressEndpointError(endpoint);
    if (error) throw new Error(error);
  } else {
    const parsed = parseSsEgressLink(link);
    if (!parsed.ok) throw new Error(parsed.error);
    endpoint = parsed.endpoint;
    stored = encryptSsEgressEndpoint(endpoint);
  }
  if (!keepExisting || current.egressType !== "ss_link") assertEntryAgents();
  assertEntryCapabilities(endpoint.method);
  const server = endpoint.server.toLowerCase();
  if (entryHosts.some((host) => addressTokens(host).has(server))) {
    throw new Error("外部链接指向的是规则的入口主机自己，这会绕回入口，请换一条链接");
  }
  return { egressType, egressInboundId: null, egressConfigJson: stored, egressUdp };
}

/**
 * 目标是内网 / 环回地址时：拨目标的是落地。外部链接的落地不是面板的机器，碰不到谁的内网，放行；
 * 面板管的落地主机要是他自己的才行（和隧道出口的口径一致，见 server/ruleTargetPolicy.ts）。
 */
async function assertEgressTargetAllowed(actor: Actor, targetIp: unknown, landingHost: any) {
  if (actor.role === "admin") return;
  const kind = restrictedForwardTargetClass(targetIp);
  if (!kind) return;
  if (Number(landingHost?.userId) === Number(actor.id)) return;
  throw new Error(`转发目标 ${String(targetIp)} 是${restrictedForwardTargetLabel(String(kind))}，经别人的落地主机出口时不能使用，请改成公网地址`);
}

/* ── 落地入站被删 / 改时 ───────────────────────────────────────────── */

export async function getRulesUsingEgressInbound(inboundId: number) {
  const database = await getDb();
  if (!database) return [] as any[];
  const rows = await database.select({
    id: forwardRules.id,
    name: forwardRules.name,
    hostId: forwardRules.hostId,
    userId: forwardRules.userId,
    pendingDelete: forwardRules.pendingDelete,
    forwardGroupId: forwardRules.forwardGroupId,
    forwardGroupRuleId: forwardRules.forwardGroupRuleId,
  }).from(forwardRules).where(and(eq(forwardRules.egressType, "ss_host"), eq(forwardRules.egressInboundId, Number(inboundId))));
  return (rows as any[]).filter((row) => !dbBool(row.pendingDelete));
}

function ruleListText(rules: any[]) {
  const names = rules.filter((rule) => !Number(rule.forwardGroupRuleId || 0)).map((rule) => `「${String(rule.name || `#${rule.id}`)}」`);
  const shown = names.slice(0, 5).join("、");
  return names.length > 5 ? `${shown} 等 ${names.length} 条` : shown;
}

/** 删落地入站前：还有规则拿它当出口就不让删，并列出这些规则。 */
export async function assertProxyInboundNotUsedAsEgress(inboundId: number) {
  const rules = await getRulesUsingEgressInbound(inboundId);
  const visible = rules.filter((rule) => !Number(rule.forwardGroupRuleId || 0));
  if (visible.length === 0) return;
  throw new Error(`这个落地入站正被 ${visible.length} 条转发规则当作 Shadowsocks 出口：${ruleListText(visible)}。请先把这些规则的出口改成其他方式，或删除这些规则`);
}

/** 改落地入站前：换协议、换成出口不支持的方法、换主机都会让依赖它的规则失效，拒绝。 */
export async function assertProxyInboundEgressCompatibleChange(inboundId: number, next: { protocol?: unknown; method?: unknown; hostId?: unknown }, currentHostId: number) {
  const rules = await getRulesUsingEgressInbound(inboundId);
  const visible = rules.filter((rule) => !Number(rule.forwardGroupRuleId || 0));
  if (visible.length === 0) return;
  const reasons: string[] = [];
  if (next.protocol !== undefined && String(next.protocol) !== "shadowsocks") reasons.push("改成别的协议");
  if (next.method !== undefined && ssEgressMethodError(next.method)) reasons.push(`改成 ${normalizeSsMethod(next.method)}（出口不支持）`);
  if (next.hostId !== undefined && Number(next.hostId) !== Number(currentHostId)) reasons.push("换到别的主机");
  // 改成 SS2022：依赖它的规则的每台入口机都要有 ssEgress2022 能力，否则这些规则会被按停用下发。
  if (reasons.length === 0 && next.method !== undefined && isSs2022Method(next.method)) {
    const hostIds = Array.from(new Set(rules.map((rule) => Number(rule.hostId || 0)).filter((id) => id > 0)));
    const hosts = hostIds.length > 0 ? await db.getHostsByIds(hostIds) as any[] : [];
    const lacking = hosts.find((host) => !hostSsEgressCapabilities(host).ss2022);
    if (lacking) reasons.push(`改成 ${normalizeSsMethod(next.method)}（${ssEgress2022UpgradeMessage(lacking)}）`);
  }
  if (reasons.length === 0) return;
  throw new Error(`这个落地入站正被 ${visible.length} 条转发规则当作 Shadowsocks 出口（${ruleListText(visible)}），不能${reasons.join("、")}。请先改掉这些规则的出口`);
}

/**
 * 落地入站换了凭据 / 端口 / 启停之后，依赖它的规则所在的入口机要马上重算一次 gost 配置。
 * 凭据本来就是每次下发时从入站现取的，这里只是催一下，让旧密码的连接不必等到下一次心跳。
 */
export async function refreshEgressDependents(inboundId: number, reason: string) {
  const rules = await getRulesUsingEgressInbound(inboundId);
  if (rules.length === 0) return 0;
  const { pushAgentRefresh } = await import("./agentEvents");
  const hostIds = new Set<number>();
  for (const rule of rules) {
    if (Number(rule.hostId || 0) > 0) hostIds.add(Number(rule.hostId));
  }
  for (const hostId of Array.from(hostIds)) pushAgentRefresh(hostId, reason);
  return hostIds.size;
}

/* ── 一键创建落地入站 ───────────────────────────────────────────────── */

/** 在落地主机的端口范围里挑一个空闲端口（避开转发规则、隧道、别的落地入站）。 */
export async function pickLandingEgressPort(hostId: number) {
  const host = await db.getHostById(hostId) as any;
  if (!host) throw new Error("主机不存在");
  const used = await db.getUsedPortsOnHost(hostId);
  for (const inbound of await db.getProxyInboundsByHost(hostId) as any[]) used.add(Number(inbound.port));
  const port = pickAvailablePort(portPolicyFrom(host), used, { start: 20000, end: 30000 });
  if (!port) throw new Error(`主机「${host.name}」的端口范围内已经没有空闲端口了`);
  return Number(port);
}

export const LANDING_EGRESS_INBOUND_DEFAULTS = {
  protocol: "shadowsocks" as const,
  method: SS_EGRESS_DEFAULT_METHOD,
  name: "落地出口 SS",
};

/* ── 给规则编辑器的落地主机清单 ─────────────────────────────────────── */

export async function listEgressLandingOptions(actor: Actor) {
  const isAdmin = actor.role === "admin";
  const hosts = (isAdmin
    ? await db.getHosts()
    : await (async () => {
      const own = await db.getHosts(actor.id) as any[];
      const allowedIds = (await db.getUserEffectiveAllowedHostIds(actor.id)).map(Number);
      const others = allowedIds.length > 0 ? await db.getHostsByIds(allowedIds) as any[] : [];
      const byId = new Map<number, any>();
      for (const host of [...own, ...others]) byId.set(Number(host.id), host);
      return Array.from(byId.values());
    })()) as any[];
  const inbounds = (isAdmin ? await db.getAllProxyInbounds() : await (async () => {
    const hostIds = hosts.map((host) => Number(host.id));
    const rows: any[] = [];
    for (const hostId of hostIds) rows.push(...await db.getProxyInboundsByHost(hostId) as any[]);
    return rows;
  })()) as any[];
  const byHost = new Map<number, any[]>();
  for (const inbound of inbounds) {
    if (String(inbound.protocol) !== "shadowsocks") continue;
    const usable = isAdmin || Number(inbound.userId) === Number(actor.id) || dbBool(inbound.landingEgress);
    if (!usable) continue;
    const list = byHost.get(Number(inbound.hostId)) || [];
    list.push({
      id: Number(inbound.id),
      name: String(inbound.name || ""),
      port: Number(inbound.port),
      method: normalizeSsMethod(inbound.method),
      methodError: ssEgressMethodError(inbound.method),
      isEnabled: dbBool(inbound.isEnabled, true),
      landingEgress: dbBool(inbound.landingEgress),
    });
    byHost.set(Number(inbound.hostId), list);
  }
  return hosts
    .filter((host) => String(host.hostType || "slave") !== "master" || isAdmin)
    .map((host) => ({
      hostId: Number(host.id),
      hostName: String(host.name || `#${host.id}`),
      online: isHostConsideredOnline(host),
      hasAddress: !!getHostEntryAddress(host),
      ownHost: Number(host.userId) === Number(actor.id),
      // 一键创建要能在这台机器上开落地节点：管理员，或者机器是自己的（细的权限 / 额度检查在创建时做）。
      canCreateInbound: isAdmin || Number(host.userId) === Number(actor.id),
      inbounds: (byHost.get(Number(host.id)) || []).sort((a, b) => a.port - b.port),
    }))
    .sort((a, b) => Number(b.inbounds.length > 0) - Number(a.inbounds.length > 0) || a.hostName.localeCompare(b.hostName));
}

/* ── 给规则编辑器的入口机能力 ───────────────────────────────────────── */

/**
 * 每台入口机现在能不能做 UDP 出口 / SS2022 出口，和保存、下发用的是同一个判断
 * （shared/ssEgress.ts hostSsEgressCapabilities）。自己看不到的主机（端口转发资源里别人的成员）
 * 只回能力，不回名字和版本。
 */
export async function listEgressEntryCapabilities(actor: Actor, hostIds: readonly number[]) {
  const ids = Array.from(new Set(hostIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))).slice(0, 64);
  if (ids.length === 0) return [];
  const rows = await db.getHostsByIds(ids) as any[];
  const allowed = actor.role === "admin"
    ? null
    : new Set((await db.getUserEffectiveAllowedHostIds(actor.id)).map(Number));
  return ids.map((hostId) => {
    const host = rows.find((row) => Number(row.id) === hostId) || null;
    const canSee = !!host && (allowed === null || Number(host.userId) === Number(actor.id) || allowed.has(hostId));
    const capabilities = hostSsEgressCapabilities(host);
    return {
      hostId,
      name: canSee ? String(host.name || "") : null,
      agentVersion: canSee ? String(host.agentVersion || "") || null : null,
      runtimeVersion: canSee ? String(host.runtimeVersion || "") || null : null,
      udp: capabilities.udp,
      ss2022: capabilities.ss2022,
      udpMessage: capabilities.udp ? null : ssEgressUdpUpgradeMessage(canSee ? host : null),
      ss2022Message: capabilities.ss2022 ? null : ssEgress2022UpgradeMessage(canSee ? host : null),
    };
  });
}

/* ── 下发：运行视图和 gost 出口链 ────────────────────────────────────── */

export type SsEgressRuntime = {
  server: string;
  port: number;
  method: string;
  password: string;
  udp: boolean;
};

export type EgressRuntimeContext = {
  inboundById: Map<number, any>;
  hostById: Map<number, any>;
};

/** 心跳里一次把这批规则要的落地入站和落地主机查完。 */
export async function loadEgressRuntimeContext(rules: readonly any[], previous?: EgressRuntimeContext): Promise<EgressRuntimeContext> {
  const context: EgressRuntimeContext = previous || { inboundById: new Map(), hostById: new Map() };
  const inboundIds = Array.from(new Set(rules
    .filter((rule) => normalizeRuleEgressType(rule?.egressType) === "ss_host")
    .map((rule) => Number(rule.egressInboundId || 0))
    .filter((id) => id > 0 && !context.inboundById.has(id))));
  for (const id of inboundIds) {
    const inbound = await db.getProxyInboundById(id).catch(() => undefined);
    context.inboundById.set(id, inbound || null);
  }
  const hostIds = Array.from(new Set(Array.from(context.inboundById.values())
    .filter(Boolean)
    .map((inbound: any) => Number(inbound.hostId))
    .filter((id) => id > 0 && !context.hostById.has(id))));
  if (hostIds.length > 0) {
    for (const host of await db.getHostsByIds(hostIds) as any[]) context.hostById.set(Number(host.id), host);
  }
  return context;
}

export type RuleEgressEvaluation = {
  state: RuleEgressState;
  runtime: SsEgressRuntime | null;
  landingHost: any | null;
  inbound: any | null;
  endpoint: SsEgressEndpoint | null;
  message: string;
};

/**
 * 这条规则的出口现在是什么状态、要下发的话下发什么。纯计算（上下文由调用方查好）。
 * entryAgentVersion：规则所在入口机的 Agent 版本；entryHostId 用来查自环。
 */
export type RuleEgressEntryOptions = {
  entryHostId: number;
  entryAgentVersion: string;
  entryHostName?: string;
  /** 入口机这次心跳上报的能力（hosts.agentCapabilities），决定 UDP / SS2022 能不能下发。 */
  entryAgentCapabilities?: unknown;
  /** 入口机上报的运行时版本，只用来写提示。 */
  entryRuntimeVersion?: unknown;
  context: EgressRuntimeContext;
};

export function evaluateRuleEgress(rule: any, options: RuleEgressEntryOptions): RuleEgressEvaluation | null {
  const type = normalizeRuleEgressType(rule?.egressType);
  if (type === "none") return null;
  const base = { runtime: null, landingHost: null, inbound: null, endpoint: null } as const;
  const shapeError = ruleEgressShapeError({
    egressType: type,
    forwardType: rule.forwardType,
    protocol: rule.protocol,
    egressUdp: rule.egressUdp,
    tunnelId: rule.tunnelId,
    // 子规则 / 模板挂着端口转发资源时 forwardGroupId 有值；不是端口转发的已经在保存时拦了，这里只看隧道等硬条件。
    failoverEnabled: rule.failoverEnabled,
    tlsInboundId: rule.tlsInboundId,
  });
  let landingHost: any = null;
  let inbound: any = null;
  let endpoint: SsEgressEndpoint | null = null;
  if (type === "ss_host") {
    inbound = options.context.inboundById.get(Number(rule.egressInboundId || 0)) || null;
    if (!inbound) return { ...base, state: "inbound_missing", message: "出口用的落地入站已被删除" };
    landingHost = options.context.hostById.get(Number(inbound.hostId)) || null;
    if (!landingHost) return { ...base, inbound, state: "inbound_missing", message: "落地主机已被删除" };
    if (String(inbound.protocol) !== "shadowsocks" || ssEgressMethodError(inbound.method)) {
      return { ...base, inbound, landingHost, state: "method_unsupported", message: ssEgressMethodError(inbound.method) || "落地入站不是 Shadowsocks" };
    }
    if (!dbBool(inbound.isEnabled, true)) return { ...base, inbound, landingHost, state: "inbound_disabled", message: `落地入站「${inbound.name}」已停用` };
    if (Number(landingHost.id) === Number(options.entryHostId)) return { ...base, inbound, landingHost, state: "self_loop", message: "落地主机就是入口主机" };
    const server = getHostEntryAddress(landingHost);
    if (!server) return { ...base, inbound, landingHost, state: "config_invalid", message: "落地主机没有可用地址" };
    endpoint = { server, port: Number(inbound.port), method: normalizeSsMethod(inbound.method), password: String(inbound.password || "") };
  } else {
    endpoint = decryptSsEgressEndpoint(rule.egressConfigJson);
    if (!endpoint) return { ...base, state: "config_invalid", message: "出口链接无法解密，请重新粘贴" };
  }
  const endpointError = ssEgressEndpointError(endpoint);
  if (endpointError) {
    return { ...base, inbound, landingHost, endpoint, state: ssEgressMethodError(endpoint.method) ? "method_unsupported" : "config_invalid", message: endpointError };
  }
  if (shapeError) return { ...base, inbound, landingHost, endpoint, state: "shape_invalid", message: shapeError };
  if (!isSsEgressAgentSupported(options.entryAgentVersion)) {
    return { ...base, inbound, landingHost, endpoint, state: "agent_upgrade", message: ssEgressAgentUpgradeMessage(options.entryHostName) };
  }
  /*
    能力不够时整条规则按停用下发（和 Agent 太旧同一个处理）：UDP 不能偷偷直连，也不能显示成在走出口；
    SS2022 在旧运行时上连 TCP 都不通。经典 AEAD 只走 TCP 的规则不看能力，旧入口机上照旧。
  */
  const entryHost = {
    name: options.entryHostName,
    agentVersion: options.entryAgentVersion,
    runtimeVersion: options.entryRuntimeVersion,
    agentCapabilities: options.entryAgentCapabilities,
  };
  const capabilities = hostSsEgressCapabilities(entryHost);
  if (isSs2022Method(endpoint.method) && !capabilities.ss2022) {
    return { ...base, inbound, landingHost, endpoint, state: "ss2022_runtime_upgrade", message: ssEgress2022UpgradeMessage(entryHost) };
  }
  const wantsUdp = ruleEgressWantsUdp(rule);
  if (wantsUdp && !capabilities.udp) {
    return { ...base, inbound, landingHost, endpoint, state: "udp_runtime_upgrade", message: ssEgressUdpUpgradeMessage(entryHost) };
  }
  const runtime: SsEgressRuntime = {
    server: endpoint.server,
    port: endpoint.port,
    method: endpoint.method,
    password: endpoint.password,
    udp: SS_EGRESS_UDP_SUPPORTED && wantsUdp && capabilities.udp,
  };
  const paused = !dbBool(rule.isEnabled);
  if (landingHost && !isHostConsideredOnline(landingHost)) {
    return { runtime, landingHost, inbound, endpoint, state: paused ? "paused" : "landing_offline", message: `落地主机「${landingHost.name}」离线` };
  }
  return { runtime, landingHost, inbound, endpoint, state: paused ? "paused" : "running", message: "" };
}

/**
 * 规则在这台 Agent 上的运行视图（和共享 TLS 入站的 sniRuleRuntimeView 同一个思路）：
 *   - 出口失效 / Agent 太旧 → 按停用下发，已经起着的监听走正常的停用流程撤掉，绝不退回直连
 *     （退回直连会让流量换一个出口 IP，用户以为在走落地，其实没有）；
 *   - 能跑 → 带上 egressRuntime，下游生成 gost 配置时挂出口链；UDP 不走出口时协议收窄成 TCP。
 * 没有出口的规则原样返回（同一个对象）。
 */
export function ruleEgressRuntimeView<T extends Record<string, any>>(rule: T, options: RuleEgressEntryOptions): T {
  const evaluation = evaluateRuleEgress(rule, options);
  if (!evaluation) return rule;
  const view: Record<string, any> = {
    ...rule,
    failoverEnabled: false,
    udpOverTcp: false,
    zeroCopy: false,
  };
  if (ruleEgressStateBlocksDelivery(evaluation.state) || !evaluation.runtime) {
    view.isEnabled = false;
    view.egressRuntimeBlocked = evaluation.state;
    view.egressRuntime = null;
    return view as T;
  }
  view.egressRuntime = evaluation.runtime;
  if (!evaluation.runtime.udp) view.protocol = "tcp";
  return view as T;
}

export function ruleEgressRuntime(rule: any): SsEgressRuntime | null {
  const runtime = rule?.egressRuntime;
  return runtime && runtime.server && runtime.port ? runtime as SsEgressRuntime : null;
}

export function gostEgressChainName(ruleId: number, proto: "tcp" | "udp") {
  return `chain-egress-${Number(ruleId)}-${proto}`;
}

/**
 * gost 的出口链：一跳一个节点。TCP 用 ss 连接器 + tcp 拨号器（nodelay：握手随连接立刻发出去，
 * 否则 SSH、SMTP 这类「服务端先说话」的协议会一直等不到落地去连目标）；UDP 用 ssu 连接器 +
 * udp 拨号器（ssu 配 tcp 拨号器走的是 UDP-over-TCP，gost 这一版那条路没初始化，会直接崩）。
 */
export function buildGostEgressChain(ruleId: number, proto: "tcp" | "udp", runtime: SsEgressRuntime) {
  const host = runtime.server.includes(":") ? `[${runtime.server}]` : runtime.server;
  const auth = { username: normalizeSsMethod(runtime.method), password: canonicalSsEgressPassword(runtime.method, runtime.password) };
  return {
    name: gostEgressChainName(ruleId, proto),
    hops: [{
      name: `hop-egress-${Number(ruleId)}-${proto}`,
      nodes: [{
        name: `egress-${Number(ruleId)}-${proto}`,
        addr: `${host}:${Number(runtime.port)}`,
        connector: proto === "tcp"
          ? { type: "ss", auth, metadata: { nodelay: true } }
          // 回包缓冲默认 4096，再大的回包（带 DNSSEC 的 DNS 回答之类）会被截断、解密失败、悄悄丢掉
          : { type: "ssu", auth, metadata: { udpBufferSize: 65535 } },
        dialer: { type: proto },
      }],
    }],
  };
}

/* ── 规则列表上的显示 ───────────────────────────────────────────────── */

/**
 * 给规则列表加上 egress 一段：类型、落地主机名、打码的链接、状态。去掉 egressConfigJson（密文也不出接口）。
 */
export async function withRuleEgressDisplay<T>(value: T): Promise<T> {
  const list: any[] = Array.isArray(value)
    ? value
    : value && Array.isArray((value as any).items)
      ? (value as any).items
      : value ? [value] : [];
  const egressRules = list.filter((rule) => normalizeRuleEgressType(rule?.egressType) !== "none");
  const strip = (rule: any) => {
    if (!rule || typeof rule !== "object" || !("egressConfigJson" in rule)) return rule;
    const { egressConfigJson: _secret, ...rest } = rule;
    return rest;
  };
  let decorate = (rule: any) => strip(rule);
  if (egressRules.length > 0) {
    const context = await loadEgressRuntimeContext(egressRules);
    const entryHostIds = new Set<number>();
    const templateGroupIds = new Set<number>();
    for (const rule of egressRules) {
      if (rule.isForwardGroupTemplate && Number(rule.forwardGroupId || 0) > 0) templateGroupIds.add(Number(rule.forwardGroupId));
      else if (Number(rule.hostId || 0) > 0) entryHostIds.add(Number(rule.hostId));
    }
    const groupEntryHosts = new Map<number, number[]>();
    for (const groupId of Array.from(templateGroupIds)) {
      const ids = (await db.getForwardGroupRuleEntryHostIds(groupId).catch(() => [])) as number[];
      groupEntryHosts.set(groupId, ids.map(Number));
      for (const id of ids) entryHostIds.add(Number(id));
    }
    const entryHosts = entryHostIds.size > 0 ? await db.getHostsByIds(Array.from(entryHostIds)) as any[] : [];
    const entryHostById = new Map(entryHosts.map((host: any) => [Number(host.id), host] as const));
    decorate = (rule: any) => {
      const plain = strip(rule);
      if (normalizeRuleEgressType(rule?.egressType) === "none") return plain;
      const hostIds = rule.isForwardGroupTemplate && Number(rule.forwardGroupId || 0) > 0
        ? groupEntryHosts.get(Number(rule.forwardGroupId)) || []
        : [Number(rule.hostId)];
      // 多台入口时取最要紧的那个状态：有一台 Agent 太旧就提示升级。
      let worst: RuleEgressEvaluation | null = null;
      for (const hostId of hostIds.length > 0 ? hostIds : [Number(rule.hostId)]) {
        const host = entryHostById.get(Number(hostId));
        const evaluation = evaluateRuleEgress(rule, {
          entryHostId: Number(hostId),
          entryAgentVersion: String(host?.agentVersion || ""),
          entryHostName: host?.name,
          entryAgentCapabilities: host?.agentCapabilities,
          entryRuntimeVersion: host?.runtimeVersion,
          context,
        });
        if (!evaluation) continue;
        if (!worst || (worst.state === "running" || worst.state === "paused")) worst = evaluation;
        if (worst.state !== "running" && worst.state !== "paused") break;
      }
      if (!worst) return plain;
      return {
        ...plain,
        egress: {
          type: normalizeRuleEgressType(rule.egressType),
          inboundId: Number(rule.egressInboundId || 0) || null,
          inboundName: worst.inbound ? String(worst.inbound.name || "") : null,
          landingHostId: worst.landingHost ? Number(worst.landingHost.id) : null,
          landingHostName: worst.landingHost ? String(worst.landingHost.name || "") : null,
          masked: worst.endpoint ? maskSsEgressEndpoint(worst.endpoint) : "",
          method: worst.endpoint ? normalizeSsMethod(worst.endpoint.method) : "",
          // 只有真的下发了 UDP 出口才算「含 UDP」；勾了但入口机撑不起时 state 是 udp_runtime_upgrade。
          udp: worst.runtime?.udp === true,
          udpConfigured: dbBool(rule.egressUdp),
          state: worst.state,
          message: worst.message,
        },
      };
    };
  }
  if (Array.isArray(value)) return value.map(decorate) as T;
  if (value && Array.isArray((value as any).items)) return { ...value, items: (value as any).items.map(decorate) } as T;
  return (value ? decorate(value) : value) as T;
}

/** 测试与心跳共用：哪些规则 id 用了这个入站（含子规则）。 */
export async function getRuleIdsUsingEgressInbounds(inboundIds: readonly number[]) {
  const ids = Array.from(new Set(inboundIds.map(Number).filter((id) => id > 0)));
  if (ids.length === 0) return [] as number[];
  const database = await getDb();
  if (!database) return [];
  const rows = await database.select({ id: forwardRules.id }).from(forwardRules)
    .where(and(eq(forwardRules.egressType, "ss_host"), inArray(forwardRules.egressInboundId, ids)));
  return (rows as any[]).map((row) => Number(row.id));
}
