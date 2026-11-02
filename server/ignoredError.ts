/*
  有兜底值、出错也不该打断主流程的地方（读不到就当没有），以前直接 .catch(() => []) 吞掉，
  数据库出问题时页面只是悄悄变空，没人知道为什么。这里至少打一条调试日志（console.debug，
  不进面板日志文件，排查时看进程输出），返回调用方给的兜底值。
*/
export function ignoreErrorWith<T>(scope: string, fallback: T) {
  return (error: unknown): T => {
    console.debug(`[${scope}] ignored error: ${error instanceof Error ? error.message : String(error)}`);
    return fallback;
  };
}
