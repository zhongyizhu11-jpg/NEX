/**
 * 「立即同步」/「添加并拉取」回来之后给人看哪句话。
 *
 * 服务端的手动同步走队列（server/proxySubSourceSync）：这个来源正在跑就直接回
 * `status: "running"`，并发满了回 `status: "queued"`，两种都带零计数。要是照旧念
 * 「同步完成：+0 更新 0 移除 0」，人会以为上游真没变化 —— 其实这次根本没拉。
 * 所以先看 status，再看 ok / unchanged / 计数。
 */

export type ProxySubSourceSyncLike = {
  ok: boolean;
  error?: string | null;
  /** done = 这次跑完了（老服务端不带这个字段，也当 done）。 */
  status?: "done" | "queued" | "running" | null;
  added: number;
  updated: number;
  removed: number;
  unchanged: boolean;
  nodeCount: number;
};

export type ProxySubSourceSyncToast = { tone: "success" | "info" | "warning" | "error"; text: string };

export const PROXY_SUB_SOURCE_SYNC_RUNNING_TEXT = "这个源正在同步，稍后刷新看结果";
export const PROXY_SUB_SOURCE_SYNC_QUEUED_TEXT = "已排队，同步会在后台完成";

/** 没真跑（正在跑 / 排队了）时的那句话；跑完了给 null。 */
export function proxySubSourceSyncPendingText(result: Pick<ProxySubSourceSyncLike, "status">): string | null {
  if (result.status === "running") return PROXY_SUB_SOURCE_SYNC_RUNNING_TEXT;
  if (result.status === "queued") return PROXY_SUB_SOURCE_SYNC_QUEUED_TEXT;
  return null;
}

/** 「立即同步」按钮的提示。 */
export function proxySubSourceSyncToast(result: ProxySubSourceSyncLike): ProxySubSourceSyncToast {
  const pending = proxySubSourceSyncPendingText(result);
  if (pending) return { tone: "info", text: pending };
  if (!result.ok) return { tone: "error", text: `拉取失败：${result.error}` };
  if (result.unchanged) return { tone: "success", text: "上游没变化" };
  return { tone: "success", text: `同步完成：+${result.added} 更新 ${result.updated} 移除 ${result.removed}` };
}

/** 「添加并拉取」的提示：来源已经建好了，后半句说第一次拉取怎么样。 */
export function proxySubSourceCreateToast(sync: ProxySubSourceSyncLike): ProxySubSourceSyncToast {
  const pending = proxySubSourceSyncPendingText(sync);
  if (pending) return { tone: "info", text: `已添加，${pending}` };
  if (sync.ok) return { tone: "success", text: `已添加，同步到 ${sync.nodeCount} 个节点` };
  return { tone: "warning", text: `已添加，但第一次拉取失败：${sync.error}` };
}
