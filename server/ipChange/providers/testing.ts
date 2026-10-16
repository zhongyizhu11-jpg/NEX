/*
  单测用的假 fetch：按顺序声明期望的请求，逐个比对 method / URL，记录请求头和 body，返回预设响应。
  多出来或少了请求都会让测试失败，所以每个 provider 的测试都能断言完整的请求序列。
*/
import assert from "node:assert/strict";

import type { IpChangeContext } from "./types";

export type RecordedRequest = {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string;
  /** body 是 JSON 时的解析结果 */
  json: any;
  /** body 是表单时的解析结果 */
  form: URLSearchParams;
};

export type ExpectedCall = {
  method: string;
  /** 完整 URL 字符串（忽略查询串顺序时请用函数）/ 正则 / 判断函数 */
  url: string | RegExp | ((url: URL) => boolean);
  check?: (req: RecordedRequest) => void;
  status?: number;
  json?: unknown;
  /** 按请求动态生成 JSON 响应（优先于 json） */
  reply?: (req: RecordedRequest) => unknown;
  text?: string;
  headers?: Record<string, string>;
  /** 模拟网络错误 */
  error?: Error;
};

export function createMockContext(expected: ExpectedCall[], options: { now?: Date } = {}) {
  const queue = [...expected];
  const requests: RecordedRequest[] = [];
  const logs: string[] = [];
  const sleeps: number[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = String(init?.method || "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers as HeadersInit | undefined).forEach((value, key) => {
      headers[key] = value;
    });
    const body = typeof init?.body === "string" ? init.body : "";
    let json: any = null;
    try {
      json = body ? JSON.parse(body) : null;
    } catch {
      json = null;
    }
    const req: RecordedRequest = { method, url, headers, body, json, form: new URLSearchParams(body) };
    requests.push(req);
    const next = queue.shift();
    assert.ok(next, `多出来的请求：${method} ${url.href}`);
    assert.equal(method, next.method.toUpperCase(), `第 ${requests.length} 个请求的方法不对：${url.href}`);
    if (typeof next.url === "string") assert.equal(url.href, new URL(next.url).href, `第 ${requests.length} 个请求的 URL 不对`);
    else if (next.url instanceof RegExp) assert.match(url.href, next.url, `第 ${requests.length} 个请求的 URL 不对`);
    else assert.ok(next.url(url), `第 ${requests.length} 个请求的 URL 不对：${url.href}`);
    next.check?.(req);
    if (next.error) throw next.error;
    const status = next.status ?? 200;
    const payload = next.reply ? next.reply(req) : next.json;
    const text = next.text ?? (payload === undefined ? "" : JSON.stringify(payload));
    const nullBody = status === 204 || status === 304;
    return new Response(nullBody ? null : text, { status, headers: next.headers });
  }) as typeof fetch;
  const ctx: IpChangeContext = {
    fetch: fakeFetch,
    now: () => options.now ?? new Date("2026-10-15T08:00:00Z"),
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    log: (message: string) => {
      logs.push(message);
    },
  };
  return {
    ctx,
    requests,
    logs,
    sleeps,
    assertDone() {
      assert.equal(queue.length, 0, `还有 ${queue.length} 个期望的请求没发出：${queue.map((c) => `${c.method} ${String(c.url)}`).join(" | ")}`);
    },
  };
}

/** 断言一个 Promise 以 IpChangeProviderError 失败，并返回该错误以便继续断言。 */
export async function rejectsWith(promise: Promise<unknown>, pattern: RegExp) {
  let caught: any;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, "应该抛错");
  assert.equal(caught.name, "IpChangeProviderError", `错误类型不对：${caught?.name} ${caught?.message}`);
  assert.match(caught.message, pattern);
  return caught as { message: string; options: { retryable: boolean; ambiguous?: boolean } };
}
