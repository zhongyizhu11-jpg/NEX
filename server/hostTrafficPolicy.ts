import { afterDatabaseCommit, afterDatabaseTransactionSettled, executeRaw, isDatabaseTransactionActive, queryRaw, rawAffectedRows } from "./dbRuntime";
import { boolLiteral, quoteIdentifier as q } from "./dbCompat";
import { appendPanelLog } from "./_core/panelLogger";
import { hostTrafficExcluded } from "../shared/hostTrafficPolicy";

/*
  主机流量故障转移的服务端状态（上游 v2.3.281 移植，见 shared/hostTrafficPolicy.ts）。

  hosts.trafficFailoverExcluded 是派生值：每次流量上报 / 重置 / 校正、改套餐流量或开关之后，
  在同一个事务里用一条 UPDATE 按 host_traffic_counters 重算。只有状态真的翻转了才在提交后
  刷新运行时（组的故障转移、相关 Agent 的配置），所以平时每次上报只多一次内存判断。

  两份内存缓存都是为了心跳：
  - 开了这个功能（或者还暂停着）的主机 id —— 其余主机上报流量时连这条 UPDATE 都不用跑；
  - 当前被暂停的主机 id —— 每个 Agent 心跳生成配置时都要用，不能每次查一遍库。
  任何会改变它们的写入都会清缓存；另外 30 秒过期兜底（多进程 / 手改数据库）。
*/

const CACHE_TTL_MS = 30_000;
let policyHostCache: { ids: Set<number>; loadedAt: number } | null = null;
let excludedHostCache: { ids: Set<number>; loadedAt: number } | null = null;
let policyHostLoad: Promise<Set<number>> | null = null;
let excludedHostLoad: Promise<Set<number>> | null = null;

export function invalidateHostTrafficPolicyCache() {
  policyHostCache = null;
  excludedHostCache = null;
}

async function loadPolicyHostIds() {
  const rows = await queryRaw<any>(`SELECT ${q("id")} FROM ${q("hosts")}
    WHERE ${q("trafficFailoverEnabled")} = ${boolLiteral(true)} OR ${q("trafficFailoverExcluded")} = ${boolLiteral(true)}`);
  return new Set(rows.map((row) => Number(row.id)).filter((id) => id > 0));
}

async function loadExcludedHostIds() {
  const rows = await queryRaw<any>(`SELECT ${q("id")}, ${q("trafficLimit")}, ${q("trafficFailoverEnabled")}, ${q("trafficFailoverExcluded")}
    FROM ${q("hosts")} WHERE ${q("trafficFailoverExcluded")} = ${boolLiteral(true)}`);
  return new Set(rows.filter(hostTrafficExcluded).map((host) => Number(host.id)));
}

async function policyHostIds() {
  // 事务里读到的是还没提交的状态：直接查，不进缓存（回滚了缓存就错了）。
  if (isDatabaseTransactionActive()) return loadPolicyHostIds();
  if (policyHostCache && Date.now() - policyHostCache.loadedAt < CACHE_TTL_MS) return policyHostCache.ids;
  if (!policyHostLoad) {
    policyHostLoad = loadPolicyHostIds()
      .then((ids) => {
        policyHostCache = { ids, loadedAt: Date.now() };
        return ids;
      })
      .finally(() => { policyHostLoad = null; });
  }
  return policyHostLoad;
}

/** 当前因为流量到阈值被暂停参与组调度的主机。 */
export async function getTrafficExcludedHostIds(): Promise<ReadonlySet<number>> {
  if (isDatabaseTransactionActive()) return loadExcludedHostIds();
  if (excludedHostCache && Date.now() - excludedHostCache.loadedAt < CACHE_TTL_MS) return excludedHostCache.ids;
  if (!excludedHostLoad) {
    excludedHostLoad = loadExcludedHostIds()
      .then((ids) => {
        excludedHostCache = { ids, loadedAt: Date.now() };
        return ids;
      })
      .finally(() => { excludedHostLoad = null; });
  }
  return excludedHostLoad;
}

/** 重算一台主机的暂停状态的 SQL（单独导出给测试看算式）。 */
export function hostTrafficPolicyDecisionSql() {
  const h = (name: string) => `${q("hosts")}.${q(name)}`;
  const ti = `t.${q("bytesIn")}`;
  const to = `t.${q("bytesOut")}`;
  // 和 shared/hostTrafficQuota.ts 的 hostTrafficUsedBytes 同一个口径：认不出的计量方式按双向算。
  const usage = `COALESCE((SELECT CASE WHEN ${h("trafficMeasureMode")} = 'outbound' THEN ${to}
    WHEN ${h("trafficMeasureMode")} = 'max' THEN CASE WHEN ${ti} > ${to} THEN ${ti} ELSE ${to} END
    ELSE ${ti} + ${to} END FROM ${q("host_traffic_counters")} t WHERE t.${q("hostId")} = ${h("id")}), 0)`;
  const percent = `CASE WHEN ${h("trafficFailoverThresholdPercent")} BETWEEN 1 AND 100 THEN ${h("trafficFailoverThresholdPercent")} ELSE 100 END`;
  return `CASE WHEN ${h("trafficFailoverEnabled")} = ${boolLiteral(true)} AND ${h("trafficLimit")} > 0
    AND ${usage} >= ${h("trafficLimit")} * 1.0 * ${percent} / 100
    THEN ${boolLiteral(true)} ELSE ${boolLiteral(false)} END`;
}

/**
 * 在流量 / 配置写入的同一个事务里调用。判断写在 UPDATE 里而不是拿前面读到的快照算：
 * 同时发生的重置或改配置不能被一个过时的判断覆盖回去。只有状态翻转才安排后续工作。
 */
export async function reconcileHostTrafficPolicy(hostId: number) {
  const id = Number(hostId);
  if (!Number.isInteger(id) || id <= 0) return false;
  if (!(await policyHostIds()).has(id)) return false;
  const decision = hostTrafficPolicyDecisionSql();
  const result = await executeRaw(`UPDATE ${q("hosts")} SET ${q("trafficFailoverExcluded")} = ${decision}
    WHERE ${q("id")} = ? AND ${q("trafficFailoverExcluded")} <> (${decision})`, [id]);
  if (!rawAffectedRows(result)) return false;
  invalidateHostTrafficPolicyCache();
  // 提交或回滚之后都再清一次：事务进行中别处可能已经按旧值把缓存填回去了。
  await afterDatabaseTransactionSettled(() => { invalidateHostTrafficPolicyCache(); });
  await afterDatabaseCommit(async () => {
    // 提交后按最新状态刷新，而不是按这一次（可能已经被后面的写入盖掉的）翻转结果。
    invalidateHostTrafficPolicyCache();
    try {
      const current = await queryRaw<any>(`SELECT ${q("id")}, ${q("trafficLimit")}, ${q("trafficFailoverEnabled")}, ${q("trafficFailoverExcluded")}, ${q("trafficFailoverThresholdPercent")}
        FROM ${q("hosts")} WHERE ${q("id")} = ?`, [id]);
      appendPanelLog("info", `[HostTrafficPolicy] host=${id} groupParticipation=${hostTrafficExcluded(current[0]) ? "excluded" : "restored"} threshold=${current[0]?.trafficFailoverThresholdPercent ?? 100}%`);
      const { refreshHostTrafficPolicyRuntime } = await import("./hostTrafficPolicyRuntime");
      await refreshHostTrafficPolicyRuntime(id);
    } catch (error) {
      appendPanelLog("warn", `[HostTrafficPolicy] runtime refresh failed host=${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return true;
}

/** 改了主机的这几个字段要重算一次（套餐流量、计量方式、开关、比例）。 */
export const HOST_TRAFFIC_POLICY_FIELDS = ["trafficLimit", "trafficMeasureMode", "trafficFailoverEnabled", "trafficFailoverThresholdPercent"] as const;

export function touchesHostTrafficPolicy(data: Record<string, unknown>) {
  return HOST_TRAFFIC_POLICY_FIELDS.some((key) => Object.prototype.hasOwnProperty.call(data, key));
}
