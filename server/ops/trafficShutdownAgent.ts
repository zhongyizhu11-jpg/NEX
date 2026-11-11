import { registerAgentExtModule, type AgentExtHost } from "./agentExt";
import { appendPanelLog } from "../_core/panelLogger";
import {
  claimHostTrafficShutdown,
  evaluateSnapshot,
  getTrafficShutdownEnabledHostIds,
  readHostTrafficShutdownSnapshot,
} from "../hostTrafficShutdown";
import { isAgentVersionAtLeast } from "../../shared/version";
import { HOST_TRAFFIC_SHUTDOWN_AGENT_VERSION } from "../../shared/hostTrafficShutdown";
import { setBoundedMapValue } from "../boundedCache";

/*
  扩展模块 "traffic_shutdown"：流量阈值关机（见 server/hostTrafficShutdown.ts、agent/ext_traffic_shutdown.go）。

  上报 { supported, lastMark, lastError }：supported = 这台 Agent 以 root 跑在 Linux 上、找得到关机命令；
  lastMark = 它本地记着的上一次关机周期。指令只有一种 { shutdown: true, mark, thresholdPercent }，
  只在这一轮刚认领到名额时发一次。
*/

export type TrafficShutdownAgentReport = { supported: boolean; lastMark: string; lastError: string; reportedAt: number };

const reports = new Map<number, TrafficShutdownAgentReport>();

/** 主机设置弹窗里显示「Agent 能不能关机」用。 */
export function getTrafficShutdownAgentReport(hostId: number) {
  return reports.get(Number(hostId)) || null;
}

function normalizeReport(raw: unknown): TrafficShutdownAgentReport | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  return {
    supported: value.supported === true,
    lastMark: typeof value.lastMark === "string" ? value.lastMark.slice(0, 64) : "",
    lastError: typeof value.lastError === "string" ? value.lastError.slice(0, 300) : "",
    reportedAt: Date.now(),
  };
}

function formatBytes(bytes: number) {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** 关机前的通知：事件时间线 + 管理员（和资源告警同一套渠道）。最多等 8 秒，发不出去也照样关。 */
async function notifyBeforeShutdown(host: AgentExtHost, snapshot: NonNullable<Awaited<ReturnType<typeof readHostTrafficShutdownSnapshot>>>) {
  const name = String(snapshot.name || host.name || "").trim().slice(0, 60) || `主机 #${snapshot.hostId}`;
  const usedPercent = snapshot.trafficLimit > 0 ? Math.round((snapshot.usedBytes / snapshot.trafficLimit) * 100) : 0;
  const work = (async () => {
    const { recordPanelEvent } = await import("./panelEvents");
    await recordPanelEvent({
      kind: "host.traffic_shutdown",
      level: "crit",
      hostId: snapshot.hostId,
      message: `${name} 本周期流量已用 ${usedPercent}%（${formatBytes(snapshot.usedBytes)} / ${formatBytes(snapshot.trafficLimit)}），达到关机阈值 ${snapshot.thresholdPercent}%，Agent 即将关闭整台机器`,
      data: { usedBytes: snapshot.usedBytes, trafficLimit: snapshot.trafficLimit, thresholdPercent: snapshot.thresholdPercent, cycleMark: snapshot.cycleMark },
    });
    const { sendAdminAlert } = await import("../resourceAlertNotifier");
    await sendAdminAlert({
      title: `NEX 流量阈值关机：${name}`,
      marker: "⛔",
      fields: [
        ["主机", `${name} (#${snapshot.hostId})`],
        ["本周期已用", `${formatBytes(snapshot.usedBytes)} / ${formatBytes(snapshot.trafficLimit)}（${usedPercent}%）`],
        ["关机阈值", `${snapshot.thresholdPercent}%`],
        ["说明", "Agent 收到指令后立即关闭整台机器，不等故障转移和 DDNS 切换；面板不会自动开机，请在服务商控制台手动开机。本周期不会再次触发。"],
      ],
      logLabel: `traffic-shutdown host=${snapshot.hostId}`,
    }, { email: true });
  })().catch((error) => {
    appendPanelLog("warn", `[HostTrafficShutdown] host=${snapshot.hostId} notify failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  await Promise.race([work, new Promise((resolve) => setTimeout(resolve, 8_000).unref?.())]);
}

registerAgentExtModule({
  name: "traffic_shutdown",
  ingest(host, report) {
    const normalized = normalizeReport(report);
    if (normalized) setBoundedMapValue(reports, Number(host.id), normalized, 20_000);
  },
  async directive(host) {
    const hostId = Number(host.id);
    if (!(await getTrafficShutdownEnabledHostIds()).has(hostId)) return undefined;
    if (!isAgentVersionAtLeast(String(host.agentVersion || ""), HOST_TRAFFIC_SHUTDOWN_AGENT_VERSION)) return undefined;
    const snapshot = await readHostTrafficShutdownSnapshot(hostId);
    if (!snapshot) return undefined;
    const evaluation = evaluateSnapshot(snapshot, String(host.agentVersion || ""), reports.get(hostId)?.supported);
    if (!evaluation.due) return undefined;
    const mark = await claimHostTrafficShutdown(hostId);
    if (mark === null) return undefined;
    await notifyBeforeShutdown(host, snapshot);
    return { shutdown: true, mark: `${hostId}:${mark}`, thresholdPercent: snapshot.thresholdPercent };
  },
});
