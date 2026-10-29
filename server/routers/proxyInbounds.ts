/**
 * 落地入站的接口。
 *
 * 与 proxySubscriptions.ts 的分工：那边管「客户端订阅」（粘链接进来的节点、
 * 订阅令牌），这边管「面板自己在主机上开节点」。两者共用同一个权限开关 ——
 * 开落地节点的人一定也要能看订阅，否则开出来的东西自己拿不到。
 *
 * 凭据一律由服务端生成，不让前端传：REALITY 私钥、UUID、密码这些一旦经过浏览器
 * 就多了一条泄漏路径，而用户也没有理由要自己指定它们。
 */

import { assertInboundRoutingNotDoubleLanding } from "../landingConflicts";
import { z } from "zod";

import { pushAgentRefresh } from "../agentEvents";
import { protectedProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { assertTenantListenPortAllowed } from "../tenantListenPortGuard";
import {
  createEmptyProxyInbound,
  proxyInboundSecurities,
  proxyInboundTransports,
  PROXY_INBOUND_PROTOCOLS,
  PROXY_INBOUND_SECURITIES,
  PROXY_INBOUND_SNELL_DEFAULT_VERSION,
  PROXY_INBOUND_SNELL_VERSIONS,
  PROXY_INBOUND_SHADOWSOCKS_METHODS,
  proxyInboundShadowsocksKeyBytes,
  PROXY_INBOUND_SHADOWSOCKS_DEFAULT_METHOD,
  isProxyInboundShadowsocksMethod,
  proxyInboundSupportsMultiUser,
  proxyNodesFromInbound,
  proxyInboundUserCredentialKinds,
  validateProxyInbound,
  type ProxyInboundUser,
  type ProxyInbound,
  type ProxyInboundProtocol,
} from "../../shared/proxyInbound";
import { formatProxyNodeLink, PROXY_NODE_TRANSPORTS } from "../../shared/proxyNode";
import { combinePortPolicies, isPortAllowedByPolicy, portPolicyErrorMessage, portPolicyFrom } from "../../shared/portPolicy";
import { dbBool } from "../repositories/repositoryUtils";
import { INBOUND_ROUTE_TARGETS, MAX_INBOUND_ROUTES, parseInboundRouting, serializeInboundRouting } from "../../shared/inboundRouting";
import {
  describeInboundRoutingStatus,
  getInboundsRoutingVia,
  invalidateInboundRoutingContext,
  listRoutingLandingOptions,
  refreshInboundRoutingDependents,
  validateInboundRoutingForSave,
} from "../inboundRoutingRuntime";
import { listLandingOptions } from "../landingOptions";
import {
  assertProxyInboundEgressCompatibleChange,
  assertProxyInboundNotUsedAsEgress,
  LANDING_EGRESS_INBOUND_DEFAULTS,
  listEgressEntryCapabilities,
  listEgressLandingOptions,
  pickLandingEgressPort,
  refreshEgressDependents,
} from "../ssEgress";
import {
  generateProxyInboundPassword,
  generateProxyInboundPsk,
  generateProxyInboundUuid,
  generateRealityKeyPair,
  generateRealityShortId,
} from "../proxyRealityKeys";

/**
 * REALITY 要偷的默认握手域名。
 *
 * 挑的标准是「随处可达、TLS 1.3、证书链正常、且本身流量就大」—— 偷一个冷门站点
 * 反而显眼。用户可以改。
 */
const DEFAULT_REALITY_SERVER_NAME = "dl.google.com";

async function assertAllowed(ctx: any) {
  if (ctx.user.role === "admin") return;
  const user = await db.getUserById(ctx.user.id);
  if (!user?.allowProxySubscription) throw new Error("当前账号没有客户端订阅权限，请联系管理员开通");
}

async function assertOwnedInbound(id: number, ctx: any) {
  const inbound = await db.getProxyInboundById(id);
  if (!inbound) throw new Error("落地节点不存在");
  if (ctx.user.role !== "admin" && inbound.userId !== ctx.user.id) throw new Error("无权操作该落地节点");
  return inbound;
}

/**
 * 这个用户还能不能再开一个落地节点。
 *
 * 主机授权只管「能在哪台机器上开」，管不住「开几个」—— 一个拿到主机授权的租户
 * 可以把那台机器的端口占满。配额是那道刹车。
 *
 * 检查的是**归属者**的额度而不是操作者的：管理员替租户开节点时，占的是租户的份额。
 * 管理员自己不受限 —— 他要是想开满，配额也拦不住他，拦了反而碍事。
 */
async function assertInboundQuota(ownerId: number, ctx: any) {
  if (ctx.user.role === "admin" && ownerId === ctx.user.id) return;
  const owner = await db.getUserById(ownerId);
  const limit = Number((owner as any)?.maxProxyInbounds || 0);
  // 0 = 不限，与 maxRules / maxPorts 一致。
  if (limit <= 0) return;
  const used = await db.countProxyInboundsByUser(ownerId);
  if (used >= limit) {
    const who = ctx.user.id === ownerId ? "你" : `用户「${(owner as any)?.username || ownerId}」`;
    throw new Error(`${who}的落地节点已达上限（${used}/${limit}）。删掉一个，或让管理员调高上限。`);
  }
}

/**
 * 落地节点只能开在装了 Agent 的主机上 —— 面板要靠 Agent 把配置推下去。
 * 租来的线路机上装不了 Agent，那种落地仍然走「粘链接」那条路。
 */
/**
 * 能不能在这台主机上开落地节点。
 *
 * 抽成纯函数是为了能单独测 —— 这条判定错一次的后果是「租户加了自己的机器却用
 * 不了」或者「能在别人的机器上开端口」，两头都不该靠肉眼看。
 *
 * 三档，顺序要紧：
 *   1. 管理员：都行
 *   2. 自己的机器：直接放行 —— 与 helpers.ts 的 requireHostAccess 一致。
 *      原来漏了这一档，于是租户能在「主机管理」里加自己的 VPS（hosts.create
 *      本来就不是管理员专属）、能在列表里看见、能装上 Agent，一点「新建节点」
 *      却撞上「无权」。而那一段的空状态还写着「先去主机管理装一台」，
 *      等于把人往墙上引。放开它没有多出风险：机器是他自己的，Agent 装在他
 *      自己那台上，maxProxyInbounds 照样管着他能开几个。
 *   3. 别人的机器：要有授权（用有效授权而不是直接授权，套餐附带的也算数）
 */
export function canOpenInboundOnHost(
  user: { id: number; role: string },
  host: { userId?: unknown } | null | undefined,
  effectiveAllowedHostIds: readonly number[],
  hostId: number,
): boolean {
  if (!host) return false;
  if (user.role === "admin") return true;
  if (Number(host.userId) === Number(user.id)) return true;
  return effectiveAllowedHostIds.map(Number).includes(Number(hostId));
}

async function assertUsableHost(hostId: number, ctx: any) {
  const host = await db.getHostById(hostId);
  if (!host) throw new Error("主机不存在");
  // 只有轮到第三档才需要查库，管理员和自己的机器不必多跑一次查询。
  const allowed = ctx.user.role === "admin" || Number(host.userId) === Number(ctx.user.id)
    ? []
    : await db.getUserEffectiveAllowedHostIds(ctx.user.id);
  if (!canOpenInboundOnHost(ctx.user, host, allowed, hostId)) {
    throw new Error("无权在该主机上开落地节点");
  }
  return host;
}

/** 普通用户开在别人机器上的入站：靠的是主机授权，授权收回后运行时不再下发它。 */
function inboundNeedsHostGrant(ctx: any, host: any) {
  return ctx.user.role !== "admin" && Number(host?.userId) !== Number(ctx.user.id);
}

/**
 * 端口能不能用。
 *
 * 以前只查了「和别的落地节点撞没撞」。可这台机器上还跑着转发规则、隧道的监听 —— 面板一路放行，
 * 到了机器上后起的那个 bind 失败，而界面两边都显示正常；租户还能借此把管理员留给转发的端口占掉。
 * 所以和转发规则走同一个占用判断（isPortUsedOnHost，排除这个入站自己）。
 *
 * 开在别人机器上的普通用户还要守那台机器的端口策略（范围 / 白名单）和套餐端口区间，
 * 和他在同一台机器上建转发规则时是同一套口径。自己的机器不受这条限制：策略是他自己定的，
 * 而 443 这类常用端口往往就在默认区间外面。
 */
async function assertInboundPortAllowed(ctx: any, host: any, port: number, excludeInboundId?: number) {
  const hostId = Number(host.id);
  if (await db.isPortUsedOnHost(hostId, port, undefined, "both", undefined, true, undefined, excludeInboundId)) {
    throw new Error(`该主机的 ${port} 端口已被转发规则或隧道占用`);
  }
  if (!inboundNeedsHostGrant(ctx, host)) return;
  let policy = portPolicyFrom(host);
  const planRange = await db.getUserPlanPortRange(ctx.user.id, hostId);
  if (planRange) policy = combinePortPolicies(policy, portPolicyFrom({ portRanges: planRange.ranges }));
  if (!isPortAllowedByPolicy(port, policy)) throw new Error(portPolicyErrorMessage(policy, "落地节点端口"));
}

/**
 * TLS 的证书、私钥是 sing-box 以 root 身份从那台机器上直接读的文件路径。普通用户在别人的机器上
 * 随手填一个路径，就能让 sing-box 拿那台机器上别人的证书和私钥对外握手。所以在别人的机器上
 * 只能用面板管得住的两种：自动签证书（ACME）和 REALITY。自己的机器随意。
 */
function assertInboundCertPathsAllowed(ctx: any, host: any, inbound: ProxyInbound) {
  if (!inboundNeedsHostGrant(ctx, host)) return;
  if (inbound.security === "tls") {
    throw new Error("在别人的主机上不能指定证书文件路径，请改用自动签证书（ACME）或 REALITY");
  }
}

/** 给一个用户补齐它这个协议需要的凭据。已有值不动 —— 编辑时不该把别人的凭据换掉。 */
function fillUserCredentials(user: ProxyInboundUser, protocol: ProxyInbound["protocol"]): ProxyInboundUser {
  const kinds = proxyInboundUserCredentialKinds(protocol);
  return {
    ...user,
    uuid: kinds.includes("uuid") ? (user.uuid || generateProxyInboundUuid()) : "",
    password: kinds.includes("password") ? (user.password || generateProxyInboundPassword()) : "",
  };
}

/**
 * 解析这个入站该归谁，并确认那个人拿得到它。
 *
 * 关键的一条：被指定的人必须有客户端订阅权限。没有的话入站会正常建起来、流量也
 * 会照扣，但他在面板上看不到节点、也拉不到订阅 —— 一个「建好了却用不上」的节点，
 * 而管理员从界面上看不出哪里不对。所以在这里当场拦住并说清要去开什么。
 */
async function resolveOwnerId(ctx: any, requested?: number): Promise<number> {
  const ownerId = Number(requested || 0);
  if (!ownerId || ownerId === ctx.user.id) return ctx.user.id;
  if (ctx.user.role !== "admin") throw new Error("只有管理员能把落地节点开给其他用户");
  const owner = await db.getUserById(ownerId);
  if (!owner) throw new Error("指定的用户不存在");
  if (!owner.allowProxySubscription) {
    throw new Error(`用户「${owner.username}」没有客户端订阅权限，开给他也拿不到节点 —— 请先在「用户管理」里开通`);
  }
  return ownerId;
}

/** 按协议与安全层补齐这一份入站需要的随机凭据。 */
function fillGeneratedCredentials(inbound: ProxyInbound): ProxyInbound {
  const filled = { ...inbound };
  if (proxyInboundSupportsMultiUser(filled.protocol)) {
    // 一个用户都没有时补一个默认的：新建时用户不必先去想「给谁用」。
    const users = filled.users.length > 0 ? filled.users : [{ id: 0, name: "默认", uuid: "", password: "" }];
    filled.users = users.map((user) => fillUserCredentials(user, filled.protocol));
    // 多用户协议的凭据只在用户身上，入站行上的那两列不再参与鉴权，清掉免得看着像还有用。
    filled.uuid = "";
    filled.password = "";
  } else {
    filled.users = [];
  }
  if (filled.protocol === "shadowsocks") {
    filled.method = isProxyInboundShadowsocksMethod(filled.method)
      ? filled.method
      : PROXY_INBOUND_SHADOWSOCKS_DEFAULT_METHOD;
    /**
     * 两类算法的密码规则不一样，走不同的生成路径：
     *   SS2022   定长密钥，长度不对 sing-box 整份拒绝加载。
     *   老 AEAD  任意口令，给普通随机串即可（实测什么长度都收）。
     */
    const bytes = proxyInboundShadowsocksKeyBytes(filled.method);
    filled.password = filled.password || (bytes > 0 ? generateProxyInboundPsk(bytes) : generateProxyInboundPassword());
  } else if (filled.protocol === "snell") {
    filled.password = filled.password || generateProxyInboundPsk(16);
  }
  if (filled.protocol === "snell" && !filled.snellVersion) {
    filled.snellVersion = PROXY_INBOUND_SNELL_DEFAULT_VERSION;
  }
  if (filled.security === "reality") {
    filled.serverName = filled.serverName || DEFAULT_REALITY_SERVER_NAME;
    if (!filled.realityPrivateKey || !filled.realityPublicKey) {
      const pair = generateRealityKeyPair();
      filled.realityPrivateKey = pair.privateKey;
      filled.realityPublicKey = pair.publicKey;
    }
    filled.realityShortId = filled.realityShortId || generateRealityShortId();
  }
  return filled;
}

/**
 * 保存后同步派生节点，并催这台主机马上重算一次下发。
 *
 * 不催也会生效 —— 下一次心跳就会重算；催一下只是把「改完到生效」从几十秒压到
 * 立刻，用户不至于以为没保存上。下发本身是按主机整体重算的：一台机器上所有
 * 启用中的入站合成一份 sing-box 配置。
 */
async function applyInbound(inboundId: number, hostId: number) {
  invalidateInboundRoutingContext();
  await db.syncProxyNodeFromInbound(inboundId);
  pushAgentRefresh(hostId, `proxy-inbound-${inboundId}`, { urgent: true });
}

const inboundInput = z.object({
  hostId: z.number().int().positive(),
  /**
   * 这个入站归谁。只有管理员能指定别人 —— 这是「把一台机器上的多个端口分租给
   * 不同用户」的关键：归属决定了节点进谁的订阅、流量扣谁的套餐。
   * 不传就是操作者自己。
   */
  userId: z.number().int().positive().optional(),
  name: z.string().trim().min(1).max(64),
  remark: z.string().trim().max(200).optional(),
  /** 对外标注：分享给别人时对方看得到的那一句。会带到派生节点上。 */
  publicLabel: z.string().trim().max(40).optional(),
  protocol: z.enum(PROXY_INBOUND_PROTOCOLS),
  port: z.number().int().min(1).max(65535),
  transport: z.enum(PROXY_NODE_TRANSPORTS).optional(),
  security: z.enum(PROXY_INBOUND_SECURITIES).optional(),
  serverName: z.string().trim().max(253).optional(),
  realityDest: z.string().trim().max(300).optional(),
  path: z.string().trim().max(200).optional(),
  host: z.string().trim().max(253).optional(),
  certPath: z.string().trim().max(300).optional(),
  keyPath: z.string().trim().max(300).optional(),
  acmeEmail: z.string().trim().max(200).optional(),
  flow: z.string().trim().max(64).optional(),
  method: z.string().trim().max(64).optional(),
  obfs: z.string().trim().max(32).optional(),
  obfsPassword: z.string().trim().max(128).optional(),
  upMbps: z.number().int().min(0).max(100000).optional(),
  downMbps: z.number().int().min(0).max(100000).optional(),
  congestionControl: z.string().trim().max(32).optional(),
  snellVersion: z.number().int().optional(),
  snellMode: z.string().trim().max(32).optional(),
  /**
   * 这个端口自己的额度与用量。
   *
   * 和主机那一层不是一回事：主机层是机房账单口径（系统级网卡计数），这一层只数
   * 面板经手的这个端口。已用量可以手工改，是为了跟别处的统计对齐 —— 面板自己
   * 仍然继续累加。
   */
  bandwidthMbps: z.number().int().min(0).max(1000000).optional(),
  trafficLimit: z.number().int().min(0).optional(),
  trafficUsed: z.number().int().min(0).optional(),
  trafficAutoReset: z.boolean().optional(),
  trafficResetDay: z.number().int().min(1).max(31).optional(),
  isEnabled: z.boolean().optional(),
  /**
   * 入站上的用户。只有多用户协议用得上，且只收 id 与 name ——
   * 凭据一律服务端生成，不让前端指定（经过浏览器就多一条泄漏路径）。
   * 不传表示不改动现有用户；传空数组会被当成「补一个默认用户」。
   */
  users: z.array(z.object({
    id: z.number().int().nonnegative().default(0),
    name: z.string().trim().max(64),
  })).max(200).optional(),
  /**
   * 分流（shared/inboundRouting.ts）：按服务 / 域名把一部分流量从别的落地出去。
   * 不传 = 不改；null 或空列表 = 不分流。
   */
  routing: z.object({
    routes: z.array(z.object({
      presets: z.array(z.string().max(40)).max(20).default([]),
      domains: z.array(z.string().max(300)).max(200).default([]),
      target: z.enum(INBOUND_ROUTE_TARGETS),
      landingInboundId: z.number().int().nonnegative().default(0),
    })).max(MAX_INBOUND_ROUTES),
  }).nullable().optional(),
});

type InboundInput = z.infer<typeof inboundInput>;

/** 把接口入参并进入站模型，缺省值按协议推导。 */
/**
 * 端口额度那几列。不走 mergeInbound —— 那个拼的是要下发给 sing-box 的配置，
 * 额度只是面板自己记账用的，混进去会让「配置变了没」这种判断跟着抖。
 */
function inboundQuotaRow(input: Partial<InboundInput>, isAdmin: boolean) {
  // 额度、已用量、限速是管理员给这个端口定的账：租户自己改就等于自己给自己加额度。
  // 非管理员提交的这些字段一律忽略，更新时保留原值（表单会原样回传，不能直接报错）。
  if (!isAdmin) return {};
  return {
    ...(input.bandwidthMbps !== undefined ? { bandwidthMbps: input.bandwidthMbps } : {}),
    ...(input.trafficLimit !== undefined ? { trafficLimit: input.trafficLimit } : {}),
    ...(input.trafficUsed !== undefined ? { trafficUsed: input.trafficUsed } : {}),
    ...(input.trafficAutoReset !== undefined ? { trafficAutoReset: input.trafficAutoReset } : {}),
    ...(input.trafficResetDay !== undefined ? { trafficResetDay: input.trafficResetDay } : {}),
  };
}

function mergeInbound(base: ProxyInbound, input: Partial<InboundInput>): ProxyInbound {
  const merged: ProxyInbound = { ...base };
  if (input.protocol !== undefined) merged.protocol = input.protocol as ProxyInboundProtocol;
  if (input.name !== undefined) merged.name = input.name;
  if (input.port !== undefined) merged.port = input.port;
  if (input.transport !== undefined) merged.transport = input.transport;
  if (input.security !== undefined) merged.security = input.security;
  if (input.serverName !== undefined) merged.serverName = input.serverName;
  if (input.realityDest !== undefined) merged.realityDest = input.realityDest;
  if (input.path !== undefined) merged.path = input.path;
  if (input.host !== undefined) merged.host = input.host;
  if (input.certPath !== undefined) merged.certPath = input.certPath;
  if (input.keyPath !== undefined) merged.keyPath = input.keyPath;
  if (input.acmeEmail !== undefined) merged.acmeEmail = input.acmeEmail;
  if (input.flow !== undefined) merged.flow = input.flow;
  if (input.method !== undefined) merged.method = input.method;
  if (input.obfs !== undefined) merged.obfs = input.obfs.toLowerCase();
  if (input.obfsPassword !== undefined) merged.obfsPassword = input.obfsPassword;
  if (input.upMbps !== undefined) merged.upMbps = input.upMbps;
  if (input.downMbps !== undefined) merged.downMbps = input.downMbps;
  if (input.congestionControl !== undefined) merged.congestionControl = input.congestionControl;
  if (input.snellVersion !== undefined) merged.snellVersion = input.snellVersion;
  if (input.snellMode !== undefined) merged.snellMode = input.snellMode;
  if (input.users !== undefined) {
    /**
     * 按 id 对上已有用户，把凭据带过来 —— 前端不传凭据，这里若不保留，
     * 每次改个名字都会给所有人换一遍凭据，客户端全体掉线。
     */
    const byId = new Map(base.users.map((user) => [user.id, user]));
    merged.users = input.users.map((item) => {
      const current = item.id > 0 ? byId.get(item.id) : undefined;
      return {
        id: current ? current.id : 0,
        name: item.name,
        uuid: current?.uuid || "",
        password: current?.password || "",
      };
    });
  }

  // 换协议时把不适用的传输与安全层收敛回该协议允许的第一项，
  // 否则会留下一个「VLESS 时选了 ws，改成 Hysteria2 后 ws 还在」的非法组合。
  const transports = proxyInboundTransports(merged.protocol);
  if (!transports.includes(merged.transport)) merged.transport = transports[0];
  const securities = proxyInboundSecurities(merged.protocol);
  if (!securities.includes(merged.security)) merged.security = securities[0];
  return merged;
}

/**
 * 新建落地入站。「新建节点」和「一键创建落地 SS 入站」（转发规则的出口）都走这一条：
 * 权限、额度、端口冲突、凭据生成一处都不少。landingEgress 只多打一个标记（派生节点默认不进订阅）。
 */
export async function createProxyInboundForActor(ctx: any, input: InboundInput, options: { landingEgress?: boolean } = {}) {
  await assertAllowed(ctx);
  const host = await assertUsableHost(input.hostId, ctx);
  assertTenantListenPortAllowed({ actor: ctx.user, host, port: input.port, label: "落地节点端口" });
  const ownerId = await resolveOwnerId(ctx, input.userId);

  await assertInboundQuota(ownerId, ctx);

  const conflict = await db.findProxyInboundPortConflict(input.hostId, input.port);
  if (conflict) throw new Error(`该主机的 ${input.port} 端口已被落地节点「${conflict.name}」占用`);
  await assertInboundPortAllowed(ctx, host, input.port);

  const inbound = fillGeneratedCredentials(mergeInbound(createEmptyProxyInbound(), input));
  const reason = validateProxyInbound(inbound);
  if (reason) throw new Error(reason);
  assertInboundCertPathsAllowed(ctx, host, inbound);
  const routing = input.routing ? await validateInboundRoutingForSave(input.routing, { ownerId, hostId: input.hostId }) : null;

  const id = await db.createProxyInbound({
    userId: ownerId,
    hostId: input.hostId,
    name: input.name,
    remark: input.remark || null,
    publicLabel: input.publicLabel || null,
    isEnabled: input.isEnabled ?? true,
    hostGrantRequired: inboundNeedsHostGrant(ctx, host),
    landingEgress: options.landingEgress === true,
    routingJson: serializeInboundRouting(routing),
    ...inboundQuotaRow(input, ctx.user.role === "admin"),
    ...db.proxyInboundToRow(inbound),
  } as any);
  await db.replaceProxyInboundUsers(Number(id), inbound.users);
  await applyInbound(Number(id), input.hostId);
  return { id };
}

export const proxyInboundsRouter = router({
  /** 这个协议能选哪些传输与安全层，以及有没有默认值。UI 用它收窄下拉。 */
  options: protectedProcedure.query(async () => ({
    protocols: PROXY_INBOUND_PROTOCOLS.map((protocol) => ({
      protocol,
      transports: proxyInboundTransports(protocol),
      securities: proxyInboundSecurities(protocol),
      multiUser: proxyInboundSupportsMultiUser(protocol),
    })),
    snellVersions: [...PROXY_INBOUND_SNELL_VERSIONS],
    defaultRealityServerName: DEFAULT_REALITY_SERVER_NAME,
    shadowsocksMethods: [...PROXY_INBOUND_SHADOWSOCKS_METHODS],
    defaultShadowsocksMethod: PROXY_INBOUND_SHADOWSOCKS_DEFAULT_METHOD,
  })),

  list: protectedProcedure.query(async ({ ctx }) => {
    if (ctx.user.role !== "admin") {
      const user = await db.getUserById(ctx.user.id);
      if (!user?.allowProxySubscription) return [];
    }
    // 管理员看全量：分租场景里要能看到一台机器上所有端口分给了谁。
    const rows = ctx.user.role === "admin"
      ? await db.getAllProxyInbounds()
      : await db.getProxyInboundsByUser(ctx.user.id);
    // 派生节点的订阅状态一次查完 —— 那个开关的入口在「新建节点」这一段。
    const derived = await db.getProxyInboundDerivedNodes(rows.map((row: any) => Number(row.id)));
    // 这些派生节点各自分享给了几个人。行上要标出来，否则「分享给谁」只有
    // 用户编辑页看得到，管理员在节点这边看不出这个端口已经租出去了。
    const shareUserIds = await db.getProxyNodeShareUserIds(
      Array.from(derived.values()).flatMap((entry: any) => entry.ids as number[]),
    );
    // 用户清单一次查完：一行一次的话，管理员那边五十个端口就是五十次往返。
    const usersByInbound = await db.getProxyInboundUsersByInbounds(rows.map((row: any) => Number(row.id)));
    // 带分流的入站：每条分流现在实际去了哪（自动挑的那台、或者为什么拒绝 / 直连）。
    const routingStatus = await describeInboundRoutingStatus(rows as any[]).catch(() => new Map());
    /*
      这些端口所在机器的机房额度。

      端口自己的用量（trafficUsed）只数面板经手的这一个端口，而机房是按整台机器的
      网卡算的 —— 两个数不是一回事，界面上要能同时给出来，否则人拿端口那个数去对
      机房账单，永远对不上还以为面板算错了。

      按用到的机器查，不整表读；一次查完而不是一行一次。
      hosts 里已经有 trafficLimit / trafficMeasureMode 了（主机管理那边一直在用），
      这里只是把它和计数表凑到一起送出去。
    */
    const hostIds: number[] = Array.from(
      new Set<number>(rows.map((row: any) => Number(row.hostId))),
    ).filter((id) => id > 0);
    const [hostRows, hostTraffic] = hostIds.length > 0
      ? await Promise.all([db.getHostsByIds(hostIds), db.getHostTrafficSummary(hostIds)])
      : [[], []];
    const hostById = new Map((hostRows as any[]).map((host: any) => [Number(host.id), host]));
    const trafficByHost = new Map((hostTraffic as any[]).map((row: any) => [Number(row.hostId), row]));
    const hostQuotaOf = (hostId: number) => {
      const host = hostById.get(Number(hostId));
      if (!host) return null;
      const counter = trafficByHost.get(Number(hostId));
      return {
        name: String(host.name || ""),
        trafficLimit: Math.max(0, Number(host.trafficLimit) || 0),
        measureMode: String(host.trafficMeasureMode || "both"),
        // 计数原样送出去，口径换算交给 shared/hostTrafficQuota —— 服务端算一遍、
        // 客户端再算一遍的话，两边迟早对不上。
        bytesIn: Math.max(0, Number(counter?.bytesIn) || 0),
        bytesOut: Math.max(0, Number(counter?.bytesOut) || 0),
        // 没有计数行 = Agent 还没报过。「还没有数」和「用了 0」在界面上是两回事。
        reported: !!counter,
      };
    };
    return rows.map((row: any) => ({
      ...row,
      // 私钥不出接口：前端没有任何用得上它的地方，多送一次就多一条泄漏路径。
      realityPrivateKey: undefined,
      // 同理用户凭据也不出去，只给 id 和名字，够界面显示和编辑了。
      // sharedUserId 要出去：界面据此把「为分享自动发的凭据」标成只读 —— 在这个
      // 弹窗里删掉它并不会取消分享，只会让对方莫名其妙连不上。
      users: (usersByInbound.get(Number(row.id)) || []).map((user) => ({
        id: user.id,
        name: user.name,
        sharedUserId: Number(user.sharedUserId || 0),
      })),
      derivedNodeIds: derived.get(Number(row.id))?.ids || [],
      derivedNodes: derived.get(Number(row.id))?.nodes || [],
      includeDirect: derived.get(Number(row.id))?.includeDirect ?? false,
      sharedUserCount: new Set(
        (derived.get(Number(row.id))?.ids || []).flatMap((id: number) => shareUserIds.get(Number(id)) || []),
      ).size,
      hostQuota: hostQuotaOf(Number(row.hostId)),
      routingJson: undefined,
      routing: parseInboundRouting(row.routingJson),
      routingStatus: routingStatus.get(Number(row.id)) || [],
    }));
  }),

  /**
   * 这个自建节点的分享链接，一个用户一条。
   *
   * 单独一个查询而不是塞进 list：链接里带着完整凭据，而 list 是每次进页面都会拉、
   * 还在轮询的。凭据只在用户主动要的时候才发出去，少一条泄漏路径。
   */
  links: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      await assertAllowed(ctx);
      const row = await assertOwnedInbound(input.id, ctx);
      const inbound = await db.loadProxyInbound(input.id);
      if (!inbound) throw new Error("落地节点不存在");

      const address = await db.getProxyInboundAddress(Number((row as any).hostId));
      if (!address) {
        // 主机还没有可用地址时，链接里的 host 会是空的 —— 给不出能用的链接，
        // 不如直说，免得用户复制走一条连不上的。
        throw new Error("这台主机还没有可用地址，生成不出能连的链接");
      }

      return proxyNodesFromInbound(inbound, { address }).map(({ user, node }) => ({
        userId: Number(user?.id || 0),
        userName: String(user?.name || ""),
        name: node.name,
        link: formatProxyNodeLink(node),
      }));
    }),

  create: protectedProcedure
    .input(inboundInput)
    .mutation(async ({ ctx, input }) => createProxyInboundForActor(ctx, input)),

  /**
   * 转发规则编辑器「出口」那一段的落地主机清单：每台能用的主机、上面能当出口的 Shadowsocks 入站。
   * 不要求客户端订阅权限 —— 用管理员开放的落地出口不需要能看订阅。
   */
  egressLandingOptions: protectedProcedure.query(async ({ ctx }) => listEgressLandingOptions(ctx.user)),

  /** 节点编辑器「分流」那一段：能走的 Shadowsocks 落地，带各服务最新的解锁检测结论。 */
  routingLandingOptions: protectedProcedure.query(async ({ ctx }) => {
    await assertAllowed(ctx);
    return listRoutingLandingOptions(ctx.user);
  }),

  /**
   * 落地选择器（规则编辑器的「出口」和节点编辑器的「分流」共用）：按主机分组的 Shadowsocks 落地入站，
   * 带方法、启停、能不能做出口、所在主机最新一次解锁检测各服务的结论。
   * 权限同 egressLandingOptions（不要求客户端订阅权限）。
   */
  landingOptions: protectedProcedure.query(async ({ ctx }) => listLandingOptions(ctx.user)),

  /**
   * 规则编辑器问：这几台入口机现在能不能让 UDP 走出口、能不能用 SS2022 出口（看 Agent 上报的能力）。
   * 只回能力和给人看的原因；看不到的主机不回名字。保存时服务端还会再按同一套规则查一遍。
   */
  egressEntryCapabilities: protectedProcedure
    .input(z.object({ hostIds: z.array(z.number().int().positive()).max(64) }))
    .query(async ({ ctx, input }) => listEgressEntryCapabilities(ctx.user, input.hostIds)),

  /**
   * 一键创建落地 SS 入站：在落地主机上开一个 Shadowsocks（aes-256-gcm：经典 AEAD 在所有入口机上都能用，
   * SS2022 要入口机的运行时 nex3 起，见 shared/ssEgress.ts）入站，随机密码、端口从这台主机的端口范围里挑。走的就是上面 create 那条路（权限、
   * 额度、端口冲突全照旧），只是打上 landingEgress 标记：派生节点默认不进订阅。
   */
  createLandingEgress: protectedProcedure
    .input(z.object({ hostId: z.number().int().positive(), name: z.string().trim().min(1).max(64).optional() }))
    .mutation(async ({ ctx, input }) => {
      const host = await db.getHostById(input.hostId);
      if (!host) throw new Error("主机不存在");
      if (ctx.user.role !== "admin" && Number(host.userId) !== Number(ctx.user.id)) {
        throw new Error("只有管理员或主机的主人能在这台主机上一键创建落地入站");
      }
      const port = await pickLandingEgressPort(input.hostId);
      const created = await createProxyInboundForActor(ctx, {
        hostId: input.hostId,
        name: input.name || LANDING_EGRESS_INBOUND_DEFAULTS.name,
        protocol: LANDING_EGRESS_INBOUND_DEFAULTS.protocol,
        method: LANDING_EGRESS_INBOUND_DEFAULTS.method,
        security: "none",
        transport: "tcp",
        port,
        remark: "转发规则的 Shadowsocks 出口",
      } as InboundInput, { landingEgress: true });
      return { id: Number(created.id), port, method: LANDING_EGRESS_INBOUND_DEFAULTS.method, hostId: input.hostId };
    }),

  update: protectedProcedure
    .input(inboundInput.partial().extend({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await assertAllowed(ctx);
      const row = await assertOwnedInbound(input.id, ctx);
      const hostId = input.hostId ?? Number(row.hostId);
      const hostChanged = hostId !== Number(row.hostId);
      /*
        换主机、或者这个入站本来就是靠主机授权开的，每次保存都重新确认还能用这台机器 ——
        以前只在传了 hostId 时才查，授权收回之后照样能改。管理员替租户开的（分租）不靠主机授权，
        不在这里拦，否则租户连改个名字都改不了。
      */
      const host = hostChanged || dbBool((row as any).hostGrantRequired)
        ? await assertUsableHost(hostId, ctx)
        : await db.getHostById(hostId);
      if (!host) throw new Error("主机不存在");

      const port = input.port ?? Number(row.port);
      if (port !== Number(row.port) || hostId !== Number(row.hostId)) {
        assertTenantListenPortAllowed({ actor: ctx.user, host: await db.getHostById(hostId), port, label: "落地节点端口" });
      }
      const conflict = await db.findProxyInboundPortConflict(hostId, port, input.id);
      if (conflict) throw new Error(`该主机的 ${port} 端口已被落地节点「${conflict.name}」占用`);
      // 端口没动、也不是重新启用时不查：已经在跑的老入站改个名字不该被卡住。
      if (hostChanged || port !== Number(row.port) || (input.isEnabled === true && !dbBool((row as any).isEnabled, true))) {
        await assertInboundPortAllowed(ctx, host, port, input.id);
      }

      // 正被转发规则当作 Shadowsocks 出口的入站：换协议 / 换成出口不支持的方法 / 换主机都会让那些规则失效，先拦下。
      await assertProxyInboundEgressCompatibleChange(input.id, { protocol: input.protocol, method: input.method, hostId: input.hostId }, Number(row.hostId));
      const loaded = await db.loadProxyInbound(input.id);
      if (!loaded) throw new Error("落地节点不存在");
      const merged = mergeInbound(loaded, input);
      /**
       * 换了协议或安全层就重新生成凭据。
       *
       * 沿用旧凭据看着更"省事"，实际是错的：REALITY 的密钥对与 TLS 证书不通用，
       * Shadowsocks 换加密方式后密码长度要求也变了 —— 留着旧值只会得到一份
       * sing-box 拒绝加载的配置。
       */
      const changedShape = (input.protocol !== undefined && input.protocol !== row.protocol)
        || (input.security !== undefined && input.security !== row.security)
        || (input.method !== undefined && input.method !== row.method);
      const reset = changedShape
        ? { ...merged, uuid: "", password: "", realityPrivateKey: "", realityPublicKey: "", realityShortId: "" }
        : merged;
      const inbound = fillGeneratedCredentials(reset);

      const reason = validateProxyInbound(inbound);
      if (reason) throw new Error(reason);
      if (
        hostChanged
        || inbound.security !== String(row.security || "")
        || inbound.certPath !== String((row as any).certPath || "")
        || inbound.keyPath !== String((row as any).keyPath || "")
      ) {
        assertInboundCertPathsAllowed(ctx, host, inbound);
      }

      /**
       * 换归属时派生节点会跟着换主人（syncProxyNodeFromInbound 按入站行的 userId
       * 写），所以旧主人的订阅里那条会消失、新主人的订阅里出现 —— 这是预期行为，
       * 但要提醒：旧主人已经导入的客户端会失去这个节点。
       */
      const ownerId = input.userId !== undefined
        ? await resolveOwnerId(ctx, input.userId)
        : Number(row.userId);
      /**
       * 换归属时也要看新主人的额度，否则「建不了就先建给自己再转过去」能绕开上限。
       * 没换归属时不查：那会让一个已经超额的用户连改名字都改不了。
       */
      if (ownerId !== Number(row.userId)) await assertInboundQuota(ownerId, ctx);
      /*
        分流没动就不重新校验：表单每次都会原样回传，面板克隆给租户的专属端口带着源入站的分流
        （点名的是管理员的落地），租户改个名字不该因为「你用不了那台落地」被拦住。
      */
      const routingChanged = input.routing !== undefined
        && serializeInboundRouting(parseInboundRouting(input.routing)) !== ((row as any).routingJson ? String((row as any).routingJson) : null);
      const routing = routingChanged
        ? await validateInboundRoutingForSave(input.routing, { ownerId, hostId })
        : undefined;
      if (routing) await assertInboundRoutingNotDoubleLanding(input.id, serializeInboundRouting(routing));

      await db.updateProxyInbound(input.id, {
        hostId,
        userId: ownerId,
        // 换了机器或者管理员改了归属，按这一次重新定；否则沿用。
        ...(hostChanged || ownerId !== Number(row.userId) ? { hostGrantRequired: inboundNeedsHostGrant(ctx, host) } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.remark !== undefined ? { remark: input.remark || null } : {}),
        ...(input.publicLabel !== undefined ? { publicLabel: input.publicLabel || null } : {}),
        ...(input.isEnabled !== undefined ? { isEnabled: input.isEnabled } : {}),
        ...(routing !== undefined ? { routingJson: serializeInboundRouting(routing) } : {}),
        ...inboundQuotaRow(input, ctx.user.role === "admin"),
        ...db.proxyInboundToRow(inbound),
      } as any);
      await db.replaceProxyInboundUsers(input.id, inbound.users);
      await applyInbound(input.id, hostId);
      // 端口、密码、启停变了：拿它当出口的规则所在的入口机马上重算 gost 配置。
      await refreshEgressDependents(input.id, `proxy-inbound-egress-${input.id}`);
      // 别的落地分流时点名走它的，也马上换上新的端口 / 密码。
      await refreshInboundRoutingDependents(input.id, `proxy-inbound-routing-${input.id}`);
      // 换过主机时旧主机也要重推一遍，否则那边的配置里还留着这个入站。
      if (input.hostId !== undefined && Number(row.hostId) !== hostId) {
        pushAgentRefresh(Number(row.hostId), `proxy-inbound-moved-${input.id}`, { urgent: true });
      }
      return { success: true };
    }),

  /** 重新生成凭据。用于疑似泄漏时换掉，而不必删了重建。 */
  rotate: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await assertAllowed(ctx);
      const row = await assertOwnedInbound(input.id, ctx);
      const current = await db.loadProxyInbound(input.id);
      if (!current) throw new Error("落地节点不存在");
      const inbound = fillGeneratedCredentials({
        ...current,
        uuid: "",
        password: "",
        // 每个用户的凭据都换掉，但保留 id 与名字 —— 派生节点要靠 id 对齐，
        // 换 id 会让订阅里的节点被删掉重建，转发规则上的绑定跟着丢。
        users: current.users.map((user) => ({ ...user, uuid: "", password: "" })),
        realityPrivateKey: "",
        realityPublicKey: "",
        realityShortId: "",
      });
      await db.updateProxyInbound(input.id, db.proxyInboundToRow(inbound) as any);
      await db.replaceProxyInboundUsers(input.id, inbound.users);
      await applyInbound(input.id, Number(row.hostId));
      // 拿它当 Shadowsocks 出口的规则：下发时从入站现取凭据，这里催入口机马上换上新密码。
      await refreshEgressDependents(input.id, `proxy-inbound-rotated-${input.id}`);
      await refreshInboundRoutingDependents(input.id, `proxy-inbound-routing-rotated-${input.id}`);
      // 换了凭据，旧订阅立刻失效 —— 这是预期行为，界面上要讲清楚。
      return { success: true };
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await assertAllowed(ctx);
      const row = await assertOwnedInbound(input.id, ctx);
      // 还有转发规则拿它当 Shadowsocks 出口：删了那些规则会断，先让人把规则改掉（报错里列出规则）。
      await assertProxyInboundNotUsedAsEgress(input.id);
      // 别的落地分流时点名走它：删了那部分流量就只能拒绝，先让人把分流改掉。
      const routingVia = await getInboundsRoutingVia(input.id);
      if (routingVia.length > 0) {
        const names = routingVia.slice(0, 5).map((item: any) => `「${item.name}」`).join("、");
        throw new Error(`落地节点${names}${routingVia.length > 5 ? ` 等 ${routingVia.length} 个` : ""}的分流在用它，先去改掉那边的分流再删`);
      }
      const result = await db.deleteProxyInbound(input.id);
      invalidateInboundRoutingContext();
      pushAgentRefresh(Number(row.hostId), `proxy-inbound-deleted-${input.id}`, { urgent: true });
      return { success: true, ...result };
    }),
});
