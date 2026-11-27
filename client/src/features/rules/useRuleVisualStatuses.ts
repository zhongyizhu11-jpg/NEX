/*
  规则卡的状态：只看服务端这一次给的（server/ruleLiveStatus.ts 已经把实时样本、在用出口都拼好了）。
  2.3.559 起前端不再另存一份「上次状态」/ 探测缓存：刷新页面不会先闪一下几分钟前的颜色，也不会拿旧的盖掉新的。
*/
import { resolveForwardRuleVisualStatus } from "@/lib/forwardRuleStatus";
import { normalizeRuleLimitReason } from "@shared/ruleLimits";
import { useCallback, useMemo } from "react";

export type UseRuleVisualStatusesContext = {
  probeByRule: Map<number, any>;
  trafficByRule: any;
  forwardGroupById: Map<number, any>;
  getForwardGroupConfigStatus: (group: any) => "available" | "degraded" | "pending" | "unavailable" | "disabled";
  forwardGroupsFetched: boolean;
  forwardGroupsError: boolean;
  getRuleOfflineHostNames: (rule: any) => string[];
  hosts: Array<any> | undefined;
  tunnels: Array<any> | undefined;
  filteredRules: Array<any>;
};

export type UseRuleVisualStatusesResult = {
  ruleVisualStatuses: Map<number, ReturnType<typeof resolveForwardRuleVisualStatus>>;
  resolveRuleVisualStatus: (rule: any) => ReturnType<typeof resolveForwardRuleVisualStatus>;
};

export function useRuleVisualStatuses(ctx: UseRuleVisualStatusesContext): UseRuleVisualStatusesResult {
  const { probeByRule, trafficByRule, forwardGroupById, getForwardGroupConfigStatus, forwardGroupsFetched, forwardGroupsError, getRuleOfflineHostNames, hosts, tunnels, filteredRules } = ctx;
  const resolveRuleVisualStatus = useCallback((rule: any): ReturnType<typeof resolveForwardRuleVisualStatus> => {
    const latest = probeByRule.get(Number(rule.id));
    // 负载均衡链路：各台出口到目标的情况
    const exitTargets = trafficByRule.get(Number(rule.id));
    const exitTargetFields = {
      exitTargetOk: exitTargets?.exitTargetOk ?? null,
      exitTargetNote: exitTargets?.exitTargetNote ?? null,
    };
    if (rule.forwardGroupId) {
      const group = forwardGroupById.get(Number(rule.forwardGroupId));
      const runtime = Array.isArray(group?.ruleRuntimeStatuses)
        ? group.ruleRuntimeStatuses.find((item: any) => Number(item.templateRuleId) === Number(rule.id))
        : null;
      const rawGroupStatus = group
        ? getForwardGroupConfigStatus(group)
        : forwardGroupsFetched || forwardGroupsError
          ? "unavailable"
          : "pending";
      const groupStatus = rawGroupStatus === "degraded" ? "available" : rawGroupStatus;
      return resolveForwardRuleVisualStatus({
        ruleEnabled: !!rule.isEnabled && !normalizeRuleLimitReason(rule.ruleLimitReason),
        ruleRunning: !!rule.isRunning,
        resourceAccessAllowed: rule.resourceAccessAllowed,
        groupEnabled: group?.isEnabled !== false,
        groupConfigStatus: groupStatus,
        runtimeStatus: runtime?.status,
        runningCount: runtime?.runningRuleCount,
        expectedCount: runtime?.expectedRuleCount,
        latestLatencyMs: latest?.latestLatencyMs,
        latestLatencyIsTimeout: latest?.latestLatencyIsTimeout,
        latestLatencyAt: latest?.latestLatencyAt,
        latestProbeFailure: latest?.latestProbeFailure,
        offlineHostNames: getRuleOfflineHostNames(rule),
        ...exitTargetFields,
      });
    }
    return resolveForwardRuleVisualStatus({
      ruleEnabled: !!rule.isEnabled && !normalizeRuleLimitReason(rule.ruleLimitReason),
      ruleRunning: !!rule.isRunning,
      resourceAccessAllowed: rule.resourceAccessAllowed,
      groupEnabled: true,
      groupConfigStatus: "available",
      latestLatencyMs: latest?.latestLatencyMs,
      latestLatencyIsTimeout: latest?.latestLatencyIsTimeout,
      latestLatencyAt: latest?.latestLatencyAt,
      latestProbeFailure: latest?.latestProbeFailure,
      offlineHostNames: getRuleOfflineHostNames(rule),
      ...exitTargetFields,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forwardGroupById, forwardGroupsError, forwardGroupsFetched, getForwardGroupConfigStatus, probeByRule, trafficByRule, hosts, tunnels]);
  const ruleVisualStatuses = useMemo(() => {
    const statuses = new Map<number, ReturnType<typeof resolveForwardRuleVisualStatus>>();
    for (const rule of filteredRules) {
      const ruleId = Number(rule?.id || 0);
      if (Number.isInteger(ruleId) && ruleId > 0) statuses.set(ruleId, resolveRuleVisualStatus(rule));
    }
    return statuses;
  }, [filteredRules, resolveRuleVisualStatus]);
  return { ruleVisualStatuses, resolveRuleVisualStatus };
}
