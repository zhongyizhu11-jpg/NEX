/*
  MCP（Model Context Protocol）服务端（#9）：让 Claude Code 之类的 AI 客户端用 API 令牌直接
  查看、操作面板 —— 「香港那台机器上有哪些规则」「把 #12 停掉」「给这条规则跑个诊断」。

  只实现 Streamable HTTP 传输里最小的那部分：客户端 POST JSON-RPC 2.0，我们直接回
  application/json（不开 SSE 流，也不发服务端通知）。方法只有 initialize / ping /
  tools/list / tools/call，以及客户端发来的 notifications/*。

  工具不自己查库：每个工具都是调同一个 tRPC 过程（appRouter.createCaller），所以权限、
  校验、审计和网页上点按钮一模一样；只读令牌、账号相关的限制也由 tRPC 中间件统一把关
  （见 server/ops/apiTokenPolicy.ts），这里在调用前再挡一次，只是为了给出更直白的提示。

  这个文件不引用 tRPC 路由（避免循环引用），由 mcpRoute.ts 把「怎么调过程」传进来，
  测试时换成假的调用器即可。
*/
import { z } from "zod";
import { APP_VERSION } from "../../shared/versions";
import { API_TOKEN_READ_ONLY_MESSAGE, type ApiTokenScope } from "./apiTokenPolicy";

export const MCP_SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const MCP_DEFAULT_PROTOCOL_VERSION = "2025-06-18";
export const MCP_SERVER_NAME = "nex";

/** 按 tRPC 路径调一个过程（例如 "rules.listPage"）。 */
export type McpInvoker = (path: string, input?: unknown) => Promise<unknown>;

export type McpSession = {
  scope: ApiTokenScope;
  isAdmin: boolean;
  invoke: McpInvoker;
  /** 测试里把轮询等待调成 0。 */
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
};

type JsonSchema = Record<string, unknown>;

type McpTool = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** 会改东西：只读令牌不能用。 */
  mutation?: boolean;
  /** 只有管理员能用。 */
  adminOnly?: boolean;
  args: z.ZodTypeAny;
  run: (args: any, session: McpSession) => Promise<unknown>;
};

type JsonRpcId = string | number | null;
type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; error: { code: number; message: string; data?: unknown } };

export const JSON_RPC_PARSE_ERROR = -32700;
export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;
export const JSON_RPC_INTERNAL_ERROR = -32603;

// ---------- 结果整理 ----------

/** 不管哪个过程返回了什么，这些字段都不交给 AI：令牌、密码、密钥类。 */
const SENSITIVE_KEY = /token|secret|password|privatekey|private_key|apikey|api_key|cookie|psk|uuid$/i;
const MAX_STRING = 2000;
const MAX_ARRAY = 200;

export function sanitizeForMcp(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value !== "object") return value;
  if (depth > 6) return "[…]";
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((item) => sanitizeForMcp(item, depth + 1));
    if (value.length > MAX_ARRAY) items.push(`…还有 ${value.length - MAX_ARRAY} 项`);
    return items;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key)) continue;
    out[key] = sanitizeForMcp(item, depth + 1);
  }
  return out;
}

/** 列表里每项只留这些字段（有哪个留哪个），一页几十台主机的完整对象对 AI 来说太长。 */
function pickFields(item: unknown, keys: string[]) {
  if (!item || typeof item !== "object") return item;
  const source = item as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return Object.keys(out).length ? out : source;
}

function compactPage(result: unknown, keys: string[]) {
  if (Array.isArray(result)) return result.map((item) => pickFields(item, keys));
  if (result && typeof result === "object" && Array.isArray((result as any).items)) {
    const page = result as Record<string, unknown>;
    return {
      total: page.totalItems ?? page.total,
      page: page.page,
      pageSize: page.pageSize,
      totalPages: page.totalPages,
      items: (page.items as unknown[]).map((item) => pickFields(item, keys)),
    };
  }
  return result;
}

const HOST_FIELDS = ["id", "name", "ip", "entryIp", "hostType", "online", "isOnline", "status", "agentVersion", "geoEmoji", "geoCountryName", "ownerName", "userId", "lastHeartbeat", "lastSeenAt", "cpuUsage", "memoryUsage", "trafficUsed", "expiresAt", "ruleCount"];
const RULE_FIELDS = ["id", "name", "hostId", "hostName", "userId", "forwardType", "protocol", "sourcePort", "targetIp", "targetPort", "isEnabled", "status", "runtimeStatus", "tunnelId", "forwardGroupId", "failoverEnabled", "entryAddress", "lastError"];
const TUNNEL_FIELDS = ["id", "name", "mode", "protocol", "entryHostId", "exitHostId", "entryHostName", "exitHostName", "isEnabled", "status", "latencyMs", "userId"];
const GROUP_FIELDS = ["id", "name", "groupMode", "mode", "isEnabled", "memberCount", "members", "status", "activeMemberId"];
const USER_FIELDS = ["id", "username", "name", "email", "role", "accountEnabled", "canAddRules", "trafficUsed", "trafficLimit", "expiresAt", "ruleCount", "lastLoginAt", "createdAt"];

/** 线路板一项的摘要：完整的 routeStatus 太深（逐跳的速率、拨号统计），列表里只留判断「好不好」要的。 */
function compactLineStatus(status: any) {
  if (!status || typeof status !== "object") return { status: null };
  const paths = Array.isArray(status.paths) ? status.paths : [];
  return {
    mode: status.policy?.mode ?? null,
    activeIndex: status.activeIndex ?? -1,
    entry: status.entry ? { hostId: status.entry.hostId, name: status.entry.name, online: status.entry.online } : null,
    agentStale: !!status.agentStale,
    paths: paths.map((path: any) => ({
      letter: path.letter,
      name: path.name,
      active: !!path.active,
      healthy: path.healthy ?? null,
      down: !!path.down,
      downReason: path.downReason || null,
      score: path.score ?? null,
      latencyMs: path.latencyMs ?? null,
      lossPct: path.lossPct ?? null,
      jitterMs: path.jitterMs ?? null,
      hops: Array.isArray(path.hops) ? path.hops.map((hop: any) => hop?.name).join(" > ") : "",
    })),
  };
}

// ---------- 工具 ----------

const pageArgs = {
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
  search: z.string().max(200).optional(),
};
const pageSchema = {
  page: { type: "integer", minimum: 1, description: "第几页，从 1 开始，默认 1" },
  pageSize: { type: "integer", minimum: 1, maximum: 100, description: "每页条数，默认 20" },
  search: { type: "string", description: "按名称 / 地址搜索，可留空" },
};
const idSchema = (description: string) => ({ type: "object", properties: { id: { type: "integer", minimum: 1, description } }, required: ["id"], additionalProperties: false });

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const MCP_TOOLS: McpTool[] = [
  {
    name: "list_hosts",
    description: "列出面板上的主机（服务器），含在线状态、地址、Agent 版本。普通用户只看得到自己的主机。",
    inputSchema: { type: "object", properties: pageSchema, additionalProperties: false },
    args: z.object(pageArgs).strict(),
    run: async (args, s) => compactPage(await s.invoke("hosts.listPage", { page: args.page ?? 1, pageSize: args.pageSize ?? 20, search: args.search ?? "" }), HOST_FIELDS),
  },
  {
    name: "get_host",
    description: "查看一台主机的完整信息（配置、计费、流量、端口范围等）。",
    inputSchema: idSchema("主机 ID"),
    args: z.object({ id: z.number().int().positive() }).strict(),
    run: async (args, s) => (await s.invoke("hosts.getById", { id: args.id })) ?? { error: "主机不存在或无权查看" },
  },
  {
    name: "list_rules",
    description: "列出转发规则，可按名称、端口或目标地址搜索。管理员传 scope=all 可看所有人的规则。",
    inputSchema: {
      type: "object",
      properties: { ...pageSchema, scope: { type: "string", enum: ["self", "all"], description: "self = 只看自己的（默认），all = 所有人的（仅管理员）" } },
      additionalProperties: false,
    },
    args: z.object({ ...pageArgs, scope: z.enum(["self", "all"]).optional() }).strict(),
    run: async (args, s) => compactPage(await s.invoke("rules.listPage", {
      page: args.page ?? 1,
      pageSize: args.pageSize ?? 20,
      search: args.search ?? "",
      category: "all",
      ...(args.scope ? { scope: args.scope } : {}),
    }), RULE_FIELDS),
  },
  {
    name: "get_rule",
    description: "查看一条转发规则的完整配置（入口、目标、协议、主备线路等）。",
    inputSchema: idSchema("规则 ID"),
    args: z.object({ id: z.number().int().positive() }).strict(),
    run: async (args, s) => (await s.invoke("rules.getById", { id: args.id })) ?? { error: "规则不存在或无权查看" },
  },
  {
    name: "get_rule_test",
    description: "读取一条规则最近一次诊断（自测）的结果：从入口一段段测到目标的连通性和延迟。",
    inputSchema: { type: "object", properties: { ruleId: { type: "integer", minimum: 1, description: "规则 ID" } }, required: ["ruleId"], additionalProperties: false },
    args: z.object({ ruleId: z.number().int().positive() }).strict(),
    run: async (args, s) => (await s.invoke("rules.latestTest", { ruleId: args.ruleId })) ?? { message: "这条规则还没有诊断过" },
  },
  {
    name: "diagnose_rule",
    description: "对一条规则发起一次诊断（和网页上「诊断」按钮相同），等待最多约 30 秒后返回结果；没等到就返回「已发出」，稍后用 get_rule_test 查看。",
    inputSchema: { type: "object", properties: { ruleId: { type: "integer", minimum: 1, description: "规则 ID" } }, required: ["ruleId"], additionalProperties: false },
    mutation: true,
    args: z.object({ ruleId: z.number().int().positive() }).strict(),
    run: async (args, s) => {
      const started = (await s.invoke("rules.startSelfTest", { ruleId: args.ruleId })) as { id?: number } | null;
      const startedId = Number(started?.id || 0);
      const deadline = Date.now() + (s.pollTimeoutMs ?? 30_000);
      const interval = s.pollIntervalMs ?? 2_000;
      while (Date.now() < deadline) {
        await sleep(interval);
        const latest = (await s.invoke("rules.latestTest", { ruleId: args.ruleId })) as Record<string, unknown> | null;
        if (!latest) continue;
        const status = String(latest.status || "");
        if (status === "pending" || status === "running") continue;
        if (startedId > 0 && Number(latest.id || 0) < startedId) continue;
        return latest;
      }
      return { message: "诊断已发出，结果还没回来（Agent 可能离线或较忙），稍后用 get_rule_test 查看", testId: startedId || null };
    },
  },
  {
    name: "list_tunnels",
    description: "列出链路（隧道），含入口 / 出口主机和状态。",
    inputSchema: { type: "object", properties: pageSchema, additionalProperties: false },
    args: z.object(pageArgs).strict(),
    run: async (args, s) => compactPage(await s.invoke("tunnels.listPage", { page: args.page ?? 1, pageSize: args.pageSize ?? 20, search: args.search ?? "" }), TUNNEL_FIELDS),
  },
  {
    name: "list_route_groups",
    description: "列出转发组 / 线路组（端口组、主备组、链路组等）及其成员。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    args: z.object({}).strict(),
    run: async (_args, s) => compactPage(await s.invoke("forwardGroups.list"), GROUP_FIELDS),
  },
  {
    name: "list_lines",
    description: "列出开了线路组（多条线路 / 主备 / 智能择优）的规则，每条带当前走哪条线路、各线路的评分、延迟、丢包和是否异常。管理员传 scope=all 可看所有人的。",
    inputSchema: {
      type: "object",
      properties: { scope: { type: "string", enum: ["self", "all"], description: "self = 只看自己的（默认），all = 所有人的（仅管理员）" } },
      additionalProperties: false,
    },
    args: z.object({ scope: z.enum(["self", "all"]).optional() }).strict(),
    run: async (args, s) => {
      const items = await s.invoke("rules.routeBoard", args.scope ? { scope: args.scope } : {});
      return Array.isArray(items) ? items.map((item: any) => ({ ruleId: item?.ruleId, name: item?.name, userName: item?.userName ?? null, ...compactLineStatus(item?.status) })) : items;
    },
  },
  {
    name: "get_line",
    description: "查看一条线路组规则此刻的线路状态：每条线路走哪几跳、拨哪个地址、评分 / 延迟 / 丢包 / 抖动 / 可用率、哪一跳断了、现在走的是哪条、最近切了几次。",
    inputSchema: { type: "object", properties: { ruleId: { type: "integer", minimum: 1, description: "规则 ID（list_lines 可查）" } }, required: ["ruleId"], additionalProperties: false },
    args: z.object({ ruleId: z.number().int().positive() }).strict(),
    run: async (args, s) => (await s.invoke("rules.routeStatus", { ruleId: args.ruleId })) ?? { message: "这条规则没有开线路组" },
  },
  {
    name: "get_line_events",
    description: "读取一条线路组规则最近的线路事件（切换、异常、恢复、预热、预检没过、人工指定等），最新的在前，原因已翻成人话。",
    inputSchema: {
      type: "object",
      properties: {
        ruleId: { type: "integer", minimum: 1, description: "规则 ID" },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "最多几条，默认 30" },
      },
      required: ["ruleId"],
      additionalProperties: false,
    },
    args: z.object({ ruleId: z.number().int().positive(), limit: z.number().int().min(1).max(100).optional() }).strict(),
    run: async (args, s) => s.invoke("rules.routeEvents", { ruleId: args.ruleId, limit: args.limit ?? 30 }),
  },
  {
    name: "export_line",
    description: "导出一条线路组规则的完整诊断资料（只读）：此刻的线路状态、最近 N 小时的线路事件和每条线路的质量历史（延迟、丢包、评分走势）。排查「线路时好时坏」时用它。",
    inputSchema: {
      type: "object",
      properties: {
        ruleId: { type: "integer", minimum: 1, description: "规则 ID" },
        hours: { type: "integer", minimum: 1, maximum: 168, description: "最近几小时，默认 24，最多 168（7 天）" },
      },
      required: ["ruleId"],
      additionalProperties: false,
    },
    args: z.object({ ruleId: z.number().int().positive(), hours: z.number().int().min(1).max(168).optional() }).strict(),
    run: async (args, s) => {
      const exported = (await s.invoke("lineDiagnostics.lineExport", { ruleId: args.ruleId, format: "json", hours: args.hours ?? 24 })) as { body?: unknown } | null;
      if (!exported || typeof exported.body !== "string") return exported ?? { error: "导出失败" };
      // body 是 JSON 文本；解析回对象交出去（直接给字符串会被截断成 2000 字）。
      try {
        return JSON.parse(exported.body);
      } catch {
        return { error: "导出的内容不是合法 JSON" };
      }
    },
  },
  {
    name: "dashboard_stats",
    description: "总览页的统计数字：主机、规则、在线数、流量等。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    args: z.object({}).strict(),
    run: async (_args, s) => s.invoke("dashboard.stats"),
  },
  {
    name: "list_users",
    description: "列出面板用户（仅管理员），含角色、是否停用、流量。",
    inputSchema: { type: "object", properties: { page: pageSchema.page, pageSize: pageSchema.pageSize }, additionalProperties: false },
    adminOnly: true,
    args: z.object({ page: pageArgs.page, pageSize: pageArgs.pageSize }).strict(),
    run: async (args, s) => compactPage(await s.invoke("users.listPage", { page: args.page ?? 1, pageSize: args.pageSize ?? 20 }), USER_FIELDS),
  },
  {
    name: "get_events",
    description: "读取面板事件时间线（主机掉线 / 恢复、规则出错、流量用尽、登录等），最新的在前。",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100, description: "最多几条，默认 50" },
        minLevel: { type: "string", enum: ["info", "warn", "crit"], description: "至少这个级别，warn 表示只看警告和严重" },
        hostId: { type: "integer", minimum: 1, description: "只看这台主机的事件" },
      },
      additionalProperties: false,
    },
    adminOnly: true,
    args: z.object({
      limit: z.number().int().min(1).max(100).optional(),
      minLevel: z.enum(["info", "warn", "crit"]).optional(),
      hostId: z.number().int().positive().optional(),
    }).strict(),
    run: async (args, s) => {
      try {
        // ops.events.list 的级别只有「全部 / 只看警告」两档：info → all，warn / crit → warn（含严重）
        return await s.invoke("ops.events.list", { limit: args.limit ?? 50, minLevel: args.minLevel && args.minLevel !== "info" ? "warn" : "all", ...(args.hostId ? { hostId: args.hostId } : {}) });
      } catch (error) {
        // 事件接口由另一项功能提供；没有这个过程（或参数形状不同）时给一句人话，而不是一串 tRPC 报错。
        const message = error instanceof Error ? error.message : String(error);
        if (/No procedure found|NOT_FOUND|not found/i.test(message)) return { message: "这个面板版本还没有事件接口" };
        throw error;
      }
    },
  },
  {
    name: "get_fault_bundle",
    description: "打包一条规则 / 一条隧道 / 一个转发组的故障信息（只读，不给主机派任务）：面板侧诊断结论、脱敏后的配置、沿线主机状态、最近一次自测、近 24 小时探测统计；管理员还包含沿线主机最近的事件和这个资源的配置变更。排查「某条规则不通」时先调它。",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["rule", "tunnel", "forwardGroup"], description: "rule = 转发规则，tunnel = 隧道，forwardGroup = 转发组 / 转发链" },
        id: { type: "integer", minimum: 1, description: "资源 ID" },
      },
      required: ["kind", "id"],
      additionalProperties: false,
    },
    args: z.object({ kind: z.enum(["rule", "tunnel", "forwardGroup"]), id: z.number().int().positive() }).strict(),
    run: async (args, s) => ((await s.invoke("diagnostics.faultBundle", { kind: args.kind, id: args.id })) as any)?.bundle ?? { error: "取不到故障包" },
  },
  {
    name: "get_fault_board",
    description: "故障看板（仅管理员）：在线主机数、最近告警、自动恢复次数、正在告警的项目（离线主机、资源告警、隧道丢包）。",
    inputSchema: { type: "object", properties: { hours: { type: "integer", enum: [24, 72, 168], description: "统计最近几小时，默认 24" } }, additionalProperties: false },
    adminOnly: true,
    args: z.object({ hours: z.union([z.literal(24), z.literal(72), z.literal(168)]).optional() }).strict(),
    run: async (args, s) => s.invoke("ops.faultBoard.summary", { hours: args.hours ?? 24 }),
  },
  {
    name: "get_ops_board",
    description: "运维看板（仅管理员）：今天 / 7 天 / 30 天的实收、订单状态、余额充值与消耗、每天流量、流量最多的规则、来源 IP 排行和地区分布。",
    inputSchema: { type: "object", properties: { range: { type: "integer", enum: [1, 7, 30], description: "天数，默认 7" } }, additionalProperties: false },
    adminOnly: true,
    args: z.object({ range: z.union([z.literal(1), z.literal(7), z.literal(30)]).optional() }).strict(),
    run: async (args, s) => s.invoke("ops.board.summary", { range: args.range ?? 7 }),
  },
  {
    name: "set_rule_enabled",
    description: "启用或停用一条转发规则。停用会立刻断开这条规则上所有正在进行的连接。",
    inputSchema: {
      type: "object",
      properties: { id: { type: "integer", minimum: 1, description: "规则 ID" }, enabled: { type: "boolean", description: "true 启用，false 停用" } },
      required: ["id", "enabled"],
      additionalProperties: false,
    },
    mutation: true,
    args: z.object({ id: z.number().int().positive(), enabled: z.boolean() }).strict(),
    run: async (args, s) => s.invoke("rules.toggle", { id: args.id, isEnabled: args.enabled }),
  },
  {
    name: "create_rule",
    description: "在一台主机上新建一条端口转发规则（直连）：入口端口 → 目标地址:端口。校验、配额和端口冲突检查与网页相同。",
    inputSchema: {
      type: "object",
      properties: {
        hostId: { type: "integer", minimum: 1, description: "入口主机 ID（list_hosts 可查）" },
        sourcePort: { type: "integer", minimum: 0, maximum: 65535, description: "入口端口，0 = 随机分配" },
        targetIp: { type: "string", description: "目标 IP 或域名" },
        targetPort: { type: "integer", minimum: 1, maximum: 65535, description: "目标端口" },
        protocol: { type: "string", enum: ["tcp", "udp", "both"], description: "默认 both" },
        forwardType: { type: "string", enum: ["iptables", "nftables", "realm", "socat", "gost", "nginx"], description: "转发方式，默认 iptables" },
        name: { type: "string", description: "规则名，留空自动生成" },
      },
      required: ["hostId", "sourcePort", "targetIp", "targetPort"],
      additionalProperties: false,
    },
    mutation: true,
    args: z.object({
      hostId: z.number().int().positive(),
      sourcePort: z.number().int().min(0).max(65535),
      targetIp: z.string().min(1).max(253),
      targetPort: z.number().int().min(1).max(65535),
      protocol: z.enum(["tcp", "udp", "both"]).optional(),
      forwardType: z.enum(["iptables", "nftables", "realm", "socat", "gost", "nginx"]).optional(),
      name: z.string().max(128).optional(),
    }).strict(),
    run: async (args, s) => s.invoke("rules.create", {
      hostId: args.hostId,
      sourcePort: args.sourcePort,
      targetIp: args.targetIp.trim(),
      targetPort: args.targetPort,
      ...(args.protocol ? { protocol: args.protocol } : {}),
      ...(args.forwardType ? { forwardType: args.forwardType } : {}),
      ...(args.name ? { name: args.name } : {}),
    }),
  },
  {
    name: "reset_user_traffic",
    description: "把一个用户本周期已用流量清零（仅管理员）。因流量用尽被暂停的转发会恢复。",
    inputSchema: { type: "object", properties: { userId: { type: "integer", minimum: 1, description: "用户 ID" } }, required: ["userId"], additionalProperties: false },
    mutation: true,
    adminOnly: true,
    args: z.object({ userId: z.number().int().positive() }).strict(),
    run: async (args, s) => s.invoke("users.resetTraffic", { userId: args.userId }),
  },
];

function toolUsable(tool: McpTool, session: McpSession) {
  if (tool.adminOnly && !session.isAdmin) return false;
  if (tool.mutation && session.scope !== "full") return false;
  return true;
}

export function listMcpTools(session: McpSession) {
  return MCP_TOOLS.filter((tool) => toolUsable(tool, session)).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.mutation ? { annotations: { readOnlyHint: false, destructiveHint: tool.name === "set_rule_enabled" } } : { annotations: { readOnlyHint: true } }),
  }));
}

function toolText(value: unknown, isError = false) {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(sanitizeForMcp(value), null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

/** tools/call：工具自己的失败（没权限、参数不对、过程报错）按 MCP 约定放进结果里 isError，而不是 JSON-RPC 错误。 */
export async function callMcpTool(name: string, rawArgs: unknown, session: McpSession) {
  const tool = MCP_TOOLS.find((item) => item.name === name);
  if (!tool) return null;
  if (tool.mutation && session.scope !== "full") return toolText(`${API_TOKEN_READ_ONLY_MESSAGE}（${tool.name} 会修改数据，需要「完全」权限的令牌）`, true);
  if (tool.adminOnly && !session.isAdmin) return toolText("这个工具只有管理员能用", true);
  const parsed = tool.args.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "参数"}：${issue.message}`).join("；");
    return toolText(`参数不对：${issues}`, true);
  }
  try {
    return toolText(await tool.run(parsed.data, session));
  } catch (error) {
    return toolText(error instanceof Error ? error.message : String(error), true);
  }
}

function rpcError(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function negotiateProtocolVersion(requested: unknown) {
  return typeof requested === "string" && (MCP_SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : MCP_DEFAULT_PROTOCOL_VERSION;
}

/** 处理一条 JSON-RPC 消息。通知（没有 id）和客户端发来的响应返回 null —— 不需要回。 */
export async function handleMcpMessage(message: unknown, session: McpSession): Promise<JsonRpcResponse | null> {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return rpcError(null, JSON_RPC_INVALID_REQUEST, "Invalid Request");
  }
  const msg = message as Record<string, unknown>;
  const hasId = Object.prototype.hasOwnProperty.call(msg, "id") && msg.id !== undefined;
  const id = (hasId ? msg.id : null) as JsonRpcId;
  if (msg.jsonrpc !== "2.0") return hasId ? rpcError(id, JSON_RPC_INVALID_REQUEST, "Invalid Request") : null;
  // 客户端对我们请求的响应（我们从不发请求），忽略。
  if (typeof msg.method !== "string") return hasId && !("result" in msg || "error" in msg) ? rpcError(id, JSON_RPC_INVALID_REQUEST, "Invalid Request") : null;
  const method = msg.method;
  const params = (msg.params && typeof msg.params === "object" ? msg.params : {}) as Record<string, unknown>;

  if (!hasId) return null; // notifications/initialized、notifications/cancelled 等：收下即可

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: negotiateProtocolVersion(params.protocolVersion),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: MCP_SERVER_NAME, title: "NEX 面板", version: APP_VERSION },
          instructions: "NEX 是端口转发 / 隧道管理面板。用 list_hosts、list_rules 找到 ID，再用 get_* 看详情；会修改数据的工具需要「完全」权限的令牌。",
        },
      };
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: listMcpTools(session) } };
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const result = await callMcpTool(name, params.arguments, session);
      if (!result) return rpcError(id, JSON_RPC_INVALID_PARAMS, `Unknown tool: ${name}`);
      return { jsonrpc: "2.0", id, result };
    }
    default:
      return rpcError(id, JSON_RPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

/**
 * 处理一次 POST 的请求体（单条或批量）。返回 HTTP 状态和要回的 JSON；
 * 全是通知 / 响应时是 202 无正文。
 */
export async function handleMcpPayload(body: unknown, session: McpSession): Promise<{ status: number; body?: unknown }> {
  if (body === undefined || body === null || (typeof body !== "object")) {
    return { status: 400, body: rpcError(null, JSON_RPC_PARSE_ERROR, "Parse error") };
  }
  if (Array.isArray(body)) {
    if (body.length === 0) return { status: 400, body: rpcError(null, JSON_RPC_INVALID_REQUEST, "Invalid Request") };
    const responses = (await Promise.all(body.slice(0, 50).map((item) => handleMcpMessage(item, session)))).filter(Boolean);
    return responses.length ? { status: 200, body: responses } : { status: 202 };
  }
  const response = await handleMcpMessage(body, session);
  return response ? { status: 200, body: response } : { status: 202 };
}
