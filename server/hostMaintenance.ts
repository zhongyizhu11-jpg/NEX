import { executeRaw } from "./dbRuntime";
import { quoteIdentifier as q, boolLiteral } from "./dbCompat";
import { appendPanelLog } from "./_core/panelLogger";
import { invalidateHostTrafficPolicyCache } from "./hostTrafficPolicy";
import { invalidateRouteNodeHealth } from "./routeNodeHealth";
import { refreshRulesThroughHost } from "./routeGroups";
import { recordPanelEvent } from "./ops/panelEvents";

/*
  节点维护（2.3.496）：一个开关把机器从所有候选里拿掉。

  走的是流量到阈值暂停那一套（server/hostTrafficPolicy.ts 的排除集合把维护中的也算进去）：转发组、
  入口组 DNS、出口组、多出口隧道都会跳过它；线路组的路径由心跳打「维护中」提示（routeNodeHints），
  入口调度器立刻改走别的。关掉维护后照常参与 —— 线路那边要等它探通、稳定才回来。
*/
export async function setHostMaintenance(hostId: number, enabled: boolean, note: string | null, actor: { id: number }) {
  const id = Number(hostId);
  const nowSec = Math.floor(Date.now() / 1000);
  await executeRaw(
    `UPDATE ${q("hosts")} SET ${q("maintenanceMode")} = ${boolLiteral(enabled)}, ${q("maintenanceSince")} = ?, ${q("maintenanceNote")} = ? WHERE ${q("id")} = ?`,
    [enabled ? nowSec : null, enabled ? (note || "").slice(0, 200) || null : null, id],
  );
  invalidateHostTrafficPolicyCache();
  invalidateRouteNodeHealth();
  appendPanelLog("info", `[Maintenance] host=${id} ${enabled ? "进入维护" : "结束维护"} by user=${actor.id}${note ? ` note=${note}` : ""}`);
  await recordPanelEvent({
    kind: "host.maintenance",
    level: enabled ? "warn" : "info",
    hostId: id,
    userId: actor.id,
    message: enabled ? `主机进入维护${note ? `：${note}` : ""}` : "主机结束维护",
  }).catch(() => null);
  const { refreshHostTrafficPolicyRuntime } = await import("./hostTrafficPolicyRuntime");
  await refreshHostTrafficPolicyRuntime(id).catch((error) => {
    appendPanelLog("warn", `[Maintenance] runtime refresh failed host=${id}: ${error instanceof Error ? error.message : String(error)}`);
  });
  const lines = await refreshRulesThroughHost(id, enabled ? "host-maintenance-on" : "host-maintenance-off").catch(() => 0);
  return { lines };
}
