/*
  各云厂商换 IP 实现共用的小工具：带超时的 HTTP、轮询、输入校验、IP 校验、密钥脱敏。

  约定：
  - 所有请求都走 ctx.fetch（测试里会换成假的），超时 = AbortSignal.timeout 叠加 ctx.signal。
  - 会改动云上资源的请求（mutating）如果出了网络错误 / 超时 / 5xx，结果是未知的：
    抛 ambiguous 错误，调用方不要盲目重发，先查状态。
  - 每个 provider 用 defineProvider 包一层：日志和错误消息里出现的凭据原文一律替换成 ***。
*/
import { isIP } from "node:net";
import { randomBytes } from "node:crypto";

import {
  IpChangeProviderError,
  type IpChangeContext,
  type IpChangeCredentials,
  type IpChangeFieldDef,
  type IpChangeProvider,
  type IpChangeTarget,
} from "./types";

export const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
export const DEFAULT_POLL_INTERVAL_MS = 5_000;
export const DEFAULT_POLL_TIMEOUT_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// 脱敏
// ---------------------------------------------------------------------------

/** 从凭据里收集所有可能泄露的敏感字符串（整值、多行值的每一行、JSON 里的长字符串）。 */
export function collectSecrets(credentials: IpChangeCredentials, fields: IpChangeFieldDef[]): string[] {
  const out = new Set<string>();
  const add = (value: unknown) => {
    const text = String(value ?? "").trim();
    if (text.length >= 6) out.add(text);
  };
  for (const [key, raw] of Object.entries(credentials || {})) {
    const value = String(raw ?? "");
    const def = fields.find((field) => field.key === key);
    add(value);
    if (def?.type === "textarea" || value.includes("\n")) {
      for (const line of value.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.length >= 16) out.add(trimmed);
        // "Name: value" 形式的请求头：值本身也要藏
        const colon = trimmed.indexOf(":");
        if (colon > 0) {
          const headerValue = trimmed.slice(colon + 1);
          add(headerValue);
          // "Bearer xxx" 这类：单独的令牌也要藏
          for (const word of headerValue.trim().split(/\s+/)) if (word.length >= 8) out.add(word);
        }
      }
      try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === "object") {
          for (const inner of Object.values(parsed)) {
            if (typeof inner !== "string") continue;
            if (inner.length >= 16) out.add(inner.trim());
            for (const line of inner.split(/\r?\n/)) if (line.trim().length >= 16) out.add(line.trim());
          }
        }
      } catch {
        /* 不是 JSON */
      }
    }
  }
  // 长的先替换，避免短串先把长串切碎后漏网
  return [...out].sort((a, b) => b.length - a.length);
}

export function scrubText(text: string, secrets: string[]): string {
  let out = String(text ?? "");
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join("***");
  }
  return out;
}

function scrubError(error: unknown, secrets: string[]): IpChangeProviderError {
  if (error instanceof IpChangeProviderError) {
    const message = scrubText(error.message, secrets);
    if (message === error.message) return error;
    return new IpChangeProviderError(message, error.options);
  }
  const message = scrubText(error instanceof Error ? error.message : String(error), secrets);
  return new IpChangeProviderError(`内部错误：${message}`, { retryable: false });
}

/** 给 provider 的三个方法套上：日志 / 错误脱敏，非 IpChangeProviderError 的异常统一包装。 */
export function defineProvider(provider: IpChangeProvider): IpChangeProvider {
  const wrapCtx = (ctx: IpChangeContext, secrets: string[]): IpChangeContext => ({
    ...ctx,
    log: (message: string) => ctx.log(scrubText(message, secrets)),
  });
  return {
    ...provider,
    async testCredentials(credentials, target, ctx) {
      const secrets = collectSecrets(credentials, provider.credentialFields);
      try {
        return await provider.testCredentials(credentials, target, wrapCtx(ctx, secrets));
      } catch (error) {
        throw scrubError(error, secrets);
      }
    },
    async getCurrentIp(credentials, target, ctx) {
      const secrets = collectSecrets(credentials, provider.credentialFields);
      try {
        return await provider.getCurrentIp(credentials, target, wrapCtx(ctx, secrets));
      } catch (error) {
        throw scrubError(error, secrets);
      }
    },
    async changeIp(credentials, target, ctx, options) {
      const secrets = collectSecrets(credentials, provider.credentialFields);
      try {
        const result = await provider.changeIp(credentials, target, wrapCtx(ctx, secrets), options);
        return { ...result, notes: result.notes.map((note) => scrubText(note, secrets)) };
      } catch (error) {
        throw scrubError(error, secrets);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 输入校验
// ---------------------------------------------------------------------------

export function invalidInput(message: string): IpChangeProviderError {
  return new IpChangeProviderError(message, { retryable: false });
}

export function readField(source: Record<string, string> | undefined, key: string): string {
  return String(source?.[key] ?? "").trim();
}

export function requireField(source: Record<string, string> | undefined, key: string, label: string): string {
  const value = readField(source, key);
  if (!value) throw invalidInput(`缺少「${label}」`);
  return value;
}

/** 必填 + 正则校验；错误消息不带值本身（值可能是密钥）。 */
export function requirePattern(
  source: Record<string, string> | undefined,
  key: string,
  label: string,
  pattern: RegExp,
  hint: string,
): string {
  const value = requireField(source, key, label);
  if (!pattern.test(value)) throw invalidInput(`「${label}」格式不正确：${hint}`);
  return value;
}

export function optionalPattern(
  source: Record<string, string> | undefined,
  key: string,
  label: string,
  pattern: RegExp,
  hint: string,
): string {
  const value = readField(source, key);
  if (value && !pattern.test(value)) throw invalidInput(`「${label}」格式不正确：${hint}`);
  return value;
}

export function optionalInt(
  source: Record<string, string> | undefined,
  key: string,
  label: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = readField(source, key);
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw invalidInput(`「${label}」必须是整数`);
  const value = Number(raw);
  if (value < min || value > max) throw invalidInput(`「${label}」超出范围（${min}–${max}）`);
  return value;
}

export function optionalChoice(
  source: Record<string, string> | undefined,
  key: string,
  label: string,
  choices: readonly string[],
  fallback: string,
): string {
  const raw = readField(source, key);
  if (!raw) return fallback;
  if (!choices.includes(raw)) throw invalidInput(`「${label}」取值不正确，可选：${choices.join(" / ")}`);
  return raw;
}

/** 地域代码：小写字母数字和短横线，如 us-east-1 / cn-hangzhou / ap-guangzhou。 */
export const REGION_PATTERN = /^[a-z]{2}[a-z0-9-]{0,40}[a-z0-9]$/;
export const REGION_HINT = "应为小写字母、数字和短横线，例如 us-east-1";

// ---------------------------------------------------------------------------
// IP
// ---------------------------------------------------------------------------

export function assertIp(value: unknown, what: string): string {
  const text = String(value ?? "").trim();
  if (!text || isIP(text) === 0) {
    throw new IpChangeProviderError(`${what}返回的 IP 地址无效：${text.slice(0, 64) || "（空）"}`, { retryable: false, ambiguous: true });
  }
  return text;
}

/** 有值就必须是合法 IP，没值返回 null。 */
export function ipOrNull(value: unknown): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  return isIP(text) === 0 ? null : text;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export type HttpResponse = {
  status: number;
  headers: Headers;
  text: string;
  /** JSON 解析结果，解析不了是 null */
  json: any;
};

export type HttpRequestInput = {
  /** 用在错误消息里的服务名，例如「AWS EC2」 */
  label: string;
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** 会改云上资源：网络错误 / 超时 / 5xx 标成 ambiguous */
  mutating?: boolean;
};

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function cancelledError(label: string, mutating: boolean) {
  return new IpChangeProviderError(
    `${label}：操作已取消${mutating ? "（请求可能已经生效，请先查看实例当前状态）" : ""}`,
    { retryable: false, ambiguous: mutating },
  );
}

export async function httpRequest(ctx: IpChangeContext, input: HttpRequestInput): Promise<HttpResponse> {
  const mutating = Boolean(input.mutating);
  if (ctx.signal?.aborted) throw cancelledError(input.label, false);
  const timeoutMs = input.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = ctx.signal ? AbortSignal.any([timeout, ctx.signal]) : timeout;
  let status: number;
  let headers: Headers;
  let text: string;
  try {
    const resp = await ctx.fetch(input.url, {
      method: input.method,
      headers: input.headers,
      body: input.body,
      signal,
      redirect: "error",
    });
    status = resp.status;
    headers = resp.headers;
    text = await resp.text();
  } catch (error) {
    if (ctx.signal?.aborted) throw cancelledError(input.label, mutating);
    const name = (error as { name?: string } | null)?.name;
    const timedOut = name === "TimeoutError" || name === "AbortError" || timeout.aborted;
    const suffix = mutating ? "；请求可能已经生效，请先查看实例当前状态再决定是否重试" : "";
    if (timedOut) {
      throw new IpChangeProviderError(
        `${input.label}：请求超时（${Math.ceil(timeoutMs / 1000)} 秒无响应，${hostOf(input.url)}）${suffix}`,
        { retryable: true, ambiguous: mutating },
      );
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new IpChangeProviderError(`${input.label}：网络错误（${hostOf(input.url)}）：${truncate(detail, 200)}${suffix}`, {
      retryable: true,
      ambiguous: mutating,
    });
  }
  let json: any = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status, headers, text, json };
}

export function truncate(text: string, max = 300): string {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * HTTP 状态码转错误：5xx / 408 / 429 可重试；mutating 请求遇到 5xx / 408 结果未知。
 * authHint：401/403 时补一句去哪检查权限。
 */
export function httpStatusError(
  label: string,
  status: number,
  detail: string,
  options: { mutating?: boolean; authHint?: string } = {},
): IpChangeProviderError {
  const retryable = status >= 500 || status === 408 || status === 429;
  const ambiguous = Boolean(options.mutating) && (status >= 500 || status === 408);
  let message = `${label} 请求失败（HTTP ${status}）`;
  if (detail) message += `：${truncate(detail)}`;
  if ((status === 401 || status === 403) && options.authHint) message += `。${options.authHint}`;
  if (ambiguous) message += "；请求可能已经生效，请先查看实例当前状态";
  return new IpChangeProviderError(message, { retryable, ambiguous });
}

/** 把一个已有错误标成 ambiguous（例如：发出了修改请求，但随后的确认步骤失败）。 */
export function markAmbiguous(error: unknown, extra?: string): IpChangeProviderError {
  const base = error instanceof IpChangeProviderError ? error : new IpChangeProviderError(String((error as Error)?.message || error), { retryable: false });
  return new IpChangeProviderError(extra ? `${base.message}；${extra}` : base.message, {
    retryable: base.options.retryable,
    ambiguous: true,
  });
}

export function appendToError(error: unknown, extra: string): IpChangeProviderError {
  const base = error instanceof IpChangeProviderError ? error : new IpChangeProviderError(String((error as Error)?.message || error), { retryable: false });
  return new IpChangeProviderError(`${base.message}；${extra}`, base.options);
}

// ---------------------------------------------------------------------------
// 轮询 / 清理
// ---------------------------------------------------------------------------

/**
 * 每隔 intervalMs 检查一次，check 返回非空值即完成；最多 timeoutMs（按次数计，不依赖真实时钟，
 * 所以测试里把 sleep 换成空函数也不会死循环）。先等再查：异步操作刚提交时一般还没好。
 */
export async function pollUntil<T>(
  ctx: IpChangeContext,
  what: string,
  check: () => Promise<T | null | undefined | false>,
  options: { intervalMs?: number; timeoutMs?: number; immediate?: boolean } = {},
): Promise<T> {
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const attempts = Math.max(1, Math.ceil(timeoutMs / intervalMs));
  for (let i = 0; i < attempts; i += 1) {
    if (i > 0 || !options.immediate) await ctx.sleep(intervalMs);
    if (ctx.signal?.aborted) throw cancelledError(what, true);
    const result = await check();
    if (result !== null && result !== undefined && result !== false) return result as T;
  }
  throw new IpChangeProviderError(`等待${what}超时（${Math.round(timeoutMs / 1000)} 秒）；操作可能仍在进行，请到控制台确认`, {
    retryable: true,
    ambiguous: true,
  });
}

/** 尽力而为的清理：失败只记日志，返回是否成功。 */
export async function bestEffort(ctx: IpChangeContext, what: string, fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    ctx.log(`${what}：成功`);
    return true;
  } catch (error) {
    ctx.log(`${what}：失败：${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/** 新建资源用的名字后缀：时间戳 + 4 位随机十六进制，例如 20260101-120000-a1b2。 */
export function resourceSuffix(ctx: IpChangeContext): string {
  const iso = ctx.now().toISOString();
  const stamp = `${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 19).replace(/:/g, "")}`;
  return `${stamp}-${randomBytes(2).toString("hex")}`;
}

export function formEncode(params: Record<string, string>, encode: (value: string) => string): string {
  return Object.entries(params)
    .map(([key, value]) => `${encode(key)}=${encode(value)}`)
    .join("&");
}

export type { IpChangeTarget, IpChangeCredentials };
