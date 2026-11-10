/*
  GET /api/openapi.json —— 面板接口文档（OpenAPI 3.1），能直接导进 Postman 和各种代码生成器。
  怎么生成见 server/openApi.ts。

  ── 谁能取 ──
  登录用户，或带个人 API 令牌（Authorization: Bearer nex_…）。认人借 tRPC 的 createContext，
  和 /api/trpc 是同一套（会话 cookie / App 会话 / 令牌），不另写一份。文档里没有这个面板的任何数据
  （主机、规则、用户都不在里面），只是「有哪些接口、长什么样」；但接口清单也没必要给没登录的人看，
  所以不像 /llms.txt 那样公开。令牌不看模块：文档本身不属于哪个模块，拿着只开了「转发规则」的令牌
  也该能看到自己能调什么。

  ── 缓存 ──
  路由表进程启动后就不变，文档只生成一次（约 0.1 秒、几百 KB），之后每个请求只是拼上面板地址发出去。
  生成放在第一次请求时：面板启动不为一个多数人不会点的功能多花时间。
*/
import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import express, { type Request, type Response } from "express";

import { createContext } from "./_core/context";
import { apiRateLimitMessage, checkApiRateLimit } from "./apiRateLimit";
import { currentApiRateLimitConfig, noteApiRateLimited } from "./apiRateLimitConfig";
import { clientIp } from "./clientIp";
import { buildOpenApiDocument, type OpenApiProcedure } from "./openApi";
import { getSetting } from "./repositories/settingsRepository";

export const OPENAPI_ROUTE_PATH = "/api/openapi.json";

/** 生成好的文档去掉开头的 "{" —— 发的时候前面拼上 {"servers": […], 就是完整的 JSON，不用每次重新序列化几百 KB。 */
let cachedTail: Promise<string> | null = null;
let buildCount = 0;

async function documentTail(): Promise<string> {
  buildCount += 1;
  // 懒加载：和 mcpRoute 一样，不在模块加载时反过来引用 routers。
  const { appRouter } = await import("./routers");
  const { document } = buildOpenApiDocument(appRouter._def.procedures as unknown as Record<string, OpenApiProcedure>);
  return JSON.stringify(document).slice(1);
}

/** 完整的文档 JSON 文本。origin 是面板对外的地址（写进 servers）。 */
export async function openApiJson(origin: string): Promise<string> {
  cachedTail ||= documentTail().catch((error) => {
    // 生成失败不缓存：下次请求再试，别让一次偶发的错把文档永久弄没
    cachedTail = null;
    throw error;
  });
  const tail = await cachedTail;
  const servers = [{ url: origin || "/", description: "这个面板" }];
  return `{"servers":${JSON.stringify(servers)},${tail}`;
}

/** 测试用：进程启动以来真正生成过几次（缓存生效时一直是 1）。 */
export function openApiBuildCountForTests() {
  return buildCount;
}

function panelOrigin(req: Request, configured: string | null) {
  const value = String(configured || "").trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(value)) return value;
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "http").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  return host ? `${proto}://${host}` : "";
}

async function handleGet(req: Request, res: Response) {
  let ctx: Awaited<ReturnType<typeof createContext>>;
  try {
    ctx = await createContext({ req, res } as unknown as CreateExpressContextOptions);
  } catch {
    res.status(503).json({ error: "面板暂时不可用" });
    return;
  }
  // 和 /mcp 一样按查询额度限流：这条路不经过 tRPC 的中间件，不在这里数就是个不限次数的口子
  const ip = clientIp(req, "unknown");
  const userId = ctx.user ? Number(ctx.user.id) : null;
  const decision = checkApiRateLimit({ apiTokenId: ctx.apiToken?.id ?? null, userId, ip }, "query", currentApiRateLimitConfig());
  if (decision.limited) {
    noteApiRateLimited(decision, { path: "openapi", type: "query", userId, tokenName: ctx.apiToken?.name ?? null, ip });
    res.setHeader("Retry-After", String(decision.retryAfterSeconds));
    res.status(429).json({ error: apiRateLimitMessage(decision, "query") });
    return;
  }
  if (!ctx.user) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="nex"');
    res.status(401).json({ error: "请先登录，或带上 API 令牌（Authorization: Bearer nex_…）" });
    return;
  }
  try {
    const configured = await getSetting("panelPublicUrl").catch(() => null);
    const body = await openApiJson(panelOrigin(req, configured));
    // private：内容虽然人人一样，但只给登录的人看，不让中间的共享缓存存下来
    res.setHeader("Cache-Control", "private, max-age=300");
    if (String(req.query.download || "") === "1") {
      res.setHeader("Content-Disposition", 'attachment; filename="nex-openapi.json"');
    }
    res.status(200).type("application/json").send(body);
  } catch (error) {
    console.warn(`[OpenAPI] 生成接口文档失败：${error instanceof Error ? error.stack || error.message : String(error)}`);
    res.status(500).json({ error: "接口文档生成失败，详情见面板日志" });
  }
}

export const openApiRouter = express.Router();

openApiRouter.get(OPENAPI_ROUTE_PATH, (req, res) => {
  void handleGet(req, res);
});
