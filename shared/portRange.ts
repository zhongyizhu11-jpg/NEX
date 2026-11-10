/**
 * 端口段转发：一条规则转一整段端口（游戏、RTP 媒体、FTP 被动端口这类业务常要）。
 *
 * 规则上只多一列 sourcePortEnd：空 = 单端口（老数据不变），比 sourcePort 大 = 段的最后一个端口。
 * 目标那头不单独存：targetPort 是目标段的第一个端口，长度和入口段一样 ——
 * targetPort === sourcePort 是「同端口」（20000-20100 → 20000-20100），不等就是「平移」
 * （20000-20100 → 30000-30100）。少存一列，就不会出现两头长度对不上的脏数据。
 *
 * 为什么只给内核转发（iptables / nftables）：DNAT 一条规则就能匹配一整段端口、按偏移改写，
 * 计数器也还是那一条；gost / realm / socat / nginx 都是一个端口一个监听，段一大就是几百上千个
 * 监听和进程，所以直接不让选，而不是悄悄替用户开几百个监听。
 *
 * 这里全是纯函数，界面和服务端各用同一份：能不能建、为什么不能建，两边说的话一字不差。
 */

/** 一条规则的端口段最多多少个端口。超了直接报错，不截断。 */
export const PORT_RANGE_MAX_SIZE = 1000;

/**
 * 认识端口段的最旧 Agent。规则命令是面板拼的，老 Agent 也能执行；但它的就绪检查和计数修复
 * 只认单端口 —— 段规则会被一直当成「没装上」反复重下，iptables 的计数链也只数第一个端口。
 * 所以老 Agent 上不下发，保存时就拦住。
 */
export const PORT_RANGE_MIN_AGENT_VERSION = "2.2.254";

/** 支持端口段的转发方式。 */
export const PORT_RANGE_FORWARD_TYPES = ["iptables", "nftables"] as const;

export type PortSpan = { start: number; end: number };

function isPort(value: number) {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

export function forwardTypeSupportsPortRange(forwardType: unknown) {
  return (PORT_RANGE_FORWARD_TYPES as readonly string[]).includes(String(forwardType ?? "").trim().toLowerCase());
}

/**
 * 解析 `8080` / `20000-20100`。end 等于 start 时按单端口处理（返回 end = start）。
 * 空串返回 null（调用方决定空是不是合法，比如新建时空 = 随机分配）。
 */
export function parsePortSpec(text: unknown): PortSpan | { error: string } | null {
  const raw = String(text ?? "").replace(/\s+/g, "").replace(/[－—–~～]/g, "-");
  if (!raw) return null;
  const match = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(raw);
  if (!match) return { error: "端口写成 8080 或 20000-20100" };
  const start = Number(match[1]);
  const end = match[2] === undefined ? start : Number(match[2]);
  if (!isPort(start) || !isPort(end)) return { error: "端口必须在 1-65535 之间" };
  if (end < start) return { error: "端口段要从小写到大，比如 20000-20100" };
  return { start, end };
}

/** 存库用：end 不比 start 大就是单端口，存 null。 */
export function normalizeSourcePortEnd(sourcePort: unknown, sourcePortEnd: unknown): number | null {
  const start = Number(sourcePort);
  const end = Number(sourcePortEnd);
  if (!isPort(start) || !isPort(end) || end <= start) return null;
  return end;
}

type PortRangeRuleLike = { sourcePort?: unknown; sourcePortEnd?: unknown; targetPort?: unknown };

/** 入口段最后一个端口；单端口规则就是 sourcePort 本身。 */
export function ruleSourcePortEnd(rule: PortRangeRuleLike | null | undefined) {
  const start = Number(rule?.sourcePort) || 0;
  return normalizeSourcePortEnd(start, rule?.sourcePortEnd) ?? start;
}

export function isPortRangeRule(rule: PortRangeRuleLike | null | undefined) {
  return normalizeSourcePortEnd(rule?.sourcePort, rule?.sourcePortEnd) !== null;
}

/** 段里有几个端口；单端口是 1。 */
export function rulePortRangeSize(rule: PortRangeRuleLike | null | undefined) {
  const start = Number(rule?.sourcePort) || 0;
  if (start <= 0) return 0;
  return ruleSourcePortEnd(rule) - start + 1;
}

/** 目标段最后一个端口：目标起点 + 段长 - 1（同端口和平移都是这个算法）。 */
export function ruleTargetPortEnd(rule: PortRangeRuleLike | null | undefined) {
  const targetPort = Number(rule?.targetPort) || 0;
  return targetPort + Math.max(0, rulePortRangeSize(rule) - 1);
}

/** 入口段里某个端口对应的目标端口（平移就是加上偏移）。不在段里返回 null。 */
export function mapPortRangeTarget(rule: PortRangeRuleLike, port: number): number | null {
  const start = Number(rule.sourcePort) || 0;
  if (port < start || port > ruleSourcePortEnd(rule)) return null;
  return (Number(rule.targetPort) || 0) + (port - start);
}

export function formatPortSpan(start: unknown, end?: unknown) {
  const s = Number(start) || 0;
  const e = Number(end) || 0;
  return e > s ? `${s}-${e}` : String(s);
}

/** 规则卡、日志里显示的入口端口：`20000-20100` 或 `8080`。 */
export function formatRuleSourcePort(rule: PortRangeRuleLike | null | undefined) {
  return formatPortSpan(rule?.sourcePort, ruleSourcePortEnd(rule));
}

/** 规则卡里显示的目标端口：段规则显示整段。 */
export function formatRuleTargetPort(rule: PortRangeRuleLike | null | undefined) {
  return formatPortSpan(rule?.targetPort, ruleTargetPortEnd(rule));
}

/**
 * 把一条规则占的端口加进集合：单端口就是 sourcePort，端口段是整段。
 * 段长在保存时就限制在 PORT_RANGE_MAX_SIZE 以内，这里再夹一次，脏数据也撑不爆这个集合。
 */
export function addRulePortSpan(used: Set<number>, portValue: unknown, portEndValue: unknown) {
  const port = Number(portValue);
  if (!isPort(port)) return;
  const end = Math.min(65535, port + PORT_RANGE_MAX_SIZE - 1, Math.max(port, Number(portEndValue) || 0));
  for (let current = port; current <= end; current += 1) used.add(current);
}

export function portSpansOverlap(left: PortSpan, right: PortSpan) {
  return left.start <= right.end && right.start <= left.end;
}

/**
 * 入口段 + 目标起点 + （可选）用户写的目标段，算出能不能存。null = 没问题。
 *
 * targetPortEnd 是表单 / 批量里用户写的目标段结尾；写了就得和入口段一样长 —— 不一样长的
 * 「多对一」「一对多」内核 DNAT 做不到一一对应（会随机挑端口），宁可直接报错。
 */
export function portRangeShapeError(input: {
  sourcePort: number;
  sourcePortEnd?: number | null;
  targetPort: number;
  targetPortEnd?: number | null;
}): string | null {
  const start = Number(input.sourcePort) || 0;
  const end = Number(input.sourcePortEnd) || 0;
  const targetStart = Number(input.targetPort) || 0;
  const targetEnd = Number(input.targetPortEnd) || 0;
  if (end > 0 && end < start) return "端口段要从小写到大，比如 20000-20100";
  const size = end > start ? end - start + 1 : 1;
  if (size > PORT_RANGE_MAX_SIZE) return `端口段最多 ${PORT_RANGE_MAX_SIZE} 个端口，现在是 ${size} 个`;
  if (targetEnd > 0 && targetEnd !== targetStart) {
    if (size === 1) return "入口是单端口时，目标也只能写一个端口";
    if (targetEnd - targetStart + 1 !== size) return `目标段要和入口段一样长（${size} 个端口）`;
  }
  if (size > 1 && targetStart > 0 && targetStart + size - 1 > 65535) return "目标段超出 65535";
  return null;
}

/** 判断「这条规则还能不能用端口段」要看的那些字段。 */
export type PortRangeRuleContext = {
  forwardType?: unknown;
  tunnelId?: unknown;
  forwardGroupId?: unknown;
  isForwardGroupTemplate?: unknown;
  /**
   * 挂的是「端口转发」资源（groupMode = port 的转发组，界面上新建端口转发走的就是它）：每个成员
   * 主机上一条一模一样的内核规则，可以用端口段。转发链、主备转发组不行。
   */
  portForwardGroup?: boolean;
  tlsInboundId?: unknown;
  failoverEnabled?: unknown;
  routeMode?: unknown;
  egressType?: unknown;
  sourcePort?: unknown;
  /** 有限速（用户或规则自己的）：内核转发的限速要换成用户态守卫，一个端口一个进程。 */
  rateLimited?: boolean;
};

export const PORT_RANGE_USERSPACE_REASON = "端口段只支持 iptables / nftables：gost、realm 这些每个端口都要单独开一个监听";

function truthy(value: unknown) {
  return value === true || value === 1 || value === "1" || value === "true";
}

/**
 * 这条规则为什么不能用端口段；null = 可以。
 *
 * 线路组、隧道、转发链、主备转发组第一版都不做：它们的每一跳、每个成员、每条线路都按单端口
 * 设计（中转监听、出口端口、健康探测），做一半比不做更糟 —— 所以这里明确拦住。
 * 「端口转发」资源（port 模式的转发组）例外：它只是在成员主机上各放一条同样的规则。
 */
export function portRangeUnsupportedReason(rule: PortRangeRuleContext): string | null {
  if (Number(rule.tlsInboundId || 0) > 0) return "共享 TLS 入站上的规则不能用端口段";
  if (Number(rule.tunnelId || 0) > 0) return "隧道规则暂不支持端口段，只能用在直连主机的规则上";
  if ((Number(rule.forwardGroupId || 0) > 0 || truthy(rule.isForwardGroupTemplate)) && !rule.portForwardGroup) {
    return "转发组 / 转发链暂不支持端口段，端口转发和直连主机的规则可以";
  }
  if (truthy(rule.failoverEnabled) || String(rule.routeMode || "").trim()) return "线路组（主备 / 多线路）暂不支持端口段";
  if (!forwardTypeSupportsPortRange(rule.forwardType)) return PORT_RANGE_USERSPACE_REASON;
  if (String(rule.egressType || "none") !== "none") return "走 Shadowsocks 出口的规则不能用端口段";
  if (rule.sourcePort !== undefined && Number(rule.sourcePort) <= 0) return "端口段不能随机分配，请写出起止端口";
  if (rule.rateLimited) return "限速的规则不能用端口段：内核转发要限速得换成用户态守卫，一个端口一个进程";
  return null;
}

/* ───────────────────────────── 批量添加 ───────────────────────────── */

export type BatchRuleLine = {
  /** 原文第几行（从 1 开始），预览和结果都按它对回去。 */
  line: number;
  text: string;
  sourcePort: number;
  sourcePortEnd: number | null;
  targetIp: string;
  targetPort: number;
  targetPortEnd: number | null;
  remark: string;
};

export type BatchRuleLineError = { line: number; text: string; error: string };

export const BATCH_RULE_MAX_LINES = 200;

/**
 * 一行：`入口端口[-结束] 目标地址:端口[-结束] [备注]`。IPv6 目标写 `[2001:db8::1]:443`。
 * 分隔用空格或制表符；`#` 开头的行和空行跳过。
 */
export function parseBatchRuleLine(text: string, line: number): BatchRuleLine | BatchRuleLineError {
  const raw = String(text || "").trim();
  const parts = raw.split(/\s+/);
  if (parts.length < 2) return { line, text: raw, error: "格式是：入口端口 目标地址:端口 [备注]" };
  const source = parsePortSpec(parts[0]);
  if (!source) return { line, text: raw, error: "缺入口端口" };
  if ("error" in source) return { line, text: raw, error: `入口端口：${source.error}` };
  const targetText = parts[1];
  let host = "";
  let portText = "";
  const bracket = /^\[([0-9a-fA-F:.]+)\]:(.+)$/.exec(targetText);
  if (bracket) {
    host = bracket[1];
    portText = bracket[2];
  } else {
    const index = targetText.lastIndexOf(":");
    if (index <= 0 || targetText.indexOf(":") !== index) {
      return { line, text: raw, error: "目标写成 地址:端口，IPv6 用 [地址]:端口" };
    }
    host = targetText.slice(0, index);
    portText = targetText.slice(index + 1);
  }
  if (!/^[a-zA-Z0-9]([a-zA-Z0-9\-_.]*[a-zA-Z0-9])?$|^[a-fA-F0-9:.]+$/.test(host)) {
    return { line, text: raw, error: "目标地址格式不对" };
  }
  const target = parsePortSpec(portText);
  if (!target) return { line, text: raw, error: "缺目标端口" };
  if ("error" in target) return { line, text: raw, error: `目标端口：${target.error}` };
  const sourcePortEnd = source.end > source.start ? source.end : null;
  const targetPortEnd = target.end > target.start ? target.end : null;
  const shapeError = portRangeShapeError({ sourcePort: source.start, sourcePortEnd, targetPort: target.start, targetPortEnd });
  if (shapeError) return { line, text: raw, error: shapeError };
  return {
    line,
    text: raw,
    sourcePort: source.start,
    sourcePortEnd,
    targetIp: host,
    targetPort: target.start,
    targetPortEnd,
    remark: parts.slice(2).join(" ").slice(0, 128),
  };
}

/**
 * 整段文本逐行解析，再找出同一批里互相撞端口的行（后出现的那行算冲突）。
 * 和库里已有规则的冲突要查库，在服务端那一步做。
 */
export function parseBatchRuleText(text: string): Array<BatchRuleLine | BatchRuleLineError> {
  const out: Array<BatchRuleLine | BatchRuleLineError> = [];
  const accepted: BatchRuleLine[] = [];
  String(text || "").split(/\r?\n/).forEach((rawLine, index) => {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const parsed = parseBatchRuleLine(trimmed, index + 1);
    if ("error" in parsed) {
      out.push(parsed);
      return;
    }
    const span = { start: parsed.sourcePort, end: parsed.sourcePortEnd ?? parsed.sourcePort };
    const clash = accepted.find((other) => portSpansOverlap(span, { start: other.sourcePort, end: other.sourcePortEnd ?? other.sourcePort }));
    if (clash) {
      out.push({ line: parsed.line, text: parsed.text, error: `和第 ${clash.line} 行的入口端口重叠` });
      return;
    }
    accepted.push(parsed);
    out.push(parsed);
  });
  return out;
}

export function isBatchRuleLineError(value: BatchRuleLine | BatchRuleLineError): value is BatchRuleLineError {
  return "error" in value;
}
