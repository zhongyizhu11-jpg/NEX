/**
 * 把「转发规则 + 节点模板 + 入口主机」组装成订阅里的节点列表。
 *
 * 放在 shared 是为了让面板能预览出和服务端完全一致的结果：用户在界面上看到的
 * 「这些节点会进订阅」必须就是客户端真正拉到的那一份，否则排查问题时无从对账。
 *
 * 这里只做纯计算，不碰数据库；调用方负责把行取出来传进来。
 */

import { getHostEntryAddress, hostNeverConnected, type HostEntryAddressSource } from "./hostEntryAddress";
import { publishedRuleEntryDomain } from "./ruleEntryDomain";
import { proxyNodeBindingTruth } from "./proxyNodeAutoBind";
import {
  buildProxyRulePlan,
  normalizeProxyRulePreset,
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
  /** 最后一次心跳。从来没有 = Agent 还没装上，见 hostNeverConnected。 */
  lastHeartbeat?: unknown;
  name?: unknown;
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
  node: ProxyNode;
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
    const address = getHostEntryAddress(host);
    const port = toPort(rule.sourcePort);
    if (address && port) ownForwardEntries.add(entryKey(address, port));
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
    directEntries.push({ ruleId: 0, templateId, kind: "direct", frontTemplateId: 0, node });
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

    entries.push({
      ruleId,
      templateId,
      kind: "relay",
      frontTemplateId: frontIdOf(template),
      ...(targetMismatch ? { targetMismatch: true } : {}),
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
 * load-balance  每条新连接轮流走下一条中转，多条连接的带宽相加（两台 300M 的中转
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
  "load-balance": "带宽叠加",
};

export const PROXY_NODE_AUTO_GROUP_HINTS: Record<ProxyNodeAutoGroup, string> = {
  off: "订阅里只有裸节点，由你自己在客户端里选。",
  "url-test": "客户端定期测速，自动走延迟最低的中转；该条中转故障时自动切换。",
  fallback: "按列表顺序主备，前一条不通才切下一条，适合有明确主力线路时。",
  "load-balance": "每条新连接轮流走不同中转，多线程下载、多设备同时用时带宽相加（两台 300M 约 600M）；单条连接仍只走一条中转。只有 Clash / Mihomo 订阅支持，sing-box 按「自动选最快」生成。",
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
};

/** 订阅最终要渲染的内容：节点、策略组、分流规则。 */
export type ProxySubscriptionDocument = {
  nodes: ProxyNode[];
  groups: ProxySubscriptionGroup[];
  ruleSets: ProxyRuleSetRef[];
  rules: ProxyRouteRule[];
};

/** 自动选路组的名字，和模板同名会让客户端里两个条目难以区分，所以加后缀。 */
export function autoGroupNameForTemplate(templateName: string, mode: ProxyNodeAutoGroup = "url-test"): string {
  // 叠加组单独起名：用户要在客户端里一眼认出「选这个才叠带宽」。
  return `${text(templateName) || "节点"} ${mode === "load-balance" ? "带宽叠加" : "自动选路"}`;
}

/** 一台中转不构成选路，低于这个数量不生成自动组。 */
export const PROXY_AUTO_GROUP_MIN_MEMBERS = 2;

/**
 * 组装订阅文档。
 *
 * 分组必须在节点重名处理之后生成：组是按名称引用成员的，用去重前的名字会让
 * 客户端找不到节点。
 */
export function buildProxySubscriptionDocument(
  plan: ProxySubscriptionPlan,
  templates: readonly ProxyNodeTemplateRow[],
  options: { mainGroupName: string; rulePreset?: ProxyRulePreset },
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
    }
  });

  const autoGroups: ProxySubscriptionGroup[] = [];
  for (const [templateId, allNames] of namesByTemplate) {
    const template = templatesById.get(templateId);
    const mode = normalizeProxyNodeAutoGroup(template?.autoGroup);
    if (mode === "off") continue;
    /**
     * 带宽叠加只叠中转，不带落地直连。
     *
     * 直连是另一条完全不同的线路（从国内直连落地往往是最差的一条），混进轮询里
     * 就是每几条连接有一条绕开前置 —— 用户看到的是组里多了个落地、速度忽高忽低。
     * 择快与主备则照旧带上直连，让客户端自己比。
     */
    const memberNames = mode === "load-balance" ? relayNamesByTemplate.get(templateId) || [] : allNames;
    if (memberNames.length < PROXY_AUTO_GROUP_MIN_MEMBERS) continue;
    autoGroups.push({
      name: autoGroupNameForTemplate(text(template?.name), mode),
      type: mode,
      members: memberNames,
    });
  }

  const groups: ProxySubscriptionGroup[] = [];
  const selectableMembers = [...autoGroups.map((group) => group.name), ...nodes.map((node) => node.name)];
  if (nodes.length > 0) {
    // 自动选路组排在裸节点前面，用户打开客户端第一眼就是「自动」。
    groups.push({ name: options.mainGroupName, type: "select", members: selectableMembers });
    groups.push(...autoGroups);
  }

  // 没有节点时不生成规则：规则会指向不存在的策略组，客户端直接拒绝整份配置。
  const rulePlan = nodes.length > 0
    ? buildProxyRulePlan({
      preset: normalizeProxyRulePreset(options.rulePreset),
      mainGroupName: options.mainGroupName,
      selectableMembers,
    })
    : { ruleSets: [], categoryGroups: [], rules: [] };

  for (const group of rulePlan.categoryGroups) {
    groups.push({ name: group.name, type: "select", members: group.members });
  }

  return { nodes, groups, ruleSets: rulePlan.ruleSets, rules: rulePlan.rules };
}
