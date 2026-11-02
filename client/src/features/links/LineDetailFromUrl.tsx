import { useEffect, useMemo } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";

import { RouteGroupSheet } from "@/features/rules/RouteGroupSheet";
import type { HostOptionRow, LineRuleRow } from "@/features/rules/routeLineOptions";
import { trpc } from "@/lib/trpc";
import { routeGroupOf } from "@shared/routeGroup";
import { describeRoutePolicy, pinUntilSeconds } from "@shared/routePolicy";
import { LINE_PARAM, useSearchIdParam } from "./lineLinks";

/*
  /rules?line=<规则 id>：打开这条线路的详情（2.3.506，见 lineLinks.ts）。

  自己按 id 取规则，不靠转发规则页当前这一页的列表 —— 分享来的线路不一定在第一页。打开时地址栏一直带着
  ?line=，关掉就去掉。手动切换、改线路和线路概览里那一份一样（同一个 RouteGroupSheet）。
*/
export function LineDetailFromUrl() {
  const [ruleId, setRuleId] = useSearchIdParam(LINE_PARAM);
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  const enabled = !!ruleId;
  const ruleQuery = trpc.rules.getById.useQuery({ id: Number(ruleId || 0) }, { enabled, staleTime: 10_000, refetchOnWindowFocus: false });
  const hostsQuery = trpc.hosts.options.useQuery(undefined, { enabled, staleTime: 60_000 });
  const rule = (enabled ? ruleQuery.data : null) as LineRuleRow | null | undefined;
  const policy = useMemo(() => {
    if (!rule || !routeGroupOf(rule)) return null;
    const host = ((hostsQuery.data || []) as HostOptionRow[]).find((item) => Number(item.id) === Number(rule.hostId));
    return describeRoutePolicy(rule, { host }) ?? null;
  }, [rule, hostsQuery.data]);

  // 规则没了、看不到、没开线路组：说一声，把参数去掉（不然刷新还会再提示一遍）。
  useEffect(() => {
    if (!enabled || ruleQuery.isLoading || ruleQuery.isFetching) return;
    if (ruleQuery.error || !ruleQuery.data) {
      toast.error("这条线路不存在，或者你没有权限查看");
      setRuleId(null);
    } else if (!routeGroupOf(ruleQuery.data as LineRuleRow)) {
      toast.error("这条规则没有开线路组");
      setRuleId(null);
    }
  }, [enabled, ruleQuery.isLoading, ruleQuery.isFetching, ruleQuery.error, ruleQuery.data, setRuleId]);

  const pinMutation = trpc.rules.update.useMutation({
    onSuccess: (_data, variables) => {
      void utils.rules.getById.invalidate({ id: Number(variables.id) });
      void utils.rules.list.invalidate();
      void utils.rules.listPage.invalidate();
      void utils.rules.routeStatus.invalidate({ ruleId: Number(variables.id) });
      void utils.rules.routeEvents.invalidate({ ruleId: Number(variables.id) });
      void utils.rules.routeBoard.invalidate();
      toast.success(variables.failoverPinnedIndex === null || variables.failoverPinnedIndex === undefined
        ? "已交回自动"
        : "已手动指定：调度这条线路的机器收到就切过去");
    },
    onError: (error) => toast.error(error.message || "操作失败"),
  });

  if (!ruleId) return null;
  const id = Number(ruleId);
  return (
    <RouteGroupSheet
      open={!!policy}
      onOpenChange={(open) => { if (!open) setRuleId(null); }}
      ruleId={id}
      subjectName={String(rule?.name || "")}
      policy={policy}
      rule={rule && !Number(rule.forwardGroupRuleId || 0) ? rule : undefined}
      canEdit
      pending={pinMutation.isPending}
      onPin={(index, durationSeconds, onDone) => pinMutation.mutate({
        id,
        failoverPinnedIndex: index,
        failoverPinnedUntil: pinUntilSeconds(durationSeconds),
      }, { onSuccess: () => onDone?.() })}
      onUnpin={(onDone) => pinMutation.mutate({ id, failoverPinnedIndex: null, failoverPinnedUntil: null }, { onSuccess: () => onDone?.() })}
      onEdit={() => { setRuleId(null); setLocation(`/rules?edit=${id}`); }}
    />
  );
}
