/*
  主机实际监听端口核对的 Agent 扩展模块 "ports"（Go 端 agent/ext_ports.go）。

  指令：{ enabled: true }，只发给 Agent 2.2.253 起（AGENT_PORT_OCCUPANCY_VERSION）。老 Agent 不认这个
  模块、也不会上报，规则卡上就没有黄色的端口占用告警；红色的绑定失败来自规则状态回执，新老 Agent 都有。
  上报：启用规则的入口端口上不归 ForwardX 管的监听（只报冲突），结论放在 server/rulePortOccupancy.ts 的内存里。
*/
import * as db from "../db";
import { registerAgentExtModule } from "./agentExt";
import {
  agentSupportsPortOccupancy,
  displayRuleIdForRow,
  parsePortOccupancyReport,
  prunePortOccupancy,
  recordHostPortOccupancy,
} from "../rulePortOccupancy";

function truthy(value: unknown) {
  return value === true || value === 1 || value === "1";
}

/**
 * 把 Agent 报的规则编号核对一遍：规则还在、启用着、确实在这台主机上（本机规则，或者走隧道 / 转发组的入口），
 * 再换成界面上那条的编号。只有出了冲突的规则才查库，绝大多数主机一轮一次都不查。
 */
async function resolveDisplayRuleIds(hostId: number, ruleIds: number[]) {
  const resolved = new Map<number, number>();
  for (const ruleId of Array.from(new Set(ruleIds)).slice(0, 200)) {
    const rule = await db.getForwardRuleById(ruleId).catch(() => undefined) as Record<string, unknown> | undefined;
    if (!rule || !truthy(rule.isEnabled) || truthy(rule.pendingDelete)) continue;
    const onThisHost = Number(rule.hostId) === hostId || Number(rule.tunnelId || 0) > 0 || Number(rule.forwardGroupId || 0) > 0;
    if (!onThisHost) continue;
    resolved.set(ruleId, displayRuleIdForRow(rule));
  }
  return resolved;
}

registerAgentExtModule({
  name: "ports",
  directive(host) {
    return agentSupportsPortOccupancy(host.agentVersion) ? { enabled: true } : undefined;
  },
  async ingest(host, report) {
    const hostId = Number(host.id);
    if (!agentSupportsPortOccupancy(host.agentVersion)) return;
    const parsed = parsePortOccupancyReport(report);
    if (!parsed) return;
    const displayIds = parsed.usable && parsed.conflicts.length > 0
      ? await resolveDisplayRuleIds(hostId, parsed.conflicts.map((conflict) => conflict.ruleId))
      : new Map<number, number>();
    recordHostPortOccupancy(hostId, parsed, (ruleId) => displayIds.get(ruleId) || 0);
  },
});

const pruneTimer = setInterval(() => prunePortOccupancy(), 10 * 60 * 1000);
pruneTimer.unref?.();
