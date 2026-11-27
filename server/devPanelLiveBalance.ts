import { setBalanceLiveReportForTest, type LiveExit } from "./balanceLive";
import { executeRaw, queryRaw } from "./dbRuntime";
import { tunnelBalanceDetect } from "./exitTargetHealth";
import { recordRuleTargetLeg, recordTunnelExitLeg } from "./ruleLatencyView";

/*
  本地开发面板（npm run dev:panel）没有真的 Agent：负载均衡链路的「入口 → 每台出口」探测和入口实时上报都没有，
  出口弹窗就看不出样子。这里每 10 秒给有多台出口的链路编一份：
    - 每台出口到出口的延迟（5–40 ms 不等）
    - 离线的出口：入口连不上；「附加：检查出口到目标」开着时，在线的最后一台当它连不上目标（入口不分给它）
    - 种子里在线的主机刷新心跳，一直算在线
  只在开发面板里跑（backgroundServices.ts）。
*/
type Row = { id: number; exitHostId: number; entryHostId: number; balanceDetect: string | null; loadBalanceStrategy: string | null };

async function feed() {
  // 种子里在线的主机一直在线（没有真 Agent 发心跳，过一两分钟就全被算成离线了）；种子里离线的那台照旧离线
  await executeRaw('UPDATE hosts SET "lastHeartbeat" = ? WHERE "isOnline" = 1', [Math.floor(Date.now() / 1000)]);
  const tunnels = await queryRaw('SELECT id, "exitHostId", "entryHostId", "balanceDetect", "loadBalanceStrategy" FROM tunnels WHERE "loadBalanceEnabled" = 1') as Row[];
  const now = Date.now();
  for (const tunnel of tunnels) {
    const nodes = await queryRaw('SELECT "hostId" FROM tunnel_exit_nodes WHERE "tunnelId" = ? ORDER BY seq', [tunnel.id]) as Array<{ hostId: number }>;
    const exitIds = Array.from(new Set([Number(tunnel.exitHostId), ...nodes.map((node) => Number(node.hostId))].filter((id) => id > 0)));
    if (exitIds.length < 2) continue;
    const chain = tunnelBalanceDetect(tunnel as never).scope === "chain";
    const rules = await queryRaw('SELECT id FROM forward_rules WHERE "tunnelId" = ?', [tunnel.id]) as Array<{ id: number }>;
    const offline = new Set((await queryRaw('SELECT id FROM hosts WHERE "isOnline" = 0') as Array<{ id: number }>).map((row) => Number(row.id)));
    // 离线的出口入口也连不上；「附加」开着时，在线的最后一台当它连不上目标
    const online = exitIds.filter((hostId) => !offline.has(hostId));
    const blockedHostId = chain && online.length >= 2 ? online[online.length - 1] : 0;
    const serving = online.filter((hostId) => hostId !== blockedHostId).length;
    const exits: LiveExit[] = exitIds.map((hostId, index) => {
      const down = offline.has(hostId);
      const ms = down ? null : 5 + ((hostId * 7 + index * 11) % 36);
      recordTunnelExitLeg(tunnel.id, hostId, ms, now);
      const blocked = hostId === blockedHostId;
      return {
        hostId, hostName: `主机 ${hostId}`, host: `198.51.100.${hostId}`, port: 24000 + hostId,
        state: down || blocked ? "down" : "active", reason: down ? "exit" : blocked ? "target" : null,
        share: down || blocked ? null : 1 / Math.max(1, serving), picks: 12,
        medianMs: null, exitMs: ms, targetMs: chain && !down && !blocked ? 3 + (hostId % 5) : null, targetLatencyUnknown: !chain && !down,
        jitterMs: 1, lossPct: down ? 100 : 0, samples: 20,
        udpState: null, peerOutdated: false,
      };
    });
    for (const rule of rules) {
      // 每台能用的出口到这条规则目标的那段（弹窗每台出口下面的「规则名 延迟」要用）
      for (const exit of exits) {
        if (exit.state !== "down") recordRuleTargetLeg({ ruleId: rule.id, tunnelId: tunnel.id, exitHostId: exit.hostId, primaryHostId: Number(tunnel.exitHostId), ms: 20 + ((rule.id * 13 + exit.hostId * 7) % 25), at: now });
      }
      setBalanceLiveReportForTest({
        ruleId: rule.id, tunnelId: tunnel.id, entryHostId: Number(tunnel.entryHostId), entryHostName: "入口",
        strategy: String(tunnel.loadBalanceStrategy || "round_robin"), targetAware: chain, source: "agent",
        exits, events: [], at: now,
      }, Number(tunnel.entryHostId));
    }
  }
}

export function startDevPanelLiveBalance() {
  const run = () => feed().catch((error) => console.warn(`[DevPanel] live balance feed: ${error instanceof Error ? error.message : String(error)}`));
  void run();
  setInterval(run, 10_000).unref();
}
