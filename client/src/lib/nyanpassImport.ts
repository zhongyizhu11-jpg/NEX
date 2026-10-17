import type { ForwardRuleProtocol } from "@shared/forwardTypes";
import {
  parseRuleTransferFile,
  RULE_TRANSFER_FILE_KIND,
  RULE_TRANSFER_FILE_VERSION,
  RULE_TRANSFER_MAX_FILE_SIZE,
  RULE_TRANSFER_MAX_IMPORT_COUNT,
  type FailoverStrategy,
  type RuleTransferFile,
  type RuleTransferFileRule,
} from "./ruleTransfer";

/*
  ny / Nyanpass 规则导入（上游 2.3.285，实验性）。

  ny 导出的是一行一条 JSON（或一个 JSON 数组），字段是 listen_port / dest / dest_policy……
  这里把它换成 NEX 自己的规则导出格式，后面走原来的导入流程。只当数据读：不读 ny 的 ID、
  凭据，也不执行任何东西。NEX 做不到一模一样的设置（单规则 IP 数 / 连接数限制、TLS / SNI、
  UDP PROXY、换算不成整数 Mbps 的限速）直接报出是第几条、哪个字段，不悄悄丢掉。
*/

export type ImportedRule = RuleTransferFileRule & { rateLimitMbps?: number };
export type CompatibleRuleFile = Omit<RuleTransferFile, "rules"> & { rules: ImportedRule[]; importSource?: "nyanpass" };
export type CompatibleRuleParseResult = { ok: true; file: CompatibleRuleFile } | { ok: false; error: string };

const ALLOWED_FIELDS = new Set(["name", "listen_port", "dest", "dest_policy", "accept_proxy_protocol", "proxy_protocol", "speed_limit", "ip_limit", "connection_limit", "tls"]);
const STRATEGIES: Record<string, FailoverStrategy> = { random: "random", round: "round_robin", ip_hash: "ip_hash", failover: "fallback" };
/** ny 的 speed_limit 是字节每秒：125000 B/s = 1 Mbps。 */
const BYTES_PER_MBPS = 125_000;

function parseTarget(value: unknown) {
  if (typeof value !== "string") return null;
  // IPv6 必须带方括号（和 ny 界面一致）。不在第一个冒号处切，也不把 URL / 路径当地址。
  const match = value.trim().match(/^(?:\[([a-fA-F0-9:.]+)\]|([^\s:[\]/?#]+)):(\d+)$/);
  if (!match) return null;
  if (match[1]) {
    try { new URL(`http://[${match[1]}]/`); } catch { return null; }
  } else if (/^\d+\.\d+\.\d+\.\d+$/.test(match[2]) && match[2].split(".").some((part) => Number(part) > 255)) {
    return null;
  }
  const port = Number(match[3]);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? { targetIp: match[1] || match[2], targetPort: port } : null;
}

function convertRule(value: unknown, index: number): ImportedRule {
  const fail = (reason: string): never => { throw new Error(`ny 第 ${index + 1} 条规则：${reason}`); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("规则必须是 JSON 对象");
  const row = value as Record<string, unknown>;
  const unknown = Object.keys(row).filter((key) => !ALLOWED_FIELDS.has(key));
  if (unknown.length) return fail(`不支持的配置字段：${unknown.join(", ").slice(0, 200)}`);
  if (!Number.isInteger(row.listen_port) || Number(row.listen_port) < 0 || Number(row.listen_port) > 65535) return fail("监听端口必须是 0-65535 的整数");
  if (!Array.isArray(row.dest) || row.dest.length === 0 || row.dest.length > 11) return fail("目标列表要有 1-11 个地址");
  const destinations = row.dest.map(parseTarget);
  if (destinations.some((item) => !item)) return fail("目标地址要写成 host:port 或 [IPv6]:port");
  for (const field of ["ip_limit", "connection_limit", "speed_limit", "accept_proxy_protocol", "proxy_protocol"] as const) {
    const number = row[field];
    if (number != null && (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0)) return fail(`字段 ${field} 必须是非负整数`);
  }
  if (Number(row.ip_limit) > 0 || Number(row.connection_limit) > 0) return fail("暂不支持 ny 的单规则 IP 数或连接数限制");
  if (row.tls != null) return fail("暂不支持 ny 的 TLS 入站、共享端口或 SNI 子规则");
  const receive = Number(row.accept_proxy_protocol || 0);
  const send = Number(row.proxy_protocol || 0);
  if (![0, 1].includes(receive) || ![0, 1, 3].includes(send)) return fail("只支持关闭 PROXY、TCP PROXY v1 或 v2；不支持 UDP PROXY");
  const policy = row.dest_policy ?? "random";
  if (typeof policy !== "string" || !Object.hasOwn(STRATEGIES, policy)) return fail(`不支持的负载均衡策略：${String(policy).slice(0, 80)}`);
  const speed = Number(row.speed_limit || 0);
  if (speed && (speed % BYTES_PER_MBPS !== 0 || speed / BYTES_PER_MBPS > 1_000_000)) return fail("ny 的限速换算不成整数 Mbps");
  const [first, ...rest] = destinations as Array<{ targetIp: string; targetPort: number }>;
  const parsed = parseRuleTransferFile({
    kind: RULE_TRANSFER_FILE_KIND,
    version: RULE_TRANSFER_FILE_VERSION,
    rules: [{
      name: row.name === undefined ? "导入规则" : row.name,
      sourcePort: row.listen_port,
      ...first,
      forwardType: "gost",
      protocol: "both",
      // 导进来先停着：入口端口可能还在 ny 那边用着，确认迁移好了再一条条打开。
      isEnabled: false,
      proxyProtocolReceive: receive === 1,
      proxyProtocolSend: send !== 0,
      proxyProtocolVersion: send === 3 ? 2 : 1,
      failoverEnabled: rest.length > 0,
      failoverTargets: rest,
      failoverStrategy: STRATEGIES[policy],
    }],
  });
  if (!parsed.ok) return fail(parsed.error.replace(/^第 1 条规则/, ""));
  return { ...parsed.file.rules[0], ...(speed ? { rateLimitMbps: speed / BYTES_PER_MBPS } : {}) };
}

/**
 * 读一个规则文件：NEX 自己的导出文件照原来的校验；不是的话按 ny 的格式试一遍。
 * 自称是 NEX 文件（带 kind）却校验不过的，照报 NEX 的错误，不拿 ny 的格式硬套。
 */
export function parseCompatibleRuleTransferText(text: string): CompatibleRuleParseResult {
  if (new TextEncoder().encode(text).byteLength > RULE_TRANSFER_MAX_FILE_SIZE) return { ok: false, error: "规则文件不能超过 5 MiB" };
  const source = text.replace(/^﻿/, "").trim();
  if (!source) return { ok: false, error: "文件中没有可导入的规则" };
  try {
    let raw: unknown;
    try {
      raw = JSON.parse(source);
    } catch {
      const lines = source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (lines.length > RULE_TRANSFER_MAX_IMPORT_COUNT) return { ok: false, error: `单次最多导入 ${RULE_TRANSFER_MAX_IMPORT_COUNT} 条规则` };
      raw = lines.map((line, index) => {
        try { return JSON.parse(line); } catch { throw new Error(`ny 第 ${index + 1} 行不是有效的 JSON`); }
      });
    }
    if (raw && typeof raw === "object" && !Array.isArray(raw) && "kind" in raw) return parseRuleTransferFile(raw);
    const rows = Array.isArray(raw) ? raw : [raw];
    if (rows.length === 0) return { ok: false, error: "文件中没有可导入的规则" };
    if (rows.length > RULE_TRANSFER_MAX_IMPORT_COUNT) return { ok: false, error: `单次最多导入 ${RULE_TRANSFER_MAX_IMPORT_COUNT} 条规则` };
    return {
      ok: true,
      file: { kind: RULE_TRANSFER_FILE_KIND, version: RULE_TRANSFER_FILE_VERSION, importSource: "nyanpass", rules: rows.map(convertRule) },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "文件无法解析，请选择 JSON 格式的规则文件" };
  }
}

/**
 * ny 规则导进所选的资源之前先核对一遍：建规则的接口会把不支持的组合悄悄改掉，
 * 实验性导入宁可整批不写也不要导进去一批「看着一样其实不一样」的规则。
 * resource 是规则页里的转发组 / 端口转发资源（含 groupMode / groupType / forwardType / PROXY 设置）。
 */
export function validateNyanpassImportTarget(rules: ImportedRule[], options: {
  protocol: ForwardRuleProtocol;
  scope: string;
  resource: any;
  admin: boolean;
}): string | null {
  const { protocol, scope, resource, admin } = options;
  if (!resource) return "请选择导入目标";
  const direct = scope === "local" && resource.groupMode === "port" && resource.groupType === "host";
  const tool = String(resource.forwardType || "");
  const on = (value: unknown) => value === true || value === 1;
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    const fail = (reason: string) => `ny 第 ${index + 1} 条规则：${reason}`;
    if (rule.rateLimitMbps && !admin) return fail("带限速的 ny 规则要管理员来导入");
    if (rule.failoverEnabled && !(direct && tool === "gost" && protocol === "tcp")) return fail("ny 多目标目前只能导进 TCP 的 GOST 端口转发资源");
    const proxy = rule.proxyProtocolReceive || rule.proxyProtocolSend;
    if (proxy && !(direct && ["gost", "realm"].includes(tool) && protocol === "tcp")) return fail("ny 的 PROXY 设置目前只能导进 TCP 的 GOST / Realm 端口转发资源");
    if (on(resource.proxyProtocolReceive) !== rule.proxyProtocolReceive || on(resource.proxyProtocolSend) !== rule.proxyProtocolSend
      || on(resource.proxyProtocolExitReceive) || on(resource.proxyProtocolExitSend)
      || (rule.proxyProtocolSend && Number(resource.proxyProtocolVersion || 1) !== rule.proxyProtocolVersion)) {
      return fail("目标资源的 PROXY 设置和 ny 规则不一致，请先核对资源；不会自动改资源");
    }
  }
  return null;
}
