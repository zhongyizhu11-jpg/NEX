/**
 * 数据库维护（切换/迁移）期间的全局写冻结。
 *
 * 面板内切换数据库时，数据是从当前库逐表读出来、写进新库的；这期间面板照常在跑：
 * 管理员改规则、Agent 每几秒上报流量和心跳、调度器扣费发提醒……这些写入要么落在
 * 已经读过的表里（新库里没有，切换后凭空丢失），要么落在还没读的表里（新旧两边
 * 对不上，比如流量计数和账单一边有一边没有）。
 *
 * 所以切换开始时打开这个开关、结束（失败或无需重启地切完）时关掉；切换成功且需要
 * 重启时一直开着直到进程退出 —— 这时再写旧库，写进去的东西也不会跟过去。
 * 开着的时候：
 *
 * - tRPC 的 mutation 一律返回 503「数据库迁移中」（查询照常，管理员要能看切换进度）；
 * - Agent 的上报/心跳类 POST 返回 503，Agent 会按失败重试，流量增量留在 Agent 本地；
 * - 调度器的定时任务整轮跳过。
 */

export const DATABASE_MAINTENANCE_MESSAGE = "数据库迁移中，请稍后再试";

let activeReason: string | null = null;

export function beginDatabaseMaintenance(reason: string) {
  activeReason = reason || "database-maintenance";
}

export function endDatabaseMaintenance() {
  activeReason = null;
}

export function isDatabaseMaintenanceActive() {
  return activeReason !== null;
}
