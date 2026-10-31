import { useMemo } from "react";

import { routeGroupRuleFields } from "@shared/routeGroup";
import { describeRoutePolicy, type RoutePolicyHost, type RoutePolicyRule } from "@shared/routePolicy";
import { RouteGroupFields, type RouteGroupDraft, type RouteHostOption, type RouteNodeOption } from "./RouteGroupFields";
import type { RouteLinePool, RouteLineTunnel } from "./RouteLinesEditor";
import { SegmentLatencyProvider } from "./SegmentLatencyProvider";

/*
  规则表单里的线路组（从 pages/Rules.tsx 挪出来）：编辑器直接摆在表单里，和规则在同一页改、一起保存
  （2.3.498 起又回到一页：2.3.497 的「摘要 + 编辑线路」要在规则框上再叠一层框，用户要的是一页改完）。
  编辑器和线路详情第一页用的是同一个（RouteGroupFields），每段的毫秒也一样有（SegmentLatencyProvider）。
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
  /** 规则目标绑着的节点（落地池的池节点时，「规则目标」预览成池里的几台）。 */
  ruleTargetNodeId?: number | null;
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
  ruleTargetNodeId = null,
}: RuleLineGroupFieldProps) {
  const policy = useMemo(() => describeRoutePolicy({
    ...policyRule,
    failoverEnabled: true,
    ...routeGroupRuleFields(value, { targetIp: policyRule.targetIp, targetPort: policyRule.targetPort }),
  }, { host: entryHost }), [value, policyRule, entryHost]);

  return (
    <div className="mt-3 border-t border-[var(--fx-stroke-weak)] pt-3" data-testid="rule-line-group">
      <SegmentLatencyProvider>
        <RouteGroupFields
          value={value}
          onChange={onChange}
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
          ruleTargetNodeId={ruleTargetNodeId}
          upstreamHostIds={upstreamHostIds}
          defaultAdvancedOpen={false}
        />
      </SegmentLatencyProvider>
    </div>
  );
}
