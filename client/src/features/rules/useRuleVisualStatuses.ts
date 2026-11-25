/*
  从 client/src/pages/Rules.tsx 第 5448-5524 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { preferLastKnownForwardRuleVisualStatus, resolveForwardRuleVisualStatus } from "@/lib/forwardRuleStatus";
import { readRuleStatusSnapshots, type RuleVisualStatusSnapshot } from "@/lib/ruleStatusCache";
import { normalizeRuleLimitReason } from "@shared/ruleLimits";
import { useCallback, useMemo } from "react";

export type UseRuleVisualStatusesContext = {
  stableProbeByRule: any /* 原类型 Map<number, RuleProbeSummary>… 引用了拿不到的 RuleProbeSummary，手动收拾 */;
  trafficByRule: any;
  forwardGroupById: Map<number, any>;
  getForwardGroupConfigStatus: (group: any) => "available" | "degraded" | "pending" | "unavailable" | "disabled";
  forwardGroupsFetched: boolean;
  forwardGroupsError: boolean;
  getRuleOfflineHostNames: (rule: any) => string[];
  hosts: Array<any> | undefined;
  tunnels: Array<any> | undefined;
  filteredRules: Array<any>;
  user: any;
  invalidatedRuleProbeIdsRef: any /* 原类型 RefObject<Set<number>>… 引用了拿不到的 RefObject，手动收拾 */;
  ruleProbeCacheRevision: number;
};

export type UseRuleVisualStatusesResult = {
  ruleVisualStatuses: Map<number, { current: ReturnType<typeof resolveForwardRuleVisualStatus>; display: ReturnType<typeof resolveForwardRuleVisualStatus>; lastKnown: RuleVisualStatusSnapshot | null; invalidated: boolean; }>;
  resolveRuleVisualStatus: (rule: any) => ReturnType<typeof resolveForwardRuleVisualStatus>;
};

export function useRuleVisualStatuses(ctx: UseRuleVisualStatusesContext): UseRuleVisualStatusesResult {
  const { stableProbeByRule, trafficByRule, forwardGroupById, getForwardGroupConfigStatus, forwardGroupsFetched, forwardGroupsError, getRuleOfflineHostNames, hosts, tunnels, filteredRules, user, invalidatedRuleProbeIdsRef, ruleProbeCacheRevision } = ctx;
  const resolveRuleVisualStatus = useCallback((rule: any): ReturnType<typeof resolveForwardRuleVisualStatus> => {
    const latest = stableProbeByRule.get(Number(rule.id));
    // 负载均衡链路：各台出口到目标的情况（不进探测缓存，按这一次的汇总）
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
  }, [forwardGroupById, forwardGroupsError, forwardGroupsFetched, getForwardGroupConfigStatus, stableProbeByRule, trafficByRule, hosts, tunnels]);
  const ruleVisualStatuses = useMemo(() => {
    const statuses = new Map<number, {
      current: ReturnType<typeof resolveForwardRuleVisualStatus>;
      display: ReturnType<typeof resolveForwardRuleVisualStatus>;
      lastKnown: RuleVisualStatusSnapshot | null;
      invalidated: boolean;
    }>();
    const ruleIds = filteredRules
      .map((rule: any) => Number(rule?.id || 0))
      .filter((ruleId: number) => Number.isInteger(ruleId) && ruleId > 0);
    const lastKnownByRule = readRuleStatusSnapshots(user?.id, ruleIds);
    for (const rule of filteredRules) {
      const ruleId = Number(rule?.id || 0);
      if (!Number.isInteger(ruleId) || ruleId <= 0) continue;
      const current = resolveRuleVisualStatus(rule);
      const invalidated = invalidatedRuleProbeIdsRef.current.has(ruleId);
      const lastKnown = invalidated ? null : lastKnownByRule.get(ruleId) || null;
      statuses.set(ruleId, {
        current,
        lastKnown,
        invalidated,
        display: preferLastKnownForwardRuleVisualStatus(current, lastKnown),
      });
    }
    return statuses;
  }, [filteredRules, resolveRuleVisualStatus, ruleProbeCacheRevision, user?.id]);
  return { ruleVisualStatuses, resolveRuleVisualStatus };
}
