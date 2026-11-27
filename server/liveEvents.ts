import { EventEmitter } from "node:events";
import type { Express, Request, Response } from "express";

/*
  面板 → 浏览器的实时通知（2.3.559，用户：「整个系统链路和规则线路调整要实时显示」「操作界面反应极速」）。

  只说「哪一类变了」，不带数据：浏览器收到后按自己的权限重取它此刻在看的那几份（client/src/hooks/useLiveEvents.ts），
  所以这里不用按用户过滤，也不会把别人的数据推给谁。轮询照旧在，只是兜底（连不上 / 老页面）。

    rules.live      规则的延迟 / 通不通（定时探测上报、诊断完成）
    tunnels.live    链路的延迟（链路探测上报、链路诊断完成）
    balance         负载均衡：入口实时上报（在用哪台出口、切换）
    hosts.live      主机上线 / 掉线
    mutation:<模块> 有人改了配置（rules / tunnels / forwardGroups / hosts）：别的标签页、别的设备也跟着刷新

  200 毫秒内的合并成一条，上报再密也不会把浏览器刷爆。
*/
export type LiveTopic = "rules.live" | "tunnels.live" | "balance" | "hosts.live" | `mutation:${LiveMutationModule}`;
export type LiveMutationModule = "rules" | "tunnels" | "forwardGroups" | "hosts";
export const LIVE_MUTATION_MODULES: ReadonlySet<string> = new Set<LiveMutationModule>(["rules", "tunnels", "forwardGroups", "hosts"]);

const COALESCE_MS = 200;
const PING_MS = 25_000;
const MAX_STREAMS = 5_000;
const MAX_STREAMS_PER_USER = 16;

const bus = new EventEmitter();
bus.setMaxListeners(0);
let pending = new Set<LiveTopic>();
let timer: ReturnType<typeof setTimeout> | null = null;

const sentByTopic = new Map<string, number>();

function flush() {
  timer = null;
  if (pending.size === 0) return;
  const topics = Array.from(pending);
  pending = new Set();
  for (const topic of topics) sentByTopic.set(topic, (sentByTopic.get(topic) || 0) + 1);
  bus.emit("live", topics);
}

export function emitLive(...topics: LiveTopic[]) {
  for (const topic of topics) pending.add(topic);
  if (timer || pending.size === 0) return;
  timer = setTimeout(flush, COALESCE_MS);
  timer.unref?.();
}

export function onLive(listener: (topics: LiveTopic[]) => void) {
  bus.on("live", listener);
  return () => { bus.off("live", listener); };
}

/** 测试用：马上发出攒着的 */
export function flushLiveForTest() {
  if (timer) clearTimeout(timer);
  flush();
}

let openStreams = 0;
const streamsByUser = new Map<number, number>();

/** /metrics 用（server/ops/metricsCollect.ts）：此刻连着几个页面、各类通知发了多少次（面板启动以来，合并后的次数） */
export function liveStreamStats() {
  return { openStreams, sentByTopic: Object.fromEntries(sentByTopic) as Record<string, number> };
}

export function registerLiveRoute(app: Express, authenticate: (req: Request, res: Response) => Promise<{ id: number } | null>) {
  app.get("/api/live", async (req: Request, res: Response) => {
    let user: { id: number } | null = null;
    try {
      user = await authenticate(req, res);
    } catch {
      res.status(503).end();
      return;
    }
    if (!user) {
      res.status(401).end();
      return;
    }
    const userId = Number(user.id);
    if (openStreams >= MAX_STREAMS || (streamsByUser.get(userId) || 0) >= MAX_STREAMS_PER_USER) {
      res.status(429).end();
      return;
    }
    openStreams += 1;
    streamsByUser.set(userId, (streamsByUser.get(userId) || 0) + 1);
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    res.write("retry: 3000\n\n");
    const off = onLive((topics) => {
      res.write(`event: change\ndata: ${JSON.stringify({ topics })}\n\n`);
    });
    const ping = setInterval(() => res.write(": ping\n\n"), PING_MS);
    ping.unref?.();
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      off();
      clearInterval(ping);
      openStreams = Math.max(0, openStreams - 1);
      const left = (streamsByUser.get(userId) || 1) - 1;
      if (left > 0) streamsByUser.set(userId, left);
      else streamsByUser.delete(userId);
    };
    req.on("close", close);
    res.on("close", close);
  });
}
