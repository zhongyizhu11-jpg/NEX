/*
  POST /mcp —— MCP 的 HTTP 入口（Streamable HTTP，只回 application/json）。协议处理在 mcp.ts。

  认证只认个人 API 令牌（Authorization: Bearer nex_…），不认浏览器 cookie：MCP 客户端
  不是浏览器，而网页里的恶意脚本也就没法借着管理员的 cookie 打这个口子。带 Origin 头的
  请求（只有浏览器会带）还要求来自面板自己的地址，挡掉 DNS 重绑定。

  GET（服务端推送流）和 DELETE（结束会话）都不支持，按规范回 405。
*/
import express, { type Request, type Response } from "express";
import { getSetting } from "../repositories/settingsRepository";
import { neutralizeCookies, readApiTokenFromHeader, requestIp, resolveApiToken } from "./apiTokens";
import { handleMcpPayload, JSON_RPC_INTERNAL_ERROR, type McpInvoker } from "./mcp";
import { apiRateLimitMessage, checkApiRateLimit } from "../apiRateLimit";
import { currentApiRateLimitConfig, noteApiRateLimited } from "../apiRateLimitConfig";

/**
 * /mcp 这一层也限流：initialize、tools/list 这些不调 tRPC 过程，不在这里数的话一个疯跑的客户端
 * 能无限打（每次还要查一遍令牌）。令牌有效按令牌的查询额度算，无效按来源 IP 的匿名额度算；
 * 工具真正调到的 tRPC 过程在 trpc.ts 的中间件里再各算一次（修改类工具因此也受修改额度约束）。
 * 超了回 429 + Retry-After。
 */
function rejectIfRateLimited(req: Request, res: Response, caller: { apiTokenId: number | null; userId: number | null; tokenName?: string | null }) {
  const ip = requestIp(req);
  const decision = checkApiRateLimit({ apiTokenId: caller.apiTokenId, userId: caller.userId, ip }, "query", currentApiRateLimitConfig());
  if (!decision.limited) return false;
  noteApiRateLimited(decision, { path: "mcp", type: "query", userId: caller.userId, tokenName: caller.tokenName ?? null, ip });
  res.setHeader("Retry-After", String(decision.retryAfterSeconds));
  res.status(429).json(jsonRpcError(-32029, apiRateLimitMessage(decision, "query")));
  return true;
}

function jsonRpcError(code: number, message: string) {
  return { jsonrpc: "2.0", id: null, error: { code, message } };
}

function hostOf(url: string) {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

async function originAllowed(req: Request) {
  const origin = String(req.headers.origin || "").trim();
  if (!origin) return true;
  const originHost = hostOf(origin);
  if (!originHost) return false;
  const requestHost = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim().toLowerCase();
  if (originHost === requestHost) return true;
  const panelUrl = await getSetting("panelPublicUrl").catch(() => null);
  return !!panelUrl && hostOf(panelUrl) === originHost;
}

/** 面板 tRPC 过程要的上下文：真实的请求（IP、审计），一个写不了 cookie 的响应壳。 */
function mcpTrpcContext(req: Request, user: any, apiToken: any) {
  return {
    req,
    res: { cookie() {}, clearCookie() {}, setHeader() {}, getHeader() { return undefined; } } as any,
    user,
    authSession: null,
    authFailureReason: null,
    apiToken,
  } as any;
}

async function createInvoker(ctx: unknown): Promise<McpInvoker> {
  // 懒加载：routers → ops 路由 → … 不能在模块加载时反过来引用 routers。
  const { appRouter } = await import("../routers");
  const caller = appRouter.createCaller(ctx as any) as any;
  return async (path, input) => {
    let target = caller;
    for (const part of path.split(".")) target = target[part];
    return input === undefined ? target() : target(input);
  };
}

async function handlePost(req: Request, res: Response) {
  neutralizeCookies(res);
  res.setHeader("Cache-Control", "no-store");
  if (!(await originAllowed(req))) {
    res.status(403).json(jsonRpcError(-32001, "Origin not allowed"));
    return;
  }
  const token = readApiTokenFromHeader(req.headers.authorization);
  const resolved = token ? await resolveApiToken(token, requestIp(req)).catch(() => null) : null;
  if (rejectIfRateLimited(req, res, resolved
    ? { apiTokenId: resolved.apiToken.id, userId: Number(resolved.user.id), tokenName: resolved.apiToken.name }
    : { apiTokenId: null, userId: null })) return;
  if (!resolved) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="nex", error="invalid_token"');
    res.status(401).json(jsonRpcError(-32001, "需要有效的 API 令牌（Authorization: Bearer nex_…），请在面板 设置 › 进阶 里创建"));
    return;
  }
  try {
    const ctx = mcpTrpcContext(req, resolved.user, resolved.apiToken);
    const invoke = await createInvoker(ctx);
    const outcome = await handleMcpPayload(req.body, {
      scope: resolved.apiToken.scope,
      modules: resolved.apiToken.modules ?? null,
      isAdmin: resolved.user.role === "admin",
      invoke,
    });
    if (outcome.body === undefined) {
      res.status(outcome.status).end();
      return;
    }
    res.status(outcome.status).type("application/json").send(JSON.stringify(outcome.body));
  } catch (error) {
    console.warn(`[MCP] request failed: ${error instanceof Error ? error.message : String(error)}`);
    res.status(500).json(jsonRpcError(JSON_RPC_INTERNAL_ERROR, "Internal error"));
  }
}

export const mcpRouter = express.Router();

mcpRouter.post("/mcp", (req, res) => {
  void handlePost(req, res);
});

mcpRouter.all("/mcp", (_req, res) => {
  res.setHeader("Allow", "POST");
  res.status(405).json(jsonRpcError(-32000, "Method not allowed"));
});
