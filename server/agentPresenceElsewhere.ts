import { queryRaw } from "./dbRuntime";
import { quoteIdentifier } from "./dbCompat";
import { agentFastLivenessTracker, AGENT_FAST_LIVENESS_ELSEWHERE_SILENCE_MS } from "./agentFastLiveness";
import { panelHasOtherLiveInstances } from "./panelLease";

/*
  多实例部署时「别的面板实例看到过这台 Agent」的来源：每 10 秒读一次 hosts.lastHeartbeat（连着那台 Agent 的实例
  大约每 90 秒写一次），交给快速存活判断（agentFastLiveness.ts）：
    · 本进程的沉默期限到了、库里显示别的实例最近还见过它 → 先不判离线，按库里的时刻再等；
    · 本进程已经判了离线、库里出现比判离线更晚的时刻 → 当它回来了（它换连到了别的实例）；
    · 本进程从没登记过的主机（启动后才加的，Agent 只连别的实例）→ 按库里的时刻和版本号登记成在线。
  只看比本进程自己看到的更晚的时刻（本进程写进库的那些不算），所以 Agent 连在本实例上时，掉线照样 90 秒判出来。
  只有一个实例时不读库、不参与（panelHasOtherLiveInstances 为 false）。
*/

const AGENT_PRESENCE_ELSEWHERE_REFRESH_MS = 10_000;

const lastSeenByHost = new Map<number, number>();
let timer: ReturnType<typeof setTimeout> | null = null;
let refreshing = false;

function agentLastSeenElsewhere(hostId: number) {
  if (!panelHasOtherLiveInstances()) return null;
  return lastSeenByHost.get(Number(hostId)) ?? null;
}

/** 读一次库（有别的实例时）。返回读到的主机数。 */
export async function refreshAgentPresenceElsewhere(now = Date.now()) {
  if (!panelHasOtherLiveInstances()) {
    lastSeenByHost.clear();
    return 0;
  }
  if (refreshing) return 0;
  refreshing = true;
  try {
    const q = quoteIdentifier;
    const sinceSeconds = Math.floor((now - AGENT_FAST_LIVENESS_ELSEWHERE_SILENCE_MS - AGENT_PRESENCE_ELSEWHERE_REFRESH_MS) / 1000);
    const rows = await queryRaw<{ id: unknown; lastHeartbeat: unknown; agentVersion: unknown }>(
      `SELECT ${q("id")}, ${q("lastHeartbeat")}, ${q("agentVersion")} FROM ${q("hosts")} WHERE ${q("lastHeartbeat")} >= ?`,
      [sinceSeconds],
    );
    lastSeenByHost.clear();
    for (const row of rows) {
      const hostId = Number(row.id);
      const seconds = Number(row.lastHeartbeat);
      if (!Number.isInteger(hostId) || hostId <= 0 || !Number.isFinite(seconds) || seconds <= 0) continue;
      const seenAt = Math.min(seconds * 1000, now);
      lastSeenByHost.set(hostId, seenAt);
      // 本进程没登记过的（启动后新加、Agent 只连别的实例）按版本号登记，不然转发组评估里它一直算离线。
      agentFastLivenessTracker.observeElsewhereActivity(hostId, seenAt, row.agentVersion);
    }
    return rows.length;
  } finally {
    refreshing = false;
  }
}

/** 面板启动时调一次。 */
export function startAgentPresenceElsewhere() {
  agentFastLivenessTracker.setLastSeenElsewhere(agentLastSeenElsewhere);
  if (timer) return;
  const loop = () => {
    timer = setTimeout(() => {
      void refreshAgentPresenceElsewhere().catch((error) => {
        console.warn(`[AgentPresence] elsewhere refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      }).finally(loop);
    }, AGENT_PRESENCE_ELSEWHERE_REFRESH_MS);
    timer.unref?.();
  };
  loop();
}

export function resetAgentPresenceElsewhereForTests() {
  if (timer) clearTimeout(timer);
  timer = null;
  lastSeenByHost.clear();
  agentFastLivenessTracker.setLastSeenElsewhere(null);
}
