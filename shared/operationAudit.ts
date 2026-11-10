/*
  操作审计（设置 / 用户 / 计费 / 套餐 / 令牌……所有改动都记一行），服务端和页面共用的那部分：
  输入怎么打码、过程路径叫什么中文名、结果怎么写。

  记的是「谁、什么时候、从哪儿、调了哪个过程、带了什么参数（打过码）、成没成」。规则 / 主机 / 隧道 /
  转发组这四样另有一份带 before / after 的配置审计（config_audit_events），两边用同一个 requestId 串起来，
  详情里一并展示，不在列表里出两行。
*/

export type OperationAuditResult = "ok" | "denied" | "error";
export type OperationAuditChannel = "web" | "api" | "mcp" | "telegram" | "internal";

export const OPERATION_AUDIT_RESULT_LABELS: Record<OperationAuditResult, string> = {
  ok: "成功",
  denied: "被拒绝",
  error: "失败",
};

export const OPERATION_AUDIT_CHANNEL_LABELS: Record<OperationAuditChannel, string> = {
  web: "网页",
  api: "API 令牌",
  mcp: "MCP",
  telegram: "Telegram 机器人",
  internal: "面板内部",
};

/** 保留天数的边界：至少 7 天（排查一次事故够用），最多 10 年。 */
export const OPERATION_AUDIT_RETENTION_DEFAULT_DAYS = 90;
export const OPERATION_AUDIT_RETENTION_MIN_DAYS = 7;
export const OPERATION_AUDIT_RETENTION_MAX_DAYS = 3650;
export const OPERATION_AUDIT_RETENTION_OPTIONS = [30, 90, 180, 365] as const;

export function normalizeOperationAuditRetentionDays(value: unknown): number {
  const days = Math.floor(Number(value));
  if (!Number.isFinite(days) || days <= 0) return OPERATION_AUDIT_RETENTION_DEFAULT_DAYS;
  return Math.min(OPERATION_AUDIT_RETENTION_MAX_DAYS, Math.max(OPERATION_AUDIT_RETENTION_MIN_DAYS, days));
}

// ── 打码 ────────────────────────────────────────────────────────────────

/** 参数摘要的上限（JSON 字符数）。超了只留前面一截，标上 _truncated。 */
export const OPERATION_AUDIT_INPUT_MAX_CHARS = 4096;
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 20;
const MAX_STRING_CHARS = 200;
export const AUDIT_REDACTED = "[已隐藏]";

/*
  键名按单词拆开看（camelCase / snake_case / kebab-case 都拆），命中其中一个就整项隐藏：
  只按子串匹配的话 hostKey / countryCode 这类正常字段全会被遮住，审计就看不出改了什么。
*/
const SECRET_WORDS = new Set([
  "password", "passwd", "pwd", "passphrase", "secret", "secrets", "token", "tokens", "pem", "credential",
  "credentials", "otp", "totp", "cookie", "cookies", "authorization", "signature", "mnemonic", "privkey", "jwt",
  "apikey", "accesskey", "secretkey", "privatekey", "sessionid", "sid", "captcha",
]);
/** 单词 key 出现时通常是密钥（apiKey、keyPem、accessKeyId）；下面这些前缀是界面上的普通键。 */
const NON_SECRET_KEY_PREFIX = /^(path|route|sort|group|line|series|cache|setting|storage|category|kind|protocol|region|section|tab|order|field|column|row|day|dedupe|idempotency|query|map|lookup|entry|exit)Key$/i;
/** 以 code 结尾时通常是验证码 / 绑定码；这些前缀是普通的代码字段。 */
const NON_SECRET_CODE_PREFIX = /^(country|currency|lang|language|locale|region|status|error|http|exit|color|discount|invite|referral|area|postal|zip|plan|product|unit|response|reason|iso)Code$/i;

function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

/** 这个键的值要不要藏起来。 */
export function isSecretAuditKey(key: string): boolean {
  const text = String(key || "");
  if (!text) return false;
  const words = keyWords(text);
  const joined = words.join("");
  if (SECRET_WORDS.has(joined)) return true;
  // 令牌的编号、数量上限不是令牌本身：tokenId、apiTokenIds、maxTokens、maxProxySubTokens
  const last = words[words.length - 1];
  if (words[0] === "max" || words[0] === "min") return false;
  if ((last === "id" || last === "ids") && words.some((word) => word === "token" || word === "tokens")) return false;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (SECRET_WORDS.has(word)) return true;
    // 两个词拼起来才是密钥的：private key、access key、api key、secret key
    if (index > 0 && SECRET_WORDS.has(`${words[index - 1]}${word}`)) return true;
  }
  if (words.includes("key") && !NON_SECRET_KEY_PREFIX.test(text)) return true;
  if ((text === "code" || /Code$/.test(text)) && !NON_SECRET_CODE_PREFIX.test(text)) return true;
  return false;
}

/** 不看键名也要藏的值：PEM、面板 / Agent 令牌、Bearer 头、JWT。 */
export function looksLikeSecretValue(value: string): boolean {
  const text = value.trim();
  if (!text) return false;
  if (/-----BEGIN [A-Z ]*(PRIVATE KEY|CERTIFICATE)-----/.test(text)) return true;
  if (/^(nex|fx|fxa)_[A-Za-z0-9_-]{16,}$/.test(text)) return true;
  if (/^Bearer\s+\S{8,}$/i.test(text)) return true;
  if (/^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(text)) return true;
  return false;
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") {
    if (looksLikeSecretValue(value)) return AUDIT_REDACTED;
    return value.length > MAX_STRING_CHARS ? `${value.slice(0, MAX_STRING_CHARS)}…（共 ${value.length} 字）` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value !== "object") return String(value);
  // seen 只放从根到这里的这一串祖先：同一个对象在两处出现（superjson 会还原共享引用）不算循环
  if (seen.has(value as object)) return "[循环引用]";
  if (depth >= MAX_DEPTH) return "[…]";
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) return `[二进制 ${value.length} 字节]`;
  seen.add(value as object);
  try {
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => redactValue(item, depth + 1, seen));
      if (value.length > MAX_ARRAY_ITEMS) items.push(`…另 ${value.length - MAX_ARRAY_ITEMS} 项`);
      return items;
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) continue;
      // 开关（clearBotToken: true）藏了也没意义，还看不出这次清掉了密钥
      const hide = isSecretAuditKey(key) && typeof item !== "boolean" && item !== null && item !== "";
      out[key] = hide ? AUDIT_REDACTED : redactValue(item, depth + 1, seen);
    }
    return out;
  } finally {
    seen.delete(value as object);
  }
}

/** 参数打码：键名像密钥的整项隐藏，值像 PEM / 令牌的也隐藏，长串截断，层级、数组长度封顶。 */
export function redactAuditInput(value: unknown): unknown {
  return redactValue(value, 0, new WeakSet());
}

/** 打码后转成存库的 JSON：超过上限只留前一截（仍是合法 JSON）。没有参数是 null。 */
export function serializeAuditInput(value: unknown): string | null {
  if (value === undefined) return null;
  let json: string;
  try {
    json = JSON.stringify(redactAuditInput(value));
  } catch {
    return JSON.stringify({ _unserializable: true });
  }
  if (json === undefined) return null;
  if (json.length <= OPERATION_AUDIT_INPUT_MAX_CHARS) return json;
  // preview 本身是字符串，引号、反斜杠会被再转义一次，截完再量一遍，超了接着缩
  let cut = OPERATION_AUDIT_INPUT_MAX_CHARS - 64;
  for (;;) {
    const out = JSON.stringify({ _truncated: true, preview: json.slice(0, Math.max(0, cut)) });
    if (out.length <= OPERATION_AUDIT_INPUT_MAX_CHARS || cut <= 0) return out;
    cut -= out.length - OPERATION_AUDIT_INPUT_MAX_CHARS + 16;
  }
}

// ── 过程路径 → 模块名 ─────────────────────────────────────────────────────

/** 路径的模块部分：rules.update → rules；ops.firewall.blockIp → ops.firewall；ipChange.accounts.create → ipChange.accounts */
export function operationAuditModule(path: string): string {
  const parts = String(path || "").split(".").filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join(".") : parts[0] || "";
}

/** 筛选下拉里的模块，按页面上的叫法。没列到的模块显示原始路径前缀。 */
export const OPERATION_AUDIT_MODULE_LABELS: Record<string, string> = {
  system: "系统设置",
  users: "用户",
  plans: "套餐",
  billing: "计费",
  payment: "支付",
  trafficBilling: "流量计费",
  referral: "推广返利",
  hosts: "主机",
  agentRuntime: "Agent 运行",
  rules: "转发规则",
  tunnels: "隧道",
  forwardGroups: "转发组",
  nodePools: "节点池",
  lineDiagnostics: "线路",
  agentTokens: "Agent 令牌",
  proxyInbounds: "代理入站",
  tlsInbounds: "TLS 入站",
  proxySubscriptions: "订阅",
  announcements: "公告",
  tickets: "工单",
  plugins: "插件",
  telegram: "Telegram",
  googleAuth: "Google 登录",
  discordAuth: "Discord",
  dnsRecords: "DNS 解析记录",
  auth: "账号",
  "ipChange.accounts": "换 IP · 云账号",
  "ipChange.hosts": "换 IP · 主机",
  ipChange: "换 IP",
  "ops.apiTokens": "API 令牌",
  "ops.passkeys": "通行密钥",
  "ops.sessions": "登录设备",
  "ops.firewall": "防火墙",
  "ops.webhooks": "Webhook",
  "ops.digest": "日报",
  "ops.hostSecurity": "安全巡检",
  "ops.agentRelay": "Agent 中转",
  "ops.hostOps": "主机运维",
  "ops.maintenance": "维护模式",
  "ops.offsiteBackup": "异地备份",
  "ops.quotaPolicy": "额度策略",
  "ops.resourceAlert": "资源告警",
  "ops.audit": "操作审计",
};

export function operationAuditModuleLabel(module: string): string {
  return OPERATION_AUDIT_MODULE_LABELS[module] || module;
}
