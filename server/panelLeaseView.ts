import { describePanelBackgroundLease, panelBackgroundLeaseStatus } from "./panelLease";

/** 后台任务租约给健康检查接口和面板日志卡片看的样子（server/panelLease.ts）。 */
export type PanelBackgroundLeaseView = {
  /** holder = 本实例在跑后台任务；standby = 别的实例在跑 / 正在接手；single = 没启用租约（单进程）。 */
  role: "holder" | "standby" | "starting" | "stopped" | "single";
  thisInstanceRuns: boolean;
  instanceId: string | null;
  holderId: string | null;
  otherInstances: number;
  text: string;
};

export function panelBackgroundLeaseView(): PanelBackgroundLeaseView {
  const status = panelBackgroundLeaseStatus();
  if (!status) {
    return { role: "single", thisInstanceRuns: true, instanceId: null, holderId: null, otherInstances: 0, text: describePanelBackgroundLease(null) };
  }
  return {
    role: status.role,
    thisInstanceRuns: status.role === "holder",
    instanceId: status.instanceId,
    holderId: status.holderId,
    otherInstances: status.otherInstanceIds.length,
    text: describePanelBackgroundLease(status),
  };
}
