import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { LineBadge } from "@/features/lines/LineUi";
import { routeGroupRuleFields } from "@shared/routeGroup";
import { describeRoutePolicy, type RoutePolicyHost, type RoutePolicyRule } from "@shared/routePolicy";
import { RouteGroupFields, type RouteGroupDraft, type RouteHostOption, type RouteNodeOption } from "./RouteGroupFields";
import { LineEditorShell } from "./RouteLineEditorDialog";
import { ROUTE_LINE_MODE_LABEL } from "./routeLineText";
import type { RouteLinePool, RouteLineTunnel } from "./RouteLinesEditor";
import { routeLineChainText } from "./routeLineOptions";

/*
  规则表单里的线路组（2.3.497 从 pages/Rules.tsx 挪出来）：表单里只放一行摘要和「编辑线路」，点开是
  和线路详情「编辑」同一个框、同一个编辑器（LineEditorShell + RouteGroupFields）。框里改的是一份
  草稿，点「完成」才写回表单，跟着规则一起保存；点「取消」草稿扔掉。
*/

export type RuleLineGroupFieldProps = {
  value: RouteGroupDraft;
  onChange: (next: RouteGroupDraft) => void;
  hosts: RouteHostOption[];
  pools: RouteLinePool[];
  tunnels: RouteLineTunnel[];
  nodeOptions: RouteNodeOption[];
  entryHostId: number | null;
  entryName: string;
  /** 隧道规则：入口前面那段（「Po0 → 隧道 华南-香港 →」）。 */
  entryPrefix: string | null;
  /** 入口前面的机器（隧道规则的隧道入口）：不拿来当中转建议。 */
  upstreamHostIds: number[];
  allowHops: boolean;
  allowTunnels: boolean;
  /** 规则自己的目标（`地址:端口`），还没填是空串。 */
  mainAddress: string;
  /** 算「此刻」用的规则字段：表单里还没保存的样子（目标、协议、转发方式、隧道、PROXY 头）。 */
  policyRule: RoutePolicyRule;
  entryHost?: RoutePolicyHost;
  protocol: string;
  scheduleTimeZone: string;
  ruleId: number | null;
};

export function RuleLineGroupField({
  value,
  onChange,
  hosts,
  pools,
  tunnels,
  nodeOptions,
  entryHostId,
  entryName,
  entryPrefix,
  upstreamHostIds,
  allowHops,
  allowTunnels,
  mainAddress,
  policyRule,
  entryHost,
  protocol,
  scheduleTimeZone,
  ruleId,
}: RuleLineGroupFieldProps) {
  const [draft, setDraft] = useState<RouteGroupDraft | null>(null);
  const policy = useMemo(() => {
    if (!draft) return null;
    return describeRoutePolicy({
      ...policyRule,
      failoverEnabled: true,
      ...routeGroupRuleFields(draft, { targetIp: policyRule.targetIp, targetPort: policyRule.targetPort }),
    }, { host: entryHost });
  }, [draft, policyRule, entryHost]);
  const main = value.lines?.[0];
  const backups = Math.max(0, (value.lines?.length || 1) - 1);
  const hostName = (id: number) => hosts.find((host) => host.id === id)?.name || `主机 ${id}`;

  return (
    <>
      <div className="mt-3 flex min-w-0 items-center justify-between gap-3 rounded-[12px] border border-[var(--fx-stroke-weak)] bg-[var(--fx-l1-surface)] px-3 py-2.5" data-testid="rule-line-summary">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2 text-[13px]">
            <LineBadge main>主</LineBadge>
            <span className="truncate">{main ? routeLineChainText(main, { entryName, hostName, pools, tunnels }) : `${entryName} → 落地`}</span>
          </div>
          <div className="mt-1 text-[11.5px] text-muted-foreground">
            {backups > 0 ? `备用 ${backups} 条` : "还没有备用"}
            {" · "}{ROUTE_LINE_MODE_LABEL[value.policy.mode] || "主备顺序"}
          </div>
        </div>
        <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => setDraft(value)} data-testid="rule-line-edit">
          编辑线路
        </Button>
      </div>
      <LineEditorShell
        open={!!draft}
        onOpenChange={(open) => { if (!open) setDraft(null); }}
        primaryLabel="完成"
        primaryDisabled={!draft}
        onPrimary={() => {
          if (draft) onChange(draft);
          setDraft(null);
        }}
        note="改完点「完成」，跟着规则一起保存"
      >
        {draft ? (
          <RouteGroupFields
            value={draft}
            onChange={setDraft}
            hosts={hosts}
            allowHops={allowHops}
            entryHostId={entryHostId}
            mainAddress={mainAddress}
            policy={policy}
            scheduleTimeZone={scheduleTimeZone}
            protocol={protocol}
            nodeOptions={nodeOptions}
            pools={pools}
            tunnels={tunnels}
            entryName={entryName}
            entryPrefix={entryPrefix}
            allowTunnels={allowTunnels}
            ruleId={ruleId}
            upstreamHostIds={upstreamHostIds}
            defaultAdvancedOpen={false}
          />
        ) : null}
      </LineEditorShell>
    </>
  );
}
