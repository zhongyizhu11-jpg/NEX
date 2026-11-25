/*
  从 client/src/pages/Rules.tsx 第 6219-6314 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { type ReactElement } from "react";
import { type RuleCardRule } from "../../pages/Rules";
import { Badge } from "@/components/ui/badge";
import { FAILOVER_TONE_CLASS, describeFailoverLineDisplay } from "@/lib/failoverLineDisplay";
import { cn } from "@/lib/utils";
import { AlertTriangle, GitBranch, Zap } from "lucide-react";

export type UseRuleSourceBadgesContext = {
  subscriptionAllowed: boolean;
  proxyNodeNameById: Map<number, string>;
  driftedRuleIds: Set<number>;
  hostById: Map<number, any>;
  setPolicyRuleId: any /* 原类型 Dispatch<SetStateAction<number | null>>… 引用了拿不到的 Dispatch，手动收拾 */;
};

export type UseRuleSourceBadgesResult = {
  renderSubscriptionBadge: (rule: RuleCardRule, placement?: "table" | "card") => ReactElement | null;
  renderFailoverLineBadge: (rule: RuleCardRule) => ReactElement | null;
  renderSubscriptionMark: (rule: RuleCardRule) => ReactElement | null;
};

export function useRuleSourceBadges(ctx: UseRuleSourceBadgesContext): UseRuleSourceBadgesResult {
  const { subscriptionAllowed, proxyNodeNameById, driftedRuleIds, hostById, setPolicyRuleId } = ctx;
  const renderSubscriptionBadge = (rule: any, placement: "table" | "card" = "table") => {
    if (!subscriptionAllowed) return null;
    const nodeId = Number(rule?.proxyNodeId || 0);
    if (!nodeId) return null;
    const nodeName = proxyNodeNameById.get(nodeId) || "落地节点";
    const visible = rule?.proxyNodeVisible !== false;
    const drifted = driftedRuleIds.has(Number(rule?.id || 0));
    // 卡片上正常的「订阅」写在名字后面（renderSubscriptionMark），这里只剩指向已变那种要人看的。
    if (placement === "card" && !drifted) return null;
    /*
      绑定和现实对不上了：这条线路还在订阅里，但客户端会拿着「nodeName」那个落地的
      凭据去连现在这个目标。比「少一条线路」严重，所以用警示色，别混在正常的订阅角标里。
    */
    if (drifted) {
      return (
        <Badge
          variant="outline"
          className="w-fit whitespace-nowrap border-[color-mix(in_srgb,var(--fx-warn)_40%,transparent)] text-[11px] text-[var(--fx-warn-text)]"
          title={`这条转发的目标已经不是它绑的「${nodeName}」了。订阅里那条线路还在，但客户端连过去是拿着「${nodeName}」的凭据去连新目标 —— 把目标改回去，或者在这里重新选节点。`}
        >
          <AlertTriangle className="mr-1 h-3 w-3" />
          订阅·指向已变
        </Badge>
      );
    }
    return (
      <Badge
        variant="outline"
        className={`w-fit whitespace-nowrap text-[11px] ${
          visible ? "border-[color-mix(in_srgb,var(--fx-path)_30%,transparent)] text-[var(--fx-path)]" : "border-muted-foreground/30 text-muted-foreground"
        }`}
        title={visible
          ? `这条转发以「${nodeName}」的身份出现在你的订阅里。改目标、停用或删掉它，客户端里那条线路会跟着变。`
          : `已绑定「${nodeName}」，但设成了不进订阅。转发照常跑，客户端里看不到它。`}
      >
        <Zap className="mr-1 h-3 w-3" />
        {visible ? "订阅" : "订阅已隐藏"}
      </Badge>
    );
  };

  /**
   * 卡片名字后面那两个字「订阅」：说明这条转发在客户端订阅里。
   *
   * 原来是名字下面单独一行的徽标 —— 卡上为它多 24px，看着像又一条状态。它其实是这条
   * 转发的一个身份，跟名字待在一起就够了；指向已变那种要人处理的仍走 renderSubscriptionBadge。
   */
  const renderSubscriptionMark = (rule: any) => {
    if (!subscriptionAllowed) return null;
    const nodeId = Number(rule?.proxyNodeId || 0);
    if (!nodeId) return null;
    if (driftedRuleIds.has(Number(rule?.id || 0))) return null;
    const nodeName = proxyNodeNameById.get(nodeId) || "落地节点";
    const visible = rule?.proxyNodeVisible !== false;
    return (
      <span
        className="fx-rule-mark"
        data-muted={visible ? undefined : ""}
        title={visible
          ? `这条转发以「${nodeName}」的身份出现在你的订阅里。改目标、停用或删掉它，客户端里那条线路会跟着变。`
          : `已绑定「${nodeName}」，但设成了不进订阅。转发照常跑，客户端里看不到它。`}
      >
        <Zap className="h-3 w-3" aria-hidden="true" />
        {visible ? "订阅" : "订阅已隐藏"}
      </span>
    );
  };

  /*
    规则行上的主备状态。
    原来这里只有一个「主备 2」的计数徽标 —— 它回答的是「配了几条」，而人要
    知道的是「现在走的哪条」。配了主备和没配在列表上几乎长一样，功能配完就
    看不见了，这正是「主备到底在哪儿用」说不清楚的地方。
  */
  const renderFailoverLineBadge = (rule: any) => {
    const display = describeFailoverLineDisplay(rule, hostById.get(Number(rule.hostId)));
    if (!display) return null;
    // 点进去是线路组面板：现在走哪条、当前和备用路径、调度计划、最近切换、应急强制走。
    return (
      <button
        type="button"
        className="shrink-0 rounded-[var(--fx-radius-control)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => setPolicyRuleId(Number(rule.id))}
        title={display.title}
        aria-label={`线路组：${display.title}`}
      >
        <Badge
          variant="outline"
          className={cn("h-5 cursor-pointer gap-1 px-1.5 text-[11px] font-medium", FAILOVER_TONE_CLASS[display.tone])}
        >
          <GitBranch className="h-3 w-3" aria-hidden="true" />
          {display.text}
        </Badge>
      </button>
    );
  };
  return { renderSubscriptionBadge, renderFailoverLineBadge, renderSubscriptionMark };
}
