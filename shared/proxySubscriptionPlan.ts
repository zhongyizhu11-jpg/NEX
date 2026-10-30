/**
 * 把「转发规则 + 节点模板 + 入口主机」组装成订阅里的节点列表。
 *
 * 放在 shared 是为了让面板能预览出和服务端完全一致的结果：用户在界面上看到的
 * 「这些节点会进订阅」必须就是客户端真正拉到的那一份，否则排查问题时无从对账。
 *
 * 这里只做纯计算，不碰数据库；调用方负责把行取出来传进来。
 */

import { getHostEntryAddress, getHostEntryAddresses, hostAutoIpv4, hostAutoIpv6, hostNeverConnected, type HostEntryAddressSource } from "./hostEntryAddress";
import { compileProxySubGroupFilter, type ProxySubGroupMatch } from "./proxySubGroupFilter";
import { publishedRuleEntryDomain } from "./ruleEntryDomain";
import { expandWeightedMembers, hostBandwidthHintMbps, PROXY_LOAD_BALANCE_MAX_WEIGHT, proxyLoadBalanceWeights } from "./linkWeights";
import { proxyNodeBindingTruth } from "./proxyNodeAutoBind";
import { proxySubRegionLabel } from "./proxySubRegion";
import { buildProxySubUnlockGroups, type ProxySubUnlockStatusMap } from "./proxySubUnlock";
import {
  buildProxyRulePlan,
  normalizeProxyRulePreset,
  proxyRuleCategoriesForPreset,
  type ProxyRouteRule,
  type ProxyRuleSetRef,
  type ProxyRulePreset,
} from "./proxyRuleset";
import {
  createEmptyProxyNode,
  proxyNodeAlwaysTls,
  proxyNodeRequiresUdp,
  PROXY_NODE_PROTOCOLS,
  PROXY_NODE_TRANSPORTS,
  relayProxyNode,
  type ProxyNode,
  type ProxyNodeProtocol,
  type ProxyNodeTransport,
  normalizeCertSha256,
} from "./proxyNode";

/** proxy_nodes 表的一行，字段名与数据库一致。 */
export type ProxyNodeTemplateRow = {
  id: number;
  /**
   * 自建节点所在的那台机器。粘来的、别人分享的没有这一项 —— 那些机器不在这个面板里，
   * 面板对它们的状态无话可说。
   */
  hostId?: unknown;
  /** 是否把这个节点自己的地址也作为一个节点放进订阅。 */
  includeDirect?: unknown;
  /** 前置代理：连接先经由哪个节点建立（同表另一行的 id）。 */
  frontProxyId?: unknown;
  name?: unknown;
  protocol?: unknown;
  address?: unknown;
  port?: unknown;
  uuid?: unknown;
  password?: unknown;
  method?: unknown;
  alterId?: unknown;
  flow?: unknown;
  transport?: unknown;
  path?: unknown;
  host?: unknown;
  tls?: unknown;
  sni?: unknown;
  alpn?: unknown;
  fingerprint?: unknown;
  certSha256?: unknown;
  allowInsecure?: unknown;
  realityPublicKey?: unknown;
  realityShortId?: unknown;
  udp?: unknown;
  obfs?: unknown;
  obfsPassword?: unknown;
  upMbps?: unknown;
  downMbps?: unknown;
  congestionControl?: unknown;
  udpRelayMode?: unknown;
  disableSni?: unknown;
  snellVersion?: unknown;
  snellMode?: unknown;
  xhttpMode?: unknown;
  isEnabled?: unknown;
  autoGroup?: unknown;
  /** 手工填的地区（国家码）；空则看落地机器的 geo，再猜名字。 */
  countryCode?: unknown;
};

/** forward_rules 表里订阅需要用到的字段。 */
export type ProxySubscriptionRuleRow = {
  id: number;
  hostId?: unknown;
  name?: unknown;
  sourcePort?: unknown;
  /** 转发放行的协议：tcp | udp | both */
  protocol?: unknown;
  proxyNodeId?: unknown;
  proxyNodeVisible?: unknown;
  proxyNodeName?: unknown;
  isEnabled?: unknown;
  pendingDelete?: unknown;
  /**
   * 转发的目标。用来核对「绑定还算不算真的」—— 调用方没查这两列时不做判断。
   */
  targetIp?: unknown;
  targetPort?: unknown;
  /** 规则专属域名（规则上的开关、发布出去的域名和记录值），见 shared/ruleEntryDomain.ts。 */
  entryDomainEnabled?: unknown;
  entryDomain?: unknown;
  entryDomainValue?: unknown;
  /**
   * 转发组 / 转发链 / 线路组由面板拆出来的内部规则：forwardGroupRuleId 指向用户建的
   * 那条主规则，routeParentRuleId 指向线路组的父规则。调用方没查这几列时不做判断。
   */
  forwardGroupRuleId?: unknown;
  isForwardGroupTemplate?: unknown;
  routeParentRuleId?: unknown;
};

export type ProxySubscriptionHostRow = HostEntryAddressSource & {
  id: number;
  /** 线路带宽 / 主机总限速 / 出口整形带宽（Mbps）：「负载均衡」组按它给这台前置多分连接。都没有时按主机名里的带宽。 */
  lineBandwidthMbps?: unknown;
  rateLimitMbps?: unknown;
  egressMbps?: unknown;
  /** 最后一次心跳。从来没有 = Agent 还没装上，见 hostNeverConnected。 */
  lastHeartbeat?: unknown;
  name?: unknown;
  /** 面板查到的机器所在国家码（hosts.geoCountryCode）；落地机器的给节点当地区。 */
  geoCountryCode?: unknown;
};

/** 一条转发没能进订阅的原因，用于在界面上解释而不是让节点无声消失。 */
export type ProxySubscriptionSkipReason =
  | "unbound"
  | "hidden"
  | "template-disabled"
  | "rule-disabled"
  | "no-entry-address"
  | "udp-not-forwarded"
  | "unreachable";

export const PROXY_SUBSCRIPTION_SKIP_LABELS: Record<ProxySubscriptionSkipReason, string> = {
  unbound: "未绑定客户端节点",
  hidden: "已在订阅中隐藏",
  "template-disabled": "所属节点模板已停用",
  "rule-disabled": "转发已停用",
  "no-entry-address": "入口主机没有可用地址",
  "udp-not-forwarded": "节点走 QUIC（只用 UDP），但这条转发没放行 UDP",
  unreachable: "最近几次端到端探测都不通，暂时移出订阅（通了自动回来）",
};

export type ProxySubscriptionEntry = {
  /** 直连节点不来自任何转发规则，这里是 0。 */
  ruleId: number;
  templateId: number;
  /** relay：经转发入口改写过的；direct：落地机自己的地址，未改写。 */
  kind: "relay" | "direct";
  /**
   * 前置代理模板的 id，0 表示没有。
   *
   * 这里刻意存 id 而不是名字：节点名要到 buildProxySubscriptionDocument 里去重之后
   * 才最终确定，提前写死名字的话，一旦去重给前置节点加了序号，引用就指向一个不
   * 存在的名字 —— Clash 会拒绝整份配置，报的还是「订阅导入失败」这种毫无线索的错。
   */
  frontTemplateId: number;
  /** 绑定已经对不上了（见 warnings）。仍然发出去，但界面上要标出来。 */
  targetMismatch?: boolean;
  /** 转发入口那台机器的带宽（Mbps，见 hostBandwidthHintMbps）。0 / 没有 = 不知道。 */
  bandwidthMbps?: number;
  /** 命名、地区、排序要用的元信息（shared/proxySubProcessors.ts）。老调用方可能不填。 */
  meta?: ProxySubEntryMeta;
  node: ProxyNode;
};

/** 和 shared/proxySubProcessors.ts 里的同名类型一致；放这儿是为了不让两个文件互相 import。 */
export type ProxySubEntryMeta = {
  hostName: string;
  templateName: string;
  ruleName: string;
  customName: boolean;
  regionCode: string;
  latencyMs?: number | null;
  /** 出口主机 id（直连 = 节点所在机器，中转 = 落地所在机器）；没有机器时 null。 */
  exitHostId?: number | null;
};

export type ProxySubscriptionSkip = {
  ruleId: number;
  ruleName: string;
  reason: ProxySubscriptionSkipReason;
};

/**
 * 「这条还在订阅里，但有件事你得知道」。
 *
 * 和 skipped 分开：那边是**没发出去**的，这边是**发出去了但可能不是你以为的那样**。
 * 刻意不做成 skip —— 静默少一条节点正是这套面板反复踩过的坑，而这类判断又不可能
 * 百分之百准（见 proxyNodeBindingTruth），所以宁可发出去 + 明确告警，让人自己判。
 */
export type ProxySubscriptionWarningReason = "target-mismatch" | "node-unused" | "host-never-online";

export const PROXY_SUBSCRIPTION_WARNING_LABELS: Record<ProxySubscriptionWarningReason, string> = {
  "target-mismatch": "这条转发的目标已经不是它绑的那个节点了",
  "node-unused": "这个节点没进任何一份订阅",
  // 从没连上过 ≠ 掉线。掉线归节点行上那个状态点管，这里说的是「Agent 还没装」。
  "host-never-online": "这台机器的 Agent 还没连上过，配置下发不下去",
};

export type ProxySubscriptionWarning = {
  /** target-mismatch 是某条转发的问题；node-unused 跟转发无关，这里是 0。 */
  ruleId: number;
  ruleName: string;
  reason: ProxySubscriptionWarningReason;
  /** 这条转发现在指向哪里。node-unused 时为空。 */
  targetText: string;
  nodeId: number;
  nodeName: string;
  /** 节点自己的地址端口。 */
  nodeText: string;
};

export type ProxySubscriptionPlan = {
  entries: ProxySubscriptionEntry[];
  skipped: ProxySubscriptionSkip[];
  /** 老调用方可能不读这个字段，所以给默认空数组而不是可选。 */
  warnings: ProxySubscriptionWarning[];
};

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function bool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const raw = text(value).toLowerCase();
  return raw === "1" || raw === "true";
}

function toPort(value: unknown): number {
  const port = Number(text(value));
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
}

const PROTOCOLS = new Set<ProxyNodeProtocol>(PROXY_NODE_PROTOCOLS);
const TRANSPORTS = new Set<ProxyNodeTransport>(PROXY_NODE_TRANSPORTS);

/** 把数据库行还原成节点模型。列都是宽松类型，这里统一收敛。 */
export function proxyNodeFromTemplateRow(row: ProxyNodeTemplateRow): ProxyNode {
  const node = createEmptyProxyNode();
  const protocol = text(row.protocol).toLowerCase() as ProxyNodeProtocol;
  node.protocol = PROTOCOLS.has(protocol) ? protocol : "vless";
  node.name = text(row.name);
  node.address = text(row.address);
  node.port = toPort(row.port);
  node.uuid = text(row.uuid);
  node.password = text(row.password);
  node.method = text(row.method);
  node.alterId = Number(text(row.alterId)) || 0;
  node.flow = text(row.flow);
  const transport = text(row.transport).toLowerCase() as ProxyNodeTransport;
  node.transport = TRANSPORTS.has(transport) ? transport : "tcp";
  node.path = text(row.path);
  node.host = text(row.host);
  node.tls = bool(row.tls);
  node.sni = text(row.sni);
  node.alpn = text(row.alpn).split(",").map((item) => item.trim()).filter(Boolean);
  node.fingerprint = text(row.fingerprint);
  node.certSha256 = normalizeCertSha256(row.certSha256);
  node.allowInsecure = bool(row.allowInsecure);
  node.realityPublicKey = text(row.realityPublicKey);
  node.realityShortId = text(row.realityShortId);
  node.udp = row.udp === undefined ? true : bool(row.udp);
  node.obfs = text(row.obfs).toLowerCase();
  node.obfsPassword = text(row.obfsPassword);
  node.upMbps = Math.max(0, Math.floor(Number(text(row.upMbps)) || 0));
  node.downMbps = Math.max(0, Math.floor(Number(text(row.downMbps)) || 0));
  node.congestionControl = text(row.congestionControl);
  node.udpRelayMode = text(row.udpRelayMode);
  node.disableSni = bool(row.disableSni);
  node.snellVersion = Number(text(row.snellVersion)) || 0;
  node.snellMode = text(row.snellMode);
  node.xhttpMode = text(row.xhttpMode);
  // Hysteria2 / TUIC / AnyTLS 的 TLS 是协议自带的，老行里 tls 列可能是 0。
  if (proxyNodeAlwaysTls(node.protocol)) node.tls = true;
  return node;
}

/** 模板的地区：手工填的国家码 → 落地机器的 geo → 空。 */
function templateRegionCode(template: ProxyNodeTemplateRow, hostsById: Map<number, ProxySubscriptionHostRow>): string {
  const manual = text(template.countryCode).toUpperCase();
  if (/^[A-Z]{2}$/.test(manual)) return manual;
  const host = hostsById.get(Number(template.hostId || 0));
  const geo = text(host?.geoCountryCode).toUpperCase();
  return /^[A-Z]{2}$/.test(geo) ? geo : "";
}

/** 节点流量出去的那台机器：自建节点所在的主机；粘来的 / 分享的没有。 */
function templateExitHostId(template: ProxyNodeTemplateRow): number | null {
  const hostId = Number(template.hostId || 0);
  return Number.isInteger(hostId) && hostId > 0 ? hostId : null;
}

/** 订阅里显示的节点名：优先用户自定义，否则「入口主机 → 模板名」。 */
export function defaultProxySubscriptionNodeName(options: {
  hostName: string;
  templateName: string;
  ruleName: string;
}): string {
  const host = text(options.hostName);
  const template = text(options.templateName);
  if (host && template) return `${host} → ${template}`;
  return template || host || text(options.ruleName) || "节点";
}

export type BuildProxySubscriptionPlanInput = {
  rules: readonly ProxySubscriptionRuleRow[];
  templates: readonly ProxyNodeTemplateRow[];
  hosts: readonly ProxySubscriptionHostRow[];
  /**
   * 当前生效的规则专属域名后缀（DNS 服务商可用且设置了后缀时才非空）。
   * 规则的域名发布成功过、且正是按这个后缀算出来的那个，节点地址就用域名。
   */
  ruleEntryDomainSuffix?: string;
  /**
   * 端到端探测一直不通的转发（见 isRuleProbeUnreachable）。开了「自动隐藏不通的节点」
   * 才会传：客户端测延迟只测到入口，后面断了照样显示几十毫秒，负载均衡组还会把连接
   * 分给它。暂时不放进订阅，探测通了就回来。
   */
  unreachableRuleIds?: ReadonlySet<number>;
  /** 每条转发最近一次探测的延迟（毫秒，null = 不通）。「按延迟排序」用。 */
  latencyByRuleId?: ReadonlyMap<number, number | null>;
};

/**
 * 生成订阅节点列表。
 *
 * 停用的转发会被排除：它此刻并不监听，放进订阅只会给客户端一个连不上的节点。
 * 但不看 isRunning，因为那是瞬时状态，据此增删会让订阅内容来回抖动。
 */
export function buildProxySubscriptionPlan(input: BuildProxySubscriptionPlanInput): ProxySubscriptionPlan {
  const templatesById = new Map<number, ProxyNodeTemplateRow>();
  for (const template of input.templates) templatesById.set(Number(template.id), template);
  const hostsById = new Map<number, ProxySubscriptionHostRow>();
  for (const host of input.hosts) hostsById.set(Number(host.id), host);

  const entries: ProxySubscriptionEntry[] = [];
  const skipped: ProxySubscriptionSkip[] = [];
  const warnings: ProxySubscriptionWarning[] = [];

  /**
   * 这个用户自己的转发入口都有哪些 `地址:端口`。
   *
   * 用来认出「串起来的两跳」：第一条转发的目标是第二条转发的入口，而绑定挂在第一条
   * 上。这种拓扑下目标当然不等于节点地址，却是正常的 —— 不认出来就会对着一条好线路
   * 报警。数据本来就都在手上，顺手算一遍。
   */
  // IPv6 字面量在转发那边可能带方括号、主机那边不一定带，两侧都去掉再比。
  const entryKey = (address: unknown, port: unknown) =>
    `${text(address).toLowerCase().replace(/^\[/, "").replace(/\]$/, "")}:${toPort(port)}`;
  const ownForwardEntries = new Set<string>();
  for (const rule of input.rules) {
    if (bool(rule.pendingDelete)) continue;
    const host = hostsById.get(Number(rule.hostId || 0));
    const port = toPort(rule.sourcePort);
    /*
      这台机器**所有**叫得出的地址都算入口，不只是订阅里用的那个首选地址。
      第一跳的目标是他自己手填的：机器配了入口域名或 DDNS 时，他照样可能写的是
      机器的 IP（或 IPv6）—— 只认首选地址就会把这条好好的串接报成「指向已经变了」。
    */
    if (port) {
      for (const entry of getHostEntryAddresses(host)) ownForwardEntries.add(entryKey(entry.value, port));
      for (const raw of [host?.ip, host?.ipv4, host?.ipv6, hostAutoIpv4(host), hostAutoIpv6(host)]) {
        if (text(raw)) ownForwardEntries.add(entryKey(raw, port));
      }
    }
    // 第一跳的目标可能写的是第二跳的专属域名，同样算自己的入口。
    const domain = publishedRuleEntryDomain(rule, input.ruleEntryDomainSuffix);
    if (domain && port) ownForwardEntries.add(entryKey(domain, port));
  }

  /**
   * 落地机自己的直连地址。
   *
   * 模板本来就是一个完整节点（地址、端口、凭据都全），只是平时只拿它的凭据、
   * 把地址端口换成转发入口。开了这个开关就再原样产出一条 —— 凭据仍然只有模板
   * 这一份，不存在两处要同步的问题。
   *
   * templateId 跟规则派生的那些一致，所以直连会自动进同一个选路组：客户端可以
   * 自己在「直连落地」和「走中转」之间挑快的。
   *
   * 排在最前面：它是这个落地的本体，其余都是它的中转变体。
   */
  /**
   * 被当作前置代理引用的模板，无论有没有开「直连也放进订阅」，都必须出现在订阅里。
   *
   * 否则渲染出的 dialer-proxy / detour 会指向一个不存在的节点 —— Clash 遇到这种
   * 引用会拒绝整份配置，用户看到的是「订阅导入失败」，跟前置代理毫无字面关联。
   * 这和之前空分组时 MATCH 指向不存在策略组是同一类问题。
   */
  const referencedAsFront = new Set<number>();
  for (const template of input.templates) {
    const frontId = Number(template.frontProxyId || 0);
    if (frontId) referencedAsFront.add(frontId);
  }

  const directEntries: ProxySubscriptionEntry[] = [];
  for (const template of input.templates) {
    const templateId = Number(template.id);
    if (!bool(template.includeDirect) && !referencedAsFront.has(templateId)) continue;
    if (template.isEnabled !== undefined && !bool(template.isEnabled)) continue;
    const node = proxyNodeFromTemplateRow(template);
    if (!node.address || !node.port) continue;
    directEntries.push({
      ruleId: 0,
      templateId,
      kind: "direct",
      frontTemplateId: 0,
      meta: { hostName: "", templateName: node.name, ruleName: "", customName: false, regionCode: templateRegionCode(template, hostsById), exitHostId: templateExitHostId(template) },
      node,
    });
  }

  /** 前置节点自己没能进订阅时就不挂引用 —— 宁可少一层，也不要一份坏配置。 */
  const emittedTemplateIds = new Set(directEntries.map((entry) => entry.templateId));
  const frontIdOf = (template: ProxyNodeTemplateRow): number => {
    const frontId = Number(template.frontProxyId || 0);
    return frontId && emittedTemplateIds.has(frontId) ? frontId : 0;
  };

  /**
   * 面板拆出来的内部规则（链的每一段、线路组的中转），它的主规则已经绑了节点时就不再
   * 单独出节点：主规则那条已经是这条线路的入口，内部段再出一条，订阅里就是同一个入口
   * 两个节点（名字后面带 #2），后面几段的还会绕开前面的机器直连中间那台。
   */
  const boundRuleIds = new Set<number>();
  for (const rule of input.rules) {
    if (Number(rule.proxyNodeId || 0) > 0 && !bool(rule.pendingDelete)) boundRuleIds.add(Number(rule.id));
  }
  const internalParentOf = (rule: ProxySubscriptionRuleRow) => {
    const routeParent = Number(rule.routeParentRuleId || 0);
    if (routeParent > 0) return routeParent;
    const groupTemplate = Number(rule.forwardGroupRuleId || 0);
    return groupTemplate > 0 && !bool(rule.isForwardGroupTemplate) ? groupTemplate : 0;
  };

  for (const rule of input.rules) {
    const ruleId = Number(rule.id);
    const ruleName = text(rule.name) || `规则 #${ruleId}`;
    const skip = (reason: ProxySubscriptionSkipReason) => skipped.push({ ruleId, ruleName, reason });

    if (bool(rule.pendingDelete)) continue;
    const parentRuleId = internalParentOf(rule);
    if (parentRuleId > 0 && boundRuleIds.has(parentRuleId)) continue;

    const templateId = Number(rule.proxyNodeId || 0);
    if (!templateId) {
      skip("unbound");
      continue;
    }
    if (rule.proxyNodeVisible !== undefined && !bool(rule.proxyNodeVisible)) {
      skip("hidden");
      continue;
    }
    if (rule.isEnabled !== undefined && !bool(rule.isEnabled)) {
      skip("rule-disabled");
      continue;
    }
    if (input.unreachableRuleIds?.has(ruleId)) {
      skip("unreachable");
      continue;
    }

    const template = templatesById.get(templateId);
    if (!template) {
      skip("unbound");
      continue;
    }
    if (template.isEnabled !== undefined && !bool(template.isEnabled)) {
      skip("template-disabled");
      continue;
    }

    /**
     * QUIC 系协议（Hysteria2 / TUIC）只跑 UDP。转发规则若只放行 TCP，这条链路
     * 从第一个握手包起就不通，而客户端那边只会显示一句超时 —— 跟「转发没放 UDP」
     * 毫无字面关联。与其把一个注定连不上的节点发出去，不如在这里排除并写明原因。
     *
     * 只在明确是 tcp 时排除：protocol 缺省（调用方没查这一列）时不做判断，
     * 宁可放行也不要凭猜测吞掉节点。
     */
    if (proxyNodeRequiresUdp(text(template.protocol).toLowerCase()) && text(rule.protocol).toLowerCase() === "tcp") {
      skip("udp-not-forwarded");
      continue;
    }

    const host = hostsById.get(Number(rule.hostId || 0));
    /*
      规则专属域名发布成功过就用域名：它跟着规则当前的入口走，规则换隧道、换入口机，
      客户端手里的地址都不用变。没发布成功过（功能没开、规则上关了开关、服务商报错）
      照旧用入口地址。
    */
    const address = publishedRuleEntryDomain(rule, input.ruleEntryDomainSuffix) || getHostEntryAddress(host);
    const port = toPort(rule.sourcePort);
    if (!address || !port) {
      skip("no-entry-address");
      continue;
    }

    const templateNode = proxyNodeFromTemplateRow(template);
    const name = text(rule.proxyNodeName) || defaultProxySubscriptionNodeName({
      hostName: text(host?.name),
      templateName: templateNode.name,
      ruleName,
    });

    /**
     * 绑定还算不算真的。
     *
     * 对不上时**照发**，只是标出来 —— 静默少一条节点是这套面板反复踩过的坑，而这类
     * 判断不可能百分之百准（串两跳、域名写法不同都会看起来像对不上）。但也不能不说：
     * 订阅里这条节点带的是这个落地的凭据，而地址写的是转发入口；入口通向别处时，
     * 客户端就会把这套凭据递给那台别的机器。
     */
    let targetMismatch = false;
    const targetText = `${text(rule.targetIp)}:${toPort(rule.targetPort) || "-"}`;
    const pointsAtOwnForwardEntry = ownForwardEntries.has(entryKey(rule.targetIp, rule.targetPort));
    if (!pointsAtOwnForwardEntry
      && proxyNodeBindingTruth(
        { targetIp: rule.targetIp, targetPort: rule.targetPort },
        { address: templateNode.address, port: templateNode.port },
      ) === "mismatch") {
      targetMismatch = true;
      warnings.push({
        ruleId,
        ruleName,
        reason: "target-mismatch",
        targetText,
        nodeId: templateId,
        nodeText: `${templateNode.address}:${templateNode.port}`,
        nodeName: templateNode.name || `节点 #${templateId}`,
      });
    }

    const bandwidthMbps = hostBandwidthHintMbps(host);
    entries.push({
      ruleId,
      templateId,
      kind: "relay",
      frontTemplateId: frontIdOf(template),
      ...(targetMismatch ? { targetMismatch: true } : {}),
      ...(bandwidthMbps > 0 ? { bandwidthMbps } : {}),
      meta: {
        hostName: text(host?.name),
        templateName: templateNode.name,
        ruleName,
        customName: !!text(rule.proxyNodeName),
        // 地区看落地（模板），不看入口：客户端里要认的是「出口在哪」。
        regionCode: templateRegionCode(template, hostsById),
        // 出口同样看落地：入口机只是转发，网站看到的是落地的 IP。
        exitHostId: templateExitHostId(template),
        ...(input.latencyByRuleId?.has(ruleId) ? { latencyMs: input.latencyByRuleId.get(ruleId) ?? null } : {}),
      },
      node: relayProxyNode(templateNode, { address, port, name }),
    });
  }

  // 直连条目自己也可能有前置（例如落地直连要经由线路机）。
  const directWithFront = directEntries.map((entry) => {
    const template = templatesById.get(entry.templateId);
    return { ...entry, frontTemplateId: template ? frontIdOf(template) : 0 };
  });

  /**
   * 一个节点也可能**谁都没用它**：没开直连，又没有任何转发绑到它上面。
   *
   * 这种节点在「我的节点」里看着好好的，客户端里却根本不存在 —— 和当初「转发不绑节点
   * 就不进订阅，而转发页上看不出」是同一个坑，只是从节点这一侧再犯一次。停用的不算：
   * 那是他自己关的，行上本来就写着停用。
   */
  /**
   * 发出去的自建节点里，有没有哪台机器的 Agent 从没连上过。
   *
   * 那种机器上开的落地端口，配置根本下发不下去 —— 面板却照样把它当成一条好线路
   * 发进订阅，客户端拉到手连不上，而这一页上一个字都没提过。
   *
   * **仍然照发**：机器可能下一分钟就连上了，而把人刚建好的节点悄悄拿掉，比发出去
   * 更糟（他会以为没建成功，再建一个）。所以只警告，不删。
   */
  for (const entry of [...directEntries, ...entries]) {
    const template = templatesById.get(Number(entry.templateId));
    const hostId = Number(template?.hostId || 0);
    if (hostId <= 0) continue;
    const host = hostsById.get(hostId);
    if (!host || !hostNeverConnected(host)) continue;
    if (warnings.some((item) => item.reason === "host-never-online" && item.nodeId === Number(entry.templateId))) continue;
    warnings.push({
      ruleId: 0,
      ruleName: "",
      reason: "host-never-online",
      targetText: text((host as any).name) || `主机 #${hostId}`,
      nodeId: Number(entry.templateId),
      nodeName: text(entry.node.name) || `节点 #${entry.templateId}`,
      nodeText: `${entry.node.address}:${entry.node.port}`,
    });
  }

  /*
    因为暂时不通而没发出去的，它的节点不算「没有转发指向」—— 转发明明在，只是这会儿
    不通，原因已经写在 skipped 里了。再报一遍「没有任何转发指向它们」是说错了话。
  */
  const unreachableRuleIdSet = new Set(skipped.filter((item) => item.reason === "unreachable").map((item) => item.ruleId));
  const emittedTemplates = new Set<number>([
    ...directWithFront.map((entry) => Number(entry.templateId)),
    ...entries.map((entry) => Number(entry.templateId)),
    ...input.rules
      .filter((rule) => unreachableRuleIdSet.has(Number(rule.id)))
      .map((rule) => Number(rule.proxyNodeId || 0)),
  ]);
  for (const template of input.templates) {
    const templateId = Number(template.id);
    if (emittedTemplates.has(templateId)) continue;
    if (template.isEnabled !== undefined && !bool(template.isEnabled)) continue;
    const node = proxyNodeFromTemplateRow(template);
    warnings.push({
      ruleId: 0,
      ruleName: "",
      reason: "node-unused",
      targetText: "",
      nodeId: templateId,
      nodeName: node.name || `节点 #${templateId}`,
      nodeText: node.address && node.port ? `${node.address}:${node.port}` : "",
    });
  }

  return { entries: [...directWithFront, ...entries], skipped, warnings };
}

/**
 * 同名节点会让 Clash 的 proxy-groups 引用产生歧义，客户端表现是随机少几个节点。
 * 重复时追加序号，保证名称在一份订阅里唯一。
 */
export function dedupeProxyNodeNames(nodes: readonly ProxyNode[]): ProxyNode[] {
  const used = new Map<string, number>();
  return nodes.map((node) => {
    const base = text(node.name) || "节点";
    const seen = used.get(base) || 0;
    used.set(base, seen + 1);
    if (seen === 0) return node.name === base ? node : { ...node, name: base };
    return { ...node, name: `${base} #${seen + 1}` };
  });
}


// ==================== 中转自动选路分组 ====================

/**
 * 同一个落地节点被多台中转指向时，订阅里额外生成一个策略组让客户端自己选路。
 *
 * off       不生成，只留裸节点
 * url-test      客户端定期测速，自动走最快的那条中转，挂掉自动切
 * fallback      按顺序主备，前一条不通才切下一条
 * load-balance  负载均衡：每条新连接轮流走下一条中转，多条连接的带宽相加（两台 300M 的中转
 *               合起来约 600M）。单条连接仍只走一条中转，上限还是一台的带宽。
 *               所有中转最后都从同一台落地出去，出口 IP 不变，所以轮询不会让网站
 *               看到 IP 跳来跳去。
 */
export const PROXY_NODE_AUTO_GROUPS = ["off", "url-test", "fallback", "load-balance"] as const;

export type ProxyNodeAutoGroup = (typeof PROXY_NODE_AUTO_GROUPS)[number];

export const PROXY_NODE_AUTO_GROUP_LABELS: Record<ProxyNodeAutoGroup, string> = {
  off: "不生成",
  "url-test": "自动选最快",
  fallback: "主备切换",
  "load-balance": "负载均衡",
};

export const PROXY_NODE_AUTO_GROUP_HINTS: Record<ProxyNodeAutoGroup, string> = {
  off: "订阅里只有裸节点，由你自己在客户端里选。",
  "url-test": "客户端定期测速，自动走延迟最低的中转；该条中转故障时自动切换。",
  fallback: "按列表顺序主备，前一条不通才切下一条，适合有明确主力线路时。",
  "load-balance": "每条新连接轮流走不同中转，多线程下载、多设备同时用时带宽相加（两台 300M 约 600M）；单条连接仍只走一条中转。按各前置的线路带宽多分少分（主机里填的「线路带宽」，没填时看总限速或主机名括号里写的带宽，如「Po0(500M)」），Clash / Mihomo 客户端生效。sing-box 按「自动选最快」生成。",
};

/**
 * 默认的选路方式。
 *
 * 单独拎出来是因为它有两个用处：新建节点时的初值，以及界面判断「这个节点改过
 * 没有」的基准。两处各写一个字面量的话，将来改默认值会漏掉一处，表现是新建的
 * 节点一打开就被当成「改过」。
 */
export const PROXY_NODE_DEFAULT_AUTO_GROUP: ProxyNodeAutoGroup = "url-test";

export function normalizeProxyNodeAutoGroup(value: unknown): ProxyNodeAutoGroup {
  const raw = String(value ?? "").trim().toLowerCase();
  return (PROXY_NODE_AUTO_GROUPS as readonly string[]).includes(raw)
    ? raw as ProxyNodeAutoGroup
    : PROXY_NODE_DEFAULT_AUTO_GROUP;
}

export type ProxySubscriptionGroupType = "select" | "url-test" | "fallback" | "load-balance";

export type ProxySubscriptionGroup = {
  name: string;
  type: ProxySubscriptionGroupType;
  /** 组内成员，可能是节点名，也可能是另一个组名（主选择器会引用自动选路组）。 */
  members: string[];
  /** 透传的外部订阅（mihomo / Stash 的 proxy-providers 名），只有 Clash 格式渲染它。 */
  use?: string[];
  /**
   * 「负载均衡」组每个成员分多少份连接（和 members 一一对应，见 proxyLoadBalanceWeights）。
   * 没有 = 平均分。只有确认支持「组里重复列同一个节点」的客户端（mihomo / Clash）才照着展开。
   */
  weights?: number[];
};

/** 透传给客户端的外部订阅（shared/proxySubSource.ts 的 provider 模式）。 */
export type ProxySubProvider = {
  name: string;
  url: string;
  intervalSec: number;
};

/** 订阅最终要渲染的内容：节点、策略组、分流规则。 */
export type ProxySubscriptionDocument = {
  nodes: ProxyNode[];
  groups: ProxySubscriptionGroup[];
  ruleSets: ProxyRuleSetRef[];
  rules: ProxyRouteRule[];
  /** 透传的外部订阅；只有 mihomo / Stash 认，别的格式忽略。 */
  providers?: ProxySubProvider[];
};

/** 自动选路组的名字，和模板同名会让客户端里两个条目难以区分，所以加后缀。 */
export function autoGroupNameForTemplate(templateName: string, mode: ProxyNodeAutoGroup = "url-test"): string {
  // 负载均衡组单独起名：用户要在客户端里一眼认出「选这个才把连接分到几台前置上」。
  return `${text(templateName) || "节点"} ${mode === "load-balance" ? "负载均衡" : "自动选路"}`;
}

/** 一台中转不构成选路，低于这个数量不生成自动组。 */
export const PROXY_AUTO_GROUP_MIN_MEMBERS = 2;

/**
 * 组装订阅文档。
 *
 * 分组必须在节点重名处理之后生成：组是按名称引用成员的，用去重前的名字会让
 * 客户端找不到节点。
 */
/** 模板里定义的自定义策略组：按正则从节点名里挑成员（Xboard 的做法）。 */
export type ProxySubCustomGroup = {
  name: string;
  type: ProxySubscriptionGroupType;
  /** 节点名筛选表达式；空 = 全部节点。怎么解释由 match 定（shared/proxySubGroupFilter）。 */
  filter: string;
  /** regex（默认，老模板）/ any 任一关键词 / all 全部关键词。 */
  match?: ProxySubGroupMatch;
  /** 成员里也带上自动组和地区组。 */
  includeGroups?: boolean;
};

export type BuildProxySubscriptionDocumentOptions = {
  mainGroupName: string;
  rulePreset?: ProxyRulePreset;
  /** 按地区（节点上的 regionCode）各建一个 url-test 组。 */
  regionGroups?: boolean;
  /** 模板里的自定义组。 */
  customGroups?: readonly ProxySubCustomGroup[];
  /** 分类去向覆盖：分类 key → DIRECT / REJECT / PROXY / 组名。 */
  categoryTargets?: Record<string, string>;
  /** 透传的外部订阅：主选择器和各分类组用 `use` 引用它们。 */
  providers?: readonly ProxySubProvider[];
  /**
   * 出口主机最新的解锁检测结论（服务端查好传进来）。有合格节点的流媒体 / AI 分类会多一个
   * 「Netflix 解锁」这类组并默认选它，见 shared/proxySubUnlock.ts。不传 = 不做。
   */
  unlockStatuses?: ProxySubUnlockStatusMap | null;
};

function regionGroupsFor(nodes: readonly ProxyNode[]): ProxySubscriptionGroup[] {
  const byRegion = new Map<string, string[]>();
  for (const node of nodes) {
    const code = String(node.regionCode || "").toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) continue;
    const list = byRegion.get(code) || [];
    list.push(node.name);
    byRegion.set(code, list);
  }
  const groups: ProxySubscriptionGroup[] = [];
  for (const [code, members] of Array.from(byRegion.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    const label = proxySubRegionLabel(code);
    if (!label) continue;
    groups.push({ name: label, type: "url-test", members });
  }
  return groups;
}

export function customGroupsFor(custom: readonly ProxySubCustomGroup[], nodeNames: readonly string[], groupNames: readonly string[]): ProxySubscriptionGroup[] {
  const out: ProxySubscriptionGroup[] = [];
  for (const group of custom) {
    const name = text(group.name);
    if (!name) continue;
    const matcher = compileProxySubGroupFilter(text(group.filter), group.match);
    const members = [
      ...(group.includeGroups ? groupNames : []),
      ...nodeNames.filter(matcher),
    ];
    if (members.length === 0) continue;
    out.push({ name, type: group.type, members });
  }
  return out;
}

export function buildProxySubscriptionDocument(
  plan: ProxySubscriptionPlan,
  templates: readonly ProxyNodeTemplateRow[],
  options: BuildProxySubscriptionDocumentOptions,
): ProxySubscriptionDocument {
  const deduped = dedupeProxyNodeNames(plan.entries.map((entry) => entry.node));

  /**
   * 前置引用在这里才落成名字 —— 必须等去重跑完。
   *
   * 一个模板只会产出一条直连条目，所以用「模板 id → 该条目去重后的名字」这张表
   * 就能把引用对准。引用不到就不挂，宁可少一层也不要指向不存在的节点。
   */
  const frontNameByTemplateId = new Map<number, string>();
  plan.entries.forEach((entry, index) => {
    const name = deduped[index]?.name;
    if (entry.kind === "direct" && name) frontNameByTemplateId.set(entry.templateId, name);
  });

  const nodes = deduped.map((node, index) => {
    const frontName = frontNameByTemplateId.get(plan.entries[index]?.frontTemplateId ?? 0);
    return frontName ? { ...node, frontProxyName: frontName } : node;
  });

  const templatesById = new Map<number, ProxyNodeTemplateRow>();
  for (const template of templates) templatesById.set(Number(template.id), template);

  // 去重后的名字按顺序对回各自的模板。
  const namesByTemplate = new Map<number, string[]>();
  const relayNamesByTemplate = new Map<number, string[]>();
  const relayBandwidthsByTemplate = new Map<number, number[]>();
  plan.entries.forEach((entry, index) => {
    const name = nodes[index]?.name;
    if (!name) return;
    const list = namesByTemplate.get(entry.templateId) || [];
    list.push(name);
    namesByTemplate.set(entry.templateId, list);
    if (entry.kind !== "direct") {
      const relays = relayNamesByTemplate.get(entry.templateId) || [];
      relays.push(name);
      relayNamesByTemplate.set(entry.templateId, relays);
      const bandwidths = relayBandwidthsByTemplate.get(entry.templateId) || [];
      bandwidths.push(Number(entry.bandwidthMbps || 0));
      relayBandwidthsByTemplate.set(entry.templateId, bandwidths);
    }
  });

  const autoGroups: ProxySubscriptionGroup[] = [];
  for (const [templateId, allNames] of namesByTemplate) {
    const template = templatesById.get(templateId);
    const mode = normalizeProxyNodeAutoGroup(template?.autoGroup);
    if (mode === "off") continue;
    /**
     * 负载均衡只分到中转上，不带落地直连。
     *
     * 直连是另一条完全不同的线路（从国内直连落地往往是最差的一条），混进轮询里
     * 就是每几条连接有一条绕开前置 —— 用户看到的是组里多了个落地、速度忽高忽低。
     * 择快与主备则照旧带上直连，让客户端自己比。
     */
    const memberNames = mode === "load-balance" ? relayNamesByTemplate.get(templateId) || [] : allNames;
    if (memberNames.length < PROXY_AUTO_GROUP_MIN_MEMBERS) continue;
    // 负载均衡按各前置的带宽多分少分：500M 和 300M 两台就是 5:3，而不是一人一半。
    const weights = mode === "load-balance" ? proxyLoadBalanceWeights(relayBandwidthsByTemplate.get(templateId) || []) : null;
    autoGroups.push({
      name: autoGroupNameForTemplate(text(template?.name), mode),
      type: mode,
      members: memberNames,
      ...(weights ? { weights } : {}),
    });
  }

  // 地区组：同一地区的节点（直连和中转都算）放一个 url-test 组。
  const regionGroups = options.regionGroups ? regionGroupsFor(nodes) : [];
  // 自定义组：模板里按正则定义的；名字和自动组 / 地区组撞了的以自定义为准（后写的覆盖）。
  const customGroups = customGroupsFor(
    options.customGroups || [],
    nodes.map((node) => node.name),
    [...autoGroups, ...regionGroups].map((group) => group.name),
  );
  const customNames = new Set(customGroups.map((group) => group.name));
  const builtGroups = [...autoGroups, ...regionGroups].filter((group) => !customNames.has(group.name));

  const groups: ProxySubscriptionGroup[] = [];
  const selectableMembers = [
    ...customGroups.map((group) => group.name),
    ...builtGroups.map((group) => group.name),
    ...nodes.map((node) => node.name),
  ];
  const providers = (options.providers || []).filter((item) => item.name && item.url);
  const providerNames = providers.map((item) => item.name);
  // 一个节点都没有、但有透传的外部订阅时，主选择器照样建：成员全部来自 provider。
  const hasContent = nodes.length > 0 || providerNames.length > 0;
  if (hasContent) {
    // 自动选路组排在裸节点前面，用户打开客户端第一眼就是「自动」。
    groups.push({ name: options.mainGroupName, type: "select", members: selectableMembers, ...(providerNames.length ? { use: providerNames } : {}) });
    groups.push(...customGroups, ...builtGroups);
  }

  /*
    解锁出口组：只看这份订阅里真有的分类，只在规则计划确实引用了它时才放进文档
    （令牌覆盖了去向的分类不引用，就不出这个组）。
  */
  const preset = normalizeProxyRulePreset(options.rulePreset);
  const unlock = hasContent && nodes.length > 0
    ? buildProxySubUnlockGroups(
      nodes.map((node, index) => ({ name: node.name, exitHostId: plan.entries[index]?.meta?.exitHostId ?? null })),
      options.unlockStatuses,
      {
        categoryKeys: proxyRuleCategoriesForPreset(preset).map((category) => category.key),
        reservedNames: [...nodes.map((node) => node.name), ...groups.map((group) => group.name), ...providerNames],
      },
    )
    : { groups: [], preferredByCategory: {} };

  // 没有节点时不生成规则：规则会指向不存在的策略组，客户端直接拒绝整份配置。
  const rulePlan = hasContent
    ? buildProxyRulePlan({
      preset,
      mainGroupName: options.mainGroupName,
      selectableMembers,
      categoryTargets: options.categoryTargets,
      preferredGroups: unlock.preferredByCategory,
    })
    : { ruleSets: [], categoryGroups: [], rules: [] };

  const referenced = new Set(rulePlan.categoryGroups.flatMap((group) => group.members));
  for (const group of unlock.groups) {
    if (referenced.has(group.name)) groups.push({ name: group.name, type: group.type, members: group.members });
  }

  for (const group of rulePlan.categoryGroups) {
    groups.push({ name: group.name, type: "select", members: group.members, ...(providerNames.length ? { use: providerNames } : {}) });
  }

  return { nodes, groups, ruleSets: rulePlan.ruleSets, rules: rulePlan.rules, ...(providers.length ? { providers: [...providers] } : {}) };
}

/* ── 负载均衡组的加权 ─────────────────────────────────────────────────── */

// 算法在 shared/linkWeights.ts，出口组的「按权重」也用它。
export { hostBandwidthHintMbps, PROXY_LOAD_BALANCE_MAX_WEIGHT, proxyLoadBalanceWeights, expandWeightedMembers };
