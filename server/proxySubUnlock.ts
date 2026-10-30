/**
 * 解锁出口自动分流的服务端那一半：按订阅条目的出口主机批量查最新解锁结论，
 * 交给 shared/proxySubUnlock.ts 去建组（shared 里不碰数据库）。
 *
 * 查不出来（表还没建、库出错）就当没有结论：订阅照常出，只是不多那几个解锁组 ——
 * 订阅拉取不能因为一个锦上添花的功能失败。
 */
import { proxySubUnlockExitHostIds, type ProxySubUnlockStatusMap } from "../shared/proxySubUnlock";

export async function loadProxySubUnlockStatuses(
  entries: readonly { meta?: { exitHostId?: number | null } }[],
): Promise<ProxySubUnlockStatusMap | null> {
  const hostIds = proxySubUnlockExitHostIds(entries);
  if (hostIds.length === 0) return null;
  try {
    // 动态引入：ops/unlock.ts 牵着 Agent 扩展那一串，仓储层静态引它容易绕成循环依赖。
    const { latestUnlockStatusesByHostIds } = await import("./ops/unlock");
    return await latestUnlockStatusesByHostIds(hostIds);
  } catch (error) {
    console.warn(`[ProxySub] unlock statuses unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
