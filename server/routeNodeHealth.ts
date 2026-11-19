import { queryRaw } from "./dbRuntime";
import { quoteIdentifier as q } from "./dbCompat";
import { dbBool } from "./repositories/repositoryUtils";
import { hostTrafficExcluded } from "../shared/hostTrafficPolicy";
import { getPresenceCapableHostLivenessSnapshot } from "./agentFastLiveness";

/*
  线路里每台机器此刻能不能走：在线、维护中、流量到阈值被暂停（quota）。心跳下发线路组调度时要按它给路径打「用不了」的提示，
  每次都查库太贵，这里留一份十秒的快照；改维护开关时立刻作废。

  在线不在线（P12）：以前直接用库里的 hosts.isOnline —— 那一列是离线判定落库之后才变的，比面板内存里的
  快速存活状态（server/agentFastLiveness.ts，90 秒没动静就确认离线）晚，面板刚重启时还可能是上一次留下的旧值。
  现在带快速存活上报的主机只认那份内存状态（读快照时现算，不受十秒缓存影响），没有那份状态的才退回库里那一列。

  读库失败：以前是 `.catch(() => [])`，一次失败就得到一张空表 —— 所有机器都「查不到」，路径上的提示全没了。
  现在留着上一份快照继续用，两秒后再试。

  节点熔断（多条线路都探不通同一台机器）在 routeGroupStats 里，按探测算，不在这里。
*/

export type RouteNodeStatus = { id: number; name: string; online: boolean; maintenance: boolean; quota: boolean };

type StoredNodeStatus = Omit<RouteNodeStatus, "online"> & { dbOnline: boolean };

const TTL_MS = 10_000;
const RETRY_AFTER_FAILURE_MS = 2_000;
let snapshot: { byId: Map<number, StoredNodeStatus>; loadedAt: number } | null = null;
let loading: Promise<void> | null = null;

type RowLoader = () => Promise<Array<Record<string, unknown>>>;

const loadRowsFromDatabase: RowLoader = () => queryRaw<Record<string, unknown>>(
  `SELECT ${q("id")}, ${q("name")}, ${q("isOnline")}, ${q("maintenanceMode")}, ${q("trafficFailoverEnabled")}, ${q("trafficLimit")}, ${q("trafficFailoverExcluded")} FROM ${q("hosts")}`,
);
let loadRows: RowLoader = loadRowsFromDatabase;

/** 测试用：换掉读库。传 null 恢复默认，并清掉快照。 */
export function configureRouteNodeHealthForTests(loader: RowLoader | null) {
  loadRows = loader || loadRowsFromDatabase;
  snapshot = null;
  loading = null;
}

async function load() {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = await loadRows();
  } catch (error) {
    if (snapshot) {
      // 上一份还在：接着用，过一小会儿再读（别每次心跳都撞一次坏掉的库）。
      snapshot = { byId: snapshot.byId, loadedAt: Date.now() - TTL_MS + RETRY_AFTER_FAILURE_MS };
    }
    console.warn(`[RouteNodeHealth] reading host status failed; keeping the previous snapshot: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const byId = new Map<number, StoredNodeStatus>();
  for (const row of rows) {
    const id = Number(row.id);
    if (!(id > 0)) continue;
    byId.set(id, {
      id,
      name: String(row.name || "").trim() || `主机 ${id}`,
      dbOnline: dbBool(row.isOnline),
      maintenance: dbBool(row.maintenanceMode),
      // 流量到故障转移阈值被暂停（和组、落地池同一个口径；维护另算，所以这里把维护那一项拿掉）
      quota: hostTrafficExcluded({ ...row, maintenanceMode: false }),
    });
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
  const stored = snapshot?.byId.get(Number(hostId));
  if (!stored) return null;
  const { dbOnline, ...status } = stored;
  // 带快速存活上报的主机：没被确认离线就算在线（刚启动的宽限期里也是，和转发组的判定一致）。
  const fast = getPresenceCapableHostLivenessSnapshot(stored.id);
  return { ...status, online: fast ? !fast.confirmedOffline : dbOnline };
}

/** 维护开关这类改动之后调：下一次立刻重读。旧的那份先留着，重读失败时还能用。 */
export function invalidateRouteNodeHealth() {
  if (snapshot) snapshot = { byId: snapshot.byId, loadedAt: 0 };
}
