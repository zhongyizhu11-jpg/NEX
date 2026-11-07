import fs from "node:fs";
import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import express, { type Request, type Response } from "express";

import { createContext } from "./_core/context";
import { getPanelProfilingEnabledUntil, panelProfilingDownload } from "./panelProfiling";

/**
 * GET /api/ops/profiling/:id/download —— 下载采好的 CPU 剖析 / 堆快照（server/panelProfiling.ts）。
 *
 * 文件可能有几百 MB，不能塞进 tRPC 的 JSON，所以单独一条路由流式发。认人和 tRPC 用同一套
 * （createContext：会话 cookie / 开发面板），但只认**网页上的管理员会话**：API 令牌一律 403
 * —— 堆快照里有会话、密码和各种密钥，泄露的令牌不能拿它把整个进程内存带走。功能关着时也不给。
 */
export const panelProfilingRouter = express.Router();

panelProfilingRouter.get("/api/ops/profiling/:id/download", async (req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store");
  const id = String(req.params.id || "");
  if (!/^[0-9a-f]{24}$/.test(id)) {
    res.status(404).type("text/plain").send("没有这份剖析");
    return;
  }
  let ctx: Awaited<ReturnType<typeof createContext>>;
  try {
    // 和 server/googleAuthRoute.ts 一样借 tRPC 的认人逻辑；createContext 只用 req / res。
    ctx = await createContext({ req, res } as unknown as CreateExpressContextOptions);
  } catch {
    res.status(503).type("text/plain").send("面板暂时不可用");
    return;
  }
  if (ctx.apiToken) {
    res.status(403).type("text/plain").send("API 令牌不能下载性能剖析，请在网页上操作");
    return;
  }
  if (!ctx.user || ctx.user.role !== "admin") {
    res.status(403).type("text/plain").send("只有管理员能下载性能剖析");
    return;
  }
  if (!(await getPanelProfilingEnabledUntil())) {
    res.status(403).type("text/plain").send("性能剖析已经关闭");
    return;
  }
  const download = panelProfilingDownload(id);
  if (!download) {
    res.status(404).type("text/plain").send("这份剖析不存在或已经过期");
    return;
  }
  res.status(200);
  res.setHeader("Content-Type", download.kind === "cpu" ? "application/json" : "application/octet-stream");
  res.setHeader("Content-Length", String(download.bytes));
  res.setHeader("Content-Disposition", `attachment; filename="${download.filename}"`);
  // 压缩中间件别碰它：几百 MB 的快照现压既慢又占内存，浏览器那头也不需要。
  res.setHeader("Cache-Control", "no-store, no-transform");
  const input = fs.createReadStream(download.file);
  input.once("error", () => res.destroy());
  input.pipe(res);
});
