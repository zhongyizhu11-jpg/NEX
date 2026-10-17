/**
 * 面板主库的健康状态（上游 v2.3.281）。服务端 server/databaseHealthState.ts 维护，
 * GET /api/database-health 原样返回；前端 DatabaseHealthGate 据此显示「数据库暂时不可用」页。
 *
 * reason 里只有白名单里的错误码和中文说明，不带驱动原始报错 —— 那里面可能有密码、SQL、
 * 参数、内网地址和文件路径，而这个接口不需要登录就能访问。
 */
export const DATABASE_UNAVAILABLE_MESSAGE = "数据库暂时不可用，请查看数据库异常提示";

export type DatabaseHealthState = "checking" | "healthy" | "unavailable" | "not_configured";

export type DatabaseHealth = {
  state: DatabaseHealthState;
  databaseType: "mysql" | "postgresql" | "sqlite" | null;
  checkedAt: string | null;
  unavailableSince: string | null;
  reason: { code: string; message: string; suggestion: string } | null;
  restartRequired: boolean;
};

export const DATABASE_HEALTH_STATES: readonly DatabaseHealthState[] = ["checking", "healthy", "unavailable", "not_configured"];

/** 老面板没有这个接口、或者回了看不懂的东西：当作没有健康信息，照常走原来的启动流程。 */
export function parseDatabaseHealth(value: unknown): DatabaseHealth | null {
  const state = (value as any)?.state;
  return DATABASE_HEALTH_STATES.includes(state) ? value as DatabaseHealth : null;
}
