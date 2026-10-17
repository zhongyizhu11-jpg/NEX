import type { Express, ErrorRequestHandler, RequestHandler } from "express";
import { databaseHealth } from "./databaseHealthState";
import { DATABASE_UNAVAILABLE_MESSAGE } from "../shared/databaseHealth";

/** 前端故障页轮询的就是这个。故障期间面板会一直有请求打过来，重试间隔给 15 秒。 */
const RETRY_AFTER_SECONDS = "15";

export function registerDatabaseHealthRoutes(app: Express) {
  // 不建登录上下文、不查库：登录态解析和所有业务查询都失败的时候它也得能用。
  app.get("/api/database-health", (_req, res) => {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.json(databaseHealth.snapshot());
  });
}

/**
 * 数据库不可用时 /api/* 直接 503（Agent 心跳 / 上报、订阅、事件流……），不再一个个去连库等超时。
 * tRPC 不在这里拦：它要回 tRPC 格式的错误（前端靠 message 认出这是数据库故障），由
 * createContext / trpc 中间件处理。
 */
export const databaseUnavailableApiGuard: RequestHandler = (req, res, next) => {
  if (!databaseHealth.isUnavailable() || !req.path.startsWith("/api/") || req.path.startsWith("/api/trpc") || req.path === "/api/database-health") return next();
  res.setHeader("Retry-After", RETRY_AFTER_SECONDS);
  res.status(503).json({ error: DATABASE_UNAVAILABLE_MESSAGE, code: "DATABASE_UNAVAILABLE" });
};

/** 路由里 next(err) 出来的数据库故障回 503，别的错误照旧往下交给 Express。 */
export const databaseRequestErrorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  if (!databaseHealth.unavailable(error)) return next(error);
  if (res.headersSent) { res.destroy(); return; }
  res.setHeader("Retry-After", RETRY_AFTER_SECONDS);
  res.status(503).json({ error: DATABASE_UNAVAILABLE_MESSAGE, code: "DATABASE_UNAVAILABLE" });
};
