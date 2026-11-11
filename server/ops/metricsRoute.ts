/*
  GET /metrics —— Prometheus 来抓的那条路径。这个文件只管 HTTP 这一层：开没开、口令对不对、缓存；
  取数和写成文本由调用方传进来（server/ops/metricsExport.ts 接上真的，测试接假的）。

  · 没开：404，和口令对不对无关 —— 先看开关再看口令，关着的面板不告诉任何人「这里有个指标接口」。
    （面板别的不认识的路径会回前端页面；这条路径明确回 404，Prometheus 那边一眼看得出是没开。）
  · 开了、口令不对或没带：401，带 WWW-Authenticate。
  · 整份文本缓存 10 秒：Prometheus 抓得再勤、同时来几个抓取，10 秒内也只取一次数；
    正在取的时候又来了请求，等同一次结果，不各取各的。
  只认 Authorization: Bearer，不认查询参数：地址会进访问日志和反向代理的日志，口令不该出现在地址里。
*/
import express, { type Request, type Response } from "express";
import { metricsTokenMatches, type MetricsExportConfig } from "./metricsExportSettings";

export const METRICS_PATH = "/metrics";
export const METRICS_CACHE_TTL_MS = 10_000;
export const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

export type MetricsRouteDeps = {
  loadConfig: () => Promise<MetricsExportConfig | null>;
  render: (config: MetricsExportConfig) => Promise<string>;
  now?: () => number;
  cacheTtlMs?: number;
};

export function createMetricsRouter(deps: MetricsRouteDeps) {
  const now = deps.now ?? Date.now;
  const ttlMs = deps.cacheTtlMs ?? METRICS_CACHE_TTL_MS;
  // 上限改了以后导出的内容不一样，缓存按它分开认：改完设置不用等 10 秒。
  let cache: { text: string; at: number; maxRules: number } | null = null;
  let inflight: { promise: Promise<string>; maxRules: number } | null = null;

  const metricsText = async (config: MetricsExportConfig) => {
    if (cache && cache.maxRules === config.maxRules && now() - cache.at < ttlMs) return cache.text;
    if (inflight && inflight.maxRules === config.maxRules) return inflight.promise;
    const promise = deps.render(config).then((text) => {
      cache = { text, at: now(), maxRules: config.maxRules };
      return text;
    });
    const mine = { promise, maxRules: config.maxRules };
    inflight = mine;
    try {
      return await promise;
    } finally {
      if (inflight === mine) inflight = null;
    }
  };

  const router = express.Router();
  router.get(METRICS_PATH, async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    let config: MetricsExportConfig | null = null;
    try {
      config = await deps.loadConfig();
    } catch {
      config = null;
    }
    if (!config?.enabled) {
      cache = null;
      res.status(404).type("text/plain").send("Not Found\n");
      return;
    }
    if (!metricsTokenMatches(req.headers.authorization, config.token)) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="nex-metrics"');
      res.status(401).type("text/plain").send("Unauthorized\n");
      return;
    }
    try {
      const text = await metricsText(config);
      res.status(200).setHeader("Content-Type", METRICS_CONTENT_TYPE);
      // 按字节发：res.send(字符串) 会把 Content-Type 的参数重排成 charset 在前，这里要原样的那一串。
      res.send(Buffer.from(text, "utf8"));
    } catch (error) {
      console.warn(`[Metrics] 生成指标失败：${error instanceof Error ? error.message : String(error)}`);
      res.status(500).type("text/plain").send("Internal Server Error\n");
    }
  });
  return router;
}
