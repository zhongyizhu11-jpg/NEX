import * as db from "./db";
import { forgetBalanceLiveTunnel } from "./balanceLive";
import { forgetExitTargetTunnel } from "./exitTargetHealth";
import { appendPanelLog } from "./_core/panelLogger";
import { forgetTunnelLatencyView } from "./ruleLatencyView";
import { startRuleSelfTest } from "./ruleSelfTestStart";

/*
  链路换了拓扑（2.3.547，用户：「隧道换了出口，转发的不实时变过来？」）。

  实验室实测（GOST 链路、出口组 → 单出口）：真实流量 2 秒就走新出口了，可面板上
    - 规则卡的「经 3 台出口」要 35 秒（入口上一份实时上报过期）才清掉；
    - 链路弹窗的出口汇总 97 秒才不再把旧出口算成在用；
    - 诊断弹窗一直画上次诊断那条旧路线（入口 → 旧出口 → 目标），不重测永远不变。
  原因都是一样的：面板内存里记着旧路线的探测（入口到出口、出口到目标、入口报的在用出口、出口快速探测），
  谁都没在换拓扑时清掉；诊断快照更是库里一行死数据。

  现在隧道保存时拓扑一变（入口 / 出口 / 中转 / 出口组 / 负载均衡开关）就：
    1. 把这条链路和它上面各规则的旧探测整段忘掉（三处内存），规则卡退回定时探测 / 诊断，等新路线测到再画；
    2. 给链路记下 topologyChangedAt，诊断弹窗拿它和上次诊断比：诊断更早就是旧路线的，按现在的配置画并自动重测；
    3. 等 Agent 拉到新配置后（约 4 秒）自动给链路上启用着的规则各排一次诊断（最多 20 条），新路线的两段几秒内就有。
*/

const SELF_TEST_DELAY_MS = 4_000;
const SELF_TEST_MAX_RULES = 20;

type TunnelRuleRow = { id: number; isEnabled?: unknown; isForwardGroupTemplate?: unknown; forwardGroupId?: unknown };

/** 规则自己换了隧道 / 入口 / 目标：忘掉它一条的旧路线状态，Agent 拉到新配置后自动重测一次。 */
export function noteRuleRouteChanged(ruleId: number, options: { reason: string; diagnose?: boolean } = { reason: "rule-route-changed" }) {
  const id = Number(ruleId);
  if (!(id > 0)) return;
  forgetTunnelLatencyView(0, [id]);
  forgetExitTargetTunnel(0, [id]);
  forgetBalanceLiveTunnel(0, [id]);
  appendPanelLog("info", `[TunnelTopology] rule=${id} ${options.reason}: forgot cached route state`);
  if (options.diagnose === false) return;
  const timer = setTimeout(() => {
    void db.getForwardRuleById(id)
      .then((fresh) => (fresh && fresh.isEnabled !== false ? startRuleSelfTest(fresh) : null))
      .catch((error: unknown) => appendPanelLog("warn", `[TunnelTopology] rule=${id} auto diagnose failed: ${(error as Error)?.message || error}`));
  }, SELF_TEST_DELAY_MS);
  timer.unref?.();
}

/** 清掉这条链路在内存里的旧路线状态（同步，保存事务里也能调）。返回链路上的规则 id。 */
export async function forgetTunnelTopologyState(tunnelId: number) {
  const rules = await db.getForwardRulesByTunnel(Number(tunnelId)).catch(() => [] as TunnelRuleRow[]) as TunnelRuleRow[];
  const ruleIds = rules.map((rule) => Number(rule.id)).filter((id) => id > 0);
  forgetTunnelLatencyView(tunnelId, ruleIds);
  forgetExitTargetTunnel(Number(tunnelId), ruleIds);
  forgetBalanceLiveTunnel(Number(tunnelId), ruleIds);
  return { rules, ruleIds };
}

/**
 * 隧道保存时拓扑变了：清旧状态、记时间，并在 Agent 拉到新配置后给规则排诊断。
 * 在事务提交之后调（diagnose 为 false 时只清状态、不排诊断）。
 */
export async function noteTunnelTopologyChanged(tunnelId: number, options: { reason: string; diagnose?: boolean } = { reason: "tunnel-updated" }) {
  const { rules, ruleIds } = await forgetTunnelTopologyState(tunnelId);
  await db.updateTunnel(Number(tunnelId), { topologyChangedAt: new Date() } as never).catch((error: unknown) => {
    appendPanelLog("warn", `[TunnelTopology] record topologyChangedAt failed tunnel=${tunnelId}: ${(error as Error)?.message || error}`);
  });
  appendPanelLog("info", `[TunnelTopology] tunnel=${tunnelId} ${options.reason}: forgot cached route state rules=${ruleIds.length}`);
  if (options.diagnose === false) return { ruleIds, queued: 0 };
  const candidates = rules
    .filter((rule) => rule.isEnabled !== false && Number(rule.isEnabled ?? 1) !== 0)
    .slice(0, SELF_TEST_MAX_RULES);
  const timer = setTimeout(() => {
    void (async () => {
      let queued = 0;
      for (const rule of candidates) {
        try {
          const fresh = await db.getForwardRuleById(Number(rule.id));
          if (!fresh || Number(fresh.tunnelId || 0) !== Number(tunnelId)) continue;
          await startRuleSelfTest(fresh);
          queued += 1;
        } catch (error) {
          appendPanelLog("warn", `[TunnelTopology] tunnel=${tunnelId} rule=${rule.id} auto diagnose failed: ${(error as Error)?.message || error}`);
        }
      }
      if (queued > 0) appendPanelLog("info", `[TunnelTopology] tunnel=${tunnelId} queued ${queued} rule diagnoses on the new route`);
    })();
  }, SELF_TEST_DELAY_MS);
  timer.unref?.();
  return { ruleIds, queued: candidates.length };
}
