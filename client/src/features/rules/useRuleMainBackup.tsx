/*
  从 client/src/pages/Rules.tsx 第 3477-3549 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { usePanelFlags } from "@/hooks/usePanelFlags";
import { buildKernelForwardWarning, isForwardChainGroup, isForwardGroupMainBackupTunnelSupported, isGostTunnelForMainBackup, type RuleFormData, type RulePageUser, type RuleResourceRow, type RuleRouteMode } from "../../pages/Rules";
import { forwardGroupModeOf } from "@shared/forwardTypes";
import { routeGroupForwardTypeSupported, routeStrategyLabel } from "@shared/routeGroup";
import { useMemo } from "react";

export type UseRuleMainBackupContext = {
  panelFlags: Pick<ReturnType<typeof usePanelFlags>, "telegramBotReady">;
  form: RuleFormData;
  selectedForwardGroup: RuleResourceRow;
  effectiveRouteForwardType: "iptables" | "nftables" | "realm" | "socat" | "gost" | "nginx";
  selectedTunnel: RuleResourceRow;
  tunnelById: Map<number, RuleResourceRow>;
  user: RulePageUser;
  usableForwardTypes: Array<"iptables" | "nftables" | "realm" | "socat" | "gost" | "nginx">;
  routeModeLocked: false;
  isSniEntryMode: boolean;
  egressActive: boolean;
  canUseFailoverGroup: boolean;
  setRouteMode: (mode: RuleRouteMode, aggregate?: boolean) => void;
  canUseGost: boolean;
  selectedHost: RuleResourceRow;
  hosts: Array<RuleResourceRow> | undefined;
  hostById: Map<number, RuleResourceRow>;
  forwardGroupById: Map<number, RuleResourceRow>;
};

export type UseRuleMainBackupResult = {
  canUseMainBackup: boolean;
  telegramBotReady: boolean;
  selectedForwardGroupIsChain: boolean;
  mainBackupDisabledText: string;
  kernelForwardWarning: string | null;
  routeGroupSectionVisible: boolean;
  routeGroupSummary: string;
  canAutoSwitchMainBackupToGost: boolean;
  mainBackupBlock: { reason: string; fix?: { label: string; run: () => void; }; } | null;
};

export function useRuleMainBackup(ctx: UseRuleMainBackupContext): UseRuleMainBackupResult {
  const { panelFlags, form, selectedForwardGroup, effectiveRouteForwardType, selectedTunnel, tunnelById, user, usableForwardTypes, routeModeLocked, isSniEntryMode, egressActive, canUseFailoverGroup, setRouteMode, canUseGost, selectedHost, hosts, hostById, forwardGroupById } = ctx;
  const telegramBotReady = panelFlags.telegramBotReady;
  const selectedForwardGroupIsChain = form.routeMode === "chain" || isForwardChainGroup(selectedForwardGroup);
  const selectedForwardGroupIsPort = forwardGroupModeOf(selectedForwardGroup) === "port";
  const mainBackupForwardType = effectiveRouteForwardType;
  const mainBackupUsesTunnelRoute = form.routeMode === "tunnel" || (!selectedForwardGroupIsChain && selectedForwardGroup?.groupType === "tunnel");
  const mainBackupIsTunnelRoute =
    (form.routeMode === "tunnel" && isGostTunnelForMainBackup(selectedTunnel))
    || isForwardGroupMainBackupTunnelSupported(selectedForwardGroup, tunnelById);
  // 线路组挂在用户态转发上（gost / realm / socat / nginx）：调度器插在它和路径之间。
  const mainBackupPortForwardSupported = !mainBackupUsesTunnelRoute
    && routeGroupForwardTypeSupported(mainBackupForwardType)
    && (user?.role === "admin" || selectedForwardGroupIsPort);
  const canAutoSwitchMainBackupToGost = !selectedForwardGroupIsChain
    && !mainBackupUsesTunnelRoute
    && !routeGroupForwardTypeSupported(mainBackupForwardType)
    && usableForwardTypes.includes("gost")
    && !routeModeLocked
    && user?.role === "admin"
    && form.routeMode === "local"
    && !selectedForwardGroupIsPort;
  const canUseMainBackup = !selectedForwardGroupIsChain
    && !isSniEntryMode
    && !egressActive
    && (
      (mainBackupUsesTunnelRoute && mainBackupForwardType === "gost" && mainBackupIsTunnelRoute)
      || mainBackupPortForwardSupported
      || canAutoSwitchMainBackupToGost
    );
  /*
    主备用不了的时候：说人话的原因，能一键改好的给一个按钮。

    用不了的规则类型（转发链、共享 TLS 入站、用了 SS 出口的……）不显示线路组这一块：
    一个点不开的折叠框只是噪音（用户反馈「用不了就不显示」）。默认的 iptables 端口转发
    不算用不了 —— 勾上会自动换成 GOST，照样显示。只有一种例外：这条规则已经开着线路组、
    但改了别的设置后用不了了，这时还显示，原因和出路写在里面，让人能把它关掉或改回去。
    原因只说他听得懂的，出路直接做成按钮。

    普通用户的判断放在「转发工具不是 GOST」前面：同一条规则两句都成立时，前一句
    才给得出他自己能走的路（改用隧道转发），后一句只会让他去找一个改不了的选项。
  */
  const mainBackupBlock: { reason: string; fix?: { label: string; run: () => void } } | null = canUseMainBackup
    ? null
    : isSniEntryMode
    ? { reason: "共享 TLS 入站上的规则暂不支持线路组。" }
    : egressActive
    ? { reason: "使用 Shadowsocks 出口的规则暂不支持线路组：出口本身就是固定的落地。" }
    : selectedForwardGroupIsChain
    ? {
      reason: "转发链用不了线路组。想要入口坏了自动换，用「转发组」（入口主备）；想要中间的线路坏了自动换，改成隧道转发再开线路组。",
      fix: canUseFailoverGroup && !routeModeLocked ? { label: "改用转发组", run: () => setRouteMode("group") } : undefined,
    }
    : mainBackupUsesTunnelRoute && !mainBackupIsTunnelRoute
    ? { reason: "这种隧道用不了线路组。换一条 GOST、Nginx 或 NEX 隧道就可以。" }
    : user?.role !== "admin" && !mainBackupUsesTunnelRoute && !selectedForwardGroupIsPort
    ? {
      reason: "普通用户的端口转发用不了线路组。改用隧道转发就可以。",
      fix: canUseGost && !routeModeLocked ? { label: "改用隧道转发", run: () => setRouteMode("tunnel") } : undefined,
    }
    : { reason: "线路组要用 gost、realm、socat 或 nginx 转发：iptables / nftables 在内核里改写目的地，调度器插不进去。" };
  const mainBackupDisabledText = mainBackupBlock?.reason || "";
  const routeGroupSectionVisible = !mainBackupBlock || form.failoverEnabled;
  const routeGroupSummary = form.failoverEnabled && form.routeGroup
    // 和框里的摘要、线路详情一个说法：几条线路（不是展开出来的几条路径）、按什么切
    ? `已开启 · ${form.routeGroup.lines?.length || form.routeGroup.paths.length} 条线路 · ${routeStrategyLabel(form.routeGroup.policy)}`
    : mainBackupBlock ? "用不了" : "未开启";
  const kernelForwardWarning = useMemo(() => buildKernelForwardWarning({
    rule: form,
    host: selectedHost,
    group: selectedForwardGroup,
    hosts: hosts || [],
    hostById,
    forwardGroupById,
  }), [form, selectedHost, selectedForwardGroup, hosts, hostById, forwardGroupById]);
  return { canUseMainBackup, telegramBotReady, selectedForwardGroupIsChain, mainBackupDisabledText, kernelForwardWarning, routeGroupSectionVisible, routeGroupSummary, canAutoSwitchMainBackupToGost, mainBackupBlock };
}
