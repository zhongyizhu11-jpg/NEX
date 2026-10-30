import { queryRaw } from "./dbRuntime";
import { quoteIdentifier as q } from "./dbCompat";
import { dbBool } from "./repositories/repositoryUtils";

/*
  线路里每台机器此刻能不能走：在线、维护中。心跳下发线路组调度时要按它给路径打「用不了」的提示，
  每次都查库太贵，这里留一份十秒的快照；改维护开关时立刻作废。

  节点熔断（多条线路都探不通同一台机器）在 routeGroupStats 里，按探测算，不在这里。
*/

export type RouteNodeStatus = { id: number; name: string; online: boolean; maintenance: boolean };

const TTL_MS = 10_000;
let snapshot: { byId: Map<number, RouteNodeStatus>; loadedAt: number } | null = null;
let loading: Promise<void> | null = null;

async function load() {
  const rows = await queryRaw<any>(`SELECT ${q("id")}, ${q("name")}, ${q("isOnline")}, ${q("maintenanceMode")} FROM ${q("hosts")}`).catch(() => [] as any[]);
  const byId = new Map<number, RouteNodeStatus>();
  for (const row of rows) {
    const id = Number(row.id);
    if (!(id > 0)) continue;
    byId.set(id, { id, name: String(row.name || "").trim() || `主机 ${id}`, online: dbBool(row.isOnline), maintenance: dbBool(row.maintenanceMode) });
  }
  snapshot = { byId, loadedAt: Date.now() };
}

/** 心跳构建前调一下：快照过期就重读（并发只读一次）。 */
export async function ensureRouteNodeHealthFresh() {
  if (snapshot && Date.now() - snapshot.loadedAt < TTL_MS) return;
  if (!loading) loading = load().finally(() => { loading = null; });
  await loading;
}

export function getRouteNodeStatus(hostId: number): RouteNodeStatus | null {
  return snapshot?.byId.get(Number(hostId)) || null;
}

export function invalidateRouteNodeHealth() {
  snapshot = null;
}

/** 维护中的主机 id。 */
export function routeMaintenanceHostIds(): Set<number> {
  const ids = new Set<number>();
  for (const status of snapshot?.byId.values() || []) if (status.maintenance) ids.add(status.id);
  return ids;
}

/** 测试用：直接塞一份快照。 */
export function setRouteNodeHealthForTest(rows: RouteNodeStatus[] | null) {
  snapshot = rows ? { byId: new Map(rows.map((row) => [row.id, row])), loadedAt: Date.now() + 3_600_000 } : null;
}

