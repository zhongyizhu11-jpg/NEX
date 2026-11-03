import * as db from "./db";
import { clearTunnelRuntimeStatusForHost } from "./tunnelRuntimeStatus";
import { appendPanelLog } from "./_core/panelLogger";
import { normalizeAgentText } from "./agentInputValidation";
import { refreshAgentsAffectedByHostAddress } from "./hostAddressRuntime";
import { runAgentRuntimeRecovery } from "./agentRuntimeRecovery";
import { invalidateAgentDesiredStateCache } from "./agentHeartbeatState";

/*
  Agent 重启 / 掉线恢复：从心跳判断机器重启过没有，以及恢复时把面板里这台机器的运行态标成要重下。
  从 server/agentHeartbeatRoute.ts 里原样搬出来，行为不变。
*/

const AGENT_REBOOT_DETECTION_GRACE_MS = 1000;

export function heartbeatTimestampMs(value: unknown) {
  if (!value) return 0;
  const timestamp = new Date(value as any).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function heartbeatUptimeSeconds(value: unknown) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

export function heartbeatIndicatesAgentReboot(previousHost: any, uptime: unknown, bootId?: unknown, nowMs = Date.now()) {
  const nextBootId = normalizeAgentText(bootId, 128);
  const previousBootId = normalizeAgentText(previousHost?.agentBootId, 128);
  if (nextBootId && previousBootId) return nextBootId !== previousBootId;
  const lastHeartbeatMs = heartbeatTimestampMs(previousHost?.lastHeartbeat);
  const uptimeSeconds = heartbeatUptimeSeconds(uptime);
  if (lastHeartbeatMs <= 0 || uptimeSeconds <= 0) return false;
  const bootedAtMs = nowMs - uptimeSeconds * 1000;
  return bootedAtMs > lastHeartbeatMs + AGENT_REBOOT_DETECTION_GRACE_MS;
}

export async function resetAgentRuntimeStateForRecovery(
  hostId: number,
  reason: string,
  options: { preserveReportedRuntime?: boolean } = {},
) {
  const id = Number(hostId);
  if (!Number.isFinite(id) || id <= 0) return;
  await runAgentRuntimeRecovery(id, options, async () => {
    // A reboot/process restart invalidates the panel's in-memory per-host tunnel
    // readiness even when the Agent supplied a local snapshot. The snapshot is
    // used to avoid needless teardown, but it must not keep a stale multi-hop
    // host marked ready and suppress the recovery action for that hop.
    clearTunnelRuntimeStatusForHost(id);
    if (!options.preserveReportedRuntime) {
      await db.resetAgentRuntimeStateForHost(id);
    }
    // resolveAgentLocalRuntimeState() runs before restart detection. Preserve the
    // snapshot accepted in this heartbeat or the next request would need to
    // upload it again before reconciliation can continue.
    invalidateAgentDesiredStateCache(id, { preserveLocalRuntimeState: true });
    await refreshAgentsAffectedByHostAddress(id, reason);
    appendPanelLog(
      "info",
      `[AgentRecovery] host=${id} reason=${reason} runtime state ${options.preserveReportedRuntime ? "reconciling from local snapshot" : "marked for reapply"}`,
    );
  });
}
