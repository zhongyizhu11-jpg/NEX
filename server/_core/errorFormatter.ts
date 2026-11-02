import { randomBytes } from "node:crypto";
import { ZodError, type ZodIssue } from "zod";

/**
 * tRPC 的输入校验失败时，默认把整份 ZodError（一串 JSON）塞进 message，
 * 前端 toast 直接把它展示给用户。这里改写两类错误的 message：
 * 1. 输入校验失败：取第一条 issue，拼成「字段: 原因」。
 *    shape.data.zodError 保留完整 issue 列表，方便表单按字段标红。
 * 2. 没被业务代码接住的数据库驱动 / 系统报错（INTERNAL_SERVER_ERROR，原文像 SQLITE_、ER_、
 *    约束失败、SQL 片段、JS 运行时错误）：换成「操作失败，编号 xxx」，原文带编号写进面板日志。
 * 其它错误的 message 原样保留 —— 中文提示是故意给用户看的，
 * 前端还会解析一些错误码（LOGIN_RATE_LIMITED:N、SETUP_LOCKED 之类），不能动。
 */

const CJK_PATTERN = /[㐀-鿿]/;

function sizeUnit(type: string): string {
  if (type === "string") return "个字符";
  if (type === "array" || type === "set") return "项";
  return "";
}

/** 把一条 zod issue 翻成一句人话；schema 里自带中文提示的直接用。 */
export function zodIssueReason(issue: ZodIssue): string {
  const message = String(issue.message || "").trim();
  if (message && CJK_PATTERN.test(message)) return message;
  switch (issue.code) {
    case "invalid_type":
      return issue.received === "undefined" || issue.received === "null" ? "不能为空" : "类型不正确";
    case "too_small": {
      const min = Number(issue.minimum);
      if (issue.type === "string" && min === 1) return "不能为空";
      if (issue.type === "array" && min === 1) return "至少选择一项";
      const unit = sizeUnit(issue.type);
      if (unit) return `至少 ${min} ${unit}`;
      return issue.inclusive ? `不能小于 ${min}` : `必须大于 ${min}`;
    }
    case "too_big": {
      const max = Number(issue.maximum);
      const unit = sizeUnit(issue.type);
      if (unit) return `最多 ${max} ${unit}`;
      return issue.inclusive ? `不能大于 ${max}` : `必须小于 ${max}`;
    }
    case "invalid_string":
      return "格式不正确";
    case "invalid_enum_value":
    case "invalid_literal":
    case "invalid_union":
    case "invalid_union_discriminator":
      return "取值无效";
    case "not_multiple_of":
      return `必须是 ${String(issue.multipleOf)} 的倍数`;
    case "invalid_date":
      return "日期无效";
    case "unrecognized_keys":
      return "包含不支持的字段";
    default:
      return message || "取值无效";
  }
}

/** 第一条校验错误的可读描述，例如「name: 最多 128 个字符」。 */
export function zodErrorMessage(error: ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "输入参数无效";
  const path = issue.path.map(String).join(".");
  const reason = zodIssueReason(issue);
  return path ? `${path}: ${reason}` : `输入参数无效：${reason}`;
}

type ErrorFormatterInput<TShape> = {
  shape: TShape;
  error: { cause?: unknown; code?: string; message?: string };
  path?: string;
};

/** 前端会解析的错误码：全大写下划线，可带「:参数」，例如 LOGIN_RATE_LIMITED:5、SETUP_LOCKED。 */
const CLIENT_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+(?::\S*)?$/;
/** 驱动自己的错误码长得也像上面的错误码，要单独排除。 */
const DRIVER_CODE_PREFIX = /^(?:SQLITE_|ER_|E[A-Z]{3,}\b)/;
const DRIVER_MESSAGE_PATTERNS: RegExp[] = [
  /\bSQLITE_[A-Z_]+\b/,
  /\bER_[A-Z_]{3,}\b/,
  /constraint failed/i,
  /violates (?:unique|foreign key|not-null|check) constraint/i,
  /duplicate (?:key|entry)/i,
  /\bFailed query:/,
  /\bno such (?:table|column)\b/i,
  /\bsyntax error\b/i,
  /\brelation "[^"]*" does not exist/i,
  /\bcolumn "[^"]*" (?:of relation "[^"]*" )?does not exist/i,
  /\bdatabase (?:is locked|table is locked|disk image is malformed)\b/i,
  /\bdeadlock\b/i,
  /\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|EADDRINUSE|ENOENT|EACCES|EPERM)\b/,
  /\bCannot read propert(?:y|ies) of (?:undefined|null)\b/,
  /\bis not a function\b/,
  /\bis not defined\b/,
  /\bMaximum call stack size exceeded\b/,
  /^\s*at .+\(.+:\d+:\d+\)/m,
];

function errorCodeOf(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const code = (value as { code?: unknown }).code;
  return typeof code === "string" ? code : "";
}

/** 原始错误本身是不是驱动 / 运行时抛出来的（看 cause 链上的错误类型和错误码）。 */
function causeLooksLikeDriverError(cause: unknown): boolean {
  let current = cause;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    if (current instanceof TypeError || current instanceof ReferenceError || current instanceof RangeError || current instanceof SyntaxError) {
      return true;
    }
    const code = errorCodeOf(current);
    if (/^SQLITE_/.test(code) || /^ER_/.test(code)) return true;
    // PostgreSQL 的 SQLSTATE 是 5 位，驱动错误还带 severity / routine。
    if (/^[0-9A-Z]{5}$/.test(code) && ("severity" in current || "routine" in current)) return true;
    if ("sqlMessage" in current || "sqlState" in current) return true;
    if (/^E[A-Z]{3,}$/.test(code) && "syscall" in current) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * 判断一条 INTERNAL_SERVER_ERROR 的 message 要不要藏起来。
 * 中文提示、前端解析的错误码一律保留；只有像驱动 / 系统原文的才换掉。
 */
export function shouldMaskInternalErrorMessage(message: string, cause?: unknown): boolean {
  const text = String(message || "").trim();
  if (!text) return false;
  if (CJK_PATTERN.test(text)) return false;
  if (CLIENT_ERROR_CODE_PATTERN.test(text) && !DRIVER_CODE_PREFIX.test(text)) return false;
  if (DRIVER_MESSAGE_PATTERNS.some((pattern) => pattern.test(text))) return true;
  return causeLooksLikeDriverError(cause);
}

export function newInternalErrorId(): string {
  return randomBytes(4).toString("hex");
}

export function maskedInternalErrorMessage(errorId: string): string {
  return `操作失败，请稍后重试（编号 ${errorId}）`;
}

function describeForLog(error: unknown): string {
  if (error instanceof Error) return error.stack || `${error.name}: ${error.message}`;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function formatTrpcErrorShape<TShape extends { message: string; data: Record<string, unknown> }>(
  { shape, error, path }: ErrorFormatterInput<TShape>,
): TShape & { data: TShape["data"] & { zodError: ReturnType<ZodError["flatten"]> | null } } {
  const cause = error.cause;
  if (cause instanceof ZodError) {
    return {
      ...shape,
      message: zodErrorMessage(cause),
      data: { ...shape.data, zodError: cause.flatten() },
    };
  }
  const code = error.code ?? shape.data?.code;
  if (code === "INTERNAL_SERVER_ERROR" && shouldMaskInternalErrorMessage(shape.message, cause)) {
    const errorId = newInternalErrorId();
    // 面板日志接管了 console，这里带上编号，用户报编号就能在日志里找到原文。
    console.error(`[tRPC] 内部错误 编号=${errorId} path=${path || "-"}: ${describeForLog(cause ?? error)}`);
    return { ...shape, message: maskedInternalErrorMessage(errorId), data: { ...shape.data, zodError: null } };
  }
  return { ...shape, data: { ...shape.data, zodError: null } };
}
