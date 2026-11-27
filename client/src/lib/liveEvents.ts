/*
  面板推过来的实时通知（server/liveEvents.ts）怎么拆、该刷新哪几份查询。纯函数，useLiveEvents 用。

  数据上报（rules.live / tunnels.live / balance / hosts.live）只刷「现在」的那几份：卡片状态、列表、负载均衡弹窗；
  延迟曲线、30 天色块这些历史不跟着刷（上报几秒就来一条，历史一分钟变不了多少，照旧按自己的节奏轮询）。
  有人改了配置（mutation:<模块>）刷整个模块：别的标签页、别的设备上的列表、表单选项都跟着变。
*/
export type LiveQueryKey =
  | "rules.trafficSummary"
  | "rules.routeStatus"
  | "rules.*"
  | "tunnels.listPage"
  | "tunnels.exitTargets"
  | "tunnels.*"
  | "forwardGroups.*"
  | "hosts.*";

const LIVE_TOPIC_QUERIES: Record<string, readonly LiveQueryKey[]> = {
  "rules.live": ["rules.trafficSummary", "rules.routeStatus"],
  "tunnels.live": ["tunnels.listPage", "tunnels.exitTargets"],
  balance: ["tunnels.exitTargets", "rules.trafficSummary"],
  "hosts.live": ["hosts.*", "tunnels.listPage", "rules.trafficSummary"],
  "mutation:rules": ["rules.*"],
  "mutation:tunnels": ["tunnels.*", "rules.trafficSummary"],
  "mutation:forwardGroups": ["forwardGroups.*", "rules.trafficSummary"],
  "mutation:hosts": ["hosts.*", "tunnels.listPage", "rules.trafficSummary"],
};

/** 页面切回前台、断线重连之后：不知道错过了什么，「现在」的那几份都刷一遍 */
export const LIVE_RESYNC_TOPICS = ["rules.live", "tunnels.live", "balance", "hosts.live"] as const;

export function liveQueriesForTopics(topics: readonly string[]): LiveQueryKey[] {
  const keys = new Set<LiveQueryKey>();
  for (const topic of topics) for (const key of LIVE_TOPIC_QUERIES[topic] || []) keys.add(key);
  // 整个模块要刷的，模块里单独那几份就不用再刷一遍
  for (const key of Array.from(keys)) {
    const module = key.split(".")[0];
    if (!key.endsWith(".*") && keys.has(`${module}.*` as LiveQueryKey)) keys.delete(key);
  }
  return Array.from(keys);
}

/** 从流里拆出完整的事件（text/event-stream）：返回拆出来的话题和还没收完的那一截 */
export function parseLiveStream(buffer: string): { topics: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const blocks = normalized.split("\n\n");
  const rest = blocks.pop() ?? "";
  const topics: string[] = [];
  for (const block of blocks) {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trim());
    }
    if (event !== "change" || data.length === 0) continue;
    try {
      const parsed = JSON.parse(data.join("\n")) as { topics?: unknown };
      if (Array.isArray(parsed.topics)) for (const topic of parsed.topics) if (typeof topic === "string") topics.push(topic);
    } catch {
      // 不认识的一条跳过，后面的照常
    }
  }
  return { topics, rest };
}
